// pages/feed/feed.js —— Tab1 找局（云 rides.list + 本地筛选）
// 筛选：方向(返校/离校/全部) · 上车点/下车点(下拉) · 还差几人(空位)
const api = require("../../utils/api.js");
const routeSvc = require("../../utils/routes.js");
const { cardOf, avatarSlots } = require("../../utils/rideView.js");
const autopoll = require("../../utils/autopoll.js");
const confirmRide = require("../../utils/confirmRide.js");

const DIR_OPTIONS = [
  { id: "in", label: "返校" },
  { id: "out", label: "离校" },
  { id: "all", label: "全部方向" },
];
const SEAT_OPTIONS = [
  { v: 0, label: "不限" },
  { v: 1, label: "≥1" },
  { v: 2, label: "≥2" },
  { v: 3, label: "≥3" },
];
const CUSTOM = "__custom__";

// 列表末尾温馨提示：轮换文案，仅装饰（不点击、不弹窗、不跳发局）
const END_TIPS = [
  "已经翻到底了～没找到合心意的？也可以自己发起一局",
  "与其干等，不如自己发起一局当发起人",
  "拼车人越多越划算，发起一局拉上同学吧",
  "到点口岸的士站人多，早发局更容易凑齐人",
  "组到 2 人就能成局，别担心人太少",
];

function inboundPlaces() {
  const seen = [];
  routeSvc.byDirection("in").forEach((r) => {
    if (!seen.some((x) => x.id === r.from)) seen.push({ id: r.from, label: r.from });
  });
  seen.push({ id: CUSTOM, label: "自定义上车点（其它香港地点）" }); // 返校自定义上车点（ADR-0014）
  return seen;
}
function outboundPlaces() {
  const seen = routeSvc.byDirection("out").map((r) => ({ id: r.to, label: r.to }));
  seen.push({ id: CUSTOM, label: "自定义下车点（其它香港地点）" });
  return seen;
}

