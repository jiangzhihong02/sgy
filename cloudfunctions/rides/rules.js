// rules.js —— 拼车局规则常量与纯判定（唯一来源）
// 本文件不依赖 wx-server-sdk，可在本地 node 直接单测（interface is the test surface）。
// 契约：cloudfunctions/SPEC.md §2。改规则改这里；客户端展示文案、SPEC 同步到同一套数值。
const MIN = 60 * 1000;

// —— 时间线（毫秒）——
const T_JOIN_CLOSE = 10 * MIN; // T−10 停止加入/关局
const T_FREE_EXIT = 30 * MIN; // T−30 自由退出/解散截止
const T_MIN_GAP = 60 * MIN; // 同人两个未出发局须相隔 ≥1h（任何方向：不能同时上两辆的士）
const T_SAME_DIR = 120 * MIN; // 同方向（返校×返校 / 离校×离校）须相隔 ≥2h（往返的士约 1h + 缓冲）
const T_POLL_ASK = 60 * MIN; // T−60 人数轮询发起
const T_POLL_DUE = 45 * MIN; // T−45 轮询截止（未回复默认接受）
const T_CHECKIN_GRACE = 10 * MIN; // T+10 停止"我到了"签到
const T_SETTLE = 60 * MIN; // 上车 1 小时后自动结算（此前曾为 2h，2026-09 定稿）

// —— 信用分（数值参数）——
const CREDIT_DEFAULT = 100;
const CREDIT_CAP = 120;
const CREDIT_LOW = 60; // 信用 <60 → 暂停发起新局 7 天
const BAN_DAYS_MS = 7 * 24 * 3600 * 1000;
const CREDIT_LEAVE_NO_SHOW = -20; // T−30 后退出 / 到点未到自动爽约
const CREDIT_RIDE_OK = 1; // 成功同行（已签到者）结算 +1
const KIND_DELTA = { gender_fake: -20, absence: -20, lateness: -10 }; // 举报坐实/联名扣分

// —— 状态分组 ——
const ACTIVE_STATUS = ["recruiting", "locked"]; // "未出发进行中"：时间冲突/邀请/复用查询用
const PARTICIPANT_STATUS = ["recruiting", "locked", "ongoing"]; // 可签到等成员操作

// —— 文本上限 ——
const MSG_MAX = 200; // 文本消息长度
const MSG_IMG_MAX = 500000; // 图片消息 = base64 data URI，单条字符上限（≈≤370KB 图；前端 q55→q30 两档压缩）
const NOTE_MAX = 50; // 发起人备注长度

/** 默认昵称随机生成：每人不同，注册时还可改（三个云函数的统一口径）。 */
const randNick = () => `拼友${Math.floor(1000 + Math.random() * 9000)}`;

/** date + "HH:mm"（深港同为 UTC+8）→ 毫秒；解析失败返回 0。 */
function dateTimeToMs(date, time) {
  const t = Date.parse(`${date}T${time}:00+08:00`);
  return Number.isNaN(t) ? 0 : t;
}

/** "我到了"是否在允许状态/窗口内。detail 与 checkin action 共用，避免两处口径分叉。 */
function canCheckin(ride, me, now) {
  if (!me) return false;
  if (me.checkedInAt) return false; // 幂等：已签不再算"可签"
  if (!PARTICIPANT_STATUS.includes(ride.status)) return false;
  return now <= ride.boardAt + T_CHECKIN_GRACE;
}

// —— 面向用户的规则面板（rides.getRules 下发；文案与数值同文件书写，改数值不会漏改文案）——
// 分钟/天从上面的常量算出来，行文只做拼接。
const MIN_ = (ms) => Math.round(ms / 60000);
const DAYS_ = (ms) => Math.round(ms / 86400000);

