// sgy/utils/confirm.js —— 微信"确认再动作"弹窗样板收敛（全 app 同形 showModal 统一）
// 用法：confirm({ title, content, onOk: () => ... })；默认按钮 确定/取消。
function confirm({ title, content, confirmText = "确定", cancelText = "取消", onOk }) {
  wx.showModal({
    title,
    content,
    confirmText,
    cancelText,
    success: (r) => {
      if (r.confirm && onOk) onOk();
    },
  });
}

module.exports = { confirm };
