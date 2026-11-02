// cloudfunctions/ffmpegProbe/lib/editor-core.js
// 音乐剪辑的纯函数核心：无第三方依赖、不读写文件/网络，可在本地 Node 16 直接单测。
//
// 被 index.js 的 analyzeAudio / renderEdit 复用：
//   - parseProbeInfo()        解析 `ffmpeg -hide_banner -nostdin -i file` 的 stderr（未打包 ffprobe）
//   - computePeaks()          4kHz mono s16le PCM → 50ms 桶 uint8 peak/rms + base64（波形）
//   - normalizeEditRequest()  renderEdit v1 入参校验 / 归一化（单源 segments）
//   - clampSegmentsToDuration() 用服务端探测到的真实时长裁剪段落（不信任客户端）
//   - finalizePlan()          裁剪后重算成片时长与淡入淡出上限
//   - buildFilterGraph() / buildRenderArgs()  v1 滤镜图与 ffmpeg args
//
//   v2（契约 §6.3，多源片段 + 每片段缓入缓出）：
//   - normalizeRenderRequestV2()  sources[] + clips[] 校验/归一化
//   - clampClipsToSources()       按每个源的真实时长 clamp 片段 in/out
//   - applyClipFades()            每片 fade 收敛（≤5s，fadeIn+fadeOut≤片段时长时等比缩）
//   - finalizePlanV2()            收敛后重算总时长与每片 fade
//   - buildFilterGraphV2()        同源 asplit → 每片 atrim+asetpts+fade → concat → volume → alimiter
//   - buildRenderArgsV2()         多 -i 输入 + filter_complex + -t 的完整 args
//
// 契约：docs/EDITOR_IMPL_CONTRACT.md §3.1 / §3.2 / §6.3
// 实测依据：docs/research/FFMPEG_EDIT_SPIKE.md
'use strict'

// ---- 波形参数（契约 §3.1）----
const SAMPLE_RATE = 4000 // 波形解码采样率
const BUCKET_MS = 50 // 每桶 50ms
const SAMPLES_PER_BUCKET = Math.round((SAMPLE_RATE * BUCKET_MS) / 1000) // 200 samples

// ---- 剪辑限额（契约 §3.2 / §6.3）----
const MAX_SEGMENTS = 20 // v1 单源 1~20 段
const MAX_SOURCES = 5 // v2 多源 1~5 个文件
const MAX_CLIPS = 40 // v2 片段 1~40 段
const MIN_SEGMENT_SEC = 0.2 // 单片最短 0.2s
const MAX_OUTPUT_SEC = 600 // 成片最长 600s（10min）
const MAX_FADE_SEC = 5 // 淡入淡出最长 5s（前端选项最大 3s，留余量）
const MAX_INPUT_BYTES = 50 * 1024 * 1024 // 源文件 ≤50MB
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024 // 成片 ≤50MB（mp3 192k 600s ≈14MB，兜底）
const BITRATES = ['64k', '96k', '128k', '192k', '256k', '320k']
const DEFAULT_BITRATE = '192k'
const OUTPUT_FORMATS = ['mp3'] // MVP 只导出 mp3（契约 §3.2）
const LIMITER = 'alimiter=limit=0.95:level=false' // 必须 level=false（spike §2.5 坑 P6）

// iOS/Android 可试听格式（契约 §3.1：iOS 支持 mp3/m4a/aac/wav；Android 额外 flac/ogg）
const PLAYABLE_IOS = ['mp3', 'm4a', 'aac', 'wav']
const PLAYABLE_ANDROID = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg']

// 坏文件特征（ffmpeg -i 的 stderr；退出码恒 1，不能判失败）
const INVALID_MEDIA_RE = /Invalid data found|moov atom not found|could not find codec parameters|Unknown input format|No such file or directory|Error opening input|is not a valid|Format .* detected only with low score/i

const CHANNEL_LAYOUT_MAP = {
  mono: 1,
  stereo: 2,
  '2.1': 3,
  '3.0': 3,
  '3.0(back)': 3,
  '4.0': 4,
  quad: 4,
  'quad(side)': 4,
  '5.0': 5,
  '5.1': 6,
  '5.1(side)': 6,
  '6.0': 6,
  '6.1': 7,
  '7.0': 7,
  '7.1': 8
}

function codedError(code, message) {
  const err = new Error(message)
  err.code = code
  // 供 index.js 区分「自己构造的用户可读错误」和底层异常（后者统一 INTERNAL）
  err.isEditorError = true
  return err
}

function round3(value) {
  const n = Number(value)
  if (!isFinite(n)) return 0
  return Math.round((n + (n >= 0 ? 1 : -1) * Number.EPSILON) * 1000) / 1000
}

function isFiniteNumber(value) {
  return value !== null && value !== undefined && value !== '' && isFinite(Number(value))
}

