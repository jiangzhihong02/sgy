// components/member-sheet —— 成员资料浮层（ride 详情与聊天共用；后端 memberInfo/block/complaint/reinvite 的唯一前端入口）
// 页面用法：<member-sheet id="memberSheet" /> 然后 this.selectComponent("#memberSheet").open({ rideId, targetOpenid, name, meOpenid, isDone, mode })
const api = require("../../utils/api.js");
const { avatarChar } = require("../../utils/rideView.js");
const { frameCls } = require("../../utils/domain.js");

Component({
  options: {
    styleIsolation: "apply-shared", // 让 app.wxss/页面里 .btn/.tag/.avatar/.row 等全局类在组件内生效
  },
  data: {
    show: false,
    member: null, // { openid, name, genderText, credit, blocked, schoolVerified, isMe, avatarChar, frame }
    done: false, // isDone 镜像进 data，供 wxml 绑（已完成局才有 迟到/缺勤举报与再约）
  },

  methods: {
    /** 打开浮层：拉 memberInfo 后展示。isDone 决定 举报可选项/是否可再约（仅 ride 已完成局）。mode 保留用（chat 恒 isDone=false）。 */
    open(opts) {
      this._rideId = opts.rideId;
      this._me = opts.meOpenid || "";
      this._isDone = !!opts.isDone;
      this.setData({ done: this._isDone });
      this.loadMember(opts.targetOpenid, opts.name);
    },

    async loadMember(target, fallbackName) {
      wx.showLoading({ title: "", mask: true });
      const res = await api.call("memberInfo", { rideId: this._rideId, targetOpenid: target });
      wx.hideLoading();
      const m = res.ok ? res.data.member : null;
      const isMe = target === this._me;
      if (!m) {
        if (!isMe) {
          wx.showToast({ title: (res && res.msg) || "无法查看该成员", icon: "none" });
          return;
        }
        // 看自己：memberInfo 兜底失败时给最小资料
        this.setData({
          show: true,
          member: {
            openid: target,
            name: fallbackName || "我",
            genderText: "",
            credit: null,
            blocked: false,
            schoolVerified: false,
            isMe: true,
            avatarChar: avatarChar(fallbackName || "我"),
            frame: "",
          },
        });
        return;
      }
      this.setData({
        show: true,
        member: {
          openid: m.openid,
          name: m.name || fallbackName || "?",
          genderText: m.gender === "female" ? "女" : m.gender === "male" ? "男" : "未填",
          credit: m.credit,
          blocked: !!m.blocked,
          schoolVerified: !!m.schoolVerified,
          isMe,
          avatarChar: avatarChar(m.name || fallbackName),
          frame: frameCls(m.gender || ""),
        },
      });
    },

    close() {
      this.setData({ show: false });
    },

    async toggleBlock() {
      const mb = this.data.member;
      if (!mb || mb.isMe) return;
      const res = await api.call("block", {
        rideId: this._rideId,
        targetOpenid: mb.openid,
        block: !mb.blocked,
      });
      if (res.ok) {
        this.setData({ "member.blocked": res.data.blocked });
        wx.showToast({ title: res.data.blocked ? "已标记：不与其乘车" : "已取消标记", icon: "none" });
      } else {
        wx.showToast({ title: res.msg || "操作失败", icon: "none" });
      }
    },

    // 举报：进行中局只有"性别不实"；已完成局才有 迟到/缺勤
    onReport() {
      const mb = this.data.member;
      if (!mb || mb.isMe) return;
      const items = this._isDone ? ["性别填写与真实不符", "迟到", "缺勤 / 没来"] : ["性别填写与真实不符"];
      const kinds = this._isDone ? ["gender_fake", "lateness", "absence"] : ["gender_fake"];
      wx.showActionSheet({ itemList: items, success: (r) => this.submitReport(kinds[r.tapIndex]) });
    },

    async submitReport(kind) {
      const mb = this.data.member;
      const res = await api.call("complaint", { rideId: this._rideId, targetOpenid: mb.openid, kind });
      if (!res.ok) {
        wx.showModal({ title: "举报未提交", content: res.msg || "请重试", showCancel: false });
        return;
      }
      wx.showToast({ title: res.data && res.data.auto ? "已有多人联名，自动坐实并扣分" : "已提交，待复核", icon: "none" });
      this.close();
    },

    // 已完成局：下周同一时刻再约老队友（后端自动复用/新建进行中局并发邀请）
    async onReinvite() {
      const mb = this.data.member;
      if (!mb || mb.isMe || !this._isDone) return;
      wx.showLoading({ title: "", mask: true });
      const res = await api.call("reinvite", { rideId: this._rideId, targetOpenid: mb.openid });
      wx.hideLoading();
      if (!res.ok) {
        wx.showModal({ title: "再约失败", content: res.msg || "请重试", showCancel: false });
        return;
      }
      const createdText = res.data.created ? "已建下周同一时刻的新局；" : "用你现有进行中的局；";
      const invText = res.data.inviteSent ? "邀请已发出" : "邀请发送：" + (res.data.msg || "失败");
      wx.showToast({ title: createdText + invText, icon: "none" });
      this.close();
    },
  },
});
