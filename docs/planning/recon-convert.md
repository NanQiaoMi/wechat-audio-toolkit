# 格式转换链路侦察报告（recon-convert）

> **任务**：task-2「侦察：格式转换链路（index/settings/历史/存储）现状与更新机会」
> **执行**：teammate `auditor-convert`（产品/前端侦察）
> **基线**：git `d55310f`（chore: baseline v5.0 snapshot 2026-10-31），分支 `feature/v5.1-audio-capture-library`
> **方法**：只读代码审阅（read/grep）+ 文档比对；未修改代码/配置，未运行构建与真机验证，未做 git 写操作（只有 `git log`/`git status` 只读查询）。
> **证据约定**：仓库内结论一律标注 `文件:行号`。平台能力（微信 API/存储限额等）仓库内无代码证据的，集中在 §5 / 附录 B 标注「待官方文档或真机复核」，不混入代码结论。
> **唯一产出**：本文件。
>
> **⚠️ 快照说明（2026-10-31 03:56 复核）**：本报告证据行号以基线 `d55310f` 为准。侦察期间工作树已被 Lead/其他 teammate 推进（`git status` 显示 `miniprogram/app.json`、`pages/index/*`、`pages/editor/*`、`pages/settings/*` 已修改；新增 `miniprogram/pages/record/`、`docs/NEXT_UPDATE_PLAN.md`）。因此：① 本报告用于**基线缺口审计与验收对照**，不是对当前实现的描述；② 落地前请用当前工作树文件复核行号与结论；③ 若当前实现已覆盖某项建议，以实际代码为准并回写差异。

---

## 0. 结论先行（TL;DR）

1. **转换主链路是"单文件同步"模型**：`chooseMessageFile({count:1})` → 上传云存储 → 一次 `wx.cloud.callFunction('ffmpegProbe', {action:convertFile})` → 结果页/本地历史。没有任务队列、没有取消、没有进度百分比、没有断点恢复（`pages/index/index.js:262-331, 475-615`）。
2. **历史记录只是"本地 20 条分享入口"**：`audio_convert_history` 仅存展示字段、按 `HH:mm` 记时间、无 `createdAt/expiresAt`，只能分享、不能试听/重试/单条删除；云端 24h 后文件被清理，本地记录仍留着死 `fileID`，只有点分享失败才提示过期（`index.js:593-603, 869-884, 805-827`；云函数 `cloudfunctions/ffmpegProbe/index.js:137-160`）。
3. **编辑器导出完全不沉淀**：导出成功只存在页面内存态，`handleExportSuccess` 后无任何 storage 写入（`pages/editor/editor.js:4443-4476`；全页唯一 `setStorage` 是草稿 `NLE_DRAFT_CACHE_V1`，`editor.js:31, 407`）。因此"统一作品库"需要新建存储层与页面，而不是改造现有历史。
4. **导入方式只有聊天文件 + 编辑器多选（≤5）**；**全项目没有任何 `RecorderManager` 调用**，录音导入是纯新增能力（`app.json:2-6`、`editor.js:652-670, 664`；grep `RecorderManager` 仅命中 docs）。
5. **分享只有"音频文件转发"（`wx.shareFileMessage`）**；**全项目 0 处 `onShareAppMessage` / `onShareTimeline` / `showShareMenu` / `onAddToFavorites`**，小程序卡片与朋友圈分享均为空白（grep 证据见 §2.d）。
6. **编辑器导出格式被硬编码为 mp3**：前端 `format:'mp3'`（`editor.js:4343-4348`）、UI「导出 MP3」（`editor.wxml:1314`）、后端输出路径/云路径/文件名/台账全为 mp3（`ffmpegProbe/index.js:327, 374, 385, 207-217`）；设计与 PRD 原本规划 mp3/wav/flac（`MUSIC_EDITOR_DESIGN.md:478, 547`；`PRD.md:315`）。
7. **文案/合规存在可见缺陷**：页脚"今日免费额度 X/5"在 `QUOTA_ENFORCED=false` 下永远不会显示（死代码，`index.wxml:463-465` + `index.js:96, 579` + `ffmpegProbe/index.js:17, 594`）；"24 小时物理销毁"承诺强于实际清理逻辑（失败源文件会泄漏、清理每天最多 100 条，`ffmpegProbe/index.js:137-160, 580-582` + `index.js:509`）；"保存/转发文件"在手机端并不能保存（`index.js:745-800` + `index.wxml:439`，与 `DEV_LOG.md:221` 的 ISSUE-003 决策冲突）；隐私弹窗因 `app.json` 缺 `__usePrivacyCheck__` 实际不会触发（`app.json:1-17`、`DEV_LOG.md:53`、`docs/legal/PRIVACY_GUIDE_SETUP.md:26,36`）。
8. **推荐 v5.1 主题**：「作品库（沉淀）+ 录音导入（采集）+ 好友分享卡片（传播）」组合，前置一项"合规/文案一致性修复"作为发版门禁。理由：作品库与录音/卡片都不需要改云端接口，复用现有上传→`convertFile`/`analyzeAudio` 链路；批量转换建议作为轻量串行队列（≤3）或顺延 v5.2。

---

## 1. 现状基线

### 1.1 路由与页面（app.json）

| 页面 | 路由 | 现状 | 证据 |
| :--- | :--- | :--- | :--- |
| 首页（格式转换） | `pages/index/index` | 933 行 js + 525 行 wxml；导入/参数/转换/结果/历史弹层/隐私弹窗全部单页内 | `app.json:3`、`index.js:32-933`、`index.wxml:1-525` |
| 编辑器 | `pages/editor/editor` | 4731 行 js；多轨剪辑/导出 mp3 | `app.json:4`、`editor.js:1-4731` |
| 设置 | `pages/settings/settings` | 仅 69 行 js，5 个入口 + 2 个数据操作 | `app.json:5`、`settings.js:1-69` |
| 任务页 / 结果页 / 历史页 | `pages/task|result|history` | **不存在**（PRD 规划过） | `app.json:2-6` vs `PRD.md:136-142` |
| tabBar | — | **不存在**；首页用横幅跳编辑器 | `app.json:1-17`、`index.wxml:30-39` |
| 隐私开关 | — | **缺失 `__usePrivacyCheck__`**（临时移除未恢复） | `app.json:1-17`、`DEV_LOG.md:53`、`PRIVACY_GUIDE_SETUP.md:26,44` |

> 文档漂移：`README.md:3` 与 `DEV_LOG.md:64` 均称"tabBar 双入口"，实际 `app.json` 无 tabBar，只有首页横幅；`PRD.md:136-142` 规划的 task/result/history 页全部被单页内联替代。

### 1.2 index 页状态机（代码实际）

状态枚举注释：`// 状态流转: IDLE | UPLOADING | TRANSCODING | SUCCESS`（`index.js:34-35`）。

| 状态 | 进入位置 | 退出/后续 | UI 表现 | 缺口 |
| :--- | :--- | :--- | :--- | :--- |
| `IDLE` | 初始 `index.js:35`；选文件后 `302`；失败回退 `608`；重置 `852` | 点「开始转换」→ UPLOADING | 大按钮根据是否可压缩动态改文案 `index.wxml:312-319` | 无 `ERROR/CANCELLED`；失败即回 IDLE，无重试态 |
| `UPLOADING` | `index.js:503-506` | 上传成功 → TRANSCODING | 3 步进度条第 1 步激活 `index.wxml:331-347` | 无上传百分比、无取消；`wx.cloud.uploadFile` 未传 `onProgressUpdate` |
| `TRANSCODING` | `index.js:521-524` | 云函数返回成功 → SUCCESS；异常 → IDLE | 第 2 步激活 | 无进度/无超时提示/无取消；云函数是同步调用，最长 55s |
| `SUCCESS` | `index.js:571-584` | 再转一首 `resetAll` `index.js:849-864` | 结果卡 `index.wxml:351-454` | 结果只存在内存；离开页面即丢（无持久化） |

**一次性"两段式"动作**（不在状态机内，但影响体验）：结果文件预下载 `prepareResultTempFile`（`index.js:683-705`）、历史文件下载缓存 `historyTempPaths`（`index.js:107, 805-827`）。

### 1.3 index data 字段分组

| 分组 | 关键字段 | 证据 | 备注 |
| :--- | :--- | :--- | :--- |
| 状态 | `status/statusText` | `index.js:34-36` | 4 态，无错误态 |
| 源文件 | `sourceFile{path,name,size,sizeText,extName,extLower}`、`sourcePlayable`、`sourceDuration/CurrentTime(+Text)` | `index.js:39-46, 292-301` | 仅当前单文件；全量替换式 |
| 目标格式 | `formats[6]`、`targetFormat` | `index.js:49-57` | mp3/wav/m4a/aac/flac/ogg |
| 压缩参数 | `compressionOptionsList`、`compressionIndex=3`、`options{bitrate,sampleRate,channels}`、`estimatedSizeText`、`savedRatioText` | `index.js:8-15, 60-80` | 码率 6 档；采样率 3 选项；声道 1/2 |
| 结果 | `convertResult{fileID,downloadUrl,fileName,targetFormat,targetSize,targetSizeText,savedRatio,duration,costSeconds}`、`resultTempFilePath`、`targetPlayable`、`targetPlayError`、`filePreparing` | `index.js:82-92, 551-561` | 结果只存内存 |
| 历史/额度 | `showHistoryModal`、`historyList`、`quotaUsed` | `index.js:94-100` | `quotaUsed` 永远 null（见 §2.f-1） |
| 隐私 | `showPrivacy` | `index.js:98-100` | 自定义 modal，非组件 |
| 实例 | `sourceAudioCtx`、`targetAudioCtx`、`historyTempPaths` | `index.js:103-107` | 页面级单例 |

