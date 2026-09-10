// guard.js —— 局内动作的公共前置守卫（**纯判定，零依赖**，可在 node 直接单测）
// 与 rideGuard.js 配对：本文件只判对错（无 IO、无 wx），那边负责取局/取成员并套统一错误信封。
//
// 判定顺序**统一**为：成员 → 角色 → 状态 → 窗口（2026-09-10 收拢；此前各 action 顺序不一）。
// 错误码：NOT_IN（不是成员）/ NOT_HOST（不是发起人）/ BAD_STATE（状态不允许）/ TOO_LATE（过了可操作时间）。
// 动作**特有**的前置条件（如 respondPoll 的"当前没有人数确认"、confirmRide 的"你不在待确认名单"）
// 不进这里，由动作自己在 fn 里返回——避免为个别动作把 interface 撑大。
//
// 注：join / create / confirmPending **不适用**本守卫——join 的调用者还不是成员且检查多为动作特有，
// create 无局可载，confirmPending 是纯查询。

/**
 * 按 spec 跑一组守卫，返回第一个未通过的 { err, msg }；全部通过返回 null。
 * spec 的键即守卫种类，**缺省 = 该守卫不适用**：
 *   member: { msg }                            —— 我必须是本局成员
 *   host:   { msg }                            —— 我必须是发起人
 *   status: { in: string[], msg }              —— 本局状态必须属于 in
 *   before: { at: (ride) => ms|null, msg }     —— 当前时刻须早于 at；at 返回 null 表示此刻无窗口（跳过）
 */
function checkGuards(ride, me, now, spec = {}) {
  if (spec.member && !me) return { err: "NOT_IN", msg: spec.member.msg };
  if (spec.host && (!me || ride.hostOpenid !== me.openid)) return { err: "NOT_HOST", msg: spec.host.msg };
  if (spec.status && !spec.status.in.includes(ride.status)) return { err: "BAD_STATE", msg: spec.status.msg };
  if (spec.before) {
    const at = spec.before.at(ride);
    if (at != null && now >= at) return { err: "TOO_LATE", msg: spec.before.msg };
  }
  return null;
}

module.exports = { checkGuards };
