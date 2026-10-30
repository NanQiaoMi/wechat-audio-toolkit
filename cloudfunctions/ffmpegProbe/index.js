// cloudfunctions/ffmpegProbe/index.js
// 路线 A 验证函数：确认云函数内能否运行静态 FFmpeg、/tmp 是否可写、冷启动/耗时常量。
// 仅用于技术验证，验证完成后删除或替换为正式转换函数。
const cloud = require('wx-server-sdk')
const { execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
// 音乐剪辑（analyzeAudio / renderEdit）纯函数核心；无第三方依赖，随云函数目录一起部署
const editorCore = require('./lib/editor-core')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const DAILY_LIMIT = 5
// 测试阶段先取消次数限制：QUOTA_ENFORCED=false 时不计次、不拦截；后续可改回 true
const QUOTA_ENFORCED = false
// 内容安全开关：个人主体当前未开通 security.mediaCheckAsync 云调用权限，默认关闭；开通后置 true。
const MEDIA_CHECK_ENABLED = false

const SRC_BIN = path.join(__dirname, 'bin', 'ffmpeg')
const TMP_BIN = '/tmp/ffmpeg-probe-bin'
const DEFAULT_TIMEOUT = Number(process.env.FFMPEG_TIMEOUT_MS || 50000)
const TARGETS = {
  mp3: ['-c:a', 'libmp3lame', '-b:a', '192k'],
  m4a: ['-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '192k', '-movflags', '+faststart'],
  wav: ['-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2'],
  flac: ['-c:a', 'flac', '-compression_level', '5'],
  ogg: ['-c:a', 'libvorbis', '-b:a', '128k'],
  aac: ['-c:a', 'aac', '-b:a', '192k', '-f', 'adts']
}

// 各输出格式的保守时长上限（秒），按 60s 云函数超时实测校准
const FORMAT_LIMIT_SEC = { mp3: 1200, wav: 1800, flac: 1800, m4a: 600, aac: 600, ogg: 600 }
const MAX_FILE_BYTES = 50 * 1024 * 1024

// ---- 音乐剪辑（editor MVP）----
// 超时预算：analyze 总时长目标 ≤20s；render 的 ffmpeg 进程 50s（云函数 60s 上限内预留下载/上传/DB）
const EDIT_PROBE_TIMEOUT_MS = 12000
const EDIT_ANALYZE_TIMEOUT_MS = 20000
const EDIT_RENDER_TIMEOUT_MS = 50000
const EDIT_MAX_SOURCE_BYTES = editorCore.MAX_INPUT_BYTES
const EDIT_MAX_DURATION_SEC = editorCore.MAX_OUTPUT_SEC

function prepareBinary() {
  // 云函数部署后可能丢失可执行位；复制到 /tmp 并 chmod +x 后再执行。
  try {
    if (fs.existsSync(TMP_BIN) && fs.statSync(TMP_BIN).size > 1024 * 1024) return TMP_BIN
    fs.copyFileSync(SRC_BIN, TMP_BIN)
    fs.chmodSync(TMP_BIN, 0o755)
    return TMP_BIN
  } catch (e) {
    return SRC_BIN
  }
}

function binInfo() {
  const out = { srcBin: SRC_BIN, tmpBin: TMP_BIN }
  for (const [k, p] of [['src', SRC_BIN], ['tmp', TMP_BIN]]) {
    try {
      const st = fs.statSync(p)
      out[k] = { size: st.size, mode: (st.mode & 0o777).toString(8) }
      try { fs.accessSync(p, fs.constants.X_OK); out[k].xok = true } catch (e) { out[k].xok = false }
    } catch (e) { out[k] = { error: String(e && e.message) } }
  }
  return out
}

function runFfmpeg(args, timeout = DEFAULT_TIMEOUT, options = {}) {
  const bin = prepareBinary()
  return new Promise((resolve) => {
    const started = Date.now()
    const execOptions = { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }
    // 无限输入/长任务必须 SIGKILL（SIGTERM 杀不掉，spike §3.1）；默认不传，保持旧行为
    if (options.killSignal) execOptions.killSignal = options.killSignal
    execFile(
      bin,
      args,
      execOptions,
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          ms: Date.now() - started,
          code: err ? err.code : 0,
          error: err ? String((err && err.message) || err) : '',
          killed: !!(err && err.killed),
          signal: err ? err.signal || null : null,
          timedOut: !!(err && (err.killed || err.code === 'ETIMEDOUT')),
          stdout: String(stdout || '').slice(-4000),
          stderr: String(stderr || '').slice(-4000),
          bin
        })
      }
    )
  })
}



