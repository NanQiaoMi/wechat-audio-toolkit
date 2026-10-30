#!/usr/bin/env node
/**
 * 音乐剪辑·云函数纯函数单测（无 Docker / 无云环境，Node 16 可直接运行）
 *
 * 覆盖 cloudfunctions/ffmpegProbe/lib/editor-core.js：
 *   - parseProbeInfo：ffmpeg -i stderr 解析（Duration / Audio / 容器格式 / 坏文件）
 *   - computePeaks：4kHz mono s16le → 50ms 桶 uint8 peak/rms → base64
 *   - normalizeEditRequest / clampSegmentsToDuration / finalizePlan：契约 §3.2 校验
 *   - buildFilterGraph / buildRenderArgs：滤镜顺序、afade 输出时间轴、alimiter、参数
 *   - playableFlags：iOS/Android 可试听格式
 *
 * 运行：
 *   node scripts/editor-spike/test_pure.js
 *   docker run --rm -v "$PWD":/repo:ro node:16-alpine node /repo/scripts/editor-spike/test_pure.js
 */
'use strict'

const path = require('path')
const core = require(path.join(__dirname, '..', '..', 'cloudfunctions', 'ffmpegProbe', 'lib', 'editor-core.js'))

let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log('  PASS ' + name)
  } else {
    fail++
    const line = name + (detail ? '  [' + detail + ']' : '')
    failures.push(line)
    console.log('  FAIL ' + line)
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, 'expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual))
}

function near(name, actual, expected, tol) {
  check(name, Math.abs(Number(actual) - expected) <= tol, 'expected ' + expected + '±' + tol + ' actual=' + actual)
}

function throwsCode(name, fn, expectedCode) {
  let got = ''
  let message = ''
  try {
    fn()
  } catch (e) {
    got = (e && e.code) || '(no code)'
    message = (e && e.message) || ''
  }
  check(name, got === expectedCode, 'expected code ' + expectedCode + ' got ' + got + ' msg=' + message)
}

function section(title) {
  console.log('\n# ' + title)
}

function meanOfUint8Array(buf, from, to) {
  let sum = 0
  let n = 0
  for (let i = from; i < to; i++) {
    sum += buf[i]
    n++
  }
  return n ? sum / n : 0
}

// ===========================================================================
section('parseProbeInfo：ffmpeg -i stderr 解析')
// ===========================================================================
const MP3_STDERR = [
  "Input #0, mp3, from 'demo.mp3':",
  '  Metadata:',
  '    encoder         : Lavf61.7.100',
  '  Duration: 00:03:00.05, start: 0.023021, bitrate: 192 kb/s',
  '  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 192 kb/s'
].join('\n')
const mp3 = core.parseProbeInfo(MP3_STDERR)
check('mp3: hasAudio', mp3.hasAudio)
near('mp3: duration=180.05', mp3.duration, 180.05, 1e-9)
eq('mp3: format', mp3.format, 'mp3')
eq('mp3: sampleRate', mp3.sampleRate, 44100)
eq('mp3: channels', mp3.channels, 2)
eq('mp3: codec', mp3.codec, 'mp3')

const M4A_STDERR = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'demo.m4a':",
  '  Duration: 00:01:02.17, start: 0.000000, bitrate: 128 kb/s',
  '  Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)'
].join('\n')
const m4a = core.parseProbeInfo(M4A_STDERR)
near('m4a: duration=62.17', m4a.duration, 62.17, 1e-9)
eq('m4a: format', m4a.format, 'm4a')
eq('m4a: channels', m4a.channels, 2)
eq('m4a: codec=aac', m4a.codec, 'aac')

const WAV_STDERR = [
  "Input #0, wav, from 'x.wav':",
  '  Duration: 00:00:30.00, bitrate: 128 kb/s',
  '  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 8000 Hz, mono, s16, 128 kb/s'
].join('\n')
const wav = core.parseProbeInfo(WAV_STDERR)
eq('wav: format', wav.format, 'wav')
eq('wav: sampleRate=8000', wav.sampleRate, 8000)
eq('wav: channels=1', wav.channels, 1)

