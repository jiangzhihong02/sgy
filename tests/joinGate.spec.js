// tests/joinGate.spec.js —— 加入确认门控（rideGate.decideJoinGate）单测
// 运行：node tests/joinGate.spec.js（纯 node，无 wx 依赖）
const assert = require("assert");
const { decideJoinGate } = require("../sgy/utils/rideGate");

const MIN = 60000;
const now = Date.UTC(2026, 8, 9, 10, 0, 0);
const ride = (o) => ({ urgent: false, boardAt: now + 90 * MIN, ...o });

const checks = [];
const check = (name, fn) => {
  checks.push(name);
  fn();
};

check("加急局 → urgent（承诺框）", () => {
  assert.strictEqual(decideJoinGate(ride({ urgent: true }), now), "urgent");
});

check("非加急、距发车 50min → near（提醒框）", () => {
  assert.strictEqual(decideJoinGate(ride({ boardAt: now + 50 * MIN }), now), "near");
});

check("非加急、距发车 61min → null（直接加）", () => {
  assert.strictEqual(decideJoinGate(ride({ boardAt: now + 61 * MIN }), now), null);
});

check("边界：恰好 60min → null（< 1h 才算 near）", () => {
  assert.strictEqual(decideJoinGate(ride({ boardAt: now + 60 * MIN }), now), null);
});

check("非加急、距发车 5min → near", () => {
  assert.strictEqual(decideJoinGate(ride({ boardAt: now + 5 * MIN }), now), "near");
});

check("缺 boardAt → null", () => {
  assert.strictEqual(decideJoinGate({ urgent: false }, now), null);
});

check("ride 为空 → null", () => {
  assert.strictEqual(decideJoinGate(null, now), null);
});

console.log(`✅ joinGate.spec · ${checks.length} 个场景全过`);
