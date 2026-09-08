// pages/chat/chat.js —— Tab4 聊天室
// 逻辑：显示"我参与的、尚未结束(recruiting/locked/ongoing)"的队伍聊天室。
// 一个都没有 → 占位文案引导去组队；有一两个 → 切换聊天室直接看消息（最多两个：早上返校 ongoing + 晚上离校 recruiting 等）。
const api = require("../../utils/api.js");
const { fmtTime, frameCls } = require("../../utils/domain.js");
const { cardOf, avatarChar } = require("../../utils/rideView.js");
const autopoll = require("../../utils/autopoll.js");
const rulesText = require("../../utils/rulesText.js"); // 图片上限与服务端 MSG_IMG_MAX 同一来源（getRules 下发，快照兜底）

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
    memShow: false, // 消息头像点开的成员资料浮层
    mem: null,
  },

  onLoad() {
    rulesText.load(); // 图片上限以云端为准（未拉到用快照 500000，与旧行为一致）
    // 聊天轮询：打开聊天室期间每 5 秒拉一次当前聊天室的新消息（切房时 tick 读最新的 curRideId）
    this._chatPoll = autopoll({
      intervalMs: 5000,
      tick: () => {
        const id = this.data.curRideId;
        if (!id) return;
        api.call("rides", { action: "messages", rideId: id }).then((res) => {
          if (res.ok && this.data.curRideId === id) this.applyMessages(res.data.messages);
        });
      },
    });
  },
  onShow() {
    this.ensureMe().finally(() => this.refreshRooms());
    this._chatPoll.start();
  },
  onHide() {
    this._chatPoll.stop();
  },
  onUnload() {
    this._chatPoll.stop();
  },

  // 缓存自己的 openid，用于判断"我发的消息"（气泡靠右）
  ensureMe() {
    if (this._openid) return Promise.resolve();
    return api.call("rides", { action: "me" }).then((r) => {
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
    const rooms = ongoing.map((r) => {
      const c = cardOf(r);
      return {
        rideId: r._id,
        label: `${c.dayText} ${c.routeLabel}`,
        statusLabel: c.statusLabel,
      };
    });
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
    this.setData({ curRideId: rideId, curTitle: room.label, curSub: room.statusLabel });
    const res = await api.call("rides", { action: "detail", rideId });
    if (res.ok) {
      const d = res.data.ride;
      this._genderOf = {};
      (d.members || []).forEach((m) => (this._genderOf[m.openid] = m.gender || ""));
      this.applyMessages(d.messages || []);
      this.setData({ curStatusCls: cardOf(d).statusCls });
    }
  },

  applyMessages(msgs) {
    const list = (msgs || []).map((m) => {
      const t = m.text || "";
      const isImg = m.type === "image";
      const isDataImg = isImg && t.indexOf("data:") === 0; // 新 base64 图才渲染
      return {
        openid: m.openid,
        whoChar: avatarChar(m.name),
        frame: frameCls(this._genderOf && this._genderOf[m.openid]),
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

  onSwitchRoom(e) {
    this.loadRoom(e.currentTarget.dataset.id);
  },

  openRide() {
    wx.navigateTo({ url: `/pages/ride/ride?id=${this.data.curRideId}` });
  },

  // ---- 消息头像 → 成员资料浮层（与局详情同套后端 memberInfo/block/complaint；聊天室局为进行中，只能报性别不实） ----
  async openSender(e) {
    const { openid, name } = e.currentTarget.dataset;
    if (!openid) return;
    wx.showLoading({ title: "", mask: true });
    const res = await api.call("rides", { action: "memberInfo", rideId: this.data.curRideId, targetOpenid: openid });
    wx.hideLoading();
    const m = res.ok ? res.data.member : null;
    if (!m) {
      wx.showToast({ title: (res && res.msg) || "无法查看该成员", icon: "none" });
      return;
    }
    this.setData({
      mem: {
        openid: m.openid,
        name: m.name || name || "?",
        genderText: m.gender === "female" ? "女" : m.gender === "male" ? "男" : "未填",
        credit: m.credit,
        blocked: !!m.blocked,
        schoolVerified: !!m.schoolVerified, // F2 起有值：仅「✓ 校内已登记」
        isMe: openid === this._openid,
        avatarChar: avatarChar(m.name || name),
        frame: frameCls(m.gender || ""),
      },
      memShow: true,
    });
  },
  closeMem() {
    this.setData({ memShow: false });
  },
  async toggleMemBlock() {
    const mem = this.data.mem;
    if (!mem || mem.isMe) return;
    const res = await api.call("rides", {
      action: "block",
      rideId: this.data.curRideId,
      targetOpenid: mem.openid,
      block: !mem.blocked,
    });
    if (res.ok) {
      this.setData({ "mem.blocked": res.data.blocked });
      wx.showToast({ title: res.data.blocked ? "已标记：不与其乘车" : "已取消标记", icon: "none" });
    } else {
      wx.showToast({ title: res.msg || "操作失败", icon: "none" });
    }
  },
  memReport() {
    const mem = this.data.mem;
    if (!mem || mem.isMe) return;
    wx.showActionSheet({
      itemList: ["性别填写与真实不符"],
      success: async () => {
        const res = await api.call("rides", {
          action: "complaint",
          rideId: this.data.curRideId,
          targetOpenid: mem.openid,
          kind: "gender_fake",
        });
        if (!res.ok) {
          wx.showModal({ title: "举报未提交", content: res.msg || "请重试", showCancel: false });
          return;
        }
        wx.showToast({
          title: res.data && res.data.auto ? "已有多人联名，自动坐实并扣分" : "已提交，待复核",
          icon: "none",
        });
        this.closeMem();
      },
    });
  },
  memGoRide() {
    if (this.data.curRideId) wx.navigateTo({ url: `/pages/ride/ride?id=${this.data.curRideId}` });
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
  // 压缩→base64→data URI：先 q55，仍超上限再 q30 压一档（都从原图压，避免二次压缩叠加损耗）
  processImage(filePath) {
    const compress = (quality) =>
      new Promise((resolve) => {
        wx.compressImage({
          src: filePath,
          quality,
          success: (r) => resolve(r.tempFilePath || filePath),
          fail: () => resolve(filePath), // 压不动就用原图，交给大小校验兜底
        });
      });
    const toData = (src) =>
      new Promise((resolve, reject) => {
        wx.getFileSystemManager().readFile({
          filePath: src,
          encoding: "base64",
          success: (b) => resolve("data:image/jpeg;base64," + b.data),
          fail: reject,
        });
      });

    wx.showLoading({ title: "压缩中", mask: true });
    compress(55)
      .then(toData)
      .then((uri) => (uri.length > rulesText.imgMax() ? compress(30).then(toData) : uri))
      .then((uri) => {
        wx.hideLoading();
        if (uri.length > rulesText.imgMax()) {
          wx.showToast({ title: "图片仍太大，请用 ≤300KB 的群二维码截图", icon: "none" });
          return;
        }
        this.sendImage(uri);
      })
      .catch(() => {
        wx.hideLoading();
        wx.showToast({ title: "图片读取失败", icon: "none" });
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
