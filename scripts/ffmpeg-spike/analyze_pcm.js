#!/usr/bin/env node
/*
 * 原始 PCM(s16le) 分析工具（无依赖，Node 16 可运行；与云函数运行时一致）
 *
 * 用法：
 *   node analyze_pcm.js click  <raw> <rate> [channels=1]   # 拼接点/起点爆音扫描
 *   node analyze_pcm.js freq   <raw> <rate>                # 自相关估计基频（验证 atempo 保音调）
 *   node analyze_pcm.js peaks  <raw> <rate> <bucketMs>     # 50ms 桶 peak/rms → int8 + base64 体积/耗时
 *   node analyze_pcm.js stats  <raw> <rate>                # 幅度/削波统计
 *   node analyze_pcm.js envelope <raw> <rate> <stepMs>     # 分桶 RMS/Peak 包络（验证淡入淡出）
 *   node analyze_pcm.js beeps  <raw> <rate>                # 标记音起点检测（毫秒级裁剪偏差）
 *
 * 输出：单行 JSON 到 stdout。
 */
'use strict'
const fs = require('fs')

const [, , mode, file, rateArg, arg4] = process.argv
if (!mode || !file) {
  console.error('usage: node analyze_pcm.js <click|freq|peaks|stats> <raw> <rate> [bucketMs|channels]')
  process.exit(2)
}
const rate = Number(rateArg) || 44100
const buf = fs.readFileSync(file)
const n = Math.floor(buf.length / 2)

function readSample(i) {
  // s16le，单声道（多声道按交织，分析时只取第 0 通道）
  return buf.readInt16LE(i * 2)
}

function envelopeMode() {
  const stepMs = Number(arg4) || 200
  const step = Math.max(1, Math.round((rate * stepMs) / 1000))
  const rows = []
  for (let from = 0; from < n; from += step) {
    const to = Math.min(n, from + step)
    let peak = 0
    let sumSq = 0
    for (let i = from; i < to; i++) {
      const v = readSample(i) / 32768
      const a = v < 0 ? -v : v
      if (a > peak) peak = a
      sumSq += v * v
    }
    rows.push({
      tMs: Math.round(((from + to) / 2 / rate) * 1000),
      peak: +peak.toFixed(4),
      rms: +Math.sqrt(sumSq / Math.max(1, to - from)).toFixed(4)
    })
  }
  return { mode: 'envelope', file, rate, stepMs, seconds: +(n / rate).toFixed(3), rows }
}

function beepsMode() {
  // 每 5ms 一桶求峰值，>0.05 视为有声；间隔 <200ms 的合并为一段，输出各段起点(ms)
  const step = Math.max(1, Math.round(rate * 0.005))
  const runs = []
  let inRun = false
  let onset = 0
  let lastOn = 0
  for (let from = 0; from < n; from += step) {
    const to = Math.min(n, from + step)
    let peak = 0
    for (let i = from; i < to; i++) {
      const a = Math.abs(readSample(i)) / 32768
      if (a > peak) peak = a
    }
    const tMs = (from / rate) * 1000
    if (peak > 0.05) {
      if (!inRun) {
        inRun = true
        onset = tMs
      }
      lastOn = tMs
    } else if (inRun && tMs - lastOn > 200) {
      runs.push(+onset.toFixed(1))
      inRun = false
    }
  }
  if (inRun) runs.push(+onset.toFixed(1))
  return { mode: 'beeps', file, rate, seconds: +(n / rate).toFixed(3), onsetsMs: runs.slice(0, 10), count: runs.length }
}

function statsMode() {
  let maxAbs = 0
  let sumSq = 0
  let clip = 0
  for (let i = 0; i < n; i++) {
    const v = readSample(i) / 32768
    const a = Math.abs(v)
    if (a > maxAbs) maxAbs = a
    sumSq += v * v
    if (a >= 0.999) clip++
  }
  return {
    mode: 'stats',
    file,
    rate,
    samples: n,
    seconds: +(n / rate).toFixed(4),
    maxAbs: +maxAbs.toFixed(4),
    rms: +Math.sqrt(sumSq / Math.max(1, n)).toFixed(4),
    clipCount: clip
  }
}

function clickMode() {
  // 搜索相邻样本跳变（爆音 = 波形阶跃）；自然音频相邻样本差远小于满量程
  let prev = readSample(0)
  let maxDelta = 0
  let maxDeltaAt = 0
  let big = 0
  let first = prev
  let first20msMax = 0
  const win20 = Math.round(rate * 0.02)
  for (let i = 1; i < n; i++) {
    const v = readSample(i)
    const d = Math.abs(v - prev)
    if (d > maxDelta) {
      maxDelta = d
      maxDeltaAt = i
    }
    if (d > 16384) big++ // > 0.5 满量程的相邻跳变
    if (i < win20 && d > first20msMax) first20msMax = d
    prev = v
  }
  const s = statsMode()
  return {
    mode: 'click',
    file,
    rate,
    seconds: s.seconds,
    maxAbs: s.maxAbs,
    maxDelta: +(maxDelta / 32768).toFixed(4),
    maxDeltaAtMs: +((maxDeltaAt / rate) * 1000).toFixed(2),
    bigJumpsGtHalf: big,
    firstSampleAbs: +(Math.abs(first) / 32768).toFixed(4),
    first20msMaxDelta: +(first20msMax / 32768).toFixed(4)
  }
}