const RULE_TIMELINE = [
  { t: "最少 2 人", d: "即成一局；不足 2 人的局会在上车前自动取消，不计爽约。" },
  { t: `出发前 ${MIN_(T_POLL_ASK)} 分钟`, d: "人数还没满时，全员确认是否「按当前人数出发」，没回复默认同意。" },
  { t: `出发前 ${MIN_(T_FREE_EXIT)} 分钟`, d: "此前可自由退出、发起人可解散；之后再退出算爽约，扣信用分。" },
  { t: `出发前 ${MIN_(T_JOIN_CLOSE)} 分钟`, d: "停止加入，按当时人数锁定成局。" },
  { t: "约定时间", d: "到上车点的士站集合，点「我到了」告诉队友你已到。" },
  { t: `上车后 ${MIN_(T_CHECKIN_GRACE)} 分钟`, d: "停止「我到了」签到；之后仍没签到也没退出的，系统会在局结束时按爽约自动扣信用分。" },
];

// 发局页「一局怎么算成立」整段
const PREVIEW_TEXT =
  `最少 2 人成局，人数上限由你设（2–6）。按出发时间倒推：提前 ${MIN_(T_POLL_ASK)} 分钟未满员时，全员确认是否按当前人数出发（没回复默认同意，至出发前 ${MIN_(T_POLL_DUE)} 分钟）；提前 ${MIN_(T_FREE_EXIT)} 分钟前可自由退出、你可解散；提前 ${MIN_(T_JOIN_CLOSE)} 分钟停止加入、按当时人数锁定成局，不足 2 人自动取消（不计爽约）；到点在上车点的士站集合点「我到了」，上车后 ${MIN_(T_CHECKIN_GRACE)} 分钟停止签到，局结束仍未签到将按爽约自动扣信用分。`;

// 「我的」页：信用分规则 / 性别与隐私（整段，数字内插自上）
const CREDIT_TEXT =
  `初始 ${CREDIT_DEFAULT}，封顶 ${CREDIT_CAP}。爽约（出发前 ${MIN_(T_FREE_EXIT)} 分钟后退出、或到点没「我到了」）自动 ${CREDIT_LEAVE_NO_SHOW}；成功同行 +${CREDIT_RIDE_OK}。拼车结束后，队友可就 迟到(${KIND_DELTA.lateness}) / 缺勤·没来(${KIND_DELTA.absence}) / 性别不实(${KIND_DELTA.gender_fake}) 举报：同一局 ≥2 名成员联名即自动坐实，否则转管理员复核。低于 ${CREDIT_LOW} 暂停发起新局 ${DAYS_(BAN_DAYS_MS)} 天（仍可加入）。`;
const PRIVACY_TEXT =
  `性别为自报，仅用于组队时以头像框颜色辨认（蓝男·粉女）。填写的性别与真实不符，会被同车人举报：坐实后清空性别并扣信用分；若同一局有 3 名以上成员同报、或你被多次坐实，则系统把性别改为判定的另一性别并锁定（仅管理员可纠正）。不展示微信号，站内联系。`;

/** rides.getRules 返回的完整面板（timeline 供详情/发局渲染，preview/creditText/privacyText 供弹层，limits 供前端校验）。 */
function rulePayload() {
  return {
    timeline: RULE_TIMELINE,
    preview: PREVIEW_TEXT,
    creditText: CREDIT_TEXT,
    privacyText: PRIVACY_TEXT,
    limits: { msgMax: MSG_MAX, imgMax: MSG_IMG_MAX, noteMax: NOTE_MAX },
  };
}

module.exports = {
  T_JOIN_CLOSE,
  T_FREE_EXIT,
  T_MIN_GAP,
  T_SAME_DIR,
  T_POLL_ASK,
  T_POLL_DUE,
  T_CHECKIN_GRACE,
  T_SETTLE,
  CREDIT_DEFAULT,
  CREDIT_CAP,
  CREDIT_LOW,
  BAN_DAYS_MS,
  CREDIT_LEAVE_NO_SHOW,
  CREDIT_RIDE_OK,
  KIND_DELTA,
  ACTIVE_STATUS,
  PARTICIPANT_STATUS,
  MSG_MAX,
  MSG_IMG_MAX,
  NOTE_MAX,
  randNick,
  dateTimeToMs,
  canCheckin,
  rulePayload,
};
