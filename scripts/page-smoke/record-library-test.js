/**
 * scripts/page-smoke/record-library-test.js
 * 针对 v5.1 现场录音 (record) 与 我的作品库 (library) 及 library-store.js 的自动化单测
 */

const assert = require('assert');
const path = require('path');
const libraryStore = require('../../miniprogram/utils/library-store.js');
const recordAudio = require('../../miniprogram/utils/record-audio.js');

let passCount = 0;
function test(name, fn) {
  try {
    fn();
    passCount++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}:`, err.message);
    throw err;
  }
}

console.log('\n# recordAudio: 录音物理能量与实时波形算法测试');

test('computePcmRms: 静音与正弦波能量计算', () => {
  const silent = new Int16Array(400);
  assert.strictEqual(recordAudio.computePcmRms(silent.buffer), 0);

  // 振幅为 16384 的正弦波（50% 满量程），理论 RMS 约为 0.5 * 0.7071 = 0.3535
  const sine = new Int16Array(1000);
  for (let i = 0; i < 1000; i++) {
    sine[i] = Math.round(Math.sin((2 * Math.PI * i) / 50) * 16384);
  }
  const rms = recordAudio.computePcmRms(sine.buffer);
  assert(rms > 0.34 && rms < 0.36, `RMS expected around 0.354, got ${rms}`);
});

test('computePcmPeak: 正确识别最大峰值', () => {
  const buf = new Int16Array([0, 1000, -15000, 3000, 32767]);
  const peak = recordAudio.computePcmPeak(buf.buffer);
  assert.strictEqual(Number(peak.toFixed(4)), 1.0);
});

test('rmsToDb & formatDecibelStatus: 分贝值转换与状态标签', () => {
  assert.strictEqual(recordAudio.rmsToDb(0), -60);
  assert.strictEqual(recordAudio.rmsToDb(1.0), 0);
  const goodStatus = recordAudio.formatDecibelStatus(-12);
  assert.strictEqual(goodStatus.level, 'good');
  assert.strictEqual(goodStatus.status, '声音清晰');
  const quietStatus = recordAudio.formatDecibelStatus(-55);
  assert.strictEqual(quietStatus.level, 'quiet');
});

test('pcmToWav: 生成标准 44 字节 RIFF/WAVE 头与采样数据', () => {
  const sampleRate = 16000;
  const pcm = new Int16Array(1600); // 100ms
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 1000;
  const wavBuffer = recordAudio.pcmToWav(pcm.buffer, sampleRate, 1, 16);
  assert.strictEqual(wavBuffer.byteLength, 44 + pcm.byteLength);

  const view = new DataView(wavBuffer);
  // RIFF
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  assert.strictEqual(riff, 'RIFF');
  // WAVE
  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  assert.strictEqual(wave, 'WAVE');
  // fmt 
  const fmt = String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15));
  assert.strictEqual(fmt, 'fmt ');
  assert.strictEqual(view.getUint16(20, true), 1); // PCM 线性格式
  assert.strictEqual(view.getUint16(22, true), 1); // 单声道
  assert.strictEqual(view.getUint32(24, true), 16000); // 采样率
  assert.strictEqual(view.getUint32(28, true), 32000); // 字节率
  assert.strictEqual(view.getUint16(34, true), 16); // 位深
  // data
  const dataTag = String.fromCharCode(view.getUint8(36), view.getUint8(37), view.getUint8(38), view.getUint8(39));
  assert.strictEqual(dataTag, 'data');
  assert.strictEqual(view.getUint32(40, true), pcm.byteLength);
});

test('concatChunks: 多 ArrayBuffer 高速合并', () => {
  const c1 = new Uint8Array([1, 2, 3]);
  const c2 = new Uint8Array([4, 5]);
  const merged = recordAudio.concatChunks([c1.buffer, c2.buffer]);
  assert.strictEqual(merged.length, 5);
  assert.deepStrictEqual(Array.from(merged), [1, 2, 3, 4, 5]);
});

test('pushWaveBar: 保持 28 柱队列滚动与非线性增益', () => {
  const bars = recordAudio.initWaveBars(28);
  assert.strictEqual(bars.length, 28);
  const nextBars = recordAudio.pushWaveBar(bars, 0.8, 110, 8);
  assert.strictEqual(nextBars.length, 28);
  const newestBar = nextBars[nextBars.length - 1];
  assert(newestBar.height > 80, `Expected high bar for 0.8 amplitude, got ${newestBar.height}`);
});

console.log('\n# libraryStore: 纯函数数据层测试');

test('normalizeItem: 补全字段与默认 24h 过期', () => {
  const now = 1700000000000;
  const item = libraryStore.normalizeItem({
    name: 'test_track.mp3',
    fileID: 'cloud://test-env/audio/test_track.mp3',
    kind: 'convert',
    createdAt: now
  });
  assert.strictEqual(item.name, 'test_track.mp3');
  assert.strictEqual(item.format, 'mp3');
  assert.strictEqual(item.kind, 'convert');
  assert.strictEqual(item.createdAt, now);
  assert.strictEqual(item.expiresAt, now + 24 * 3600 * 1000);
  assert.strictEqual(typeof item.id, 'string');
});

test('dedupeItems: 相同 fileID 去重置顶', () => {
  const item1 = { id: '1', fileID: 'cloud://f1', name: 'v1.mp3', createdAt: 100 };
  const item2 = { id: '2', fileID: 'cloud://f2', name: 'v2.mp3', createdAt: 200 };
  const item3 = { id: '3', fileID: 'cloud://f1', name: 'v1_new.mp3', createdAt: 300 };
  const deduped = libraryStore.dedupeItems([item3, item2, item1]);
  assert.strictEqual(deduped.length, 2);
  assert.strictEqual(deduped[0].fileID, 'cloud://f1');
  assert.strictEqual(deduped[0].name, 'v1_new.mp3');
});

test('addItem: 超过 50 个自动截断超限元素', () => {
  let list = [];
  for (let i = 0; i < 60; i++) {
    list = libraryStore.addItem(list, {
      name: `item_${i}.mp3`,
      fileID: `cloud://f_${i}`,
      kind: 'convert',
      createdAt: 1000 + i
    });
  }
  assert.strictEqual(list.length, 50);
  assert.strictEqual(list[0].name, 'item_59.mp3');
});

