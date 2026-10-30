# 音频格式转换小程序 · 任务计划与技术方案（TASK_PLAN v2.5）

| 项目 | 内容 |
| :--- | :--- |
| 项目名 | 音频格式转换（暂定名 AudioConvert，可在小程序后台修改） |
| 文档版本 | v2.5（2026-10-28，路线 A 结论 + V1.1 在线音乐编辑详细设计） |
| 负责人 | Lead（产品 / 架构 / 全栈） |
| 状态 | **个人主体、公开发布、免费**；路线 A（云函数 + 静态 FFmpeg）**有条件通过**，转换主链路原型可端到端；**V1.1「在线音乐编辑」详细设计 v0.1 已完成待评审**（见 [MUSIC_EDITOR_DESIGN](./MUSIC_EDITOR_DESIGN.md)）；v1.0 剩余：备案/隐私指引/类目/真机全流程 |
| 关联文档 | [PRD](./PRD.md) · [可行性研究](./FEASIBILITY.md) · [开发记录](./DEV_LOG.md) · [文档索引](./README.md) |

> 说明：`docs/archive/` 保存了工作区中其他 AI 工具/早期版本生成的草稿；当前版本以本文档为准。写完会设置为只读，避免被并发工具覆盖。

---

## 0. 结论摘要（先读）

1. **端内转码不可行**：单包 2MB、分包总量 30MB；`WXWebAssembly.instantiate` 只能加载代码包内文件，无多线程/大内存保证。端内只做导入、播放、参数、进度。
2. **客户端固定方案**：原生小程序；基础库 ≥2.23.0（`callContainer` 要求）；**异步任务**——申请上传票据 → 直传 → 建任务 → 轮询；因为 `callContainer` 的 `timeout` 上限 15s，不能同步长请求。
3. **服务端两条路线**：
   - **路线 A（优先验证，成本最低）**：云开发云函数 + 静态/精简 FFmpeg + 云存储 + 云数据库；
   - **路线 B（兜底）**：微信云托管 + Docker FFmpeg + 对象存储。
   客户端接口契约不变，服务端实现可替换。
4. **路线 A 进展**：已下载 Linux x86_64 静态 FFmpeg 7.0.2（76MB，zip≈28MB，含 mp3/aac/flac/vorbis/opus/amr/ape/wma）；已创建验证函数 `cloudfunctions/ffmpegProbe`；本机 Docker（1 CPU）**复测**：5min WAV 2.6s、FLAC 2.7s、MP3 320k 8.6s、M4A（默认 AAC）80.4s / **`-aac_coder fast` 20.2s**；30min MP3 192k 40.8s、FLAC 14.1s、WAV 10.3s。**结论：路线 A 对 mp3/wav/flac 可行（30min MP3 接近 60s，偏紧）；M4A 在 30min 时长下大概率超时，需限制时长（建议 ≤10min）或改走 B/优化编码器**。**路线 A 验证结论（2026-10-27 23:45）**：包体 28.6MB 部署 ✅；FFmpeg 在云函数可运行 ✅（需复制到 /tmp + chmod）；超时已调至 60s ✅；云端实测 30min FLAC 13.6s、WAV 9.2s、5min FLAC 2.4s ✅；30min MP3 在 60s 内未返回（调用挂起，判断超时风险高）；小片段外推 M4A/OGG 30min >160s ❌。**结论：A 路线“有条件通过”，需按格式限制时长：WAV/FLAC ≤30min；MP3 ≤15~20min；M4A/OGG ≤5~8min；若必须 30min 全格式则走 B（云托管）。**

