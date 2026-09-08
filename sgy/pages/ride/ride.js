// pages/ride/ride.js —— 局详情（云 rides.detail 等）
// 聊天已统一搬到「聊天室」Tab：本页不再内嵌聊天，成员点「去聊天室」跳转。
const api = require("../../utils/api.js");
const { cardOf, avatarChar } = require("../../utils/rideView.js");
const { dayLabel, frameCls } = require("../../utils/domain.js");
const autopoll = require("../../utils/autopoll.js");
const rulesText = require("../../utils/rulesText.js");
const { decideJoinGate } = require("../../utils/rideGate.js"); // 加入前确认门控（纯判定）
const { confirm } = require("../../utils/confirm.js"); // 确认-再动作弹窗样板

Page({
  data: {
    ride: null, // 详情视图
    loaded: false,
    errorMsg: "",
    isMember: false,
    isHost: false,
    canJoin: false,
    canCancel: false,
    canLeave: false,
    meChecked: false,
    meNeedPoll: false,
    pollAccepted: false,
    showRules: false,
    rules: rulesText.timeline(), // 规则面板：云端单一来源，本地快照兜底（onLoad 再刷新）
    isDone: false, // 已结束/已取消：操作按钮应灰置不可交互
    editingNote: false,
    noteDraft: "",
    blockedRideText: "", // 本局里被我标过「不与其乘车」的人（标记者横幅）
  },

  onLoad(options) {
    this._rideId = options && options.id;
    this._openid = "";
    // 规则面板以云端为准：拉回后刷新（未拉到用快照）
    rulesText.load().then(() => this.setData({ rules: rulesText.timeline() }));
    // 详情页常驻时自动刷新：新人入队/人数变化/备注修改不用退出重进（加载到内容且无错误才刷）
    this._ridePoll = autopoll({ intervalMs: 6000, idleWhile: () => !!this.data.ride && !this.data.errorMsg, tick: () => this.refresh() });
    if (this._rideId) this.refresh();
    else this.setData({ errorMsg: "缺少局 ID", loaded: true });
  },
  onShow() {
    if (this.data.ride && !this.data.errorMsg) this.refresh();
    this._ridePoll.start();
  },
  onHide() {
    this._ridePoll.stop();
  },
  onUnload() {
    this._ridePoll.stop();
  },

  onShareAppMessage() {
    const r = this.data.ride;
    return {
      title: r ? `${dayLabel(r.boardAt)} ${r.routeLabel} · 求拼${r.capacity - r.memberCount}人` : "深港拼车",
      path: `/pages/ride/ride?id=${this._rideId}`,
    };
  },

  async refresh() {
    const [meRes, res] = await Promise.all([
      api.call("me"),
      api.call("detail", { rideId: this._rideId }),
    ]);
    if (meRes.ok) this._openid = meRes.data.user.openid;
    if (!res.ok) {
      this.setData({ loaded: true, errorMsg: res.msg || "加载失败" });
      return;
    }
    const d = res.data.ride;
    const c = cardOf(d); // 卡片展示唯一派生（routeLabel/时间/座位/状态标签）
    const me = d.members.find((m) => m.openid === this._openid);
    const poll = d.poll || null;
    const meVoted = !!(poll && poll.active && poll.responses.some((x) => x.openid === this._openid));
    const pollResolved = !!(poll && !poll.active && poll.status === "accepted");
    const blkNames = (d.blockedInRide || []).map((x) => x.name);

    this.setData({
      ride: {
        _id: d._id,
        routeLabel: c.routeLabel,
        boardAt: d.boardAt,
        dayText: c.dayText,
        departText: c.departText,
        statusLabel: c.statusLabel,
        statusCls: c.statusCls,
        seatText: c.seatText,
        note: d.note,
        memberCount: d.memberCount,
        capacity: d.capacity,
        status: d.status,
        urgent: !!d.urgent, // 加急局红标
        members: d.members.map((m) => ({
          openid: m.openid,
          name: m.name,
          role: m.role,
          frame: frameCls(m.gender),
          avatarChar: avatarChar(m.name),
          checked: m.checkedInAt > 0,
          isMe: m.openid === this._openid,
        })),
      },
      isMember: !!d.isMember,
      isHost: !!d.isHost,
      canJoin: !!d.canJoin,
      canCancel: !!d.canCancel,
      meChecked: !!(me && me.checkedInAt > 0),
      meNeedPoll: !!(poll && poll.active && !meVoted && d.isMember),
      pollAccepted: !!pollResolved,
      isDone: ["done", "cancelled", "failed"].includes(d.status),
      canLeave: ["recruiting", "locked"].includes(d.status) && Date.now() < d.boardAt,
      blockedRideText: blkNames.join("、"),
      loaded: true,
      errorMsg: "",
    });
  },

  goChatTab() {
    // 让聊天室 Tab 选中这一局：switchTab 不带参数，用 globalData 传目标局 id（chat.onShow 消费后清除）
    getApp().globalData.pendingChatRide = this._rideId;
    wx.switchTab({ url: "/pages/chat/chat" });
  },

  async run(action, data, successText) {
    const res = await api.call(action, { rideId: this._rideId, ...data });
    if (res.ok) {
      if (successText) wx.showToast({ title: successText, icon: "success" });
      this.refresh();
    } else {
      wx.showModal({ title: "操作失败", content: res.msg || "请重试", showCancel: false });
    }
    return res.ok;
  },

  async onJoin() {
    const ride = this.data.ride;
    const gate = decideJoinGate(ride, Date.now()); // 该弹哪种确认（urgent/near/null），纯判定集中一处
    // 加急局成员侧承诺：出发在即已过免费退出线，加入后中途退出计爽约（优先级高于近临提醒，不叠弹窗）
    if (gate === "urgent" && !this._urgentJoinConfirmed) {
      confirm({
        title: "加入加急局？",
        content: "加急局出发在即（30 分钟内）：加入后中途退出计爽约、扣信用分。确认加入？",
        confirmText: "确认加入",
        cancelText: "再想想",
        onOk: () => {
          this._urgentJoinConfirmed = true;
          this.onJoin();
        },
      });
      return;
    }
    // 非加急、距发车 < 1 小时：提示可能来不及 / 凑不齐（凑不齐自动取消、不计爽约）
    if (gate === "near" && !this._nearJoinConfirmed) {
      confirm({
        title: "确认加入？",
        content: "距发车不到 1 小时：可能来不及集合，也可能凑不齐人。凑不齐会自动取消，不计爽约。确定加入吗？",
        confirmText: "确定加入",
        cancelText: "再想想",
        onOk: () => {
          this._nearJoinConfirmed = true;
          this.onJoin();
        },
      });
      return;
    }
    const res = await api.call("join", { rideId: this._rideId });
    if (res.ok) {
      const warns = (res.data && res.data.warnings) || [];
      if (warns.length) {
        wx.showModal({
          title: "队里有你标记过的人",
          content: `这一局里有你标记「不与其乘车」的人：${warns.map((w) => w.name).join("、")}。如需避开，请退出本局。`,
          confirmText: "我知道了",
          showCancel: false,
          success: () => this.refresh(),
        });
      } else {
        wx.showToast({ title: "已加入", icon: "success" });
        this.refresh();
      }
    } else if (res.err === "NEED_REGISTER") {
      wx.showModal({
        title: "先注册再加入",
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
      wx.showModal({ title: "加入失败", content: res.msg || "请重试", showCancel: false });
    }
  },

  onLeave() {
    const r = this.data.ride;
    const late = r && Date.now() >= r.boardAt - 30 * 60 * 1000;
    confirm({
      title: "退出这一局？",
      content: late ? "距上车不足 30 分钟，退出会计爽约（信用 −20）。确定退出？" : "退出后如想再参加需重新加入。",
      onOk: () => this.run("leave", {}, "已退出"),
    });
  },

  onCancel() {
    confirm({
      title: "解散这一局？",
      content: "解散后所有成员都会收到局已取消。",
      onOk: () => {
        this.run("cancel", {}).then((ok) => ok && setTimeout(() => wx.navigateBack(), 600));
      },
    });
  },

  onCheckin() {
    // 严谨交互：二次确认（措辞软化"诚信出行"→"互相信任"）
    confirm({
      title: "确认到达？",
      content: "请如实签到——拼车靠的是互相信任，别让队友空等。",
      confirmText: "我到了",
      onOk: () => this.run("checkin", {}, "已签到，大家集合吧"),
    });
  },

  onPollYes() {
    this.run("respondPoll", { accept: true });
  },

  onPollNo() {
    confirm({
      title: "不认可当前人数？",
      content: "你会免费退出这一局（不影响信用），让其余成员继续组。",
      onOk: () => this.run("respondPoll", { accept: false }, "已退出"),
    });
  },

  onTapNote() {
    if (this.data.isHost) this.onStartNoteEdit();
  },
  onStartNoteEdit() {
    const r = this.data.ride;
    this.setData({ editingNote: true, noteDraft: (r && r.note) || "" });
  },
  onNoteDraftInput(e) {
    this.setData({ noteDraft: e.detail.value });
  },
  async onSaveNote() {
    const note = this.data.noteDraft.trim();
    const res = await api.call("updateNote", { rideId: this._rideId, note });
    if (res.ok) {
      this.setData({ editingNote: false });
      this.refresh();
    } else {
      wx.showModal({ title: "保存失败", content: res.msg || "请重试", showCancel: false });
    }
  },
  onCancelNoteEdit() {
    this.setData({ editingNote: false });
  },

  onRule() {
    this.setData({ showRules: !this.data.showRules });
  },

  // ---- 成员资料 / 标记 / 举报 / 再约（统一走共用 member-sheet 组件） ----
  async openMember(e) {
    const { openid, name } = e.currentTarget.dataset;
    const sheet = this.selectComponent("#memberSheet");
    if (sheet) {
      sheet.open({
        rideId: this._rideId,
        targetOpenid: openid,
        name,
        meOpenid: this._openid,
        isDone: this.data.isDone,
      });
    }
  },
  goBack() {
    wx.navigateBack();
  },

  openAA() {
    wx.navigateTo({ url: "/pages/aa/aa" });
  },
});