const FLAC_STDERR = [
  "Input #0, flac, from 'x.flac':",
  '  Duration: 00:00:07.00, start: 0.000000, bitrate: 704 kb/s',
  '  Stream #0:0: Audio: flac, 44100 Hz, stereo, s32 (24 bit)'
].join('\n')
eq('flac: format', core.parseProbeInfo(FLAC_STDERR).format, 'flac')

const OGG_STDERR = [
  "Input #0, ogg, from 'x.ogg':",
  '  Duration: 00:01:00.00, start: 0.000000, bitrate: 128 kb/s',
  '  Stream #0:0: Audio: vorbis, 44100 Hz, stereo, fltp, 128 kb/s'
].join('\n')
eq('ogg: format', core.parseProbeInfo(OGG_STDERR).format, 'ogg')

const VIDEO_ONLY_STDERR = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'v.mp4':",
  '  Duration: 00:00:02.00, start: 0.000000, bitrate: 115 kb/s',
  '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 640x360, 113 kb/s, 25 fps, 25 tbr, 12800 tbn'
].join('\n')
const videoOnly = core.parseProbeInfo(VIDEO_ONLY_STDERR)
check('video-only: hasAudio=false', videoOnly.hasAudio === false)
near('video-only: duration 仍可解析', videoOnly.duration, 2.0, 1e-9)

const RANDOM_STDERR = "x.mp3: Invalid data found when processing input\n"
const randomInfo = core.parseProbeInfo(RANDOM_STDERR)
check('random: hasAudio=false', randomInfo.hasAudio === false)
check('random: isInvalidMediaText=true', core.isInvalidMediaText(RANDOM_STDERR) === true)
check('random: 正常 stderr 不误判 invalid', core.isInvalidMediaText(MP3_STDERR) === false)
eq('Duration N/A: duration=0', core.parseProbeInfo('  Duration: N/A, start: 0.000000, bitrate: N/A').duration, 0)
eq('空文本: duration=0', core.parseProbeInfo('').duration, 0)

// ===========================================================================
section('computePeaks：50ms 桶 uint8 peak/rms + base64')
// ===========================================================================
const RATE = 4000
const N = RATE * 2 // 2 秒
const pcm = Buffer.alloc(N * 2)
for (let i = 0; i < N; i++) {
  const amp = i < N / 2 ? 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE) : 0
  pcm.writeInt16LE(Math.round(amp * 32767), i * 2)
}
const peaks = core.computePeaks(pcm, RATE, 50)
eq('buckets=40 (2s/50ms)', peaks.buckets, 40)
eq('bucketSamples=200', peaks.bucketSamples, 200)
eq('sampleCount=8000', peaks.sampleCount, 8000)
near('peak[1]≈0.5*255', peaks.peak[1] / 255, 0.5, 0.01)
near('rms[1]≈0.354*255', peaks.rms[1] / 255, 0.354, 0.01)
eq('后半段 peak=0', peaks.peak[39], 0)
eq('后半段 rms=0', peaks.rms[39], 0)
eq('peak base64 长度=40', Buffer.from(peaks.peakB64, 'base64').length, 40)
eq('rms base64 长度=40', Buffer.from(peaks.rmsB64, 'base64').length, 40)
check('peak ≥ rms（逐桶）', peaks.peak.every(function (p, i) { return p + 1 >= peaks.rms[i] }))
check('字节均 ≤255', peaks.peak.every(function (v) { return v >= 0 && v <= 255 }) && peaks.rms.every(function (v) { return v >= 0 && v <= 255 }))
eq('空 PCM buckets=0', core.computePeaks(Buffer.alloc(0), RATE, 50).buckets, 0)

const odd = Buffer.from([0xff, 0x7f, 0x00]) // 1 个完整 sample=32767 + 半字节
const oddPeaks = core.computePeaks(odd, RATE, 50)
eq('奇数长度: sampleCount=1', oddPeaks.sampleCount, 1)
eq('奇数长度: peak=255', oddPeaks.peak[0], 255)

// 半正弦 1 秒（幅度 1.0），桶数=20：用于确认分桶边界
const half = Buffer.alloc(RATE * 2)
for (let i = 0; i < RATE; i++) half.writeInt16LE(Math.round(32767 * Math.sin((2 * Math.PI * 100 * i) / RATE)), i * 2)
eq('1s@4kHz buckets=20', core.computePeaks(half, RATE, 50).buckets, 20)

