// pages/create/create.js —— 发局（已接云 rides.create）
// 返校 = 深圳→教大：选上车点（固定终点教大）；离校 = 教大→口岸/就近：选或自定义下车点。
const api = require("../../utils/api.js");
const { DIRECTIONS, ROUTES, fmtDate, fmtTime, dayLabel } = require("../../utils/domain.js");

function buildInOptions() {
  return ROUTES.filter((r) => r.directionId === "in").map((r) => ({
    routeId: r.id,
    label: r.from,
    to: r.to,
  }));
}
function buildOutOptions() {
  // 预置 = 3 个口岸下车点；"自定义…"放在最后
  return ROUTES.filter((r) => r.directionId === "out").map((r) => ({
    routeId: r.id,
    label: r.to,
    isCustom: false,
  }));
}

Page({
  data: {
    directions: [DIRECTIONS.IN, DIRECTIONS.OUT],
    directionId: "in",
    selDirDesc: DIRECTIONS.IN.desc,

    // 返校
    inOptions: buildInOptions(),
    inIndex: 0,
    inLabel: "",

    // 离校
    outOptions: buildOutOptions().concat([{ routeId: "", label: "自定义下车点", isCustom: true }]),
    outIndex: 0,
    destCustom: false,
    customDest: "",

    time: "",
    date: "",
    timeStart: "", // 时间选择器下限：选"今天"时为当前+31分钟，否则不限
    dateStart: fmtDate(Date.now()),
    capacity: 4,
    capacityRange: [2, 3, 4],
    note: "",
    submitting: false,
    err: null, // { head, sub, rows:[{label,text}] }
  },

  onLoad() {
    const now = Date.now();
    this._today = fmtDate(now);
    // 默认时间：当前+40 分钟，向上取整到 5 分钟（避开已过去时刻）
    const rounded = Math.ceil((now + 40 * 60000) / 300000) * 300000;
    this.setData({
      date: this._today,
      time: fmtTime(rounded),
      timeStart: fmtTime(now + 31 * 60000),
    });
    this.applyDirection("in", true);
  },

  applyDirection(dir, init) {
    if (dir === "in") {
      const first = this.data.inOptions[0];
      const patch = {
        selDirDesc: DIRECTIONS.IN.desc,
        inLabel: first ? first.label : "",
      };
      if (init) patch.inIndex = 0;
      this.setData(patch);
    } else {
      this.setData({ selDirDesc: DIRECTIONS.OUT.desc });
      if (init) this.setData({ outIndex: 0, destCustom: false, customDest: "" });
    }
  },

  onPickDirection(e) {
    const dir = e.currentTarget.dataset.id;
    this.setData({ directionId: dir });
    this.applyDirection(dir, true);
  },

  onPickIn(e) {
    const idx = Number(e.detail.value);
    this.setData({ inIndex: idx, inLabel: this.data.inOptions[idx].label });
  },

  onPickOut(e) {
    const idx = Number(e.detail.value);
    const opt = this.data.outOptions[idx];
    this.setData({ outIndex: idx, destCustom: !!opt.isCustom });
  },

  onCustomDestInput(e) {
    this.setData({ customDest: e.detail.value });
  },

  onPickTime(e) {
    this.setData({ time: e.detail.value });
  },
  onPickDate(e) {
    const date = e.detail.value;
    const patch = { date };
    // 选今天 → 时间下限=当前+31 分钟；选未来 → 不限（避免出现早于现在的选项）
    if (date === this._today) {
      const start = fmtTime(Date.now() + 31 * 60000);
      patch.timeStart = start;
      if (this.data.time && this.data.time < start) patch.time = start;
    } else {
      patch.timeStart = "";
    }
    this.setData(patch);
  },
  onCapacityTap(e) {
    this.setData({ capacity: Number(e.currentTarget.dataset.cap) });
  },
  onNoteInput(e) {
    this.setData({ note: e.detail.value });
  },

  onPreviewRule() {
    wx.showModal({
      title: "一局怎么算成立",
      content:
        "按约定出发时间倒推：提前 1 小时还没满员时，全员确认是否按当前人数出发（没回复默认同意）；提前 30 分钟前都能自由退出、发起人可解散；提前 10 分钟停止加入，2 人及以上即成局，不满 2 人自动取消（不算爽约）；到点在上车点集合点「我到了」，超时 10 分钟还没到可被队友标记爽约。",
      showCancel: false,
    });
  },

  async onSubmit() {
    if (this.data.submitting) return;
    this.setData({ err: null });
    const { directionId, date, time, capacity, note } = this.data;

    let routePayload;
    let routeText; // 纯"起点 → 终点"，不含 返校/离校 前缀（冲突对比表用）
    let summary;
    if (directionId === "in") {
      const opt = this.data.inOptions[this.data.inIndex];
      routePayload = { routeId: opt.routeId };
      routeText = `${opt.label} → 香港教育大学`;
      summary = `返校 ${routeText}`;
    } else {
      if (this.data.destCustom) {
        const to = this.data.customDest.trim();
        if (!to) {
          wx.showToast({ title: "请填写下车地点", icon: "none" });
          return;
        }
        routePayload = { directionId: "out", to };
        routeText = `香港教育大学 → ${to}`;
        summary = `离校 ${routeText}`;
      } else {
        const opt = this.data.outOptions[this.data.outIndex];
        routePayload = { routeId: opt.routeId };
        routeText = `香港教育大学 → ${opt.label}`;
        summary = `离校 ${routeText}`;
      }
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: "发起中", mask: true });
    const res = await api.call("rides", {
      action: "create",
      date,
      time,
      capacity,
      note,
      ...routePayload,
    });
    wx.hideLoading();
    this.setData({ submitting: false });

    if (res.ok) {
      wx.showToast({ title: "已发起，等拼友来", icon: "success" });
      // redirectTo：用详情页替换本填表页 → 详情页左上角返回 = 直接回找局
      setTimeout(() => wx.redirectTo({ url: `/pages/ride/ride?id=${res.data.rideId}` }), 600);
    } else if (res.err === "ACTIVE_RIDE" && res.data && res.data.conflict) {
      const c = res.data.conflict;
      this.setData({
        err: {
          head: "你已有出发时间太近的拼车局",
          sub: "请先退出或等它结束后再发起",
          rows: [
            { label: "已加入", text: `${c.routeLabel} · ${fmtDate(c.boardAt)} ${fmtTime(c.boardAt)}` },
            { label: "新建冲突", text: `${routeText} · ${date} ${time}` },
          ],
        },
      });
      // 冲突提示在页面下方，自动滚到底让用户看得到（兼容小屏机型）
      setTimeout(() => wx.pageScrollTo({ scrollTop: 100000, duration: 250 }), 120);
    } else if (res.err === "NEED_REGISTER") {
      wx.showModal({
        title: "先注册再发局",
        content: res.msg || "请先填个昵称完成注册",
        confirmText: "去注册",
        success: (m) => {
          if (m.confirm) {
            getApp().globalData.pendingRegister = true;
            wx.switchTab({ url: "/pages/profile/profile" });
          }
        },
      });
    } else {
      wx.showModal({ title: "发局失败", content: `${res.msg}\n（这是你想发起但失败的局：${summary} ${date} ${time}）`, showCancel: false });
    }
  },
});
