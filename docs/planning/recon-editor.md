# 编辑器 / 云端侦察报告（recon-editor）

> 任务：task-3（编辑器 + 云端渲染链路现状与更新机会）｜执行人：auditor-editor（只读侦察）
> 仓库：`/Users/mimi/WeChatProjects/miniprogram-1`｜分支：`feature/v5.1-audio-capture-library`｜基线：`d55310f`
> 执行方式：纯静态审阅（read/grep/awk）+ 3 个只读 Node 统计脚本；**未改任何代码/配置，未执行 git 写操作，未部署云函数、未跑 Docker、未上真机**。唯一写入文件即本报告。
> 证据约定：下表别名 + 行号；所有结论均给到「文件:行号」。

## 0. 别名与证据口径

| 别名 | 文件 | 行数 / 字节 |
| :--- | :--- | ---: |
| `E` | `miniprogram/pages/editor/editor.js` | 4731 / 167,931 |
| `W` | `miniprogram/pages/editor/editor.wxml` | 1452 / 71,557 |
| `CSS` | `miniprogram/pages/editor/editor.wxss` | 4256 / 84,423 |
| `U` | `miniprogram/utils/editor-utils.js` | 1270 / 45,413 |
| `F` | `cloudfunctions/ffmpegProbe/index.js` | 740 / 30,365 |
| `C` | `cloudfunctions/ffmpegProbe/lib/editor-core.js` | 841 / 33,022 |
| `I` | `miniprogram/pages/index/index.js` | 933 |
| `IW` | `miniprogram/pages/index/index.wxml` | 525 |
| `D` | `docs/MUSIC_EDITOR_DESIGN.md` | 2088 |
| `K` | `docs/EDITOR_IMPL_CONTRACT.md` | 231 |
| `L` | `docs/DEV_LOG.md` | 313 |
| `B` | `docs/planning/baseline-verification.md`（task-1 验证基线） | — |

> 工作量口径（单人）：**S ≤ 0.5 天**、**M 0.5–2 天**、**L > 2 天**（含自测；不含真机/审核/发布窗口）。
> 本次只读实测：`wc -l` / `du -sh` / `file` / 2 个 Node 结构统计脚本（见 §6）。

---

## 1. 结论摘要（先看这 12 条）

| # | 结论 | 关键证据 |
| :-- | :--- | :--- |
| 1 | 编辑器功能面已相当完整：5 源导入、6 轨、40 片段、分割/裁剪/ripple 删除/复制粘贴/拖动磁吸/碰撞顺延/变速/EQ/降噪/增益/淡变/ducking/双指缩放/撤销/草稿/云端 mp3 导出/成片试听转发 | `E:43-173`、`E:1766-1834`、`E:4337-4476`、`K:136-231` |
| 2 | **导出格式只有 mp3**，客户端、请求、云函数输出路径、返回文件名、台账 5 处硬编码 | `E:4346`、`E:4482`、`C:40`、`F:327/374/385/210` |
| 3 | 云端编码器能力**已具备**（同一云函数的 `convertFile` 就在用 m4a/wav/flac/ogg 的编码参数），缺的只是编辑导出侧的格式开关与限额矩阵 | `F:24-31/534-540`、`L:178/185-194` |
| 4 | **WAV 受 50MB 输出上限硬约束**：44.1k/16bit/立体声 ≈10.6MB/分钟，600s 成片 ≈105.8MB；设计建议 WAV ≤4min、FLAC ≤7min、M4A ≤8min | `D:1483-1491`、`C:37` |
| 5 | `renderEditV2` 是**同步执行**：函数墙钟 60s（控制台设置），FFmpeg 内部 50s，下载/探测不设总预算；5 源大文件 + 复杂滤镜时「下载+探测+50s 渲染+上传」有超 60s 风险 | `F:39-41/190-204/328-358`、`L:207/234` |
| 6 | 失败路径已能回编辑态保工程并「重新导出」，但**无幂等/无 taskId**：超时重试会重复渲染、重复落库，函数被杀时还可能留下「已上传但客户端认为失败」的孤儿成片 | `E:4393-4409`、`F:374-390`、`L:237` |
| 7 | **源文件永不清理**：analyzeAudio 上传到 `edit_sources/` 后从不写台账，`cleanup` 只按 `converted_files` 删 → 剪辑源文件 24h 后仍在（存储泄漏） | `E:765-770`、`F:235-306/137-160` |
| 8 | 录音（RecorderManager）**当前完全不存在**；`onStop` 的 `{tempFilePath,duration,fileSize}` 可零后端改动接入 `importFiles` 链路 | 全仓 grep 无 recorder；接入点 `E:732-816` |
| 9 | **没有作品库/导出历史**：导出成功即 `clearDraft()`，离开页面后除了云端 24h 文件与云端台账（客户端不可查）之外无痕迹 | `E:4473`、`F:207-224`、`I:869-884`（转换侧有历史，编辑侧没有） |
| 10 | 草稿是**单工程、单 storage key、7 天**，且 `peaks`（Uint8Array）随草稿 JSON 序列化，5 源×10min 估算接近 1MB/单 key 上限，失败只 `console.warn` 不提示 | `E:31/379-413/439-442` |
| 11 | 代码结构：单 Page 对象 **194 个方法**（87 个是 wxml 事件处理函数），时间轴/轨道/手势区块 1618 行占 34%；wxss **546 规则块/23 段动画**，章节注释编号乱序重复 | 本次统计（§6）、`E:1579-3196`、`CSS:604/1204/2867/3177/3304/3519` |
| 12 | v5.2 最该做的是「**导出闭环**」三件套：可靠性加固（S/M）→ 格式扩展（M）→ 作品库（M）；两段式任务化（L）建议推迟到有真实超时数据之后 | 见 §5 |

---

## 2. 能力盘点

### 2.1 功能域清单（已实现 / 明确缺口）

