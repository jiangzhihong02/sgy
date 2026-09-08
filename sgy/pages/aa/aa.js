// pages/aa/aa.js —— 如何 AA（线下付款）教程
// 三种方式 + 图位占位。作者配图时：把图放到 sgy/images/aa/ 下，并把对应 img* 从 "" 改成路径即可。
Page({
  data: {
    // 图位：作者配图后填路径（如 "/images/aa/face-redpacket.png"）；留空显示占位框
    imgFace: "", // 方法一备选 · 微信面对面红包教程
    imgCode: "", // 方法二 · 聊天室发收款码示例
    imgGroup: "", // 方法三 · 微信群收群收款示例
  },
});