### 1.4 转换主链路时序（成功路径）

| # | 步骤 | 代码 | 说明 |
| :--- | :--- | :--- | :--- |
| 1 | 会话选文件（单文件） | `index.js:262-331` | `count:1`、`type:'file'`、扩展名白名单含 amr/wma/ape 不含 aiff |
| 2 | 前端校验 | `index.js:272-290` | >50MB 拦截；按扩展名判 `sourcePlayable`（仅 mp3/aac/m4a/wav） |
| 3 | 点开始转换 | `index.js:475-499` | 再次 50MB 校验；已知时长时按 `FORMAT_LIMIT_SEC` 预检 |
| 4 | 上传云存储 | `index.js:503-514` | `wx.cloud.uploadFile` → `temp_audios/{ts}_{rand}.{ext}` |
| 5 | 云函数转码 | `index.js:521-539`；`ffmpegProbe/index.js:489-604` | 同步 `callFunction`，云端下载→按格式 ffmpeg→上传→返回结构 |
| 6 | 结果处理 | `index.js:541-590` | 计算瘦身率、按平台判 `targetPlayable`、预下载结果文件 |
| 7 | 写本地历史 | `index.js:592-603` | `unshift` + 上限 20 条 |
| 8 | 结果操作 | `index.js:620-844` | 试听、转发文件 `shareFileMessage`、PC `saveFileToDisk`、复制链接 |

云端关键行为（`ffmpegProbe/index.js:489-604`）：

- 参数白名单：目标格式 `24-31`，码率 `501`，采样率 `502`，声道 `503`；
- 配额开关：`QUOTA_ENFORCED=false` 时不拦截、返回 `quota:null`（`17, 507-510, 576-577, 594`）；
- 输入上限 50MB（`35, 523`）、按输出格式的时长上限（`34, 526-532`）；
- 输出落 `converted_audios/`（`549`），写 `converted_files` 台账（`578, 126-135`）供每天 04:00 定时清理（`config.json` triggers，`index.js:137-160`）；
- 成功后删源（`580-582`）；**失败路径不删源**（见 §2.f-3）。

### 1.5 历史记录 storage 结构（`audio_convert_history`）

写入：`index.js:876-884`；读取：`index.js:869-874`；清空：`index.js:918-930`（设置页也清，`settings.js:40-51`）。当前结构：

```json
{
  "id": 1710000000000,
  "fileName": "源文件名.flac",
  "targetFileName": "源文件名_ab12.mp3",
  "sourceExt": "FLAC",
  "targetFormat": "MP3",
  "targetSizeText": "1.2 MB",
  "fileID": "cloud://...",
  "downloadUrl": "https://...临时链接",
  "time": "12:34"
}
```

| 字段 | 来源 | 问题 |
| :--- | :--- | :--- |
| `id` | `Date.now()`（`index.js:594`） | 批量场景同毫秒会冲突；无前导时间语义之外的用途 |
| `fileName/targetFileName/sourceExt/targetFormat` | `index.js:595-598` | 仅展示；无 `kind`（转换/剪辑/录音）区分 |
| `targetSizeText` | `index.js:599` | 只有文本，无字节数；无法排序/统计 |
| `fileID` | `index.js:600` | 云端 24h 后清理，本地不感知 |
| `downloadUrl` | `index.js:601` | **临时 URL（约 10min 有效，`CLIENT_CAPABILITIES.md:487`）被持久化**，违反 `PRD.md:270`「不记录敏感 URL」 |
| `time` | `index.js:602` | 只有 `HH:mm`，**无 `createdAt/expiresAt`**，无法实现 24h 过期标记（`PRD.md:178` 要求） |
| — | — | 无 `duration/bitrate/sampleRate/channels/status/safetyStatus`，与 `TASK_PLAN.md:317-321`、`PRD.md:176` 定义不一致 |
| 容量 | `index.js:880` | 上限 20 条；无迁移/版本字段 |

### 1.6 错误处理矩阵（index 转换链路）

| 场景 | 触发位置 | 当前行为 | 缺口 |
| :--- | :--- | :--- | :--- |
| 用户取消选文件 | `index.js:316-329` | 静默（不 toast） | 符合预期 |
| 隐私协议未声明 | `index.js:316-325` | 弹窗贴出开发者级长文案（"请在微信公众平台 → 设置 → 服务内容声明…"） | 终端用户不可操作、文案泄露实现细节 |
| 选文件其它失败 | `index.js:326-328` | `showToast('选择文件失败')` | 无错误码/无重试/无引导 |
| >50MB | 选文件时 `index.js:272-281`；开始时 `484-488` | 两次拦截，modal 提示 50MB | 逻辑重复；无"如何压缩/拆分"的可操作入口 |
| 时长超格式建议 | `index.js:490-499` | 已知时长才预检；文案建议改用 MP3/WAV/FLAC | 不可播源（flac/ogg/amr/ape/wma）时长为 0，预检被绕过，见 §2.f-6 |
| 上传/云函数/转码失败 | `index.js:606-614` | 统一 catch：状态回 IDLE + `wx.showModal` 展示 `err.message` | 无错误码分流（`QUOTA_EXCEEDED/TIMEOUT/UNSUPPORTED_FORMAT/…` 均已定义于 `PRD.md:281`/`TASK_PLAN.md:281` 但前端未消费）；无重试按钮；未区分网络/云函数未部署/权限 |
| 结果播放失败 | `index.js:224-234` | 自动回退本地临时文件；仍失败仅 `console.warn` | 无面向用户的兜底提示（只有 `targetPlayError` 布尔，wxml 未展示） |
| 历史文件过期 | `index.js:820-826` | 分享时下载失败才弹"文件已过期" | 事前无过期标记；正常浏览不提示；也不能重新转换 |
| 页面卸载/切后台 | `index.js:150-156` | 只停/销毁播放器；转换请求不取消、结果丢失 | 无 taskId 持久化/无恢复（`PRD.md:385-390` 规划过） |

### 1.7 隐私弹窗逻辑

| 环节 | 代码 | 说明/问题 |
| :--- | :--- | :--- |
| 总开关 | `app.json:1-17` 无 `__usePrivacyCheck__` | **开关未恢复 → `wx.onNeedPrivacyAuthorization` 不触发 → 自定义弹窗是死代码**（`DEV_LOG.md:53` 临时移除，`PRIVACY_GUIDE_SETUP.md:26,44-45` 要求提审前恢复） |
| 注册监听 | `index.js:115-121` | `wx.onNeedPrivacyAuthorization` 注册回调，置 `showPrivacy:true` |
| 弹窗 UI | `index.wxml:509-523` | 标题/说明/查看隐私政策/不同意/同意并继续（按钮 id `agree-btn`/`disagree-btn`） |
| 同意/拒绝 | `index.js:123-138` | 通过 `privacyResolve({buttonId,event})` 回传；拒绝仅 toast「未同意隐私政策将无法选择音频」 |
| 打开隐私政策 | `index.js:140-148` | `wx.openPrivacyContract` 失败提示「请先在后台配置隐私保护指引」（**面向用户的开发者文案**） |
| 编辑器重复实现 | `editor.js:303-334`；`editor.wxml` 隐私弹窗 | 与首页逻辑重复；无共享组件；`onUnload` 未注销监听 |
| 设置页 | `settings.js:6-14`；`settings.wxml:12` | 只有"隐私保护指引"入口，无同意状态/授权管理 |

### 1.8 settings 页能力与缺口

能力（`settings.js:1-69`、`settings.wxml:1-24`）：服务说明（50MB/不限次数/24h/时长建议）、隐私指引、用户协议（modal 文本）、版权投诉（modal 文本）、关于（modal 文本）、清空历史、清理本机缓存、版本号。

| 缺口 | 证据 | 影响 |
| :--- | :--- | :--- |
| 版本号硬编码 `0.1.0`，与实现 v5.0 不符 | `settings.js:3, 35`、`DEV_LOG.md:309` | 用户/审核看到过期版本信息 |
| 无"意见反馈/客服"可点击入口（只有 modal 里写"通过小程序客服提交"） | `settings.js:24-30`、`settings.wxml:10-16`；全项目无 `open-type="contact"`（grep 0） | `PRD.md:307` FR-18、`PRD.md:274-275` FR-13 验收「投诉入口可触达」不成立 |
| 清缓存 `wx.clearStorageSync()` 会连未导出的剪辑草稿一起清掉 | `settings.js:60` + `editor.js:31, 373-414` | 用户可能丢失工程草稿，且确认文案未说明 |
| 清历史后首页历史角标/列表不刷新（首页无 `onShow`，只在 `onLoad` 读一次） | `index.js:106-112, 907-910` + `settings.js:46` | 返回首页仍显示旧条数，直到重新打开历史弹层 |
| 无作品库/存储用量/额度真实状态 | `settings.wxml:1-24` | "不限次数"与首页 quota 残留代码互相矛盾（见 §2.f-1） |
| 协议为硬编码 modal 文本，非可分享/可留存文档页 | `settings.js:16-38` | 合规材料可追溯性弱 |
| 无隐私授权状态/隐私指引配置自检 | `settings.js:6-14` | 真机失败时用户无从自查 |