| 功能域 | 已实现（证据） | 明确缺口（证据） |
| :--- | :--- | :--- |
| **导入** | `wx.chooseMessageFile` 一次多选、可选数量=剩余源名额（`E:652-669`）；9 种扩展名白名单（`U:15`）、空文件/50MB 预检（`U:178-204`→`E:705-711`）；串行 上传→analyze→建 source+默认整段 clip（`E:732-816`）；部分失败可「重试失败项」（`E:713-726/923-942`）；单源 ≤600s/≤50MB、源 ≤5、片段 ≤40（`U:16-19`、`E:821-833`） | 无录音入口（全仓 grep 无 `RecorderManager`）；无机内文件选择（平台限制，`L:219` ISSUE-001）；**源文件不清理**（`F:235-306` 无台账写入 + `F:137-160` 只删 converted_files）；无「同文件复用上次分析结果」缓存（设计 `D:1527` 的 audio_analyses 未落地） |
| **轨道** | 默认 2 轨、动态加至 6 轨（`E:115-118/1766-1789`）、删轨二次确认并移除该轨片段（`E:1791-1834`）；轨头静音（`E:2904-2914`）、ducking（`E:2925-2936`）、音量预设轮换 0/-6/-12/-18/+3（`E:2938-2954`）；片段换轨（`E:2802-2812`）、跨轨移动（`E:1881-1896`）、重叠自动下移下一轨（`E:2654-2749`、`U:887-1004`） | `solo` 方法存在但 **wxml 无任何绑定**（`E:2916-2923`；`W` 全文无 solo）；**服务端只处理 mute 且只在多轨分支**（`C:715/729`）→ 单轨工程静音导出不生效；solo/ducking **不参与导出**（`C:645-779` 无对应滤镜；`U:1147` 只透传 tracks）；全轨静音时兜底 `anullsrc 1s` 与返回 `plan.totalDur` 不一致（`C:762-764` vs `F:387`） |
| **片段** | 数据模型 `{id,sourceId,in,out,fadeIn,fadeOut,trackId,offsetSec,speed,eqPreset,denoise,volumeDb,pan,isDuplicate}`（`U:320-338`、`E:863-871`）；上移/下移/删除（`E:1314-1353`）；播放头分割（`E:1355-1373`）、剃刀落指处分割（`E:1601-1634`）、裁至选区（`E:1501-1524`）、重置（`E:1526-1542`）、ripple 删除（`E:1544-1579`、`U:561-627`）；复制/粘贴/复制一份（`E:1375-1442`）；把手拖拽改 in/out（`E:2257-2614`）；微调（`E:2968-3003/3187-3199`）；拖动+磁吸+碰撞检测（`E:2052-2256/2615-2749`）；撤销快照最多 30（`E:1257-1278`、`E:30`） | **无重做**（全仓 grep 无 redo）；undo 快照只有 `clips+selectedIndex`（`E:1257-1263`）→ 加/删轨（`E:1772/1806`）、静音/独奏/ducking（`E:2904-2936`）、轨道音量（`E:2947`）**撤销不回来**；`pan` 是死字段：请求里带（`U:1136`）但服务端归一化白名单不含 pan（`C:499-504/557-560/621-623`）→ 永远不生效 |
| **变换/音效** | 每片淡变 0/0.5/1/2/3s，超长等比缩（`U:23/1165-1187`、`C:541-545`）；变速 0.5–2.0（`U:33`、`E:2814-2826`、`C:678-680`）；5 种 EQ 预设（`U:35-41`、`C:682-690`）；降噪 4 档（`U:43-48`、`C:691-694`）；片段增益 -24~+12dB（`E:2865-2887`、`C:696-698`）；全局音量（`E:3293-3309`、`C:775`）；轨道音量（`E:2938-2954`、`C:748-752`）；限幅固定 `alimiter=limit=0.95`（`C:41/776`） | 降噪 UI 标 3/6/12dB（`U:43-48`）但服务端只做固定 `highpass=80,lowpass=12000`，与所选 dB 无关（`C:691-694`）→ 参数名不副实；EQ/降噪/ducking **预览听不到**（预览只做音量+淡变包络+playbackRate，`E:3706-3721/3488-3528`）；`pan` 未生效（同上）；无 BGM/循环/响度标准化（设计 P1/P2，`D:1508`） |
| **播放** | 单轨跨源顺序试听队列（`U:1033-1083`、`E:3562-3704`）+ 淡变/增益包络（`E:3706-3721`）；多轨真并发：每轨一个 `InnerAudioContext` 池（`E:578-590`）+ 35ms 墙钟主时钟（`E:3427-3542`）；静音跳过（`E:3488-3492`）、ducking 近似下压 -12dB（`E:3507-3510`）、变速用 `playbackRate`（`E:3526-3529`）；来电/中断自动停（`E:240-243/346-353`）；静音键穿透（`E:233-237/564`）；成片播放器带 slider/seek/本地零缓冲热切（`E:4573-4659`） | 预览是「近似」而非渲染级：EQ/降噪不生效、变速是**变调**而非 `atempo` 保持音调（`E:3528` vs `C:679`）→ 导出听感与预览不一致；无 A/B 对比、无循环播放；无「solo 试听」 |
| **时间轴** | Canvas2D 源波形 + 标尺 + 选区 + 播放头（`E:3919-4183`）；双指捏合 0.02x–4x、全览/预设/步进、缩放以光标为中心（`E:1642-1760/1927-2050`）；播放自动跟焦且不弹回（`E:3466-3478/3153-3185`）；10 分钟限额界碑与超限红纹（`W:410-422`、`E:1170-1173`）；样式集中在 `CSS:1204-2866` | 存在**两条时间轴**（源波形 canvas 与多轨时间轴）认知负担（`W:163-176` vs `W:267+`）；无拖拽调整片段顺序的「换轨拖拽」（换轨靠按钮）；无片段对齐吸附到其他轨的吸附点（只有 0s/播放头/相邻边缘，`E:2052-2256`） |
| **导出** | mp3 192k 默认、6 档码率 64k–320k（`E:34-41/96`）；复杂度预检只影响文案（`E:4358-4364`）；elapsed 计时（`E:4376-4378`）；失败保工程 + 重试（`E:4393-4409`）；成功进结果页并可试听/转发（`E:4443-4476/4661-4692`）；结果页提示 24h 保留（`W:1431`） | **只有 mp3**（`E:4346`、`C:40`、`F:327/374/385`）；无 WAV/M4A/FLAC、无码率说明与格式/体积/时长联动解释；无进度百分比、无取消、无 taskId 恢复；导出成功不写本地历史（`E:4443-4476` 无 storage 写入） |
| **草稿** | 防抖 400ms 自动保存（`E:416-421`）、单 key `NLE_DRAFT_CACHE_V1`（`E:31`）、启动弹窗恢复/丢弃（`E:431-468`）、7 天过期（`E:439-442`）、导出成功清草稿（`E:4473`）、防误退原生化提示（`E:355-371`） | 只能存**一个**工程；无命名/列表/新建-切换；`peaks` 随草稿 JSON 化（`E:394-395`），多源长音频逼近微信单 key 1MB 上限且失败静默（`E:411-413`）；不存缩放/选区/格式偏好/撤销栈；无版本迁移字段 |
| **容错** | 导入失败逐项文案 + 重试（`E:944-975`）；未部署云函数的识别（`E:952-961`）；导出失败回编辑态且「工程完整保留」弹窗（`E:4393-4409`）；本地临时文件失效自动从 fileID 重下（`E:512-542`）；不可预览格式平台提示（`E:1111-1124`）；波形不可用降级提示（`W:176`）；音频实例 onHide/onUnload 销毁（`E:270-295/592-617`） | 客户端 `callFunction` 无超时（`L:237` ISSUE-019）；无导出 watchdog / 断网重试策略；无幂等（重复点重试=重复渲染+重复落库）；无崩溃/错误上报；`mapExportError` 缺 `OUTPUT_TOO_LARGE`/`UNSUPPORTED_FORMAT` 文案（`E:4416-4429` vs `F:367-369`） |

### 2.2 数据模型

```text
sources[]  { id, fileID, localPath, name, size, duration, format, sampleRate, channels,
             peaks:{peak:Uint8Array, rms:Uint8Array}, rmsPeaks, bucketMs, playable,
             playableIos/playableAndroid, metaText }                 E:839-860、E:381-398
clips[]    { id, sourceId, in, out, fadeIn, fadeOut, trackId, offsetSec?, speed?,
             eqPreset?, denoise?, volumeDb?, pan?, isDuplicate? }    E:863-871、U:320-338
tracks[]   { id, name, color, tag, mute, solo, volumeDb, ducking? }  E:115-118、E:1776-1784
视图       trackViews / timelineData（每轨片段像素位置+波形柱+播放头）  U:717-887、E:1154-1161
渲染请求   { sources:[{fileID,fileName,size}]（仅被引用源、按首现重排）,
             clips:[{sourceIndex,trackId,offsetSec,in,out,fadeIn,fadeOut,volumeDb,
                     speed,eqPreset,denoise,pan}],
             tracks, volumeDb, format, bitrate }                     U:1100-1153
服务端plan { sources, clips, totalDur, format, bitrate, volumeDb }    C:582-634
```

口径差异（值得修）：客户端 `planDuration = Σ(out-in)`（`U:313-318`），服务端 `planClipsDuration` 多轨取「Σ 与各轨终点最大值」（`C:513-533`）。多轨/带 offset 时客户端估算时长（体积预估、10 分钟限额判断、结果页兜底）会小于真实成片。

### 2.3 import → analyze → render 真实链路

```text
[导入]
E:652 chooseAudioFiles → wx.chooseMessageFile(count=剩余名额, extension=AUDIO_EXTENSIONS)
  → E:691 handleFilesPicked → E:705 U.validateLocalFile（扩展名/空/50MB）
  → E:732 importFiles（串行）：
      E:765 U.buildCloudPath → edit_sources/{ts}_{rand}.{ext}
      E:770 wx.cloud.uploadFile
      E:779 wx.cloud.callFunction{action:'analyzeAudio', fileID, fileName, size}
           └ F:235 analyzeAudio：F:248 下载→F:251 ffmpeg -i 探测→F:265 -ac1 -ar4000 s16le
             →F:276 computePeaks（50ms 桶 uint8 peak/rms base64）→F:286 返回
      E:818 addSourceFromAnalysis → 建 source + 默认整段 clip（trackId=当前目标轨）
  → E:874 enterEditingAfterImport → refreshClipData + 草稿 + Canvas

[编辑] 全部在内存：this.sources/this.clips/this.tracks/undoStack/selection；
      每次提交走 commitClips（E:1283-1312）→ refreshClipData（E:1129）→ scheduleSaveDraft（E:416）

[导出]
E:4337 startExport → E:4343 U.buildRenderRequest(format:'mp3', bitrate)
  → E:4381 wx.cloud.callFunction{action:'renderEdit', ...request}
       └ F:309 renderEdit → F:315 renderEditV2：
           F:320 C.normalizeRenderRequestV2（便宜校验 sources≤5/clips≤40/单片≥0.2/总≤600）
           F:331 逐源 cloud.downloadFile + ffmpeg -i 探测（真实时长）
           F:351 C.clampClipsToSources + finalizePlanV2（clamp + 每片 fade 收敛）
           F:357 C.buildRenderArgsV2 → F:358 execFile(ffmpeg, timeout=50s, SIGKILL)
           F:365-369 输出空/超 50MB 校验 → F:374 上传 edited_audios/*.mp3
           F:379 recordEditOutput（converted_files, kind=edit_output）→ F:381 返回
  → E:4443 handleExportSuccess → 结果卡片 + E:4472 预下载本地 + E:4473 clearDraft
  → E:4661 shareResult（wx.shareFileMessage，必须点击手势内且本地路径就绪）
```

