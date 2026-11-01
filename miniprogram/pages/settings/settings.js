// miniprogram/pages/settings/settings.js
const libraryStore = require('../../utils/library-store.js');

const FEEDBACK_EMAIL = 'feedback@example.com';

Page({
  data: {
    version: '5.1.0',
    feedbackEmail: FEEDBACK_EMAIL
  },

  onLoad() {
    if (wx.showShareMenu) {
      try { wx.showShareMenu({ menus: ['shareAppMessage'] }); } catch (e) {}
    }
  },

  onShareAppMessage() {
    return {
      title: '音频工具箱 · 格式转换 / 剪辑 / 录音，一站搞定',
      path: '/pages/index/index'
    };
  },

  goIndex() {
    wx.reLaunch({ url: '/pages/index/index' });
  },

  goRecord() {
    wx.navigateTo({ url: '/pages/record/record?from=settings' });
  },

  goLibrary() {
    wx.navigateTo({ url: '/pages/library/library' });
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
      content: '本工具仅提供音频格式转换、剪辑与录音处理服务。请确保你拥有所处理音频的合法权利，不得转换、传播侵权、违法或违反微信平台规则的内容。处理结果仅供个人使用，服务按现状提供。',
      showCancel: false
    });
  },

  showCopyright() {
    wx.showModal({
      title: '版权与侵权投诉',
      content: '如你认为本服务处理的内容侵犯你的合法权益，请通过小程序客服或反馈邮箱提交权利证明与具体链接，我们将在 24 小时内核实处理。',
      showCancel: false
    });
  },

  showFeedback() {
    wx.showModal({
      title: '意见反馈',
      content: '如遇问题或有功能建议，欢迎发送邮件至 ' + FEEDBACK_EMAIL + '，我们会在 1～2 个工作日内处理。',
      confirmText: '复制邮箱',
      cancelText: '关闭',
      success: (res) => {
        if (res.confirm) {
          wx.setClipboardData({
            data: FEEDBACK_EMAIL,
            success: () => wx.showToast({ title: '邮箱已复制', icon: 'success' })
          });
        }
      }
    });
  },

  showAbout() {
    wx.showModal({
      title: '关于',
      content: '音频工具箱 v' + this.data.version + '\n格式转换 · 多轨剪辑 · 现场录音\n技术：微信云开发 + FFmpeg 7.0.2\n录音/剪辑上限 10 分钟，单文件 ≤ 50MB\n所有音频仅用于本次处理，云端 24 小时内自动清理。',
      showCancel: false
    });
  },

  clearHistory() {
    wx.showModal({
      title: '清空我的作品',
      content: '将清空本机作品库与旧转换历史，不影响云端文件（云端文件 24 小时内自动清理）。',
      success: (res) => {
        if (!res.confirm) return;
        try {
          libraryStore.clearLibrary();
          wx.removeStorageSync('audio_convert_history');
        } catch (e) {}
        wx.showToast({ title: '已清空', icon: 'success' });
      }
    });
  },

  clearCache() {
    wx.showModal({
      title: '清理缓存',
      content: '将清理本机临时缓存、作品库与历史记录（保留未导出的剪辑草稿），不影响云端文件。',
      success: (res) => {
        if (!res.confirm) return;
        try {
          // 保留未导出的剪辑草稿，避免误删用户工程
          const DRAFT_KEY = 'NLE_DRAFT_CACHE_V1';
          let draft = null;
          try { draft = wx.getStorageSync(DRAFT_KEY); } catch (e) {}
          wx.clearStorageSync();
          if (draft) {
            try { wx.setStorageSync(DRAFT_KEY, draft); } catch (e) {}
          }
          wx.showToast({ title: '已清理', icon: 'success' });
        } catch (e) {
          wx.showToast({ title: '清理失败', icon: 'none' });
        }
      }
    });
  }
});