### 1.9 编辑器与转换链路交叉现状（b/c/d/e 的公共前提）

| 事实 | 证据 | 对本次规划的意义 |
| :--- | :--- | :--- |
| 编辑器已支持**多选串行导入**（≤5，逐项 upload→analyzeAudio→失败重试） | `editor.js:652-670, 732-816`、`editor-utils.js:15-19` | 批量转换可直接复用该"队列+逐项进度+失败收集"模式 |
| 素材上限：单文件 50MB、5 源、40 片段、成片 10min | `editor-utils.js:16-19` | 录音/批量参数可对齐 |
| 导出成功后**无任何 storage 落库**，只存在 `data.result` | `editor.js:4443-4476`；全页仅草稿写入 `editor.js:407` | 作品库必须新增存储层；编辑器要加"导出入库" |
| 导出结果文件在云端 `edited_audios/`，写 `converted_files`（kind=edit_output），由同一 04:00 定时任务清理 | `ffmpegProbe/index.js:207-217, 309-400`；`config.json` | 作品库需要 24h 过期语义；编辑产物已在清理范围内 |
| 草稿 storage `NLE_DRAFT_CACHE_V1`，7 天过期，导出成功清除 | `editor.js:31, 407-414, 431-459, 4473` | 作品库不能复用草稿 key；清缓存要保护 |
| 编辑器无小程序卡片分享，只有文件 `shareFileMessage` | `editor.js:4661-4692`、`editor.wxml:1409-1414` | 分享卡片需补两页 |

### 1.10 云函数接口清单与限额（ffmpegProbe）

| action | 用途 | 现状 | 证据 |
| :--- | :--- | :--- | :--- |
| `convertFile`（默认） | 单文件转换 | 同步、单文件、55s ffmpeg 预算 | `index.js:489-604, 725-739` |
| `analyzeAudio` | 编辑导入分析波形/时长 | 单文件 | `ffmpegProbe/index.js:235-308` |
| `renderEdit` | 多轨剪辑导出 | 输出固定 mp3；≤10min；输出 ≤50MB | `ffmpegProbe/index.js:309-402` |
| `cleanup`/Timer | 04:00 清理 `converted_files` 中 24h 前记录 | 单次最多 100 条 | `ffmpegProbe/index.js:137-160`、`config.json` |
| `probe/sleep/convert/encodeOnly` | 技术验证遗留 action | 保留 | `ffmpegProbe/index.js:630-723, 729-731` |
| 配额集合 `quota` | 5 次/日 | 开关关闭，不写不读 | `ffmpegProbe/index.js:15-17, 100-124, 507-510` |

限额常量：`FORMAT_LIMIT_SEC = { mp3:1200, wav:1800, flac:1800, m4a/aac/ogg:600 }`（`ffmpegProbe/index.js:34`，前端重复一份于 `index.js:5`）；输入 50MB（`35`）；输出 100MB 硬顶（`546`），编辑器输出 50MB（`editor-core` 常量，`editor.js:1205-1208`）。

**清理/留存风险（影响"24h 销毁"文案）**：

1. 失败转换的源文件不会删除：客户端上传到 `temp_audios/`（`index.js:509`），云函数只在成功末尾 `autoCleanSource`（`ffmpegProbe/index.js:580-582`）；失败/提前 return 路径不删源，而 cleanup 只扫 `converted_files` 集合（`137-160`）→ 失败源文件可能长期残留。
2. cleanup 每天只处理 100 条（`142`），高用量日会顺延到次日 → 实际保留可能 >24h。
3. 前端页脚/历史/结果卡均写死"24 小时销毁"（`index.wxml:460, 477`；`editor.wxml:1427`），与上述实现不完全一致，属隐私承诺风险。

### 1.11 文档 vs 实现偏差（摘要）

| 主题 | 文档口径 | 代码实际 | 证据 |
| :--- | :--- | :--- | :--- |
| 页面结构 | task/result/history 三页 | 单页内联 + 历史弹层 | `PRD.md:136-142` vs `app.json:2-6` |
| 入口形态 | tabBar 双入口 | 无 tabBar，横幅跳转 | `README.md:3`、`DEV_LOG.md:64` vs `app.json:1-17`、`index.wxml:30-39` |
| 录音导入 | P1，首页次级入口"录音转格式" | 未实现 | `PRD.md:194-199`、`TASK_PLAN.md:68` vs `app.json:2-6`（grep 0 处 RecorderManager） |
| 批量转换 | MVP 非目标；V1.1/M8 规划 | 未实现；编辑器有批量导入可复用 | `PRD.md:60,122`、`TASK_PLAN.md:73,339` vs `index.js:265`、`editor.js:652-816` |
| 历史页 | 独立页 + 试听/重试/删除/过期标记 | 弹层 + 仅分享；无过期字段 | `PRD.md:173-178,267-270`、`TASK_PLAN.md:317-321` vs `index.js:593-603, 869-884`、`index.wxml:470-507` |
| 额度 | 首页展示剩余次数；测试期不限 | 首页 quota 死代码；设置页写不限次数 | `PRD.md:296` vs `index.wxml:463-465`、`settings.wxml:5` |
| 输出命名 | `原文件名_转换为{格式}.{ext}` | `原名_{4位随机}.{格式}` | `PRD.md:344` vs `ffmpegProbe/index.js:588` |
| 编辑器导出格式 | P0 mp3/wav/flac | 仅 mp3 | `PRD.md:315`、`MUSIC_EDITOR_DESIGN.md:547` vs `editor.js:4346`、`ffmpegProbe/index.js:327,374,385` |
| 隐私 | 弹窗、指引、收集声明齐全 | `__usePrivacyCheck__` 缺失，弹窗不触发；无麦克风声明 | `PRD.md:277-281` vs `app.json:1-17`、`DEV_LOG.md:53` |
| 版本号 | 实现已到 v5.0（DEV_LOG 尾部） | 设置页 `0.1.0`；DEV_LOG 标题仍 v1.8；PRD v1.3/TASK_PLAN v2.5 停留在 10-28 | `DEV_LOG.md:1,309`、`settings.js:3`、`PRD.md:1`、`TASK_PLAN.md:1` |

---

## 2. 逐项结论（a–f）

### a. 录音/录音导入（RecorderManager）

**现状**：全项目无 `RecorderManager`/`getRecorderManager`/`scope.record`/`wx.authorize` 调用（grep 仅在 docs 命中）；导入只有 `chooseMessageFile` 单文件（`index.js:262-331`）与编辑器多选（`editor.js:652-670`）。录音是 PRD 明确规划但未实现的 P1（`PRD.md:194-199`、`TASK_PLAN.md:68`、`MUSIC_EDITOR_DESIGN.md:752`、`UX_EDITOR_SPEC.md:592`）。

**需要改的点（前端）**：

| # | 改动点 | 文件:行（现状锚点） | 说明 |
| :--- | :--- | :--- | :--- |
| 1 | 恢复隐私总开关 | `app.json:1-17`（缺 `__usePrivacyCheck__`） | 录音与选文件同受隐私协议约束；恢复方式见 `PRIVACY_GUIDE_SETUP.md:26,44-45` |
| 2 | 后台隐私指引新增"麦克风"声明 | `PRD.md:280,452`；`MUSIC_EDITOR_DESIGN.md:1583` | 需在 MP 后台"用户隐私保护指引"勾选麦克风/录音能力；否则 `RecorderManager` 首次使用会被拦截（与 `DEV_LOG.md:53` 的文件选择同因） |
| 3 | `scope.record` 授权链 | 无现状代码 | `wx.getSetting` 查授权 → `wx.authorize({scope:'scope.record'})` → 拒绝时 `wx.showModal` + `wx.openSetting` 引导；不能只在 onError 里兜底 |
| 4 | RecorderManager 生命周期 | 无现状代码 | `onLoad` 创建 `wx.getRecorderManager()`；`onStart/onPause/onResume/onStop/onError/onInterruptionBegin/onInterruptionEnd`；`onHide/onUnload` 停止并清理计时器（可复用编辑器打断处理模式 `editor.js:346-353`） |
| 5 | 录音 UI 与状态 | `index.wxml:45-71` 空态只有选文件；`index.js` 无录音状态 | 空态加次级入口"录音转格式"（`PRD.md:147`）；录制面板（计时/暂停/停止/取消/重录）；建议独立底部弹层，避免挤压 525 行 wxml |
| 6 | 产物转统一本地文件 | `index.js:262-331` 选文件成功分支与 `292-309` 组装 `sourceFile` | 抽 `acceptLocalAudio({path,name,size,origin})`，让选文件与录音共用同一段 setData/试听/预检逻辑；录音产物命名如 `录音_YYYYMMDD_HHmm.{ext}` |
| 7 | 录音规格约束 | `index.js:5` 时长上限；`ffmpegProbe/index.js:34` | 产品값≤10min（`PRD.md:197`）；默认 aac（兼容性最好），可选 mp3/wav；**wav 10min≈106MB 超过 50MB 上传上限**（`DEV_LOG.md:79`），选 wav 需前端限制或提示转 aac |
| 8 | 去向二选一：转换 / 进剪辑 | `index.js:475-615`（转换）；`editor.js:732-792`（导入分析） | 录音停止后给两个按钮：「转为格式」→ 复用 `startConvert` 链路；「进入剪辑」→ 把临时文件写入 `getApp().globalData.pendingImport` 后 `navigateTo editor`，编辑器 `onLoad` 消费并走 `importFiles`（`editor.js:732`） |
| 9 | 历史/作品库标记来源 | `index.js:593-603` | 记录 `origin:'record'`，供作品库筛选/统计 |