function channelsFromLayout(layout) {
  const key = String(layout || '')
    .trim()
    .toLowerCase()
  if (CHANNEL_LAYOUT_MAP[key] !== undefined) return CHANNEL_LAYOUT_MAP[key]
  if (key.indexOf('mono') >= 0) return 1
  if (key.indexOf('stereo') >= 0) return 2
  const dot = /^(\d+)\.(\d+)/.exec(key)
  if (dot) return Number(dot[1]) + Number(dot[2])
  const ch = /(\d+)\s*channels?/.exec(key)
  if (ch) return Number(ch[1])
  return 0
}

// 容器/编码 → 对用户展示的 format 名（契约示例：mp3）
function normalizeFormat(container, codec) {
  const tokens = String(container || '')
    .split(',')
    .map(function (s) {
      return s.trim()
    })
    .filter(Boolean)
  const has = function (name) {
    return tokens.indexOf(name) >= 0
  }
  if (has('mp3')) return 'mp3'
  if (has('mov') || has('mp4') || has('m4a') || has('3gp') || has('3g2') || has('mj2')) return 'm4a'
  if (has('wav') || has('wave')) return 'wav'
  if (has('flac')) return 'flac'
  if (has('ogg')) return 'ogg'
  if (has('webm') || has('matroska')) return 'webm'
  if (has('aac')) return 'aac'
  // 容器未知时用音频编码兜底
  const k = String(codec || '').toLowerCase()
  if (k.indexOf('mp3') >= 0) return 'mp3'
  if (k.indexOf('aac') >= 0) return 'aac'
  if (k.indexOf('flac') >= 0) return 'flac'
  if (k.indexOf('vorbis') >= 0 || k.indexOf('opus') >= 0) return 'ogg'
  if (k.indexOf('pcm') >= 0) return 'wav'
  return 'unknown'
}

/**
 * 解析 `ffmpeg -hide_banner -nostdin -i <file>` 的 stderr。
 * 注意：该命令没有输出参数，退出码恒为 1 —— 只能靠 stderr 内容判断（spike 坑 P11）。
 *
 * @param {string} rawText stderr（可拼上 stdout）
 * @returns {{duration:number, format:string, sampleRate:number, channels:number,
 *            codec:string, container:string, hasAudio:boolean}}
 */
function parseProbeInfo(rawText) {
  const text = String(rawText || '')
  const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
  const duration = durationMatch
    ? round3(Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]))
    : 0

  const audioMatch = /Audio:\s*([^,\n]+),\s*(\d+)\s*Hz,\s*([^,\n]+)/.exec(text)
  const inputMatch = /Input #0,\s*([^,\n]+)/.exec(text)

  const codec = audioMatch
    ? String(audioMatch[1])
        .replace(/\s*\(.*$/, '')
        .trim()
        .toLowerCase()
    : ''
  const sampleRate = audioMatch ? Number(audioMatch[2]) : 0
  const channelLayout = audioMatch ? String(audioMatch[3]).trim().toLowerCase() : ''
  const channels = channelLayout ? channelsFromLayout(channelLayout) : 0
  const container = inputMatch ? String(inputMatch[1]).trim().toLowerCase() : ''
  const format = normalizeFormat(container, codec)

  return {
    duration: duration > 0 ? duration : 0,
    format: format,
    sampleRate: sampleRate > 0 ? sampleRate : 0,
    channels: channels,
    codec: codec,
    container: container,
    hasAudio: !!audioMatch
  }
}

function toByte(ratio) {
  const v = Math.round((isFinite(ratio) ? ratio : 0) * 255)
  if (v < 0) return 0
  if (v > 255) return 255
  return v
}

/**
 * 服务端波形：PCM(s16le mono) → 50ms 桶 uint8 peak/rms（0~255）+ base64。
 * peak = max|s16| / 32768；rms = sqrt(mean(s^2)) / 32768（契约 §3.1）。
 *
 * @param {Buffer} pcm         s16le 单声道 PCM
 * @param {number} [sampleRate]
 * @param {number} [bucketMs]
 * @returns {{buckets:number, peak:Buffer, rms:Buffer, peakB64:string, rmsB64:string,
 *            sampleCount:number, sampleRate:number, bucketMs:number, bucketSamples:number}}
 */
function computePeaks(pcm, sampleRate, bucketMs) {
  const buf = Buffer.isBuffer(pcm) ? pcm : Buffer.alloc(0)
  const rate = Number(sampleRate) > 0 ? Number(sampleRate) : SAMPLE_RATE
  const ms = Number(bucketMs) > 0 ? Number(bucketMs) : BUCKET_MS
  const bucketSamples = Math.max(1, Math.round((rate * ms) / 1000))
  const sampleCount = Math.floor(buf.length / 2)
  const buckets = sampleCount > 0 ? Math.ceil(sampleCount / bucketSamples) : 0
  const peak = Buffer.alloc(buckets)
  const rms = Buffer.alloc(buckets)

  for (let b = 0; b < buckets; b++) {
    const start = b * bucketSamples
    const end = Math.min(sampleCount, start + bucketSamples)
    let maxAbs = 0
    let sumSq = 0
    for (let i = start; i < end; i++) {
      const s = buf.readInt16LE(i * 2)
      const abs = s < 0 ? -s : s
      if (abs > maxAbs) maxAbs = abs
      sumSq += s * s
    }
    const n = end - start > 0 ? end - start : 1
    peak[b] = toByte(maxAbs / 32768)
    rms[b] = toByte(Math.sqrt(sumSq / n) / 32768)
  }

  return {
    buckets: buckets,
    peak: peak,
    rms: rms,
    peakB64: peak.toString('base64'),
    rmsB64: rms.toString('base64'),
    sampleCount: sampleCount,
    sampleRate: rate,
    bucketMs: ms,
    bucketSamples: bucketSamples
  }
}

