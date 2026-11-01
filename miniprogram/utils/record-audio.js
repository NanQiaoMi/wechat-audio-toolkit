/**
 * miniprogram/utils/record-audio.js
 * 现场录音音频处理与实时波形算法纯函数工具库
 *
 * 职责：
 * 1. 实时 PCM 帧 RMS / Peak 能量与分贝（dB）计算
 * 2. 纯前端 16-bit PCM 字节流转标准 RIFF/WAVE 文件
 * 3. 实时滚动波形谱线（Rolling Waveform Spectrum）数据计算
 * 4. 多分片 ArrayBuffer 零内存泄露高速拼接
 *
 * 全纯函数实现，不依赖 wx API，可在 Node / 客户端无缝运行。
 */

'use strict';

/** 默认录音参数 */
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_BIT_DEPTH = 16;
const DEFAULT_BAR_COUNT = 28;

/**
 * 计算 16-bit PCM 缓冲区的均方根振幅（RMS）
 * @param {ArrayBuffer|Uint8Array|Int16Array} buffer 
 * @returns {number} 归一化振幅 0.0 ~ 1.0
 */
function computePcmRms(buffer) {
  if (!buffer) return 0;
  let view;
  if (buffer instanceof Int16Array) {
    view = buffer;
  } else if (buffer instanceof ArrayBuffer) {
    view = new Int16Array(buffer);
  } else if (buffer.buffer instanceof ArrayBuffer) {
    view = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
  } else {
    return 0;
  }

  const len = view.length;
  if (len === 0) return 0;

  let sum = 0;
  for (let i = 0; i < len; i++) {
    const s = view[i] / 32768.0;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / len);
  return Math.min(1.0, Math.max(0.0, rms));
}

/**
 * 计算 16-bit PCM 缓冲区的峰值振幅（Peak）
 * @param {ArrayBuffer|Uint8Array|Int16Array} buffer
 * @returns {number} 归一化峰值 0.0 ~ 1.0
 */
function computePcmPeak(buffer) {
  if (!buffer) return 0;
  let view;
  if (buffer instanceof Int16Array) {
    view = buffer;
  } else if (buffer instanceof ArrayBuffer) {
    view = new Int16Array(buffer);
  } else if (buffer.buffer instanceof ArrayBuffer) {
    view = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
  } else {
    return 0;
  }

  const len = view.length;
  if (len === 0) return 0;

  let max = 0;
  for (let i = 0; i < len; i++) {
    const abs = Math.abs(view[i]);
    if (abs > max) max = abs;
  }
  return Math.min(1.0, max / 32768.0);
}

/**
 * 将 RMS 振幅转换为分贝（dBFS）
 * @param {number} rms 0.0 ~ 1.0
 * @returns {number} -60 ~ 0 dB
 */
function rmsToDb(rms) {
  if (rms <= 0.001) return -60;
  const db = 20 * Math.log10(rms);
  return Math.max(-60, Math.min(0, Math.round(db)));
}

/**
 * 格式化分贝为用户易懂的信号强弱指示
 * @param {number} db -60 ~ 0
 * @returns {{ text: string, level: string, status: string }}
 */
function formatDecibelStatus(db) {
  const safeDb = typeof db === 'number' && !isNaN(db) ? db : -60;
  if (safeDb < -45) {
    return { text: `${safeDb} dB`, level: 'quiet', status: '环境安静' };
  } else if (safeDb < -25) {
    return { text: `${safeDb} dB`, level: 'normal', status: '声音轻柔' };
  } else if (safeDb < -6) {
    return { text: `${safeDb} dB`, level: 'good', status: '声音清晰' };
  } else if (safeDb < -1) {
    return { text: `${safeDb} dB`, level: 'loud', status: '音量充沛' };
  } else {
    return { text: `${safeDb} dB`, level: 'peak', status: '接近过载' };
  }
}

/**
 * 纯前端将 16-bit PCM 二进制流包装为标准 44 字节 RIFF/WAVE 文件
 * @param {ArrayBuffer|Uint8Array} pcmBuffer 原始 PCM 数据
 * @param {number} [sampleRate=16000] 采样率
 * @param {number} [numChannels=1] 通道数
 * @param {number} [bitDepth=16] 位深
 * @returns {ArrayBuffer} 包含完整 44 字节 WAV 头的二进制数据
 */
