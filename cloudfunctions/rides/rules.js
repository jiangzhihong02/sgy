// rules.js —— 拼车局规则常量与纯判定（唯一来源）
// 本文件不依赖 wx-server-sdk，可在本地 node 直接单测（interface is the test surface）。
// 契约：cloudfunctions/SPEC.md §2。改规则改这里；客户端展示文案、SPEC 同步到同一套数值。
const MIN = 60 * 1000;

// —— 时间线（毫秒）——
const T_JOIN_CLOSE = 10 * MIN; // T−10 停止加入/关局
const T_JOIN_CLOSE_URGENT = 5 * MIN; // 加急局关局点：T−5 停止加入（比正常晚，给临时响应者留时间；见 CONTEXT 加急局）
const T_FREE_EXIT = 30 * MIN; // T−30 自由退出/解散截止
const T_MIN_GAP = 60 * MIN; // 同人两个未出发局须相隔 ≥1h（任何方向：不能同时上两辆的士）
const T_SAME_DIR = 120 * MIN; // 同方向（返校×返校 / 离校×离校）须相隔 ≥2h（往返的士约 1h + 缓冲）
const T_POLL_ASK = 60 * MIN; // T−60 人数轮询发起
const T_POLL_DUE = 45 * MIN; // T−45 轮询截止（未回复默认接受）
const T_CHECKIN_GRACE = 10 * MIN; // T+10 停止"我到了"签到
const T_SETTLE = 45 * MIN; // 上车后 45 分钟自动结算（深港单程最慢约 45 分钟，行程结束即结算、尽早进入补签确认窗口；此前曾为 2h→1h，2026-09-08 定稿 45min）
const CONFIRM_WINDOW_MS = 48 * 3600 * 1000; // 结算后"补签到确认"窗口：到点没签到的成员 48h 内可弹窗确认是否上车（见 CONTEXT 签到）
// —— 加急局（2026-09-08，见 CONTEXT 加急局）——
const URGENT_MIN_LEAD = 15 * MIN; // 加急局最早提前 15 分钟发起（留出别人看到+加入的窗口）
const URGENT_WINDOW = 30 * MIN; // 加急局窗口：出发前 30 分钟内

/** 关局提前量：加急局 T−5、正常局 T−10（advance/join/detail canJoin 共用，避免口径分叉）。 */
const joinCloseMs = (ride) => (ride && ride.urgent ? T_JOIN_CLOSE_URGENT : T_JOIN_CLOSE);

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

// —— 信用分表格（可视化面板；数值内插自上，事件行文案静态；结构化表述，规则唯一表述格式）——
const CREDIT_TABLE = [
  { event: "初始", note: "注册即默认", delta: `+${CREDIT_DEFAULT}`, up: true },
  { event: "爽约", note: `出发前 ${MIN_(T_FREE_EXIT)} 分钟后退出 / 到点没签到，经 48h 补确认仍没上车或逾期不答`, delta: `${CREDIT_LEAVE_NO_SHOW}`, up: false },
  { event: "迟到", note: "举报坐实（同局 ≥2 人联名自动，否则管理员复核）", delta: `${KIND_DELTA.lateness}`, up: false },
  { event: "缺勤·没来", note: "举报坐实；谎报「上车了」也靠队友报此条兜底", delta: `${KIND_DELTA.absence}`, up: false },
  { event: "性别不实", note: "举报坐实，顺带清空性别；多人/多次坐实会反推锁定", delta: `${KIND_DELTA.gender_fake}`, up: false },
  { event: "成功同行", note: "到点签到且局完成，结算自动", delta: `+${CREDIT_RIDE_OK}`, up: true },
];
const CREDIT_FOOTER = `封顶 ${CREDIT_CAP}。低于 ${CREDIT_LOW} 暂停发起新局 ${DAYS_(BAN_DAYS_MS)} 天（仍可加入）。`;

// —— 隐私与实名（分节排版；结构化表述）——
const PRIVACY_SECTIONS = [
  {
    title: "性别（自报，不验证）",
    lines: [
      "仅用于组队/聊天里以头像框颜色辨认（蓝男·粉女）。",
      `自报不实会被同车人举报：坐实后清空性别并扣 ${KIND_DELTA.gender_fake}。`,
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
];

/** rides.getRules 返回的完整面板（timeline 供详情/发局规则表，creditTable/creditFooter/privacySections 供可视化面板，limits 供前端校验）。 */
function rulePayload() {
  return {
    timeline: RULE_TIMELINE,
    creditTable: CREDIT_TABLE,
    creditFooter: CREDIT_FOOTER,
    privacySections: PRIVACY_SECTIONS,
    limits: {
      msgMax: MSG_MAX,
      imgMax: MSG_IMG_MAX,
      noteMax: NOTE_MAX,
      chatKeepMs: T_SETTLE + CONFIRM_WINDOW_MS, // 聊天室保留窗：结算后 48h（与补签确认同宽），过后服务端禁发
      urgentMinLead: URGENT_MIN_LEAD, // 加急局最早提前量（客户端时间下限）
      urgentWindow: URGENT_WINDOW, // 加急局窗口（客户端判定勾选可用）
    },
  };
}

module.exports = {
  T_JOIN_CLOSE,
  T_JOIN_CLOSE_URGENT,
  T_FREE_EXIT,
  T_MIN_GAP,
  T_SAME_DIR,
  T_POLL_ASK,
  T_POLL_DUE,
  T_CHECKIN_GRACE,
  T_SETTLE,
  CONFIRM_WINDOW_MS,
  URGENT_MIN_LEAD,
  URGENT_WINDOW,
  joinCloseMs,
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
  CREDIT_TABLE,
  CREDIT_FOOTER,
  PRIVACY_SECTIONS,
};