**与 chooseMessageFile 的复用关系**：上传（`index.js:508-514`）、云端转换（`index.js:521-539`）、结果处理（`541-590`）、历史写入（`592-603`）全部可原样复用；差异只在"文件从哪来"与"是否需要授权/录制 UI"。编辑器侧已有"本地临时文件→upload→analyzeAudio"的现成函数（`editor.js:756-798`），录音产物可直接走同一函数，无需新云端接口。

**风险**：

| 风险 | 级别 | 说明/缓解 |
| :--- | :--- | :--- |
| 隐私指引未配置导致录音不可用 | 高 | 与 03:46 真机 `chooseMessageFile` 事故同源（`DEV_LOG.md:53`）；必须先恢复 `__usePrivacyCheck__` 并配置麦克风声明再提审 |
| 类目/审核对"录音"敏感 | 中 | 类目为"工具>图片处理"且"不得传播分享/公开访问"（`PRD.md:447`）；录音是本地采集，风险低于公开传播，但提审需说明麦克风用途与 24h 删除 |
| 各端录制格式/时长/中断差异 | 中 | 录制中来电、切后台、锁屏会中断；需保存已录部分或明确提示（`PRD.md:198`）；格式与 `onStop` 返回字段（`tempFilePath/duration/fileSize`）需真机核验（附录 B） |
| 录音文件被系统清理/过大 | 中 | 临时文件只应短持有：录制完立即进入上传或先 `saveFile` 到 `USER_DATA_PATH`；wav 大时长超 50MB 需前置拦截 |
| 编辑器接收外部本地文件的耦合 | 低 | 用 globalData 传临时路径而非 URL query（路径含特殊字符、query 长度限制）；编辑器 `onLoad` 消费后立即清空，避免重复导入 |

**结论**：适合作为 v5.1 切片，工作量 **M（前端 2~3 人日 + 真机 0.5~1 人日）**，云端 0 改动（复用 `convertFile`/`analyzeAudio`）。必须与"隐私开关恢复"打包上线。

### b. 批量转换

**现状（阻塞点）**：

| 层 | 现状 | 证据 |
| :--- | :--- | :--- |
| 选择 | `chooseMessageFile({count:1})`，`sourceFile` 单对象 | `index.js:262-308` |
| 状态机 | 单状态枚举，结果单对象 | `index.js:34-35, 82-92` |
| 结果/历史 | 单结果卡；历史单条 `unshift` | `index.wxml:351-454`、`index.js:876-884` |
| 云端 | `convertFile` 只接受单个 `fileID`，同步执行（55s ffmpeg 预算） | `ffmpegProbe/index.js:489-604, 542` |
| 调用约束 | `callFunction` 长调用无客户端 timeout、切后台 5s 可能中断（已知 ISSUE-019） | `DEV_LOG.md:237`、`CLIENT_CAPABILITIES.md:344` |
| 可复用模式 | 编辑器已有"多选→逐项上传/分析→失败收集/重试"的串行队列 | `editor.js:652-730, 732-816` |

**三种改造方案对比**：

| 方案 | 做法 | 改动 | 工作量 | 风险 | 建议 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| A. 前端串行队列（推荐 v5.1） | 一次多选（≤3）→ 逐项复用现有 `convertFile`；每项 `pending/uploading/converting/success/fail`；总进度 + 失败列表 + 重试；队列落 storage 以便恢复 | 仅前端：`index.js` 状态机扩展（增加队列态或子状态）、`index.wxml` 列表 UI、`index.wxss`；历史逐条写入；云端 0 改动 | **M**：前端 3~4 人日 + 真机 1 人日；后端 0~0.5 人日（可选：失败源文件补偿清理） | 中：总时长可达数分钟，必须前台；中途退出会留下未完成项；部分成功语义要设计 | ✅ v5.1 轻量做（≤3 个） |
| B. 云端批量 action | 新增 `convertBatch`，一次 event 传多 fileID，串行转码 | 云函数新增 action；但仍在单次 60s 预算内，第二个文件就可能超时 | 后端 M、前端 S | 高：不可控超时、无重试、失败回滚难 | ❌ 不建议 |
| C. 异步任务队列（两段式） | `tasks` 集合 + `createTask/runTask/getTask` + 轮询；可恢复/取消 | 后端新增集合/action/定时补偿；前端轮询与任务态 UI | **L**：后端 4~6 人日 + 前端 2~3 人日 | 高：云函数仍需单文件/次执行、并发控制、幂等、清理；远超 v5.1 范围 | 留 v5.2（与 `DEV_LOG.md:113`、`PRD.md:234-238` 的异步任务设计合并） |

**前端改造面（方案 A 细化）**：

1. 数据：`sourceFile` → `batchItems[]`（每项含 `path/name/size/sizeText/ext/status/result/error`）；`status` 增加 `BATCHING` 或在 `IDLE/SUCCESS` 之外用 `batchProgress` 表达。
2. 选择：`count:3`（上限与产品确认；编辑器 5 是源上限，转换建议 3 以内），逐项做 50MB/扩展名校验，超限项直接在列表标红。
3. 执行：`for` 串行调用现有上传+`callFunction`，每项完成后立即写历史/作品库并更新 UI；任一项失败不中断后续（与 `editor.js:793-798` 一致）。
4. 结果：列表卡片（格式/大小/状态/单个转发/单个试听），"全部完成 N 成功 M 失败"汇总；失败项重试。
5. 退出保护：转换中 `wx.enableAlertBeforeUnload`（编辑器已有模式 `editor.js:355-371`）；队列状态写 storage，重进页面提示"有未完成批量任务"。
6. 历史/作品库：`id` 生成改用"时间戳+随机"（现有 `Date.now()` 批量会撞，`index.js:594`）。

**工作量结论**：方案 A 总计 **前端 M（3~4 人日）、后端 S（0~0.5 人日）**；若做方案 C 则 **L（后端 4~6 + 前端 2~3 人日）**。v5.1 建议只做 A 且上限 3；批量与"作品库"共用列表/存储可省 1 人日。

### c. 统一「作品库」

**现状**：

| 产物类型 | 现在存在哪 | 是否持久化 | 证据 |
| :--- | :--- | :--- | :--- |
| 格式转换结果 | 页面 `data.convertResult` + 本地历史（仅元信息） | 元信息持久化（20 条），文件 24h 后过期 | `index.js:551-561, 876-884`；云端清理 `ffmpegProbe/index.js:137-160` |
| 剪辑导出结果 | 仅页面 `data.result`（`fileID/fileName/size/duration`） | **否**：无任何 storage 写入 | `editor.js:4443-4476`；全页唯一 `setStorage` 为草稿 `editor.js:407` |
| 录音产物（规划） | 临时路径 | 否 | 无实现 |
| 草稿工程 | `NLE_DRAFT_CACHE_V1` | 是（7 天） | `editor.js:31, 407-414, 431-442` |

**建议存储结构**（新增 `miniprogram/utils/works-store.js` 统一封装）：

```json
// storage key: works_v1
{
  "schemaVersion": 1,
  "updatedAt": 1761800000000,
  "items": [
    {
      "id": "w_1761800000000_ab12",
      "kind": "convert",                  // convert | edit | record
      "createdAt": 1761800000000,
      "expiresAt": 1761886400000,         // createdAt + 24h（云端文件清理时间）
      "status": "ready",                  // ready | expired | failed
      "title": "会议录音_剪辑.mp3",
      "source": {
        "name": "会议录音.m4a", "ext": "m4a",
        "sizeBytes": 6870000, "durationSec": 301,
        "origin": "chat"                  // chat | record | editor
      },
      "output": {
        "fileName": "会议录音_ab12.mp3",
        "format": "mp3", "bitrate": "192k",
        "sampleRate": 44100, "channels": 2,
        "sizeBytes": 1234567, "durationSec": 301,
        "fileID": "cloud://..."
      },
      "extra": { "clipCount": 3, "costSeconds": "15.1", "savedRatio": 82 }
      // 故意不存 downloadUrl（临时链接）、不存本地 tempPath（会被清理）
    }
  ]
}
```