function playableFlags(format) {
  const f = String(format || '').toLowerCase()
  return {
    playableIos: PLAYABLE_IOS.indexOf(f) >= 0,
    playableAndroid: PLAYABLE_ANDROID.indexOf(f) >= 0
  }
}

function isInvalidMediaText(rawText) {
  return INVALID_MEDIA_RE.test(String(rawText || ''))
}

function normalizeSegments(rawSegments) {
  if (!Array.isArray(rawSegments) || rawSegments.length < 1 || rawSegments.length > MAX_SEGMENTS) {
    throw codedError('PARAM_ERROR', '剪辑片段需为 1~' + MAX_SEGMENTS + ' 段')
  }
  let total = 0
  const segments = rawSegments.map(function (seg, i) {
    const idx = i + 1
    if (!seg || typeof seg !== 'object') throw codedError('PARAM_ERROR', '第 ' + idx + ' 段参数无效')
    const inSec = Number(seg.in)
    const outSec = Number(seg.out)
    if (!isFinite(inSec) || !isFinite(outSec)) throw codedError('PARAM_ERROR', '第 ' + idx + ' 段起止时间无效')
    if (inSec < 0) throw codedError('PARAM_ERROR', '第 ' + idx + ' 段开始时间不能为负数')
    if (!(inSec < outSec)) throw codedError('PARAM_ERROR', '第 ' + idx + ' 段开始时间必须小于结束时间')
    const len = outSec - inSec
    if (len < MIN_SEGMENT_SEC - 1e-9) {
      throw codedError('PARAM_ERROR', '第 ' + idx + ' 段太短（至少 ' + MIN_SEGMENT_SEC + ' 秒）')
    }
    total += len
    return { in: round3(inSec), out: round3(outSec) }
  })
  if (total > MAX_OUTPUT_SEC + 1e-9) {
    throw codedError('DURATION_TOO_LONG', '成片时长需在 ' + MAX_OUTPUT_SEC / 60 + ' 分钟以内（当前约 ' + round3(total) + ' 秒）')
  }
  return segments
}

function planOutDuration(segments) {
  let total = 0
  for (let i = 0; i < segments.length; i++) total += segments[i].out - segments[i].in
  return round3(total)
}

/**
 * 用服务端探测到的真实源时长裁剪 segments（不信任客户端；spike §2.1 "越界裁剪"）。
 * out 超过源尾时 clamp 到源尾；in 已超出源时长则报错。
 */
function clampSegmentsToDuration(segments, duration) {
  const maxSec = Number(duration)
  if (!isFinite(maxSec) || maxSec <= 0) {
    return segments.map(function (s) {
      return { in: s.in, out: s.out }
    })
  }
  return segments.map(function (seg, i) {
    const idx = i + 1
    const inSec = Math.min(Math.max(0, seg.in), maxSec)
    const outSec = Math.min(Math.max(0, seg.out), maxSec)
    if (inSec >= maxSec - 1e-6) {
      throw codedError('PARAM_ERROR', '第 ' + idx + ' 段起点超出音频时长（' + round3(maxSec) + ' 秒）')
    }
    const len = outSec - inSec
    // 容差 0.05s：`Duration:` 是估算值，尾部可能略小于客户端时长
    if (len < MIN_SEGMENT_SEC - 0.05) {
      throw codedError('PARAM_ERROR', '第 ' + idx + ' 段超出音频范围，有效长度不足 ' + MIN_SEGMENT_SEC + ' 秒')
    }
    return { in: round3(inSec), out: round3(outSec) }
  })
}

function normalizeBitrate(raw) {
  const value = String(raw || DEFAULT_BITRATE).toLowerCase()
  return BITRATES.indexOf(value) >= 0 ? value : DEFAULT_BITRATE
}

function normalizeVolumeDb(raw) {
  if (!isFiniteNumber(raw)) return 0
  const v = Number(raw)
  if (v === 0) return 0
  return round3(Math.max(-60, Math.min(24, v)))
}

function toNonNegative(raw) {
  if (!isFiniteNumber(raw)) return 0
  const v = Number(raw)
  return v > 0 ? v : 0
}

// 淡入淡出归一：先按 ≤5s 封顶，再保证「淡入+淡出 ≤ 成片时长」（与前端 editor-utils.resolveFades 规则一致，
// 避免客户端预览/服务端成片的淡化时长不一致；spike §2.4：d 超过片段时长 FFmpeg 会静默铺满，故必须服务端校验）
function applyFades(requested, outDur) {
  const dur = Number(outDur) > 0 ? Number(outDur) : 0
  if (dur <= 0) return { fadeIn: 0, fadeOut: 0 }
  let fadeIn = Math.min(toNonNegative(requested && requested.fadeIn), MAX_FADE_SEC, dur)
  let fadeOut = Math.min(toNonNegative(requested && requested.fadeOut), MAX_FADE_SEC, dur)
  if (fadeIn + fadeOut > dur) {
    const scale = dur / (fadeIn + fadeOut)
    fadeIn = fadeIn * scale
    fadeOut = fadeOut * scale
  }
  return { fadeIn: round3(fadeIn), fadeOut: round3(fadeOut) }
}

