#!/usr/bin/env node
/**
 * 音乐剪辑前端自测 v2（无需微信开发者工具，纯 Node）：
 *   1) editor-utils.js 纯函数断言（clips 增删改排序/分割/裁剪/ripple delete/淡入淡出/
 *      跨源预览队列/v2 导出请求/peaks 解码）
 *   2) editor.wxml 标签配对 + 事件处理函数存在性 + wx:for/wx:key
 *   3) editor.wxss 花括号配对、editor.json 可解析
 *   4) 页面逻辑冒烟：stub wx / Page，跑多源导入→片段操作→淡入淡出→跨源预览→v2 导出→转发
 *
 * 运行（系统 PATH 无 node 时用 DSH 内置 Node）：
 *   node scripts/editor-spike/frontend-test.js
 * 另配合：
 *   node --check miniprogram/pages/editor/editor.js
 *   node --check miniprogram/utils/editor-utils.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const UTILS_PATH = path.join(ROOT, 'miniprogram', 'utils', 'editor-utils.js');
const PAGE_DIR = path.join(ROOT, 'miniprogram', 'pages', 'editor');
const WXML_PATH = path.join(PAGE_DIR, 'editor.wxml');
const WXSS_PATH = path.join(PAGE_DIR, 'editor.wxss');
const JS_PATH = path.join(PAGE_DIR, 'editor.js');
const JSON_PATH = path.join(PAGE_DIR, 'editor.json');
const u = require(UTILS_PATH);

let passed = 0;
const failures = [];
const pendingSmokeTests = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS  ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('FAIL  ' + name);
    console.log('      ' + (err && err.message ? err.message.split('\n')[0] : err));
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS  ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('FAIL  ' + name);
    console.log('      ' + (err && err.message ? err.message.split('\n')[0] : err));
  }
}

function smokeTest(name, fn) {
  pendingSmokeTests.push({ name, fn });
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ========================================================================== */
/* 测试数据构造                                                                */
/* ========================================================================== */

function makeSources() {
  return [
    {
      id: 's1',
      fileID: 'cloud://test/a.mp3',
      localPath: 'wxfile://tmp/a.mp3',
      name: 'a.mp3',
      size: 1024 * 1024,
      duration: 120,
      format: 'mp3',
      sampleRate: 44100,
      channels: 2,
      bucketMs: 50,
      peaks: new Uint8Array(0),
      playable: true,
    },
    {
      id: 's2',
      fileID: 'cloud://test/b.wav',
      localPath: 'wxfile://tmp/b.wav',
      name: 'b.wav',
      size: 2 * 1024 * 1024,
      duration: 60,
      format: 'wav',
      sampleRate: 44100,
      channels: 2,
      bucketMs: 50,
      peaks: new Uint8Array(0),
      playable: true,
    },
  ];
}

function makeClip(id, sourceId, inSec, outSec, fadeIn, fadeOut) {
  return { id: id, sourceId: sourceId, in: inSec, out: outSec, fadeIn: fadeIn || 0, fadeOut: fadeOut || 0 };
}

/* ========================================================================== */
/* 1. 纯函数断言                                                              */
/* ========================================================================== */

test('时间/大小/淡入淡出/dB 格式化', () => {
  assert.strictEqual(u.formatClock(0), '00:00');
  assert.strictEqual(u.formatClock(245.612), '04:05');
  assert.strictEqual(u.formatPrecise(245.612), '04:05.6');
  assert.strictEqual(u.formatPrecise(59.99), '01:00.0');
  assert.strictEqual(u.formatPrecise(600), '10:00.0');
  assert.strictEqual(u.formatSecondsLabel(62.5), '1 分 02.5 秒');
  assert.strictEqual(u.formatFade(0), '0s');
  assert.strictEqual(u.formatFade(0.5), '0.5s');
  assert.strictEqual(u.formatFade(3), '3s');
  assert.strictEqual(u.formatBytes(50 * 1024 * 1024), '50 MB');
  assert.strictEqual(u.formatDb(-6), '-6 dB');
  assert.strictEqual(u.formatDb(3), '+3 dB');
  assert.ok(Math.abs(u.dbToGain(-6) - 0.5012) < 0.001);
  assert.strictEqual(u.dbToGain(12), 1);
});

test('本地文件预检与 upload 云路径', () => {
  assert.strictEqual(u.validateLocalFile({ name: 'a.MP3', size: 1024 }).ok, true);
  assert.strictEqual(u.validateLocalFile({ name: 'a.txt', size: 1024 }).ok, false);
  assert.strictEqual(u.validateLocalFile({ name: 'a.mp3', size: 0 }).ok, false);
  assert.strictEqual(u.validateLocalFile({ name: 'a.mp3', size: 51 * 1024 * 1024 }).code, 'FILE_TOO_LARGE');
  assert.strictEqual(u.buildCloudPath('MP3', 1700000000000, 'ab12cd'), 'edit_sources/1700000000000_ab12cd.mp3');
});

test('clipDuration / planDuration / validateClips 正常路径', () => {
  const sources = makeSources();
  const clips = [
    makeClip('c1', 's1', 0, 120),
    makeClip('c2', 's2', 0, 30),
    makeClip('c3', 's2', 30, 60),
  ];
  assert.strictEqual(u.clipDuration(clips[0]), 120);
  assert.strictEqual(u.planDuration(clips), 180);
  assert.strictEqual(u.validateClips(clips, sources).ok, true);
});

test('validateClips：空/超 40 片/总时长 >600/单片过短/源不存在', () => {
  const sources = makeSources();
  assert.strictEqual(u.validateClips([], sources).code, 'NO_CLIPS');
  assert.strictEqual(u.validateClips([makeClip('c1', 's1', 0, 120)], []).code, 'NO_SOURCES');

  const many = [];
  for (let i = 0; i < 41; i++) many.push(makeClip('c' + i, 's1', i, i + 1));
  assert.strictEqual(u.validateClips(many, sources).code, 'TOO_MANY_CLIPS');

  assert.strictEqual(
    u.validateClips([makeClip('long', 's1', 0, 301), makeClip('long2', 's2', 0, 300)], sources).code,
    'DURATION_TOO_LONG'
  );
  assert.strictEqual(u.validateClips([makeClip('tiny', 's1', 0, 0.1)], sources).code, 'CLIP_TOO_SHORT');
  assert.strictEqual(u.validateClips([makeClip('c1', 'sX', 0, 10)], sources).code, 'INVALID_SOURCE');
});

test('moveClip / removeClip', () => {
  const clips = [makeClip('c1', 's1', 0, 10), makeClip('c2', 's1', 10, 20), makeClip('c3', 's1', 20, 30)];
  assert.deepStrictEqual(u.moveClip(clips, 0, 2).clips.map((c) => c.id), ['c2', 'c3', 'c1']);
  assert.deepStrictEqual(u.moveClip(clips, 2, 0).clips.map((c) => c.id), ['c3', 'c1', 'c2']);
  assert.strictEqual(u.moveClip(clips, 0, 9).ok, false);
  assert.strictEqual(u.removeClip(clips, 1).clips.length, 2);
  assert.strictEqual(u.removeClip([clips[0]], 0).ok, false, '最后一段不允许删除');
});

test('splitClipAt：中间分割、fade 归属、两段各 ≥0.2s', () => {
  const clips = [makeClip('c1', 's1', 0, 120, 2, 3)];
  const res = u.splitClipAt(clips, 0, 30, 'c1b');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.clips.length, 2);
  assert.deepStrictEqual(res.clips[0], { id: 'c1', sourceId: 's1', in: 0, out: 30, fadeIn: 2, fadeOut: 0 });
  assert.deepStrictEqual(res.clips[1], { id: 'c1b', sourceId: 's1', in: 30, out: 120, fadeIn: 0, fadeOut: 3 });
  assert.strictEqual(u.splitClipAt(clips, 0, 0.1, 'x').ok, false, '太靠近开头');
  assert.strictEqual(u.splitClipAt(clips, 0, 119.95, 'x').ok, false, '太靠近结尾');
  assert.strictEqual(u.splitClipAt(clips, 0, 0.2, 'x').ok, true, '刚好 0.2s 可分割');
});

test('cropClipToRange / resetClipToFull', () => {
  const clip = makeClip('c1', 's1', 10, 100, 1, 2);
  const cropped = u.cropClipToRange(clip, 30, 60);
  assert.strictEqual(cropped.ok, true);
  assert.strictEqual(cropped.clip.in, 30);
  assert.strictEqual(cropped.clip.out, 60);
  assert.strictEqual(cropped.clip.id, 'c1');
  assert.strictEqual(u.cropClipToRange(clip, 30, 30.1).ok, false);
  const reset = u.resetClipToFull(cropped.clip, 120);
  assert.strictEqual(reset.clip.in, 0);
  assert.strictEqual(reset.clip.out, 120);
});

test('rippleDeleteSelection：单片中间/边缘、同源多片、其它源不动、残片丢弃', () => {
  const sources = makeSources();

  // 单片中间删除 => 左右两段（左保留 fadeIn、右保留 fadeOut）
  const one = u.rippleDeleteSelection([makeClip('c1', 's1', 0, 120, 2, 3)], 's1', 30, 60);
  assert.strictEqual(one.ok, true);
  assert.strictEqual(one.clips.length, 2);
  assert.deepStrictEqual([one.clips[0].in, one.clips[0].out, one.clips[0].fadeIn, one.clips[0].fadeOut], [0, 30, 2, 0]);
  assert.deepStrictEqual([one.clips[1].in, one.clips[1].out, one.clips[1].fadeIn, one.clips[1].fadeOut], [60, 120, 0, 3]);
  assert.strictEqual(one.removed, 30);

  // 边缘删除只保留一侧
  const edge = u.rippleDeleteSelection([makeClip('c1', 's1', 0, 60, 1, 1)], 's1', 0, 20);
  assert.strictEqual(edge.clips.length, 1);
  assert.strictEqual(edge.clips[0].in, 20);
  assert.strictEqual(edge.clips[0].fadeIn, 0);

  // 同源多片 + 其它源片段按原顺序保留
  const multi = u.rippleDeleteSelection(
    [makeClip('a1', 's1', 0, 30), makeClip('a2', 's1', 30, 60, 1, 2), makeClip('b1', 's2', 0, 20)],
    's1',
    20,
    40
  );
  assert.deepStrictEqual(
    multi.clips.map((c) => [c.id, c.in, c.out, c.sourceId]),
    [
      ['a1', 0, 20, 's1'],
      ['a2_r1', 40, 60, 's1'],
      ['b1', 0, 20, 's2'],
    ]
  );
  assert.strictEqual(multi.clips[1].fadeIn, 0);
  assert.strictEqual(multi.clips[1].fadeOut, 2);
  assert.strictEqual(multi.removed, 10 + 10);

  // 删除全部 => 报错
  const all = u.rippleDeleteSelection([makeClip('c1', 's1', 0, 10)], 's1', 0, 10);
  assert.strictEqual(all.ok, false);
  assert.strictEqual(all.clips.length, 0);

  // 两端残片都 <0.2s => 丢弃后无可导出片段
  const tiny = u.rippleDeleteSelection([makeClip('c1', 's1', 0, 10)], 's1', 0.05, 9.95);
  assert.strictEqual(tiny.ok, false);
  assert.strictEqual(tiny.dropped, 2);

  // 有效性交叉校验：同一份数据（没删除的部分）总时长符合预期
  assert.strictEqual(u.planDuration(multi.clips), 60);
  assert.strictEqual(u.validateClips(multi.clips, sources).ok, true);
});

test('effectiveClipFades：每片段独立，fadeIn+fadeOut>片段时长时等比缩短', () => {
  const f1 = u.effectiveClipFades(makeClip('c', 's1', 0, 10, 1, 2));
  assert.deepStrictEqual(f1, { fadeIn: 1, fadeOut: 2, adjusted: false });

  const f2 = u.effectiveClipFades(makeClip('c', 's1', 0, 2, 3, 3));
  assert.strictEqual(f2.adjusted, true);
  assert.ok(f2.fadeIn + f2.fadeOut <= 2.0001, '缩短后总和不超片段时长');
  assert.ok(f2.fadeIn > 0 && f2.fadeOut > 0);

  const capped = u.resolveFades(6, 0, 10);
  assert.strictEqual(capped.fadeIn, 5, '单值按 5s 封顶（与后端一致）');
});

test('buildPreviewQueue：跨源顺序、offset、每片归一后 fade', () => {
  const sources = makeSources();
  const clips = [
    makeClip('c1', 's1', 0, 30, 1, 0),
    makeClip('c2', 's2', 10, 40, 0, 2),
    makeClip('c3', 's1', 0, 10, 0, 0),
  ];
  const built = u.buildPreviewQueue(clips, sources);
  assert.strictEqual(built.ok, true);
  assert.strictEqual(built.total, 70);
  assert.deepStrictEqual(built.queue.map((q) => [q.clipIndex, q.sourceId, q.offset]), [
    [0, 's1', 0],
    [1, 's2', 30],
    [2, 's1', 60],
  ]);
  assert.strictEqual(built.queue[0].localPath, 'wxfile://tmp/a.mp3');
  assert.strictEqual(built.queue[1].localPath, 'wxfile://tmp/b.wav');
  assert.strictEqual(built.queue[0].fadeIn, 1);
  assert.strictEqual(built.queue[1].fadeOut, 2);

  const single = u.buildPreviewQueue(clips, sources, { clipIndex: 1 });
  assert.strictEqual(single.queue.length, 1);
  assert.strictEqual(single.queue[0].offset, 0);
  assert.strictEqual(u.buildPreviewQueue(clips, [sources[0]], {}).ok, false, '缺源应报错');
});

test('buildRenderRequest：只带被引用源、sourceIndex 重排、fade 归一', () => {
  const sources = makeSources();
  const clips = [
    makeClip('c1', 's2', 0, 2, 3, 3), // 2s 片段，3+3 归一为 1+1
    makeClip('c2', 's1', 0, 10, 0, 0),
    makeClip('c3', 's2', 10, 20, 0, 1),
  ];
  const built = u.buildRenderRequest(clips, sources, { volumeDb: -3, format: 'mp3', bitrate: '192k' });
  assert.strictEqual(built.ok, true);
  assert.deepStrictEqual(built.request.sources.map((s) => s.fileName), ['b.wav', 'a.mp3']);
  assert.deepStrictEqual(built.request.clips.map((c) => c.sourceIndex), [0, 1, 0]);
  assert.deepStrictEqual(
    [built.request.clips[0].fadeIn, built.request.clips[0].fadeOut],
    [1, 1],
    'fade 归一后写入请求'
  );
  assert.strictEqual(built.request.volumeDb, -3);
  assert.strictEqual(built.request.format, 'mp3');
  assert.strictEqual(built.request.bitrate, '192k');
  assert.strictEqual(built.request.sources.length, 2);
  assert.strictEqual(built.request.sources[0].fileID, 'cloud://test/b.wav');

  assert.strictEqual(u.buildRenderRequest([], sources).ok, false);
});

