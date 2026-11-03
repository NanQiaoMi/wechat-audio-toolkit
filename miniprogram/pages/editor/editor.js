// miniprogram/pages/editor/editor.js
// 音乐剪辑 v2：多源音频导入 → 云函数分析出波形 → 片段时间线（拼接/分割/裁剪/ripple 删除）
// + 每片段淡入淡出 + 全局音量 → 云端 FFmpeg 渲染 MP3 → 试听/转发。
// 契约：docs/EDITOR_IMPL_CONTRACT.md §6.1/§6.2/§6.3（多源 sources + clips + 每片 fade）。

const editorUtils = require('../../utils/editor-utils.js');
const monoIcons = require('../../utils/mono-icons.js');
const libraryStore = require('../../utils/library-store.js');
const haptics = require('../../utils/haptics.js');

// 状态机：empty → uploading / analyzing → editing → exporting → result
const STATUS = {
  EMPTY: 'empty',
  UPLOADING: 'uploading',
  ANALYZING: 'analyzing',
  EDITING: 'editing',
  EXPORTING: 'exporting',
  RESULT: 'result',
};

// 波形画布与手势常量（逻辑 px；drawWave 与命中测试共用）
const WAVE_PAD_X = 8;
const WAVE_PAD_Y = 14;
const WAVE_RULER_H = 18;
const HANDLE_HIT_PX = 28;
const TAP_MOVE_PX = 6;
const MIN_SELECTION = editorUtils.MIN_SELECTION_DURATION;
const MAX_PLAN_DURATION = editorUtils.MAX_PLAN_DURATION;
const MAX_FILE_BYTES = editorUtils.MAX_FILE_BYTES;
const MAX_SOURCES = editorUtils.MAX_SOURCES;
const MAX_CLIPS = editorUtils.MAX_CLIPS;
const UNDO_LIMIT = 30;
const DRAFT_STORAGE_KEY = 'NLE_DRAFT_CACHE_V1';

// 成片压缩比特率与品质规格定义
const BITRATE_OPTIONS = [
  { value: '64k', label: '64k', kbps: 64, shortDesc: '极小体积', quality: '极小体积 · 极致省流', shortGrade: '极小体积', hint: '体积缩减到极致，适合微信网络极速秒传与语音播客' },
  { value: '96k', label: '96k', kbps: 96, shortDesc: '精简省流', quality: '精简省流 · 语言清晰', shortGrade: '精简省流', hint: '体积小巧，兼顾人声清晰度与低码率消耗' },
  { value: '128k', label: '128k', kbps: 128, shortDesc: '网络均衡', quality: '网络均衡 · 推荐省流', shortGrade: '网络均衡', hint: '标准网络流媒体规格，音质与体积适中' },
  { value: '192k', label: '192k', kbps: 192, shortDesc: '标准推荐', quality: '标准高保真 · 官方推荐', shortGrade: '高保真', hint: 'CD 级听感与体积黄金平衡点，适合绝大多数音乐与社交分享' },
  { value: '256k', label: '256k', kbps: 256, shortDesc: '超清发烧', quality: '超清母带 · 音乐级', shortGrade: '超清音质', hint: '发烧级丰富音频细节，高动态保真呈现' },
  { value: '320k', label: '320k', kbps: 320, shortDesc: '最高无损', quality: '最高品质 · MP3上限', shortGrade: '最高无损', hint: 'MP3 格式所允许的理论最高编码比特率' },
];