// ===========================================================================
section('normalizeEditRequest：契约 §3.2 参数校验')
// ===========================================================================
const okPlan = core.normalizeEditRequest({
  segments: [{ in: 12.5, out: 45 }, { in: 60, out: 90 }],
  fadeIn: 2,
  fadeOut: 1.5,
  volumeDb: -3,
  format: 'mp3',
  bitrate: '192k'
})
eq('正常: outDur=62.5', okPlan.outDur, 62.5)
eq('正常: fadeIn=2', okPlan.fadeIn, 2)
eq('正常: fadeOut=1.5', okPlan.fadeOut, 1.5)
eq('正常: volumeDb=-3', okPlan.volumeDb, -3)
eq('正常: bitrate=192k', okPlan.bitrate, '192k')

throwsCode('0 段 → PARAM_ERROR', function () { core.normalizeEditRequest({ segments: [] }) }, 'PARAM_ERROR')
throwsCode('缺 segments → PARAM_ERROR', function () { core.normalizeEditRequest({}) }, 'PARAM_ERROR')
const manySegments = []
for (let i = 0; i < 21; i++) manySegments.push({ in: i * 2, out: i * 2 + 1 })
throwsCode('21 段 → PARAM_ERROR', function () { core.normalizeEditRequest({ segments: manySegments }) }, 'PARAM_ERROR')
throwsCode('in=out → PARAM_ERROR', function () { core.normalizeEditRequest({ segments: [{ in: 5, out: 5 }] }) }, 'PARAM_ERROR')
throwsCode('in>out → PARAM_ERROR', function () { core.normalizeEditRequest({ segments: [{ in: 6, out: 5 }] }) }, 'PARAM_ERROR')
throwsCode('负数 in → PARAM_ERROR', function () { core.normalizeEditRequest({ segments: [{ in: -1, out: 5 }] }) }, 'PARAM_ERROR')
throwsCode('单片 0.1s → PARAM_ERROR', function () { core.normalizeEditRequest({ segments: [{ in: 1, out: 1.1 }] }) }, 'PARAM_ERROR')
throwsCode('非数字 → PARAM_ERROR', function () { core.normalizeEditRequest({ segments: [{ in: 'a', out: 5 }] }) }, 'PARAM_ERROR')
throwsCode('总长 601s → DURATION_TOO_LONG', function () {
  core.normalizeEditRequest({ segments: [{ in: 0, out: 300 }, { in: 300, out: 601 }] })
}, 'DURATION_TOO_LONG')
throwsCode('format=m4a → UNSUPPORTED_FORMAT', function () {
  core.normalizeEditRequest({ segments: [{ in: 0, out: 10 }], format: 'm4a' })
}, 'UNSUPPORTED_FORMAT')

const bitrateBad = core.normalizeEditRequest({ segments: [{ in: 0, out: 10 }], bitrate: '999k' })
eq('非法 bitrate 回退 192k', bitrateBad.bitrate, '192k')
const volumeHigh = core.normalizeEditRequest({ segments: [{ in: 0, out: 10 }], volumeDb: 100 })
eq('volumeDb +100 夹到 +24', volumeHigh.volumeDb, 24)
const volumeLow = core.normalizeEditRequest({ segments: [{ in: 0, out: 10 }], volumeDb: -100 })
eq('volumeDb -100 夹到 -60', volumeLow.volumeDb, -60)
const fadeClamp = core.normalizeEditRequest({ segments: [{ in: 0, out: 2 }], fadeIn: 3, fadeOut: 3 })
eq('2s 成片: fadeIn+fadeOut>时长 → 各 1s', fadeClamp.fadeIn, 1)
eq('2s 成片: fadeOut 同步缩到 1s', fadeClamp.fadeOut, 1)
const fadeOne = core.normalizeEditRequest({ segments: [{ in: 0, out: 2 }], fadeIn: 3, fadeOut: 0 })
eq('2s 成片: 仅 fadeIn 3 → 2（与前端 resolveFades 一致）', fadeOne.fadeIn, 2)
const fadeNeg = core.normalizeEditRequest({ segments: [{ in: 0, out: 20 }], fadeIn: -5, fadeOut: 0 })
eq('负数 fade → 0', fadeNeg.fadeIn, 0)
eq('fadeOut 0 保持 0', fadeNeg.fadeOut, 0)
eq('1 段 10s outDur=10', core.planOutDuration(core.normalizeEditRequest({ segments: [{ in: 0, out: 10 }] }).segments), 10)

