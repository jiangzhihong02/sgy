// pages/chat/chat.js —— Tab4 聊天室
// 逻辑：显示"我参与的、尚未结束(recruiting/locked/ongoing)"的队伍聊天室。
// 一个都没有 → 占位文案引导去组队；有一两个 → 切换聊天室直接看消息（最多两个：早上返校 ongoing + 晚上离校 recruiting 等）。
const api = require("../../utils/api.js");
const { statusView, fmtTime, dayLabel } = require("../../utils/domain.js");

Page({
  data: {
    rooms: [],
    hasRooms: false,
    curRideId: "",
    curTitle: "",
    curSub: "",
    curStatusCls: "tag-gray",
    messages: [],
    hasMyImage: false, // 我已在该局发过图（每人每局 1 张）
    chatInput: "",
    sending: false,
    loading: true,
  },

  onShow() {
    this.ensureMe().finally(() => this.refreshRooms());
  },
  onHide() {
    this.stopPoll();
  },
  onUnload() {
    this.stopPoll();
  },

  // 缓存自己的 openid，用于判断"我发的消息"（气泡靠右）
  ensureMe() {
    if (this._openid) return Promise.resolve();
    return api.call("user", { action: "me" }).then((r) => {
      if (r.ok) {
        this._openid = r.data.user.openid;
        this.applyMessages(this.data.messages);
      }
    });
  },

  async refreshRooms() {
    // 已有队伍时静默刷新，避免每次进 Tab 闪"加载中"；首次/空态才显示全屏 loading
    if (!this.data.hasRooms) this.setData({ loading: true });
    const res = await api.call("rides", { action: "my" });
    const ongoing = res.ok ? res.data.ongoing || [] : [];
    const rooms = ongoing.map((r) => ({
      rideId: r._id,
      label: `${dayLabel(r.boardAt)} ${r.routeLabel}`,
      statusLabel: statusView(r.status).label,
    }));
    this._rooms = rooms;

    let cur = this.data.curRideId;
    if (!rooms.some((x) => x.rideId === cur)) cur = rooms.length ? rooms[0].rideId : "";

    this.setData({
      rooms,
      hasRooms: rooms.length > 0,
      curRideId: cur,
      loading: false,
    });
    if (cur) this.loadRoom(cur);
  },

  async loadRoom(rideId) {
    const room = this._rooms.find((x) => x.rideId === rideId);
    if (!room) return;
    this.stopPoll();
    this.setData({ curRideId: rideId, curTitle: room.label, curSub: room.statusLabel });
    const res = await api.call("rides", { action: "detail", rideId });
    if (res.ok) {
      const d = res.data.ride;
      const frameOf = (g) => (g === "female" ? "avatar-female" : g === "male" ? "avatar-male" : "");
      this._genderOf = {};
      (d.members || []).forEach((m) => (this._genderOf[m.openid] = m.gender || ""));
      this.applyMessages(d.messages || []);
      this.setData({ curStatusCls: statusView(d.status).cls });
      this.startPoll(rideId);
    }
  },

  applyMessages(msgs) {
    const frameOf = (g) => (g === "female" ? "avatar-female" : g === "male" ? "avatar-male" : "");
    const list = (msgs || []).map((m) => {
      const t = m.text || "";
      const isImg = m.type === "image";
      const isDataImg = isImg && t.indexOf("data:") === 0; // 新 base64 图才渲染
      return {
        whoChar: (m.name || "?").slice(0, 1),
        frame: frameOf(this._genderOf && this._genderOf[m.openid]),
        name: m.name,
        at: fmtTime(m.createdAt),
        type: m.type || "text",
        text: t,
        createdAt: m.createdAt,
        mine: !!this._openid && m.openid === this._openid,
        url: isDataImg ? t : "",
        legacyImg: isImg && !isDataImg, // 旧 cloud:// 图不再拉取，显示占位
      };
    });
    const oldLast = this.data.messages.length ? this.data.messages[this.data.messages.length - 1].createdAt : 0;
    const newLast = list.length ? list[list.length - 1].createdAt : 0;
    const changed = list.length !== this.data.messages.length || oldLast !== newLast;
    if (!changed) return;
    this.setData({ messages: list, hasMyImage: list.some((x) => x.mine && x.type === "image") });
  },

  // 聊天轮询：打开聊天室期间每 5 秒拉一次新消息
  startPoll(rideId) {
    this.stopPoll();
    this._pollTimer = setInterval(() => {
      if (this.data.curRideId !== rideId) return;
      api.call("rides", { action: "messages", rideId }).then((res) => {
        if (res.ok && this.data.curRideId === rideId) this.applyMessages(res.data.messages);
      });
    }, 5000);
  },
  stopPoll() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  },

  onSwitchRoom(e) {
    this.loadRoom(e.currentTarget.dataset.id);
  },

  openRide() {
    wx.navigateTo({ url: `/pages/ride/ride?id=${this.data.curRideId}` });
  },

  goFeed() {
    wx.switchTab({ url: "/pages/feed/feed" });
  },

  onChatInput(e) {
    this.setData({ chatInput: e.detail.value });
  },

  async onSend() {
    const text = this.data.chatInput.trim();
    if (!text || this.data.sending) return;
    this.setData({ sending: true });
    const res = await api.call("rides", { action: "sendMessage", rideId: this.data.curRideId, text });
    this.setData({ sending: false, chatInput: "" });
    if (res.ok) this.loadRoom(this.data.curRideId);
    else wx.showToast({ title: res.msg || "发送失败", icon: "none" });
  },

  onShareAppMessage() {
    return { title: "深港拼车", path: "/pages/chat/chat" };
  },

  // ---- 发送图片（方案2：base64 存消息；每人每局 1 张，建议发群二维码） ----
  onPickImage() {
    if (this.data.hasMyImage) {
      wx.showToast({ title: "每人每局只能发 1 张（群二维码）", icon: "none" });
      return;
    }
    wx.showModal({
      title: "发图（每人 1 张）",
      content: "建议发微信群二维码：队友长按图片保存后，用微信扫一扫即可加群。",
      confirmText: "选图",
      success: (r) => {
        if (!r.confirm) return;
        wx.chooseMedia({
          count: 1,
          mediaType: ["image"],
          sourceType: ["album", "camera"],
          success: (m) => this.processImage(m.tempFiles[0].tempFilePath),
        });
      },
    });
  },
  processImage(filePath) {
    wx.showLoading({ title: "压缩中", mask: true });
    wx.compressImage({
      src: filePath,
      quality: 55,
      success: (r) => {
        const src = r.tempFilePath || filePath;
        wx.getFileSystemManager().readFile({
          filePath: src,
          encoding: "base64",
          success: (b) => {
            wx.hideLoading();
            const dataUri = "data:image/jpeg;base64," + b.data;
            if (dataUri.length > 200000) {
              wx.showToast({ title: "图片仍太大，换一张更小的", icon: "none" });
              return;
            }
            this.sendImage(dataUri);
          },
          fail: () => {
            wx.hideLoading();
            wx.showToast({ title: "图片读取失败", icon: "none" });
          },
        });
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: "压缩失败", icon: "none" });
      },
    });
  },
  async sendImage(dataUri) {
    const res = await api.call("rides", { action: "sendMessage", rideId: this.data.curRideId, text: dataUri, type: "image" });
    if (res.ok) this.loadRoom(this.data.curRideId);
    else wx.showModal({ title: "发送失败", content: res.msg || "请重试", showCancel: false });
  },
  onPreviewImg(e) {
    const src = e.currentTarget.dataset.src;
    if (!src) return;
    if (String(src).indexOf("data:") === 0) {
      wx.showToast({ title: "长按图片保存 → 微信扫一扫加群", icon: "none" });
      return;
    }
    wx.previewImage({ urls: [src] });
  },
});
