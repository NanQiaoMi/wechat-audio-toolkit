// miniprogram/pages/video-extract/video-extract.js
const videoExtractor = require('../../utils/video-extractor');
const libraryStore = require('../../utils/library-store');
const haptics = require('../../utils/haptics');

Page({
  data: {
    status: 'idle', // 'idle' | 'extracting' | 'success' | 'error'
    isScrubbing: false,
    scrubbingPercent: 0,
    scrubbingTimeText: '00:00',
    videoInfo: {
      name: '',
      size: 0,
      sizeText: '',
      duration: 0,
      durationText: '',
      thumbTempFilePath: '',
      tempFilePath: '',
    },
    resultAudio: {
      title: '',
      format: 'm4a',
      formatUpper: 'M4A',
      duration: 0,
      durationText: '00:00',
      size: 0,
      sizeText: '0 B',
      tempFilePath: '',
      fileID: '',
    },
    extractCostMs: 0,
    extractMode: 'local', // 'local' | 'cloud'
    extractTitle: '正在从视频中无损剥离音轨…',
    extractSubTip: '本地硬件解封装中，毫秒级出声',
    isCloudProcessing: false,

    // 播放器状态
    isPlaying: false,
    playCurrentTime: 0,
    playCurrentTimeText: '00:00',
    sliderValue: 0,
    sliderMax: 100,
    isSliderSeeking: false,

    isSavedToLibrary: false,
    errorMessage: '',
  },

  audioCtx: null,

  onLoad(options) {
    this.initAudioContext();
  },

  onUnload() {
    this.stopAudio();
    if (this.audioCtx) {
      try {
        this.audioCtx.destroy();
      } catch (e) {}
      this.audioCtx = null;
    }
  },

  onHide() {
    this.stopAudio();
  },

  /**
   * 初始化高保真试听播放器
   */
  initAudioContext() {
    if (typeof wx === 'undefined' || typeof wx.createInnerAudioContext !== 'function') {
      return;
    }
    const ctx = wx.createInnerAudioContext();
    ctx.obeyMuteSwitch = false; // 穿透静音键，确保扬声器清晰发声

    ctx.onPlay(() => {
      this.setData({ isPlaying: true });
    });

    ctx.onPause(() => {
      this.setData({ isPlaying: false });
    });

    ctx.onStop(() => {
      this.setData({ isPlaying: false, playCurrentTime: 0, playCurrentTimeText: '00:00', sliderValue: 0 });
    });

    ctx.onEnded(() => {
      this.setData({ isPlaying: false, playCurrentTime: 0, playCurrentTimeText: '00:00', sliderValue: 0 });
    });

    ctx.onTimeUpdate(() => {
      if (this.data.isSliderSeeking) return;
      const cur = Math.max(0, ctx.currentTime || 0);
      const dur = Math.max(0.1, ctx.duration || this.data.resultAudio.duration || 1);
      const ratio = Math.min(100, Math.max(0, (cur / dur) * 100));

      this.setData({
        playCurrentTime: cur,
        playCurrentTimeText: videoExtractor.formatSeconds(cur),
        sliderValue: Math.round(ratio),
      });
    });

    ctx.onError((err) => {
      console.warn('[video-extract] 音频播放器报错:', err);
      this.setData({ isPlaying: false });
      if (this.data.extractMode === 'local') {
        wx.showModal({
          title: '音频格式受限',
          content: '当前手机硬件无法解码该本地音轨（常见于视频包含杜比/多声道/特殊编码）。\n\n是否使用云端 FFmpeg 转换为标准 MP3？（仅传输已剥离的轻量音频，超省流量）',
          confirmText: '立即转码',
          cancelText: '取消',
          success: (modalRes) => {
            if (modalRes.confirm) {
              this.reExtractViaCloud();
            }
          },
        });
      } else {
        wx.showToast({ title: '播放失败，音频格式异常', icon: 'none' });
      }
    });

    this.audioCtx = ctx;
  },

  /**
   * 通道 1：从手机系统相册选取视频
   */
  chooseAlbumVideo() {
    if (typeof wx === 'undefined') return;

    if (wx.chooseMedia) {
      wx.chooseMedia({
        count: 1,
        mediaType: ['video'],
        sourceType: ['album'], // 纯相册，直接调起相册选取
        sizeType: ['original'], // 请求原视频
        compressed: false, // 【微信官方 2.25.0+ 关键属性】显式声明不压缩视频
        success: (res) => {
          const item = res && res.tempFiles && res.tempFiles[0];
          if (!item) return;
          this.handleSelectedVideo({
            tempFilePath: item.tempFilePath,
            size: item.size,
            duration: item.duration,
            thumbTempFilePath: item.thumbTempFilePath || '',
            name: `相册视频_${Date.now().toString().slice(-4)}.mp4`,
          });
        },
        fail: (err) => {
          if (err && (err.errMsg || '').indexOf('cancel') >= 0) return;
          console.warn('[video-extract] chooseMedia 失败:', err);
          wx.showModal({
            title: '相册转码受限',
            content: '该视频触发了微信相册底层转码限制（通常因包含杜比/多声道/高码率音轨）。\n\n建议点击下方【从聊天会话选取】，直接在微信聊天记录或「文件传输助手」中选择该视频，100% 避开相册压缩直接秒级提取！',
            confirmText: '从聊天选取',
            cancelText: '取消',
            success: (modalRes) => {
              if (modalRes.confirm) {
                this.chooseMessageVideo();
              }
            },
          });
        },
      });
    } else if (wx.chooseVideo) {
      wx.chooseVideo({
        sourceType: ['album'],
        compressed: false, // 【关键】禁用微信原生压缩，规避原生压缩器解码失败
        success: (res) => {
          this.handleSelectedVideo({
            tempFilePath: res.tempFilePath,
            size: res.size,
            duration: res.duration,
            thumbTempFilePath: res.thumbTempFilePath || '',
            name: `相册视频_${Date.now().toString().slice(-4)}.mp4`,
          });
        },
        fail: (err) => {
          if (err && (err.errMsg || '').indexOf('cancel') >= 0) return;
          console.warn('[video-extract] chooseVideo 失败:', err);
          wx.showModal({
            title: '相册转码受限',
            content: '该视频触发了微信相册转码限制，建议使用「从微信聊天会话选取」。',
            confirmText: '从聊天选取',
            cancelText: '取消',
            success: (modalRes) => {
              if (modalRes.confirm) {
                this.chooseMessageVideo();
              }
            },
          });
        },
      });
    }
  },

  /**
   * 通道 2：从微信聊天会话选择视频（100% 绕过微信相册压缩，直读原文件）
   */
  chooseMessageVideo() {
    if (typeof wx === 'undefined' || typeof wx.chooseMessageFile !== 'function') {
      wx.showToast({ title: '当前版本微信不支持选择聊天文件', icon: 'none' });
      return;
    }

    wx.chooseMessageFile({
      count: 1,
      type: 'all', // 允许从微信聊天记录、文件传输助手选择视频或文件，彻底突破相册压缩
      success: (res) => {
        const item = res && res.tempFiles && res.tempFiles[0];
        if (!item) return;
        this.handleSelectedVideo({
          tempFilePath: item.path,
          size: item.size,
          duration: 0, // chooseMessageFile 可能不带 duration，由后续解码探测
          thumbTempFilePath: '',
          name: item.name || `微信视频_${Date.now().toString().slice(-4)}.mp4`,
        });
      },
      fail: (err) => {
        if (err && (err.errMsg || '').indexOf('cancel') >= 0) return;
        wx.showToast({ title: '选取聊天文件失败', icon: 'none' });
      },
    });
  },

  /**
   * 处理选中的视频并启动双核提取流
   */
  async handleSelectedVideo(rawFile) {
    this.rawVideoFile = rawFile;
    const check = videoExtractor.validateVideoFile(rawFile);
    if (!check.valid) {
      wx.showModal({
        title: '视频无法提取',
        content: check.error || '所选视频文件不符合要求',
        showCancel: false,
      });
      return;
    }

    this.stopAudio();
    const durSec = rawFile.duration ? Math.round(rawFile.duration) : 0;
    this.setData({
      status: 'extracting',
      isCloudProcessing: true,
      extractTitle: '正在上传视频至云端提取…',
      extractSubTip: check.largeNotice || '云端 FFmpeg 7.0 强力引擎，100% 格式兼容，转为通用高音质 MP3',
      videoInfo: {
        name: rawFile.name || '未命名视频.mp4',
        size: rawFile.size,
        sizeText: videoExtractor.formatBytes(rawFile.size),
        duration: durSec,
        durationText: durSec > 0 ? videoExtractor.formatSeconds(durSec) : '时长计算中',
        thumbTempFilePath: rawFile.thumbTempFilePath || '',
        tempFilePath: rawFile.tempFilePath,
      },
      isSavedToLibrary: false,
      errorMessage: '',
    });

    const startTime = Date.now();

    // 🚀 用户指定：不走本地解封装上传，直接发起云端高精转码抽取（100% 格式兼容，规避手机芯片解码限制）
    await this.startCloudExtraction(rawFile, startTime);
  },

  /**
   * 启动云端 FFmpeg 强力转码抽取（作为本地解码失败/不兼容的优雅兜底，转为标准 MP3）
   * 智能支持两种模式：
   * 1. 纯音频优先模式：仅上传本地解封装出来的 2MB~5MB 音轨，极速秒传，省 98% 流量
   * 2. 原始视频兜底模式：本地无法解复用时上传原视频
   */
  async startCloudExtraction(fileToUpload, startTime = Date.now()) {
    if (!fileToUpload) return;
    const durSec = fileToUpload.duration ? Math.round(fileToUpload.duration) : (this.data.videoInfo.duration || 0);
    const isAudioOnly = !!fileToUpload.isAudioOnlyUpload;
    const displayName = fileToUpload.sourceVideoName || (this.rawVideoFile ? this.rawVideoFile.name : fileToUpload.name) || '视频';

    if (fileToUpload.size > videoExtractor.MAX_CLOUD_VIDEO_BYTES) {
      this.setData({
        status: 'error',
        errorMessage: `文件大小为 ${videoExtractor.formatBytes(fileToUpload.size)}（超过云端支持限额 ${videoExtractor.formatBytes(videoExtractor.MAX_CLOUD_VIDEO_BYTES)}）。建议先裁剪后再处理。`,
      });
      return;
    }

    const tipSize = videoExtractor.formatBytes(fileToUpload.size);
    this.setData({
      status: 'extracting',
      isCloudProcessing: true,
      extractTitle: isAudioOnly ? '已在本地剥离纯音频，正在极速上传转码…' : '正在上传视频至云端提取…',
      extractSubTip: isAudioOnly
        ? `仅传输 ${tipSize} 纯音频（节省约 98% 流量）· FFmpeg 转为通用 MP3`
        : '云端 FFmpeg 7.0 强力转码引擎接管，转为标准 MP3',
    });

    try {
      if (!wx.cloud) {
        throw new Error('未开通云开发服务，无法进行云端兜底抽取');
      }

      const cloudExtMatch = String(fileToUpload.name).match(/\.([a-zA-Z0-9]+)$/);
      const cloudExt = cloudExtMatch ? cloudExtMatch[1].toLowerCase() : (isAudioOnly ? 'm4a' : 'mp4');
      const cloudFolder = isAudioOnly ? 'audio_tmp' : 'video_tmp';
      const cloudPath = `${cloudFolder}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${cloudExt}`;

      const uploadRes = await wx.cloud.uploadFile({
        cloudPath,
        filePath: fileToUpload.tempFilePath,
      });

      if (!uploadRes || !uploadRes.fileID) {
        throw new Error('上传临时文件失败');
      }

      const cloudRes = await videoExtractor.extractAudioViaCloud(uploadRes.fileID, displayName, {
        targetFormat: 'mp3',
        bitrate: '192k',
      });

      if (!cloudRes.success || !cloudRes.fileID) {
        throw new Error(cloudRes.errorMessage || '云端转码抽取失败');
      }

      // 下载云端抽取的 MP3 到本地供即时试听
      const dlRes = await wx.cloud.downloadFile({ fileID: cloudRes.fileID });
      const localAudioPath = dlRes && dlRes.tempFilePath ? dlRes.tempFilePath : '';

      const costMs = Date.now() - startTime;
      const originalVideoSize = (this.data.videoInfo && this.data.videoInfo.size) || (this.rawVideoFile && this.rawVideoFile.size) || 0;
      let trafficSavedNotice = '';
      if (isAudioOnly && originalVideoSize > fileToUpload.size) {
        const savedPercent = Math.max(0, Math.round((1 - fileToUpload.size / originalVideoSize) * 100));
        trafficSavedNotice = `仅传 ${tipSize} · 省流量 ${savedPercent}%`;
      }

      this.applyExtractionResult({
        title: `${displayName.replace(/\.[^.]+$/, '')}_原声`,
        format: cloudRes.format || 'mp3',
        duration: cloudRes.duration || durSec || 1,
        size: cloudRes.size || 0,
        tempFilePath: localAudioPath,
        fileID: cloudRes.fileID,
        mode: 'cloud',
        costMs,
        trafficSavedNotice,
      });
    } catch (err) {
      let errMsg = String((err && err.message) || err || '音轨提取失败，请重试');
      if (errMsg.indexOf('FUNCTION_NOT_FOUND') >= 0 || errMsg.indexOf('not found') >= 0 || errMsg.indexOf('云函数调用失败') >= 0) {
        errMsg += '\n\n【部署提示】若您在真机测试遇到此提示，请在微信开发者工具中右键 cloudfunctions/ffmpegProbe 目录，选择「上传并部署：云端安装依赖」，等待部署完成后即可使用云端转码。';
      }
      this.setData({
        status: 'error',
        errorMessage: errMsg,
      });
    }
  },

  /**
   * 手动请求重新使用云端 FFmpeg 转码为标准 MP3
   * 优先复用本地已剥离的纯音频（2MB~5MB），瞬间完成上传，节省 98% 流量
   */
  reExtractViaCloud() {
    this.stopAudio();
    if (this.data.resultAudio && this.data.resultAudio.tempFilePath && this.data.extractMode === 'local') {
      const audioPath = this.data.resultAudio.tempFilePath;
      const audioSize = this.data.resultAudio.size || 0;
      return this.startCloudExtraction({
        tempFilePath: audioPath,
        size: audioSize,
        duration: this.data.resultAudio.duration,
        name: `${(this.rawVideoFile ? this.rawVideoFile.name : '视频').replace(/\.[^.]+$/, '')}_原声.m4a`,
        isAudioOnlyUpload: true,
        sourceVideoName: this.rawVideoFile ? this.rawVideoFile.name : '',
      });
    }

    if (this.rawVideoFile) {
      return this.startCloudExtraction(this.rawVideoFile);
    }
    wx.showToast({ title: '原文件已释放，请重新选取', icon: 'none' });
  },

  /**
   * 应用抽取完成后的数据并装配播放器
   */
  applyExtractionResult({ title, format, duration, size, tempFilePath, fileID, mode, costMs, trafficSavedNotice }) {
    const dur = Math.max(1, Math.round(Number(duration) || 0));
    const sz = Number(size) || 0;
    const fmt = String(format || 'm4a').toLowerCase();

    // 格式化耗时展示：大于等于 1000ms 显示为 X.X 秒，小于 1000ms 显示为 Xms
    const costText = costMs >= 1000 ? `${(costMs / 1000).toFixed(1)} 秒` : `${costMs}ms`;

    let speedDesc = `耗时 ${costText} · ${mode === 'local' ? '本地极速剥离 (0流量)' : '云端转码'}`;
    if (trafficSavedNotice) {
      speedDesc = `耗时 ${costText} · 云端极速转码 (${trafficSavedNotice})`;
    }

    // 计算体积瘦身百分比
    const origSize = (this.data.videoInfo && this.data.videoInfo.size) || (this.rawVideoFile && this.rawVideoFile.size) || 0;
    let savedRatio = 0;
    if (origSize > sz && origSize > 0) {
      savedRatio = Math.max(0, Math.min(99, Math.round((1 - sz / origSize) * 100)));
    }

    // 自动入库持久化（与格式转换、剪辑工坊保持一致），避免用户退出页面丢失
    try {
      const libItem = videoExtractor.buildLibraryItem({
        title,
        tempFilePath,
        fileID,
        duration: dur,
        size: sz,
        format: fmt,
        sourceVideoName: (this.data.videoInfo && this.data.videoInfo.name) || (this.rawVideoFile && this.rawVideoFile.name) || '',
      });
      libraryStore.addItem(libItem);
    } catch (e) {
      console.warn('[video-extract] 自动保存到作品库异常:', e);
    }

    this.setData({
      status: 'success',
      extractCostMs: costMs,
      extractCostText: costText,
      extractMode: mode,
      speedDescText: speedDesc,
      savedRatio,
      isSavedToLibrary: true,
      resultAudio: {
        title,
        format: fmt,
        formatUpper: fmt.toUpperCase(),
        duration: dur,
        durationText: videoExtractor.formatSeconds(dur),
        size: sz,
        sizeText: videoExtractor.formatBytes(sz),
        tempFilePath,
        fileID,
      },
      isPlaying: false,
      playCurrentTime: 0,
      playCurrentTimeText: '00:00',
      sliderValue: 0,
    });

    if (this.audioCtx && tempFilePath) {
      try {
        this.audioCtx.src = tempFilePath;
      } catch (e) {}
    }

    wx.showToast({
      title: mode === 'local' ? '极速提取成功' : '云端转码成功',
      icon: 'success',
    });
    haptics.notificationSuccess();
  },

  /**
   * 播放 / 暂停切换
   */
  togglePlayAudio() {
    if (!this.audioCtx || !this.data.resultAudio.tempFilePath) {
      wx.showToast({ title: '音频未就绪', icon: 'none' });
      return;
    }

    haptics.impactLight();
    if (this.data.isPlaying) {
      this.audioCtx.pause();
    } else {
      this.audioCtx.play();
    }
  },

  /**
   * 停止播放
   */
  stopAudio() {
    if (this.audioCtx) {
      try {
        this.audioCtx.stop();
      } catch (e) {}
    }
    this.setData({ isPlaying: false });
  },

  onSliderChanging(e) {
    const percent = e && e.detail ? Number(e.detail.value) : 0;
    const dur = this.data.resultAudio.duration || 1;
    const seekSec = (percent / 100) * dur;
    const clampedPct = Math.max(6, Math.min(94, percent));
    haptics.impactLight();
    this.setData({
      isSliderSeeking: true,
      isScrubbing: true,
      scrubbingPercent: clampedPct,
      scrubbingTimeText: videoExtractor.formatSeconds(seekSec),
      playCurrentTime: seekSec,
      playCurrentTimeText: videoExtractor.formatSeconds(seekSec),
    });
  },

  onSliderChange(e) {
    const percent = e && e.detail ? Number(e.detail.value) : 0;
    const dur = this.data.resultAudio.duration || 1;
    const seekSec = (percent / 100) * dur;

    if (this.audioCtx) {
      try {
        this.audioCtx.seek(seekSec);
      } catch (err) {}
    }

    haptics.impactMedium();
    this.setData({
      isSliderSeeking: false,
      isScrubbing: false,
      playCurrentTime: seekSec,
      playCurrentTimeText: videoExtractor.formatSeconds(seekSec),
      sliderValue: percent,
    });
  },

  /**
   * 去向 1：一键送入多轨剪辑工坊
   */
  sendToEditor() {
    this.stopAudio();
    const res = this.data.resultAudio;
    if (!res.tempFilePath && !res.fileID) {
      wx.showToast({ title: '音频文件不可用', icon: 'none' });
      return;
    }

    let appInstance = null;
    try { appInstance = getApp(); } catch (e) {}
    if (appInstance) {
      if (!appInstance.globalData) appInstance.globalData = {};
      appInstance.globalData.pendingAudio = {
        path: res.tempFilePath,
        fileID: res.fileID,
        name: `${res.title}.${res.format}`,
        size: res.size,
        durationSec: res.duration,
        extName: res.formatUpper,
        extLower: res.format,
        from: 'video-extract',
      };
    }

    wx.navigateTo({
      url: '/pages/editor/editor',
      fail: () => {
        wx.showToast({ title: '打开剪辑工坊失败', icon: 'none' });
      },
    });
  },

  /**
   * 去向 2：一键送入格式转换 / 压缩工坊
   */
  sendToConverter() {
    this.stopAudio();
    const res = this.data.resultAudio;
    if (!res.tempFilePath && !res.fileID) {
      wx.showToast({ title: '音频文件不可用', icon: 'none' });
      return;
    }

    let appInstance = null;
    try { appInstance = getApp(); } catch (e) {}
    if (appInstance) {
      if (!appInstance.globalData) appInstance.globalData = {};
      appInstance.globalData.pendingAudio = {
        path: res.tempFilePath,
        fileID: res.fileID,
        name: `${res.title}.${res.format}`,
        size: res.size,
        durationSec: res.duration,
        extName: res.formatUpper,
        extLower: res.format,
        from: 'video-extract',
      };
    }

    wx.reLaunch({
      url: '/pages/index/index',
      fail: () => {
        wx.navigateTo({ url: '/pages/index/index' });
      },
    });
  },

  /**
   * 去向 3：存入「我的作品」库
   */
  saveToMyLibrary() {
    const res = this.data.resultAudio;
    if (!res.tempFilePath && !res.fileID) {
      wx.showToast({ title: '音频文件不可用', icon: 'none' });
      return;
    }

    if (this.data.isSavedToLibrary) {
      wx.showToast({ title: '已保存在作品库中', icon: 'none' });
      return;
    }

    const item = videoExtractor.buildLibraryItem({
      title: res.title,
      tempFilePath: res.tempFilePath,
      fileID: res.fileID,
      duration: res.duration,
      size: res.size,
      format: res.format,
      sourceVideoName: this.data.videoInfo.name,
    });

    libraryStore.addItem(item);
    this.setData({ isSavedToLibrary: true });
    wx.showToast({ title: '已存入我的作品', icon: 'success' });
  },

  /**
   * 去向 4：分享好友或保存到本地手机
   */
  shareOrSaveAudio() {
    const path = this.data.resultAudio.tempFilePath;
    if (!path) {
      wx.showToast({ title: '无本地临时文件', icon: 'none' });
      return;
    }

    if (wx.shareFileMessage) {
      wx.shareFileMessage({
        filePath: path,
        fileName: `${this.data.resultAudio.title}.${this.data.resultAudio.format}`,
        success: () => {
          wx.showToast({ title: '分享成功', icon: 'success' });
        },
        fail: (err) => {
          if (err && (err.errMsg || '').indexOf('cancel') >= 0) return;
          this.fallbackSaveAudio(path);
        },
      });
    } else {
      this.fallbackSaveAudio(path);
    }
  },

  /**
   * 保存到本地手机或电脑磁盘
   */
  saveToLocalDisk() {
    const path = this.data.resultAudio.tempFilePath;
    const fileName = `${this.data.resultAudio.title}.${this.data.resultAudio.format}`;
    if (!path) {
      wx.showToast({ title: '音频准备中，请稍候', icon: 'none' });
      return;
    }

    const sys = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
    const platform = String(sys.platform || '').toLowerCase();
    const isPC = platform === 'windows' || platform === 'mac' || platform === 'pc';

    if (platform === 'devtools') {
      wx.showModal({
        title: '开发者工具不支持保存',
        content: '微信开发者工具无法直接写入本地文件。请在手机微信中通过“发给微信好友”发送至文件传输助手保存。',
        showCancel: false,
      });
      return;
    }

    if (isPC) {
      if (wx.saveFileToDisk) {
        wx.saveFileToDisk({
          filePath: path,
          fileName,
          success: () => wx.showToast({ title: '已保存到电脑磁盘', icon: 'success' }),
          fail: err => {
            const msg = (err && err.errMsg) || '';
            if (msg.includes('cancel')) return;
            this.shareOrSaveAudio();
          },
        });
      } else {
        this.shareOrSaveAudio();
      }
      return;
    }

    // 手机端：通过 shareFileMessage 转发至「文件传输助手」保存
    if (wx.shareFileMessage) {
      wx.shareFileMessage({
        filePath: path,
        fileName,
        success: () => wx.showToast({ title: '已转发，请在聊天中保存', icon: 'none' }),
        fail: err => {
          if (err && (err.errMsg || '').includes('cancel')) return;
          wx.showModal({
            title: '保存指引',
            content: '请点击“发给微信好友”发送至「文件传输助手」，长按音频即可直接保存到手机本地。',
            showCancel: false,
          });
        },
      });
    } else {
      this.fallbackSaveAudio(path);
    }
  },

  fallbackSaveAudio(path) {
    if (wx.saveFileToDisk) {
      wx.saveFileToDisk({
        filePath: path,
        success: () => wx.showToast({ title: '已保存至磁盘', icon: 'success' }),
        fail: () => wx.showToast({ title: '保存失败或已取消', icon: 'none' }),
      });
    } else {
      wx.showModal({
        title: '已就绪',
        content: '音频已成功提取，您可直接「送入多轨剪辑」或「转格式压缩」。',
        showCancel: false,
      });
    }
  },

  goLibrary() {
    this.stopAudio();
    wx.navigateTo({
      url: '/pages/library/library',
      fail: () => wx.showToast({ title: '无法打开作品库', icon: 'none' }),
    });
  },

  resetToPicker() {
    this.stopAudio();
    this.rawVideoFile = null;
    this.setData({
      status: 'idle',
      isPlaying: false,
      playCurrentTime: 0,
      playCurrentTimeText: '00:00',
      sliderValue: 0,
      isSavedToLibrary: false,
      errorMessage: '',
    });
  },
});
