// pages/trips/trips.js —— Tab2 行程（已接云 rides.my）
const api = require("../../utils/api.js");
const { statusView, fmtTime } = require("../../utils/domain.js");

Page({
  data: {
    segs: [
      { id: "ongoing", label: "进行中" },
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
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    this.setData({ loading: true });
    const res = await api.call("rides", { action: "my" });
    this._ongoing = res.ok ? res.data.ongoing : [];
    this._done = res.ok ? res.data.history : [];
    if (!res.ok) wx.showToast({ title: res.msg || "加载失败", icon: "none" });
    this.render();
  },

  render() {
    const src = this.data.seg === "ongoing" ? this._ongoing : this._done;
    const trips = (src || []).map((t) => {
      const sv = statusView(t.status);
      return {
        ...t,
        id: t._id,
        routeLabel: t.routeLabel || `${t.from} → ${t.to}`,
        timeText: fmtTime(t.boardAt),
        statusLabel: sv.label,
        statusCls: sv.cls,
        seatText: `${t.memberCount}/${t.capacity} 人`,
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
