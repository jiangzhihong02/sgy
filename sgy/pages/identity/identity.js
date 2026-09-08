// pages/identity/identity.js —— 校内身份登记（自报；仅注册用户，见 CONTEXT 校内身份 / ADR-0013）
const api = require("../../utils/api.js");
const RE_STUDENT_ID = /^s\d{7}$/i;

Page({
  data: {
    school: "香港教育大学",
    studentId: "",
    name: "",
    major: "",
    declared: false,
    submitting: false,
  },

  onLoad() {
    api.call("me").then((r) => {
      if (!r.ok) return;
      const s = r.data.user.schoolId;
      if (s) {
        this.setData({
          declared: true,
          studentId: s.studentId || "",
          name: s.name || "",
          major: s.major || "",
        });
      }
    });
  },

  onStudentId(e) {
    this.setData({ studentId: e.detail.value });
  },
  onName(e) {
    this.setData({ name: e.detail.value });
  },
  onMajor(e) {
    this.setData({ major: e.detail.value });
  },

  async onSubmit() {
    const studentId = this.data.studentId.trim().toLowerCase();
    const name = this.data.name.trim();
    if (!RE_STUDENT_ID.test(studentId)) {
      wx.showToast({ title: "学号格式：小写 s + 7 位数字", icon: "none" });
      return;
    }
    if (!name) {
      wx.showToast({ title: "请填写真实姓名", icon: "none" });
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    wx.showLoading({ title: "保存中", mask: true });
    const res = await api.call("identitySave", {
      studentId,
      name,
      major: this.data.major.trim(),
    });
    wx.hideLoading();
    this.setData({ submitting: false });
    if (res.ok) {
      wx.showToast({ title: "已登记校内身份", icon: "success" });
      setTimeout(() => wx.navigateBack(), 600);
    } else if (res.err === "NEED_REGISTER") {
      wx.showModal({
        title: "先注册再登记",
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
      wx.showModal({ title: "保存失败", content: res.msg || "请重试", showCancel: false });
    }
  },
});