function todayKey() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

async function getQuota(openid) {
  const id = `${openid}_${todayKey()}`
  try {
    const r = await db.collection('quota').doc(id).get()
    return { id, count: Number((r.data && r.data.count) || 0), ok: true }
  } catch (e) {
    return { id, count: 0, ok: false }
  }
}

async function addQuota(openid, current) {
  const id = `${openid}_${todayKey()}`
  try {
    await db.collection('quota').doc(id).set({
      data: { openid, date: todayKey(), count: current + 1, updatedAt: Date.now() }
    })
    return true
  } catch (e) {
    return false
  }
}

async function recordOutput(openid, fileID, size, format) {
  try {
    await db.collection('converted_files').add({
      data: { openid, fileID, size, format, createdAt: Date.now() }
    })
    return true
  } catch (e) {
    return false
  }
}

async function cleanup(event = {}) {
  const rawOlder = event.olderThanSec
  const olderThanSec = rawOlder === undefined ? 24 * 3600 : Math.max(0, Number(rawOlder) || 0)
  const cutoff = Date.now() - olderThanSec * 1000
  try {
    const r = await db.collection('converted_files').where({ createdAt: _.lt(cutoff) }).limit(100).get()
    const docs = (r.data || [])
    if (!docs.length) return { action: 'cleanup', deleted: 0, remaining: 0 }
    const fileIDs = docs.map(d => d.fileID).filter(Boolean)
    let cloudDeleted = 0
    if (fileIDs.length) {
      try {
        const del = await cloud.deleteFile({ fileList: fileIDs })
        cloudDeleted = (del.fileList || []).filter(x => x.status === 0).length
      } catch (e) {}
    }
    for (const d of docs) {
      try { await db.collection('converted_files').doc(d._id).remove() } catch (e) {}
    }
    return { action: 'cleanup', deleted: cloudDeleted, docs: docs.length, remaining: 0 }
  } catch (e) {
    return { action: 'cleanup', error: String(e && e.message || e), deleted: 0 }
  }
}

function sanitizeName(name) {
  const base = String(name || 'audio').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 60)
  return base || 'audio'
}

function parseDuration(text) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(text || ''))
  if (!m) return 0
  return Math.round(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]))
}

async function getDuration(filePath) {
  const r = await runFfmpeg(['-hide_banner', '-i', filePath], 12000)
  return parseDuration(r.stderr || '')
}

// ===========================================================================
// 音乐剪辑（editor MVP）：analyzeAudio / renderEdit
// 契约：docs/EDITOR_IMPL_CONTRACT.md §3；实测：docs/research/FFMPEG_EDIT_SPIKE.md
// 纯函数（解析/校验/滤镜/args）在 lib/editor-core.js，便于本地无云环境单测。
// ===========================================================================

function editAudioExt(fileID, fileName) {
  const m = String(fileID + ' ' + fileName).match(/\.([a-zA-Z0-9]{1,5})(?:[\s?]|$)/)
  return m ? m[1].toLowerCase() : 'bin'
}

// 下载云文件到 /tmp；错误统一转成用户可读的 code（INVALID_FILE / FILE_TOO_LARGE）
async function downloadCloudFile(fileID, destPath, maxBytes) {
  let buf
  try {
    const dl = await cloud.downloadFile({ fileID })
    buf = Buffer.isBuffer(dl.fileContent) ? dl.fileContent : Buffer.from(dl.fileContent)
  } catch (e) {
    throw editorCore.codedError('INVALID_FILE', '源文件下载失败，请重新上传后再试')
  }
  if (!buf || buf.length === 0) throw editorCore.codedError('INVALID_FILE', '源文件为空，请重新选择音频')
  if (buf.length > maxBytes) {
    throw editorCore.codedError('FILE_TOO_LARGE', '文件超过 50MB，请压缩或换用更短的音频')
  }
  fs.writeFileSync(destPath, buf)
  return buf
}