| 设计项 | 建议 | 理由 |
| :--- | :--- | :--- |
| 条数上限 | 50 条 | 纯元信息约 <50KB；不会逼近本地缓存限制（官方口径单 key 1MB/总量 10MB，待核验，见附录 B） |
| 过期语义 | `expiresAt = createdAt + 24h`；渲染时计算 `status`，过期项置灰、禁试听/转发，保留元信息 | 与云端清理一致；满足 `PRD.md:178`「超过 24h 标记文件已清理，仍保留元信息」 |
| 本地留存（可选） | 仅当用户主动"保存到本地"时 `saveFile` 到 `USER_DATA_PATH`，记录 `extra.localPath`/`savedLocally` | 避免把临时路径写进库；同时提供"云端过期后仍可听"的增强，属可选项 |
| 迁移 | 首次启动读 `audio_convert_history`（≤20 条）→ 映射为 `kind:'convert'`（`id` 可用旧时间戳补时间、`createdAt=旧 id`、`expiresAt=+24h`、`fileID/downloadUrl` 只保留 `fileID`）→ 写 `works_v1` + `works_migrated_v1:true`，旧 key 保留 1 个版本可回滚 | 无破坏式迁移；旧 key 是 `Date.now()` 时间戳可反推创建时间（`index.js:594`） |
| 删除/清空 | 单条删除仅删本地元信息（不删云端文件，云端由定时清理）；清空同 `clearHistory` 语义 | 避免越权删云端/误删其它记录 |
| 去重 | `fileID` 唯一（转换/编辑产物 fileID 唯一） | 防止重试/重复入库 |

**页面信息架构**：

- 新增 `pages/library/library`（作品库页，取代现在的历史弹层；历史弹层可保留为兼容入口 1 个版本）。
- 入口：首页右上胶囊"作品"（替换 `index.wxml:17-21` 的"历史"）、设置页"数据管理→作品库"（`settings.wxml:18-22`）、编辑器结果页"已存入作品库"链接（`editor.wxml:1409-1427`）。
- 结构：顶部统计（总数/转换/剪辑）+ 分段筛选（全部/转换/剪辑/录音）+ 列表卡片（封面/标题/格式→格式/大小/时间/状态）+ 底部"清空"；过期区单独分组；空态引导"去转换 / 去剪辑 / 录音"。
- 卡片操作：试听（未过期）、转发文件（未过期，沿用 `shareLocalFile` 模式 `index.js:707-726`）、再来一次（转换记参数→回填首页；剪辑→打开编辑器）、删除。
- 注意：**作品库是 per-openid 的本地数据**，不能通过小程序卡片"分享作品"给他人（无公开链接，且类目禁止公开传播，`RELEASE_CHECKLIST.md:18`）。

**工作量**：新增存储层 + 作品库页 + 首页/设置/编辑器接入，约 **M：前端 3~4 人日**；云端 0 改动（清理逻辑已覆盖转换/编辑产物）。这是"录音导入/剪辑沉淀/分享"三者的公共底座，应最先做。

### d. 分享能力

**现状（grep 全项目 miniprogram 目录）**：

| 能力 | 是否存在 | 证据 |
| :--- | :--- | :--- |
| `onShareAppMessage`（好友卡片） | **0 处** | grep 无命中 |
| `onShareTimeline`（朋友圈） | **0 处** | grep 无命中 |
| `wx.showShareMenu` / `onAddToFavorites` | **0 处** | grep 无命中 |
| `wx.shareFileMessage`（音频文件转发） | 已实现，8 处引用 | `index.js:680-682, 707-726, 731-740, 791, 805-827`；`editor.js:4661-4692` |
| 文件转发手势约束 | 必须用户点击同步调用；结果页预下载，历史页"先准备再点第二次" | `index.js:680-682, 734-739, 805-827`；`DEV_LOG.md:57` |
| PC 保存 | `saveFileToDisk` + 失败复制链接 | `index.js:745-800` |
| 分享文案位置 | 结果页按钮叫「发给微信好友」，实际是**发送音频文件**，不是小程序卡片 | `index.wxml:433-436`、`editor.wxml:1409-1414` |

**缺口与成本**：

| 缺口 | 说明 | 成本 | 风险/注意点 |
| :--- | :--- | :--- | :--- |
| 小程序卡片（好友） | 需在页面实现 `onShareAppMessage`，返回 `{title,path,imageUrl}`；按钮需 `open-type="share"` 或右上角菜单 | **S/M：0.5~1 人日/页 × 2 页 + 封面图设计 0.5 人日 + 真机 0.5 人日** | `path` 只放安全参数（如 `?from=share`），不要带 `fileID/openid`；卡片只能分享"小程序"不能分享音频内容；封面图建议 5:4、控制在 200KB 内（包体约束见 `DEV_LOG.md:54`）；朋友圈单页模式限制需核验（附录 B） |
| 朋友圈（`onShareTimeline`） | 可返回 `{title,query,imageUrl}` | S（代码） | **不建议 v5.1**：类目"工具>图片处理、不得传播分享/公开访问"（`PRD.md:447`）、`RELEASE_CHECKLIST.md:18` 明确"当前仅文件转发，风险可控"；朋友圈会把工具公开传播，审核风险显著上升。如未来做，需产品/合规重新拍板并在页面处理单页模式（部分 API 不可用） |
| 作品分享 | 用户可能期望"把作品发给朋友" | — | 现状无法安全实现：作品文件无公开 URL、云 fileID 属当前 openid（`ffmpegProbe/index.js:505-506`），卡片分享只能引导对方打开小程序；**不要用 `?workId=` 暗示对方能看到作品**，否则必然失败 |
| 分享卡 vs 文件按钮区分 | 现在只有一个"发给微信好友"（文件） | S（文案/按钮） | 结果页需并列两个动作：「发送音频文件」（现有）与「分享小程序给好友」（卡片），避免语义混淆 |

**结论**：v5.1 只做"好友小程序卡片"（`onShareAppMessage` + 一个 `open-type="share"` 按钮 + 封面图），不做朋友圈；成本 1.5~2 人日，无后端改动；合规上作为"邀请体验"而非"作品分发"。

### e. 输出格式：编辑器只支持 mp3

**证据链**：

| 位置 | 事实 | 证据 |
| :--- | :--- | :--- |
| 前端请求 | `format:'mp3'` 硬编码，用户不可选 | `editor.js:4343-4348` |
| 前端 UI | 吸底导出按钮文案固定「导出 MP3」 | `editor.wxml:1314` |
| 前端文件名 | `_剪辑.mp3` | `editor.js:4478-4483` |
| 请求契约 | `buildRenderRequest` 已支持 `format` 字段（默认 mp3） | `editor-utils.js:1141-1152` |
| 后端 | `renderEditV2/V1` 输出路径、云路径、文件名、台账全部 mp3，忽略请求中的 `format` | `ffmpegProbe/index.js:327, 374, 385, 424, 463, 475, 207-217` |
| 文档规划 | 设计 P0 = mp3/wav/flac，m4a P1、OGG 不支持；PRD 也写"导出 mp3（默认）/wav/flac（P1）" | `MUSIC_EDITOR_DESIGN.md:478, 547`、`PRD.md:315` |

**从转换页视角看用户是否需要更多输出格式**：需要，但优先级低于"作品库/录音"。

1. 转换页允许选 6 种输出（`index.js:49-56`），用户会自然期望"剪辑也能选格式"；现在剪辑强制 mp3，等于把用户在转换页做的格式选择在剪辑页作废，认知不一致。
2. 但多格式导出不是无损扩展：后端输出路径/云路径/文件名/台账/错误码/时长矩阵都要参数化；且**格式×时长×体积**约束明显（WAV 10min≈106MB，超过 50MB 输出上限 `PRD.md:316`、`MUSIC_EDITOR_DESIGN.md:1071-1072`、`ffmpegProbe/index.js:546`），必须新增 `EXPORT_LIMIT/UNSUPPORTED_FORMAT` 映射与前端提示（`MUSIC_EDITOR_DESIGN.md:1346-1350`）。
3. 建议 v5.1 **不做**编辑器多格式；改为"规格透明"的低成本增强：
   - 转换页：格式卡上标注"iOS 可否试听"、时长建议（已有 `FORMAT_LIMIT_SEC`，`index.js:5`）、高级参数实时摘要（已有 `index.wxml:244`）；
   - 编辑器：导出区标注「剪辑成片固定输出 MP3（192k 默认，可调 64~320k）」，并提示"需要 WAV/FLAC 请先用格式转换"；v5.2 再实现 mp3/wav/flac + m4a（P1）。
4. 若纳入 v5.1，工作量 **M~L：前端 1~1.5 人日 + 后端 1~2 人日（参数化 + 限额矩阵 + 单测）**；风险：flac/wav 长时长超时/超 50MB、copy 快速路径需重新评估（`MUSIC_EDITOR_DESIGN.md:1005-1029`）。

### f. UX/文案/错误处理缺陷 Top 10