// ===========================================================================
section('clampSegmentsToDuration / finalizePlan：服务端按真实时长裁剪')
// ===========================================================================
const clampFull = core.clampSegmentsToDuration([{ in: 0, out: 180 }], 120)
eq('out 越界 → clamp 到 120', clampFull[0].out, 120)
const clampTail = core.clampSegmentsToDuration([{ in: 100, out: 130 }], 120)
eq('尾段 clamp: in 保持', clampTail[0].in, 100)
eq('尾段 clamp: out=120', clampTail[0].out, 120)
throwsCode('整段超出时长 → PARAM_ERROR', function () {
  core.clampSegmentsToDuration([{ in: 130, out: 150 }], 120)
}, 'PARAM_ERROR')
throwsCode('clamp 后不足 0.2s → PARAM_ERROR', function () {
  core.clampSegmentsToDuration([{ in: 119.9, out: 120.5 }], 120)
}, 'PARAM_ERROR')
const noDuration = core.clampSegmentsToDuration([{ in: 1, out: 2 }], 0)
eq('duration=0 不改动', noDuration[0].out, 2)

const plan40 = core.normalizeEditRequest({ segments: [{ in: 0, out: 20 }, { in: 30, out: 50 }], fadeIn: 3, fadeOut: 3 })
eq('finalize 前 outDur=40', plan40.outDur, 40)
const finalized = core.finalizePlan(plan40, core.clampSegmentsToDuration(plan40.segments, 40))
eq('finalize 后 outDur=30', finalized.outDur, 30)
eq('finalize 保留 fadeIn=3', finalized.fadeIn, 3)

// ===========================================================================
section('buildFilterGraph / buildRenderArgs：滤镜顺序与参数（契约 §3.2）')
// ===========================================================================
const graph = core.buildFilterGraph(okPlan)
const expectedGraph =
  '[0:a]atrim=start=12.5:end=45,asetpts=PTS-STARTPTS[s0];' +
  '[0:a]atrim=start=60:end=90,asetpts=PTS-STARTPTS[s1];' +
  '[s0][s1]concat=n=2:v=0:a=1[cat];' +
  '[cat]afade=t=in:st=0:d=2,afade=t=out:st=61:d=1.5,volume=-3dB,alimiter=limit=0.95:level=false[out]'
eq('2 段完整 filter_complex 字符串', graph, expectedGraph)
check('无显式 aresample/aformat（spike 规则 6）', graph.indexOf('aresample') < 0 && graph.indexOf('aformat') < 0)
check('alimiter 在链尾且 level=false', /,alimiter=limit=0\.95:level=false\[out\]$/.test(graph))
check('afade 在 concat 之后（下标）', graph.indexOf('afade') > graph.indexOf('concat='))
check('volume 在 afade 之后（下标）', graph.indexOf('volume=') > graph.indexOf('afade='))
check('afade 淡出 st=输出时间轴(61)', graph.indexOf('afade=t=out:st=61:d=1.5') >= 0)

const graphNoFx = core.buildFilterGraph(core.normalizeEditRequest({ segments: [{ in: 0, out: 10 }] }))
eq(
  '无效果单段 filter_complex',
  graphNoFx,
  '[0:a]atrim=start=0:end=10,asetpts=PTS-STARTPTS[s0];[s0]concat=n=1:v=0:a=1[cat];[cat]alimiter=limit=0.95:level=false[out]'
)
check('volume=0 省略 volume 滤镜', core.buildFilterGraph(okPlan).indexOf('volume=0dB') < 0)

