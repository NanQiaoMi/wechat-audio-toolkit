#!/usr/bin/env node
/**
 * 音乐剪辑·云函数 action 级端到端实测（宿主机执行，需要 Docker）
 *
 * 用「mock wx-server-sdk + 真实 exports.main + 容器内静态 FFmpeg 7.0.2」验证 index.js 的
 * analyzeAudio / renderEdit 包装层（云 SDK 之外的所有逻辑）以及旧 convertFile/probe 回归：
 *   - cloud.downloadFile/uploadFile/deleteFile/getTempFileURL/getWXContext/database 全部本地 mock；
 *   - child_process.execFile 被替换为 `docker exec <container> /tmp/bin/ffmpeg ...`，
 *     并把云函数写到宿主机 /tmp 的临时文件映射进容器挂载目录（/work/mockio/tmpio）；
 *   - 断言：返回结构、错误码、上传产物可解码/时长正确、converted_files 台账、/tmp finally 清理。
 *
 * 运行（先由 run.sh 准备容器）：
 *   CONTAINER=ffmpeg-editor-spike WORK=/tmp/editor-spike-work node scripts/editor-spike/test_actions_mock.js
 */
'use strict'

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const Module = require('module')
const { spawnSync } = require('child_process')

const CONTAINER = process.env.CONTAINER || 'ffmpeg-editor-spike'
const WORK = process.env.WORK || '/tmp/editor-spike-work'
const CWORK = '/work'
const FFMPEG = '/tmp/bin/ffmpeg'
const FFPROBE = '/usr/local/bin/ffprobe'
const CLOUD_DIR = path.join(WORK, 'mock_cloud')
const SAMPLE_DIR = path.join(WORK, 'samples')
const IO_DIR = path.join(WORK, 'mockio', 'tmpio')
const UPLOAD_DIR = path.join(WORK, 'uploads')

let pass = 0
let fail = 0
const failures = []

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
  check(label, Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) <= tol, 'expected ' + expected + '±' + tol + ' actual=' + actual)
}

function section(title) {
  console.log('\n# ' + title)
}

function toC(hostPath) {
  return CWORK + hostPath.slice(WORK.length)
}

function runDocker(argv) {
  const r = spawnSync('docker', ['exec', CONTAINER].concat(argv), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? String(r.error.message) : '' }
}

function ffprobeDuration(hostFile) {
  const r = runDocker([FFPROBE, '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', toC(hostFile)])
  return Number(String(r.stdout).trim()) || 0
}

function ffDecodeOk(hostFile) {
  return runDocker([FFMPEG, '-v', 'error', '-nostdin', '-i', toC(hostFile), '-map', '0:a:0', '-f', 'null', '-']).status === 0
}

// ---------------------------------------------------------------------------
// 1) 容器 & 测试素材
// ---------------------------------------------------------------------------
function ensureContainer() {
  const r = runDocker([FFMPEG, '-version'])
  if (r.status !== 0) {
    console.error('容器 ' + CONTAINER + ' 未就绪，请先执行 bash scripts/editor-spike/run.sh')
    process.exit(2)
  }
}

function ensureSample(name, genArgs) {
  const host = path.join(SAMPLE_DIR, name)
  if (!fs.existsSync(host) || fs.statSync(host).size < 1024) {
    const r = runDocker([FFMPEG].concat(genArgs).concat([toC(host)]))
    if (r.status !== 0) throw new Error('生成样本失败 ' + name + ': ' + r.stderr.slice(-300))
  }
  return host
}

