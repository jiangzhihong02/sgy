// sgy/utils/api.js —— 云函数调用统一封装
// 统一调 rides 云函数（原 user 已并入，见 ADR-0012）：name 固定为 "rides"，action 由本封装补齐。
// 云函数统一返回 { ok, data?, err?, msg? }，见 cloudfunctions/SPEC.md §0。
function call(action, data = {}) {
  return wx.cloud
    .callFunction({ name: "rides", data: { action, ...data } })
    .then((res) => res.result || { ok: false, err: "EMPTY", msg: "云函数无返回" })
    .catch((e) => ({ ok: false, err: e.errCode || "NET", msg: e.errMsg || "网络错误" }));
}

module.exports = { call };