test('isExpired: 超过 24 小时判定过期', () => {
  const now = Date.now();
  const validItem = { createdAt: now - 3600 * 1000, expiresAt: now + 23 * 3600 * 1000 };
  const expiredItem = { createdAt: now - 25 * 3600 * 1000, expiresAt: now - 1000 };
  assert.strictEqual(libraryStore.isExpired(validItem, now), false);
  assert.strictEqual(libraryStore.isExpired(expiredItem, now), true);
});

test('mergeLegacy: 自动将旧版 audio_convert_history 映射迁移', () => {
  const legacy = [
    {
      id: 12345,
      fileName: 'input.wav',
      targetFileName: 'output.mp3',
      sourceExt: 'WAV',
      targetFormat: 'MP3',
      targetSizeText: '1.2 MB',
      fileID: 'cloud://env/legacy.mp3',
      downloadUrl: 'https://tmp/legacy.mp3',
      time: '14:20'
    }
  ];
  const migrated = libraryStore.mergeLegacy(legacy);
  assert.strictEqual(migrated.length, 1);
  assert.strictEqual(migrated[0].kind, 'convert');
  assert.strictEqual(migrated[0].name, 'output.mp3');
  assert.strictEqual(migrated[0].fileID, 'cloud://env/legacy.mp3');
});

test('itemFromEdit: 剪辑产物入库数据映射正确', () => {
  const editResult = {
    fileName: '成片_混音_20261102.mp3',
    size: 2048000,
    sizeText: '2.0 MB',
    durationText: '01:30',
    fileID: 'cloud://env/edit_out.mp3',
    clipCount: 4
  };
  const item = libraryStore.itemFromEdit(editResult);
  assert.strictEqual(item.kind, 'edit');
  assert.strictEqual(item.name, '成片_混音_20261102.mp3');
  assert.strictEqual(item.extra.clipCount, 4);
});

console.log('\n# 页面级冒烟与桩测试');

