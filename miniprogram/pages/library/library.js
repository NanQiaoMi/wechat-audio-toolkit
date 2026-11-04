// miniprogram/pages/library/library.js
// v5.1 FR-31「我的作品」作品库页（docs/NEXT_UPDATE_PLAN.md §5.2）
// 职责：展示 / 筛选 / 分享 / 复制外链 / 删除 / 清空，数据全部走 utils/library-store.js。
const libraryStore = require('../../utils/library-store.js');

const FILTER_TABS = [
  { key: 'all', label: '全部' },
  { key: 'convert', label: '格式转换' },
  { key: 'edit', label: '音乐剪辑' },
  { key: 'record', label: '现场录音' },
  { key: 'extract', label: '视频提取' },
];

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatCreatedAt(ts) {
  const n = Number(ts);
  if (!isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** 兼容 loadAndMigrate 返回库对象 { items } 的契约，同时容忍直接返回数组。 */
function readLibraryItems() {
  let lib = null;
  try {
    lib = libraryStore.loadAndMigrate();
  } catch (e) {
    console.warn('[library] 读取作品库失败', e);
    return [];
  }
  if (Array.isArray(lib)) return lib;
  return lib && Array.isArray(lib.items) ? lib.items : [];
}

Page({
  data: {
    items: [],
    filtered: [],
    filter: 'all',
    filterTabs: FILTER_TABS.map((t) => ({ key: t.key, label: t.label, count: 0 })),
    statsText: '',
    hasItems: false,
    empty: true,
    filterEmpty: false,
  },

  onLoad() {
    // 分享文件缓存：fileID -> 本地临时路径（两段式分享，保证第二次点击在手势内同步转发）
    this.tempPathCache = Object.create(null);
    this.downloading = Object.create(null);
    this._unloaded = false;
    try {
      if (wx.showShareMenu) {
        wx.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage'] });
      }
    } catch (e) {}
  },

  onShow() {
    this.loadData();
  },

  onUnload() {
    // 标记已卸载：进行中的下载回调不再弹 toast / modal
    this._unloaded = true;
    this.tempPathCache = Object.create(null);
    this.downloading = Object.create(null);
  },

  /* ---------------------------------------------------------------------- */
  /* 数据加载与筛选                                                          */
  /* ---------------------------------------------------------------------- */

  loadData() {
    const items = readLibraryItems();
    this.setData({ items }, () => this.refresh());
  },

  refresh() {
    const items = Array.isArray(this.data.items) ? this.data.items : [];
    const filter = this.data.filter || 'all';
    const now = Date.now();
    const summary = libraryStore.stats(items, now);

    const filterTabs = FILTER_TABS.map((tab) => ({
      key: tab.key,
      label: tab.label,
      count: tab.key === 'all' ? summary.total : (summary[tab.key] || 0),
    }));

    const filtered = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      if (filter !== 'all' && item.kind !== filter) continue;
      filtered.push(this.decorateItem(item, now));
    }

    let statsText = '转换、剪辑、录音与提取作品会自动汇总在这里';
    if (summary.total > 0) {
      statsText = '共 ' + summary.total + ' 个作品 · 云端保留 24h';
      if (summary.expired > 0) statsText += ' · ' + summary.expired + ' 个已过期';
    }

    this.setData({
      filtered,
      filterTabs,
      statsText,
      hasItems: summary.total > 0,
      empty: summary.total === 0,
      filterEmpty: summary.total > 0 && filtered.length === 0,
    });
  },

  /** item → 视图模型（过期态 / 徽标 / 展示时间 / 可复制外链） */
  decorateItem(item, now) {
    const expired = libraryStore.isExpired(item, now);
    let extraLabel = '';
    const extra = item.extra || {};
    if (item.kind === 'edit') {
      if (extra.clipCount) extraLabel = extra.clipCount + ' 个片段';
      else if (extra.targetFormat) extraLabel = '目标 ' + extra.targetFormat;
    } else if (item.kind === 'record') {
      extraLabel = '高清录音';
    } else if (item.kind === 'extract') {
      extraLabel = '视频提取';
    } else if (extra.targetFormat) {
      extraLabel = '目标 ' + extra.targetFormat;
    }

    let kindLabel = '格式转换';
    let kindClass = 'kind-convert';
    if (item.kind === 'edit') {
      kindLabel = '音乐剪辑';
      kindClass = 'kind-edit';
    } else if (item.kind === 'record') {
      kindLabel = '现场录音';
      kindClass = 'kind-record';
    } else if (item.kind === 'extract') {
      kindLabel = '视频提取';
      kindClass = 'kind-extract';
    }

    return Object.assign({}, item, {
      kindLabel,
      kindClass,
      formatLabel: String(item.format || '').toUpperCase(),
      extraLabel,
      createdText: formatCreatedAt(item.createdAt),
      expired,
      canCopyLink: !!item.downloadUrl && !expired,
    });
  },

  setFilter(e) {
    const key = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.key : '';
    if (!key || key === this.data.filter) return;
    this.setData({ filter: key }, () => this.refresh());
  },

  findItem(e) {
    const id = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.id : '';
    if (!id) return null;
    const items = Array.isArray(this.data.items) ? this.data.items : [];
    for (let i = 0; i < items.length; i++) {
      if (items[i] && String(items[i].id) === String(id)) return items[i];
    }
    return null;
  },

  /* ---------------------------------------------------------------------- */
  /* 分享（两段式：首次准备 + toast，再次 shareFileMessage）                 */
  /* ---------------------------------------------------------------------- */

  shareItem(e) {
    const item = this.findItem(e);
    if (!item) return;

    // 兜底：极端情况下（如 onLoad 未执行/页面复用时）保证缓存表可用
    if (!this.tempPathCache) this.tempPathCache = Object.create(null);
    if (!this.downloading) this.downloading = Object.create(null);

    // 本地临时文件（如现场录音）可直接快速调起分享
    if (item.tempFilePath) {
      this.shareLocalFile(item.tempFilePath, this.shareFileName(item));
      return;
    }

    if (libraryStore.isExpired(item)) {
      this.showExpiredModal();
      return;
    }
    if (!item.fileID) {
      wx.showToast({ title: '该作品缺少云端文件信息', icon: 'none' });
      return;
    }

    const cached = this.tempPathCache[item.fileID];
    if (cached) {
      // 第二次点击：手势内同步调用 shareFileMessage
      this.shareLocalFile(cached, this.shareFileName(item));
      return;
    }

    if (this.downloading[item.fileID]) {
      wx.showToast({ title: '文件准备中，请 1 秒后再点一次', icon: 'none' });
      return;
    }

    if (!wx.cloud || typeof wx.cloud.downloadFile !== 'function') {
      wx.showModal({
        title: '当前环境不支持转发',
        content: '请在手机微信中使用，或复制下载链接到电脑下载。',
        showCancel: false,
      });
      return;
    }

    this.downloading[item.fileID] = true;
    wx.showToast({ title: '文件准备中，请 1 秒后再点一次', icon: 'none' });
    wx.cloud
      .downloadFile({ fileID: item.fileID })
      .then((res) => {
        delete this.downloading[item.fileID];
        if (this._unloaded) return;
        if (res && res.tempFilePath) {
          this.tempPathCache[item.fileID] = res.tempFilePath;
          wx.showToast({ title: '文件已准备，请再次点击分享', icon: 'none' });
        } else {
          this.showShareFailModal();
        }
      })
      .catch(() => {
        if (this.downloading) delete this.downloading[item.fileID];
        if (this._unloaded) return;
        this.showShareFailModal();
      });
  },

  /** 文件名兜底补扩展名（历史数据可能只有裸文件名） */
  shareFileName(item) {
    const name = String((item && item.name) || '').trim();
    const ext = String((item && item.format) || 'mp3').replace(/^\./, '') || 'mp3';
    if (!name) return '音频_' + Date.now() + '.' + ext;
    if (/\.[A-Za-z0-9]{2,8}$/.test(name)) return name;
    return name + '.' + ext;
  },

  shareLocalFile(filePath, fileName) {
    if (typeof wx.shareFileMessage !== 'function') {
      wx.showModal({
        title: '当前环境不支持转发',
        content: '请在手机微信中使用，或复制下载链接到电脑下载。',
        showCancel: false,
      });
      return;
    }
    wx.shareFileMessage({
      filePath,
      fileName,
      success: () => wx.showToast({ title: '已发送，请在聊天中保存', icon: 'none' }),
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        if (msg.indexOf('cancel') >= 0 || msg.indexOf('Cancel') >= 0) return;
        wx.showModal({
          title: '转发失败',
          content: (msg || '微信未允许本次转发') + '\n可复制下载链接到电脑下载。',
          showCancel: false,
        });
      },
    });
  },

  showExpiredModal() {
    wx.showModal({
      title: '文件已过期',
      content: '云端文件仅保留 24 小时，该记录已过期。\n请重新处理后再分享。',
      showCancel: false,
    });
  },

  showShareFailModal() {
    wx.showModal({
      title: '文件准备失败',
      content: '云端文件仅保留 24 小时，可能已被清理；也可能是网络异常。\n请稍后重试，或重新处理后再分享。',
      showCancel: false,
    });
  },

  /* ---------------------------------------------------------------------- */
  /* 复制外链 / 删除 / 清空                                                  */
  /* ---------------------------------------------------------------------- */

  copyLink(e) {
    const item = this.findItem(e);
    if (!item) return;
    if (libraryStore.isExpired(item)) {
      this.showExpiredModal();
      return;
    }
    if (!item.downloadUrl) {
      wx.showToast({ title: '该记录没有可复制的外链', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: item.downloadUrl,
      success: () => wx.showToast({ title: '链接已复制到剪贴板', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
    });
  },

  deleteItem(e) {
    const item = this.findItem(e);
    if (!item) return;
    wx.showModal({
      title: '删除这条记录？',
      content: '「' + item.name + '」将从本地作品库移除，云端文件不受影响。',
      confirmText: '删除',
      confirmColor: '#DC2626',
      success: (res) => {
        if (!res.confirm) return;
        let items = [];
        try {
          items = libraryStore.removeFromLibrary(item.id) || [];
        } catch (err) {
          console.warn('[library] 删除失败', err);
          items = [];
        }
        this.setData({ items }, () => this.refresh());
        wx.showToast({ title: '已删除', icon: 'success' });
      },
    });
  },

  clearAll() {
    if (!this.data.hasItems) return;
    const count = (this.data.items || []).length;
    wx.showModal({
      title: '清空作品库？',
      content: '将删除全部本地作品记录（共 ' + count + ' 条），云端文件不受影响，删除后无法恢复。',
      confirmText: '清空',
      confirmColor: '#DC2626',
      success: (res) => {
        if (!res.confirm) return;
        try {
          libraryStore.clearLibrary();
        } catch (err) {
          console.warn('[library] 清空失败', err);
        }
        this.tempPathCache = Object.create(null);
        this.downloading = Object.create(null);
        this.setData({ items: [] }, () => this.refresh());
        wx.showToast({ title: '已清空', icon: 'none' });
      },
    });
  },

  /* ---------------------------------------------------------------------- */
  /* 导航：空态三入口 / 点击卡片继续处理                                     */
  /* ---------------------------------------------------------------------- */

  goIndex() {
    const stack = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    for (let i = stack.length - 2; i >= 0; i--) {
      if (stack[i] && stack[i].route === 'pages/index/index') {
        wx.navigateBack({ delta: stack.length - 1 - i });
        return;
      }
    }
    wx.navigateTo({
      url: '/pages/index/index',
      fail: () => {
        try {
          wx.reLaunch({ url: '/pages/index/index' });
        } catch (e) {
          wx.showToast({ title: '无法打开首页', icon: 'none' });
        }
      },
    });
  },

  goEditor() {
    wx.navigateTo({
      url: '/pages/editor/editor',
      fail: () => wx.showToast({ title: '剪辑页打开失败', icon: 'none' }),
    });
  },

  goRecord() {
    wx.navigateTo({
      url: '/pages/record/record',
      fail: () => wx.showToast({ title: '录音页打开失败', icon: 'none' }),
    });
  },

  goVideoExtract() {
    wx.navigateTo({
      url: '/pages/video-extract/video-extract',
      fail: () => wx.showToast({ title: '视频提取页打开失败', icon: 'none' }),
    });
  },

  /** 点击卡片：回到对应工具继续处理（本轮不做跨页回填） */
  onItemTap(e) {
    const item = this.findItem(e);
    if (!item) return;
    if (item.kind === 'edit') {
      wx.showToast({ title: '打开剪辑工坊', icon: 'none' });
      this.goEditor();
      return;
    }
    if (item.kind === 'record') {
      wx.showToast({ title: '打开现场录音', icon: 'none' });
      this.goRecord();
      return;
    }
    if (item.kind === 'extract') {
      wx.showToast({ title: '打开视频提取', icon: 'none' });
      this.goVideoExtract();
      return;
    }
    this.goIndex();
  },

  /* ---------------------------------------------------------------------- */
  /* 分享卡片：只开放好友/群（不开放朋友圈），落地首页避免暴露用户作品        */
  /* ---------------------------------------------------------------------- */

  onShareAppMessage() {
    return {
      title: '音频工具箱 · 我的音频作品',
      path: '/pages/index/index',
    };
  },
});
