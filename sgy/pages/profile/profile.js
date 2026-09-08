// pages/profile/profile.js —— Tab3 我的（已接 rides.me / rides.login）
const api = require("../../utils/api.js");
const rulesText = require("../../utils/rulesText.js");

// 随机昵称建议：每个人默认不一样（注册时可改）
const WORDS = ["麦穗", "山风", "橘子", "青柠", "海豚", "布丁", "繁星", "远山", "小鹿", "云朵", "晨光", "晚风"];
const nickSuggestion = () => `${WORDS[Math.floor(Math.random() * WORDS.length)]}${Math.floor(10 + Math.random() * 90)}`;

Page({
  data: {
    user: { nickName: "我", gender: "", genderLocked: "", registered: false, avatarChar: "我", phoneVerified: false, sub: "点击完善资料（填昵称）后才能参与拼车" },
    credit: 100,
    bannedUntil: 0,
    isAdmin: false,
    registerNick: "",
    registering: false,
    showReg: false,
    genders: [
      { id: "", label: "不填" },
      { id: "female", label: "女" },
      { id: "male", label: "男" },
    ],
    menu: [
      { id: "credit", label: "信用分与规则", icon: "⭐" },
      { id: "privacy", label: "隐私与实名说明", icon: "🔒" },
      { id: "feedback", label: "反馈与建议", icon: "✉️" },
      { id: "about", label: "关于本工具", icon: "ℹ️" },
    ],
  },

  onShow() {
    rulesText.load(); // 预拉规则面板（信用/隐私弹层文案与数字以云端为准）
    this.refresh().then(() => {
      // 从发局/加入被拦跳过来时：自动弹出注册
      const g = getApp().globalData;
      if (g.pendingRegister) {
        g.pendingRegister = false;
        if (!this.data.user.registered) this.openRegister();
      }
    });
  },

  async refresh() {
    const res = await api.call("me");
    if (res.ok) {
      const u = res.data.user;
      const locked = !!u.genderLocked;
      const sub = u.registered
        ? locked
          ? "性别已核实 · 仅昵称可改"
          : "点我可修改昵称/性别"
        : "点击完善资料（填昵称）后才能参与拼车";
      this.setData({
        user: { ...this.data.user, ...u, avatarChar: (u.nickName || "我").slice(0, 1), sub },
        credit: u.credit,
        bannedUntil: u.bannedUntil || 0,
        isAdmin: !!res.data.isAdmin,
      });
    }
  },

  onTapUser() {
    if (this.data.user.registered) {
      wx.showToast({
        title: this.data.user.genderLocked ? "已注册；性别已核实不可改，昵称可直接改" : "已注册，昵称/性别可直接改",
        icon: "none",
      });
      return;
    }
    this.openRegister();
  },
  openRegister() {
    if (this.data.user.registered) return;
    if (!this.data.registerNick) this.setData({ registerNick: nickSuggestion() });
    this.setData({ showReg: true });
  },
  onCloseReg() {
    this.setData({ showReg: false });
  },

  onNickInput(e) {
    this.setData({ registerNick: e.detail.value });
  },

  async onRegisterSubmit() {
    const nick = this.data.registerNick.trim();
    if (!nick) {
      wx.showToast({ title: "请填写昵称", icon: "none" });
      return;
    }
    if (this.data.registering) return;
    this.setData({ registering: true });
    wx.showLoading({ title: "注册中", mask: true });
    const res = await api.call("register", { nickName: nick, gender: this.data.user.gender || "" });
    wx.hideLoading();
    this.setData({ registering: false });
    if (res.ok) {
      wx.showToast({ title: "注册成功，可参与拼车", icon: "success" });
      this.setData({ showReg: false });
      this.refresh();
    } else {
      wx.showToast({ title: res.msg || "注册失败", icon: "none" });
    }
  },

  async onPickGender(e) {
    const g = e.currentTarget.dataset.id;
    const res = await api.call("login", { gender: g });
    if (res.ok) {
      this.setData({ "user.gender": g });
      wx.showToast({ title: "已保存（自报，无法强验证）", icon: "none" });
    } else {
      wx.showToast({ title: res.msg || "保存失败", icon: "none" });
    }
  },

  onIdentity() {
    if (!this.data.user.registered) {
      this.openRegister();
      return;
    }
    wx.navigateTo({ url: "/pages/identity/identity" });
  },

  onTapMenu(e) {
    const id = e.currentTarget.dataset.id;
    if (id === "feedback") {
      wx.navigateTo({ url: "/pages/feedback/feedback" });
      return;
    }
    // 信用分规则 / 隐私与实名：半屏可视化面板（rules-panel 组件，内容单一来源 rides/rules.js）
    const panel = this.selectComponent("#rulesPanel");
    if (id === "credit" && panel) {
      panel.open("credit");
      return;
    }
    if (id === "privacy" && panel) {
      panel.open("privacy");
      return;
    }
    if (id === "about") {
      wx.showModal({
        title: "深港拼车",
        content:
          "为深港跨境通勤者（当前：往返香港教育大学的师生）提供拼车局撮合。只组队、不约车、不经手车费，AA 线下进行。",
        showCancel: false,
      });
    }
  },

  onAdmin() {
    wx.navigateTo({ url: "/pages/admin/admin" });
  },

  onLogin() {
    wx.showToast({ title: "已自动登录（体验版无需手动）", icon: "none" });
  },
});
