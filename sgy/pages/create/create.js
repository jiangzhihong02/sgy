// pages/create/create.js —— 发局（已接云 rides.create）
// 返校 = 深圳→教大：选上车点（固定终点教大）或自定义上车点；离校 = 教大→口岸/就近：选或自定义下车点。
const api = require("../../utils/api.js");
const routeSvc = require("../../utils/routes.js");
const { DIRECTIONS, fmtDate, fmtTime, dayLabel, dateTimeToMs } = require("../../utils/domain.js");
const rulesText = require("../../utils/rulesText.js");

// 24 小时制时间选择：小时 00–23 + 每 5 分钟一档（原生 time 在 iOS 跟随系统 12/24，无法强制，故自选）
const HOURS = Array.from({ length: 24 }, (_, i) => (i < 10 ? "0" + i : "" + i));
const MINS = ["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"];
const NORMAL_MIN_LEAD = 31 * 60000; // 普通局最早提前量（服务端 TOO_SOON >30min，前端取整到 31min）
function timeIndexes(time) {
  const parts = String(time || "00:00").split(":");
  const hh = Math.max(0, Math.min(23, Number(parts[0]) || 0));
  const mm = Number(parts[1]) || 0;
  let mi = 0;
  let best = 99;
  MINS.forEach((s, i) => {
    const d = Math.abs(Number(s) - mm);
    if (d < best) {
      best = d;
      mi = i;
    }
  });
  return [hh, mi];
}

