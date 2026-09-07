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
  T_JOIN_CLOSE,
  T_POLL_ASK,
  T_POLL_DUE,
  T_SETTLE,
  CREDIT_RIDE_OK,
  CREDIT_LEAVE_NO_SHOW,
  ACTIVE_STATUS,
  MSG_MAX,
  randNick,
} = require("./rules");

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
// 所有状态翻转用"仍处于原状态"的条件更新，避免并发双推进；结算只由翻到 done 的那一方执行，
// settled 字段防止重复结算。rideSweep 定时器与每次读取共用同一逻辑（不再依赖定时器）。
async function advanceStatus(raw) {
  let cur = raw;
  let changed = false;
  for (let i = 0; i < 4; i++) {
    const now = Date.now();
    let patch = null;
    let settle = false;
    if (cur.status === "recruiting") {
      if (now >= cur.boardAt - T_JOIN_CLOSE) {
        patch = { status: cur.memberCount >= 2 ? "locked" : "failed", poll: null, updatedAt: now };
      } else if (cur.memberCount < cur.capacity) {
        if (!cur.poll || !cur.poll.active) {
          if (now >= cur.boardAt - T_POLL_ASK && now < cur.boardAt - T_POLL_DUE) {
            patch = { poll: { active: true, status: "pending", askedAt: now, dueAt: cur.boardAt - T_POLL_DUE, responses: [] }, updatedAt: now };
          }
        } else if (now >= (cur.poll.dueAt || cur.boardAt - T_POLL_DUE)) {
          patch = { poll: { ...cur.poll, active: false, status: "accepted", responses: cur.poll.responses || [] }, updatedAt: now };
        }
      }
    } else if (cur.status === "locked" && now >= cur.boardAt) {
      patch = { status: "ongoing", updatedAt: now };
    } else if (cur.status === "ongoing" && !cur.settled && now >= cur.boardAt + T_SETTLE) {
      const noShows = (cur.members || []).filter((m) => !(m.checkedInAt && m.checkedInAt > 0)).map((m) => m.openid);
      patch = { status: "done", settled: true, noShowConfirmed: (cur.noShowConfirmed || []).concat(noShows), updatedAt: now };
      settle = true;
    } else {
      break; // 当前没有到期的推进
    }
    if (!patch) break;
    const upd = await db.collection("rides").where({ _id: cur._id, status: cur.status }).update({ data: patch });
    const won = !!(upd && upd.stats && upd.stats.updated > 0);
    if (won) {
      changed = true;
      cur = { ...cur, ...patch };
      if (settle) {
        for (const m of cur.members || []) {
          if (m.checkedInAt && m.checkedInAt > 0) await applyCreditDelta(m.openid, CREDIT_RIDE_OK);
          else await applyCreditDelta(m.openid, CREDIT_LEAVE_NO_SHOW);
        }
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
