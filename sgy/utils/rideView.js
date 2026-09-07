// sgy/utils/rideView.js —— 局卡片的展示视图模型（唯一派生处）
// 之前 routeLabel/seatText/状态标签/时间/头像位 在 feed·trips·ride·chat 各写一份，
// 且时间标签已分叉（找局含日期、行程只显时钟）。这里收拢：
//   cardOf(ride)   —— 列表/详情头部共用字段（routeLabel·时间·座位·状态标签与色）
//   avatarSlots    —— 找局卡片 fixed 头像位（满=首字+性别框 / 空=灰圈＋）
//   avatarChar     —— 成员/消息首字头像
// 纯函数，仅依赖 domain.js，可在本地 node 冒烟。
const D = require("./domain");

/** 一局的路由文字：优先服务端 routeLabel，缺省拼 from → to。 */
function rideLabel(ride) {
  return ride.routeLabel || `${ride.from || ""} → ${ride.to || ""}`;
}

/** "3/4 人" */
function seatText(ride) {
  return `${ride.memberCount || 0}/${ride.capacity || 4} 人`;
}

/** 头像首字，空名回退 "?"（与 gender 边框 frameCls 配对使用）。 */
function avatarChar(name) {
  return String(name || "?").slice(0, 1);
}

/** 一局在列表/详情共用的展示字段：唯一来源，页面只取字段。 */
function cardOf(ride) {
  const sv = D.statusView(ride.status);
  return {
    routeLabel: rideLabel(ride),
    dayText: D.dayLabel(ride.boardAt), // "今天/明天/9/1 07:40"（含日期，唯一时间口径）
    departText: D.departFromNow(ride.boardAt),
    seatText: seatText(ride),
    statusLabel: sv.label,
    statusCls: sv.cls,
  };
}

/** 找局卡片固定 capacity 个头像位：有人=首字+性别框；空位=灰圈加号。 */
function avatarSlots(ride, briefs) {
  const cap = ride.capacity || 4;
  const mem = briefs || [];
  const arr = [];
  for (let i = 0; i < cap; i++) {
    const m = mem[i];
    arr.push(
      m
        ? { k: i, filled: true, text: avatarChar(m.name), cls: D.frameCls(m.gender || "") }
        : { k: i, filled: false, text: "" }
    );
  }
  return arr;
}

module.exports = { rideLabel, seatText, avatarChar, cardOf, avatarSlots };
