// lifecycle.js —— 拼车局生命周期动作：发 / 加 / 退 / 解 / 签 / 轮询应答 / 改备注
const {
  T_JOIN_CLOSE,
  T_FREE_EXIT,
  CREDIT_LOW,
  CREDIT_LEAVE_NO_SHOW,
  T_POLL_DUE,
  T_CHECKIN_GRACE,
  PARTICIPANT_STATUS,
  ACTIVE_STATUS,
  NOTE_MAX,
  dateTimeToMs,
} = require("./rules");
const {
  db,
  _,
  ok,
  fail,
  briefOf,
  ensureUser,
  ensureRegistered,
  applyCreditDelta,
  getMember,
  getRide,
  findTimeConflict,
} = require("./db");

async function create(event, openid) {
  const { date, time, capacity = 4, womenOnly = false, note = "" } = event;
  let route = null;

  if (event.routeId) {
    const routeRes = await db.collection("routes").where({ routeId: event.routeId }).limit(1).get();
    route = routeRes.data[0];
    if (!route || !route.enabled) return fail("BAD_ROUTE", "线路不存在或已停用");
  } else if (event.directionId === "out") {
    // 离校支持自定义下车点（如粉岭），见 ADR-0009；from 固定为学校
    const to = String(event.to || "").trim();
    if (!to) return fail("BAD_DEST", "请填写下车地点");
    route = { routeId: "", directionId: "out", from: "香港教育大学", to: to.slice(0, 14) };
  } else {
    return fail("BAD_ROUTE", "缺少线路或下车地点");
  }

  const boardAt = event.boardAt ? Number(event.boardAt) : dateTimeToMs(date, time);
  if (!boardAt || boardAt - Date.now() <= T_FREE_EXIT) {
    return fail("TOO_SOON", "出发时间需至少晚于当前 30 分钟，好让别人能加入");
  }

  const user = await ensureUser(openid);
  if (user.credit < CREDIT_LOW) return fail("HOST_BLOCKED", "信用分低于 60，暂停发起新局 7 天");
  const needReg = await ensureRegistered(openid);
  if (needReg) return needReg;
  const conf = await findTimeConflict(openid, boardAt);
  if (conf) return fail("ACTIVE_RIDE", "你已有出发时间太近的进行中拼车局，请先退出或等它结束", { conflict: briefOf(conf) });

  const now = Date.now();
  const member = { openid, name: user.nickName || "拼友", gender: user.gender || "", role: "host", checkedInAt: 0, joinedAt: now };
  const add = await db.collection("rides").add({
    data: {
      routeId: route.routeId || "",
      directionId: route.directionId,
      from: route.from,
      to: route.to,
      date: date || "",
      boardAt,
      capacity,
      womenOnly,
      note,
      status: "recruiting",
      hostOpenid: openid,
      memberCount: 1,
      members: [member],
      memberOpenids: [openid],
      poll: null,
      noShowConfirmed: [],
      settled: false,
      createdAt: now,
      updatedAt: now,
    },
  });
  return ok({ rideId: add._id });
}

async function join(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  const now = Date.now();

  if (ride.status !== "recruiting") return fail("NOT_OPEN", "这一局已停止加入");
  if (ride.memberCount >= ride.capacity) return fail("FULL", "这一局已满员");
  if (getMember(ride, openid)) return fail("ALREADY_IN", "你已在这一局里");
  if (now > ride.boardAt - T_JOIN_CLOSE) return fail("CLOSED", "距上车不足 10 分钟，已停止加入");
  const conf = await findTimeConflict(openid, ride.boardAt);
  if (conf) return fail("ACTIVE_RIDE", "你已有出发时间太近的进行中拼车局，请先退出", { conflict: briefOf(conf) });

  const user = await ensureUser(openid);
  const needReg = await ensureRegistered(openid);
  if (needReg) return needReg;

  // 队伍里是否有我标记"不与其乘车"的人（blocks 集合缺失时降级为无提醒，不阻断加入）
  const existingIds = (ride.members || []).map((m) => m.openid);
  let warnings = [];
  if (existingIds.length) {
    try {
      const blockedRes = await db.collection("blocks").where({ byOpenid: openid, targetOpenid: _.in(existingIds) }).get();
      const blockedSet = new Set((blockedRes.data || []).map((b) => b.targetOpenid));
      warnings = (ride.members || []).filter((m) => blockedSet.has(m.openid)).map((m) => ({ openid: m.openid, name: m.name }));
    } catch (e) {
      console.warn("[join] blocks check skipped:", e.message);
    }
  }

  const member = { openid, name: user.nickName || "拼友", gender: user.gender || "", role: "member", checkedInAt: 0, joinedAt: now };
  await db.collection("rides").doc(ride._id).update({
    data: {
      members: _.push([member]),
      memberOpenids: _.push([openid]),
      memberCount: _.inc(1),
      updatedAt: now,
    },
  });
  return ok({ rideId: ride._id, warnings });
}

