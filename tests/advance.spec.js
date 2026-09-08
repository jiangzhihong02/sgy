// tests/advance.spec.js —— 读时自愈状态机纯判定（advance.js planAdvance）单测
// 运行：node tests/advance.spec.js（纯 node，无 wx 依赖；advance.js 只 require 纯 rules.js）
// 契约：cloudfunctions/SPEC.md §3/§4。
const assert = require("assert");
const { planAdvance } = require("../cloudfunctions/rides/advance");
const {
  T_JOIN_CLOSE, T_POLL_ASK, T_POLL_DUE, T_SETTLE, CONFIRM_WINDOW_MS,
} = require("../cloudfunctions/rides/rules");

const MIN = 60000;
const T = Date.UTC(2026, 8, 8, 10, 0, 0); // 固定上车时刻（本地 node 时区无关）

const ride = (over) => ({
  _id: "r1",
  boardAt: T,
  status: "recruiting",
  memberCount: 1,
  capacity: 4,
  members: [],
  poll: null,
  noShowConfirmed: [],
  settled: false,
  ...over,
});

const checks = [];
const check = (name, fn) => {
  checks.push(name);
  fn();
};

check("recruiting ≥2 → 锁定 locked", () => {
  const p = planAdvance(ride({ memberCount: 2 }), T - T_JOIN_CLOSE);
  assert(p, "应有推进");
  assert.strictEqual(p.patch.status, "locked");
  assert.strictEqual(p.settle, null);
});

check("recruiting <2 → 未成局 failed", () => {
  const p = planAdvance(ride({ memberCount: 1 }), T - T_JOIN_CLOSE);
  assert(p);
  assert.strictEqual(p.patch.status, "failed");
});

check("加急局 T−5 关局：now=boardAt−5min → locked", () => {
  const p = planAdvance(ride({ urgent: true, memberCount: 2 }), T - 5 * MIN);
  assert(p, "加急局应到 T−5 关局");
  assert.strictEqual(p.patch.status, "locked");
});

check("加急局未到 T−5（now=boardAt−7min）→ 无推进", () => {
  const p = planAdvance(ride({ urgent: true, memberCount: 2 }), T - 7 * MIN);
  assert.strictEqual(p, null, "加急局 T−5 前不应关局");
});

check("普通局 T−10 关局：now=boardAt−7min → locked", () => {
  const p = planAdvance(ride({ memberCount: 2 }), T - 7 * MIN);
  assert(p, "普通局应到 T−10 关局");
  assert.strictEqual(p.patch.status, "locked");
});

check("recruiting 未满且 T−60 → 建人数轮询", () => {
  const p = planAdvance(ride({ memberCount: 1 }), T - T_POLL_ASK);
  assert(p, "应有推进");
  assert.strictEqual(p.patch.poll.active, true);
  assert.strictEqual(p.patch.poll.dueAt, T - T_POLL_DUE);
});

check("轮询到期 → accepted（active=false）", () => {
  const poll = { active: true, status: "pending", dueAt: T - T_POLL_DUE, responses: [{ openid: "a", accept: true, at: 1 }] };
  const p = planAdvance(ride({ memberCount: 1, poll }), T - T_POLL_DUE);
  assert(p);
  assert.strictEqual(p.patch.poll.active, false);
  assert.strictEqual(p.patch.poll.status, "accepted");
  assert.strictEqual(p.patch.poll.responses.length, 1);
});

check("locked 到点 → 进行中 ongoing", () => {
  const p = planAdvance(ride({ status: "locked", memberCount: 2 }), T);
  assert(p);
  assert.strictEqual(p.patch.status, "ongoing");
});

check("ongoing 结算：已签 +1，未签挂 pendingConfirm", () => {
  const p = planAdvance(
    ride({ status: "ongoing", members: [
      { openid: "a", checkedInAt: T - 10 },
      { openid: "b", checkedInAt: 0 },
    ] }),
    T + T_SETTLE
  );
  assert(p);
  assert.strictEqual(p.patch.status, "done");
  assert.deepStrictEqual(p.settle.plus, ["a"]);
  assert.deepStrictEqual(p.settle.minus, []);
  assert.deepStrictEqual(p.patch.pendingConfirm.openids, ["b"]);
  assert.strictEqual(p.patch.pendingConfirm.dueAt, T + T_SETTLE + CONFIRM_WINDOW_MS);
});

check("结算晚于 48h 确认窗：未签者直接落罚", () => {
  const p = planAdvance(
    ride({ status: "ongoing", members: [
      { openid: "a", checkedInAt: T - 10 },
      { openid: "b", checkedInAt: 0 },
    ] }),
    T + T_SETTLE + CONFIRM_WINDOW_MS + 1
  );
  assert(p);
  assert.deepStrictEqual(p.settle.minus, ["b"]);
  assert.ok(p.patch.noShowConfirmed.includes("b"));
});

check("done 且补签窗口到期：未确认者 deferredPenalty", () => {
  const p = planAdvance(
    ride({ status: "done", settled: true, pendingConfirm: { dueAt: T + T_SETTLE + CONFIRM_WINDOW_MS, openids: ["b", "c"], resolved: ["c"], settled: false } }),
    T + T_SETTLE + CONFIRM_WINDOW_MS
  );
  assert(p);
  assert.deepStrictEqual(p.deferredPenalty, ["b"]);
  assert.strictEqual(p.patch.pendingConfirm.settled, true);
  assert.ok(p.patch.noShowConfirmed.includes("b"));
  assert.ok(!p.patch.noShowConfirmed.includes("c"));
});

check("done 补签全确认：无落罚", () => {
  const p = planAdvance(
    ride({ status: "done", settled: true, pendingConfirm: { dueAt: T + T_SETTLE + CONFIRM_WINDOW_MS, openids: ["b", "c"], resolved: ["b", "c"], settled: false } }),
    T + T_SETTLE + CONFIRM_WINDOW_MS
  );
  assert(p);
  assert.strictEqual(p.deferredPenalty, null);
});

check("done 无 pendingConfirm → 无推进", () => {
  assert.strictEqual(planAdvance(ride({ status: "done", settled: true }), Date.now()), null);
});

check("recruiting 已满员且未到关局 → 无推进", () => {
  assert.strictEqual(planAdvance(ride({ memberCount: 4, capacity: 4 }), T - T_POLL_ASK), null);
});

check("done 补签未到期 → 无推进", () => {
  const p = planAdvance(
    ride({ status: "done", settled: true, pendingConfirm: { dueAt: T + T_SETTLE + CONFIRM_WINDOW_MS, openids: ["b"], resolved: [], settled: false } }),
    T + T_SETTLE - 1
  );
  assert.strictEqual(p, null);
});

console.log(`✅ advance.spec · ${checks.length} 个场景全过`);
