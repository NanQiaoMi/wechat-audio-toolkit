// miniprogram/pages/record/record.js
/**
 * 现场录音页（v5.1 · FR-30）
 * 计划：docs/NEXT_UPDATE_PLAN.md §5.1 / §5.7
 *
 * 状态机：idle（待录） → recording（录音中） ⇄ paused（暂停） → review（试听 / 去向）
 * 去向：写入 app.globalData.pendingAudio（一次性跨页数据，严禁 URL 传路径）
 *   - 去转换：navigateBack 回首页（栈深 <= 1 时 reLaunch 首页）
 *   - 去剪辑：redirectTo 编辑器 ?from=record
 */

// ---- 录音参数契约（计划 §5.1.3，勿随意调整）----
const RECORD_OPTIONS = {
  duration: 600000, // 10 分钟上限（毫秒）
  sampleRate: 44100,
  numberOfChannels: 2,
  encodeBitRate: 192000,
  format: 'mp3',
};

const MAX_DURATION_MS = 600000;
const MIN_DURATION_MS = 1000; // 不足 1 秒拒绝（计划 §5.1.6）
const TIMER_INTERVAL_MS = 100;
const HIT_LIMIT_TOLERANCE_MS = 1500; // 自动停止判定容差

// 假声波动效条（同计划 §5.1.3：CSS 假动效，不做真实波形）
const WAVE_BARS = [];
for (let i = 0; i < 14; i++) {
  WAVE_BARS.push({
    id: i,
    h: 28 + ((i * 37) % 56), // 28 ~ 83 rpx
    d: (i % 7) * 90, // 错峰动画延迟 ms
  });
}

// ---- 纯函数工具（不依赖 wx，便于 Node 侧自检）----
function pad2(num) {
  const n = Math.floor(Math.abs(Number(num) || 0));
  return n < 10 ? '0' + n : '' + n;
}

// 毫秒 → mm:ss（向下取整，最长 10 分钟不会溢出到小时）
function formatClock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
}

// 秒 → mm:ss
function formatSeconds(sec) {
  return formatClock((Number(sec) || 0) * 1000);
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  if (n < 1024) return n + ' B';
  const kb = n / 1024;
  if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + ' KB';
  const mb = kb / 1024;
  return mb.toFixed(mb < 10 ? 1 : 0) + ' MB';
}

// 录音文件展示名：录音_YYYYMMDD_HHmmss.mp3（计划 §5.1.3）
function buildRecordName(date) {
  const d = date || new Date();
  return (
    '录音_' +
    d.getFullYear() +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    '_' +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds()) +
    '.mp3'
  );
}

// 秒（保留 1 位小数），pendingAudio.durationSec 使用
function durationToSec(ms) {
  return Math.round(((Number(ms) || 0) / 1000) * 10) / 10;
}

function isPrivacyError(msg) {
  const text = String(msg || '').toLowerCase();
  return text.indexOf('privacy') >= 0;
}

function isAuthError(msg) {
  const text = String(msg || '').toLowerCase();
  return (
    text.indexOf('auth') >= 0 ||
    text.indexOf('permission') >= 0 ||
    text.indexOf('scope.record') >= 0
  );
}

