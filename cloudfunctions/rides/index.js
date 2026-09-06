// cloudfunctions/rides —— 拼车局主业务
// 契约见 SPEC.md。所有时间字段为毫秒时间戳 number；openid 一律取云端上下文。
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// ---- 规则常量（毫秒），与 SPEC.md §2 一致 ----
const T_JOIN_CLOSE = 10 * 60 * 1000; // T−10 停止加入
const T_FREE_EXIT = 30 * 60 * 1000; // T−30 自由退出/解散截止
const T_MIN_GAP = 60 * 60 * 1000; // 同一个人两个未出发局，出发时间至少相隔 1 小时（不同方向/不同时段互不冲突）
const T_POLL_ASK = 60 * 60 * 1000; // T−60 人数轮询
const T_POLL_DUE = 45 * 60 * 1000; // T−45 轮询截止
const T_CHECKIN_GRACE = 10 * 60 * 1000; // T+10 可标爽约
const CREDIT_DEFAULT = 100;
const CREDIT_CAP = 120;
const MSG_MAX = 200;

const ok = (data) => ({ ok: true, data });
const fail = (err, msg, data = null) => ({ ok: false, err, msg, data });

const ACTIVE_STATUS = ["recruiting", "locked"];

// 管理员 openid（与 cloudfunctions/user 一致；上线前改为你的真实 openid）
const ADMIN_OPENIDS = ["oDhfnxajsWOYp-ak-V7Vmnm953q0"];

// ---- 用户工具 ----
async function findUser(openid) {
  const res = await db.collection("users").where({ openid }).limit(1).get();
  return res.data[0] || null;
}

