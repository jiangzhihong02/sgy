// sgy/utils/rulesText.js —— 面向用户的规则面板
// 单一来源：rides 云函数 rules.js（rides.getRules 下发，文案与数值同文件）。本模块像 routes.js 一样
// 「云端为准 + 本地快照兜底」：拉取失败/未拉到时用 FALLBACK，保证规则弹层/校验不空。
const api = require("./api");

// 快照：与 cloudfunctions/rides/rules.js rulePayload() 当前值一致（云端改规则后此兜底可滞后，属可接受降级）。
const FALLBACK = {
  timeline: [
    { t: "最少 2 人", d: "即成一局；不足 2 人的局会在上车前自动取消，不计爽约。" },
    { t: "出发前 60 分钟", d: "人数还没满时，全员确认是否「按当前人数出发」，没回复默认同意。" },
    { t: "出发前 30 分钟", d: "此前可自由退出、发起人可解散；之后再退出算爽约，扣信用分。" },
    { t: "出发前 10 分钟", d: "停止加入，按当时人数锁定成局。" },
    { t: "约定时间", d: "到上车点的士站集合，点「我到了」告诉队友你已到。" },
    { t: "上车后 10 分钟", d: "停止「我到了」签到；之后仍没签到也没退出的，系统会在局结束时按爽约自动扣信用分。" },
  ],
  preview:
    "最少 2 人成局，人数上限由你设（2–4）。按出发时间倒推：提前 60 分钟未满员时，全员确认是否按当前人数出发（没回复默认同意，至出发前 45 分钟）；提前 30 分钟前可自由退出、你可解散；提前 10 分钟停止加入、按当时人数锁定成局，不足 2 人自动取消（不计爽约）；到点在上车点的士站集合点「我到了」，上车后 10 分钟停止签到，局结束仍未签到将按爽约自动扣信用分。",
  creditText:
    "初始 100，封顶 120。爽约（出发前 30 分钟后退出、或到点没「我到了」）自动 -20；成功同行 +1。拼车结束后，队友可就 迟到(-10) / 缺勤·没来(-20) / 性别不实(-20) 举报：同一局 ≥2 名成员联名即自动坐实，否则转管理员复核。低于 60 暂停发起新局 7 天（仍可加入）。",
  privacyText:
    "性别为自报，仅用于组队时以头像框颜色辨认（蓝男·粉女）。填写的性别与真实不符，会被同车人举报：坐实后清空性别并扣信用分；若同一局有 3 名以上成员同报、或你被多次坐实，则系统把性别改为判定的另一性别并锁定（仅管理员可纠正）。不展示微信号，站内联系。",
  limits: { msgMax: 200, imgMax: 500000, noteMax: 50 },
};

let cache = null; // null = 尚未成功拉到云端（用快照兜底）

/** 当前生效面板（同步）。 */
function payload() {
  return cache || FALLBACK;
}

/** 拉取一次并缓存；失败/空则退回快照。返回当前生效面板。 */
function load() {
  if (cache) return Promise.resolve(cache);
  return api
    .call("rides", { action: "getRules" })
    .then((res) => {
      if (res.ok && res.data && Array.isArray(res.data.timeline) && res.data.limits) cache = res.data;
      return cache || FALLBACK;
    })
    .catch(() => FALLBACK);
}

const timeline = () => (payload().timeline || []).map((r) => ({ t: r.t, d: r.d }));
const preview = () => payload().preview || "";
const creditText = () => payload().creditText || "";
const privacyText = () => payload().privacyText || "";
const imgMax = () => ((payload().limits || {}).imgMax) || 500000;

module.exports = { payload, load, timeline, preview, creditText, privacyText, imgMax };
