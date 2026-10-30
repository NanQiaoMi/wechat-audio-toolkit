#!/usr/bin/env node
/**
 * 音乐剪辑·后端本地实测（宿主机执行，需要 Docker）
 *
 * 用 `linuxserver/ffmpeg` 容器（--cpus=1 --memory=1g，模拟云函数 1 核）+ 项目静态
 * FFmpeg 7.0.2（cloudfunctions/ffmpegProbe/bin/ffmpeg，复制进容器 chmod 后执行）；
 * 只把 cloudfunctions/ffmpegProbe/lib/editor-core.js 生成的 filter args 交给 FFmpeg 跑，
 * 验证：
 *   1. analyze 链路：`ffmpeg -i` stderr 解析 duration/format/sr/ch + 4kHz 解码 + 50ms 桶 peaks
 *   2. 删除区间 + concat：成片时长误差 ≤0.2s、可完整解码、保留段顺序正确、无削波/拼接爆音
 *   3. 淡入淡出：首尾 RMS 包络确实衰减（含淡出 st=输出时间轴）
 *   4. volume / alimiter：-6dB 比例≈0.501、+12dB 被限幅（不硬削波）
 *   5. 异常输入：随机字节/空文件/无音轨 → parseProbeInfo 判不出来 = 走错误分支
 *   6. 10min 上限：610s 输入 Duration 解析 >600（对应 DURATION_TOO_LONG 分支）
 *
 * 运行（先由 run.sh 准备容器，或手动创建后）：
 *   CONTAINER=ffmpeg-editor-spike WORK=/tmp/editor-spike-work node scripts/editor-spike/test_integration.js
 */
'use strict'

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const core = require(path.join(__dirname, '..', '..', 'cloudfunctions', 'ffmpegProbe', 'lib', 'editor-core.js'))

const CONTAINER = process.env.CONTAINER || 'ffmpeg-editor-spike'
const WORK = process.env.WORK || '/tmp/editor-spike-work' // 宿主机路径，容器内挂载为 /work
const CWORK = '/work'
const FFMPEG = process.env.CONTAINER_FFMPEG || '/tmp/bin/ffmpeg'
const FFPROBE = process.env.CONTAINER_FFPROBE || '/usr/local/bin/ffprobe'

const OUT_DIR = path.join(WORK, 'out')
const SAMPLE_DIR = path.join(WORK, 'samples')
const RESULT_DIR = path.join(WORK, 'results')
const SAMPLE_SECONDS = 120

let pass = 0
let fail = 0
const failures = []
const metrics = []

function section(title) {
  console.log('\n# ' + title)
}

function check(label, cond, detail) {
  if (cond) {
    pass++
    console.log('  PASS ' + label)
  } else {
    fail++
    const line = label + (detail ? '  [' + detail + ']' : '')
    failures.push(line)
    console.log('  FAIL ' + line)
  }
}

function near(label, actual, expected, tol) {
  const ok = Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) <= tol
  check(label, ok, 'expected ' + expected + '±' + tol + ' actual=' + actual)
}

