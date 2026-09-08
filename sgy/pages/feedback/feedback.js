// pages/feedback/feedback.js —— 反馈与建议（仅注册用户提交，服务端校验）
const api = require("../../utils/api.js");

const KINDS = [
  { id: "suggestion", label: "建议" },
  { id: "bug", label: "问题/Bug" },
  { id: "other", label: "其它" },
];

Page({
  data: {
    kinds: KINDS,
    kind: "suggestion",
    text: "",
    contact: "",
    submitting: false,
  },

  onPickKind(e) {
    this.setData({ kind: e.currentTarget.dataset.id });
  },
  onText(e) {
    this.setData({ text: e.detail.value });
  },
  onContact(e) {
    this.setData({ contact: e.detail.value });
  },

  async onSubmit() {
    const text = this.data.text.trim();
    if (!text) {
      wx.showToast({ title: "请写下你的反馈", icon: "none" });
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    wx.showLoading({ title: "提交中", mask: true });
    const res = await api.call("feedback", {
      kind: this.data.kind,
      text,
      contact: this.data.contact.trim(),
    });
    wx.hideLoading();
    this.setData({ submitting: false });
    if (res.ok) {
      wx.showToast({ title: "已收到，谢谢反馈", icon: "success" });
      setTimeout(() => wx.navigateBack(), 600);
    } else if (res.err === "NEED_REGISTER") {
      wx.showModal({
        title: "先注册再反馈",
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
      wx.showModal({ title: "提交失败", content: res.msg || "请重试", showCancel: false });
    }
  },
});
