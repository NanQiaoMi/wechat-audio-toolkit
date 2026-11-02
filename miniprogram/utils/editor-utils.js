/**
 * 音乐剪辑页纯函数工具 v2（不依赖 wx / DOM / 第三方库，可在 Node 中直接单测）。
 *
 * v2 数据模型（契约 docs/EDITOR_IMPL_CONTRACT.md §6.2）：
 * - sources: [{ id, fileID, localPath, name, size, duration, format, sampleRate, channels,
 *              peaks: {peak: Uint8Array, rms: Uint8Array}, bucketMs, playable, metaText }]
 * - clips:   [{ id, sourceId, in, out, fadeIn, fadeOut }]，数组顺序即成片顺序
 * - 每个 clip 独立淡入淡出；fadeIn+fadeOut > 片段时长时按比例缩短（与后端 editor-core 一致）
 *
 * 约定：所有函数不修改入参，返回新数组/新对象。
 */

'use strict';

var AUDIO_EXTENSIONS = ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'amr', 'ape', 'wma'];
var MAX_FILE_BYTES = 50 * 1024 * 1024; // 单个源文件 50MB
var MAX_PLAN_DURATION = 600; // 成片总时长上限：10 分钟
var MAX_SOURCES = 5; // 最多 5 个源文件
var MAX_CLIPS = 40; // 最多 40 个片段
var MIN_CLIP_DURATION = 0.2; // 单片段最短 0.2s（云函数硬校验）
var MIN_SELECTION_DURATION = 0.2; // 选区最短 0.2s
var MAX_FADE_SEC = 5; // 单片段淡入/淡出上限（与后端一致；UI 只提供 0~3s）
var FADE_OPTIONS = [0, 0.5, 1, 2, 3]; // 每片段淡入/淡出可选值（秒）

// ---- 纯净通用音轨定义 (Track 1, Track 2... 支持拓展至 8 轨) ----
var TRACK_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#E11D48', '#84CC16'];

var TRACK_DEFS = [
  { id: 'T1', name: '音轨 1', color: '#3B82F6', tag: '1' },
  { id: 'T2', name: '音轨 2', color: '#10B981', tag: '2' },
  { id: 'T3', name: '音轨 3', color: '#F59E0B', tag: '3' },
  { id: 'T4', name: '音轨 4', color: '#8B5CF6', tag: '4' },
];

var SPEED_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

var EQ_PRESETS = [
  { key: 'flat', label: '原声无染', icon: '⚖️', desc: '纯净标准频响，无声染色' },
  { key: 'vocal', label: '清晰人声', icon: '🎙️', desc: '提亮 1~3kHz 中频，切除浑浊低频' },
  { key: 'radio', label: '复古电台', icon: '📻', desc: '带通滤波模拟经典收音机与老电话' },
  { key: 'bass', label: '澎湃低音', icon: '🎧', desc: '增强 80~120Hz 律动与低频厚度' },
  { key: 'treble', label: '明亮空气', icon: '✨', desc: '提升 6~10kHz 高频，清脆通透' },
  { key: 'warm', label: '温暖黑胶', icon: '💿', desc: '提升温暖中低频，抚平高频毛刺与燥感' }
];

var DENOISE_OPTIONS = [
  { val: 0, label: '关闭' },
  { val: 3, label: '轻度 3dB' },
  { val: 6, label: '中度 6dB' },
  { val: 12, label: '深度 12dB' }
];

var ZOOM_LEVELS = [1.0, 1.5, 2.0, 3.0];

var BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var base64Lookup = null;

/* -------------------------------------------------------------------------- */
/* 基础工具                                                                    */
/* -------------------------------------------------------------------------- */

function pad2(value) {
  var n = Math.floor(value);
  return n < 10 ? '0' + n : String(n);
}

function toNumber(value, fallback) {
  var n = Number(value);
  return isFinite(n) ? n : (typeof fallback === 'number' ? fallback : 0);
}

function toNonNegative(value) {
  var n = Number(value);
  return isFinite(n) && n > 0 ? n : 0;
}

