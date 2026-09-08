// advance.js —— 读时自愈状态机的纯判定（无 IO，可在本地 node 直接单测）
// planAdvance(raw, now)：
//   入参：一张 rides 文档（raw）+ 当前时刻（now 毫秒）
//   出参：{ patch, settle, deferredPenalty } | null
//     patch            —— 要条件更新写回 rides 的字段（不含 _id / status 守卫；updatedAt 已带）
//     settle           —— 本次翻转是否结算（done）：{ plus: 已签到成员 openid[], minus: 结算时已过确认窗的未签成员[] }
//     deferredPenalty  —— 补签到确认窗口到期仍未确认的 openid[]（null = 无）
//   推进序：recruiting →(T−T_JOIN_CLOSE)→ locked/failed | 人数轮询建/结
//         locked →(T)→ ongoing
//         ongoing →(T+T_SETTLE, 未 settled)→ done + 结算（未签挂 pendingConfirm，等 48h 确认）
//         done + pendingConfirm 到期 → 未确认者记爽约（deferredPenalty）
//   调用方（db.advanceStatus）负责：条件原子更新、竞争重拉、按 settle/deferred 写信用分。
const {
  T_POLL_ASK,
  T_POLL_DUE,
  T_SETTLE,
  CONFIRM_WINDOW_MS,
  joinCloseMs, // 关局提前量：加急局 T−5、正常局 T−10
} = require("./rules");

function planAdvance(raw, now) {
  const cur = raw;
  let patch = null;
  let settle = null;
  let deferredPenalty = null;

  if (cur.status === "recruiting") {
    if (now >= cur.boardAt - joinCloseMs(cur)) {
      patch = { status: cur.memberCount >= 2 ? "locked" : "failed", poll: null, updatedAt: now };
    } else if (cur.memberCount < cur.capacity) {
      if (!cur.poll || !cur.poll.active) {
        if (now >= cur.boardAt - T_POLL_ASK && now < cur.boardAt - T_POLL_DUE) {
          patch = { poll: { active: true, status: "pending", askedAt: now, dueAt: cur.boardAt - T_POLL_DUE, responses: [] }, updatedAt: now };
        }
      } else if (now >= (cur.poll.dueAt || cur.boardAt - T_POLL_DUE)) {
        patch = { poll: { ...cur.poll, active: false, status: "accepted", responses: cur.poll.responses || [] }, updatedAt: now };
      }
    }
  } else if (cur.status === "locked" && now >= cur.boardAt) {
    patch = { status: "ongoing", updatedAt: now };
  } else if (cur.status === "ongoing" && !cur.settled && now >= cur.boardAt + T_SETTLE) {
    // 结算：已签到 +1；未签不立即扣分，挂 pendingConfirm（48h 窗口），结算晚于窗口的极端情况直接落罚
    const pending = (cur.members || []).filter((m) => !(m.checkedInAt && m.checkedInAt > 0)).map((m) => m.openid);
    const confirmDue = cur.boardAt + T_SETTLE + CONFIRM_WINDOW_MS;
    const expiredNow = now >= confirmDue;
    patch = {
      status: "done",
      settled: true,
      noShowConfirmed: (cur.noShowConfirmed || []).concat(expiredNow ? pending : []),
      pendingConfirm: { dueAt: confirmDue, openids: pending, resolved: [], settled: false },
      updatedAt: now,
    };
    settle = {
      plus: (cur.members || []).filter((m) => m.checkedInAt && m.checkedInAt > 0).map((m) => m.openid),
      minus: expiredNow ? pending : [],
    };
  } else if (cur.status === "done" && cur.pendingConfirm && !cur.pendingConfirm.settled && now >= (cur.pendingConfirm.dueAt || 0)) {
    const pc = cur.pendingConfirm;
    const un = (pc.openids || []).filter((o) => !(pc.resolved || []).includes(o));
    const npc = { ...pc, settled: true };
    patch = un.length
      ? { pendingConfirm: npc, noShowConfirmed: (cur.noShowConfirmed || []).concat(un), updatedAt: now }
      : { pendingConfirm: npc, updatedAt: now };
    deferredPenalty = un.length ? un : null;
  } else {
    return null;
  }
  if (!patch) return null;
  return { patch, settle, deferredPenalty };
}

module.exports = { planAdvance };
