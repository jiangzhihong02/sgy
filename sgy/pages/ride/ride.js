// pages/ride/ride.js —— 局详情（已接云 rides.detail 等）
const api = require("../../utils/api.js");
const { statusView, fmtTime, dayLabel, departFromNow } = require("../../utils/domain.js");

// 基本规则（面向用户的中文表述，避免 T−30 之类黑话）
const RULES_ROWS = [
  { t: "最少 2 人", d: "即成一局；不足 2 人的局会在约定时间前自动取消，不计爽约。" },
  { t: "出发前 60 分钟", d: "人数还没满时，全员确认是否「按当前人数出发」，没回复默认同意。" },
  { t: "出发前 30 分钟", d: "可自由退出，发起人可解散；之后再退出算爽约，扣信用分。" },
  { t: "出发前 10 分钟", d: "停止加入，按当时人数锁定成局。" },
  { t: "约定时间", d: "到上车点的士站集合，点「我到了」告诉队友你已到。" },
  { t: "约定时间后 10 分钟", d: "还没到、也没在聊天室说明，可被队友标记爽约。" },
];

Page({
  data: {
    ride: null, // 详情视图
    loaded: false,
    errorMsg: "",
    isMember: false,
    isHost: false,
    canJoin: false,
    canCancel: false,
    meChecked: false,
    meNeedPoll: false,
    pollAccepted: false,
    chatting: false,
    chatInput: "",
    showRules: false,
    rules: RULES_ROWS,
    isDone: false, // 已结束/已取消：操作按钮应灰置不可交互
    showMember: false, // 成员资料浮层
    panel: null, // { openid,name,gender,credit,blocked }
    editingNote: false,
    noteDraft: "",
    myActiveRides: [],
  },

  onLoad(options) {
    this._rideId = options && options.id;
    this._openid = "";
    if (this._rideId) this.refresh();
    else this.setData({ errorMsg: "缺少局 ID", loaded: true });
  },

  onShow() {
    // 从别处返回本页时恢复聊天轮询（onHide 已停）
    if (this.data.ride && this.data.isMember) this.syncChatPoll();
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
      api.call("user", { action: "me" }),
      api.call("rides", { action: "detail", rideId: this._rideId }),
    ]);
    if (meRes.ok) this._openid = meRes.data.user.openid;
    if (!res.ok) {
      this.setData({ loaded: true, errorMsg: res.msg || "加载失败" });
      return;
    }
    const d = res.data.ride;
    const sv = statusView(d.status);
    const me = d.members.find((m) => m.openid === this._openid);
    const poll = d.poll || null;
    const meVoted = !!(poll && poll.active && poll.responses.some((x) => x.openid === this._openid));
    const pollResolved = !!(poll && !poll.active && poll.status === "accepted");

    // 性别着色：蓝男 粉女（自报）
    const frameOf = (g) => (g === "female" ? "avatar-female" : g === "male" ? "avatar-male" : "");
    const genderOf = {};
    d.members.forEach((m) => (genderOf[m.openid] = m.gender || ""));

    this.setData({
      ride: {
        _id: d._id,
        routeLabel: d.routeLabel,
        boardAt: d.boardAt,
        dayText: dayLabel(d.boardAt),
        departText: departFromNow(d.boardAt),
        statusLabel: sv.label,
        statusCls: sv.cls,
        seatText: `${d.memberCount}/${d.capacity} 人`,
        note: d.note,
        memberCount: d.memberCount,
        capacity: d.capacity,
        status: d.status,
        members: d.members.map((m) => ({
          openid: m.openid,
          name: m.name,
          role: m.role,
          gender: m.gender || "",
          frame: frameOf(m.gender),
          avatarChar: (m.name || "?").slice(0, 1),
          checked: m.checkedInAt > 0,
          isMe: m.openid === this._openid,
        })),
        messages: (d.messages || []).map((m) => ({
          openid: m.openid,
          name: m.name,
          whoChar: (m.name || "?").slice(0, 1),
          frame: frameOf(genderOf[m.openid]),
          text: m.text,
          type: m.type || "text",
          at: fmtTime(m.createdAt),
          createdAt: m.createdAt,
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
      showMember: false,
      panel: null,
      loaded: true,
      errorMsg: "",
    });
    const r = this.data.ride;
    this._genderOf = {};
    (r.members || []).forEach((m) => (this._genderOf[m.openid] = m.gender || ""));
    this.syncChatPoll();
  },

  onHide() {
    this.stopChatPoll();
  },
  onUnload() {
    this.stopChatPoll();
  },

  // 详情页不再内嵌聊天，统一跳到「聊天室」Tab
  syncChatPoll() {
    this.stopChatPoll();
  },
  goChatTab() {
    wx.switchTab({ url: "/pages/chat/chat" });
  },
  startChatPoll() {
    this.stopChatPoll();
    this._chatTimer = setInterval(() => {
      api.call("rides", { action: "messages", rideId: this._rideId }).then((res) => {
        if (!res.ok) return;
        const frameOf = (g) => (g === "female" ? "avatar-female" : g === "male" ? "avatar-male" : "");
        const list = (res.data.messages || []).map((m) => ({
          openid: m.openid,
          whoChar: (m.name || "?").slice(0, 1),
          frame: frameOf(this._genderOf && this._genderOf[m.openid]),
          name: m.name,
          text: m.text,
          type: m.type || "text",
          at: fmtTime(m.createdAt),
          createdAt: m.createdAt,
        }));
        const cur = this.data.ride;
        const oldLast = cur && cur.messages && cur.messages.length ? cur.messages[cur.messages.length - 1].createdAt : 0;
        const newLast = list.length ? list[list.length - 1].createdAt : 0;
        if (!cur || !cur.messages || list.length !== cur.messages.length || oldLast !== newLast) {
          this.setData({ "ride.messages": list });
        }
      });
    }, 5000);
  },
  stopChatPoll() {
    if (this._chatTimer) {
      clearInterval(this._chatTimer);
      this._chatTimer = null;
    }
  },

  async run(action, data, successText) {
    const res = await api.call("rides", { action, rideId: this._rideId, ...data });
    if (res.ok) {
      if (successText) wx.showToast({ title: successText, icon: "success" });
      this.refresh();
    } else {
      wx.showModal({ title: "操作失败", content: res.msg || "请重试", showCancel: false });
    }
    return res.ok;
  },

  async onJoin() {
    const res = await api.call("rides", { action: "join", rideId: this._rideId });
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
    wx.showModal({
      title: "退出这一局？",
      content: late ? "已过 T−30，退出会计爽约（信用 −20）。确定退出？" : "退出后如想再参加需重新加入。",
      success: (res) => res.confirm && this.run("leave", {}, "已退出"),
    });
  },

  onCancel() {
    wx.showModal({
      title: "解散这一局？",
      content: "解散后所有成员都会收到局已取消。",
      success: (res) => {
        if (res.confirm) {
          this.run("cancel", {}).then((ok) => ok && setTimeout(() => wx.navigateBack(), 600));
        }
      },
    });
  },

  onCheckin() {
    this.run("checkin", {}, "已签到，大家集合吧");
  },

  onPollYes() {
    this.run("respondPoll", { accept: true });
  },

  onPollNo() {
    wx.showModal({
      title: "不认可当前人数？",
      content: "你会免费退出这一局（不影响信用），让其余成员继续组。",
      success: (res) => res.confirm && this.run("respondPoll", { accept: false }, "已退出"),
    });
  },

  onChatInput(e) {
    this.setData({ chatInput: e.detail.value });
  },

  async onSend() {
    const text = this.data.chatInput.trim();
    if (!text || this.data.chatting) return;
    this.setData({ chatting: true });
    const res = await api.call("rides", { action: "sendMessage", rideId: this._rideId, text });
    this.setData({ chatting: false, chatInput: "" });
    if (res.ok) this.refresh();
    else wx.showToast({ title: res.msg || "发送失败", icon: "none" });
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
    const res = await api.call("rides", { action: "updateNote", rideId: this._rideId, note });
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

  // ---- 成员资料 / 标记 / 举报 / 再约（统一在成员浮层里操作） ----
  async openMember(e) {
    const { openid, name } = e.currentTarget.dataset;
    const isMe = openid === this._openid;
    wx.showLoading({ title: "", mask: true });
    const res = await api.call("rides", { action: "memberInfo", rideId: this._rideId, targetOpenid: openid });
    wx.hideLoading();
    if (!res.ok && !isMe) {
      wx.showToast({ title: res.msg || "无法查看", icon: "none" });
      return;
    }
    const m = res.ok
      ? res.data.member
      : { openid, name: name || "我", gender: "", credit: null, blocked: false };
    this.setData({
      panel: {
        ...m,
        name: m.name || name,
        genderText: m.gender === "female" ? "女" : m.gender === "male" ? "男" : "未填",
        avatarChar: ((m.name || name) || "?").slice(0, 1),
        isMe,
      },
      showMember: true,
    });
  },
  closeMember() {
    this.setData({ showMember: false });
  },
  async toggleBlock() {
    const p = this.data.panel;
    if (!p || p.isMe) return;
    const res = await api.call("rides", { action: "block", rideId: this._rideId, targetOpenid: p.openid, block: !p.blocked });
    if (res.ok) {
      this.setData({ "panel.blocked": res.data.blocked });
      wx.showToast({ title: res.data.blocked ? "已标记：不与其乘车" : "已取消标记", icon: "none" });
    } else {
      wx.showToast({ title: res.msg || "操作失败", icon: "none" });
    }
  },
  // 举报：进行中局只有"性别不实"；已结束局才有 迟到/缺勤
  onPanelReport() {
    const p = this.data.panel;
    if (!p || p.isMe) return;
    const items = this.data.isDone ? ["性别填写与真实不符", "迟到", "缺勤 / 没来"] : ["性别填写与真实不符"];
    const kinds = this.data.isDone ? ["gender_fake", "lateness", "absence"] : ["gender_fake"];
    wx.showActionSheet({
      itemList: items,
      success: (r) => this.submitReport(p.openid, kinds[r.tapIndex]),
    });
  },
  async submitReport(targetOpenid, kind) {
    const res = await api.call("rides", { action: "complaint", rideId: this._rideId, targetOpenid, kind });
    if (!res.ok) {
      wx.showModal({ title: "举报未提交", content: res.msg || "请重试", showCancel: false });
      return;
    }
    wx.showToast({
      title: res.data && res.data.auto ? "已有多人联名，自动坐实并扣分" : "已提交，待复核",
      icon: "none",
    });
    this.closeMember();
  },
  // 已完成局：下周同一时刻再约老队友（后端自动复用/新建进行中局并发邀请）
  async onPanelReinvite() {
    const p = this.data.panel;
    if (!p || p.isMe) return;
    wx.showLoading({ title: "", mask: true });
    const res = await api.call("rides", { action: "reinvite", rideId: this._rideId, targetOpenid: p.openid });
    wx.hideLoading();
    if (!res.ok) {
      wx.showModal({ title: "再约失败", content: res.msg || "请重试", showCancel: false });
      return;
    }
    const createdText = res.data.created ? "已建下周同一时刻的新局；" : "用你现有进行中的局；";
    const invText = res.data.inviteSent ? "邀请已发出" : "邀请发送：" + (res.data.msg || "失败");
    wx.showToast({ title: createdText + invText, icon: "none" });
    this.closeMember();
  },

  onPreviewImg(e) {
    const src = e.currentTarget.dataset.src;
    if (src) wx.previewImage({ urls: [src] });
  },

  goBack() {
    wx.navigateBack();
  },
});