function clampNumber(value, min, max) {
  var n = toNumber(value, 0);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function clampUnit(value) {
  return clampNumber(value, 0, 1);
}

function roundTo(value, digits) {
  var d = typeof digits === 'number' ? digits : 0;
  var p = Math.pow(10, d);
  return Math.round(toNumber(value, 0) * p) / p;
}

function round3(value) {
  return roundTo(value, 3);
}

/** 吸附到指定步长（默认 0.1s），用于选区两端。 */
function snapTime(seconds, step) {
  var s = toNumber(step, 0.1);
  if (s <= 0) return Math.max(0, toNumber(seconds, 0));
  return Math.max(0, Math.round(toNumber(seconds, 0) / s) * s);
}

/* -------------------------------------------------------------------------- */
/* 格式化                                                                      */
/* -------------------------------------------------------------------------- */

/** 00:00（用于总时长/片段时长展示）。 */
function formatClock(seconds) {
  var total = Math.floor(toNumber(seconds, 0) + 1e-6);
  if (total < 0) total = 0;
  return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
}

/** 00:00.0（0.1s 精度，用于选区起止 / 播放头）。 */
function formatPrecise(seconds) {
  var totalTenths = Math.round(toNumber(seconds, 0) * 10);
  if (totalTenths < 0) totalTenths = 0;
  var mins = Math.floor(totalTenths / 600);
  var rest = totalTenths - mins * 600;
  return pad2(mins) + ':' + pad2(Math.floor(rest / 10)) + '.' + (rest % 10);
}

/** 59.0 秒 / 1 分 02.5 秒（用于 toast 文案）。 */
function formatSecondsLabel(seconds) {
  var s = Math.max(0, toNumber(seconds, 0));
  if (s < 60) return s.toFixed(1) + ' 秒';
  var mins = Math.floor(s / 60);
  var rest = s - mins * 60;
  return mins + ' 分 ' + (rest < 10 ? '0' : '') + rest.toFixed(1) + ' 秒';
}

function formatBytes(bytes) {
  var b = toNumber(bytes, 0);
  if (!b || b <= 0) return '0 B';
  var k = 1024;
  var sizes = ['B', 'KB', 'MB', 'GB'];
  var i = Math.floor(Math.log(b) / Math.log(k));
  if (i < 0) i = 0;
  if (i > sizes.length - 1) i = sizes.length - 1;
  return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDb(db) {
  var v = Math.round(toNumber(db, 0));
  return (v > 0 ? '+' : '') + v + ' dB';
}

function dbToGain(db) {
  return clampUnit(Math.pow(10, toNumber(db, 0) / 20));
}

/** 淡入淡出值展示：0 -> "0s"，0.5 -> "0.5s"，2 -> "2s"。 */
function formatFade(value) {
  var v = toNonNegative(value);
  if (v <= 0) return '0s';
  return (Math.round(v * 10) / 10) + 's';
}

/* -------------------------------------------------------------------------- */
/* 文件 / 上传                                                                 */
/* -------------------------------------------------------------------------- */

function getFileExtension(fileName) {
  if (!fileName || typeof fileName !== 'string') return '';
  var clean = fileName.split('?')[0].split('#')[0];
  var idx = clean.lastIndexOf('.');
  if (idx < 0 || idx === clean.length - 1) return '';
  return clean.slice(idx + 1).toLowerCase();
}

function isAllowedAudioExtension(ext) {
  return AUDIO_EXTENSIONS.indexOf(String(ext || '').toLowerCase()) >= 0;
}

/**
 * 本地预检：扩展名 / 空文件 / 50MB。
 * @returns {{ok:boolean, code?:string, message?:string, ext?:string, size?:number}}
 */
function validateLocalFile(file, limits) {
  var opts = limits || {};
  var maxBytes = typeof opts.maxBytes === 'number' ? opts.maxBytes : MAX_FILE_BYTES;
  if (!file || !file.name) {
    return { ok: false, code: 'INVALID_FILE', message: '没有获取到文件信息，请重新选择。' };
  }
  var ext = getFileExtension(file.name);
  if (!isAllowedAudioExtension(ext)) {
    return {
      ok: false,
      code: 'EXT_NOT_ALLOWED',
      message: '暂不支持该文件格式。请选择 MP3 / WAV / M4A / AAC / FLAC / OGG / AMR / APE / WMA 音频。',
    };
  }
  var size = toNumber(file.size, 0);
  if (size <= 0) {
    return { ok: false, code: 'EMPTY_FILE', message: '这个文件是空的，请换一个音频文件。' };
  }
  if (size > maxBytes) {
    return {
      ok: false,
      code: 'FILE_TOO_LARGE',
      message: '单文件请控制在 50MB 以内，当前文件 ' + formatBytes(size) + '。',
    };
  }
  return { ok: true, ext: ext, size: size };
}

/** edit_sources/{ts}_{rand}.{ext}（与契约 §3 一致）。 */
function buildCloudPath(ext, timestamp, random) {
  var safeExt = String(ext || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp3';
  var ts = timestamp || Date.now();
  var rnd = String(random || Math.random().toString(36).slice(2, 8)).replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'rand';
  return 'edit_sources/' + ts + '_' + rnd + '.' + safeExt;
}

/* -------------------------------------------------------------------------- */
/* 波形 peaks（base64 -> Uint8Array）                                          */
/* -------------------------------------------------------------------------- */

function getBase64Lookup() {
  if (base64Lookup) return base64Lookup;
  base64Lookup = new Int16Array(128);
  for (var i = 0; i < 128; i++) base64Lookup[i] = -1;
  for (var j = 0; j < BASE64_CHARS.length; j++) {
    base64Lookup[BASE64_CHARS.charCodeAt(j)] = j;
  }
  return base64Lookup;
}

/**
 * 解析服务端返回的 base64 uint8 数组（兼容 URL-safe 与换行）。
 * 手写实现而不依赖 wx.base64ToArrayBuffer，方便在 Node 中单测。
 */
function decodeBase64ToUint8(input) {
  if (!input || typeof input !== 'string') return new Uint8Array(0);
  var lookup = getBase64Lookup();
  var clean = input.replace(/-/g, '+').replace(/_/g, '/').split('=')[0];
  var out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  var buffer = 0;
  var bits = 0;
  var pos = 0;
  for (var i = 0; i < clean.length; i++) {
    var code = clean.charCodeAt(i);
    var value = code < 128 ? lookup[code] : -1;
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[pos++] = (buffer >> bits) & 0xff;
    }
  }
  return pos === out.length ? out : out.subarray(0, pos);
}

/** 解析 analyzeAudio 返回的 peaks 字段。 */
function parsePeaks(data) {
  var peaks = (data && data.peaks) || {};
  return {
    peak: decodeBase64ToUint8(peaks.peak || ''),
    rms: decodeBase64ToUint8(peaks.rms || ''),
  };
}

/**
 * 截取源音频在 [inSec, outSec] 区间内的真实波形切片（归一化百分比高度 15%~95%）。
 */
function sliceClipWaveBars(src, inSec, outSec, targetBarCount) {
  var count = typeof targetBarCount === 'number' && targetBarCount > 0 ? targetBarCount : 30;
  if (!src || !src.peaks || !src.peaks.length || typeof src.duration !== 'number' || src.duration <= 0) {
    var dummy = [];
    for (var d = 0; d < count; d++) {
      var wave = Math.round(32 + Math.sin(d * 0.45) * 26 + Math.sin(d * 1.3) * 16 + (d % 3) * 8);
      dummy.push({ id: d, h: Math.max(16, Math.min(94, wave)) });
    }
    return dummy;
  }

  var peaks = src.peaks;
  var totalBuckets = peaks.length;
  var bucketSec = src.bucketMs ? src.bucketMs / 1000 : 0.05;
  var startB = Math.max(0, Math.floor(inSec / bucketSec));
  var endB = Math.min(totalBuckets, Math.ceil(outSec / bucketSec));
  var range = Math.max(1, endB - startB);

  var bars = [];
  for (var i = 0; i < count; i++) {
    var bStart = startB + Math.floor((i * range) / count);
    var bEnd = startB + Math.floor(((i + 1) * range) / count);
    if (bEnd <= bStart) bEnd = bStart + 1;
    var maxVal = 0;
    for (var b = bStart; b < bEnd && b < totalBuckets; b++) {
      if (peaks[b] > maxVal) maxVal = peaks[b];
    }
    var percent = Math.round(16 + (maxVal / 255) * 80);
    bars.push({ id: i, h: Math.max(16, Math.min(96, percent)) });
  }
  return bars;
}

/* -------------------------------------------------------------------------- */
/* 片段（clips）计算                                                           */
/* -------------------------------------------------------------------------- */

/** 片段时长（秒）；非法返回 0。 */
function clipDuration(clip) {
  if (!clip) return 0;
  var start = Number(clip.in);
  var end = Number(clip.out);
  if (!isFinite(start) || !isFinite(end) || end <= start) return 0;
  return end - start;
}

/** 成片总时长 = Σ((out-in)/speed)。考虑各分段倍速对最终成品总长的真实影响。 */
function planDuration(clips) {
  var list = Array.isArray(clips) ? clips : [];
  var sum = 0;
  for (var i = 0; i < list.length; i++) {
    var cl = list[i];
    var sp = cl && cl.speed && cl.speed > 0 ? cl.speed : 1.0;
    sum += clipDuration(cl) / sp;
  }
  return sum;
}

function copyClip(clip) {
  var src = clip || {};
  var out = {
    id: src.id,
    sourceId: src.sourceId,
    in: toNumber(src.in, 0),
    out: toNumber(src.out, 0),
    fadeIn: toNonNegative(src.fadeIn),
    fadeOut: toNonNegative(src.fadeOut),
  };
  if (src.trackId !== undefined) out.trackId = src.trackId;
  if (src.offsetSec !== undefined) out.offsetSec = toNonNegative(src.offsetSec);
  if (src.volumeDb !== undefined) out.volumeDb = roundTo(clampNumber(src.volumeDb, -24, 12), 1);
  if (src.speed !== undefined) out.speed = isFinite(Number(src.speed)) && Number(src.speed) > 0 ? Number(src.speed) : 1.0;
  if (src.eqPreset !== undefined) out.eqPreset = src.eqPreset;
  if (src.denoise !== undefined) out.denoise = src.denoise;
  if (src.pan !== undefined) out.pan = src.pan;
  return out;
}

function copyClips(clips) {
  return (Array.isArray(clips) ? clips : []).map(copyClip);
}

function sourceMap(sources) {
  var map = Object.create(null);
  var list = Array.isArray(sources) ? sources : [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id) map[list[i].id] = list[i];
  }
  return map;
}

function findSource(sources, sourceId) {
  var list = Array.isArray(sources) ? sources : [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === sourceId) return list[i];
  }
  return null;
}

