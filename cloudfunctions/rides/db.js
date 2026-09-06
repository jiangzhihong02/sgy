// db.js —— rides 云函数内的共享数据/守卫/信封（同一可部署单元内唯一的 wx 入口）
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const {
  CREDIT_DEFAULT,
  CREDIT_CAP,
  CREDIT_LOW,
  BAN_DAYS_MS,
  T_MIN_GAP,
  T_SAME_DIR,
  ACTIVE_STATUS,
  MSG_MAX,
  randNick,
} = require("./rules");

const ok = (data) => ({ ok: true, data });
const fail = (err, msg, data = null) => ({ ok: false, err, msg, data });

/** 路线/局的简短摘要（时间冲突对比等用，不含 返校/离校 前缀）。 */
const briefOf = (r) => ({
  boardAt: r.boardAt,
  routeLabel: `${r.from} → ${r.to}`,
  directionId: r.directionId,
});

async function findUser(openid) {
  const res = await db.collection("users").where({ openid }).limit(1).get();
  return res.data[0] || null;
}

// 惰性建档。默认昵称随机（与 user 云函数同口径）；游客 registered=false。
async function ensureUser(openid) {
  let u = await findUser(openid);
  if (!u) {
    const now = Date.now();
    const data = {
      openid,
      nickName: randNick(),
      avatarUrl: "",
      gender: "",
      phoneVerified: false,
      registered: false,
      credit: CREDIT_DEFAULT,
      bannedUntil: 0,
      createdAt: now,
      updatedAt: now,
    };
    const add = await db.collection("users").add({ data });
    u = { _id: add._id, ...data };
  }
  return u;
}

// 信用变更统一入口：clamp 0..CREDIT_CAP；跌破 CREDIT_LOW 封禁发起 BAN_DAYS_MS。
async function applyCreditDelta(openid, delta) {
  const u = await ensureUser(openid);
  const next = Math.max(0, Math.min(CREDIT_CAP, u.credit + delta));
  const patch = { credit: next, updatedAt: Date.now() };
  if (next < CREDIT_LOW) patch.bannedUntil = Date.now() + BAN_DAYS_MS;
  await db.collection("users").where({ openid }).update({ data: patch });
  return next;
}

// 参与类操作前置：必须已注册。
async function ensureRegistered(openid) {
  const u = await ensureUser(openid);
  if (!u.registered) return fail("NEED_REGISTER", "请先完成注册（填昵称）再参与拼车");
  return null;
}

function getMember(ride, openid) {
  return (ride.members || []).find((m) => m.openid === openid) || null;
}

async function getRide(rideId) {
  const res = await db.collection("rides").where({ _id: rideId }).limit(1).get();
  return res.data[0] || null;
}

// 是否存在冲突的未出发局：① 任何方向出发时间差 < T_MIN_GAP（无法同时上两辆的士）；
// ② 同方向（directionId 相同）且时间差 < T_SAME_DIR（同向需先完成一趟往返才能再出发）。
async function findTimeConflict(openid, boardAt, directionId) {
  const res = await db.collection("rides").where({ memberOpenids: openid, status: _.in(ACTIVE_STATUS) }).get();
  const act = res.data || [];
  return (
    act.find((r) => {
      const diff = Math.abs(r.boardAt - boardAt);
      if (diff < T_MIN_GAP) return true;
      if (directionId && r.directionId === directionId && diff < T_SAME_DIR) return true;
      return false;
    }) || null
  );
}

/** 局内最近 20 条消息（升序，含 type），detail 与聊天轮询共用。 */
async function recentMessages(rideId) {
  const msgs = await db
    .collection("messages")
    .where({ rideId })
    .orderBy("createdAt", "desc")
    .limit(20)
    .get();
  return (msgs.data || [])
    .map((m) => ({ openid: m.openid, name: m.name, text: m.text, type: m.type || "text", createdAt: m.createdAt }))
    .reverse();
}

module.exports = {
  cloud,
  db,
  _,
  ok,
  fail,
  briefOf,
  findUser,
  ensureUser,
  applyCreditDelta,
  ensureRegistered,
  getMember,
  getRide,
  findTimeConflict,
  recentMessages,
  MSG_MAX,
};
