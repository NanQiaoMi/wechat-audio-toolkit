// miniprogram/pages/index/index.js
const app = getApp();
const libraryStore = require('../../utils/library-store.js');

// 与云函数保持一致：A 路线下各输出格式的保守时长上限（秒）
const FORMAT_LIMIT_SEC = { mp3: 1200, wav: 1800, flac: 1800, m4a: 600, aac: 600, ogg: 600 };

// 压缩率与比特率规格库
const COMPRESSION_BITRATES = [
  { value: '64k',  kbps: 64,  label: '64 kbps',  shortGrade: '极小体积', quality: '极小体积 · 微信畅发 · 适合长录音/人声解说', sub: '长录音/极小' },
  { value: '96k',  kbps: 96,  label: '96 kbps',  shortGrade: '高压缩',   quality: '高压缩 · 轻巧便携 · 节省约 90% 体积', sub: '高压缩/省空间' },
  { value: '128k', kbps: 128, label: '128 kbps', shortGrade: '标准便携', quality: '标准便携 · 日常分享 · 节省约 85% 体积', sub: '标准便携' },
  { value: '192k', kbps: 192, label: '192 kbps', shortGrade: '标准推荐', quality: '标准高保真 · 官方推荐 · 兼顾听感与体积', sub: '官方推荐' },
  { value: '256k', kbps: 256, label: '256 kbps', shortGrade: '超清音质', quality: '超清高保真 · 音乐发烧 · 饱满动态声场', sub: '音乐发烧' },
  { value: '320k', kbps: 320, label: '320 kbps', shortGrade: '极品母带', quality: '极品高保真 · CD母带级 · 极致听觉盛宴', sub: 'CD母带级' },
];

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