/** 片段 id 在 clips 中的下标；找不到返回 -1。 */
function findClipIndexById(clips, clipId) {
  var list = Array.isArray(clips) ? clips : [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === clipId) return i;
  }
  return -1;
}

/**
 * 单片段淡入淡出归一：先按 ≤5s 封顶，再保证 fadeIn+fadeOut ≤ 片段时长（等比缩短）。
 * 与后端 editor-core.applyFades 规则一致，保证预览与成片一致。
 * @returns {{fadeIn:number, fadeOut:number, adjusted:boolean}}
 */
function effectiveClipFades(clip) {
  return resolveFades(clip && clip.fadeIn, clip && clip.fadeOut, clipDuration(clip));
}

/**
 * 导出前校验（服务端会再校验一次）。
 * @returns {{ok:boolean, code?:string, message?:string}}
 */
function validateClips(clips, sources, options) {
  var opts = options || {};
  var list = Array.isArray(clips) ? clips : [];
  var sourceList = Array.isArray(sources) ? sources : [];
  var maxDuration = typeof opts.maxDuration === 'number' ? opts.maxDuration : MAX_PLAN_DURATION;
  var minClip = typeof opts.minClip === 'number' ? opts.minClip : MIN_CLIP_DURATION;
  var maxClips = typeof opts.maxClips === 'number' ? opts.maxClips : MAX_CLIPS;
  var maxSources = typeof opts.maxSources === 'number' ? opts.maxSources : MAX_SOURCES;

  if (!sourceList.length) {
    return { ok: false, code: 'NO_SOURCES', message: '还没有可用的音频源，请先选择音频。' };
  }
  if (sourceList.length > maxSources) {
    return { ok: false, code: 'TOO_MANY_SOURCES', message: '最多支持 ' + maxSources + ' 个音频源。' };
  }
  if (!list.length) {
    return { ok: false, code: 'NO_CLIPS', message: '还没有可导出的片段，请先添加音频。' };
  }
  if (list.length > maxClips) {
    return { ok: false, code: 'TOO_MANY_CLIPS', message: '片段数超过 ' + maxClips + ' 段，请合并或删除片段。' };
  }

  var map = sourceMap(sourceList);
  var total = 0;
  for (var i = 0; i < list.length; i++) {
    var clip = list[i] || {};
    var start = Number(clip.in);
    var end = Number(clip.out);
    if (!clip.sourceId || !map[clip.sourceId]) {
      return { ok: false, code: 'INVALID_SOURCE', message: '片段引用的音频不存在，请撤销或重新导入。' };
    }
    if (!isFinite(start) || !isFinite(end) || start < 0 || end <= start) {
      return { ok: false, code: 'INVALID_CLIP', message: '片段时间参数异常，请撤销后重试。' };
    }
    if (end - start < minClip - 1e-6) {
      return {
        ok: false,
        code: 'CLIP_TOO_SHORT',
        message: '第 ' + (i + 1) + ' 段短于 ' + minClip + ' 秒，请调整片段后再导出。',
      };
    }
    total += end - start;
  }

  if (total > maxDuration + 1e-6) {
    return {
      ok: false,
      code: 'DURATION_TOO_LONG',
      message: '成片超过 ' + Math.floor(maxDuration / 60) + ' 分钟，请删减片段或缩短后再导出。',
    };
  }
  if (total < minClip - 1e-6) {
    return { ok: false, code: 'DURATION_TOO_SHORT', message: '成片至少保留 ' + minClip + ' 秒。' };
  }
  return { ok: true };
}

/** 移动片段（调整拼接顺序）；返回新数组。 */
function moveClip(clips, fromIndex, toIndex) {
  var list = copyClips(clips);
  var from = Number(fromIndex);
  var to = Number(toIndex);
  if (!isFinite(from) || !isFinite(to) || from < 0 || from >= list.length || to < 0 || to >= list.length) {
    return { ok: false, clips: list, message: '无法移动片段。' };
  }
  if (from === to) return { ok: true, clips: list };
  var moved = list.splice(from, 1)[0];
  list.splice(to, 0, moved);
  return { ok: true, clips: list };
}

/** 删除片段；至少保留 1 段。 */
function removeClip(clips, index) {
  var list = copyClips(clips);
  var i = Number(index);
  if (!isFinite(i) || i < 0 || i >= list.length) return { ok: false, clips: list, message: '片段不存在。' };
  if (list.length <= 1) return { ok: false, clips: list, message: '至少保留 1 个片段，可以直接重新导入音频。' };
  list.splice(i, 1);
  return { ok: true, clips: list };
}

/**
 * 在播放头（源时间 time）处把第 index 段切成两段：
 * 前段保留 fadeIn、后段保留 fadeOut，两段都必须 ≥0.2s。
 * @param {string} newId 新片段的 id（由页面生成，保证唯一）
 */
