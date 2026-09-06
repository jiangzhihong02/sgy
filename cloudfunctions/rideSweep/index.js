// cloudfunctions/rideSweep —— 定时触发壳（每分钟）
// 状态机/结算逻辑统一在 cloudfunctions/rides 的 __sweep（rules.js 单一来源），
// 这里只负责"到点叫一次 rides"，避免两份规则常量复制后各自漂移。
// 部署顺序：先部署 rides（含 __sweep），再部署本函数。
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async () => {
  const res = await cloud.callFunction({ name: "rides", data: { action: "__sweep" } });
  return res.result || { ok: false, err: "EMPTY", msg: "rides 无返回" };
};