| # | 缺陷 | 位置（证据） | 影响 | 建议修复 |
| :-- | :--- | :--- | :--- | :--- |
| 1 | **额度残留死代码/文案矛盾**：页脚"今日免费额度 X/5"永远不会显示（`quotaUsed` 永远 null），但代码仍在；设置页写"不限次数" | `index.wxml:463-465`、`index.js:96,579`、`ffmpegProbe/index.js:17,594`、`settings.wxml:5`、`RELEASE_CHECKLIST.md:34` | 若日后恢复配额，前端无初始剩余次数、语义是"已用"却写"额度"；现状属死代码，误导维护者 | 删除页脚 quota 块与相关样式（`index.wxss:1110`）；或恢复配额时一并做"剩余次数"接口与初始查询（`PRD.md:296`） |
| 2 | **历史无法感知过期**：只存 `HH:mm`，无 `createdAt/expiresAt`，24h 后仍可点分享，失败才弹"已过期" | `index.js:593-603, 876-884, 805-827`、`index.wxml:470-507` | 用户反复点、体验差；不满足 `PRD.md:178`、`FR-12:269` | 作品库方案落地 `createdAt/expiresAt`，列表直接显示"已过期"并禁用操作 |
| 3 | **"24 小时物理销毁"承诺过强**：失败转换的源文件不删、cleanup 每日上限 100 条 | `index.wxml:460,477`、`editor.wxml:1427`、`ffmpegProbe/index.js:580-582,137-160`、`index.js:509` | 隐私承诺与实现不一致，提审/舆情风险 | 云函数 `finally`/失败分支删除源文件；cleanup 分页循环或按前缀清理 `temp_audios/`；或把文案改为"最长 24 小时内清理"并补充失败文件清理 |
| 4 | **手机端「保存 / 转发文件」名不副实** | `index.js:745-800`、`index.wxml:439`、`DEV_LOG.md:221`（ISSUE-003 曾决策"不展示保存到手机"） | 用户以为能保存到手机，实际只能转发到聊天再长按保存 | 按平台动态文案：手机端改为「转发到聊天保存」；PC 端保留「保存到电脑」 |
| 5 | **源文件不可播提示过度承诺**："转换后将支持原声直接试听" | `index.wxml:116-120`、`index.js:563-569` | 用户把 flac/ogg 转成 flac/ogg 后 iOS 仍不能试听，预期落空 | 文案区分"转为 MP3/M4A/WAV/AAC 后可试听"；目标格式卡上直接标 iOS 可播徽标 |
| 6 | **不可播源的时长预检被绕过**：`sourceDuration` 只有可播源才有值，flac/ogg/amr 等为 0；用体积估算时长（按 192kbps）做预估 | `index.js:289, 368-401, 490-499`、`ffmpegProbe/index.js:526-531` | 用户等完上传才被云端拒绝；预估体积/瘦身比例失真 | 选文件后先调用 `analyzeAudio`（已有 action，`ffmpegProbe/index.js:235`）拿真实时长；或在选择时展示"时长待云端探测"并弱化预估 |
| 7 | **错误处理无码/无重试/无取消**：所有失败统一 `err.message` + 回 IDLE；无 `ERROR` 状态；无取消/进度百分比 | `index.js:34, 475-499, 606-614`、`index.wxml:331-347`、`PRD.md:240-244,299-302` | 用户不知道能不能重试、要不要重新上传；长音频只能干等 | 引入错误码映射（云端已返回 `code`：`ffmpegProbe/index.js:497-510,598-599`）与重试按钮；`status` 增加 `FAILED`；上传用 `onProgressUpdate`，界面显示百分比与取消（取消=页面级 abort 语义，至少隐藏"取消"承诺） |
| 8 | **隐私弹窗实际不触发 + 开发者文案**：`app.json` 缺 `__usePrivacyCheck__`；打开隐私政策失败提示"请先在后台配置隐私保护指引"；拒绝后无"去设置"引导；首页/编辑器两套重复实现 | `app.json:1-17`、`index.js:115-148`、`editor.js:303-334`、`PRIVACY_GUIDE_SETUP.md:26,36` | 真机首次使用可能直接报 `api scope is not declared`（历史事故 `DEV_LOG.md:53`）；文案不是给用户看的 | 恢复开关 + 统一隐私组件/工具（避免两份逻辑）；失败文案改为"隐私协议暂未就绪，请稍后重试/联系客服" |
| 9 | **无页面退出/任务恢复；结果只存内存** | `index.js:150-156`（onHide/onUnload 只停播放）、无 `onShow`、无 taskId；`DEV_LOG.md:237` ISSUE-019 | 转码中切走/杀进程 → 结果丢失、云端可能残留产物；用户回来一脸茫然 | 最小版：转换中 `enableAlertBeforeUnload` + 结果/历史写作品库；完整版：async task + taskId 持久化（v5.2） |
| 10 | **设置页陈旧/低价值/破坏性操作**：版本 `0.1.0`；无真实客服/反馈入口；`clearStorageSync` 会清掉剪辑草稿；清历史后首页角标不刷新；产品名不统一（音频格式转换/音乐格式转换器/AudioConvert） | `settings.js:3,24-30,35,60`、`settings.wxml:10-16,24`、`index.wxml:11,466`、`editor.wxml:1427` | 信任感/合规（投诉入口不可达）/误删草稿风险 | 版本从配置读取；加 `<button open-type="contact">意见反馈</button>`；清缓存只删已知 key 并保留 `NLE_DRAFT_CACHE_V1` 或明确提示；首页 `onShow` 刷新作品数；统一产品名 |

**额外观察（不入 Top10，但建议顺手修）**：

- 两次 50MB 校验重复（`index.js:272-281` 与 `484-488`）；扩展名白名单含 amr/wma/ape 但不含 aiff（`index.js:267` vs `PRD.md:119`）。
- 输出命名与 PRD 不一致（`ffmpegProbe/index.js:588` vs `PRD.md:344`）。
- 设置页时长建议与代码一致（`settings.wxml:7` vs `index.js:5`），但 PRD 8.2 的 M4A「≤5~8 分钟」宽于代码 10 分钟（`PRD.md:337` vs `index.js:5`）。
- `audioConvert`、`quickstartFunctions` 两个云函数前端 0 引用（grep 无命中），属遗留死代码（`cloudfunctions/audioConvert/index.js:1-40`、`cloudfunctions/quickstartFunctions/index.js:1-20`），建议 v5.1 清理/不部署。
- `sitemap.json` 允许全部页面被索引（`sitemap.json:1-6`），若后续出现作品库页，可评估是否禁止索引（隐私/内容安全考虑）。

---

## 3. 候选更新项池（13 项）

> 价值 1-5（用户价值/战略价值综合）；工作量 S≈≤1 人日、M≈2~4 人日、L≈≥5 人日（AI 辅助 + 前端为主估算，含自测，不含真机矩阵与提审）；"v5.1 切片"= 是否建议进入下一版。

| # | 候选更新项 | 价值 | 工作量 | 风险 | 主要涉及文件 | 适合 v5.1？ |
| :-- | :--- | :---: | :---: | :--- | :--- | :--- |
| 1 | 录音导入（录音→转换 / 录音→剪辑） | 5 | M | 中高（隐私/麦克风声明/审核/端差异） | `index.js/.wxml/.wxss`、`app.json`、`editor.js`（消费 pendingImport）、`editor.wxml`、legal/docs | ✅ 是（P1） |
| 2 | 批量转换（≤3 前端串行队列） | 4 | M | 中（前台等待、中断、部分成功） | `index.js/.wxml/.wxss`、作品库存储、docs | ✅ 是（P2，可顺延） |
| 3 | 统一作品库（转换+剪辑+录音，含历史迁移/过期/试听/删除/重试） | 5 | M | 低中（存储上限、过期语义、迁移） | 新增 `utils/works-store.js`、`pages/library/*`；`app.json`、`index.*`、`editor.*`、`settings.*` | ✅ 是（P0 核心） |
| 4 | 分享小程序卡片（好友，不含朋友圈） | 4 | S/M | 中（类目"不得传播"边界、封面素材） | `index.js/.wxml`、`editor.js/.wxml`、`images/share-card.*`、docs | ✅ 是（P1） |
| 5 | 编辑器输出格式扩展（mp3/wav/flac，m4a P1） | 4 | M/L | 中（超时/50MB/时长矩阵/错误码） | `editor.js/.wxml`、`editor-utils.js`、`ffmpegProbe/index.js`、`EDITOR_IMPL_CONTRACT.md` | ⏳ 否（v5.2；v5.1 只做规格透明） |
| 6 | 设置页升级（版本/客服反馈/作品库入口/清缓存隔离/隐私状态） | 3 | S | 低 | `settings.js/.wxml/.wxss`、`app.json` | ✅ 是（P0 顺带） |
| 7 | 新手引导/帮助（三条平台约束、首次空态引导、格式可播徽标） | 3 | S/M | 低 | `index.wxml/.wxss`、`editor.wxml`、`docs` | ✅ 是（低成本，可并入作品库空态） |
| 8 | 转换预设方案（微信畅发/车载/省流/高保真，一键套格式+码率） | 4 | S | 低 | `index.js/.wxml` | ✅ 是（S 级快赢，可选项） |
| 9 | 音频信息标签/规格透明（码率/采样率/声道/时长/来源/iOS 可播） | 3 | S | 低 | `index.js/.wxml`、`editor.wxml` | ✅ 是（并入 #8/作品库卡片） |
| 10 | 转录文字/音频转文字 | 3 | L | 高（需额外云服务/内容安全/隐私/成本） | 云函数/新服务、`index.*`、legal | ❌ 否（非本版本方向） |
| 11 | 音量标准化/响度匹配 | 3 | M/L | 中高（loudnorm 10min≈42s 超预算；`MUSIC_EDITOR_DESIGN.md:1088`） | `ffmpegProbe/index.js`、`editor-core`、`editor.*` | ❌ 否（v5.2 评估） |
| 12 | 输入/输出格式扩展（amr 输出、aiff 输入等） | 3 | S/M | 中（设备兼容/试听限制） | `index.js`、`ffmpegProbe/index.js`、`settings.wxml`、docs | ⏳ 否（v5.2） |
| 13 | 任务恢复/后台化（异步任务+轮询+取消） | 5 | L | 高（超时/幂等/清理/成本） | `ffmpegProbe/index.js`、`index.*`、新集合/定时器、docs | ❌ 否（v5.2 与批量合流） |