/**
 * 校验 renderEdit 入参（下载前先做便宜校验，失败直接返回明确错误码）。
 * @returns {{segments:Array, outDur:number, format:string, bitrate:string, volumeDb:number,
 *            requestFadeIn:number, requestFadeOut:number, fadeIn:number, fadeOut:number}}
 */
function normalizeEditRequest(event) {
  const ev = event || {}
  const segments = normalizeSegments(ev.segments)
  const format = String(ev.format || 'mp3').toLowerCase()
  if (OUTPUT_FORMATS.indexOf(format) < 0) {
    throw codedError('UNSUPPORTED_FORMAT', '当前仅支持导出 MP3')
  }
  const outDur = planOutDuration(segments)
  const requested = { fadeIn: toNonNegative(ev.fadeIn), fadeOut: toNonNegative(ev.fadeOut) }
  const fades = applyFades(requested, outDur)
  return {
    segments: segments,
    outDur: outDur,
    format: format,
    bitrate: normalizeBitrate(ev.bitrate),
    volumeDb: normalizeVolumeDb(ev.volumeDb),
    requestFadeIn: requested.fadeIn,
    requestFadeOut: requested.fadeOut,
    fadeIn: fades.fadeIn,
    fadeOut: fades.fadeOut
  }
}

/** 源时长裁剪后重算时间轴，并按新的成片时长重新限制淡入淡出 */
function finalizePlan(plan, segments) {
  const outDur = planOutDuration(segments)
  if (outDur > MAX_OUTPUT_SEC + 1e-9) {
    throw codedError('DURATION_TOO_LONG', '成片时长需在 ' + MAX_OUTPUT_SEC / 60 + ' 分钟以内（当前约 ' + outDur + ' 秒）')
  }
  const fades = applyFades({ fadeIn: plan.requestFadeIn, fadeOut: plan.requestFadeOut }, outDur)
  return {
    segments: segments,
    outDur: outDur,
    format: plan.format,
    bitrate: plan.bitrate,
    volumeDb: plan.volumeDb,
    fadeIn: fades.fadeIn,
    fadeOut: fades.fadeOut
  }
}

function fmtSec(value) {
  const n = round3(Number(value) || 0)
  return String(n === 0 ? 0 : n)
}

/**
 * 生成 filter_complex（契约 §3.2 + spike §6.3 规则）：
 *   每段 atrim+asetpts → concat → afade(in/out, st 用输出时间轴) → volume → alimiter
 * 注意：afade 在 concat 之后；alimiter 最后且必须 level=false。
 */
function buildFilterGraph(plan) {
  const segments = plan.segments || []
  const parts = []
  const labels = []
  segments.forEach(function (seg, i) {
    parts.push('[0:a]atrim=start=' + fmtSec(seg.in) + ':end=' + fmtSec(seg.out) + ',asetpts=PTS-STARTPTS[s' + i + ']')
    labels.push('[s' + i + ']')
  })
  parts.push(labels.join('') + 'concat=n=' + segments.length + ':v=0:a=1[cat]')

  const chain = []
  if (plan.fadeIn > 0) chain.push('afade=t=in:st=0:d=' + fmtSec(plan.fadeIn))
  if (plan.fadeOut > 0) {
    const fadeOutStart = Math.max(0, round3(plan.outDur - plan.fadeOut))
    chain.push('afade=t=out:st=' + fmtSec(fadeOutStart) + ':d=' + fmtSec(plan.fadeOut))
  }
  if (plan.volumeDb) chain.push('volume=' + fmtSec(plan.volumeDb) + 'dB')
  chain.push(LIMITER)
  parts.push('[cat]' + chain.join(',') + '[out]')
  return parts.join(';')
}

const ENCODERS = {
  mp3: function (bitrate) {
    return ['-c:a', 'libmp3lame', '-b:a', bitrate]
  }
}

/**
 * 生成完整 ffmpeg args（不含二进制路径）。
 * 顺序：通用参数（含 -filter_complex_threads 1）→ -i → filter_complex → -map → -map_metadata -1 → -t → 编码参数 → 输出。
 */
function buildRenderArgs(inputPath, outputPath, plan) {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-filter_complex_threads',
    '1',
    '-i',
    inputPath,
    '-filter_complex',
    buildFilterGraph(plan),
    '-map',
    '[out]',
    '-map_metadata',
    '-1',
    '-t',
    fmtSec(plan.outDur)
  ]
  const encoder = ENCODERS[plan.format] || ENCODERS.mp3
  const encoderArgs = encoder(plan.bitrate || DEFAULT_BITRATE)
  for (let i = 0; i < encoderArgs.length; i++) args.push(encoderArgs[i])
  args.push(outputPath)
  return args
}