// 写 converted_files 台账：集合可能未建/字段可能不兼容，均不得影响主流程（契约 §3.2）
async function recordEditOutput(openid, fileID, size) {
  try {
    await db.collection('converted_files').add({
      data: { openid, fileID, size, format: 'mp3', createdAt: Date.now(), kind: 'edit_output' }
    })
    return true
  } catch (e) {
    // 降级：去掉可选的 kind 字段再试一次（旧集合/索引不兼容时）
    try {
      await db.collection('converted_files').add({
        data: { openid, fileID, size, format: 'mp3', createdAt: Date.now() }
      })
      return true
    } catch (e2) {
      return false
    }
  }
}

// 失败响应：只暴露自己构造的用户可读文案，其余统一 INTERNAL
function editErrorResult(e, fallbackCode, fallbackMessage) {
  if (e && e.isEditorError) {
    return { success: false, code: String(e.code || fallbackCode), errorMessage: String(e.message || fallbackMessage) }
  }
  return { success: false, code: fallbackCode, errorMessage: fallbackMessage }
}

// analyzeAudio：下载 → ffmpeg -i 解析 → 4kHz mono s16le 解码 → 50ms 桶 peak/rms → base64
async function analyzeAudio(event = {}) {
  const fileID = event.fileID
  const fileName = event.fileName || ''
  if (!fileID) return { success: false, code: 'PARAM_ERROR', errorMessage: '缺少源音频 fileID 参数' }
  const declaredSize = Number(event.size) || 0
  if (declaredSize > EDIT_MAX_SOURCE_BYTES) {
    return { success: false, code: 'FILE_TOO_LARGE', errorMessage: '文件超过 50MB，请压缩或换用更短的音频' }
  }

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const inputPath = `/tmp/ed_analyze_${suffix}.${editAudioExt(fileID, fileName)}`
  const pcmPath = `/tmp/ed_analyze_${suffix}.pcm`
  try {
    await downloadCloudFile(fileID, inputPath, EDIT_MAX_SOURCE_BYTES)

    // 未打包 ffprobe：`ffmpeg -i` 无输出参数时退出码恒为 1，不能以退出码判失败（spike 坑 P11）
    const probe = await runFfmpeg(['-hide_banner', '-nostdin', '-i', inputPath], EDIT_PROBE_TIMEOUT_MS)
    const probeText = `${probe.stderr || ''}\n${probe.stdout || ''}`
    const info = editorCore.parseProbeInfo(probeText)
    if (!info.hasAudio) {
      if (editorCore.isInvalidMediaText(probeText)) {
        return { success: false, code: 'INVALID_FILE', errorMessage: '无法识别的音频文件，请换一个文件试试' }
      }
      return { success: false, code: 'DECODE_FAILED', errorMessage: '文件里没有可用的音轨，请选择音频文件' }
    }
    if (info.duration > EDIT_MAX_DURATION_SEC) {
      return { success: false, code: 'DURATION_TOO_LONG', errorMessage: `音频超过 ${EDIT_MAX_DURATION_SEC / 60} 分钟，暂不支持在线剪辑` }
    }

    // 波形专用 PCM：4kHz 单声道 s16le（10min ≈4.8MB，契约 §3.1）
    const decode = await runFfmpeg(
      ['-v', 'error', '-nostdin', '-y', '-i', inputPath, '-ac', '1', '-ar', '4000', '-f', 's16le', pcmPath],
      EDIT_ANALYZE_TIMEOUT_MS
    )
    if (decode.timedOut) {
      return { success: false, code: 'DECODE_FAILED', errorMessage: '音频分析超时，请换更短的音频' }
    }
    if (!decode.ok || !fs.existsSync(pcmPath)) {
      return { success: false, code: 'DECODE_FAILED', errorMessage: '音频解码失败，文件可能损坏' }
    }
    const pcm = fs.readFileSync(pcmPath)
    const peaks = editorCore.computePeaks(pcm, editorCore.SAMPLE_RATE, editorCore.BUCKET_MS)
    if (!peaks.buckets) {
      return { success: false, code: 'DECODE_FAILED', errorMessage: '音频解码为空，文件可能损坏' }
    }

    // Duration 缺失时（个别容器）用实际解码样本数兜底
    let duration = info.duration
    if (!duration) duration = editorCore.round3(peaks.sampleCount / editorCore.SAMPLE_RATE)
    const playable = editorCore.playableFlags(info.format)

    return {
      success: true,
      data: {
        duration,
        format: info.format,
        sampleRate: info.sampleRate,
        channels: info.channels,
        bucketMs: editorCore.BUCKET_MS,
        buckets: peaks.buckets,
        peaks: { peak: peaks.peakB64, rms: peaks.rmsB64 },
        playableIos: playable.playableIos,
        playableAndroid: playable.playableAndroid
      }
    }
  } catch (e) {
    return editErrorResult(e, 'INTERNAL', '音频分析失败，请稍后重试')
  } finally {
    try { if (fs.existsSync(pcmPath)) fs.unlinkSync(pcmPath) } catch (e) {}
    try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath) } catch (e) {}
  }
}

