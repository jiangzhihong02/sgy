// rideGuard.js —— 局内动作的公共前置（**薄 IO**）：取局 + 跑守卫 + 统一错误信封
// 纯判定在 guard.js（零依赖、可 node 单测）；本文件负责 IO 与信封，供 lifecycle 各动作复用：
//   withRide(rideId, openid, spec, fn) —— 局不存在或守卫不过 → 直接返回 fail；通过 → 把 (ride, me) 交给 fn。
//   spec.pre —— 可选：取到 (ride, me) 后**立刻**跑，早于一切守卫；返回非空即短路、直接当响应。
//     它表达的不是"拒绝的理由"，而是"无需再判、已经达成"（如 checkin 的幂等：已签 → 直接 ok）。
//     故不进 checkGuards —— 那里只产 fail，且顺序固定为 成员→角色→状态→窗口。
//     ⚠ 少了它，"已达成"会被后面的状态/窗口守卫先拦下：局已结算或过了签到窗口时，
//       重试签到会报 BAD_STATE/TOO_LATE，而非幂等成功（2026-09-10 修）。
// 本文件 require ./db（会 cloud.init），因此**单测请测 guard.js**，不要 require 这里。
const { fail, getRide, getMember } = require("./db");
const { checkGuards } = require("./guard");

async function withRide(rideId, openid, spec, fn) {
  const ride = await getRide(rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  const me = getMember(ride, openid);
  if (spec.pre) {
    const done = spec.pre(ride, me);
    if (done) return done;
  }
  const denied = checkGuards(ride, me, Date.now(), spec);
  if (denied) return fail(denied.err, denied.msg);
  return fn(ride, me);
}

module.exports = { withRide };