function splitClipAt(clips, index, time, newId) {
  var list = copyClips(clips);
  var i = Number(index);
  if (!isFinite(i) || i < 0 || i >= list.length) return { ok: false, clips: list, message: '片段不存在。' };
  var clip = list[i];
  var t = round3(time);
  if (!isFinite(t)) return { ok: false, clips: list, message: '播放头位置无效。' };
  if (t - clip.in < MIN_CLIP_DURATION - 1e-9) {
    return { ok: false, clips: list, message: '播放头太靠近片段开头，两段都至少需要 0.2 秒。' };
  }
  if (clip.out - t < MIN_CLIP_DURATION - 1e-9) {
    return { ok: false, clips: list, message: '播放头太靠近片段结尾，两段都至少需要 0.2 秒。' };
  }
  var first = { id: clip.id, sourceId: clip.sourceId, in: round3(clip.in), out: t, fadeIn: clip.fadeIn, fadeOut: 0 };
  var second = {
    id: newId || clip.id + '_split_' + Math.round(t * 1000),
    sourceId: clip.sourceId,
    in: t,
    out: round3(clip.out),
    fadeIn: 0,
    fadeOut: clip.fadeOut,
  };
  ['trackId', 'offsetSec', 'volumeDb', 'speed', 'eqPreset', 'denoise', 'pan', 'isDuplicate'].forEach(function (k) {
    if (clip[k] !== undefined) {
      first[k] = clip[k];
      second[k] = clip[k];
    }
  });
  if (clip.offsetSec !== undefined) {
    second.offsetSec = round3(toNonNegative(clip.offsetSec) + (t - clip.in));
  }
  list.splice(i, 1, first, second);
  return { ok: true, clips: list };
}

/** 裁剪片段到 [start, end]（选区），保留原 id 与淡入淡出设置。 */
function cropClipToRange(clip, start, end) {
  if (!clip) return { ok: false, clip: null, message: '片段不存在。' };
  var a = Number(start);
  var b = Number(end);
  if (!isFinite(a) || !isFinite(b)) return { ok: false, clip: null, message: '选区无效。' };
  if (b < a) {
    var tmp = a;
    a = b;
    b = tmp;
  }
  a = round3(a);
  b = round3(b);
  if (b - a < MIN_CLIP_DURATION - 1e-9) {
    return { ok: false, clip: null, message: '选区太短了，片段至少 0.2 秒。' };
  }
  var cropped = {
    id: clip.id,
    sourceId: clip.sourceId,
    in: a,
    out: b,
    fadeIn: toNonNegative(clip.fadeIn),
    fadeOut: toNonNegative(clip.fadeOut),
  };
  ['trackId', 'offsetSec', 'volumeDb', 'speed', 'eqPreset', 'denoise', 'pan'].forEach(function (k) {
    if (clip[k] !== undefined) cropped[k] = clip[k];
  });
  return { ok: true, clip: cropped };
}

/** 重置片段为所属源的完整时长。 */
function resetClipToFull(clip, sourceDuration) {
  if (!clip) return { ok: false, clip: null, message: '片段不存在。' };
  var dur = Number(sourceDuration);
  if (!isFinite(dur) || dur < MIN_CLIP_DURATION) return { ok: false, clip: null, message: '源音频时长异常，无法重置。' };
  var reset = {
    id: clip.id,
    sourceId: clip.sourceId,
    in: 0,
    out: round3(dur),
    fadeIn: toNonNegative(clip.fadeIn),
    fadeOut: toNonNegative(clip.fadeOut),
  };
  ['trackId', 'offsetSec', 'volumeDb', 'speed', 'eqPreset', 'denoise', 'pan'].forEach(function (k) {
    if (clip[k] !== undefined) reset[k] = clip[k];
  });
  return { ok: true, clip: reset };
}

/**
 * ripple delete：在「选中片段所属源」的时间轴上删除 [start, end]，
 * 同一源的所有片段都会被切分（选区在边缘时只保留一侧），<0.2s 残片丢弃。
 * 其它源片段按原顺序保留。
 * @param {number} [minDuration]
 * @param {Function} [makeId] 右半段 id 工厂（页面传入以保证全局唯一；单测可省略）
 * @returns {{ok:boolean, clips:Array, removed:number, dropped:number, message?:string}}
 */
function rippleDeleteSelection(clips, sourceId, start, end, minDuration, makeId) {
  var list = copyClips(clips);
  var minDur = typeof minDuration === 'number' ? minDuration : MIN_CLIP_DURATION;
  var from = Math.min(toNumber(start, 0), toNumber(end, 0));
  var to = Math.max(toNumber(start, 0), toNumber(end, 0));
  if (to - from <= 1e-9) {
    return { ok: false, clips: list, removed: 0, dropped: 0, message: '选区无效。' };
  }

  var out = [];
  var removed = 0;
  var dropped = 0;
  var rightSeq = 0;

  for (var i = 0; i < list.length; i++) {
    var clip = list[i];
    if (!sourceId || clip.sourceId !== sourceId) {
      out.push(clip);
      continue;
    }
    // 无交集：整段保留
    if (to <= clip.in || from >= clip.out) {
      out.push(clip);
      continue;
    }
    var overlap = Math.min(clip.out, to) - Math.max(clip.in, from);
    if (overlap > 0) removed += overlap;

    var leftEnd = Math.min(clip.out, from);
    if (leftEnd > clip.in) {
      if (leftEnd - clip.in >= minDur - 1e-9) {
        out.push({
          id: clip.id,
          sourceId: clip.sourceId,
          in: clip.in,
          out: round3(leftEnd),
          fadeIn: clip.fadeIn,
          fadeOut: 0,
        });
      } else {
        dropped++;
      }
    }
    var rightStart = Math.max(clip.in, to);
    if (clip.out > rightStart) {
      if (clip.out - rightStart >= minDur - 1e-9) {
        rightSeq++;
        var rightId = typeof makeId === 'function' ? makeId() : clip.id + '_r' + rightSeq;
        out.push({
          id: rightId,
          sourceId: clip.sourceId,
          in: round3(rightStart),
          out: clip.out,
          fadeIn: 0,
          fadeOut: clip.fadeOut,
        });
      } else {
        dropped++;
      }
    }
  }

  if (!out.length) {
    return { ok: false, clips: [], removed: removed, dropped: dropped, message: '删除后没有可导出的片段了。' };
  }
  return { ok: true, clips: out, removed: removed, dropped: dropped };
}

function getEqPreset(key) {
  for (var i = 0; i < EQ_PRESETS.length; i++) {
    if (EQ_PRESETS[i].key === key) return EQ_PRESETS[i];
  }
  return EQ_PRESETS[0];
}