function buildInOptions() {
  return routeSvc.byDirection("in").map((r) => ({
    routeId: r.routeId,
    label: r.from,
    to: r.to,
  }));
}
function buildOutOptions() {
  // 预置 = 3 个口岸下车点；"自定义…"放在最后
  return routeSvc.byDirection("out").map((r) => ({
    routeId: r.routeId,
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
    inOptions: buildInOptions().concat([{ routeId: "", label: "自定义上车点", isCustom: true }]),
    inIndex: 0,
    inLabel: "",
    pickupCustom: false,
    customPickup: "",

    // 离校
    outOptions: buildOutOptions().concat([{ routeId: "", label: "自定义下车点", isCustom: true }]),
    outIndex: 0,
    destCustom: false,
    customDest: "",

    time: "",
    date: "",
    timeStart: "", // 选"今天"时的下限（当前+31分钟），用于校验，不再用于原 time picker
    dateStart: fmtDate(Date.now()),
    hourOptions: HOURS,
    minuteOptions: MINS,
    timeH: 0,
    timeM: 0,
    capacity: 4,
    capacityRange: [2, 3, 4, 5, 6], // 上限 2–6（有六人座车；默认 4）
    urgent: false, // 加急局：30 分钟内出发（T−5 关局；凑不齐自动作废不扣发起人分）
    note: "",
    showRulesTip: false, // 成立规则表就地展开
    rules: rulesText.timeline(), // 成立规则表（云端单一来源，快照兜底；onLoad 再刷新）
    submitting: false,
    err: null, // { head, sub, rows:[{label,text}] }
  },

  onLoad() {
    const now = Date.now();
    this._today = fmtDate(now);
    // 默认时间：当前+40 分钟，向上取整到 5 分钟（避开已过去时刻）
    const rounded = Math.ceil((now + 40 * 60000) / 300000) * 300000;
    const t = fmtTime(rounded);
    const [hi, mi] = timeIndexes(t);
    this.setData({
      date: this._today,
      time: t,
      timeStart: fmtTime(now + 31 * 60000),
      timeH: hi,
      timeM: mi,
    });
    rulesText.load().then(() => this.setData({ rules: rulesText.timeline() })); // 成立规则表以云端为准
    this.applyDirection("in", true);
    this.refreshRoutes();
  },

  // 线路目录以云端为准：拉到后重建下拉（保持当前方向，回退到首项/非自定义）
  async refreshRoutes() {
    await routeSvc.load();
    const inOptions = buildInOptions().concat([{ routeId: "", label: "自定义上车点", isCustom: true }]);
    const outOptions = buildOutOptions().concat([{ routeId: "", label: "自定义下车点", isCustom: true }]);
    const patch = { inOptions, outOptions };
    if (this.data.directionId === "in") {
      patch.inIndex = 0;
      patch.inLabel = inOptions[0] ? inOptions[0].label : "";
      patch.pickupCustom = false;
      patch.customPickup = "";
    } else {
      patch.outIndex = 0;
      patch.destCustom = false;
      patch.customDest = "";
    }
    this.setData(patch);
  },

  applyDirection(dir, init) {
    if (dir === "in") {
      const first = this.data.inOptions[0];
      const patch = {
        selDirDesc: DIRECTIONS.IN.desc,
        inLabel: first ? first.label : "",
      };
      if (init) {
        patch.inIndex = 0;
        patch.pickupCustom = false;
        patch.customPickup = "";
      }
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
    const opt = this.data.inOptions[idx];
    this.setData({ inIndex: idx, inLabel: opt.label, pickupCustom: !!opt.isCustom });
  },

  onPickOut(e) {
    const idx = Number(e.detail.value);
    const opt = this.data.outOptions[idx];
    this.setData({ outIndex: idx, destCustom: !!opt.isCustom });
  },

  onCustomPickupInput(e) {
    this.setData({ customPickup: e.detail.value });
  },
  onCustomDestInput(e) {
    this.setData({ customDest: e.detail.value });
  },

  // 所选时间距现在还有多少毫秒（加急/普通共用；用 domain.dateTimeToMs，与服务端同口径）
  _leadOf(date, time) {
    return dateTimeToMs(date, time) - Date.now();
  },

  // 24 小时制自选时间（小时列 00–23 / 分钟列 每 5 分钟）；加急局下限 15 分钟、窗口 30 分钟
  onPickTimeM(e) {
    const v = e.detail.value || [];
    const hh = HOURS[v[0]] || "00";
    const mm = MINS[v[1]] || "00";
    const t = `${hh}:${mm}`;
    const lead = this._leadOf(this.data.date, t);
    const minLead = this.data.urgent ? rulesText.urgentMinLead() : NORMAL_MIN_LEAD;
    if (lead < minLead) {
      wx.showToast({ title: this.data.urgent ? "加急局最早提前 15 分钟发起" : "出发时间不能早于当前 31 分钟", icon: "none" });
      return;
    }
    if (this.data.urgent && lead > rulesText.urgentWindow()) {
      wx.showToast({ title: "加急仅限 30 分钟内出发", icon: "none" });
      return;
    }
    this.setData({ time: t, timeH: v[0], timeM: v[1] });
    this._maybeSuggestLeadTime();
  },
  onPickDate(e) {
    const date = e.detail.value;
    const patch = { date };
    // 选今天 → 时间下限=当前+31 分钟（加急 15 分钟）；选未来 → 不限（避免出现早于现在的选项）
    if (date === this._today) {
      const start = fmtTime(Date.now() + (this.data.urgent ? rulesText.urgentMinLead() : NORMAL_MIN_LEAD));
      patch.timeStart = start;
      if (this.data.time && this.data.time < start) patch.time = start;
    } else {
      patch.timeStart = "";
    }
    const final = patch.time || this.data.time;
    const [hi, mi] = timeIndexes(final);
    patch.timeH = hi;
    patch.timeM = mi;
    this.setData(patch);
    this._maybeSuggestLeadTime();
  },

  // 选完集合时间后提示一次"提前约50分钟"（同一会话只弹一次；可"不再显示"永久关闭，storage 记录，无重置入口）
  _maybeSuggestLeadTime() {
    if (this._leadTipShown) return; // 调时间/调日期会各触发一次，会话内去重
    let off = false;
    try {
      off = !!wx.getStorageSync("createLeadTipOff");
    } catch (e) { /* storage 不可用照常提示 */ }
    if (off) return;
    this._leadTipShown = true;
    wx.showModal({
      title: "留出集合与 AA 时间",
      content: "建议集合时间比上课时间提前约 50 分钟——留出到校、与队友当面 AA 的时间，避免赶上课。",
      confirmText: "知道了",
      cancelText: "不再显示",
      success: (r) => {
        if (!r.confirm) {
          try { wx.setStorageSync("createLeadTipOff", 1); } catch (e) { /* 忽略 */ }
        }
      },
    });
  },
  onCapacityTap(e) {
    this.setData({ capacity: Number(e.currentTarget.dataset.cap) });
  },

  // 加急局开关：仅当所选时间在 15–30 分钟内可用；勾选时提醒"可能没人响应"
  onToggleUrgent() {
    if (this.data.urgent) {
      this.setData({ urgent: false });
      return;
    }
    const lead = this._leadOf(this.data.date, this.data.time);
    if (lead > rulesText.urgentWindow() || lead < rulesText.urgentMinLead()) {
      wx.showToast({ title: "先把上车时间调到 15–30 分钟内，再勾加急", icon: "none" });
      return;
    }
    this.setData({ urgent: true });
    wx.showModal({
      title: "加急局提醒",
      content: "加急局 30 分钟内出发，可能没人响应——请做好心理准备。",
      confirmText: "知道",
      showCancel: false,
    });
  },
  onNoteInput(e) {
    this.setData({ note: e.detail.value });
  },

  onPreviewRule() {
    // 查看规则 = 就地展开两列表格（时点｜说明），已中文；不用整段弹窗
    this.setData({ showRulesTip: !this.data.showRulesTip });
  },

  async onSubmit() {
    if (this.data.submitting) return;
    // 加急局：发起前二次确认（发起后不能取消；凑不齐 2 人自动作废，不计爽约不扣分）
    if (this.data.urgent && !this._urgentConfirmed) {
      wx.showModal({
        title: "加急局 · 发起前确认",
        content: "加急局 30 分钟内出发，发起后不能取消。若凑不齐 2 人会自动作废（不计爽约、不扣信用分）。确认发起？",
        confirmText: "确认发起",
        cancelText: "再想想",
        success: (r) => {
          if (r.confirm) {
            this._urgentConfirmed = true;
            this.onSubmit();
          }
        },
      });
      return;
    }
    this.setData({ err: null });
    const { directionId, date, time, capacity, note } = this.data;

    let routePayload;
    let routeText; // 纯"起点 → 终点"，不含 返校/离校 前缀（冲突对比表用）
    let summary;
    if (directionId === "in") {
      if (this.data.pickupCustom) {
        const from = this.data.customPickup.trim();
        if (!from) {
          wx.showToast({ title: "请填写上车地点", icon: "none" });
          return;
        }
        routePayload = { directionId: "in", from };
        routeText = `${from} → 香港教育大学`;
        summary = `返校 ${routeText}`;
      } else {
        const opt = this.data.inOptions[this.data.inIndex];
        routePayload = { routeId: opt.routeId };
        routeText = `${opt.label} → 香港教育大学`;
        summary = `返校 ${routeText}`;
      }
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
    const res = await api.call("create", {
      date,
      time,
      capacity,
      note,
      urgent: this.data.urgent,
      ...routePayload,
    });
    wx.hideLoading();
    this.setData({ submitting: false });

    if (res.ok) {
      wx.showToast({ title: this.data.urgent ? "加急局已发起，转发拉人吧" : "已发起，等拼友来", icon: "success" });
      // 平台 AA 提醒（严谨交互）：先成功提示，再补一条"线下AA / 逃单不负责"
      setTimeout(() => {
        wx.showToast({ title: "平台建议线下 AA，安全妥当；逃单、不给钱平台不负责", icon: "none" });
      }, 800);
      // redirectTo：用详情页替换本填表页 → 详情页左上角返回 = 直接回找局
      setTimeout(() => wx.redirectTo({ url: `/pages/ride/ride?id=${res.data.rideId}` }), 1800);
    } else if (res.err === "ACTIVE_RIDE" && res.data && res.data.conflict) {
      const c = res.data.conflict;
      this.setData({
        err: {
          head: res.msg || "你已有冲突的进行中拼车局",
          sub: "先退出「已加入」的那一局，或等它结束后再发起",
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
