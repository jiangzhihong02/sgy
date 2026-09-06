// pages/profile/profile.js —— Tab3 我的（已接云 user.me / user.login）
const api = require("../../utils/api.js");

// 随机昵称建议：每个人默认不一样（注册时可改）
const WORDS = ["麦穗", "山风", "橘子", "青柠", "海豚", "布丁", "繁星", "远山", "小鹿", "云朵", "晨光", "晚风"];
const nickSuggestion = () => `${WORDS[Math.floor(Math.random() * WORDS.length)]}${Math.floor(10 + Math.random() * 90)}`;

Page({
  data: {
    user: { nickName: "我", gender: "", registered: false, avatarChar: "我", phoneVerified: false },
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
      { id: "about", label: "关于本工具", icon: "ℹ️" },
    ],
  },

  onShow() {
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
    const res = await api.call("user", { action: "me" });
    if (res.ok) {
      const u = res.data.user;
      this.setData({
        user: { ...this.data.user, ...u, avatarChar: (u.nickName || "我").slice(0, 1) },
        credit: u.credit,
        bannedUntil: u.bannedUntil || 0,
        isAdmin: !!res.data.isAdmin,
      });
    }
  },

  onTapUser() {
    if (this.data.user.registered) {
      wx.showToast({ title: "已注册，昵称/性别可直接改", icon: "none" });
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
    const res = await api.call("user", { action: "register", nickName: nick, gender: this.data.user.gender || "" });
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
    const res = await api.call("user", { action: "login", gender: g });
    if (res.ok) {
      this.setData({ "user.gender": g });
      wx.showToast({ title: "已保存（自报，无法强验证）", icon: "none" });
    } else {
      wx.showToast({ title: res.msg || "保存失败", icon: "none" });
    }
  },

  onTapMenu(e) {
    const id = e.currentTarget.dataset.id;
    const modals = {
      credit: {
        title: "信用分规则",
        content:
          "初始 100。爽约 −20；签到后放鸽子 −40；无理由乱标他人 −10；成功同行 +1（封顶 120）。低于 60 暂停发起新局 7 天。上报由管理员人工复核。",
      },
      privacy: {
        title: "性别与隐私",
        content:
          "性别为自报，仅用于组队时以头像框颜色辨认（蓝男·粉女）。填写的性别若与真实不符，同车人可在队伍里检举，查实后清空性别并扣信用分。不展示微信号，站内联系。",
      },
      about: {
        title: "深港拼车",
        content:
          "为深港跨境通勤者（当前：往返香港教育大学的师生）提供拼车局撮合。只组队、不约车、不经手车费，AA 线下进行。",
      },
    };
    const m = modals[id];
    if (m) wx.showModal({ title: m.title, content: m.content, showCancel: false });
  },

  onAdmin() {
    wx.navigateTo({ url: "/pages/admin/admin" });
  },

  onLogin() {
    wx.showToast({ title: "已自动登录（体验版无需手动）", icon: "none" });
  },
});