---

## 3. 逐项回答

### a. 导出格式：现状、扩展改动面、编码器、码率语义、限额、UI、工作量

**现状（硬编码点按层汇总，共 7 组）**

| 层 | 位置 | 现状 |
| :--- | :--- | :--- |
| 页面请求 | `E:4346` | `format: 'mp3'` 写死；`E:4347` 只透传 `exportBitrate` |
| 客户端输出名 | `E:4482` | `${base}_剪辑.mp3` |
| 客户端 UI | `W:1314/100/107/1333` | 按钮「导出 MP3」、指南与导出中文案写死 MP3 |
| 客户端估算 | `E:1093-1109` | 体积=`dur*kbps*1000/8+4096`；压缩比基准 `dur*44100*4`（隐含 WAV 基准），对 WAV/FLAC 无语义 |
| 渲染请求默认 | `U:1149` | `opts.format \|\| 'mp3'` |
| 云函数输出 | `F:327/374/385`、`F:210/217` | 临时文件 `.mp3`、cloudPath `.mp3`、fileName `_剪辑.mp3`、台账 `format:'mp3'` |
| 纯函数核心 | `C:40`、`C:407-411`、`C:437/789`、`C:337-340/592-595` | `OUTPUT_FORMATS=['mp3']`；`ENCODERS` 只有 mp3；两处 `normalize*Request` 用白名单拒其他格式（`UNSUPPORTED_FORMAT`） |

**编码器支持（结合仓库事实）**

- 静态 FFmpeg 7.0.2 已知含 libmp3lame / 原生 aac / flac / pcm / libvorbis（`L:178` F11；`L:181-194` 1 CPU Docker 实测表）。
- **同一云函数的 `convertFile` 已经在生产链路使用这些编码参数**：`F:24-31` TARGETS（mp3=libmp3lame；m4a=`aac -aac_coder fast -movflags +faststart`；wav=`pcm_s16le -ar 44100 -ac 2`；flac=`flac -compression_level 5`；ogg/aac），`F:534-540` 拼 args + `-b:a/-ar/-ac`。
- `cloudfunctions/ffmpegProbe/bin/ffmpeg` 为 Linux x86-64 静态 ELF（本次 `file` 实测），macOS 不能直接跑，本机 Docker daemon 未启动（`B` 二/七），故**编码器清单只能引用既有实测记录，未在本轮重新跑 ffmpeg**。
- 结论：**不需要新编码器、不需要新依赖**，扩展是「参数表 + 校验 + 命名 + UI + 限额」的纯周边改动。

**码率参数含义（必须向用户讲清）**

| 格式 | `-b:a` 是否有意义 | 实际参数 | 体积公式（成片 D 秒） |
| :--- | :--- | :--- | :--- |
| MP3 | 是（CBR） | `-c:a libmp3lame -b:a {64k..320k}` | D×kbps×1000/8 |
| M4A(AAC) | 是 | `-c:a aac -aac_coder fast -b:a {…} -movflags +faststart` | D×kbps×1000/8 |
| WAV | **否** | `-c:a pcm_s16le -ar 44100 -ac 2`（固定 1411kbps） | D×44100×2ch×16bit/8 = **D×176,400 B** |
| FLAC | 否（无损） | `-c:a flac -compression_level 5` | 真实音乐约 700–900kbps 等效 |

**iOS 可播矩阵（与仓库既有声明一致）**

- iOS：`mp3 / m4a / aac / wav` 可播；**flac / ogg 不可播**（`C:44-45`、`L:174` F7、`I:563-569` 首页按平台判定）。
- Android：额外支持 flac/ogg（`C:45`、`I:569`）。
- 因此若加 FLAC：结果页必须复用首页「母带专用编码 → 请转发到聊天试听/保存」的引导（`IW:423-428`），否则 iOS 用户点试听必报错（`E:4526-4558` 的 error 兜底只能兜一层）。

**50MB 与 10min 限额影响（关键约束）**

| 格式 | 600s 成片体积 | 与 50MB 上限（`C:37`、`F:367-369`） | 建议产品上限 |
| :--- | ---: | :--- | :--- |
| MP3 192k / 320k | 14.4MB / 24MB | 无压力 | 600s（保持） |
| M4A 192k | 14.4MB | 无压力 | 480s（编码耗时，见下） |
| WAV 44.1k/16bit/立体声 | **≈105.8MB** | **超 2 倍，必须限长** | **240s**（≈42MB；设计 `D:1486` 同结论） |
| FLAC 真实音乐 | ≈45–65MB | 边缘/超限 | 420s（设计 `D:1487`） |

> M4A 编码耗时风险：设计实测 10min→m4a 16.9s、竞争环境 35.9s（`D:1498`），而 60s 函数墙钟里还要放「下载全部源 + 逐源探测 + 上传」；再叠加 5 源时不可忽视 → M4A 上限建议 8min 且**在服务端下载前先做时长×格式的预算校验**。

**UI 落点（复用首页现成范式，避免重造）**

- 首页格式选择器：`IW:139-146`（`.format-cell` 六宫格 + 选中 check），数据模型 `I:49-57`；压缩/码率面板 `IW:377-430`；不可播引导 `IW:423-428`。编辑页可：
  1. 吸底导出浮岛的压缩面板上方加一行格式 chips（`W:1214-1279` 内）；
  2. 浮岛胶囊文案 `W:1297-1304` 改成 `格式 · 码率 · 体积`；
  3. 主按钮 `W:1314` 改 `导出 {{exportFormatLabel}}`；
  4. 结果卡片 `W:1360-1372` 规格看板加「格式」格 + iOS 不可播引导块（照 `IW:423-428`）；
  5. 压缩面板在声音抽屉里还有一份重复实现（`W:1143-1200`），扩展时**两处都要改** → 强烈建议先抽组件（见 e）。

**改动清单（可执行级，按依赖顺序）**

| # | 文件:位置 | 改动 |
| :-- | :--- | :--- |
| 1 | `C:40` | `OUTPUT_FORMATS` 扩为 `['mp3','wav','m4a']`（FLAC 是否本轮由产品定，见风险） |
| 2 | `C:407-411` | `ENCODERS` 增加 `wav/m4a`（复用 `F:24-31` 参数；m4a 必须 `-aac_coder fast`）；无 bitrate 的格式忽略入参 |
| 3 | `C:296-299` | `normalizeBitrate` 改 format-aware（wav/flac 返回空、不生成 `-b:a`） |
| 4 | `C:592-604` | `normalizeRenderRequestV2` 增加**分格式时长上限**表（mp3 600 / m4a 480 / wav 240 / flac 420）→ 超限返回 `EXPORT_LIMIT`（新错误码）而非渲染后才发现超 50MB |
| 5 | `C:417-442 / 782-794` | `buildRenderArgs(V2)` 的 encoder 选择已按 `plan.format`；补「wav 不加 `-b:a`」分支 |
| 6 | `F:327` | 临时输出后缀 `.${plan.format}` |
| 7 | `F:374/385` | cloudPath 与返回 fileName 用 `plan.format` |
| 8 | `F:207-224` | `recordEditOutput(openid,fileID,size,format)` 传真实格式（去掉写死 mp3；旧集合兼容逻辑保留） |
| 9 | `F:367-369` 前 | 增加 **渲染前体积预估**（wav: D×176400；flac: 按 160k 保守估）→ 直接返回 `OUTPUT_TOO_LARGE`，避免白渲染 |
| 10 | `F:421-475` | `renderEditV1` 同步支持（或明确声明 v1 保持 mp3-only，在契约里写清） |
| 11 | `E:34-41/90-103` | 新增 `EXPORT_FORMATS` 常量 + `exportFormat/exportFormatLabel` data |
| 12 | `E:4346-4347` | `format: this.data.exportFormat`；`bitrate` 仅对 mp3/m4a 传 |
| 13 | `E:1093-1109` | `calcEstimatedFileSize/calcCompressionRatio` 按格式分支（WAV 用 PCM 公式，压缩比基准统一 WAV） |
| 14 | `E:4416-4429` | `mapExportError` 补 `EXPORT_LIMIT/OUTPUT_TOO_LARGE/UNSUPPORTED_FORMAT` 文案 |
| 15 | `E:4478-4483/4443-4476` | 输出名扩展名 + 结果对象带 `format`、`playableOnIos` |
| 16 | `W:1314/100/107/1333/1297-1304/1360-1372` | 文案动态化 + 格式 chips + 结果页格式格 + iOS/Android 引导 |
| 17 | `CSS:3304-3726`（+ `CSS:2867-3176` 抽屉内重复面板） | `.format-chip` 一族样式（照 `IW:139-146` 的视觉） |
| 18 | `U:1100-1153` | 请求格式仍由调用方传；补单测覆盖 wav/m4a 请求 |
| 19 | `scripts/editor-spike/test_pure.js:456-457` | 现有断言「format=m4a → UNSUPPORTED_FORMAT」必须改为新期望，并补 wav/m4a args/限额用例 |
| 20 | 文档 | `K`§3.2/§6.3 增补格式矩阵；`D`§11.2 去掉「仅 mp3」偏差；`L` 追记 |
| 21 | 部署 | ffmpegProbe 需重新部署（云函数侧改动），首次部署后先用 mp3 回归再验 wav/m4a |

