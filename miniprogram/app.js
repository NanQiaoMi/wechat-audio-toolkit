// app.js
App({
  onLaunch: function () {
    this.globalData = {
      // env 参数说明：
      // env 参数决定接下来小程序发起的云开发调用（wx.cloud.xxx）会请求到哪个云环境的资源
      // 此处请填入环境 ID, 环境 ID 可在微信开发者工具顶部工具栏点击「云开发」按钮获取
      // 若此处留空，微信底层将自动选择当前开通的默认云环境
      env: "cloud1-d0g1pwjogd2f39be2",
    };
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      wx.cloud.init({
        env: this.globalData.env || undefined,
        traceUser: true,
      });
    }
  },
});