// renderEdit 入口：v2（sources[] + clips[]，多源拼接 + 每片段缓入缓出）优先；否则兼容 v1（segments 单源）
async function renderEdit(event = {}) {
  if (Array.isArray(event.sources) || Array.isArray(event.clips)) return await renderEditV2(event)
  return await renderEditV1(event)
}

// renderEdit v2：多源 sources[] + clips[] + 每片段 fadeIn/fadeOut（契约 §6.3）
async function renderEditV2(event = {}) {
  const t0 = Date.now()
  // 下载前先做便宜校验（sources 1~5 / clips 1~40 / 每片 ≥0.2s / 总 ≤600s / 声明大小 / fade 归一）
  let plan
  try {
    plan = editorCore.normalizeRenderRequestV2(event)
  } catch (e) {
    return editErrorResult(e, 'PARAM_ERROR', '剪辑参数有误')
  }

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const inputPaths = []
  const outputPath = `/tmp/ed_render_out_${suffix}.mp3`
  try {
    // 1) 逐个下载 + probe：拿到每个源的真实时长（用于 clamp，不信任客户端）
    const sourceDurations = []
    for (let i = 0; i < plan.sources.length; i++) {
      const src = plan.sources[i]
      const sourcePath = `/tmp/ed_render_s${i}_${suffix}.${editAudioExt(src.fileID, src.fileName)}`
      inputPaths.push(sourcePath)
      await downloadCloudFile(src.fileID, sourcePath, EDIT_MAX_SOURCE_BYTES)

      const probe = await runFfmpeg(['-hide_banner', '-nostdin', '-i', sourcePath], EDIT_PROBE_TIMEOUT_MS)
      const probeText = `${probe.stderr || ''}\n${probe.stdout || ''}`
      const info = editorCore.parseProbeInfo(probeText)
      if (!info.hasAudio) {
        if (editorCore.isInvalidMediaText(probeText)) {
          return { success: false, code: 'INVALID_FILE', errorMessage: `第 ${i + 1} 个源文件无法识别，请换一个文件试试` }
        }
        return { success: false, code: 'DECODE_FAILED', errorMessage: `第 ${i + 1} 个源文件里没有可用的音轨` }
      }
      sourceDurations.push(info.duration)
    }

    // 2) 按每个源的真实时长 clamp 片段，再对每片 fade 做最终等比收敛
    try {
      plan = editorCore.finalizePlanV2(plan, editorCore.clampClipsToSources(plan.clips, sourceDurations))
    } catch (e) {
      return editErrorResult(e, 'PARAM_ERROR', '剪辑片段超出源文件范围')
    }

    // 3) 一次性 filter_complex 渲染（同源 asplit / 每片 fade / concat / 全局 volume+limiter）
    const args = editorCore.buildRenderArgsV2(inputPaths, outputPath, plan)
    const render = await runFfmpeg(args, EDIT_RENDER_TIMEOUT_MS, { killSignal: 'SIGKILL' })
    if (render.timedOut) {
      return { success: false, code: 'TIMEOUT', errorMessage: '剪辑超时，请缩短音频或减少片段后重试' }
    }
    if (!render.ok || !fs.existsSync(outputPath)) {
      return { success: false, code: 'RENDER_FAILED', errorMessage: '音频剪辑失败，请稍后重试' }
    }
    const outSize = fs.statSync(outputPath).size
    if (!outSize) return { success: false, code: 'RENDER_FAILED', errorMessage: '导出文件为空，请稍后重试' }
    if (outSize > editorCore.MAX_OUTPUT_BYTES) {
      return { success: false, code: 'OUTPUT_TOO_LARGE', errorMessage: '导出文件超过 50MB，请缩短时长或降低码率' }
    }

    // 4) 上传 + 台账（与 v1 一致；fileName 取第一个源文件名，便于用户识别）
    const firstName = plan.sources.length ? plan.sources[0].fileName : ''
    const baseName = sanitizeName(firstName ? firstName.replace(/\.[^.]+$/, '') : 'audio')
    const cloudPath = `edited_audios/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`
    const upload = await cloud.uploadFile({ cloudPath, fileContent: fs.readFileSync(outputPath) })
    const outputFileID = upload.fileID

    const ctx = cloud.getWXContext()
    await recordEditOutput(ctx.OPENID || 'anonymous', outputFileID, outSize)

    return {
      success: true,
      data: {
        fileID: outputFileID,
        fileName: `${baseName}_剪辑.mp3`,
        size: outSize,
        duration: plan.totalDur,
        costMs: Date.now() - t0
      }
    }
  } catch (e) {
    return editErrorResult(e, 'INTERNAL', '剪辑失败，请稍后重试')
  } finally {
    for (let i = 0; i < inputPaths.length; i++) {
      try { if (fs.existsSync(inputPaths[i])) fs.unlinkSync(inputPaths[i]) } catch (e) {}
    }
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch (e) {}
  }
}