function pcmToWav(pcmBuffer, sampleRate = DEFAULT_SAMPLE_RATE, numChannels = DEFAULT_CHANNELS, bitDepth = DEFAULT_BIT_DEPTH) {
  const pcmBytes = pcmBuffer instanceof Uint8Array ? pcmBuffer : new Uint8Array(pcmBuffer);
  const dataSize = pcmBytes.byteLength;
  const blockAlign = numChannels * (bitDepth / 8);
  const byteRate = sampleRate * blockAlign;
  const totalBufferSize = 44 + dataSize;
  const buffer = new ArrayBuffer(totalBufferSize);
  const view = new DataView(buffer);

  // 1. "RIFF" chunk descriptor
  view.setUint8(0, 0x52); // 'R'
  view.setUint8(1, 0x49); // 'I'
  view.setUint8(2, 0x46); // 'F'
  view.setUint8(3, 0x46); // 'F'
  view.setUint32(4, 36 + dataSize, true); // chunkSize = 36 + SubChunk2Size

  // 2. "WAVE" format
  view.setUint8(8, 0x57);  // 'W'
  view.setUint8(9, 0x41);  // 'A'
  view.setUint8(10, 0x56); // 'V'
  view.setUint8(11, 0x45); // 'E'

  // 3. "fmt " sub-chunk
  view.setUint8(12, 0x66); // 'f'
  view.setUint8(13, 0x6D); // 'm'
  view.setUint8(14, 0x74); // 't'
  view.setUint8(15, 0x20); // ' '
  view.setUint32(16, 16, true);             // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);              // AudioFormat (1 for PCM linear)
  view.setUint16(22, numChannels, true);     // NumChannels
  view.setUint32(24, sampleRate, true);      // SampleRate
  view.setUint32(28, byteRate, true);        // ByteRate = SampleRate * NumChannels * BitsPerSample/8
  view.setUint16(32, blockAlign, true);      // BlockAlign = NumChannels * BitsPerSample/8
  view.setUint16(34, bitDepth, true);        // BitsPerSample

  // 4. "data" sub-chunk
  view.setUint8(36, 0x64); // 'd'
  view.setUint8(37, 0x61); // 'a'
  view.setUint8(38, 0x74); // 't'
  view.setUint8(39, 0x61); // 'a'
  view.setUint32(40, dataSize, true);        // Subchunk2Size = NumSamples * NumChannels * BitsPerSample/8

  // 写入 PCM 采样数据
  new Uint8Array(buffer, 44).set(pcmBytes);

  return buffer;
}

/**
 * 高速合并多个 ArrayBuffer 帧切片为一个连续的 Uint8Array
 * @param {Array<ArrayBuffer|Uint8Array>} chunks 帧切片数组
 * @returns {Uint8Array}
 */
function concatChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return new Uint8Array(0);
  }
  let totalLength = 0;
  for (let i = 0; i < chunks.length; i++) {
    totalLength += chunks[i].byteLength || 0;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    result.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return result;
}

/**
 * 初始化静态/空态实时声波条
 * @param {number} [count=DEFAULT_BAR_COUNT] 柱数
 * @returns {Array<{ id: number, height: number, opacity: number }>}
 */
function initWaveBars(count = DEFAULT_BAR_COUNT) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    bars.push({
      id: i,
      height: 8, // 静默基础高 8rpx
      opacity: 0.35,
    });
  }
  return bars;
}

/**
 * 推进实时滚动波形谱线（向左滚动，最新帧自右侧压入）
 * @param {Array<{ id: number, height: number, opacity: number }>} currentBars
 * @param {number} amplitude 归一化振幅 0.0 ~ 1.0
 * @param {number} [maxHeight=110] 最高 rpx
 * @param {number} [minHeight=8] 最低 rpx
 * @returns {Array<{ id: number, height: number, opacity: number }>}
 */
function pushWaveBar(currentBars, amplitude, maxHeight = 110, minHeight = 8) {
  const bars = Array.isArray(currentBars) && currentBars.length > 0
    ? currentBars.slice()
    : initWaveBars(DEFAULT_BAR_COUNT);

  // 引入非线性感知增益（平缓小声、放大中声、保护高声）
  const safeAmp = Math.min(1.0, Math.max(0.0, Number(amplitude) || 0));
  const dynamicFactor = Math.pow(safeAmp, 0.65); // 伽马压缩增强低振幅可见度
  const newHeight = Math.round(minHeight + dynamicFactor * (maxHeight - minHeight));
  const newOpacity = Math.min(1.0, Math.max(0.35, 0.35 + dynamicFactor * 0.65));

  // 左移一格，尾部入队
  bars.shift();
  bars.push({
    id: Date.now() + Math.random(),
    height: newHeight,
    opacity: Number(newOpacity.toFixed(2)),
  });

  return bars;
}

module.exports = {
  DEFAULT_SAMPLE_RATE,
  DEFAULT_CHANNELS,
  DEFAULT_BIT_DEPTH,
  DEFAULT_BAR_COUNT,
  computePcmRms,
  computePcmPeak,
  rmsToDb,
  formatDecibelStatus,
  pcmToWav,
  concatChunks,
  initWaveBars,
  pushWaveBar,
};