Page({
  data: {
    // 状态机：idle | recording | paused | review
    status: 'idle',
    elapsedMs: 0,
    elapsedText: '00:00',
    waveBars: WAVE_BARS,
    interrupted: false,

    // 异常态（权限 / 隐私 / 录音失败）
    errorKind: '', // '' | 'auth' | 'privacy' | 'failed'
    errorTitle: '',
    errorText: '',

    // REVIEW：录音结果
    tempFilePath: '',
    fileName: '',
    fileSize: 0,
    sizeText: '0 B',
    durationSec: 0,
    durationText: '00:00',

    // REVIEW：试听
    isPlaying: false,
    previewValue: 0,
    previewDuration: 0,
    previewCurrentText: '00:00',
    previewDurationText: '00:00',

    // 来源：index | editor（决定「完成」后的默认去向提示）
    fromSource: 'index',
  },

  // ============================================================
  // 生命周期
  // ============================================================

  onLoad(options) {
    const from = options && options.from === 'editor' ? 'editor' : 'index';
    this.setData({ fromSource: from });

    this.recorder = null;
    this.recorderHandlers = null;
    this.audioCtx = null;
    this.timer = null;

    this.accMs = 0; // 已累计录音时长（暂停冻结）
    this.segStart = 0; // 当前录音片段起点时间戳
    this.starting = false; // 已调用 start、等 onStart
    this.stopping = false; // 已调用 stop、等 onStop
    this.destroyed = false; // 页面已卸载
    this.pageHidden = false; // 页面是否在后台
    this.autoPaused = false; // 是否由 onHide 自动暂停
    this.wxInterruptionBegin = null;
    this.wxInterruptionEnd = null;

    this.initRecorder();
    this.initPreviewPlayer();
    this.setupShareMenu();
  },

  onShow() {
    this.pageHidden = false;
    if (this.autoPaused) {
      this.autoPaused = false;
      if (this.data.status === 'paused') {
        wx.showToast({ title: '已自动暂停录音，点击「继续」恢复', icon: 'none', duration: 2500 });
      }
    }
    // 从系统设置返回后重新检测麦克风权限
    if (this.data.errorKind === 'auth') {
      this.recheckRecordAuth();
    }
  },

  onHide() {
    this.pageHidden = true;
    this.stopPreview();
    if (this.data.status === 'recording') {
      this.pauseRecording();
      if (this.data.status === 'paused') {
        this.autoPaused = true;
      }
    }
  },

  onUnload() {
    this.destroyed = true;
    this.clearTimer();
    this.stopRecordingSilently();
    this.unbindRecorder();
    this.destroyPreview();
  },

  // ============================================================
  // 录音器初始化与解绑
  // ============================================================

  initRecorder() {
    if (!wx.getRecorderManager) {
      this.showError('failed', '录音不可用', '当前微信版本不支持录音功能，请升级微信后重试。');
      return;
    }
    const recorder = wx.getRecorderManager();
    this.recorder = recorder;

    // RecorderManager 为单例：保存引用，onUnload 时解绑，避免多页面实例回调累积
    this.recorderHandlers = {
      start: () => this.handleRecorderStart(),
      stop: (res) => this.handleRecorderStop(res),
      error: (err) => this.handleRecorderError(err),
      interruptionBegin: () => this.handleAudioInterruptionBegin(),
      interruptionEnd: () => this.handleAudioInterruptionEnd(),
    };

    const h = this.recorderHandlers;
    recorder.onStart(h.start);
    recorder.onStop(h.stop);
    recorder.onError(h.error);
    if (recorder.onInterruptionBegin) recorder.onInterruptionBegin(h.interruptionBegin);
    if (recorder.onInterruptionEnd) recorder.onInterruptionEnd(h.interruptionEnd);

    // 系统级音频打断（来电 / 微信语音）：录音暂停，不自动继续
    this.wxInterruptionBegin = () => this.handleAudioInterruptionBegin();
    this.wxInterruptionEnd = () => this.handleAudioInterruptionEnd();
    if (wx.onAudioInterruptionBegin) wx.onAudioInterruptionBegin(this.wxInterruptionBegin);
    if (wx.onAudioInterruptionEnd) wx.onAudioInterruptionEnd(this.wxInterruptionEnd);
  },

  unbindRecorder() {
    const recorder = this.recorder;
    const h = this.recorderHandlers;
    if (recorder && h) {
      try {
        if (recorder.offStart) recorder.offStart(h.start);
        if (recorder.offStop) recorder.offStop(h.stop);
        if (recorder.offError) recorder.offError(h.error);
        if (recorder.offInterruptionBegin) recorder.offInterruptionBegin(h.interruptionBegin);
        if (recorder.offInterruptionEnd) recorder.offInterruptionEnd(h.interruptionEnd);
      } catch (e) {}
    }
    try {
      if (wx.offAudioInterruptionBegin && this.wxInterruptionBegin) {
        wx.offAudioInterruptionBegin(this.wxInterruptionBegin);
      }
      if (wx.offAudioInterruptionEnd && this.wxInterruptionEnd) {
        wx.offAudioInterruptionEnd(this.wxInterruptionEnd);
      }
    } catch (e) {}
    this.recorderHandlers = null;
  },

  // ============================================================
  // 试听播放器
  // ============================================================

  initPreviewPlayer() {
    if (!wx.createInnerAudioContext) return;
    // 与首页一致：突破 iOS 静音拨片，保证试听外放
    if (wx.setInnerAudioOption) {
      try {
        wx.setInnerAudioOption({ obeyMuteSwitch: false, mixWithOther: false });
      } catch (e) {}
    }

    const ctx = wx.createInnerAudioContext();
    try {
      ctx.obeyMuteSwitch = false;
    } catch (e) {}
    this.audioCtx = ctx;

    ctx.onPlay(() => this.setData({ isPlaying: true }));
    ctx.onPause(() => this.setData({ isPlaying: false }));
    ctx.onStop(() =>
      this.setData({ isPlaying: false, previewValue: 0, previewCurrentText: '00:00' })
    );
    ctx.onEnded(() =>
      this.setData({ isPlaying: false, previewValue: 0, previewCurrentText: '00:00' })
    );
    ctx.onTimeUpdate(() => {
      const audio = this.audioCtx;
      if (!audio || this.data.status !== 'review') return;
      const cur = Number(audio.currentTime) || 0;
      const dur = Number(audio.duration) || this.data.previewDuration || 0;
      const patch = {
        previewValue: cur,
        previewCurrentText: formatSeconds(cur),
      };
      if (dur > 0) {
        patch.previewDuration = dur;
        patch.previewDurationText = formatSeconds(dur);
      }
      this.setData(patch);
    });
    ctx.onCanplay(() => {
      const audio = this.audioCtx;
      if (!audio || this.data.status !== 'review') return;
      const dur = Number(audio.duration);
      if (dur > 0) {
        this.setData({ previewDuration: dur, previewDurationText: formatSeconds(dur) });
      }
    });
    ctx.onError(() => {
      this.setData({ isPlaying: false });
      wx.showToast({ title: '试听失败，请重试', icon: 'none' });
    });
  },

  stopPreview() {
    const ctx = this.audioCtx;
    if (ctx) {
      try {
        ctx.stop();
      } catch (e) {}
    }
    this.setData({ isPlaying: false, previewValue: 0, previewCurrentText: '00:00' });
  },

  destroyPreview() {
    const ctx = this.audioCtx;
    this.audioCtx = null;
    if (!ctx) return;
    try {
      ctx.stop();
      if (ctx.destroy) ctx.destroy();
    } catch (e) {}
  },

  // ============================================================
  // 分享（只开 shareAppMessage，不开朋友圈）
  // ============================================================

  setupShareMenu() {
    if (!wx.showShareMenu) return;
    try {
      wx.showShareMenu({
        menus: ['shareAppMessage'],
        fail: () => {},
      });
    } catch (e) {}
  },

  onShareAppMessage() {
    return {
      title: '现场录音，录完立刻转格式',
      path: '/pages/record/record',
    };
  },

  // ============================================================
  // 权限与隐私
  // ============================================================

  ensureRecordAuth(onGranted) {
    if (!wx.getSetting) {
      onGranted(true);
      return;
    }
    wx.getSetting({
      success: (res) => {
        const setting = (res && res.authSetting) || {};
        const recordAuth = setting['scope.record'];
        if (recordAuth === true) {
          onGranted(true);
          return;
        }
        if (recordAuth === false) {
          this.promptAuthGuide();
          onGranted(false);
          return;
        }
        this.requestAuthorize(onGranted);
      },
      fail: () => this.requestAuthorize(onGranted),
    });
  },

  requestAuthorize(onGranted) {
    if (!wx.authorize) {
      onGranted(true);
      return;
    }
    wx.authorize({
      scope: 'scope.record',
      success: () => {
        this.clearError();
        onGranted(true);
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        if (isPrivacyError(msg)) this.showPrivacyGuide();
        else this.promptAuthGuide();
        onGranted(false);
      },
    });
  },

  // 权限被拒绝：弹窗说明 + 「去设置」引导
  promptAuthGuide() {
    this.showError(
      'auth',
      '麦克风权限未开启',
      '录音需要「麦克风」权限。可点击「去设置」开启，或再次点击录音重新授权。'
    );
    wx.showModal({
      title: '需要麦克风权限',
      content: '录音需要访问你的麦克风，请在设置中允许「麦克风」后重试。',
      confirmText: '去设置',
      cancelText: '取消',
      success: (res) => {
        if (res && res.confirm) this.openSettingForRecord();
      },
    });
  },

  openSettingForRecord() {
    if (!wx.openSetting) {
      wx.showToast({ title: '当前微信版本不支持打开设置', icon: 'none' });
      return;
    }
    wx.openSetting({
      success: (res) => {
        const granted = !!(res && res.authSetting && res.authSetting['scope.record']);
        if (granted) {
          this.clearError();
          wx.showToast({ title: '麦克风权限已开启', icon: 'success' });
        } else {
          this.showError(
            'auth',
            '麦克风权限仍未开启',
            '未获得麦克风权限，暂时无法录音。可点击「去设置」再次开启。'
          );
        }
      },
      fail: () => {
        wx.showToast({ title: '打开设置失败，请手动前往设置页', icon: 'none' });
      },
    });
  },

  recheckRecordAuth() {
    if (!wx.getSetting) return;
    wx.getSetting({
      success: (res) => {
        const setting = (res && res.authSetting) || {};
        if (setting['scope.record'] === true && this.data.errorKind === 'auth') {
          this.clearError();
        }
      },
      fail: () => {},
    });
  },

  // 隐私指引未声明「访问你的麦克风」
  showPrivacyGuide() {
    const text =
      '录音需要「访问你的麦克风」隐私授权。请在小程序后台「设置 → 服务内容声明 → 用户隐私保护指引」中声明「访问你的麦克风」后重新打开小程序再试。';
    this.showError('privacy', '隐私指引未声明麦克风', text);
    wx.showModal({
      title: '隐私授权未配置',
      content: text,
      showCancel: false,
      confirmText: '我知道了',
    });
  },

  showError(kind, title, text) {
    this.setData({ errorKind: kind, errorTitle: title, errorText: text });
  },

  clearError() {
    this.setData({ errorKind: '', errorTitle: '', errorText: '' });
  },

  // ============================================================
  // 录音控制
  // ============================================================

  onStartRecord() {
    if (this.data.status !== 'idle' || this.starting) return;
    this.clearError();
    this.ensureRecordAuth((granted) => {
      if (granted) this.doStartRecording();
    });
  },

  doStartRecording() {
    if (!this.recorder) {
      this.showError('failed', '录音不可用', '当前微信版本不支持录音功能，请升级微信后重试。');
      return;
    }
    if (this.data.status !== 'idle' || this.starting) return;
    this.starting = true;
    this.stopping = false;
    this.setData({ interrupted: false });
    try {
      this.recorder.start(RECORD_OPTIONS);
    } catch (e) {
      this.starting = false;
      const msg = (e && (e.errMsg || e.message)) || '';
      if (isPrivacyError(msg)) this.showPrivacyGuide();
      else if (isAuthError(msg)) this.promptAuthGuide();
      else this.showError('failed', '录音失败', '录音失败，请检查麦克风是否被占用后重试。');
    }
  },

  handleRecorderStart() {
    if (this.destroyed) return;
    this.starting = false;
    this.accMs = 0;
    this.segStart = Date.now();
    this.clearError();
    this.setData({
      status: 'recording',
      elapsedMs: 0,
      elapsedText: '00:00',
      interrupted: false,
    });
    this.startTimer();
    // start 期间页面被切走：立即暂停，避免后台持续录音
    if (this.pageHidden) {
      this.autoPaused = true;
      this.pauseRecording();
    }
  },

  onPauseRecord() {
    this.pauseRecording();
  },

  pauseRecording() {
    if (this.data.status !== 'recording') return;
    this.freezeTimer();
    this.setData({ status: 'paused' });
    if (this.recorder) {
      try {
        this.recorder.pause();
      } catch (e) {}
    }
  },

  onResumeRecord() {
    this.resumeRecording();
  },

  resumeRecording() {
    if (this.data.status !== 'paused') return;
    if (!this.recorder) {
      this.showError('failed', '录音不可用', '当前微信版本不支持录音功能，请升级微信后重试。');
      return;
    }
    try {
      this.recorder.resume();
    } catch (e) {
      this.showError('failed', '继续录音失败', '继续录音失败，请检查麦克风是否被占用后重试。');
      return;
    }
    this.setData({ status: 'recording', interrupted: false });
    this.startTimer();
  },

  onFinishRecord() {
    const status = this.data.status;
    if (status !== 'recording' && status !== 'paused') return;
    if (this.starting || this.stopping) return;
    this.stopping = true;
    this.freezeTimer();
    this.clearTimer();
    if (!this.recorder) {
      this.stopping = false;
      this.handleRecorderStop(null);
      return;
    }
    try {
      this.recorder.stop();
    } catch (e) {
      this.stopping = false;
      this.handleRecorderError({ errMsg: 'recorder.stop fail' });
    }
  },

  handleRecorderStop(res) {
    this.starting = false;
    this.stopping = false;
    this.clearTimer();
    if (this.destroyed) return;

    const info = res || {};
    const path = info.tempFilePath || '';
    const durationMs = Number(info.duration) || this.accMs || 0;
    const fileSize = Number(info.fileSize) || 0;

    // 拿不到文件：兜底失败
    if (!path) {
      this.resetToIdle();
      this.showError('failed', '录音失败', '未获取到录音文件，请检查麦克风是否被占用后重试。');
      return;
    }

    // 不足 1 秒：不进入 REVIEW，提示重录（计划 §5.1.6）
    if (durationMs < MIN_DURATION_MS) {
      this.resetToIdle();
      wx.showToast({ title: '录音太短（不足 1 秒），请重新录制', icon: 'none', duration: 2500 });
      return;
    }

    const hitLimit = durationMs >= MAX_DURATION_MS - HIT_LIMIT_TOLERANCE_MS;
    const durationSec = durationToSec(durationMs);
    const fileName = buildRecordName(new Date());

    this.setData({
      status: 'review',
      interrupted: false,
      elapsedMs: durationMs,
      elapsedText: formatClock(durationMs),
      tempFilePath: path,
      fileName: fileName,
      fileSize: fileSize,
      sizeText: formatBytes(fileSize),
      durationSec: durationSec,
      durationText: formatClock(durationMs),
      isPlaying: false,
      previewValue: 0,
      previewDuration: durationSec,
      previewCurrentText: '00:00',
      previewDurationText: formatClock(durationMs),
    });

    if (this.audioCtx) {
      try {
        this.audioCtx.src = path;
      } catch (e) {}
    }

    // 10 分钟自动停止（onStop 被动触发）
    if (hitLimit) {
      wx.showToast({ title: '已达 10 分钟上限，已自动保存', icon: 'none', duration: 3000 });
    }
  },

  handleRecorderError(err) {
    this.starting = false;
    this.stopping = false;
    this.clearTimer();
    if (this.destroyed) return;

    const msg = (err && (err.errMsg || err.message)) || '';
    const wasActive = this.data.status === 'recording' || this.data.status === 'paused';
    this.resetToIdle();

    if (isPrivacyError(msg)) {
      this.showPrivacyGuide();
      return;
    }
    if (isAuthError(msg)) {
      this.showError(
        'auth',
        '麦克风权限未开启',
        '录音需要「麦克风」权限。可点击「去设置」开启后重试。'
      );
      return;
    }
    this.showError('failed', '录音失败', '录音失败，请检查麦克风是否被占用后重试。');
    if (wasActive) {
      wx.showToast({ title: '录音已中断', icon: 'none' });
    }
  },

  // ============================================================
  // 计时器（100ms 刷新，暂停冻结）
  // ============================================================

  startTimer() {
    this.clearTimer();
    this.segStart = Date.now();
    this.timer = setInterval(() => this.tickTimer(), TIMER_INTERVAL_MS);
  },

  tickTimer() {
    if (this.data.status !== 'recording') return;
    const now = Date.now();
    const total = this.accMs + (now - (this.segStart || now));
    this.setData({ elapsedMs: total, elapsedText: formatClock(total) });
  },

  freezeTimer() {
    if (this.data.status === 'recording' && this.segStart) {
      this.accMs += Date.now() - this.segStart;
    }
    this.segStart = 0;
    this.clearTimer();
    this.setData({ elapsedMs: this.accMs, elapsedText: formatClock(this.accMs) });
  },

  clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  // ============================================================
  // 音频打断（来电 / 微信语音）：暂停，不自动继续
  // ============================================================

  handleAudioInterruptionBegin() {
    if (this.destroyed) return;
    if (this.data.status === 'recording') {
      this.pauseRecording();
      this.setData({ interrupted: true });
    }
    if (this.data.status === 'review' && this.data.isPlaying && this.audioCtx) {
      try {
        this.audioCtx.pause();
      } catch (e) {}
      this.setData({ isPlaying: false });
    }
  },

  handleAudioInterruptionEnd() {
    if (this.destroyed) return;
    if (this.data.interrupted && this.data.status === 'paused') {
      wx.showToast({ title: '录音已中断，点击「继续」恢复', icon: 'none', duration: 2500 });
    }
  },

  // ============================================================
  // 试听控制（REVIEW）
  // ============================================================

  onTogglePreview() {
    if (this.data.status !== 'review' || !this.audioCtx) return;
    const ctx = this.audioCtx;
    if (this.data.isPlaying) {
      try {
        ctx.pause();
      } catch (e) {}
      this.setData({ isPlaying: false });
      return;
    }
    if (!ctx.src && this.data.tempFilePath) {
      try {
        ctx.src = this.data.tempFilePath;
      } catch (e) {}
    }
    try {
      ctx.play();
    } catch (e) {}
  },

  onPreviewSeek(e) {
    if (this.data.status !== 'review' || !this.audioCtx) return;
    const detail = (e && e.detail) || {};
    const value = Number(detail.value);
    if (isNaN(value)) return;
    try {
      this.audioCtx.seek(value);
    } catch (err) {}
    this.setData({
      previewValue: value,
      previewCurrentText: formatSeconds(value),
    });
  },

  // ============================================================
  // 重录 / 复位
  // ============================================================

  onRestartRecord() {
    if (this.data.status !== 'review') return;
    this.resetToIdle();
    this.clearError();
  },

  onRetryRecord() {
    if (this.data.status === 'review') return;
    this.clearError();
    this.onStartRecord();
  },

  resetToIdle() {
    this.clearTimer();
    this.accMs = 0;
    this.segStart = 0;
    this.stopPreview();
    this.setData({
      status: 'idle',
      elapsedMs: 0,
      elapsedText: '00:00',
      interrupted: false,
      isPlaying: false,
      tempFilePath: '',
      fileName: '',
      fileSize: 0,
      sizeText: '0 B',
      durationSec: 0,
      durationText: '00:00',
      previewValue: 0,
      previewDuration: 0,
      previewCurrentText: '00:00',
      previewDurationText: '00:00',
    });
    if (this.audioCtx) {
      try {
        this.audioCtx.src = '';
      } catch (e) {}
    }
  },

  // ============================================================
  // 去向（pendingAudio → 去转换 / 去剪辑）
  // ============================================================

  getAppInstance() {
    try {
      return typeof getApp === 'function' ? getApp() : null;
    } catch (e) {
      return null;
    }
  },

  // 临时文件可能被系统清理：去向之前必须校验（计划 §5.1.6）
  isTempFileAlive(path) {
    if (!path) return false;
    if (!wx.getFileSystemManager) return true; // 低版本无法校验时放行，避免误伤
    try {
      const fs = wx.getFileSystemManager();
      if (!fs || !fs.accessSync) return true;
      fs.accessSync(path);
      return true;
    } catch (e) {
      return false;
    }
  },

  preparePendingAudio() {
    const path = this.data.tempFilePath;
    if (!this.isTempFileAlive(path)) {
      this.resetToIdle();
      this.showError('failed', '录音文件已失效', '录音文件可能已被系统清理，请重新录制。');
      wx.showModal({
        title: '录音文件已失效',
        content: '录音文件可能已被系统清理，请重新录制。',
        showCancel: false,
      });
      return null;
    }

    const app = this.getAppInstance();
    if (!app) {
      wx.showToast({ title: '小程序初始化异常，请重试', icon: 'none' });
      return null;
    }

    const item = {
      path: path,
      name: this.data.fileName,
      size: this.data.fileSize,
      extName: 'MP3',
      extLower: 'mp3',
      durationSec: this.data.durationSec,
      source: 'record',
    };
    app.globalData = app.globalData || {};
    app.globalData.pendingAudio = item;
    return item;
  },

  clearPendingAudio() {
    const app = this.getAppInstance();
    if (!app || !app.globalData) return;
    try {
      delete app.globalData.pendingAudio;
    } catch (e) {
      app.globalData.pendingAudio = null;
    }
  },

  onGoConvert() {
    if (this.data.status !== 'review') return;
    if (!this.preparePendingAudio()) return;
    this.stopPreview();

    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    // 仅从首页进入时 navigateBack（保留首页状态）；其它入口（设置/作品库/剪辑）统一 reLaunch 首页消费 pendingAudio
    if (this.data.fromSource !== 'index' || !pages || pages.length <= 1) {
      wx.reLaunch({
        url: '/pages/index/index',
        fail: () => {
          this.clearPendingAudio();
          wx.showToast({ title: '返回首页失败，请重试', icon: 'none' });
        },
      });
      return;
    }
    wx.navigateBack({
      fail: () => {
        wx.reLaunch({
          url: '/pages/index/index',
          fail: () => {
            this.clearPendingAudio();
            wx.showToast({ title: '返回首页失败，请重试', icon: 'none' });
          },
        });
      },
    });
  },

  onGoEditor() {
    if (this.data.status !== 'review') return;
    if (!this.preparePendingAudio()) return;
    this.stopPreview();

    wx.redirectTo({
      url: '/pages/editor/editor?from=record',
      fail: () => {
        this.clearPendingAudio();
        wx.showModal({
          title: '无法打开剪辑工坊',
          content: '剪辑页暂时不可用，可先「去转换」返回首页处理。',
          showCancel: false,
        });
      },
    });
  },

  // 页面卸载时静默停止录音（不发提示、不进入 REVIEW）
  stopRecordingSilently() {
    const status = this.data.status;
    if (status !== 'recording' && status !== 'paused' && !this.starting) return;
    if (!this.recorder) return;
    try {
      this.recorder.stop();
    } catch (e) {}
  },

  onOpenSettings() {
    this.openSettingForRecord();
  },
});