function makeWxStub() {
  const storage = {};
  return {
    env: { USER_DATA_PATH: '/tmp' },
    getFileSystemManager() {
      return {
        writeFileSync(p, d) {},
        readFileSync(p) { return Buffer.alloc(0); },
        unlinkSync(p) {},
      };
    },
    getStorageSync(k) { return storage[k] || null; },
    setStorageSync(k, v) { storage[k] = v; },
    removeStorageSync(k) { delete storage[k]; },
    showToast() {},
    showModal(opts) { if (opts.success) opts.success({ confirm: true }); },
    showShareMenu() {},
    navigateTo() {},
    navigateBack() {},
    setInnerAudioOption() {},
    createInnerAudioContext() {
      let isPlaying = false;
      const listeners = { play: [], pause: [], stop: [], timeUpdate: [], ended: [] };
      return {
        src: '',
        obeyMuteSwitch: true,
        currentTime: 0,
        duration: 2.5,
        play() {
          isPlaying = true;
          listeners.play.forEach(fn => fn());
        },
        pause() {
          isPlaying = false;
          listeners.pause.forEach(fn => fn());
        },
        stop() {
          isPlaying = false;
          listeners.stop.forEach(fn => fn());
        },
        seek(t) { this.currentTime = t; },
        destroy() {},
        onPlay(fn) { listeners.play.push(fn); },
        onPause(fn) { listeners.pause.push(fn); },
        onStop(fn) { listeners.stop.push(fn); },
        onEnded(fn) { listeners.ended.push(fn); },
        onError() {},
        onTimeUpdate(fn) { listeners.timeUpdate.push(fn); },
        onCanplay() {},
      };
    },
    getRecorderManager() {
      return {
        start() {},
        pause() {},
        resume() {},
        stop() {},
        onStart() {},
        onPause() {},
        onResume() {},
        onStop() {},
        onError() {},
        onFrameRecorded() {},
      };
    }
  };
}

test('record.js: 模块定义与基础数据结构存在', () => {
  const originalWx = global.wx;
  const originalPage = global.Page;
  let pageOptions = null;
  global.wx = makeWxStub();
  global.Page = (opts) => { pageOptions = opts; };

  try {
    // 动态加载执行 record.js
    delete require.cache[require.resolve('../../miniprogram/pages/record/record.js')];
    require('../../miniprogram/pages/record/record.js');
    assert(pageOptions, 'Page 未被注册');
    assert.strictEqual(typeof pageOptions.onStartRecord, 'function');
    assert.strictEqual(typeof pageOptions.onFinishRecord, 'function');
    assert.strictEqual(typeof pageOptions.onGoEditor, 'function');
    assert.strictEqual(typeof pageOptions.onGoConvert, 'function');
    assert.strictEqual(pageOptions.data.status, 'idle');
    assert.strictEqual(pageOptions.data.liveWaveBars.length, 28);
  } finally {
    try { pageInstance.onUnload(); } catch (e) {}
    global.wx = originalWx;
    global.Page = originalPage;
  }
});

test('record.js: 实时帧声波更新与 28 柱动态谱线响应', () => {
  const originalWx = global.wx;
  const originalPage = global.Page;
  let pageInstance = null;
  global.wx = makeWxStub();
  global.Page = (opts) => {
    pageInstance = Object.assign({}, opts, {
      setData(patch) {
        Object.assign(this.data, patch);
      }
    });
  };

  try {
    delete require.cache[require.resolve('../../miniprogram/pages/record/record.js')];
    require('../../miniprogram/pages/record/record.js');
    pageInstance.onLoad();

    // 模拟启动录音
    pageInstance.handleRecorderStart();
    assert.strictEqual(pageInstance.data.status, 'recording');

    // 模拟录入一段有声音频帧 (16-bit PCM 正弦波)
    const pcmFrame = new Int16Array(1000);
    for (let i = 0; i < 1000; i++) pcmFrame[i] = 16384;
    pageInstance.handleFrameRecorded({ frameBuffer: pcmFrame.buffer });

    assert.strictEqual(pageInstance.pcmChunks.length, 1);
    assert(pageInstance.data.liveDecibel > -20, '未正确计算分贝');
    assert.strictEqual(pageInstance.data.liveWaveBars.length, 28);
    const lastBar = pageInstance.data.liveWaveBars[27];
    assert(lastBar.height > 20, '波形条高度未跟随振幅更新');
  } finally {
    try { pageInstance.onUnload(); } catch (e) {}
    global.wx = originalWx;
    global.Page = originalPage;
  }
});

