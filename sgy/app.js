// app.js
const departReminder = require("./utils/departReminder.js");

App({
  onLaunch() {
    this.globalData = {
      env: "cloud1-d1gx6bw91f395901c",
    };
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      wx.cloud.init({
        env: this.globalData.env,
        traceUser: true,
      });
    }
    // 首次进入免责声明：只弹一次（storage 永久记录）；任何首次打开都弹（游客只浏览也弹）
    this._showDisclaimerOnce();
  },

  // 免责声明文案（公益/纯撮合定位，与 CONTEXT「只做撮合」一致）。用户在"同意并开始使用"后不再弹。
  _showDisclaimerOnce() {
    let seen = false;
    try {
      seen = !!wx.getStorageSync("disclaimerSeen");
    } catch (e) { /* storage 不可用：照常弹 */ }
    if (seen) return;
    // 略延迟，等首页渲染完再弹（app onLaunch 时页面可能还没就绪）
    setTimeout(() => {
      wx.showModal({
        title: "欢迎使用 · 使用须知",
        content:
          "深港拼车是一个为跨境通勤同学做的公益组队撮合工具——为爱发电，不以营利为目的。\n" +
          "它只提供线上组队：帮你在同一时间、同一上车点找到拼友，一起拼坐的士。\n" +
          "平台不约车、不经手车费、不承担承运与安全责任；车由你们到点自行安排，AA 方式请你们自行商量。\n" +
          "请把安全放第一，诚信组队、准时赴约、按时付清 AA。\n" +
          "祝各位出行顺利，一路平安，准时到达，和和气气 🚕",
        confirmText: "同意并开始使用",
        showCancel: false,
        success: () => {
          try { wx.setStorageSync("disclaimerSeen", 1); } catch (e) { /* 忽略 */ }
        },
      });
    }, 500);
  },

  // 出发前提醒（DESIGN「通知策略」：打开小程序时主动弹一次）——挂 app 级，任何入口都覆盖得到
  //（从分享卡片直达详情、直接落到「我的」等；原先只挂在 feed/trips 的 onShow 里，这些入口会漏）。
  // 去重由 departReminder 自己负责（查询 10 分钟 TTL + 每局只弹一次），故重复触发无害。
  onShow() {
    departReminder.maybePromptOnce();
  },
});