async function ensureUser(openid) {
  let u = await findUser(openid);
  if (!u) {
    const data = {
      openid,
      nickName: "通勤者",
      avatarUrl: "",
      gender: "",
      phoneVerified: false,
      credit: CREDIT_DEFAULT,
      bannedUntil: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const add = await db.collection("users").add({ data });
    u = { _id: add._id, ...data };
  }
  return u;
}

// 信用变更统一入口：clamp 0..120；跌破 60 时封禁发起 7 天（bannedUntil）
async function applyCreditDelta(openid, delta) {
  const u = await ensureUser(openid);
  const next = Math.max(0, Math.min(CREDIT_CAP, u.credit + delta));
  const patch = { credit: next, updatedAt: Date.now() };
  if (next < 60) patch.bannedUntil = Date.now() + 7 * 24 * 3600 * 1000;
  await db.collection("users").where({ openid }).update({ data: patch });
  return next;
}

// 参与类操作前校验：必须已注册（填昵称）
async function ensureRegistered(openid) {
  const u = await ensureUser(openid);
  if (!u.registered) return fail("NEED_REGISTER", "请先完成注册（填昵称）再参与拼车");
  return null;
}

function getMember(ride, openid) {
  return (ride.members || []).find((m) => m.openid === openid) || null;
}

const briefOf = (r) => ({ boardAt: r.boardAt, routeLabel: `${r.from} → ${r.to}`, directionId: r.directionId });

// 是否存在"出发时间太近"的未出发局（返回冲突局或 null）
async function findTimeConflict(openid, boardAt) {
  const res = await db.collection("rides").where({ memberOpenids: openid, status: _.in(ACTIVE_STATUS) }).get();
  const act = res.data || [];
  return act.find((r) => Math.abs(r.boardAt - boardAt) < T_MIN_GAP) || null;
}

function dateTimeToMs(date, time) {
  // date: YYYY-MM-DD, time: HH:mm（深港同为 UTC+8）
  const t = Date.parse(`${date}T${time}:00+08:00`);
  return Number.isNaN(t) ? 0 : t;
}

// ---- 读取辅助 ----
async function getRide(rideId) {
  const res = await db.collection("rides").where({ _id: rideId }).limit(1).get();
  return res.data[0] || null;
}

// ---- action 实现 ----
async function create(event, openid) {
  const { date, time, capacity = 4, womenOnly = false, note = "" } = event;
  let route = null;

  if (event.routeId) {
    const routeRes = await db.collection("routes").where({ routeId: event.routeId }).limit(1).get();
    route = routeRes.data[0];
    if (!route || !route.enabled) return fail("BAD_ROUTE", "线路不存在或已停用");
  } else if (event.directionId === "out") {
    // 离校支持自定义下车点（如粉岭），见 UI 需求；from 固定为学校
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
  if (user.credit < 60) return fail("HOST_BLOCKED", "信用分低于 60，暂停发起新局 7 天");
  const needReg = await ensureRegistered(openid);
  if (needReg) return needReg;
  const conf = await findTimeConflict(openid, boardAt);
  if (conf) return fail("ACTIVE_RIDE", "你已有出发时间太近的进行中拼车局，请先退出或等它结束", { conflict: briefOf(conf) });

  const now = Date.now();
  const member = { openid, name: user.nickName || "通勤者", gender: user.gender || "", role: "host", checkedInAt: 0, joinedAt: now };
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

async function list(event, openid) {
  const now = Date.now();
  const cond = { status: _.in(ACTIVE_STATUS), boardAt: _.gt(now - 5 * 60 * 1000) };
  if (event.directionId) cond.directionId = event.directionId;
  if (event.pickup) cond.from = event.pickup;
  if (event.date) cond.date = event.date;
  const res = await db.collection("rides").where(cond).orderBy("boardAt", "asc").limit(50).get();
  const rows = sanitizeList(res.data);
  return ok({
    rides: rows.map((r) => {
      const raw = res.data.find((x) => x._id === r._id) || {};
      return {
        ...r,
        mine: raw.hostOpenid === openid,
        joined: !!(raw.memberOpenids || []).includes(openid),
      };
    }),
  });
}

function sanitizeList(rides) {
  return rides.map((r) => ({
    _id: r._id,
    routeId: r.routeId,
    directionId: r.directionId,
    from: r.from,
    to: r.to,
    routeLabel: `${r.from} → ${r.to}`,
    boardAt: r.boardAt,
    capacity: r.capacity,
    memberCount: r.memberCount,
    status: r.status,
    womenOnly: r.womenOnly,
    note: r.note,
    hostOpenid: r.hostOpenid,
    poll: r.poll || null,
    membersBrief: (r.members || []).slice(0, r.capacity).map((m) => ({ name: m.name, gender: m.gender || "" })),
  }));
}

async function my(openid) {
  const res = await db.collection("rides").where({ memberOpenids: openid }).limit(100).get();
  const rows = sanitizeList(res.data).sort((a, b) => b.boardAt - a.boardAt);
  const ongoing = rows.filter((r) => ["recruiting", "locked", "ongoing"].includes(r.status));
  const history = rows.filter((r) => ["done", "cancelled", "failed"].includes(r.status));
  return ok({ ongoing, history });
}

async function detail(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  const me = getMember(ride, openid);
  const msgs = await db
    .collection("messages")
    .where({ rideId: ride._id })
    .orderBy("createdAt", "desc")
    .limit(20)
    .get();

  const now = Date.now();
  const d = {
    _id: ride._id,
    routeLabel: `${ride.from} → ${ride.to}`,
    boardAt: ride.boardAt,
    capacity: ride.capacity,
    memberCount: ride.memberCount,
    status: ride.status,
    womenOnly: ride.womenOnly,
    note: ride.note,
    members: ride.members.map((m) => ({ openid: m.openid, name: m.name, role: m.role, gender: m.gender || "", checkedInAt: m.checkedInAt })),
    poll: ride.poll || null,
    canJoin: ride.status === "recruiting" && ride.memberCount < ride.capacity && !me && now <= ride.boardAt - T_JOIN_CLOSE,
    canCheckin: !!me && now <= ride.boardAt + T_CHECKIN_GRACE,
    canCancel: ride.hostOpenid === openid && now < ride.boardAt - T_FREE_EXIT,
    isMember: !!me,
    isHost: ride.hostOpenid === openid,
    messages: (msgs.data || []).map((m) => ({ openid: m.openid, name: m.name, text: m.text, type: m.type || "text", createdAt: m.createdAt })).reverse(),
  };
  return ok({ ride: d });
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

  // 队伍里是否有我标记"不与其乘车"的人（blocks 集合缺失/未建索引时降级为无提醒，不阻断加入）
  const existingIds = (ride.members || []).map((m) => m.openid);
  let warnings = [];
  if (existingIds.length) {
    try {
      const blockedRes = await db
        .collection("blocks")
        .where({ byOpenid: openid, targetOpenid: _.in(existingIds) })
        .get();
      const blockedSet = new Set((blockedRes.data || []).map((b) => b.targetOpenid));
      warnings = (ride.members || []).filter((m) => blockedSet.has(m.openid)).map((m) => ({ openid: m.openid, name: m.name }));
    } catch (e) {
      console.warn("[join] blocks check skipped:", e.message);
    }
  }

  const member = { openid, name: user.nickName || "通勤者", gender: user.gender || "", role: "member", checkedInAt: 0, joinedAt: now };
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

  if (penalty) await applyCreditDelta(openid, -20);
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
  if (!["recruiting", "locked", "ongoing"].includes(ride.status)) return fail("BAD_STATE", "这一局当前不能签到");
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
    // 不认可当前人数：免费退出（此时一定在 T−45 前，尚在自由退出窗口）
    return leave({ rideId: ride._id, _noPenalty: true }, openid);
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

async function sendMessage(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (!getMember(ride, openid)) return fail("NOT_IN", "只有成员能在局内发言");
  const needReg = await ensureRegistered(openid);
  if (needReg) return needReg;
  const isImage = event.type === "image";
  const text = String(event.text || "").trim();
  if (!text) return fail("EMPTY", "内容为空");
  if (isImage) {
    // 方案2：图片走 base64 存消息，不用云存储（免存储流量/权限）
    if (text.length > 200000) return fail("TOO_BIG", "图片太大，请换张更小的（建议 ≤100KB）");
    const cnt = await db.collection("messages").where({ rideId: ride._id, openid, type: "image" }).count();
    if (cnt.total >= 1) return fail("IMG_LIMIT", "每人每局最多发 1 张图（建议发群二维码，队友长按保存后扫码加群）");
  }
  const user = await ensureUser(openid);
  await db.collection("messages").add({
    data: {
      rideId: ride._id,
      openid,
      name: user.nickName || "拼友",
      text: isImage ? text : text.slice(0, MSG_MAX),
      type: isImage ? "image" : "text",
      createdAt: Date.now(),
    },
  });
  return ok({ sent: true });
}

// ---- 成员资料 / 拉黑 / 投诉 / 邀请 ----
async function memberInfo(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (!getMember(ride, openid)) return fail("NOT_IN", "只有同局成员能查看");
  const target = ride.members.find((m) => m.openid === event.targetOpenid);
  if (!target) return fail("BAD_TARGET", "对象不在这一局");
  const u = await findUser(event.targetOpenid);
  const blk = await db
    .collection("blocks")
    .where({ byOpenid: openid, targetOpenid: event.targetOpenid })
    .count();
  return ok({
    member: {
      openid: target.openid,
      name: target.name,
      gender: target.gender || "",
      credit: u ? u.credit : 100,
      blocked: blk.total > 0,
    },
  });
}

async function setBlock(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (!getMember(ride, openid)) return fail("NOT_IN", "只有同局成员能标记");
  if (event.targetOpenid === openid) return fail("BAD_TARGET", "不能标记自己");
  if (!ride.memberOpenids.includes(event.targetOpenid)) return fail("BAD_TARGET", "对象不在这一局");
  const now = Date.now();
  const want = !!event.block;
  const existing = await db
    .collection("blocks")
    .where({ byOpenid: openid, targetOpenid: event.targetOpenid })
    .get();
  if (want && existing.data.length === 0) {
    await db.collection("blocks").add({ data: { byOpenid: openid, targetOpenid: event.targetOpenid, createdAt: now } });
  } else if (!want && existing.data.length > 0) {
    await db.collection("blocks").doc(existing.data[0]._id).remove();
  }
  return ok({ blocked: want });
}

const KIND_DELTA = { gender_fake: -20, absence: -20, lateness: -10 };
const COMPLAINT_KINDS = ["gender_fake", "lateness", "absence"];

async function complaint(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (!getMember(ride, openid)) return fail("NOT_IN", "只有同局成员能举报");
  if (event.targetOpenid === openid) return fail("BAD_TARGET", "不能举报自己");
  if (!ride.memberOpenids.includes(event.targetOpenid)) return fail("BAD_TARGET", "对象不在这一局");
  if (!COMPLAINT_KINDS.includes(event.kind)) return fail("BAD_KIND", "举报类型无效");
  // 迟到/缺勤只在拼车结束后可举报；性别不实随时可报
  if (event.kind !== "gender_fake" && ride.status !== "done") return fail("NOT_DONE", "拼车结束（已完成）后才能举报迟到/缺勤");

  const now = Date.now();
  const exRes = await db
    .collection("reports")
    .where({ rideId: ride._id, targetOpenid: event.targetOpenid, status: "pending" })
    .get();
  const existing = exRes.data || [];

  // 同一人同一对象同一类只能一次；同对象可被不同成员"联名"
  if (existing.some((x) => x.byOpenid === openid && x.kind === event.kind)) return fail("DUP", "你已对该成员提交过同类举报");

  await db.collection("reports").add({
    data: {
      rideId: ride._id,
      byOpenid: openid,
      targetOpenid: event.targetOpenid,
      kind: event.kind,
      note: event.note || "",
      status: "pending",
      creditDelta: 0,
      createdAt: now,
      resolvedAt: 0,
    },
  });

  // 联名坐实：同一局内 ≥2 名不同成员举报同一人 → 自动坐实并扣分一次
  const after = await db
    .collection("reports")
    .where({ rideId: ride._id, targetOpenid: event.targetOpenid, status: "pending" })
    .get();
  const list = after.data || [];
  const reporters = new Set(list.map((x) => x.byOpenid));
  if (reporters.size >= 2) {
    const worst = Math.min(...list.map((x) => KIND_DELTA[x.kind] || 0));
    if (list.some((x) => x.kind === "gender_fake")) {
      await db.collection("users").where({ openid: event.targetOpenid }).update({ data: { gender: "", updatedAt: Date.now() } });
    }
    const credit = await applyCreditDelta(event.targetOpenid, worst);
    for (const rep of list) {
      await db.collection("reports").doc(rep._id).update({ data: { status: "upheld", creditDelta: worst, resolvedAt: Date.now() } });
    }
    return ok({ reported: true, auto: true, targetCredit: credit });
  }
  return ok({ reported: true, auto: false });
}

// 已完成局"下周同一时刻再约"：复用/新建进行中局并邀请老队友
async function reinvite(event, openid) {
  const old = await getRide(event.rideId);
  if (!old) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (old.status !== "done") return fail("NOT_DONE", "拼车结束后才能再约队友");
  if (!getMember(old, openid)) return fail("NOT_IN", "只有同局成员能再约");
  const targetOpenid = event.targetOpenid;
  if (!targetOpenid || targetOpenid === openid || !old.memberOpenids.includes(targetOpenid)) {
    return fail("BAD_TARGET", "对象不在这一局");
  }

  const now = Date.now();
  const desired = old.boardAt + 7 * 24 * 3600 * 1000; // 下周同一天同一时刻
  if (desired <= now + T_FREE_EXIT) return fail("TOO_SOON", "下周该时刻已不足 30 分钟，换个局约吧");

  const mine = await db.collection("rides").where({ memberOpenids: openid, status: _.in(ACTIVE_STATUS) }).get();
  const actives = mine.data || [];

  // 优先复用"同线路 + 下周同一时刻 ±2 小时"的进行中局；没有就用我现有任一进行中局；都没有才新建
  const sameRoute = actives.find((r) => r.routeId === (old.routeId || "") && Math.abs(r.boardAt - desired) < 2 * 3600 * 1000);
  let rideId = null;
  let created = false;
  if (sameRoute) {
    rideId = sameRoute._id;
  } else if (actives.length) {
    rideId = actives[0]._id;
  } else {
    const made = await create(
      { routeId: old.routeId || "", directionId: old.directionId, to: old.to, boardAt: desired, capacity: old.capacity || 4, note: "再约老队友" },
      openid
    );
    if (!made.ok) return made;
    rideId = made.data.rideId;
    created = true;
  }

  const s = await inviteSend({ rideId, targetOpenid }, openid);
  return ok({ rideId, created, inviteSent: s.ok, msg: s.ok ? null : s.msg });
}

async function inviteSend(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (!["recruiting", "locked"].includes(ride.status)) return fail("NOT_OPEN", "只能邀请加入进行中的局");
  if (!getMember(ride, openid)) return fail("NOT_IN", "只有局内成员能发出邀请");
  if (event.targetOpenid === openid) return fail("BAD_TARGET", "不能邀请自己");
  if ((ride.memberOpenids || []).includes(event.targetOpenid)) return fail("ALREADY_IN", "对方已在这一局");
  const needReg = await ensureRegistered(openid);
  if (needReg) return needReg;
  const now = Date.now();
  const dup = await db
    .collection("invites")
    .where({ rideId: ride._id, toOpenid: event.targetOpenid, status: "pending" })
    .count();
  if (dup.total > 0) return fail("DUP", "已邀请过对方");
  const me = await ensureUser(openid);
  await db.collection("invites").add({
    data: {
      rideId: ride._id,
      fromOpenid: openid,
      fromName: me.nickName || "通勤者",
      toOpenid: event.targetOpenid,
      status: "pending",
      createdAt: now,
    },
  });
  return ok({ sent: true });
}

async function inviteList(openid) {
  const res = await db.collection("invites").where({ toOpenid: openid, status: "pending" }).get();
  const invites = [];
  for (const inv of res.data) {
    const ride = await getRide(inv.rideId).catch(() => null);
    if (!ride) continue;
    invites.push({
      _id: inv._id,
      fromName: inv.fromName,
      routeLabel: `${ride.from} → ${ride.to}`,
      boardAt: ride.boardAt,
      rideId: ride._id,
      live: ["recruiting", "locked"].includes(ride.status) && ride.memberCount < ride.capacity,
    });
  }
  invites.sort((a, b) => b.boardAt - a.boardAt);
  return ok({ invites });
}

async function respondInvite(event, openid) {
  const res = await db.collection("invites").doc(event.inviteId).get().catch(() => null);
  const inv = res && res.data;
  if (!inv) return fail("NOT_FOUND", "邀请不存在或已失效");
  if (inv.toOpenid !== openid) return fail("NOT_YOURS", "这不是给你的邀请");
  if (inv.status !== "pending") return fail("RESOLVED", "该邀请已处理");
  const status = !!event.accept ? "accepted" : "declined";
  await db.collection("invites").doc(event.inviteId).update({ data: { status, updatedAt: Date.now() } });
  return ok({ rideId: inv.rideId, status });
}

// 轻量拉取局内最新消息（聊天轮询用，不带整局数据）
async function rideMessages(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (!getMember(ride, openid)) return fail("NOT_IN", "只有成员能查看聊天");
  const msgs = await db
    .collection("messages")
    .where({ rideId: ride._id })
    .orderBy("createdAt", "desc")
    .limit(20)
    .get();
  return ok({
    messages: (msgs.data || []).map((m) => ({ openid: m.openid, name: m.name, text: m.text, type: m.type || "text", createdAt: m.createdAt })).reverse(),
  });
}

// 联调辅助：管理员为给定 openid 们创建一条"已完成"的共享拼车局（含示例消息），用于测试历史/投诉/再约
async function adminSeedDone(event, openid) {
  if (!ADMIN_OPENIDS.includes(openid)) return fail("NO_ADMIN", "无管理员权限");
  const list = (event.members || []).filter((x) => x && typeof x === "string");
  if (list.length < 2) return fail("BAD_MEMBERS", "至少传两个成员 openid");
  const now = Date.now();
  const members = [];
  for (const o of list) {
    const u = await ensureUser(o);
    members.push({
      openid: o,
      name: u.nickName || "通勤者",
      gender: u.gender || "",
      role: members.length ? "member" : "host",
      checkedInAt: now - 60 * 60000,
      joinedAt: now - 90 * 60000,
    });
  }
  const add = await db.collection("rides").add({
    data: {
      routeId: "in-futian",
      directionId: "in",
      from: "福田口岸（落马洲）的士站",
      to: "香港教育大学",
      date: "",
      boardAt: now - 90 * 60000,
      capacity: 4,
      womenOnly: false,
      note: "联调用·已完成局（adminSeedDone）",
      status: "done",
      hostOpenid: list[0],
      memberCount: list.length,
      members,
      memberOpenids: list,
      poll: null,
      noShowConfirmed: [],
      settled: true,
      createdAt: now - 90 * 60000,
      updatedAt: now,
    },
  });
  const lines = ["到齐了，出发 🚕", "到学校了，下次再拼！"];
  for (let i = 0; i < lines.length; i++) {
    const who = members[i % members.length];
    await db.collection("messages").add({
      data: { rideId: add._id, openid: who.openid, name: who.name, text: lines[i], createdAt: now - 80 * 60000 + i * 1000 },
    });
  }
  return ok({ rideId: add._id, members: list });
}

// 发起人修改局备注
async function updateNote(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (ride.hostOpenid !== openid) return fail("NOT_HOST", "只有发起人能修改备注");
  if (!["recruiting", "locked"].includes(ride.status)) return fail("NOT_EDITABLE", "该局已结束，不能改备注");
  const note = String(event.note || "").trim().slice(0, 50);
  await db.collection("rides").doc(ride._id).update({ data: { note, updatedAt: Date.now() } });
  return ok({ note });
}

// ---- 入口 ----
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail("NO_AUTH", "无法识别用户");
  try {
    switch (event.action) {
      case "create":
        return await create(event, OPENID);
      case "list":
        return await list(event, OPENID);
      case "my":
        return await my(OPENID);
      case "detail":
        return await detail(event, OPENID);
      case "join":
        return await join(event, OPENID);
      case "leave":
        return await leave(event, OPENID);
      case "cancel":
        return await cancel(event, OPENID);
      case "checkin":
        return await checkin(event, OPENID);
      case "respondPoll":
        return await respondPoll(event, OPENID);
      case "memberInfo":
        return await memberInfo(event, OPENID);
      case "block":
        return await setBlock(event, OPENID);
      case "complaint":
        return await complaint(event, OPENID);
      case "reinvite":
        return await reinvite(event, OPENID);
      case "updateNote":
        return await updateNote(event, OPENID);
      case "invite":
        return await inviteSend(event, OPENID);
      case "inviteList":
        return await inviteList(OPENID);
      case "inviteRespond":
        return await respondInvite(event, OPENID);
      case "adminSeedDone":
        return await adminSeedDone(event, OPENID);
      case "sendMessage":
        return await sendMessage(event, OPENID);
      case "messages":
        return await rideMessages(event, OPENID);
      default:
        return fail("NO_ACTION", "未知 action");
    }
  } catch (e) {
    console.error("[rides]", e);
    return fail("EXCEPTION", "服务开小差了，请重试");
  }
};