function eq(label, actual, expected) {
  check(label, actual === expected, 'expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual))
}

function toC(hostPath) {
  if (hostPath.indexOf(WORK) !== 0) throw new Error('路径不在 WORK 下，无法映射到容器: ' + hostPath)
  return CWORK + hostPath.slice(WORK.length)
}

function runDocker(argv) {
  const t0 = Date.now()
  const r = spawnSync('docker', ['exec', CONTAINER].concat(argv), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    ms: Date.now() - t0,
    error: r.error ? String(r.error.message) : ''
  }
}

function ff(args) {
  return runDocker([FFMPEG].concat(args))
}

function ffprobeDuration(hostFile) {
  const r = runDocker([
    FFPROBE,
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    toC(hostFile)
  ])
  return Number(String(r.stdout).trim()) || 0
}

function probeInfo(hostFile) {
  const r = ff(['-hide_banner', '-nostdin', '-i', toC(hostFile)])
  return {
    exitCode: r.status,
    info: core.parseProbeInfo(r.stderr + '\n' + r.stdout),
    stderr: r.stderr,
    ms: r.ms
  }
}

function decodePcm(hostInput, hostPcm, rate) {
  const r = ff([
    '-v',
    'error',
    '-nostdin',
    '-y',
    '-i',
    toC(hostInput),
    '-ac',
    '1',
    '-ar',
    String(rate),
    '-f',
    's16le',
    toC(hostPcm)
  ])
  if (r.status !== 0) throw new Error('解码 PCM 失败: ' + r.stderr.slice(-300))
  return fs.readFileSync(hostPcm)
}

function decodeOk(hostFile) {
  const r = ff(['-v', 'error', '-nostdin', '-i', toC(hostFile), '-map', '0:a:0', '-f', 'null', '-'])
  return r.status === 0
}

function pcmMaxAbs(pcm) {
  let maxAbs = 0
  const n = Math.floor(pcm.length / 2)
  for (let i = 0; i < n; i++) {
    const v = Math.abs(pcm.readInt16LE(i * 2))
    if (v > maxAbs) maxAbs = v
  }
  return maxAbs
}

function pcmCountAbove(pcm, threshold) {
  let count = 0
  const n = Math.floor(pcm.length / 2)
  for (let i = 0; i < n; i++) {
    if (Math.abs(pcm.readInt16LE(i * 2)) >= threshold) count++
  }
  return count
}

// 相邻样本最大跳变（爆音扫描）；excludeWindows 为 [fromSec,toSec] 数组
function pcmMaxDelta(pcm, rate, excludeWindows) {
  const n = Math.floor(pcm.length / 2)
  const windows = excludeWindows || []
  let maxDelta = 0
  for (let i = 1; i < n; i++) {
    const t = i / rate
    let skip = false
    for (let w = 0; w < windows.length; w++) {
      if (t >= windows[w][0] && t <= windows[w][1]) {
        skip = true
        break
      }
    }
    if (skip) continue
    const d = Math.abs(pcm.readInt16LE(i * 2) - pcm.readInt16LE((i - 1) * 2))
    if (d > maxDelta) maxDelta = d
  }
  return maxDelta / 32768
}

function meanRms(stats, fromSec, toSec) {
  const bucketMs = stats.bucketMs
  const b0 = Math.max(0, Math.floor((fromSec * 1000) / bucketMs))
  const b1 = Math.min(stats.buckets, Math.ceil((toSec * 1000) / bucketMs))
  let sum = 0
  let n = 0
  for (let i = b0; i < b1; i++) {
    sum += stats.rms[i]
    n++
  }
  return n ? sum / n : 0
}

function analyzeStats(hostFile, rate, bucketMs) {
  const pcmPath = path.join(OUT_DIR, 'tmp_stats_' + process.pid + '_' + Date.now() + '.pcm')
  const pcm = decodePcm(hostFile, pcmPath, rate)
  try {
    const t0 = Date.now()
    const peaks = core.computePeaks(pcm, rate, bucketMs)
    return {
      pcmBytes: pcm.length,
      sampleCount: peaks.sampleCount,
      exactDuration: peaks.sampleCount / rate,
      buckets: peaks.buckets,
      peak: peaks.peak,
      rms: peaks.rms,
      peakB64: peaks.peakB64,
      rmsB64: peaks.rmsB64,
      bucketMs: bucketMs,
      maxAbs: pcmMaxAbs(pcm),
      nodeComputeMs: Date.now() - t0
    }
  } finally {
    try {
      fs.unlinkSync(pcmPath)
    } catch (e) {}
  }
}

function ensureContainer() {
  const r = runDocker([FFMPEG, '-hide_banner', '-version'])
  if (r.status !== 0) {
    console.error('容器 ' + CONTAINER + ' 未就绪（无法运行静态 ffmpeg）。请先执行：bash scripts/editor-spike/run.sh')
    console.error(r.stderr.slice(-500))
    process.exit(2)
  }
  const p = runDocker([FFPROBE, '-version'])
  if (p.status !== 0) {
    console.error('容器内 ffprobe 不可用，无法做时长校验')
    process.exit(2)
  }
}

function ensureSample(hostSample) {
  fs.mkdirSync(SAMPLE_DIR, { recursive: true })
  if (fs.existsSync(hostSample)) {
    const probe = probeInfo(hostSample)
    if (probe.info.hasAudio && Math.abs(probe.info.duration - SAMPLE_SECONDS) <= 0.5) {
      return { cached: true, ms: 0, info: probe.info }
    }
  }
  // 120s mp3：前 60s 幅度 0.8 FS（响），后 60s 幅度 0.08 FS（轻），用于验证删除/拼接/淡入淡出/音量。
  // 注意：lavfi 的 `sine` 源默认幅度只有 1/8，必须用 volume=6.4 / 0.64 抬到目标幅度。
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=60',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=60',
    '-filter_complex',
    '[0:a]volume=6.4[a0];[1:a]volume=0.64[a1];[a0][a1]concat=n=2:v=0:a=1[out]',
    '-map',
    '[out]',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '192k',
    toC(hostSample)
  ]
  const r = ff(args)
  if (r.status !== 0) {
    console.error('生成测试样本失败: ' + r.stderr.slice(-500))
    process.exit(2)
  }
  const probe = probeInfo(hostSample)
  return { cached: false, ms: r.ms, info: probe.info }
}

// 通用小样本生成（v2 多源测试用）：genArgs 不含输出路径，由本函数追加
function ensureRawSample(hostSample, genArgs) {
  fs.mkdirSync(SAMPLE_DIR, { recursive: true })
  if (fs.existsSync(hostSample) && fs.statSync(hostSample).size > 1024) {
    return { cached: true, ms: 0 }
  }
  const args = ['-hide_banner', '-nostdin', '-y'].concat(genArgs).concat([toC(hostSample)])
  const r = ff(args)
  if (r.status !== 0) {
    console.error('生成测试样本失败(' + path.basename(hostSample) + '): ' + r.stderr.slice(-400))
    process.exit(2)
  }
  return { cached: false, ms: r.ms }
}