**补充说明**：

- #3 作品库是 #1/#2/#4 的公共底座：录音与剪辑产物都需要落库，分享卡片入口也需要"可回溯的作品"。建议先做 #3 再做 #1/#4。
- #5 与 #12 有重叠但作用域不同：#5 是编辑器导出格式，#12 是转换页输入/输出格式。
- #13 不建议在 v5.1 做：云端仍是 60s 单函数模型（`DEV_LOG.md:34,37`），异步任务需要新增 `tasks` 集合、轮询、幂等、补偿与清理（`DEV_LOG.md:113,237`），与批量一起做才划算。

---

## 4. v5.1（转换/采集/沉淀方向）排序建议与理由

### 4.1 建议排序（5 项）

| 优先级 | 项 | 理由 | 依赖 |
| :--- | :--- | :--- | :--- |
| **P0-1** | 合规/文案一致性修复（隐私开关恢复、24h 表述、保存/转发文案、清缓存隔离、版本号、客服入口、quota 死代码清理） | 这是提审门禁：`__usePrivacyCheck__` 未恢复、隐私指引未配置时真机选文件就会失败（`DEV_LOG.md:53`）；文案与实现不一致（"24h 销毁"、"保存"）会在审核/投诉中放大。整体 S 级，性价比最高 | 后台隐私指引配置（人工） |
| **P0-2** | 统一作品库 + 历史升级（迁移、过期标记、试听/转发/删除/重试、剪辑导出入库、录音入库字段预留） | 沉淀是"采集→沉淀→传播"闭环的中间层；无云端改动、纯前端可控；当前历史是"死 fileID 列表"，剪辑结果完全丢失（`editor.js:4443-4476`）。这是后续录音/卡片的地基 | P0-1（storage/清理语义） |
| **P1-3** | 录音导入（转换 / 剪辑双去向） | 补齐 PRD P1（`PRD.md:194-199`），解决"手机本地文件选不了"的核心痛点（`DEV_LOG.md:219` ISSUE-001）；复用上传/`convertFile`/`analyzeAudio` 全链路，无后端改动 | P0-1 隐私 + P0-2 入库 |
| **P1-4** | 分享小程序卡片（好友 only） | 现有只有文件转发（`index.js:707-726`），缺增长入口；成本 1.5~2 人日、无后端；封面图 + `onShareAppMessage` 即可；**不做朋友圈**以避开类目"不得传播"风险（`RELEASE_CHECKLIST.md:18`） | 无（可与作品库并行） |
| **P2-5** | 批量转换（≤3 前端串行 + 队列恢复） | 真实需求存在（群里多个录音），但风险在"长时间前台+中断"；复用编辑器队列模式（`editor.js:732-816`），云端 0 改动；若排期紧可顺延 v5.2，与异步任务（#13）合并规划 | P0-2（列表/存储）、P0-1（退出保护） |

**可选快赢（若 P2-5 顺延）**：转换预设（#8，S 级）+ 规格透明/可播徽标（#9，S 级）可以填补 v5.1 的"体感增量"。

### 4.2 「录音导入 + 作品库 + 分享卡片」组合的文件级改动清单

> 标注：🆕 新增 / ✏️ 修改 / ⚙️ 配置 / 📄 文档。所有路径相对仓库根目录。

| # | 文件 | 类型 | 改动点 | 依据 |
| :-- | :--- | :---: | :--- | :--- |
| 1 | `miniprogram/app.json` | ⚙️ | 注册 `pages/library/library`；恢复 `"__usePrivacyCheck__": true`；不新增 tabBar（用胶囊/横幅入口，避免图标包体与审核面） | `app.json:1-17`、`PRIVACY_GUIDE_SETUP.md:26,44` |
| 2 | `miniprogram/utils/works-store.js` | 🆕 | 作品库存储层：`list/get/add/update/remove/clear`；`works_v1` schema、50 条上限、24h `expiresAt` 计算、`audio_convert_history` → `works_v1` 迁移、幂等去重、异常兜底 | §2.c 设计；`index.js:869-884` 旧结构 |
| 3 | `miniprogram/pages/library/library.js` | 🆕 | 作品库页：加载/筛选（全部/转换/剪辑/录音）/过期分组/试听/转发/再来一次/删除/清空/空态；复用 `shareLocalFile` 思路（新增本地函数或抽公共 utils） | `index.js:707-726` 分享实现可抽公共 |
| 4 | `miniprogram/pages/library/library.wxml/.wxss/.json` | 🆕 | 页面 UI 与标题/配置 | — |
| 5 | `miniprogram/pages/index/index.js` | ✏️ | ① 抽取 `acceptLocalAudio({path,name,size,origin})` 统一选文件/录音入口；② 录音：`getRecorderManager` 生命周期 + `scope.record` 授权 + 计时；③ 转换成功写 `works-store`（kind=convert/record），去掉 `downloadUrl` 持久化、增加 `createdAt/expiresAt`、`id` 改随机后缀；④ 历史入口改为跳作品库/或保留弹层但读新 store；⑤ `onShareAppMessage`；⑥ `onShow` 刷新作品数；⑦ 错误码映射与失败态；⑧ 可选批量队列 | `index.js:106-112, 262-331, 475-615, 593-603, 869-884, 907-910` |
| 6 | `miniprogram/pages/index/index.wxml` | ✏️ | ① 空态加"录音转格式"次级入口；② 录音面板（计时/暂停/停止/取消/重录 + 去向按钮）；③ 右上胶囊"作品"（替换历史）；④ 结果页加"分享小程序给好友" `open-type="share"`；⑤ 修正文案（24h/保存/不可播）；⑥ 删除 quota 页脚块 | `index.wxml:17-21, 45-71, 116-120, 433-441, 460-465` |
| 7 | `miniprogram/pages/index/index.wxss` | ✏️ | 录音面板/作品入口/批量列表样式；删除 `footer-quota-pill` 等死样式 | `index.wxss:1110,1144,1217` |
| 8 | `miniprogram/pages/editor/editor.js` | ✏️ | ① `onLoad` 消费 `getApp().globalData.pendingImport`（录音/作品库"再来一次"），走 `importFiles`；② 导出成功 `handleExportSuccess` 前写 `works-store`（kind=edit）；③ `onShareAppMessage`；④ 结果页"再剪一首/继续微调"保留 | `editor.js:179-258, 732-816, 4443-4476, 4661-4718` |
| 9 | `miniprogram/pages/editor/editor.wxml` | ✏️ | 结果卡加"已存入作品库/查看作品库"入口 + 分享卡片按钮（`open-type="share"`）；格式透明文案（固定 MP3） | `editor.wxml:1409-1427` |
| 10 | `miniprogram/pages/editor/editor.wxss` | ✏️ | 新按钮/入口样式 | — |
| 11 | `miniprogram/app.js` | ✏️ | `globalData.pendingImport`（录音→剪辑/作品库→剪辑）；可选：启动时触发 `works-store` 迁移 | `app.js:2-19` |
| 12 | `miniprogram/pages/settings/settings.js/.wxml` | ✏️ | 版本号从配置/常量读取；作品库入口；`<button open-type="contact">` 意见反馈；清缓存改为只删已知 key 且保护 `NLE_DRAFT_CACHE_V1`；文案与配额状态一致 | `settings.js:3,24-30,35,60`、`settings.wxml:10-22` |
| 13 | `miniprogram/images/share-card.png`（或 `.jpg`） | 🆕 | 分享卡片封面（建议 5:4，≤200KB） | `DEV_LOG.md:54` 包体约束 |
| 14 | `cloudfunctions/ffmpegProbe/index.js` | ✏️（可选/建议同版） | 失败路径/`finally` 删除源文件，或新增按前缀清理 `temp_audios/`；如做批量加 action（v5.2）；否则本组合 **无接口变更** | `ffmpegProbe/index.js:580-582,137-160` |
| 15 | `docs/legal/PRIVACY_GUIDE_SETUP.md` + `docs/legal/PRIVACY_POLICY.md` | 📄 | 增加"麦克风/录音"收集项与用途；同步 24h 删除表述 | `PRD.md:280,452`、`PRIVACY_GUIDE_SETUP.md:14-17` |
| 16 | `docs/PRD.md` / `docs/TASK_PLAN.md` / `docs/DEV_LOG.md` / `docs/RELEASE_CHECKLIST.md` | 📄 | 同步 v5.1 需求（录音/作品库/卡片/批量）、验收项、发布检查项（隐私开关恢复、麦克风声明、卡片审核说明）；修正文档版本号 | `PRD.md:1`、`TASK_PLAN.md:1`、`DEV_LOG.md:1,309`、`RELEASE_CHECKLIST.md:11,18,34` |
| 17 | `docs/EDITOR_IMPL_CONTRACT.md` | 📄 | 仅在把"接入作品库/接收外部导入"写入契约时更新（不建议 v5.1 改导出格式） | `EDITOR_IMPL_CONTRACT.md:6,123,163` |
| 18 | `cloudfunctions/ffmpegProbe/config.json` / `miniprogram/sitemap.json` / `project.config.json` | ⚙️ | 本组合**无需改动**；若清理 `temp_audios/` 可评估是否新增定时 trigger（当前 `dailyCleanup` 04:00 已存在，可直接复用） | `ffmpegProbe/config.json`、`sitemap.json:1-6` |