test('getUnplayableSources / toClipViews / queueOutputPosition', () => {
  const sources = makeSources();
  sources[1].playable = false;
  const clips = [makeClip('c1', 's1', 0, 30, 1, 0.5), makeClip('c2', 's2', 0, 10), makeClip('c3', 's2', 10, 20)];
  const unplayable = u.getUnplayableSources(clips, sources);
  assert.strictEqual(unplayable.length, 1);
  assert.strictEqual(unplayable[0].name, 'b.wav');

  const views = u.toClipViews(clips, sources);
  assert.strictEqual(views[0].sourceName, 'a.mp3');
  assert.strictEqual(views[0].durationText, '00:30.0');
  assert.strictEqual(views[0].fadeLabel, '淡入1s / 淡出0.5s');
  assert.strictEqual(views[0].hasFade, true);
  assert.strictEqual(views[1].fadeLabel, '');
  assert.strictEqual(views[1].hasFade, false);

  const queue = u.buildPreviewQueue(clips, sources).queue;
  // 片段 c2 = s2 0..10，offset 30：源时间 5 => 30 + 5
  assert.strictEqual(u.queueOutputPosition(queue, 1, 5), 35);
  // 片段 c3 = s2 10..20，offset 40：源时间 18 => 40 + 8
  assert.strictEqual(u.queueOutputPosition(queue, 2, 18), 48);
});

test('peaks base64 解码与 Buffer 一致、parsePeaks', () => {
  const bytes = [];
  for (let i = 0; i < 256; i++) bytes.push(i);
  const b64 = Buffer.from(bytes).toString('base64');
  assert.deepStrictEqual(Array.from(u.decodeBase64ToUint8(b64)), bytes);
  assert.strictEqual(u.decodeBase64ToUint8('').length, 0);
  assert.strictEqual(u.decodeBase64ToUint8(null).length, 0);
  const parsed = u.parsePeaks({ peaks: { peak: Buffer.from([1, 2, 3]).toString('base64'), rms: '' } });
  assert.deepStrictEqual(Array.from(parsed.peak), [1, 2, 3]);
  assert.strictEqual(parsed.rms.length, 0);
});

test('播放可用性：iPhone + playableIos=false 时禁用预览', () => {
  assert.strictEqual(u.resolvePreviewPlayable({ playableIos: false, playableAndroid: true }, 'ios'), false);
  assert.strictEqual(u.resolvePreviewPlayable({ playableIos: true, playableAndroid: true }, 'ios'), true);
  assert.strictEqual(u.resolvePreviewPlayable({ playableIos: false, playableAndroid: true }, 'android'), true);
  assert.strictEqual(u.resolvePreviewPlayable({ playableIos: false, playableAndroid: false }, 'devtools'), true);
});

test('snapTime / round3 / 复制不修改入参', () => {
  assert.strictEqual(u.snapTime(12.34, 0.1), 12.3);
  assert.strictEqual(u.snapTime(12.36, 0.1), 12.4);
  assert.strictEqual(u.round3(1.23456), 1.235);
  const clips = [makeClip('c1', 's1', 0, 10, 1, 0)];
  const moved = u.moveClip(clips, 0, 0).clips;
  moved[0].in = 999;
  assert.strictEqual(clips[0].in, 0, 'moveClip 不应修改入参');
});

/* ========================================================================== */
/* 2. WXML / WXSS / JSON 静态检查                                             */
/* ========================================================================== */

function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

function collectWxmlHandlerNames(wxmlText) {
  const re = /(?:bind|catch|capture-bind|capture-catch)[a-z-]*="([A-Za-z_$][\w$]*)"/g;
  const names = new Set();
  let match;
  while ((match = re.exec(wxmlText))) names.add(match[1]);
  return Array.from(names);
}

test('editor.json 可解析且标题为「音乐剪辑」', () => {
  const json = JSON.parse(read(JSON_PATH));
  assert.strictEqual(json.navigationBarTitleText, '音乐剪辑');
  assert.strictEqual(typeof json.usingComponents, 'object');
});

test('editor.wxml 标签配对（view/block/canvas/button/scroll-view…）', () => {
  const text = stripComments(read(WXML_PATH));
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const stack = [];
  let match;
  while ((match = tagRe.exec(text))) {
    const closing = match[1] === '/';
    const name = match[2];
    const selfClosing = match[4] === '/';
    if (closing) {
      const top = stack.pop();
      assert.strictEqual(top, name, `标签不匹配：期望 </${top}>，实际 </${name}>（pos ${match.index}）`);
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  assert.deepStrictEqual(stack, [], '存在未闭合标签：' + stack.join(', '));
});

test('editor.wxml 事件处理函数都存在于 editor.js', () => {
  const wxmlText = stripComments(read(WXML_PATH));
  const jsText = read(JS_PATH);
  const names = collectWxmlHandlerNames(wxmlText);
  assert.ok(names.length >= 20, '事件绑定数量异常：' + names.length);
  names.forEach((name) => {
    const methodRe = new RegExp('(^|[\\s,{])' + name.replace(/\$/g, '\\$') + '\\s*\\(');
    assert.ok(methodRe.test(jsText), '处理函数缺失：' + name);
  });
});

test('editor.wxml 中 wx:for 均带 wx:key', () => {
  const wxmlText = stripComments(read(WXML_PATH));
  const loops = wxmlText.match(/wx:for="/g) || [];
  const keys = wxmlText.match(/wx:key=/g) || [];
  assert.ok(loops.length >= 3, 'wx:for 数量异常：' + loops.length);
  assert.strictEqual(keys.length, loops.length, `wx:for ${loops.length} 个，wx:key ${keys.length} 个`);
});

test('editor.wxss 花括号配对', () => {
  const text = read(WXSS_PATH).replace(/\/\*[\s\S]*?\*\//g, '');
  const open = (text.match(/{/g) || []).length;
  const close = (text.match(/}/g) || []).length;
  assert.strictEqual(open, close, `{ ${open} 个，} ${close} 个`);
});

test('page 数据字段覆盖 v2 关键状态（sources/clips/selectedClipIndex/…）', () => {
  const jsText = read(JS_PATH);
  ['sources', 'clips', 'selectedClipIndex', 'selectedClip', 'clipCount', 'fadeIn', 'fadeOut', 'volumeDb', 'canPreviewAll', 'exportDisabled', 'importFailures', 'result'].forEach((key) => {
    assert.ok(new RegExp('\\b' + key + ':').test(jsText), '缺少 data 字段：' + key);
  });
  assert.ok(jsText.indexOf("action: 'renderEdit'") >= 0, '导出应调用 renderEdit');
  assert.ok(jsText.indexOf('sources:') >= 0 && jsText.indexOf('clips:') >= 0, '导出请求应包含 sources/clips');
});

/* ========================================================================== */
/* 3. 页面冒烟（stub wx / Page，串行执行）                                     */
/* ========================================================================== */

function createFakeCtx() {
  const noop = () => {};
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    clearRect: noop,
    fillRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
    fillText: noop,
    scale: noop,
    save: noop,
    restore: noop,
  };
}

function createAudioMock() {
  const handlers = {};
  return {
    src: '',
    volume: 1,
    startTime: 0,
    playbackRate: 1,
    currentTime: 0,
    duration: 0,
    playing: false,
    destroyed: false,
    onCanplay(fn) { handlers.canplay = fn; },
    onTimeUpdate(fn) { handlers.timeupdate = fn; },
    onEnded(fn) { handlers.ended = fn; },
    onError(fn) { handlers.error = fn; },
    onPlay(fn) { handlers.play = fn; },
    onPause(fn) { handlers.pause = fn; },
    onStop(fn) { handlers.stop = fn; },
    play() { this.playing = true; if (handlers.play) handlers.play(); },
    pause() { this.playing = false; if (handlers.pause) handlers.pause(); },
    stop() { this.playing = false; this.currentTime = 0; if (handlers.stop) handlers.stop(); },
    seek(time) { this.currentTime = Number(time) || 0; },
    destroy() { this.destroyed = true; },
    _handlers: handlers,
  };
}

function makeAnalyzeResponse(overrides) {
  const opts = Object.assign({ duration: 120, playableIos: true, playableAndroid: true }, overrides || {});
  const duration = Number(opts.duration);
  const buckets = Math.max(1, Math.ceil((duration * 1000) / 50));
  const peak = Buffer.alloc(buckets);
  for (let i = 0; i < buckets; i++) peak[i] = (i * 13) % 256;
  return {
    success: true,
    data: {
      duration,
      format: opts.format || 'mp3',
      sampleRate: 44100,
      channels: 2,
      bucketMs: 50,
      buckets,
      peaks: { peak: peak.toString('base64'), rms: '' },
      playableIos: opts.playableIos,
      playableAndroid: opts.playableAndroid,
    },
  };
}

function makeRenderResponse(request) {
  const clips = (request && request.clips) || [];
  const total = clips.reduce((sum, clip) => sum + (clip.out - clip.in), 0);
  return {
    success: true,
    data: {
      fileID: 'cloud://test.edited/edited_audios/out.mp3',
      fileName: 'mix_剪辑.mp3',
      size: 2411724,
      duration: Math.round(total * 1000) / 1000,
      costMs: 4200,
    },
  };
}

/**
 * wx stub：可配置多批 chooseMessageFile、多个 analyze 返回值、render 返回值。
 */
function createWxStub(options) {
  const opts = options || {};
  const state = {
    platform: opts.platform || 'ios',
    analyzeResults: (opts.analyzeResults || []).slice(),
    renderResult: opts.renderResult || null,
  };
  const calls = {
    upload: [],
    analyze: [],
    render: [],
    download: [],
    share: [],
    modal: [],
    toast: [],
    getTempFileURL: [],
    chooseFile: [],
  };
  const audioInstances = [];
  const fakeCtx = createFakeCtx();
  const fakeCanvas = { width: 0, height: 0, getContext() { return fakeCtx; } };
  const batches = opts.chooseBatches || [[{ path: 'wxfile://tmp/a.mp3', name: 'a.mp3', size: 1024 * 1024 }]];
  let chooseIndex = 0;

  const wxStub = {
    createInnerAudioContext() {
      const audio = createAudioMock();
      audioInstances.push(audio);
      return audio;
    },
    createSelectorQuery() {
      const chain = {
        select() { return chain; },
        fields() { return chain; },
        boundingClientRect() { return chain; },
        exec(cb) {
          cb([
            { node: fakeCanvas, width: 340, height: 130 },
            { left: 0, top: 100, width: 340, height: 130 },
          ]);
        },
      };
      return chain;
    },
    getWindowInfo() {
      return { pixelRatio: 2, platform: state.platform, windowWidth: 375, windowHeight: 667 };
    },
    getDeviceInfo() { return { platform: state.platform }; },
    getSystemInfoSync() {
      return { pixelRatio: 2, platform: state.platform, windowWidth: 375, windowHeight: 667 };
    },
    storage: (opts && opts.storage) ? Object.assign({}, opts.storage) : {},
    getStorageSync(key) { return wxStub.storage[key]; },
    setStorage(payload) {
      if (payload && payload.key) wxStub.storage[payload.key] = payload.data;
      if (payload && payload.success) payload.success();
    },
    removeStorageSync(key) { delete wxStub.storage[key]; },
    enableAlertBeforeUnload(payload) { calls.alert = payload; },
    disableAlertBeforeUnload() { calls.alert = null; },
    onAudioInterruptionBegin(cb) { state.interruptionBeginCb = cb; },
    onAudioInterruptionEnd(cb) { state.interruptionEndCb = cb; },
    offAudioInterruptionBegin() { state.interruptionBeginCb = null; },
    offAudioInterruptionEnd() { state.interruptionEndCb = null; },
    nextTick(fn) { setTimeout(fn, 0); },
    setInnerAudioOption() {},
    onWindowResize() {},
    offWindowResize() {},
    onNeedPrivacyAuthorization() {},
    offNeedPrivacyAuthorization() {},
    openPrivacyContract() {},
    showLoading() {},
    hideLoading() {},
    showToast(payload) { calls.toast.push(payload); },
    navigateTo(payload) { (calls.navigateTo = calls.navigateTo || []).push(payload); },
    redirectTo(payload) { (calls.redirectTo = calls.redirectTo || []).push(payload); },
    showModal(payload) {
      calls.modal.push(payload);
      if (opts.modalConfirm !== undefined && payload.success) {
        payload.success({ confirm: Boolean(opts.modalConfirm), cancel: !opts.modalConfirm });
      }
    },
    chooseMessageFile(payload) {
      calls.chooseFile.push(payload);
      if (opts.chooseFail) {
        if (payload.fail) payload.fail(opts.chooseFail);
        return;
      }
      const files = batches[Math.min(chooseIndex, batches.length - 1)] || [];
      chooseIndex++;
      if (payload.success) payload.success({ tempFiles: files });
    },
    getFileSystemManager() {
      if (opts.fileSystemManager) return opts.fileSystemManager;
      return {
        statSync() { return { size: 1024 * 1024 }; },
      };
    },
    shareFileMessage(payload) {
      calls.share.push(payload);
      if (payload.success) payload.success();
    },
    cloud: {
      uploadFile(payload) {
        calls.upload.push(payload);
        if (typeof opts.uploadFile === 'function') {
          return opts.uploadFile(payload);
        }
        return Promise.resolve({ fileID: 'cloud://test.edit/' + payload.cloudPath });
      },
      callFunction(payload) {
        if (typeof opts.cloudCallFunction === 'function') {
          return opts.cloudCallFunction(payload);
        }
        const data = payload.data || {};
        if (data.action === 'analyzeAudio') {
          calls.analyze.push(data);
          const result = state.analyzeResults.length ? state.analyzeResults.shift() : makeAnalyzeResponse({});
          return Promise.resolve({ result: result });
        }
        if (data.action === 'renderEdit') {
          calls.render.push(data);
          return Promise.resolve({ result: state.renderResult || makeRenderResponse(data) });
        }
        return Promise.resolve({ result: { success: false, errorMessage: 'unsupported action' } });
      },
      downloadFile(payload) {
        calls.download.push(payload);
        if (opts.downloadFail) return Promise.reject(new Error('mock download fail'));
        return Promise.resolve({ tempFilePath: 'wxfile://tmp/result.mp3' });
      },
      getTempFileURL(payload) {
        calls.getTempFileURL.push(payload);
        return Promise.resolve({
          fileList: [{ fileID: payload.fileList[0], tempFileURL: 'https://example.com/result.mp3', status: 0 }],
        });
      },
    },
  };

  return { wx: wxStub, calls, audioInstances, state, fakeCanvas };
}

function loadEditorPage(wxStub) {
  global.wx = wxStub;
  let captured = null;
  global.Page = (config) => {
    captured = config;
  };
  delete require.cache[require.resolve(JS_PATH)];
  require(JS_PATH);
  assert.ok(captured, 'editor.js 没有调用 Page()');
  const page = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data));
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (typeof callback === 'function') callback();
  };
  return page;
}

async function withSilencedConsoleError(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.error = original;
  }
}