Page({
  data: {
    status: STATUS.EMPTY,

    // 导入进度
    stageText: '',
    importProgressText: '',
    importFileName: '',
    loadError: '',
    failStage: '',

    // 音频源 / 片段时间线
    sources: [],
    sourceCount: 0,
    clips: [],
    clipCount: 0,
    selectedClipIndex: 0,
    selectedClip: null,
    selectedSource: null,
    planDuration: 0,
    planDurationText: '00:00',
    totalDurationText: '00:00',
    currentTimeText: '00:00.0',

    // 选区（选中片段所属源的源时间轴）
    hasSelection: false,
    selection: null,
    canUndo: false,

    // 预览
    isPlaying: false,
    playMode: '',
    canPreviewAll: true,
    canPreviewClip: true,
    previewBanner: '',

    // 每片段淡入淡出 + 全局音量
    fadeOptions: editorUtils.FADE_OPTIONS,
    fadeIn: 0,
    fadeOut: 0,
    fadeAdjusted: false,
    effectiveFadeInText: '',
    effectiveFadeOutText: '',
    volumeDb: 0,
    volumeText: '0 dB',

    // 导出与压缩控制
    exportDisabled: false,
    exportTip: '',
    exporting: false,
    exportElapsed: 0,
    exportComplexityHeavy: false,
    bitrateOptionsList: BITRATE_OPTIONS,
    exportBitrate: '192k',
    exportBitrateIndex: 3,
    estimatedFileSizeText: '约 0 MB',
    compressionRatioText: '86',
    qualityGradeText: '标准高保真 · 官方推荐',
    qualityGradeShort: '高保真',
    qualityHintText: 'CD 级听感与体积黄金平衡点，适合绝大多数音乐与社交分享',
    showCompressionPanel: false,

    // 剪贴板 (复制与粘贴)
    hasClipboard: false,
    clipboardName: '',

    // 双指手势缩放反馈
    isPinchingTimeline: false,
    pinchTipText: '',
    userBrowsingWhilePlaying: false, // 播放时用户主动滑阅后续内容状态标记

    // 通用多音轨与声音工具（默认初始化 4 轨，最多支持 8 轨专业混音）
    tracks: [
      { id: 'T1', name: '音轨 1', color: '#3B82F6', tag: '1', mute: false, solo: false, volumeDb: 0 },
      { id: 'T2', name: '音轨 2', color: '#10B981', tag: '2', mute: false, solo: false, volumeDb: 0 },
      { id: 'T3', name: '音轨 3', color: '#F59E0B', tag: '3', mute: false, solo: false, volumeDb: 0 },
      { id: 'T4', name: '音轨 4', color: '#8B5CF6', tag: '4', mute: false, solo: false, volumeDb: 0 },
    ],
    trackViews: [],
    activeTool: 'select', // 'select' (V) | 'razor' (C)
    snapEnabled: true,
    zoomLevel: 1.0,
    zoomPercentText: '100%',
    timelineScrollLeft: 0,
    inspectorTab: 'effects', // 'effects' (声音处理) | 'fade' (淡变) | 'track' (音轨)
    isInspectorExpanded: false, // 底部面板是否展开详细调音
    showInspectorDrawer: false, // 声音效果器抽屉开关
    timelineData: null, // 全轨统一时间线数据模型

    // 选中片段的声音属性
    selectedClipTrackId: 'T1',
    selectedClipSpeed: 1.0,
    selectedClipEq: 'flat',
    selectedClipDenoise: 0,
    selectedClipGainDb: 0,
    selectedClipGainText: '0 dB',
    speedOptions: editorUtils.SPEED_OPTIONS,
    eqPresets: editorUtils.EQ_PRESETS,
    gainPresets: editorUtils.GAIN_PRESETS,
    denoiseOptions: editorUtils.DENOISE_OPTIONS,
    zoomLevels: editorUtils.ZOOM_LEVELS,
    zoomLevelRatioText: '100%',
    isDraggingClip: false,
    dragClipIndex: null,
    dragClipLeftRpx: 0,
    dragTipText: '',
    isTrimmingClip: false,
    trimType: '',
    trimLeftRpx: 0,
    trimWidthRpx: 0,
    trimTipText: '',
    monoIcons: monoIcons,

    // 导入失败提示
    importFailures: [],
    importFailureNames: '',
    importFailureDetail: '',

    // 结果
    result: null,
    resultPlaying: false,
    resultCurrentTime: 0,
    resultDuration: 0,
    resultCurrentText: '00:00',
    resultDurationText: '00:00',
    resultTempReady: false,
    resultPlayError: false,

    // 波形画布异常降级
    waveUnavailable: false,

    // 隐私授权
    showPrivacy: false,
  },

  /* ====================================================================== */
  /* 生命周期                                                                */
  /* ====================================================================== */

  onLoad() {
    try {
      const sys = wx.getSystemInfoSync();
      this.windowWidth = sys.windowWidth || 375;
    } catch (e) {
      this.windowWidth = 375;
    }
    this.tracks = [
      { id: 'T1', name: '音轨 1', color: '#3B82F6', tag: '1', mute: false, solo: false, volumeDb: 0 },
      { id: 'T2', name: '音轨 2', color: '#10B981', tag: '2', mute: false, solo: false, volumeDb: 0 },
      { id: 'T3', name: '音轨 3', color: '#F59E0B', tag: '3', mute: false, solo: false, volumeDb: 0 },
      { id: 'T4', name: '音轨 4', color: '#8B5CF6', tag: '4', mute: false, solo: false, volumeDb: 0 },
    ];
    this._targetTrackId = 'T1';
    this.sources = [];
    this.clips = [];
    this.selectedClipIndex = 0;
    this.undoStack = [];
    this.currentSourceTime = 0;
    this.wavePeaks = null;
    this.rmsPeaks = null;
    this.waveBucketMs = 50;
    this.waveDuration = 0;
    this.playback = null;
    this.playTimer = null;
    this.paused = false;
    this.previewSrcId = '';
    this.exporting = false;
    this.exportTimer = null;
    this.exportStartedAt = 0;
    this.resultTempFilePath = '';
    this.resultFallbackTried = false;
    this._preparingFileID = '';
    this.gesture = null;
    this.waveCtx = null;
    this.waveCanvas = null;
    this.canvasW = 0;
    this.canvasH = 0;
    this.canvasLeft = 0;
    this.canvasRetry = 0;
    this.sourceCanplay = false;
    this.previewFailed = false;
    this._lastTimeTextAt = 0;
    this._lastSelDataAt = 0;
    this.importing = false;
    this.choosingFile = false;
    this.failedItems = [];
    this.preRejects = [];
    this._sourceSeq = 0;
    this._clipSeq = 0;
    this._userIsBrowsingTimeline = false;
    this._userIsTouchingTimeline = false;
    this._programmaticScroll = false;

    this.initAudioContexts();
    this.initPrivacyAuthorization();
    if (wx.setInnerAudioOption) {
      try {
        wx.setInnerAudioOption({ obeyMuteSwitch: false, mixWithOther: true });
      } catch (e) {}
    }

    // 监听系统音频中断（如来电呼入/微信语音/前后台切换）
    this._onAudioInterruptionBegin = () => this.handleAudioInterruptionBegin();
    this._onAudioInterruptionEnd = () => this.handleAudioInterruptionEnd();
    if (wx.onAudioInterruptionBegin) wx.onAudioInterruptionBegin(this._onAudioInterruptionBegin);
    if (wx.onAudioInterruptionEnd) wx.onAudioInterruptionEnd(this._onAudioInterruptionEnd);

    this._onWindowResize = () => {
      if (this.data.status === STATUS.EDITING) this.initWaveCanvas();
    };
    if (wx.onWindowResize) wx.onWindowResize(this._onWindowResize);

    if (wx.showShareMenu) {
      try { wx.showShareMenu({ menus: ['shareAppMessage'] }); } catch (e) {}
    }

    // 从「现场录音」页跳转而来：优先消费录音临时文件（避免再弹草稿恢复）
    if (this.consumePendingAudio()) return;

    // 检查并提示恢复未完成的草稿工程
    this.checkAndPromptRestoreDraft();
  },

  /** 消费「现场录音」或「视频提取」页传入的一次性音频；命中并开始导入时返回 true */
  consumePendingAudio() {
    let appInstance = null;
    try { appInstance = getApp(); } catch (e) {}
    const pending = appInstance && appInstance.globalData && appInstance.globalData.pendingAudio;
    if (!pending || !pending.path) return false;
    appInstance.globalData.pendingAudio = null;
    const isVideo = pending.from === 'video-extract';
    const name = pending.name || (isVideo ? '视频提取原声.m4a' : '现场录音.mp3');
    const extMatch = String(name).match(/\.([a-zA-Z0-9]+)$/);
    const ext = (pending.extLower || (extMatch ? extMatch[1] : 'mp3')).toLowerCase();
    const file = { path: pending.path, name: name, size: Number(pending.size) || 0 };
    const check = editorUtils.validateLocalFile(file, { maxBytes: MAX_FILE_BYTES });
    if (!check.ok) {
      wx.showModal({
        title: isVideo ? '视频音频无法导入' : '录音无法导入',
        content: check.message || (isVideo ? '视频音轨格式异常。' : '录音文件异常，请重新录制。'),
        showCancel: false,
      });
      return false;
    }
    const toastTitle = isVideo ? '视频原声已就绪，正在导入…' : '录音已就绪，正在分析…';
    wx.showToast({ title: toastTitle, icon: 'none' });
    this.nextTick(() => this.importFiles([{ file: file, ext: check.ext }]));
    return true;
  },

  goVideoExtract() {
    wx.navigateTo({ url: '/pages/video-extract/video-extract?from=editor' });
  },

  goRecord() {
    wx.navigateTo({ url: '/pages/record/record?from=editor' });
  },

  onShareAppMessage() {
    return {
      title: '在线多轨剪辑 · 手机上也能精细剪音频',
      path: '/pages/editor/editor',
    };
  },

  onReady() {
    if (this.data.status === STATUS.EDITING) this.initWaveCanvas();
  },

  onShow() {
    // 契约：onHide 时 stop + destroy，回到页面时按当前状态重建播放实例
    if (!this.sourceAudio || !this.resultAudio) this.initAudioContexts();
    if (this.data.status === STATUS.RESULT && this.data.result) this.setupResultAudio(this.data.result);
    this.nextTick(() => {
      if (this.data.status === STATUS.EDITING) {
        if (this.waveCtx) this.drawWave();
        else this.initWaveCanvas();
      }
    });
  },

  onHide() {
    // tab 页切换不销毁页面，但停止播放并释放播放器资源（onShow 重建）
    this.stopAllPlayback();
    this.clearPlayTimer();
    this.destroyAudioContexts();
  },

  onUnload() {
    this.stopAllPlayback();
    this.clearExportTimer();
    this.destroyAudioContexts();
    if (this._draftTimer) clearTimeout(this._draftTimer);
    if (this._onAudioInterruptionBegin && wx.offAudioInterruptionBegin) {
      try { wx.offAudioInterruptionBegin(this._onAudioInterruptionBegin); } catch (e) {}
    }
    if (this._onAudioInterruptionEnd && wx.offAudioInterruptionEnd) {
      try { wx.offAudioInterruptionEnd(this._onAudioInterruptionEnd); } catch (e) {}
    }
    if (wx.disableAlertBeforeUnload) {
      try { wx.disableAlertBeforeUnload(); } catch (e) {}
    }
    if (this._onWindowResize && wx.offWindowResize) wx.offWindowResize(this._onWindowResize);
    if (this._privacyHandler && wx.offNeedPrivacyAuthorization) {
      wx.offNeedPrivacyAuthorization(this._privacyHandler);
    }
  },

  nextTick(fn) {
    if (wx.nextTick) wx.nextTick(fn);
    else setTimeout(fn, 0);
  },

  /* ====================================================================== */
  /* 隐私授权（wx.chooseMessageFile 需要）                                   */
  /* ====================================================================== */

  initPrivacyAuthorization() {
    if (!wx.onNeedPrivacyAuthorization) return;
    this._privacyHandler = (resolve) => {
      this.privacyResolve = resolve;
      this.setData({ showPrivacy: true });
    };
    wx.onNeedPrivacyAuthorization(this._privacyHandler);
  },

  handleAgreePrivacy() {
    if (this.privacyResolve) {
      this.privacyResolve({ buttonId: 'editor-agree-btn', event: 'agree' });
      this.privacyResolve = null;
    }
    this.setData({ showPrivacy: false });
  },

  handleDisagreePrivacy() {
    if (this.privacyResolve) {
      this.privacyResolve({ buttonId: 'editor-disagree-btn', event: 'disagree' });
      this.privacyResolve = null;
    }
    this.setData({ showPrivacy: false });
    wx.showToast({ title: '未同意隐私政策将无法选择音频', icon: 'none' });
  },

  openPrivacyContract() {
    if (wx.openPrivacyContract) {
      wx.openPrivacyContract({
        fail: () => wx.showToast({ title: '请先在后台配置隐私保护指引', icon: 'none' }),
      });
    }
  },

  preventBubble() {},

  /* ====================================================================== */
  /* 防误退拦截、来电打断保护与剪辑工程草稿自动保存恢复                     */
  /* ====================================================================== */

  handleAudioInterruptionBegin() {
    this.stopAllPlayback();
    this.setData({ isPlaying: false, playMode: '' });
  },

  handleAudioInterruptionEnd() {
    // 系统打断恢复：安全保持暂停，静候用户主动点按播放，避免突然出声造成社交惊扰
  },

  updateUnloadAlert() {
    if (this.data.status === STATUS.EDITING && this.clips && this.clips.length > 0) {
      if (wx.enableAlertBeforeUnload) {
        try {
          wx.enableAlertBeforeUnload({
            message: '当前有未导出的音频剪辑，退出将丢失本次未保存的变动，确定返回吗？',
          });
        } catch (e) {}
      }
    } else {
      if (wx.disableAlertBeforeUnload) {
        try {
          wx.disableAlertBeforeUnload();
        } catch (e) {}
      }
    }
  },

  saveDraft() {
    if (!wx.setStorage) return;
    if (this.data.status !== STATUS.EDITING || !this.clips || !this.clips.length || !this.sources || !this.sources.length) {
      return;
    }
    try {
      const draft = {
        savedAt: Date.now(),
        sources: this.sources.map(s => ({
          id: s.id,
          name: s.name,
          localPath: s.localPath || s.tempFilePath || '',
          fileID: s.fileID,
          duration: s.duration,
          size: s.size,
          format: s.format,
          sampleRate: s.sampleRate,
          channels: s.channels,
          playable: s.playable !== false,
          playableIos: s.playableIos,
          playableAndroid: s.playableAndroid,
          peaks: s.peaks,
          rmsPeaks: s.rmsPeaks,
          bucketMs: s.bucketMs,
          metaText: s.metaText,
        })),
        clips: editorUtils.copyClips(this.clips),
        tracks: this.tracks,
        selectedClipIndex: this.selectedClipIndex || 0,
        exportBitrate: this.data.exportBitrate || '192k',
        exportBitrateIndex: this.data.exportBitrateIndex !== undefined ? this.data.exportBitrateIndex : 3,
        planDurationText: this.data.planDurationText,
        clipCount: this.clips.length,
      };
      wx.setStorage({
        key: DRAFT_STORAGE_KEY,
        data: draft,
      });
    } catch (err) {
      console.warn('Auto-save draft failed:', err);
    }
  },

  scheduleSaveDraft() {
    if (this._draftTimer) clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => {
      this.saveDraft();
    }, 400);
  },

  clearDraft() {
    if (this._draftTimer) clearTimeout(this._draftTimer);
    if (!wx.removeStorageSync) return;
    try {
      wx.removeStorageSync(DRAFT_STORAGE_KEY);
    } catch (e) {}
  },

  checkAndPromptRestoreDraft() {
    if (!wx.getStorageSync) return false;
    try {
      const draft = wx.getStorageSync(DRAFT_STORAGE_KEY);
      if (!draft || !draft.clips || !draft.clips.length || !draft.sources || !draft.sources.length) {
        return false;
      }
      const now = Date.now();
      if (now - (draft.savedAt || 0) > 7 * 24 * 3600 * 1000) {
        this.clearDraft();
        return false;
      }
      const clipCount = draft.clips.length;
      const durText = draft.planDurationText || '未完成成片';
      const timeAgoMin = Math.round((now - (draft.savedAt || now)) / 60000);
      const timeAgoText = timeAgoMin <= 1 ? '刚刚' : `${timeAgoMin} 分钟前`;

      wx.showModal({
        title: '发现未导出的剪辑草稿',
        content: `检测到 ${timeAgoText} 编辑的工程（包含 ${clipCount} 个片段，成片 ${durText}）。是否恢复继续剪辑？`,
        confirmText: '恢复草稿',
        cancelText: '丢弃草稿',
        confirmColor: '#FF6B00',
        success: (res) => {
          if (res.confirm) {
            this.restoreDraft(draft);
          } else {
            this.clearDraft();
            wx.showToast({ title: '已放弃草稿', icon: 'none' });
          }
        },
      });
      return true;
    } catch (err) {
      console.warn('Check draft error:', err);
      return false;
    }
  },

  restoreDraft(draft) {
    if (!draft || !draft.sources || !draft.clips) return;
    this.sources = (draft.sources || []).map(s => ({
      ...s,
      localPath: s.localPath || s.tempFilePath || '',
      playable: s.playable !== false,
    }));
    this.clips = editorUtils.copyClips(draft.clips || []);
    if (draft.tracks && draft.tracks.length) {
      this.tracks = draft.tracks;
    }
    this.selectedClipIndex = editorUtils.clampNumber(draft.selectedClipIndex || 0, 0, this.clips.length - 1);
    if (draft.exportBitrate) {
      this.setData({
        exportBitrate: draft.exportBitrate,
        exportBitrateIndex: draft.exportBitrateIndex !== undefined ? draft.exportBitrateIndex : 3,
      });
    }

    const clip = this.getSelectedClip();
    this.currentSourceTime = clip ? clip.in : 0;
    this.syncWaveSource();
    this.setData({
      status: STATUS.EDITING,
      sources: this.sources,
      clips: this.clips,
      currentTimeText: editorUtils.formatPrecise(this.currentSourceTime),
    });
    this.refreshClipData();
    this.nextTick(() => {
      this.initWaveCanvas();
      this.updateUnloadAlert();
    });
    haptics.notificationSuccess();
    wx.showToast({ title: '已恢复剪辑工程', icon: 'success' });
  },

  /**
   * 确保音频源在当前设备具备可用本地文件路径，失效或草稿恢复时从云端 fileID 自动修复重下
   */
  async ensureSourceLocalPath(source) {
    if (!source) return '';
    if (source.localPath) {
      if (wx.getFileSystemManager) {
        try {
          const fs = wx.getFileSystemManager();
          fs.accessSync(source.localPath);
          return source.localPath;
        } catch (e) {
          console.log('[editor] 本地临时文件失效，准备从云端重新拉取：', source.fileID);
        }
      } else {
        return source.localPath;
      }
    }
    if (source.fileID && wx.cloud && wx.cloud.downloadFile) {
      try {
        if (wx.showLoading) wx.showLoading({ title: '加载音频中…', mask: true });
        const res = await wx.cloud.downloadFile({ fileID: source.fileID });
        if (wx.hideLoading) wx.hideLoading();
        if (res && res.tempFilePath) {
          source.localPath = res.tempFilePath;
          return source.localPath;
        }
      } catch (err) {
        if (wx.hideLoading) wx.hideLoading();
        console.warn('[editor] 自动下载音频失败:', err);
      }
    }
    return source.localPath || '';
  },

  /* ====================================================================== */
  /* 音频实例                                                                */
  /* ====================================================================== */

  initAudioContexts() {
    if (!this.sourceAudio) this.initSourceAudio();
    if (!this.resultAudio) this.initResultAudio();
  },

  initSourceAudio() {
    const ctx = wx.createInnerAudioContext();
    ctx.onCanplay(() => this.handleSourceCanplay());
    ctx.onPlay(() => this.handleSourcePlay());
    // 监听硬件时钟更新（只作为底层时间缓存，不直接扰动 35ms 高精物理时钟）
    ctx.onTimeUpdate(() => {
      if (this.sourceAudio && isFinite(this.sourceAudio.currentTime)) {
        this._lastHwCurrentTime = Number(this.sourceAudio.currentTime);
        this._lastHwTimeAt = Date.now();
      }
    });
    ctx.onEnded(() => this.handleSourceEnded());
    ctx.onError((err) => this.handleSourceAudioError(err));
    this.sourceAudio = ctx;
  },

  handleSourcePlay() {
    // 原生硬件正式出声：校准墙上时钟起始点，消除启动缓冲延迟
    if (this.data.isPlaying && this.playback) {
      const pb = this.playback;
      const item = pb.queue[pb.index];
      if (item && !this._playbackWallStart) {
        this._playbackWallStart = Date.now();
        this._playbackStartSourceTime = this.currentSourceTime || item.in;
        const clipOutputStart = editorUtils.queueOutputPosition(pb.queue, pb.index, item.in);
        this._playbackStartTimelineSec = clipOutputStart + Math.max(0, this._playbackStartSourceTime - item.in);
        this._playbackSpeed = item.speed || 1.0;
      }
    }
  },

  initResultAudio() {
    const ctx = wx.createInnerAudioContext();
    try { ctx.obeyMuteSwitch = false; } catch (e) {}
    ctx.onPlay(() => this.setData({ resultPlaying: true }));
    ctx.onPause(() => this.setData({ resultPlaying: false }));
    ctx.onStop(() => this.setData({ resultPlaying: false }));
    ctx.onEnded(() => this.setData({ resultPlaying: false, resultCurrentTime: 0, resultCurrentText: '00:00' }));
    ctx.onTimeUpdate(() => this.handleResultTimeUpdate());
    ctx.onCanplay(() => {
      const d = ctx && ctx.duration;
      if (d > 0) this.setData({ resultDuration: d, resultDurationText: editorUtils.formatClock(d) });
    });
    ctx.onError((err) => this.handleResultAudioError(err));
    this.resultAudio = ctx;
  },

  getTrackAudio(trackId) {
    if (!this.trackAudioPool) this.trackAudioPool = {};
    if (!this.trackAudioPool[trackId]) {
      const ctx = wx.createInnerAudioContext();
      ctx.onCanplay(() => {
        if (this.isMultiTrackPlaying && typeof ctx.startTime === 'number' && ctx.startTime > 0) {
          try { ctx.seek(ctx.startTime); } catch (e) {}
        }
      });
      this.trackAudioPool[trackId] = ctx;
    }
    return this.trackAudioPool[trackId];
  },

  destroyAudioContexts() {
    if (this.sourceAudio) {
      try {
        this.sourceAudio.stop();
        this.sourceAudio.destroy();
      } catch (e) {}
      this.sourceAudio = null;
    }
    this.previewSrcId = '';
    if (this.resultAudio) {
      try {
        this.resultAudio.stop();
        this.resultAudio.destroy();
      } catch (e) {}
      this.resultAudio = null;
    }
    if (this.trackAudioPool) {
      Object.keys(this.trackAudioPool).forEach(id => {
        try {
          this.trackAudioPool[id].stop();
          this.trackAudioPool[id].destroy();
        } catch (e) {}
      });
      this.trackAudioPool = null;
    }
  },

  getPlatform() {
    try {
      if (wx.getSystemInfoSync) {
        const sys = wx.getSystemInfoSync();
        if (sys && (sys.platform === 'devtools' || sys.environment === 'wxide')) return 'devtools';
      }
      if (wx.getDeviceInfo) {
        const info = wx.getDeviceInfo();
        const p = String((info && info.platform) || '').toLowerCase();
        if (p === 'devtools') return 'devtools';
        return p;
      }
      const sys = wx.getSystemInfoSync();
      return String((sys && sys.platform) || '').toLowerCase();
    } catch (e) {
      return '';
    }
  },

  makeSourceId() {
    this._sourceSeq += 1;
    return 's' + Date.now().toString(36) + '_' + this._sourceSeq;
  },

  makeClipId() {
    this._clipSeq += 1;
    return 'c' + Date.now().toString(36) + '_' + this._clipSeq;
  },

  /* ====================================================================== */
  /* 导入：多选 → 逐个上传/分析 → sources + clips                             */
  /* ====================================================================== */

  chooseAudioFiles() {
    if (this.choosingFile || this.importing) return;
    if (this.data.status === STATUS.UPLOADING || this.data.status === STATUS.ANALYZING) return;
    if (this.data.status === STATUS.EXPORTING) return;
    const remaining = MAX_SOURCES - this.sources.length;
    if (remaining <= 0) {
      wx.showModal({ title: '音频源已满', content: '最多支持 ' + MAX_SOURCES + ' 个音频源，请先删除片段或换一个项目。', showCancel: false });
      return;
    }
    this.choosingFile = true;
    this.stopAllPlayback();
    // iOS 兼容性提升：采用 type: 'all' 且不传 extension 参数，避免 iOS 微信将大写后缀过滤或抛出 invalid parameter
    wx.chooseMessageFile({
      count: remaining,
      type: 'all',
      success: (res) => this.handleFilesPicked(res),
      fail: (err) => this.handleChooseFail(err),
    });
  },

  handleChooseFail(err) {
    this.choosingFile = false;
    const msg = (err && err.errMsg) || '';
    if (msg.indexOf('cancel') >= 0) return;
    if (msg.indexOf('privacy') >= 0) {
      wx.showModal({
        title: '需要文件读取授权',
        content: '请在隐私弹窗中点击「同意」后再选择音频；若没有弹出，请在微信设置中允许本小程序读取你选择的文件。',
        showCancel: false,
      });
      return;
    }
    wx.showModal({
      title: '选择文件失败',
      content: msg || '请稍后重试，或在微信聊天中先把音频发送给「文件传输助手」再选择。',
      showCancel: false,
    });
  },

  handleFilesPicked(res) {
    this.choosingFile = false;
    const files = (res && res.tempFiles) || [];
    if (!files.length) return;

    const remaining = MAX_SOURCES - this.sources.length;
    const accepted = [];
    const rejected = [];
    const fs = wx.getFileSystemManager ? wx.getFileSystemManager() : null;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePath = file.path || file.tempFilePath;
      if (accepted.length >= remaining) {
        rejected.push({ name: file.name, message: '最多支持 ' + MAX_SOURCES + ' 个音频源，多余文件未导入' });
        continue;
      }

      // iOS 容错：检测聊天文件是否已在本地下载完成
      if (fs && fs.statSync && filePath) {
        try {
          const stat = fs.statSync(filePath);
          if (stat && typeof stat.size === 'number' && stat.size > 0 && !file.size) {
            file.size = stat.size;
          }
        } catch (statErr) {
          rejected.push({ name: file.name, message: '文件尚未在微信中下载，请先在聊天记录中点击下载' });
          continue;
        }
      }

      const check = editorUtils.validateLocalFile(file, { maxBytes: MAX_FILE_BYTES });
      if (!check.ok) {
        rejected.push({ name: file.name, message: check.message });
        continue;
      }
      accepted.push({ file: file, ext: check.ext });
    }

    if (!accepted.length) {
      const firstMessage = rejected.length ? rejected[0].message : '没有可导入的音频文件';
      if (this.sources.length) {
        this.showImportFailures(rejected);
      } else {
        this.setData({ status: STATUS.EMPTY, loadError: firstMessage });
        this.setImportFailures(rejected);
      }
      return;
    }

    this.preRejects = rejected;
    this.importFiles(accepted);
  },

  /**
   * 串行导入：每个文件 uploadFile → analyzeAudio → 生成 source + 默认整段 clip。
   * 部分失败记录在 this.failedItems，可点「重试失败项」。
   */
  async importFiles(items) {
    if (!items || !items.length) return;
    this.importing = true;
    const wasEditing = this.sources.length > 0;
    const firstNewClipIndex = this.clips.length;
    if (wasEditing) this.pushUndo();
    else this.undoStack = [];

    const total = items.length;
    const failures = (this.preRejects || []).slice();
    this.preRejects = [];
    this.failedItems = [];
    this.setData({
      status: STATUS.UPLOADING,
      stageText: '正在准备导入…',
      importProgressText: '0/' + total,
      importFileName: items[0].file.name,
      loadError: '',
      failStage: '',
      importFailures: [],
      importFailureNames: '',
      importFailureDetail: '',
    });

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const filePath = (item.file && (item.file.path || item.file.tempFilePath)) || '';
      this.setData({
        status: STATUS.UPLOADING,
        stageText: '正在上传 ' + (i + 1) + '/' + total + '…',
        importProgressText: i + 1 + '/' + total,
        importFileName: item.file.name,
      });
      try {
        const cloudPath = editorUtils.buildCloudPath(
          item.ext,
          Date.now(),
          Math.random().toString(36).slice(2, 8) + i
        );
        let uploadRes = null;
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            uploadRes = await wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: filePath });
            if (uploadRes && uploadRes.fileID) break;
          } catch (upErr) {
            lastErr = upErr;
            if (attempt === 0) await new Promise(r => setTimeout(r, 600));
          }
        }
        if (!uploadRes || !uploadRes.fileID) {
          const upMsg = (lastErr && (lastErr.errMsg || lastErr.message)) || '上传超时或网络异常';
          throw this.makeImportError('upload', '上传失败：' + upMsg + '，请检查网络后重试。');
        }

        this.setData({
          status: STATUS.ANALYZING,
          stageText: '正在分析波形 ' + (i + 1) + '/' + total + '…',
        });
        const callRes = await wx.cloud.callFunction({
          name: 'ffmpegProbe',
          data: {
            action: 'analyzeAudio',
            fileID: uploadRes.fileID,
            fileName: item.file.name,
            size: item.file.size,
          },
        });
        const result = callRes && callRes.result;
        if (!result || result.success !== true) {
          throw this.makeImportError('analyze', this.mapAnalyzeError(result), result && result.code);
        }
        this.addSourceFromAnalysis(item, uploadRes.fileID, result.data);
      } catch (err) {
        console.error('[editor] 导入失败：' + item.file.name, err);
        failures.push({ name: item.file.name, message: this.normalizeImportError(err) });
        this.failedItems.push(item);
      }
    }

    this.importing = false;

    if (!this.sources.length) {
      this.setData({
        status: STATUS.EMPTY,
        stageText: '',
        importProgressText: '',
        importFileName: '',
        loadError: failures.length ? failures[0].message : '没有成功导入音频，请重试。',
      });
      this.setImportFailures(failures);
      return;
    }

    const hint = firstNewClipIndex < this.clips.length ? firstNewClipIndex : Math.max(0, this.clips.length - 1);
    this.enterEditingAfterImport(failures, hint);
  },

  addSourceFromAnalysis(item, fileID, raw) {
    const data = raw || {};
    const duration = Number(data.duration);
    if (!isFinite(duration) || duration <= editorUtils.MIN_CLIP_DURATION) {
      throw this.makeImportError('analyze', '这个音频时长异常，无法编辑，请换一个文件。');
    }
    if (duration > MAX_PLAN_DURATION + 0.001) {
      throw this.makeImportError(
        'analyze',
        '单个音频需在 10 分钟以内，超长音频可以先用「格式转换」处理。',
        'DURATION_TOO_LONG'
      );
    }
    if (this.clips.length >= MAX_CLIPS) {
      throw this.makeImportError('analyze', '片段数已达上限（' + MAX_CLIPS + ' 段），请先删除片段。');
    }

    const parsed = editorUtils.parsePeaks(data);
    const format = String(data.format || item.ext || '').toLowerCase();
    const sampleRate = Number(data.sampleRate) || 0;
    const channels = Number(data.channels) || 0;
    const source = {
      id: this.makeSourceId(),
      fileID: fileID,
      localPath: item.file.path,
      name: item.file.name,
      size: Number(item.file.size) || 0,
      duration: editorUtils.round3(duration),
      format: format,
      sampleRate: sampleRate,
      channels: channels,
      peaks: parsed.peak,
      rmsPeaks: parsed.rms,
      bucketMs: Number(data.bucketMs) > 0 ? Number(data.bucketMs) : 50,
      playable: editorUtils.resolvePreviewPlayable(data, this.getPlatform()),
      metaText: [
        format ? format.toUpperCase() : '',
        sampleRate ? Number((sampleRate / 1000).toFixed(1)) + 'kHz' : '',
        channels === 1 ? '单声道' : channels === 2 ? '立体声' : '',
      ]
        .filter(Boolean)
        .join(' · '),
    };

    this.sources.push(source);
    this.clips.push({
      id: this.makeClipId(),
      sourceId: source.id,
      in: 0,
      out: source.duration,
      fadeIn: 0,
      fadeOut: 0,
      trackId: this._targetTrackId || (this.tracks[0] && this.tracks[0].id) || 'T1',
    });
  },

  enterEditingAfterImport(failures, selectIndexHint) {
    const targetIndex =
      typeof selectIndexHint === 'number' && isFinite(selectIndexHint)
        ? selectIndexHint
        : Math.max(0, this.clips.length - 1);
    this.selectedClipIndex = editorUtils.clampNumber(targetIndex, 0, Math.max(0, this.clips.length - 1));
    this.selection = null;
    this.releaseWaveCanvas();

    const clip = this.getSelectedClip();
    this.currentSourceTime = clip ? clip.in : 0;
    this.syncWaveSource();

    this.setData({
      status: STATUS.EDITING,
      stageText: '',
      importProgressText: '',
      importFileName: '',
      loadError: '',
      failStage: '',
      hasSelection: false,
      selection: null,
      currentTimeText: editorUtils.formatPrecise(this.currentSourceTime),
      isPlaying: false,
      playMode: '',
    });
    this.setImportFailures(failures);
    this.refreshClipData();
    this.scheduleSaveDraft();
    this.updateUnloadAlert();
    this.nextTick(() => this.initWaveCanvas());
    if (editorUtils.planDuration(this.clips) > MAX_PLAN_DURATION) {
      wx.showToast({ title: '成片已超过 10 分钟，请删减片段后再导出', icon: 'none', duration: 2600 });
    }
  },

  setImportFailures(failures) {
    const list = failures || [];
    const names = list
      .map((f) => f.name)
      .slice(0, 3)
      .join('、');
    this.setData({
      importFailures: list,
      importFailureNames: names + (list.length > 3 ? ' 等' : ''),
      importFailureDetail: list.length ? list[0].message : '',
    });
  },

  showImportFailures(failures) {
    this.setImportFailures(failures);
    wx.showToast({ title: failures.length + ' 个文件未导入，请查看提示', icon: 'none' });
  },

  retryFailedImports() {
    if (this.importing) return;
    if (!this.failedItems.length) {
      wx.showToast({ title: '没有需要重试的文件', icon: 'none' });
      return;
    }
    const items = this.failedItems.slice();
    this.failedItems = [];
    this.setData({ importFailures: [], importFailureNames: '', importFailureDetail: '' });
    this.importFiles(items);
  },

  dismissImportFailures() {
    this.setData({ importFailures: [], importFailureNames: '', importFailureDetail: '' });
  },

  makeImportError(stage, message, code) {
    const err = new Error(message);
    err.stage = stage;
    err.userMessage = message;
    err.code = code || '';
    return err;
  },

  normalizeImportError(err) {
    if (!err) return '处理失败，请稍后重试。';
    if (err.userMessage) return err.userMessage;
    const msg = String(err.errMsg || err.message || '');
    if (msg.indexOf('-501000') >= 0 || msg.indexOf('FunctionName') >= 0 || msg.indexOf('cloud function') >= 0) {
      return '云端服务尚未就绪，请确认已部署 ffmpegProbe 云函数后重试。';
    }
    if (msg.indexOf('timeout') >= 0) return '云端处理超时，请重试或换一个更短的音频。';
    return msg || '处理失败，请检查网络后重试。';
  },

  mapAnalyzeError(result) {
    if (!result) return '云端分析无响应，请稍后重试。';
    const code = result.code || '';
    if (code === 'DURATION_TOO_LONG') {
      return '单个音频超过 10 分钟，剪辑目前支持 10 分钟以内的音频；更长音频可以先用「格式转换」处理。';
    }
    if (code === 'FILE_TOO_LARGE') return '单文件超过 50MB，请换一个更小的音频。';
    if (code === 'INVALID_FILE' || code === 'DECODE_FAILED') {
      return '这个文件解析失败，可能已损坏或不是音频文件，请换一个。';
    }
    if (code === 'INTERNAL') return '服务开小差了，请稍后重试。';
    return result.errorMessage || '准备波形失败，请重试。';
  },

  resetProject() {
    wx.showModal({
      title: '换一个项目',
      content: '当前所有音频和剪辑都不会保存，确定清空重新开始吗？',
      success: (res) => {
        if (!res.confirm) return;
        this.resetAll();
      },
    });
  },

  resetAll() {
    this.stopAllPlayback();
    this.clearDraft();
    this.sources = [];
    this.clips = [];
    this.selectedClipIndex = 0;
    this.undoStack = [];
    this.failedItems = [];
    this.preRejects = [];
    this.currentSourceTime = 0;
    this.previewFailed = false;
    this.resultTempFilePath = '';
    this._preparingFileID = '';
    this.releaseWaveCanvas();
    this.wavePeaks = null;
    this.rmsPeaks = null;
    this.waveDuration = 0;
    this.setData({
      status: STATUS.EMPTY,
      stageText: '',
      importProgressText: '',
      importFileName: '',
      loadError: '',
      failStage: '',
      sources: [],
      sourceCount: 0,
      clips: [],
      clipCount: 0,
      selectedClipIndex: 0,
      selectedClip: null,
      selectedSource: null,
      planDuration: 0,
      planDurationText: '00:00',
      totalDurationText: '00:00',
      currentTimeText: '00:00.0',
      hasSelection: false,
      selection: null,
      canPreviewAll: true,
      canPreviewClip: true,
      previewBanner: '',
      isPlaying: false,
      playMode: '',
      fadeIn: 0,
      fadeOut: 0,
      fadeAdjusted: false,
      volumeDb: 0,
      volumeText: editorUtils.formatDb(0),
      exportDisabled: false,
      exportTip: '',
      exporting: false,
      exportElapsed: 0,
      importFailures: [],
      importFailureNames: '',
      importFailureDetail: '',
      result: null,
      resultPlaying: false,
      resultCurrentText: '00:00',
      resultDurationText: '00:00',
      resultTempReady: false,
      resultPlayError: false,
      waveUnavailable: false,
    });
    this.updateUnloadAlert();
  },

  /* ====================================================================== */
  /* 片段数据与视图                                                          */
  /* ====================================================================== */

  getSelectedClip() {
    return this.clips[this.selectedClipIndex] || null;
  },

  getSelectedSource() {
    const clip = this.getSelectedClip();
    return clip ? editorUtils.findSource(this.sources, clip.sourceId) : null;
  },

  buildSourceViews() {
    return this.sources.map((src) => ({
      id: src.id,
      name: src.name,
      metaText: src.metaText,
      durationText: editorUtils.formatClock(src.duration),
      sizeText: editorUtils.formatBytes(src.size),
      format: src.format,
      playable: src.playable !== false,
    }));
  },

  syncWaveSource() {
    const source = this.getSelectedSource();
    if (!source) {
      this.wavePeaks = null;
      this.rmsPeaks = null;
      this.waveBucketMs = 50;
      this.waveDuration = 0;
      return;
    }
    this.wavePeaks = source.peaks && source.peaks.length ? source.peaks : null;
    this.rmsPeaks = source.rmsPeaks && source.rmsPeaks.length ? source.rmsPeaks : null;
    this.waveBucketMs = source.bucketMs > 0 ? source.bucketMs : 50;
    this.waveDuration = source.duration || 0;
  },

  calcEstimatedFileSize(totalSec) {
    const opt = BITRATE_OPTIONS[this.data.exportBitrateIndex || 0] || BITRATE_OPTIONS[3];
    const dur = Math.max(0, typeof totalSec === 'number' ? totalSec : editorUtils.planDuration(this.clips));
    const bytes = (dur * opt.kbps * 1000 / 8) + 4096;
    if (dur <= 0) return '0 KB';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  },

  calcCompressionRatio(totalSec) {
    const opt = BITRATE_OPTIONS[this.data.exportBitrateIndex || 0] || BITRATE_OPTIONS[3];
    const dur = Math.max(0, typeof totalSec === 'number' ? totalSec : editorUtils.planDuration(this.clips));
    if (dur <= 0) return '86';
    const bytes = (dur * opt.kbps * 1000 / 8) + 4096;
    const wavBytes = dur * 44100 * 4;
    return String(Math.max(10, Math.min(98, Math.round((1 - bytes / wavBytes) * 100))));
  },

  buildPreviewBanner(unplayable) {
    const names = unplayable
      .map((src) => {
        const name = String((src && src.name) || '');
        return name.length > 16 ? name.slice(0, 14) + '…' : name;
      })
      .join('、');
    const platform = this.getPlatform();
    const prefix = platform === 'ios' ? 'iPhone' : '当前设备';
    if (platform === 'ios') {
      return '🍎 iOS 专属提示：iPhone 暂不支持 ' + names + ' 直接外放试听，但可正常编辑并一键导出为通用 MP3 畅听。';
    }
    return prefix + ' 不支持 ' + names + ' 的格式试听，可继续编辑并导出后试听。';
  },

  /**
   * 统一刷新：片段视图、选中片段、时长、导出可用性、预览可用性、淡入淡出显示。
   */
  refreshClipData() {
    const rawViews = editorUtils.toClipViews(this.clips, this.sources);
    const total = editorUtils.planDuration(this.clips);
    const views = rawViews.map(v => {
      const dur = v.duration || 0;
      const widthRpx = Math.max(180, Math.min(460, Math.round((dur / Math.max(1, total)) * 640)));
      return {
        ...v,
        widthRpx: widthRpx,
      };
    });
    const validation = editorUtils.validateClips(this.clips, this.sources);
    const sourceViews = this.buildSourceViews();
    const selectedIndex = views.length
      ? editorUtils.clampNumber(this.selectedClipIndex, 0, views.length - 1)
      : -1;
    this.selectedClipIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const selectedView = selectedIndex >= 0 ? views[selectedIndex] : null;
    const selectedSource = selectedView ? editorUtils.findSource(this.sources, selectedView.sourceId) : null;
    const unplayable = editorUtils.getUnplayableSources(this.clips, this.sources);
    const fadeEffective = selectedView
      ? editorUtils.effectiveClipFades(this.clips[this.selectedClipIndex])
      : { adjusted: false };

    // 仿 PR/达芬奇全轨统一时间线数据计算
    const timelineData = editorUtils.buildTimelineData(
      this.tracks,
      this.clips,
      this.sources,
      this.data.zoomLevel || 1.0,
      this.selectedClipIndex,
      this.currentSourceTime
    );

    const selRaw = this.clips[this.selectedClipIndex] || {};
    const selectedClipTrackId = selRaw.trackId || (this.tracks[0] && this.tracks[0].id) || 'T1';
    const selectedClipSpeed = selRaw.speed || 1.0;
    const selectedClipEq = selRaw.eqPreset || 'flat';
    const selectedClipDenoise = selRaw.denoise || 0;
    const selectedClipGainDb = selRaw.volumeDb || 0;

    const effectiveTotalSec = Math.max(total, (timelineData && timelineData.maxTimelineSec) || 0);
    const isOverDurationCeiling = effectiveTotalSec > 600;
    const ceilingExceededSec = isOverDurationCeiling ? editorUtils.round3(effectiveTotalSec - 600) : 0;
    const ceilingExceededText = isOverDurationCeiling ? editorUtils.formatSecondsLabel(ceilingExceededSec) : '';

    this.setData(
      {
        sources: sourceViews,
        sourceCount: this.sources.length,
        clips: views,
        clipCount: views.length,
        tracks: this.tracks,
        trackViews: timelineData.tracks,
        timelineData: timelineData,
        zoomPercentText: (() => {
          const fitScale = this.calcFitScale ? this.calcFitScale() : 0.05;
          const curr = this.data.zoomLevel || 1.0;
          return Math.abs(curr - fitScale) < 0.02 ? '全览' : Math.round(curr * 100) + '%';
        })(),
        selectedClipIndex: this.selectedClipIndex,
        selectedClip: selectedView,
        selectedClipTrackId: selectedClipTrackId,
        selectedClipSpeed: selectedClipSpeed,
        selectedClipEq: selectedClipEq,
        selectedClipDenoise: selectedClipDenoise,
        selectedClipGainDb: selectedClipGainDb,
        selectedClipGainText: editorUtils.formatDb(selectedClipGainDb),
        selectedSource: selectedSource
          ? {
              name: selectedSource.name,
              metaText: selectedSource.metaText,
              sizeText: editorUtils.formatBytes(selectedSource.size),
              durationText: editorUtils.formatClock(selectedSource.duration),
              format: selectedSource.format,
              playable: selectedSource.playable !== false,
            }
          : null,
        planDuration: effectiveTotalSec,
        planDurationText: editorUtils.formatClock(effectiveTotalSec),
        totalDurationText: selectedSource ? editorUtils.formatClock(selectedSource.duration) : '00:00',
        currentTimeText: editorUtils.formatPrecise(this.currentSourceTime),
        isOverDurationCeiling: isOverDurationCeiling,
        ceilingExceededSec: ceilingExceededSec,
        ceilingExceededText: ceilingExceededText,
        canPreviewAll: unplayable.length === 0 && views.length > 0,
        canPreviewClip: !!(selectedView && selectedSource && selectedSource.playable !== false),
        previewBanner: unplayable.length ? this.buildPreviewBanner(unplayable) : '',
        fadeIn: selectedView ? selectedView.fadeIn : 0,
        fadeOut: selectedView ? selectedView.fadeOut : 0,
        fadeAdjusted: !!fadeEffective.adjusted,
        effectiveFadeInText: editorUtils.formatFade(fadeEffective.fadeIn),
        effectiveFadeOutText: editorUtils.formatFade(fadeEffective.fadeOut),
        canUndo: this.undoStack.length > 0,
        exportDisabled: !validation.ok || this.exporting || isOverDurationCeiling,
        exportTip: validation.ok ? (isOverDurationCeiling ? `总长已超出 10 分钟限额 (超 ${ceilingExceededText})` : '') : validation.message,
        estimatedFileSizeText: this.calcEstimatedFileSize(total),
        compressionRatioText: this.calcCompressionRatio(total),
      },
      () => this.drawWave()
    );
  },

  selectClip(index, targetTime) {
    const i = Number(index);
    if (!isFinite(i) || i < 0 || i >= this.clips.length) return;
    this.selectedClipIndex = i;
    const clip = this.clips[i];
    if (clip) {
      if (typeof targetTime === 'number' && isFinite(targetTime)) {
        this.currentSourceTime = editorUtils.clampNumber(targetTime, clip.in, clip.out);
      } else if (this.currentSourceTime < clip.in || this.currentSourceTime > clip.out) {
        this.currentSourceTime = clip.in;
      }
    }
    this.selection = null;
    this.syncWaveSource();
    this.setData({ hasSelection: false, selection: null });
    this.refreshClipData();
    if (this.data.isPlaying) {
      this.seekPlaybackTo(this.currentSourceTime);
    }
  },

  onClipTap(e) {
    this.selectClip(Number(e.currentTarget.dataset.index));
  },

  pushUndo() {
    this.undoStack.push({
      clips: editorUtils.copyClips(this.clips),
      selectedIndex: this.selectedClipIndex,
    });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
  },

  undo() {
    if (!this.undoStack.length) return;
    this.stopPlayback();
    const snapshot = this.undoStack.pop();
    this.clips = editorUtils.copyClips(snapshot.clips);
    this.selectedClipIndex = editorUtils.clampNumber(snapshot.selectedIndex, 0, Math.max(0, this.clips.length - 1));
    this.selection = null;
    const clip = this.getSelectedClip();
    this.currentSourceTime = clip ? clip.in : 0;
    this.syncWaveSource();
    this.setData({ hasSelection: false, selection: null });
    this.refreshClipData();
    wx.showToast({ title: '已撤销', icon: 'none' });
  },

  /**
   * 提交新的 clips 列表（数量/非空校验 → 入 undo 栈 → 刷新视图）。
   */
  commitClips(nextClips, options) {
    const opts = options || {};
    if (!Array.isArray(nextClips) || !nextClips.length) {
      wx.showToast({ title: '至少保留 1 个片段', icon: 'none' });
      return false;
    }
    if (nextClips.length > MAX_CLIPS) {
      wx.showToast({ title: '最多支持 ' + MAX_CLIPS + ' 个片段', icon: 'none' });
      return false;
    }
    if (opts.pushUndo !== false) this.pushUndo();
    if (!opts.preservePlayback) {
      this.stopPlaybackAudioOnly();
      this.playback = null;
      this.paused = false;
      this.isMultiTrackPlaying = false;
    }
    this.clips = editorUtils.copyClips(nextClips);
    const target = typeof opts.selectedClipIndex === 'number' ? opts.selectedClipIndex : this.selectedClipIndex;
    this.selectedClipIndex = editorUtils.clampNumber(target, 0, this.clips.length - 1);
    if (opts.clearSelection !== false) this.selection = null;
    const clip = this.getSelectedClip();
    if (clip && opts.jumpToIn !== false && !opts.preservePlayback) this.currentSourceTime = clip.in;
    this.syncWaveSource();
    if (this.selection) this.pushSelectionData(true);
    else this.setData({ hasSelection: false, selection: null });
    this.refreshClipData();
    this.scheduleSaveDraft();
    this.updateUnloadAlert();
    if (opts.toast) wx.showToast({ title: opts.toast, icon: 'none' });
    return true;
  },

  moveSelectedClip(delta) {
    const from = this.selectedClipIndex;
    const to = from + delta;
    if (to < 0 || to >= this.clips.length) {
      wx.showToast({ title: delta < 0 ? '已经是最前面的一段' : '已经是最后面的一段', icon: 'none' });
      return;
    }
    this.stopPlayback();
    const res = editorUtils.moveClip(this.clips, from, to);
    if (!res.ok) {
      wx.showToast({ title: res.message || '无法移动', icon: 'none' });
      return;
    }
    this.commitClips(res.clips, {
      selectedClipIndex: to,
      toast: delta < 0 ? '已上移' : '已下移',
    });
  },

  moveClipUp() {
    this.moveSelectedClip(-1);
  },

  moveClipDown() {
    this.moveSelectedClip(1);
  },

  deleteSelectedClip() {
    const index = this.selectedClipIndex;
    const res = editorUtils.removeClip(this.clips, index);
    if (!res.ok) {
      wx.showToast({ title: res.message || '无法删除', icon: 'none' });
      return;
    }
    this.stopPlayback();
    this.commitClips(res.clips, {
      selectedClipIndex: Math.min(index, res.clips.length - 1),
      toast: '已删除片段',
    });
    haptics.impactMedium();
  },

  splitSelectedClipAtPlayhead() {
    const clip = this.getSelectedClip();
    if (!clip) return;
    let time = this.currentSourceTime;
    if (!(time > clip.in + 1e-6 && time < clip.out - 1e-6)) {
      // 智能回退：如果在片段边界或外部点按剪开，自动选择片段正中央 50% 位置，避免打断手机连续操作
      time = editorUtils.round3((clip.in + clip.out) / 2);
    }
    const res = editorUtils.splitClipAt(this.clips, this.selectedClipIndex, time, this.makeClipId());
    if (!res.ok) {
      wx.showModal({ title: '无法分割', content: res.message || '播放头位置不合适，单段至少需 0.2 秒。', showCancel: false });
      return;
    }
    this.stopPlayback();
    this.commitClips(res.clips, {
      selectedClipIndex: this.selectedClipIndex + 1,
      toast: '已在播放头处分割',
    });
    haptics.impactHeavy();
  },

  copySelectedClip() {
    const clip = this.getSelectedClip();
    if (!clip) {
      wx.showToast({ title: '请先在时间线上选中音频片段', icon: 'none' });
      return;
    }
    this.clipboardClip = editorUtils.copyClip(clip);
    const clipName = clip.sourceName || clip.name || '音频片段';
    this.setData({
      hasClipboard: true,
      clipboardName: clipName,
    });
    haptics.impactLight();
    wx.showToast({ title: '已复制片段，移动红针后点「粘贴」', icon: 'none' });
  },

  pasteClip() {
    if (!this.clipboardClip) {
      wx.showToast({ title: '剪贴板为空，请先点击「复制」', icon: 'none' });
      return;
    }
    if (this.clips.length >= MAX_CLIPS) {
      wx.showToast({ title: '最多支持 ' + MAX_CLIPS + ' 个片段', icon: 'none' });
      return;
    }
    this.pushUndo();
    const cloned = editorUtils.copyClip(this.clipboardClip);
    cloned.id = this.makeClipId();

    // 目标轨道：选中片段所在轨道，或当前活动轨道
    const curClip = this.getSelectedClip();
    const targetTrackId = (curClip && curClip.trackId) || this.activeTrackId || 'T1';
    cloned.trackId = targetTrackId;

    // 起跑时间位置计算
    let targetOffset = 0;
    if (typeof this.currentSourceTime === 'number' && this.currentSourceTime > 0) {
      targetOffset = editorUtils.round3(this.currentSourceTime);
    } else if (curClip && typeof curClip.offsetSec === 'number') {
      const curDur = (curClip.out || 0) - (curClip.in || 0);
      targetOffset = editorUtils.round3(curClip.offsetSec + curDur + 0.1);
    } else {
      const sameTrackClips = this.clips.filter((c) => (c.trackId || 'T1') === targetTrackId);
      if (sameTrackClips.length > 0) {
        const last = sameTrackClips[sameTrackClips.length - 1];
        const lastDur = (last.out || 0) - (last.in || 0);
        targetOffset = editorUtils.round3((last.offsetSec || 0) + lastDur + 0.1);
      }
    }
    cloned.offsetSec = Math.max(0, targetOffset);

    const nextClips = this.clips.slice();
    const insertIndex = this.selectedClipIndex >= 0 ? this.selectedClipIndex + 1 : nextClips.length;
    nextClips.splice(insertIndex, 0, cloned);

    this.stopPlayback();
    this.commitClips(nextClips, {
      selectedClipIndex: insertIndex,
      toast: '已成功粘贴到时间线',
    });
    haptics.impactMedium();
  },

  duplicateSelectedClip() {
    this.copySelectedClip();
    this.pasteClip();
  },

  toggleExportCompressionPanel() {
    this.setData({ showCompressionPanel: !this.data.showCompressionPanel });
    haptics.impactLight();
  },

  closeCompressionPanel() {
    this.setData({ showCompressionPanel: false });
  },

  onBitrateSliderChange(e) {
    const idx = Math.max(0, Math.min(BITRATE_OPTIONS.length - 1, Number(e.detail.value) || 0));
    const opt = BITRATE_OPTIONS[idx];
    this.setData({
      exportBitrate: opt.value,
      exportBitrateIndex: idx,
    });
    this.updateEstimatedFileSize();
    haptics.impactLight();
  },

  onBitrateSliderChanging(e) {
    const idx = Math.max(0, Math.min(BITRATE_OPTIONS.length - 1, Math.round(Number(e.detail.value)) || 0));
    const opt = BITRATE_OPTIONS[idx];
    if (opt.value !== this.data.exportBitrate) {
      haptics.impactLight();
      this.setData({
        exportBitrate: opt.value,
        exportBitrateIndex: idx,
      });
      this.updateEstimatedFileSize();
    }
  },

  selectBitratePreset(e) {
    const idx = Number(e.currentTarget.dataset.index) || 0;
    const opt = BITRATE_OPTIONS[idx];
    if (!opt) return;
    this.setData({
      exportBitrate: opt.value,
      exportBitrateIndex: idx,
    });
    this.updateEstimatedFileSize();
    haptics.impactLight();
  },

  updateEstimatedFileSize() {
    const total = editorUtils.planDuration(this.clips);
    const sizeText = this.calcEstimatedFileSize(total);
    const ratio = this.calcCompressionRatio(total);
    const opt = BITRATE_OPTIONS[this.data.exportBitrateIndex || 0] || BITRATE_OPTIONS[3];
    this.setData({
      estimatedFileSizeText: sizeText,
      compressionRatioText: ratio,
      qualityGradeText: opt.quality,
      qualityGradeShort: opt.shortGrade,
      qualityHintText: opt.hint,
    });
  },

  cropSelectedClipToSelection() {
    if (!this.hasUsableSelection()) {
      wx.showToast({ title: '先在波形上拖动，选择要保留的部分', icon: 'none' });
      return;
    }
    const clip = this.getSelectedClip();
    if (!clip) return;
    const res = editorUtils.cropClipToRange(clip, this.selection.start, this.selection.end);
    if (!res.ok) {
      wx.showModal({ title: '无法裁剪', content: res.message || '选区太短了。', showCancel: false });
      return;
    }
    const next = this.clips.slice();
    next[this.selectedClipIndex] = res.clip;
    this.stopPlayback();
    this.commitClips(next, {
      selectedClipIndex: this.selectedClipIndex,
      toast: '已裁剪到选区',
    });
  },

  cropToSelection() {
    this.cropSelectedClipToSelection();
  },

  resetSelectedClip() {
    const clip = this.getSelectedClip();
    const source = this.getSelectedSource();
    if (!clip || !source) return;
    const res = editorUtils.resetClipToFull(clip, source.duration);
    if (!res.ok) {
      wx.showModal({ title: '无法重置', content: res.message || '源音频时长异常。', showCancel: false });
      return;
    }
    const next = this.clips.slice();
    next[this.selectedClipIndex] = res.clip;
    this.stopPlayback();
    this.commitClips(next, {
      selectedClipIndex: this.selectedClipIndex,
      toast: '已恢复整段',
    });
  },

  rippleDeleteSelection() {
    if (!this.hasUsableSelection()) {
      wx.showToast({ title: '先在波形上拖动，选择要删除的部分', icon: 'none' });
      return;
    }
    const clip = this.getSelectedClip();
    if (!clip) return;
    const res = editorUtils.rippleDeleteSelection(
      this.clips,
      clip.sourceId,
      this.selection.start,
      this.selection.end,
      editorUtils.MIN_CLIP_DURATION,
      () => this.makeClipId()
    );
    if (!res.ok) {
      wx.showModal({
        title: '无法删除',
        content: res.message || '删除后没有可导出的片段了，请缩小选区。',
        showCancel: false,
      });
      return;
    }
    this.stopPlayback();
    this.commitClips(res.clips, {
      selectedClipIndex: this.selectedClipIndex,
      toast:
        '已删除 ' +
        editorUtils.formatSecondsLabel(res.removed) +
        (res.dropped > 0 ? '（短残片已忽略）' : '，可撤销'),
    });
  },

  /* ====================================================================== */
  /* PR / 达芬奇 NLE 经典轨道编辑工具与内置声音处理工具                     */
  /* ====================================================================== */

  setToolSelect() {
    this.setData({ activeTool: 'select' });
    this.razorTouchTime = null;
    this.drawWave();
    wx.showToast({ title: '已切回选择模式', icon: 'none' });
  },

  setToolRazor() {
    if (this.data.activeTool === 'razor') {
      this.setData({ activeTool: 'select' });
      this.razorTouchTime = null;
      this.drawWave();
      wx.showToast({ title: '已退出剃刀，切回选择模式', icon: 'none' });
      return;
    }
    this.setData({ activeTool: 'razor' });
    haptics.impactMedium();
    wx.showToast({ title: '✂️ 剃刀就绪：在波形或音轨轻触即剪', icon: 'none' });
  },

  executeRazorCutAtTime(clip, cutTime) {
    if (!clip) return;
    const minDur = editorUtils.MIN_CLIP_DURATION || 0.2;
    // 智能阻尼与边缘吸附防微残片护栏（Phase 2: Micro-Clip Defense）
    if (cutTime <= clip.in + 0.3) {
      wx.showToast({ title: '✂️ 距起点不足 0.3s，已自动吸附至端点', icon: 'none' });
      haptics.impactLight();
      return;
    }
    if (cutTime >= clip.out - 0.3) {
      wx.showToast({ title: '✂️ 距终点不足 0.3s，已自动吸附至端点', icon: 'none' });
      haptics.impactLight();
      return;
    }

    this.pushUndo();
    const res = editorUtils.splitClipAt(this.clips, this.selectedClipIndex, cutTime, this.makeClipId());
    if (!res.ok) {
      wx.showToast({ title: res.message || '此处无法剪断', icon: 'none' });
      return;
    }

    this.currentSourceTime = cutTime;
    this.stopPlayback();
    this.commitClips(res.clips, {
      selectedClipIndex: this.selectedClipIndex + 1,
      toast: `✂️ 已在 ${editorUtils.formatPrecise(cutTime)} 剪开`,
    });
    haptics.impactHeavy();
    this.setData({ justSplitIndex: this.selectedClipIndex + 1 });
    setTimeout(() => {
      this.setData({ justSplitIndex: null });
    }, 600);
  },

  toggleSnap() {
    const next = !this.data.snapEnabled;
    this.setData({ snapEnabled: next });
    wx.showToast({ title: next ? '🧲 磁吸对齐开启' : '磁吸已关闭', icon: 'none' });
  },

  calcFitScale() {
    const viewportWidthRpx = 520;
    let maxSec = 10;
    if (this.clips && this.clips.length) {
      this.clips.forEach(c => {
        const dur = (c.out || 0) - (c.in || 0);
        const end = (typeof c.offsetSec === 'number' ? c.offsetSec : 0) + dur;
        if (end > maxSec) maxSec = end;
      });
    }
    const rawScale = viewportWidthRpx / (maxSec * 36);
    return Math.max(0.02, Math.min(1.0, Math.round(rawScale * 100) / 100));
  },

  zoomFit() {
    const fitScale = this.calcFitScale();
    this.setData({
      zoomLevel: fitScale,
      zoomPercentText: '全览',
      zoomLevelRatioText: Math.round(fitScale * 100) + '%',
      timelineScrollLeft: 0,
    });
    this.refreshClipData();
    wx.showToast({ title: '已全览显示全部音频', icon: 'none' });
  },

  calcZoomScroll(nextScale) {
    const playheadSec = this.currentSourceTime || 0;
    const pxPerSec = Math.max(0.5, 36 * nextScale);
    const windowWidth = this.windowWidth || 375;
    const rpxRatio = 750 / windowWidth;
    const playheadRpx = playheadSec * pxPerSec;
    const viewportWidthRpx = 540;
    const targetScrollRpx = Math.max(0, playheadRpx - viewportWidthRpx * 0.35);
    const targetScrollPx = Math.round(targetScrollRpx / rpxRatio);
    this.timelineScrollLeft = targetScrollPx;
    return targetScrollPx;
  },

  cycleZoom() {
    const fitScale = this.calcFitScale();
    const levels = [fitScale, 0.5, 1.0, 2.0, 3.0]
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort((a, b) => a - b);
    const curr = this.data.zoomLevel || 1.0;
    let idx = levels.findIndex(l => Math.abs(l - curr) < 0.05);
    if (idx < 0) idx = 1;
    const next = levels[(idx + 1) % levels.length];
    const scrollPx = Math.abs(next - fitScale) < 0.02 ? 0 : this.calcZoomScroll(next);
    const isFit = Math.abs(next - fitScale) < 0.02;
    this.setData({
      zoomLevel: next,
      zoomPercentText: isFit ? '全览' : Math.round(next * 100) + '%',
      zoomLevelRatioText: Math.round(next * 100) + '%',
      timelineScrollLeft: scrollPx,
    });
    this.refreshClipData();
    wx.showToast({ title: isFit ? '全览视图' : `缩放 ${Math.round(next * 100)}%`, icon: 'none' });
  },

  zoomIn() {
    const curr = this.data.zoomLevel || 1.0;
    const fitScale = this.calcFitScale();
    const levels = [fitScale, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0]
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort((a, b) => a - b);
    let next = levels[levels.length - 1];
    for (let i = 0; i < levels.length; i++) {
      if (levels[i] > curr + 0.03) {
        next = levels[i];
        break;
      }
    }
    const scrollPx = this.calcZoomScroll(next);
    const isFit = Math.abs(next - fitScale) < 0.02;
    this.triggerZoomAnimation(next, isFit, scrollPx);
  },

  zoomOut() {
    const curr = this.data.zoomLevel || 1.0;
    const fitScale = this.calcFitScale();
    const levels = [fitScale, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0]
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort((a, b) => a - b);
    let next = levels[0];
    for (let i = levels.length - 1; i >= 0; i--) {
      if (levels[i] < curr - 0.03) {
        next = levels[i];
        break;
      }
    }
    const scrollPx = Math.abs(next - fitScale) < 0.02 ? 0 : this.calcZoomScroll(next);
    const isFit = Math.abs(next - fitScale) < 0.02;
    this.triggerZoomAnimation(next, isFit, scrollPx);
  },

  setZoomScale(e) {
    const scale = Number(e.currentTarget.dataset.scale);
    if (!isFinite(scale) || scale <= 0) return;
    const fitScale = this.calcFitScale();
    const scrollPx = Math.abs(scale - fitScale) < 0.02 ? 0 : this.calcZoomScroll(scale);
    const isFit = Math.abs(scale - fitScale) < 0.02;
    this.triggerZoomAnimation(scale, isFit, scrollPx);
  },

  triggerZoomAnimation(scale, isFit, scrollPx) {
    if (this._zoomAnimTimer) clearTimeout(this._zoomAnimTimer);
    this.setData({
      isZoomAnimating: true,
      zoomLevel: scale,
      zoomPercentText: isFit ? '全览' : Math.round(scale * 100) + '%',
      zoomLevelRatioText: Math.round(scale * 100) + '%',
      timelineScrollLeft: scrollPx,
    });
    this.refreshClipData();
    this._zoomAnimTimer = setTimeout(() => {
      this.setData({ isZoomAnimating: false });
    }, 380);
  },

  toggleInspectorExpanded() {
    this.setData({ isInspectorExpanded: !this.data.isInspectorExpanded });
  },

  addTrack() {
    if (!this.tracks) this.tracks = [];
    if (this.tracks.length >= 8) {
      wx.showToast({ title: '最多支持 8 条音轨', icon: 'none' });
      return;
    }
    this.pushUndo();
    const nextNum = this.tracks.length + 1;
    const colors = editorUtils.TRACK_COLORS || ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#E11D48', '#84CC16'];
    const color = colors[(nextNum - 1) % colors.length];
    const newTrack = {
      id: 'T' + nextNum + '_' + Date.now().toString(36).slice(-4),
      name: '音轨 ' + nextNum,
      color: color,
      tag: String(nextNum),
      mute: false,
      solo: false,
      volumeDb: 0,
    };
    this.tracks.push(newTrack);
    this._targetTrackId = newTrack.id;
    this.refreshClipData();
    haptics.impactLight();
    wx.showToast({ title: `已创建「${newTrack.name}」`, icon: 'none' });
  },

  deleteTrack(e) {
    const trackId = e.currentTarget.dataset.track;
    if (!trackId || this.tracks.length <= 1) {
      wx.showToast({ title: '至少保留 1 条音轨', icon: 'none' });
      return;
    }
    const trk = this.tracks.find(t => t.id === trackId);
    const trkName = trk ? trk.name : '该音轨';
    const hasClips = this.clips.some(c => c.trackId === trackId);
    if (hasClips) {
      wx.showModal({
        title: '删除音轨',
        content: `「${trkName}」上有音频，删除音轨将同时移除轨道上的音频片段，确定吗？`,
        success: (res) => {
          if (!res.confirm) return;
          this.pushUndo();
          if (this.trackAudioPool && this.trackAudioPool[trackId]) {
            try {
              this.trackAudioPool[trackId].stop();
              this.trackAudioPool[trackId].destroy();
            } catch (e) {}
            delete this.trackAudioPool[trackId];
          }
          this.clips = this.clips.filter(c => c.trackId !== trackId);
          this.tracks = this.tracks.filter(t => t.id !== trackId);
          this.selectedClipIndex = Math.max(0, Math.min(this.selectedClipIndex, this.clips.length - 1));
          this.refreshClipData();
          wx.showToast({ title: '已删除「' + trkName + '」', icon: 'none' });
        }
      });
      return;
    }
    this.pushUndo();
    if (this.trackAudioPool && this.trackAudioPool[trackId]) {
      try {
        this.trackAudioPool[trackId].stop();
        this.trackAudioPool[trackId].destroy();
      } catch (e) {}
      delete this.trackAudioPool[trackId];
    }
    this.tracks = this.tracks.filter(t => t.id !== trackId);
    this.refreshClipData();
    wx.showToast({ title: '已删除「' + trkName + '」', icon: 'none' });
  },

  addAudioToTrack(e) {
    const trackId = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.track) || (this.tracks[0] && this.tracks[0].id) || 'T1';
    this._targetTrackId = trackId;
    if (this.sources.length > 0 && this.sources.length < MAX_SOURCES) {
      wx.showActionSheet({
        itemList: ['从微信选择新音频', '复用已导入的音频'],
        success: (res) => {
          if (res.tapIndex === 0) {
            this.chooseAudioFiles();
          } else if (res.tapIndex === 1) {
            this.showReuseSourceSheet(trackId);
          }
        },
        fail: () => {}
      });
    } else {
      this.chooseAudioFiles();
    }
  },

  showReuseSourceSheet(trackId) {
    const names = this.sources.map(s => (s.name.length > 20 ? s.name.slice(0, 18) + '…' : s.name));
    wx.showActionSheet({
      itemList: names,
      success: (res) => {
        const source = this.sources[res.tapIndex];
        if (!source) return;
        this.pushUndo();
        const newClip = {
          id: this.makeClipId(),
          sourceId: source.id,
          in: 0,
          out: source.duration,
          fadeIn: 0,
          fadeOut: 0,
          trackId: trackId,
        };
        this.clips.push(newClip);
        this.selectedClipIndex = this.clips.length - 1;
        this.refreshClipData();
        wx.showToast({ title: `已拼入「${source.name}」`, icon: 'none' });
      }
    });
  },

  promptMoveClipToTrack() {
    const clip = this.getSelectedClip();
    if (!clip) return;
    const names = this.tracks.map(t => t.name + (t.id === clip.trackId ? ' (当前)' : ''));
    wx.showActionSheet({
      itemList: names,
      success: (res) => {
        const targetTrack = this.tracks[res.tapIndex];
        if (!targetTrack || targetTrack.id === clip.trackId) return;
        this.pushUndo();
        this.clips[this.selectedClipIndex].trackId = targetTrack.id;
        this.refreshClipData();
        wx.showToast({ title: `已移至 ${targetTrack.name}`, icon: 'none' });
      }
    });
  },

  moveClipEarlier() {
    this.moveClipUp();
  },

  moveClipLater() {
    this.moveClipDown();
  },

  seekToZero() {
    this.stopPlayback();
    const clip = this.getSelectedClip();
    this.currentSourceTime = clip ? clip.in : 0;
    this.setData({ currentTimeText: editorUtils.formatPrecise(this.currentSourceTime) });
    this.drawWave();
  },

  alignClipToPlayhead() {
    const clip = this.getSelectedClip();
    if (!clip) return;
    this.pushUndo();
    const targetTime = editorUtils.round3(this.currentSourceTime || 0);
    this.clips[this.selectedClipIndex].offsetSec = targetTime;
    this.refreshClipData();
    wx.showToast({ title: `已对齐至 ${editorUtils.formatPrecise(targetTime)}`, icon: 'none' });
  },

  // ==========================================
  // 双指缩放核心手势（向内缩小向外放大 Pinch to Zoom）与多指互斥锁
  // ==========================================
  onTimelineTouchStart(e) {
    this._userIsTouchingTimeline = true;
    if (e.touches && e.touches.length >= 2) {
      this._isPinching = true;
      this._gestureLock = 'pinch';
      if (this._isDraggingClip) {
        this._isDraggingClip = false;
        this.setData({ isDraggingClip: false, dragClipIndex: null, dragTipText: '' });
      }
      if (this._isTrimming) {
        this._isTrimming = false;
        this.setData({ isTrimmingClip: false, trimType: '', trimTipText: '' });
      }
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      this._pinchStartDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      this._pinchStartScale = this.data.zoomLevel || 1.0;
      this._lastPinchApplyTime = 0;

      // 记录双指几何中心点对应的音轨时间戳（秒），保证缩放时中心锚点稳定不漂移
      const windowWidth = this.windowWidth || 375;
      const headerPx = 170 * (windowWidth / 750);
      const scrollPx = this.timelineScrollLeft || 0;
      const midClientX = (t1.clientX + t2.clientX) / 2;
      const midTimelinePx = Math.max(0, midClientX - headerPx + scrollPx);
      const midTimelineRpx = midTimelinePx * (750 / windowWidth);
      const pxPerSec = Math.max(0.5, 36 * this._pinchStartScale);
      this._pinchCenterSec = editorUtils.round3(midTimelineRpx / pxPerSec);
    }
  },

  onTimelineTouchMove(e) {
    if (e.touches && e.touches.length >= 2) {
      if (!this._isPinching || !this._pinchStartDist) {
        this.onTimelineTouchStart(e);
        return;
      }
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const currentDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      if (this._pinchStartDist > 5) {
        // 双指外扩 currentDist > startDist -> ratio > 1 -> 放大
        // 双指内捏 currentDist < startDist -> ratio < 1 -> 缩小
        const ratio = currentDist / this._pinchStartDist;
        let targetScale = this._pinchStartScale * ratio;
        const fitScale = this.calcFitScale();
        // 范围限制：最小全览 (fitScale)，最大 4.0x
        targetScale = Math.max(fitScale, Math.min(4.0, targetScale));
        targetScale = Math.round(targetScale * 100) / 100;

        const now = Date.now();
        if (now - (this._lastPinchApplyTime || 0) > 16 && Math.abs(targetScale - (this.data.zoomLevel || 1.0)) >= 0.01) {
          this._lastPinchApplyTime = now;
          const isFit = Math.abs(targetScale - fitScale) < 0.02;

          let scrollPx = 0;
          if (!isFit) {
            const windowWidth = this.windowWidth || 375;
            const rpxRatio = 750 / windowWidth;
            const headerPx = 170 * (windowWidth / 750);
            const midClientX = (t1.clientX + t2.clientX) / 2;
            const nextPxPerSec = Math.max(0.5, 36 * targetScale);
            const centerSec = typeof this._pinchCenterSec === 'number' ? this._pinchCenterSec : (this.currentSourceTime || 0);
            const targetCenterRpx = centerSec * nextPxPerSec;
            const targetCenterPx = targetCenterRpx / rpxRatio;
            const targetScrollPx = Math.max(0, Math.round(targetCenterPx - (midClientX - headerPx)));
            scrollPx = targetScrollPx;
            this.timelineScrollLeft = scrollPx;
          }

          const zoomPercentText = isFit ? '全览' : Math.round(targetScale * 100) + '%';
          const directionText = isFit
            ? '全览 (已缩至最小)'
            : targetScale >= 4.0
            ? '400% (已放大至最大)'
            : ratio > 1.02
            ? `${zoomPercentText} · 向外放大`
            : ratio < 0.98
            ? `${zoomPercentText} · 向内缩小`
            : `${zoomPercentText}`;

          // 双指缩放进行中：采用轻量级波形数据，彻底避免生成上千 DOM 节点造成掉帧
          const timelineData = editorUtils.buildTimelineData(
            this.tracks,
            this.clips,
            this.sources,
            targetScale,
            this.selectedClipIndex,
            this.currentSourceTime,
            { isPinching: true }
          );

          // 单次合并提交，手势中途不触发 Canvas 重绘与重复跨线程通讯，保障 60FPS 丝滑跟手
          this.setData({
            zoomLevel: targetScale,
            zoomPercentText: zoomPercentText,
            zoomLevelRatioText: zoomPercentText,
            timelineScrollLeft: scrollPx,
            isPinchingTimeline: true,
            pinchTipText: `🔍 ${directionText}`,
            timelineData: timelineData,
            trackViews: timelineData.tracks,
          });
        }
      }
    }
  },

  onTimelineTouchEnd(e) {
    this._userIsTouchingTimeline = false;
    if (this._isPinching) {
      if (!e.touches || e.touches.length < 2) {
        this._isPinching = false;
        this._pinchStartDist = 0;
        this._pinchCenterSec = null;
        this.setData({ isPinchingTimeline: false, pinchTipText: '' });
        // 手指抬起后执行一次完整精细刷新，平滑呈现高精细度波形并同步 Canvas
        this.refreshClipData();
        setTimeout(() => {
          this._gestureLock = 'none';
        }, 80);
      }
    }
  },

  onClipTouchStart(e) {
    if (e.touches && e.touches.length >= 2) {
      this.onTimelineTouchStart(e);
      return;
    }
    if (this._isPinching || this._gestureLock === 'pinch') return;
    if (this.data.activeTool === 'razor') {
      this._isDraggingClip = false;
      this._dragClipIndex = null;
      return;
    }
    const index = Number(e.currentTarget.dataset.index);
    if (!isFinite(index) || index < 0 || index >= this.clips.length) return;
    this._dragClipIndex = index;
    const touch = (e.touches && e.touches[0]) || {};
    this._dragStartX = touch.clientX || 0;
    this._dragStartY = touch.clientY || 0;
    this._dragStartTime = Date.now();
    const clip = this.clips[index];
    this._dragStartOffset = (clip && typeof clip.offsetSec === 'number') ? clip.offsetSec : 0;
    this._finalOffsetSec = this._dragStartOffset;
    this._isDraggingClip = false;
    this._lastSnappedState = false;
  },

  onClipTouchMove(e) {
    if (this._isPinching || (e.touches && e.touches.length >= 2)) {
      if (!this._isPinching) {
        this.onTimelineTouchStart(e);
      }
      this.onTimelineTouchMove(e);
      return;
    }
    if (this._gestureLock === 'pinch') return;
    if (this.data.activeTool === 'razor') return;
    if (this._dragClipIndex === undefined || this._dragClipIndex === null) return;
    const touch = (e.touches && e.touches[0]) || {};
    const deltaX = (touch.clientX || 0) - this._dragStartX;
    const deltaY = (touch.clientY || 0) - this._dragStartY;

    if (!this._isDraggingClip) {
      // 竖向滑动优先判定：防止用户滑动页面时误触发音频片段位移
      if (Math.abs(deltaY) > Math.abs(deltaX)) return;
      // 拖拽启动阈值：位移需达到 10px，确保点击选择时不误触发拖动
      if (Math.abs(deltaX) > 10) {
        this._isDraggingClip = true;
        this._gestureLock = 'drag';
        // 关键优化：轻量选中当前片段，绝不调用重型 selectClip()，杜绝重算 DOM 掉帧与指针被强行跳回
        if (this.selectedClipIndex !== this._dragClipIndex) {
          this.selectedClipIndex = this._dragClipIndex;
          this.syncWaveSource();
        }
        haptics.impactLight();
      }
    }
    if (!this._isDraggingClip) return;

    const pxPerSec = (this.data.timelineData && this.data.timelineData.pxPerSec) || 36;
    const windowWidth = this.windowWidth || 375;
    const deltaRpx = deltaX * (750 / windowWidth);
    const deltaSec = deltaRpx / pxPerSec;
    let nextOffset = Math.max(0, editorUtils.round3(this._dragStartOffset + deltaSec));

    const playhead = this.currentSourceTime || 0;
    const dragClip = this.clips[this._dragClipIndex];
    const clipDur = editorUtils.clipDuration(dragClip);
    const dragTrackId = (dragClip && dragClip.trackId) || (this.tracks[0] && this.tracks[0].id) || 'T1';

    // 收集同轨上其他相邻片段的起止边界用于磁吸
    const sameTrackClips = [];
    if (this.data.timelineData && this.data.timelineData.tracks) {
      const trk = this.data.timelineData.tracks.find(t => t.id === dragTrackId);
      if (trk && trk.clips) {
        trk.clips.forEach(c => {
          if (c.index !== this._dragClipIndex) {
            sameTrackClips.push({
              start: c.timelineStartSec,
              end: c.timelineEndSec,
              name: c.sourceName || '相邻片段',
            });
          }
        });
      }
    }

    let isSnapped = false;
    let snapLabel = '';
    const snapThreshold = 0.25;

    // 1. 优先磁吸同轨相邻片段边缘（缝隙贴合与前后衔接）
    for (let i = 0; i < sameTrackClips.length; i++) {
      const oc = sameTrackClips[i];
      if (Math.abs(nextOffset - oc.end) < snapThreshold) {
        nextOffset = oc.end;
        isSnapped = true;
        snapLabel = `🧲贴合「${oc.name}」尾部`;
        break;
      }
      if (Math.abs(nextOffset + clipDur - oc.start) < snapThreshold) {
        nextOffset = Math.max(0, editorUtils.round3(oc.start - clipDur));
        isSnapped = true;
        snapLabel = `🧲贴合「${oc.name}」头部`;
        break;
      }
    }

    // 2. 磁吸播放指针 (CTI)
    if (!isSnapped) {
      if (Math.abs(nextOffset - playhead) < snapThreshold) {
        nextOffset = playhead;
        isSnapped = true;
        snapLabel = '🧲对齐播放光标';
      } else if (Math.abs(nextOffset + clipDur - playhead) < snapThreshold) {
        nextOffset = Math.max(0, editorUtils.round3(playhead - clipDur));
        isSnapped = true;
        snapLabel = '🧲尾对齐光标';
      }
    }

    // 3. 磁吸 0s 轨道原点
    if (!isSnapped && nextOffset < 0.2) {
      nextOffset = 0;
      isSnapped = true;
      snapLabel = '🧲对齐轨道起点';
    }

    if (isSnapped && !this._lastSnappedState) {
      haptics.impactMedium();
    }
    this._lastSnappedState = isSnapped;
    this._finalOffsetSec = nextOffset;

    // 毫秒级直接计算视觉 leftRpx，轻量更新位置，彻底摆脱 refreshClipData 的桥接阻塞
    const dragLeftRpx = Math.round(nextOffset * pxPerSec);

    const now = Date.now();
    if (!this._lastDragUpdate || now - this._lastDragUpdate > 20) {
      this._lastDragUpdate = now;
      const src = dragClip && this.sources.find(s => s.id === dragClip.sourceId);
      const name = src ? src.name : '片段';
      const shortName = name.length > 7 ? name.slice(0, 6) + '…' : name;
      this.setData({
        isDraggingClip: true,
        dragClipIndex: this._dragClipIndex,
        dragClipLeftRpx: dragLeftRpx,
        dragTipText: `${shortName} 移至 ${editorUtils.formatPrecise(nextOffset)}${isSnapped ? ` (${snapLabel})` : ''}`,
      });
    }
  },

  onClipTouchEnd(e) {
    if (this._isPinching) {
      this.onTimelineTouchEnd(e);
      return;
    }
    if (this._isDraggingClip) {
      this._isDraggingClip = false;
      this._gestureLock = 'none';
      this._justFinishedDragging = true;
      // 100ms 后自动清除防点击拦截锁，防止某些机型未触发 tap 事件导致后续点击被吞
      setTimeout(() => {
        this._justFinishedDragging = false;
      }, 100);

      const clip = this.clips[this._dragClipIndex];
      const hasMoved = clip && typeof this._finalOffsetSec === 'number' && Math.abs((clip.offsetSec || 0) - this._finalOffsetSec) > 0.01;
      if (hasMoved && clip) {
        this.pushUndo();
        this.stopPlaybackAudioOnly();
        this.playback = null;
        this.paused = false;
        this.isMultiTrackPlaying = false;
        clip.offsetSec = this._finalOffsetSec;

        // 自动重叠下移防护：切开重叠或移动碰撞后，自动将后一段🎵下移至下一音轨
        const shiftRes = editorUtils.shiftOverlappingClipsToNextTrack(this.tracks, this.clips);
        if (shiftRes.shifted) {
          this.tracks = shiftRes.tracks;
          this.clips = shiftRes.clips;
          const trk = this.tracks.find(t => t.id === (shiftRes.movedInfo && shiftRes.movedInfo.targetTrackId));
          wx.showToast({
            title: `🎵 后一段已自动下移至「${trk ? trk.name : '下一音轨'}」`,
            icon: 'none'
          });
        }
      }
      this.refreshClipData();
      this.setData({
        isDraggingClip: false,
        dragClipIndex: null,
        dragTipText: '',
      });
      if (hasMoved) {
        haptics.impactLight();
      }
    }
    this._dragClipIndex = null;
    this._lastSnappedState = false;
    this._gestureLock = 'none';
  },

  onTrimInTouchStart(e) {
    if (e.touches && e.touches.length >= 2) {
      this.onTimelineTouchStart(e);
      return;
    }
    if (this._isPinching || this._gestureLock === 'pinch') return;
    const clip = this.getSelectedClip();
    if (!clip) return;
    const touch = (e.touches && e.touches[0]) || {};
    this._trimStartX = touch.clientX || 0;
    this._trimStartIn = clip.in;
    this._trimStartOffset = (typeof clip.offsetSec === 'number') ? clip.offsetSec : 0;
    this._trimClipOut = clip.out;
    this._trimClipIndex = this.selectedClipIndex;
    this._isTrimming = false;
    this._trimType = 'in';
    this._lastSnappedState = false;
    this._lastTrimUpdate = 0;
  },

  onTrimInTouchMove(e) {
    if (this._isPinching || (e.touches && e.touches.length >= 2)) {
      this._isTrimming = false;
      this.setData({ isTrimmingClip: false, trimType: '', trimTipText: '' });
      if (!this._isPinching) {
        this.onTimelineTouchStart(e);
      }
      this.onTimelineTouchMove(e);
      return;
    }
    if (this._gestureLock === 'pinch') return;
    if (this._trimClipIndex === undefined || this._trimClipIndex === null) return;
    const touch = (e.touches && e.touches[0]) || {};
    const deltaX = (touch.clientX || 0) - this._trimStartX;
    const wasTrimming = this._isTrimming;
    if (!this._isTrimming && Math.abs(deltaX) > 4) {
      this._isTrimming = true;
    }
    if (!this._isTrimming) return;

    const pxPerSec = (this.data.timelineData && this.data.timelineData.pxPerSec) || 36;
    const windowWidth = this.windowWidth || 375;
    const deltaRpx = deltaX * (750 / windowWidth);
    const deltaSec = deltaRpx / pxPerSec;

    const maxIn = this._trimClipOut - editorUtils.MIN_CLIP_DURATION;
    let nextIn = Math.min(maxIn, Math.max(0, editorUtils.round3(this._trimStartIn + deltaSec)));

    const actualDeltaIn = nextIn - this._trimStartIn;
    let nextOffset = Math.max(0, editorUtils.round3(this._trimStartOffset + actualDeltaIn));

    // 收集同轨上其他相邻片段的起止边界用于磁吸
    const sameTrackClips = [];
    const clip = this.clips[this._trimClipIndex];
    const dragTrackId = (clip && clip.trackId) || (this.tracks[0] && this.tracks[0].id) || 'T1';
    if (this.data.timelineData && this.data.timelineData.tracks) {
      const trk = this.data.timelineData.tracks.find(t => t.id === dragTrackId);
      if (trk && trk.clips) {
        trk.clips.forEach(c => {
          if (c.index !== this._trimClipIndex) {
            sameTrackClips.push({
              start: c.timelineStartSec,
              end: c.timelineEndSec,
              name: c.sourceName || '相邻片段',
            });
          }
        });
      }
    }

    // 智能磁吸对齐（靠近前一段尾部、0s 或 播放光标）
    const playhead = this.currentSourceTime || 0;
    let isSnapped = false;

    for (let i = 0; i < sameTrackClips.length; i++) {
      const oc = sameTrackClips[i];
      if (Math.abs(nextOffset - oc.end) < 0.2) {
        const snapOffsetDelta = oc.end - this._trimStartOffset;
        const snappedIn = this._trimStartIn + snapOffsetDelta;
        if (snappedIn >= 0 && snappedIn <= maxIn) {
          nextIn = editorUtils.round3(snappedIn);
          nextOffset = oc.end;
          isSnapped = true;
          break;
        }
      }
    }

    if (!isSnapped) {
      if (Math.abs(nextOffset - playhead) < 0.2) {
        const snapOffsetDelta = playhead - this._trimStartOffset;
        const snappedIn = this._trimStartIn + snapOffsetDelta;
        if (snappedIn >= 0 && snappedIn <= maxIn) {
          nextIn = editorUtils.round3(snappedIn);
          nextOffset = playhead;
          isSnapped = true;
        }
      } else if (nextOffset < 0.15) {
        const snapOffsetDelta = 0 - this._trimStartOffset;
        const snappedIn = this._trimStartIn + snapOffsetDelta;
        if (snappedIn >= 0 && snappedIn <= maxIn) {
          nextIn = editorUtils.round3(snappedIn);
          nextOffset = 0;
          isSnapped = true;
        }
      }
    }

    if (isSnapped && !this._lastSnappedState) {
      haptics.impactMedium();
    }
    this._lastSnappedState = isSnapped;
    this._finalTrimIn = nextIn;
    this._finalTrimOffset = nextOffset;

    const nextDur = editorUtils.round3(this._trimClipOut - nextIn);
    const trimLeftRpx = Math.round(nextOffset * pxPerSec);
    const trimWidthRpx = Math.max(28, Math.round(nextDur * pxPerSec));

    const now = Date.now();
    if (!wasTrimming || !this._lastTrimUpdate || now - this._lastTrimUpdate > 20) {
      this._lastTrimUpdate = now;
      this.setData({
        isTrimmingClip: true,
        trimType: 'in',
        trimLeftRpx: trimLeftRpx,
        trimWidthRpx: trimWidthRpx,
        trimTipText: `📍 入点: ${editorUtils.formatPrecise(nextIn)} (时长: ${editorUtils.formatPrecise(nextDur)})${isSnapped ? ' 🧲磁吸' : ''}`,
      });
    }
  },

  onTrimInTouchEnd(e) {
    if (this._isPinching) {
      this.onTimelineTouchEnd(e);
      return;
    }
    if (this._isTrimming) {
      this._isTrimming = false;
      this._gestureLock = 'none';
      this._justFinishedTrimming = true;
      setTimeout(() => {
        this._justFinishedTrimming = false;
      }, 100);
      if (typeof this._finalTrimIn === 'number' && this._trimClipIndex !== null) {
        const clip = this.clips[this._trimClipIndex];
        if (clip) {
          const changed = clip.in !== this._finalTrimIn || clip.offsetSec !== this._finalTrimOffset;
          if (changed) {
            this.pushUndo();
            this.stopPlaybackAudioOnly();
            this.playback = null;
            this.paused = false;
            this.isMultiTrackPlaying = false;
            clip.in = this._finalTrimIn;
            if (typeof this._finalTrimOffset === 'number') {
              clip.offsetSec = this._finalTrimOffset;
            }
            if (this.selectedClipIndex === this._trimClipIndex) {
              this.currentSourceTime = clip.in;
            }
            const shiftRes = editorUtils.shiftOverlappingClipsToNextTrack(this.tracks, this.clips);
            if (shiftRes.shifted) {
              this.tracks = shiftRes.tracks;
              this.clips = shiftRes.clips;
            }
            this.refreshClipData();
            this.drawWave();
          }
        }
      }
      this.setData({
        isTrimmingClip: false,
        trimType: '',
        trimTipText: '',
      });
      haptics.impactLight();
    }
    this._trimClipIndex = null;
    this._lastSnappedState = false;
    this._gestureLock = 'none';
  },

  onTrimOutTouchStart(e) {
    if (e.touches && e.touches.length >= 2) {
      this.onTimelineTouchStart(e);
      return;
    }
    if (this._isPinching || this._gestureLock === 'pinch') return;
    const clip = this.getSelectedClip();
    if (!clip) return;
    const touch = (e.touches && e.touches[0]) || {};
    this._trimStartX = touch.clientX || 0;
    this._trimStartOut = clip.out;
    this._trimClipIn = clip.in;
    this._trimClipOffset = (typeof clip.offsetSec === 'number') ? clip.offsetSec : 0;
    this._trimClipIndex = this.selectedClipIndex;
    const source = this.sources.find(s => s.id === clip.sourceId);
    this._trimSourceDuration = (source && source.duration) || 600;
    this._isTrimming = false;
    this._trimType = 'out';
    this._lastSnappedState = false;
    this._lastTrimUpdate = 0;
  },

  onTrimOutTouchMove(e) {
    if (this._isPinching || (e.touches && e.touches.length >= 2)) {
      this._isTrimming = false;
      this.setData({ isTrimmingClip: false, trimType: '', trimTipText: '' });
      if (!this._isPinching) {
        this.onTimelineTouchStart(e);
      }
      this.onTimelineTouchMove(e);
      return;
    }
    if (this._gestureLock === 'pinch') return;
    if (this._trimClipIndex === undefined || this._trimClipIndex === null) return;
    const touch = (e.touches && e.touches[0]) || {};
    const deltaX = (touch.clientX || 0) - this._trimStartX;
    const wasTrimming = this._isTrimming;
    if (!this._isTrimming && Math.abs(deltaX) > 4) {
      this._isTrimming = true;
      this._gestureLock = 'trim';
    }
    if (!this._isTrimming) return;

    const pxPerSec = (this.data.timelineData && this.data.timelineData.pxPerSec) || 36;
    const windowWidth = this.windowWidth || 375;
    const deltaRpx = deltaX * (750 / windowWidth);
    const deltaSec = deltaRpx / pxPerSec;

    const minOut = this._trimClipIn + editorUtils.MIN_CLIP_DURATION;
    const maxOut = this._trimSourceDuration;
    let nextOut = Math.max(minOut, Math.min(maxOut, editorUtils.round3(this._trimStartOut + deltaSec)));

    const clipEndTimeline = this._trimClipOffset + (nextOut - this._trimClipIn);
    const playhead = this.currentSourceTime || 0;
    let isSnapped = false;

    // 收集同轨上其他相邻片段的起止边界用于磁吸
    const sameTrackClips = [];
    const clip = this.clips[this._trimClipIndex];
    const dragTrackId = (clip && clip.trackId) || (this.tracks[0] && this.tracks[0].id) || 'T1';
    if (this.data.timelineData && this.data.timelineData.tracks) {
      const trk = this.data.timelineData.tracks.find(t => t.id === dragTrackId);
      if (trk && trk.clips) {
        trk.clips.forEach(c => {
          if (c.index !== this._trimClipIndex) {
            sameTrackClips.push({
              start: c.timelineStartSec,
              end: c.timelineEndSec,
              name: c.sourceName || '相邻片段',
            });
          }
        });
      }
    }

    // 优先贴合后一段头部
    for (let i = 0; i < sameTrackClips.length; i++) {
      const oc = sameTrackClips[i];
      if (Math.abs(clipEndTimeline - oc.start) < 0.2) {
        const snappedDuration = oc.start - this._trimClipOffset;
        const snappedOut = this._trimClipIn + snappedDuration;
        if (snappedOut >= minOut && snappedOut <= maxOut) {
          nextOut = editorUtils.round3(snappedOut);
          isSnapped = true;
          break;
        }
      }
    }

    if (!isSnapped && Math.abs(clipEndTimeline - playhead) < 0.2) {
      const snappedDuration = playhead - this._trimClipOffset;
      const snappedOut = this._trimClipIn + snappedDuration;
      if (snappedOut >= minOut && snappedOut <= maxOut) {
        nextOut = editorUtils.round3(snappedOut);
        isSnapped = true;
      }
    }

    if (isSnapped && !this._lastSnappedState) {
      haptics.impactMedium();
    }
    this._lastSnappedState = isSnapped;
    this._finalTrimOut = nextOut;

    const nextDur = editorUtils.round3(nextOut - this._trimClipIn);
    const trimWidthRpx = Math.max(28, Math.round(nextDur * pxPerSec));

    const now = Date.now();
    if (!wasTrimming || !this._lastTrimUpdate || now - this._lastTrimUpdate > 20) {
      this._lastTrimUpdate = now;
      this.setData({
        isTrimmingClip: true,
        trimType: 'out',
        trimWidthRpx: trimWidthRpx,
        trimTipText: `📍 出点: ${editorUtils.formatPrecise(nextOut)} (时长: ${editorUtils.formatPrecise(nextDur)})${isSnapped ? ' 🧲磁吸' : ''}`,
      });
    }
  },

  onTrimOutTouchEnd(e) {
    if (this._isPinching) {
      this.onTimelineTouchEnd(e);
      return;
    }
    if (this._isTrimming) {
      this._isTrimming = false;
      this._gestureLock = 'none';
      this._justFinishedTrimming = true;
      setTimeout(() => {
        this._justFinishedTrimming = false;
      }, 100);
      if (typeof this._finalTrimOut === 'number' && this._trimClipIndex !== null) {
        const clip = this.clips[this._trimClipIndex];
        if (clip) {
          const changed = clip.out !== this._finalTrimOut;
          if (changed) {
            this.pushUndo();
            this.stopPlaybackAudioOnly();
            this.playback = null;
            this.paused = false;
            this.isMultiTrackPlaying = false;
            clip.out = this._finalTrimOut;
            const shiftRes = editorUtils.shiftOverlappingClipsToNextTrack(this.tracks, this.clips);
            if (shiftRes.shifted) {
              this.tracks = shiftRes.tracks;
              this.clips = shiftRes.clips;
            }
            this.refreshClipData();
            this.drawWave();
          }
        }
      }
      this.setData({
        isTrimmingClip: false,
        trimType: '',
        trimTipText: '',
      });
      haptics.impactLight();
    }
    this._trimClipIndex = null;
    this._lastSnappedState = false;
    this._gestureLock = 'none';
  },

  /**
   * 一键顺延对齐同轨重叠片段（消除碰撞重叠，实现无缝对接）
   */
  autoStaggerOverlap() {
    const clip = this.getSelectedClip();
    if (!clip) return;
    const trackId = clip.trackId || (this.tracks[0] && this.tracks[0].id) || 'T1';

    const trackClips = [];
    if (this.data.timelineData && this.data.timelineData.tracks) {
      const trk = this.data.timelineData.tracks.find(t => t.id === trackId);
      if (trk && trk.clips) {
        trackClips.push(...trk.clips);
      }
    }
    trackClips.sort((a, b) => a.timelineStartSec - b.timelineStartSec);

    const currentTrackIndex = trackClips.findIndex(c => c.index === this.selectedClipIndex);
    if (currentTrackIndex > 0) {
      const prevClip = trackClips[currentTrackIndex - 1];
      this.pushUndo();
      this.clips[this.selectedClipIndex].offsetSec = prevClip.timelineEndSec;
      this.refreshClipData();
      haptics.impactMedium();
      wx.showToast({ title: '已顺延对齐，消除重叠 ✅', icon: 'success' });
    } else if (trackClips.length > 1) {
      const nextClip = trackClips[1];
      this.pushUndo();
      this.clips[nextClip.index].offsetSec = trackClips[0].timelineEndSec;
      this.refreshClipData();
      haptics.impactMedium();
      wx.showToast({ title: '已顺延后续片段，消除重叠 ✅', icon: 'success' });
    }
  },

  /**
   * 一键将重叠片段移至新音轨（独立混音，双轨并行）
   */
  moveOverlapToNewTrack() {
    const clip = this.getSelectedClip();
    if (!clip) return;

    // 优先采用全局同轨重叠下移算法
    const shiftRes = editorUtils.shiftOverlappingClipsToNextTrack(this.tracks, this.clips);
    if (shiftRes.shifted) {
      this.pushUndo();
      this.stopPlaybackAudioOnly();
      this.playback = null;
      this.paused = false;
      this.isMultiTrackPlaying = false;
      this.tracks = shiftRes.tracks;
      this.clips = shiftRes.clips;
      this.refreshClipData();
      const trk = this.tracks.find(t => t.id === (shiftRes.movedInfo && shiftRes.movedInfo.targetTrackId));
      haptics.impactMedium();
      wx.showToast({ title: `🎵 已将后一段下移至「${trk ? trk.name : '下一音轨'}」✅`, icon: 'success' });
      return;
    }

    const currentTrackId = clip.trackId || (this.tracks[0] && this.tracks[0].id) || 'T1';
    const clipDur = editorUtils.clipDuration(clip);
    const startSec = typeof clip.offsetSec === 'number' ? clip.offsetSec : 0;
    const endSec = editorUtils.round3(startSec + clipDur);

    // 优先寻找现存音轨中在 [startSec, endSec] 无冲突的音轨
    let candidateTrackId = null;
    for (let i = 0; i < this.tracks.length; i++) {
      const tid = this.tracks[i].id;
      if (tid === currentTrackId) continue;
      const clipsOnTrack = this.clips.filter((c, idx) => idx !== this.selectedClipIndex && (c.trackId || 'T1') === tid);
      let conflict = false;
      for (let j = 0; j < clipsOnTrack.length; j++) {
        const oc = clipsOnTrack[j];
        const oStart = typeof oc.offsetSec === 'number' ? oc.offsetSec : 0;
        const oEnd = editorUtils.round3(oStart + editorUtils.clipDuration(oc));
        if (Math.max(startSec, oStart) < Math.min(endSec, oEnd) - 0.05) {
          conflict = true;
          break;
        }
      }
      if (!conflict) {
        candidateTrackId = tid;
        break;
      }
    }

    if (candidateTrackId) {
      this.pushUndo();
      this.stopPlaybackAudioOnly();
      this.playback = null;
      this.paused = false;
      this.isMultiTrackPlaying = false;
      this.clips[this.selectedClipIndex].trackId = candidateTrackId;
      this.clips[this.selectedClipIndex].isDuplicate = true;
      this.refreshClipData();
      const trk = this.tracks.find(t => t.id === candidateTrackId);
      haptics.impactMedium();
      wx.showToast({ title: `🎵 已移至「${trk ? trk.name : candidateTrackId}」独立混音 ✅`, icon: 'success' });
      return;
    }

    if (this.tracks.length >= 6) {
      wx.showToast({ title: '已达音轨数量上限 (6条)，请手动错开时间', icon: 'none' });
      return;
    }

    const nextTrackNum = this.tracks.length + 1;
    const newTrack = {
      id: 'T' + nextTrackNum,
      name: '音轨 ' + nextTrackNum,
      color: editorUtils.TRACK_COLORS[nextTrackNum - 1] || '#8B5CF6',
      tag: String(nextTrackNum),
      mute: false,
      solo: false,
      volumeDb: 0,
    };
    this.pushUndo();
    this.stopPlaybackAudioOnly();
    this.playback = null;
    this.paused = false;
    this.isMultiTrackPlaying = false;
    this.tracks.push(newTrack);
    this.clips[this.selectedClipIndex].trackId = newTrack.id;
    this.clips[this.selectedClipIndex].isDuplicate = true;
    this.refreshClipData();
    haptics.impactMedium();
    wx.showToast({ title: `🎵 已新建「${newTrack.name}」并移入独立混音 ✅`, icon: 'success' });
  },

  onTrackClipTap(e) {
    if (this._justFinishedDragging) {
      this._justFinishedDragging = false;
      return;
    }
    const index = Number(e.currentTarget.dataset.index);
    if (!isFinite(index) || index < 0 || index >= this.clips.length) return;
    const clip = this.clips[index];
    if (!clip) return;

    // 触点时间精确解算：根据用户手指点按的实际位置计算对应的音频时间戳
    let targetSourceTime = null;
    if (e && e.detail && typeof e.detail.x === 'number') {
      const windowWidth = this.windowWidth || 375;
      const headerPx = 170 * (windowWidth / 750);
      const scrollPx = this.timelineScrollLeft || 0;
      const relativePx = Math.max(0, e.detail.x - headerPx + scrollPx);
      const relativeRpx = relativePx * (750 / windowWidth);
      const pxPerSec = (this.data.timelineData && this.data.timelineData.pxPerSec) || 36;
      const touchSecOnTimeline = relativeRpx / pxPerSec;
      const offsetSec = typeof clip.offsetSec === 'number' ? clip.offsetSec : 0;
      const deltaSec = touchSecOnTimeline - offsetSec;
      targetSourceTime = editorUtils.clampNumber(editorUtils.round3(clip.in + deltaSec), clip.in, clip.out);
    }

    if (this.data.activeTool === 'razor') {
      this.selectClip(index, targetSourceTime);
      const minDur = editorUtils.MIN_CLIP_DURATION || 0.2;
      if (typeof targetSourceTime === 'number' && targetSourceTime >= clip.in + minDur && targetSourceTime <= clip.out - minDur) {
        this.executeRazorCutAtTime(clip, targetSourceTime);
      } else {
        // 如果点在边缘或未提供坐标，以播放红针或正中进行剪断
        this.splitSelectedClipAtPlayhead();
      }
    } else {
      // 触控点击精准寻位与选中：
      // 1. 选中该片段，高亮显示；
      // 2. 将播放光标与底层音频指针精准定位至用户点击的声波位置（绝不再生硬倒退至片段开头！）；
      // 3. 伴随轻柔物理微震动反馈。
      this.selectClip(index, targetSourceTime);
      haptics.impactLight();
    }
  },

  switchInspectorTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab) {
      this.setData({ inspectorTab: tab });
      haptics.impactLight();
    }
  },

  setClipTrack(e) {
    const trackId = e.currentTarget.dataset.track;
    if (!trackId) return;
    const clip = this.getSelectedClip();
    if (!clip) return;
    this.pushUndo();
    this.clips[this.selectedClipIndex].trackId = trackId;
    this.refreshClipData();
    const trk = this.tracks.find(t => t.id === trackId);
    wx.showToast({ title: `已分配至 ${trk ? trk.name : trackId}`, icon: 'none' });
  },

  setClipSpeed(e) {
    const val = Number(e.currentTarget.dataset.value);
    if (!val || !isFinite(val)) return;
    const clip = this.getSelectedClip();
    if (!clip) return;
    this.pushUndo();

    // 更新片段倍速
    this.clips[this.selectedClipIndex].speed = val;

    // 若当前正在播放，热更新播放速率，平滑过渡而不中断或倒退至开头！
    if (this.data.isPlaying) {
      const currentSource = this.currentSourceTime;
      this._playbackSpeed = val;

      if (this.sourceAudio) {
        try {
          this.sourceAudio.startTime = currentSource;
          if (typeof this.sourceAudio.playbackRate !== 'undefined') {
            this.sourceAudio.playbackRate = val;
          }
          this.sourceAudio.seek(currentSource);
        } catch (e) {}
      }

      if (this.trackAudioPool) {
        Object.keys(this.trackAudioPool).forEach(id => {
          const a = this.trackAudioPool[id];
          if (a) {
            try {
              if (typeof a.playbackRate !== 'undefined') {
                a.playbackRate = val;
              }
            } catch (e) {}
          }
        });
      }

      if (this.playback) {
        const built = editorUtils.buildPreviewQueue(this.clips, this.sources);
        if (built.ok) {
          this.playback.queue = built.queue;
        }
        const newTimelinePos = editorUtils.queueOutputPosition(this.playback.queue, this.playback.index, currentSource);
        this._playbackWallStart = Date.now();
        this._playbackStartSourceTime = currentSource;
        this._playbackStartTimelineSec = newTimelinePos;
        this._lastDisplayTime = null;
      }

      if (this.isMultiTrackPlaying) {
        this.multiTrackWallStartTime = Date.now();
        this.multiTrackStartTimelineSec = this.currentSourceTime;
      }
    }

    this.refreshClipData();
    haptics.impactLight();
    wx.showToast({ title: `变速已设为 ${val}x`, icon: 'none' });
  },

  setClipEq(e) {
    const preset = e.currentTarget.dataset.preset;
    if (!preset) return;
    const clip = this.getSelectedClip();
    if (!clip) return;
    this.pushUndo();
    this.clips[this.selectedClipIndex].eqPreset = preset;
    if (this.playback && this.playback.queue) {
      this.playback.queue.forEach(item => {
        if (item.clipId === clip.id) item.eqPreset = preset;
      });
    }
    this.refreshClipData();
    haptics.impactLight();
    const info = editorUtils.getEqPreset(preset);
    wx.showToast({ title: `均衡器：${info ? info.label : preset}`, icon: 'none' });
  },

  setClipDenoise(e) {
    const val = Number(e.currentTarget.dataset.value);
    if (!isFinite(val)) return;
    const clip = this.getSelectedClip();
    if (!clip) return;
    this.pushUndo();
    this.clips[this.selectedClipIndex].denoise = val;
    if (this.playback && this.playback.queue) {
      this.playback.queue.forEach(item => {
        if (item.clipId === clip.id) item.denoise = val;
      });
    }
    this.refreshClipData();
    haptics.impactLight();
    wx.showToast({ title: val > 0 ? `降噪已开启 (${val}dB)` : '降噪已关闭', icon: 'none' });
  },

  onClipGainChanging(e) {
    const val = Number(e.detail.value);
    this.setData({
      selectedClipGainDb: val,
      selectedClipGainText: editorUtils.formatDb(val),
    });
    const clip = this.getSelectedClip();
    if (clip) {
      clip.volumeDb = val;
      if (this.playback && this.playback.queue) {
        this.playback.queue.forEach(item => {
          if (item.clipId === clip.id) item.volumeDb = val;
        });
      }
      if (this.data.isPlaying) {
        this.applyPreviewVolume(this.currentSourceTime);
      }
    }
  },

  onClipGainChange(e) {
    const val = Number(e.detail.value);
    const clip = this.getSelectedClip();
    if (!clip) return;
    this.pushUndo();
    this.clips[this.selectedClipIndex].volumeDb = val;
    if (this.playback && this.playback.queue) {
      this.playback.queue.forEach(item => {
        if (item.clipId === clip.id) item.volumeDb = val;
      });
    }
    this.refreshClipData();
    if (this.data.isPlaying) {
      this.applyPreviewVolume(this.currentSourceTime);
    }
    haptics.impactLight();
  },

  resetClipGain() {
    const clip = this.getSelectedClip();
    if (!clip) return;
    this.pushUndo();
    this.clips[this.selectedClipIndex].volumeDb = 0;
    if (this.playback && this.playback.queue) {
      this.playback.queue.forEach(item => {
        if (item.clipId === clip.id) item.volumeDb = 0;
      });
    }
    this.refreshClipData();
    if (this.data.isPlaying) {
      this.applyPreviewVolume(this.currentSourceTime);
    }
    haptics.impactLight();
    wx.showToast({ title: '增益已复位 (0 dB)', icon: 'none' });
  },

  applyQuickGainPreset(e) {
    const val = Number(e.currentTarget.dataset.value);
    if (!isFinite(val)) return;
    const clip = this.getSelectedClip();
    if (!clip) return;
    this.pushUndo();
    this.clips[this.selectedClipIndex].volumeDb = val;
    if (this.playback && this.playback.queue) {
      this.playback.queue.forEach(item => {
        if (item.clipId === clip.id) item.volumeDb = val;
      });
    }
    this.setData({
      selectedClipGainDb: val,
      selectedClipGainText: editorUtils.formatDb(val),
    });
    this.refreshClipData();
    if (this.data.isPlaying) {
      this.applyPreviewVolume(this.currentSourceTime);
    }
    haptics.impactLight();
    wx.showToast({ title: `增益：${editorUtils.formatDb(val)}`, icon: 'none' });
  },

  nudgeClipOffset(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    if (!isFinite(delta)) return;
    const clip = this.getSelectedClip();
    if (!clip) return;
    this.pushUndo();
    this.stopPlaybackAudioOnly();
    this.playback = null;
    this.paused = false;
    const nextOffset = Math.max(0, editorUtils.round3((clip.offsetSec || 0) + delta));
    this.clips[this.selectedClipIndex].offsetSec = nextOffset;
    this.refreshClipData();
    wx.showToast({ title: delta > 0 ? `向后平移 +${delta}s` : `向前平移 ${delta}s`, icon: 'none' });
  },

  toggleTrackMute(e) {
    const trackId = e.currentTarget.dataset.track;
    const trk = this.tracks.find(t => t.id === trackId);
    if (!trk) return;
    trk.mute = !trk.mute;
    this.stopPlaybackAudioOnly();
    this.playback = null;
    this.paused = false;
    this.refreshClipData();
    wx.showToast({ title: trk.mute ? `${trk.name} 已静音` : `${trk.name} 已取消静音`, icon: 'none' });
  },

  toggleTrackSolo(e) {
    const trackId = e.currentTarget.dataset.track;
    const trk = this.tracks.find(t => t.id === trackId);
    if (!trk) return;
    trk.solo = !trk.solo;
    this.refreshClipData();
    wx.showToast({ title: trk.solo ? `${trk.name} 独奏开启` : `${trk.name} 独奏关闭`, icon: 'none' });
  },

  toggleTrackDucking(e) {
    const trackId = e.currentTarget.dataset.track || 'A2';
    const trk = this.tracks.find(t => t.id === trackId);
    if (!trk) return;
    trk.ducking = !trk.ducking;
    this.refreshClipData();
    wx.showToast({
      title: trk.ducking ? '🦆 智能避让已开启（伴奏遇人声下压 -12dB）' : '智能避让已关闭',
      icon: 'none',
      duration: 2500,
    });
  },

  cycleTrackVolume(e) {
    const trackId = e.currentTarget.dataset.track;
    const trk = this.tracks.find(t => t.id === trackId);
    if (!trk) return;
    const presets = [0, -6, -12, -18, 3];
    const cur = typeof trk.volumeDb === 'number' ? trk.volumeDb : 0;
    let nextIdx = (presets.indexOf(cur) + 1) % presets.length;
    if (nextIdx < 0) nextIdx = 0;
    const nextVal = presets[nextIdx];
    this.pushUndo();
    trk.volumeDb = nextVal;
    this.refreshClipData();
    wx.showToast({
      title: `${trk.name} 音量：${nextVal > 0 ? '+' + nextVal : nextVal} dB`,
      icon: 'none',
    });
  },

  openInspectorDrawer(e) {
    const tab = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.tab) || 'effects';
    this.setData({
      showInspectorDrawer: true,
      inspectorTab: tab,
    });
  },

  closeInspectorDrawer() {
    this.setData({ showInspectorDrawer: false });
  },

  trimClipHead(e) {
    if (this._justFinishedTrimming) {
      this._justFinishedTrimming = false;
      return;
    }
    const clip = this.getSelectedClip();
    if (!clip) return;
    const delta = Number((e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.delta) || 0.2);
    const maxIn = clip.out - editorUtils.MIN_CLIP_DURATION;
    const nextIn = Math.min(maxIn, Math.max(0, editorUtils.round3(clip.in + delta)));
    if (nextIn === clip.in) return;
    this.pushUndo();
    this.clips[this.selectedClipIndex].in = nextIn;
    this.refreshClipData();
    wx.showToast({ title: `入点已微调至 ${editorUtils.formatPrecise(nextIn)}`, icon: 'none' });
  },

  trimClipTail(e) {
    if (this._justFinishedTrimming) {
      this._justFinishedTrimming = false;
      return;
    }
    const clip = this.getSelectedClip();
    if (!clip) return;
    const delta = Number((e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.delta) || -0.2);
    const source = this.sources.find(s => s.id === clip.sourceId);
    const maxDur = (source && source.duration) || 600;
    const minOut = clip.in + editorUtils.MIN_CLIP_DURATION;
    const nextOut = Math.max(minOut, Math.min(maxDur, editorUtils.round3(clip.out + delta)));
    if (nextOut === clip.out) return;
    this.pushUndo();
    this.clips[this.selectedClipIndex].out = nextOut;
    this.refreshClipData();
    wx.showToast({ title: `出点已微调至 ${editorUtils.formatPrecise(nextOut)}`, icon: 'none' });
  },

  onTimelineTap(e) {
    if (this._justFinishedDragging || this._justFinishedTrimming) {
      return;
    }
    const time = Number(e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.time);
    if (isFinite(time) && time >= 0) {
      this.currentSourceTime = time;
      this.setData({ currentTimeText: editorUtils.formatPrecise(time) });
      this.refreshClipData();
      this.drawWave();
      if (this.data.isPlaying) {
        this.seekPlaybackTo(time);
      }
      return;
    }
    // 手机触控交互：点击时间轴空白区直接寻位播放头，并立即同步音频指针
    if (e && e.detail && typeof e.detail.x === 'number') {
      const windowWidth = this.windowWidth || 375;
      const headerPx = 170 * (windowWidth / 750);
      const scrollPx = this.timelineScrollLeft || 0;
      const relativePx = Math.max(0, e.detail.x - headerPx + scrollPx);
      const relativeRpx = relativePx * (750 / windowWidth);
      const pxPerSec = (this.data.timelineData && this.data.timelineData.pxPerSec) || 36;
      const targetSec = editorUtils.round3(relativeRpx / pxPerSec);
      const maxSec = (this.data.timelineData && this.data.timelineData.maxTimelineSec) || 600;
      const clamped = Math.max(0, Math.min(maxSec, targetSec));
      this.currentSourceTime = clamped;

      // 智能选取：若点击位置落在某个音频片段的时间覆盖范围内，联动聚焦选中该片段
      let hitClipIndex = -1;
      for (let i = 0; i < this.clips.length; i++) {
        const c = this.clips[i];
        const cStart = typeof c.offsetSec === 'number' ? c.offsetSec : 0;
        const cEnd = cStart + editorUtils.clipDuration(c);
        if (clamped >= cStart && clamped <= cEnd) {
          hitClipIndex = i;
          break;
        }
      }
      if (hitClipIndex >= 0 && hitClipIndex !== this.selectedClipIndex) {
        this.selectedClipIndex = hitClipIndex;
        this.syncWaveSource();
      }

      this.setData({
        currentTimeText: editorUtils.formatPrecise(clamped),
        'timelineData.playheadRpx': Math.round(clamped * pxPerSec),
      });
      this.refreshClipData();
      this.drawWave();
      if (this.data.isPlaying) {
        this.seekPlaybackTo(clamped);
      }
      haptics.impactLight();
    }
  },

  onRulerTickTap(e) {
    const time = Number(e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.time);
    if (!isFinite(time) || time < 0) return;
    haptics.impactLight();
    const pxPerSec = (this.data.timelineData && this.data.timelineData.pxPerSec) || 36;
    const maxSec = (this.data.timelineData && this.data.timelineData.maxTimelineSec) || 600;
    const clamped = Math.max(0, Math.min(maxSec, time));
    this.currentSourceTime = clamped;
    this.setData({
      currentTimeText: editorUtils.formatPrecise(clamped),
      'timelineData.playheadRpx': Math.round(clamped * pxPerSec),
    });
    this.refreshClipData();
    this.drawWave();
    if (this.data.isPlaying) {
      this.seekPlaybackTo(clamped);
    }
  },

  seekPlaybackTo(targetSec) {
    if (!this.data.isPlaying) return;
    if (this.isMultiTrackPlaying) {
      this.multiTrackStartTimelineSec = targetSec;
      this.multiTrackWallStartTime = Date.now();
      const tracks = (this.data.timelineData && this.data.timelineData.tracks) || [];
      const sourceMap = editorUtils.sourceMap(this.sources);
      tracks.forEach(track => {
        const audio = this.getTrackAudio(track.id);
        if (!audio) return;
        if (track.mute) return;
        const activeClip = (track.clips || []).find(c => {
          return targetSec >= c.timelineStartSec && targetSec < c.timelineEndSec;
        });
        if (activeClip) {
          const src = sourceMap[activeClip.sourceId];
          if (!src || !src.localPath) return;
          const speed = activeClip.speed || 1.0;
          const sourceOffset = editorUtils.round3(activeClip.in + (targetSec - activeClip.timelineStartSec) * speed);
          this.activeTrackClips[track.id] = { clipId: activeClip.id, sourceOffset: sourceOffset };
          try {
            audio.startTime = sourceOffset;
            if (typeof audio.playbackRate !== 'undefined') {
              audio.playbackRate = activeClip.speed || 1.0;
            }
            audio.src = src.localPath;
            audio.seek(sourceOffset);
            audio.play();
          } catch (e) {}
        } else {
          this.activeTrackClips[track.id] = null;
          try { audio.pause(); } catch (e) {}
        }
      });
      return;
    }

    // 单轨或片段队列播放 seek
    const pb = this.playback;
    const ctx = this.sourceAudio;
    if (!pb || !ctx) return;
    let foundIndex = -1;
    let foundClipIn = 0;
    for (let i = 0; i < pb.queue.length; i++) {
      const item = pb.queue[i];
      const startOut = editorUtils.queueOutputPosition(pb.queue, i, item.in);
      const endOut = startOut + item.duration;
      if (targetSec >= startOut - 1e-6 && targetSec <= endOut + 1e-6) {
        foundIndex = i;
        foundClipIn = editorUtils.clampNumber(item.in + (targetSec - startOut), item.in, item.out);
        break;
      }
    }
    if (foundIndex >= 0) {
      this._playbackWallStart = Date.now();
      this._playbackStartSourceTime = foundClipIn;
      this._playbackStartTimelineSec = targetSec;
      this.currentSourceTime = foundClipIn;
      this._lastDisplayTime = pb.mode === 'all' ? targetSec : foundClipIn;

      const pxPerSec = (this.data.timelineData && this.data.timelineData.pxPerSec) || 36;
      this.setData({
        currentTimeText: editorUtils.formatPrecise(this._lastDisplayTime),
        'timelineData.playheadRpx': Math.round(targetSec * pxPerSec),
      });

      if (pb.index !== foundIndex) {
        this.previewSrcId = '';
        this.playQueueAt(foundIndex, foundClipIn, targetSec);
        setTimeout(() => {
          try {
            ctx.startTime = foundClipIn;
            ctx.seek(foundClipIn);
          } catch (e) {}
        }, 80);
      } else {
        try {
          ctx.startTime = foundClipIn;
          ctx.seek(foundClipIn);
        } catch (e) {}
        this.applyPreviewVolume(foundClipIn);
      }
    }
  },

  resumePlayheadFollow() {
    this._userIsBrowsingTimeline = false;
    this._userIsTouchingTimeline = false;
    this._programmaticScroll = true;
    const pxPerSec = (this.data.timelineData && this.data.timelineData.pxPerSec) || 36;
    const playheadRpx = Math.round((this.currentSourceTime || 0) * pxPerSec);
    const windowWidth = this.windowWidth || 375;
    const rpxRatio = 750 / windowWidth;
    const viewportWidthRpx = 540;
    const targetScrollPx = Math.max(0, Math.round((playheadRpx - viewportWidthRpx * 0.35) / rpxRatio));
    this.timelineScrollLeft = targetScrollPx;
    this.setData({
      userBrowsingWhilePlaying: false,
      timelineScrollLeft: targetScrollPx,
    });
  },

  onTimelineScroll(e) {
    if (!e || !e.detail) return;
    const scrollLeft = e.detail.scrollLeft || 0;
    this.timelineScrollLeft = scrollLeft;
    if (this._programmaticScroll) {
      this._programmaticScroll = false;
      return;
    }
    // 播放中用户主动横向滑动检阅后续内容
    if (this.data.isPlaying) {
      this._userIsBrowsingTimeline = true;
      if (!this.data.userBrowsingWhilePlaying) {
        this.setData({ userBrowsingWhilePlaying: true });
      }
    }
  },

  nudgeClipHead(e) {
    const delta = Number((e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.delta) || 0.2);
    this.trimClipHead({ currentTarget: { dataset: { delta: delta } } });
  },

  nudgeClipTail(e) {
    const delta = Number((e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.delta) || -0.2);
    this.trimClipTail({ currentTarget: { dataset: { delta: delta } } });
  },

  /* ====================================================================== */
  /* 选区（选中片段所属源的源时间轴，限制在片段 in/out 内）                   */
  /* ====================================================================== */

  hasUsableSelection() {
    return !!(this.selection && this.selection.end - this.selection.start >= MIN_SELECTION - 1e-6);
  },

  buildSelectionData() {
    const sel = this.selection;
    if (!sel) return null;
    return {
      start: sel.start,
      end: sel.end,
      startText: editorUtils.formatPrecise(sel.start),
      endText: editorUtils.formatPrecise(sel.end),
      durText: editorUtils.formatPrecise(sel.end - sel.start),
      durSeconds: sel.end - sel.start,
    };
  },

  setSelection(start, end) {
    const clip = this.getSelectedClip();
    if (!clip) return;
    let a = editorUtils.clampNumber(start, clip.in, clip.out);
    let b = editorUtils.clampNumber(end, clip.in, clip.out);
    if (b < a) {
      const tmp = a;
      a = b;
      b = tmp;
    }
    this.selection = { start: a, end: b };
    this.pushSelectionData(true);
    this.drawWave();
  },

  pushSelectionData(force) {
    const sel = this.selection;
    if (!sel) {
      this.setData({ hasSelection: false, selection: null });
      return;
    }
    const now = Date.now();
    if (!force && this._lastSelDataAt && now - this._lastSelDataAt < 60) return;
    this._lastSelDataAt = now;
    this.setData({ hasSelection: true, selection: this.buildSelectionData() });
  },

  clearSelection() {
    this.selection = null;
    this.setData({ hasSelection: false, selection: null }, () => this.drawWave());
  },

  selectAll() {
    const clip = this.getSelectedClip();
    if (!clip) return;
    this.setSelection(clip.in, clip.out);
    wx.showToast({ title: '已选中本片段', icon: 'none' });
  },

  /* ====================================================================== */
  /* 每片段淡入淡出 / 全局音量                                                */
  /* ====================================================================== */

  onClipFadeInTap(e) {
    this.applyClipFade('fadeIn', Number(e.currentTarget.dataset.value) || 0);
  },

  onClipFadeOutTap(e) {
    this.applyClipFade('fadeOut', Number(e.currentTarget.dataset.value) || 0);
  },

  applyClipFade(key, value) {
    const index = this.selectedClipIndex;
    const clip = this.clips[index];
    if (!clip) return;
    const next = this.clips.slice();
    const updated = Object.assign({}, clip);
    updated[key] = editorUtils.toNonNegative(value);
    next[index] = updated;
    const adjusted = editorUtils.effectiveClipFades(updated).adjusted;
    if (this.playback && this.playback.queue) {
      this.playback.queue.forEach(item => {
        if (item.clipId === clip.id) {
          item[key] = updated[key];
        }
      });
    }
    const wasPlaying = this.data.isPlaying;
    this.commitClips(next, {
      selectedClipIndex: index,
      jumpToIn: false,
      clearSelection: false,
      preservePlayback: wasPlaying,
      toast: adjusted ? '片段较短，导出时淡入淡出会自动缩短' : '',
    });
    if (wasPlaying) {
      this.applyPreviewVolume(this.currentSourceTime);
    }
    haptics.impactLight();
  },

  onVolumeChanging(e) {
    this.updateVolume(e.detail.value);
  },

  onVolumeChange(e) {
    this.updateVolume(e.detail.value);
  },

  updateVolume(raw) {
    const value = editorUtils.clampNumber(Math.round(Number(raw) || 0), -24, 12);
    this.setData({ volumeDb: value, volumeText: editorUtils.formatDb(value) });
    if (this.data.isPlaying) this.applyPreviewVolume(this.currentSourceTime);
  },

  /* ====================================================================== */
  /* 预览：跨源顺序播放 + 每片段淡入淡出音量包络                              */
  /* ====================================================================== */

  togglePlayAll() {
    if (this.data.isPlaying && this.data.playMode === 'all') {
      this.pausePlayback();
      return;
    }
    if (this.paused && this.playback && this.playback.mode === 'all') {
      this.resumePlayback();
      return;
    }
    if (!this.data.canPreviewAll) {
      this.showPreviewUnavailable();
      return;
    }
    this.startPlayback('all');
  },

  togglePlayClip() {
    if (!this.data.canPreviewClip) {
      this.showPreviewUnavailable();
      return;
    }
    if (this.data.isPlaying && this.data.playMode === 'clip') {
      this.pausePlayback();
      return;
    }
    if (this.paused && this.playback && this.playback.mode === 'clip') {
      this.resumePlayback();
      return;
    }
    this.startPlayback('clip');
  },

  showPreviewUnavailable() {
    wx.showModal({
      title: '当前设备无法试听',
      content: this.data.previewBanner || '该格式在当前设备无法试听，可继续编辑并导出后试听。',
      showCancel: false,
    });
  },

  async startPlayback(mode) {
    const options = mode === 'clip' ? { clipIndex: this.selectedClipIndex } : {};
    const built = editorUtils.buildPreviewQueue(this.clips, this.sources, options);
    if (!built.ok) {
      wx.showToast({ title: built.message || '没有可试听的片段', icon: 'none' });
      return;
    }
    // 跨源播放前确认所有涉及的源都可试听，若本地文件因微信缓存被清理则从云端静默重下修复
    const map = editorUtils.sourceMap(this.sources);
    for (let i = 0; i < built.queue.length; i++) {
      const src = map[built.queue[i].sourceId];
      if (!src) continue;
      if (!src.localPath && src.fileID) {
        await this.ensureSourceLocalPath(src);
      }
      if (src.playable === false || !src.localPath) {
        this.showPreviewUnavailable();
        return;
      }
      built.queue[i].localPath = src.localPath;
    }
    this.stopPlaybackAudioOnly();
    this.playback = {
      mode: mode,
      queue: built.queue,
      index: -1,
      total: built.total,
      switching: false,
    };
    this.paused = false;
    this.selection = null;
    this._userIsBrowsingTimeline = false;
    this._userIsTouchingTimeline = false;
    this.setData({
      isPlaying: true,
      playMode: mode,
      hasSelection: false,
      selection: null,
      userBrowsingWhilePlaying: false,
    });

    // 检查是否跨多轨道且全片播放
    const distinctTracks = {};
    this.clips.forEach(c => { if (c.trackId) distinctTracks[c.trackId] = true; });
    const isMultiTrack = mode === 'all' && Object.keys(distinctTracks).length > 1;

    if (isMultiTrack) {
      this.startMultiTrackPlayback();
    } else {
      let startIndex = 0;
      let startOffset = 0;
      let startTimelinePos = 0;
      if (mode === 'all' && this.currentSourceTime > 0) {
        for (let i = 0; i < built.queue.length; i++) {
          const item = built.queue[i];
          const startOut = editorUtils.queueOutputPosition(built.queue, i, item.in);
          const sp = item.speed && item.speed > 0 ? item.speed : 1.0;
          const effectiveDur = item.effectiveDuration || (item.duration / sp);
          const endOut = startOut + effectiveDur;
          if (this.currentSourceTime >= startOut && this.currentSourceTime < endOut - 0.05) {
            startIndex = i;
            startOffset = item.in + (this.currentSourceTime - startOut) * sp;
            startTimelinePos = this.currentSourceTime;
            break;
          }
        }
      }
      this.currentSourceTime = startOffset > 0 ? startOffset : built.queue[startIndex].in;
      const initialTimelineSec = startTimelinePos > 0
        ? startTimelinePos
        : editorUtils.queueOutputPosition(built.queue, startIndex, built.queue[startIndex].in);

      this._playbackWallStart = Date.now();
      this._playbackStartSourceTime = this.currentSourceTime;
      this._playbackStartTimelineSec = initialTimelineSec;
      this._playbackSpeed = built.queue[startIndex].speed || 1.0;
      this._lastDisplayTime = mode === 'all' ? initialTimelineSec : this.currentSourceTime;

      this.playQueueAt(startIndex, this.currentSourceTime, initialTimelineSec);
      this.startPlayTimer();
    }
  },

  startMultiTrackPlayback() {
    this.isMultiTrackPlaying = true;
    const maxDur = (this.data.timelineData && this.data.timelineData.maxTimelineSec) || 8;
    this.multiTrackTotalDuration = maxDur;
    const startSec = (this.currentSourceTime && this.currentSourceTime < maxDur - 0.1) ? this.currentSourceTime : 0;
    this.multiTrackStartTimelineSec = startSec;
    this.multiTrackWallStartTime = Date.now();
    this.activeTrackClips = {};

    this.tickMultiTrackPlayback();
    this.clearPlayTimer();
    this.playTimer = setInterval(() => this.tickMultiTrackPlayback(), 35);
  },

  tickMultiTrackPlayback() {
    if (!this.data.isPlaying || !this.isMultiTrackPlaying) return;
    const elapsed = (Date.now() - this.multiTrackWallStartTime) / 1000;
    const currentTimelineSec = editorUtils.round3(this.multiTrackStartTimelineSec + elapsed);

    if (currentTimelineSec >= this.multiTrackTotalDuration) {
      this.finishPlayback();
      return;
    }

    this.currentSourceTime = currentTimelineSec;
    const pxPerSec = (this.data.timelineData && this.data.timelineData.pxPerSec) || 36;
    const playheadRpx = Math.round(currentTimelineSec * pxPerSec);
    const windowWidth = this.windowWidth || 375;
    const rpxRatio = 750 / windowWidth;
    const currentScrollPx = this.timelineScrollLeft || 0;
    const currentScrollRpx = currentScrollPx * rpxRatio;
    const viewportWidthRpx = 540;
    const relPlayhead = playheadRpx - currentScrollRpx;

    const patch = {
      currentTimeText: editorUtils.formatPrecise(currentTimelineSec),
      'timelineData.playheadRpx': playheadRpx,
    };

    // 自动跟随光标逻辑：
    // 只有在用户没有在手动浏览时间轴、且当前指针自然播放到接近视口右边缘时才平滑向右推进
    // 严禁在 relPlayhead < 0 时向左弹回！用户滑到后面查看时允许从容检阅
    const shouldAutoFollow = !this._userIsBrowsingTimeline && !this._userIsTouchingTimeline && relPlayhead > viewportWidthRpx * 0.78;

    if (shouldAutoFollow) {
      const newScrollRpx = Math.max(0, playheadRpx - viewportWidthRpx * 0.35);
      const newScrollPx = Math.round(newScrollRpx / rpxRatio);
      this.timelineScrollLeft = newScrollPx;
      this._programmaticScroll = true;
      patch.timelineScrollLeft = newScrollPx;
    }
    this.setData(patch);

    const tracks = (this.data.timelineData && this.data.timelineData.tracks) || [];
    const sourceMap = editorUtils.sourceMap(this.sources);

    tracks.forEach(track => {
      const audio = this.getTrackAudio(track.id);
      if (!audio) return;

      // 如果音轨被静音，直接暂停
      if (track.mute) {
        try { audio.pause(); } catch (e) {}
        this.activeTrackClips[track.id] = null;
        return;
      }

      // 寻找当前秒数下处于活动状态的片段
      const activeClip = (track.clips || []).find(c => {
        return currentTimelineSec >= c.timelineStartSec && currentTimelineSec < c.timelineEndSec;
      });

      if (activeClip) {
        const src = sourceMap[activeClip.sourceId];
        if (!src || !src.localPath) return;

        const speed = activeClip.speed || 1.0;
        // 计算该片段此刻应处的源时间偏移（倍速补偿）
        const sourceOffset = editorUtils.round3(activeClip.in + (currentTimelineSec - activeClip.timelineStartSec) * speed);
        // 计算音量包络（轨道音量 + 片段音量 + 全局音量 + 淡入淡出）
        let vol = editorUtils.dbToGain(track.volumeDb || 0) * editorUtils.dbToGain(activeClip.volumeDb || 0) * editorUtils.dbToGain(this.data.volumeDb || 0);
        // 智能人声避让 (Auto-Ducking)：遇其他轨道人声时自动下压 -12dB
        if (track.ducking) {
          const isOtherSpeaking = tracks.some(t => t.id !== track.id && !t.mute && (t.clips || []).some(c => currentTimelineSec >= c.timelineStartSec && currentTimelineSec < c.timelineEndSec));
          if (isOtherSpeaking) vol *= editorUtils.dbToGain(-12);
        }
        const localSec = currentTimelineSec - activeClip.timelineStartSec;
        if (activeClip.fadeIn > 0 && localSec < activeClip.fadeIn) {
          vol *= Math.max(0, localSec / activeClip.fadeIn);
        }
        const remainSec = activeClip.timelineEndSec - currentTimelineSec;
        if (activeClip.fadeOut > 0 && remainSec < activeClip.fadeOut) {
          vol *= Math.max(0, remainSec / activeClip.fadeOut);
        }
        try { audio.volume = editorUtils.clampUnit(vol); } catch (e) {}

        const prevActive = this.activeTrackClips[track.id];
        if (!prevActive || prevActive.clipId !== activeClip.id) {
          this.activeTrackClips[track.id] = { clipId: activeClip.id, sourceOffset: sourceOffset };
          try {
            audio.startTime = sourceOffset;
            if (typeof audio.playbackRate !== 'undefined') {
              audio.playbackRate = activeClip.speed || 1.0;
            }
            audio.src = src.localPath;
            audio.seek(sourceOffset);
            audio.play();
          } catch (e) {}
        }
      } else {
        if (this.activeTrackClips[track.id]) {
          this.activeTrackClips[track.id] = null;
          try { audio.pause(); } catch (e) {}
        }
      }
    });
  },

  handleSourceCanplay() {
    this.sourceCanplay = true;
    if (!this.data.isPlaying || !this.playback) return;
    const item = this.playback.queue[this.playback.index];
    if (!item || !this.sourceAudio) return;
    // 切换 src 后加载完成，补一次 startTime / playbackRate + seek + play
    try {
      this.sourceAudio.startTime = item.in;
      if (typeof this.sourceAudio.playbackRate !== 'undefined') {
        this.sourceAudio.playbackRate = item.speed || 1.0;
      }
      this.sourceAudio.seek(item.in);
    } catch (e) {}
    try {
      this.sourceAudio.play();
    } catch (e) {}
  },

  playQueueAt(index, initialOffset, initialTimelineSec) {
    const pb = this.playback;
    const ctx = this.sourceAudio;
    if (!pb || !ctx) return;
    const item = pb.queue[index];
    if (!item) {
      this.finishPlayback();
      return;
    }
    pb.index = index;
    this.syncSelectedClipForPlayback(item.clipIndex);

    const seekIn = (typeof initialOffset === 'number' && isFinite(initialOffset)) ? initialOffset : item.in;
    this.currentSourceTime = seekIn;
    this.applyPreviewVolume(seekIn);
    this.drawWave();

    // 重新对齐高精物理时钟锚点
    this._playbackWallStart = Date.now();
    this._playbackStartSourceTime = seekIn;
    const clipOutputStart = editorUtils.queueOutputPosition(pb.queue, index, item.in);
    const startTimelinePos = (typeof initialTimelineSec === 'number' && isFinite(initialTimelineSec))
      ? initialTimelineSec
      : (clipOutputStart + Math.max(0, seekIn - item.in));
    this._playbackStartTimelineSec = startTimelinePos;
    this._playbackSpeed = item.speed || 1.0;

    // 关键：显式设置 InnerAudioContext 的 startTime 和 playbackRate
    // 微信小程序在未设置 startTime 时，seek 可能会被 native 重置回 00:00
    try {
      ctx.startTime = seekIn;
      if (typeof ctx.playbackRate !== 'undefined') {
        ctx.playbackRate = item.speed || 1.0;
      }
    } catch (e) {}

    if (this.previewSrcId !== item.sourceId || ctx.src !== item.localPath) {
      // 切源或初次载入：先换 src，等 onCanplay 后再 seek + play
      this.previewSrcId = item.sourceId;
      this.sourceCanplay = false;
      try {
        ctx.stop();
      } catch (e) {}
      try {
        ctx.startTime = seekIn;
        ctx.src = item.localPath;
      } catch (e) {}
      return;
    }
    try {
      ctx.startTime = seekIn;
      ctx.seek(seekIn);
    } catch (e) {}
    try {
      ctx.play();
    } catch (e) {}
  },

  syncSelectedClipForPlayback(clipIndex) {
    if (clipIndex === this.selectedClipIndex) return;
    const clip = this.clips[clipIndex];
    if (!clip) return;
    this.selectedClipIndex = clipIndex;
    this.selection = null;
    this.currentSourceTime = clip.in;
    this.syncWaveSource();
    this.setData({ hasSelection: false, selection: null, selectedClipIndex: clipIndex });
    this.refreshClipData();
  },

  advancePlayback() {
    const pb = this.playback;
    if (!pb || pb.switching) return;
    const next = pb.index + 1;
    if (next >= pb.queue.length) {
      this.finishPlayback();
      return;
    }
    pb.switching = true;
    const nextItem = pb.queue[next];
    const nextClipStartOut = editorUtils.queueOutputPosition(pb.queue, next, nextItem.in);

    // 关键：无缝衔接时钟锚点，全片播放时间码与指针平滑穿透，绝无停顿与突跳
    this._playbackWallStart = Date.now();
    this._playbackStartSourceTime = nextItem.in;
    this._playbackStartTimelineSec = nextClipStartOut;
    this._playbackSpeed = nextItem.speed || 1.0;

    const ctx = this.sourceAudio;
    try {
      if (ctx) ctx.pause();
    } catch (e) {}
    this.playQueueAt(next);
    setTimeout(() => {
      if (this.playback === pb) pb.switching = false;
    }, 120);
  },

  handleSourceEnded() {
    if (this.playback) this.advancePlayback();
  },

  tickPlayback() {
    const pb = this.playback;
    const ctx = this.sourceAudio;
    if (!pb || !ctx || !this.data.isPlaying) return;
    const item = pb.queue[pb.index];
    if (!item) return;

    const t = Number(ctx.currentTime);

    // 刚切源/seek 未生效时 currentTime 可能在 item.in 之前（微信 native 漏播开头音频 bug 预防）
    // 若检出当前时间在片段开始时间之前，立即静音并强行补 seek，防止原声泄露播放
    if (isFinite(t) && t < item.in - 0.25) {
      try {
        ctx.volume = 0;
        ctx.startTime = item.in;
        ctx.seek(item.in);
      } catch (e) {}
      return;
    }

    const now = Date.now();
    if (!this._playbackWallStart) {
      this._playbackWallStart = now;
      this._playbackStartSourceTime = this.currentSourceTime || item.in;
      const clipOutputStart = editorUtils.queueOutputPosition(pb.queue, pb.index, item.in);
      this._playbackStartTimelineSec = clipOutputStart + Math.max(0, this._playbackStartSourceTime - item.in);
      this._playbackSpeed = item.speed || 1.0;
    }

    // 1. 基于高精度物理时钟连续递增（微秒级插值）
    const elapsed = Math.max(0, (now - this._playbackWallStart) / 1000 * (this._playbackSpeed || 1.0));
    let continuousSourceTime = this._playbackStartSourceTime + elapsed;

    // 2. 硬件时钟软对齐 (Soft PLL Anchor Slew)：
    // 微信底层 InnerAudioContext.currentTime 具有 250ms~400ms 的原生离散阶梯延迟。
    // 绝对禁止直接将 continuousSourceTime 赋值为 t（赋值会造成倒退突跳）。
    // 仅当硬件时间滞后或超前超过 450ms（超出常规阶梯步进窗口，说明发生了真实的缓冲卡顿）时，
    // 以每帧最大 15ms 的平滑微调率（Slew Rate）温和拉动基准，肉眼完全感知不到抖动。
    if (isFinite(t) && t >= item.in - 0.05 && t <= item.out + 0.5) {
      const drift = t - continuousSourceTime;
      if (Math.abs(drift) > 0.45) {
        const gentleSlew = Math.max(-0.015, Math.min(0.015, drift * 0.1));
        this._playbackWallStart -= gentleSlew * 1000;
      }
    }

    // 3. 严格单调性保证（Strict Monotonicity）：
    // 在播放进行中，时间码决不能倒退！
    if (typeof this._lastDisplayTime === 'number' && isFinite(this._lastDisplayTime)) {
      if (pb.mode !== 'all' && continuousSourceTime < this._lastDisplayTime) {
        continuousSourceTime = this._lastDisplayTime;
      }
    }

    // 4. 片段播放结束边界判定
    if (continuousSourceTime >= item.out - 0.02 || (isFinite(t) && t >= item.out - 0.04 && t > item.in)) {
      this.advancePlayback();
      return;
    }

    this.currentSourceTime = editorUtils.clampNumber(continuousSourceTime, item.in, item.out);
    this.applyPreviewVolume(this.currentSourceTime);

    // 5. 计算成片时间轴位置与标尺红针坐标（严格与当前片段速率对齐）
    let outputSec = editorUtils.queueOutputPosition(pb.queue, pb.index, this.currentSourceTime);
    if (pb.mode === 'all' && typeof this._lastDisplayTime === 'number' && isFinite(this._lastDisplayTime) && outputSec < this._lastDisplayTime) {
      outputSec = this._lastDisplayTime;
    }
    const pxPerSec = (this.data.timelineData && this.data.timelineData.pxPerSec) || 36;
    const playheadRpx = Math.round(outputSec * pxPerSec);
    const windowWidth = this.windowWidth || 375;
    const rpxRatio = 750 / windowWidth;
    const currentScrollPx = this.timelineScrollLeft || 0;
    const currentScrollRpx = currentScrollPx * rpxRatio;
    const viewportWidthRpx = 540;
    const relPlayhead = playheadRpx - currentScrollRpx;

    // 全片播放时展示成片时间轴时间码；单片段试听时展示片段内源时间码
    const displayTimeSec = pb.mode === 'all' ? outputSec : this.currentSourceTime;
    this._lastDisplayTime = displayTimeSec;

    const patch = {
      currentTimeText: editorUtils.formatPrecise(displayTimeSec),
      'timelineData.playheadRpx': playheadRpx,
    };

    // 自动跟随光标逻辑：
    // 用户手动滑阅时暂停跟随，且绝不向左强行弹回，保证浏览后续内容不被打断
    const shouldAutoFollow = !this._userIsBrowsingTimeline && !this._userIsTouchingTimeline && relPlayhead > viewportWidthRpx * 0.78;

    if (shouldAutoFollow) {
      const newScrollRpx = Math.max(0, playheadRpx - viewportWidthRpx * 0.35);
      const newScrollPx = Math.round(newScrollRpx / rpxRatio);
      this.timelineScrollLeft = newScrollPx;
      this._programmaticScroll = true;
      patch.timelineScrollLeft = newScrollPx;
    }

    // 35ms 高频平滑提交
    this.setData(patch);

    // 波形图 Canvas 节流重绘（约 10 FPS），彻底规避频繁绘制 Canvas 引起的 CPU 耗电与掉帧
    if (!this._lastWaveDrawAt || now - this._lastWaveDrawAt > 95) {
      this._lastWaveDrawAt = now;
      this.drawWave();
    }
  },

  applyPreviewVolume(sourceTime) {
    const ctx = this.sourceAudio;
    const pb = this.playback;
    if (!ctx || !pb) return;
    const item = pb.queue[pb.index];
    if (!item) return;
    const clipVol = typeof item.volumeDb === 'number' ? item.volumeDb : 0;
    let gain = editorUtils.dbToGain((this.data.volumeDb || 0) + clipVol);
    const local = editorUtils.clampNumber(sourceTime - item.in, 0, item.duration);
    if (item.fadeIn > 0 && local < item.fadeIn) gain *= Math.max(0, local / item.fadeIn);
    const remain = item.duration - local;
    if (item.fadeOut > 0 && remain < item.fadeOut) gain *= Math.max(0, remain / item.fadeOut);
    try {
      ctx.volume = editorUtils.clampUnit(gain);
    } catch (e) {}
  },

  pausePlayback() {
    if (this.isMultiTrackPlaying) {
      if (this.trackAudioPool) {
        Object.keys(this.trackAudioPool).forEach(id => {
          try { this.trackAudioPool[id].pause(); } catch (e) {}
        });
      }
    }
    if (this.sourceAudio) {
      try {
        this.sourceAudio.pause();
      } catch (e) {}
    }
    this.clearPlayTimer();
    this.paused = true;
    this._lastDisplayTime = null;
    this.setData({ isPlaying: false });
  },

  resumePlayback() {
    if (this.isMultiTrackPlaying) {
      this.paused = false;
      this.setData({ isPlaying: true });
      this.multiTrackWallStartTime = Date.now();
      this.multiTrackStartTimelineSec = this.currentSourceTime || 0;
      this.activeTrackClips = {};
      this.clearPlayTimer();
      this.playTimer = setInterval(() => this.tickMultiTrackPlayback(), 35);
      return;
    }
    const pb = this.playback;
    const ctx = this.sourceAudio;
    if (!pb || !ctx) return;
    const item = pb.queue[pb.index];
    if (!item) {
      this.startPlayback(pb.mode);
      return;
    }
    this.paused = false;
    this._lastDisplayTime = null;
    this.setData({ isPlaying: true });

    // 恢复高精物理时钟锚点
    this._playbackWallStart = Date.now();
    this._playbackStartSourceTime = this.currentSourceTime || item.in;
    const clipOutputStartSec = editorUtils.queueOutputPosition(pb.queue, pb.index, item.in);
    this._playbackStartTimelineSec = clipOutputStartSec + Math.max(0, this._playbackStartSourceTime - item.in);
    this._playbackSpeed = item.speed || 1.0;

    try {
      ctx.play();
    } catch (e) {}
    this.applyPreviewVolume(this.currentSourceTime);
    this.startPlayTimer();
  },

  finishPlayback() {
    this.clearPlayTimer();
    this._playbackWallStart = null;
    this._lastDisplayTime = null;
    this._userIsBrowsingTimeline = false;
    this._userIsTouchingTimeline = false;
    if (this.isMultiTrackPlaying) {
      this.isMultiTrackPlaying = false;
      this.activeTrackClips = {};
      if (this.trackAudioPool) {
        Object.keys(this.trackAudioPool).forEach(id => {
          try { this.trackAudioPool[id].stop(); } catch (e) {}
        });
      }
    }
    if (this.sourceAudio) {
      try {
        this.sourceAudio.stop();
      } catch (e) {}
    }
    this.playback = null;
    this.paused = false;
    const clip = this.getSelectedClip();
    this.currentSourceTime = clip ? clip.in : 0;
    this.setData({
      isPlaying: false,
      playMode: '',
      userBrowsingWhilePlaying: false,
      currentTimeText: editorUtils.formatPrecise(this.currentSourceTime),
    });
    this.drawWave();
  },

  stopPlaybackAudioOnly() {
    this.clearPlayTimer();
    this._playbackWallStart = null;
    this._lastDisplayTime = null;
    this._userIsBrowsingTimeline = false;
    this._userIsTouchingTimeline = false;
    if (this.isMultiTrackPlaying) {
      this.isMultiTrackPlaying = false;
      this.activeTrackClips = {};
      if (this.trackAudioPool) {
        Object.keys(this.trackAudioPool).forEach(id => {
          try { this.trackAudioPool[id].stop(); } catch (e) {}
        });
      }
    }
    if (this.sourceAudio) {
      try {
        this.sourceAudio.stop();
      } catch (e) {}
    }
    this.playback = null;
  },

  stopPlayback() {
    const wasPlaying = this.data.isPlaying;
    this.stopPlaybackAudioOnly();
    this.paused = false;
    if (wasPlaying) this.setData({ isPlaying: false, playMode: '', userBrowsingWhilePlaying: false });
  },

  stopResultPlayback() {
    if (this.resultAudio) {
      try {
        this.resultAudio.stop();
      } catch (e) {}
    }
  },

  stopAllPlayback() {
    this.stopPlayback();
    this.stopResultPlayback();
  },

  startPlayTimer() {
    this.clearPlayTimer();
    this.playTimer = setInterval(() => this.tickPlayback(), 35);
  },

  clearPlayTimer() {
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
  },

  handleSourceAudioError(err) {
    console.warn('[editor] 源音频播放失败', err);
    this.stopPlayback();
    const source = this.getSelectedSource();
    const errCode = err && (err.errCode || err.code);

    // 针对本地文件丢失/过期错误 (10003) 尝试自动从云端重新拉取修复
    if (source && (errCode === 10003 || !source.localPath) && source.fileID) {
      this.ensureSourceLocalPath(source).then(newPath => {
        if (newPath) {
          wx.showToast({ title: '音频缓存已修复，请重试播放', icon: 'none' });
        } else {
          this.markSourceUnplayable(source);
        }
      });
      return;
    }

    // 格式明确不支持错误 (10004)
    if (errCode === 10004) {
      this.markSourceUnplayable(source);
    } else {
      wx.showToast({ title: '播放遇到波动，请重试', icon: 'none' });
    }
  },

  markSourceUnplayable(source) {
    if (!this.previewFailed) {
      this.previewFailed = true;
      if (source) source.playable = false;
      this.setData({
        canPreviewAll: false,
        canPreviewClip: false,
        previewBanner: this.buildPreviewBanner([source || { name: '该音频' }]),
      });
      wx.showToast({ title: '该设备无法试听此格式，可导出后试听', icon: 'none', duration: 2500 });
    }
  },

  seekSource(sourceTime) {
    const clip = this.getSelectedClip();
    if (!clip) return;
    const target = editorUtils.clampNumber(editorUtils.snapTime(sourceTime, 0.1), clip.in, clip.out);
    this.currentSourceTime = target;
    this.setData({ currentTimeText: editorUtils.formatPrecise(target) });

    const pb = this.playback;
    if (this.data.isPlaying && pb) {
      const item = pb.queue[pb.index];
      if (item && item.clipId === clip.id && target >= item.in - 1e-6 && target <= item.out + 1e-6) {
        try {
          this.sourceAudio.seek(target);
        } catch (e) {}
        this.applyPreviewVolume(target);
      } else {
        // 跨片段/跨源 seek：MVP 先停止预览，避免播放位置错乱
        this.stopPlayback();
      }
    }
    this.drawWave();
  },

  /* ====================================================================== */
  /* 波形 Canvas 2D（显示选中片段的完整源波形）                               */
  /* ====================================================================== */

  initWaveCanvas() {
    if (!this.getSelectedClip()) return;
    const query = wx.createSelectorQuery();
    query.select('#waveCanvas').fields({ node: true, size: true });
    query.select('#waveCanvas').boundingClientRect();
    query.exec((res) => {
      const field = res && res[0];
      const rect = res && res[1];
      if (!field || !field.node) {
        if ((this.canvasRetry || 0) < 3) {
          this.canvasRetry = (this.canvasRetry || 0) + 1;
          setTimeout(() => this.initWaveCanvas(), 80);
        } else {
          this.setData({ waveUnavailable: true });
        }
        return;
      }

      const width = Number(field.width || (rect && rect.width) || 0);
      const height = Number(field.height || (rect && rect.height) || 0);
      if (!(width > 10) || !(height > 10)) {
        if ((this.canvasRetry || 0) < 3) {
          this.canvasRetry = (this.canvasRetry || 0) + 1;
          setTimeout(() => this.initWaveCanvas(), 80);
        } else {
          this.setData({ waveUnavailable: true });
        }
        return;
      }
      this.canvasRetry = 0;

      const canvas = field.node;
      let dpr = 2;
      try {
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        dpr = Math.min(Number(info.pixelRatio) || 2, 3);
      } catch (e) {
        dpr = 2;
      }

      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        this.setData({ waveUnavailable: true });
        return;
      }
      ctx.scale(dpr, dpr);

      this.waveCanvas = canvas;
      this.waveCtx = ctx;
      this.canvasW = width;
      this.canvasH = height;
      this.canvasLeft = rect ? rect.left : 0;
      this.setData({ waveUnavailable: false });
      this.drawWave();
    });
  },

  releaseWaveCanvas() {
    this.waveCtx = null;
    this.waveCanvas = null;
    this.canvasW = 0;
    this.canvasH = 0;
    this.gesture = null;
  },

  timeToX(time) {
    const width = this.canvasW || 0;
    const innerW = Math.max(1, width - WAVE_PAD_X * 2);
    const duration = this.waveDuration || 0;
    if (!duration) return WAVE_PAD_X;
    return WAVE_PAD_X + editorUtils.clampNumber(time / duration, 0, 1) * innerW;
  },

  xToTime(x) {
    const width = this.canvasW || 0;
    const innerW = Math.max(1, width - WAVE_PAD_X * 2);
    const duration = this.waveDuration || 0;
    if (!duration) return 0;
    return editorUtils.clampNumber((x - WAVE_PAD_X) / innerW, 0, 1) * duration;
  },

  drawWave() {
    const ctx = this.waveCtx;
    if (!ctx || !this.canvasW || !this.canvasH) return;
    const width = this.canvasW;
    const height = this.canvasH;
    const rulerH = WAVE_RULER_H;
    const innerW = Math.max(1, width - WAVE_PAD_X * 2);
    const innerH = Math.max(1, height - rulerH - WAVE_PAD_Y * 2);
    const duration = this.waveDuration || 0;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#FAF8F5';
    ctx.fillRect(0, 0, width, height);

    // 绘制顶部时间刻度标尺 (Top Time Ruler)
    ctx.fillStyle = '#E7E5E4';
    ctx.fillRect(WAVE_PAD_X, rulerH, innerW, 1);

    if (duration > 0) {
      let step = 5;
      if (duration > 300) step = 60;
      else if (duration > 120) step = 30;
      else if (duration > 60) step = 15;
      else if (duration > 30) step = 10;

      ctx.font = '9px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#A8A29E';

      for (let t = 0; t <= duration; t += step) {
        const tx = this.timeToX(t);
        ctx.fillRect(tx, rulerH - 4, 1, 4);
        const mins = Math.floor(t / 60);
        const secs = Math.floor(t % 60);
        const label = (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
        ctx.fillText(label, tx, rulerH - 5);
      }
    }

    if (!duration) return;

    const clip = this.getSelectedClip();
    const inT = clip ? clip.in : 0;
    const outT = clip ? clip.out : duration;
    const peaks = this.wavePeaks;
    const bucketMs = this.waveBucketMs > 0 ? this.waveBucketMs : 50;
    const bucketCount = peaks ? peaks.length : 0;
    const cols = Math.max(12, Math.min(320, Math.floor(innerW / 2.5)));
    const colW = innerW / cols;
    const midY = rulerH + WAVE_PAD_Y + innerH / 2;

    for (let i = 0; i < cols; i++) {
      const x = WAVE_PAD_X + i * colW;
      const t0 = (i / cols) * duration;
      const t1 = ((i + 1) / cols) * duration;
      const centerT = (t0 + t1) / 2;
      let amp = 0;
      if (bucketCount > 0) {
        let b0 = Math.floor((t0 * 1000) / bucketMs);
        let b1 = Math.ceil((t1 * 1000) / bucketMs);
        if (b0 < 0) b0 = 0;
        if (b1 > bucketCount) b1 = bucketCount;
        if (b1 <= b0) b1 = Math.min(bucketCount, b0 + 1);
        const span = b1 - b0;
        const step = span > 64 ? Math.ceil(span / 64) : 1;
        for (let b = b0; b < b1; b += step) {
          const v = peaks[b] || 0;
          if (v > amp) amp = v;
        }
        amp = amp / 255;
      } else {
        amp = 0.28 + 0.14 * Math.abs(Math.sin(i * 0.7));
      }
      const inside = centerT >= inT && centerT <= outT;
      if (inside && clip && typeof clip.volumeDb === 'number' && clip.volumeDb !== 0) {
        const gainScale = editorUtils.clampNumber(editorUtils.dbToGain(clip.volumeDb), 0.25, 1.8);
        amp = Math.min(1.0, amp * gainScale);
      }
      const barHeight = Math.max(2, amp * innerH);
      ctx.fillStyle = inside ? '#FF6B00' : '#E7E5E4';
      ctx.fillRect(x, midY - barHeight / 2, Math.max(1, colW - 1), barHeight);
    }

    // 片段 in/out 边界线（in/out 之外淡化）
    const inX = this.timeToX(inT);
    const outX = this.timeToX(outT);
    ctx.fillStyle = 'rgba(255, 107, 0, 0.7)';
    ctx.fillRect(inX - 1, rulerH, 2, height - rulerH);
    ctx.fillRect(outX - 1, rulerH, 2, height - rulerH);

    // 选区遮罩 + 专业触控把手
    if (this.selection) {
      const sx = this.timeToX(this.selection.start);
      const ex = this.timeToX(this.selection.end);
      if (ex > sx) {
        // 选区淡橙遮罩
        ctx.fillStyle = 'rgba(255, 107, 0, 0.15)';
        ctx.fillRect(sx, rulerH, ex - sx, height - rulerH);

        // 左右边界线
        ctx.fillStyle = 'rgba(255, 107, 0, 0.9)';
        ctx.fillRect(sx - 1, rulerH, 2, height - rulerH);
        ctx.fillRect(ex - 1, rulerH, 2, height - rulerH);

        // 左把手胶囊 (带有立体触感凹槽)
        const handleH = Math.min(48, innerH);
        const handleY = midY - handleH / 2;
        ctx.fillStyle = '#FF6B00';
        ctx.fillRect(sx - 6, handleY, 12, handleH);
        // 把手防滑纹
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(sx - 2, handleY + 12, 1.5, handleH - 24);
        ctx.fillRect(sx + 1, handleY + 12, 1.5, handleH - 24);

        // 右把手胶囊
        ctx.fillStyle = '#FF6B00';
        ctx.fillRect(ex - 6, handleY, 12, handleH);
        // 把手防滑纹
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(ex - 2, handleY + 12, 1.5, handleH - 24);
        ctx.fillRect(ex + 1, handleY + 12, 1.5, handleH - 24);
      }
    }

    // 播放指针 (Needle)
    const px = this.timeToX(this.currentSourceTime);
    ctx.fillStyle = '#EF4444';
    ctx.fillRect(px - 1, rulerH, 2, height - rulerH);
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px, rulerH + 4);
    ctx.closePath();
    ctx.fill();

    // 剃刀激光对齐瞄准线 (Razor Laser Guide Line)
    if (typeof this.razorTouchTime === 'number') {
      const rx = this.timeToX(this.razorTouchTime);
      ctx.save();
      ctx.strokeStyle = '#EF4444';
      ctx.lineWidth = 2;
      if (ctx.setLineDash) ctx.setLineDash([4, 2]);
      ctx.beginPath();
      ctx.moveTo(rx, rulerH);
      ctx.lineTo(rx, height);
      ctx.stroke();
      if (ctx.setLineDash) ctx.setLineDash([]);

      // 顶部剪刀瞄准指示徽章
      const razorTimeLabel = '✂️ ' + editorUtils.formatPrecise(this.razorTouchTime);
      ctx.font = 'bold 10px -apple-system, sans-serif';
      const badgeW = Math.max(62, (ctx.measureText ? ctx.measureText(razorTimeLabel).width : 50) + 14);
      const badgeH = 18;
      const badgeX = Math.max(WAVE_PAD_X, Math.min(width - WAVE_PAD_X - badgeW, rx - badgeW / 2));
      const badgeY = rulerH + 4;
      
      ctx.fillStyle = '#EF4444';
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
        ctx.fill();
      } else {
        ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
      }

      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(razorTimeLabel, badgeX + badgeW / 2, badgeY + badgeH / 2);
      ctx.restore();
    }

    if (!bucketCount) {
      ctx.fillStyle = '#94A3B8';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('波形数据为空，仍可拖动选择', width / 2, height - 6);
      ctx.textAlign = 'left';
    }
  },

  /* ====================================================================== */
  /* 波形手势：点按 seek / 拖动新建选区 / 拖手柄微调                          */
  /* ====================================================================== */

  touchX(e) {
    const list = (e.touches && e.touches.length ? e.touches : e.changedTouches) || [];
    const touch = list[0];
    if (!touch) return 0;
    if (typeof touch.x === 'number' && isFinite(touch.x)) return touch.x;
    const clientX = typeof touch.clientX === 'number' ? touch.clientX : 0;
    return clientX - (this.canvasLeft || 0);
  },

  onWaveTouchStart(e) {
    if (this.data.status !== STATUS.EDITING || !this.getSelectedClip() || !this.waveCtx) return;
    if ((e.touches || []).length >= 2) {
      this.gesture = { multi: true };
      return;
    }
    const clip = this.getSelectedClip();
    const x = this.touchX(e);
    const time = this.xToTime(x);

    // 剃刀模式触控：实时锁定瞄准激光线并准备切割
    if (this.data.activeTool === 'razor') {
      const targetTime = editorUtils.clampNumber(time, clip.in, clip.out);
      this.razorTouchTime = targetTime;
      this.gesture = { mode: 'razor', startX: x, startTime: targetTime, moved: false, multi: false };
      this.drawWave();
      haptics.impactLight();
      return;
    }

    let mode = 'new';
    const sel = this.selection;
    if (sel) {
      if (Math.abs(x - this.timeToX(sel.start)) <= HANDLE_HIT_PX) mode = 'start';
      else if (Math.abs(x - this.timeToX(sel.end)) <= HANDLE_HIT_PX) mode = 'end';
    }
    this.gesture = {
      mode: mode,
      startX: x,
      startTime: editorUtils.clampNumber(time, clip.in, clip.out),
      moved: false,
      multi: false,
    };
    if (mode === 'start' || mode === 'end') {
      this.gesture.draft = { start: sel.start, end: sel.end };
    }
  },

  onWaveTouchMove(e) {
    const gesture = this.gesture;
    if (!gesture || gesture.multi || !this.waveCtx) return;
    if ((e.touches || []).length >= 2) {
      gesture.multi = true;
      return;
    }
    const clip = this.getSelectedClip();
    if (!clip) return;
    const x = this.touchX(e);
    const time = editorUtils.clampNumber(this.xToTime(x), clip.in, clip.out);

    if (gesture.mode === 'razor') {
      this.razorTouchTime = time;
      this.drawWave();
      return;
    }

    if (!gesture.moved && Math.abs(x - gesture.startX) >= TAP_MOVE_PX) gesture.moved = true;
    if (!gesture.moved) return;

    if (gesture.mode === 'start' || gesture.mode === 'end') {
      const draft = gesture.draft;
      if (!draft) return;
      if (gesture.mode === 'start') {
        draft.start = Math.max(clip.in, Math.min(time, draft.end - MIN_SELECTION));
      } else {
        draft.end = Math.min(clip.out, Math.max(time, draft.start + MIN_SELECTION));
      }
      this.selection = { start: draft.start, end: draft.end };
    } else {
      let a = gesture.startTime;
      let b = time;
      if (b < a) {
        const tmp = a;
        a = b;
        b = tmp;
      }
      this.selection = { start: a, end: b };
    }
    this.pushSelectionData(false);
    this.drawWave();
  },

  onWaveTouchEnd(e) {
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture || gesture.multi || !this.waveCtx) return;
    const clip = this.getSelectedClip();
    if (!clip) return;

    const x = this.touchX(e);
    const time = editorUtils.clampNumber(this.xToTime(x), clip.in, clip.out);

    if (gesture.mode === 'razor') {
      const cutTime = typeof this.razorTouchTime === 'number' ? this.razorTouchTime : time;
      this.razorTouchTime = null;
      this.drawWave();
      this.executeRazorCutAtTime(clip, cutTime);
      return;
    }

    if (!gesture.moved) {
      this.seekSource(time);
      return;
    }

    const selection = this.selection;
    if (!selection) return;

    let start = editorUtils.clampNumber(editorUtils.snapTime(selection.start, 0.1), clip.in, clip.out);
    let end = editorUtils.clampNumber(editorUtils.snapTime(selection.end, 0.1), clip.in, clip.out);

    if (end - start < MIN_SELECTION) {
      if (gesture.mode === 'start' || gesture.mode === 'end') {
        if (gesture.mode === 'start') start = Math.max(clip.in, end - MIN_SELECTION);
        else end = Math.min(clip.out, start + MIN_SELECTION);
      } else {
        this.selection = null;
        this.setData({ hasSelection: false, selection: null });
        this.drawWave();
        wx.showToast({ title: '选区太短了，至少 0.2 秒', icon: 'none' });
        return;
      }
    }

    this.selection = { start: start, end: end };
    this.pushSelectionData(true);
    this.drawWave();
  },

  onWaveTouchCancel() {
    if (this.gesture && this.gesture.mode === 'razor') {
      this.razorTouchTime = null;
    }
    this.gesture = null;
    if (this.selection) this.pushSelectionData(true);
    this.drawWave();
  },

  /* ====================================================================== */
  /* 导出（renderEdit v2：sources + clips）                                   */
  /* ====================================================================== */

  startExport() {
    if (this.data.status !== STATUS.EDITING || this.exporting) return;
    if (!this.sources.length || !this.clips.length) {
      wx.showToast({ title: '请先添加音频', icon: 'none' });
      return;
    }
    const built = editorUtils.buildRenderRequest(this.clips, this.sources, {
      tracks: this.tracks,
      volumeDb: this.data.volumeDb,
      format: 'mp3',
      bitrate: this.data.exportBitrate || '192k',
    });
    if (!built.ok) {
      wx.showModal({
        title: '暂时无法导出',
        content: built.message || '请检查片段后再导出。',
        showCancel: false,
      });
      return;
    }

    // 复杂度预检（Phase 4：Pre-flight Complexity Evaluation）
    const totalDur = editorUtils.planDuration(this.clips);
    const trackCount = (this.tracks && this.tracks.length) || 1;
    const clipCount = (this.clips && this.clips.length) || 1;
    const hasFilters = this.clips.some(c => (c.speed && c.speed !== 1) || c.gainDb || c.denoise || c.eq || c.fadeIn || c.fadeOut);
    const complexity = totalDur * (1 + 0.1 * trackCount + 0.05 * clipCount + (hasFilters ? 0.2 : 0));
    const isHeavy = complexity > 180 || totalDur > 180 || clipCount > 10;

    this.exporting = true;
    this.stopPlayback();
    this.releaseWaveCanvas();
    this.exportStartedAt = Date.now();
    this.setData({
      status: STATUS.EXPORTING,
      exportElapsed: 0,
      exportComplexityHeavy: isHeavy,
    });
    this.clearExportTimer();
    this.exportTimer = setInterval(() => {
      this.setData({ exportElapsed: Math.max(1, Math.floor((Date.now() - this.exportStartedAt) / 1000)) });
    }, 1000);

    // 防重复点击：exporting 标记 + 云函数侧校验
    wx.cloud
      .callFunction({
        name: 'ffmpegProbe',
        data: Object.assign({ action: 'renderEdit' }, built.request),
      })
      .then((callRes) => {
        const result = callRes && callRes.result;
        if (!result || result.success !== true || !result.data || !result.data.fileID) {
          throw this.makeImportError('export', this.mapExportError(result), result && result.code);
        }
        this.handleExportSuccess(result.data, editorUtils.planDuration(this.clips));
      })
      .catch((err) => {
        console.error('[editor] 导出失败', err);
        // 容错与可恢复重试机制：100% 保留当前工程状态，回到编辑态重新绑定 canvas
        this.setData({ status: STATUS.EDITING });
        this.nextTick(() => this.initWaveCanvas());
        wx.showModal({
          title: '导出失败',
          content: this.normalizeExportError(err) + '\n\n当前工程已完整保留，未丢失任何数据。',
          confirmText: '重新导出',
          cancelText: '返回检查',
          success: (res) => {
            if (res && res.confirm) {
              this.nextTick(() => this.startExport());
            }
          },
        });
      })
      .then(() => {
        this.exporting = false;
        this.clearExportTimer();
      });
  },

  mapExportError(result) {
    if (!result) return '云端没有响应，请稍后重试。';
    const code = result.code || '';
    if (code === 'DURATION_TOO_LONG') return '成片超过 10 分钟，请删减片段后再导出。';
    if (code === 'CLIP_TOO_SHORT' || code === 'PARAM_ERROR') {
      return result.errorMessage || '片段参数不合法，请撤销后重新编辑。';
    }
    if (code === 'SOURCES_TOO_MANY' || code === 'CLIPS_TOO_MANY') {
      return result.errorMessage || '音频源或片段数超过上限，请先删减。';
    }
    if (code === 'FILE_TOO_LARGE') return '源文件超过 50MB，请换一个更小的音频。';
    if (code === 'INVALID_FILE' || code === 'DECODE_FAILED') return '源文件解析失败，请重新选择音频。';
    if (code === 'TIMEOUT' || code === 'RENDER_TIMEOUT') return '合成超时了，请缩短音频或减少片段后重试。';
    return result.errorMessage || '合成失败，请稍后重试。';
  },

  normalizeExportError(err) {
    if (!err) return '合成失败，请稍后重试。';
    if (err.userMessage) return err.userMessage;
    const msg = String(err.errMsg || err.message || '');
    if (msg.indexOf('-501000') >= 0 || msg.indexOf('FunctionName') >= 0 || msg.indexOf('cloud function') >= 0) {
      return '云端服务尚未就绪，请确认 ffmpegProbe 云函数已部署。';
    }
    if (msg.indexOf('timeout') >= 0) return '网络超时了，请检查网络后重试；若多次失败，可缩短音频再试。';
    return msg || '合成失败，请检查网络后重试。';
  },

  handleExportSuccess(data, planTotal) {
    const duration = Number(data.duration) > 0 ? Number(data.duration) : planTotal;
    const fileName = data.fileName || this.buildOutputName();
    const result = {
      fileID: data.fileID,
      fileName: fileName,
      size: Number(data.size) || 0,
      sizeText: editorUtils.formatBytes(data.size),
      duration: duration,
      durationText: editorUtils.formatClock(duration),
      costSeconds: data.costMs ? (Number(data.costMs) / 1000).toFixed(1) : '',
      clipCount: this.clips.length,
    };
    // v5.1：导出成果写入「我的作品」库（失败不阻断导出主流程）
    try {
      libraryStore.addToLibrary(
        libraryStore.itemFromEdit({
          fileName: result.fileName,
          size: result.size,
          sizeText: result.sizeText,
          durationText: result.durationText,
          fileID: result.fileID,
          clipCount: result.clipCount,
        })
      );
    } catch (e) {
      console.warn('[editor] 作品库写入失败', e);
    }
    this.releaseWaveCanvas();
    this.resultTempFilePath = '';
    this._preparingFileID = '';
    this.resultFallbackTried = false;
    this.setData({
      status: STATUS.RESULT,
      result: result,
      resultPlaying: false,
      resultCurrentText: '00:00',
      resultDurationText: result.durationText,
      resultTempReady: false,
      resultPlayError: false,
      isPlaying: false,
      playMode: '',
    });
    this.setupResultAudio(result);
    this.prepareResultTempFile(result.fileID);
    this.clearDraft();
    this.updateUnloadAlert();
    wx.showToast({ title: '导出成功', icon: 'success' });
    haptics.notificationSuccess();
  },

  buildOutputName() {
    const firstSource = this.sources[0];
    const name = (firstSource && firstSource.name) || '';
    const base = name.replace(/\.[^.]+$/, '');
    return (base || '剪辑') + '_剪辑.mp3';
  },

  clearExportTimer() {
    if (this.exportTimer) {
      clearInterval(this.exportTimer);
      this.exportTimer = null;
    }
  },

  /* ====================================================================== */
  /* 结果：试听 / 转发 / 继续编辑                                             */
  /* ====================================================================== */

  setupResultAudio(result) {
    const ctx = this.resultAudio;
    if (!ctx || !result) return;
    this.resultFallbackTried = false;
    try { ctx.stop(); } catch (e) {}
    try { ctx.obeyMuteSwitch = false; } catch (e) {}

    // 如果本地临时文件已经就绪，优先直接给播放器赋本地零缓冲路径
    if (this.resultTempFilePath) {
      ctx.src = this.resultTempFilePath;
      return;
    }

    // 严禁将 cloud:// fileID 直接赋值给 InnerAudioContext.src（微信底层不支持）
    // 异步拉取 HTTPS 可播放临时链接作为后备播放源
    wx.cloud
      .getTempFileURL({ fileList: [result.fileID] })
      .then((res) => {
        const item = res && res.fileList && res.fileList[0];
        if (item && item.tempFileURL) {
          if (!this.resultTempFilePath && this.resultAudio) {
            this.resultAudio.src = item.tempFileURL;
          }
        }
      })
      .catch((err) => {
        console.warn('[editor] 获取成片临时播放链接失败', err);
      });
  },

  handleResultAudioError(err) {
    console.warn('[editor] 成片播放失败', err);
    const result = this.data.result;
    if (!result || !this.resultAudio) return;
    this.setData({ resultPlaying: false });
    if (!this.resultFallbackTried) {
      this.resultFallbackTried = true;
      if (this.resultTempFilePath) {
        try {
          this.resultAudio.src = this.resultTempFilePath;
          this.resultAudio.play();
          return;
        } catch (e) {}
      }
      wx.cloud
        .getTempFileURL({ fileList: [result.fileID] })
        .then((res) => {
          const item = res && res.fileList && res.fileList[0];
          if (item && item.tempFileURL) {
            if (this.resultAudio) {
              this.resultAudio.src = item.tempFileURL;
              this.resultAudio.play();
            }
          } else {
            this.setData({ resultPlayError: true });
          }
        })
        .catch(() => this.setData({ resultPlayError: true }));
    } else {
      this.setData({ resultPlayError: true });
    }
  },

  handleResultTimeUpdate() {
    const ctx = this.resultAudio;
    if (!ctx) return;
    const current = Number(ctx.currentTime) || 0;
    const result = this.data.result;
    const duration = Number(ctx.duration) > 0 ? Number(ctx.duration) : (result && result.duration) || 0;
    this.setData({
      resultCurrentTime: current,
      resultDuration: duration,
      resultCurrentText: editorUtils.formatClock(current),
      resultDurationText: editorUtils.formatClock(duration),
    });
  },

  toggleResultPlay() {
    const ctx = this.resultAudio;
    const result = this.data.result;
    if (!ctx || !result) return;
    if (this.data.resultPlaying) {
      try {
        ctx.pause();
      } catch (e) {}
      return;
    }

    // 检查并确保有合法的播放源：本地临时路径优先，其次临时网络链接
    if (!ctx.src || ctx.src.startsWith('cloud://')) {
      if (this.resultTempFilePath) {
        ctx.src = this.resultTempFilePath;
      } else {
        if (wx.showLoading) wx.showLoading({ title: '准备试听音频...', mask: false });
        wx.cloud
          .getTempFileURL({ fileList: [result.fileID] })
          .then((res) => {
            if (wx.hideLoading) wx.hideLoading();
            const item = res && res.fileList && res.fileList[0];
            if (item && item.tempFileURL) {
              ctx.src = item.tempFileURL;
              ctx.play();
            } else if (this.resultTempFilePath) {
              ctx.src = this.resultTempFilePath;
              ctx.play();
            } else {
              wx.showToast({ title: '成片准备中，请重试', icon: 'none' });
            }
          })
          .catch(() => {
            if (wx.hideLoading) wx.hideLoading();
            wx.showToast({ title: '成片加载失败', icon: 'none' });
          });
        return;
      }
    }

    try {
      ctx.play();
    } catch (e) {
      console.warn('播放失败:', e);
      this.setData({ resultPlayError: true });
      wx.showToast({ title: '成片试听失败，可转发至微信聊天直接试听', icon: 'none' });
    }
  },

  onResultSeek(e) {
    const val = Number(e.detail.value) || 0;
    if (this.resultAudio) {
      try {
        this.resultAudio.seek(val);
      } catch (err) {}
    }
  },

  prepareResultTempFile(fileID) {
    if (!fileID || this._preparingFileID === fileID) return;
    this._preparingFileID = fileID;
    wx.cloud
      .downloadFile({ fileID: fileID })
      .then((res) => {
        if (this._preparingFileID === fileID) this._preparingFileID = '';
        if (!res || !res.tempFilePath) return;
        if (!this.data.result || this.data.result.fileID !== fileID) return;
        this.resultTempFilePath = res.tempFilePath;
        // 关键增强：本地文件下载就绪后优先切换为本地零缓冲源进行试听
        if (this.resultAudio) {
          const wasPlaying = this.data.resultPlaying;
          const curTime = this.resultAudio.currentTime || 0;
          try {
            this.resultAudio.src = res.tempFilePath;
            if (wasPlaying) {
              this.resultAudio.seek(curTime);
              this.resultAudio.play();
            }
          } catch (e) {}
        }
        this.setData({ resultTempReady: true, resultPlayError: false });
      })
      .catch((err) => {
        if (this._preparingFileID === fileID) this._preparingFileID = '';
        console.warn('[editor] 预下载成片失败', err);
      });
  },

  shareResult() {
    const result = this.data.result;
    if (!result || !result.fileID) return;
    if (!wx.shareFileMessage) {
      wx.showModal({
        title: '当前环境不支持转发',
        content: '请在手机微信中使用；电脑版可先点「试听成片」确认后再用微信发送。',
        showCancel: false,
      });
      return;
    }
    if (!this.resultTempFilePath) {
      // shareFileMessage 必须在用户点击手势内同步调用，先下载再提示点第二次
      this.prepareResultTempFile(result.fileID);
      wx.showToast({ title: '文件准备中，请 1 秒后再点一次', icon: 'none' });
      return;
    }
    wx.shareFileMessage({
      filePath: this.resultTempFilePath,
      fileName: result.fileName,
      success: () => wx.showToast({ title: '已发送，请在聊天中保存', icon: 'none' }),
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        if (msg.indexOf('cancel') >= 0) return;
        wx.showModal({
          title: '转发失败',
          content: msg || '微信未允许本次转发，可稍后重试。',
          showCancel: false,
        });
      },
    });
  },

  reEdit() {
    if (this.data.status !== STATUS.RESULT) return;
    this.stopResultPlayback();
    if (this.resultAudio) {
      try { this.resultAudio.src = ''; } catch (e) {}
    }
    this.resultTempFilePath = '';
    this._preparingFileID = '';
    this.stopPlaybackAudioOnly();
    this.playback = null;
    this.paused = false;
    this.isMultiTrackPlaying = false;
    this.setData({
      status: STATUS.EDITING,
      resultPlaying: false,
      result: null,
      resultTempReady: false,
      resultPlayError: false,
    });
    this.nextTick(() => {
      this.initWaveCanvas();
      this.scheduleSaveDraft();
      this.updateUnloadAlert();
    });
  },

  restartEditing() {
    wx.showModal({
      title: '重新开始',
      content: '当前编辑不会保存，确定清空并重新选择音频吗？',
      success: (res) => {
        if (!res.confirm) return;
        this.resetAll();
        this.nextTick(() => this.chooseAudioFiles());
      },
    });
  },
});
