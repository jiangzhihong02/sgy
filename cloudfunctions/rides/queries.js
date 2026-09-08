// queries.js —— 只读查询：找局列表 / 我的局 / 局详情 / 聊天拉取
const { T_FREE_EXIT, ACTIVE_STATUS, canCheckin, rulePayload, joinCloseMs } = require("./rules");
const { db, _, ok, fail, getRide, getMember, recentMessages, blockersOf, advanceMany } = require("./db");

const view = (r) => ({
  _id: r._id,
  routeId: r.routeId,
  directionId: r.directionId,
  from: r.from,
  to: r.to,
  routeLabel: `${r.from} → ${r.to}`,
  boardAt: r.boardAt,
  urgent: !!r.urgent, // 加急局标记（找局红标/排序语义）
  capacity: r.capacity,
  memberCount: r.memberCount,
  status: r.status,
  womenOnly: r.womenOnly,
  note: r.note,
  hostOpenid: r.hostOpenid,
  poll: r.poll || null,
});

async function list(event, openid) {
  const now = Date.now();
  const cond = { status: _.in(ACTIVE_STATUS), boardAt: _.gt(now - 5 * 60 * 1000) };
  if (event.directionId) cond.directionId = event.directionId;
  if (event.pickup) cond.from = event.pickup;
  if (event.date) cond.date = event.date;
  const res = await db.collection("rides").where(cond).orderBy("boardAt", "asc").limit(50).get();
  // 读时自愈：先把这批到期局就地推进（关局/上路/结算），翻完就不再出现在列表
  let raw = await advanceMany(res.data || []);
  raw = raw.filter((r) => ACTIVE_STATUS.includes(r.status));
  // 先到者优先：隐藏"host 是 不想带我的人"发起的局（对方标过我，不希望我出现在他/她的局里；join 另有否决兜底）
  const blockers = await blockersOf(openid);
  if (blockers.size) raw = raw.filter((r) => !blockers.has(r.hostOpenid));
  const rides = raw.map((r) => ({
    ...view(r),
    membersBrief: (r.members || []).slice(0, r.capacity).map((m) => ({ name: m.name, gender: m.gender || "" })),
    mine: r.hostOpenid === openid,
    joined: !!(r.memberOpenids || []).includes(openid),
  }));
  return ok({ rides });
}

async function my(event, openid) {
  const res = await db.collection("rides").where({ memberOpenids: openid }).limit(100).get();
  const adv = await advanceMany(res.data || []); // 读时自愈：过期未关/未结算的先就地推进
  const rows = adv.map(view);
  // 分桶排序：未完成按出发时间升序（先出发在前——聊天室切换栏/行程"未完成"都是"下一个要上的局"在前，新加入的局每次重建自动入位）；历史降序（最近完成在前）
  const ongoing = rows.filter((r) => ["recruiting", "locked", "ongoing"].includes(r.status)).sort((a, b) => a.boardAt - b.boardAt);
  const history = rows.filter((r) => ["done", "cancelled", "failed"].includes(r.status)).sort((a, b) => b.boardAt - a.boardAt);
  return ok({ ongoing, history });
}

async function detail(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  const me = getMember(ride, openid);
  const now = Date.now();
  const d = {
    ...view(ride),
    members: ride.members.map((m) => ({ openid: m.openid, name: m.name, role: m.role, gender: m.gender || "", checkedInAt: m.checkedInAt })),
    canJoin: ride.status === "recruiting" && ride.memberCount < ride.capacity && !me && now <= ride.boardAt - joinCloseMs(ride),
    canCheckin: canCheckin(ride, me, now),
    canCancel: ride.hostOpenid === openid && now < ride.boardAt - T_FREE_EXIT,
    isMember: !!me,
    isHost: ride.hostOpenid === openid,
    blockedInRide: await blockedNamesIn(ride, openid), // 本局里被我标过「不与其乘车」的人（标记者可见横幅）
    messages: await recentMessages(ride._id),
  };
  return ok({ ride: d });
}

// 我在本局中标记过「不与其乘车」的成员（去重、排除自己、缺集合降级为空）
async function blockedNamesIn(ride, openid) {
  const ids = (ride.members || []).map((m) => m.openid).filter((o) => o && o !== openid);
  if (!ids.length) return [];
  try {
    const blk = await db.collection("blocks").where({ byOpenid: openid, targetOpenid: _.in(ids) }).get();
    const set = new Set((blk.data || []).map((b) => b.targetOpenid));
    return (ride.members || []).filter((m) => set.has(m.openid)).map((m) => ({ openid: m.openid, name: m.name }));
  } catch (e) {
    return [];
  }
}

async function rideMessages(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (!getMember(ride, openid)) return fail("NOT_IN", "只有成员能查看聊天");
  return ok({ messages: await recentMessages(ride._id) });
}

// 线路目录只读下发（管理员可在 routes 集合增改；客户端拉取后本地快照仅兜底）
async function routeList(event) {
  const res = await db.collection("routes").where({ enabled: true }).orderBy("directionId", "asc").limit(100).get();
  return ok({
    routes: (res.data || []).map((r) => ({ routeId: r.routeId, directionId: r.directionId, from: r.from, to: r.to })),
  });
}

// 面向用户规则面板下发（文案与数值单一来源 rides/rules.js；客户端本地快照仅兜底）
async function getRules() {
  return ok(rulePayload());
}

module.exports = { list, my, detail, rideMessages, routeList, getRules };