// ===========================================================================
// v2：多源片段拼接 + 每片段缓入缓出（契约 §6.3）
// 请求形态：{ sources:[{fileID,fileName,size}], clips:[{sourceIndex,in,out,fadeIn,fadeOut}], volumeDb, ... }
// 注意：v2 不读顶层 fadeIn/fadeOut（淡入淡出改为每片段独立）；v1 segments 路径完全不受影响。
// ===========================================================================

function normalizeSourceV2(raw, index) {
  const idx = index + 1
  if (!raw || typeof raw !== 'object') throw codedError('PARAM_ERROR', '第 ' + idx + ' 个源文件参数无效')
  const fileID = String(raw.fileID || '').trim()
  if (!fileID) throw codedError('PARAM_ERROR', '第 ' + idx + ' 个源文件缺少 fileID')
  const size = isFiniteNumber(raw.size) ? Math.max(0, Number(raw.size)) : 0
  if (size > MAX_INPUT_BYTES) {
    throw codedError('FILE_TOO_LARGE', '第 ' + idx + ' 个源文件超过 50MB，请压缩或换用更短的音频')
  }
  return {
    fileID: fileID,
    fileName: String(raw.fileName || ''),
    size: size
  }
}

function normalizeClipsV2(rawClips, sourceCount) {
  if (!Array.isArray(rawClips) || rawClips.length < 1) {
    throw codedError('PARAM_ERROR', '剪辑片段需为 1~' + MAX_CLIPS + ' 段')
  }
  if (rawClips.length > MAX_CLIPS) {
    throw codedError('CLIPS_TOO_MANY', '片段数超过 ' + MAX_CLIPS + ' 段，请先合并或删除部分片段')
  }
  let total = 0
  const clips = rawClips.map(function (clip, i) {
    const idx = i + 1
    if (!clip || typeof clip !== 'object') throw codedError('PARAM_ERROR', '第 ' + idx + ' 个片段参数无效')
    const sourceIndex = Number(clip.sourceIndex)
    if (!isFinite(sourceIndex) || Math.floor(sourceIndex) !== sourceIndex || sourceIndex < 0 || sourceIndex >= sourceCount) {
      throw codedError('PARAM_ERROR', '第 ' + idx + ' 个片段的源文件序号无效')
    }
    const inSec = Number(clip.in)
    const outSec = Number(clip.out)
    if (!isFinite(inSec) || !isFinite(outSec)) throw codedError('PARAM_ERROR', '第 ' + idx + ' 个片段起止时间无效')
    if (inSec < 0) throw codedError('PARAM_ERROR', '第 ' + idx + ' 个片段开始时间不能为负数')
    if (!(inSec < outSec)) throw codedError('PARAM_ERROR', '第 ' + idx + ' 个片段开始时间必须小于结束时间')
    const len = outSec - inSec
    if (len < MIN_SEGMENT_SEC - 1e-9) {
      throw codedError('PARAM_ERROR', '第 ' + idx + ' 个片段太短（至少 ' + MIN_SEGMENT_SEC + ' 秒）')
    }
    total += len
    const outClip = {
      sourceIndex: sourceIndex,
      in: round3(inSec),
      out: round3(outSec),
      // 先只做「≥0、≤5」收敛；等源时长 clamp 后再按片段时长等比收敛（finalizePlanV2）
      fadeIn: round3(Math.min(toNonNegative(clip.fadeIn), MAX_FADE_SEC)),
      fadeOut: round3(Math.min(toNonNegative(clip.fadeOut), MAX_FADE_SEC))
    }
    if (clip.trackId !== undefined) outClip.trackId = String(clip.trackId)
    if (clip.offsetSec !== undefined) outClip.offsetSec = round3(toNonNegative(clip.offsetSec))
    if (clip.speed !== undefined) outClip.speed = Number(clip.speed)
    if (clip.eqPreset !== undefined) outClip.eqPreset = String(clip.eqPreset)
    if (clip.denoise !== undefined) outClip.denoise = Number(clip.denoise)
    if (clip.volumeDb !== undefined) outClip.volumeDb = round3(clip.volumeDb)
    return outClip
  })
  if (total > MAX_OUTPUT_SEC + 1e-9) {
    throw codedError('DURATION_TOO_LONG', '成片时长需在 ' + MAX_OUTPUT_SEC / 60 + ' 分钟以内（当前约 ' + round3(total) + ' 秒）')
  }
  return clips
}

function planClipsDuration(clips) {
  let total = 0
  const trackEndSec = {}
  const trackIds = {}
  for (let i = 0; i < clips.length; i++) {
    const dur = clips[i].out - clips[i].in
    total += dur
    const tid = clips[i].trackId || 'T1'
    if (clips[i].trackId) trackIds[clips[i].trackId] = true
    const start = typeof clips[i].offsetSec === 'number' && clips[i].offsetSec > 0 ? clips[i].offsetSec : (trackEndSec[tid] || 0)
    trackEndSec[tid] = start + dur
  }
  if (Object.keys(trackIds).length > 1) {
    let maxEnd = 0
    Object.keys(trackEndSec).forEach(function (tid) {
      if (trackEndSec[tid] > maxEnd) maxEnd = trackEndSec[tid]
    })
    return round3(Math.max(total, maxEnd))
  }
  return round3(total)
}

