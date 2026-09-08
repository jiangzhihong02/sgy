// sgy/utils/confirmRide.js —— 补签到确认弹窗
// 结算时没点「我到了」的成员，在结算后 48h（CONFIRM_WINDOW_MS）内打开小程序会被问这一局是否上车：
//   上车了 → 补记为已签到 +1；没上车 → 记爽约 −20；稍后再说 → 改天再问（每日至多提示一次）。
// 谎报"上车了"由队友在局完成后举报「缺勤没来」兜底（见 CONTEXT 签到）。
const api = require("./api");
const KEY_LAST = "confirmRideLastPrompt";

async function maybePromptOnce() {
  const today = new Date().toDateString();
  try {
    if (wx.getStorageSync(KEY_LAST) === today) return;
  } catch (e) {
    /* storage 不可用时照常提示 */
  }
  const res = await api.call("confirmPending");
  if (!res.ok || !(res.data && res.data.list) || !res.data.list.length) return;
  const first = res.data.list[0];
  const remember = () => {
    try {
      wx.setStorageSync(KEY_LAST, today);
    } catch (e) {
      /* 忽略 */
    }
  };
  wx.showActionSheet({
    itemList: ["上车了", "没上车", "稍后再说"],
    success: (r) => {
      if (r.tapIndex === 0) {
        remember();
        api.call("confirmRide", { rideId: first.rideId, rode: true }).then((x) =>
          wx.showToast({ title: x.ok ? "已补签到，不扣分" : (x.msg || "失败"), icon: "none" })
        );
      } else if (r.tapIndex === 1) {
        remember();
        api.call("confirmRide", { rideId: first.rideId, rode: false }).then((x) =>
          wx.showToast({ title: x.ok ? "已记爽约" : (x.msg || "失败"), icon: "none" })
        );
      } else {
        remember(); // 稍后：今天不再弹
      }
    },
    fail: () => {
      remember(); // 弹过一次就算今天的额度（点掉遮罩不再反复弹）
    },
  });
}

module.exports = { maybePromptOnce };