function renderCase(label, segments, options, expectedDur) {
  const plan = core.normalizeEditRequest(Object.assign({ segments: segments }, options || {}))
  const outFile = path.join(OUT_DIR, label + '.mp3')
  const args = core.buildRenderArgs(toC(SAMPLE_FILE), toC(outFile), plan)
  const run = ff(args)
  const row = {
    label: label,
    plannedDuration: plan.outDur,
    ffprobeDuration: 0,
    exactDuration: 0,
    wallMs: run.ms,
    maxAbs: 0,
    note: ''
  }

  check(label + ': ffmpeg rc=0', run.status === 0, 'rc=' + run.status + ' ' + run.stderr.slice(-300))
  check(label + ': 输出文件存在且非空', fs.existsSync(outFile) && fs.statSync(outFile).size > 1024)
  if (run.status !== 0 || !fs.existsSync(outFile)) return { plan: plan, outFile: outFile, args: args, metrics: row, ok: false }

  row.ffprobeDuration = ffprobeDuration(outFile)
  near(label + ': 计划时长=' + plan.outDur + 's（ffprobe ±0.2s）', row.ffprobeDuration, expectedDur, 0.2)
  check(label + ': 完整解码通过', decodeOk(outFile))

  const stats = analyzeStats(outFile, 4000, 50)
  row.exactDuration = stats.exactDuration
  row.maxAbs = stats.maxAbs / 32768
  near(label + ': 精确解码时长（±0.2s）', stats.exactDuration, expectedDur, 0.2)
  check(
    label + ': 桶数≈时长/50ms',
    Math.abs(stats.buckets - Math.round(expectedDur * 1000 / 50)) <= 2,
    'buckets=' + stats.buckets + ' expected≈' + Math.round((expectedDur * 1000) / 50)
  )
  check(
    label + ': base64 两数组等长',
    Buffer.from(stats.peakB64, 'base64').length === stats.buckets &&
      Buffer.from(stats.rmsB64, 'base64').length === stats.buckets
  )
  check(label + ': peak ≥ rms（逐桶）', stats.peak.every(function (p, i) { return p + 1 >= stats.rms[i] }))

  return { plan: plan, outFile: outFile, args: args, metrics: row, ok: true, stats: stats }
}

// ===========================================================================
// main
// ===========================================================================
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.mkdirSync(RESULT_DIR, { recursive: true })

section('环境检查')
ensureContainer()
const versionRun = runDocker([FFMPEG, '-version'])
const versionLine = (versionRun.stdout + versionRun.stderr).split('\n')[0] || ''
check('容器内静态 FFmpeg 可执行', /ffmpeg version/i.test(versionLine), versionLine)
const probeVersion = runDocker([FFPROBE, '-version'])
check('容器内 ffprobe 可用（仅本地校验用）', /ffprobe version/i.test(probeVersion.stdout + probeVersion.stderr))
const capProbe = runDocker(['bash', '-lc', 'nproc; cat /sys/fs/cgroup/cpu.max 2>/dev/null || true; cat /sys/fs/cgroup/memory.max 2>/dev/null || true'])
console.log('  容器资源: ' + capProbe.stdout.trim().replace(/\n/g, ' | '))

// ---------------------------------------------------------------------------
section('1) 生成/复用 120s 测试样本（前 60s 响 0.8 FS，后 60s 轻 0.08 FS）')
const SAMPLE_FILE = path.join(SAMPLE_DIR, 'music_loud_quiet_120s_v2.mp3')
const sample = ensureSample(SAMPLE_FILE)
check('样本存在', fs.existsSync(SAMPLE_FILE))
console.log('  样本: ' + SAMPLE_FILE + '（' + (fs.statSync(SAMPLE_FILE).size / 1048576).toFixed(2) + 'MB, ' + (sample.cached ? '复用' : '新生成') + '）')
const srcBytes = fs.statSync(SAMPLE_FILE).size

// ---------------------------------------------------------------------------
section('2) analyze 链路实测：ffmpeg -i 解析 + 4kHz 解码 + 50ms 桶 peaks')
{
  const probe = probeInfo(SAMPLE_FILE)
  check('ffmpeg -i 无输出参数时退出码=1（证明不能按退出码判失败，spike 坑 P11）', probe.exitCode === 1, 'exitCode=' + probe.exitCode)
  check('解析出音频流', probe.info.hasAudio)
  near('duration≈120s', probe.info.duration, SAMPLE_SECONDS, 0.15)
  check('format=mp3', probe.info.format === 'mp3', 'format=' + probe.info.format)
  check('sampleRate=44100', probe.info.sampleRate === 44100, 'sampleRate=' + probe.info.sampleRate)
  check('channels=1', probe.info.channels === 1, 'channels=' + probe.info.channels)

  const t0 = Date.now()
  const stats = analyzeStats(SAMPLE_FILE, core.SAMPLE_RATE, core.BUCKET_MS)
  const analyzeWall = Date.now() - t0
  near('解码时长≈120s', stats.sampleCount / core.SAMPLE_RATE, SAMPLE_SECONDS, 0.15)
  near('buckets≈2400（120s/50ms）', stats.buckets, 2400, 2)
  check('base64 peak/rms 等长且=桶数', Buffer.from(stats.peakB64, 'base64').length === stats.buckets && Buffer.from(stats.rmsB64, 'base64').length === stats.buckets)
  const loudRms = meanRms(stats, 5, 55)
  const quietRms = meanRms(stats, 65, 115)
  check('源样本响段峰值≈0.8FS（防止样本生成幅度漂移）', stats.maxAbs / 32768 > 0.7 && stats.maxAbs / 32768 < 0.9, 'maxAbs=' + (stats.maxAbs / 32768).toFixed(3))
  check('响段 RMS≈0.57*255≈144', loudRms > 120 && loudRms < 170, 'loudRms=' + loudRms.toFixed(1))
  check('轻段 RMS≈0.057*255≈14', quietRms > 6 && quietRms < 30, 'quietRms=' + quietRms.toFixed(1))
  check('响/轻 RMS 比例>5', loudRms / quietRms > 5, 'ratio=' + (loudRms / quietRms).toFixed(1))
  check('peak ≥ rms（逐桶）', stats.peak.every(function (p, i) { return p + 1 >= stats.rms[i] }))
  console.log(
    '  analyze: pcm=' + (stats.pcmBytes / 1048576).toFixed(2) + 'MB buckets=' + stats.buckets +
      ' b64=' + Buffer.from(stats.peakB64, 'base64').length * 2 + 'B nodeCompute=' + stats.nodeComputeMs + 'ms wall(含docker)=' + analyzeWall + 'ms'
  )
  metrics.push({ label: 'analyze_120s', wallMs: analyzeWall + probe.ms, note: 'buckets=' + stats.buckets + ' b64=' + Buffer.from(stats.peakB64, 'base64').length * 2 + 'B' })
}

