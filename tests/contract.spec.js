// tests/contract.spec.js —— 跨端契约一致性检查（客户端快照 vs 云端"唯一来源"）
// 运行：node tests/contract.spec.js
//
// 为什么需要它：小程序客户端与云函数是**两个部署单元，无法共享代码**，于是同一些事实
// （规则面板文案/数值、线路目录、时间解析口径）各存一份、靠人手同步。这里在 node 里
// 同时 require 两侧的**纯模块**并断言相等——漂移即刻变红，而不是等线上表现不一致才发现。
// 前提：被 require 的两侧模块必须保持"无 wx / 无 wx-server-sdk"（见各文件头注）。
const assert = require("assert");
const rules = require("../cloudfunctions/rides/rules");
const rulesText = require("../sgy/utils/rulesText");
const domain = require("../sgy/utils/domain");
const { ROUTES: SEED_ROUTES } = require("../cloudfunctions/routeInit/catalog");

const checks = [];
const check = (name, fn) => {
  checks.push(name);
  try {
    fn();
  } catch (e) {
    console.error(`\n✗ ${name}`); // 先点出漂移的是哪一项，assert 的差异输出紧随其后
    throw e;
  }
};

// ---- 规则面板：sgy/utils/rulesText.js 的离线快照 vs rides/rules.js rulePayload() ----
const panel = rules.rulePayload();
const snap = rulesText.FALLBACK;

check("规则面板 · timeline 一致", () => assert.deepStrictEqual(snap.timeline, panel.timeline));
check("规则面板 · creditTable 一致", () => assert.deepStrictEqual(snap.creditTable, panel.creditTable));
check("规则面板 · creditFooter 一致", () => assert.deepStrictEqual(snap.creditFooter, panel.creditFooter));
check("规则面板 · privacySections 一致", () => assert.deepStrictEqual(snap.privacySections, panel.privacySections));
check("规则面板 · limits 一致", () => assert.deepStrictEqual(snap.limits, panel.limits));

// 防"空洞通过"：两侧都空也能 deepStrictEqual 相等，但那是假绿。
check("契约检查非空洞（两侧都有内容）", () => {
  assert.ok(panel.timeline.length > 0 && snap.timeline.length > 0, "timeline 为空");
  assert.ok(panel.creditTable.length > 0 && snap.creditTable.length > 0, "creditTable 为空");
  assert.ok(panel.privacySections.length > 0 && snap.privacySections.length > 0, "privacySections 为空");
});

// ---- 线路目录：sgy/utils/domain.js 的离线快照 vs routeInit/catalog.js 的 seed ----
check("线路目录 · 逐条一致（含顺序）", () => {
  const clientRoutes = domain.ROUTES.map((r) => ({
    routeId: r.id,
    directionId: r.directionId,
    from: r.from,
    to: r.to,
  }));
  assert.deepStrictEqual(clientRoutes, SEED_ROUTES);
});

// ---- 时间口径：两个部署单元各有一份 dateTimeToMs（无法共享实现），至少行为要一致 ----
check("dateTimeToMs · 与云端同口径", () => {
  const samples = [
    ["2026-09-10", "07:40"],
    ["2026-01-01", "00:00"],
    ["2026-12-31", "23:59"],
    ["", ""],
    ["not-a-date", "99:99"],
  ];
  samples.forEach(([d, t]) => {
    assert.strictEqual(domain.dateTimeToMs(d, t), rules.dateTimeToMs(d, t), `样本 ${d} ${t}`);
  });
});

// 刻意**不**纳入：rideGate 的"距发车 <1 小时"（sgy/utils/rideGate.js）与云端 T_POLL_ASK(60min)
// 数值相同但语义不同（"来不及集合"的提醒 vs "人数确认"的发起点），断言相等会误导。

console.log(`✅ contract.spec · ${checks.length} 项契约一致`);