**工作量**：**WAV-only = S（≈0.5–1 天）**；**WAV+M4A = M（≈1.5–2.5 天，含测试与一次云函数部署回归）**；再加 FLAC = M+ / L（iOS 不可播引导 + 7min 限额 + 体积边界）。**注意：本仓库编辑器导出侧改动 ≥3 文件 + 云函数，按 AGENTS.md 3.1 属「大型变更」，需要分支/回归流程，不是「小改」**。

---

### b. 云端可靠性：同步 60s 的真实风险、超时处理、两段式任务化成本

**现状**

| 环节 | 参数/证据 | 说明 |
| :--- | :--- | :--- |
| 云函数墙钟 | 60s（控制台设置；`config.json` 无 timeout，只有 timer 触发器） | `L:207`「deployed…timeout=60s」、`L:234` ISSUE-016「config.json 不生效，用户已在控制台调到 60s」；`cloudfunctions/ffmpegProbe/config.json` 仅 permissions+triggers；对照 `cloudfunctions/audioConvert/config.json` 才有 `"timeout":60`（该函数是遗留未用，见 §4） |
| FFmpeg 渲染 | `EDIT_RENDER_TIMEOUT_MS=50000` + `SIGKILL`（`F:41/358`） | 50s 是**进程**预算，不含下载/探测/上传 |
| 探测 | 每源 `EDIT_PROBE_TIMEOUT_MS=12000`（`F:39`）；5 源逐个 `cloud.downloadFile`+`ffmpeg -i`（`F:331-347`） | 下载无显式超时（`F:190-204`） |
| 解码总量上界 | 源 ≤5 × 单源 ≤600s → 最坏 3000s 音频参与解码（`C:645-707` 每片 `atrim` 需解码到 out 点） | 10min 纯重编码实测 14.0s（`D:1497`）；多效果最坏组合 10.5–22.7s（`D:1505`），但那是**1 源**；5 源×重效果无实测数据 |
| 客户端 | `wx.cloud.callFunction` 无超时参数；切后台 5s 可能中断（`L:237` ISSUE-019） | 客户端只有 elapsed 计时（`E:4376-4378`）与 heavy 文案（`E:4358-4364`、`W:1336`） |

**结论**：对「1–2 源、≤3 分钟、普通淡变/裁剪」的典型用法，实测 0.8–3s（`D:1907`/`D:1909`），**风险低**。风险集中在：
1) 5 源、长时间、多轨 + `atempo/equalizer/amix`（解码总量与滤镜链放大）；
2) 源文件大（≤50MB×5）导致下载占满预算，FFmpeg 还没跑完就被函数 60s 杀掉；
3) 函数在「渲染完成已上传」之后、返回响应之前被杀 → 成片存在、台账已写，但客户端只收到 timeout → **孤儿成片 + 重试再产一份**（`F:374-379` 先上传后返回，无幂等键）；
4) 失败时**没有明确错误码**：函数被杀时客户端只能从 `errMsg` 里匹配 `timeout`（`E:4432-4441`），`mapExportError` 的 `TIMEOUT/RENDER_TIMEOUT` 只在 FFmpeg 自身超时才会返回（`F:359-361`）→ 用户看到的是笼统「网络超时」。
5) 客户端重试无幂等：`E:4393-4409` 弹「重新导出」→ 再次 `callFunction`（`E:4381`），服务端每次新渲染、新上传、新台账记录。

**低成本加固（S–M，建议先于格式扩展做）**

| 加固 | 位置 | 内容 |
| :--- | :--- | :--- |
| 服务端时间预算 | `F:315-358` | 进函数记 `t0`，下载/探测后若 `Date.now()-t0 > BUDGET` 直接返回 `SERVICE_BUSY/TIMEOUT`（不启动必死的渲染） |
| 渲染前体积预估 | `F:357` 前 | 按 format×时长预估输出字节，超 50MB 直接 `OUTPUT_TOO_LARGE` |
| 明确错误码 | `F:359-364` | 区分 `RENDER_TIMEOUT`（FFmpeg 超时）与 `FUNC_BUDGET`（自身预算不足） |
| 客户端看门狗 | `E:4381-4413` | `Promise.race` 式 75s 兜底（函数已 60s 被杀）+ 至少给「稍后可在历史中查看」的出口（依赖作品库） |
| 幂等键 | `E:4343`/`F:320` | 请求带 `clientToken`（时间戳+随机），服务端在同一 token 重复时返回上次结果（轻量幂等，不必上集合也能用 `converted_files` 查 24h 内同名 token 记录） |
| 孤儿清理 | `F:137-160` | cleanup 增加 `kind='edit_output'` 与**未返回成功**（如记录 `status:'uploaded'` 后置 succeeded）的对账；并给 `edit_sources/` 补台账（见 §4 P0-2） |

**两段式任务化（createEditTask → runEditTask → getEditTask）评估**

设计文档已备好完整方案：接口契约 `D:1231-1323`、集合字段（`edit_tasks`：clientToken/status/planHash/plan/quotaCharged/result/error/timings/startedAt/expiresAt）`D:1400-1419`、额度预占/返还算法 `D:1535-1550`、生命周期 2h/24h/48h `D:1446-1455`、真机 Spike E1/E10 `D:1644/1653`、后台触发器依赖按量付费环境（`L:238` ISSUE-020）。

落地需要（相对现状）：

| 类别 | 需要的改动 | 证据/依赖 |
| :--- | :--- | :--- |
| 云函数 | `exports.main` 增 3 个 action（`createEditTask/runEditTask/getEditTask`），`runEditTask` 复用现有 `renderEditV2` 主体；`cleanup` 扩到 `edit_tasks` 48h + 惰性超时（running>75s→failed+退次） | `F:725-740`、`F:137-160`、`D:1547` |
| 云数据库 | 新建 `edit_tasks` 集合 + 索引（openid+clientToken 唯一建议）；`converted_files` 增 `kind`；`quota` 恢复语义（测试期 `QUOTA_ENFORCED=false`，`F:17`） | `D:1369-1433`、`F:17` |
| 客户端 | `exporting` 状态机改为 `queued/polling`；`getEditTask` 轮询 1.5s→3s；页面重进用 `taskId` 恢复；`onShow` 续查；与 `enableAlertBeforeUnload`（`E:355-371`）联动；结果卡片数据源改 task result | `D:1315-1321`、`E:4337-4476` |
| 测试 | `test_actions_mock.js` 需 mock 数据库与任务状态机（现 8 组/605 行），前端冒烟需覆盖轮询/恢复 | 本次统计 `scripts/editor-spike/test_actions_mock.js` 605 行 |
| 风险 | ①**并未突破 60s 计算上限**（仍需一次调用内跑完 FFmpeg），只解决「结果可恢复/幂等/错误分类」；②新增 3 条云端路径 + 集合权限，回归面扩大；③任务卡死需自愈逻辑，比现在「同步失败即时可见」更难排查；④与 24h 清理、额度返还交叉，边界多；⑤真实收益依赖「大导出/弱网/切后台」的发生率，目前**无数据** | `D:1510`（60s 硬超时）、`L:237` |

**是否值得本轮做**：**不值得作为 v5.2 P0**。理由：现状典型导出 1–3s，失败主要来自弱网/函数被杀（低频），而两段式成本 L、回归风险最大、且不提高上限。建议：v5.2 先做上表「低成本加固」，同时在云函数里记录 `timings`（downloadMs/renderMs/uploadMs）与失败码到 `converted_files`，积累 2–4 周真实数据；若「导出耗时 >30s」或「函数超时」占比超过 2–3%，v5.3 再按设计文档落地两段式（设计已就绪，届时几乎照抄）。

