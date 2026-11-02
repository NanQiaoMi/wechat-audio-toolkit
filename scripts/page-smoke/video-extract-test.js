// scripts/page-smoke/video-extract-test.js
/**
 * 视频提取音频（Video-to-Audio）自动化单元测试与端到端状态机验证
 * 覆盖：
 * 1. video-extractor.js 纯函数：formatSeconds, formatBytes, validateVideoFile, buildLibraryItem
 * 2. video-extractor.js 本地极速解复用 Mock (wx.createMediaContainer 成功 / 无音轨降级 / 异常降级)
 * 3. video-extractor.js 云端兜底抽取 Mock (wx.cloud.callFunction 成功 / 失败)
 * 4. video-extract.js 页面级生命周期、选视频、播放器寻位、去向分发（送入剪辑 / 送入转换 / 存入作品库 / 重选）
 * 5. 全局配置与路由连通性（app.json, index.wxml, editor.wxml）
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const videoExtractor = require('../../miniprogram/utils/video-extractor');
const libraryStore = require('../../miniprogram/utils/library-store');

let passedCount = 0;
let totalCount = 0;

function it(name, fn) {
  totalCount++;
  try {
    fn();
    passedCount++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function itAsync(name, fn) {
  totalCount++;
  try {
    await fn();
    passedCount++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function runAll() {
  console.log('\n# 1. video-extractor: 纯函数与数据校验');

  it('formatSeconds: 格式化秒数为 mm:ss 与 hh:mm:ss', () => {
    assert.strictEqual(videoExtractor.formatSeconds(0), '00:00');
    assert.strictEqual(videoExtractor.formatSeconds(45), '00:45');
    assert.strictEqual(videoExtractor.formatSeconds(65), '01:05');
    assert.strictEqual(videoExtractor.formatSeconds(600), '10:00');
    assert.strictEqual(videoExtractor.formatSeconds(3665), '01:01:05');
  });

  it('formatBytes: 格式化字节大小为 B / KB / MB / GB', () => {
    assert.strictEqual(videoExtractor.formatBytes(500), '500 B');
    assert.strictEqual(videoExtractor.formatBytes(1024), '1.0 KB');
    assert.strictEqual(videoExtractor.formatBytes(2.5 * 1024 * 1024), '2.5 MB');
    assert.strictEqual(videoExtractor.formatBytes(1.2 * 1024 * 1024 * 1024), '1.20 GB');
  });

  it('validateVideoFile: 正常视频、大视频(350MB放行)、超 500MB拦截、超 30 分钟拦截', () => {
    const emptyCheck = videoExtractor.validateVideoFile(null);
    assert.strictEqual(emptyCheck.valid, false);

    const zeroSize = videoExtractor.validateVideoFile({ size: 0, duration: 10 });
    assert.strictEqual(zeroSize.valid, false);

    // 350MB 大视频应正常放行并标记 isLarge = true
    const largeFile = videoExtractor.validateVideoFile({ size: 350 * 1024 * 1024, duration: 180 });
    assert.strictEqual(largeFile.valid, true);
    assert.strictEqual(largeFile.isLarge, true);
    assert.ok(largeFile.largeNotice.indexOf('较大') >= 0);

    // 超过 500MB 拦截
    const overSize = videoExtractor.validateVideoFile({ size: 520 * 1024 * 1024, duration: 60 });
    assert.strictEqual(overSize.valid, false);
    assert.ok(overSize.error.indexOf('500MB') >= 0);

    const overDuration = videoExtractor.validateVideoFile({ size: 20 * 1024 * 1024, duration: 1900 });
    assert.strictEqual(overDuration.valid, false);
    assert.ok(overDuration.error.indexOf('30 分钟') >= 0);

    const validFile = videoExtractor.validateVideoFile({ size: 15 * 1024 * 1024, duration: 120, name: 'my_video.mp4' });
    assert.strictEqual(validFile.valid, true);
    assert.strictEqual(validFile.name, 'my_video.mp4');
    assert.strictEqual(validFile.isLarge, false);
  });

  it('buildLibraryItem: 构造符合 library-store 规范的条目', () => {
    const item = videoExtractor.buildLibraryItem({
      title: '海边日落原声',
      tempFilePath: 'wxfile://tmp/sunset.m4a',
      fileID: 'cloud://test/sunset.m4a',
      duration: 185,
      size: 2.8 * 1024 * 1024,
      format: 'm4a',
      sourceVideoName: '海边日落.mp4',
    });

    assert.ok(item.id.startsWith('ve_'));
    assert.strictEqual(item.title, '海边日落原声');
    assert.strictEqual(item.format, 'm4a');
    assert.strictEqual(item.duration, 185);
    assert.strictEqual(item.durationText, '03:05');
    assert.strictEqual(item.source, 'video_extract');
    assert.strictEqual(item.sourceVideoName, '海边日落.mp4');
    assert.ok(item.expiresAt > Date.now());
  });

  console.log('\n# 2. video-extractor: 双核解复用管道与降级');

  await itAsync('extractAudioLocally: 环境缺失 wx.createMediaContainer 时自动提示降级', async () => {
    global.wx = undefined;
    const res = await videoExtractor.extractAudioLocally('wxfile://test.mp4');
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.fallbackToCloud, true);
  });

  await itAsync('extractAudioLocally: 成功解复用提取音轨 (Mock wx.createMediaContainer)', async () => {
    global.wx = {
      createMediaContainer: () => {
        let tracksAdded = [];
        return {
          extractDataSource: ({ source, success, fail }) => {
            success({
              tracks: [
                { kind: 'video', duration: 60 },
                { kind: 'audio', duration: 60 },
              ],
            });
          },
          addTrack: (t) => {
            tracksAdded.push(t);
          },
          export: ({ success, fail }) => {
            success({
              tempFilePath: 'wxfile://tmp/extracted_audio.m4a',
            });
          },
          destroy: () => {},
        };
      },
      getFileSystemManager: () => ({
        statSync: () => ({ size: 1024 * 1024 }),
      }),
    };

    const res = await videoExtractor.extractAudioLocally('wxfile://sample.mp4');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.mode, 'local');
    assert.strictEqual(res.tempFilePath, 'wxfile://tmp/extracted_audio.m4a');
    assert.strictEqual(res.format, 'm4a');
    assert.strictEqual(res.duration, 60);
    assert.strictEqual(res.size, 1024 * 1024);
  });

  await itAsync('extractAudioLocally: 无音轨时优雅提示降级云端', async () => {
    global.wx = {
      createMediaContainer: () => ({
        extractDataSource: ({ success }) => {
          success({
            tracks: [{ kind: 'video', duration: 30 }], // 无 audio 轨
          });
        },
        destroy: () => {},
      }),
    };

    const res = await videoExtractor.extractAudioLocally('wxfile://novideo.mp4');
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.fallbackToCloud, true);
    assert.ok(res.reason.indexOf('未检测到可用音频轨道') >= 0);
  });

  await itAsync('probeAudioPlayable: 探测成功 (onCanplay 触发时返回 true)', async () => {
    global.wx = {
      createInnerAudioContext: () => ({
        set src(v) {},
        onCanplay: (fn) => setTimeout(fn, 10),
        onError: (fn) => {},
        stop: () => {},
        destroy: () => {},
      }),
    };
    const ok = await videoExtractor.probeAudioPlayable('wxfile://test.m4a');
    assert.strictEqual(ok, true);
  });

  await itAsync('probeAudioPlayable: 探测失败 (onError 触发时拦截返回 false)', async () => {
    global.wx = {
      createInnerAudioContext: () => ({
        set src(v) {},
        onCanplay: (fn) => {},
        onError: (fn) => setTimeout(() => fn({ errCode: 10001, errMsg: 'MEDIA_ERR_DECODE' }), 10),
        stop: () => {},
        destroy: () => {},
      }),
    };
    const ok = await videoExtractor.probeAudioPlayable('wxfile://unplayable.m4a');
    assert.strictEqual(ok, false);
  });

  await itAsync('extractAudioLocally: 探测不可播放时自动标记 fallbackToCloud: true 触发云端接管', async () => {
    global.wx = {
      createMediaContainer: () => ({
        extractDataSource: ({ success }) => {
          success({ tracks: [{ kind: 'audio', duration: 60 }] });
        },
        addTrack: () => {},
        export: ({ success }) => {
          success({ tempFilePath: 'wxfile://tmp/bad_codec.m4a' });
        },
        destroy: () => {},
      }),
      getFileSystemManager: () => ({
        statSync: () => ({ size: 500 * 1024 }),
      }),
      createInnerAudioContext: () => ({
        set src(v) {},
        onCanplay: (fn) => {},
        onError: (fn) => setTimeout(() => fn({ errCode: 10001, errMsg: 'DECODE_ERROR' }), 10),
        stop: () => {},
        destroy: () => {},
      }),
    };

    const res = await videoExtractor.extractAudioLocally('wxfile://video.mp4');
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.fallbackToCloud, true);
    assert.ok(res.reason.indexOf('无法直接解码') >= 0);
  });

  await itAsync('extractAudioViaCloud: 云函数调用成功提取 MP3', async () => {
    global.wx = {
      cloud: {
        callFunction: ({ name, data, success, fail }) => {
          assert.strictEqual(name, 'ffmpegProbe');
          assert.strictEqual(data.action, 'extractVideoAudio');
          success({
            result: {
              success: true,
              fileID: 'cloud://bucket/audio.mp3',
              duration: 90,
              durationText: '01:30',
              size: 2 * 1024 * 1024,
              sizeText: '2.0 MB',
              format: 'mp3',
            },
          });
        },
      },
    };

    const res = await videoExtractor.extractAudioViaCloud('cloud://bucket/video.mp4', 'test.mp4');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.mode, 'cloud');
    assert.strictEqual(res.fileID, 'cloud://bucket/audio.mp3');
    assert.strictEqual(res.duration, 90);
    assert.strictEqual(res.format, 'mp3');
  });

  console.log('\n# 3. video-extract.js: 页面级逻辑与状态机');

  await itAsync('video-extract page: 完整选视频、解复用、成功状态机与送入剪辑/转换', async () => {
    // 加载页面
    let pageConfig = null;
    global.Page = (cfg) => { pageConfig = cfg; };
    require('../../miniprogram/pages/video-extract/video-extract.js');
    assert.ok(pageConfig, 'video-extract.js 成功注册页面');

    // 模拟微信与全局 App
    const globalData = {};
    global.getApp = () => ({ globalData });
    let audioPlayed = false;
    let audioStopped = false;
    let audioSrc = '';

    global.wx = {
      createInnerAudioContext: () => ({
        obeyMuteSwitch: true,
        set src(val) { audioSrc = val; },
        get src() { return audioSrc; },
        play: () => { audioPlayed = true; },
        stop: () => { audioStopped = true; },
        pause: () => { audioPlayed = false; },
        seek: () => {},
        destroy: () => {},
        onPlay: (fn) => {},
        onPause: (fn) => {},
        onStop: (fn) => {},
        onEnded: (fn) => {},
        onTimeUpdate: (fn) => {},
        onError: (fn) => {},
        onCanplay: (fn) => setTimeout(fn, 5),
      }),
      createMediaContainer: () => ({
        extractDataSource: ({ success }) => {
          success({
            tracks: [{ kind: 'audio', duration: 120 }],
          });
        },
        addTrack: () => {},
        export: ({ success }) => {
          success({ tempFilePath: 'wxfile://tmp/my_extracted.m4a' });
        },
        destroy: () => {},
      }),
      getFileSystemManager: () => ({
        statSync: () => ({ size: 3 * 1024 * 1024 }),
      }),
      showToast: () => {},
      showModal: () => {},
      navigateTo: ({ url }) => { globalData.lastNavigatedUrl = url; },
      reLaunch: ({ url }) => { globalData.lastRelaunchedUrl = url; },
    };

    // 实例化页面
    const page = Object.assign({}, pageConfig, {
      data: JSON.parse(JSON.stringify(pageConfig.data)),
      setData(patch) {
        Object.assign(this.data, patch);
      },
    });

    page.onLoad();
    assert.strictEqual(page.data.status, 'idle');

    // 执行选择与本地提取
    await page.handleSelectedVideo({
      tempFilePath: 'wxfile://tmp/dance_video.mp4',
      name: '舞蹈配乐.mp4',
      size: 25 * 1024 * 1024,
      duration: 120,
      thumbTempFilePath: 'wxfile://tmp/thumb.jpg',
    });

    // 校验提取成功
    assert.strictEqual(page.data.status, 'success');
    assert.strictEqual(page.data.extractMode, 'local');
    assert.strictEqual(page.data.resultAudio.title, '舞蹈配乐_原声');
    assert.strictEqual(page.data.resultAudio.format, 'm4a');
    assert.strictEqual(page.data.resultAudio.duration, 120);
    assert.strictEqual(page.data.resultAudio.tempFilePath, 'wxfile://tmp/my_extracted.m4a');

    // 试听播放
    page.togglePlayAudio();
    assert.strictEqual(audioPlayed, true);

    // 送入剪辑工坊
    page.sendToEditor();
    assert.strictEqual(globalData.lastNavigatedUrl, '/pages/editor/editor');
    assert.ok(globalData.pendingAudio);
    assert.strictEqual(globalData.pendingAudio.from, 'video-extract');
    assert.strictEqual(globalData.pendingAudio.path, 'wxfile://tmp/my_extracted.m4a');

    // 送入格式转换
    page.sendToConverter();
    assert.strictEqual(globalData.lastRelaunchedUrl, '/pages/index/index');

    // 存入作品库
    page.saveToMyLibrary();
    assert.strictEqual(page.data.isSavedToLibrary, true);

    // 重置回拾取器
    page.resetToPicker();
    assert.strictEqual(page.data.status, 'idle');
    assert.strictEqual(page.rawVideoFile, null);
  });

  await itAsync('video-extract page: 试听播放器报错时弹出云端转码引导弹窗，点击转码调用云端抽取', async () => {
    let pageConfig = null;
    global.Page = (cfg) => { pageConfig = cfg; };
    delete require.cache[require.resolve('../../miniprogram/pages/video-extract/video-extract.js')];
    require('../../miniprogram/pages/video-extract/video-extract.js');

    let modalConfig = null;
    let cloudCalled = false;
    let playerErrCb = null;

    global.wx = {
      createInnerAudioContext: () => ({
        obeyMuteSwitch: true,
        set src(v) {},
        play: () => {},
        stop: () => {},
        pause: () => {},
        seek: () => {},
        destroy: () => {},
        onPlay: () => {},
        onPause: () => {},
        onStop: () => {},
        onEnded: () => {},
        onTimeUpdate: () => {},
        onError: (fn) => { playerErrCb = fn; },
        onCanplay: (fn) => {},
      }),
      showModal: (cfg) => {
        modalConfig = cfg;
        if (cfg.success) cfg.success({ confirm: true });
      },
      showToast: () => {},
      cloud: {
        uploadFile: async () => ({ fileID: 'cloud://bucket/sample.mp4' }),
        callFunction: ({ success }) => {
          cloudCalled = true;
          if (success) {
            success({
              result: {
                success: true,
                fileID: 'cloud://bucket/sample.mp3',
                duration: 45,
                format: 'mp3',
                size: 1024 * 500,
              },
            });
          }
        },
        downloadFile: async () => ({ tempFilePath: 'wxfile://tmp/downloaded.mp3' }),
      },
    };

    const page = Object.assign({}, pageConfig, {
      data: JSON.parse(JSON.stringify(pageConfig.data)),
      setData(patch) { Object.assign(this.data, patch); },
    });

    page.onLoad();
    page.setData({ extractMode: 'local' });
    page.rawVideoFile = {
      tempFilePath: 'wxfile://tmp/original.mp4',
      name: '特殊音轨视频.mp4',
      size: 10 * 1024 * 1024,
      duration: 45,
    };

    // 触发播放器解码错误
    assert.ok(playerErrCb, '必须注册 onError 回调');
    playerErrCb({ errCode: 10001, errMsg: 'MEDIA_ERR_DECODE' });

    assert.ok(modalConfig, '必须弹出受限提示弹窗');
    assert.strictEqual(modalConfig.title, '音频格式受限');
    assert.ok(modalConfig.content.indexOf('云端 FFmpeg 转换为标准 MP3') >= 0);

    // 等待云端抽取执行完成
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(cloudCalled, true, '点击转码后必须调用云端抽取');
    assert.strictEqual(page.data.status, 'success');
    assert.strictEqual(page.data.extractMode, 'cloud');
    assert.strictEqual(page.data.resultAudio.format, 'mp3');
  });

  await itAsync('video-extract page: reExtractViaCloud 手动一键转为标准 MP3', async () => {
    let pageConfig = null;
    global.Page = (cfg) => { pageConfig = cfg; };
    delete require.cache[require.resolve('../../miniprogram/pages/video-extract/video-extract.js')];
    require('../../miniprogram/pages/video-extract/video-extract.js');

    let cloudCalled = false;

    global.wx = {
      createInnerAudioContext: () => ({
        obeyMuteSwitch: true,
        set src(v) {},
        play: () => {},
        stop: () => {},
        pause: () => {},
        seek: () => {},
        destroy: () => {},
        onPlay: () => {},
        onPause: () => {},
        onStop: () => {},
        onEnded: () => {},
        onTimeUpdate: () => {},
        onError: () => {},
        onCanplay: () => {},
      }),
      showToast: () => {},
      cloud: {
        uploadFile: async () => ({ fileID: 'cloud://bucket/re_extract.mp4' }),
        callFunction: ({ success }) => {
          cloudCalled = true;
          if (success) {
            success({
              result: {
                success: true,
                fileID: 'cloud://bucket/re_extract.mp3',
                duration: 30,
                format: 'mp3',
                size: 600 * 1024,
              },
            });
          }
        },
        downloadFile: async () => ({ tempFilePath: 'wxfile://tmp/re_extracted.mp3' }),
      },
    };

    const page = Object.assign({}, pageConfig, {
      data: JSON.parse(JSON.stringify(pageConfig.data)),
      setData(patch) { Object.assign(this.data, patch); },
    });

    page.onLoad();
    page.rawVideoFile = {
      tempFilePath: 'wxfile://tmp/manual.mp4',
      name: '手动重转.mp4',
      size: 5 * 1024 * 1024,
      duration: 30,
    };

    await page.reExtractViaCloud();
    assert.strictEqual(cloudCalled, true);
    assert.strictEqual(page.data.extractMode, 'cloud');
    assert.strictEqual(page.data.resultAudio.format, 'mp3');
  });

  await itAsync('chooseAlbumVideo: wx.chooseMedia 强制传入 sizeType: [original] 且 compressed: false 规避微信原生压缩与音频解码失败', async () => {
    let capturedOpts = null;
    let pageConfig = null;
    global.Page = (cfg) => { pageConfig = cfg; };
    delete require.cache[require.resolve('../../miniprogram/pages/video-extract/video-extract.js')];
    require('../../miniprogram/pages/video-extract/video-extract.js');

    global.wx = {
      chooseMedia: (opts) => {
        capturedOpts = opts;
      },
      showToast: () => {},
      showModal: () => {},
    };

    const page = Object.assign({}, pageConfig, {
      data: JSON.parse(JSON.stringify(pageConfig.data)),
      setData(patch) { Object.assign(this.data, patch); },
    });

    page.chooseAlbumVideo();
    assert.ok(capturedOpts, 'wx.chooseMedia 必须被调用');
    assert.deepStrictEqual(capturedOpts.sizeType, ['original'], 'sizeType 必须强制为 original 以绕过原生压缩');
    assert.strictEqual(capturedOpts.compressed, false, 'compressed 必须显式为 false');
    assert.deepStrictEqual(capturedOpts.mediaType, ['video']);
    assert.deepStrictEqual(capturedOpts.sourceType, ['album']);
  });

  await itAsync('chooseAlbumVideo: 降级 wx.chooseVideo 强制传入 compressed: false 规避原生压缩', async () => {
    let capturedVideoOpts = null;
    let pageConfig = null;
    global.Page = (cfg) => { pageConfig = cfg; };
    delete require.cache[require.resolve('../../miniprogram/pages/video-extract/video-extract.js')];
    require('../../miniprogram/pages/video-extract/video-extract.js');

    global.wx = {
      chooseMedia: undefined, // 模拟旧基础库
      chooseVideo: (opts) => {
        capturedVideoOpts = opts;
      },
      showToast: () => {},
      showModal: () => {},
    };

    const page = Object.assign({}, pageConfig, {
      data: JSON.parse(JSON.stringify(pageConfig.data)),
      setData(patch) { Object.assign(this.data, patch); },
    });

    page.chooseAlbumVideo();
    assert.ok(capturedVideoOpts, 'wx.chooseVideo 必须被调用');
    assert.strictEqual(capturedVideoOpts.compressed, false, 'compressed 必须为 false 禁用压缩');
  });

  await itAsync('chooseAlbumVideo: 捕获微信相册原生解码/压缩错误并提供友好弹窗指引且可一键转入聊天选取', async () => {
    let modalShown = null;
    let pageConfig = null;
    global.Page = (cfg) => { pageConfig = cfg; };
    delete require.cache[require.resolve('../../miniprogram/pages/video-extract/video-extract.js')];
    require('../../miniprogram/pages/video-extract/video-extract.js');

    let messageFileCalled = false;
    global.wx = {
      chooseMedia: (opts) => {
        opts.fail({ errMsg: 'chooseMedia:fail audio decode error' });
      },
      chooseMessageFile: (opts) => {
        messageFileCalled = true;
      },
      showToast: () => {},
      showModal: (modal) => {
        modalShown = modal;
        modal.success({ confirm: true });
      },
    };

    const page = Object.assign({}, pageConfig, {
      data: JSON.parse(JSON.stringify(pageConfig.data)),
      setData(patch) { Object.assign(this.data, patch); },
    });

    page.chooseAlbumVideo();
    assert.ok(modalShown, '必须弹出友好指导弹窗');
    assert.strictEqual(modalShown.title, '相册转码受限');
    assert.ok(modalShown.content.indexOf('从聊天会话选取') >= 0);
    assert.strictEqual(messageFileCalled, true, '确认转入聊天选取必须调用 chooseMessageFile');
  });

  await itAsync('chooseMessageVideo: 采用 type: all 兼容视频与文件形式，彻底绕过相册压缩', async () => {
    let capturedMessageOpts = null;
    let pageConfig = null;
    global.Page = (cfg) => { pageConfig = cfg; };
    delete require.cache[require.resolve('../../miniprogram/pages/video-extract/video-extract.js')];
    require('../../miniprogram/pages/video-extract/video-extract.js');

    global.wx = {
      chooseMessageFile: (opts) => {
        capturedMessageOpts = opts;
      },
      showToast: () => {},
    };

    const page = Object.assign({}, pageConfig, {
      data: JSON.parse(JSON.stringify(pageConfig.data)),
      setData(patch) { Object.assign(this.data, patch); },
    });

    page.chooseMessageVideo();
    assert.ok(capturedMessageOpts, 'wx.chooseMessageFile 必须被调用');
    assert.strictEqual(capturedMessageOpts.type, 'all', 'type 必须为 all 兼容原文件与视频');
  });

  it('videoExtractor.MAX_CLOUD_VIDEO_BYTES: 同步放宽至 500MB', () => {
    assert.strictEqual(videoExtractor.MAX_CLOUD_VIDEO_BYTES, 500 * 1024 * 1024);
  });

  console.log('\n# 4. 路由与跨模块入口一致性核查');

  it('app.json 包含 pages/video-extract/video-extract 路由', () => {
    const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../miniprogram/app.json'), 'utf8'));
    assert.ok(appJson.pages.includes('pages/video-extract/video-extract'), 'app.json 必须注册 video-extract 页面');
  });

  it('index.wxml & index.js 包含 goVideoExtract 入口', () => {
    const indexWxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxml'), 'utf8');
    const indexJs = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.js'), 'utf8');
    assert.ok(indexWxml.indexOf('goVideoExtract') >= 0, 'index.wxml 必须包含视频提取快捷卡片');
    assert.ok(indexJs.indexOf('goVideoExtract') >= 0, 'index.js 必须实现 goVideoExtract 跳转函数');
  });

  it('editor.wxml & editor.js 包含 goVideoExtract 入口', () => {
    const editorWxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/editor/editor.wxml'), 'utf8');
    const editorJs = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/editor/editor.js'), 'utf8');
    assert.ok(editorWxml.indexOf('goVideoExtract') >= 0, 'editor.wxml 必须包含视频提取入口按键');
    assert.ok(editorJs.indexOf('goVideoExtract') >= 0, 'editor.js 必须实现 goVideoExtract 跳转函数');
  });

  console.log('\n============================================');
  console.log(`视频提取测试套件: pass=${passedCount} fail=${totalCount - passedCount}`);
  if (passedCount === totalCount) {
    console.log('全部通过 ✅\n');
  } else {
    console.error('存在失败项 ❌\n');
    process.exitCode = 1;
  }
}

runAll();
