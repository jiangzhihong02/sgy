// invites.js —— 组队邀请与"下周同一时刻再约"
const { T_FREE_EXIT, ACTIVE_STATUS } = require("./rules");
const { db, _, ok, fail, ensureUser, ensureRegistered, getRide } = require("./db");
const { create } = require("./lifecycle");

// 已完成局"下周同一时刻再约"：复用/新建进行中局并邀请老队友
async function reinvite(event, openid) {
  const old = await getRide(event.rideId);
  if (!old) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (old.status !== "done") return fail("NOT_DONE", "拼车结束后才能再约队友");
  if (!(old.memberOpenids || []).includes(openid)) return fail("NOT_IN", "只有同局成员能再约");
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
  if (!ACTIVE_STATUS.includes(ride.status)) return fail("NOT_OPEN", "只能邀请加入进行中的局");
  if (!(ride.memberOpenids || []).includes(openid)) return fail("NOT_IN", "只有局内成员能发出邀请");
  if (event.targetOpenid === openid) return fail("BAD_TARGET", "不能邀请自己");
  if ((ride.memberOpenids || []).includes(event.targetOpenid)) return fail("ALREADY_IN", "对方已在这一局");
  const needReg = await ensureRegistered(openid);
  if (needReg) return needReg;
  const now = Date.now();
  const dup = await db.collection("invites").where({ rideId: ride._id, toOpenid: event.targetOpenid, status: "pending" }).count();
  if (dup.total > 0) return fail("DUP", "已邀请过对方");
  const me = await ensureUser(openid);
  await db.collection("invites").add({
    data: {
      rideId: ride._id,
      fromOpenid: openid,
      fromName: me.nickName || "拼友",
      toOpenid: event.targetOpenid,
      status: "pending",
      createdAt: now,
    },
  });
  return ok({ sent: true });
}

async function inviteList(event, openid) {
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
      live: ACTIVE_STATUS.includes(ride.status) && ride.memberCount < ride.capacity,
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

module.exports = { reinvite, inviteSend, inviteList, respondInvite };