smokeTest('页面冒烟：多源导入→分割/排序/ripple 删除/裁剪→每段淡入淡出→跨源预览→v2 导出→转发→切 tab', async () => {
  const fileA = { path: 'wxfile://tmp/a.mp3', name: 'a.mp3', size: 1 * 1024 * 1024 };
  const fileB = { path: 'wxfile://tmp/b.wav', name: 'b.wav', size: 2 * 1024 * 1024 };
  const stub = createWxStub({
    chooseBatches: [[fileA, fileB]],
    analyzeResults: [makeAnalyzeResponse({ duration: 120 }), makeAnalyzeResponse({ duration: 60, format: 'wav' })],
  });
  const page = loadEditorPage(stub.wx);

  page.onLoad();
  page.onShow();
  await wait(10);
  assert.strictEqual(page.data.status, 'empty');
  assert.ok(page.sourceAudio && page.resultAudio, 'onLoad 应创建两个播放实例');

  // —— 多选导入两个文件：逐个上传/分析 → 2 源 2 片段 ——
  page.chooseAudioFiles();
  assert.strictEqual(page.data.status, 'uploading');
  assert.strictEqual(stub.calls.chooseFile[0].count, 5, 'chooseMessageFile count 应为剩余可加数');
  await wait(80);
  assert.strictEqual(page.data.status, 'editing');
  assert.strictEqual(page.sources.length, 2);
  assert.strictEqual(page.clips.length, 2);
  assert.strictEqual(page.data.clipCount, 2);
  assert.strictEqual(page.data.sourceCount, 2);
  assert.strictEqual(page.data.planDurationText, '03:00');
  assert.strictEqual(page.data.selectedClipIndex, 0);
  assert.strictEqual(page.data.selectedSource.name, 'a.mp3');
  assert.strictEqual(stub.calls.analyze.length, 2);
  assert.ok(page.waveCtx, '编辑态应初始化 Canvas 2D');

  // —— 选中第二段：波形切到 b.wav 源 ——
  page.onClipTap({ currentTarget: { dataset: { index: 1 } } });
  assert.strictEqual(page.data.selectedClipIndex, 1);
  assert.strictEqual(page.data.selectedSource.name, 'b.wav');
  assert.strictEqual(page.data.totalDurationText, '01:00');
  assert.strictEqual(page.waveDuration, 60);

  // —— 在播放头分割 b 片段（30s）——
  page.currentSourceTime = 30;
  page.splitSelectedClipAtPlayhead();
  assert.strictEqual(page.clips.length, 3);
  assert.strictEqual(page.data.selectedClipIndex, 2);
  assert.strictEqual(page.clips[1].in, 0);
  assert.strictEqual(page.clips[1].out, 30);
  assert.strictEqual(page.clips[2].in, 30);
  assert.strictEqual(page.clips[2].out, 60);

  // —— 上移 / 下移 ——
  page.moveClipUp();
  assert.deepStrictEqual(page.clips.map((c) => c.in), [0, 30, 0]);
  assert.strictEqual(page.data.selectedClipIndex, 1);
  page.moveClipDown();
  assert.deepStrictEqual(page.clips.map((c) => c.in), [0, 0, 30]);
  assert.strictEqual(page.data.selectedClipIndex, 2);

  // —— 每片段淡入淡出 ——
  page.onClipFadeInTap({ currentTarget: { dataset: { value: 1 } } });
  page.onClipFadeOutTap({ currentTarget: { dataset: { value: 2 } } });
  assert.strictEqual(page.clips[2].fadeIn, 1);
  assert.strictEqual(page.clips[2].fadeOut, 2);
  assert.strictEqual(page.data.fadeIn, 1);
  assert.strictEqual(page.data.fadeOut, 2);
  assert.ok(String(page.data.clips[2].fadeLabel).indexOf('淡入1s') >= 0);

  // —— 跨源预览：播放全部 → 第二段自动切源 ——
  page.selectClip(0);
  page.togglePlayAll();
  await wait(5);
  assert.strictEqual(page.data.isPlaying, true);
  assert.strictEqual(page.data.playMode, 'all');
  assert.strictEqual(page.playback.queue.length, 3);
  const audio = page.sourceAudio;
  assert.strictEqual(audio.src, 'wxfile://tmp/a.mp3');
  audio._handlers.canplay();
  await wait(5);
  assert.strictEqual(audio.playing, true);
  audio.currentTime = 119.99;
  audio._handlers.timeupdate();
  await wait(90);
  assert.strictEqual(page.playback.index, 1, '应切到第二段');
  assert.strictEqual(page.data.selectedClipIndex, 1, '播放时波形应跟随到当前片段');
  assert.strictEqual(audio.src, 'wxfile://tmp/b.wav', '跨源应切换 InnerAudioContext.src');
  page.stopPlayback();
  assert.strictEqual(page.data.isPlaying, false);

  // —— 选段 + ripple 删除（同源片段一起切）——
  page.selectClip(0);
  page.setSelection(30, 60);
  page.rippleDeleteSelection();
  assert.strictEqual(page.clips.length, 4);
  assert.strictEqual(page.data.planDurationText, '02:30');
  assert.strictEqual(page.data.hasSelection, false);

  // —— 撤销 ——
  page.undo();
  assert.strictEqual(page.clips.length, 3);
  assert.strictEqual(page.data.planDurationText, '03:00');

  // —— 裁剪到选区 + 重置片段 ——
  page.selectClip(0);
  page.setSelection(10, 20);
  page.cropSelectedClipToSelection();
  assert.deepStrictEqual([page.clips[0].in, page.clips[0].out], [10, 20]);
  assert.strictEqual(page.data.planDurationText, '01:10');
  page.resetSelectedClip();
  assert.deepStrictEqual([page.clips[0].in, page.clips[0].out], [0, 120]);
  assert.strictEqual(page.data.planDurationText, '03:00');

  // —— 全局音量 + 导出（v2 请求）——
  page.onVolumeChange({ detail: { value: -3 } });
  assert.strictEqual(page.data.volumeDb, -3);
  page.startExport();
  assert.strictEqual(page.data.status, 'exporting');
  assert.strictEqual(page.exporting, true, '导出中应有防重入标记');
  await wait(60);
  assert.strictEqual(page.data.status, 'result');
  assert.strictEqual(page.data.result.clipCount, 3);
  assert.strictEqual(page.data.result.durationText, '03:00');
  assert.strictEqual(page.data.result.sizeText, '2.3 MB');

  const renderCall = stub.calls.render[0];
  assert.strictEqual(renderCall.action, 'renderEdit');
  assert.strictEqual(renderCall.sources.length, 2);
  assert.strictEqual(renderCall.clips.length, 3);
  assert.deepStrictEqual(renderCall.clips.map((c) => c.sourceIndex), [0, 1, 1]);
  assert.strictEqual(renderCall.clips[2].fadeIn, 1);
  assert.strictEqual(renderCall.clips[2].fadeOut, 2);
  assert.strictEqual(renderCall.volumeDb, -3);
  assert.strictEqual(renderCall.format, 'mp3');
  assert.strictEqual(renderCall.bitrate, '192k');
  assert.ok(renderCall.sources[0].fileID.indexOf('cloud://') === 0);
  assert.strictEqual(renderCall.sources[0].fileName, 'a.mp3');

  // —— 结果：预下载 + 手势内转发 ——
  page.resultTempFilePath = '';
  page.shareResult();
  assert.strictEqual(stub.calls.share.length, 0, '未缓存时不应调用 shareFileMessage');
  assert.ok(stub.calls.toast.some((t) => String(t.title || '').indexOf('文件准备中') >= 0));
  await wait(40);
  assert.strictEqual(page.data.resultTempReady, true);
  page.shareResult();
  assert.strictEqual(stub.calls.share.length, 1);
  assert.strictEqual(stub.calls.share[0].fileName, 'mix_剪辑.mp3');

  // —— 切 tab：状态保留、播放实例销毁/重建 ——
  page.onHide();
  assert.strictEqual(page.data.status, 'result');
  assert.strictEqual(page.sourceAudio, null);
  assert.strictEqual(page.resultAudio, null);
  page.onShow();
  await wait(20);
  assert.ok(page.sourceAudio && page.resultAudio);

  // —— 继续编辑：canvas 重新挂载 ——
  page.reEdit();
  await wait(20);
  assert.strictEqual(page.data.status, 'editing');
  assert.ok(page.waveCtx, '继续编辑后应重新初始化 canvas');
  page.onUnload();
});