function freqMode() {
  // 自相关估计基频：取中段 0.5s，搜索 60~1200Hz
  const start = Math.floor(n / 2)
  const N = Math.min(Math.round(rate * 0.5), n - start - 1)
  const data = new Float64Array(N)
  let mean = 0
  for (let i = 0; i < N; i++) mean += readSample(start + i) / 32768
  mean /= N
  for (let i = 0; i < N; i++) data[i] = readSample(start + i) / 32768 - mean
  const minLag = Math.floor(rate / 1200)
  const maxLag = Math.ceil(rate / 60)
  let bestLag = 0
  let bestCorr = -Infinity
  const corrs = new Float64Array(maxLag + 1)
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    let e1 = 0
    let e2 = 0
    for (let i = 0; i + lag < N; i++) {
      const a = data[i]
      const b = data[i + lag]
      sum += a * b
      e1 += a * a
      e2 += b * b
    }
    const corr = sum / Math.sqrt(e1 * e2 + 1e-12)
    corrs[lag] = corr
    if (corr > bestCorr) {
      bestCorr = corr
      bestLag = lag
    }
  }
  // 次谐波修正：取相关度 >= 0.97*best 的最小滞后（即最高基频）
  let f0Lag = bestLag
  for (let lag = minLag; lag < bestLag; lag++) {
    if (corrs[lag] >= 0.97 * bestCorr) { f0Lag = lag; break }
  }
  bestLag = f0Lag
  // 抛物线插值提升精度
  let refined = bestLag
  const corrAt = (lag) => {
    let sum = 0
    let e1 = 0
    let e2 = 0
    for (let i = 0; i + lag < N; i++) {
      const a = data[i]
      const b = data[i + lag]
      sum += a * b
      e1 += a * a
      e2 += b * b
    }
    return sum / Math.sqrt(e1 * e2 + 1e-12)
  }
  if (bestLag > minLag && bestLag < maxLag) {
    const cm = corrAt(bestLag - 1)
    const c0 = bestCorr
    const cp = corrAt(bestLag + 1)
    const denom = cm - 2 * c0 + cp
    if (Math.abs(denom) > 1e-9) refined = bestLag + (0.5 * (cm - cp)) / denom
  }
  return {
    mode: 'freq',
    file,
    rate,
    seconds: +(n / rate).toFixed(3),
    freqHz: +(rate / refined).toFixed(2),
    corr: +bestCorr.toFixed(4)
  }
}

function peaksMode() {
  const bucketMs = Number(arg4) || 50
  const bucketSamples = Math.max(1, Math.round((rate * bucketMs) / 1000))
  const buckets = Math.ceil(n / bucketSamples)
  const t0 = process.hrtime.bigint()
  const out = Buffer.alloc(buckets * 2)
  for (let b = 0; b < buckets; b++) {
    const from = b * bucketSamples
    const to = Math.min(n, from + bucketSamples)
    let peak = 0
    let sumSq = 0
    for (let i = from; i < to; i++) {
      const v = readSample(i) / 32768
      const a = v < 0 ? -v : v
      if (a > peak) peak = a
      sumSq += v * v
    }
    const rms = Math.sqrt(sumSq / Math.max(1, to - from))
    const p8 = Math.min(127, Math.round(peak * 127))
    const r8 = Math.min(127, Math.round(rms * 127))
    out[b * 2] = p8
    out[b * 2 + 1] = r8
  }
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6
  const b64 = out.toString('base64')
  return {
    mode: 'peaks',
    file,
    rate,
    bucketMs,
    samples: n,
    seconds: +(n / rate).toFixed(3),
    buckets,
    rawBytes: out.length,
    b64Bytes: Buffer.byteLength(b64),
    nodeComputeMs: +elapsed.toFixed(2),
    rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1),
    b64Sample: b64.slice(0, 40)
  }
}

let result
if (mode === 'click') result = clickMode()
else if (mode === 'freq') result = freqMode()
else if (mode === 'peaks') result = peaksMode()
else if (mode === 'stats') result = statsMode()
else if (mode === 'envelope') result = envelopeMode()
else if (mode === 'beeps') result = beepsMode()
else {
  console.error('unknown mode: ' + mode)
  process.exit(2)
}
console.log(JSON.stringify(result))
