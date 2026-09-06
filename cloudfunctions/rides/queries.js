// queries.js —— 只读查询：找局列表 / 我的局 / 局详情 / 聊天拉取
const { T_JOIN_CLOSE, T_FREE_EXIT, ACTIVE_STATUS, canCheckin } = require("./rules");
const { db, _, ok, fail, getRide, getMember, recentMessages } = require("./db");

const view = (r) => ({
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
});

async function list(event, openid) {
  const now = Date.now();
  const cond = { status: _.in(ACTIVE_STATUS), boardAt: _.gt(now - 5 * 60 * 1000) };
  if (event.directionId) cond.directionId = event.directionId;
  if (event.pickup) cond.from = event.pickup;
  if (event.date) cond.date = event.date;
  const res = await db.collection("rides").where(cond).orderBy("boardAt", "asc").limit(50).get();
  const rides = (res.data || []).map((r) => ({
    ...view(r),
    membersBrief: (r.members || []).slice(0, r.capacity).map((m) => ({ name: m.name, gender: m.gender || "" })),
    mine: r.hostOpenid === openid,
    joined: !!(r.memberOpenids || []).includes(openid),
  }));
  return ok({ rides });
}

async function my(event, openid) {
  const res = await db.collection("rides").where({ memberOpenids: openid }).limit(100).get();
  const rows = (res.data || []).map(view).sort((a, b) => b.boardAt - a.boardAt);
  const ongoing = rows.filter((r) => ["recruiting", "locked", "ongoing"].includes(r.status));
  const history = rows.filter((r) => ["done", "cancelled", "failed"].includes(r.status));
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
    canJoin: ride.status === "recruiting" && ride.memberCount < ride.capacity && !me && now <= ride.boardAt - T_JOIN_CLOSE,
    canCheckin: canCheckin(ride, me, now),
    canCancel: ride.hostOpenid === openid && now < ride.boardAt - T_FREE_EXIT,
    isMember: !!me,
    isHost: ride.hostOpenid === openid,
    messages: await recentMessages(ride._id),
  };
  return ok({ ride: d });
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

module.exports = { list, my, detail, rideMessages, routeList };