// renderEdit v1（兼容保留）：校验 → 下载 → 探测真实时长并裁剪 → filter_complex 一次成片 → 上传 edited_audios
async function renderEditV1(event = {}) {
  const t0 = Date.now()
  const fileID = event.fileID
  const fileName = event.fileName || ''
  if (!fileID) return { success: false, code: 'PARAM_ERROR', errorMessage: '缺少源音频 fileID 参数' }
  const declaredSize = Number(event.size) || 0
  if (declaredSize > EDIT_MAX_SOURCE_BYTES) {
    return { success: false, code: 'FILE_TOO_LARGE', errorMessage: '文件超过 50MB，请压缩或换用更短的音频' }
  }

  // 便宜参数校验放在下载前，失败直接返回明确 code（契约 §3.2）
  let plan
  try {
    plan = editorCore.normalizeEditRequest(event)
  } catch (e) {
    return editErrorResult(e, 'PARAM_ERROR', '剪辑参数有误')
  }

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  // 注意：输入/输出必须不同路径。源为 mp3 时若都用 ed_render_<suffix>.mp3，
  // ffmpeg 会因 "output file is same as input" 失败（本地 mock 实测发现）。
  const inputPath = `/tmp/ed_render_in_${suffix}.${editAudioExt(fileID, fileName)}`
  const outputPath = `/tmp/ed_render_out_${suffix}.mp3`
  try {
    await downloadCloudFile(fileID, inputPath, EDIT_MAX_SOURCE_BYTES)

    const probe = await runFfmpeg(['-hide_banner', '-nostdin', '-i', inputPath], EDIT_PROBE_TIMEOUT_MS)
    const probeText = `${probe.stderr || ''}\n${probe.stdout || ''}`
    const info = editorCore.parseProbeInfo(probeText)
    if (!info.hasAudio) {
      if (editorCore.isInvalidMediaText(probeText)) {
        return { success: false, code: 'INVALID_FILE', errorMessage: '无法识别的音频文件，请换一个文件试试' }
      }
      return { success: false, code: 'DECODE_FAILED', errorMessage: '文件里没有可用的音轨，请选择音频文件' }
    }

    // 服务端按真实时长 clamp（不信任客户端；spike §2.1 "越界裁剪"）
    if (info.duration > 0) {
      try {
        plan = editorCore.finalizePlan(plan, editorCore.clampSegmentsToDuration(plan.segments, info.duration))
      } catch (e) {
        return editErrorResult(e, 'PARAM_ERROR', '剪辑片段超出音频范围')
      }
    }

    const args = editorCore.buildRenderArgs(inputPath, outputPath, plan)
    // 长任务必须 SIGKILL；maxBuffer 4MB；timeout 50s（契约 §3.2）
    const render = await runFfmpeg(args, EDIT_RENDER_TIMEOUT_MS, { killSignal: 'SIGKILL' })
    if (render.timedOut) {
      return { success: false, code: 'TIMEOUT', errorMessage: '剪辑超时，请缩短音频或减少片段后重试' }
    }
    if (!render.ok || !fs.existsSync(outputPath)) {
      return { success: false, code: 'RENDER_FAILED', errorMessage: '音频剪辑失败，请稍后重试' }
    }
    const outSize = fs.statSync(outputPath).size
    if (!outSize) return { success: false, code: 'RENDER_FAILED', errorMessage: '导出文件为空，请稍后重试' }
    if (outSize > editorCore.MAX_OUTPUT_BYTES) {
      return { success: false, code: 'OUTPUT_TOO_LARGE', errorMessage: '导出文件超过 50MB，请缩短时长或降低码率' }
    }

    const baseName = sanitizeName(fileName ? fileName.replace(/\.[^.]+$/, '') : 'audio')
    const cloudPath = `edited_audios/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`
    const upload = await cloud.uploadFile({ cloudPath, fileContent: fs.readFileSync(outputPath) })
    const outputFileID = upload.fileID

    // 台账 best-effort：集合/字段容错，失败不影响返回（契约 §3.2）
    const ctx = cloud.getWXContext()
    await recordEditOutput(ctx.OPENID || 'anonymous', outputFileID, outSize)

    return {
      success: true,
      data: {
        fileID: outputFileID,
        fileName: `${baseName}_剪辑.mp3`,
        size: outSize,
        duration: plan.outDur,
        costMs: Date.now() - t0
      }
    }
  } catch (e) {
    return editErrorResult(e, 'INTERNAL', '剪辑失败，请稍后重试')
  } finally {
    try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath) } catch (e) {}
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch (e) {}
  }
}

