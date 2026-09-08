/**
 * 领域常量与显示助手。
 * 线路目录（ROUTES）改由云数据库 routes 下发（见 utils/routes.js：拉 rides.routes、
 * DB 为唯一来源）；本文件里的 ROUTES 仅作离线快照兜底，管理员增改线路后请以云端为准。
 */

// 方向（面向用户的叫法：返校 = 从深圳去学校；离校 = 从学校回深圳/就近回家）
const DIRECTIONS = {
  IN: { id: "in", label: "返校", desc: "返校 · 深圳 → 香港教育大学" },
  OUT: { id: "out", label: "离校", desc: "离校 · 香港教育大学 → 口岸或就近地点" },
};

// 线路目录（一期 7 条，均为香港侧上车/下车，见 ADR-0003）
// 命名约定：口岸集合点保留"的士站"（= 香港侧该口岸的士站，见 ADR-0002）；
// 大埔墟本身就是"站"，不再加"的士站"。
const ROUTES = [
  { id: "in-liantang", directionId: "in", from: "莲塘口岸（香园围）的士站", to: "香港教育大学" },
  { id: "in-futian", directionId: "in", from: "福田口岸（落马洲）的士站", to: "香港教育大学" },
  { id: "in-szbay", directionId: "in", from: "深圳湾口岸的士站", to: "香港教育大学" },
  { id: "in-taimarket", directionId: "in", from: "大埔墟站（东铁线）", to: "香港教育大学" },
  { id: "out-liantang", directionId: "out", from: "香港教育大学", to: "莲塘口岸（香园围）香港侧" },
  { id: "out-futian", directionId: "out", from: "香港教育大学", to: "福田口岸（落马洲）香港侧" },
  { id: "out-szbay", directionId: "out", from: "香港教育大学", to: "深圳湾口岸香港侧" },
];

// 拼车局状态
const RIDE_STATUS = {
  RECRUITING: { id: "recruiting", label: "招募中" },
  LOCKED: { id: "locked", label: "已成局" },
  ONGOING: { id: "ongoing", label: "进行中" },
  DONE: { id: "done", label: "已完成" },
  CANCELLED: { id: "cancelled", label: "已取消" },
  FAILED: { id: "failed", label: "未成局" },
};

function routeLabel(route) {
  return `${route.from} → ${route.to}`;
}

/** 起终点简写（聊天室切换条用）：别名(教大) → 去「（…）」→ 去"香港侧/的士站"后缀 → 超 6 字截断。 */
const SHORT_ALIAS = { "香港教育大学": "教大" };
function shortPoint(name) {
  if (!name) return "";
  const s = String(name).trim();
  if (SHORT_ALIAS[s]) return SHORT_ALIAS[s];
  let t = s.replace(/（[^）]*）/g, "").replace(/香港侧$/, "").replace(/的士站$/, "");
  if (t.length > 6) t = t.slice(0, 6) + "…";
  return t || s;
}

/** 距离上车时间的展示文案：minutes 为相对当前时刻的分钟数（负数=已过） */
function departureText(minutes) {
  if (minutes == null) return "";
  if (minutes < 0) return `已过 ${-minutes} 分`;
  if (minutes === 0) return "马上出发";
  if (minutes < 60) return `${minutes} 分后`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分后` : `${h} 小时后`;
}

const pad2 = (n) => (n < 10 ? "0" + n : "" + n);

/** 毫秒 -> 本地 HH:mm */
function fmtTime(ms) {
  if (!ms) return "--:--";
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 毫秒 -> 本地 YYYY-MM-DD */
function fmtDate(ms) {
  const d = ms ? new Date(ms) : new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** date("YYYY-MM-DD") + time("HH:mm") → 毫秒（与 rides/rules.js dateTimeToMs 同口径，避免两端两套实现；失败返回 0）。 */
function dateTimeToMs(date, time) {
  const t = Date.parse(`${date}T${time}:00+08:00`);
  return Number.isNaN(t) ? 0 : t;
}

/** 毫秒 -> 距现在还有多久的文案（未来为正） */
function departFromNow(ms) {
  if (!ms) return "";
  return departureText(Math.round((ms - Date.now()) / 60000));
}

/** 毫秒 -> "今天 07:40" / "明天 07:40" 式的短标签 */
function dayLabel(ms) {
  const a = new Date();
  const b = new Date(ms);
  const d0 = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const d1 = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  const diff = Math.round((d1 - d0) / 86400000);
  const prefix = diff === 0 ? "今天" : diff === 1 ? "明天" : `${b.getMonth() + 1}/${b.getDate()}`;
  return `${prefix} ${fmtTime(ms)}`;
}

/** 拼车局状态 → 展示用元数据（标签 + wxss 类名） */
const STATUS_VIEW = {
  recruiting: { label: "招募中", cls: "tag-green" },
  locked: { label: "已成局", cls: "tag-gray" },
  ongoing: { label: "进行中", cls: "tag-orange" },
  done: { label: "已完成", cls: "tag-gray" },
  cancelled: { label: "已取消", cls: "tag-red" },
  failed: { label: "未成局", cls: "tag-red" },
};
function statusView(id) {
  return STATUS_VIEW[id] || { label: id || "未知", cls: "tag-gray" };
}

/** 自报性别 → 头像框着色类名（蓝男 · 粉女 · 不填无框）。三端唯一来源。 */
function frameCls(gender) {
  return gender === "female" ? "avatar-female" : gender === "male" ? "avatar-male" : "";
}

module.exports = {
  DIRECTIONS,
  ROUTES,
  RIDE_STATUS,
  statusView,
  routeLabel,
  shortPoint,
  departureText,
  fmtTime,
  fmtDate,
  dateTimeToMs,
  departFromNow,
  dayLabel,
  frameCls,
};