function ensureSamples() {
  fs.mkdirSync(CLOUD_DIR, { recursive: true })
  fs.mkdirSync(path.join(CLOUD_DIR, 'samples'), { recursive: true })
  fs.mkdirSync(IO_DIR, { recursive: true })
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })

  const src120 = ensureSample('music_loud_quiet_120s_v2.mp3', [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
    '-filter_complex', '[0:a]volume=6.4[a0];[1:a]volume=0.64[a1];[a0][a1]concat=n=2:v=0:a=1[out]',
    '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '192k'
  ])
  const long610 = ensureSample('long_610s.mp3', [
    '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
    '-t', '610', '-c:a', 'libmp3lame', '-b:a', '64k'
  ])
  const badRandom = path.join(SAMPLE_DIR, 'bad_random.mp3')
  if (!fs.existsSync(badRandom)) fs.writeFileSync(badRandom, crypto.randomBytes(50000))

  // v2 多源测试素材：源0 8s 440Hz 0.8FS（RMS≈144）、源1 6s 660Hz 0.2FS（RMS≈36）
  const v2src0 = ensureSample('v2_src0_440_8s.mp3', [
    '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-af', 'volume=6.4', '-c:a', 'libmp3lame', '-b:a', '192k'
  ])
  const v2src1 = ensureSample('v2_src1_660_6s.mp3', [
    '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=6',
    '-af', 'volume=1.6', '-c:a', 'libmp3lame', '-b:a', '192k'
  ])
  const v2Video = ensureSample('video_only_2s.mp4', [
    '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=2', '-c:v', 'mpeg4'
  ])

  // mock 云存储的源文件：cloud://mock/samples/xxx.mp3
  const put = function (src, name) {
    const dst = path.join(CLOUD_DIR, 'samples', name)
    if (!fs.existsSync(dst)) fs.copyFileSync(src, dst)
    return 'cloud://mock/samples/' + name
  }
  return {
    source120: put(src120, 'music_loud_quiet_120s_v2.mp3'),
    long610: put(long610, 'long_610s.mp3'),
    badRandom: put(badRandom, 'bad_random.mp3'),
    v2src0: put(v2src0, 'v2_src0_440_8s.mp3'),
    v2src1: put(v2src1, 'v2_src1_660_6s.mp3'),
    v2video: put(v2Video, 'video_only_2s.mp4'),
    source120Host: path.join(CLOUD_DIR, 'samples', 'music_loud_quiet_120s_v2.mp3'),
    long610Host: path.join(CLOUD_DIR, 'samples', 'long_610s.mp3'),
    badRandomHost: path.join(CLOUD_DIR, 'samples', 'bad_random.mp3'),
    v2src0Host: path.join(CLOUD_DIR, 'samples', 'v2_src0_440_8s.mp3'),
    v2src1Host: path.join(CLOUD_DIR, 'samples', 'v2_src1_660_6s.mp3'),
    v2videoHost: path.join(CLOUD_DIR, 'samples', 'video_only_2s.mp4')
  }
}

// ---------------------------------------------------------------------------
// 2) mock wx-server-sdk
// ---------------------------------------------------------------------------
const dbDocs = []
const deletedCloudFiles = []
const uploaded = []

function newId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10)
}

const dbMock = {
  command: {
    lt: function (v) {
      return { __op: 'lt', value: v }
    }
  },
  collection: function (name) {
    return {
      add: async function (payload) {
        const doc = Object.assign({ _id: newId('doc'), _collection: name }, payload && payload.data)
        dbDocs.push(doc)
        return { _id: doc._id }
      },
      doc: function (id) {
        return {
          get: async function () {
            const found = dbDocs.filter(function (d) { return d._id === id })[0]
            if (!found) throw new Error('doc not found')
            return { data: found }
          },
          set: async function (payload) {
            const found = dbDocs.filter(function (d) { return d._id === id })[0]
            if (found && payload && payload.data) Object.assign(found, payload.data)
            return {}
          },
          remove: async function () {
            const idx = dbDocs.findIndex(function (d) { return d._id === id })
            if (idx >= 0) dbDocs.splice(idx, 1)
            return {}
          }
        }
      },
      where: function () {
        const q = {
          limit: function () { return q },
          get: async function () {
            return { data: dbDocs.filter(function (d) { return d._collection === name }) }
          }
        }
        return q
      }
    }
  }
}