Page({
  data: {
    // 状态流转: IDLE | UPLOADING | TRANSCODING | SUCCESS
    status: 'IDLE',
    statusText: '准备就绪',

    // 源音频数据
    sourceFile: null,
    sourcePlayable: false,
    isSourcePlaying: false,
    sourceDuration: 0,
    sourceCurrentTime: 0,
    sourceDurationText: '00:00',
    sourceCurrentTimeText: '00:00',
    soundBars: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],

    // 格式定义 (Refero Superr 风格化标签)
    formats: [
      { key: 'mp3', name: 'MP3', desc: '全能播放 · 车载首选', badge: 'Everywhere 🚗' },
      { key: 'wav', name: 'WAV', desc: '无损母带 · 剪辑工程', badge: 'Studio 🎛️' },
      { key: 'm4a', name: 'M4A', desc: '高保真 · 苹果生态', badge: 'Apple / iOS 📱' },
      { key: 'aac', name: 'AAC', desc: '轻巧体积 · 纯净通透', badge: 'Crisp 💎' },
      { key: 'flac', name: 'FLAC', desc: '母带无损 · 发烧归档', badge: 'Audiophile 🎧' },
      { key: 'ogg', name: 'OGG', desc: '开放编码 · 游戏音效', badge: 'Open Web 🌐' },
    ],
    targetFormat: 'mp3',

    // 核心压缩与音质控制
    compressionOptionsList: COMPRESSION_BITRATES,
    compressionIndex: 3, // 默认 192k 标准推荐
    isCompressibleFormat: true,
    estimatedSizeText: '约 0 MB',
    savedRatioText: 75,
    qualityGradeText: '标准高保真 · 官方推荐 · 兼顾听感与体积',
    qualityGradeShort: '标准推荐',

    // 高级参数
    showAdvanced: false,
    bitrateOptions: COMPRESSION_BITRATES,
    sampleRateOptions: [
      { value: 0, label: '同原音频' },
      { value: 44100, label: '44.1 kHz (CD级)' },
      { value: 48000, label: '48 kHz (广播级)' },
    ],
    options: {
      bitrate: '192k',
      sampleRate: 0,
      channels: 2,
    },

    // 转换结果
    convertResult: null,
    resultTempFilePath: '',
    filePreparing: false,
    isTargetPlaying: false,
    targetDuration: 0,
    targetCurrentTime: 0,
    targetDurationText: '00:00',
    targetCurrentTimeText: '00:00',
    targetPlayable: true,
    targetPlayError: false,

    // 作品库角标 / 隐私授权
    libraryCount: 0,
    showPrivacy: false,
  },

  sourceAudioCtx: null,
  targetAudioCtx: null,

  onLoad() {
    this.historyTempPaths = Object.create(null);
    this.initAudioContexts();
    this.initPrivacyAuthorization();
    this.updateCompressionEstimate();
    if (wx.showShareMenu) {
      try { wx.showShareMenu({ menus: ['shareAppMessage'] }); } catch (e) {}
    }
  },

  onShow() {
    this.consumePendingAudio();
    this.refreshLibraryCount();
  },

  /** 消费「现场录音」页一次性传入的音频，填充为转换源 */
  consumePendingAudio() {
    let appInstance = null;
    try { appInstance = getApp(); } catch (e) {}
    const pending = appInstance && appInstance.globalData && appInstance.globalData.pendingAudio;
    if (!pending || !pending.path) return;
    appInstance.globalData.pendingAudio = null;
    const extName = (pending.extName || 'MP3').toUpperCase();
    const extLower = (pending.extLower || extName).toLowerCase();
    const size = Number(pending.size) || 0;
    const duration = Number(pending.durationSec) || 0;
    const sourcePlayable = ['mp3', 'aac', 'm4a', 'wav'].indexOf(extLower) >= 0;
    this.stopAllAudio();
    this.setData({
      sourceFile: {
        path: pending.path,
        name: pending.name || (pending.from === 'video-extract' ? '视频提取原声.m4a' : '现场录音.mp3'),
        size: size,
        sizeText: formatBytes(size),
        extName: extName,
        extLower: extLower,
      },
      sourcePlayable: sourcePlayable,
      status: 'IDLE',
      statusText: '准备就绪',
      convertResult: null,
      resultTempFilePath: '',
      targetPlayable: true,
      targetPlayError: false,
      sourceDuration: duration,
      sourceDurationText: formatTime(duration),
      sourceCurrentTime: 0,
      sourceCurrentTimeText: '00:00',
    });
    this.updateCompressionEstimate();
    if (sourcePlayable && this.sourceAudioCtx) {
      try { this.sourceAudioCtx.src = pending.path; } catch (e) {}
    }
    const toastTitle = pending.from === 'video-extract' ? '视频原声已就绪' : '录音已就绪';
    wx.showToast({ title: toastTitle, icon: 'none' });
  },

  /** 刷新右上角作品库角标 */
  refreshLibraryCount() {
    try {
      const lib = libraryStore.loadAndMigrate();
      this.setData({ libraryCount: lib && lib.items ? lib.items.length : 0 });
    } catch (e) {
      this.setData({ libraryCount: 0 });
    }
  },

  onShareAppMessage() {
    return {
      title: '音频工具箱 · 格式转换 / 剪辑 / 录音，一站搞定',
      path: '/pages/index/index',
    };
  },


  initPrivacyAuthorization() {
    if (!wx.onNeedPrivacyAuthorization) return;
    wx.onNeedPrivacyAuthorization((resolve) => {
      this.privacyResolve = resolve;
      this.setData({ showPrivacy: true });
    });
  },

  handleAgreePrivacy() {
    if (this.privacyResolve) {
      this.privacyResolve({ buttonId: 'agree-btn', event: 'agree' });
      this.privacyResolve = null;
    }
    this.setData({ showPrivacy: false });
  },

  handleDisagreePrivacy() {
    if (this.privacyResolve) {
      this.privacyResolve({ buttonId: 'disagree-btn', event: 'disagree' });
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
    } else {
      wx.showToast({ title: '当前基础库不支持打开隐私政策', icon: 'none' });
    }
  },

  onHide() {
    this.stopAllAudio();
  },

  onUnload() {
    this.destroyAudioContexts();
  },

  /**
   * 初始化音频播放实例
   */
  initAudioContexts() {
    // 突破 iOS 硬件静音拨片限制，保证试听声音正常通过扬声器外放
    if (wx.setInnerAudioOption) {
      try {
        wx.setInnerAudioOption({
          obeyMuteSwitch: false,
          mixWithOther: false,
        });
      } catch (e) {}
    }

    // 1. 原音频播放上下文
    this.sourceAudioCtx = wx.createInnerAudioContext();
    try { this.sourceAudioCtx.obeyMuteSwitch = false; } catch (e) {}
    this.sourceAudioCtx.onPlay(() => this.setData({ isSourcePlaying: true }));
    this.sourceAudioCtx.onPause(() => this.setData({ isSourcePlaying: false }));
    this.sourceAudioCtx.onStop(() => this.setData({ isSourcePlaying: false, sourceCurrentTime: 0 }));
    this.sourceAudioCtx.onEnded(() => this.setData({ isSourcePlaying: false, sourceCurrentTime: 0 }));
    this.sourceAudioCtx.onTimeUpdate(() => {
      if (!this.sourceAudioCtx) return;
      const cur = this.sourceAudioCtx.currentTime;
      const dur = this.sourceAudioCtx.duration || this.data.sourceDuration;
      this.setData({
        sourceCurrentTime: cur,
        sourceDuration: dur,
        sourceCurrentTimeText: formatTime(cur),
        sourceDurationText: formatTime(dur),
      });
    });
    this.sourceAudioCtx.onCanplay(() => {
      const d = this.sourceAudioCtx && this.sourceAudioCtx.duration;
      if (d > 0) {
        this.setData({ sourceDuration: d, sourceDurationText: formatTime(d) });
        this.updateCompressionEstimate();
      }
    });
    this.sourceAudioCtx.onError(err => {
      console.warn('原音频播放错误:', err);
      this.setData({ isSourcePlaying: false });
    });

    // 2. 转码目标音频播放上下文
    this.targetAudioCtx = wx.createInnerAudioContext();
    try { this.targetAudioCtx.obeyMuteSwitch = false; } catch (e) {}
    this.targetAudioCtx.onPlay(() => this.setData({ isTargetPlaying: true, targetPlayError: false }));
    this.targetAudioCtx.onPause(() => this.setData({ isTargetPlaying: false }));
    this.targetAudioCtx.onStop(() => this.setData({ isTargetPlaying: false, targetCurrentTime: 0 }));
    this.targetAudioCtx.onEnded(() => this.setData({ isTargetPlaying: false, targetCurrentTime: 0, targetCurrentTimeText: '00:00' }));
    this.targetAudioCtx.onTimeUpdate(() => {
      if (!this.targetAudioCtx) return;
      const cur = this.targetAudioCtx.currentTime;
      const dur = this.targetAudioCtx.duration || this.data.targetDuration;
      this.setData({
        targetCurrentTime: cur,
        targetDuration: dur,
        targetCurrentTimeText: formatTime(cur),
        targetDurationText: formatTime(dur),
      });
    });
    this.targetAudioCtx.onCanplay(() => {
      const d = this.targetAudioCtx && this.targetAudioCtx.duration;
      if (d > 0) this.setData({ targetDuration: d, targetDurationText: formatTime(d) });
    });
    this.targetAudioCtx.onError(err => {
      console.warn('目标音频播放错误:', err);
      this.setData({ isTargetPlaying: false, targetPlayError: true });
      // 容灾自愈：若当前使用的是网络 downloadUrl 遇到错误，且本地临时文件已下载，则尝试切到本地临时路径
      if (this.data.resultTempFilePath && this.targetAudioCtx && this.targetAudioCtx.src !== this.data.resultTempFilePath) {
        try {
          this.targetAudioCtx.src = this.data.resultTempFilePath;
          return;
        } catch (e) {}
      }
    });
  },

  destroyAudioContexts() {
    if (this.sourceAudioCtx) {
      this.sourceAudioCtx.stop();
      this.sourceAudioCtx.destroy();
      this.sourceAudioCtx = null;
    }
    if (this.targetAudioCtx) {
      this.targetAudioCtx.stop();
      this.targetAudioCtx.destroy();
      this.targetAudioCtx = null;
    }
  },

  stopAllAudio() {
    if (this.sourceAudioCtx) this.sourceAudioCtx.stop();
    if (this.targetAudioCtx) this.targetAudioCtx.stop();
    this.setData({
      isSourcePlaying: false,
      isTargetPlaying: false,
    });
  },

  /**
   * 选择音频文件 (从微信聊天会话)
   */
  chooseAudioFile() {
    this.stopAllAudio();
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'amr', 'wma', 'ape'],
      success: res => {
        if (!res.tempFiles || res.tempFiles.length === 0) return;
        const file = res.tempFiles[0];

        // 校验大小：限制 50MB
        const maxBytes = 50 * 1024 * 1024;
        if (file.size > maxBytes) {
          wx.showModal({
            title: '文件超出限制',
            content: '为保证微信云端极速转码体验，单文件大小建议在 50MB 以内。',
            showCancel: false,
          });
          return;
        }

        // 提取扩展名
        const extMatch = file.name.match(/\.([a-zA-Z0-9]+)$/);
        const extName = extMatch ? extMatch[1].toUpperCase() : 'AUDIO';
        const extLower = extName.toLowerCase();

        // 判断是否直接在前端可试听 (mp3, aac, m4a, wav 直接支持)
        const playableFormats = ['mp3', 'aac', 'm4a', 'wav'];
        const sourcePlayable = playableFormats.includes(extLower);

        this.setData({
          sourceFile: {
            path: file.path,
            name: file.name,
            size: file.size,
            sizeText: formatBytes(file.size),
            extName: extName,
            extLower: extLower,
          },
          sourcePlayable,
          status: 'IDLE',
          convertResult: null,
          sourceCurrentTime: 0,
          sourceDuration: 0,
          sourceCurrentTimeText: '00:00',
          sourceDurationText: '00:00',
        });
        this.updateCompressionEstimate();

        // 若可试听，配置试听源
        if (sourcePlayable && this.sourceAudioCtx) {
          this.sourceAudioCtx.src = file.path;
        }
      },
      fail: err => {
        const msg = (err && err.errMsg) || '';
        if (msg.includes('privacy') || msg.includes('privacy agreement')) {
          wx.showModal({
            title: '隐私授权未配置',
            content: '当前版本的隐私保护指引未声明“选择文件”接口。请在微信公众平台 → 设置 → 服务内容声明 → 用户隐私保护指引中补充“选中的文件 / wx.chooseMessageFile”，或将小程序更新到已配置隐私指引的版本后再试。',
            showCancel: false,
          });
          return;
        }
        if (!msg.includes('cancel')) {
          wx.showToast({ title: '选择文件失败', icon: 'none' });
        }
      },
    });
  },

  /**
   * 原音频播放/暂停控制
   */
  togglePlaySource() {
    if (!this.sourceAudioCtx || !this.data.sourceFile) return;
    if (this.data.isSourcePlaying) {
      this.sourceAudioCtx.pause();
    } else {
      if (this.targetAudioCtx) this.targetAudioCtx.pause();
      this.sourceAudioCtx.play();
    }
  },

  onSourceSeek(e) {
    const val = e.detail.value;
    if (this.sourceAudioCtx) {
      this.sourceAudioCtx.seek(val);
    }
  },

  /**
   * 选择目标格式
   */
  selectTargetFormat(e) {
    const format = e.currentTarget.dataset.format;
    this.setData({ targetFormat: format });
    this.updateCompressionEstimate();
    if (wx.vibrateShort) {
      try { wx.vibrateShort({ type: 'light' }); } catch (err) {}
    }
  },

  /**
   * 压缩比率与预估体积实时测算
   */
  updateCompressionEstimate() {
    const { sourceFile, sourceDuration, compressionIndex, targetFormat } = this.data;
    const isCompressible = !['wav', 'flac'].includes(targetFormat);
    const opt = COMPRESSION_BITRATES[compressionIndex] || COMPRESSION_BITRATES[3];

    let sizeText = '约 0 MB';
    let savedRatio = 0;

    if (sourceFile) {
      const dur = sourceDuration > 0 ? sourceDuration : Math.max(10, Math.round(sourceFile.size / (192 * 1000 / 8)));
      const bytes = (dur * opt.kbps * 1000 / 8) + 4096;
      if (bytes < 1024 * 1024) {
        sizeText = '约 ' + Math.max(1, Math.round(bytes / 1024)) + ' KB';
      } else {
        sizeText = '约 ' + (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      }

      if (sourceFile.size > bytes) {
        savedRatio = Math.max(1, Math.min(98, Math.round(((sourceFile.size - bytes) / sourceFile.size) * 100)));
      }
    } else {
      sizeText = opt.kbps <= 96 ? '约 1~2 MB' : (opt.kbps <= 192 ? '约 3~5 MB' : '约 6~8 MB');
      savedRatio = opt.kbps <= 64 ? 95 : (opt.kbps <= 96 ? 90 : (opt.kbps <= 128 ? 85 : (opt.kbps <= 192 ? 75 : (opt.kbps <= 256 ? 50 : 30))));
    }

    this.setData({
      isCompressibleFormat: isCompressible,
      estimatedSizeText: sizeText,
      savedRatioText: savedRatio,
      qualityGradeText: opt.quality,
      qualityGradeShort: opt.shortGrade,
      'options.bitrate': opt.value,
    });
  },

  selectBitrateIndex(e) {
    const idx = Number(e.currentTarget.dataset.index) || 0;
    this.setData({ compressionIndex: idx });
    this.updateCompressionEstimate();
    if (wx.vibrateShort) {
      try { wx.vibrateShort({ type: 'light' }); } catch (err) {}
    }
  },

  onBitrateSliderChange(e) {
    const idx = Number(e.detail.value) || 0;
    this.setData({ compressionIndex: idx });
    this.updateCompressionEstimate();
    if (wx.vibrateShort) {
      try { wx.vibrateShort({ type: 'light' }); } catch (err) {}
    }
  },

  onBitrateSliderChanging(e) {
    const idx = Number(e.detail.value) || 0;
    this.setData({ compressionIndex: idx });
    this.updateCompressionEstimate();
  },

  quickExtremeCompress() {
    this.setData({ compressionIndex: 0 }); // 64k 极小体积
    this.updateCompressionEstimate();
    if (wx.vibrateShort) {
      try { wx.vibrateShort({ type: 'medium' }); } catch (err) {}
    }
    wx.showToast({ title: '已开启极限压缩 (64k)', icon: 'none' });
  },

  switchToMp3Compress() {
    this.setData({ targetFormat: 'mp3' });
    this.updateCompressionEstimate();
    if (wx.vibrateShort) {
      try { wx.vibrateShort({ type: 'medium' }); } catch (err) {}
    }
    wx.showToast({ title: '已切为 MP3 并开启压缩', icon: 'none' });
  },

  /**
   * 高级设置折叠
   */
  toggleAdvanced() {
    this.setData({ showAdvanced: !this.data.showAdvanced });
  },

  setBitrate(e) {
    const val = e.currentTarget.dataset.val;
    const idx = COMPRESSION_BITRATES.findIndex(b => b.value === val);
    if (idx >= 0) {
      this.setData({ compressionIndex: idx });
    }
    this.setData({ 'options.bitrate': val });
    this.updateCompressionEstimate();
  },

  setSampleRate(e) {
    const val = Number(e.currentTarget.dataset.val);
    this.setData({ 'options.sampleRate': val });
  },

  setChannels(e) {
    const val = Number(e.currentTarget.dataset.val);
    this.setData({ 'options.channels': val });
  },

  /**
   * 启动转码流程
   */
  async startConvert() {
    const { sourceFile, targetFormat, options } = this.data;
    if (!sourceFile) {
      wx.showToast({ title: '请先选择音频文件', icon: 'none' });
      return;
    }

    this.stopAllAudio();

    // MVP 限制：50MB
    if (sourceFile.size && sourceFile.size > 50 * 1024 * 1024) {
      wx.showModal({ title: '文件过大', content: '单文件请控制在 50MB 以内，可先压缩或拆分。', showCancel: false });
      return;
    }

    // 已知时长时按输出格式做前端预检（后端同样会校验）
    const limitSec = FORMAT_LIMIT_SEC[targetFormat];
    if (limitSec && this.data.sourceDuration > 0 && this.data.sourceDuration > limitSec) {
      wx.showModal({
        title: '时长超出建议',
        content: `当前音频约 ${Math.ceil(this.data.sourceDuration / 60)} 分钟，${targetFormat.toUpperCase()} 建议 ${Math.floor(limitSec / 60)} 分钟以内；可改用 MP3/WAV/FLAC，或先裁剪音频。`,
        showCancel: false,
      });
      return;
    }

    try {
      // Step 1: 上传音频至云存储
      this.setData({
        status: 'UPLOADING',
        statusText: '正在上传音频至云存储...',
      });

      const randomKey = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const cloudPath = `temp_audios/${randomKey}.${sourceFile.extLower}`;

      const uploadRes = await wx.cloud.uploadFile({
        cloudPath,
        filePath: sourceFile.path,
      });

      if (!uploadRes.fileID) {
        throw new Error('上传云存储失败，未返回 fileID');
      }

      // Step 2: 调用云函数执行 FFmpeg 转码
      this.setData({
        status: 'TRANSCODING',
        statusText: 'FFmpeg 云端转码中...',
      });

      const callRes = await wx.cloud.callFunction({
        name: 'ffmpegProbe',
        data: {
          fileID: uploadRes.fileID,
          targetFormat: targetFormat,
          fileName: sourceFile.name,
          options: {
            bitrate: options.bitrate,
            sampleRate: options.sampleRate || undefined,
            channels: options.channels,
          },
          autoCleanSource: true,
        },
      });

      const result = callRes.result;
      if (!result || !result.success) {
        throw new Error(result ? result.errorMessage : '云函数转码无响应');
      }

      const transData = result.data;
      const savedRatio = sourceFile.size > transData.targetSize
        ? Math.round(((sourceFile.size - transData.targetSize) / sourceFile.size) * 100)
        : 0;

      const convertResult = {
        fileID: transData.fileID,
        downloadUrl: transData.downloadUrl,
        fileName: transData.fileName,
        targetFormat: transData.targetFormat,
        targetSize: transData.targetSize,
        targetSizeText: formatBytes(transData.targetSize),
        savedRatio,
        duration: transData.duration,
        costSeconds: (transData.costTimeMs / 1000).toFixed(1),
      };

      // 判断目标格式是否支持微信原生前端直接试听
      const sys = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
      const isIos = (sys.platform || '').toLowerCase() === 'ios';
      const targetFmt = convertResult.targetFormat.toLowerCase();
      const targetPlayable = isIos
        ? ['mp3', 'm4a', 'wav', 'aac'].includes(targetFmt)
        : ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg'].includes(targetFmt);

      this.setData({
        status: 'SUCCESS',
        statusText: '转码完成',
        convertResult,
        targetPlayable,
        targetPlayError: false,
        resultTempFilePath: '',
        filePreparing: true,
        sourceDuration: transData.duration || this.data.sourceDuration,
        sourceDurationText: formatTime(transData.duration || this.data.sourceDuration),
        targetDuration: transData.duration || this.data.sourceDuration,
        targetDurationText: formatTime(transData.duration || this.data.sourceDuration),
      });
      this.prepareResultTempFile(convertResult.fileID);

      // 准备新音频试听播放源
      if (this.targetAudioCtx && targetPlayable && convertResult.downloadUrl) {
        this.targetAudioCtx.src = convertResult.downloadUrl;
      }

      // 存入作品库（v5.1：统一「我的作品」，旧 audio_convert_history 仅做迁移兼容）
      this.saveHistoryRecord({
        id: Date.now(),
        fileName: sourceFile.name,
        targetFileName: convertResult.fileName,
        sourceExt: sourceFile.extName,
        targetFormat: convertResult.targetFormat.toUpperCase(),
        targetSize: convertResult.targetSize,
        targetSizeText: convertResult.targetSizeText,
        duration: convertResult.duration,
        fileID: convertResult.fileID,
        downloadUrl: convertResult.downloadUrl,
        time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      });

      wx.showToast({ title: '转码成功！', icon: 'success' });
    } catch (err) {
      console.error('转码过程错误:', err);
      this.setData({ status: 'IDLE', statusText: '准备就绪' });
      wx.showModal({
        title: '转码失败',
        content: err.message || '请检查是否已在微信开发者工具中部署 ffmpegProbe 云函数。',
        showCancel: false,
      });
    }
  },

  /**
   * 目标音频播放控制
   */
  togglePlayTarget() {
    if (!this.targetAudioCtx || !this.data.convertResult) return;
    const { targetPlayable, isTargetPlaying, resultTempFilePath, convertResult } = this.data;

    if (!targetPlayable) {
      wx.showModal({
        title: '格式试听提示',
        content: `当前 ${convertResult.targetFormat.toUpperCase()} 为母带专用编码，微信原生系统播放器暂不支持页面内直接预览。\n\n音频已按无损高品质完整转换，请点击下方「发给微信好友」或「保存/转发文件」，在微信聊天中可直接原声试听与保存！`,
        showCancel: false,
      });
      return;
    }

    if (isTargetPlaying) {
      this.targetAudioCtx.pause();
    } else {
      if (this.sourceAudioCtx) this.sourceAudioCtx.pause();

      const src = resultTempFilePath || convertResult.downloadUrl;
      if (!src && convertResult.fileID) {
        if (wx.showLoading) wx.showLoading({ title: '准备试听音频...', mask: false });
        wx.cloud.getTempFileURL({ fileList: [convertResult.fileID] })
          .then(res => {
            if (wx.hideLoading) wx.hideLoading();
            const item = res.fileList && res.fileList[0];
            if (item && item.tempFileURL) {
              this.targetAudioCtx.src = item.tempFileURL;
              this.targetAudioCtx.play();
            } else {
              wx.showToast({ title: '试听音频准备中，请重试', icon: 'none' });
            }
          })
          .catch(() => {
            if (wx.hideLoading) wx.hideLoading();
            wx.showToast({ title: '加载失败，请重试', icon: 'none' });
          });
        return;
      }

      if (src && this.targetAudioCtx.src !== src) {
        this.targetAudioCtx.src = src;
      }

      try {
        this.targetAudioCtx.play();
      } catch (err) {
        console.warn('播放失败:', err);
        wx.showToast({ title: '播放启动失败，请重试', icon: 'none' });
      }
    }
  },

  onTargetSeek(e) {
    const val = e.detail.value;
    if (this.targetAudioCtx) {
      this.targetAudioCtx.seek(val);
    }
  },

  /**
   * 转换成功后预下载结果文件：shareFileMessage 必须在用户点击手势内同步调用，
   * 不能等 await 下载完再调用，否则会报 can only be invoked by user TAP gesture。
   */
  prepareResultTempFile(fileID) {
    if (!fileID) return;
    wx.cloud.downloadFile({ fileID })
      .then(res => {
        this.setData({ resultTempFilePath: res.tempFilePath, filePreparing: false });
        if (this.historyTempPaths) this.historyTempPaths[fileID] = res.tempFilePath;
        // 关键增强：本地文件下载就绪后优先切换为本地零缓冲源进行试听
        if (this.targetAudioCtx && this.data.targetPlayable && res.tempFilePath) {
          const wasPlaying = this.data.isTargetPlaying;
          const curTime = this.targetAudioCtx.currentTime || 0;
          try {
            this.targetAudioCtx.src = res.tempFilePath;
            if (wasPlaying) {
              this.targetAudioCtx.seek(curTime);
              this.targetAudioCtx.play();
            }
          } catch (e) {}
        }
      })
      .catch(() => {
        this.setData({ filePreparing: false });
      });
  },

  shareLocalFile(filePath, fileName) {
    if (!wx.shareFileMessage) {
      wx.showModal({ title: '当前环境不支持转发', content: '请在手机微信中使用，或复制下载链接到电脑下载。', showCancel: false });
      return;
    }
    wx.shareFileMessage({
      filePath,
      fileName,
      success: () => wx.showToast({ title: '已发送，请在聊天中保存', icon: 'none' }),
      fail: err => {
        const msg = (err && err.errMsg) || '';
        if (msg.includes('cancel')) return;
        wx.showModal({
          title: '转发失败',
          content: (msg || '微信未允许本次转发') + '\n可复制下载链接到电脑下载。',
          showCancel: false,
        });
      },
    });
  },

  /**
   * 一键分享给微信好友（同步使用已预下载的本地文件，保留用户手势）
   */
  shareToFriend() {
    const { convertResult, resultTempFilePath } = this.data;
    if (!convertResult || !convertResult.fileID) return;
    if (!resultTempFilePath) {
      this.prepareResultTempFile(convertResult.fileID);
      wx.showToast({ title: '文件准备中，请 1 秒后再点', icon: 'none' });
      return;
    }
    this.shareLocalFile(resultTempFilePath, convertResult.fileName);
  },

  /**
   * 保存/转发文件：PC 端可直接保存到磁盘；手机端走微信文件转发
   */
  saveToLocal() {
    const { convertResult, resultTempFilePath } = this.data;
    if (!convertResult || !convertResult.fileID) return;
    if (!resultTempFilePath) {
      this.prepareResultTempFile(convertResult.fileID);
      wx.showToast({ title: '文件准备中，请 1 秒后再点', icon: 'none' });
      return;
    }
    const sys = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
    const platform = String(sys.platform || '').toLowerCase();
    const isPC = platform === 'windows' || platform === 'mac' || platform === 'pc';

    if (platform === 'devtools') {
      wx.showModal({
        title: '开发者工具不支持保存',
        content: '微信开发者工具模拟器无法写入本地文件。请在手机微信或电脑版微信中扫码打开预览，再使用“保存/转发文件”。',
        showCancel: false,
      });
      return;
    }

    if (isPC) {
      if (wx.saveFileToDisk) {
        wx.saveFileToDisk({
          filePath: resultTempFilePath,
          fileName: convertResult.fileName,
          success: () => wx.showToast({ title: '已保存到电脑磁盘', icon: 'success' }),
          fail: err => {
            const msg = (err && err.errMsg) || '';
            if (msg.includes('cancel')) return;
            wx.showModal({
              title: '保存到电脑失败',
              content: '当前环境可能不支持直接保存文件。\n可点击“复制下载链接”，在电脑浏览器中下载。',
              confirmText: '复制链接',
              cancelText: '知道了',
              success: r => { if (r.confirm) this.copyDownloadLink(); },
            });
          },
        });
      } else {
        this.copyDownloadLink();
      }
      return;
    }

    // 手机微信：小程序无法直接写入公共文件目录，只能转发到聊天后保存
    if (!wx.shareFileMessage) {
      wx.showModal({
        title: '手机端无法直接保存',
        content: '请复制下载链接到电脑浏览器下载，或升级微信后使用“转发文件”功能。',
        showCancel: false,
      });
      return;
    }
    this.shareLocalFile(resultTempFilePath, convertResult.fileName);
  },

  /**
   * 复制临时下载外链
   */
  copyDownloadLink() {
    const { convertResult } = this.data;
    if (!convertResult || !convertResult.downloadUrl) {
      wx.showToast({ title: '未获取到链接', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: convertResult.downloadUrl,
      success: () => {
        wx.showToast({ title: '链接已复制到剪贴板', icon: 'none' });
      },
    });
  },

  /**
   * 重置状态转换下一首
   */
  resetAll() {
    this.stopAllAudio();
    this.setData({
      status: 'IDLE',
      statusText: '准备就绪',
      resultTempFilePath: '',
      filePreparing: false,
      sourceFile: null,
      sourcePlayable: false,
      convertResult: null,
      sourceCurrentTime: 0,
      sourceDuration: 0,
      targetCurrentTime: 0,
      targetDuration: 0,
    });
  },

  /**
   * 保存转换作品到「我的作品」库
   */
  saveHistoryRecord(record) {
    try {
      libraryStore.addToLibrary(libraryStore.itemFromConvert(record));
      this.refreshLibraryCount();
    } catch (e) {
      console.warn('保存作品库失败', e);
    }
  },

  openSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  goEditor() {
    this.stopAllAudio();
    wx.navigateTo({
      url: '/pages/editor/editor',
      fail: (err) => {
        console.warn('navigateTo /pages/editor/editor 失败，尝试 redirectTo:', err);
        wx.redirectTo({
          url: '/pages/editor/editor',
          fail: (redirectErr) => {
            console.error('打开剪辑工坊失败:', redirectErr);
            wx.showToast({ title: '无法打开剪辑工坊', icon: 'none' });
          },
        });
      },
    });
  },

  goVideoExtract() {
    this.stopAllAudio();
    wx.navigateTo({
      url: '/pages/video-extract/video-extract?from=index',
      fail: () => wx.showToast({ title: '无法打开视频提取', icon: 'none' }),
    });
  },

  goRecord() {
    this.stopAllAudio();
    wx.navigateTo({ url: '/pages/record/record?from=index' });
  },

  goLibrary() {
    this.stopAllAudio();
    wx.navigateTo({
      url: '/pages/library/library',
      fail: () => wx.showToast({ title: '无法打开作品库', icon: 'none' }),
    });
  },

  preventBubble() {},


});