### 4.3 实施顺序/依赖（建议）

```
P0-1 合规/文案修复（S）──┐
                          ├─▶ P0-2 作品库 + 历史迁移（M）──┬─▶ P1-3 录音导入（M）
                          │                                └─▶ P1-4 分享卡片（S/M，可与作品库并行）
                          └─▶ P2-5 批量转换（M，可顺延；依赖退出保护与作品库列表）
可选：转换预设/规格透明（S）可并行插队
```

### 4.4 建议验收口径（供 Lead 参考）

- 作品库：迁移后旧历史 1 条不少；24h 过期项显示"已清理"且不可分享；剪辑导出后作品库出现 1 条；删除/清空只影响本地；重启小程序记录仍在。
- 录音：首次录音出现麦克风授权；拒绝后可去设置；录制 10s→停止→转换为 mp3 成功；同一录音"进入剪辑"可导入并导出；切后台/来电不崩溃且有提示。
- 分享卡片：真机点"分享小程序给好友"能发出卡片；打开卡片进入首页且不自动触发转换；朋友圈分享**不出现**（本版不做）。
- 批量：3 个文件串行转换，逐个显示状态与结果；中途退出再进页面提示未完成任务；失败项可单独重试。
- 合规：恢复 `__usePrivacyCheck__` 后真机首次选文件弹隐私弹窗；隐私指引含选择文件 + 麦克风；设置页客服按钮可拉起居会话。

---

## 5. 风险与未决问题

| # | 风险/未决 | 影响 | 建议 |
| :-- | :--- | :--- | :--- |
| R1 | 隐私开关/指引配置依赖 MP 后台人工操作，代码侧无法自证 | 录音/选文件可能真机失败（历史事故 `DEV_LOG.md:53`） | 把"后台配置 + 真机复验"列为 v5.1 发布门禁；设置页加隐私指引自检提示 |
| R2 | 平台能力需真机核验：`RecorderManager` 各端格式/`onStop` 字段/中断行为；`onShareAppMessage` 封面规范；本地 storage 限额；朋友圈单页模式 | 影响实现细节与验收 | 见附录 B，v5.1 开发前 0.5~1 人日 Spike |
| R3 | 类目合规："工具>图片处理、不得传播分享/公开访问"（`PRD.md:447`）与分享卡片/录音的边界 | 审核被拒 | v5.1 只做好友卡片、不做朋友圈；提审说明"用户主动发送自有文件/邀请体验，无公开传播"；录音说明本地采集用途 |
| R4 | 24h 清理与"物理销毁"承诺不一致（失败源残留、每日 100 条上限） | 隐私承诺风险 | 云函数失败路径删源 + cleanup 分页；文案改为可证明的表述 |
| R5 | 批量/长任务前台等待与 `callFunction` 中断（`DEV_LOG.md:237`） | 批量失败率/结果丢失 | v5.1 批量上限 3 + 退出保护 + 队列持久化；完整异步任务留 v5.2 |
| R6 | 作品库只存元信息，云端文件 24h 后过期；用户可能期望"永久保存" | 预期落差 | 列表显式区分"云端 24h / 已过期"；提供"转发到聊天保存"作为留存路径（现有能力 `index.js:731-740`） |
| R7 | 文档滞后（PRD v1.3/TASK_PLAN v2.5/DEV_LOG 标题 v1.8 vs 实现 v5.0） | 规划/验收口径不一致 | v5.1 启动时先同步一次文档版本与差异（§1.11） |
| R8 | 遗留死代码（`audioConvert`/`quickstartFunctions`/quota footer/旧历史弹层） | 维护成本与误导 | v5.1 顺手清理；清理前 grep 确认无引用 |
| R9 | 无统一自动化测试入口：`scripts/` 下有 Node 测试脚本（如 `scripts/editor-spike/test_pure.js`）但没有根级 `package.json`/统一测试命令；小程序端改造无法用现成命令回归 | 验证强度不足 | 至少为 `works-store.js` 等纯函数补 Node 单测（可用本机 node：`/Users/mimi/.dsh/dsh-runtimes/dsh-plugin-desktop-primary-runtime/dependencies/node/bin/node`），并在 DEV_LOG 记录命令与结果 |

> 说明：R9 中「无自动化测试入口」指小程序端没有根级 `package.json`/测试脚本；云函数目录虽然各有 `package.json`，但没有统一测试命令。此项不阻塞本次只读侦察，但会影响后续实现验收。

---

## 附录 A：证据索引（关键结论 → 文件:行）

| 结论 | 证据 |
| :--- | :--- |
| 页面只有 3 个、无 tabBar、无隐私开关 | `miniprogram/app.json:1-17` |
| 单文件选择 | `miniprogram/pages/index/index.js:262-331`（`count:1` 在 265） |
| 状态机 4 态 | `index.js:34-35`；转移 `302, 503-506, 521-524, 571-584, 608, 852` |
| 50MB/时长预检 | `index.js:272-281, 484-499`；云端 `cloudfunctions/ffmpegProbe/index.js:34-35, 523, 526-532` |
| 上传/云函数调用 | `index.js:503-539`；`ffmpegProbe/index.js:489-604` |
| 结果字段/试听/平台可播 | `index.js:541-590, 620-705` |
| 历史写入/读取/上限 20 | `index.js:869-884, 593-603` |
| 历史仅分享、过期才提示 | `index.wxml:488-501`；`index.js:805-827` |
| 剪辑导出不持久化 | `editor.js:4443-4476`；唯一 storage 写入 `editor.js:407` |
| 编辑器多选串行导入（可复用队列） | `editor.js:652-670, 691-816` |
| 编辑器导出 mp3 硬编码 | `editor.js:4343-4348, 4478-4483`；`editor.wxml:1314`；`ffmpegProbe/index.js:327,374,385,207-217` |
| 分享只有文件转发，无卡片/朋友圈 | `index.js:707-740, 805-827`；`editor.js:4661-4692`；grep `onShareAppMessage/onShareTimeline` 0 命中 |
| 配额关闭、quota 死代码 | `ffmpegProbe/index.js:15-17,507-510,576-577,594`；`index.js:96,579`；`index.wxml:463-465`；`settings.wxml:5` |
| 24h 清理（每日 100 条、仅 converted_files） | `ffmpegProbe/index.js:137-160`；`config.json` triggers |
| 失败不删源/源文件泄漏 | `ffmpegProbe/index.js:580-582`（仅成功删源）；客户端上传 `index.js:509` |
| 隐私弹窗实现但开关缺失 | `index.js:115-148`；`index.wxml:509-523`；`app.json:1-17`；`DEV_LOG.md:53`；`PRIVACY_GUIDE_SETUP.md:26,36` |
| 设置页陈旧/无客服/清缓存 | `settings.js:3,24-30,35,60`；`settings.wxml:10-16,24` |
| 文档漂移（页面/录音/历史/额度/格式） | `PRD.md:60,118-124,136-142,173-178,194-199,267-281,296,315,447`；`TASK_PLAN.md:64-80,317-321,339`；`README.md:3`；`DEV_LOG.md:1,53,64,221,237,309` |
| 编辑器格式规划 | `MUSIC_EDITOR_DESIGN.md:478,547,752`；`PRD.md:315`；`EDITOR_IMPL_CONTRACT.md:6,123` |
| 平台约束（上传需前台/限时链接） | `CLIENT_CAPABILITIES.md:344,487`；`DEV_LOG.md:79,237` |

## 附录 B：平台约束待核验清单（非仓库证据，v5.1 Spike 前需官方文档/真机确认）

| # | 项 | 待确认内容 | 用途 |
| :-- | :--- | :--- | :--- |
| B1 | `RecorderManager` | 各基础库/平台支持的 `format`（aac/mp3/wav）；`onStop` 是否返回 `fileSize/duration`；后台/来电中断行为；最长 10min 参数口径 | 录音导入实现与降级策略 |
| B2 | `scope.record` 授权 | 首次授权 UI、拒绝后的 `wx.openSetting` 路径、隐私指引"麦克风"声明与接口对应关系 | 权限引导与审核材料 |
| B3 | `onShareAppMessage` | 卡片 `imageUrl` 尺寸/大小/格式要求；`path` 参数限制；按钮 `open-type="share"` 与菜单入口差异 | 分享卡片实现 |
| B4 | `onShareTimeline` | 是否需 `wx.showShareMenu({menus:['shareTimeline']})`；单页模式可用 API 清单；朋友圈分享对审核类目的影响 | 决定是否永远不做朋友圈 |
| B5 | 本地存储 | `wx.setStorage` 单 key / 总量上限（官方口径 1MB/10MB，需复核） | 作品库容量上限/是否需分片 |
| B6 | `wx.shareFileMessage` | 文件大小上限、支持格式、PC/手机差异 | 历史/作品库转发兜底 |
| B7 | 云函数超时 | 当前 60s 是否仍是上限（`DEV_LOG.md:34,37`） | 批量/长音频策略 |
| B8 | 临时链接 | `getTempFileURL` 私有链接有效期（文档 10min/2h 口径不一，`CLIENT_CAPABILITIES.md:487-488`） | 不持久化 `downloadUrl` 的依据 |

---

*本报告为只读侦察产出，所有推荐均需 Lead 结合 v5.1 目标、合规与排期拍板；未验证项已在附录 B 单列，未执行项未写成已通过。*
