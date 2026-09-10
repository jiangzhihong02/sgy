// sgy/utils/createGate.js —— 发局页的「时间 / 加急」判定（纯函数，无 wx，可在 node 测）
// 抽出来的理由：这段规则原先内联在 pages/create/create.js 里、**不可测**，
// 于是"加急局勾不上"的循环依赖一直没被发现（见 tests/createGate.spec.js）。
//
// ⚠ 曾经的 bug：勾加急要求"所选时间已在 15–30 分钟内"，而选时间（未勾加急）下限是 31 分钟
//   ⇒ 要勾加急得先有时间、要有那段时间得先勾加急 —— **加急局永远发不出去**。
// 修复原则：**加急不是前置条件，而是对"临近时间"的建议**——
//   先选时间 → 选到 15–30 分钟就返回 suggestUrgent，由页面问"要不要按加急局发起"；
//   反过来先勾加急也照样能用（页面据此把时间下限放宽到 urgentMin）。
//
// 与服务端 rides/rules.js 同口径：普通局 >30min 发起；加急局 15–30 分钟内出发。
// 三个阈值由调用方注入（依赖注入，不在模块内造字面量），便于测试固定取值。

/**
 * 判定候选出发时间能否使用。
 * @param {number} lead 距现在的毫秒数
 * @param {boolean} urgent 当前是否已勾选加急
 * @param {{normalMin:number, urgentMin:number, urgentWindow:number}} cfg
 * @returns {{ok:boolean, msg?:string, suggestUrgent?:boolean}}
 *   ok=false          —— 该时间不可用（msg 为给用户看的原因）
 *   suggestUrgent=true—— 时间可用，但**必须按加急局发起**（服务端普通局要求 >30min），
 *                       页面应弹窗询问；用户若拒绝加急，则不可用该时间
 */
function judgeTime(lead, urgent, cfg) {
  if (urgent) {
    if (lead < cfg.urgentMin) return { ok: false, msg: "加急局最早提前 15 分钟发起" };
    if (lead > cfg.urgentWindow) return { ok: false, msg: "加急仅限 30 分钟内出发" };
    return { ok: true };
  }
  if (lead < cfg.urgentMin) return { ok: false, msg: "出发时间最早提前 15 分钟" };
  // 15–30 分钟：可发起，但只能作为加急局 —— 这里返回"建议加急"而不是拒绝（修复点）
  if (lead <= cfg.urgentWindow) return { ok: true, suggestUrgent: true };
  if (lead < cfg.normalMin) return { ok: false, msg: "出发时间不能早于当前 31 分钟" };
  return { ok: true };
}

/** 加急适用的时间区间（页面勾选加急后，据此把时间下限放宽）。 */
function canToggleUrgent(lead, cfg) {
  return lead >= cfg.urgentMin && lead <= cfg.urgentWindow;
}

module.exports = { judgeTime, canToggleUrgent };
