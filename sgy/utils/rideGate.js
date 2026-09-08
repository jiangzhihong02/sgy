// sgy/utils/rideGate.js —— 加入前的确认门控（纯函数，无 wx，可在本地 node 测）
// 决定"加入这一局前要不要弹确认、弹哪种"：
//   'urgent'  加急局（30 分钟内出发）→ 承诺框（加入后中途退出计爽约）
//   'near'    非加急但距发车 < 1 小时  → 提醒框（可能来不及 / 凑不齐）
//   null      其它 → 直接加入
// ride = 客户端局视图（需 .urgent / .boardAt）；now = 当前毫秒。
const NEAR_WINDOW = 60 * 60000; // "近临出发"窗口：距发车 1 小时内

function decideJoinGate(ride, now) {
  if (!ride || !ride.boardAt) return null;
  if (ride.urgent) return "urgent";
  return ride.boardAt - now < NEAR_WINDOW ? "near" : null;
}

module.exports = { decideJoinGate, NEAR_WINDOW };
