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
  creditTable: [
    { event: "初始", note: "注册即默认", delta: "+100", up: true },
    { event: "爽约", note: "出发前 30 分钟后退出 / 到点没签到，经 48h 补确认仍没上车或逾期不答", delta: "-20", up: false },
    { event: "迟到", note: "举报坐实（同局 ≥2 人联名自动，否则管理员复核）", delta: "-10", up: false },
    { event: "缺勤·没来", note: "举报坐实；谎报「上车了」也靠队友报此条兜底", delta: "-20", up: false },
    { event: "性别不实", note: "举报坐实，顺带清空性别；多人/多次坐实会反推锁定", delta: "-20", up: false },
    { event: "成功同行", note: "到点签到且局完成，结算自动", delta: "+1", up: true },
  ],
  creditFooter: "封顶 120。低于 60 暂停发起新局 7 天（仍可加入）。",
  privacySections: [
    {
      title: "性别（自报，不验证）",
      lines: [
        "仅用于组队/聊天里以头像框颜色辨认（蓝男·粉女）。",
        "自报不实会被同车人举报：坐实后清空性别并扣 -20。",
        "同一局 ≥3 名成员同报、或多次坐实 → 系统把性别改为判定的另一性别并锁定，仅管理员可纠正。",
      ],
    },
    {
      title: "校内身份（自报不核验）",
      lines: [
        "登记是威慑与线下好辨认，系统不验证真伪。",
        "同车人只看到「✓ 校内已登记」绿标，学号与姓名明文不对外。",
        "学号与姓名仅本人与管理员可见；填错可自行修改，撤销登记需联系管理员。",
      ],
    },
    {
      title: "联系方式",
      lines: ["不展示微信号。", "站内联系走局内聊天室。"],
    },
  ],
  limits: { msgMax: 200, imgMax: 500000, noteMax: 50, chatKeepMs: 175500000, urgentMinLead: 900000, urgentWindow: 1800000 }, // chatKeepMs=45min+48h；urgentMinLead=15min、urgentWindow=30min
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
    .call("getRules")
    .then((res) => {
      if (res.ok && res.data && Array.isArray(res.data.timeline) && res.data.limits) cache = res.data;
      return cache || FALLBACK;
    })
    .catch(() => FALLBACK);
}

const timeline = () => (payload().timeline || []).map((r) => ({ t: r.t, d: r.d }));
const creditTable = () => payload().creditTable || [];
const creditFooter = () => payload().creditFooter || "";
const privacySections = () => payload().privacySections || [];
const imgMax = () => ((payload().limits || {}).imgMax) || 500000;
const chatKeepMs = () => ((payload().limits || {}).chatKeepMs) || 175500000;
const urgentMinLead = () => ((payload().limits || {}).urgentMinLead) || 900000;
const urgentWindow = () => ((payload().limits || {}).urgentWindow) || 1800000;

module.exports = { payload, load, timeline, creditTable, creditFooter, privacySections, imgMax, chatKeepMs, urgentMinLead, urgentWindow };