**实现进展（2026-10-28 00:10）**：已在 `cloudfunctions/ffmpegProbe` 内实现正式 `convertFile`（云存储下载 → ffmpeg → 上传 → 返回 fileID/下载 URL/时长/费用），并把前端 `pages/index` 的云函数调用从 `audioConvert` 切换到已配置 60s 超时的 `ffmpegProbe`；用 3s 样本完成 **上传→6 种格式转换→返回结果** 的 E2E 验证（mp3/wav/flac/m4a/ogg/aac 均成功，单次 ~1s）。仍待：内容安全权限/回调、函数正式改名；**已完成进度（2026-10-28 00:20）**：每日 5 次配额（云数据库 quota）、24h 清理（converted_files + cleanup action + 定时触发器配置）、隐私授权弹窗（`__usePrivacyCheck__` + 自定义弹窗）均已实现；配额/清理已实测通过。内容安全 `mediaCheckAsync` 仍为 -604101（个人主体/云调用权限未开通），代码已加开关 `MEDIA_CHECK_ENABLED=false`，待权限开通后开启；设置页（协议/隐私/投诉/缓存/关于）已实现并验证。**真实 5 分钟音频 E2E（2026-10-28 02:47）**：通过 UI 上传 6.87MB MP3 → 云端转码 → SUCCESS，耗时 15.1 秒，结果大小 6.87MB；配额/时长提示已接入。**发布准备（03:38）**：新增隐私政策/用户协议/版权投诉指引草稿、发布前检查清单；已生成真机预览二维码（包大小 1.2MB）。**03:46 真机问题定位**：`chooseMessageFile:fail api scope is not declared in the privacy agreement`，原因是后台隐私指引未声明该接口；已临时移除 `__usePrivacyCheck__` 供测试，正式修复步骤见 `docs/legal/PRIVACY_GUIDE_SETUP.md`，发布前必须恢复开关并配置隐私指引。**03:56 资源体积**：删除模板遗留 214K/305K 图片与未使用 example 页/组件，miniprogram 96K、预览包 53KB，满足“图片/音频 ≤200K”代码质量规则。**03:58 历史分享**：24h 清理后历史 fileID 失效，已补过期提示/失败回调，避免静默失败。**04:00 取消次数限制**：测试阶段 `QUOTA_ENFORCED=false`，每日 5 次限制暂停（配额代码保留，可切回），设置页文案同步。**04:24 分享修复**：真机报 `can only be invoked by user TAP gesture`，已改为转换后预下载缓存本地文件，分享按钮同步调用；历史分享两段式（先准备再转发）；手机端保存说明“转发到文件传输助手后保存”。**04:31 保存修复**：`saveFileToDisk` 仅 PC 可用，已按平台分流；手机走微信转发，开发者工具明确提示不可保存，PC 失败兜底复制链接。
5. **导入只有两条路**：微信会话文件（`wx.chooseMessageFile`，2.5.0+）或录音（≤10min）。小程序**不能读取手机本地文件**，首页必须引导“先发给文件传输助手再选”。
6. **试听格式要收敛**：iOS `InnerAudioContext` 不支持 flac/ogg/amr/ape/wma；默认输出 **mp3/m4a/wav**，flac/ogg 仅高级并标注平台限制。
7. **手机端不能直接保存**：`saveFileToDisk` 仅 PC；`openDocument` 不支持音频；导出走“转发给好友/文件传输助手 + PC 保存 + 2h 临时链接”。
8. **内容安全**：`mediaCheckAsync` 音频 ≤10MB、支持 mp3/aac/ac3/wma/flac/vorbis/opus/wav（不支持 amr/ape）、异步结果最长 30min；按时长自适应生成 ≤10MB mp3 代理（30min@32k 单声道≈7.2MB），创建任务时并行送检，risky 删除并阻断导出。
9. **合规**：类目「工具 > 图片处理」（不得公开传播）；个人主体可备案/发布工具类、**不可虚拟支付**；必须隐私指引、版权声明、侵权投诉入口；不提供公开链接/曲库/社区。
10. **MVP 边界**：单文件 ≤50MB、时长 ≤30min；输入 10 种；输出 mp3/m4a/wav 默认 + flac/ogg 高级；**测试阶段不限次数**（`QUOTA_ENFORCED=false`，可恢复每日 5 次）；云文件 24h 清理；历史本地 storage。
11. **不引入 MySQL**：任务状态用对象存储/云数据库 JSON + 单 worker；额度计数用 JSON + 进程内互斥；量上来再换 Redis/MySQL。
12. **工期**：路线 A 验证通过后约 **12~14 个有效人日**；若走 B 约 **14~17 人日**。备案材料 **11-02 前提交**，审核时间另计。
13. **V1.1 在线音乐编辑设计已完成**（v0.1 待评审）：云端 FFmpeg 渲染 + 端内近似预览；10min 编辑上限、导出扣次、两段式任务 + 轮询；1 CPU 实测 10min 最坏组合 22.7s。详见 [MUSIC_EDITOR_DESIGN](./MUSIC_EDITOR_DESIGN.md)。

---

## 1. 目标与成功标准

### 1.1 产品目标

> 微信里 3 步完成音频格式转换：**选文件 → 选格式 → 转换并可试听/转发**。

### 1.2 MVP 成功标准

| 指标 | 目标 | 口径 |
| :--- | :--- | :--- |
| 任务成功率 | ≥97% | 排除用户取消 |
| 端到端 P95 | ≤60s | 10MB/5min 音频、4G、含上传+排队+转码+下载 |
| 首屏可交互 | ≤1.5s | 中端安卓真机冷启动 |
| 格式矩阵通过率 | 100% | §10.2 |
| 崩溃率 | <0.5% | 小程序后台异常 |
| 审核 | 一次通过 | 类目/备案/隐私/内容安全齐全 |

### 1.3 非目标

- 不读取手机本地文件、不做端内 FFmpeg/WASM。
- 不做曲库、在线音乐、公开分享链接、社区、公开播放。
- 不做批量转换、视频转音频、变声/降噪；**「剪辑/拼接/淡入淡出/铃声模板」列为 V1.1**，设计与边界见 [MUSIC_EDITOR_DESIGN](./MUSIC_EDITOR_DESIGN.md)。
- 不做广告、会员、虚拟支付（用户决策：完全免费）。

---

## 2. 范围与版本

| 模块 | MVP v1.0 | V1.1 | V2 |
| :--- | :--- | :--- | :--- |
| 导入 | 聊天文件、文件传输助手、录音（≤10min） | 历史再次转换 | 收藏/链接 |
| 输入 | mp3/wav/m4a/aac/flac/ogg/amr/ape/wma/aiff（ffprobe 为准） | opus 等 | 更多 |
| 输出 | mp3/m4a/wav（默认）；flac/ogg 高级 | amr、aac 裸流 | 自定义模板 |
| 参数 | 3 档 MP3 预设 + M4A/WAV 默认 + 高级（码率/采样率/声道） | （编辑）整体淡入淡出/音量/变速；响度标准化 P2 | 变调/降噪/多轨 |
| 任务 | 异步单任务、进度、取消、失败重试 | 批量 | 并发 |
| 试听 | 源/结果；平台限制提示 | 波形/近似预览（编辑） | 精确预览/多轨试听 |
| 导出 | 转发、PC 保存、2h 临时链接 | 音乐剪辑成片导出（复用同一结果链路） | 云端空间/工程文件 |
| **音乐编辑** | — | **裁剪/删除/拼接/淡入淡出/音量/变速/配乐/模板（详见设计文档 M9）** | 选段级效果/多轨/降噪/变调 |
| 历史 | 本地 20 条 | 云端历史 | 跨端 |
| 额度 | 测试阶段不限次数（`QUOTA_ENFORCED=false`，可恢复每日 5 次） | 保持免费；额度与转换共享可配 | 未来主体升级再评估 |
| 安全 | 内容安全、24h 清理、限流 | 举报/黑名单 | 风控 |

