// rules.js —— 拼车局规则常量与纯判定（唯一来源）
// 本文件不依赖 wx-server-sdk，可在本地 node 直接单测（interface is the test surface）。
// 契约：cloudfunctions/SPEC.md §2。改规则改这里；客户端展示文案、SPEC 同步到同一套数值。
const MIN = 60 * 1000;

// —— 时间线（毫秒）——
const T_JOIN_CLOSE = 10 * MIN; // T−10 停止加入/关局
const T_FREE_EXIT = 30 * MIN; // T−30 自由退出/解散截止
const T_MIN_GAP = 60 * MIN; // 同人两个未出发局须相隔 ≥1h
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
const MSG_IMG_MAX = 200000; // 图片消息 = base64 data URI，单条字符上限
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

module.exports = {
  T_JOIN_CLOSE,
  T_FREE_EXIT,
  T_MIN_GAP,
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
};