// ---------------------------------------------------------------------------
section('3) 删除区间 + concat：保留 [0,20]+[60,80] = 40s（响 20s + 轻 20s）')
const caseA = renderCase('caseA_delete_concat', [{ in: 0, out: 20 }, { in: 60, out: 80 }], {}, 40)
if (caseA.ok) {
  const s = caseA.stats
  const loud = meanRms(s, 2, 18)
  const quiet = meanRms(s, 22, 38)
  check('caseA: 前 20s 为响段（RMS 120~170）', loud > 120 && loud < 170, 'loud=' + loud.toFixed(1))
  check('caseA: 后 20s 为轻段（RMS 6~30）', quiet > 6 && quiet < 30, 'quiet=' + quiet.toFixed(1))
  check('caseA: 保留段顺序/删除生效（响/轻 >5）', loud / quiet > 5, 'ratio=' + (loud / quiet).toFixed(1))
  check('caseA: 无削波（max|s| ≤0.96FS）', s.maxAbs / 32768 <= 0.96, 'maxAbs=' + (s.maxAbs / 32768).toFixed(3))

  // 拼接点爆音扫描：20s 处是「响→轻」硬切，排除 ±50ms 窗口后其余最大跳变应接近自然音频
  const pcm44 = decodePcm(caseA.outFile, path.join(OUT_DIR, 'caseA_44k.pcm'), 44100)
  const delta = pcmMaxDelta(pcm44, 44100, [[19.95, 20.05]])
  check('caseA: 拼接点以外无爆音（相邻样本最大跳变<0.35）', delta < 0.35, 'maxDelta=' + delta.toFixed(3))
  check('caseA: 首样本无直流突变（|x|<0.05FS）', Math.abs(pcm44.readInt16LE(0)) / 32768 < 0.05, 'first=' + (pcm44.readInt16LE(0) / 32768).toFixed(3))
  try {
    fs.unlinkSync(path.join(OUT_DIR, 'caseA_44k.pcm'))
  } catch (e) {}
  caseA.metrics.note = 'loud=' + loud.toFixed(0) + ' quiet=' + quiet.toFixed(0) + ' maxDelta=' + delta.toFixed(3)
}
if (caseA.metrics) metrics.push(caseA.metrics)

// ---------------------------------------------------------------------------
section('4) 淡入 3s / 淡出 3s（单段 40s，验证 afade st=输出时间轴）')
const caseB = renderCase('caseB_fade_3s', [{ in: 0, out: 40 }], { fadeIn: 3, fadeOut: 3, volumeDb: 0 }, 40)
if (caseB.ok) {
  const s = caseB.stats
  const steady = meanRms(s, 5, 35)
  function ratioAt(fromSec, toSec) {
    return meanRms(s, fromSec, toSec) / steady
  }
  check('caseB: 0~50ms 淡入起点 RMS<15% 稳态', ratioAt(0, 0.05) < 0.15, 'ratio=' + ratioAt(0, 0.05).toFixed(3))
  check('caseB: 1.5s 处淡入中段 RMS≈50% 稳态', ratioAt(1.45, 1.55) > 0.2 && ratioAt(1.45, 1.55) < 0.8, 'ratio=' + ratioAt(1.45, 1.55).toFixed(3))
  check('caseB: 4s 处淡入完成 RMS>90% 稳态', ratioAt(3.95, 4.05) > 0.9, 'ratio=' + ratioAt(3.95, 4.05).toFixed(3))
  check('caseB: 36.5s 处仍未淡出 RMS>90% 稳态', ratioAt(36.4, 36.6) > 0.9, 'ratio=' + ratioAt(36.4, 36.6).toFixed(3))
  check('caseB: 38.5s 处淡出中段 RMS≈50% 稳态（st=37 生效）', ratioAt(38.45, 38.55) > 0.2 && ratioAt(38.45, 38.55) < 0.8, 'ratio=' + ratioAt(38.45, 38.55).toFixed(3))
  check('caseB: 末尾 50ms RMS<15% 稳态', ratioAt(39.95, 40) < 0.15, 'ratio=' + ratioAt(39.95, 40).toFixed(3))
  check('caseB: 无削波（max|s| ≤0.96FS）', s.maxAbs / 32768 <= 0.96, 'maxAbs=' + (s.maxAbs / 32768).toFixed(3))
  caseB.metrics.note = 'fadeIn/out=3s steady=' + steady.toFixed(0)
}
if (caseB.metrics) metrics.push(caseB.metrics)