---

### c. 录音导入：接入点、最小改动、坑清单

**现状**：全仓无 `RecorderManager`（grep `RecorderManager|startRecord|录音|麦克风` 在 `miniprogram/**`、`cloudfunctions/**` 均 0 命中；v5.1 分支的采集库尚未落到本工作区）。云函数侧**无需任何改动**：`analyzeAudio` 用 ffmpeg 探测容器/编码（`F:251-284`），录音产出的 mp3/aac/wav 直接被接受（`F:253` parseProbeInfo、`F:284` playableFlags）。

**最小接入路径（复用现有串行导入链路，无后端改动）**

```text
wx.getRecorderManager()
  .start({ duration: 600000, format:'mp3', sampleRate:44100, numberOfChannels:1, encodeBitRate:128000 })
  .onStop(res => {                       // res = { tempFilePath, duration, fileSize, sampleRate }
      const pseudoFile = { path: res.tempFilePath, name: `录音_${Date.now()}.mp3`, size: res.fileSize };
      const check = U.validateLocalFile(pseudoFile, { maxBytes: U.MAX_FILE_BYTES }); // E:705 同款预检
      if (!check.ok) { /* 走 E:713-722 的错误展示 */ return; }
      this.preRejects = [];
      this.importFiles([{ file: pseudoFile, ext: 'mp3' }]);   // ← 复用 E:732-816
  })
```

- 关键复用点：`importFiles`（`E:732`）内部已串好「uploadFile（`E:770`）→ analyzeAudio（`E:779`）→ `addSourceFromAnalysis`（`E:792/818`）→ `enterEditingAfterImport`（`E:874`）」，录音只要构造 `{file:{path,name,size}, ext}` 即可，与 `chooseMessageFile` 完全同构（`E:691-726` 产出的就是同一结构）。
- UI 入口：空态主按钮旁（`W:46-51`）+ 空轨道「点击添加音乐」（`W` 空轨卡片）+ 「加音频」ActionSheet（`E:1836-1885` 的 itemList 追加「录制音频」）。录音态应复用 `STATUS.UPLOADING/ANALYZING` 文案位（`E:744-763`）。
- 名额校验必须前置：`MAX_SOURCES - sources.length`（`E:656-660`）；直接调 `importFiles` 不会做这一步。

**坑清单（按发生概率排序）**

| # | 坑 | 说明与规避（证据） |
| :-- | :--- | :--- |
| 1 | 临时文件失效 | `onStop.tempFilePath` 是本地临时文件，可能被微信清理；编辑器已有自愈 `ensureSourceLocalPath`（`E:512-542`，失效时按 fileID 重下），但**录音后应先立刻 upload/analyze**，不要只存 path 等用户操作 |
| 2 | `file.name` 必须有扩展名 | `U.validateLocalFile` 依赖扩展名（`U:184-191`），`U.buildCloudPath` 也按 ext 拼路径（`U:207-212`）→ 录音必须人为构造 `录音_xxx.mp3`，不能传空 name |
| 3 | 时长上限 | RecorderManager 单次录制上限 600000ms=10min，与编辑器单源/成片上限一致（`U:17`）；但「录音 10min + 已有源」叠加会让成片超 600s → 目前只 toast 警告（`E:905-907`）+ 禁用导出（`E:1223`），建议录音前按剩余额度提示剩余可录时长 |
| 4 | 采样率/声道 | 8k/16k 录音导出 mp3 192k 会明显升采样、音质差且波形粗；建议人声 `44100/mono/128k`，音乐类 `44100/stereo/192k`；`analyzeAudio` 返回的 `sampleRate/channels` 会用于 `metaText`（`E:853-857`），UI 可展示 |
| 5 | iOS/Android 差异 | ①iOS 蓝牙/麦克风切换与 `format:'mp3'` 支持版本差异，部分机型需回退 `aac`（扩展名 `.aac`/ADTS，`analyzeAudio` 用 ffmpeg 探测可接受）；②iOS 静音键不影响录音，但**录音会抢占音频会话**，与 `InnerAudioContext` 预览冲突 → 开始录音前 `stopAllPlayback()`（`E:3836-3839`）；③来电/微信语音会触发 `onInterruptionBegin`，需像现有逻辑一样停（`E:240-243/346-353`） |
| 6 | 权限与隐私 | 需要 `scope.record` 授权 + 后台「用户隐私保护指引」声明麦克风；编辑器已有隐私弹窗机制（`E:306-313`），但录音拒绝授权后的降级文案需新增；未声明时 iOS 直接失败 |
| 7 | 单例与页面生命周期 | `getRecorderManager()` 是全局单例，`onStop/onError` 回调可能晚于页面 `onUnload`（`E:277-295`）触发 → 回调里要判 `this.data`/是否已卸载，避免对已销毁页面 setData |
| 8 | 录音中退出/后台 | 后台录音会被系统暂停或停止；需要在 `onHide`（`E:270-275`）处理录音状态，并在 UI 明确「录音时长已保存/中断」 |
| 9 | 文件大小 | `onStop.fileSize` 可直接用于 50MB 预检（`U:16`），不要用 `fs.statSync`（部分机型 tempFilePath 没有 stat 权限）；128k×600s≈9.6MB，安全 |

**工作量**：若 v5.1 采集库已输出 `{tempFilePath,duration,fileSize,format}`，编辑器侧接入 **S（0.5 天）**；若还要做录音 UI（波形/计时/暂停/重录）+ 权限兜底，**M（1–1.5 天）**。

---

### d. 作品/导出记录 + 草稿机制现状与局限

**导出记录：没有。**

| 层面 | 现状 | 证据 |
| :--- | :--- | :--- |
| 客户端本地 | 只用两个 storage key：`audio_convert_history`（转换页）与 `NLE_DRAFT_CACHE_V1`（编辑器草稿）；编辑器导出成功**不写任何历史** | `I:869-884`、`E:31`；导出成功路径 `E:4443-4476` 无 storage 写入 |
| 客户端页面 | 结果只在 `data.result`，离开页面（`onUnload`）即丢；返回后再进是空态 | `E:277-295`（onUnload 清实例）；再进入走 `onLoad`（`E:179-252`）重建空数据（`E:191-192`） |
| 云端台账 | `converted_files` 有 `{openid,fileID,size,format:'mp3',createdAt,kind:'edit_output'}`，但**客户端没有任何查询 action**（只有 cleanup 读） | `F:207-224`、`F:137-160`；全仓无 `getMyExports/listOutputs` |
| 云端文件 | 保留 ≤24h（cleanup 每天 4:00 触发；每次最多删 100 条） | `cloudfunctions/ffmpegProbe/config.json` triggers；`F:139-142` |
| 设计稿 | 设计过本地 `audio_history_v1`（含 `type:'convert'` / `'edit'`、planBrief）与 `editor_task_v1` | `D:1437-1443` |

**机会**（价值最高的一个中等改动）：复用首页历史范式（`I:869-884`，卡片 `IW:488-503`，清空 `I:918-930`）做「作品库」：本地保存 `{fileID,fileName,format,size,sizeText,duration,createdAt,planBrief}` 最多 20 条 + 24h 过期标记 + 「继续剪辑」（用 planBrief 重建草稿） + 「试听/转发」；再补一个云函数 action `getMyExports`（按 openid 查 `converted_files`，仅返回 24h 内）作为跨设备兜底。**不需要新建集合**。

**草稿机制：单工程、单 key、7 天，可用但脆弱。**

| 维度 | 现状 | 证据 | 局限 |
| :--- | :--- | :--- | :--- |
| 触发 | 编辑态提交防抖 400ms 自动存；导入完成/继续编辑也存 | `E:416-421/902/1308/4715` | 撤销/静音等不触发保存（`E:2904-2936` 无 scheduleSaveDraft） |
| 内容 | sources（含 peaks/localPath/fileID/format/playable）、clips、tracks、selectedClipIndex、exportBitrate | `E:379-406` | 不含缩放/选区/inspector 状态/格式偏好（mp3 写死）；不含撤销栈 |
| 恢复 | 启动 `onLoad` 弹窗「恢复/丢弃」，7 天过期清除 | `E:431-468/439-442` | 只在 `onLoad`（tab 页被保留时不重查）；无手动保存/命名 |
| 容量 | `peaks` 是 `Uint8Array`（`E:394-395`），JSON 序列化后近似 7–9 字节/字节；5 源×10min ≈ 5×(12000×2)×8B ≈ 960KB | 估算；微信单 key 上限 1MB、总 10MB | 接近上限，`wx.setStorage` 失败只 `console.warn`（`E:411-413`）→ 用户以为已保存，实际丢草稿 |
| 生命周期 | 导出成功 `clearDraft()`（`E:4473`）；用户放弃/超 7 天删除 | 同上 | 导出后若用户直接离开，工程无副本（与「作品库」缺位叠加） |
| 多工程 | 只有 1 个 key | `E:31` | 第二个项目会覆盖第一个（无提示） |