const args = core.buildRenderArgs('/tmp/in.mp3', '/tmp/out.mp3', okPlan)
const argStr = args.join(' ')
check('args 含 -filter_complex_threads 1', args[args.indexOf('-filter_complex_threads') + 1] === '1')
check('args 含 -map_metadata -1', args.indexOf('-map_metadata') >= 0 && args[args.indexOf('-map_metadata') + 1] === '-1')
check('args 含 -t 62.5', args[args.indexOf('-t') + 1] === '62.5')
check('args 含 -map [out]', args.indexOf('[out]') >= 0)
check('args 编码 libmp3lame 192k', argStr.indexOf('-c:a libmp3lame -b:a 192k') >= 0)
check('args 输出路径在最后', args[args.length - 1] === '/tmp/out.mp3')
check('args 含 -loglevel error', args.indexOf('error') >= 0)
check('args 无 -ss 快剪（必须重编码）', args.indexOf('-ss') < 0 && argStr.indexOf('-c copy') < 0)

// ===========================================================================
section('playableFlags：iOS/Android 可试听格式')
// ===========================================================================
const iosMp3 = core.playableFlags('mp3')
check('mp3: iOS/Android 可播', iosMp3.playableIos === true && iosMp3.playableAndroid === true)
const m4aFlags = core.playableFlags('m4a')
check('m4a: iOS/Android 可播', m4aFlags.playableIos === true && m4aFlags.playableAndroid === true)
const flacFlags = core.playableFlags('flac')
check('flac: iOS 不可播 / Android 可播', flacFlags.playableIos === false && flacFlags.playableAndroid === true)
const oggFlags = core.playableFlags('ogg')
check('ogg: iOS 不可播 / Android 可播', oggFlags.playableIos === false && oggFlags.playableAndroid === true)
const unknownFlags = core.playableFlags('unknown')
check('unknown: 都不可播', unknownFlags.playableIos === false && unknownFlags.playableAndroid === false)

// ===========================================================================
section('v2：多源片段 + 每片段缓入缓出（契约 §6.3）')
// ===========================================================================
const v2Event = {
  sources: [
    { fileID: 'cloud://mock/a.mp3', fileName: 'a.mp3', size: 1000 },
    { fileID: 'cloud://mock/b.wav', fileName: 'b.wav', size: 2000 }
  ],
  clips: [
    { sourceIndex: 0, in: 0, out: 3, fadeIn: 1, fadeOut: 0.5 },
    { sourceIndex: 1, in: 1, out: 4, fadeIn: 0, fadeOut: 1 },
    { sourceIndex: 0, in: 5, out: 7, fadeIn: 0.5, fadeOut: 0.5 }
  ],
  volumeDb: -3,
  format: 'mp3',
  bitrate: '192k',
  // v2 应忽略顶层全局 fade（改为每片 fade）
  fadeIn: 5,
  fadeOut: 5
}
const p2 = core.normalizeRenderRequestV2(v2Event)
eq('v2: sources=2', p2.sources.length, 2)
eq('v2: clips=3', p2.clips.length, 3)
eq('v2: totalDur=8', p2.totalDur, 8)
eq('v2: format=mp3', p2.format, 'mp3')
eq('v2: volumeDb=-3', p2.volumeDb, -3)
eq('v2: 忽略顶层 fadeIn（不产生全局 fade）', p2.fadeIn, undefined)
eq('v2: 源 fileName 保留', p2.sources[0].fileName, 'a.mp3')
eq('v2: 片段 sourceIndex 保留', p2.clips[1].sourceIndex, 1)

// 每片 fade 收敛：fadeIn+fadeOut>clipDur → 等比缩到 clipDur
const fit2 = core.applyClipFades({ in: 0, out: 2.5, fadeIn: 3, fadeOut: 3 })
eq('applyClipFades: 2.5s 片 3+3 → 各 1.25', fit2.fadeIn, 1.25)
eq('applyClipFades: 等比后 fadeOut=1.25', fit2.fadeOut, 1.25)
const fitOne = core.applyClipFades({ in: 0, out: 2.5, fadeIn: 3, fadeOut: 0 })
eq('applyClipFades: 单片只 fadeIn → 2.5', fitOne.fadeIn, 2.5)
eq('applyClipFades: 未请求 fadeOut=0', fitOne.fadeOut, 0)
check('applyClipFades: ≤5s 封顶', core.applyClipFades({ in: 0, out: 30, fadeIn: 9, fadeOut: 0 }).fadeIn === 5)