const cloudMock = {
  DYNAMIC_CURRENT_ENV: 'mock-env',
  init: function () {},
  database: function () { return dbMock },
  getWXContext: function () { return { OPENID: 'mock-openid', APPID: 'mock-appid' } },
  downloadFile: async function (opts) {
    const rel = String(opts.fileID).replace(/^cloud:\/\/mock\//, '')
    const host = path.join(CLOUD_DIR, rel)
    if (!fs.existsSync(host)) throw new Error('mock downloadFile: not found ' + opts.fileID)
    return { fileContent: fs.readFileSync(host) }
  },
  uploadFile: async function (opts) {
    const host = path.join(CLOUD_DIR, opts.cloudPath)
    fs.mkdirSync(path.dirname(host), { recursive: true })
    fs.writeFileSync(host, opts.fileContent)
    uploaded.push({ cloudPath: opts.cloudPath, host: host, size: opts.fileContent.length })
    return { fileID: 'cloud://mock/' + opts.cloudPath }
  },
  deleteFile: async function (opts) {
    const list = (opts && opts.fileList) || []
    list.forEach(function (f) { deletedCloudFiles.push(f) })
    return { fileList: list.map(function (f) { return { fileID: f, status: 0 } }) }
  },
  getTempFileURL: async function (opts) {
    const list = (opts && opts.fileList) || []
    return { fileList: list.map(function (f) { return { fileID: f, tempFileURL: 'https://mock.example/' + encodeURIComponent(f) } }) }
  },
  openapi: { security: { mediaCheckAsync: async function () { return { errcode: 0 } } } }
}

// ---------------------------------------------------------------------------
// 3) 把 execFile 重定向到容器内静态 FFmpeg
// ---------------------------------------------------------------------------
const cp = require('child_process')
const realExecFile = cp.execFile
let currentOutputMap = []

function copyFileSafe(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
}

function mapArgs(args) {
  currentOutputMap = []
  return args.map(function (arg) {
    if (typeof arg !== 'string' || arg.indexOf('/tmp/') !== 0) return arg
    const base = path.basename(arg)
    const mappedHost = path.join(IO_DIR, base)
    if (fs.existsSync(arg)) {
      // 输入文件：拷进容器可见目录
      copyFileSafe(arg, mappedHost)
      return toC(mappedHost)
    }
    // 输出文件：先用容器路径，执行完再拷回宿主机 /tmp
    currentOutputMap.push([mappedHost, arg])
    return toC(mappedHost)
  })
}

function fakeExecFile(file, args, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  options = options || {}
  const mappedArgs = mapArgs((args || []).slice())
  const r = spawnSync('docker', ['exec', CONTAINER, FFMPEG].concat(mappedArgs), {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout,
    killSignal: options.killSignal || 'SIGTERM'
  })
  // 把容器内写出的文件拷回宿主机 /tmp（云函数代码读的是宿主机路径）
  currentOutputMap.forEach(function (pair) {
    if (fs.existsSync(pair[0])) {
      try {
        copyFileSafe(pair[0], pair[1])
      } catch (e) {}
      try {
        fs.unlinkSync(pair[0])
      } catch (e) {}
    }
  })
  const timedOut = !!(r.error && (r.error.code === 'ETIMEDOUT' || r.error.code === 'ABORT_ERR'))
  const err = r.status === 0 ? null : Object.assign(new Error('Command failed: ffmpeg ' + mappedArgs.join(' ')), {
    code: timedOut ? 'ETIMEDOUT' : r.status,
    signal: r.signal || null,
    killed: timedOut
  })
  if (err && process.env.MOCK_DEBUG) {
    console.error('[mock exec fail] status=' + r.status + ' args=' + mappedArgs.join(' '))
    console.error((r.stderr || '').slice(-2000))
  }
  setImmediate(function () {
    if (callback) callback(err, r.stdout || '', r.stderr || '')
  })
}

function installHooks() {
  cp.execFile = fakeExecFile
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk') return cloudMock
    return originalLoad.apply(this, arguments)
  }
  return function restore() {
    cp.execFile = realExecFile
    Module._load = originalLoad
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  section('环境与素材')
  ensureContainer()
  const files = ensureSamples()
  check('mock 源文件就绪（120s / 610s / 坏文件）', fs.existsSync(files.source120Host) && fs.existsSync(files.long610Host) && fs.existsSync(files.badRandomHost))
  check('120s 源可解码', ffDecodeOk(files.source120Host))

  const restore = installHooks()
  const fn = require(path.join(__dirname, '..', '..', 'cloudfunctions', 'ffmpegProbe', 'index.js'))

  try {
    // -----------------------------------------------------------------------
    section('1) 回归：旧 probe 行为不变')
    const probe = await fn.main({ action: 'probe' })
    check('probe: ffmpegOk=true', probe.ffmpegOk === true, 'error=' + probe.ffmpegError)
    check('probe: ffmpeg 7.0.2', /ffmpeg version 7\.0\.2/.test((probe.ffmpegVersion || []).join(' ')), JSON.stringify(probe.ffmpegVersion))
    check('probe: node/platform/arch 字段保留', !!probe.node && !!probe.platform && !!probe.arch)

    // -----------------------------------------------------------------------
    section('2) 回归：旧 convertFile 行为不变（120s mp3 → mp3 128k）')
    const conv = await fn.main({
      action: 'convertFile',
      fileID: files.source120,
      fileName: 'music_loud_quiet_120s_v2.mp3',
      targetFormat: 'mp3',
      options: { bitrate: '128k' }
    })
    check('convertFile: success=true', conv.success === true, JSON.stringify(conv).slice(0, 300))
    if (conv.success) {
      const convHost = path.join(CLOUD_DIR, conv.data.fileID.replace('cloud://mock/', ''))
      check('convertFile: 上传 converted_audios 文件存在', fs.existsSync(convHost), conv.data.fileID)
      near('convertFile: 成片时长≈120s', ffprobeDuration(convHost), 120, 0.2)
      check('convertFile: 返回目标大小≈实际大小', Math.abs(conv.data.targetSize - fs.statSync(convHost).size) < 1024)
      check('convertFile: 返回 targetFormat=mp3', conv.data.targetFormat === 'mp3')
      check('convertFile: 源文件已自动清理（deleteFile 被调用）', deletedCloudFiles.indexOf(files.source120) >= 0)
      check('convertFile: 写 converted_files 台账', dbDocs.some(function (d) { return d._collection === 'converted_files' && d.fileID === conv.data.fileID }))
    }

    // -----------------------------------------------------------------------
    section('3) analyzeAudio：正常文件（120s）')
    const an = await fn.main({ action: 'analyzeAudio', fileID: files.source120, fileName: 'music_loud_quiet_120s_v2.mp3', size: fs.statSync(files.source120Host).size })
    check('analyzeAudio: success=true', an.success === true, JSON.stringify(an).slice(0, 300))
    if (an.success) {
      const d = an.data
      near('analyzeAudio: duration≈120s', d.duration, 120, 0.15)
      check('analyzeAudio: format=mp3', d.format === 'mp3')
      check('analyzeAudio: sampleRate=44100', d.sampleRate === 44100)
      check('analyzeAudio: channels=1', d.channels === 1)
      check('analyzeAudio: bucketMs=50', d.bucketMs === 50)
      near('analyzeAudio: buckets≈2400', d.buckets, 2400, 2)
      const peak = Buffer.from(d.peaks.peak, 'base64')
      const rms = Buffer.from(d.peaks.rms, 'base64')
      check('analyzeAudio: peaks 两数组等长且=桶数', peak.length === d.buckets && rms.length === d.buckets)
      check('analyzeAudio: playableIos/Android=true', d.playableIos === true && d.playableAndroid === true)
      let loudSum = 0
      let quietSum = 0
      for (let b = 100; b < 1100; b++) loudSum += rms[b]
      for (let b = 1300; b < 2300; b++) quietSum += rms[b]
      check('analyzeAudio: 波形响/轻段比例>5', loudSum / 1000 / (quietSum / 1000) > 5, 'loud=' + (loudSum / 1000).toFixed(1) + ' quiet=' + (quietSum / 1000).toFixed(1))
      const tmpLeft = fs.readdirSync('/tmp').filter(function (n) { return n.indexOf('ed_analyze_') === 0 })
      check('analyzeAudio: finally 清理 /tmp 临时文件', tmpLeft.length === 0, tmpLeft.join(','))
    }

    // -----------------------------------------------------------------------
    section('4) analyzeAudio：错误码分支')
    const anBad = await fn.main({ action: 'analyzeAudio', fileID: files.badRandom, fileName: 'bad_random.mp3', size: 50000 })
    check('坏文件: success=false', anBad.success === false)
    check('坏文件: code=INVALID_FILE', anBad.code === 'INVALID_FILE', JSON.stringify(anBad))
    check('坏文件: errorMessage 为用户可读中文', /[\u4e00-\u9fa5]/.test(anBad.errorMessage || ''), anBad.errorMessage)

    const anLong = await fn.main({ action: 'analyzeAudio', fileID: files.long610, fileName: 'long_610s.mp3', size: fs.statSync(files.long610Host).size })
    check('610s: code=DURATION_TOO_LONG', anLong.success === false && anLong.code === 'DURATION_TOO_LONG', JSON.stringify(anLong))

    const anBig = await fn.main({ action: 'analyzeAudio', fileID: files.source120, fileName: 'x.mp3', size: 60 * 1024 * 1024 })
    check('声明 >50MB: code=FILE_TOO_LARGE', anBig.success === false && anBig.code === 'FILE_TOO_LARGE', JSON.stringify(anBig))

    const anNoId = await fn.main({ action: 'analyzeAudio', fileName: 'x.mp3' })
    check('缺 fileID: success=false', anNoId.success === false && /fileID/.test(anNoId.errorMessage || ''), JSON.stringify(anNoId))

    // -----------------------------------------------------------------------
    section('5) renderEdit：正常导出（[0,20]+[60,80]，淡入 1s / 音量 -3dB → 40s）')
    const badBefore = dbDocs.length
    const re = await fn.main({
      action: 'renderEdit',
      fileID: files.source120,
      fileName: 'music.mp3',
      segments: [{ in: 0, out: 20 }, { in: 60, out: 80 }],
      fadeIn: 1,
      fadeOut: 0,
      volumeDb: -3,
      format: 'mp3',
      bitrate: '192k'
    })
    check('renderEdit: success=true', re.success === true, JSON.stringify(re).slice(0, 400))
    if (re.success) {
      const d = re.data
      check('renderEdit: 返回 edited_audios fileID', /^cloud:\/\/mock\/edited_audios\//.test(d.fileID), d.fileID)
      const outHost = path.join(CLOUD_DIR, d.fileID.replace('cloud://mock/', ''))
      check('renderEdit: 上传成片存在', fs.existsSync(outHost))
      near('renderEdit: duration=40', d.duration, 40, 0.001)
      near('renderEdit: 成片可解码且时长≈40s', ffprobeDuration(outHost), 40, 0.2)
      check('renderEdit: 记录 size 与文件一致', d.size === fs.statSync(outHost).size)
      check('renderEdit: costMs>0', d.costMs > 0)
      check('renderEdit: fileName 以 _剪辑.mp3 结尾', /_剪辑\.mp3$/.test(d.fileName), d.fileName)
      const docs = dbDocs.slice(badBefore)
      check('renderEdit: 写 converted_files（kind=edit_output）', docs.some(function (x) { return x._collection === 'converted_files' && x.kind === 'edit_output' && x.fileID === d.fileID }))
      check('renderEdit: 台账字段完整', docs.some(function (x) { return x.openid === 'mock-openid' && x.format === 'mp3' && x.size > 0 && !!x.createdAt }))
      const tmpLeft = fs.readdirSync('/tmp').filter(function (n) { return n.indexOf('ed_render_') === 0 })
      check('renderEdit: finally 清理 /tmp 临时文件', tmpLeft.length === 0, tmpLeft.join(','))
    }

    // -----------------------------------------------------------------------
    section('6) renderEdit：参数校验与越界 clamp')
    const resEmpty = await fn.main({ action: 'renderEdit', fileID: files.source120, fileName: 'a.mp3', segments: [] })
    check('0 段: code=PARAM_ERROR', resEmpty.success === false && resEmpty.code === 'PARAM_ERROR', JSON.stringify(resEmpty))

    const resShort = await fn.main({ action: 'renderEdit', fileID: files.source120, fileName: 'a.mp3', segments: [{ in: 1, out: 1.1 }] })
    check('0.1s 片段: code=PARAM_ERROR', resShort.success === false && resShort.code === 'PARAM_ERROR', JSON.stringify(resShort))

    const resOut = await fn.main({ action: 'renderEdit', fileID: files.source120, fileName: 'a.mp3', segments: [{ in: 500, out: 520 }] })
    check('段完全越界: code=PARAM_ERROR', resOut.success === false && resOut.code === 'PARAM_ERROR', JSON.stringify(resOut))

    const resFmt = await fn.main({ action: 'renderEdit', fileID: files.source120, fileName: 'a.mp3', segments: [{ in: 0, out: 10 }], format: 'm4a' })
    check('format=m4a: code=UNSUPPORTED_FORMAT', resFmt.success === false && resFmt.code === 'UNSUPPORTED_FORMAT', JSON.stringify(resFmt))

    const resNoId = await fn.main({ action: 'renderEdit', segments: [{ in: 0, out: 10 }] })
    check('缺 fileID: success=false', resNoId.success === false, JSON.stringify(resNoId))

    const resLong = await fn.main({ action: 'renderEdit', fileID: files.source120, fileName: 'a.mp3', segments: [{ in: 0, out: 400 }, { in: 30, out: 400 }] })
    check('计划 >600s: code=DURATION_TOO_LONG', resLong.success === false && resLong.code === 'DURATION_TOO_LONG', JSON.stringify(resLong))

    // -----------------------------------------------------------------------
    section('7) renderEdit v2：多源 sources[] + clips[] + 每片段 fade（2 源 3 片 → 成片 8s）')
    const v2Before = dbDocs.length
    const reV2 = await fn.main({
      action: 'renderEdit',
      sources: [
        { fileID: files.v2src0, fileName: 'v2_src0_440_8s.mp3', size: fs.statSync(files.v2src0Host).size },
        { fileID: files.v2src1, fileName: 'v2_src1_660_6s.mp3', size: fs.statSync(files.v2src1Host).size }
      ],
      clips: [
        { sourceIndex: 0, in: 0, out: 3, fadeIn: 1, fadeOut: 0.5 },
        { sourceIndex: 1, in: 1, out: 4, fadeIn: 0, fadeOut: 1 },
        { sourceIndex: 0, in: 5, out: 7, fadeIn: 0.5, fadeOut: 0.5 }
      ],
      volumeDb: -6,
      format: 'mp3',
      bitrate: '192k',
      // v2 应忽略顶层全局 fade（逐片 fade 已生效）
      fadeIn: 5,
      fadeOut: 5
    })
    check('renderEdit v2: success=true', reV2.success === true, JSON.stringify(reV2).slice(0, 400))
    if (reV2.success) {
      const d = reV2.data
      check('renderEdit v2: 返回 edited_audios fileID', /^cloud:\/\/mock\/edited_audios\//.test(d.fileID), d.fileID)
      const outHost = path.join(CLOUD_DIR, d.fileID.replace('cloud://mock/', ''))
      check('renderEdit v2: 上传成片存在', fs.existsSync(outHost))
      near('renderEdit v2: duration=8（3+3+2）', d.duration, 8, 0.001)
      near('renderEdit v2: 成片可解码且时长≈8s', ffprobeDuration(outHost), 8, 0.2)
      check('renderEdit v2: 记录 size 与文件一致', d.size === fs.statSync(outHost).size)
      check('renderEdit v2: costMs>0', d.costMs > 0)
      check('renderEdit v2: fileName 以 _剪辑.mp3 结尾', /_剪辑\.mp3$/.test(d.fileName), d.fileName)
      const docs = dbDocs.slice(v2Before)
      check('renderEdit v2: 写 converted_files（kind=edit_output）', docs.some(function (x) { return x._collection === 'converted_files' && x.kind === 'edit_output' && x.fileID === d.fileID }))
      check('renderEdit v2: 台账字段完整', docs.some(function (x) { return x.openid === 'mock-openid' && x.format === 'mp3' && x.size > 0 && !!x.createdAt }))
      const tmpLeft = fs.readdirSync('/tmp').filter(function (n) { return n.indexOf('ed_render_') === 0 })
      check('renderEdit v2: finally 清理多源 /tmp 临时文件', tmpLeft.length === 0, tmpLeft.join(','))
    }

    // -----------------------------------------------------------------------
    section('8) renderEdit v2：错误码分支（sources/clips 校验 + 源文件异常）')
    const sixSources = []
    for (let i = 0; i < 6; i++) sixSources.push({ fileID: files.v2src0, fileName: 'a.mp3' })
    const resSources = await fn.main({
      action: 'renderEdit',
      sources: sixSources,
      clips: [{ sourceIndex: 0, in: 0, out: 1 }]
    })
    check('v2 6 个源: code=SOURCES_TOO_MANY', resSources.success === false && resSources.code === 'SOURCES_TOO_MANY', JSON.stringify(resSources))

    const manyClips = []
    for (let i = 0; i < 41; i++) manyClips.push({ sourceIndex: 0, in: (i % 40) * 0.2, out: (i % 40) * 0.2 + 0.2 })
    const resClips = await fn.main({
      action: 'renderEdit',
      sources: [{ fileID: files.v2src0, fileName: 'a.mp3' }],
      clips: manyClips
    })
    check('v2 41 个片段: code=CLIPS_TOO_MANY', resClips.success === false && resClips.code === 'CLIPS_TOO_MANY', JSON.stringify(resClips))

    const resNoClips = await fn.main({ action: 'renderEdit', sources: [{ fileID: files.v2src0, fileName: 'a.mp3' }] })
    check('v2 缺 clips: code=PARAM_ERROR', resNoClips.success === false && resNoClips.code === 'PARAM_ERROR', JSON.stringify(resNoClips))

    const resBadIndex = await fn.main({
      action: 'renderEdit',
      sources: [{ fileID: files.v2src0, fileName: 'a.mp3' }],
      clips: [{ sourceIndex: 2, in: 0, out: 1 }]
    })
    check('v2 sourceIndex 越界: code=PARAM_ERROR', resBadIndex.success === false && resBadIndex.code === 'PARAM_ERROR', JSON.stringify(resBadIndex))

    const resShortClip = await fn.main({
      action: 'renderEdit',
      sources: [{ fileID: files.v2src0, fileName: 'a.mp3' }],
      clips: [{ sourceIndex: 0, in: 1, out: 1.1 }]
    })
    check('v2 片段 0.1s: code=PARAM_ERROR', resShortClip.success === false && resShortClip.code === 'PARAM_ERROR', JSON.stringify(resShortClip))

    const resTotalLen = await fn.main({
      action: 'renderEdit',
      sources: [{ fileID: files.v2src0, fileName: 'a.mp3' }],
      clips: manyClips.slice(0, 40).map(function () { return { sourceIndex: 0, in: 0, out: 20 } })
    })
    check('v2 成片 >600s: code=DURATION_TOO_LONG', resTotalLen.success === false && resTotalLen.code === 'DURATION_TOO_LONG', JSON.stringify(resTotalLen))

    const resBigSrc = await fn.main({
      action: 'renderEdit',
      sources: [{ fileID: files.v2src0, fileName: 'a.mp3', size: 60 * 1024 * 1024 }],
      clips: [{ sourceIndex: 0, in: 0, out: 1 }]
    })
    check('v2 源声明 >50MB: code=FILE_TOO_LARGE', resBigSrc.success === false && resBigSrc.code === 'FILE_TOO_LARGE', JSON.stringify(resBigSrc))

    const resNoFileID = await fn.main({
      action: 'renderEdit',
      sources: [{ fileName: 'a.mp3' }],
      clips: [{ sourceIndex: 0, in: 0, out: 1 }]
    })
    check('v2 源缺 fileID: code=PARAM_ERROR', resNoFileID.success === false && resNoFileID.code === 'PARAM_ERROR', JSON.stringify(resNoFileID))

    const resFmtV2 = await fn.main({
      action: 'renderEdit',
      sources: [{ fileID: files.v2src0, fileName: 'a.mp3' }],
      clips: [{ sourceIndex: 0, in: 0, out: 1 }],
      format: 'm4a'
    })
    check('v2 format=m4a: code=UNSUPPORTED_FORMAT', resFmtV2.success === false && resFmtV2.code === 'UNSUPPORTED_FORMAT', JSON.stringify(resFmtV2))

    const resBadSrc = await fn.main({
      action: 'renderEdit',
      sources: [
        { fileID: files.v2src0, fileName: 'a.mp3' },
        { fileID: files.badRandom, fileName: 'bad.mp3' }
      ],
      clips: [{ sourceIndex: 0, in: 0, out: 1 }, { sourceIndex: 1, in: 0, out: 1 }]
    })
    check('v2 源为坏文件: code=INVALID_FILE', resBadSrc.success === false && resBadSrc.code === 'INVALID_FILE', JSON.stringify(resBadSrc))
    check('v2 坏文件错误文案含源序号', /第 2 个源文件/.test(resBadSrc.errorMessage || ''), resBadSrc.errorMessage)

    const resVideoSrc = await fn.main({
      action: 'renderEdit',
      sources: [{ fileID: files.v2video, fileName: 'video_only_2s.mp4' }],
      clips: [{ sourceIndex: 0, in: 0, out: 1 }]
    })
    check('v2 源无音轨: code=DECODE_FAILED', resVideoSrc.success === false && resVideoSrc.code === 'DECODE_FAILED', JSON.stringify(resVideoSrc))

    const tmpLeftAfterErrors = fs.readdirSync('/tmp').filter(function (n) { return n.indexOf('ed_render_') === 0 })
    check('v2 失败路径: finally 清理 /tmp（含已下载源）', tmpLeftAfterErrors.length === 0, tmpLeftAfterErrors.join(','))

    // -----------------------------------------------------------------------
    section('9) cleanup（兼容旧行为，清理 mock 台账）')
    const cl = await fn.main({ action: 'cleanup', olderThanSec: 0 })
    check('cleanup: 返回 action=cleanup', cl.action === 'cleanup', JSON.stringify(cl))
    check('cleanup: 删除云文件数>0', Number(cl.deleted) > 0, JSON.stringify(cl))
    check('cleanup: 台账已清空', dbDocs.filter(function (d) { return d._collection === 'converted_files' }).length === 0)
  } finally {
    restore()
    try {
      fs.unlinkSync('/tmp/ffmpeg-probe-bin')
    } catch (e) {}
  }

  console.log('\n============================================')
  console.log('action 级 mock 实测: pass=' + pass + ' fail=' + fail)
  if (fail > 0) {
    console.log('失败项：')
    failures.forEach(function (f) { console.log('  - ' + f) })
    process.exit(1)
  }
  console.log('全部通过 ✅（真实 exports.main + mock 云 SDK + 容器静态 FFmpeg 7.0.2）')
}

module.exports = { main: main }

main().catch(function (e) {
  console.error('测试异常:', e && e.stack)
  process.exit(1)
})
