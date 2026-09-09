// lifecycle.js —— 拼车局生命周期动作：发 / 加 / 退 / 解 / 签 / 轮询应答 / 改备注
const {
  T_FREE_EXIT,
  T_MIN_GAP,
  T_SAME_DIR,
  CREDIT_LOW,
  CREDIT_LEAVE_NO_SHOW,
  CREDIT_RIDE_OK,
  T_POLL_DUE,
  T_CHECKIN_GRACE,
  URGENT_MIN_LEAD,
  URGENT_WINDOW,
  joinCloseMs,
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
const { checkText } = require("./safe"); // 内容安全：自定义地点/备注入库前拦截违规

// 冲突是否因"同方向往返不足"（区别于单纯出发太近）
const dirLabel = (d) => (d === "in" ? "返校" : d === "out" ? "离校" : "");
function conflictMsg(conf, boardAt, directionId) {
  const diff = Math.abs(conf.boardAt - boardAt);
  const sameDir = directionId && conf.directionId === directionId && diff >= T_MIN_GAP && diff < T_SAME_DIR;
  if (!sameDir) return null;
  return `同一时段你已有一班同方向「${dirLabel(directionId)}」局：同向出发需先完成一趟往返，两局间隔需 ≥2 小时。`;
}

async function create(event, openid) {
  const { date, time, womenOnly = false, note = "" } = event;
  const urgent = !!event.urgent; // 加急局：30 分钟内出发、T−5 关局、凑不齐自动作废不扣发起人分（见 CONTEXT 加急局）
  const capacity = Number.isFinite(Number(event.capacity)) ? Math.min(6, Math.max(2, Math.round(Number(event.capacity)))) : 4; // 2–6 钳制，默认 4
  let route = null;

  if (event.routeId) {
    const routeRes = await db.collection("routes").where({ routeId: event.routeId }).limit(1).get();
    route = routeRes.data[0];
    if (!route || !route.enabled) return fail("BAD_ROUTE", "线路不存在或已停用");
  } else if (event.directionId === "out") {
    // 离校支持自定义下车点（如粉岭），见 ADR-0009；from 固定为学校
    const to = String(event.to || "").trim();
    if (!to) return fail("BAD_DEST", "请填写下车地点");
    const toSafe = await checkText(to);
    if (!toSafe.safe) return fail("UNSAFE_CONTENT", "下车地点含违规或不当内容，请修改");
    route = { routeId: "", directionId: "out", from: "香港教育大学", to: to.slice(0, 14) };
  } else if (event.directionId === "in") {
    // 返校支持自定义上车点（ADR-0014，与离校对称）；to 固定为教大
    const from = String(event.from || "").trim();
    if (!from) return fail("BAD_DEST", "请填写上车地点");
    const fromSafe = await checkText(from);
    if (!fromSafe.safe) return fail("UNSAFE_CONTENT", "上车地点含违规或不当内容，请修改");
    route = { routeId: "", directionId: "in", from: from.slice(0, 14), to: "香港教育大学" };
  } else {
    return fail("BAD_ROUTE", "缺少线路或上车地点");
  }

  const boardAt = event.boardAt ? Number(event.boardAt) : dateTimeToMs(date, time);
  if (!boardAt) return fail("BAD_TIME", "请选择出发时间");
  if (urgent) {
    // 加急局：提前 15–30 分钟（比正常局的 ≥30 分钟更松，绕开 TOO_SOON）
    const lead = boardAt - Date.now();
    if (lead < URGENT_MIN_LEAD) return fail("TOO_SOON_URGENT", "加急局最早提前 15 分钟发起（留出别人看到、加入的时间）");
    if (lead > URGENT_WINDOW) return fail("URGENT_WINDOW", "加急仅限 30 分钟内出发；超时可取消加急按普通局发起");
  } else if (boardAt - Date.now() <= T_FREE_EXIT) {
    return fail("TOO_SOON", "出发时间需至少晚于当前 30 分钟，好让别人能加入");
  }

  // 备注内容安全（空备注跳过）
  const noteSafe = await checkText(note);
  if (!noteSafe.safe) return fail("UNSAFE_CONTENT", "备注含违规或不当内容，请修改后再发起");

  const user = await ensureUser(openid);
  if (user.credit < CREDIT_LOW) return fail("HOST_BLOCKED", "信用分低于 60，暂停发起新局 7 天");
  const needReg = await ensureRegistered(openid);
  if (needReg) return needReg;
  const conf = await findTimeConflict(openid, boardAt, route.directionId);
  if (conf) {
    const msg = conflictMsg(conf, boardAt, route.directionId) || "你已有出发时间太近的进行中拼车局，请先退出或等它结束";
    return fail("ACTIVE_RIDE", msg, { conflict: briefOf(conf) });
  }

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
      urgent,
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
  if (now > ride.boardAt - joinCloseMs(ride)) return fail("CLOSED", "已停止加入（出发在即）");
  const conf = await findTimeConflict(openid, ride.boardAt, ride.directionId);
  if (conf) {
    const msg = conflictMsg(conf, ride.boardAt, ride.directionId) || "你已有出发时间太近的进行中拼车局，请先退出";
    return fail("ACTIVE_RIDE", msg, { conflict: briefOf(conf) });
  }

  const user = await ensureUser(openid);
  const needReg = await ensureRegistered(openid);
  if (needReg) return needReg;

  const existingIds = (ride.members || []).map((m) => m.openid);

  // 先到者优先（入队否决）：局内任一成员标记过"不与其乘车"我 → 拒绝加入。
  // 文案用"已满"托词（类似"对方正忙"），不暴露是谁/因何被拦。
  if (existingIds.length) {
    try {
      const veto = await db.collection("blocks").where({ targetOpenid: openid, byOpenid: _.in(existingIds) }).count();
      if (veto.total > 0) return fail("NOT_WELCOME", "这一队刚好已满员，试试别的队伍吧");
    } catch (e) {
      /* 集合缺失/未建索引时降级放行 */
    }
  }

  // 队伍里是否有我标记"不与其乘车"的人（仅提醒，不阻断——我自己选择）
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
  const noteSafe = await checkText(note);
  if (!noteSafe.safe) return fail("UNSAFE_CONTENT", "备注含违规或不当内容，请修改");
  await db.collection("rides").doc(ride._id).update({ data: { note, updatedAt: Date.now() } });
  return ok({ note });
}

// 补签到确认：列出"我"待确认的已完成局（结算后未签到、仍在确认窗口内）
async function confirmPending(event, openid) {
  const res = await db.collection("rides").where({ memberOpenids: openid, status: "done" }).limit(50).get();
  const now = Date.now();
  const list = [];
  for (const r of res.data || []) {
    const pc = r.pendingConfirm;
    if (pc && !pc.settled && now < pc.dueAt && (pc.openids || []).includes(openid) && !(pc.resolved || []).includes(openid)) {
      list.push({ rideId: r._id, routeLabel: `${r.from || ""} → ${r.to || ""}`, boardAt: r.boardAt });
    }
  }
  list.sort((a, b) => b.boardAt - a.boardAt);
  return ok({ list });
}

// 补签到确认：rode=true → 补记为已签到并 +1；rode=false → 记爽约 −20（谎报由队友 done 后举报缺勤兜底）
async function confirmRide(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (ride.status !== "done") return fail("NOT_DONE", "拼车结束（已完成）后才能确认");
  const pc = ride.pendingConfirm;
  if (!pc || pc.settled) return fail("NO_CONFIRM", "当前无需确认");
  const now = Date.now();
  if (now >= pc.dueAt) return fail("CONFIRM_CLOSED", "确认已截止");
  if (!(pc.openids || []).includes(openid)) return fail("NOT_IN", "你不在待确认名单");
  if ((pc.resolved || []).includes(openid)) return fail("DUP", "你已确认过");
  const rode = !!event.rode;
  const resolved = (pc.resolved || []).concat(openid);
  const allResolved = (pc.openids || []).every((o) => resolved.includes(o));
  const members = (ride.members || []).map((m) => (m.openid === openid && rode ? { ...m, checkedInAt: now } : m));
  const patch = {
    members,
    memberCount: members.length,
    pendingConfirm: { ...pc, resolved, settled: allResolved },
    updatedAt: now,
  };
  if (!rode) patch.noShowConfirmed = (ride.noShowConfirmed || []).concat(openid);
  await db.collection("rides").doc(ride._id).update({ data: patch });
  if (rode) await applyCreditDelta(openid, CREDIT_RIDE_OK);
  else await applyCreditDelta(openid, CREDIT_LEAVE_NO_SHOW);
  return ok({ rode, creditDelta: rode ? CREDIT_RIDE_OK : CREDIT_LEAVE_NO_SHOW });
}

module.exports = {
  create,
  join,
  leave,
  cancel,
  checkin,
  respondPoll,
  updateNote,
  confirmPending,
  confirmRide,
};