// ---------------------------------------------------------------------------
section('5) volume -6dB：RMS 应≈0.501× 基准（同一 10s 片段）')
const caseV0 = renderCase('caseC_volume_0db', [{ in: 0, out: 10 }], { volumeDb: 0 }, 10)
const caseVm6 = renderCase('caseC_volume_m6db', [{ in: 0, out: 10 }], { volumeDb: -6 }, 10)
if (caseV0.ok && caseVm6.ok) {
  const rms0 = meanRms(caseV0.stats, 2, 8)
  const rmsM6 = meanRms(caseVm6.stats, 2, 8)
  const ratio = rmsM6 / rms0
  check('-6dB: RMS 比例≈0.501（±0.05）', Math.abs(ratio - 0.501) <= 0.05, 'ratio=' + ratio.toFixed(3))
  check('-6dB: 无削波', caseVm6.stats.maxAbs / 32768 <= 0.96)
}
if (caseV0.metrics) metrics.push(caseV0.metrics)
if (caseVm6.metrics) metrics.push(caseVm6.metrics)

// ---------------------------------------------------------------------------
section('6) volume +12dB：alimiter(limit=0.95:level=false) 生效，不硬削波')
const caseVp12 = renderCase('caseD_volume_p12db_limiter', [{ in: 0, out: 10 }], { volumeDb: 12 }, 10)
if (caseVp12.ok) {
  const s = caseVp12.stats
  const maxFs = s.maxAbs / 32768
  const hardClipped = pcmCountAbove(decodePcm(caseVp12.outFile, path.join(OUT_DIR, 'caseD.pcm'), 4000), 32500)
  check('+12dB: limiter 后峰值 0.85~0.99FS（未被压到 0dBFS 硬削）', maxFs > 0.85 && maxFs <= 0.995, 'maxAbs=' + maxFs.toFixed(3))
  check('+12dB: 接近满幅样本占比<0.1%（无硬削波平台）', hardClipped / s.sampleCount < 0.001, 'clipped=' + hardClipped + '/' + s.sampleCount)
  caseVp12.metrics.note = 'maxAbs=' + maxFs.toFixed(3) + ' clipped=' + hardClipped
  try {
    fs.unlinkSync(path.join(OUT_DIR, 'caseD.pcm'))
  } catch (e) {}
}
if (caseVp12.metrics) metrics.push(caseVp12.metrics)