/**
 * 每片 fade 收敛（契约 §6.3）：≥0、≤5s；若 fadeIn+fadeOut > clipDur，等比缩到 clipDur。
 * 与前端 editor-utils 的片段 fade 收敛规则一致，保证预览与成片听感一致。
 * @param {{in:number,out:number,fadeIn:number,fadeOut:number}} clip
 * @returns {{fadeIn:number,fadeOut:number}}
 */
function applyClipFades(clip) {
  const clipDur = round3(Number(clip && clip.out) - Number(clip && clip.in))
  const fades = applyFades({ fadeIn: clip && clip.fadeIn, fadeOut: clip && clip.fadeOut }, clipDur)
  return { fadeIn: fades.fadeIn, fadeOut: fades.fadeOut }
}

/**
 * 用每个源的真实时长 clamp 片段（不信任客户端；各源可能长度不同）。
 * @param {Array} clips
 * @param {number[]} sourceDurations 与 sources 同序的秒数（<=0 表示未知，跳过 clamp）
 */
function clampClipsToSources(clips, sourceDurations) {
  const durations = Array.isArray(sourceDurations) ? sourceDurations : []
  return clips.map(function (clip, i) {
    const idx = i + 1
    const dur = Number(durations[clip.sourceIndex])
    const outClip = { sourceIndex: clip.sourceIndex, in: clip.in, out: clip.out, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut }
    ;['trackId', 'offsetSec', 'speed', 'eqPreset', 'denoise', 'volumeDb'].forEach(function (k) {
      if (clip[k] !== undefined) outClip[k] = clip[k]
    })
    if (!isFinite(dur) || dur <= 0) return outClip
    const inSec = Math.min(Math.max(0, clip.in), dur)
    const outSec = Math.min(Math.max(0, clip.out), dur)
    if (inSec >= dur - 1e-6) {
      throw codedError('PARAM_ERROR', '第 ' + idx + ' 个片段起点超出源文件时长（' + round3(dur) + ' 秒）')
    }
    const len = outSec - inSec
    // 容差 0.05s：`Duration:` 是估算值，源尾可能略短于客户端时长
    if (len < MIN_SEGMENT_SEC - 0.05) {
      throw codedError('PARAM_ERROR', '第 ' + idx + ' 个片段超出源文件范围，有效长度不足 ' + MIN_SEGMENT_SEC + ' 秒')
    }
    outClip.in = round3(inSec)
    outClip.out = round3(outSec)
    return outClip
  })
}

/**
 * v2 入参校验（下载前；便宜校验，失败直接返回明确错误码）。
 * @returns {{sources:Array, clips:Array, totalDur:number, format:string, bitrate:string, volumeDb:number}}
 */
function normalizeRenderRequestV2(event) {
  const ev = event || {}
  if (!Array.isArray(ev.sources) || ev.sources.length < 1) {
    throw codedError('PARAM_ERROR', '请至少提供 1 个源文件')
  }
  if (ev.sources.length > MAX_SOURCES) {
    throw codedError('SOURCES_TOO_MANY', '最多支持 ' + MAX_SOURCES + ' 个源文件')
  }
  const sources = ev.sources.map(normalizeSourceV2)
  const clips = normalizeClipsV2(ev.clips, sources.length)
  const format = String(ev.format || 'mp3').toLowerCase()
  if (OUTPUT_FORMATS.indexOf(format) < 0) {
    throw codedError('UNSUPPORTED_FORMAT', '当前仅支持导出 MP3')
  }
  return {
    sources: sources,
    clips: clips,
    totalDur: planClipsDuration(clips),
    format: format,
    bitrate: normalizeBitrate(ev.bitrate),
    volumeDb: normalizeVolumeDb(ev.volumeDb)
  }
}

/** 源时长 clamp 后重算总时长，并对每片 fade 做最终等比收敛 */
function finalizePlanV2(plan, clips) {
  const totalDur = planClipsDuration(clips)
  if (totalDur > MAX_OUTPUT_SEC + 1e-9) {
    throw codedError('DURATION_TOO_LONG', '成片时长需在 ' + MAX_OUTPUT_SEC / 60 + ' 分钟以内（当前约 ' + totalDur + ' 秒）')
  }
  const finalized = clips.map(function (clip) {
    const fades = applyClipFades(clip)
    const outClip = {
      sourceIndex: clip.sourceIndex,
      in: clip.in,
      out: clip.out,
      fadeIn: fades.fadeIn,
      fadeOut: fades.fadeOut
    }
    ;['trackId', 'offsetSec', 'speed', 'eqPreset', 'denoise', 'volumeDb'].forEach(function (k) {
      if (clip[k] !== undefined) outClip[k] = clip[k]
    })
    return outClip
  })
  return {
    sources: plan.sources,
    clips: finalized,
    totalDur: totalDur,
    format: plan.format,
    bitrate: plan.bitrate,
    volumeDb: plan.volumeDb
  }
}

