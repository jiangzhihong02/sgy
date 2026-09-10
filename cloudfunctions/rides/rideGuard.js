// rideGuard.js —— 局内动作的公共前置（**薄 IO**）：取局 + 跑守卫 + 统一错误信封
// 纯判定在 guard.js（零依赖、可 node 单测）；本文件负责 IO 与信封，供 lifecycle 各动作复用：
//   withRide(rideId, openid, spec, fn) —— 局不存在或守卫不过 → 直接返回 fail；通过 → 把 (ride, me) 交给 fn。
// 本文件 require ./db（会 cloud.init），因此**单测请测 guard.js**，不要 require 这里。
const { fail, getRide, getMember } = require("./db");
const { checkGuards } = require("./guard");

async function withRide(rideId, openid, spec, fn) {
  const ride = await getRide(rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  const me = getMember(ride, openid);
  const denied = checkGuards(ride, me, Date.now(), spec);
  if (denied) return fail(denied.err, denied.msg);
  return fn(ride, me);
}

module.exports = { withRide };