Page({
  data: {
    dirOptions: DIR_OPTIONS,
    selectedDir: "all", // 默认全部方向（2026-09-08 起；此前默认返校）
    dirLabel: "全部方向",
    openKey: "none", // none | dir | place | seat

    placeOptions: [], // 默认全部方向时无上车点筛选；选了具体方向后重建
    placeHeader: "上车点",
    placeValue: "all", // 'all' | from/to 名 | __custom__
    placeLabel: "全部上车点",

    seatOptions: SEAT_OPTIONS,
    seatVal: 0,
    seatLabel: "不限",

    rides: [],
    loading: true,
    loaded: false,
    loadErr: false, // rides.list 拉取失败（区别于"真没有局"）
    invites: [],
    endTip: "", // 列表末尾温馨提示（轮换，仅装饰）
  },

  onLoad() {
    // 常驻找局页时每 10 秒轻量刷新：别人新发的局/人数变化不用切 Tab 也能看到；下拉展开时不刷
    this._feedPoll = autopoll({ intervalMs: 10000, idleWhile: () => this.data.openKey !== "none", tick: () => this.refresh() });
    this.refresh();
    this.refreshRoutes();
  },
  onShow() {
    if (this.data.loaded) this.refresh();
    this._feedPoll.start();
    confirmRide.maybePromptOnce(); // 补签到确认（结算后未签到者 48h 内被问）
  },
  onHide() {
    this._feedPoll.stop();
  },
  onUnload() {
    this._feedPoll.stop();
  },
  // 线路目录以云端为准：拉到后重建当前方向的下拉；所选值若已不存在则回到"全部"
  async refreshRoutes() {
    const before = routeSvc.isLoaded();
    await routeSvc.load();
    if (routeSvc.isLoaded() && !before) {
      const dir = this.data.selectedDir;
      const opts = dir === "in" ? inboundPlaces() : dir === "out" ? outboundPlaces() : [];
      const header = dir === "in" ? "上车点" : "下车点";
      const keep = this.data.placeValue !== "all" && this.data.placeValue !== CUSTOM && opts.some((o) => o.id === this.data.placeValue);
      this.setData({
        placeOptions: opts,
        placeHeader: header,
        placeValue: keep ? this.data.placeValue : "all",
        placeLabel: keep ? this.data.placeValue : dir === "in" ? "全部上车点" : "全部下车点",
      });
      this.render();
    }
  },
  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },
  onShareAppMessage() {
    return { title: "深港拼车 · 找同路人组队拼的士", path: "/pages/feed/feed" };
  },

  async refresh() {
    const res = await api.call("list");
    if (!res.ok) {
      // 失败不再伪装成"空列表"：置错误态（首屏可见）+ 自动重试一次（冷启动/刚重传云函数常见）
      this.setData({ rides: [], loading: false, loaded: true, loadErr: true });
      if (!this._retried) {
        this._retried = true;
        setTimeout(() => this.refresh(), 1500);
      }
      return;
    }
    this._rides = res.data.rides || [];
    this._retried = false;
    this.setData({ loadErr: false });
    this.render();
    this.loadInvites();
  },
  onRetryFeed() {
    this._retried = false;
    this.setData({ loading: true, loadErr: false });
    this.refresh();
  },

  async loadInvites() {
    const res = await api.call("inviteList");
    this.setData({ invites: res.ok ? res.data.invites : [] });
  },

  openInvite() {
    const first = this.data.invites[0];
    if (first && first.live) {
      wx.navigateTo({ url: `/pages/ride/ride?id=${first.rideId}` });
    } else {
      wx.showToast({ title: "该邀请的队伍已满/已结束", icon: "none" });
    }
  },

  async declineInvite() {
    const first = this.data.invites[0];
    if (!first) return;
    await api.call("inviteRespond", { inviteId: first._id, accept: false });
    this.loadInvites();
  },

  // ---- 下拉控制 ----
  onOpen(e) {
    const key = e.currentTarget.dataset.k;
    this.setData({ openKey: this.data.openKey === key ? "none" : key });
  },
  closeAll() {
    this.setData({ openKey: "none" });
  },

  onPickDir(e) {
    const id = e.currentTarget.dataset.id;
    const label = DIR_OPTIONS.find((x) => x.id === id).label;
    const patch = { selectedDir: id, dirLabel: label, placeValue: "all", openKey: "none" };
    if (id === "in") {
      patch.placeOptions = inboundPlaces();
      patch.placeHeader = "上车点";
      patch.placeLabel = "全部上车点";
    } else if (id === "out") {
      patch.placeOptions = outboundPlaces();
      patch.placeHeader = "下车点";
      patch.placeLabel = "全部下车点";
    }
    this.setData(patch);
    this.render();
  },

  onPickPlace(e) {
    const id = e.currentTarget.dataset.id;
    const opt = this.data.placeOptions.find((x) => x.id === id);
    const isAll = id === "all";
    this.setData({
      placeValue: id,
      placeLabel: isAll ? (this.data.selectedDir === "in" ? "全部上车点" : "全部下车点") : opt ? opt.label : "全部",
      openKey: "none",
    });
    this.render();
  },

  onPickSeat(e) {
    const v = Number(e.currentTarget.dataset.id);
    const opt = SEAT_OPTIONS.find((x) => x.v === v);
    this.setData({ seatVal: v, seatLabel: opt.label, openKey: "none" });
    this.render();
  },

  // ---- 列表 ----
  render() {
    const { selectedDir: dir, placeValue: place, seatVal } = this.data;
    const list = (this._rides || [])
      .filter((r) => {
        if (dir !== "all" && r.directionId !== dir) return false;
        if (place !== "all") {
          if (dir === "in") {
            if (place === CUSTOM) {
              if (r.routeId) return false; // 自定义上车点的返校局没有 routeId
            } else if (r.from !== place) {
              return false;
            }
          } else if (dir === "out") {
            if (place === CUSTOM) {
              if (r.routeId) return false; // 只有自定义下车点的局没有 routeId
            } else if (r.to !== place) {
              return false;
            }
          }
        }
        if (seatVal > 0 && r.capacity - r.memberCount < seatVal) return false;
        return true;
      })
      .map((r) => {
        const c = cardOf(r); // 卡片展示唯一派生（routeLabel/时间/座位/状态标签）
        return {
          ...r,
          id: r._id,
          routeLabel: c.routeLabel,
          timeText: c.dayText,
          departText: c.departText,
          seatText: c.seatText,
          statusLabel: c.statusLabel,
          statusCls: c.statusCls,
          joined: !!r.joined,
          mine: !!r.mine,
          marked: !!r.mine || !!r.joined,
          markLabel: r.mine ? "我发起的" : r.joined ? "已加入" : "",
          // 固定 capacity 个头像位：有人=真人首字+性别框；空位=灰圈加号
          slots: avatarSlots(r, r.membersBrief),
          joinable: r.status === "recruiting" && r.memberCount < r.capacity,
        };
      });
    this.setData({ rides: list, loading: false, loaded: true, endTip: this.pickEndTip(list) });
  },

  // 列表内容变化时才换一条提示（避免 10s 轮询原地闪文案）；空列表清空
  pickEndTip(list) {
    const sig = list.map((r) => r.id).join(",");
    if (!list.length) {
      this._endTipSig = "";
      return "";
    }
    if (sig === this._endTipSig) return this.data.endTip;
    this._endTipSig = sig;
    let tip = END_TIPS[Math.floor(Math.random() * END_TIPS.length)];
    if (tip === this.data.endTip) tip = END_TIPS[(END_TIPS.indexOf(tip) + 1) % END_TIPS.length];
    return tip;
  },

  goCreate() {
    wx.navigateTo({ url: "/pages/create/create" });
  },
  openRide(e) {
    wx.navigateTo({ url: `/pages/ride/ride?id=${e.currentTarget.dataset.id}` });
  },
});