/** 片段 -> WXML 展示结构。 */
function toClipViews(clips, sources) {
  var map = sourceMap(sources);
  var list = Array.isArray(clips) ? clips : [];
  var seenSources = Object.create(null);
  var views = [];
  for (var i = 0; i < list.length; i++) {
    var clip = list[i] || {};
    var dur = clipDuration(clip);
    var src = map[clip.sourceId];
    var isDuplicate = !!clip.isDuplicate;
    if (clip.sourceId) {
      if (seenSources[clip.sourceId]) {
        isDuplicate = true;
      } else {
        seenSources[clip.sourceId] = true;
      }
    }
    var fades = effectiveClipFades(clip);
    var fadeIn = toNonNegative(clip.fadeIn);
    var fadeOut = toNonNegative(clip.fadeOut);
    var parts = [];
    if (fadeIn > 0) parts.push('淡入' + formatFade(fadeIn));
    if (fadeOut > 0) parts.push('淡出' + formatFade(fadeOut));

    var speed = clip.speed && clip.speed > 0 ? clip.speed : 1.0;
    var eqPreset = clip.eqPreset || 'flat';
    var eqInfo = getEqPreset(eqPreset);
    var denoise = typeof clip.denoise === 'number' ? clip.denoise : 0;
    var volumeDb = roundTo(clip.volumeDb || 0, 1);
    var trackId = clip.trackId || 'T1';

    views.push({
      id: clip.id,
      index: i,
      sourceId: clip.sourceId,
      sourceName: src ? src.name : '未知音频',
      isDuplicate: isDuplicate,
      duration: dur,
      durationText: formatPrecise(dur),
      in: toNonNegative(clip.in),
      out: toNonNegative(clip.out),
      inText: formatPrecise(clip.in),
      outText: formatPrecise(clip.out),
      fadeIn: fadeIn,
      fadeOut: fadeOut,
      fadeInText: formatFade(fadeIn),
      fadeOutText: formatFade(fadeOut),
      fadeLabel: parts.join(' / '),
      hasFade: fadeIn > 0 || fadeOut > 0,
      fadeAdjusted: fades.adjusted,
      trackId: trackId,
      offsetSec: toNonNegative(clip.offsetSec),
      speed: speed,
      speedText: speed !== 1.0 ? speed + 'x' : '',
      eqPreset: eqPreset,
      eqLabel: eqInfo.label,
      eqIcon: eqInfo.icon,
      denoise: denoise,
      denoiseText: denoise > 0 ? denoise + 'dB' : '',
      volumeDb: volumeDb,
      volumeText: volumeDb !== 0 ? formatDb(volumeDb) : '',
      hasFx: speed !== 1.0 || eqPreset !== 'flat' || denoise > 0 || Math.abs(volumeDb) > 0.5,
      waveBars: sliceClipWaveBars(src, clip.in, clip.out, 20),
    });
  }
  return views;
}

/**
 * 将 clips 按照音轨分组渲染
 */
function toTrackViews(tracks, clips, sources, zoomScale, selectedClipIndex) {
  var data = buildTimelineData(tracks, clips, sources, zoomScale, selectedClipIndex, 0);
  return data.tracks;
}

/**
 * 纯净通用多轨时间线数据构建
 * 标尺与所有音轨共享同一物理时间轴，并支持毫秒级精准缩放
 */