// 源真实时长 clamp
const clamped2 = core.clampClipsToSources(
  [
    { sourceIndex: 0, in: 0, out: 12, fadeIn: 0, fadeOut: 0 },
    { sourceIndex: 1, in: 5, out: 9, fadeIn: 0, fadeOut: 0 }
  ],
  [8, 6]
)
eq('clamp: 源 0 out 12→8', clamped2[0].out, 8)
eq('clamp: 源 1 in 保持 5', clamped2[1].in, 5)
eq('clamp: 源 1 out 9→6', clamped2[1].out, 6)
throwsCode('clamp: 片段起点超出源时长 → PARAM_ERROR', function () {
  core.clampClipsToSources([{ sourceIndex: 0, in: 50, out: 60, fadeIn: 0, fadeOut: 0 }], [8, 6])
}, 'PARAM_ERROR')
const clampedNoDur = core.clampClipsToSources([{ sourceIndex: 0, in: 1, out: 2, fadeIn: 0, fadeOut: 0 }], [0])
eq('clamp: 源时长未知（0）不改动', clampedNoDur[0].out, 2)

// 完整计划（clamp + fade 最终收敛）
const finalized2 = core.finalizePlanV2(p2, core.clampClipsToSources(p2.clips, [8, 6]))
eq('v2 finalize: totalDur=8', finalized2.totalDur, 8)
eq('v2 finalize: clip0 fadeIn=1', finalized2.clips[0].fadeIn, 1)
eq('v2 finalize: clip0 fadeOut=0.5', finalized2.clips[0].fadeOut, 0.5)
eq('v2 finalize: clip1 fadeOut=1', finalized2.clips[1].fadeOut, 1)
eq('v2 finalize: clip2 fade=0.5/0.5', finalized2.clips[2].fadeIn, 0.5)
const v2Short = core.finalizePlanV2(
  core.normalizeRenderRequestV2({ sources: [{ fileID: 'x' }], clips: [{ sourceIndex: 0, in: 0, out: 2, fadeIn: 3, fadeOut: 3 }] }),
  [{ sourceIndex: 0, in: 0, out: 2, fadeIn: 5, fadeOut: 5 }]
)
eq('v2 finalize: 2s 片 5+5 收敛为 1/1', v2Short.clips[0].fadeIn, 1)
eq('v2 finalize: fadeOut 同步收敛', v2Short.clips[0].fadeOut, 1)

// filter graph：同源 asplit + 每片 fade 在 concat 前（片段本地时间轴）
const graph2 = core.buildFilterGraphV2(finalized2)
const expectedGraph2 =
  '[0:a]asplit=2[s0_0][s0_2];' +
  '[s0_0]atrim=start=0:end=3,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1,afade=t=out:st=2.5:d=0.5[c0];' +
  '[1:a]atrim=start=1:end=4,asetpts=PTS-STARTPTS,afade=t=out:st=2:d=1[c1];' +
  '[s0_2]atrim=start=5:end=7,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.5,afade=t=out:st=1.5:d=0.5[c2];' +
  '[c0][c1][c2]concat=n=3:v=0:a=1[cat];' +
  '[cat]volume=-3dB,alimiter=limit=0.95:level=false[out]'
eq('v2 完整 filter_complex 字符串', graph2, expectedGraph2)
check('v2: 同源两片 asplit=2 且标签正确', graph2.indexOf('[0:a]asplit=2[s0_0][s0_2]') >= 0)
check('v2: 只引一次源直接用 [1:a]', graph2.indexOf('[1:a]atrim=start=1:end=4') >= 0)
check('v2: 每片 fade 在 concat 之前', graph2.indexOf('afade') < graph2.indexOf('concat='))
check('v2: fade 淡出 st 用片段本地时间轴（clip0 st=2.5 / clip1 st=2 / clip2 st=1.5）',
  graph2.indexOf('afade=t=out:st=2.5:d=0.5') >= 0 && graph2.indexOf('afade=t=out:st=2:d=1') >= 0 && graph2.indexOf('afade=t=out:st=1.5:d=0.5') >= 0)