// ---------------------------------------------------------------------------
section('7) 异常输入：随机字节 / 空文件 / 无音轨视频 → 错误分支判定')
{
  const badRandom = path.join(SAMPLE_DIR, 'bad_random.mp3')
  fs.writeFileSync(badRandom, crypto.randomBytes(50000))
  const badRandomProbe = probeInfo(badRandom)
  check('随机字节: 未识别出音频流', badRandomProbe.info.hasAudio === false)
  check('随机字节: 命中 INVALID_FILE 特征', core.isInvalidMediaText(badRandomProbe.stderr) === true, badRandomProbe.stderr.split('\n')[0])

  const badEmpty = path.join(SAMPLE_DIR, 'bad_empty.mp3')
  fs.writeFileSync(badEmpty, Buffer.alloc(0))
  const badEmptyProbe = probeInfo(badEmpty)
  check('空文件: 未识别出音频流', badEmptyProbe.info.hasAudio === false)

  const videoOnly = path.join(SAMPLE_DIR, 'video_only_2s.mp4')
  const v = ff(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=2', '-c:v', 'mpeg4', toC(videoOnly)])
  check('生成无音轨视频', v.status === 0, v.stderr.slice(-200))
  const videoProbe = probeInfo(videoOnly)
  near('无音轨视频: 仍解析出 duration=2s', videoProbe.info.duration, 2, 0.2)
  check('无音轨视频: hasAudio=false（走 DECODE_FAILED 分支）', videoProbe.info.hasAudio === false)
  check('无音轨视频: 不误判为坏文件（isInvalidMediaText=false）', core.isInvalidMediaText(videoProbe.stderr) === false)
  metrics.push({ label: 'error_paths', wallMs: 0, note: 'random/empty/video-only 判定正确' })
}

// ---------------------------------------------------------------------------
section('8) 10 分钟上限：610s 输入解析 Duration>600（对应 DURATION_TOO_LONG 分支）')
{
  const longFile = path.join(SAMPLE_DIR, 'long_610s.mp3')
  if (!fs.existsSync(longFile) || fs.statSync(longFile).size < 1024) {
    const r = ff([
      '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-t', '610', '-c:a', 'libmp3lame', '-b:a', '64k', toC(longFile)
    ])
    check('生成 610s 静音 mp3', r.status === 0, r.stderr.slice(-200))
  }
  const probe = probeInfo(longFile)
  near('610s 输入 duration≈610s', probe.info.duration, 610, 0.5)
  check('duration > MAX_OUTPUT_SEC(600) → analyzeAudio 返回 DURATION_TOO_LONG', probe.info.duration > core.MAX_OUTPUT_SEC, 'duration=' + probe.info.duration)
}

// ---------------------------------------------------------------------------
section('9) 10min 分析耗时实测：600s mp3 解码 4kHz + 12000 桶 peaks（契约要求 ≤20s）')
{
  const bigFile = path.join(SAMPLE_DIR, 'music_600s_tone.mp3')
  let genMs = 0
  if (!fs.existsSync(bigFile) || fs.statSync(bigFile).size < 1024 * 1024) {
    const r = ff([
      '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=600',
      '-af', 'volume=6.4', '-c:a', 'libmp3lame', '-b:a', '192k', toC(bigFile)
    ])
    genMs = r.ms
    check('生成 600s mp3（1 vCPU）', r.status === 0, r.stderr.slice(-200))
  }
  const probe = probeInfo(bigFile)
  near('600s 输入 duration≈600s', probe.info.duration, 600, 0.2)

  const decodePath = path.join(OUT_DIR, 'big_600s_4k.pcm')
  const tDecode = Date.now()
  const pcm600 = decodePcm(bigFile, decodePath, core.SAMPLE_RATE) // 容器内 ffmpeg 解码
  const decodeWall = Date.now() - tDecode
  const tPeaks = Date.now()
  const peaks600 = core.computePeaks(pcm600, core.SAMPLE_RATE, core.BUCKET_MS)
  const peaksMs = Date.now() - tPeaks
  try {
    fs.unlinkSync(decodePath)
  } catch (e) {}

  check('600s: 解码样本数≈2,400,000', Math.abs(peaks600.sampleCount - 2400000) < 2000, 'samples=' + peaks600.sampleCount)
  near('600s: buckets≈12000', peaks600.buckets, 12000, 2)
  check(
    '600s: peak/rms base64 各 12000B',
    Buffer.from(peaks600.peakB64, 'base64').length === peaks600.buckets && Buffer.from(peaks600.rmsB64, 'base64').length === peaks600.buckets,
    'pcm=' + (pcm600.length / 1048576).toFixed(2) + 'MB'
  )
  const analyzeTotal = decodeWall + peaksMs
  check('600s: 分析总耗时 ' + analyzeTotal + 'ms < 20000ms（契约 §3.1 超时 ≤20s）', analyzeTotal < 20000)
  console.log(
    '  600s analyze: 生成=' + genMs + 'ms(decode 4kHz)=' + decodeWall + 'ms peaks=' + peaksMs + 'ms 合计=' + analyzeTotal +
      'ms pcm=' + (pcm600.length / 1048576).toFixed(2) + 'MB b64=' + Buffer.from(peaks600.peakB64, 'base64').length * 2 + 'B'
  )
  metrics.push({
    label: 'analyze_600s',
    wallMs: analyzeTotal,
    plannedDuration: 600,
    exactDuration: peaks600.sampleCount / core.SAMPLE_RATE,
    note: 'decode=' + decodeWall + 'ms peaks=' + peaksMs + 'ms buckets=' + peaks600.buckets + ' b64=' + Buffer.from(peaks600.peakB64, 'base64').length * 2 + 'B'
  })
}

// ---------------------------------------------------------------------------
section('10) v2 多源片段拼接 + 每片段缓入缓出（2 源 3 片，成片 8s，契约 §6.3/§6.4）')
{
  // 源 0：8s 440Hz 幅度 0.8FS（RMS≈144）；源 1：6s 660Hz 幅度 0.2FS（RMS≈36）
  // 幅度差 4 倍，用于校验片段顺序与每片 fade 包络；源 0 被两个片段引用 → 覆盖 asplit 分支。
  const v2src0 = path.join(SAMPLE_DIR, 'v2_src0_440_8s.mp3')
  const v2src1 = path.join(SAMPLE_DIR, 'v2_src1_660_6s.mp3')
  const gen0 = ensureRawSample(v2src0, [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-af', 'volume=6.4', '-c:a', 'libmp3lame', '-b:a', '192k'
  ])
  const gen1 = ensureRawSample(v2src1, [
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=6', '-af', 'volume=1.6', '-c:a', 'libmp3lame', '-b:a', '192k'
  ])
  const pr0 = probeInfo(v2src0)
  const pr1 = probeInfo(v2src1)
  near('v2: 源0 时长≈8s', pr0.info.duration, 8, 0.15)
  near('v2: 源1 时长≈6s', pr1.info.duration, 6, 0.15)
  check('v2: 两源都解析出音轨', pr0.info.hasAudio && pr1.info.hasAudio)
  console.log('  v2 源: ' + path.basename(v2src0) + '(' + (gen0.cached ? '复用' : '新生成') + ') + ' + path.basename(v2src1) + '(' + (gen1.cached ? '复用' : '新生成') + ')')

  const v2Request = {
    sources: [
      { fileID: 'cloud://mock/v2_a.mp3', fileName: 'v2_src0_440_8s.mp3', size: fs.statSync(v2src0).size },
      { fileID: 'cloud://mock/v2_b.mp3', fileName: 'v2_src1_660_6s.mp3', size: fs.statSync(v2src1).size }
    ],
    clips: [
      { sourceIndex: 0, in: 0, out: 3, fadeIn: 1, fadeOut: 0.5 },
      { sourceIndex: 1, in: 1, out: 4, fadeIn: 0, fadeOut: 1 },
      { sourceIndex: 0, in: 5, out: 7, fadeIn: 0.5, fadeOut: 0.5 }
    ],
    volumeDb: -6,
    format: 'mp3',
    bitrate: '192k'
  }
  const rawPlan = core.normalizeRenderRequestV2(v2Request)
  const planV2 = core.finalizePlanV2(rawPlan, core.clampClipsToSources(rawPlan.clips, [pr0.info.duration, pr1.info.duration]))
  eq('v2: 计划成片总时长=8s（3+3+2）', planV2.totalDur, 8)
  check('v2: clips=3 / sources=2', planV2.clips.length === 3 && planV2.sources.length === 2, 'clips=' + planV2.clips.length + ' sources=' + planV2.sources.length)

  const outV2 = path.join(OUT_DIR, 'v2_multisource_2src_3clips.mp3')
  const argsV2 = core.buildRenderArgsV2([toC(v2src0), toC(v2src1)], toC(outV2), planV2)
  const runV2 = ff(argsV2)
  check('v2: ffmpeg rc=0', runV2.status === 0, runV2.stderr.slice(-300))
  check('v2: 输出文件存在且非空', fs.existsSync(outV2) && fs.statSync(outV2).size > 1024)
  if (runV2.status !== 0 || !fs.existsSync(outV2)) {
    console.error(runV2.stderr.slice(-800))
  } else {
    const ffpV2 = ffprobeDuration(outV2)
    near('v2: ffprobe 成片时长=8s（±0.2s）', ffpV2, 8, 0.2)
    check('v2: 成片完整解码通过', decodeOk(outV2))
    const st = analyzeStats(outV2, 4000, 50)
    near('v2: 精确解码时长=8s（±0.2s）', st.exactDuration, 8, 0.2)

    // 全局 -6dB 后：源0 片≈144*0.501≈72；源1 片≈36*0.501≈18
    const steady0 = meanRms(st, 1.2, 2.4) // 片段1（源0 响）
    const steady1 = meanRms(st, 3.2, 4.9) // 片段2（源1 轻）
    const steady2 = meanRms(st, 6.7, 7.4) // 片段3（源0 响）
    check('v2: 片段1（响）RMS≈72', steady0 > 55 && steady0 < 90, 'rms=' + steady0.toFixed(1))
    check('v2: 片段2（轻）RMS≈18', steady1 > 10 && steady1 < 30, 'rms=' + steady1.toFixed(1))
    check('v2: 片段3（响，同源 asplit 第二片）RMS≈72', steady2 > 55 && steady2 < 90, 'rms=' + steady2.toFixed(1))
    check(
      'v2: 拼接顺序=源0→源1→源0（响-轻-响）',
      steady0 > steady1 * 2 && steady2 > steady1 * 2,
      's0=' + steady0.toFixed(1) + ' s1=' + steady1.toFixed(1) + ' s2=' + steady2.toFixed(1)
    )
    check('v2: 同源 asplit 两个片段电平均≈源0', Math.abs(steady0 - steady2) / steady0 < 0.15, 'Δ=' + (Math.abs(steady0 - steady2) / steady0).toFixed(3))

    // 每片 fade 包络（片段时间轴，导出后验证）
    const fade1InStart = meanRms(st, 0, 0.05) / steady0
    const fade1InDone = meanRms(st, 0.95, 1.05) / steady0
    const fade1OutMid = meanRms(st, 2.7, 2.8) / steady0
    const fade2OutMid = meanRms(st, 5.4, 5.6) / steady1
    const fade3InMid = meanRms(st, 6.2, 6.3) / steady2
    const fade3OutEnd = meanRms(st, 7.95, 8) / steady2
    check('v2: 片段1 fadeIn 起点 RMS<15%', fade1InStart < 0.15, 'ratio=' + fade1InStart.toFixed(3))
    check('v2: 片段1 fadeIn 1s 后恢复>85%', fade1InDone > 0.85, 'ratio=' + fade1InDone.toFixed(3))
    check('v2: 片段1 fadeOut 中段（2.75s）≈50%', fade1OutMid > 0.2 && fade1OutMid < 0.8, 'ratio=' + fade1OutMid.toFixed(3))
    check('v2: 片段2 fadeOut 中段（5.5s）≈50%', fade2OutMid > 0.2 && fade2OutMid < 0.8, 'ratio=' + fade2OutMid.toFixed(3))
    check('v2: 片段3 fadeIn 中段（6.25s）≈50%', fade3InMid > 0.2 && fade3InMid < 0.8, 'ratio=' + fade3InMid.toFixed(3))
    check('v2: 片段3 末尾 fadeOut RMS<15%', fade3OutEnd < 0.15, 'ratio=' + fade3OutEnd.toFixed(3))

    check('v2: 无削波（max|s| ≤0.96FS）', st.maxAbs / 32768 <= 0.96, 'maxAbs=' + (st.maxAbs / 32768).toFixed(3))
    // 拼接点（3s、6s）是不同源/不同电平的硬切，排除 ±50ms 后其余最大跳变应接近自然音频
    const pcm44V2 = decodePcm(outV2, path.join(OUT_DIR, 'v2_44k.pcm'), 44100)
    const deltaV2 = pcmMaxDelta(pcm44V2, 44100, [[2.95, 3.05], [5.95, 6.05]])
    check('v2: 拼接点以外无爆音（相邻样本最大跳变<0.35）', deltaV2 < 0.35, 'maxDelta=' + deltaV2.toFixed(3))
    try {
      fs.unlinkSync(path.join(OUT_DIR, 'v2_44k.pcm'))
    } catch (e) {}

    console.log(
      '  v2: 计划=8s ffprobe=' + ffpV2.toFixed(3) + 's exact=' + st.exactDuration.toFixed(3) + 's wall=' + runV2.ms +
        'ms RMS=' + steady0.toFixed(0) + '/' + steady1.toFixed(0) + '/' + steady2.toFixed(0) + ' maxDelta=' + deltaV2.toFixed(3)
    )
    metrics.push({
      label: 'v2_multisource_3clips',
      plannedDuration: 8,
      ffprobeDuration: ffpV2,
      exactDuration: st.exactDuration,
      wallMs: runV2.ms,
      maxAbs: st.maxAbs / 32768,
      note: 'RMS=' + steady0.toFixed(0) + '/' + steady1.toFixed(0) + '/' + steady2.toFixed(0) + ' fade ok maxDelta=' + deltaV2.toFixed(3)
    })
  }

  // 顺序可调：把 clips 顺序反过来（源1 轻 → 源0 响），验证「上移/下移后导出顺序随之变化」
  const revRequest = {
    sources: v2Request.sources,
    clips: [
      { sourceIndex: 1, in: 1, out: 3, fadeIn: 0, fadeOut: 0 },
      { sourceIndex: 0, in: 0, out: 2, fadeIn: 0, fadeOut: 0 }
    ],
    volumeDb: 0,
    format: 'mp3'
  }
  const revRaw = core.normalizeRenderRequestV2(revRequest)
  const revPlan = core.finalizePlanV2(revRaw, core.clampClipsToSources(revRaw.clips, [pr0.info.duration, pr1.info.duration]))
  const outRev = path.join(OUT_DIR, 'v2_reordered_2clips.mp3')
  const runRev = ff(core.buildRenderArgsV2([toC(v2src0), toC(v2src1)], toC(outRev), revPlan))
  check('v2 反向顺序: ffmpeg rc=0', runRev.status === 0, runRev.stderr.slice(-300))
  if (runRev.status === 0 && fs.existsSync(outRev)) {
    const ffpRev = ffprobeDuration(outRev)
    near('v2 反向顺序: 时长=4s（±0.2s）', ffpRev, 4, 0.2)
    const revStats = analyzeStats(outRev, 4000, 50)
    const revFirst = meanRms(revStats, 0.5, 1.5) // 源1 轻段（无全局音量 → RMS≈36）
    const revSecond = meanRms(revStats, 2.5, 3.5) // 源0 响段（RMS≈144）
    check('v2 反向顺序: 先轻后响（clips 数组顺序即成片顺序）', revSecond > revFirst * 2.5, 'first=' + revFirst.toFixed(1) + ' second=' + revSecond.toFixed(1))
    check('v2 反向顺序: 轻段 RMS≈36', revFirst > 22 && revFirst < 50, 'rms=' + revFirst.toFixed(1))
    check('v2 反向顺序: 响段 RMS≈144', revSecond > 110 && revSecond < 175, 'rms=' + revSecond.toFixed(1))
    console.log('  v2 反向: wall=' + runRev.ms + 'ms RMS=' + revFirst.toFixed(0) + '→' + revSecond.toFixed(0) + ' dur=' + ffpRev.toFixed(3) + 's')
    metrics.push({
      label: 'v2_reordered_2clips',
      plannedDuration: 4,
      ffprobeDuration: ffpRev,
      exactDuration: revStats.exactDuration,
      wallMs: runRev.ms,
      maxAbs: revStats.maxAbs / 32768,
      note: 'order=quiet(' + revFirst.toFixed(0) + ')->loud(' + revSecond.toFixed(0) + ')'
    })
  }
}

// ---------------------------------------------------------------------------
section('11) 汇总')
const tsvPath = path.join(RESULT_DIR, 'editor-backend.tsv')
const lines = ['label\tplanned_dur\tffprobe_dur\texact_dur\twall_ms\tmax_abs\tnote']
metrics.forEach(function (m) {
  lines.push(
    [
      m.label,
      m.plannedDuration !== undefined ? m.plannedDuration : '',
      m.ffprobeDuration !== undefined ? m.ffprobeDuration : '',
      m.exactDuration !== undefined ? m.exactDuration.toFixed(4) : '',
      m.wallMs,
      m.maxAbs !== undefined ? m.maxAbs.toFixed(4) : '',
      m.note || ''
    ].join('\t')
  )
})
fs.writeFileSync(tsvPath, lines.join('\n') + '\n')
console.log('  明细已写入: ' + tsvPath)
metrics.forEach(function (m) {
  console.log(
    '  ' + m.label.padEnd(30) + ' wall=' + String(m.wallMs).padStart(6) + 'ms' +
      (m.plannedDuration !== undefined ? ' planned=' + m.plannedDuration + 's' : '') +
      (m.ffprobeDuration ? ' ffprobe=' + Number(m.ffprobeDuration).toFixed(3) + 's' : '') +
      (m.exactDuration ? ' exact=' + m.exactDuration.toFixed(3) + 's' : '') +
      (m.maxAbs !== undefined ? ' maxAbs=' + m.maxAbs.toFixed(3) : '') +
      (m.note ? '  ' + m.note : '')
  )
})

console.log('\n============================================')
console.log('Docker 实测: pass=' + pass + ' fail=' + fail)
if (fail > 0) {
  console.log('失败项：')
  failures.forEach(function (f) {
    console.log('  - ' + f)
  })
  process.exit(1)
}
console.log('全部通过 ✅（静态 FFmpeg 7.0.2 / 容器 ' + CONTAINER + '）')