function buildTimelineData(tracks, clips, sources, zoomScale, selectedClipIndex, playheadSec, options) {
  var trackList = Array.isArray(tracks) && tracks.length ? tracks : TRACK_DEFS;
  var scale = typeof zoomScale === 'number' && zoomScale > 0 ? zoomScale : 1.0;
  var pxPerSec = Math.max(0.5, 36 * scale); // 每秒占据的 rpx 像素数（支持全览微缩）
  var playhead = typeof playheadSec === 'number' && playheadSec >= 0 ? playheadSec : 0;
  var isPinching = !!(options && options.isPinching);
  var clipViews = toClipViews(clips, sources);
  var sMap = sourceMap(sources);

  var trackMap = {};
  for (var t = 0; t < trackList.length; t++) {
    var trk = trackList[t];
    trackMap[trk.id] = {
      id: trk.id,
      name: trk.name || ('音轨 ' + (t + 1)),
      color: trk.color || TRACK_COLORS[t % TRACK_COLORS.length] || '#3B82F6',
      tag: trk.tag || String(t + 1),
      mute: !!trk.mute,
      solo: !!trk.solo,
      ducking: !!trk.ducking,
      volumeDb: roundTo(trk.volumeDb || 0, 1),
      clips: [],
      currentTrackEndSec: 0,
      addAudioLeftRpx: 0,
    };
  }

  var defaultTrackId = trackList[0] ? trackList[0].id : 'T1';
  var maxTimelineSec = 8;

  for (var c = 0; c < clipViews.length; c++) {
    var cv = clipViews[c];
    var tid = cv.trackId;
    if (!tid || !trackMap[tid]) {
      tid = defaultTrackId;
      cv.trackId = defaultTrackId;
    }

    var targetTrack = trackMap[tid];
    var speed = cv.speed && cv.speed > 0 ? cv.speed : 1.0;
    var dur = cv.duration;
    // 片段在时间轴上的物理占用时长受倍速影响（2x 倍速耗时减半，0.5x 倍速耗时翻倍）
    var effectiveDur = round3(dur / speed);
    // 紧凑排布或指定偏移
    var startSec = 0;
    if (typeof cv.offsetSec === 'number' && cv.offsetSec > 0) {
      startSec = cv.offsetSec;
    } else {
      startSec = targetTrack.currentTrackEndSec;
    }
    var endSec = round3(startSec + effectiveDur);
    targetTrack.currentTrackEndSec = endSec;
    if (endSec > maxTimelineSec) {
      maxTimelineSec = endSec;
    }

    var minWidthRpx = Math.max(24, Math.min(140, Math.round(140 * scale)));
    var widthRpx = Math.max(minWidthRpx, Math.round(effectiveDur * pxPerSec));
    var leftRpx = Math.round(startSec * pxPerSec);
    var src = sMap[cv.sourceId];
    // 密集波形：常态自适应满铺，全幅延展无留白；双指缩放手势期间自适应轻量化(最高36柱)，保障 60FPS 极速手势响应
    var barPitchRpx = 8;
    var dynamicBarCount = isPinching
      ? Math.max(8, Math.min(28, Math.floor(widthRpx / 16)))
      : Math.max(20, Math.min(360, Math.floor(widthRpx / barPitchRpx)));
    var dynamicWaveBars = sliceClipWaveBars(src, cv.in, cv.out, dynamicBarCount);

    var item = Object.assign({}, cv, {
      trackName: targetTrack.name,
      trackColor: targetTrack.color,
      timelineStartSec: startSec,
      timelineEndSec: endSec,
      effectiveDuration: effectiveDur,
      effectiveDurationText: formatPrecise(effectiveDur),
      widthRpx: widthRpx,
      leftRpx: leftRpx,
      isSelected: selectedClipIndex === c,
      waveBars: dynamicWaveBars,
      isOverlapping: false,
      overlapDeltaSec: 0,
      overlapText: '',
    });
    targetTrack.clips.push(item);
  }

  // 生产级防碰撞与片段重叠检测：逐轨排查是否存在物理时隙交叠
  var totalHasOverlap = false;
  for (var trkKey in trackMap) {
    var trkItem = trackMap[trkKey];
    var laneClips = trkItem.clips;
    trkItem.hasOverlap = false;
    for (var i = 0; i < laneClips.length; i++) {
      for (var j = i + 1; j < laneClips.length; j++) {
        var clipA = laneClips[i];
        var clipB = laneClips[j];
        var overlapStart = Math.max(clipA.timelineStartSec, clipB.timelineStartSec);
        var overlapEnd = Math.min(clipA.timelineEndSec, clipB.timelineEndSec);
        // 重叠阈值大于 0.05 秒即判定为物理碰撞
        if (overlapEnd - overlapStart > 0.05) {
          var deltaSec = round3(overlapEnd - overlapStart);
          clipA.isOverlapping = true;
          clipA.overlapDeltaSec = Math.max(clipA.overlapDeltaSec || 0, deltaSec);
          clipA.overlapText = '重叠 ' + clipA.overlapDeltaSec.toFixed(1) + 's';

          clipB.isOverlapping = true;
          clipB.overlapDeltaSec = Math.max(clipB.overlapDeltaSec || 0, deltaSec);
          clipB.overlapText = '重叠 ' + clipB.overlapDeltaSec.toFixed(1) + 's';

          trkItem.hasOverlap = true;
          totalHasOverlap = true;
        }
      }
    }
  }

  // 10 分钟导出限额界标与超出判定 (MAX_PLAN_DURATION = 600s)
  var ceilingSec = MAX_PLAN_DURATION;
  var ceilingRpx = Math.round(ceilingSec * pxPerSec);
  var isExceededCeiling = maxTimelineSec > ceilingSec;
  var ceilingExceededSec = isExceededCeiling ? round3(maxTimelineSec - ceilingSec) : 0;

  // 标尺总宽度与留白
  var timelineWidthRpx = Math.max(540, Math.round(maxTimelineSec * pxPerSec) + 120);
  var playheadRpx = Math.round(playhead * pxPerSec);

  // 动态标尺刻度：自适应像素密度计算，确保刻度文字间距至少 60rpx，永不重叠拥挤，且完整覆盖 10 分钟全景
  var minSeparationRpx = 60;
  var targetStep = minSeparationRpx / Math.max(0.1, pxPerSec);
  var stepCandidates = [1, 2, 5, 10, 15, 30, 60, 120, 300];
  var stepSec = 300;
  for (var k = 0; k < stepCandidates.length; k++) {
    if (stepCandidates[k] >= targetStep) {
      stepSec = stepCandidates[k];
      break;
    }
  }

  var rulerTicks = [];
  var maxSafeTicks = 500;
  var tickCount = 0;
  var endSec = maxTimelineSec + stepSec;
  for (var s = 0; s <= endSec && tickCount < maxSafeTicks; s += stepSec) {
    rulerTicks.push({
      sec: s,
      text: formatClock(s),
      leftRpx: Math.round(s * pxPerSec),
    });
    tickCount++;
  }

  var tracksResult = [];
  for (var i = 0; i < trackList.length; i++) {
    var tItem = trackMap[trackList[i].id];
    tItem.addAudioLeftRpx = Math.round(tItem.currentTrackEndSec * pxPerSec);
    tracksResult.push(tItem);
  }

  return {
    tracks: tracksResult,
    rulerTicks: rulerTicks,
    timelineWidthRpx: timelineWidthRpx,
    playheadRpx: playheadRpx,
    maxTimelineSec: maxTimelineSec,
    pxPerSec: pxPerSec,
    hasOverlap: totalHasOverlap,
    ceilingRpx: ceilingRpx,
    ceilingSec: ceilingSec,
    isExceededCeiling: isExceededCeiling,
    ceilingExceededSec: ceilingExceededSec,
  };
}

/**
 * 当同轨片段被切开重叠或发生碰撞时，自动将后一段🎵下移至下一个音轨中，并标记为重复分段
 * @param {Array} tracks 轨道定义列表
 * @param {Array} clips 片段列表
 * @returns {{ shifted: boolean, tracks: Array, clips: Array, movedInfo?: object }}
 */