check('v2: 全局 volume 在 concat 之后', graph2.indexOf('volume=-3dB') > graph2.indexOf('concat='))
check('v2: alimiter 链尾 level=false', /,alimiter=limit=0\.95:level=false\[out\]$/.test(graph2))
check('v2: asplit 在片段引用之前', graph2.indexOf('asplit=') < graph2.indexOf('atrim='))

// 单源单片段：无 asplit
const p2single = core.finalizePlanV2(
  core.normalizeRenderRequestV2({ sources: [{ fileID: 'x' }], clips: [{ sourceIndex: 0, in: 0, out: 5, fadeIn: 1, fadeOut: 1 }] }),
  [{ sourceIndex: 0, in: 0, out: 5, fadeIn: 1, fadeOut: 1 }]
)
const graph2single = core.buildFilterGraphV2(p2single)
eq(
  'v2 单源单片 filter_complex（无 asplit）',
  graph2single,
  '[0:a]atrim=start=0:end=5,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1,afade=t=out:st=4:d=1[c0];' +
    '[c0]concat=n=1:v=0:a=1[cat];[cat]alimiter=limit=0.95:level=false[out]'
)
check('v2 单源单片：无 asplit', graph2single.indexOf('asplit') < 0)
check('v2: volume=0 省略 volume 滤镜', graph2single.indexOf('volume=') < 0)

// args：多个 -i、-t 总时长、mp3 192k、SIGKILL 由 index 层保证
const args2 = core.buildRenderArgsV2(['/tmp/a.mp3', '/tmp/b.wav'], '/tmp/out.mp3', finalized2)
const argStr2 = args2.join(' ')
let iCount = 0
args2.forEach(function (a) { if (a === '-i') iCount++ })
eq('v2 args: 2 个 -i', iCount, 2)
eq('v2 args: -i 顺序与 sources 一致', args2[args2.indexOf('-i') + 1], '/tmp/a.mp3')
check('v2 args: 第二个 -i 是源 1', args2[args2.lastIndexOf('-i') + 1] === '/tmp/b.wav')
check('v2 args: -t 8', args2[args2.indexOf('-t') + 1] === '8')
check('v2 args: -filter_complex_threads 1', args2[args2.indexOf('-filter_complex_threads') + 1] === '1')
check('v2 args: -map_metadata -1', args2.indexOf('-map_metadata') >= 0 && args2[args2.indexOf('-map_metadata') + 1] === '-1')
check('v2 args: libmp3lame 192k', argStr2.indexOf('-c:a libmp3lame -b:a 192k') >= 0)
check('v2 args: 输出路径在最后', args2[args2.length - 1] === '/tmp/out.mp3')

