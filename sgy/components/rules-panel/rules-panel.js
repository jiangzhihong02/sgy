// components/rules-panel —— 规则半屏面板（信用分表格 / 隐私与实名分节）
// 页面用法：<rules-panel id="rulesPanel" /> 然后 this.selectComponent("#rulesPanel").open("credit"|"privacy")
// 内容单一来源：rides 云函数 rules.js rulePayload()（getRules 下发），本地 rulesText 快照兜底。
const rulesText = require("../../utils/rulesText.js");

Component({
  options: {
    styleIsolation: "apply-shared", // 让 app.wxss 全局类在组件内可用（本面板以自有 rp-* 类为主）
  },
  data: {
    show: false,
    mode: "credit", // credit(信用分表格) | privacy(隐私与实名分节)
    title: "",
    creditRows: [], // { event, note, delta, up }
    creditFooter: "",
    privacySections: [], // { title, lines[] }
  },

  methods: {
    open(mode) {
      const isPrivacy = mode === "privacy";
      this.setData({
        show: true,
        mode: isPrivacy ? "privacy" : "credit",
        title: isPrivacy ? "性别与隐私" : "信用分规则",
        creditRows: rulesText.creditTable(),
        creditFooter: rulesText.creditFooter(),
        privacySections: rulesText.privacySections(),
      });
    },
    close() {
      this.setData({ show: false });
    },
  },
});