function shiftOverlappingClipsToNextTrack(tracks, clips) {
  var trackList = (tracks && tracks.length ? tracks : TRACK_DEFS).map(function(t) {
    return Object.assign({}, t);
  });
  var clipList = copyClips(clips);
  var anyShifted = false;
  var movedInfo = null;

  var maxLoops = 10;
  var loop = 0;

  while (loop < maxLoops) {
    loop++;
    var foundOverlap = false;

    for (var t = 0; t < trackList.length; t++) {
      var trk = trackList[t];
      var laneClips = [];
      for (var c = 0; c < clipList.length; c++) {
        var cl = clipList[c];
        if ((cl.trackId || trackList[0].id) === trk.id) {
          laneClips.push({ clip: cl, index: c });
        }
      }
      laneClips.sort(function(a, b) {
        var aStart = toNonNegative(a.clip.offsetSec);
        var bStart = toNonNegative(b.clip.offsetSec);
        return aStart - bStart;
      });

      for (var i = 0; i < laneClips.length; i++) {
        for (var j = i + 1; j < laneClips.length; j++) {
          var itemA = laneClips[i];
          var itemB = laneClips[j];
          var spA = itemA.clip && itemA.clip.speed && itemA.clip.speed > 0 ? itemA.clip.speed : 1.0;
          var spB = itemB.clip && itemB.clip.speed && itemB.clip.speed > 0 ? itemB.clip.speed : 1.0;
          var startA = toNonNegative(itemA.clip.offsetSec);
          var endA = round3(startA + clipDuration(itemA.clip) / spA);
          var startB = toNonNegative(itemB.clip.offsetSec);
          var endB = round3(startB + clipDuration(itemB.clip) / spB);

          var overlapStart = Math.max(startA, startB);
          var overlapEnd = Math.min(endA, endB);

          // 发生重叠（> 0.05s）
          if (overlapEnd - overlapStart > 0.05) {
            foundOverlap = true;
            anyShifted = true;
            var clipToMove = itemB.clip;
            clipToMove.isDuplicate = true; // 标记为重复分段（只展现 🎵 标记，不展现文字）
            clipToMove.isMovedDown = true;

            // 寻找下一个音轨：从当前轨的下一轨（t + 1）开始往下寻找无冲突的音轨
            var targetTrackId = null;
            for (var nextIdx = t + 1; nextIdx < trackList.length; nextIdx++) {
              var candTrack = trackList[nextIdx];
              var candClips = clipList.filter(function(oc) {
                return (oc.trackId || trackList[0].id) === candTrack.id;
              });
              var hasConflict = false;
              for (var k = 0; k < candClips.length; k++) {
                var oc = candClips[k];
                var ocSp = oc && oc.speed && oc.speed > 0 ? oc.speed : 1.0;
                var ocStart = toNonNegative(oc.offsetSec);
                var ocEnd = round3(ocStart + clipDuration(oc) / ocSp);
                if (Math.max(startB, ocStart) < Math.min(endB, ocEnd) - 0.05) {
                  hasConflict = true;
                  break;
                }
              }
              if (!hasConflict) {
                targetTrackId = candTrack.id;
                break;
              }
            }

            // 若现有下一轨均有冲突或没有下一轨，则自动新建下一条音轨（最多支持8条音轨）
            if (!targetTrackId) {
              if (trackList.length < 8) {
                var nextNum = trackList.length + 1;
                var newTrk = {
                  id: 'T' + nextNum,
                  name: '音轨 ' + nextNum,
                  color: TRACK_COLORS[(nextNum - 1) % TRACK_COLORS.length] || '#8B5CF6',
                  tag: String(nextNum),
                  mute: false,
                  solo: false,
                  volumeDb: 0,
                };
                trackList.push(newTrk);
                targetTrackId = newTrk.id;
              } else {
                targetTrackId = trackList[trackList.length - 1].id;
              }
            }

            clipToMove.trackId = targetTrackId;
            movedInfo = {
              clipIndex: itemB.index,
              clipId: clipToMove.id,
              targetTrackId: targetTrackId,
            };
            break;
          }
        }
        if (foundOverlap) break;
      }
      if (foundOverlap) break;
    }

    if (!foundOverlap) break;
  }

  return {
    shifted: anyShifted,
    tracks: trackList,
    clips: clipList,
    movedInfo: movedInfo,
  };
}