建议（并入 §4 P1-3）：`draft v2 = {version, projects:[{id,name,savedAt,sources,clips,tracks,...}] }`，**peaks 不落草稿**改为恢复时按 `fileID` 重跑 `analyzeAudio`（已有云函数，无新后端），并给保存失败可见提示；同时保留「最近一次自动草稿」语义避免用户无感升级。

---

### e. 代码结构：维护成本评估与最小安全拆分

**量级与热点（本次统计）**

| 指标 | 数值 | 说明 |
| :--- | :--- | :--- |
| `E` 行数 / 字节 | 4731 / 167,931 | 单 Page 对象 |
| Page 顶层方法 | **194** 个 | 其中 wxml 事件处理函数 **87** 个（正则比对 `W` 的 `bind*/catch*`），非 handler 107 个 |
| `E` 最大区块 | 轨道/手势/声音工具 **1579–3196**（1618 行，34%） | 拖动、把手、剃刀、缩放、轨头、抽屉全在这一段 |
| 次大区块 | 预览 3311–3914（604）、片段视图 1057–1576（520）、导入 652–1052（401） | — |
| `W` 行数 | 1452（五个状态块：空态 `W:17`、上传 `W:114`、编辑 `W:132-1319`、导出中 `W:1322`、结果 `W:1340`，隐私弹窗 `W:1437`） | 编辑态单块 1188 行 |
| `CSS` 行数 / 规则块 / keyframes | 4256 / **546** / **23** | 本次 Node 统计：556 个逗号选择器中 553 唯一，重复 2 个（`.tool-action-group`、`.tool-icon-btn` 各 2 次） |
| `CSS` 章节注释 | 17 段，编号乱序重复（4→6→7→6→7→7→8→9→10） | `CSS:604/1204/2867/3177/3304/3519` |
| 云函数 | `F` 740 + `C` 841（纯函数可单测） | 结构比前端好；问题在 action 只有 6 个、无任务化 |
| 遗留物 | `cloudfunctions/audioConvert` **149MB**（node_modules 含 `@ffmpeg-installer`）、`quickstartFunctions`、`F:630-723` 的 probe/sleep/convert/encodeOnly 验证 action | `du -sh` 本次实测；`F:725-740` |

**维护成本判断**：功能增长已进入「改一处要读 1500 行」阶段；`DEV_LOG` v1.9→v5.0 的 50+ 次 UI 迭代（`L:278-309`）几乎全部落在 `E/W/CSS` 同几个大区块，且**同一功能被改了 3–5 轮**（导出浮岛 v3.8→v5.0；按钮布局 v3.4→v4.5→v5.0；折行 v2.3→v3.2→v3.8→v5.0），说明缺少稳定的 UI 组件边界，只能整段重写。再不拆，v5.2 的格式扩展/作品库/两段式都会继续叠在这 3 个文件上。

**最小安全拆分方案（4 个 Phase，每 Phase 独立可回归，不改行为）**

| Phase | 内容 | 风险 | 工作量 |
| :--- | :--- | :--- | :--- |
| **1（最安全，先做）** | 把**非 wxml handler** 的纯逻辑抽到 `miniprogram/utils/editor-*.js`：<br>① `editor-export.js`：`buildOutputName`（`E:4478`）、`calcEstimatedFileSize/calcCompressionRatio`（`E:1093-1109`）、`mapExportError/normalizeExportError` 映射表（`E:4416-4441`）、`EXPORT_FORMATS/BITRATE_OPTIONS`（`E:34-41`）；<br>② `editor-draft.js`：`serializeDraft/parseDraft/validateDraft`（`E:373-507` 的纯逻辑部分）；<br>③ `editor-timeline.js`：`calcFitScale/calcZoomScroll/zoom*` 数学 + `refreshClipData` 里的宽度计算（`E:1132-1139/1642-1760`）。<br>页面保留同名薄方法调用 → **事件绑定不变、测试文本断言不变** | 低（纯函数，可单测） | M（1–1.5 天） |
| **2** | `CSS` 按章节用 `@import` 拆成 `pages/editor/styles/{header,empty,progress,studio,timeline,inspector,export,result,modal}.wxss`，`editor.wxss` 只保留变量/基础/imports。小程序 wxss 支持 `@import`，只影响构建期；**无 JS/模板改动** | 低（样式级回归需 DevTools 目测 + `CSS` 花括号检查仍成立） | S（0.5 天） |
| **3** | 抽 2 个自定义组件：`<export-dock>`（`W:1210-1317` + `CSS:3304-3726` + 相关 data/事件）与 `<empty-state>`（`W:16-111` + `CSS:255-537`）。组件用 `properties + triggerEvent`，页面只留状态 | 中（事件/样式隔离、`editor.json` 需 `usingComponents`，测试需升级） | M（1.5–2 天） |
| **4（可选，谨慎）** | 把预览/播放（`E:3307-3914`）与 Canvas（`E:3915-4332`）抽成 behavior 混合（`Page(Object.assign({}, playbackBehavior, canvasBehavior, {...}))`）。**不建议先做**：这部分与 wx 音频实例/页面生命周期强耦合，收益低于风险 | 高 | L（2–3 天） |

> 不建议「把 editor.js 拆成多个 page 文件」——微信页面只能有一个 js；拆分只能用 utils / behavior / 组件三种形式。

**拆分对测试的影响（必须先知道）**

- 现有前端测试**直接读源码文本**断言：`scripts/editor-spike/frontend-test.js:413-422` 要求「wxml 里每个 handler 名在 editor.js 文本中出现」；`:439-446` 要求 data 字段与 `action: 'renderEdit'` 字符串出现在 editor.js。**只要 handler 还在 editor.js（Phase 1 就满足）就不破测试**；若做 Phase 3/4 把 handler 搬走，必须同步把这两个断言改成「扫 editor.js + 组件/behavior 文件」。
- 冒烟测试通过 `loadEditorPage()` require `editor.js` 并捕获 `Page(config)`（`frontend-test.js:677-683`）→ Phase 1 的 utils 抽取不改变加载方式，测试零改动；新增 utils 需补纯函数单测。
- 基线：前端 41 项 + 后端纯函数 150 项 = **191 项全过**（`B` 一），拆分后必须保持 ≥191 且 `test_pure.js` 数字不降；`B` 八 有固定回归命令块（`node --check` 10 文件 / frontend-test / test_pure / 结构检查 18 项）。
- 后端 `C` 已分离纯函数，拆分无影响；`test_actions_mock.js`（605 行，mock 云 SDK）在格式扩展/任务化时才需要改。

---

### f. 编辑器 UI/交互可优化 Top 10（结合 DEV_LOG 用户反馈历史）

