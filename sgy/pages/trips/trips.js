// pages/trips/trips.js —— Tab2 行程（已接云 rides.my）
const api = require("../../utils/api.js");
const { cardOf } = require("../../utils/rideView.js");
const confirmRide = require("../../utils/confirmRide.js");

Page({
  data: {
    segs: [
      { id: "ongoing", label: "未完成" },
      { id: "done", label: "历史" },
    ],
    seg: "ongoing",
    trips: [],
    loading: true,
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    // 从详情返回后数据可能有变（加入/退出/状态推进）
    if (this.data.loaded) this.refresh();
    confirmRide.maybePromptOnce(); // 补签到确认（结算后未签到者 48h 内被问）
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    this.setData({ loading: true });
    const res = await api.call("my");
    this._ongoing = res.ok ? res.data.ongoing : [];
    this._done = res.ok ? res.data.history : [];
    if (!res.ok) wx.showToast({ title: res.msg || "加载失败", icon: "none" });
    this.render();
  },

  render() {
    const src = this.data.seg === "ongoing" ? this._ongoing : this._done;
    const trips = (src || []).map((t) => {
      const c = cardOf(t);
      return {
        ...t,
        id: t._id,
        routeLabel: c.routeLabel,
        // 时间标签与找局统一为「含日期」（今天/明天/月/日 + HH:mm）——历史记录不再丢失是哪一天
        timeText: c.dayText,
        seatText: c.seatText,
        statusLabel: c.statusLabel,
        statusCls: c.statusCls,
      };
    });
    this.setData({ trips, loading: false, loaded: true });
  },

  onSwitchSeg(e) {
    this.setData({ seg: e.currentTarget.dataset.id });
    this.render();
  },

  openRide(e) {
    wx.navigateTo({ url: `/pages/ride/ride?id=${e.currentTarget.dataset.id}` });
  },
});
