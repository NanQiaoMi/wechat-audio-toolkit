Page({
  data: {
    version: '0.1.0'
  },

  openPrivacyContract() {
    if (wx.openPrivacyContract) {
      wx.openPrivacyContract({
        fail: () => wx.showToast({ title: '隐私指引尚未配置', icon: 'none' })
      });
    } else {
      wx.showToast({ title: '当前基础库不支持', icon: 'none' });
    }
  },

  showAgreement() {
    wx.showModal({
      title: '用户协议',
      content: '本工具仅提供音频格式转换服务。请确保你拥有所处理音频的合法权利，不得转换、传播侵权、违法或违反微信平台规则的内容。转换结果仅供个人使用，服务按现状提供。',
      showCancel: false
    });
  },

  showCopyright() {
    wx.showModal({
      title: '版权与侵权投诉',
      content: '如你认为本服务处理的内容侵犯你的合法权益，请通过小程序客服提交权利证明与具体链接，我们将在 24 小时内核实处理。',
      showCancel: false
    });
  },

  showAbout() {
    wx.showModal({
      title: '关于',
      content: '音乐格式转换器 v0.1.0\n音频格式本地/云端转换工具\n技术：微信云开发 + FFmpeg',
      showCancel: false
    });
  },

  clearHistory() {
    wx.showModal({
      title: '清空历史记录',
      content: '仅清空本机历史记录，不影响云端文件（云端文件 24 小时内自动清理）。',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('audio_convert_history');
          wx.showToast({ title: '已清空', icon: 'success' });
        }
      }
    });
  },

  clearCache() {
    wx.showModal({
      title: '清理缓存',
      content: '将清理本机临时缓存与历史记录，不影响云端文件。',
      success: (res) => {
        if (res.confirm) {
          try {
            wx.clearStorageSync();
            wx.showToast({ title: '已清理', icon: 'success' });
          } catch (e) {
            wx.showToast({ title: '清理失败', icon: 'none' });
          }
        }
      }
    });
  }
});