| # | 问题（现状） | 证据 | 用户影响 | 建议 |
| :-- | :--- | :--- | :--- | :--- |
| 1 | **压缩面板重复且浮岛信息过载**：同一套「码率/预估体积/滑块/预设」在声音抽屉（`W:1143-1200`）与吸底浮岛（`W:1214-1279`）各实现一遍，浮岛固定吸底 + 240rpx 内边距 | `W:1143-1200/1214-1317`、`CSS:3304-3726`、`L:297`（v3.8 曾专门修过折行） | 手机上 1/3 屏被占，两处状态易不同步 | 只保留**一个**压缩面板（建议放抽屉），浮岛单行 `格式·码率·体积`；抽 `<export-dock>` 组件统一 |
| 2 | **按钮层级过多**：模式分段器（`W:199-209`）+ 辅助胶囊（`W:212-225`）+ 4 宫格动作（`W:229-246`）+ 双播放主键（`W:249-258`）+ 底部 13 项缎带（`E:1579-3196`/`L:292`） | 同上 + `L:304`（v4.5 已重构一次） | 低频功能与高频功能同权，误触 | 按使用频率分两层：高频（分割/删除/播放/导出）常驻；低频（EQ/降噪/变速/换轨）收进长按/抽屉 |
| 3 | **双时间轴认知负担**：源波形 Canvas（`W:163-176`）+ 多轨时间轴（`W:267+`）各有一条时间概念，选区和播放头在源时间轴 | `W:163-176/267-430`、`E:4182-4335`（波形手势） | 新手不知道「该在哪里剪」 | 明确角色（源波形=入出点精修，时间轴=编排），或在未进入修剪时折叠源波形；文案改为「精修入出点」 |
| 4 | **预览不等于成片**：EQ/降噪/ducking 不参与预览，变速用 `playbackRate`（变调）而非 `atempo` | `E:3706-3721/3488-3528` vs `C:678-698`；`W:261` 已写「快速模拟」 | 用户按预览判断后导出「声音不一样」→ 投诉/重导 | 折中：预览里把已生效的「导出专属处理」显式标注（如「EQ/降噪将在导出时生效」），并把「导出后试听」做成强引导；完整 WYSIWYG 不现实（端内无 FFmpeg） |
| 5 | **撤销能力不足**：无重做；快照只含 clips+selectedIndex，不含 tracks/mute/solo/轨道音量 | `E:1257-1278` vs `E:1772/1806/2904-2954` | 误删轨/误静音无法恢复 | 加 redo 栈 + 快照扩展 `{clips,tracks,selectedIndex}`（S–M，纯 bug 修复级改动） |
| 6 | **导出中无进度、不可离开**：只有 elapsed 秒数 + 固定文案 | `W:1322-1338`、`E:4376-4378` | 长导出时焦虑、切后台丢结果 | v5.2 至少：阶段文案（下载/渲染/上传）+「请勿离开」+ 失败保留工程（已有）；持久化 taskId 待两段式 |
| 7 | **无格式选择、码率说明不完整**：按钮写死「导出 MP3」；6 档码率只对 mp3 有解释，没有「格式/体积/时长上限」联动 | `W:1314`、`E:34-41`、`E:1093-1109` | 想要无损/微信更好兼容（m4a）的用户没有出口 | 见 §3a：格式 chips + 每格式上限/体积联动说明（v5.2） |
| 8 | **空态信息重复、C 位不唯一**：规格胶囊（`W:54-56`）+ 9 个格式标签（`W:59-69`）+ 3 步指南（`W:79-103`）+ iOS 提示（`W:105-108`）四段都在讲同一件事 | `W:33-109` | 首屏下面全是字，主 CTA 被稀释 | 折叠指南（点开看），首屏只留：主按钮 + 一行规格 + 「录音」第二入口 |
| 9 | **轨头入口散落 + 死功能**：mute/ducking 在轨头（`W:346-349`），solo 无入口（`E:2916`），`pan` 死字段（`U:1136` vs `C:499-504`） | 同左 | 找不到功能 / 点了没反应 | 轨头长按进「轨道菜单」（静音/独奏/避让/音量/删除）；删除 solo 死代码或补 UI（二选一，别留半成品） |
| 10 | **错误码文案不全、失败提示泛化**：`OUTPUT_TOO_LARGE/UNSUPPORTED_FORMAT/EXPORT_LIMIT` 无映射（`E:4416-4429` vs `F:367-369`），未知错误直接展示 `errMsg`（`E:4432-4441`） | 同左 | 失败时用户不知道该改什么 | 建「错误码→可行动建议」表（缩短时长/降码率/换格式/稍后重试），与格式扩展同批做 |

> 附加（不进 Top10 但建议顺手）：`W:1333` 导出中文案写死 MP3；`E:4478-4483` 输出名固定 `_剪辑.mp3`；`L:278-309` 记录的多轮「折行/排版」问题本质是**没有组件化 + 文案写死**，与 e 的拆分方案同源。

---

## 4. 候选更新项池（12 项）

> 价值=用户可感知价值（1–5）；工作量=单人含自测；「本轮切片」指 v5.1（采集库）窗口；「v5.2」为下一步编辑器/云端版本。

| # | 候选 | 价值 | 工作量 | 风险 | 涉及文件 | v5.1 切片? | v5.2 适合? |
| :-- | :--- | :--: | :--: | :--- | :--- | :--: | :--: |
| P0-1 | **导出可靠性加固**：服务端时间预算/渲染前体积预估/明确超时码 + 客户端看门狗 + `timings` 落库 | 4 | S–M | 低（增量、可灰度） | `F:315-399`、`E:4337-4413` | 否 | **是（P0）** |
| P0-2 | **存储泄漏修复**：`edit_sources/` 补台账（analyze 后记录 kind=edit_source）+ cleanup 覆盖 + 孤儿成片对账 | 3 | S | 低（只加记录/清理） | `F:137-160/207-224/235-306`、`E:765-770` | 否 | **是（P0 附带）** |
| P1-1 | **导出格式扩展 MP3/WAV/M4A + 清晰码率说明** | 5 | M | 中（云函数回归 + 限额矩阵 + iOS 矩阵 + 测试断言改） | `E/W/CSS/U/F/C` 共 8 文件（见 §3a） | **不建议**（见 §5.2） | **是（P1）** |
| P1-2 | **作品库/导出历史**：本地 20 条 + 24h 过期标记 + 继续剪辑 + 云 `getMyExports` | 4 | M | 低–中（storage 迁移、openid 查询权限） | `E:4443-4476`、`W:1340-1430`、`I:869-884`（范式）、`F`（新 action） | 否 | **是（P1）** |
| P1-3 | **草稿 v2**：多工程 + 列表 + 保存失败可见 + peaks 不落盘（恢复时重分析） | 4 | M | 中（旧草稿迁移、1MB 限制） | `E:373-507`、新 `utils/editor-draft.js`、`W` 新增列表 | 否 | **是（P2）** |
| P1-4 | **撤销/重做完整化**：redo + 快照含 tracks/轨道属性 | 4 | S–M | 低（纯前端） | `E:1257-1281/1766-1834/2904-2954`、`W:221-224` | **是**（低风险、独立） | 是 |
| P1-5 | **录音接入编辑器**（依赖 v5.1 采集库产物） | 5 | S（接入）/ M（含录音 UI） | 中（权限/平台差异/临时文件） | `E:652-816/1836-1885`、`W:46-51`、`U:178-204` | **是（v5.1 主线）** | 视 v5.1 结果 |
| P2-1 | **UI Top10 中的 1/2/8**（导出浮岛统一、层级收敛、空态折叠） | 3 | M | 中（纯视觉回归，依赖组件化） | `W/CSS` + Phase 3 组件 | 否 | 是（P2） |
| P2-2 | **预览/成片一致性提示 + 导出后 A/B 试听** | 3 | S–M | 低 | `E:3307-3721/4443-4476`、`W:261/1376-1425` | 否 | 是（P2） |
| P2-3 | **错误码→可行动建议表**（含格式扩展新增码） | 3 | S | 极低 | `E:4416-4441`、`F:359-369` | 否 | 是（随 P1-1） |
| P3-1 | **两段式任务化** create/run/get + edit_tasks + 幂等 + 轮询 + 清理 | 3–4 | L | 高（3 条新云端路径、集合权限、回归面最大） | `F`（新 action/集合）、`E:4337-4476`、`scripts/editor-spike/test_actions_mock.js` | 否 | 否（v5.3，需先有数据） |
| P3-2 | **编辑器拆分 Phase 1+2**（utils 抽取 + wxss `@import`） | 3（维护性） | M | 低–中（测试文本断言） | `E:1093-1109/416-507/1642-1760/4416-4483`、`U` 新文件、`CSS`、`frontend-test.js:413-446` | 否 | 是（可与 P1 并行） |
| P3-3 | **遗留清理**：`cloudfunctions/audioConvert`（149MB）与 `quickstartFunctions` 归档、`F:606-723` 验证 action 收口、solo/pan 死代码 | 2 | S | 低 | 仓库级 | 否 | 是（杂项日） |
| P3-4 | **上传票据/归属校验**（防他人 fileID 复用） | 2 | M | 中（涉及上传链路） | `F:725-740`、`E:765-770`、`U:207-212`；设计 `D:1388-1398` | 否 | 否（v5.3 合规项） |

---

## 5. V5.2 排序建议 + v5.1 小切片评估

### 5.1 v5.2（编辑器/云端方向）推荐 5 项，按顺序