async function convertFile(event) {
  // 正式转换入口：fileID -> 下载 -> ffmpeg -> 上传 -> 返回 UI 需要的结构
  const t0 = Date.now()
  const fileID = event.fileID
  const targetFormat = String(event.targetFormat || 'mp3').toLowerCase()
  const options = event.options || {}
  const fileName = event.fileName || ''
  const autoCleanSource = event.autoCleanSource !== false
  if (!fileID) return { success: false, code: 'PARAM_ERROR', errorMessage: '缺少源音频 fileID 参数' }
  if (!TARGETS[targetFormat]) {
    return { success: false, code: 'UNSUPPORTED_FORMAT', errorMessage: '暂不支持该输出格式' }
  }
  const bitrate = ['64k','96k','128k','192k','256k','320k'].includes(options.bitrate) ? options.bitrate : '192k'
  const sampleRate = [0, 44100, 48000].includes(Number(options.sampleRate)) ? Number(options.sampleRate) : 0
  const channels = [1, 2].includes(Number(options.channels)) ? Number(options.channels) : 2

  const ctx = cloud.getWXContext()
  const openid = ctx.OPENID || 'anonymous'
  const quota = QUOTA_ENFORCED ? await getQuota(openid) : { count: 0 }
  if (QUOTA_ENFORCED && quota.count >= DAILY_LIMIT) {
    return { success: false, code: 'QUOTA_EXCEEDED', errorMessage: `今日免费转换次数已用完（${DAILY_LIMIT}/${DAILY_LIMIT}），明天再来吧` }
  }

  const ts = Date.now()
  const suffix = `${ts}_${Math.random().toString(36).slice(2, 8)}`
  const srcExtMatch = String(fileID + ' ' + fileName).match(/\.([a-zA-Z0-9]{1,5})(?:[\s?]|$)/)
  const srcExt = srcExtMatch ? srcExtMatch[1].toLowerCase() : 'bin'
  const inputPath = `/tmp/cf_in_${suffix}.${srcExt}`
  const outputPath = `/tmp/cf_out_${suffix}.${targetFormat}`
  let outputFileID = ''
  try {
    const dl = await cloud.downloadFile({ fileID })
    const buf = Buffer.isBuffer(dl.fileContent) ? dl.fileContent : Buffer.from(dl.fileContent)
    if (!buf || buf.length === 0) throw new Error('源文件为空或下载失败')
    if (buf.length > MAX_FILE_BYTES) throw new Error('文件超过 50MB，请压缩或拆分后重试')
    fs.writeFileSync(inputPath, buf)

    const duration = await getDuration(inputPath)
    if (duration > 0) {
      const limit = FORMAT_LIMIT_SEC[targetFormat] || 600
      if (duration > limit) {
        throw new Error(`该输出格式建议 ${Math.floor(limit / 60)} 分钟以内（当前 ${Math.ceil(duration / 60)} 分钟），请改用 MP3/WAV/FLAC 或降低时长`)
      }
    }

    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, ...TARGETS[targetFormat]]
    if (targetFormat !== 'wav') {
      if (['mp3','m4a','aac','ogg'].includes(targetFormat)) args.push('-b:a', bitrate)
    }
    if (sampleRate) args.push('-ar', String(sampleRate))
    if (channels) args.push('-ac', String(channels))
    args.push(outputPath)

    const conv = await runFfmpeg(args, 55000)
    if (!conv.ok) throw new Error(`转码失败：${(conv.stderr || conv.error || '').slice(-300)}`)
    if (!fs.existsSync(outputPath)) throw new Error('转码输出文件不存在')
    const outSize = fs.statSync(outputPath).size
    if (outSize > 100 * 1024 * 1024) throw new Error('输出文件过大，请降低码率')

    const baseName = sanitizeName(fileName ? fileName.replace(/\.[^.]+$/, '') : 'audio_converted')
    const cloudPath = `converted_audios/${baseName}_${suffix}.${targetFormat}`
    const uploadRes = await cloud.uploadFile({ cloudPath, fileContent: fs.readFileSync(outputPath) })
    outputFileID = uploadRes.fileID
    let downloadUrl = ''
    try {
      const u = await cloud.getTempFileURL({ fileList: [outputFileID] })
      if (u.fileList && u.fileList[0]) downloadUrl = u.fileList[0].tempFileURL || ''
    } catch (e) {}

    // 内容安全：仅作 best-effort 送检；回调/台账需后续接入（媒体需公网可下载且 ≤10MB）
    let safety = null
    if (MEDIA_CHECK_ENABLED && downloadUrl) {
      try {
        const ctx = cloud.getWXContext()
        const check = await cloud.openapi.security.mediaCheckAsync({
          openid: ctx.OPENID,
          scene: 1,
          version: 2,
          media_type: 1,
          media_url: downloadUrl
        })
        safety = { errcode: check.errcode, traceId: check.trace_id || '' }
      } catch (e) {
        safety = { error: String((e && e.message) || e) }
      }
    }

    if (QUOTA_ENFORCED) await addQuota(openid, quota.count)
    const quotaAfter = QUOTA_ENFORCED ? quota.count + 1 : null
    await recordOutput(openid, outputFileID, outSize, targetFormat)

    if (autoCleanSource) {
      cloud.deleteFile({ fileList: [fileID] }).catch(() => {})
    }
    return {
      success: true,
      data: {
        fileID: outputFileID,
        downloadUrl,
        fileName: `${baseName}_${suffix.slice(-4)}.${targetFormat}`,
        targetFormat,
        targetSize: outSize,
        sourceSize: buf.length,
        duration,
        safety,
        quota: QUOTA_ENFORCED ? { used: quotaAfter, limit: DAILY_LIMIT } : null,
        costTimeMs: Date.now() - t0
      }
    }
  } catch (e) {
    return { success: false, code: 'CONVERT_FAILED', errorMessage: String((e && e.message) || e) }
  } finally {
    try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath) } catch (e) {}
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch (e) {}
  }
}

