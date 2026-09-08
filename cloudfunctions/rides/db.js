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
  CREDIT_RIDE_OK,
  CREDIT_LEAVE_NO_SHOW,
  ACTIVE_STATUS,
  MSG_MAX,
  randNick,
} = require("./rules");
const { planAdvance } = require("./advance"); // 状态推进的纯判定（无 IO，可单测；时间常量由其自理）

const ok = (data) => ({ ok: true, data });
const fail = (err, msg, data = null) => ({ ok: false, err, msg, data });

// 管理员名单：原散落 rides/admin.js 与已删除的 user/index.js 两份，现收敛为本可部署单元单一来源。
const ADMIN_OPENIDS = ["oDhfnxajsWOYp-ak-V7Vmnm953q0"]; // 内测期作者本人
const isAdmin = (openid) => ADMIN_OPENIDS.includes(openid);

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

// 惰性建档。默认昵称随机（randNick 唯一来源 rules.js）；游客 registered=false。
async function ensureUser(openid) {
  let u = await findUser(openid);
  if (!u) {
    const now = Date.now();
    const data = {
      openid,
      nickName: randNick(),
      avatarUrl: "",
      gender: "",
      genderLocked: "",
      genderFakeCount: 0,
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

// 到期惰性推进（读时自愈）：把一张局按当前时间就地推进到它该在的状态。
// 状态判定的纯逻辑在 advance.js planAdvance()（可单测）；这里只做薄 IO：
// "仍处于原状态"的条件更新防并发双推进、竞争失败重拉、按 settle/deferred 写信用分。
// rideSweep 定时器与每次读取共用同一逻辑（不再依赖定时器）。
async function advanceStatus(raw) {
  let cur = raw;
  let changed = false;
  for (let i = 0; i < 4; i++) {
    const now = Date.now();
    const plan = planAdvance(cur, now);
    if (!plan) break;
    const { patch, settle, deferredPenalty } = plan;
    const upd = await db.collection("rides").where({ _id: cur._id, status: cur.status }).update({ data: patch });
    const won = !!(upd && upd.stats && upd.stats.updated > 0);
    if (won) {
      changed = true;
      cur = { ...cur, ...patch };
      if (settle) {
        for (const o of settle.plus) await applyCreditDelta(o, CREDIT_RIDE_OK);
        for (const o of settle.minus) await applyCreditDelta(o, CREDIT_LEAVE_NO_SHOW);
      }
      if (deferredPenalty) {
        for (const o of deferredPenalty) await applyCreditDelta(o, CREDIT_LEAVE_NO_SHOW);
      }
    } else {
      // 竞争失败（别人先翻了）：重拉最新状态继续判
      const f = await db.collection("rides").where({ _id: cur._id }).limit(1).get();
      const fresh = f.data[0];
      if (!fresh) break;
      cur = fresh;
    }
  }
  return { ride: cur, changed };
}

/** 读取一张局：先就地推进到期状态再返回（读时自愈入口）。 */
async function getRide(rideId) {
  const res = await db.collection("rides").where({ _id: rideId }).limit(1).get();
  const raw = res.data[0];
  if (!raw) return null;
  const { ride } = await advanceStatus(raw);
  return ride;
}

/** 批量推进（找局/行程列表用），返回推进后的文档。 */
async function advanceMany(rows) {
  const out = [];
  for (const r of rows || []) {
    const { ride } = await advanceStatus(r);
    out.push(ride);
  }
  return out;
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

// 标记过"不与其乘车"我的 openid 集合 = 不想带我的人（byOpenid 标过 target=我）。
// list 用它隐藏 "host ∈ 不想带我的人" 的局 → 对方发起的局对我不下发。
async function blockersOf(openid) {
  const set = new Set();
  try {
    const res = await db.collection("blocks").where({ targetOpenid: openid }).get();
    (res.data || []).forEach((b) => b.byOpenid && set.add(b.byOpenid));
  } catch (e) {
    /* 集合缺失/未建索引时降级为不隐藏 */
  }
  return set;
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
  blockersOf,
  advanceStatus,
  advanceMany,
  recentMessages,
  MSG_MAX,
  isAdmin,
  ADMIN_OPENIDS,
};
