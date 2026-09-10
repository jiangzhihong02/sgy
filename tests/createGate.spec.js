// tests/createGate.spec.js —— 发局页「时间 / 加急」判定单测
// 运行：node tests/createGate.spec.js（纯 node；createGate.js 零依赖）
//
// 本测试锁死一个曾经存在的 bug：**加急局勾不上**（循环依赖）——
//   onToggleUrgent 要求"所选时间已在 15–30 分钟内"，而选时间时（未勾加急）下限又是 31 分钟，
//   于是"要勾加急得先有时间、要有那段时间得先勾加急"，加急局永远发不出去。
const assert = require("assert");
const { judgeTime, canToggleUrgent } = require("../sgy/utils/createGate");

const MIN = 60000;
const CFG = { normalMin: 31 * MIN, urgentMin: 15 * MIN, urgentWindow: 30 * MIN };

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

// —— 回归：不许再出现"能勾加急却设不了该时间"的循环依赖 ——
check("能勾加急的时间，也必须能先被设成出发时间（无循环依赖）", () => {
  for (let m = 15; m <= 30; m += 1) {
    const lead = m * MIN;
    if (!canToggleUrgent(lead, CFG)) continue;
    const v = judgeTime(lead, false, CFG);
    assert.strictEqual(v.ok, true, `${m} 分钟：能勾加急，却设不了该时间（${v.msg}）`);
  }
});

// —— 临近时间（15–30 分钟）：可以设，但要提示"是否按加急局发起" ——
check("20 分钟后出发：时间应可用，且建议加急", () => {
  const v = judgeTime(20 * MIN, false, CFG);
  assert.strictEqual(v.ok, true, `被拒了：${v.msg}`);
  assert.strictEqual(v.suggestUrgent, true, "15–30 分钟应建议加急");
});

check("已选加急时，20 分钟后出发：可用、不再重复建议", () => {
  const v = judgeTime(20 * MIN, true, CFG);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(!!v.suggestUrgent, false);
});

// —— 边界 ——
check("不足 15 分钟：拒绝（普通/加急都太早）", () => {
  assert.strictEqual(judgeTime(14 * MIN, false, CFG).ok, false);
  assert.strictEqual(judgeTime(14 * MIN, true, CFG).ok, false);
});

check("30 分钟整：可用，但必须是加急局（服务端普通局要求 >30 分钟）", () => {
  // 注：这条断言在修复时**刻意改过**——原先期望"一律拒绝"。但 30 分钟整在加急区间内，
  // 一律拒绝会把这一档加急也堵死（等于在别处重犯同一个循环依赖）。正确语义＝可用＋强制转加急。
  const v = judgeTime(30 * MIN, false, CFG);
  assert.strictEqual(v.ok, true, "应可用（走加急），而不是被拒");
  assert.strictEqual(v.suggestUrgent, true, "必须提示转加急");
});

check("普通局 40 分钟：可用、不建议加急", () => {
  const v = judgeTime(40 * MIN, false, CFG);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(!!v.suggestUrgent, false);
});

check("加急局 40 分钟：拒绝（加急仅限 30 分钟内）", () => {
  assert.strictEqual(judgeTime(40 * MIN, true, CFG).ok, false);
});

console.log(`✅ createGate.spec · ${checks.length} 个场景全过`);
