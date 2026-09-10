// sgy/utils/departReminder.js —— 出发前提醒：「请按时到达；赶不上请及时退出」
// 打开小程序时查一次：我还有"距出发 30–60 分钟、又没签到"的局 → 弹一次。
// 窗口由服务端 departPending 界定（下界＝免费退出截止 T−30，见 rules.T_DEPART_REMIND）——
// 选这段是因为此刻"赶不上就退出"还来得及且不扣分，提醒才行动得上。
// 两重去重：① 查询本身 10 分钟 TTL（避免每次切 Tab 都打云函数）；② 每局只弹一次。
const api = require("./api");
const { dayLabel } = require("./domain");
const rulesText = require("./rulesText"); // 文案里的"出发前 X 分钟"取自云端 limits，不硬编码

const KEY_CHECK_AT = "departCheckAt"; // 上次查询时刻
const KEY_SEEN = "departReminded_"; // 按局记录：departReminded_<rideId>
const CHECK_TTL = 10 * 60 * 1000;

async function maybePromptOnce() {
  try {
    const last = wx.getStorageSync(KEY_CHECK_AT);
    if (last && Date.now() - last < CHECK_TTL) return;
    wx.setStorageSync(KEY_CHECK_AT, Date.now());
  } catch (e) {
    /* storage 不可用：照常查 */
  }

  let list = [];
  try {
    const res = await api.call("departPending");
    if (!res.ok || !(res.data && res.data.list)) return;
    list = res.data.list;
  } catch (e) {
    return;
  }
  const first = list[0];
  if (!first) return;

  try {
    if (wx.getStorageSync(KEY_SEEN + first.rideId)) return;
    wx.setStorageSync(KEY_SEEN + first.rideId, 1);
  } catch (e) {
    /* 忽略：storage 不可用时可能重复提醒，可接受 */
  }

  wx.showModal({
    title: "快到出发时间了",
    content:
      `${dayLabel(first.boardAt)}　${first.routeLabel}\n` +
      `到场前，这局的人数是队友唯一能看到的信号：请按时到达；若赶不上，请在出发前 ${rulesText.minLabel(rulesText.freeExit())} 分钟前退出，好让队友按真实人数出发。`,
    confirmText: "知道了",
    showCancel: false,
  });
}

module.exports = { maybePromptOnce };