/**
 * v2 filter_complex（契约 §6.3，支持多轨道与内置声音工具）：
 *   [s:a]asplit=k[...]（同源被多片引用时）
 *   每片：[label]atrim+asetpts[,atempo][,equalizer/bass/treble][,highpass][,volume][,afade in][,afade out] → [cN]
 *   单轨或多轨混音：
 *     若所有片在同轨 -> [c0]..[cn]concat=n=N:v=0:a=1[cat]
 *     若跨轨 (A1/A2/A3) -> 每轨 concat -> [trk_A1][trk_A2]amix=inputs=M...[cat]
 *   全局：[cat]volume（0 可省）,alimiter=limit=0.95:level=false[out]
 */
function buildFilterGraphV2(plan) {
  const sources = plan.sources || []
  const clips = plan.clips || []
  const parts = []

  // 每个源被哪些 clip 引用（按 clips 顺序）
  const refs = sources.map(function () {
    return []
  })
  clips.forEach(function (clip, j) {
    refs[clip.sourceIndex].push(j)
  })

  // 1) 同源多片段：先 asplit，标签在引用前定义
  refs.forEach(function (clipIndexes, s) {
    if (clipIndexes.length > 1) {
      let outLabels = ''
      clipIndexes.forEach(function (j) {
        outLabels += '[s' + s + '_' + j + ']'
      })
      parts.push('[' + s + ':a]asplit=' + clipIndexes.length + outLabels)
    }
  })

  // 2) 每个片段：atrim+asetpts → 音效处理滤镜 → 本片 fade
  clips.forEach(function (clip, j) {
    const clipDur = round3(clip.out - clip.in)
    const many = refs[clip.sourceIndex].length > 1
    const inputLabel = many ? '[s' + clip.sourceIndex + '_' + j + ']' : '[' + clip.sourceIndex + ':a]'
    const chain = ['atrim=start=' + fmtSec(clip.in) + ':end=' + fmtSec(clip.out), 'asetpts=PTS-STARTPTS']

    // 简易音频处理工具：
    // ① 变速变调（atempo 仅接受 0.5~2.0）
    if (clip.speed && clip.speed > 0 && clip.speed !== 1.0) {
      chain.push('atempo=' + clip.speed)
    }
    // ② 风格 EQ 均衡器
    if (clip.eqPreset === 'vocal') {
      chain.push('equalizer=f=2500:width_type=h:width=1200:g=4,highpass=f=100')
    } else if (clip.eqPreset === 'radio') {
      chain.push('highpass=f=400,lowpass=f=3200')
    } else if (clip.eqPreset === 'bass') {
      chain.push('bass=g=6:f=100')
    } else if (clip.eqPreset === 'treble') {
      chain.push('treble=g=5:f=6000')
    } else if (clip.eqPreset === 'warm') {
      chain.push('equalizer=f=350:width_type=h:width=250:g=3,lowpass=f=12000')
    }
    // ③ 智能降噪
    if (clip.denoise && clip.denoise > 0) {
      chain.push('highpass=f=80,lowpass=f=12000')
    }
    // ④ 片段增益
    if (clip.volumeDb && Math.abs(clip.volumeDb) > 0.05) {
      chain.push('volume=' + fmtSec(clip.volumeDb) + 'dB')
    }

    if (clip.fadeIn > 0) chain.push('afade=t=in:st=0:d=' + fmtSec(clip.fadeIn))
    if (clip.fadeOut > 0) {
      const effDur = clip.speed && clip.speed !== 1.0 ? round3(clipDur / clip.speed) : clipDur
      const fadeOutStart = Math.max(0, round3(effDur - clip.fadeOut))
      chain.push('afade=t=out:st=' + fmtSec(fadeOutStart) + ':d=' + fmtSec(clip.fadeOut))
    }
    parts.push(inputLabel + chain.join(',') + '[c' + j + ']')
  })

  // 3) 多轨道混音 (Multi-Track Mixing) 或 单轨连续拼接 (Sequential Concat)
  const trackIds = {}
  clips.forEach(function (c) {
    if (c.trackId) trackIds[c.trackId] = true
  })
  const distinctTracks = Object.keys(trackIds)
  if (distinctTracks.length > 1) {
    const trackOutputs = []
    const trackDefs = Array.isArray(plan.tracks) ? plan.tracks : []
    const trackMap = {}
    trackDefs.forEach(function (t) { if (t && t.id) trackMap[t.id] = t })

    distinctTracks.forEach(function (tid) {
      const trackClips = []
      clips.forEach(function (c, idx) {
        if (c.trackId === tid) trackClips.push(idx)
      })
      if (trackClips.length > 0) {
        const tDef = trackMap[tid]
        // 轨道被静音则不混入最终成片
        if (tDef && tDef.mute) return

        let trkConcatLabels = ''
        trackClips.forEach(function (idx) {
          trkConcatLabels += '[c' + idx + ']'
        })
        let currentLabel = 'trk_' + tid
        parts.push(trkConcatLabels + 'concat=n=' + trackClips.length + ':v=0:a=1[' + currentLabel + ']')

        // 若首片段带 offsetSec > 0，增加 adelay 实现精确时间差对齐
        const firstClip = clips[trackClips[0]]
        if (firstClip && typeof firstClip.offsetSec === 'number' && firstClip.offsetSec > 0) {
          const delayMs = Math.round(firstClip.offsetSec * 1000)
          const delayLabel = currentLabel + '_d'
          parts.push('[' + currentLabel + ']adelay=delays=' + delayMs + '|' + delayMs + ':all=1[' + delayLabel + ']')
          currentLabel = delayLabel
        }

        // 若该轨设置了轨道音量
        if (tDef && typeof tDef.volumeDb === 'number' && Math.abs(tDef.volumeDb) > 0.05) {
          const volLabel = currentLabel + '_v'
          parts.push('[' + currentLabel + ']volume=' + fmtSec(tDef.volumeDb) + 'dB[' + volLabel + ']')
          currentLabel = volLabel
        }

        trackOutputs.push('[' + currentLabel + ']')
      }
    })

    if (trackOutputs.length > 1) {
      parts.push(trackOutputs.join('') + 'amix=inputs=' + trackOutputs.length + ':duration=longest:dropout_transition=0:normalize=0[cat]')
    } else if (trackOutputs.length === 1) {
      parts.push(trackOutputs[0] + 'anull[cat]')
    } else {
      parts.push('anullsrc=r=44100:cl=stereo,atrim=duration=1[cat]')
    }
  } else {
    let clipLabels = ''
    clips.forEach(function (clip, j) {
      clipLabels += '[c' + j + ']'
    })
    parts.push(clipLabels + 'concat=n=' + clips.length + ':v=0:a=1[cat]')
  }

  // 4) 全局音量 + 限幅
  const tail = []
  if (plan.volumeDb) tail.push('volume=' + fmtSec(plan.volumeDb) + 'dB')
  tail.push(LIMITER)
  parts.push('[cat]' + tail.join(',') + '[out]')
  return parts.join(';')
}