/** 当前被 clips 引用、且当前设备不能试听的源。 */
function getUnplayableSources(clips, sources) {
  var list = Array.isArray(clips) ? clips : [];
  var map = sourceMap(sources);
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var id = list[i] && list[i].sourceId;
    if (!id || seen[id]) continue;
    seen[id] = true;
    var src = map[id];
    if (src && src.playable === false) out.push({ id: id, name: src.name, format: src.format });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 预览队列 / 导出请求                                                         */
/* -------------------------------------------------------------------------- */

/**
 * 构建预览队列（契约 §6.2）：
 * - 默认按 clips 顺序返回全部片段（跨源）；
 * - opts.clipIndex 指定时只返回该片段（试听本片段）。
 * 每项：{ clipId, clipIndex, sourceId, sourceName, localPath, in, out, duration,
 *         fadeIn, fadeOut, offset }，fade 已归一（预览与成片一致）。
 * @returns {{ok:boolean, queue:Array, total?:number, message?:string}}
 */
function buildPreviewQueue(clips, sources, options) {
  var opts = options || {};
  var list = Array.isArray(clips) ? clips : [];
  var map = sourceMap(sources);
  var indexes = [];

  if (typeof opts.clipIndex === 'number' && isFinite(opts.clipIndex)) {
    if (opts.clipIndex < 0 || opts.clipIndex >= list.length) {
      return { ok: false, queue: [], message: '片段不存在。' };
    }
    indexes = [opts.clipIndex];
  } else {
    for (var i = 0; i < list.length; i++) indexes.push(i);
  }
  if (!indexes.length) return { ok: false, queue: [], message: '还没有可试听的片段。' };

  var queue = [];
  var offset = 0;
  for (var j = 0; j < indexes.length; j++) {
    var index = indexes[j];
    var clip = list[index];
    var src = map[clip && clip.sourceId];
    if (!clip || !src) return { ok: false, queue: [], message: '片段引用的音频已不存在，请撤销或重新导入。' };
    var dur = clipDuration(clip);
    if (dur < MIN_CLIP_DURATION - 1e-6) {
      return { ok: false, queue: [], message: '存在过短的片段（<0.2 秒），请先调整。' };
    }
    var fades = effectiveClipFades(clip);
    var speed = clip && clip.speed && clip.speed > 0 ? clip.speed : 1.0;
    var effectiveDur = round3(dur / speed);
    queue.push({
      clipId: clip.id,
      clipIndex: index,
      sourceId: clip.sourceId,
      sourceName: src.name,
      localPath: src.localPath || '',
      in: round3(clip.in),
      out: round3(clip.out),
      duration: round3(dur),
      effectiveDuration: effectiveDur,
      fadeIn: round3(fades.fadeIn),
      fadeOut: round3(fades.fadeOut),
      offset: round3(offset),
      speed: speed,
      volumeDb: typeof clip.volumeDb === 'number' ? clip.volumeDb : 0,
      eqPreset: clip.eqPreset || 'flat',
      denoise: clip.denoise || 0,
    });
    offset += effectiveDur;
  }
  return { ok: true, queue: queue, total: round3(offset) };
}

/** 当前播放位置（源时间）换算成成片时间轴位置（用于展示/淡入淡出，高精换算倍速物理时钟）。 */
function queueOutputPosition(queue, index, sourceTime) {
  var list = Array.isArray(queue) ? queue : [];
  if (!list.length) return 0;
  var i = Math.max(0, Math.min(toNumber(index, 0), list.length - 1));
  var item = list[i];
  var pos = toNumber(item.offset, 0);
  var speed = item.speed && item.speed > 0 ? item.speed : 1.0;
  var inSec = toNumber(item.in, 0);
  var outSec = toNumber(item.out, 0);
  var rawLocal = toNumber(sourceTime, 0) - inSec;
  var maxLocal = Math.max(0, outSec - inSec);
  var local = clampNumber(rawLocal / speed, 0, maxLocal / speed);
  return pos + local;
}

/**
 * 构建 renderEdit v2 请求（契约 §6.3）：
 * - 只带被 clip 引用的 sources，并按首次出现顺序重排 sourceIndex；
 * - clips 带归一后的 fadeIn/fadeOut。
 * @returns {{ok:boolean, request?:object, code?:string, message?:string}}
 */
function buildRenderRequest(clips, sources, options) {
  var opts = options || {};
  var validation = validateClips(clips, sources, opts);
  if (!validation.ok) {
    return { ok: false, request: null, code: validation.code, message: validation.message };
  }

  var list = copyClips(clips);
  var map = sourceMap(sources);
  var used = [];
  var usedIndex = Object.create(null);
  var outClips = [];

  for (var i = 0; i < list.length; i++) {
    var clip = list[i];
    var src = map[clip.sourceId];
    if (!src) return { ok: false, request: null, message: '片段引用的音频已不存在。' };
    var index = usedIndex[clip.sourceId];
    if (typeof index !== 'number') {
      index = used.length;
      usedIndex[clip.sourceId] = index;
      used.push(src);
    }
    var fades = effectiveClipFades(clip);
    outClips.push({
      sourceIndex: index,
      trackId: clip.trackId || 'A1',
      offsetSec: toNonNegative(clip.offsetSec),
      in: round3(clip.in),
      out: round3(clip.out),
      fadeIn: round3(fades.fadeIn),
      fadeOut: round3(fades.fadeOut),
      volumeDb: roundTo(clampNumber(clip.volumeDb, -24, 12), 1),
      speed: clip.speed || 1.0,
      eqPreset: clip.eqPreset || 'flat',
      denoise: clip.denoise || 0,
      pan: clip.pan || 0,
    });
  }

  return {
    ok: true,
    request: {
      sources: used.map(function (src) {
        return { fileID: src.fileID, fileName: src.name, size: Number(src.size) || 0 };
      }),
      clips: outClips,
      tracks: opts.tracks || TRACK_DEFS,
      volumeDb: roundTo(clampNumber(opts.volumeDb, -24, 12), 1),
      format: opts.format || 'mp3',
      bitrate: opts.bitrate || '192k',
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 淡入淡出 / 播放可用性                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 把选的淡入淡出收敛到片段时长范围内（与后端 editor-core.applyFades 一致）：
 * - 单个值先按 ≤5s 封顶，且不超过片段时长；
 * - 淡入 + 淡出不超过片段时长（超出时按比例缩短，0.1s 精度）。
 * @returns {{fadeIn:number, fadeOut:number, adjusted:boolean}}
 */
function resolveFades(fadeIn, fadeOut, total) {
  var fi = Math.min(toNonNegative(fadeIn), MAX_FADE_SEC);
  var fo = Math.min(toNonNegative(fadeOut), MAX_FADE_SEC);
  var dur = Math.max(0, toNumber(total, 0));
  var adjusted = fi > dur + 1e-9 || fo > dur + 1e-9 || fi + fo > dur + 1e-9;

  if (dur <= 0) return { fadeIn: 0, fadeOut: 0, adjusted: fi > 0 || fo > 0 };

  if (fi > dur) fi = dur;
  if (fo > dur) fo = dur;

  if (fi + fo > dur + 1e-9) {
    var scale = dur / (fi + fo);
    fi = roundTo(fi * scale, 1);
    fo = roundTo(fo * scale, 1);
    if (fi + fo > dur + 1e-9) {
      if (fi >= fo) fi = Math.max(0, roundTo(dur - fo, 1));
      else fo = Math.max(0, roundTo(dur - fi, 1));
    }
  }

  return { fadeIn: roundTo(fi, 2), fadeOut: roundTo(fo, 2), adjusted: adjusted };
}

/**
 * 按分析结果判断当前平台能不能直接试听。
 * 契约：iPhone 不支持该格式时服务端返回 playableIos=false。
 */
function resolvePreviewPlayable(analysis, platform) {
  if (!analysis) return false;
  var p = String(platform || '').toLowerCase();
  if (p === 'devtools') return true;
  if (p === 'ios') return analysis.playableIos !== false;
  if (p === 'android') return analysis.playableAndroid !== false;
  return true;
}

module.exports = {
  AUDIO_EXTENSIONS: AUDIO_EXTENSIONS,
  MAX_FILE_BYTES: MAX_FILE_BYTES,
  MAX_PLAN_DURATION: MAX_PLAN_DURATION,
  MAX_SOURCES: MAX_SOURCES,
  MAX_CLIPS: MAX_CLIPS,
  MIN_CLIP_DURATION: MIN_CLIP_DURATION,
  MIN_SELECTION_DURATION: MIN_SELECTION_DURATION,
  MAX_FADE_SEC: MAX_FADE_SEC,
  FADE_OPTIONS: FADE_OPTIONS,
  TRACK_DEFS: TRACK_DEFS,
  SPEED_OPTIONS: SPEED_OPTIONS,
  EQ_PRESETS: EQ_PRESETS,
  DENOISE_OPTIONS: DENOISE_OPTIONS,
  ZOOM_LEVELS: ZOOM_LEVELS,
  getEqPreset: getEqPreset,
  toTrackViews: toTrackViews,
  buildTimelineData: buildTimelineData,

  clampNumber: clampNumber,
  clampUnit: clampUnit,
  roundTo: roundTo,
  round3: round3,
  snapTime: snapTime,
  toNonNegative: toNonNegative,

  formatClock: formatClock,
  formatPrecise: formatPrecise,
  formatSecondsLabel: formatSecondsLabel,
  formatBytes: formatBytes,
  formatDb: formatDb,
  formatFade: formatFade,
  dbToGain: dbToGain,

  getFileExtension: getFileExtension,
  isAllowedAudioExtension: isAllowedAudioExtension,
  validateLocalFile: validateLocalFile,
  buildCloudPath: buildCloudPath,

  decodeBase64ToUint8: decodeBase64ToUint8,
  parsePeaks: parsePeaks,
  sliceClipWaveBars: sliceClipWaveBars,

  clipDuration: clipDuration,
  planDuration: planDuration,
  copyClip: copyClip,
  copyClips: copyClips,
  sourceMap: sourceMap,
  findSource: findSource,
  findClipIndexById: findClipIndexById,
  effectiveClipFades: effectiveClipFades,
  resolveFades: resolveFades,
  validateClips: validateClips,
  moveClip: moveClip,
  removeClip: removeClip,
  splitClipAt: splitClipAt,
  cropClipToRange: cropClipToRange,
  resetClipToFull: resetClipToFull,
  rippleDeleteSelection: rippleDeleteSelection,
  toClipViews: toClipViews,
  getUnplayableSources: getUnplayableSources,
  shiftOverlappingClipsToNextTrack: shiftOverlappingClipsToNextTrack,

  buildPreviewQueue: buildPreviewQueue,
  queueOutputPosition: queueOutputPosition,
  buildRenderRequest: buildRenderRequest,

  resolvePreviewPlayable: resolvePreviewPlayable,
};
