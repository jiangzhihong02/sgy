// pages/admin/admin.js —— 管理员后台（代发种子局 / 举报复核）
const api = require("../../utils/api.js");
const { ROUTES, routeLabel, fmtDate, fmtTime } = require("../../utils/domain.js");

Page({
  data: {
    reports: [],
    routeOptions: ROUTES.map((r) => ({ routeId: r.id, label: routeLabel(r) })),
    routeIndex: 0,
    date: "",
    time: "",
    dateStart: fmtDate(Date.now()),
    timeStart: "",
    capacity: 4,
    capacityRange: [2, 3, 4],
    seeding: false,
  },

  onLoad() {
    const now = Date.now();
    const rounded = Math.ceil((now + 40 * 60000) / 300000) * 300000;
    this._today = fmtDate(now);
    this.setData({
      date: this._today,
      time: fmtTime(rounded),
      timeStart: fmtTime(now + 31 * 60000),
    });
    this.loadPending();
  },

  onShow() {
    this.loadPending();
  },

  async loadPending() {
    const res = await api.call("rides", { action: "adminPending" });
    if (res.ok) this.setData({ reports: res.data.reports || [] });
  },

  onResolve(e) {
    const { id, kind, name } = e.currentTarget.dataset;
    wx.showModal({
      title: `坐实「${name}」的举报？`,
      content: `类型：${kind}。坐实会扣该成员信用分并（性别类）清空性别。`,
      confirmText: "坐实扣分",
      success: async (m) => {
        if (!m.confirm) return;
        const r = await api.call("rides", { action: "resolveReport", reportId: id, action: "uphold" });
        wx.showToast({ title: r.ok ? "已坐实并扣分" : r.msg || "失败", icon: "none" });
        this.loadPending();
      },
    });
  },

  onDismiss(e) {
    const { id } = e.currentTarget.dataset;
    api.call("rides", { action: "resolveReport", reportId: id, action: "dismiss" }).then((r) => {
      wx.showToast({ title: r.ok ? "已驳回" : r.msg || "失败", icon: "none" });
      this.loadPending();
    });
  },

  onPickRoute(e) {
    this.setData({ routeIndex: Number(e.detail.value) });
  },
  onPickDate(e) {
    const date = e.detail.value;
    const patch = { date };
    if (date === this._today) {
      const s = fmtTime(Date.now() + 31 * 60000);
      patch.timeStart = s;
      if (this.data.time && this.data.time < s) patch.time = s;
    } else {
      patch.timeStart = "";
    }
    this.setData(patch);
  },
  onPickTime(e) {
    this.setData({ time: e.detail.value });
  },
  onCapTap(e) {
    this.setData({ capacity: Number(e.currentTarget.dataset.cap) });
  },

  async onSeed() {
    if (this.data.seeding) return;
    const opt = this.data.routeOptions[this.data.routeIndex];
    if (!opt) {
      wx.showToast({ title: "请选择线路", icon: "none" });
      return;
    }
    this.setData({ seeding: true });
    wx.showLoading({ title: "代发中", mask: true });
    const res = await api.call("rides", {
      action: "create",
      routeId: opt.routeId,
      date: this.data.date,
      time: this.data.time,
      capacity: this.data.capacity,
      note: "种子局 · 欢迎加入",
    });
    wx.hideLoading();
    this.setData({ seeding: false });
    if (res.ok) wx.showToast({ title: "已代发，去找局可见", icon: "success" });
    else wx.showModal({ title: "代发失败", content: res.msg || "请重试", showCancel: false });
  },
});