function baseInfo(action) {
  const info = {
    action,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / 1048576),
    tmpDir: os.tmpdir(),
    cwd: __dirname,
    wxContext: cloud.getWXContext(),
    tmpWritable: false,
    binInfo: binInfo()
  }
  try {
    fs.writeFileSync('/tmp/_probe.txt', 'ok')
    fs.unlinkSync('/tmp/_probe.txt')
    info.tmpWritable = true
  } catch (e) {
    info.tmpError = String(e && e.message)
  }
  return info
}

async function probe() {
  const t0 = Date.now()
  const v = await runFfmpeg(['-hide_banner', '-version'], 10000)
  return {
    ...baseInfo('probe'),
    ffmpegVersion: ((v.stdout || '') + (v.stderr || '')).split('\n').slice(0, 3),
    ffmpegMs: v.ms,
    ffmpegOk: v.ok,
    ffmpegError: v.error,
    ffmpegStderr: (v.stderr || '').slice(-1000),
    totalMs: Date.now() - t0
  }
}

async function sleep(ms) {
  const t0 = Date.now()
  await new Promise((r) => setTimeout(r, ms))
  return { ...baseInfo('sleep'), sleptMs: ms, totalMs: Date.now() - t0 }
}

async function convert(event) {
  const t0 = Date.now()
  const seconds = Math.max(1, Math.min(Number(event.seconds) || 30, 1800))
  const target = TARGETS[event.target] ? event.target : 'mp3'
  const ts = Date.now()
  const src = `/tmp/src_${ts}.mp3`
  const out = `/tmp/out_${ts}.${target}`
  const gen = await runFfmpeg(
    [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
      '-c:a', 'libmp3lame', '-b:a', '192k',
      '-y', src
    ],
    30000
  )
  const conv = await runFfmpeg(
    ['-hide_banner', '-loglevel', 'error', '-i', src, ...TARGETS[target], '-y', out]
  )
  let outBytes = 0
  try {
    outBytes = fs.statSync(out).size
  } catch (e) {}
  try { fs.unlinkSync(src) } catch (e) {}
  try { fs.unlinkSync(out) } catch (e) {}
  return {
    ...baseInfo('convert'),
    seconds,
    target,
    genOk: gen.ok,
    genMs: gen.ms,
    genError: gen.error,
    convOk: conv.ok,
    convMs: conv.ms,
    convError: conv.error,
    convStderr: conv.ok ? '' : (conv.stderr || '').slice(-1000),
    outBytes,
    totalMs: Date.now() - t0,
    memRssMB: Math.round(process.memoryUsage().rss / 1048576)
  }
}