---

## 3. 关键约束与官方依据（摘要）

| # | 约束 | 数值/结论 | 来源 |
| :--- | :--- | :--- | :--- |
| C1 | 代码包 | 主包/单分包 ≤2MB；总分包 ≤30MB（服务商 20MB） | [分包加载](https://developers.weixin.qq.com/miniprogram/dev/framework/subpackages.html) |
| C2 | WXWebAssembly | 2.13.0+；仅代码包内路径；线程/内存未承诺 | [WASM](https://developers.weixin.qq.com/miniprogram/dev/framework/performance/wasm.html) |
| C3 | 本地文件 | 只能访问 `wxfile://`；无手机文件选择器；临时文件 4GB；缓存+用户文件 200MB | [文件系统](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/file-system.html) |
| C4 | chooseMessageFile | 2.5.0+；count 0~100；仅会话文件；extension 仅 type=file 有效 | [API](https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.chooseMessageFile.html) |
| C5 | 录音 | aac/mp3/wav/pcm；最长 600000ms | [RecorderManager](https://developers.weixin.qq.com/miniprogram/dev/api/media/recorder/RecorderManager.start.html) |
| C6 | 播放 | mp3/m4a/aac/wav 双端支持；iOS 不支持 flac/ogg/amr/ape/wma；aiff/caf 仅 iOS；需 destroy | [InnerAudioContext](https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/InnerAudioContext.html) |
| C7 | 导出 | `shareFileMessage` 2.16.1+ 仅点击；`saveFileToDisk` 仅 PC；`openDocument` 不支持音频 | [shareFileMessage](https://developers.weixin.qq.com/miniprogram/dev/api/share/wx.shareFileMessage.html) |
| C8 | 网络 | downloadFile ≤200MB、默认 60s；并发 ≤10；服务器域名必须 HTTPS+ICP | [网络](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html) |
| C9 | callContainer | 基础库 ≥2.23.0；**timeout 最大 15s**；请求 100KiB、回包 1000KiB；免域名、自动带 openid | [云托管调用](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/development/call/mini.html) |
| C10 | 云托管 | 60s 请求/20MB 包体（CloudBase 口径，待实测）；0.25核0.5G~16核32G；缩容至 0；无持久盘；UTC；构建 >10min 易失败 | [云托管](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/basic/intro.html) |
| C11 | 云托管对象存储 | 小程序可 uploadFile(config.env)/downloadFile/getTempFileURL；src 支持 fileID；临时链接默认 86400s | [对象存储](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/guide/storage/api.html) |
| C12 | 消息推送/开放接口 | 云托管可配置消息推送；开放接口服务免 token 调 api.weixin.qq.com（白名单）；30s/32MiB | [消息推送](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/guide/weixin/push.html) · [开放接口](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/guide/weixin/open.html) |
| C13 | 内容安全 | mediaCheckAsync：音频 ≤10MB；格式 mp3/aac/ac3/wma/flac/vorbis/opus/wav；异步 ≤30min；2000 次/分；需 openid 近 2h 访问 | [API](https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_mediacheckasync.html) |
| C14 | 云开发 | 云函数 /tmp 512MB、无状态、Linux CentOS 7.2 系；代码包/超时官方未载明（路线 A 需实测）；免费环境未上线可用 | [云函数机制](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/functions/mechanism.html) · [计费](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/billing/Billing_Instructions.html) |
| C15 | 隐私 | chooseMessageFile→“收集你选中的文件”；录音→“访问你的麦克风”；隐私弹窗与后台指引 | [隐私指引](https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/miniprogram-intro.html) |
| C16 | 类目/备案 | 工具>图片处理覆盖音频本地制作剪辑、不得传播/公开；个人可备案（上限 5）；文娱音乐需许可证 | [类目](https://developers.weixin.qq.com/miniprogram/product/material/) · [备案](https://developers.weixin.qq.com/miniprogram/product/record/record_guidelines.html) |

---

## 4. 技术架构

### 4.0 路线 A/B 验证门（用户决策 2026-10-27）

| 路线 | 方案 | 成本 | 验证项 | 通过条件 |
| :--- | :--- | :--- | :--- | :--- |
| **A（优先）** | 云开发云函数 + 静态/精简 FFmpeg + 云存储 + 云数据库 | 未上线免费环境；上线后 19.9 元/月 + 资源点 | 包体/超时/内存/冷启动/50MB·30min 转码（SP-12） | 能部署；单次转码在云函数超时内完成；异步任务可落地；成本可接受 |
| **B（兜底）** | 微信云托管 + Docker FFmpeg + 对象存储 | 首环境 3 个月免费额度；之后约 10~50 元/月 | 镜像/调用/上传/消息推送（SP-01~SP-11） | 端到端可用 |
| C（不建议） | 第三方转码 API / 自建服务器 | 隐私/备案/成本差 | — | — |

**判定（2026-10-27 实测后）**：A 路线“有条件通过”——WAV/FLAC 30min 可、MP3 需限 15~20min、M4A/OGG 需限 5~8min；若产品要求 30min 全格式，则必须 B。待产品确认限制后冻结。

> 当前（2026-10-27 23:19）：个人主体、公开发布、免费；云开发环境 `cloud1-d0g1pwjogd2f39be2` 已开通并写入 `miniprogram/envList.js`/`app.js`；测试函数 `cloudfunctions/ffmpegProbe` **已部署成功（28.6MB，Active，Nodejs16.13，默认 timeout=3s）**；本机 Docker 复测数据见 [DEV_LOG](./DEV_LOG.md) §3.1。**23:27 云端实测（3s 超时内可测部分）：FFmpeg 在云函数内可运行（需复制到 /tmp 并 chmod +x）；Node16.13、1 CPU、975MB、/tmp 可写；按 30s 片段外推：WAV≈12.6s、FLAC≈29.8s、MP3≈54s（偏紧）；M4A/OGG 10s 片段约 0.9s，30min 外推≈161s，**A 路线下 m4a/ogg 只能支持短文件**。下一步需把云函数超时调到 60s 完成 5/30min 实测。

### 4.1 总体架构（以路线 B 为例；A 用云函数替代云托管 + 对象存储）

```text
┌──────────────────── 微信小程序（原生 WXML/WXSS/JS） ────────────────────┐
│ 页面：index(导入/配置) · task(进度) · result(结果) · history · settings    │
│ 组件：audio-player · format-grid · param-sheet · step-progress · privacy  │
│ 工具：cloud.js · task.js · audio.js · format.js · history.js · track.js   │
└──────────┬────────────────────────────────────────┬─────────────────────┘
           │ 1) 申请上传票据 → uploadFile(config.env)  │ 3) callContainer 轮询
           ▼                                        ▼
┌────────────────── 服务端（B：微信云托管 / A：云开发云函数） ──────────────────┐
│ 存储：B=对象存储 COS；A=云存储                                              │
│ 接口：POST /v1/upload-tickets → upload → POST /v1/tasks → GET /v1/tasks/:id │
│       POST /v1/tasks/:id/cancel · /internal/message · /internal/cleanup      │
│ Worker：下载 → ffprobe → ffmpeg → 上传 → 更新任务；单 worker/并发 1            │
│ 内容安全：开放接口/云调用 mediaCheckAsync + 消息推送回调                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 组件职责

| 组件 | 职责 | 备注 |
| :--- | :--- | :--- |
| 小程序端 | 导入、校验、上传、轮询、播放、下载/转发、历史、隐私 | 不承担转码 |
| 文件存储 | 输入/输出/任务 JSON/代理 | 上传票据绑定 openid；24h 清理 |
| 计算（A/B） | 任务 API + Worker + FFmpeg | A：云函数/云数据库；B：云托管/对象存储 |
| 内容安全 | 送检与回调落库 | mediaCheckAsync + 消息推送 |
| 云开发（A） | 云函数、云存储、云数据库、云调用 | 路线 A 主底座 |
| 云托管（B） | 容器、对象存储、消息推送、开放接口 | 路线 B 主底座 |

### 4.3 任务状态机

```text
IDLE → UPLOADING → QUEUED → PROBING → TRANSCODING → UPLOADING_RESULT → SUCCEEDED
                                      ↘ FAILED（可重试）
                    ↘ CANCELLED
SUCCEEDED → SAFETY_PENDING → SAFETY_PASS / SAFETY_RISKY（异步，最长 30min）
```

- 客户端以服务端状态为准；轮询 1.5s 起退避至 3s；失败 3 次进入“网络异常”。
- 任务 5 分钟未推进 → `FAILED/TIMEOUT`；重试最多 1 次；`expiresAt=createdAt+24h`。

### 4.4 关键数据流

1. 用户选文件 → 校验大小/扩展名 → `POST /v1/upload-tickets`（服务端按 openid 生成 ticket 与 cloudPath）→ `wx.cloud.uploadFile` → fileID。
2. `POST /v1/tasks`：服务端校验 ticket.openid==header openid、fileID==ticket.cloudPath，写任务 JSON（含 openid），入队，返回 `{taskId,pollAfterMs}`。
3. Worker：下载 → ffprobe 校验 → ffmpeg（≤45s）→ 上传输出 → 更新 JSON。
4. 客户端轮询 `GET /v1/tasks/:id`：返回状态/进度/输出 fileID/安全状态。
5. 成功后：fileID 直接 `InnerAudioContext` 试听；转发走 `downloadFile` + `shareFileMessage`；PC 走 `saveFileToDisk`；复制链接走 `getTempFileURL`（按 2h 申请）。
6. 送检：创建任务时立即对输入发起（与转码并行）；≤10MB 且格式支持用输入临时 URL；否则按时长自适应生成 ≤10MB mp3 代理；回调写回任务 JSON。

### 4.5 内容安全流程

```text
创建任务 → 立即送检（并行）→ mediaCheckAsync（≤10MB，格式白名单）
        → trace_id 落库 → 消息推送 wxa_media_check 回调
        → pass：无感；risky：删除输出 + 标记 blocked + 阻断后续导出；review：保守/人工
```

> 异步检测最长 30min；MVP 允许检测结果前试听/下载，命中后删除。该窗口策略用户已确认接受，需在协议与提审材料披露。

### 4.6 清理与保留

- 输入转码后即删；输出保留 24h；任务 JSON 48h。
- 优先对象存储/云存储生命周期规则；否则每次建任务顺带清理 + 外部定时 `/internal/cleanup`。

---

## 5. 功能规划（模块）

| 编号 | 功能 | 优先级 | 页面/组件 | 实现要点 |
| :--- | :--- | :---: | :--- | :--- |
| F-01 | 会话文件导入 | P0 | index | chooseMessageFile；扩展名初筛；大小/时长提示 |
| F-02 | 录音导入 | P1 | index | RecorderManager；≤10min；麦克风授权 |
| F-03 | 文件信息/预检 | P0 | file-card | 名称/大小/格式；ffprobe 服务端校验 |
| F-04 | 源音频试听 | P0 | audio-player | InnerAudioContext；iOS 格式提示；destroy |
| F-05 | 格式/参数配置 | P0 | index + param-sheet | mp3/m4a/wav 默认；flac/ogg 高级；3 档 MP3 预设 |
| F-06 | 上传任务 | P0 | cloud.js | 上传票据 + uploadFile 进度/重试/取消 |
| F-07 | 异步转码轮询 | P0 | task.js | 1.5s→3s 退避；页面隐藏暂停；恢复 |
| F-08 | 进度与文案 | P0 | step-progress | 上传/排队/转码/安全/完成 |
| F-09 | 结果试听/对比 | P0 | result | 源/结果切换；大小对比 |
| F-10 | 转发给好友 | P0 | result | downloadFile + shareFileMessage（点击触发） |
| F-11 | PC 保存/临时链接 | P1 | result | saveFileToDisk；getTempFileURL（2h） |
| F-12 | 历史记录 | P1 | history | 本地 20 条；过期标记；重试/转发/清空 |
| F-13 | 设置/协议/投诉 | P1 | settings | 协议、隐私、版权、投诉、关于 |
| F-14 | 隐私授权 | P0 | privacy-popup | 后台指引一致；未同意不可用 |
| F-15 | 内容安全 | P0 | 服务端 | 并行送检、回调落库、risky 删除/阻断 |
| F-16 | 额度/限流 | P0 | 服务端 | 每日 5 次；并发 1；失败返还 |
| F-17 | 错误与降级 | P0 | utils/errors | 错误码映射；重试；不白屏 |
| F-18 | 埋点 | P1 | track.js | 核心漏斗 |
| F-19 | 分享卡片 | P2 | 页面 | 仅小程序卡片，不公开链接 |
| F-20 | 广告位 | — | — | 用户决策免费，不做广告 |

### 5.1 V1.1 音乐编辑（设计见 [MUSIC_EDITOR_DESIGN](./MUSIC_EDITOR_DESIGN.md)）

| 编号 | 功能 | 优先级 | 页面/组件 | 实现要点 |
| :--- | :--- | :---: | :--- | :--- |
| F-21 | 导入与分析（多选 ≤5） | P0 | editor / analyzeAudio | 上传 → ffprobe → 50ms peaks → playable 标记；不生成代理 |
| F-22 | 波形时间轴 | P0 | waveform-timeline | canvas 2d 视口 + view 覆盖层；手势/缩放/选区/0.1s 微调 |
| F-23 | 编辑操作（裁剪/删除/排序/撤销） | P0 | editor / EditPlan | 非破坏 JSON；片段列表；草稿恢复 |
| F-24 | 效果（整体淡入淡出/音量） | P0 | tool-sheet | 0～5s；-24～+12dB；变量作用于成片 |
| F-25 | 导出任务（mp3/wav/flac） | P0 | create/run/getEditTask | 快剪 copy 白名单；重编码 filtergraph；额度预占/返还 |
| F-26 | 拼接/配乐/变速/模板 | P1 | editor + render | 多源 concat；BGM 循环/偏移/音量；atempo；铃声 ≤40s |

---

## 6. 客户端设计

### 6.1 页面

| 页面 | 路由 | 职责 |
| :--- | :--- | :--- |
| 首页 | `pages/index/index` | 导入、文件信息、试听、格式参数、发起任务 |
| 任务页 | `pages/task/task` | 上传/排队/转码进度、取消、失败重试 |
| 结果页 | `pages/result/result` | 试听、大小对比、转发、PC 保存、临时链接 |
| 历史页 | `pages/history/history` | 本地历史、重试/转发/清空 |
| 设置页 | `pages/settings/settings` | 协议、隐私、版权、投诉、关于 |
| 隐私弹窗 | `components/privacy-popup` | 首次授权 |

### 6.2 工具模块

- `utils/cloud.js`：SDK 初始化（env 可空，环境 ID 走接口 config.env）、票据、上传、callContainer 封装、下载。
- `utils/task.js`：创建/轮询/恢复/超时/退避。
- `utils/audio.js`：播放器工厂/平台能力/销毁。
- `utils/format.js`：白名单/预设/参数校验/体积估算。
- `utils/history.js`：20 条本地记录/过期清理。
- `utils/track.js`：埋点。

### 6.3 兼容/体验规则

| 场景 | 规则 |
| :--- | :--- |
| iOS 不支持格式试听 | 提示“需先转 MP3”，提供快捷转换 |
| 输出默认 | MP3 192k；M4A（iOS 友好）；WAV 二次确认体积 |
| >50MB | 本地拦截 |
| >30min | 服务端 ffprobe 拒绝并返还额度 |
| 弱网 | 上传重试/取消；轮询自动重试 |
| 页面卸载 | 销毁播放器/定时器；保留 taskId 恢复 |
| PC | 显示“保存到电脑”；转发仍可用 |
| 基础库 | 后台最低 2.23.0；低版本提示升级 |
| 包体 | 主包 ≤1.5MB；SVG/WebP；不引重型 UI 库 |

---

## 7. 服务端设计（A/B 共用契约）

### 7.1 接口

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| POST | `/v1/upload-tickets` | `{fileName,fileSize,ext}` → `{ticketId,cloudPath,expiresAt}` |
| POST | `/v1/tasks` | `{ticketId,fileID,fileName,fileSize,target,clientToken}` → `{taskId,pollAfterMs}` |
| GET | `/v1/tasks/:id` | 状态/进度/输出/安全 |
| POST | `/v1/tasks/:id/cancel` | 取消 |
| GET | `/v1/config` | 能力/限额/预设（可选） |
| POST | `/internal/message` | 消息推送回调（wxa_media_check） |
| POST | `/internal/cleanup` | 过期对象清理（内部鉴权） |
| GET | `/healthz` | 健康检查 |

- 鉴权：从平台注入 header 取 openid；票据/任务/fileID 三者归属校验；服务公网关闭。
- 请求/响应小（fileID/元信息）；文件走存储直传。
- 幂等：clientToken 10 分钟；限流：日 5 次、分钟 3 次、并发 1；计数存 `quotas/{openid}/{date}.json`（进程内互斥）。
- 错误码：`INVALID_FILE`/`UPLOAD_FAILED`/`TASK_NOT_FOUND`/`FILE_EXPIRED`/`UNSUPPORTED_FORMAT`/`FILE_TOO_LARGE`/`DURATION_TOO_LONG`/`DECODE_FAILED`/`TRANSCODE_TIMEOUT`/`OUTPUT_TOO_LARGE`/`RATE_LIMITED`/`QUOTA_EXCEEDED`/`SAFETY_RISKY`/`SERVICE_BUSY`/`STORAGE_ERROR`/`INTERNAL`。

### 7.2 路线 A（云函数）要点

- 函数含 `bin/ffmpeg`（静态 76MB，zip≈28MB）；Node 20；`/tmp` 512MB。
- 任务状态：云数据库集合 `tasks`（或云存储 JSON）；单实例/单函数串行或延迟/定时触发；客户端轮询。
- 内容安全：`cloud.openapi.security.mediaCheckAsync`（云调用，需 config.json permissions）+ 云开发消息推送接收结果。
- 清理：云函数定时触发器（每日）+ 建任务顺带清理。
- **待实测**：代码包上限、超时上限、冷启动、云函数单次 30min 转码可行性、并发/额度。

### 7.3 路线 B（云托管）要点

- Dockerfile：node:20-slim + apt ffmpeg（或自编译含 amr）；镜像 <500MB；构建 <10min。
- 服务：Express + 进程内单队列 Worker；对象存储 COS；开放接口服务 + 消息推送。
- 配置：最小实例 0、最大 1（关键期最小 1）；0.5核1G 起；openid header；公网关闭。
- 任务补偿：GET/POST 惰性判定 `updatedAt>5min` → FAILED/TIMEOUT；`leaseAt/attempts`。
- 清理：COS 生命周期优先；否则启动/每日清理。

---

## 8. 数据模型

### 8.1 任务记录

```json
{
  "taskId": "t_xxx", "openid": "oXXX", "createdAt": 0, "updatedAt": 0,
  "status": "transcoding", "progress": 55, "ticketId": "up_xxx",
  "input": {"fileID": "cloud://.../in/t_xxx.flac", "name": "demo.flac", "size": 12345678, "format": "flac", "duration": 245.6},
  "target": {"format": "mp3", "bitrate": 192, "sampleRate": 44100, "channels": 2},
  "output": {"fileID": "cloud://.../out/t_xxx.mp3", "size": 5678901, "format": "mp3"},
  "safety": {"traceId": "", "status": "pending", "suggest": ""},
  "error": null, "leaseAt": 0, "attempts": 1, "expiresAt": 0
}
```

### 8.2 本地历史

`taskId, fileName, inputFormat, outputFormat, inputSize, outputSize, createdAt, expiresAt, outputFileID, status, safetyStatus`（最多 20 条）。

---

## 9. WBS 与排期

### 9.1 里程碑

| 里程碑 | 内容 | 产出 | 计划 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| M0 | 立项/文档/环境盘点 | 计划/PRD/可行性/开发记录 | 10-27 | ✅ |
| M1 | 用户决策 | 决策记录 | 10-27 | ✅ |
| G0 | 合规前置：备案材料提交、类目/隐私 | 备案受理/通过 | 11-02 前提交 | ⏳ |
| M2a | 路线 A 验证：云函数 + 静态 FFmpeg | 通过/不通过结论 | 10-29~10-30 | ✅ 有条件通过（需格式限长） |
| M2b | 路线 B 验证（仅 A 失败） | B Spike 报告 | 10-31~11-02 | ⏳ |
| M3 | 工程基建：删 quickstart、服务骨架、存储/环境 | 可部署骨架 | 11-03~11-04 | ⏳ |
| M4 | 核心链路：导入→上传→任务→轮询→结果→转发 | 端到端 | 11-05~11-10 | ⏳ |
| M5 | 功能完备：历史/设置/额度/错误/内容安全/PC | 完整版 | 11-11 | ⏳ |
| M6 | 测试：真机矩阵/弱网/大文件/安全/合规 | 报告 | 11-12~11-13 | ⏳ |
| M7 | 提审/上线（备案通过后） | 线上 v1.0 | 11-16 提审 | ⏳ |
| M8 | V1.1：批量/amr/波形（保持免费） | v1.1 | 上线后 2~4 周 | ⏳ |
| M9.0a | 真机 Spike（S1～S13 + E1～E11 + E12 五源） | Spike 报告 + 5 源结论 | v1.0 M4 后 | +3~5d |
| M9.0b | 设计评审/v0.3 契约冻结 | 评审通过 | 并行/之后 | +0.5~1d |
| M9.1 | 契约/分析链路（peaks + upload ticket） | analyzeAudio + 单测 | +1.5d | ⏳ |
| M9.2 | 编辑器 P0（波形/预览/裁剪/铃声/单段导出） | 端到端导出 | +3.5d | ⏳ |
| M9.3 | 拼接/配乐/模板/变速（P1） | 功能完备 | +3.0d | ⏳ |
| M9.4 | 测试/合规/提审 | v1.1 上线 | +2.5d | ⏳ |

> **进展（2026-10-28）**：已先落地**音乐剪辑 MVP v2**（与格式转换同小程序、tabBar 双入口）：多源导入（≤5）、片段时间线（上移/下移/分割/裁剪/删除选区/撤销）、**每片段独立缓入缓出**、跨源预览、全局音量、导出 MP3；云函数 v2 `renderEdit`（同源 asplit + 每片 afade + concat）与 `analyzeAudio`；devtools E2E（2 源 3 片 5s 成片，RMS 包络验证 fade/顺序）与格式转换回归通过。剩余差异（无 upload ticket、无两段式、无 BGM/变速/多格式/模板、仅 mp3）见 [MUSIC_EDITOR_DESIGN §19](./MUSIC_EDITOR_DESIGN.md)。

### 9.2 WBS（估时含 AI 辅助）

| 工作流 | 任务 | 估时 |
| :--- | :--- | :--- |
| 产品/设计 | 决策/PRD/流程/文案/提审材料/协议 | 2.0d |
| 前端 | 工程重建、导入、播放、参数、上传、轮询、结果、历史、设置、错误、隐私 | 4.5d |
| 服务端 A | 云函数转码、任务、内容安全、清理、额度 | 3.5d |
| 服务端 B（如启用） | 云托管镜像/服务/对象存储/消息推送 | +2.5d |
| 云资源 | 环境、存储、数据库、内容安全、监控 | 0.5d |
| 测试 | 用例、样本、接口、真机、弱网/大文件、安全、合规 | 2.0d |
| 发布 | Git/体验版/提审/灰度/回滚 | 1.0d |
| 文档 | Spike/接口/测试/运维 | 0.8d |
| **合计** | A 路线 v1.0 约 12~14 人日；B 路线约 14~17 人日；**V1.1 音乐编辑另加约 15～20 人日**（含 3～5d 真机 Spike；见设计文档 §14） | |

### 9.3 关键路径

门户：路线 A 验证 → 云函数转码链路 → 前端全链路 → 真机矩阵 → 提审。备案并行且 11-02 前提交。

---

## 10. 测试与质量

### 10.1 性能预算

主包 ≤1.5MB；首屏 ≤1.5s；10MB 上传 ≤10s（4G）；5min 转码 ≤30s；端到端 P95 ≤60s；轮询 1.5→3s；冷启动有“准备中”文案。

### 10.2 必测矩阵

输入 10 × 输出 3 + 2 高级 × 参数组合（3 档 MP3 + 各格式默认）≈60 组；平台 iOS/Android/PC；边界 5/30min、50MB、单/双声道、44.1/48k、特殊文件名；异常 0 字节/损坏/改扩展名/断网/超时/重复点击/超限/安全 risky。

### 10.3 安全清单

- 票据/任务/fileID 归属校验，防 IDOR；服务公网关闭。
- ffprobe 判断类型；execFile 数组参数；输出文件名清洗。
- 24h 清理；日志脱敏；隐私弹窗与后台一致。
- 内容安全送检/回调/删除可追溯。

---

## 11. 合规与上线

| 项 | 动作 | 状态 |
| :--- | :--- | :--- |
| 主体 | 个人主体（确认） | ✅ |
| 发布 | 公开发布 | ✅ |
| 商业化 | 免费、无广告、无虚拟支付 | ✅ |
| 类目 | 工具>图片处理；说明音频本地制作/剪辑、不提供公开传播 | ⏳ |
| 备案 | 个人可备案；11-02 前提交材料 | ⏳ |
| 隐私 | 收集选中文件 + 麦克风；弹窗/指引 | ⏳ |
| 内容安全 | mediaCheckAsync + 回调 + risky 删除 | ⏳ |
| 版权 | 用户协议、投诉入口、不内置曲库 | ⏳ |
| 基础库 | 后台最低 2.23.0 | ⏳ |
| 分享边界 | 不做公开链接/社区；转发仅用户点击私聊 | ⏳ |

---

## 12. 成本测算

| 路线 | 成本 |
| :--- | :--- |
| A 云函数 + 云开发 | 上线前免费环境；上线后基础套餐 19.9 元/月 + 资源点（函数/存储/数据库/CDN 按量）；低量预计 20~40 元/月 |
| B 云托管 | 首环境 3 个月免费额度（720 核·时/1440 GB·时/5GB 流量等）；之后低量约 10~50 元/月（0.25核0.5G≈0.71 元/天） |
| 存储/流量 | 24h 清理 + 50MB 上限 + 每日 5 次；低量几元/月 |

> 成本护栏：文件上限、每日额度、24h 清理、监控日成本；免费策略下优先 A。

---

## 13. 风险登记册

| # | 风险 | 概率 | 影响 | 应对 |
| :--- | :--- | :--- | :--- | :--- |
| R1 | 用户无法读取本地文件，转化率低 | 高 | 高 | 首页强引导 + 录音入口 |
| R2 | 类目“不得传播分享”与转发冲突 | 中 | 高 | 提审版不做公开分享；准备降级 |
| R3 | 路线 A 云函数包体/超时/性能不达标 | 中 | 高 | 先实测；失败切 B |
| R4 | 云端 1 CPU 下 AAC/OGG/MP3 长文件性能不足（30min M4A/OGG 估算 >160s；MP3 30min 未在 60s 返回） | 高 | 中 | A 路线按格式限长（m4a/ogg 5~8min、mp3 15~20min）；或 30min 全格式走 B |
| R5 | 上传/存储单文件上限未知 | 中 | 中 | 实测 20/50/100MB；必要时降低上限 |
| R6 | 内容安全 10MB/格式限制导致漏检 | 中 | 中 | 自适应代理 + 风险披露 |
| R7 | iOS/Android 播放与转发差异 | 高 | 中 | 真机矩阵 + 默认 mp3 |
| R8 | 云托管成本/主体问题 | 低 | 中 | A 优先；B 仅在必要时 |
| R9 | 版权/内容投诉 | 中 | 中 | 协议/投诉/删除 |
| R10 | 并发/额度计数丢失 | 中 | 中 | JSON 持久化 + 惰性补偿 |
| R11 | 另一个 AI 工具并发覆盖文档 | 高 | 中 | 文档归档 + 只读保护（见 DEV_LOG） |

---

## 14. 用户决策与待确认

### 14.1 已确认

| # | 问题 | 决策 |
| :--- | :--- | :--- |
| 1 | 定位 | 公开发布 |
| 2 | 主体 | **个人**（AppID 本人所有） |
| 3 | 环境 | 云开发已开通 `cloud1-d0g1pwjogd2f39be2` |
| 4 | 云托管 | 先验证 A，必要时再上 B |
| 5 | 文件上限 | 50MB / 30min 够用 |
| 6 | 转发 | 保留“转发给好友” |
| 7 | 内容安全 | 接受“先转换、并行送检、命中后删除” |
| 8 | 商业化 | 免费（无广告/无付费） |

### 14.2 仍需确认

1. **DevTools 服务端口**：请到「设置/偏好设置 → 安全设置」开启「服务端口」，以便我通过官方 CLI 部署 `ffmpegProbe`（或你在 IDE 右键上传）。
2. **格式时长限制**：是否接受 A 路线的差异化上限（WAV/FLAC 30min、MP3 15~20min、M4A/OGG 5~8min）？若必须 30min 全格式 → 需开通云托管（B）。
3. **V1.1 编辑设计评审**：是否按 v1.1 实施、源/成片时长上限、额度共享、输出格式与多选上限（见 [MUSIC_EDITOR_DESIGN §17](./MUSIC_EDITOR_DESIGN.md)）。
4. 可选：UI 品牌色/参考风格、上线 deadline。

---

## 15. 下一步

1. 用户开启 DevTools 服务端口 → 部署 `cloudfunctions/ffmpegProbe` → 云端实测（包体/超时/冷启动/5min/30min 转码）。
2. 同时复测本机静态 FFmpeg（去并发干扰），确定 A 的性能边界；若 AAC/30min 超时 → 降低上限或改 B。
3. 开发可并行：搭 `miniprogram/` 页面骨架 + mock API（不依赖云环境）。
4. 备案/类目/隐私材料 11-02 前提交。
5. V1.1 编辑：先评审 [MUSIC_EDITOR_DESIGN](./MUSIC_EDITOR_DESIGN.md)，再做 §13.3 真机 Spike，最后按 M9 排期。
6. 每日更新 [DEV_LOG](./DEV_LOG.md)。

---

## 16. 附录

### A. 文档依据（用户提供 + 官方）

framework / reference / component / api / server / devtools / ai 文档树；微信云开发（数据库/存储/云函数/云调用/定时器/消息推送/实时推送/计费）；微信云托管（镜像/调用/对象存储/消息推送/开放接口/计费/FAQ）。关键结论见 [FEASIBILITY](./FEASIBILITY.md)。

### B. 客户端能力映射（摘要）

| 需求 | 官方能力 | 限制 |
| :--- | :--- | :--- |
| 选音频 | chooseMessageFile | 仅会话文件；count 0~100 |
| 录音 | RecorderManager | ≤10min |
| 试听 | InnerAudioContext | iOS 格式限制 |
| 上传 | wx.cloud.uploadFile | 单文件上限待实测 |
| 进度 | callContainer 轮询 | 单次 ≤15s |
| 转发 | shareFileMessage | 2.16.1+，点击行为 |
| 保存 | saveFileToDisk | 仅 PC |
| 历史 | wx.setStorage | 200MB 总缓存 |

### C. 环境现状

| 项 | 现状 |
| :--- | :--- |
| 工程 | 云开发 quickstart 模板；页面待重建 |
| AppID | `wx484dd63e6a427b3b`（个人） |
| 云开发环境 | `cloud1-d0g1pwjogd2f39be2`（envList.js/app.js 已填） |
| 基础库 | `libVersion=3.17.5`；后台最低 2.23.0 |
| 本机 | Docker 28.3 已启动；Node 未安装；静态 FFmpeg 7.0.2 已下载 |
| 路线 A | `cloudfunctions/ffmpegProbe` 已准备（含 ffmpeg）；待部署 |
| 云托管 | 未开通（A 失败再开） |

---

*本计划 v2.5 依据官方文档、独立评审、用户决策与 2026-10-28 实测/调研；V1.1 编辑以 [MUSIC_EDITOR_DESIGN](./MUSIC_EDITOR_DESIGN.md) 为准；变更记录见 [DEV_LOG](./DEV_LOG.md)。*
