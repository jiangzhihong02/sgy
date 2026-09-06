// app.js
App({
  onLaunch() {
    this.globalData = {
      // TODO(接入云开发时必填)：环境 ID。
      // 在微信开发者工具右上角「云开发」控制台创建环境后，把环境 ID 填到这里；
      // 留空时 wx.cloud 请求会失败（骨架阶段不依赖云，可先预览 UI）。
      env: "cloud1-d1gx6bw91f395901c",
    };
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      wx.cloud.init({
        env: this.globalData.env,
        traceUser: true,
      });
    }
  },
});