| 序 | 项 | 为什么排这里 | 依赖 |
| :-- | :--- | :--- | :--- |
| **1** | **导出可靠性加固（P0-1）+ 存储泄漏修复（P0-2）** | 成本最低、直接降低「导出失败/重复扣资源」；为格式扩展/作品库提供干净的地基（明确错误码、timings、台账）。格式扩展会放大失败面（WAV 体积/ M4A 耗时），不先加固等于把风险叠上去 | 无 |
| **2** | **导出格式扩展 MP3/WAV/M4A + 码率说明（P1-1）** | 用户可感知价值最高（5/5）：可导出无损/微信兼容格式 + 明确「多少码率=多少体积/多长上限」；编码器已具备（`F:24-31`），主要是矩阵与 UI | 1（错误码表）；云函数部署 |
| **3** | **作品库/导出历史（P1-2）** | 把现有 24h 云文件 + 台账变成可回访的作品；与 2 共用结果页/结果对象，一起做省一次 UI 重构；也补上「导出后离开页面=全丢」的体验断点 | 2（结果对象带 format）；`converted_files` 已有数据 |
| **4** | **撤销/重做完整化（P1-4）** | 低成本高满意度，修的是真实缺陷（加轨/静音/轨道音量无法撤销、无重做）；与其它项无耦合，可并行插队 | 无 |
| **5** | **编辑器拆分 Phase 1+2（P3-2）+ 错误码表（P2-3）** | 让 2/3/4 的改动不再堆在 4731 行单文件；Phase 1 只抽非 handler 纯函数，测试零破坏；Phase 2 纯样式拆分。作为持续项与 1–4 并行 | 无（建议在 1–4 之前起步） |

**暂缓**：两段式任务化（P3-1，等真实超时数据）；上传票据（P3-4，合规项可随发布窗口另排）；UI 大改 Top10 的 1/2/8（等组件化后做，否则又是一轮整段重写）。

**建议打包方式**：v5.2 = 「导出闭环」一个主题（1+2+3+4）≈ 3–4 人日开发 + 1–1.5 人日测试/回归，第三项可独立发小版；编辑器拆分（5）作为同一分支内的前置重构小提交，控制单次 PR 体积。

### 5.2 「导出格式扩展（mp3/wav/m4a + 清晰码率说明）」作为 v5.1 小切片的可行性

**结论：技术上可行，但不算「小切片」——不建议塞进 v5.1。**

理由（对抗性自检）：

1. **改动面跨端 8 个文件**：`E/W/CSS/U/F/C` + 测试（`scripts/editor-spike/test_pure.js:456-457` 现有断言会直接失败）。按 AGENTS.md 3.1「≥3 个非测试源文件 + 公共行为/协议变更」= **大型变更**，需要分支/回归/（若发布）提审窗口；v5.1 的主线是采集库（前端 + 隐私 + 平台差异已经很多），两件事叠加会把回归面乘起来。
2. **必须重新部署云函数**：v5.1 若按约定只改前端，格式扩展会打破「v5.1 不动云端」的边界；云函数部署后 mp3 主链路必须先全量回归（B 的固定命令块 + 真机/工具导出）。
3. **限额矩阵是产品决策**：WAV 4min/FLAC 7min/M4A 8min 与「成片 10 分钟」的既有承诺冲突，需要在 UI 上解释（`D:1483-1491` 是设计建议，未拍板）；同时 10 分钟界碑（`W:410-422`）要随格式变化，属于交互变更。
4. **iOS 矩阵**：加 FLAC 会引入「导出成功但 iPhone 不能试听」的新引导分支（`IW:423-428` 范式），是新的用户误解点；只做 mp3/wav/m4a 可规避。
5. **若用户强烈要求 v5.1 内先给一点无损能力**：最小可行切口 = **只加 WAV**（S，0.5–1 天）：`C:40/407-411` 加 wav、`F:327/374/385` 用 format 后缀、`E:4346` 读 `exportFormat`、浮岛加 2 个格式 chips、WAV 上限 4min + 渲染前体积预估、`mapExportError` 补 2 个码 —— 仍是「1 次云函数部署 + 全链路回归」，建议放在 v5.1 **收尾后**作为独立小版（v5.1.1），不要与采集库同分支同发布。

**具体改动清单**：见 §3a 的 21 行表格（服务端 1–10、客户端 11–17、测试 18–19、文档/部署 20–21）。按该清单执行时，建议顺序：`C`（纯函数+单测先绿）→ `F`（输出/台账/预估）→ 本地 mock/docker 链路（本机 docker 不可用时仅 `test_pure` + `test_actions_mock`）→ 前端 UI → 全量回归 → 部署 → 真机抽查 WAV/M4A 各 1 条。

---

## 6. 验证、限制与未执行项

**本次实际执行的只读检查**

| 命令/方法 | 结果 |
| :--- | :--- |
| `wc -l` 12 个相关文件 | 见 §0 表格（`E` 4731、`W` 1452、`CSS` 4256、`U` 1270、`F` 740、`C` 841） |
| `du -sh cloudfunctions/* miniprogram` | `audioConvert` 149M、`ffmpegProbe` 117M、`quickstartFunctions` 16K、`miniprogram` 528K |
| `file cloudfunctions/ffmpegProbe/bin/ffmpeg` | ELF 64-bit x86-64 statically linked（Linux，本机不可直接执行） |
| Node 脚本①（wxss 规则统计） | 546 规则块 / 553 选择器 / 553 唯一 / 23 keyframes；重复选择器 2 个 |
| Node 脚本②（wxml handler vs editor.js 方法 diff） | wxml 事件处理函数 87 个；`E` 顶层方法 194 个；非 handler 107 个 |
| `grep`（recorder/历史/storage/mp3/ducking/solo/offset 等） | 见各节证据；确认无 `RecorderManager`、无编辑器导出历史、无 `getEditTask` 类 action |
| 读取证据文档 | `K` 全文、`D` §9.4/§10/§11.2/§13.3/§19、`L` §2–§9 尾部、`B` 一/二/七/八 |

**未执行项（环境受限，非代码失败）**

| 项 | 原因 | 影响 |
| :--- | :--- | :--- |
| Docker 容器化实测（`scripts/editor-spike/run.sh`） | 本机 docker daemon 未运行（`B` 二：`Cannot connect to the Docker daemon`） | 无法在本轮重测 ffmpeg 滤波/编码耗时；相关数字引用 `D`/`L` 既有实测 |
| 云函数部署与真机导出 | 只读侦察约束 | 未验证线上 timeout 实际值、未验证 wav/m4a 假设 |
| DevTools CLI 编译/预览 | 只读约束 + IDE 未启动（`B` 六） | WXML/WXSS 改动可行性依赖既有基线（`B` 静态检查 18/18 过） |
| 真机 iOS/Android 录音、导出、iOS 可播矩阵 | 无设备 | §3c/§3a 的 iOS 结论引用仓库既有声明（`L:174`、`I:563-569`） |

**关键不确定性（需要后续用真机/线上数据收敛）**

1. 5 源 × 600s × 多效果的实际 P95 耗时（决定两段式是否必要、M4A 是否可放开 10min）；
2. `wx.cloud.callFunction` 在切后台/弱网下的真实失败率（ISSUE-019 仍「待验证」，`L:237`）；
3. 微信本地存储单 key 上限对「多源草稿含 peaks」的实际失败阈值（本轮为估算：≈960KB/5 源×10min）；
4. WAV/FLAC 在 `cloud.uploadFile` 50MB 上限下的真实成功率（`D:1491` 标注「待实测」）；
5. 录音机型差异（`format:'mp3'` 回退 aac 的具体机型清单）。

---

## 附录 A｜关键坐标速查

| 主题 | 坐标 |
| :--- | :--- |
| 状态机 / 常量 | `E:9-41`；limits `U:15-23` |
| 导入链 | `E:652-975`（`importFiles` E:732、`addSourceFromAnalysis` E:818） |
| 数据模型 | `E:839-871`、`U:320-338`、`E:115-118/1776-1784` |
| 轨道/声音工具 | `E:1577-3196`；服务端多轨混音 `C:709-779` |
| 预览播放 | `E:3307-3914`（多轨主时钟 E:3427-3542） |
| 波形/手势 | `E:3915-4332` |
| 导出链 | 客户端 `E:4337-4491`；服务端 `F:309-399`；纯函数 `C:582-794` |
| 结果/转发 | `E:4496-4730` |
| 草稿 | `E:373-542`；key `E:31` |
| 导出格式硬编码 | `E:4346/4482`、`W:1314`、`C:40/407-411`、`F:327/374/385/210` |
| 云端清理/台账 | `F:137-160/207-224`；触发器 `cloudfunctions/ffmpegProbe/config.json` |
| 设计依据 | `D:1231-1323`（两段式）、`D:1369-1459`（集合/生命周期）、`D:1479-1510`（格式×时长矩阵）、`D:1911-1922`（v2 偏差） |
| 测试基线 | `B` 一（191 项）、`B` 八（回归命令块）；`scripts/editor-spike/{test_pure,frontend-test,test_actions_mock,test_integration}.js` |
| 反馈历史 | `L:278-309`（v1.9→v5.0 UI 迭代）、`L:234/237/238/239`（ISSUE-016/019/020/021） |