/** v2 ffmpeg args：按 sources 顺序依次 -i，filter_complex 引用 [0:a]/[1:a]… */
function buildRenderArgsV2(inputPaths, outputPath, plan) {
  const paths = Array.isArray(inputPaths) ? inputPaths : [inputPaths]
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-filter_complex_threads', '1']
  paths.forEach(function (p) {
    args.push('-i', p)
  })
  args.push('-filter_complex', buildFilterGraphV2(plan), '-map', '[out]', '-map_metadata', '-1', '-t', fmtSec(plan.totalDur))
  const encoder = ENCODERS[plan.format] || ENCODERS.mp3
  const encoderArgs = encoder(plan.bitrate || DEFAULT_BITRATE)
  for (let i = 0; i < encoderArgs.length; i++) args.push(encoderArgs[i])
  args.push(outputPath)
  return args
}

module.exports = {
  // 常量
  SAMPLE_RATE: SAMPLE_RATE,
  BUCKET_MS: BUCKET_MS,
  SAMPLES_PER_BUCKET: SAMPLES_PER_BUCKET,
  MAX_SEGMENTS: MAX_SEGMENTS,
  MAX_SOURCES: MAX_SOURCES,
  MAX_CLIPS: MAX_CLIPS,
  MIN_SEGMENT_SEC: MIN_SEGMENT_SEC,
  MAX_OUTPUT_SEC: MAX_OUTPUT_SEC,
  MAX_FADE_SEC: MAX_FADE_SEC,
  MAX_INPUT_BYTES: MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES: MAX_OUTPUT_BYTES,
  BITRATES: BITRATES,
  DEFAULT_BITRATE: DEFAULT_BITRATE,
  OUTPUT_FORMATS: OUTPUT_FORMATS,
  LIMITER: LIMITER,
  // 工具
  codedError: codedError,
  round3: round3,
  isFiniteNumber: isFiniteNumber,
  // 探测 / 波形
  parseProbeInfo: parseProbeInfo,
  computePeaks: computePeaks,
  playableFlags: playableFlags,
  isInvalidMediaText: isInvalidMediaText,
  // v1：单源 segments
  normalizeEditRequest: normalizeEditRequest,
  normalizeSegments: normalizeSegments,
  planOutDuration: planOutDuration,
  clampSegmentsToDuration: clampSegmentsToDuration,
  finalizePlan: finalizePlan,
  applyFades: applyFades,
  buildFilterGraph: buildFilterGraph,
  buildRenderArgs: buildRenderArgs,
  // v2：多源 clips + 每片 fade
  normalizeSourceV2: normalizeSourceV2,
  normalizeClipsV2: normalizeClipsV2,
  normalizeRenderRequestV2: normalizeRenderRequestV2,
  planClipsDuration: planClipsDuration,
  clampClipsToSources: clampClipsToSources,
  applyClipFades: applyClipFades,
  finalizePlanV2: finalizePlanV2,
  buildFilterGraphV2: buildFilterGraphV2,
  buildRenderArgsV2: buildRenderArgsV2
}