smokeTest('部分导入失败：保留成功片段并提示，重试只补失败文件', async () => {
  const fileA = { path: 'wxfile://tmp/a.mp3', name: 'a.mp3', size: 1024 * 1024 };
  const fileB = { path: 'wxfile://tmp/b.mp3', name: 'b.mp3', size: 1024 * 1024 };
  const stub = createWxStub({
    chooseBatches: [[fileA, fileB]],
    analyzeResults: [
      makeAnalyzeResponse({ duration: 60 }),
      { success: false, code: 'INVALID_FILE', errorMessage: '文件里没有可用的音轨' },
    ],
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.onShow();
  page.chooseAudioFiles();
  await withSilencedConsoleError(async () => wait(80));

  assert.strictEqual(page.data.status, 'editing');
  assert.strictEqual(page.sources.length, 1);
  assert.strictEqual(page.clips.length, 1);
  assert.strictEqual(page.data.importFailures.length, 1);
  assert.strictEqual(page.data.importFailureNames, 'b.mp3');

  stub.state.analyzeResults = [makeAnalyzeResponse({ duration: 45 })];
  page.retryFailedImports();
  await wait(80);
  assert.strictEqual(page.sources.length, 2);
  assert.strictEqual(page.clips.length, 2);
  assert.strictEqual(page.data.importFailures.length, 0);
  assert.strictEqual(stub.calls.chooseFile.length, 1, '重试不应重新打开文件选择器');
  assert.strictEqual(stub.calls.upload.length, 3, '失败的 b 重传一次，a 不重复上传');
  page.onUnload();
});

smokeTest('全部导入失败（超 10 分钟）：可重试错误态；iPhone 不可试听源禁用预览', async () => {
  const stub = createWxStub({
    chooseBatches: [[{ path: 'wxfile://tmp/long.mp3', name: 'long.mp3', size: 1024 * 1024 }]],
    analyzeResults: [
      { success: false, code: 'DURATION_TOO_LONG', errorMessage: 'too long' },
      makeAnalyzeResponse({ duration: 60, playableIos: false }),
      makeAnalyzeResponse({ duration: 30, playableIos: true }),
    ],
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.onShow();
  await withSilencedConsoleError(async () => {
    page.chooseAudioFiles();
    await wait(60);
  });
  assert.strictEqual(page.data.status, 'empty');
  assert.ok(String(page.data.loadError).indexOf('10 分钟') >= 0);
  assert.strictEqual(page.sources.length, 0);

  // 重试：先成功导入一个 iPhone 不可试听的源，再加一个可试听源
  page.retryFailedImports();
  await wait(60);
  assert.strictEqual(page.data.status, 'editing');
  assert.strictEqual(page.data.canPreviewAll, false);
  assert.strictEqual(page.data.canPreviewClip, false);
  assert.ok(String(page.data.previewBanner).indexOf('iPhone') >= 0, '应给出 iPhone 文案');

  page.chooseAudioFiles();
  await wait(80);
  assert.strictEqual(page.sources.length, 2);
  assert.strictEqual(page.data.canPreviewAll, false, '仍有不可试听源时不能播放全部');
  page.selectClip(1);
  assert.strictEqual(page.data.canPreviewClip, true, '选中可试听源可单独试听');
  page.togglePlayAll();
  assert.ok(stub.calls.modal.some((m) => m.title === '当前设备无法试听'));
  assert.strictEqual(page.data.isPlaying, false);
  page.onUnload();
});

smokeTest('源数量上限（5 个）与 >50MB 本地预检', async () => {
  const files = [];
  for (let i = 0; i < 6; i++) {
    files.push({ path: 'wxfile://tmp/' + i + '.mp3', name: i + '.mp3', size: 1024 * 1024 });
  }
  const stub = createWxStub({
    chooseBatches: [files],
    analyzeResults: [
      makeAnalyzeResponse({ duration: 10 }),
      makeAnalyzeResponse({ duration: 10 }),
      makeAnalyzeResponse({ duration: 10 }),
      makeAnalyzeResponse({ duration: 10 }),
      makeAnalyzeResponse({ duration: 10 }),
    ],
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.onShow();
  page.chooseAudioFiles();
  await wait(100);
  assert.strictEqual(page.sources.length, 5);
  assert.strictEqual(page.clips.length, 5);
  assert.strictEqual(page.data.importFailures.length, 1, '第 6 个文件应提示超上限');
  page.onUnload();

  const stub2 = createWxStub({
    chooseBatches: [[{ path: 'wxfile://tmp/big.mp3', name: 'big.mp3', size: 51 * 1024 * 1024 }]],
  });
  const page2 = loadEditorPage(stub2.wx);
  page2.onLoad();
  page2.onShow();
  page2.chooseAudioFiles();
  await wait(10);
  assert.strictEqual(page2.data.status, 'empty');
  assert.strictEqual(stub2.calls.upload.length, 0);
  assert.ok(String(page2.data.loadError).indexOf('50MB') >= 0, '超 50MB 应在空态给出可操作文案');
  assert.strictEqual(page2.data.importFailures.length, 1);
  page2.onUnload();
});

smokeTest('导出失败：回到编辑态并重新初始化 canvas，给出可操作文案', async () => {
  const stub = createWxStub({
    chooseBatches: [[{ path: 'wxfile://tmp/a.mp3', name: 'a.mp3', size: 1024 * 1024 }]],
    analyzeResults: [makeAnalyzeResponse({ duration: 60 })],
    renderResult: { success: false, code: 'TIMEOUT', errorMessage: '云端渲染超时' },
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.onShow();
  page.chooseAudioFiles();
  await wait(80);
  assert.strictEqual(page.data.status, 'editing');

  await withSilencedConsoleError(async () => {
    page.startExport();
    await wait(60);
  });
  assert.strictEqual(page.data.status, 'editing');
  assert.strictEqual(page.exporting, false);
  assert.ok(stub.calls.modal.some((m) => m.title === '导出失败'));
  assert.ok(page.waveCtx, '失败回到编辑态后 canvas 应重新初始化');
  page.onUnload();
});

smokeTest('手机触控拖动裁剪与单色图标：拖拽入点/出点把手完成交互裁剪', async () => {
  const stub = createWxStub({
    chooseBatches: [[{ path: 'wxfile://tmp/test.mp3', name: 'test.mp3', size: 1024 * 1024 }]],
    analyzeResults: [makeAnalyzeResponse({ duration: 60 })],
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.onShow();
  page.chooseAudioFiles();
  await wait(80);
  assert.strictEqual(page.data.status, 'editing');
  assert.ok(page.data.monoIcons, 'monoIcons 字典应存在');
  assert.ok(page.data.monoIcons.split, '剪裁单色图标应存在');
  assert.ok(page.data.monoIcons.trash, '删除单色图标应存在');

  // 验证入点拖动裁剪 (Trim In)
  const initialIn = page.clips[0].in;
  page.onTrimInTouchStart({ touches: [{ clientX: 100 }] });
  page.onTrimInTouchMove({ touches: [{ clientX: 180 }] });
  assert.strictEqual(page.data.isTrimmingClip, true);
  assert.strictEqual(page.data.trimType, 'in');
  assert.ok(page.data.trimTipText.indexOf('入点') >= 0);
  page.onTrimInTouchEnd({});
  assert.strictEqual(page.data.isTrimmingClip, false);
  assert.ok(page.clips[0].in > initialIn, '拖动把手后入点应增加');

  // 验证出点拖动裁剪 (Trim Out)
  const initialOut = page.clips[0].out;
  page.onTrimOutTouchStart({ touches: [{ clientX: 300 }] });
  page.onTrimOutTouchMove({ touches: [{ clientX: 220 }] });
  assert.strictEqual(page.data.isTrimmingClip, true);
  assert.strictEqual(page.data.trimType, 'out');
  assert.ok(page.data.trimTipText.indexOf('出点') >= 0);
  page.onTrimOutTouchEnd({});
  assert.strictEqual(page.data.isTrimmingClip, false);
  assert.ok(page.clips[0].out < initialOut, '向左拖动把手后出点应减小');

  // 验证双行顶部工具条缩放比率
  page.zoomIn();
  assert.ok(page.data.zoomLevelRatioText, '应维护实际缩放百分比');
  page.onUnload();
});

smokeTest('音频复制粘贴与成片压缩率大小预览：复制后粘贴到时间线 + 滑动控制压缩率实时预估大小', async () => {
  const stub = createWxStub({
    chooseBatches: [[{ path: 'wxfile://tmp/test.mp3', name: 'test.mp3', size: 1024 * 1024 }]],
    analyzeResults: [makeAnalyzeResponse({ duration: 60 })],
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.onShow();
  page.chooseAudioFiles();
  await wait(80);
  assert.strictEqual(page.clips.length, 1);

  // 1. 验证复制操作
  page.copySelectedClip();
  assert.strictEqual(page.data.hasClipboard, true, '复制后 hasClipboard 应为 true');
  assert.ok(page.clipboardClip, 'clipboardClip 应存储被复制片段');

  // 2. 验证粘贴操作
  const beforeCount = page.clips.length;
  page.pasteClip();
  assert.strictEqual(page.clips.length, beforeCount + 1, '粘贴后片段总数应 +1');
  assert.strictEqual(page.selectedClipIndex, 1, '新粘贴的片段应被自动选中');
  assert.strictEqual(page.clips[1].sourceId, page.clips[0].sourceId, '新片段应继承源属性');
  assert.notStrictEqual(page.clips[1].id, page.clips[0].id, '新片段必须分配独立全局唯一 ID');

  // 3. 验证滑块控制压缩率与文件大小实时预估
  // 切换为 64k 极小体积
  page.selectBitratePreset({ currentTarget: { dataset: { index: 0 } } });
  assert.strictEqual(page.data.exportBitrate, '64k');
  assert.strictEqual(page.data.exportBitrateIndex, 0);
  const sizeAt64k = page.data.estimatedFileSizeText;
  const ratioAt64k = Number(page.data.compressionRatioText);
  assert.ok(sizeAt64k, '应生成 64k 预估大小');
  assert.ok(ratioAt64k > 80, '64k 压缩节省率应较高');

  // 切换为 320k 最高品质
  page.selectBitratePreset({ currentTarget: { dataset: { index: 5 } } });
  assert.strictEqual(page.data.exportBitrate, '320k');
  assert.strictEqual(page.data.exportBitrateIndex, 5);
  const sizeAt320k = page.data.estimatedFileSizeText;
  assert.ok(sizeAt320k, '应生成 320k 预估大小');

  // 验证滑动条事件驱动
  page.onBitrateSliderChange({ detail: { value: 3 } });
  assert.strictEqual(page.data.exportBitrate, '192k', '滑块移动到 index=3 应切到 192k');

  // 验证压缩控制抽屉与吸底面板折叠开关
  assert.strictEqual(page.data.showCompressionPanel, false);
  page.toggleExportCompressionPanel();
  assert.strictEqual(page.data.showCompressionPanel, true);
  page.toggleExportCompressionPanel();
  assert.strictEqual(page.data.showCompressionPanel, false);

  page.onUnload();
});

smokeTest('专业剃刀工具交互升级：激光瞄准线、波形点触切割、音轨触控直切与模式切换', async () => {
  const stub = createWxStub({
    chooseBatches: [[{ path: 'wxfile://tmp/test.mp3', name: 'test.mp3', size: 1024 * 1024 }]],
    analyzeResults: [makeAnalyzeResponse({ duration: 60 })],
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.onShow();
  page.chooseAudioFiles();
  await wait(80);
  assert.strictEqual(page.clips.length, 1);
  assert.strictEqual(page.data.activeTool, 'select');

  // 1. 验证剃刀模式切换与再次点击自动切回选择模式 (Toggle)
  page.setToolRazor();
  assert.strictEqual(page.data.activeTool, 'razor', '点击剃刀按钮后应进入 razor 模式');
  page.setToolRazor();
  assert.strictEqual(page.data.activeTool, 'select', '再次点击剃刀按钮应退出并切回 select 模式');
  page.setToolRazor();
  assert.strictEqual(page.data.activeTool, 'razor');

  // 2. 验证波形 Canvas 激光线瞄准与拖拽切割 (Laser Guide & Waveform Touch-to-Cut)
  page.canvasW = 300;
  page.canvasH = 100;
  page.waveDuration = 60;
  page.canvasLeft = 0;

  // 手指按下：触发瞄准
  page.onWaveTouchStart({ touches: [{ clientX: 150 }] });
  assert.ok(typeof page.razorTouchTime === 'number', '波形按下应记录 razorTouchTime');
  assert.strictEqual(page.gesture.mode, 'razor', '手势模式应设为 razor');

  // 手指滑动：实时追踪更新激光线
  page.onWaveTouchMove({ touches: [{ clientX: 200 }] });
  assert.ok(typeof page.razorTouchTime === 'number');

  // 手指抬起：执行精确切割
  const initialClipsCount = page.clips.length;
  page.onWaveTouchEnd({ changedTouches: [{ clientX: 200 }] });
  assert.strictEqual(page.clips.length, initialClipsCount + 1, '波形触控抬起后应成功切断片段');
  assert.strictEqual(page.razorTouchTime, null, '切割完成后应清除 razorTouchTime');
  assert.ok(page.data.justSplitIndex !== undefined, '切开后应提供 justSplit 视觉反馈状态');

  // 3. 验证多轨时间线片段触控直切 (Timeline Clip Touch-to-Cut)
  const countBeforeClipTap = page.clips.length;
  // 模拟触碰 start，不会开启拖动
  page.onClipTouchStart({ currentTarget: { dataset: { index: 0 } }, touches: [{ clientX: 50 }] });
  page.onClipTouchMove({ currentTarget: { dataset: { index: 0 } }, touches: [{ clientX: 80 }] });
  assert.strictEqual(page.data.isDraggingClip, false, '剃刀模式下点触片段绝对不应触发片段位移拖拽');

  // 模拟触碰 tap 切割
  page.onTrackClipTap({ currentTarget: { dataset: { index: 0 } }, detail: { x: 120 } });
  assert.strictEqual(page.clips.length, countBeforeClipTap + 1, '多轨片段点触后应精准切断并增加片段');

  // 4. 验证退出剃刀模式
  page.setToolSelect();
  assert.strictEqual(page.data.activeTool, 'select', '应安全切回 select 模式');

  page.onUnload();
});

smokeTest('阶段一稳定性护栏：草稿自动保存、启动一键恢复、退出拦截防误触、电话来电系统打断保护', async () => {
  const stub = createWxStub({
    chooseBatches: [[{ path: 'wxfile://tmp/test.mp3', name: 'test.mp3', size: 1024 * 1024 }]],
    analyzeResults: [makeAnalyzeResponse({ duration: 60 })],
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.onShow();
  page.chooseAudioFiles();
  await wait(80);
  assert.strictEqual(page.data.status, 'editing');

  // 1. 验证防误触退出拦截 (enableAlertBeforeUnload)
  assert.ok(stub.calls.alert, '编辑状态有片段时必须开启防误退拦截');
  assert.ok(stub.calls.alert.message.indexOf('未保存') >= 0);

  // 2. 验证草稿自动保存 (saveDraft)
  page.saveDraft();
  const draft = stub.wx.storage['NLE_DRAFT_CACHE_V1'];
  assert.ok(draft, '存储中应包含草稿快照');
  assert.strictEqual(draft.clips.length, page.clips.length);
  assert.strictEqual(draft.sources.length, page.sources.length);
  assert.ok(draft.savedAt > 0);

  // 3. 验证来电/微信语音系统打断保护 (onAudioInterruption)
  page.setData({ isPlaying: true, playMode: 'all' });
  page.handleAudioInterruptionBegin();
  assert.strictEqual(page.data.isPlaying, false, '发生系统来电打断时必须暂停播放');
  assert.strictEqual(page.data.playMode, '');

  // 4. 验证清空工程时关闭退出拦截与清除草稿
  page.resetAll();
  assert.strictEqual(stub.calls.alert, null, '清空工程后应关闭防误退拦截');
  assert.strictEqual(stub.wx.storage['NLE_DRAFT_CACHE_V1'], undefined, '清空工程后应清除本地草稿');

  page.onUnload();

  // 5. 验证启动时自动检测并恢复草稿
  const mockDraft = {
    savedAt: Date.now() - 60000,
    sources: [{ id: 'S1', name: 'my_song.mp3', duration: 120, fileID: 'cloud://test/s.mp3' }],
    clips: [{ id: 'C1', sourceId: 'S1', in: 10, out: 40, offsetSec: 0, trackId: 'T1' }],
    tracks: [{ id: 'T1', name: '音轨 1', color: '#3B82F6' }],
    planDurationText: '00:30',
    exportBitrate: '256k',
    exportBitrateIndex: 4,
  };
  const stub2 = createWxStub({
    modalConfirm: true,
    storage: {
      'NLE_DRAFT_CACHE_V1': mockDraft,
    },
  });
  const page2 = loadEditorPage(stub2.wx);
  page2.onLoad();
  await wait(20);
  assert.strictEqual(page2.data.status, 'editing', '确认恢复草稿后应直接恢复到编辑态');
  assert.strictEqual(page2.clips.length, 1);
  assert.strictEqual(page2.clips[0].in, 10);
  assert.strictEqual(page2.clips[0].out, 40);
  assert.strictEqual(page2.data.exportBitrate, '256k');
  assert.ok(stub2.calls.alert, '草稿恢复后应自动激活防误退拦截');

  page2.onUnload();
});

smokeTest('阶段二至四防御性护栏：手势互斥锁、残片智能阻尼吸附、淡变超长自适应预警与导出容灾', async () => {
  const stub = createWxStub({
    chooseBatches: [[{ path: 'wxfile://tmp/demo.mp3', name: 'demo.mp3', size: 1024 * 1024 }]],
    analyzeResults: [makeAnalyzeResponse({ duration: 60 })],
    renderResult: { success: false, code: 'NETWORK_TIMEOUT', errorMessage: '连接超时' },
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.onShow();
  page.chooseAudioFiles();
  await wait(80);
  assert.strictEqual(page.data.status, 'editing');
  assert.strictEqual(page.clips.length, 1);

  // 1. 验证多指手势互斥锁 (Multi-Touch Mutex)
  // 单指触发片段拖动
  page.onClipTouchStart({ currentTarget: { dataset: { index: 0 } }, touches: [{ clientX: 100 }] });
  page.onClipTouchMove({ currentTarget: { dataset: { index: 0 } }, touches: [{ clientX: 160 }] });
  assert.strictEqual(page.data.isDraggingClip, true, '单指位移应激活 isDraggingClip');

  // 突然双指捏合缩放（模拟第二根手指落下）
  page.onClipTouchMove({
    currentTarget: { dataset: { index: 0 } },
    touches: [{ clientX: 160, clientY: 100 }, { clientX: 240, clientY: 100 }],
  });
  assert.strictEqual(page.data.isDraggingClip, false, '检测到多指时必须立即打断并重置 isDraggingClip');
  assert.strictEqual(page._gestureLock, 'pinch', '手势互斥锁应锁定为 pinch');

  // 手指全部离开，释放互斥锁
  page.onTimelineTouchEnd({ touches: [] });
  await wait(100);
  assert.strictEqual(page._gestureLock, 'none', '手指抬起后互斥锁应自动释放');

  // 2. 验证剃刀边缘阻尼吸附护栏 (Micro-Clip Defense)
  page.setToolRazor();
  assert.strictEqual(page.data.activeTool, 'razor');
  const clip = page.clips[0]; // in: 0, out: 60
  const initialClips = page.clips.length;

  // 尝试在 0.1s 处进行微切 (<0.3s)
  page.executeRazorCutAtTime(clip, 0.1);
  assert.strictEqual(page.clips.length, initialClips, '距起点不足 0.3s 时应智能阻尼吸附，禁止切出残片');
  assert.ok(stub.calls.toast.some((t) => t.title.indexOf('不足 0.3s') >= 0), '应给出吸附友好提示');

  // 尝试在 59.85s 处进行微切 (<0.3s)
  page.executeRazorCutAtTime(clip, 59.85);
  assert.strictEqual(page.clips.length, initialClips, '距终点不足 0.3s 时应智能阻尼吸附，禁止切出残片');

  // 安全位置 (15s) 切开
  page.executeRazorCutAtTime(clip, 15);
  assert.strictEqual(page.clips.length, initialClips + 1, '正常安全距离应成功切断');
  page.setToolSelect();

  // 3. 验证淡入淡出超长等比自适应可视化 (Fade Proportional Adaptation Visuals)
  page.selectClip(0);
  // 当前第 0 段裁剪为 2 秒短片段 (0~2)
  page.clips[0].out = 2;
  // 设置淡入 2 秒，淡出 2 秒 (合计 4 秒 > 片段物理时长 2 秒)
  page.clips[0].fadeIn = 2;
  page.clips[0].fadeOut = 2;
  page.refreshClipData();

  assert.strictEqual(page.data.fadeAdjusted, true, '淡变超长时 fadeAdjusted 状态应为 true');
  assert.strictEqual(page.data.effectiveFadeInText, '1s', '2s 短片段应等比自适应为 1s 淡入');
  assert.strictEqual(page.data.effectiveFadeOutText, '1s', '2s 短片段应等比自适应为 1s 淡出');

  // 4. 验证导出复杂度预检与容错保留 (Export Pre-flight & Fault Tolerance)
  await withSilencedConsoleError(async () => {
    page.startExport();
    await wait(60);
  });
  assert.strictEqual(page.data.status, 'editing', '导出网络失败后应安全回到编辑态');
  assert.strictEqual(page.clips.length, 2, '导出失败后工程片段 100% 完整保留，严禁丢失数据');
  assert.ok(stub.calls.modal.some((m) => m.content && m.content.indexOf('完整保留') >= 0), '提示弹窗应告知用户工程已完整保留');

  page.onUnload();
});

smokeTest('轨道双指手势：向外张开放大、向内捏合缩小与片段多指转发（Pinch-to-Zoom）', async () => {
  const stub = createWxStub({
    chooseBatches: [[{ path: 'wxfile://tmp/test_song.mp3', name: 'test_song.mp3', size: 1024 * 1024 }]],
    analyzeResults: [makeAnalyzeResponse({ duration: 120 })],
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.onShow();
  page.chooseAudioFiles();
  await wait(80);
  assert.strictEqual(page.data.status, 'editing');
  assert.strictEqual(page.clips.length, 1);
  page.setData({ zoomLevel: 1.0 });

  // 1. 双指触碰轨道初始位置（间距 100px）
  page.onTimelineTouchStart({
    touches: [
      { clientX: 100, clientY: 200 },
      { clientX: 200, clientY: 200 },
    ],
  });
  assert.strictEqual(page._isPinching, true, '双指触碰应进入 pinch 状态');
  assert.strictEqual(page._pinchStartScale, 1.0, '基准缩放比例应为 1.0');
  assert.strictEqual(Math.round(page._pinchStartDist), 100, '初始双指间距应为 100px');

  // 2. 双指向外张开放大（Pinch Out: 间距由 100px 扩大至 160px，比例 1.6x）
  await wait(40);
  page.onTimelineTouchMove({
    touches: [
      { clientX: 70, clientY: 200 },
      { clientX: 230, clientY: 200 },
    ],
  });
  assert.strictEqual(page.data.zoomLevel, 1.6, '双指向外张开后音轨应放大至 1.6x (160%)');
  assert.strictEqual(page.data.isPinchingTimeline, true, '缩放期间应展示浮动反馈药丸');
  assert.ok(page.data.pinchTipText.indexOf('向外放大') >= 0, '提示文案应清晰指示向外放大');

  // 3. 双指向内捏合缩小（Pinch In: 间距由 100px 缩小至 60px，比例 0.6x）
  await wait(40);
  page.onTimelineTouchMove({
    touches: [
      { clientX: 120, clientY: 200 },
      { clientX: 180, clientY: 200 },
    ],
  });
  assert.strictEqual(page.data.zoomLevel, 0.6, '双指向内捏合后音轨应缩小至 0.6x (60%)');
  assert.ok(page.data.pinchTipText.indexOf('向内缩小') >= 0, '提示文案应清晰指示向内缩小');

  // 4. 双指向内捏合至极限（自动吸附全览 fitScale）
  await wait(40);
  page.onTimelineTouchMove({
    touches: [
      { clientX: 148, clientY: 200 },
      { clientX: 152, clientY: 200 },
    ],
  });
  const fitScale = page.calcFitScale();
  assert.strictEqual(page.data.zoomLevel, fitScale, '向内捏合至极致应缩小至全览 fitScale');
  assert.strictEqual(page.data.zoomPercentText, '全览');
  assert.ok(page.data.pinchTipText.indexOf('全览') >= 0);

  // 5. 验证手指在音频片段上触发双指手势时，自动转发给时间轴缩放
  page.onTimelineTouchEnd({ touches: [] });
  await wait(100);
  assert.strictEqual(page._isPinching, false);
  assert.strictEqual(page.data.isPinchingTimeline, false);

  page.setData({ zoomLevel: 1.0 });
  // 指尖 1 落在第 0 个片段上，指尖 2 落在另一处
  page.onClipTouchStart({
    currentTarget: { dataset: { index: 0 } },
    touches: [
      { clientX: 100, clientY: 200 },
      { clientX: 200, clientY: 200 },
    ],
  });
  assert.strictEqual(page._isPinching, true, '在片段卡片上双指触碰应顺利激活时间轴缩放');
  await wait(40);
  page.onClipTouchMove({
    currentTarget: { dataset: { index: 0 } },
    touches: [
      { clientX: 60, clientY: 200 },
      { clientX: 240, clientY: 200 },
    ],
  });
  assert.strictEqual(page.data.zoomLevel, 1.8, '片段上双指向外张开应正确放大音轨至 1.8x');

  // 6. 手指抬起结束缩放
  page.onClipTouchEnd({ touches: [] });
  assert.strictEqual(page._isPinching, false);
  assert.strictEqual(page.data.isPinchingTimeline, false);

  page.onUnload();
});

smokeTest('格式试听与草稿恢复自愈，以及时间轴缩放 60FPS 丝滑动画与轻量化波形', async () => {
  const stub = createWxStub({
    chooseBatches: [
      [{ path: 'wxfile://tmp/voice.mp3', name: 'voice.mp3', size: 1024 * 1024 }],
    ],
    analyzeResults: [
      makeAnalyzeResponse({ duration: 60, format: 'mp3', playableIos: true, playableAndroid: true }),
    ],
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.onShow();

  // 1. 导入音频并验证处于编辑态
  page.chooseAudioFiles();
  await wait(50);
  assert.strictEqual(page.data.status, 'editing');
  assert.strictEqual(page.data.canPreviewAll, true);
  assert.strictEqual(page.data.canPreviewClip, true);

  // 2. 模拟自动保存草稿
  page.saveDraft();
  const draft = stub.wx.storage['NLE_DRAFT_CACHE_V1'];
  assert.ok(draft, '草稿应成功存储');
  assert.strictEqual(draft.sources[0].localPath, 'wxfile://tmp/voice.mp3');
  assert.strictEqual(draft.sources[0].playable, true);

  // 3. 模拟清空内存后恢复草稿
  page.sources = [];
  page.clips = [];
  page.restoreDraft(draft);
  assert.strictEqual(page.sources[0].localPath, 'wxfile://tmp/voice.mp3');
  assert.strictEqual(page.sources[0].playable, true);
  assert.strictEqual(page.data.canPreviewAll, true, '草稿恢复后 canPreviewAll 应为 true');

  // 4. 测试点击档位缩放触发 isZoomAnimating 动画类
  page.setZoomScale({ currentTarget: { dataset: { scale: 2.0 } } });
  assert.strictEqual(page.data.zoomLevel, 2.0);
  assert.strictEqual(page.data.isZoomAnimating, true, '点击缩放档位应激活 isZoomAnimating 动画标记');
  await wait(400);
  assert.strictEqual(page.data.isZoomAnimating, false, '动画结束后应自动复位 isZoomAnimating');

  // 5. 验证双指手势缩放采用轻量化数据且单次合并 setData
  page.onTimelineTouchStart({
    touches: [
      { clientX: 100, clientY: 200 },
      { clientX: 200, clientY: 200 },
    ],
  });
  await wait(30);
  page.onTimelineTouchMove({
    touches: [
      { clientX: 80, clientY: 200 },
      { clientX: 220, clientY: 200 },
    ],
  });
  assert.strictEqual(page.data.isPinchingTimeline, true);
  assert.ok(page.data.timelineData.tracks[0].clips[0].waveBars.length <= 28, '缩放手势期间应采用轻量级波形条，避免大量 DOM 掉帧');

  // 6. 抬手结束手势后恢复全量高精度波形
  page.onTimelineTouchEnd({ touches: [] });
  assert.strictEqual(page.data.isPinchingTimeline, false);

  page.onUnload();
});

smokeTest('播放中自由滑阅后续内容不弹回，时间轴精准寻位不倒退，音轨波形静态精准标定', async () => {
  const stub = createWxStub({
    chooseBatches: [
      [{ path: 'wxfile://tmp/preview_song.mp3', name: 'preview_song.mp3', size: 1024 * 1024 }],
    ],
    analyzeResults: [
      makeAnalyzeResponse({ duration: 180, format: 'mp3', playableIos: true, playableAndroid: true }),
    ],
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.onShow();

  page.chooseAudioFiles();
  await wait(50);
  assert.strictEqual(page.data.status, 'editing');

  // 1. 启动播放全部
  page.togglePlayAll();
  assert.strictEqual(page.data.isPlaying, true);

  // 2. 模拟用户主动横向滑动时间轴到 800px 处检阅后续片段
  page.onTimelineTouchStart({ touches: [{ clientX: 200, clientY: 200 }] });
  page.onTimelineScroll({ detail: { scrollLeft: 800 } });
  page.onTimelineTouchEnd({ touches: [] });
  assert.strictEqual(page.timelineScrollLeft, 800);
  assert.strictEqual(page.data.userBrowsingWhilePlaying, true, '播放中主动滑动应标记为正在浏览后续');

  // 3. 模拟播放时钟触发 tickMultiTrackPlayback / tickPlayback
  // 指针仍在 0~5s 处，但视口滚动在 800px（相当于 relPlayhead < 0）
  page.tickPlayback();
  assert.strictEqual(page.timelineScrollLeft, 800, '播放时钟绝不得强行将视口弹回前面的指针！');

  // 4. 点击「回至指针」悬浮药丸，平滑复位跟随
  page.resumePlayheadFollow();
  assert.strictEqual(page.data.userBrowsingWhilePlaying, false);

  // 5. 点击时间轴 45s 位置寻位，验证实时同步且音频时钟不弹回
  page.onTimelineTap({ currentTarget: { dataset: { time: 45 } } });
  assert.strictEqual(page.currentSourceTime, 45, '指针应精确寻位至 45s');

  page.onUnload();
});

smokeTest('同轨片段碰撞与重叠预警、一键顺延/换轨消除、相邻片段智能磁吸与10分钟总长限额防线', async () => {
  const stub = createWxStub({
    chooseBatches: [
      [
        { path: 'wxfile://tmp/song1.mp3', name: 'song1.mp3', size: 1024 * 1024 },
        { path: 'wxfile://tmp/song2.mp3', name: 'song2.mp3', size: 1024 * 1024 },
      ],
    ],
    analyzeResults: [
      makeAnalyzeResponse({ duration: 60, format: 'mp3' }),
      makeAnalyzeResponse({ duration: 60, format: 'mp3' }),
    ],
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.onShow();

  page.chooseAudioFiles();
  await wait(50);
  assert.strictEqual(page.data.status, 'editing');
  assert.strictEqual(page.clips.length, 2);

  // 1. 同轨重叠碰撞检测：让片段 0 (0~10s) 与片段 1 (offset: 5s, 5~15s) 在音轨 1 发生物理重叠 5s
  page.clips[0].trackId = 'T1';
  page.clips[0].in = 0;
  page.clips[0].out = 10;
  page.clips[0].offsetSec = 0;

  page.clips[1].trackId = 'T1';
  page.clips[1].in = 0;
  page.clips[1].out = 10;
  page.clips[1].offsetSec = 5; // 与片段 0 重叠 5 秒

  page.refreshClipData();
  assert.strictEqual(page.data.timelineData.hasOverlap, true, '时间线整体应标记存在重叠碰撞');
  const t1 = page.data.timelineData.tracks.find(t => t.id === 'T1');
  assert.strictEqual(t1.hasOverlap, true, '音轨 1 应标记重叠');
  assert.strictEqual(t1.clips[0].isOverlapping, true, '片段 0 应被标记为重叠');
  assert.strictEqual(t1.clips[1].isOverlapping, true, '片段 1 应被标记为重叠');
  assert.strictEqual(t1.clips[1].overlapDeltaSec, 5, '重叠时长应准确计算为 5 秒');

  // 2. 一键顺延对齐 (autoStaggerOverlap)：选中片段 1，一键顺延至前一段尾部 (offset: 10s)
  page.selectClip(1);
  page.autoStaggerOverlap();
  assert.strictEqual(page.clips[1].offsetSec, 10, '顺延后片段 1 起点应无缝对接在片段 0 终点 (10s)');
  assert.strictEqual(page.data.timelineData.hasOverlap, false, '顺延后重叠应被彻底消除');
  assert.strictEqual(page.data.timelineData.tracks[0].hasOverlap, false);

  // 3. 一键移至新音轨 (moveOverlapToNewTrack)：再次制造重叠后一键移入新音轨
  page.clips[1].offsetSec = 4; // 再次重叠 6 秒
  page.refreshClipData();
  assert.strictEqual(page.data.timelineData.hasOverlap, true);
  page.selectClip(1);
  page.moveOverlapToNewTrack();
  assert.strictEqual(page.clips[1].trackId, 'T2', '重叠片段应智能分流移至可用音轨 T2');
  assert.strictEqual(page.data.timelineData.hasOverlap, false, '分轨后两轨各自分立，不再重叠');

  // 4. 智能磁吸相邻片段测试 (onClipTouchMove)：将片段 1 放回 T1，拖拽靠近片段 0 尾部自动吸附
  page.clips[1].trackId = 'T1';
  page.clips[1].offsetSec = 20;
  page.refreshClipData();

  page.setData({ zoomLevel: 1.0 });
  const pxPerSec = page.data.timelineData.pxPerSec; // 36
  page.onClipTouchStart({
    currentTarget: { dataset: { index: 1 } },
    touches: [{ clientX: 200, clientY: 100 }],
  });
  // 模拟向左拖动，使得目标 offset 落在 10.15s（处于片段 0 尾部 10s 的 ±0.25s 磁吸窗口内）
  // deltaOffset = 10.15 - 20 = -9.85s -> deltaRpx = -9.85 * 36 = -354.6rpx -> deltaX = -354.6 / 2 = -177.3px
  const targetX = 200 - (9.85 * pxPerSec) / 2;
  page.onClipTouchMove({
    currentTarget: { dataset: { index: 1 } },
    touches: [{ clientX: targetX, clientY: 100 }],
  });
  assert.strictEqual(page._finalOffsetSec, 10, '拖拽靠近前一段尾部时，应智能磁吸对齐至前一段终点 (10s)');
  assert.ok(page.data.dragTipText.indexOf('🧲贴合') >= 0, '磁吸时应展示贴合相邻片段提示文案');
  page.onClipTouchEnd({ touches: [] });

  // 5. 10 分钟导出限额防线 (600s Ceiling Limit Warning)
  // 让成片总长达到 650 秒（超出 10 分钟限额 50 秒）
  page.clips[0].in = 0;
  page.clips[0].out = 60;
  page.clips[0].offsetSec = 0;
  page.clips[1].in = 0;
  page.clips[1].out = 60;
  page.clips[1].offsetSec = 590; // 590 + 60 = 650s

  page.refreshClipData();
  assert.strictEqual(page.data.isOverDurationCeiling, true, '成片超 600s 应触发限额警戒');
  assert.strictEqual(page.data.ceilingExceededSec, 50, '超额秒数应准确计算为 50 秒');
  assert.strictEqual(page.data.exportDisabled, true, '超额时必须禁用导出按钮');
  assert.strictEqual(page.data.timelineData.isExceededCeiling, true, '时间轴标尺应标出超限警戒区');
  assert.strictEqual(page.data.timelineData.ceilingRpx, Math.round(600 * pxPerSec));

  // 6. 删除音轨时清理音频上下文资源
  page.getTrackAudio('T2'); // 分配 T2 audio context
  assert.ok(page.trackAudioPool['T2']);
  page.deleteTrack({ currentTarget: { dataset: { track: 'T2' } } });
  assert.strictEqual(page.trackAudioPool['T2'], undefined, '删除音轨时应彻底清理该轨的 AudioContext 实例');

  page.onUnload();
});

smokeTest('统一精修控制中枢视觉对齐与模式分段器、辅助工具及对称播放行', async () => {
  const stub = createWxStub({
    chooseBatches: [
      [{ path: 'wxfile://tmp/v36.mp3', name: 'v36.mp3', size: 1024 * 1024 }],
    ],
    analyzeResults: [
      makeAnalyzeResponse({ duration: 60, format: 'mp3', playableIos: true, playableAndroid: true }),
    ],
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.chooseAudioFiles();
  await wait(50);

  // 1. 验证 WXML 中存在新版专业精修控制中枢核心结构
  const wxmlText = read(WXML_PATH);
  assert.ok(wxmlText.indexOf('studio-command-console') >= 0, 'WXML 应包含 studio-command-console 容器');
  assert.ok(wxmlText.indexOf('console-mode-utility-row') >= 0, 'WXML 应包含第一排模式分段与辅助工具行');
  assert.ok(wxmlText.indexOf('mode-segmented-pill') >= 0, 'WXML 应包含 iOS 风格模式分段胶囊');
  assert.ok(wxmlText.indexOf('utility-pill-group') >= 0, 'WXML 应包含视觉对齐的辅助操作组');
  assert.ok(wxmlText.indexOf('console-action-grid') >= 0, 'WXML 应包含四等分剪辑快捷网格');
  assert.ok(wxmlText.indexOf('console-transport-row') >= 0, 'WXML 应包含对称主控播放行');

  // 2. 验证 WXSS 中包含对应样式规则
  const wxssText = read(WXSS_PATH);
  assert.ok(wxssText.indexOf('.studio-command-console') >= 0, 'WXSS 应包含 .studio-command-console 样式定义');
  assert.ok(wxssText.indexOf('.mode-segmented-pill') >= 0, 'WXSS 应包含 .mode-segmented-pill 样式定义');
  assert.ok(wxssText.indexOf('.utility-pill-group') >= 0, 'WXSS 应包含 .utility-pill-group 样式定义');
  assert.ok(wxssText.indexOf('.console-action-grid') >= 0, 'WXSS 应包含 .console-action-grid 样式定义');
  assert.ok(wxssText.indexOf('.console-transport-row') >= 0, 'WXSS 应包含 .console-transport-row 样式定义');

  // 3. 验证模式切换交互响应
  assert.strictEqual(page.data.activeTool, 'select', '默认应为选择模式');
  page.setToolRazor();
  assert.strictEqual(page.data.activeTool, 'razor', '点击剃刀应切换为 razor 模式');
  page.setToolSelect();
  assert.strictEqual(page.data.activeTool, 'select', '点击选择模式应切换回 select');

  // 4. 验证磁吸对齐切换
  const initialSnap = page.data.snapEnabled;
  page.toggleSnap();
  assert.strictEqual(page.data.snapEnabled, !initialSnap, '点击磁吸胶囊应正确翻转磁吸状态');
  page.toggleSnap();
  assert.strictEqual(page.data.snapEnabled, initialSnap);

  // 5. 验证归零与撤销响应
  page.seekToZero();
  assert.strictEqual(page.currentSourceTime, 0, '点击归零应将播放位置置为 0');
  assert.strictEqual(page.data.currentTimeText, '00:00.0');

  page.onUnload();
});

smokeTest('音频修改后试听与成片重渲染防护：startTime/playbackRate/音量增益/防原声泄露与成片路径热切换', async () => {
  const stub = createWxStub({
    chooseBatches: [
      [{ path: 'wxfile://tmp/v37.mp3', name: 'v37.mp3', size: 1024 * 1024 }],
    ],
    analyzeResults: [
      makeAnalyzeResponse({ duration: 60, format: 'mp3', playableIos: true, playableAndroid: true }),
    ],
    renderResult: {
      success: true,
      data: { fileID: 'cloud://test/render_new.mp3', duration: 15, size: 500000 },
    },
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.chooseAudioFiles();
  await wait(50);

  // 1. 验证导入后片段
  assert.strictEqual(page.clips.length, 1);
  assert.strictEqual(page.clips[0].in, 0);
  assert.strictEqual(page.clips[0].out, 60);

  // 2. 修改片段：裁剪到 10s ~ 30s，并设置速度 1.5x，增益 3dB
  page.clips[0].in = 10;
  page.clips[0].out = 30;
  page.clips[0].speed = 1.5;
  page.clips[0].volumeDb = 3;
  page.refreshClipData();

  // 3. 启动播放本段，验证 playQueueAt 显式设置了 startTime 和 playbackRate
  await page.startPlayback('clip');
  assert.ok(page.sourceAudio, 'sourceAudio 应已初始化');
  assert.strictEqual(page.sourceAudio.startTime, 10, 'InnerAudioContext.startTime 必须显式设为 clip.in (10s)');
  assert.strictEqual(page.sourceAudio.playbackRate, 1.5, 'InnerAudioContext.playbackRate 必须设为 clip.speed (1.5)');

  // 4. 验证 applyPreviewVolume 计算了 clip.volumeDb（实时热调音更新）
  page.onClipGainChange({ detail: { value: -6 } });
  assert.strictEqual(page.playback.queue[0].volumeDb, -6, '调节增益应热更新播放队列中的 volumeDb，绝不中断正在进行的播放');
  page.applyPreviewVolume(15);
  assert.ok(page.sourceAudio.volume < 0.6 && page.sourceAudio.volume > 0.4, '音量应应用片段增益 -6dB');

  // 5. 验证 tickPlayback 防原声泄露守卫
  // 当微信 native seek 延迟，当前时间 t 仍为 0 (< 10 - 0.25) 时，必须静音 ctx.volume = 0 并补 seek
  page.sourceAudio.currentTime = 0;
  page.tickPlayback();
  assert.strictEqual(page.sourceAudio.volume, 0, 'seek 延迟期间必须立即静音防原声泄露');
  assert.strictEqual(page.sourceAudio.startTime, 10);

  // 6. 验证交互修改操作能立即使播放缓存失效 (this.playback = null)
  assert.ok(page.playback !== null, '播放时 playback 应存在');
  // 模拟入点手势修剪
  page._isTrimming = true;
  page._trimClipIndex = 0;
  page._finalTrimIn = 12;
  page.onTrimInTouchEnd({});
  assert.strictEqual(page.clips[0].in, 12);
  assert.strictEqual(page.playback, null, '拖动手势修剪后必须清除旧 playback 缓存');
  assert.strictEqual(page.paused, false);

  // 模拟出点手势修剪
  page.playback = { mode: 'clip', queue: [] };
  page._isTrimming = true;
  page._trimClipIndex = 0;
  page._finalTrimOut = 28;
  page.onTrimOutTouchEnd({});
  assert.strictEqual(page.clips[0].out, 28);
  assert.strictEqual(page.playback, null);

  // 7. 导出并验证成片播放与热切换
  page.startExport();
  await wait(50);
  assert.strictEqual(page.data.status, 'result');
  assert.strictEqual(page.data.result.fileID, 'cloud://test/render_new.mp3');

  // 预下载完成后，resultAudio.src 应立即热切换为本地 tempFilePath
  page.prepareResultTempFile('cloud://test/render_new.mp3');
  await wait(50);
  assert.strictEqual(page.resultTempFilePath, 'wxfile://tmp/result.mp3');
  assert.strictEqual(page.resultAudio.src, page.resultTempFilePath, '成片下载后音频 src 必须切换为本地 tempFilePath');

  // 8. 点击「继续编辑」后状态清理
  page.reEdit();
  assert.strictEqual(page.data.status, 'editing');
  assert.strictEqual(page.resultAudio.src, '', '返回编辑时成片 audio src 必须重置为空');
  assert.strictEqual(page.resultTempFilePath, '', '返回编辑时 tempFilePath 必须清空');
  assert.strictEqual(page.data.result, null);
  assert.strictEqual(page.playback, null);

  page.onUnload();
});

smokeTest('音频切开重叠自动下移至下一音轨与重复分段仅展现🎵标记', async () => {
  const stub = createWxStub({
    chooseBatches: [
      [{ path: 'wxfile://tmp/song.mp3', name: 'song.mp3', size: 1024 * 1024 }],
    ],
    analyzeResults: [
      makeAnalyzeResponse({ duration: 60, format: 'mp3', playableIos: true, playableAndroid: true }),
    ],
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.chooseAudioFiles();
  await wait(50);

  // 1. 初始状态：1 个主片段，默认属于 T1，isDuplicate 为 false
  assert.strictEqual(page.clips.length, 1);
  assert.strictEqual(page.clips[0].trackId || 'T1', 'T1');
  assert.strictEqual(page.data.clips[0].isDuplicate, false, '首段主音频必须展现完整名称与文字');

  // 2. 在 25s 处进行播放头分割
  page.currentSourceTime = 25;
  page.splitSelectedClipAtPlayhead();
  assert.strictEqual(page.clips.length, 2, '切开后应有两个片段');

  // 3. 验证视图标记：第一段为原始主片段，第二段为重复分段 (isDuplicate: true)
  assert.strictEqual(page.data.clips[0].isDuplicate, false);
  assert.strictEqual(page.data.clips[1].isDuplicate, true, '切开后的后一段应标记为 isDuplicate 供 WXML 仅展现 🎵 标记');

  // 4. 模拟拖动第二段向左移动与第一段重叠（第二段起点设为 10s，第一段 0~25s，产生 15s 物理重叠）
  page._isDraggingClip = true;
  page._dragClipIndex = 1;
  page._finalOffsetSec = 10;
  page.onClipTouchEnd({});

  // 5. 验证自动重叠下移防护生效：第二段（后一段）被自动从 T1 下移至 T2！
  assert.strictEqual(page.clips[0].trackId || 'T1', 'T1', '前一段留在 T1');
  assert.strictEqual(page.clips[1].trackId, 'T2', '切开重叠后，后一段必须自动下移至下一音轨 T2');
  assert.strictEqual(page.data.clips[1].isDuplicate, true);

  // 6. 验证 WXML 中存在 .clip-mark-only-tag 样式与 🎵 标记结构
  const wxml = read(WXML_PATH);
  assert.ok(wxml.indexOf('clip-mark-only-tag') >= 0, 'WXML 应包含 .clip-mark-only-tag');
  assert.ok(wxml.indexOf('clip-mark-icon') >= 0, 'WXML 应包含 .clip-mark-icon');
  assert.ok(wxml.indexOf('🎵') >= 0, 'WXML 应包含 🎵 音符标记');

  const wxss = read(WXSS_PATH);
  assert.ok(wxss.indexOf('.clip-mark-only-tag') >= 0, 'WXSS 应包含 .clip-mark-only-tag 样式定义');
  assert.ok(wxss.indexOf('.clip-mark-icon') >= 0, 'WXSS 应包含 .clip-mark-icon 样式定义');

  page.onUnload();
});

function loadIndexPage(wxStub) {
  global.wx = wxStub;
  const sharedApp = { globalData: {} };
  global.getApp = () => sharedApp;
  let captured = null;
  global.Page = (config) => {
    captured = config;
  };
  const indexJsPath = path.join(ROOT, 'miniprogram', 'pages', 'index', 'index.js');
  delete require.cache[require.resolve(indexJsPath)];
  require(indexJsPath);
  assert.ok(captured, 'index.js 没有调用 Page()');
  const page = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data));
  page.setData = function setData(patch, callback) {
    for (const k of Object.keys(patch)) {
      if (k.includes('.')) {
        const parts = k.split('.');
        let obj = this.data;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!obj[parts[i]]) obj[parts[i]] = {};
          obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = patch[k];
      } else {
        this.data[k] = patch[k];
      }
    }
    if (typeof callback === 'function') callback();
  };
  return page;
}

smokeTest('格式转换主页面音频压缩控制台：预设码率切换、极限压缩、实时体积测算与无损格式智能拦截', async () => {
  const indexWxmlPath = path.join(ROOT, 'miniprogram', 'pages', 'index', 'index.wxml');
  const indexWxssPath = path.join(ROOT, 'miniprogram', 'pages', 'index', 'index.wxss');

  // 1. 验证 WXML 中具有首要压缩控制面板及核心元素
  const wxml = read(indexWxmlPath);
  assert.ok(wxml.indexOf('compression-panel') >= 0, 'WXML 应包含 .compression-panel 核心控制台');
  assert.ok(wxml.indexOf('compression-metrics-board') >= 0, 'WXML 应包含体积预估看板');
  assert.ok(wxml.indexOf('quality-grade-banner') >= 0, 'WXML 应包含当前档位音质说明条');
  assert.ok(wxml.indexOf('bitrate-preset-grid') >= 0, 'WXML 应包含 6 档预设胶囊矩阵');
  assert.ok(wxml.indexOf('slider-control-row') >= 0, 'WXML 应包含连续滑动控制条');
  assert.ok(wxml.indexOf('extreme-btn-pill') >= 0, 'WXML 应包含极限压缩快捷按钮');
  assert.ok(wxml.indexOf('quickExtremeCompress') >= 0, 'WXML 应绑定 quickExtremeCompress 事件');
  assert.ok(wxml.indexOf('lossless-notice-box') >= 0, 'WXML 应包含无损格式提示');
  assert.ok(wxml.indexOf('switchToMp3Compress') >= 0, 'WXML 应包含切换 MP3 压缩按钮');

  // 2. 验证 WXSS 样式文件包含压缩样式并花括号匹配
  const wxss = read(indexWxssPath);
  assert.ok(wxss.indexOf('.compression-panel') >= 0, 'WXSS 应包含 .compression-panel');
  assert.ok(wxss.indexOf('.bitrate-preset-grid') >= 0, 'WXSS 应包含 .bitrate-preset-grid');
  assert.ok(wxss.indexOf('.save-badge-pill') >= 0, 'WXSS 应包含 .save-badge-pill');
  const openBraces = (wxss.match(/{/g) || []).length;
  const closeBraces = (wxss.match(/}/g) || []).length;
  assert.strictEqual(openBraces, closeBraces, 'index.wxss 花括号必须完全闭合配对');

  // 3. 运行页面逻辑单元
  let cloudCallData = null;
  const stub = createWxStub({
    cloudCallFunction: async ({ name, data }) => {
      cloudCallData = { name, data };
      return {
        result: {
          success: true,
          data: {
            fileID: 'cloud://test/converted_compressed.mp3',
            downloadUrl: 'https://example.com/converted_compressed.mp3',
            fileName: 'long_audio_compressed.mp3',
            targetFormat: 'mp3',
            targetSize: 1200000,
            targetSampleRate: 44100,
            targetChannels: 2,
          },
        },
      };
    },
  });

  const page = loadIndexPage(stub.wx);

  // 初始状态断言
  assert.strictEqual(page.data.compressionOptionsList.length, 6, '必须包含 6 档预设码率 (64k~320k)');
  assert.strictEqual(page.data.compressionIndex, 3, '默认档位为 192k (标准推荐)');
  assert.strictEqual(page.data.options.bitrate, '192k');
  assert.strictEqual(page.data.isCompressibleFormat, true, 'MP3 默认可压缩');

  // 4. 模拟加载源音频 (12MB, 时长 180s)
  page.setData({
    sourceFile: {
      path: 'wxfile://tmp/long_audio.mp3',
      name: 'long_audio.mp3',
      size: 12 * 1024 * 1024,
      sizeText: '12 MB',
      extName: 'MP3',
      extLower: 'mp3',
    },
    sourceDuration: 180,
  });
  page.updateCompressionEstimate();

  // 验证 192k 测算
  assert.ok(page.data.savedRatioText > 0, '192k 下应有瘦身比例预估');
  assert.ok(page.data.estimatedSizeText.indexOf('MB') >= 0, '预估体积应为 MB 格式');

  // 5. 点击极限压缩快捷按钮 (一键锁 64k)
  page.quickExtremeCompress();
  assert.strictEqual(page.data.compressionIndex, 0, '极限压缩应选中第 0 档 (64k)');
  assert.strictEqual(page.data.options.bitrate, '64k', 'options.bitrate 应更新为 64k');
  assert.ok(page.data.savedRatioText >= 80, '64k 极限压缩对 12MB 音频瘦身率应达到 80% 以上');

  // 6. 切换码率胶囊 (点选 96k)
  page.selectBitrateIndex({ currentTarget: { dataset: { index: 1 } } });
  assert.strictEqual(page.data.compressionIndex, 1);
  assert.strictEqual(page.data.options.bitrate, '96k');
  assert.strictEqual(page.data.qualityGradeShort, '高压缩');

  // 7. 滑块连续调节 (滑到 320k)
  page.onBitrateSliderChange({ detail: { value: 5 } });
  assert.strictEqual(page.data.compressionIndex, 5);
  assert.strictEqual(page.data.options.bitrate, '320k');
  assert.strictEqual(page.data.qualityGradeShort, '极品母带');

  // 8. 格式无损防呆拦截：切到 wav 时，isCompressibleFormat 应为 false
  page.setData({ targetFormat: 'wav' });
  page.updateCompressionEstimate();
  assert.strictEqual(page.data.isCompressibleFormat, false, 'WAV 无损格式不可执行常规压缩');

  // 触发一键切换回 MP3 压缩
  page.switchToMp3Compress();
  assert.strictEqual(page.data.targetFormat, 'mp3');
  assert.strictEqual(page.data.isCompressibleFormat, true);

  // 9. 执行转码，断言传递给云函数的 options 包含所选压缩码率
  page.setData({ compressionIndex: 0 }); // 选 64k
  page.updateCompressionEstimate();
  await page.startConvert();

  assert.ok(cloudCallData, '必须发起云函数调用');
  assert.strictEqual(cloudCallData.name, 'ffmpegProbe');
  assert.strictEqual(cloudCallData.data.targetFormat, 'mp3');
  assert.strictEqual(cloudCallData.data.options.bitrate, '64k', '云函数参数必须正确透传选定的 64k 压缩比特率');
});

smokeTest('全流程处理完成原声试听：双页面即时试听播放器、零缓冲本地热切、静音穿透与进度拖拽', async () => {
  const indexWxmlPath = path.join(ROOT, 'miniprogram', 'pages', 'index', 'index.wxml');
  const indexWxssPath = path.join(ROOT, 'miniprogram', 'pages', 'index', 'index.wxss');
  const editorWxmlPath = path.join(ROOT, 'miniprogram', 'pages', 'editor', 'editor.wxml');
  const editorWxssPath = path.join(ROOT, 'miniprogram', 'pages', 'editor', 'editor.wxss');

  // 1. WXML & WXSS 结构断言：格式转换页
  const indexWxml = read(indexWxmlPath);
  assert.ok(indexWxml.indexOf('result-audition-box') >= 0, 'index.wxml 应包含 .result-audition-box');
  assert.ok(indexWxml.indexOf('targetPlayable') >= 0, 'index.wxml 应区分 targetPlayable');
  assert.ok(indexWxml.indexOf('unplayable-result-banner') >= 0, 'index.wxml 应提供不可直接试听格式的友好向导');

  const indexWxss = read(indexWxssPath);
  assert.ok(indexWxss.indexOf('.audition-playing-badge') >= 0, 'index.wxss 应定义试听中呼吸徽章');
  const iOpen = (indexWxss.match(/{/g) || []).length;
  const iClose = (indexWxss.match(/}/g) || []).length;
  assert.strictEqual(iOpen, iClose, 'index.wxss 花括号闭合');

  // 2. WXML & WXSS 结构断言：音频剪辑工坊页
  const editorWxml = read(editorWxmlPath);
  assert.ok(editorWxml.indexOf('audition-inline-player') >= 0, 'editor.wxml 应升级为全功能 .audition-inline-player');
  assert.ok(editorWxml.indexOf('onResultSeek') >= 0, 'editor.wxml 应绑定 onResultSeek 拖拽寻位');

  const editorWxss = read(editorWxssPath);
  assert.ok(editorWxss.indexOf('.audition-inline-player') >= 0, 'editor.wxss 应定义 .audition-inline-player');
  const eOpen = (editorWxss.match(/{/g) || []).length;
  const eClose = (editorWxss.match(/}/g) || []).length;
  assert.strictEqual(eOpen, eClose, 'editor.wxss 花括号闭合');

  // 3. 页面逻辑测试：格式转换页试听
  const stubIndex = createWxStub({
    cloudCallFunction: async () => ({
      result: {
        success: true,
        data: {
          fileID: 'cloud://test/converted_finished.mp3',
          downloadUrl: 'https://example.com/converted_finished.mp3',
          fileName: 'test_compressed.mp3',
          targetFormat: 'mp3',
          targetSize: 1500000,
          duration: 120,
          costTimeMs: 1200,
        },
      },
    }),
  });

  const pageIndex = loadIndexPage(stubIndex.wx);
  pageIndex.initAudioContexts();
  assert.strictEqual(pageIndex.targetAudioCtx.obeyMuteSwitch, false, '播放器必须配置 obeyMuteSwitch: false 穿透硬件静音');

  // 模拟转码完成
  pageIndex.setData({
    sourceFile: { path: 'wxfile://tmp/test.wav', name: 'test.wav', size: 10 * 1024 * 1024, extLower: 'wav', extName: 'WAV' },
    targetFormat: 'mp3',
  });
  await pageIndex.startConvert();

  assert.strictEqual(pageIndex.data.status, 'SUCCESS');
  assert.strictEqual(pageIndex.data.targetPlayable, true);
  assert.ok(pageIndex.targetAudioCtx.src.indexOf('wxfile://') >= 0 || pageIndex.targetAudioCtx.src.indexOf('https://') >= 0, '必须挂载有效播放源');

  // 点击播放
  pageIndex.togglePlayTarget();
  assert.strictEqual(pageIndex.data.isTargetPlaying, true);

  // 模拟本地下载就绪 (零缓冲热切)
  pageIndex.prepareResultTempFile('cloud://test/converted_finished.mp3');
  await wait(50);
  assert.ok(pageIndex.data.resultTempFilePath.indexOf('wxfile://') >= 0);
  assert.strictEqual(pageIndex.targetAudioCtx.src, pageIndex.data.resultTempFilePath, '本地就绪后应热切换为本地零缓冲源');

  // 模拟进度条拖拽 seek
  pageIndex.onTargetSeek({ detail: { value: 45 } });
  assert.strictEqual(pageIndex.targetAudioCtx.currentTime, 45);

  // 4. 页面逻辑测试：音频剪辑工坊成片试听
  const stubEditor = createWxStub();
  const pageEditor = loadEditorPage(stubEditor.wx);
  pageEditor.onLoad();
  pageEditor.initAudioContexts();

  pageEditor.handleExportSuccess({
    fileID: 'cloud://test.edit/export_master.mp3',
    fileName: 'master.mp3',
    size: 2000000,
    duration: 180,
    costMs: 1500,
  }, 180);

  assert.strictEqual(pageEditor.data.status, 'result');
  assert.ok(!pageEditor.resultAudio.src || !pageEditor.resultAudio.src.startsWith('cloud://'), '严禁直接赋值非法 cloud:// 协议');

  // 点击成片试听
  pageEditor.toggleResultPlay();
  await wait(50);
  assert.strictEqual(pageEditor.data.resultPlaying, true);
  assert.strictEqual(pageEditor.resultAudio.obeyMuteSwitch, false);

  // 成片时间更新驱动
  pageEditor.resultAudio.currentTime = 30;
  pageEditor.handleResultTimeUpdate();
  assert.strictEqual(pageEditor.data.resultCurrentTime, 30);
  assert.strictEqual(pageEditor.data.resultCurrentText, '00:30');

  // 成片进度拖拽 seek
  pageEditor.onResultSeek({ detail: { value: 60 } });
  assert.strictEqual(pageEditor.resultAudio.currentTime, 60);

  // 暂停
  pageEditor.toggleResultPlay();
  assert.strictEqual(pageEditor.data.resultPlaying, false);
});

smokeTest('选中片段控制中枢布局与双端修剪仪表盘：无折行对称微调、精简动作缎带及调音台联动', async () => {
  const wxml = read(WXML_PATH);
  const wxss = read(WXSS_PATH);

  // 1. WXML 结构断言：全新双端修剪仪表盘与消除折行
  assert.ok(wxml.indexOf('clip-trim-dashboard') >= 0, 'WXML 应包含 .clip-trim-dashboard 仪表盘');
  assert.ok(wxml.indexOf('trim-endpoint-group') >= 0, 'WXML 应包含 .trim-endpoint-group');
  assert.ok(wxml.indexOf('trim-span-bridge') >= 0, 'WXML 应包含中段把手拖拽指示 .trim-span-bridge');
  assert.ok(wxml.indexOf('pro-tools-ribbon-wrapper') >= 0, 'WXML 应包含工具缎带包裹容器 .pro-tools-ribbon-wrapper');
  assert.ok(wxml.indexOf('track-tag-pill') >= 0, 'WXML 应包含轨道标识胶囊 .track-tag-pill');

  // 2. 验证微调按钮采用水平现代排版，彻底废除墓碑式竖排文字
  assert.ok(wxml.indexOf('首微调') === -1, '严禁出现纵向挤压的「首微调」竖字');
  assert.ok(wxml.indexOf('尾微调') === -1, '严禁出现纵向挤压的「尾微调」竖字');
  assert.ok(wxml.indexOf('nudgeClipHead') >= 0, '必须保留入点微调事件绑定');
  assert.ok(wxml.indexOf('nudgeClipTail') >= 0, '必须保留出点微调事件绑定');

  // 3. WXSS 样式断言
  assert.ok(wxss.indexOf('.clip-trim-dashboard') >= 0, 'WXSS 应包含 .clip-trim-dashboard 样式');
  assert.ok(wxss.indexOf('.trim-nudge-btn') >= 0, 'WXSS 应包含 .trim-nudge-btn 样式');
  assert.ok(wxss.indexOf('.span-indicator-pill') >= 0, 'WXSS 应包含 .span-indicator-pill 样式');
  assert.ok(wxss.indexOf('.track-tag-pill') >= 0, 'WXSS 应包含 .track-tag-pill 样式');

  // 4. 逻辑断言：微调入点出点
  const stub = createWxStub();
  const page = loadEditorPage(stub.wx);
  page.onLoad();

  page.sources = [{ id: 's1', name: 'song.mp3', duration: 180 }];
  page.clips = [{ id: 'c1', sourceId: 's1', trackId: 'T1', in: 10, out: 60, offsetSec: 0 }];
  page.selectedClipIndex = 0;
  page.refreshClipData();

  assert.strictEqual(page.data.selectedClip.inText, '00:10.0');
  assert.strictEqual(page.data.selectedClip.outText, '01:00.0');

  // 点击左侧入点微调 (+0.2s)
  page.nudgeClipHead({ currentTarget: { dataset: { delta: 0.2 } } });
  assert.strictEqual(page.clips[0].in, 10.2, '入点应精确平移 +0.2s');

  // 点击右侧出点微调 (-0.2s)
  page.nudgeClipTail({ currentTarget: { dataset: { delta: -0.2 } } });
  assert.strictEqual(page.clips[0].out, 59.8, '出点应精确微调 -0.2s');

  page.onUnload();
});

smokeTest('格式转换完成界面优化与纯音频资源直通：sendConvertedToEditor、作品库联动与音视频格式兼容', async () => {
  const indexWxml = read(path.join(__dirname, '../../miniprogram/pages/index/index.wxml'));
  const indexWxss = read(path.join(__dirname, '../../miniprogram/pages/index/index.wxss'));

  // 1. 验证 WXML 具备新版送入剪辑与我的作品入库导航
  assert.ok(indexWxml.indexOf('sendConvertedToEditor') >= 0, 'index.wxml 必须包含送入多轨剪辑按钮');
  assert.ok(indexWxml.indexOf('primary-editor') >= 0, '必须包含 primary-editor 样式');
  assert.ok(indexWxml.indexOf('library-link') >= 0, '必须包含我的作品快速入库链接');
  assert.ok(indexWxss.indexOf('.primary-editor') >= 0, 'WXSS 必须定义 .primary-editor 样式');

  // 2. 模拟 index 页面逻辑执行
  const stub = createWxStub();
  const page = loadIndexPage(stub.wx);
  page.onLoad();

  assert.ok(typeof page.sendConvertedToEditor === 'function', 'index.js 必须实现 sendConvertedToEditor');

  page.setData({
    sourceFile: { name: '演讲原声.mp4', size: 10 * 1024 * 1024 },
    convertResult: {
      fileID: 'cloud://bucket/converted_audios/lecture.mp3',
      targetFormat: 'mp3',
      targetSize: 2 * 1024 * 1024,
    },
    resultTempFilePath: 'wxfile://tmp/lecture.mp3',
  });

  // 执行送入多轨剪辑
  page.sendConvertedToEditor();
  assert.strictEqual(stub.calls.navigateTo.length, 1, '必须跳转到多轨剪辑工坊');
  assert.strictEqual(stub.calls.navigateTo[0].url, '/pages/editor/editor');

  const appInstance = getApp();
  assert.ok(appInstance.globalData.pendingAudio, '必须向全局写入 pendingAudio');
  assert.strictEqual(appInstance.globalData.pendingAudio.name, '演讲原声.mp3');
  assert.strictEqual(appInstance.globalData.pendingAudio.extName, 'MP3');
  assert.strictEqual(appInstance.globalData.pendingAudio.from, 'audio-convert');
  assert.strictEqual(appInstance.globalData.pendingAudio.path, 'wxfile://tmp/lecture.mp3');

  // 验证剪辑工坊 onLoad 能自动消费该纯音频资源
  const editorPage = loadEditorPage(stub.wx);
  editorPage.onLoad();
  assert.strictEqual(appInstance.globalData.pendingAudio, null, '剪辑工坊进入时必须成功消费并清空 pendingAudio');

  await wait(120);
  editorPage.onUnload();
  page.onUnload();
});

smokeTest('播放时钟高精物理插值引擎：全片播放时间码连续递增、多片段无突跳与硬件微调校准', async () => {
  const stub = createWxStub({});
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  await wait(50);

  // 1. 模拟包含 2 个已裁剪片段的单轨工程
  page.sources = [
    { id: 's1', name: '原声A.mp3', duration: 60, localPath: 'wxfile://tmp/a.mp3', playable: true },
    { id: 's2', name: '原声B.mp3', duration: 40, localPath: 'wxfile://tmp/b.mp3', playable: true },
  ];
  page.clips = [
    { id: 'c1', sourceId: 's1', in: 10, out: 20, trackId: 'T1', offsetSec: 0, speed: 1.0 }, // 10s 长，时间轴 0~10s
    { id: 'c2', sourceId: 's2', in: 5, out: 15, trackId: 'T1', offsetSec: 10, speed: 1.0 },  // 10s 长，时间轴 10~20s
  ];
  page.refreshClipData();

  // 2. 启动「播放全部」
  await page.startPlayback('all');
  assert.strictEqual(page.data.isPlaying, true);
  assert.strictEqual(page.data.playMode, 'all');

  // 3. 初始状态时间码与红针验证
  assert.strictEqual(page.data.currentTimeText, '00:00.0');
  assert.strictEqual(page.data.timelineData.playheadRpx, 0);

  // 4. 模拟经过 100ms（音频播放器已进入片段内时间 10.1s）
  page.sourceAudio.currentTime = 10.1;
  page._playbackWallStart = Date.now() - 100;
  page.tickPlayback();
  assert.strictEqual(page.data.currentTimeText, '00:00.1');

  // 5. 模拟进入第二段（例如时间轴 12.5s 处，对应源 B 的 in(5) + 2.5 = 7.5s）
  page.playback.index = 1;
  page.sourceAudio.currentTime = 7.5;
  page._playbackWallStart = Date.now() - 2500;
  page._playbackStartSourceTime = 5;
  page._playbackStartTimelineSec = 10;
  page.tickPlayback();

  // 关键断言：全片播放时，时间码必须连续显示成片时间 00:12.5，绝不能突跳回片段内源时间 00:07.5！
  assert.strictEqual(page.data.currentTimeText, '00:12.5', '全片播放时时间码必须连续显示时间轴成片时间');
  assert.ok(page.data['timelineData.playheadRpx'] > 0);

  // 6. 验证微信硬件台阶式延迟下时间码严格单调递增，绝不因硬件台阶突跳倒退
  // 模拟微信底层 currentTime 滞留在 7.5s (250ms 台阶窗口)，而物理时钟连续走字
  const timecodes = [];
  for (let step = 1; step <= 5; step++) {
    page.sourceAudio.currentTime = 7.5; // 硬件台阶静止
    page._playbackWallStart = Date.now() - (2500 + step * 70); // 物理时间走过 70ms, 140ms, 210ms, 280ms, 350ms
    page.tickPlayback();
    timecodes.push(page.data.currentTimeText);
  }
  // 必须连续单调递增：12.5 -> 12.6 -> 12.7 -> 12.8 -> 12.9
  assert.strictEqual(timecodes[0], '00:12.6');
  assert.strictEqual(timecodes[1], '00:12.6'); // 70ms 步进
  assert.strictEqual(timecodes[4], '00:12.9');
  for (let i = 1; i < timecodes.length; i++) {
    assert.ok(timecodes[i] >= timecodes[i - 1], `时间码必须单调不减: ${timecodes[i]} >= ${timecodes[i - 1]}`);
  }

  // 7. 验证 seek 到第二段（例如时间轴 16.0s 处，对应源 B 的 in(5) + 6 = 11s）
  page.seekPlaybackTo(16.0);
  assert.strictEqual(page._playbackStartTimelineSec, 16.0, 'seek 后起始成片时间必须对齐目标点 16.0s');
  assert.strictEqual(page._playbackStartSourceTime, 11.0, 'seek 后起始源时间必须对齐目标点 11.0s');
  assert.strictEqual(page.data.currentTimeText, '00:16.0');

  page.stopPlayback();
  assert.strictEqual(page.data.isPlaying, false);
  page.onUnload();
});

smokeTest('触感微交互、拖拽悬浮时码气泡与自适应标尺密度集成验证', async () => {
  const vibrateLog = [];
  const stub = createWxStub({
    chooseBatches: [[{ path: 'wxfile://tmp/voice.mp3', name: 'voice.mp3', size: 1024 * 1024 }]],
    analyzeResults: [
      makeAnalyzeResponse({
        duration: 20,
        sampleRate: 44100,
        channels: 2,
        format: 'mp3',
        peaks: Buffer.alloc(400, 128).toString('base64'),
      }),
    ],
  });
  stub.wx.vibrateShort = function (opts) {
    vibrateLog.push(opts ? opts.type : 'light');
  };

  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.onShow();
  page.chooseAudioFiles();
  await wait(80);

  // 1. 验证时间标尺点击触发轻微触感
  vibrateLog.length = 0;
  page.onRulerTickTap({ currentTarget: { dataset: { time: 5 } } });
  assert.strictEqual(page.data.currentTimeText, '00:05.0');
  assert.ok(vibrateLog.includes('light'), '点击时间标尺刻度应触发 light 触感反馈');

  // 2. 验证复制触发 light 触感
  await wait(80); // 超出 60ms 防抖门禁
  vibrateLog.length = 0;
  page.copySelectedClip();
  assert.ok(vibrateLog.includes('light'), '复制片段应触发 light 触感');

  // 3. 验证分割触发 heavy 坚实剃刀触感
  await wait(80);
  vibrateLog.length = 0;
  page.currentSourceTime = 2.0;
  page.splitSelectedClipAtPlayhead();
  assert.ok(vibrateLog.includes('heavy'), '切断片段应触发 heavy 坚实剃刀触感');

  // 4. 验证删除触发 medium 触感
  await wait(80);
  vibrateLog.length = 0;
  page.deleteSelectedClip();
  assert.ok(vibrateLog.includes('medium'), '删除片段应触发 medium 触感');

  // 5. 验证 app.wxss 中存在 .scrubbing-time-bubble 声明
  const appWxss = fs.readFileSync(path.join(__dirname, '../../miniprogram/app.wxss'), 'utf-8');
  assert.ok(appWxss.includes('.scrubbing-time-bubble'), 'app.wxss 必须包含全局 .scrubbing-time-bubble 悬浮气泡类定义');
  assert.ok(appWxss.includes('bubblePop'), 'app.wxss 必须包含 bubblePop 丝滑微弹入动效');

  // 6. 验证自适应标尺生成：各缩放等级下刻度间距与总长覆盖
  const rulerTicks = page.data.timelineData.rulerTicks;
  assert.ok(rulerTicks && rulerTicks.length > 0, '标尺刻度数据必须存在');
  assert.strictEqual(rulerTicks[0].sec, 0);

  page.onUnload();
});

smokeTest('v6.6 倍速动态平滑切换、多轨8轨扩容、全幅波形图无截断与吸底按钮布局防遮挡验证', async () => {
  const fileMaster = { path: 'wxfile://tmp/track_master.mp3', size: 10 * 1024 * 1024, name: 'master.mp3' };
  const fileVocal = { path: 'wxfile://tmp/track_vocal.mp3', size: 5 * 1024 * 1024, name: 'vocal.mp3' };
  const stub = createWxStub({
    chooseBatches: [[fileMaster, fileVocal]],
    analyzeResults: [
      makeAnalyzeResponse({ duration: 240 }),
      makeAnalyzeResponse({ duration: 60 }),
    ],
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.onShow();
  await wait(10);

  // 1. 验证音轨初始默认 4 轨，且可一路扩容至 8 条音轨
  assert.strictEqual(page.data.tracks.length, 4, '初始默认应具备 4 条音轨');
  assert.strictEqual(page.data.tracks[0].id, 'T1');
  assert.strictEqual(page.data.tracks[3].id, 'T4');
  
  // 逐一添加音轨至第 8 轨
  page.addTrack(); // T5
  page.addTrack(); // T6
  page.addTrack(); // T7
  page.addTrack(); // T8
  assert.strictEqual(page.tracks.length, 8, '应成功扩容至 8 条音轨');
  
  // 尝试添加第 9 轨被硬限拦截
  page.addTrack();
  assert.strictEqual(page.tracks.length, 8, '超过 8 条音轨时应被硬限拦截');
  const lastToast = stub.calls.toast[stub.calls.toast.length - 1];
  assert.ok(lastToast && lastToast.title.indexOf('最多支持 8 条') >= 0);

  // 2. 导入音频并验证波形全幅生成
  page.chooseAudioFiles();
  await wait(80);
  assert.strictEqual(page.sources.length, 2);
  assert.strictEqual(page.clips.length, 2);

  // 将片段设为 240s 的长音频
  page.clips[0].in = 0;
  page.clips[0].out = 240;
  page.clips[0].speed = 1.0;
  page.refreshClipData();

  // 验证 1.0x 倍速下成片与波形
  const tlData1x = page.data.timelineData;
  const clipTrack1x = tlData1x.tracks.find(t => t.clips && t.clips.length > 0);
  assert.ok(clipTrack1x, '应存在包含片段的轨道');
  const clip0View1x = clipTrack1x.clips[0];
  assert.strictEqual(clip0View1x.timelineEndSec, 240);
  assert.ok(clip0View1x.waveBars.length >= 20, '波形条应充足生成');

  // 3. 启动播放并在播放中动态切换 1.5x 倍速，验证不中断、不从头重置
  page.togglePlayClip();
  assert.strictEqual(page.data.isPlaying, true, '应处于播放中');
  page.currentSourceTime = 30.5; // 播放至 30.5 秒

  // 在播放态下动态切换倍速为 1.5x
  page.setClipSpeed({ currentTarget: { dataset: { value: 1.5 } } });
  assert.strictEqual(page.data.isPlaying, true, '动态调整倍速后必须保持继续播放，绝不中断');
  assert.strictEqual(page.clips[0].speed, 1.5, '片段倍速应正确更新为 1.5x');
  assert.strictEqual(page._playbackSpeed, 1.5, '物理时钟倍速锚点必须同步更新为 1.5x');
  assert.strictEqual(page.currentSourceTime, 30.5, '播放指针必须保留当前秒数，绝不可倒退重置回 00:00');

  // 验证 1.5x 倍速下时间轴占用时长缩短 (240s / 1.5 = 160s)
  const tlData15x = page.data.timelineData;
  const clipTrack15x = tlData15x.tracks.find(t => t.clips && t.clips.length > 0);
  assert.ok(clipTrack15x, '应存在包含片段的轨道');
  const clip0View15x = clipTrack15x.clips[0];
  assert.strictEqual(clip0View15x.timelineEndSec, 160, '1.5x 倍速下时间线末端应等比缩短为 160s');
  assert.strictEqual(clip0View15x.effectiveDuration, 160);

  // 4. 验证 CSS 契约：全幅波形 space-between 与吸底导出按键防遮挡
  const editorWxss = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/editor/editor.wxss'), 'utf-8');
  assert.ok(editorWxss.includes('justify-content: space-between'), '波形容器必须使用 justify-content: space-between 全幅自适应满铺');
  assert.ok(editorWxss.includes('dock-export-action-btn'), '必须包含 dock-export-action-btn 导出按钮样式');
  assert.ok(editorWxss.includes('max-width: 52% !important'), '导出按钮必须限制 max-width 避免覆盖左侧时码');
  assert.ok(editorWxss.includes('width: auto !important'), '导出按钮必须显式强制重置原生宽度');

  page.onUnload();
});

smokeTest('声音工具箱非破坏性实时音效调节与均衡器/变速网格布局美化 (v6.7)', async () => {
  const stub = createWxStub({
    chooseBatches: [
      [{ path: 'wxfile://tmp/song.mp3', name: 'song.mp3', size: 1024 * 1024 }],
    ],
    analyzeResults: [
      makeAnalyzeResponse({ duration: 180, format: 'mp3', playableIos: true, playableAndroid: true }),
    ],
  });
  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.onShow();

  page.chooseAudioFiles();
  await wait(80);
  assert.strictEqual(page.data.status, 'editing');

  // 1. 验证 EQ 预设 8 项完整度与倍速选项 6 项完整度
  assert.strictEqual(page.data.eqPresets.length, 8, 'EQ 预设应包含 8 种对称预设');
  assert.strictEqual(page.data.speedOptions.length, 6, '倍速应包含 6 种标准速度');
  assert.strictEqual(page.data.gainPresets.length, 4, '快捷增益应包含 4 档预设');

  // 2. 启动播放并在播放中动态切换 EQ 预设
  page.togglePlayClip();
  assert.strictEqual(page.data.isPlaying, true, '播放应已开启');
  page.currentSourceTime = 42.5;

  page.setClipEq({ currentTarget: { dataset: { preset: 'warm' } } });
  assert.strictEqual(page.data.isPlaying, true, '动态设置 EQ 时必须保持播放，绝不可中断');
  assert.strictEqual(page.currentSourceTime, 42.5, '当前播放指针必须保持 42.5s');
  assert.strictEqual(page.clips[0].eqPreset, 'warm', '片段 eqPreset 应更新为 warm');
  assert.strictEqual(page.playback.queue[0].eqPreset, 'warm', '播放队列 eqPreset 应同步更新');

  // 3. 动态切换降噪
  page.setClipDenoise({ currentTarget: { dataset: { value: 6 } } });
  assert.strictEqual(page.data.isPlaying, true, '动态设置降噪时必须保持播放');
  assert.strictEqual(page.currentSourceTime, 42.5, '当前播放指针必须保持');
  assert.strictEqual(page.clips[0].denoise, 6, '片段 denoise 应更新为 6');
  assert.strictEqual(page.playback.queue[0].denoise, 6, '播放队列 denoise 应同步更新');

  // 4. 动态滑动片段音量增益
  page.onClipGainChanging({ detail: { value: 5 } });
  assert.strictEqual(page.clips[0].volumeDb, 5, '滑动中片段音量应实时响应');
  assert.strictEqual(page.data.isPlaying, true, '滑动中播放必须持续');

  page.onClipGainChange({ detail: { value: 3 } });
  assert.strictEqual(page.data.isPlaying, true, '松开手势后播放必须持续');
  assert.strictEqual(page.currentSourceTime, 42.5, '当前播放指针必须保持');
  assert.strictEqual(page.clips[0].volumeDb, 3, '片段音量增益应更新为 3');

  // 5. 快捷增益胶囊与复位音量
  page.applyQuickGainPreset({ currentTarget: { dataset: { value: 6 } } });
  assert.strictEqual(page.data.isPlaying, true, '点击快捷增益胶囊后播放必须持续');
  assert.strictEqual(page.clips[0].volumeDb, 6, '片段音量增益应更新为 +6dB');

  page.resetClipGain();
  assert.strictEqual(page.data.isPlaying, true, '复位音量后播放必须持续');
  assert.strictEqual(page.clips[0].volumeDb, 0, '片段音量增益应复位为 0');

  // 6. 动态热切换倍速：平滑过渡不从头开始且时钟锚点连续
  page.setClipSpeed({ currentTarget: { dataset: { value: 1.5 } } });
  assert.strictEqual(page.data.isPlaying, true, '切换倍速必须保持正在播放状态');
  assert.strictEqual(page.clips[0].speed, 1.5, '片段倍速应更新为 1.5x');
  assert.strictEqual(page.currentSourceTime, 42.5, '当前播放指针绝不可跳跃回 0 或开头');

  // 7. 淡入淡出调整时不中断播放且保留片段倍速等其他所有参数
  page.applyClipFade('fadeIn', 1.5);
  assert.strictEqual(page.data.isPlaying, true, '调整淡入时保持播放');
  assert.strictEqual(page.clips[0].fadeIn, 1.5);
  assert.strictEqual(page.clips[0].speed, 1.5, '调整淡入时绝不可丢失已设置的倍速参数');

  // 8. 验证 CSS 契约：3列网格与对称排版
  const editorWxss = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/editor/editor.wxss'), 'utf-8');
  assert.ok(editorWxss.includes('.chips-selector-row.speed-grid'), '必须包含 speed-grid 样式');
  assert.ok(editorWxss.includes('.chips-selector-row.eq-grid'), '必须包含 eq-grid 样式');
  assert.ok(editorWxss.includes('.chips-selector-row.denoise-grid'), '必须包含 denoise-grid 样式');

  page.onUnload();
});

smokeTest('iOS端聊天文件获取与容灾上传优化验证', async () => {
  let uploadAttempts = 0;
  const stub = createWxStub({
    platform: 'ios',
    chooseBatches: [
      [
        // 1. 未在微信本地下载的文件（statSync 抛错）
        { tempFilePath: 'wxfile://tmp/not_downloaded.mp3', name: '未下载.mp3', size: 0 },
        // 2. 大写后缀且使用 tempFilePath 的正常文件
        { tempFilePath: 'wxfile://tmp/REAL_RECORDING.MP3', name: 'REAL_RECORDING.MP3', size: 2 * 1024 * 1024 },
      ],
    ],
    fileSystemManager: {
      statSync(p) {
        if (p.includes('not_downloaded')) {
          throw new Error('file not found');
        }
        return { size: 2 * 1024 * 1024 };
      },
    },
    uploadFile(payload) {
      uploadAttempts++;
      if (uploadAttempts === 1) {
        return Promise.reject(new Error('uploadFile:fail timeout'));
      }
      return Promise.resolve({ fileID: 'cloud://test.edit/' + payload.cloudPath });
    },
    analyzeResults: [makeAnalyzeResponse({ duration: 30 })],
  });

  const page = loadEditorPage(stub.wx);
  page.onLoad();
  page.onShow();

  page.chooseAudioFiles();

  // 1. 验证 wx.chooseMessageFile 参数：type 为 all，且无 extension 参数
  assert.strictEqual(stub.calls.chooseFile.length, 1);
  const chooseCall = stub.calls.chooseFile[0];
  assert.strictEqual(chooseCall.type, 'all', '必须使用 type: all 兼容 iOS 聊天各类消息');
  assert.strictEqual(chooseCall.extension, undefined, 'type 为 all 时不得传 extension，规避 iOS 微信接口异常');

  await wait(800);

  // 2. 验证未下载文件被友好拦截，未导致崩溃
  assert.strictEqual(page.preRejects.length, 0);
  assert.strictEqual(page.data.importFailures.length, 1, '未下载文件应进入 importFailures');
  assert.ok(page.data.importFailures[0].message.includes('尚未在微信中下载'), '文案应明确引导去聊天记录下载');

  // 3. 验证正常文件成功上传与重试
  assert.strictEqual(uploadAttempts, 2, '上传遇到超时应自动重试第 2 次');
  assert.strictEqual(page.sources.length, 1, '大写 MP3 文件应成功导入为 1 个源');
  assert.strictEqual(page.clips.length, 1, '应成功生成 1 个片段');
  assert.strictEqual(page.data.status, 'editing');

  page.onUnload();
});

/* ========================================================================== */
/* 汇总                                                                       */
/* ========================================================================== */

async function main() {
  for (let i = 0; i < pendingSmokeTests.length; i++) {
    await asyncTest(pendingSmokeTests[i].name, pendingSmokeTests[i].fn);
  }
  console.log('\n----------------------------------------');
  if (failures.length) {
    console.log(`结果：${passed} 通过，${failures.length} 失败`);
    failures.forEach((f) => {
      console.log(' - ' + f.name);
      if (f.err && f.err.stack) console.log('   ' + f.err.stack.split('\n').slice(0, 10).join('\n   '));
    });
    process.exit(1);
  }
  console.log(`结果：${passed} 项全部通过`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