// 校验与错误码
const sixSources = []
for (let i = 0; i < 6; i++) sixSources.push({ fileID: 'cloud://s' + i + '.mp3' })
throwsCode('v2: 6 个源 → SOURCES_TOO_MANY', function () {
  core.normalizeRenderRequestV2({ sources: sixSources, clips: [{ sourceIndex: 0, in: 0, out: 1 }] })
}, 'SOURCES_TOO_MANY')
throwsCode('v2: 空 sources → PARAM_ERROR', function () {
  core.normalizeRenderRequestV2({ sources: [], clips: [{ sourceIndex: 0, in: 0, out: 1 }] })
}, 'PARAM_ERROR')
throwsCode('v2: 空 clips → PARAM_ERROR', function () {
  core.normalizeRenderRequestV2({ sources: [{ fileID: 'x' }], clips: [] })
}, 'PARAM_ERROR')
const fortyOneClips = []
for (let i = 0; i < 41; i++) fortyOneClips.push({ sourceIndex: 0, in: i * 0.2, out: i * 0.2 + 0.2 })
throwsCode('v2: 41 个片段 → CLIPS_TOO_MANY', function () {
  core.normalizeRenderRequestV2({ sources: [{ fileID: 'x' }], clips: fortyOneClips })
}, 'CLIPS_TOO_MANY')
throwsCode('v2: sourceIndex 越界 → PARAM_ERROR', function () {
  core.normalizeRenderRequestV2({ sources: [{ fileID: 'x' }], clips: [{ sourceIndex: 1, in: 0, out: 1 }] })
}, 'PARAM_ERROR')
throwsCode('v2: 片段 0.1s → PARAM_ERROR', function () {
  core.normalizeRenderRequestV2({ sources: [{ fileID: 'x' }], clips: [{ sourceIndex: 0, in: 1, out: 1.1 }] })
}, 'PARAM_ERROR')
throwsCode('v2: 片段 in>=out → PARAM_ERROR', function () {
  core.normalizeRenderRequestV2({ sources: [{ fileID: 'x' }], clips: [{ sourceIndex: 0, in: 2, out: 2 }] })
}, 'PARAM_ERROR')
throwsCode('v2: 总时长 601s → DURATION_TOO_LONG', function () {
  core.normalizeRenderRequestV2({
    sources: [{ fileID: 'x' }],
    clips: [{ sourceIndex: 0, in: 0, out: 300 }, { sourceIndex: 0, in: 300, out: 601 }]
  })
}, 'DURATION_TOO_LONG')
throwsCode('v2: 源声明 >50MB → FILE_TOO_LARGE', function () {
  core.normalizeRenderRequestV2({
    sources: [{ fileID: 'x', size: 60 * 1024 * 1024 }],
    clips: [{ sourceIndex: 0, in: 0, out: 1 }]
  })
}, 'FILE_TOO_LARGE')
throwsCode('v2: 源缺 fileID → PARAM_ERROR', function () {
  core.normalizeRenderRequestV2({ sources: [{ fileName: 'a.mp3' }], clips: [{ sourceIndex: 0, in: 0, out: 1 }] })
}, 'PARAM_ERROR')
throwsCode('v2: format=m4a → UNSUPPORTED_FORMAT', function () {
  core.normalizeRenderRequestV2({ sources: [{ fileID: 'x' }], clips: [{ sourceIndex: 0, in: 0, out: 1 }], format: 'm4a' })
}, 'UNSUPPORTED_FORMAT')

// 多轨混音与时间差 adelay 渲染（Sprint 1）
const multiTrackPlan = {
  sources: [{ fileID: 's0' }, { fileID: 's1' }],
  clips: [
    { sourceIndex: 0, in: 0, out: 5, trackId: 'T1' },
    { sourceIndex: 1, in: 0, out: 4, trackId: 'T2', offsetSec: 3.5 }
  ],
  tracks: [
    { id: 'T1', name: '人声', volumeDb: 0 },
    { id: 'T2', name: '伴奏', volumeDb: -12 }
  ],
  volumeDb: 0
}
const multiGraph = core.buildFilterGraphV2(multiTrackPlan)
check('多轨混音：T2 带 adelay 延迟', multiGraph.indexOf('adelay=delays=3500|3500:all=1') >= 0)
check('多轨混音：T2 带 volume=-12dB', multiGraph.indexOf('volume=-12dB') >= 0)
check('多轨混音：包含 amix 混音器', multiGraph.indexOf('amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[cat]') >= 0)

// 多轨静音排除
const muteTrackPlan = {
  sources: [{ fileID: 's0' }, { fileID: 's1' }],
  clips: [
    { sourceIndex: 0, in: 0, out: 5, trackId: 'T1' },
    { sourceIndex: 1, in: 0, out: 4, trackId: 'T2', offsetSec: 3.5 }
  ],
  tracks: [
    { id: 'T1', name: '人声', volumeDb: 0 },
    { id: 'T2', name: '伴奏', mute: true }
  ],
  volumeDb: 0
}
const muteGraph = core.buildFilterGraphV2(muteTrackPlan)
check('多轨静音：T2 被静音后排除出混音', muteGraph.indexOf('trk_T2') < 0 && muteGraph.indexOf('[trk_T1]anull[cat]') >= 0)

// ===========================================================================
console.log('\n============================================')
console.log('纯函数单测: pass=' + pass + ' fail=' + fail)
if (fail > 0) {
  console.log('失败项：')
  failures.forEach(function (f) { console.log('  - ' + f) })
  process.exit(1)
}
console.log('全部通过 ✅')