test('record.js: 随时暂停/中断即时回放与恢复', () => {
  const originalWx = global.wx;
  const originalPage = global.Page;
  let pageInstance = null;
  global.wx = makeWxStub();
  global.Page = (opts) => {
    pageInstance = Object.assign({}, opts, {
      setData(patch) {
        Object.assign(this.data, patch);
      }
    });
  };

  try {
    delete require.cache[require.resolve('../../miniprogram/pages/record/record.js')];
    require('../../miniprogram/pages/record/record.js');
    pageInstance.onLoad();

    pageInstance.handleRecorderStart();

    // 录入 1 秒的 PCM 帧 (16000 采样 = 32000 字节)
    const pcm = new Int16Array(16000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = 8000;
    pageInstance.handleFrameRecorded({ frameBuffer: pcm.buffer });

    // 随时中断/暂停
    pageInstance.onPauseRecord();
    assert.strictEqual(pageInstance.data.status, 'paused');
    assert.strictEqual(pageInstance.data.pausedPreviewReady, true);
    assert.strictEqual(pageInstance.data.pausedDuration, 1.0);
    assert(pageInstance.pausedTempPath.length > 0, '未生成中断临时 WAV 路径');

    // 试听播放与寻位
    pageInstance.onTogglePausedPreview();
    assert.strictEqual(pageInstance.data.pausedIsPlaying, true);

    pageInstance.onPausedPreviewSeek({ detail: { value: 0.5 } });
    assert.strictEqual(pageInstance.data.pausedCurrentTime, 0.5);

    // 继续录音：自动停止试听并切回 recording
    pageInstance.onResumeRecord();
    assert.strictEqual(pageInstance.data.status, 'recording');
    assert.strictEqual(pageInstance.data.pausedIsPlaying, false);
  } finally {
    try { pageInstance.onUnload(); } catch (e) {}
    global.wx = originalWx;
    global.Page = originalPage;
  }
});

test('record.js: 系统通话打断中断保存与最终 WAV 合成', () => {
  const originalWx = global.wx;
  const originalPage = global.Page;
  let pageInstance = null;
  global.wx = makeWxStub();
  global.Page = (opts) => {
    pageInstance = Object.assign({}, opts, {
      setData(patch) {
        Object.assign(this.data, patch);
      }
    });
  };

  try {
    delete require.cache[require.resolve('../../miniprogram/pages/record/record.js')];
    require('../../miniprogram/pages/record/record.js');
    pageInstance.onLoad();

    pageInstance.handleRecorderStart();
    const pcm = new Int16Array(32000); // 2 秒
    pageInstance.handleFrameRecorded({ frameBuffer: pcm.buffer });

    // 模拟系统来电打断
    pageInstance.handleAudioInterruptionBegin();
    assert.strictEqual(pageInstance.data.status, 'paused');
    assert.strictEqual(pageInstance.data.interrupted, true);
    assert.strictEqual(pageInstance.data.pausedPreviewReady, true);

    // 完成录音
    pageInstance.onFinishRecord();
    pageInstance.handleRecorderStop({ duration: 2000 });

    assert.strictEqual(pageInstance.data.status, 'review');
    assert.strictEqual(pageInstance.data.durationSec, 2.0);
    assert(pageInstance.data.fileName.endsWith('.wav'), '生成文件名应为 .wav');
    assert(pageInstance.data.tempFilePath.endsWith('.wav'), '输出路径应为 .wav');
  } finally {
    try { pageInstance.onUnload(); } catch (e) {}
    global.wx = originalWx;
    global.Page = originalPage;
  }
});

test('library.js: 模块定义、加载与类型筛选切换', () => {
  const originalWx = global.wx;
  const originalPage = global.Page;
  let pageOptions = null;
  global.wx = makeWxStub();
  global.Page = (opts) => { pageOptions = opts; };

  try {
    delete require.cache[require.resolve('../../miniprogram/pages/library/library.js')];
    require('../../miniprogram/pages/library/library.js');
    assert(pageOptions, 'Page 未被注册');
    assert.strictEqual(typeof pageOptions.onShow, 'function');
    assert.strictEqual(typeof pageOptions.setFilter, 'function');
    assert.strictEqual(typeof pageOptions.deleteItem, 'function');
    assert.strictEqual(typeof pageOptions.clearAll, 'function');
    assert.strictEqual(typeof pageOptions.shareItem, 'function');
  } finally {
    try { pageInstance.onUnload(); } catch (e) {}
    global.wx = originalWx;
    global.Page = originalPage;
  }
});

console.log(`\n============================================\n录音与作品库单测: pass=${passCount} fail=0\n全部通过 ✅\n`);
process.exit(0);