async function leave(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  const now = Date.now();
  if (!ACTIVE_STATUS.includes(ride.status)) return fail("NOT_LEAVEABLE", "这一局当前状态不可退出");
  if (now >= ride.boardAt) return fail("GONE", "已到上车时间，按未到处理");

  const me = getMember(ride, openid);
  if (!me) return fail("NOT_IN", "你不在这一局里");

  const penalty = now >= ride.boardAt - T_FREE_EXIT; // T−30 后退出计爽约

  let members = ride.members.filter((m) => m.openid !== openid);
  let hostOpenid = ride.hostOpenid;
  let status = ride.status;
  if (members.length === 0) {
    status = "cancelled"; // 无人了，局取消
  } else if (me.role === "host") {
    // 发起人离开：移交给最早加入者
    members.sort((a, b) => a.joinedAt - b.joinedAt);
    members[0].role = "host";
    hostOpenid = members[0].openid;
  }

  const patch = {
    members,
    memberOpenids: members.map((m) => m.openid),
    memberCount: members.length,
    hostOpenid,
    status,
    poll: null, // 人数变了，让 sweep 视窗口重新询问
    updatedAt: now,
  };
  await db.collection("rides").doc(ride._id).update({ data: patch });

  if (penalty) await applyCreditDelta(openid, CREDIT_LEAVE_NO_SHOW);
  return ok({ left: true, penalty, status });
}

async function cancel(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (ride.hostOpenid !== openid) return fail("NOT_HOST", "只有发起人能解散");
  if (Date.now() >= ride.boardAt - T_FREE_EXIT) return fail("TOO_LATE", "距上车不足 30 分钟，不能解散（可自行退出）");
  await db.collection("rides").doc(ride._id).update({ data: { status: "cancelled", updatedAt: Date.now() } });
  return ok({ cancelled: true });
}

async function checkin(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  const me = getMember(ride, openid);
  if (!me) return fail("NOT_IN", "你不在这一局里");
  if (me.checkedInAt) return ok({ checkedInAt: me.checkedInAt }); // 幂等
  if (!PARTICIPANT_STATUS.includes(ride.status)) return fail("BAD_STATE", "这一局当前不能签到");
  if (Date.now() > ride.boardAt + T_CHECKIN_GRACE) return fail("TOO_LATE", "已超过上车时间 10 分钟，不能再签到");

  const members = ride.members.map((m) => (m.openid === openid ? { ...m, checkedInAt: Date.now() } : m));
  await db.collection("rides").doc(ride._id).update({ data: { members, updatedAt: Date.now() } });
  return ok({ checkedInAt: Date.now() });
}

async function respondPoll(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (!ride.poll || !ride.poll.active) return fail("NO_POLL", "当前没有进行中的确认");
  const now = Date.now();
  if (now >= (ride.poll.dueAt || ride.boardAt - T_POLL_DUE)) return fail("POLL_CLOSED", "确认已截止");
  const me = getMember(ride, openid);
  if (!me) return fail("NOT_IN", "你不在这一局里");

  const accept = !!event.accept;
  if (!accept) {
    // 不认可当前人数：免费退出。轮询截止 T−45 < 自由退出截止 T−30，故必在免费窗口内，
    // leave 按时间判定不会扣分——无需任何"免罚"标记。
    return leave({ rideId: ride._id }, openid);
  }

  const responses = (ride.poll.responses || []).concat({ openid, accept: true, at: now });
  const patch = { updatedAt: now };
  if (responses.length >= ride.memberCount) {
    patch.poll = { ...ride.poll, active: false, status: "accepted", responses };
  } else {
    patch.poll = { ...ride.poll, responses };
  }
  await db.collection("rides").doc(ride._id).update({ data: patch });
  return ok({ poll: patch.poll });
}

// 发起人修改局备注
async function updateNote(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (ride.hostOpenid !== openid) return fail("NOT_HOST", "只有发起人能修改备注");
  if (!["recruiting", "locked"].includes(ride.status)) return fail("NOT_EDITABLE", "该局已结束，不能改备注");
  const note = String(event.note || "").trim().slice(0, NOTE_MAX);
  await db.collection("rides").doc(ride._id).update({ data: { note, updatedAt: Date.now() } });
  return ok({ note });
}

module.exports = {
  create,
  join,
  leave,
  cancel,
  checkin,
  respondPoll,
  updateNote,
};
