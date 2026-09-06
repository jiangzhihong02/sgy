// sgy/utils/api.js —— 云函数调用统一封装
// 云函数统一返回 { ok, data?, err?, msg? }，见 cloudfunctions/SPEC.md §0。
function call(name, data = {}) {
  return wx.cloud
    .callFunction({ name, data })
    .then((res) => res.result || { ok: false, err: "EMPTY", msg: "云函数无返回" })
    .catch((e) => ({ ok: false, err: e.errCode || "NET", msg: e.errMsg || "网络错误" }));
}

module.exports = { call };
