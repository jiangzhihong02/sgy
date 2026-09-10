// tests/guard.spec.js —— 局内动作公共守卫（guard.checkGuards）单测
// 运行：node tests/guard.spec.js（纯 node；guard.js 零依赖，不碰 wx/db）
const assert = require("assert");
const { checkGuards } = require("../cloudfunctions/rides/guard");

const MIN = 60000;
const now = Date.UTC(2026, 8, 10, 10, 0, 0);
const ride = (o) => ({ status: "recruiting", boardAt: now + 30 * MIN, hostOpenid: "host", ...o });
const me = (o) => ({ openid: "u1", role: "member", checkedInAt: 0, ...o });

const checks = [];
const check = (name, fn) => {
  checks.push(name);
  try {
    fn();
  } catch (e) {
    console.error(`\n✗ ${name}`);
    throw e;
  }
};

// ---- member ----
check("member：me 为空 → NOT_IN（带自定义文案）", () => {
  const v = checkGuards(ride(), null, now, { member: { msg: "你不在这一局里" } });
  assert.strictEqual(v.err, "NOT_IN");
  assert.strictEqual(v.msg, "你不在这一局里");
});
check("member：me 存在 → 通过", () => {
  assert.strictEqual(checkGuards(ride(), me(), now, { member: { msg: "x" } }), null);
});

// ---- status ----
check("status：不在允许集合 → BAD_STATE", () => {
  const v = checkGuards(ride({ status: "done" }), me(), now, { status: { in: ["recruiting", "locked"], msg: "状态不可退出" } });
  assert.strictEqual(v.err, "BAD_STATE");
  assert.strictEqual(v.msg, "状态不可退出");
});
check("status：在允许集合 → 通过", () => {
  assert.strictEqual(checkGuards(ride(), me(), now, { status: { in: ["recruiting", "locked"], msg: "x" } }), null);
});

// ---- before ----
check("before：now < at → 通过", () => {
  assert.strictEqual(checkGuards(ride(), me(), now, { before: { at: (r) => r.boardAt, msg: "x" } }), null);
});
check("before：now >= at → TOO_LATE（边界相等即失败）", () => {
  const v = checkGuards(ride(), me(), now, { before: { at: (r) => r.boardAt - 30 * MIN, msg: "已到上车时间" } });
  assert.strictEqual(v.err, "TOO_LATE");
  assert.strictEqual(v.msg, "已到上车时间");
});
check("before：at 返回 null → 跳过（本动作此刻无窗口）", () => {
  assert.strictEqual(checkGuards(ride(), me(), now, { before: { at: () => null, msg: "x" } }), null);
});

// ---- 顺序（统一为 成员 → 状态 → 窗口）----
check("顺序：成员 > 状态 > 窗口", () => {
  const all = {
    member: { msg: "m" },
    status: { in: [], msg: "s" },
    before: { at: () => 0, msg: "b" },
  };
  assert.strictEqual(checkGuards(ride(), null, now, all).err, "NOT_IN"); // 最先卡成员
  assert.strictEqual(checkGuards(ride(), me(), now, all).err, "BAD_STATE"); // 成员过后卡状态
  assert.strictEqual(checkGuards(ride(), me(), now, { before: { at: () => 0, msg: "b" } }).err, "TOO_LATE");
});

// ---- 缺省 ----
check("缺省的守卫不适用：空 spec / 不传 spec 都通过", () => {
  assert.strictEqual(checkGuards(ride(), null, now, {}), null);
  assert.strictEqual(checkGuards(ride(), null, now), null);
});

console.log(`✅ guard.spec · ${checks.length} 个场景全过`);