async function encodeOnly(event) {
  const t0 = Date.now()
  const seconds = Math.max(1, Math.min(Number(event.seconds) || 60, 1800))
  const target = TARGETS[event.target] ? event.target : 'mp3'
  const ts = Date.now()
  const out = `/tmp/enc_${ts}.${target}`
  const enc = await runFfmpeg(
    [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
      ...TARGETS[target],
      '-y', out
    ],
    58000
  )
  let outBytes = 0
  try { outBytes = fs.statSync(out).size } catch (e) {}
  try { fs.unlinkSync(out) } catch (e) {}
  return {
    ...baseInfo('encodeOnly'),
    seconds,
    target,
    encOk: enc.ok,
    encMs: enc.ms,
    encError: enc.error,
    encStderr: enc.ok ? '' : (enc.stderr || '').slice(-1000),
    outBytes,
    totalMs: Date.now() - t0,
    memRssMB: Math.round(process.memoryUsage().rss / 1048576)
  }
}

exports.main = async (event = {}) => {
  if (event.Type === 'Timer' || event.action === 'cleanup') return await cleanup(event)
  const action = event.action || (event.fileID ? 'convertFile' : 'probe')
  try {
    if (action === 'sleep') return await sleep(Math.min(Number(event.ms) || 5000, 300000))
    if (action === 'convert') return await convert(event)
    if (action === 'encodeOnly') return await encodeOnly(event)
    // 音乐剪辑（editor MVP）：与原转换流程并存，互不影响
    if (action === 'analyzeAudio') return await analyzeAudio(event)
    if (action === 'renderEdit') return await renderEdit(event)
    if (action === 'convertFile') return await convertFile(event)
    return await probe()
  } catch (e) {
    return { action, error: String((e && e.stack) || e), totalMs: 0 }
  }
}
