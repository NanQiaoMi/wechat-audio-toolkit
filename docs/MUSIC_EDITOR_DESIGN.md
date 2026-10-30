# 在线音乐编辑 · 详细设计（MUSIC_EDITOR_DESIGN v0.2）

| 项目 | 内容 |
| :--- | :--- |
| 文档 | 《音频格式转换小程序 · 在线音乐编辑详细设计》 |
| 版本 | v0.2（2026-10-28；已按独立评审 B1~B3/M1~M12 修订，待复审） |
| 日期 | 2026-10-28 |
| 负责人 | Lead（产品 / 架构 / 全栈） |
| 状态 | **v0.2 设计评审通过（有条件）+ 音乐剪辑 MVP v2 已落地**；与格式转换同小程序双 tab，支持多片段拼接/每片段缓入缓出，后续按 §19.2 迭代 |
| 关联文档 | [PRD](./PRD.md) · [TASK_PLAN](./TASK_PLAN.md) · [FEASIBILITY](./FEASIBILITY.md) · [DEV_LOG](./DEV_LOG.md) · [客户端能力](./research/CLIENT_CAPABILITIES.md) · [FFmpeg 实测](./research/FFMPEG_EDIT_SPIKE.md) · [UX 规格](./research/UX_EDITOR_SPEC.md) |
| 设计依据 | 2026-10-27～28 的路线 A 实测数据、官方文档核实（FEASIBILITY）、本轮专项调研（客户端能力/FFmpeg 实测/UX 规格，见 `docs/research/`） |

> 阅读顺序建议：§0 结论摘要 → §1 进度基线 → §2 产品定义 → §3 关键决策 → §5 编辑模型 → §8 服务端 → §9 接口 → §16 验收。设计与实现人员可只读 §5～§10。

> **契约唯一性（v0.2 评审结论 B2）**：**本文档 §5.2 EditPlan + §5.6 冻结行为表 + §9 API 是唯一事实源**；[UX_EDITOR_SPEC](./research/UX_EDITOR_SPEC.md) 与 [CLIENT_CAPABILITIES](./research/CLIENT_CAPABILITIES.md) 中与本契约冲突的字段名/API 名/交互承诺一律以本文档为准（两份材料文首已加对齐说明）。测试与实现不得引用旧字段（`timeline`、`output`、`bgm.volumeDb`、`analyze/render/renderStatus/cancel`）。

---

## 0. 结论摘要（先读）

1. **功能定位**：在现有「音频格式转换」之上增加「简单音乐剪辑」——**裁剪 / 删除片段 / 拼接 / 淡入淡出 / 音量 / 变速 / 配乐 / 铃声模板**，导出后落到现有「试听 / 转发 / PC 保存」链路。目标是把「一段音频处理成能用的片段」，不是做专业 DAW。
2. **端内不渲染、云端 FFmpeg 渲染**（延续 ADR-001）。小程序端只负责导入、波形与时间轴交互、**近似预览**、导出参数；真正的成片由云函数内静态 FFmpeg 7.0.2 生成。
3. **新增一条「分析 → 编辑 → 渲染」链路**：导入后先由云函数 `analyzeAudio` 返回 ffmpeg 探测元信息 + 波形 peaks（50ms 桶，uint8 0–255，base64）+ 端内可否试听标记；编辑页用 peaks 画波形，用 `InnerAudioContext` 顺序播放片段做近似预览；点击导出后用「快建任务 + 执行 + 轮询」两段式驱动云端 FFmpeg 按确定性 filter graph 渲染成片。
4. **编辑源时长上限 10 分钟**（v1.0 转换仍为 30 分钟）。这是路由 A「60s 云函数超时 + 1 CPU」下能保证成功率的边界；超过时明确提示「剪辑支持 10 分钟以内，长音频请先转码或分段」。铃声模板额外限制成片 ≤40s。
5. **非破坏性编辑模型**：客户端维护 `EditPlan`（源文件 + 片段列表 + 每段效果 + 配乐轨），所有操作只改 JSON，可撤销/重做/草稿恢复；导出时才把 JSON 编译成一条 FFmpeg 命令。这样服务端可校验、可幂等、可回放问题。
6. **额度策略可配置**：当前测试阶段 v1.0 已按用户要求关闭次数限制（`QUOTA_ENFORCED=false`）；正式策略建议与转换共享每日 5 次——导入/分析/波形/预览免费（有频率护栏），**导出成功才扣 1 次**，失败返还。编辑实现按「可开关」设计，不在测试期强制拦截。
7. **合规不变**：仍然只处理用户从微信会话导入的自有音频；**不内置曲库、不提供在线听歌、不做公开分享**；类目沿用「工具 > 图片处理」（官方口径覆盖音频本地制作/剪辑）；内容安全沿用现有送检 + 24h 清理策略。
8. **实施节奏**：建议作为 **v1.1（M9）** 在 v1.0 提审/上线后启动；若业务要求进入 v1.0，则只保留 **P0-lite（导入 → 裁剪/删除 → 导出 MP3）**，其余（拼接/配乐/模板/变速）顺延，且需评估发布档期。详见 §14。
9. **待真机验证的关键假设**（已在 §13.3/§15 列出）：① 最坏组合 10min + 效果 + 配乐能否稳定 <45s（FFmpeg）/ <55s（函数）；② 导出「create + run + poll」在真机切后台/锁屏后的恢复行为；③ `InnerAudioContext` 顺序预览的段间间隙与 `playbackRate` 是否保调；④ Canvas 2D 在低端安卓上的手势帧率与交互手感。

---

## 1. 项目进度基线（2026-10-28）

### 1.1 已完成（有据可查）

| 里程碑 | 状态 | 关键事实 |
| :--- | :--- | :--- |
| M0 立项 / 文档 | ✅ | FEASIBILITY（424 行、69 来源）、TASK_PLAN v2.4、PRD v1.2、DEV_LOG v1.4、发布清单、法务草稿 |
| M1 用户决策 | ✅ | 个人主体、公开发布、免费、云开发环境 `cloud1-d0g1pwjogd2f39be2`、50MB/30min、保留转发、接受「先转换、并行送检、命中后删除」 |
| M2a 路线 A 验证 | ✅ 有条件通过 | 云函数 + 静态 FFmpeg 7.0.2：部署包 28.6MB、Node 16.13、1 CPU / 975MB、timeout 60s；30min WAV≈9.2s、FLAC≈13.6s；30min MP3 未在 60s 返回；M4A/OGG 长文件不可行 |
| 转换主链路（原型） | ✅ 可端到端 | `pages/index`：聊天文件导入 → 上传云存储 → `ffmpegProbe.convertFile` → 试听/历史/设置；3s 样本 6 格式 E2E、真实 5min/6.87MB MP3 转码 15.1s 通过 |
| 额度/清理/隐私 | ✅ 已验证 | 云数据库 `quota` 每日 5 次（第 6 次拦截）；`converted_files` + `cleanup` 24h 清理实测；`__usePrivacyCheck__` + 自定义隐私弹窗；设置页 |
| 发布准备 | 🟡 部分 | 预览二维码已生成；隐私/协议/投诉草稿；03:46 真机报 `chooseMessageFile ... privacy agreement`，已临时移除隐私检查开关待后台配置；04:24～04:31 真机修复分享/保存链路（预下载后同步调 `shareFileMessage`；PC/手机分流保存） |

### 1.2 现状与差距（必须如实看待）

- **文档与代码有偏差**：文档规划了 `pages/task`、`pages/result`、`pages/history` 与 `utils/*`，当前实际只有 `pages/index`（719 行 JS，单页承载全部流程）和 `pages/settings`；上传/轮询/历史/播放均内联在首页。编辑功能上线前建议做一次**小重构**（抽出 `utils/cloud.js`、`utils/audio.js`、`utils/history.js`、`components/audio-player`），但不作为前置阻塞。
- **当前转换是同步调用**：`wx.cloud.callFunction` 一次等待完成（已实测 15.1s 成功）。编辑导出更重，**已按官方「callFunction 无客户端 timeout / 切后台 5s 中断」改为两段式任务 + 轮询**（ADR-E09）；真机长调用/中断恢复仍是本轮最大 Spike 项（§13.3 SPIKE-E1）。
- **内容安全未生效**：个人主体无 `security.mediaCheckAsync` 权限（-604101），代码开关 `MEDIA_CHECK_ENABLED=false`。编辑功能沿用同一策略，不因新增编辑引入新的合规机制；但提审材料需要继续如实披露。
- **额度测试期关闭**：用户 2026-10-28 要求测试阶段 `QUOTA_ENFORCED=false`（v1.0 已生效，设置页文案「不限次数（测试阶段）」）。编辑设计沿用同一开关，不把「5 次/日」写死；上线前由用户决定是否恢复。
- **发布阻塞项仍在**：备案（11-02 前提交）、隐私指引后台配置并恢复 `__usePrivacyCheck__`、类目提交、真机全流程、正式云函数命名。**编辑设计不改变这些优先级。**

### 1.3 本设计在路线图中的位置

```text
v1.0 格式转换（当前）                 v1.1 在线音乐编辑（本设计）
M3 工程基建 ── M4 核心链路 ── M5 完备 ── M6 测试 ── M7 提审/上线
                                                    │
                                                    ├── M9.1 分析链路（peaks + 可播标记）
                                                    ├── M9.2 编辑器（裁剪/删除/导出）
                                                    ├── M9.3 拼接/配乐/模板
                                                    └── M9.4 测试/提审
```

- **强依赖**：v1.0 的云函数/云存储/额度/清理/隐私弹窗/转发链路必须先稳定；编辑复用它们，不另建账号体系、不引入新主体要求。
- **弱依赖**：`pages/task`、`pages/result` 的拆分不是前置条件；编辑页可以独立存在，结果页复用现有结果卡。
- **若必须进入 v1.0**：只做 §2.5 的 P0-lite，并把 M4～M7 顺延至少 4～6 个有效人日；不建议。

---

## 2. 需求与产品定义

### 2.1 背景与用户问题

现有能力解决「格式不对、听不了」；但用户在微信里处理音频时更高频的诉求是「**内容长了/不对，帮我截出能用的部分**」：

1. 一段 4 分钟的歌，只想要 30 秒副歌做铃声/提示音；
2. 采访/会议录音 30 分钟，只保留重点 3 分钟，中间废话删掉；
3. 几条语音备忘想按顺序拼成一条发出去；
4. 自己弹的一段旋律 + 一段伴奏，想混在一起；
5. 录的语音开头结尾空白太长，想剪干净。

这些操作在手机上缺少「不用装 App、不用学专业软件」的入口；而微信里文件已在聊天记录里，**导入路径天然成立**。现有转换功能带来相同的目标用户与流量，增加剪辑能显著提升留存与使用频次，且不增加新的合规主体要求。

### 2.2 产品定位

> **一句话**：在微信里，三步把一段音频剪成你要的样子——**选音频 → 拖两下 → 导出**。
>
> 不是「在线音乐平台」：没有曲库、没有在线听歌、没有公开分享；只处理用户自己导入的音频，产物是文件，可转发给好友或保存到电脑。

### 2.3 目标用户与典型场景（JTBD）

| 用户 | 场景（JTBD） | 现状痛点 | 本功能的价值 | 对应模板 |
| :--- | :--- | :--- | :--- | :--- |
| 普通用户 | 把喜欢的歌剪 30～40 秒做铃声/闹钟/提示音 | 手机自带剪辑门槛高、要装 App | 微信内选歌 → 拖选区 → 一键铃声 | 手机铃声 |
| 学生/职场 | 课堂/会议录音只保留重点、删掉空白与废话 | 录音很长、无法精细剪 | 波形可视化，删掉中间段，导出 | 自由剪辑 / 静音清理 |
| 家庭用户 | 多条语音备忘按顺序合成一条发给家人 | 微信语音不能直接拼接 | 多选聊天文件 → 排序 → 拼接 | 语音拼接 |
| 内容爱好者 | 人声 + 背景音乐简单混合 | 手机无多轨工具 | 主音频 + 配乐音量/循环/淡出 | 配乐混音 |
| 老用户 | 转换完成后发现需要裁剪 | 只能整文件转 | 结果页「继续剪辑」直达编辑器 | — |

### 2.4 成功指标（v1.1，上线 4 周观察）

| 指标 | 目标 | 口径 |
| :--- | :--- | :--- |
| 编辑器进入率 | ≥12% | 进入编辑页 UV / 首页 UV |
| 导入→分析成功率 | ≥98% | 排除用户取消 / 主动退出 |
| 上传 P95 | ≤15s | 10MB/4G；用户点击选择 → 上传完成（不含分析） |
| 分析 P95 | ≤8s | **上传完成 → peaks 返回**（10min mp3；4kHz 解码实测 4.06s + 探测/冷启动余量）；不含上传 |
| 波形首帧 | ≤300ms | peaks 到手 → 波形可交互（本地绘制） |
| 常用任务完成率 | ≥70% | 进入编辑页且完成导出 / 进入编辑页 |
| 导出成功率 | ≥97% | 排除用户取消 / 额度不足 |
| 3min 音频导出 P95 | ≤25s | 点击导出 → 结果可播放（含下载源+渲染+上传成片；不含排队） |
| 单次编辑操作数 | 中位数 ≤5 | 从分析完成到点导出之间的操作事件数 |
| 崩溃率 | <0.5% | 小程序后台异常 |
| 投诉率 | <0.1% | 与音频内容/版权相关投诉 / 导出入次 |

### 2.5 范围（P0 / P1 / P2）与非目标

**P0（v1.1 必须，自由剪辑主链路）**

- 单个/多个会话音频导入（**P0 主轨 ≤3 个源文件**，每个 ≤10min、≤50MB；SPIKE-E12 通过后放开到 ≤5），录音导入沿用首页能力；
- 服务端分析：ffmpeg 探测元信息、peaks 波形、跨平台可播标记（P0 不生成试听代理，iOS 不可播格式接受「可编辑、不可试听」并给出提示/先转 MP3 入口）；
- 波形时间轴：播放头、选区、双指缩放、横向滚动、选区微调（±0.1s）、循环试听选区；
- 编辑操作：**裁剪保留选区 / 删除选区 / 撤销重做 / 片段拖动排序**；
- 声学参数：**淡入、淡出（0～5s）**、**整体音量（-24～+12dB）**；
- **模板：手机铃声（≤40s，预置选区+淡出+命名，P0）**；
- 导出：mp3（128/192/320k）、wav、flac；默认 mp3 192k；快速无损导出（仅裁剪、同格式）自动启用；
- 导出结果试听、转发好友、PC 保存/复制链接（复用 v1.0 结果能力）；
- 额度、失败返还、错误提示、24h 清理、内容安全沿用。

**P1（v1.1 迭代内，视进度）**

- 片段拼接（多源文件，顺序调整）；
- 配乐轨（第二段音频、音量、循环、偏移、淡出）；
- 变速（0.5×/0.75×/1.25×/1.5×/2.0×，保持音调）；
- 模板：语音拼接、静音清理（去首尾静音）、配乐混音（基础版）；
- 草稿自动保存 + 历史记录恢复；
- 埋点与漏斗、编辑历史入口。

**P2（后续版本）**

- 变调、降噪、人声分离、节拍/卡点、自动字幕、频谱图；
- 多轨（>2 轨）、交叉淡入淡出、侧链闪避；
- 30 分钟以上长音频编辑（依赖路线 B 云托管或异步队列）；
- 曲库/背景音乐素材（**合规不允许，不做**）；
- 导出视频/动态封面/歌词。

**明确非目标**

- ❌ 不提供在线听歌、曲库、榜单、社区、公开链接/分享墙；
- ❌ 不做端内 FFmpeg/WASM 编码、不做端内精确混音渲染；
- ❌ 不做专业 DAW 功能（多轨自动化、母带、插件链、MIDI）；
- ❌ 不承诺「设置系统铃声」——手机端小程序无此能力，文案必须说明「导出文件后需自行在手机设置中使用」；
- ❌ 不改动 v1.0 的转换限额与格式矩阵（编辑源 10min 是新增独立限制）。

### 2.6 与现有转换功能的关系

| 维度 | v1.0 格式转换 | v1.1 在线音乐编辑 | 复用/差异 |
| :--- | :--- | :--- | :--- |
| 入口 | 首页 | 首页新卡片 + 结果页「继续剪辑」+ 历史 | 新入口，不改变原主按钮 |
| 导入 | 聊天文件/录音 | 同左，可多选（**P0 主轨 ≤3，SPIKE-E12 后 ≤5**；UX 建议 9 不采纳） | 复用 `chooseMessageFile` |
| 上传 | `wx.cloud.uploadFile` | 同左（每个源文件一次） | 复用 |
| 云端 | `ffmpegProbe.convertFile` | 新增 `analyzeAudio` / `createEditTask` / `runEditTask` / `getEditTask` 动作 | 同一云函数，扩展 action |
| 额度 | 测试阶段不限次数（`QUOTA_ENFORCED=false`，可恢复 5 次/日） | 与转换共用同一开关；开启时导出成功扣 1、失败返还，分析免费 | 复用 quota 集合，新增 bucket/字段 |
| 清理 | 输出 24h、输入转换后删 | 分析记录/导出结果 24h；P1 代理再做 | 复用 `converted_files`，新增 `edit_tasks` |
| 结果导出 | 试听/转发/PC 保存/临时链接 | 同左 | 直接复用 |
| 隐私 | 选择文件/麦克风 | 同左（无新增隐私接口） | 无需新增声明 |
| 合规 | 工具类目、无传播 | 同左；编辑不引入曲库 | 文档/协议补充「剪辑」措辞 |

---

## 3. 约束与关键设计决策

### 3.1 硬约束汇总

| # | 约束 | 数值/结论 | 对本设计的影响 |
| :--- | :--- | :--- | :--- |
| E-C1 | 云函数超时 | 60s 硬超时；函数内 deadline 55s；FFmpeg 45s | 10min 编辑上限；重活必须可降级/快速导出 |
| E-C2 | 云函数资源 | 1 CPU / 975MB / Node 16 / `/tmp` 512MB | 单次只处理 1 个编辑任务；解码内存与临时文件需清理 |
| E-C3 | 代码包 | 静态 FFmpeg 已 28.6MB（zip），路线 A 已验证可部署 | 不新增第二个 FFmpeg 副本；扩展同一云函数 |
| E-C4 | 小程序不能读手机本地文件 | 只能 `chooseMessageFile` / 录音 | 导入引导沿用首页；不支持「相册/文件管理器」 |
| E-C5 | iOS 不能播放 flac/ogg/amr/ape/wma | 跨平台可播 = mp3/m4a/aac/wav | P0 接受「有波形、能编辑、不能试听」，文案提示；P1 再评估试听代理/云端 15s 试听片段 |
| E-C6 | 手机不能保存到系统目录 | `shareFileMessage`/PC `saveFileToDisk` | 铃声模板只能导出文件，不能直接设为铃声 |
| E-C7 | 基础库 | 最低 2.23.0（callContainer）；工程 3.17.5 | Canvas 2D、InnerAudioContext 能力需按 2.23 兼容 |
| E-C8 | 品类/合规 | 工具 > 图片处理覆盖「音频本地制作、剪辑」；不得公开传播 | 无曲库/社区/公开链接；文案强调自有文件 |
| E-C9 | 内容安全 | `mediaCheckAsync` 音频 ≤10MB，个人主体当前无权限 | 沿用现有开关与窗口策略，编辑不新增检测入口 |
| E-C10 | 免费无广告 | 个人主体、无虚拟支付 | 成本护栏靠限额 + 额度 + 24h 清理 |
| E-C11 | 客户端长调用不可靠 | **官方 `callFunction` 无客户端 timeout 参数**；网络默认 60s；**小程序切后台 5s 内请求未结束会中断**（`fail interrupted`） | 导出拆成「快建任务 + 执行 + 轮询」两段式，不依赖单次长调用返回结果（§8.6） |
| E-C12 | 端内内存 | WebAudio 解码 5min 立体声 PCM ≈100MB，风险高；内存无官方数值，iOS 连续告警会销毁小程序 | 波形用服务端 peaks；预览用流式播放，不整段解码；监听 `wx.onMemoryWarning` |
| E-C13 | 播放云文件 | `InnerAudioContext.src` 自基础库 **2.2.3 起支持云文件 ID** | 预览/结果统一用 fileID，避免临时 URL 时效 |
| E-C14 | 时间轴画布 | Canvas 2D **最大 1365×1365**，过大安卓可能 crash；canvas touch 事件带相对坐标 | 视口画布 + view 覆盖层；不做整条长画布 |
| E-C15 | WAV 体积 | 44.1k/16bit 立体声 10min **≈106MB**；**输入 WAV ≤4.7min（50MB）/ 输出 WAV ≤4min（42MB）** | 输入/输出上限分开；长无损用 FLAC |
| E-C16 | 临时链接 | `getTempFileURL` 私有链接口径冲突（**10min** vs guide 2h，一次 ≤50 个） | 不依赖临时链接做播放；转发/PC 保存现取现用 |
| E-C17 | `chooseMessageFile` 多选 | `count` 0～100；**返回顺序、单文件大小上限官方未说明** | 多选顺序以用户可视顺序为准（待真机），上传前按大小过滤 |
| E-C18 | 网络/上传 | `wx.*` 网络接口并发 10；上传期间切后台 5s 中断 | 上传并发 ≤2；提示「保持前台」；失败重传 |

> 以上 E-C13～E-C18 的官方依据与来源链接见 [CLIENT_CAPABILITIES.md §5/§10](./research/CLIENT_CAPABILITIES.md)（2026-10-28 核验）；未核实的项在 §13.3 有对应 Spike。

### 3.2 关键设计决策（ADR-E）

> 与既有 ADR-001～016 并列，编号 E 表示 Editor。每条写明「替代方案」便于评审。

**ADR-E01 编辑在云端渲染，端内不做编码或精确混音**
- 决策：所有导出由云函数静态 FFmpeg 完成；端内只做交互与近似预览。
- 理由：端内无编码器、包体/内存不允许；路线 A 已验证 FFmpeg 可用；与 ADR-001 一致。
- 替代：端内 WASM（包体 2MB/总分包 30MB 限制、无多线程，否决）；第三方 API（隐私/成本/合规，否决）。

**ADR-E02 新增 `analyzeAudio` + 导出任务三动作，复用现有函数**
- 决策：不新建独立云函数；在 `ffmpegProbe`（后续更名 `audioStudio`）内新增 action，共用同一份 FFmpeg 二进制与依赖。
- 理由：28.6MB 包体只部署一份；额度/清理/鉴权代码复用；部署与回滚简单。
- 风险：函数职责变多，需按 action 拆文件（`lib/analyze.js`、`lib/edit.js`、`lib/ffmpeg.js`）；日志按 taskId 串联。
- 替代：独立云函数（多 28.6MB 包、重复代码、多一份冷启动，否决）。

**ADR-E03 分析前置 + 波形 peaks 由服务端生成**
- 决策：导入后先调 `analyzeAudio`，返回时长/格式/采样率/声道 + peaks（50ms 桶、uint8 peak/rms、base64）+ `playableIos/playableAndroid` 标记。**P0 不生成试听代理**：不为少数 iOS 不可播格式增加 60s 预算与存储；P1 视反馈再评估。
- 理由：peaks 数据量小（10min ≈ 24KB 原始 / 32KB base64），不依赖端内解码格式支持，低端机无内存风险；与「先分析再编辑」的乐观 UI 契合。
- 替代：端内 `decodeAudioData` 算波形（5min 立体声 ≈100MB PCM，格式支持不确定，否决为主路径，仅作降级）。
- 影响：首屏等待 1～5s（10min 文件），需分析态 UI 与失败重试。

**ADR-E04 预览采用 InnerAudioContext 顺序播放，不追求精确**
- 决策：主轨用两个 `InnerAudioContext` 轮换预加载播放片段；淡入淡出用 `volume` 定时渐变近似；配乐用第二实例同步播放；变速用 `playbackRate`；UI 明确「预览为近似效果，以导出为准」。
- 理由：不占大内存、不依赖解码格式、实现成本低；对「剪掉一段/拼起来」的听觉判断足够。
- 替代：端内 WebAudio 精确预览（内存/格式/后台限制风险，不作为 P0）；服务端实时渲染预览（每次试听消耗算力，成本不可控，否决）。

**ADR-E05 非破坏性 `EditPlan`，导出时编译为 FFmpeg 命令**
- 决策：客户端只维护 JSON（源 + 片段 + 效果 + 配乐）；服务端校验后编译 filter graph；任何操作可撤销/重做。
- 理由：可回放问题、可幂等重试、可跨端恢复；避免上传中间产物。
- 替代：每步操作都在云端渲染并回传中间文件（延迟/成本/失败率高，否决）。

**ADR-E06 导出成功才扣额度，分析/预览免费**
- 决策：`analyzeAudio` 不计次但有频率/时长护栏；导出任务成功才扣 1 次，失败/取消/超时返还。
- 理由：用户「打开看看」不应被扣次；算力主要花在渲染。
- 替代：导入即扣次（体验差）；无限免费分析（被刷风险）。

**ADR-E07 单条命令完成渲染，快速路径自动切换**
- 决策：一次 ffmpeg 调用完成 裁剪/拼接/效果/混音；当且仅当「单源 + 单片段 + 无效果 + 目标容器与源码相同」时走 `-ss -to -c copy` 快剪，否则重编码。
- 理由：减少中间文件与 I/O，便于 60s 内完成；快剪让长文件/无损剪辑几乎瞬时。
- 风险：copy 裁剪有帧边界误差与容器兼容问题；仅用于明确白名单场景（§8.5）。
- 替代：多步渲染中间文件（超时/磁盘/失败率，否决）。

**ADR-E08 主轨源文件 P0 最多 3 个（上限 5），编辑输出 ≤10 分钟**
- 决策：P0 主轨源文件 ≤3 个、源总时长 ≤900s、每个 ≤10min/50MB；SPIKE-E12 通过后放开 5 个/1200s；成片（含变速/拼接后）≤10min；铃声模板 ≤40s。
- 理由：60s 内完成最坏组合渲染；解码内存与 `/tmp` 可控；覆盖歌曲/语音备忘主场景。
- 替代：不限制源数量（filter 图与解码时长不可控，否决）；30min 编辑（需云托管/异步队列，P2）。

**ADR-E09 导出采用「快建任务 + 执行 + 轮询」两段式，不依赖单次长调用**
- 决策：`createEditTask`（≤5s，校验+预占额度+落库+返回 `taskId`）→ `runEditTask(taskId)`（≤55s，执行渲染，通常一次返回结果）→ 客户端以 1.5s→3s 轮询 `getEditTask` 兜底；任何阶段失败/切后台都能用 `taskId` 查到结果或续跑。
- 理由（官方依据）：`wx.cloud.callFunction` **无客户端 timeout 参数**，网络默认 60s；**切后台 5s 内请求未结束会 `fail interrupted`**。一次等 30～50s 的方案在用户切走/来电时必然丢结果；两段式让「扣次、执行、结果」都有持久化锚点。
- 幂等：`createEditTask` 以 `clientToken` 去重；`runEditTask` 以 `taskId + leaseAt` 防并发重复执行；`getEditTask` 只按归属返回。
- 可选后台化（P1）：若环境为**按量付费**且已验证「数据库事件触发器」可用，可由集合变更自动触发 worker（与同一云函数），客户端只 `create + 轮询`，彻底摆脱前台长等待。当前环境类型与事件 payload 格式**待确认/待实测**，不作为 v1.1 P0 的硬依赖。
- 替代：一次同步调用等 50s（切后台丢结果、无法恢复，否决）；纯定时触发器队列（最小 1min 粒度，等太久，仅作兜底）。

**ADR-E10 编辑页单页 + 组件化，不新增 tabBar**
- 决策：首页加「音乐剪辑」入口卡；编辑页 `pages/editor/editor` 单页承载分析/编辑/导出/结果状态；工具参数用底部面板；不引入 tabBar。
- 理由：现有首页是单页工具流，加 tabBar 会增加层级与首屏成本；入口卡可埋点、可灰度。
- 替代：独立 Tab（首屏/包体/导航重构成本高，否决）。

**ADR-E11 模板只改默认参数，不锁定用户操作**
- 决策：铃声/拼接/配乐/静音清理模板本质是「预置 EditPlan + 引导」，用户进入后仍可自由调整。
- 理由：降低学习成本但不牺牲可控性；避免为模板做两套编辑逻辑。
- 替代：模板向导式多步页面（层级多、维护成本高，否决）。

---

## 4. 总体架构

### 4.1 架构图

```text
┌──────────────────────── 微信小程序（原生 WXML/WXSS/JS） ────────────────────────┐
│ 首页 pages/index                编辑页 pages/editor（单页多状态）                │
│  ├─ 原「格式转换」卡片            ├─ analysis-view  上传/分析/失败重试            │
│  ├─ 新增「音乐剪辑」入口卡  ───▶  ├─ waveform-timeline（canvas 2d + 手势）        │
│  ├─ 历史（v1.0 模态框）           ├─ clip-bar / track-bar（主轨 + 配乐）          │
│  └─ 设置                          ├─ tool-sheet（裁剪/删除/淡入淡出/音量/变速/配乐）│
│                                    ├─ preview-engine（InnerAudioContext ×2～3）    │
│ 转换结果卡「继续剪辑」──────────▶  └─ export-bar / result-panel                   │
│ utils/cloud.js · utils/audio.js · utils/format.js · utils/history.js · utils/edit.js │
└───────────┬─────────────────────────────────────────────┬────────────────────────┘
            │ 1) wx.cloud.uploadFile（源文件直传）            │ 4) 预览：临时 URL 流式播放
            ▼                                             │
┌────────────────── 微信云开发（环境 cloud1-d0g1pwjogd2f39be2） ───────────────────┐
│ 云存储：edit_sources/…（源）  edit_outputs/…（成片）  edit_previews/…（P1 代理）  │
│ 云数据库：audio_analyses · edit_tasks · quota · converted_files                    │
│ 云函数 audioStudio（现 ffmpegProbe）                                               │
│  actions: analyzeAudio / createEditTask / runEditTask / getEditTask          │
│           cleanup(定时) / convertFile                                         │
│  内部：ffmpeg 探测 → peaks 计算 → （P1 可选）试听代理                          │
│        EditPlan 校验 → filter graph 编译 → 静态 FFmpeg 7.0.2 → 上传成片            │
└───────────┬─────────────────────────────────────────────┬────────────────────────┘
            │ 2) analyzeAudio（同步，≤10s）                  │ 5) createEditTask(≤5s)                                      │
            │                                                 │    → runEditTask(≤55s) → getEditTask 轮询                    │
            └─────────────────────────────────────────────┘
```

**设计取舍**：分析同步返回（数据小、等待可接受）；导出采用「快建任务 → 执行 → 轮询」两段式（ADR-E09），不引入独立服务/队列/数据库选型变更；后台化留给 P1（事件触发器，需按量付费环境验证）。

### 4.2 三条关键数据流

**流程 A：导入与分析**

1. 用户点「音乐剪辑」→ 选择会话文件（可多选，主轨 ≤5）或录音。
2. 客户端逐文件校验扩展名/大小 → 调 `createUploadTicket({fileName,size,ext})` 拿 `{ticketId, cloudPath}`（cloudPath 含 openid，服务端签发）→ `wx.cloud.uploadFile({cloudPath, filePath})`；上传进度 + 可取消。
3. 逐个调用 `analyzeAudio({ticketId, fileID, fileName, size, clientToken})`（服务端校验 ticket 归属/路径/fileID 前缀）：
   - 服务端 `ffmpeg -i` 解析 stderr（未打包 ffprobe）拿 `duration/codec/sampleRate/channels/bitrate`；
   - 校验时长 ≤600s、大小 ≤50MB、有音轨；
   - 解码为 4kHz 单声道 s16le（`/tmp`），按 50ms 桶计算 `peak`（绝对值最大值）与 `rms`，量化为 uint8 0–255，base64；
   - 记录 `playableIos = format ∈ {mp3,m4a,aac,wav}`、`playableAndroid`（flac/ogg/amr/ape/wma 在 iOS 不可播）；`playable = playableIos && playableAndroid` 仅作双端标记；
   - 写 `audio_analyses` 记录（TTL 24h），返回 `{analysisId,duration,format,sampleRate,channels,buckets,peaks,playableIos,playableAndroid,playable,proxyUsed:false}`。
4. 客户端展示分析进度（逐个文件），全部成功后进入编辑态；任一失败可重试/移除该文件。
5. 进入编辑态时生成 `EditPlan` 初值：每个源文件默认一个整段 clip（多源时按选择顺序排好）。

**流程 B：编辑与预览**

1. 所有手势/工具只修改内存中的 `EditPlan`，并推入 undo 栈（防抖合并高频拖动）。
2. 预览引擎把 `EditPlan.main.clips` 展开成播放队列：`[src, in, out]`；按段设置 `startTime/seek`，用两个 `InnerAudioContext` 轮换预加载；淡入淡出用 `volume` 定时渐变近似；配乐用独立实例同步播放（循环/偏移/音量）。
3. 时长、片段数、格式安全提示实时计算；非法操作（如 fade > 片段/2）在面板层即时提示。
4. 切后台/离开页面：停止预览、销毁实例、自动保存草稿（节流）。

**流程 C：导出与结果（两段式 + 轮询兜底）**

1. 用户点「导出」→ 选择格式/码率（默认 mp3 192k）→ 二次确认（时长/大小/额度）。
2. 客户端生成 `clientToken`（`u_${Date.now()}_${random}`），调用 **`createEditTask`**（快，≤5s）：
   - 服务端幂等检查 → 额度预占 → 校验 plan/源归属/限额 → 落 `edit_tasks`（`queued`，保存 plan）→ 返回 `{taskId, pollAfterMs}`。
3. 客户端调用 **`runEditTask({taskId})`**（执行，≤55s）：
   - 服务端用 `taskId + leaseAt` 防并发，`queued → running`；下载源 → 编译 filter graph → FFmpeg → 上传 → 落 `succeeded`；返回结果。
   - 用户保持前台时，多数情况这一次调用即可拿到结果；**长调用本身不作为唯一结果通道**。
4. 任何异常（失败/超时/切后台/断网）：客户端以 `taskId` 调 `getEditTask` 轮询（1.5s→3s，最长 90s）：
   - `queued`：可再次调 `runEditTask` 续跑（最多 2 次）；
   - `running`：继续轮询；服务端对 `running > 75s` 惰性判 `TIMEOUT` 并返还额度；
   - `succeeded`：展示结果。
5. 客户端展示结果面板（复用 v1.0 结果卡）：试听、转发、PC 保存/复制链接、再剪一次、返回首页；写本地历史（type=edit）。
6. 结果播放优先用 **fileID**（官方 2.2.3+ `InnerAudioContext.src` 支持云文件 ID），不依赖 10min/2h 临时链接时效。
7. 额度只在 `createEditTask` 预占一次；失败/超时由服务端返还；`getEditTask` 不重复扣次。

### 4.3 状态机

**编辑器页面状态（客户端）**

```text
IDLE ──选择文件──▶ UPLOADING ──全部源上传完成──▶ ANALYZING ──全部成功──▶ EDITING
  ▲                    │失败                         │失败                   │
  └────返回/重选────────┴───────────显示错误+重试──────┴──────────────────────┘
EDITING ──点导出──▶ EXPORTING ──成功──▶ SUCCESS ──分享/再剪/返回──▶ IDLE/EDITING
   │                    │失败（含超时/切后台）
   │                    ▼
   │              EXPORT_FAILED ──重试（taskId 续跑/新建）──▶ EXPORTING
   └──返回（自动存草稿）──▶ DRAFT（本地）

EXPORTING 内部阶段：PREPARING（createEditTask）→ RENDERING（runEditTask）→ POLLING（getEditTask 兜底）→ SUCCESS/FAILED
```

**分析记录（`audio_analyses.status`）**：`ready | failed`，TTL 24h。

**渲染任务（`edit_tasks.status`）**：`queued → running → succeeded | failed | blocked`（主状态只这 5 个）；内容安全用独立字段 `safetyStatus ∈ {none,pending,pass,risky}`，不混入主状态。`blocked` 仅当内容安全 risky 且输出已删除；`failed` 带 `error.code`。

**状态转换表**

| 当前 | 事件 | 下一状态 | 副作用 |
| :--- | :--- | :--- | :--- |
| — | createEditTask 成功 | queued | 写完整 plan；额度预占（开关开启时） |
| queued | runEditTask 抢占 | running | leaseAt=now；attempts+1 |
| queued | 超过 90s 未执行 | failed | 退次（若已预占）；`error.code=TIMEOUT` |
| running | 执行成功 | succeeded | 写 result；converted_files(kind=edit_output) |
| running | 执行失败 | failed | 退次；error.code 映射 |
| running | lease >75s 未续 | failed | 退次；`error.code=TIMEOUT`（getEditTask/cleanup 惰性触发） |
| succeeded | 内容安全 risky（异步） | blocked | 删除输出；历史标记不可用 |
| queued/running | 用户取消（v0.2 不做） | — | —（本期不提供取消，导出中可退后台） |

**幂等/防重**：
- `createEditTask` 以 `clientToken` 唯一索引去重；重复请求返回同一 task。
- `runEditTask` 以 `taskId` + `leaseAt`（+60s）防并发；已有 `succeeded` 直接返回结果；`running` 且 lease 未过期 → `EXPORT_RUNNING`。
- `getEditTask` 只允许创建者 openid 查询；只返回 `fileID`（客户端用 fileID 播放/`downloadFile`），**不返回长期 URL**。

### 4.4 与既有组件的边界

| 组件 | 编辑功能的改动 | 是否阻塞 v1.0 |
| :--- | :--- | :--- |
| `cloudfunctions/ffmpegProbe` | 增加 action 分发与 `lib/analyze.js`、`lib/edit.js`、`lib/filtergraph.js`；`convertFile` 逻辑不动 | 否（v1.1 再加） |
| 云数据库 | 新增 `audio_analyses`、`edit_tasks`；`quota` 增加 `editUsed` 桶（或复用 count 单池） | 否 |
| 云存储 | 新增目录 `edit_sources/`、`edit_previews/`、`edit_outputs/`；清理逻辑扩展 | 否 |
| 首页 | 增加入口卡；工具函数抽取（建议） | 否 |
| 结果页/历史 | 复用；历史增加 `type: edit` 与「继续剪辑」 | 否 |
| 隐私弹窗/协议 | 协议文案补充「剪辑」，隐私指引无需新增接口声明 | 否 |
| 内容安全 | 无新增机制；沿用开关与回调 | 否 |

---

## 5. 编辑模型与数据契约

### 5.1 设计原则

1. **非破坏性**：任何操作只改 `EditPlan`，源文件永不修改；导出前不产生中间音频。
2. **可校验**：所有时间/增益/格式参数有明确范围与服务端二次校验；客户端校验只负责体验。
3. **可幂等**：相同 `EditPlan + clientToken` 重试得到同一结果；服务端按 `planVersion` 记录。
4. **可演进**：`version` 字段 + 只增不删的字段策略；新效果用可选字段，旧客户端请求被服务端按 min(version) 支持。
5. **单一事实源**：时长/片段合法性由 `EditPlan` 派生，不存冗余的可变状态；UI 只渲染派生值。

### 5.2 `EditPlan` Schema（v1）

> 时间单位统一为**秒（浮点，保留 3 位小数 = 毫秒）**；增益单位 dB；采样率/声道以导出参数为准。所有 `sourceId` 必须在 `sources` 中存在。

```json
{
  "version": 1,
  "planId": "p_1730081234567_ab12cd",
  "template": "free | ringtone | concat | mix | silence",
  "sources": {
    "src_1": {
      "analysisId": "a_1730081234000_xx",
      "fileID": "cloud://cloud1-d0g1pwjogd2f39be2.xxx/edit_sources/1730081234_ab12cd.mp3",
      "name": "夜曲.mp3",
      "duration": 245.612,
      "format": "mp3",
      "sampleRate": 44100,
      "channels": 2,
      "role": "main"
    },
    "src_2": {
      "analysisId": "a_1730081240000_yy",
      "fileID": "cloud://.../edit_sources/1730081240_ef34gh.mp3",
      "name": "副歌.mp3",
      "duration": 62.4,
      "format": "mp3",
      "sampleRate": 44100,
      "channels": 2,
      "role": "main"
    }
  },
  "main": {
    "clips": [
      { "id": "c1", "sourceId": "src_1", "in": 12.5, "out": 45.0, "gainDb": 0 },
      { "id": "c2", "sourceId": "src_2", "in": 0.0, "out": 30.0, "gainDb": 0 }
    ],
    "speed": 1.0,
    "gainDb": 0,
    "fadeInSec": 0,
    "fadeOutSec": 1.5,
    "normalize": false
  },
  "bgm": {
    "enabled": false,
    "sourceId": null,
    "in": 0,
    "out": 0,
    "startOffsetSec": 0,
    "loop": true,
    "gainDb": -12,
    "fadeInSec": 1,
    "fadeOutSec": 2
  },
  "export": {
    "format": "mp3",
    "bitrate": "192k",
    "sampleRate": 0,
    "channels": 2,
    "fileName": "夜曲_剪辑.mp3"
  }
}
```

**字段说明（主轨）**

| 字段 | 类型 | 必填 | 范围/默认 | 说明 |
| :--- | :--- | :---: | :--- | :--- |
| `version` | int | 是 | 1 | Schema 版本 |
| `planId` | string | 否 | ≤40 字符 | 客户端生成，用于日志关联；服务端返回自己的 taskId |
| `template` | enum | 否 | `free`/`ringtone`/`concat`/`mix`/`silence` | 只影响限额与默认参数，不改变渲染规则 |
| `sources` | object | 是 | **1～3 个 main（上限 5）** + 0～1 个 bgm | key 为 `src_*`；`role=main/bgm` |
| `main.clips` | array | 是 | 1～50 个 | 顺序即输出顺序；每个 clip 合法则整体合法 |
| `clip.in/out` | number | 是 | `0 ≤ in < out ≤ source.duration`；`out-in ≥ 0.2` | 毫秒精度；超出源时长拒绝 |
| `clip.gainDb` | number | 否 | -24～+12，默认 0 | 单段增益 |
| `main.speed` | number | 否 | 0.5～2.0，默认 1.0 | 整条主轨变速；输出时长 = Σclip / speed |
| `main.gainDb` | number | 否 | -24～+12，默认 0 | 主轨整体增益（与 clip.gainDb 叠加，总增益上限 +12） |
| `main.fadeInSec` / `main.fadeOutSec` | number | 否 | 0～5；不重叠；以**变速后的输出时间轴**计算 | 成片整体淡入/淡出（P0）；片段间交叉淡入淡出留 P2 |
| `main.normalize` | bool | 否 | false | 单遍 loudnorm（**P2**：1 CPU 实测 5min≈21s、10min≈42s，暂不进 v1.1，保留字段） |
| `export.format` | enum | 是 | `mp3`/`wav`/`flac`/`m4a`（m4a P1） | 默认 mp3 |
| `export.bitrate` | enum | 否 | 128k/192k/320k（仅 mp3/m4a） | 默认 192k |
| `export.sampleRate` | number | 否 | 0（跟随源；多源时默认 44100）/44100/48000 | WAV 强制 44100；0 时单源=源采样率、多源=44100 |
| `export.channels` | number | 否 | 2（默认）/1 | 单声道可减体积；不匹配源时走重编码 |
| `export.fileName` | string | 否 | ≤60 字符 | 服务端清洗非法字符 |

**配乐轨（P1）**

| 字段 | 范围/默认 | 说明 |
| :--- | :--- | :--- |
| `bgm.sourceId` | 必填 | 必须 `role=bgm` 的源 |
| `bgm.in/out` | 0 ≤ in < out ≤ duration | 配乐取用区间 |
| `bgm.startOffsetSec` | -30～+30，默认 0 | 相对成片起点的偏移；负值=裁掉配乐开头 |
| `bgm.loop` | bool，默认 true | 成片比配乐长时循环 |
| `bgm.gainDb` | -30～0，默认 -12 | 配乐音量，通常压低 10～15dB |
| `bgm.fadeInSec/fadeOutSec` | 0～5 | 配乐淡入/淡出 |
| `bgm.duck` | bool，默认 false | 侧链自动闪避（P1，需实测 `sidechaincompress`） |

### 5.3 派生值与校验规则（服务端为准）

```text
outputDuration = sum(clip.out - clip.in) / main.speed
outputBytes ≈ outputDuration × bitrate / 8（用于提示与 LIMIT 预检，不精确）
```

| # | 规则 | 不通过错误码 |
| :--- | :--- | :--- |
| V1 | `sources` 中 main 数量 1～3（P0；SPIKE 后 5），bgm ≤1；每个源 record 属于当前 openid | `INVALID_PLAN` / `FORBIDDEN` |
| V2 | `clips` 1～50；每个 clip 时间在源范围内、`out-in ≥ 0.2` | `INVALID_PLAN` |
| V3 | `outputDuration` 0.3～600s；铃声模板 ≤40s；超过 600s 拒绝 | `OUTPUT_TOO_LONG` |
| V4 | 源文件总大小 ≤100MB；**P0 主轨源总时长 ≤900s、配乐 ≤600s**；SPIKE-E12 通过后 1200s（解码预算，见 §11.1） | `INPUT_TOO_LARGE` |
| V5 | `fadeInSec + fadeOutSec ≤ outputDuration`；配乐 fade 不越界 | `INVALID_PLAN` |
| V6 | `speed ∈ [0.5,2.0]`；`gain` 范围合法 | `INVALID_PLAN` |
| V7 | 格式/码率/采样率/声道在白名单；m4a 输出时长受 §11.2 限制 | `UNSUPPORTED_FORMAT` / `OUTPUT_TOO_LONG` |
| V8 | 输出预估时长对应的格式安全上限（§11.2） | `EXPORT_LIMIT` |
| V9 | 源文件存在且未过期（≤24h）；已下载校验可解码 | `SOURCE_EXPIRED` / `DECODE_FAILED` |

**服务端必须重新计算，不能信任客户端传入的 `outputDuration`。** 客户端只传 plan。

### 5.4 撤销 / 重做 / 草稿

| 项 | 设计 |
| :--- | :--- |
| 撤销粒度 | 每次「提交型」操作（删除选区、拖动片段结束、面板点确定）入栈；拖动滑杆时只在 `touchend` 入栈（预览实时生效） |
| 栈深 | 30 步；超出丢弃最早 |
| 快照大小 | 约 1～8KB/步（JSON），30 步 <250KB，可放内存；不建议整包存 storage |
| 重做 | 与撤销对称；任何新编辑清空 redo 栈 |
| 草稿 | `wx.setStorageSync('editor_draft_v1', {plan, sources, analysisIds, updatedAt})`，操作后 1s 防抖；页面 `onHide/onUnload` 强制保存 |
| 恢复 | 进入编辑页若存在 ≤24h 草稿且 `analysis` 未过期 → 弹「继续上次剪辑？」；源过期则提示重新导入（保留 plan 但无法预览/导出） |
| 过期清理 | 启动时清理 >24h 草稿；不存任何可公开访问 URL（临时 URL 可存但会过期，用前重新换） |

### 5.5 模板预置（客户端只改默认值，服务端只校验限额）

| 模板 | 默认行为 | 默认参数 | 限额 |
| :--- | :--- | :--- | :--- |
| `free` 自由剪辑 | 导入后进入编辑，无预设选区 | 整段 clip，mp3 192k | §11.1 |
| `ringtone` 手机铃声 | 引导选一段 ≤40s；默认选区取 0～30s（用户可改） | 整体 fadeOut 1.5s，mp3 192k，命名 `_铃声.mp3` | 成片 ≤40s |
| `concat` 语音拼接 | 多选 2～5 个会话音频，按顺序 append；可选段间 0.2s 静音 | 无效果，mp3 192k | 源 ≤5 |
| `mix` 配乐混音 | 选主音频 + 选配乐；配乐默认循环、-12dB、淡出 3s | 配乐 `loop=true` | 主+配乐各 ≤10min |
| `silence` 静音清理 | 用 peaks 自动检测首尾/中间静音（阈值 -40dBFS、>0.6s），生成 clip 列表后交用户确认 | 无效果 | P1 |

> 模板不是独立代码路径：`ringtone` 仅设置 `maxOutputSec=40` 与服务端限额；`silence` 由客户端根据 peaks 生成普通 clips；`concat` 只是多 source 的 clips 排列。避免维护两套编辑逻辑。

### 5.6 v1.1 冻结行为表（唯一值；UX/测试/文案均引用本表）

| # | 行为 | 冻结值（v0.2） | 与 UX 旧稿的差异 |
| :--- | :--- | :--- | :--- |
| 1 | 主轨源文件数 | **P0 ≤3；SPIKE-E12 通过后 ≤5**；UX 建议的 9 不采纳 | UX 写 ≤9 → 以本表为准 |
| 2 | 源总时长 / 成片时长 | 主轨源总时长 P0 ≤900s（后 1200s）；成片 ≤600s；铃声模板 ≤40s | UX 只写合计 ≤10min |
| 3 | 导出格式 | **P0：mp3（192k 默认）/wav（≤4min）/flac（≤7min）；m4a P1（≤8min）；OGG 不支持** | UX 把 M4A/OGG 列为默认/高级 → P1/不支持 |
| 4 | 草稿 TTL | **24h**（本地 1 条）；不是 7 天 | UX 写 7 天 → 以本表为准 |
| 5 | 铃声限额 | **>40s 硬拦**（客户端禁导出 + 服务端 V3 拒绝）；模板 P0 上线 | UX 写"只提示不硬拦" → 以本表为准 |
| 6 | 额度 | **测试期 `QUOTA_ENFORCED=false` 不限次数；开关开启时 5 次/日共享、导出成功扣 1、失败返还**；不把 5 次写死进 UI | UX 全量文案写死 5 次/日 → 以本表为准 |
| 7 | 选区最小时长 | **0.2s**（服务端 V2 同值） | UX 写 0.1s → 以本表为准 |
| 8 | 取消导出 | **v1.1 不提供取消**；导出中可退后台，回来查结果；无 `cancelEditTask` | UX 有"取消（退次）"→ 作废 |
| 9 | Canvas/手势 | 主轨 276pt、配乐轨 56pt、标尺 22pt；zoom ≤20×；长按 500ms；单指拖波形=选区（编辑优先）；滚动走路标/双指 | UX §4/§5 与本表一致的部分保留 |
| 10 | 预览实例 | **2 个常驻**（主轨+BGM）；A/B 预热默认关闭，S4 扩展验证通过再启用 | CLIENT 建议 2 常驻，采纳 |
| 11 | 快剪 | 仅 mp3/m4a/wav 单段无效果；**flac 禁用**；含任何效果/多段/改 sampleRate/channels 必须重编码 | 新增参数校验 |
| 12 | 导出超时 | 云函数硬超时 60s；函数内 deadline 55s；FFmpeg 45s；客户端轮询 90s；任务 75s 无 lease → TIMEOUT+退次 | 统一四档预算 |
| 13 | 分析预算 | 客户端等待 20s：8s 切文案、10s 重试 1 次、20s 失败；服务端 peaks 子步骤 15s | 统一 |
| 14 | 数据格式 | peaks 为 **uint8 0–255**（不是有符号 int8），接口回传 `buckets` | 命名修正 |
| 15 | 源文件归属 | 上传走 `createUploadTicket`（cloudPath 含 openid），`analyzeAudio` 必须带 ticket；`edit_tasks`/`audio_analyses` 双重归属校验 | 新增安全机制 |
| 16 | 云函数命名 | v1.1 继续用 `ffmpegProbe`（避免迁移风险）；更名 `audioStudio` 列为 P2 | Q10 改建议 |

> 与 UX 冲突时以本表为准；UX 文档文首已加「冲突以主文档 v0.2 为准」的对齐说明。数字口径统一：时长秒 ±0.1s、体积 MB（十进制）±1MB、耗时 ms。

> **planHash 规范化（评审 B2）**：`planHash = sha256(canonicalJson(plan)).slice(0,16)`；规范化规则 = 对象 key 升序、数字统一四舍五入到 3 位小数、省略值为默认/0/false 的可选字段、数组保持顺序、剔除 `planId`/`clientToken` 等非内容字段。用于 24h 内同 plan 去重与问题回放，不同客户端实现必须一致。

---

## 6. 客户端详细设计

### 6.1 页面与组件

| 页面/组件 | 路由/路径 | 职责 | 备注 |
| :--- | :--- | :--- | :--- |
| 首页入口卡 | `pages/index` 内 | 「音乐剪辑」模板入口（自由剪辑/铃声/拼接/配乐） | 在现有页面上追加，不动转换主流程 |
| 编辑页 | `pages/editor/editor` | 分析、编辑、预览、导出、结果，单页状态机 | 新增；页面参数 `?analysisIds=…&template=ringtone&entry=result` |
| 波形时间轴 | `components/waveform-timeline` | 画波形/标尺/选区/播放头/片段/双轨，派发手势事件 | 纯 canvas + 事件；不直接改 plan |
| 工具面板 | `components/tool-sheet` | 裁剪/删除/淡入淡出/音量/变速/配乐的面板容器 | 通用底部弹层，内容由 slot/配置驱动 |
| 片段条 | `components/clip-bar` | 展示片段列表、拖动排序、删除/复制 | 长按拖动；点击定位 |
| 导出栏 | `components/export-bar` | 格式选择、额度提示、导出按钮 | 固定底部，含安全区 |
| 分析视图 | `components/analysis-view` | 上传进度、分析进度、失败重试 | 覆盖编辑区 |
| 结果面板 | `components/edit-result` | 成片试听、大小、转发/PC 保存/再剪 | 复用 v1.0 结果卡样式 |
| 预览引擎 | `utils/audio-preview.js` | InnerAudioContext 池、播放队列、淡入淡出近似、BGM | 非组件，页面持有一个实例 |
| 编辑计划工具 | `utils/edit-plan.js` | 不可变操作、派生时长、校验、模板、序列化 | 纯函数，便于单测 |
| 格式化/云工具 | `utils/format.js` / `utils/cloud.js` | 时长/大小/格式/临时 URL/上传封装 | 从 `pages/index` 抽取 |

> 现有首页代码内联了大量云调用与播放器逻辑，编辑页应复用抽取后的工具；抽取属 v1.0 技术债清理，建议在 M5/M6 顺带完成，不单独排期。

### 6.2 编辑页状态与视图

| 状态 | 触发 | 主视图 | 可执行动作 |
| :--- | :--- | :--- | :--- |
| `UPLOADING` | 进入页面时带了本地文件/录音 | 上传进度（逐文件） | 取消上传、重试 |
| `ANALYZING` | 上传完成 | 分析动画 + 步骤文案（解析音频 → 生成波形 → 准备试听） | 取消（清理临时文件）、失败重试 |
| `EDITING` | 全部源分析成功 | 波形时间轴 + 工具栏 + 导出栏 | 全部编辑操作、预览、导出、退出（存草稿） |
| `EXPORTING` | 点导出并确认 | 全屏/半屏进度卡：阶段文案 + 已用时间 + 提示 | 无取消（可退后台，回来查询），防重复点击 |
| `SUCCESS` | 渲染成功 | 结果面板（试听/分享/再剪） | 转发、PC 保存、复制链接、再剪一次、回首页 |
| `EXPORT_FAILED` | 渲染失败/超时 | 错误卡 + 原因 + 重试/换参数 | 重试（同 token 查回）、降级（改短/改格式）、返回 |
| `DRAFT` | 用户中途退出 | 下次进入首页/编辑页提示恢复 | 继续/放弃 |

**页面参数与入口**

| 入口 | 参数 | 行为 |
| :--- | :--- | :--- |
| 首页「音乐剪辑」卡 | `?template=free` | 打开发起选择文件 |
| 首页模板卡 | `?template=ringtone/concat/mix/silence` | 预设参数，仍走选择文件 |
| 转换结果卡「继续剪辑」 | `?fileID=…&analysisId=…&template=free` | 跳过选择，直接用已有源分析（若已有 analysisId 则直接进入分析/编辑） |
| 历史记录「继续剪辑」 | `?fileID=…` | 校验文件未过期后重新分析 |
| 草稿恢复 | 无参数，检测本地草稿 | 弹窗恢复 |

### 6.3 波形与时间轴渲染

**数据格式（服务端 analysis 返回）**

```json
{
  "analysisId": "a_1730081234000_xx",
  "duration": 245.612,
  "bucketMs": 50,
  "peaks": {
    "peak": "<base64，长度 ceil(duration*1000/50)，每字节 0-255>",
    "rms":  "<base64，同上>"
  },
  "format": "mp3",
  "sampleRate": 44100,
  "channels": 2,
  "playable": true,
  "proxyUsed": false
}
```

- `peak`：该 50ms 桶内 |样本| 最大值，线性映射到 0～255（`round(amp*255)`，amp∈[0,1]）。
- `rms`：该桶内均方根，同样映射；用于内层填充与更柔和的视觉。
- 10 分钟 = 12000 桶 → 每数组 12KB，base64 约 16KB，两个数组 ≈32KB；3 分钟 ≈10KB。数据量可接受，直接随 analysis 返回，无需分页。
- 客户端用 `wx.base64ToArrayBuffer` 解码为 `Uint8Array`；不逐桶 setData。

**绘制方案（Canvas 2D 视口画布 + view 覆盖层）**

```text
<canvas type="2d" id="wave" class="wave-canvas" disable-scroll
        bindtouchstart=... bindtouchmove=... bindtouchend=... />
初始化：SelectorQuery.select('#wave').fields({node:true,size:true})
       canvas.width = width * dpr; canvas.height = height * dpr
       ctx.scale(dpr, dpr)
视口：viewport = {startSec, endSec}，由 scrollOffset + zoom 决定
每帧：只绘制 viewport 内的桶 → 屏幕列（每列取桶区间 max(peak)、max(rms)），
      视口下实际只画 ≈188～800 根柱（不是「整条 12000 桶」）
      上轨主音频（276pt）、下轨配乐（56pt，未启用时虚线占位）
      选区背景、选中片段轮廓、时间标尺（独立 22pt 高）
覆盖层（view 绝对定位）：播放头、选区手柄、时间气泡、循环标记
```

| 项 | 规格 |
| :--- | :--- |
| 画布硬限制 | 官方：Canvas 2D 需显式宽高、默认 300×150、**最大 1365×1365**，过大宽高安卓可能 crash → **只做视口画布**（≈750×432rpx），绝不做整条 10min 长画布 |
| 画布尺寸 | 宽 = 屏宽内容区 343pt（686rpx）；主轨 276pt（552rpx）、配乐轨 56pt（112rpx）、标尺 22pt（44rpx）；总高约 370pt；DPR3 时 1029×1110 < 1365 上限 |
| 重绘触发 | 手势移动（合并到 `requestAnimationFrame` 每帧一次）、缩放、选区变化、plan 变化；播放中**不重绘波形**，播放头用 view overlay 的 `transform` 每 100ms 更新 |
| 播放头 | 红色 2rpx 竖线 + 顶部三角；位置 = (currentSec - viewport.startSec) / windowSec × width |
| 时间标尺 | 根据 pixelsPerSecond 自适应：≥120px/s 显示 1s 刻度；30～120 显示 5s；<30 显示 10s/30s；标签 `mm:ss`（放大后 `mm:ss.s`） |
| DPR | 取 `wx.getWindowInfo().pixelRatio`，`canvas.width = 逻辑宽 × dpr` 并 `ctx.scale`；高 DPR 设备 `min(dpr,3)`，低端机 `min(dpr,2)` |
| 触摸坐标 | canvas touch 事件的 `Touch.x/y` 是**相对 canvas 左上角**（官方）；手势直接用，需扣除内边距 |
| 阻止滚动 | canvas 加 `disable-scroll`；编辑器页面画布区域不随页面滚动 |
| 同层渲染 | canvas 2.9.0+ 支持同层渲染，view 覆盖层可安全叠加；iOS 不支持 `pointer-events`，覆盖层用 `catchtap` |
| 性能预算 | 单次重绘 ≤8ms（中端安卓）；拖动 ≥50fps；10min 全览按列聚合降采样到 ≤800 柱，1s 窗口按桶插值 |
| 低端降级 | `benchmarkLevel` 低 / 内存告警时：降 DPR、关 rms 层、柱宽 3～4pt；仍卡则降级为「每 200ms 一根」的简化波形 |
| 缓存 | 缩放档位切换时重算列聚合；可用离屏 canvas 缓存静态波形层（P2） |

**缩放与滚动**

- 默认 `zoom=1`：整段音频铺满屏宽；`zoom` 可到 **20×**（UX 统一值；约 40px/s，1px≈25ms），配合 0.1s 吸附与 ±0.1s 按钮满足精度。
- 双指缩放以两指中点为锚；**MVP 手势「编辑优先」**：单指拖波形 = 新建/调整选区；横向滚动走「拖动标尺 / 双指平移 / 底部滚动条」三条路径之一（见 §7.3 与 UX 规格）。
- 缩放后若播放头/选区出视口，自动滚动到最近边缘（动画 ≤150ms）。
- 选区最小 **0.2s**（服务端 V2 同值）；手柄视觉宽 10pt、命中 44pt，允许超出波形区上下边界。
- 点按阈值：位移 <8pt 且 <250ms 判点按；边缘 24pt 内拖手柄/选区 500ms 后自动滚动；长按统一 500ms。

### 6.4 手势与选区交互

| 手势 | 区域 | 行为 | 冲突处理 |
| :--- | :--- | :--- | :--- |
| 点按 | 波形/标尺 | 播放头移到该时间（吸附 0.1s） | 位移 <8pt 且 <250ms 才判点按 |
| 单指横向拖动 | 波形空白区 | **新建选区**（编辑优先） | 与滚动分离：滚动只走标尺拖动/双指/底部滚动条 |
| 拖动选区手柄 | 手柄命中区（≥44pt） | 调整 start/end，实时显示 `mm:ss.S` 气泡 | 手柄优先级最高 |
| 拖动选区内部 | 选区 | 整体平移选区（不改变长度） | 位移 >12pt 才进入平移 |
| 双指捏合/平移 | 波形区 | 缩放视图 / 横向平移（不改 plan） | `touches.length===2` 后锁定，touchend 归零；画布 `disable-scroll` |
| 拖动片段芯片 | 片段条 | 调整片段顺序（拼接） | 长按 500ms 进入拖动 |
| 双击 | 波形 | 放大到选区/点击点（可选） | MVP 可不做 |
| 播放按钮 | 底部工具区 | 播放/暂停；长按循环试听选区 | — |

**阈值汇总（全文档唯一值）**：点按 8pt/250ms；手柄命中 44pt；双指判定 150ms；长按 500ms；边缘 24pt 持续 500ms 触发自动滚动；吸附 0.1s（可关）；选区最小 0.2s；zoom 上限 20×；常驻 `-0.1s / +0.1s` 按钮兜底。

**精确微调**：选区两端支持 `-0.1s / +0.1s` 按钮与滑动微调；面板显示 `mm:ss.S`；导出前若选区边界小于 0.2s 则阻止并提示。

**撤销/重做**：工具栏常驻两个图标（不可用时置灰）；每次提交型操作入栈；拖动过程中实时预览但不入栈。

### 6.5 预览引擎（`utils/audio-preview.js`）

**目标**：用最低实现成本让用户「听到大致结果」；不追求采样级精确，UI 明确提示以导出为准。

**实例与资源**

| 资源 | 数量 | 用途 |
| :--- | :--- | :--- |
| `main` | 1（常驻） | 主轨片段顺序播放；段间用 `seek` 切换（间隙目标 ≤300ms） |
| `bgm` | 1（常驻） | 配乐同步播放（`loop=true`） |
| `mainNext`（可选） | 0～1 | A/B 预热优化，默认关闭；需 S4 扩展验证通过再启用 |
| `src` 设置 | 每个 source 一次 | 直接 `src = source.fileID`（官方 2.2.3+ 支持云文件 ID）；片段定位统一用 `seek(offset)` |

- 所有实例在 `onHide/onUnload` 停止并 `destroy()`（官方：音频资源不会自动释放）；同一时间最多 3 个实例。
- 首次进入编辑页调用 `wx.setInnerAudioOption({ obeyMuteSwitch: true, mixWithOther: true })`（**遵守 iOS 静音键**，不强制外放；用户听不到时提示检查静音键）；不要与 WebAudio 混用。
- `onTimeUpdate` 官方未承诺频率（不要假设 250ms）：**判界用 `onTimeUpdate` + 按 `(out-in)/speed` 估算的定时器双保险**，谁先到用谁；选区边界误差按 ±0.3s 设计并在文案说明。
- 系统中断用 `wx.onAudioInterruptionBegin/End` 处理（来电等）。

**播放队列构建**

```text
输入：plan.main.clips + plan.main.speed
输出：schedule = [
  { src, offset: clip.in, begin: 0,        dur: (out-in)/speed, gainDb, fadeIn, fadeOut },
  { src, offset: clip.in, begin: dur1,     dur: ...,              ... }
]
```

- 每个片段使用 `InnerAudioContext` 播放：`ctx.src = fileID; ctx.seek(offset); ctx.play()`；监听 `onTimeUpdate` + 定时器，当位置到达 `offset + 段时长 × speed` 时暂停并切下一段。
- 段间切换：默认单实例 `seek`（官方 ms 精度）+ 定时器双保险；**段间间隙目标 ≤300ms，待真机实测**；若间隙明显，再启用 A/B 预热（默认关闭，避免多实例限制）。
- 淡入/淡出：`onTimeUpdate` 或 50ms 定时器设置 `volume`：`v = clamp(进度比例) × 基础音量`；体积小、开销低；无法做精确曲线，听感上足够判断「有没有淡入」。
- 变速：`playbackRate = plan.main.speed`（官方范围 0.5～2.0），段时长按 `/speed` 计算；**是否保持音调官方未说明，需真机验证**；不保调时提示「预览音调可能不同，导出会保持音调」。
- 配乐：`bgm` 实例独立；`loop=true`；音量 = 10^(gainDb/20)；根据 `startOffsetSec` 决定开始时机（正=延迟，负=从配乐内部偏移起播）；配乐淡出用同样的 volume 渐变；成片结束时停止。
- 循环试听选区：只播放与选区相交的片段局部，`loop` 由页面定时器重新入队；停止时清定时器。
- 音量增益：`volume` 只有 0～1，**>0dB 的放大无法预览**（封顶 1），只体现相对大小；导出才真实增益。

**明确不支持的预览能力（UI 提示一次即可）**

- 段间可能有极短静音/爆音；淡入淡出为音量台阶；配乐循环点可能有细微空隙；变速音调可能与导出不同；响度标准化（loudnorm）无法预览。
- 文案：「预览为快速近似效果，导出后以实际文件为准」。

**降级**

- 若预览初始化失败（fileID 不可播/实例创建失败/格式不支持）：显示「预览不可用，可直接导出后试听」，保留编辑与导出；**不阻塞导出**。
- 双实例混播失败/被系统中断：降级为「只播主轨」，BGM 提示「导出后可听到配乐」。
- `wx.onMemoryWarning`：释放 peaks 缓存、停止预览、清离屏 canvas，提示重启；编辑计划保留在草稿。
- 若文件 >50MB 或时长 >10min：在分析阶段已拦截，不会进入编辑。

### 6.6 导入、上传与分析

| 步骤 | 规则 | 失败处理 |
| :--- | :--- | :--- |
| 选择文件 | `wx.chooseMessageFile({count: 主轨上限 5, type:'file', extension:[…]})`；仅视频/图片不支持 | 取消不报错；隐私未授权引导（沿用 v1.0 文案） |
| 本地预检 | 扩展名白名单；单文件 ≤50MB；P0 主轨 ≤3 个（上限 5）；WAV 源提示「建议 ≤4.7min」；提示「剪辑支持 10 分钟以内」 | 立即弹窗，不进入上传 |
| 上传 | `wx.cloud.uploadFile` 并发 ≤2；显示单文件进度与总进度；**提示「上传期间请保持微信在前台」**（官方：切后台 5s 中断） | 失败文件可单独重试/移除 |
| 分析 | 串行调用 `analyzeAudio`；客户端等待预算 **20s**：>8s 切「分析有点慢」，>10s 重试 1 次，>20s 失败；服务端 peaks 子步骤 15s | 失败可重试；已成功文件保留；不扣额度 |
| 进入编辑 | 全部成功后用分析结果构建 sources 与默认 clips；当前平台不可播的源显示「本机不支持该格式试听」横幅 | 若部分失败，提示「移除失败文件后继续」 |

**录音入口**：沿用 `RecorderManager`（aac/mp3/wav，≤10min）；停止后得到临时路径，走同一上传/分析链路；麦克风隐私声明与 v1.0 一致。

**从转换结果「继续剪辑」**：结果页把 `fileID + analysisId?` 传给编辑页；若文件仍存在（≤24h），直接分析/进入编辑；否则提示「文件已过期，请重新选择」。

**多源拼接（P1）**：选择顺序即默认拼接顺序；用户可在片段条拖动调整；每个源独立分析，分析结果按 `analysisId` 缓存。

### 6.7 导出流程

1. **前置校验**：plan 合法、`outputDuration` ≤600s（铃声 ≤40s）、额度剩余 >0、格式安全矩阵允许、源分析未过期。
2. **确认面板**：成片时长、预估大小、格式/码率、本次扣 1 次（剩余 X 次）、隐私/版权提示；用户确认后调用。
3. **PREPARING**：生成 `clientToken` → `createEditTask({clientToken, plan, analysisIds, template})`；成功拿 `taskId` 后**立即同步写本地 storage `editor_task_v1`**（不等防抖），用于切后台/杀进程后恢复查询。此步应当 ≤5s（只做校验/落库），失败直接展示错误，不扣次。
4. **RENDERING**：立刻 `runEditTask({taskId})`；显示阶段文案（「正在下载素材」→「正在渲染」→「正在上传结果」）与已用秒数；**禁止重复提交**。多数前台场景在此拿到结果。
5. **POLLING（兜底）**：若 `runEditTask` 调用失败/超时/用户切后台回来，则用 `getEditTask({taskId})` 轮询（1.5s→3s，最长 90s）：
   - `queued` → 再调一次 `runEditTask` 续跑（最多 2 次）；
   - `running` → 继续轮询（服务端 75s 判超时并返还）；
   - `succeeded` → 展示结果；`failed` → 展示原因/重试。
6. **成功**：拿 `fileID`（结果播放直接用 fileID，官方 2.2.3+ 支持），展示结果面板；写本地历史（type=edit，含 plan 摘要与 `taskId`）；更新首页额度。
7. **失败重试**：优先复用同一 `taskId` 续跑（服务端幂等）；若任务已失败，用新 `clientToken` 重试（服务端会重新预占/失败返还）。若明确是参数错误（如输出超限），引导修改参数/缩短时长。
8. **用户离开**：导出中可返回/锁屏；回来后首页或编辑页提示「有一单导出在进行/已完成」，可查结果（`taskId` 存本地草稿）。

### 6.8 草稿与恢复

- 触发保存：操作后 1s 防抖、`onHide`、`onUnload`、导出前。
- 保存内容：`editPlan`、`sources`（含 `analysisId/fileID/name/duration/format`）、`analysisId`、`updatedAt`、`exportConfig`；**不存 peaks**（可从 analysis 缓存重新拉，或进入时重新分析；为恢复速度可另存 peaks，但需控制 storage 体积）。
- 恢复条件：草稿 ≤24h 且 analysis 记录未过期；过期则保留 plan 但标记「素材已清理，需重新导入」。
- 冲突：同一时间只保留一个草稿；新编辑覆盖旧草稿；用户放弃时清理。
- 历史记录：仅保存已导出结果（fileID/名称/格式/时间/expiresAt/plan 摘要），不保存源文件。
- **taskId 立即落库**：`createEditTask` 返回后同步写 `editor_task_v1`（不等 1s 防抖）；杀进程/切后台回来可查询/续跑，避免重复预占。

### 6.9 错误与降级

| 场景 | 用户看到 | 动作 | 备注 |
| :--- | :--- | :--- | :--- |
| 源文件 >10min（或 WAV >4min） | 「剪辑支持 10 分钟以内（WAV 建议 4 分钟以内）」 | 换文件/去转换 | 与 v1.0 转换 30min 区分 |
| 源文件 >50MB | 「单文件请控制在 50MB 以内」 | 重选 | |
| 不支持/损坏/改扩展名 | 「这个文件解析失败，可能已损坏或不是音频」 | 重选/重试 | 服务端 ffmpeg 探测为准（扩展名不可信） |
| 分析失败（服务） | 「准备波形失败，请重试」 | 重试/返回 | 给 traceId（可选） |
| iOS 不支持播放源格式 | 顶部横幅「iPhone 不支持该格式试听，可编辑并导出，或先转为 MP3」；预览按钮置灰 | 导出/先转 MP3 | P0 不生成代理 |
| 导出超时/断网 | 「网络不稳定，正在确认结果…」→ 查到/查不到 | 重试（同 token） | 不重复扣次 |
| 额度不足 | 「今日免费次数已用完（5/5），明天再来」 | 返回 | 分析不扣次，用户仍可预览 |
| 输出超限（10min/铃声 40s） | 「成片超过 X 分钟，请缩短」 | 回到编辑 | 服务端为主 |
| 内容安全拦截（若开通） | 「文件未通过安全检查，无法导出」 | 删除/换文件 | 不展示细节 |
| 源过期 | 「素材已过期（24h），请重新导入」 | 重选 | 草稿保留 |
| 云函数不可用/冷启动慢 | 「服务准备中，请稍候」+ 重试 | 重试 | 与 v1.0 一致 |
| 切后台/来电 | 预览暂停；导出中回来查结果 | 恢复 | 页面 onShow 处理 |
| 重复点击导出 | 按钮禁用 + toast「正在导出」 | — | 双保险（clientToken） |

### 6.10 性能与包体预算

| 项 | 预算 | 说明 |
| :--- | :--- | :--- |
| 编辑页 JS 增量 | ≤60KB（未压缩） | 不引第三方波形/手势库，手写 canvas |
| 组件 + WXML/WXSS 增量 | ≤50KB | 复用现有样式变量 |
| 首屏进入编辑器（已有分析） | ≤300ms | 波形首次绘制 ≤100ms |
| 分析完成（3min / 10min mp3） | P95 ≤3s / ≤8s | 服务端实测 4kHz 解码 3min≈1.3s、10min≈4.0s + 分桶；含下载/探测余量 |
| 预览启动延迟 | ≤300ms | fileID 已拿到即可；首次加载受网络缓冲影响 |
| 拖动/缩放帧率 | ≥50fps 中端安卓 | 视口画布重绘 ≤8ms；播放头走 view overlay |
| 导出等待（3min 精修） | P95 ≤25s | 服务端实测约 2～4s；含上传/下载/排队余量 |
| 导出等待（10min 最坏组合） | P95 ≤40s | 服务端实测 22.7s；超时则提示缩短 |
| 内存峰值 | ≤120MB（编辑页） | 不整段解码/不驻留 PCM；播放器及时 destroy；监听内存告警 |
| 草稿 storage | ≤200KB | 不含 peaks |

---

## 7. UX 规格摘要

> 完整交互、文案、尺寸与线框见 [UX_EDITOR_SPEC.md](./research/UX_EDITOR_SPEC.md)（含 `docs/research/ux/*.svg` 低保真线框）。本节只保留进入开发必须对齐的决策，**若与 UX 文档冲突，以本文档的边界/限额为准，交互细节以 UX 文档为准**。

### 7.1 入口与首次使用

- 首页在「转换」主流程下方增加**音乐剪辑卡片区**：一句价值 + 模板 chip。**P0 上线：自由剪辑 / 手机铃声；语音拼接 / 配乐混音为 feature flag（未上线隐藏）**；不改变原「选择音频 → 转换」的主按钮层级。
- 首次进入编辑页展示 1 张半透明引导（仅一次）：「拖动两下手柄选区，点 ✂ 就剪好了」；可直接跳过。
- 转换结果卡增加次级按钮「继续剪辑这段音频」；历史记录项增加「继续剪辑」（文件未过期时可见）。

### 7.2 编辑器布局（375pt 基准，自上而下）

```text
┌─────────────────────────────────────┐
│ ‹ 返回        音乐剪辑        ↺  ↻   │ 44pt 导航（自定义）
├─────────────────────────────────────┤
│ 00:42.3 / 03:18.0        [循环试听]  │ 24pt 时间信息
│ ┌─────────────────────────────────┐ │
│ │  标尺  0:00   0:30   1:00 …     │ │ 20pt
│ │ ▁▂▅█▇▅▂▁ 主轨波形（选区高亮）     │ │ 60pt
│ │         [选区手柄]               │ │
│ │ ▁▃▅▇▅▃▁ 配乐轨（未启用时占位）     │ │ 28pt
│ └─────────────────────────────────┘ │
│  🔍−  ├──────●──────┤  🔍+   ⤢ 适应 │ 缩放
├─────────────────────────────────────┤
│  ✂裁剪  🗑删除  ⧉复制  ↕排序(拼接)   │ 工具横条（可滚动）
│  🌊淡入淡出  🎚音量  ⏩变速  🎵配乐   │
├─────────────────────────────────────┤
│ 片段: [1 ▁▂▅ 00:32] [2 ▁▃ 00:30] +  │ 片段条 40pt
├─────────────────────────────────────┤
│ 预计 01:02 · ≈1.4MB    [ 导出 MP3 ▾ ]│ 底部固定栏 56pt + 安全区
└─────────────────────────────────────┘
```

- 选区手柄：视觉宽 12rpx，命中区 88rpx × 波形区全高；拖出时间气泡（`mm:ss.S`）。
- 工具面板从底部弹出（高度 ≤ 屏高 55%），带遮罩；面板内改动实时生效（预览跟随），点「完成」入 undo 栈。
- 导出栏上方显示额度：`今日剩余 3 次`；额度为 0 时按钮置灰并解释「分析/预览仍可用」。

### 7.3 手势决策（与 §6.4 对齐）

| 手势 | 结果 |
| :--- | :--- |
| 点按波形 | 移动播放头 |
| 单指拖动波形（所有 zoom） | **新建/调整选区**（编辑优先） |
| 横向浏览 | 拖动标尺 / 双指平移 / 底部滚动条三选一（MVP 实现前两者） |
| 拖手柄 | 调整选区边界（吸附 0.1s 网格，可关闭吸附） |
| 双指捏合 | 缩放视图（不修改 plan） |
| 拖动片段芯片 | 调整片段顺序（拼接） |
| 底部播放按钮 | 播放/暂停；长按 = 从选区起点循环 |

### 7.4 主要文案（节选，完整见 UX 文档）

| 场景 | 文案 |
| :--- | :--- |
| 入口卡 | 「剪一段，刚刚好」/「裁剪 · 拼接 · 淡入淡出 · 配乐」 |
| 分析中 | 「正在准备波形…」「音频有点长，再等几秒」 |
| 超过 10min | 「剪辑目前支持 10 分钟以内的音频，更长的可以先用格式转换处理」 |
| 预览提示 | 「预览是快速近似效果，导出后以实际文件为准」 |
| 导出中 | 「正在合成你的音频…（已用 8 秒）」 |
| 额度不足 | 「今天的 5 次免费额度用完了，明天再来；波形和预览不受影响」 |
| 铃声限制 | 「铃声建议 40 秒以内，超出后无法导出」 |
| 版权提示 | 「请确认你对该音频拥有合法使用权；本工具不提供曲库，也不提供公开分享」 |

### 7.5 埋点（与 §13 测试一起验收）

`editor_enter`（入口来源/模板）、`editor_import_result`（数量/格式/时长段）、`editor_analyze`（成功/失败/耗时）、`editor_op`（操作类型/选区时长/片段数）、`editor_preview_play`（类型/时长）、`editor_export_start`（格式/时长/片段数/是否快剪）、`editor_export_result`（成功/失败码/耗时/扣次）、`editor_share`、`editor_draft_restore`。埋点不含文件名、不含音频内容标识。

---

## 8. 服务端详细设计

### 8.1 代码组织（云函数内）

```text
cloudfunctions/ffmpegProbe/            # v1.1 更名 audioStudio（保留旧名灰度）
├── index.js            # action 分发、openid、配额、cleanup、错误兜底
├── bin/ffmpeg          # 现有静态 7.0.2（唯一副本，勿复制）
├── lib/
│   ├── ffmpeg.js       # prepareBinary / runFfmpeg(args, timeout=45s, killSignal=SIGKILL) / probeAudio()
│   ├── analyze.js      # analyzeAudio：下载→探测→peaks→落库
│   ├── edit.js         # createEditTask / runEditTask / getEditTask
│   ├── filtergraph.js  # EditPlan → ffmpeg args（纯函数，可单测）
│   ├── peaks.js        # PCM buffer → 50ms 桶 peak/rms base64
│   ├── plan.js         # plan schema 校验、派生时长、限额矩阵
│   └── quota.js        # 共享配额（含预占/返还）
└── package.json        # 仅 wx-server-sdk，不新增依赖
```

**约束**：不引入 npm 依赖（保持部署包体积与冷启动）；`filtergraph.js`/`peaks.js`/`plan.js` 用纯 Node 实现，方便本地 `node --test` 单测。

### 8.2 `analyzeAudio` 流程

```text
1. 入参：{action:'analyzeAudio', ticketId, fileID, fileName, size, clientToken}
2. 鉴权：ctx.OPENID；ticket 必须存在、未过期、openid 一致、fileID 等于 ticket.cloudPath 对应的 fileID；文件必须存在且大小一致
3. 查重：audio_analyses 中同 openid + fileID + status=ready 且未过期 → 直接返回（省算力）
4. 限流：analysisCount（当日）< 30，否则 ANALYZE_LIMITED
5. 下载：cloud.downloadFile(fileID) → Buffer；>50MB 拒绝；写 /tmp/ed_{rand}.{ext}
6. 探测（**云函数未打包 ffprobe**，用 ffmpeg -i 解析 stderr；现有 `parseDuration` 已用此法）：
   ffmpeg -hide_banner -nostdin -i /tmp/ed_x.ext 2>&1
   - 解析 `Duration: HH:MM:SS.xx`、`Audio: <codec>, <sr> Hz, <mono|stereo|...>, <bitrate>`、format 名称
   - **注意：ffmpeg -i 无输出文件时退出码恒为 1**，不能用退出码判失败，只解析 stderr
   - 无 `Audio:` 行 / duration<=0 → DECODE_FAILED
   - duration > 600s → DURATION_TOO_LONG（提示 10 分钟以内）
   - 可选：若后续要精确 tags/码率，再评估打包静态 ffprobe（+体积）或解析更多 stderr 字段；MVP 不需要
7. peaks：ffmpeg -v error -i /tmp/ed_x.ext -ac 1 -ar 4000 -f s16le /tmp/ed_x.pcm（超时 15s）
   - 读 PCM，按 200 samples（50ms）分桶：peak=max|s16|/32768、rms=sqrt(mean(s^2))/32768
   - 量化 int8：Uint8Array(round(amp*255))；base64 编码；两数组等长
8. 计算 playableIos/playableAndroid（格式矩阵；P0 不生成试听代理）
9. 落库 audio_analyses：analysisId（服务端生成 a_*）、openid、fileID、fileName、size、
   duration、format、sampleRate、channels、bucketMs=50、buckets、peaks、playableIos、playableAndroid、
   status='ready'、createdAt、expiresAt=now+24h
10. 返回 {success:true, data:{...}}；finally 删除 /tmp 临时文件
```

**性能预算**：3min mp3 总耗时 ≤3s；10min mp3 ≤8s（仅探测+peaks，不生成代理；实测 4kHz 解码 3min≈1.3s、10min≈4.0s）。以 [FFMPEG_EDIT_SPIKE](./research/FFMPEG_EDIT_SPIKE.md) 实测为准。

**注意**：
- 不落库/返回长期 URL；客户端播放直接用 fileID（官方 2.2.3+ 支持），避免临时链接 10min/2h 过期问题。
- 不生成试听代理：iOS 不可播格式返回 `playableIos=false`，客户端提示「有波形、能编辑、不能试听」+「先转 MP3」入口；P1 若做代理再补 `edit_previews/` 目录与清理。
- 源文件保留 24h 供导出任务使用；不在此函数删除。

### 8.3 导出任务：`createEditTask` / `runEditTask` / `getEditTask`

**为什么拆三个动作**：`callFunction` 无客户端 timeout 参数、网络默认 60s、切后台 5s 会中断（E-C11）。导出要「校验/扣次/执行/结果」四件事都有持久化锚点，才能做到不丢单、不重复扣次、可恢复。客户端体验仍是「点导出 → 看进度 → 拿结果」，只是结果通道从「一次长调用」改为「长调用优先 + 轮询兜底」。

**A. `createEditTask`（快，目标 ≤5s；只做校验/预占/落库，不执行 FFmpeg）**

```text
1. 入参：{action:'createEditTask', clientToken, plan, analysisIds:[...], template}
2. 基础校验：plan.version=1；JSON ≤32KB；clientToken 正则 ^u_[0-9]{13}_[a-z0-9]{6,12}$
3. 幂等：edit_tasks where clientToken & openid → 存在则返回现有 {taskId,status}（不重复扣次）
4. 校验 plan（服务端为准，先校验后预占，避免非法请求占额度）：
   - 按 analysisIds 查 audio_analyses：openid 归属、status=ready、未过期
   - plan.sources 的 fileID/name/duration 必须与 analysis 记录一致（不信任客户端）
   - §5.3 全部规则；outputDuration、格式安全矩阵（§11.2）；模板限额（ringtone ≤40s）
5. 配额预占（仅 QUOTA_ENFORCED=true 时执行；测试期跳过、quotaCharged=false）：
   - quota 文档 {openid_date, count, analysisCount, updatedAt}
   - db.runTransaction：读→校验 count<5→count+1→写 edit_tasks(status='queued',
     quotaCharged=true, plan=<完整 EditPlan ≤32KB>, planSchema=1, planHash=…)
   - 事务失败重试 1 次，仍失败 → SERVICE_BUSY
6. 返回 {taskId, status:'queued', pollAfterMs:1500, quota:{used,limit} or null}
```

**B. `runEditTask`（执行，≤55s；客户端前台调用一次，失败可重试）**

```text
1. 入参：{action:'runEditTask', taskId}
2. 归属：task.openid === ctx.OPENID；按 status：
   - succeeded → 直接返回 result（幂等）
   - failed → 返回原错误（客户端可换 clientToken 重试）
   - running 且 leaseAt 未过期（<70s）→ EXPORT_RUNNING {taskId}（客户端转 getEditTask）
   - queued 或 lease 过期 → 抢占：CAS 更新 status='running', leaseAt=now, attempts+1
3. 读取 task.plan；下载源：每个 source cloud.downloadFile → /tmp/edit_{taskId}_{i}.{ext}
   - 单文件 ≤50MB、总量 ≤100MB；WAV 源 ≤4min（10min WAV≈106MB 必超 50MB）；写前检查 /tmp 剩余空间
4. 构建命令：filtergraph.js（§8.4）→ args
5. 执行 runFfmpeg(args, timeout=**45000**, killSignal=**SIGKILL**)
   - FFmpeg 预算 45s，函数总预算 55s（留 10s 下载/上传/DB）
   - 超时 → TIMEOUT；非 0 → DECODE_FAILED/EXPORT_FAILED（stderr 脱敏取末 300 字）
   - 退出码 183（空/无法识别）、234（无音轨/参数错误）映射为可读错误
   - 输出文件 >50MB（50MB 硬限）→ OUTPUT_TOO_LARGE
6. ffmpeg 探测输出 → 时长/大小校验（与预期差 >2s 记 warning，不直接失败）
7. 上传：cloud.uploadFile → edit_outputs/{taskId}.{ext}（**cloudPath 不含用户文件名**）；展示名由 result.fileName 单独返回
8. 落库成功：status='succeeded'、result{fileID,size,duration,format,bitrate}、leaseAt=0、
   costMs、finishedAt；converted_files.add({openid,fileID,kind:'edit_output',...}) 供清理
9. 返回 result；finally 删除 /tmp 输入/输出
```

**C. `getEditTask`（查，快；轮询/恢复唯一入口）**

```text
1. 入参：{action:'getEditTask', taskId}
2. 归属校验 task.openid === ctx.OPENID
3. 惰性超时：
   - status='running' 且 now - leaseAt > 75s → failed/TIMEOUT + 返还（幂等，只返一次）
   - status='queued' 且 now - createdAt > 90s → failed/TIMEOUT + 返还（覆盖「create 后从未 run/杀进程」）
4. 返回 {taskId,status,result?,error?,progressHint}；result 只返回 fileID（客户端直接播放/下载），
   不返回长期 downloadUrl
5. 不扣次、不触发执行
```

**失败与返还**：`runEditTask` 内任何失败 → `status='failed'`、`error={code,message}`；若 `quotaCharged=true` 且未返还 → `quota.count -= 1`（clamp ≥0），标记 `quotaRefunded=true`（幂等，避免双退）。**超时/实例被杀**：`getEditTask` 惰性判定（running lease 超 75s / queued 超 90s）+ `cleanup` 兜底（每日 + 每次 create/analyze 顺带清理少量）。同 openid + planHash 且 24h 内 succeeded → 可直接返回已有结果（clientToken 之外的二次去重）。

**可选后台化（P1，非 P0 依赖）**：若云开发环境为**按量付费**且「数据库事件触发器」配置可用，可监听 `edit_tasks` 插入/更新，在 `status='queued'` 时自动触发同一云函数执行 `runEditTask`；客户端只需 `createEditTask + getEditTask` 轮询，切后台也能完成。注意：事件触发器当前**仅按量付费环境支持、仅数据库集合类型**，触发条件/事件 payload 需按控制台文档配置并实测（SPIKE-E10）。官方文档：[事件触发器](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/functions/EveTrigger.html)（2026-10-28 核验）。

### 8.4 Filter graph 编译规则（`lib/filtergraph.js`）

**输入**：`plan`、各 source 的 `/tmp` 路径与探测信息、导出参数。**输出**：`{args, expectedDuration, usesFastCopy}`。

**规则 0：快速路径（仅 mp3/m4a/wav，且满足全部条件）**

```text
usesFastCopy = plan.main.clips.length===1
  && plan.bgm.enabled===false
  && clip.gainDb===0
  && plan.main.gainDb===0 && plan.main.speed===1
  && plan.main.fadeInSec===0 && plan.main.fadeOutSec===0
  && plan.main.normalize===false
  && export.format===source.format
  && export.format ∈ {mp3, m4a, wav}          // flac 禁用；ogg/opus 未验证不开放
  && (export.bitrate 未变化或与源码率同档)                       // 码率变化必须重编码
  && (export.sampleRate===0 || export.sampleRate===source.sampleRate)
  && export.channels===source.channels                            // 改采样率/声道必须重编码
```

命令（注意：**不要**给 m4a 加 `-avoid_negative_ts make_zero`，会把误差从 +0.5ms 放大到 +23.6ms）：

```bash
ffmpeg -hide_banner -nostdin -loglevel error -y   -ss {clip.in} -to {clip.out} -i /tmp/edit_x.mp3   -map 0:a:0 -c copy -map_metadata -1   /tmp/edit_out.mp3
```

- **已实测精度**：mp3 +17.4ms（恒定，≤1 帧 26.1ms，无开头爆音）；m4a +0.5~6.1ms；wav +0.4ms；**flac +81.6ms 且容器时长不更新（60s 输出仍报 180s）→ flac 永久禁用 copy**，改重编码（10min 仅 +2.6s）。
- **多段 copy 拼接会漂移**（concat demuxer 3min 段 +23.9ms、3 段 +66ms）→ 拼接一律重编码；copy 只用于「单段连续区间 + 无任何效果」。
- copy 输出时长必须回传实际值（用 ffmpeg -i 解析或解码校验），客户端时间轴以此为准；**不能只信 flac 类容器的 duration**。
- UI 标注「快速导出：切点精度约 0.03 秒（mp3）」；对精度敏感或需要效果时自动走重编码。
- copy 路径不得加 `-b:a`。

**规则 1：重编码主路径**

```text
对每个 source i：-i /tmp/edit_{taskId}_{i}.{ext}
主轨每个 clip（按 main.clips 顺序）：
  [i:a]atrim=start={in}:end={out},asetpts=PTS-STARTPTS[,volume={clip.gainDb}dB]
  → [c1] [c2] ...
  # 不显式堆 aresample/aformat：FFmpeg 7 的 auto_conversion_filters 会自动转换；
  # 输出用 -ar/-ac 统一规格。确需显式归一时必须加 -filter_complex_threads 1。
拼接： [c1][c2]…concat=n={N}:v=0:a=1[main0]
变速： [main0]atempo={speed}[main1]          # 1.0 时省略；>2 需串联
主轨音量：[main1]volume={main.gainDb}dB[main2]  # 0 时省略；放在混音前
配乐（若启用，输入侧循环，省内存）：
  -stream_loop -1 -i /tmp/edit_{taskId}_bgm.ext
  # offset>0 时：atrim 先扣掉 offset，adelay 后再算 fade；offset<0 则全部作用在 bgm.in
  [j:a]atrim=start={bgm.in}:end={bgm.in + max(0, outputDur - offsetSec)},
        asetpts=PTS-STARTPTS,
        adelay={startOffsetMs}|{startOffsetMs},
        volume={bgm.gainDb}dB,
        afade=t=in:st={offsetSec}:d={bgm.fadeIn},
        afade=t=out:st={outputDur-bgm.fadeOut}:d={bgm.fadeOut}
  → [bgm0]
混音： [main2][bgm0]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[main3]
整体淡入淡出（必须在 atempo/混音之后，st 按输出时间轴）：
  [main3]afade=t=in:st=0:d={fadeInSec}[main4]                       # 0 时省略
  [main4]afade=t=out:st={outputDur-fadeOutSec}:d={fadeOutSec}[main5]  # 0 时省略
限幅： [main5]alimiter=limit=0.95:level=false[aout]      # level=false 必须；否则自动增益
响度（P2，仅 ≤180s）：[main5]loudnorm=I=-16:TP=-1.5:LRA=11[main6] 后强制 -ar 44100
输出： -map [aout] -map_metadata -1 -t {outputDur} -ar {sr} -ac {ch} + 编码参数
```

**顺序原则（已由实测修正）**：逐段 `atrim+asetpts`（+片段增益）→ `concat` → `atempo` → 主轨 `volume` → 配乐链（`volume/afade/adelay`）→ `amix` → **整体 afade** → `alimiter` → `-t`。反例：若先 afade 再 atempo，淡出位置提前到 `st/speed`（实测 57s 淡出变成 38s）；若 afade 放在混音前，BGM 不会被整体淡出。片段级淡入淡出（P2）需按 `Σ(前序片段时长)/speed` 计算各段输出位置后再插 afade。

**编码参数（与现有 `convertFile` 一致，减少差异）**

| 输出 | 参数 |
| :--- | :--- |
| mp3 | `-c:a libmp3lame -b:a {bitrate} -ar {sr} -ac {ch}` |
| wav | `-c:a pcm_s16le -ar {sr} -ac {ch}`（默认 44100；产品上限 4min） |
| flac | `-c:a flac -compression_level 5 -ar {sr} -ac {ch}`（产品上限 7min） |
| m4a（P1） | `-c:a aac -aac_coder fast -b:a {bitrate} -movflags +faststart`（产品上限 8min，留 2× 安全系数） |

**工程护栏（必须写进 `lib/ffmpeg.js`）**
- `execFile(bin, args, { timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 4MB, windowsHide: true })`：**SIGTERM 杀不掉 `-stream_loop -1` 的无限输入（实测 9s 仍未退出），必须 SIGKILL**。
- 所有命令 `-hide_banner -nostdin -y -loglevel error`；复杂 filter（concat/amix）加 `-filter_complex_threads 1`（1 vCPU 下默认线程会抢核，3×2min concat 从 7.3s 劣化到 24~26s）。
- **永远 `-t {outputDur}`**：既是精确裁尾，也防 BGM 无限循环把 /tmp 写爆（反例 235s 写出 259MB / 10824s 音频）。
- 输出后 `statSync(out).size > 50MB` → 删除并返回 `OUTPUT_TOO_LARGE`；按格式提前预检体积（WAV 4min≈42MB、FLAC 7min≈45~50MB）。
- `-map_metadata -1` 默认去除源元数据（隐私最小化）；若产品后续要保留标题/作者，再做显式白名单。
- 需要进度时用 `-progress pipe:1 -stats_period 1`，解析 `out_time_us`（注意 `out_time_ms` 实际也是微秒）；当前同步任务只用于日志，不做客户端流式进度。

**已实测确认的细节**（FFmpeg 7.0.2 / Docker 1 CPU，详见 [FFMPEG_EDIT_SPIKE.md](./research/FFMPEG_EDIT_SPIKE.md)）：
- `afade` 必须在 `atempo` 之后，且整体 fade 放在 `amix` 之后（同时淡化主轨+BGM）。
- BGM 循环优先用输入侧 `-stream_loop -1` + filter `atrim`（内存省）；`aloop` 也可用但内存约 ×2（3min BGM 26MB→50.6MB）。
- `amix` 默认 `normalize=1` 会把主轨压 -4.6dB；必须 `normalize=0`。`alimiter` 默认 `level=1` 会自动增益 +0.5dB；必须 `level=false`。
- `concat` 自动转换已足够；**不要显式堆 aresample/aformat**。确需显式归一 + 复杂多输入时必须 `-filter_complex_threads 1`。
- `loudnorm` 单遍 5min≈20.8~21.5s、10min≈41.9s，且默认改采样率（wav 输出变 192kHz）→ 仅 ≤3min 可用，v1.1 放 P2。
- copy 快剪：mp3 +17.4ms、m4a +0.5~6.1ms、wav +0.4ms；flac 禁用。m4a copy **不要**加 `-avoid_negative_ts`。
- 扩展名不可信（wav 改名 .mp3 可正常解码）；以探测到的音频流为准。
- `ffmpeg -i` 探测（无输出文件）退出码恒为 1，不能以退出码判失败；解析 stderr 的 `Duration`/`Audio:` 行。
- m4a(aac fast) 10min 编码实测 16.9s，但宿主竞争可到 35.9s → 产品上限保留 8min + 2× 安全系数。

### 8.5 快剪（无损导出）策略

| 条件 | 行为 |
| :--- | :--- |
| 单源、单片段、无任何效果、目标格式=源格式、码率未改、格式 ∈ {mp3,m4a,wav} | 走 `-c copy`，通常 <0.2s；UI 标「快速导出」 |
| 格式为 flac | **禁止 copy**（容器时长错误/精度差），一律重编码（10min 仅 +2.6s） |
| 只改格式（如 flac→mp3） | 重编码（格式变了不能 copy） |
| 有淡入淡出/音量/变速/拼接/配乐/响度 | 重编码 |
| 源为 amr/ape/wma/ogg/opus 或容器兼容性未知 | 重编码为所选格式 |
| 多段 copy 拼接 | 不启用（concat demuxer 会漂移 +24~66ms）；拼接一律 filter concat 重编码 |
| copy 失败（输出不可播/时长异常） | **自动降级重编码一次**，记录 `fallbackReencoded=true` |

### 8.6 超时、断连与恢复

| 场景 | 服务端 | 客户端 |
| :--- | :--- | :--- |
| 正常完成 | `runEditTask` 返回 result | 展示结果 |
| `runEditTask` 调用超时/网络失败 | task 仍在 `queued/running`；不自动失败 | 用 `taskId` 调 `getEditTask`；若 `queued` 再调 `runEditTask` 续跑（≤2 次）；`running` 则轮询 |
| 用户切后台/来电（官方：5s 后网络请求中断） | `runEditTask` 可能未收到/中断；task 状态保留 | 回前台后按 `taskId` 轮询；服务端 75s 无进展判 TIMEOUT + 返还 |
| FFmpeg 超 45s / 函数超 55s | kill → failed `TIMEOUT`，返还额度 | 提示「音频较长，渲染超时」+ 建议缩短/改格式 |
| 云函数实例崩溃/被杀 | task 停在 running，lease 不再续 | `getEditTask` 惰性判 75s → TIMEOUT + 返还；cleanup 兜底 |
| 重复提交/重试 | `createEditTask` 按 clientToken 幂等；`runEditTask` 按 taskId+lease 防并发 | 复用同一 taskId；UI 禁用按钮 |
| 内容安全 risky（若开通） | 删输出、task 标记 `blocked` | 隐藏导出/提示不可用 |
| 可选事件触发器 | queued 任务由触发器执行 | 只 create + 轮询（P1） |

**待验证事项（SPIKE-E1）**：真机上 `createEditTask` + `runEditTask` + 轮询的完整体验；`runEditTask` 等待 30～50s 是否被系统中断；切后台/灭屏后服务端是否继续执行；中断后 `getEditTask` 能否查到结果。若「客户端断开即导致函数被取消」，则以「重试 runEditTask（同 taskId）」恢复；若平台对长调用有硬上限，则必须启用 P1 事件触发器或把单次预算缩到 ≤20s。

### 8.7 内容安全与清理

- **内容安全**：沿用 v1.0 策略。个人主体当前无 `security.mediaCheckAsync` 权限，代码开关关闭；权限开通后对 `edit_outputs` 成片做 best-effort 送检（≤10MB 直接送；>10MB 生成 32k 代理）。命中 risky：删除输出、任务标记 `safety_risky`、客户端不可导出；窗口策略与协议披露不变。
- **清理**：扩展 `cleanup` action：
  - `converted_files` 中 `kind` ∈ {`edit_source`,`edit_preview`,`edit_output`} 的文件 >24h 删除；
  - `audio_analyses` 记录 >24h 删除；`edit_tasks` 记录 >48h 删除（保留元信息用于问题追踪的阶段可延长，但需脱敏）；
  - 解析失败/取消的临时文件在 finally 删除，不依赖定时器。

### 8.8 成本与并发护栏

| 护栏 | 值 | 说明 |
| :--- | :--- | :--- |
| 云函数超时 | 60s 硬超时；内部 deadline 55s；FFmpeg 45s | 与 v1.0 一致（v1.0 转换仍用现有 50s 预算） |
| 单次分析时长 | ≤10min 源 | 超过拒绝 |
| 单次渲染时长 | ≤10min 成片 | 格式矩阵再收紧 |
| 分析频率 | 30 次/日/openid；串行 | 防止刷波形/分析算力 |
| 导出额度 | 可配置：测试期不限次数；正式建议 5 次/日/openid（与转换共享） | 预占+失败返还；开关 `QUOTA_ENFORCED` |
| 并发 | 客户端单线程；服务端平台自动扩缩 | 不引入队列 |
| 存储 | 源/输出 24h 清理；单文件 ≤50MB（源）/≤50MB（输出，待实测可放宽） | |
| 冷启动 | 首次分析可能有 1～3s 冷启动；文案「准备中」 | 与 v1.0 一致 |

---

## 9. 接口规格

### 9.1 通用约定

- **调用方式**：`wx.cloud.callFunction({name:'ffmpegProbe'（v1.1 更名 audioStudio）, data:{action, ...}})`；服务端以 `ctx.OPENID` 鉴权，不接受客户端传 openid。
- **响应包络**：
  ```json
  { "success": true,  "data": { } }
  { "success": false, "code": "INVALID_PLAN", "errorMessage": "用户可读文案", "traceId": "t_...", "detail": "日志用，不展示" }
  ```
- **版本**：`action` 内不再分版本；`plan.version` 控制协议；新增字段可选，服务端兼容缺省。
- **大小限制**：请求 JSON ≤32KB；响应 peaks ≤64KB（分析）、结果 ≤8KB（渲染）。
- **超时**：分析客户端等待 ≤20s；`createEditTask` ≤5s；`runEditTask` ≤55s（切后台会被系统中断，见 §8.6）；`getEditTask` ≤5s。
- **错误码**见 §9.7；所有错误必须可映射到用户文案，未知错误统一 `INTERNAL`。

### 9.2 action 一览

| action | 调用特征 | 作用 | 扣次 | 超时预算 |
| :--- | :--- | :--- | :---: | :--- |
| `createUploadTicket` | 同步、快 | 签发绑定 openid 的 cloudPath | 否 | 3s |
| `analyzeAudio` | 同步 | 探测 + peaks + 可播标记 | 否 | 20s |
| `createEditTask` | 同步、快 | 校验 plan + 预占额度 + 落 queued 任务 | 预占 1（失败返还） | 5s |
| `runEditTask` | 同步、长 | 执行渲染（可按 taskId 重试/续跑） | 不重复扣 | 55s |
| `getEditTask` | 同步、快 | 按 taskId 查状态/结果（轮询/恢复） | 否 | 5s |
| `convertFile` | 同步 | v1.0 转换（不变） | 是 | 55s |
| `cleanup` | 定时/手动 | 清理过期文件与记录 | 否 | 60s |

> 客户端顺序：`createEditTask` → `runEditTask` →（失败/中断）`getEditTask` 轮询 → 必要时重试 `runEditTask`。后端 P1 可加事件触发器自动执行 queued 任务，客户端只 create + poll。

### 9.3 `analyzeAudio`

请求：

```json
{
  "action": "analyzeAudio",
  "ticketId": "up_1730081234000_ab12",
  "fileID": "cloud://cloud1-d0g1pwjogd2f39be2.xxx/edit_sources/oXxx/1730081234_ab12.mp3",
  "fileName": "夜曲.mp3",
  "size": 8421376,
  "clientToken": "u_1730081234567_ab12cd"
}
```

响应：

```json
{
  "success": true,
  "data": {
    "analysisId": "a_1730081234567_xy12",
    "duration": 245.612,
    "format": "mp3",
    "sampleRate": 44100,
    "channels": 2,
    "bitrate": 192000,
    "size": 8421376,
    "bucketMs": 50,
    "buckets": 4912,
    "peaks": { "peak": "…base64…", "rms": "…base64…" },
    "playableIos": true,
    "playableAndroid": true,
    "playable": true,
    "proxyUsed": false,
    "costMs": 1832
  }
}
```

> 客户端以当前平台字段判断：`playableIos=false` 时 iPhone 顶部提示「iPhone 不支持该格式试听，可编辑并导出，或先转为 MP3」；`playableAndroid=false` 同理（少见）。**不返回长期 URL**，播放直接传云文件 ID（官方 2.2.3+ 支持），避免临时链接 10min/2h 过期问题。

错误：`INVALID_FILE` / `FILE_TOO_LARGE` / `DURATION_TOO_LONG` / `DECODE_FAILED` / `ANALYZE_LIMITED` / `STORAGE_ERROR` / `INTERNAL`。

### 9.3.1 `createUploadTicket`（新增，安全前置）

请求：`{ "action": "createUploadTicket", "fileName": "夜曲.mp3", "size": 8421376, "ext": "mp3" }`

响应：

```json
{ "success": true, "data": { "ticketId": "up_1730081234000_ab12", "cloudPath": "edit_sources/oXxx/1730081234_ab12.mp3", "expiresAt": 1730084834000 } }
```

- 服务端生成 `edit_sources/{openid}/{ts}_{rand}.{ext}`；`upload_tickets` 记录 ticketId/openid/cloudPath/size/ext/expiresAt(2h)/used。
- `analyzeAudio` 必须带 ticketId 且 fileID 与 cloudPath 一致；ticket 一次性使用（同一文件只发一个 ticket）。
- 这样源文件天然按 openid 隔离，堵住「已知他人 fileID 即可 analyze/导出」的越权路径（评审 M12）。

### 9.4 导出三接口

**9.4.1 `createEditTask`（快返回）**

```json
{
  "action": "createEditTask",
  "clientToken": "u_1730081300000_ab12cd",
  "template": "free",
  "analysisIds": ["a_1730081234567_xy12"],
  "plan": { "version": 1, "sources": { }, "main": { }, "bgm": { }, "export": { } }
}
```

响应：

```json
{
  "success": true,
  "data": {
    "taskId": "e_1730081300123_ab12cd",
    "status": "queued",
    "pollAfterMs": 1500,
    "quota": null
  }
}
```

> `quota` 在 `QUOTA_ENFORCED=false` 时为 `null`。

错误：`INVALID_PLAN` / `OUTPUT_TOO_LONG` / `UNSUPPORTED_FORMAT` / `EXPORT_LIMIT` / `QUOTA_EXCEEDED` / `SOURCE_EXPIRED` / `SERVICE_BUSY` / `INTERNAL`。

**9.4.2 `runEditTask`（执行）**

请求：`{ "action": "runEditTask", "taskId": "e_1730081300123_ab12cd" }`

成功响应（结构同下 `getEditTask` 的 result）：

```json
{
  "success": true,
  "data": {
    "taskId": "e_1730081300123_ab12cd",
    "status": "succeeded",
    "result": {
      "fileID": "cloud://…/edit_outputs/夜曲_剪辑_e_xxx.mp3",
      "fileName": "夜曲_剪辑.mp3",
      "format": "mp3",
      "bitrate": "192k",
      "size": 2531123,
      "sizeText": "2.4MB",
      "duration": 62.0,
      "fastCopy": false,
      "costMs": 8123
    },
    "quota": null,
    "safety": { "status": "pending" }
  }
}
```

- 任务已被其它调用执行中：`{success:false, code:'EXPORT_RUNNING', taskId}` → 客户端转 `getEditTask`。
- 失败：`TIMEOUT`/`DECODE_FAILED`/`EXPORT_FAILED`/`OUTPUT_TOO_LARGE`/`INTERNAL`；额度由服务端返还。
- 任务已 succeeded：直接返回原 result（幂等）。

**9.4.3 `getEditTask`（查）**

请求：`{ "action": "getEditTask", "taskId": "e_…" }`

响应：

```json
{
  "success": true,
  "data": {
    "taskId": "e_…",
    "status": "succeeded",
    "result": { "fileID": "cloud://…", "fileName": "…", "size": 2531123, "duration": 62.0, "format": "mp3", "costMs": 8123 },
    "error": null,
    "quota": null
  }
}
```

| status | 含义 | 客户端动作 |
| :--- | :--- | :--- |
| `queued` | 已创建/待执行（事件触发器未启用时） | 再调 `runEditTask` 一次；或提示稍后 |
| `running` | 渲染中 | 1.5s→3s 轮询；超过 75s 服务端转 failed |
| `succeeded` | 完成 | 展示结果（播放/下载直接用 fileID） |
| `failed` | 失败 | 展示错误码文案 + 重试（新 clientToken） |
| `blocked` | 内容安全拦截 | 不可导出 |

> 服务端可只返回 fileID；如客户端需要下载（转发/PC 保存），直接 `wx.cloud.downloadFile({fileID})`，不依赖临时 URL。

### 9.5 取消语义（v1.1：不提供取消）

- v1.1 **不提供取消导出**：`runEditTask` 是同步 FFmpeg 执行，无法安全中断后复用；强行中断会造成半成品与退次复杂度。
- 导出中允许退后台/返回；回来用 `taskId` 查结果（或续跑）。UI 不出现「取消」按钮，只出现「可以离开，完成后可在历史中查看」。
- 若后续要做取消：新增 `cancelEditTask(taskId)`，仅 `queued/running` 可取消，取消后 `failed`+退次，幂等标记 `quotaRefunded`；该接口 v1.1 不实现（与 UX 旧稿的「取消退次」冲突，以本节为准）。

### 9.6 与 v1.0 `convertFile` 的兼容

- 仍支持旧请求（无 action 时按 `fileID` 推断 `convertFile`，与现状一致），避免历史版本客户端不可用。
- `convertFile` 的返回结构不变；新增字段只增不删。
- 云函数更名时保留旧函数名 1～2 个版本（或直接沿用旧名 `ffmpegProbe`，v1.1 不强制更名，见 §17 待确认）。

### 9.7 错误码总表（编辑新增）

| code | HTTP/语义 | 用户文案 | 触发 |
| :--- | :--- | :--- | :--- |
| `INVALID_PLAN` | 参数 | 「编辑参数不合法，请重试」 | plan 结构/字段/范围错误 |
| `DURATION_TOO_LONG` | 源 | 「剪辑支持 10 分钟以内」 | 源 >600s |
| `OUTPUT_TOO_LONG` | 输出 | 「成片超过时长上限，请缩短」 | 成片 >600s / 铃声 >40s |
| `FILE_TOO_LARGE` | 源 | 「单个文件请控制在 50MB 以内」 | 源 >50MB |
| `INPUT_TOO_LARGE` | 源 | 「素材总大小超限，请减少源文件」 | 源总量 >100MB |
| `UNSUPPORTED_FORMAT` | 格式 | 「暂不支持该导出格式」 | 格式/码率/参数白名单外 |
| `EXPORT_LIMIT` | 格式 | 「该格式建议更短时长，请改用 MP3」 | 格式安全矩阵（§11.2） |
| `SOURCE_EXPIRED` | 源 | 「素材已过期，请重新导入」 | analysis 记录过期/文件被清理 |
| `DECODE_FAILED` | 源 | 「音频无法解析，可能已损坏」 | ffmpeg 探测/解码失败（退出码 183/234 等） |
| `TIMEOUT` | 服务 | 「渲染超时，请缩短音频或改用 MP3」 | FFmpeg 超 45s / 函数预算 55s / 任务 75s 无 lease |
| `OUTPUT_TOO_LARGE` | 输出 | 「导出文件过大，请降低码率/缩短时长」 | >50MB |
| `QUOTA_EXCEEDED` | 额度 | 「今日免费次数已用完（5/5）」 | 预占失败（仅额度开关开启时） |
| `ANALYZE_LIMITED` | 频控 | 「操作太频繁，请稍后再试」 | 分析 >30 次/日 |
| `SERVICE_BUSY` | 服务 | 「服务繁忙，请稍后重试」 | 事务/并发失败 |
| `SAFETY_RISKY` | 安全 | 「文件未通过安全检查，无法导出」 | 内容安全命中（若开通） |
| `NETWORK_ERROR` | 客户端 | 「网络不稳定，请重试」 | 客户端映射 |
| `FORBIDDEN` | 鉴权 | 「无权访问该文件」 | fileID/analysisId/task 归属不符 |
| `EXPORT_RUNNING` | 状态 | 「正在导出中」 | runEditTask 发现同 task 已被执行（客户端转轮询） |
| `UPLOAD_FAILED` | 存储 | 「上传失败，请重试」 | 源文件未直传成功/票据过期 |
| `STORAGE_ERROR` | 存储 | 「存储服务暂不可用」 | 云存储下载/上传失败 |
| `INTERNAL` | 未知 | 「服务开小差了，请重试」 | 未捕获异常 |

> 与 v1.0 错误码（`INVALID_FILE`/`UPLOAD_FAILED`/…）共用前缀风格，客户端统一在 `utils/errors.js` 映射。

---

## 10. 数据模型

### 10.1 云数据库集合

**`audio_analyses`**（新增；单文档约 20～40KB）

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `_id` | string | `analysisId`，`a_${ts}_${rand}` |
| `openid` | string | 归属；所有读写校验 |
| `fileID` | string | 源文件；与客户端 plan 中一致才有效 |
| `fileName` / `size` | string/number | 元信息 |
| `duration` / `format` / `sampleRate` / `channels` / `bitrate` | | ffmpeg -i 探测结果 |
| `bucketMs` | number | 固定 50 |
| `peaks` | object | `{peak:base64, rms:base64}` |
| `playableIos` / `playableAndroid` / `playable` | boolean | 分平台可播标记（`playable=双端都行`）；格式白名单 · 2.2.3+ `src` 支持 fileID |
| `peaksHash` | string | 波形缓存键（fileID+hash） |
| `previewFileID` | string | P1 试听代理 fileID（P0 恒空，保留字段） |
| `status` | string | `ready`（失败不落库或落 `failed` 供排查） |
| `createdAt` / `expiresAt` | number | 24h TTL（逻辑过期 + cleanup 删除） |

**`upload_tickets`**（新增，安全）

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `_id` | string | `ticketId`（up_*） |
| `openid` | string | 归属 |
| `cloudPath` | string | `edit_sources/{openid}/{ts}_{rand}.{ext}` |
| `size` / `ext` | number/string | 声明值，analyze 时校验 |
| `expiresAt` | number | 2h |
| `used` | boolean | analyze 成功后置 true |
| `createdAt` | number | cleanup 48h 删除 |

**`edit_tasks`**（新增）

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `_id` | string | `taskId`，`e_${ts}_${rand}` |
| `clientToken` | string | 客户端幂等键；**唯一索引建议**（openid+clientToken） |
| `openid` | string | 归属 |
| `status` | string | `created/running/succeeded/failed/blocked` |
| `template` | string | 模板 |
| `planHash` | string | plan 规范化后的 sha256 前 16 位（日志/排重） |
| `plan` | object | **完整 EditPlan（≤32KB，服务端专用，48h TTL）**；run/重试/恢复/后台触发器都从这里读；不返回客户端 |
| `planSchema` | number | plan Schema 版本（=1） |
| `planBrief` | object | 摘要（源数/片段数/成片时长/格式/是否配乐），仅用于日志/列表；**不替代 plan** |
| `quotaCharged` | boolean | 是否已预占额度 |
| `result` | object | `{fileID,size,duration,format,bitrate,costMs,fastCopy}` |
| `error` | object | `{code,message}`（message 脱敏） |
| `timings` | object | `{downloadMs,renderMs,uploadMs,totalMs}` |
| `startedAt` / `finishedAt` | number | 超时判定与监控 |
| `attempts` | number | 重试次数 |
| `expiresAt` | number | 48h 后清理 |

**`quota`**（扩展现有）

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `_id` | string | `${openid}_${date}`（现有格式） |
| `openid` / `date` | string | 现有 |
| `count` | number | **转换 + 编辑导出**共享次数（保持现有语义） |
| `analysisCount` | number | 当日分析次数（≤30） |
| `updatedAt` | number | 现有 |

**`converted_files`**（扩展现有）

现有字段 `{openid,fileID,size,format,createdAt}`；新增 `kind`：`convert_output`（默认）/`edit_source`/`edit_preview`/`edit_output`。cleanup 按 `createdAt` 删除并 `deleteFile`。

### 10.2 本地存储

| key | 内容 | 大小 | 生命周期 |
| :--- | :--- | :--- | :--- |
| `editor_draft_v1` | plan + sources + analysisIds + updatedAt | ≤200KB | 24h / 用户放弃 |
| `editor_task_v1` | 最近一次导出 taskId + clientToken + 状态 + 时间 | <1KB | 24h / 成功后保留供历史 |
| `audio_history_v1`（现有 `historyList` 扩展） | 记录 `type:'convert'|'edit'`、fileID、名称、格式、时间、过期标记、planBrief | ≤100KB（20 条） | 24h 标记过期，用户可清空 |
| `editor_quota_cache` | 最近一次额度 | <1KB | 每日 |

> 不存源文件二进制、不存临时 URL、不存音频内容标识。

### 10.3 生命周期与清理

```text
0h     导入 → edit_sources/（源，≤50MB/个）
~1s    分析 → audio_analyses（peaks + playable）
导出   → edit_outputs/ + edit_tasks.succeeded
2h     upload_tickets 过期（analyze 前校验；cleanup 删除）
24h    cleanup：删源/输出文件（P1 代理同理）；删 audio_analyses；历史条目标记「文件已清理」
48h    cleanup：删 edit_tasks（或保留脱敏摘要 7 天，视排查需要）
```

- 清理频率：云函数定时触发器每日 1 次（现有）+ 每次 analyze/render 顺带清理少量（防止长期无调用堆积）。
- 幂等：`cleanup` 可重复执行；删除失败记录保留，下次再试。
- 存储成本估算见 §11.4。

---

## 11. 限额、配额与成本

### 11.1 输入限额

| 项 | 限制 | 依据 |
| :--- | :--- | :--- |
| 单个源文件 | ≤50MB、时长 ≤10min（600s）；**WAV 源 ≤4min、FLAC 源按实际大小 ≤50MB（约 8min）** | 路线 A 60s 超时 + 50MB 硬限；10min WAV≈106MB、10min 真实 FLAC 45~65MB |
| 主轨源文件数 | **P0 1～3 个（上限 5）** | 拼接主场景；5 源性能待 SPIKE-E12，通过前不放开 |
| 配乐源文件 | 0～1 个，时长 ≤10min、≤50MB | 混音复杂度 |
| 素材总大小 | ≤100MB | `/tmp` 512MB + 内存；留足输出空间 |
| 主轨源总时长 | **P0 ≤900s（15min）**；SPIKE-E12 后 ≤1200s | 3×10min 的极端组合会拉长解码时间；memo 最大仅测 3 源/6min |
| 配乐源时长 | ≤600s | 混音额外解码 |
| 片段数 | ≤50；单片 ≥0.2s（与服务端 V2 一致） | UI 与 filter 图长度 |
| 成片时长 | 0.3～600s；铃声模板 ≤40s | 导出安全矩阵 |
| 变速后时长 | 仍受 600s 限制 | 服务端按变速后计算 |

### 11.2 导出格式 × 时长安全矩阵（v1.1 建议）

> 以下「建议上限」是设计目标值；**最终以 [FFMPEG_EDIT_SPIKE.md](./research/FFMPEG_EDIT_SPIKE.md) 的 1 CPU 实测数据校准**。超过上限时服务端返回 `EXPORT_LIMIT`，并提示改用 MP3。

| 输出格式 | 码率/参数 | 建议成片上限 | 说明 |
| :--- | :--- | :---: | :--- |
| **MP3** | 128/192/320k，默认 192k | **10min**（产品硬上限 600s；FFmpeg 外推可到 20min） | 主推；10min 纯编码实测 14.0~14.9s；完整编辑 280s 输出 10.5~22.7s |
| **WAV** | PCM 16bit / 44.1k / 立体声 | **4min**（≈42MB，实测 280s 输出 49.4MB） | 10min 立体声 ≈106MB，超输出上限；需要长无损用 FLAC；更长只能单声道/低采样率（P2） |
| **FLAC** | 无损压缩 | **7min**（420s；真实音乐 700~900kbps ≈45~50MB） | 10min 真实音乐 45~65MB，可能超 50MB；输出前 statSync 校验 |
| **M4A** | AAC fast / 192k | **8min**（P1，留 2× 安全系数；memo 外推可到 10min） | 10min 编码实测 16.9s、宿主竞争 35.9s；P0 不默认提供 |
| OGG/AAC 裸流 | — | 不做 | 编辑导出不做，降低矩阵与 iOS 兼容成本 |

**通用硬上限**：输出文件 ≤50MB（与输入上限一致，待实测云函数 `uploadFile` 上限后可放宽到 100MB）；超过 → `OUTPUT_TOO_LARGE`。

**实测耗时（Docker `--cpus=1 --memory=1g`；FFmpeg 7.0.2 静态；2026-10-28）**

| 场景 | 输入/操作 | 输出 | 耗时 |
| :--- | :--- | :--- | ---: |
| 纯重编码 | 60s/3min/5min/10min mp3→mp3 192k | 同长 | 1.39s / 3.83s / 8.37s / **14.0s** |
| 纯重编码 | 5min/10min mp3→m4a aac fast 192k | 同长 | 9.0s / **16.9s（另一轮 18.3s，竞争 35.9s）** |
| 裁剪 | 60s atrim 重编码 mp3 | 60s | 1.2s |
| 删除中段 | 3min 删 60s（filter concat 2 段） | 120s | 2.5s |
| 拼接 | 2×3min / 3×2min（filter concat） | 6min | 8.1s / **7.3s（`-filter_complex_threads 1`；默认线程 16.7s）** |
| 淡入淡出 | 裁剪+afade 60s | 60s | 1.5s |
| 变速 | 3min atempo 1.5× | 2min | 3.0s |
| 配乐混音 | 3min 主轨 + 1min 循环 BGM/偏移/闪避 | 3min | 4.2～4.9s |
| **最坏组合** | **10min 源**：删中段+拼接+1.5x 变速+整段淡入淡出+循环 BGM+限幅 | **280s** | **10.5s（干净）/ 22.7s（竞争）** |
| 同上（无损格式） | 同上→wav/flac | 280s | 6.2s / 6.2s |
| copy 快剪 | 20s/60s 片段 | 同长 | 0.02～0.06s（容器时长需解码校验） |
| loudnorm | 5min/10min 单遍 | 同长 | 21.5s / 41.9s（**P2，不进 v1.1**） |

> 结论：**10min 成片 + 效果 + 配乐在 1 CPU 上实测 10.5～22.7s**（干净复测 10.5s，宿主竞争 22.7s），**函数 55s 内预算可行**；FFmpeg 内预算定 **45s**（函数 60s 硬超时，留 15s 给下载/上传/DB）。真正风险在「多源拼接」「输入解码总量」与「无限输入缺 -t」，已由 §11.1 限额、§8.4 顺序与护栏、§8.5 快剪策略控制。数据来源：[FFMPEG_EDIT_SPIKE.md](./research/FFMPEG_EDIT_SPIKE.md)。

**时间预算（P95，按实测余量）**

| 场景 | 目标 P95 | 依据/约束 |
| :--- | :--- | :--- |
| 分析 3min / 10min | ≤3s / ≤8s | 只做探测 + 4kHz peaks（实测解码 1.3s / 4.0s），不生成代理 |
| 快剪 10min | ≤3s | `-c copy` 实测 <0.1s，加下载/上传 |
| 精修 3min（裁剪+淡入淡出） | ≤10s | 实测约 1～3s，含下载/上传 |
| 精修 10min（最坏组合） | ≤40s | 实测 22.7s（280s 成片）+ 下载/上传余量 |
| 多源拼接（P0 ≤3 源/900s） | ≤45s | 3×2min 实测 7.3s；5 源/1200s 需 SPIKE-E12 通过才放开 |

### 11.3 配额规则

| 动作 | 是否扣次 | 限制 | 说明 |
| :--- | :---: | :--- | :--- |
| 导入/上传 | 否 | 并发 ≤2；文件规则 | 上传失败不计数 |
| `analyzeAudio` | 否 | 30 次/日/openid；单次 ≤15s | 防刷；同 fileID 24h 内复用分析结果 |
| 预览播放 | 否 | 仅客户端 | 无服务端算力 |
| 导出（`createEditTask` + `runEditTask`） | 开关开启时**成功扣 1** | 与转换共享（建议 5 次/日）；测试期 `QUOTA_ENFORCED=false` 不扣 | create 预占，失败/超时/内容安全拦截返还 |
| 转发/PC 保存 | 否 | 复用 v1.0 | |
| 清理/查询 | 否 | — | |

**共享池的取舍**：用户已于 2026-10-28 要求在测试期关闭次数限制（`QUOTA_ENFORCED=false`，v1.0 已生效）；编辑沿用同一开关，测试期不阻塞。上线前再决定是否恢复 5 次/日共享或提高到 8 次/日（成本见 §11.4）。**该决策需用户确认（§17 Q3）**。

**预占算法（防并发/防刷）**

```text
begin:
  doc = quota/{openid}_{date} (不存在则创建 {count:0, analysisCount:0})
  transaction:
    if doc.count >= 5: return QUOTA_EXCEEDED
    doc.count += 1; doc.updatedAt = now; write
    create edit_tasks {status:'created', quotaCharged:true}
  commit
on failure (after reservation): quota.count -= 1 (clamp ≥0)
on success: keep
on process death: getEditTask/cleanup 惰性检测 running>75s 或 queued>90s → failed + 返还（检查 quotaCharged=true 且未返还，避免双退）；planHash 24h 内成功结果可直接复用
```

> wx-server-sdk 若不支持 `runTransaction`，降级为「`_.inc(1)` 后读取 >5 则回退」，允许极小概率超发 1 次，不影响体验；实现时以 SDK 能力为准。

### 11.4 成本估算（量级）

| 项目 | 单次消耗 | 100 活跃用户/日 × 3 次编辑/日的量级 |
| :--- | :--- | :--- |
| 云函数分析 | 1 次调用，3～6s ×1 CPU | 300 次/日，约 20～30 分钟 CPU |
| 云函数渲染 | 1 次调用，8～25s ×1 CPU | 300 次/日，约 40～120 分钟 CPU |
| 云函数转换（v1.0） | 同上 | 与现状叠加 |
| 存储 | 源+代理+输出，24h 清理 | 峰值 ≈ 单日文件量（100 用户×3×~10MB≈3GB 上限），清理后回落 |
| 数据库 | analyses 记录 ~30KB/条；tasks ~2KB | 300 条/日，24～48h TTL |
| 流量 | 上传/下载/试听 | 与 v1.0 同一量级；试听走临时 URL（不经过函数） |

- **成本护栏**：额度开关（正式期可恢复 5 次/日）、10min 限制、24h 清理、分析 30 次/日、公共资源按现有套餐。具体金额待打包上线后按云开发账单核算，不在此拍数。
- **免费策略不变**：无广告、无付费墙；个人主体不可虚拟支付。

---

## 12. 合规、安全与版权

### 12.1 类目、备案与主体

| 项 | 结论 | 编辑功能的影响 |
| :--- | :--- | :--- |
| 主体 | 个人主体 | 不变 |
| 类目 | 工具 > 图片处理（官方描述覆盖「音频的本地制作、剪辑」） | 不变；提审说明补充「音频裁剪/拼接/混音为本地化制作工具，不提供公开传播」 |
| 备案 | 强制；个人可备案 | 已在 v1.0 计划内，编辑不新增备案事项 |
| 名称/文案 | 避免「在线音乐」「曲库」「听歌」等表述 | 功能命名用「音乐剪辑/音频剪辑」；页面不出现「在线听歌/热门歌曲」 |

> **风险点**：名称含「音乐」+ 剪辑功能容易被误判为「文娱 > 音乐」类目。应对：类目说明、页面文案、提审材料三处一致强调「用户自有音频的本地制作工具，无曲库、无公开播放/传播」；不提供任何内置音频素材。若审核仍要求音乐类目资质，降级方案：功能更名「音频剪辑」并把入口收进工具页（不改技术方案）。

### 12.2 隐私与个人信息

- **新增接口**：无。编辑复用 `wx.chooseMessageFile`（「收集你选中的文件」）与（若保留录音入口）`RecorderManager`（「访问你的麦克风」）；上传/下载/播放沿用现有链路的隐私声明。
- **新增数据**：源文件、编辑参数（时长/增益等，不含内容语义）、成片；均属用户文件，24h 删除。
- **隐私指引/政策更新**：在「收集的信息」与「保留期限」中补充「剪辑素材与导出文件同样仅用于本次处理，24 小时内删除」；客服/投诉入口不变。
- **最小化**：`edit_tasks.plan`（编辑参数，不含音频内容）仅服务端可读、48h 删除，仅用于重试/恢复/排障；日志不落文件名与完整 plan。`planBrief` 用于列表/指标，不替代 plan。

### 12.3 内容安全

- 沿用 v1.0：`mediaCheckAsync` 异步送检 + 回调 + risky 删除；个人主体当前无权限，开关关闭并在协议/提审材料披露窗口策略。
- 编辑不引入外部内容（无曲库、无素材库），风险不高于 v1.0 的「用户上传 + 转码」；但**混音/拼接可能产生新的组合内容**，仍以输入送检为主、输出 best-effort 送检（权限开通后）。
- 输出 >10MB 时按现有策略生成低码率代理或抽检；命中后删除输出、任务 `blocked`、历史记录标记。
- 用户提示统一：「文件未通过安全检查，无法导出」，不泄露检测细节。

### 12.4 版权

| 风险 | 应对 |
| :--- | :--- |
| 用户剪辑/混音未授权音乐 | 用户协议已有「用户保证对文件拥有合法权利」条款，编辑场景补充「包括剪辑、拼接、混音后的衍生文件」；启动页/导出确认不重复弹窗，协议内说明 |
| 内置素材/曲库 | **不做**；配乐只能由用户自己从会话导入 |
| 铃声/传播 | 仅导出文件；转发是用户对自有文件的私聊发送，不提供公开链接/分享墙；PC 临时链接 2h、仅用户可获取 |
| 投诉 | 沿用版权投诉入口与删除机制；编辑产物与源文件均可按 fileID 删除 |
| 规避 DRM/去水印 | 明确不做；不提供「提取会员歌曲」类能力 |

### 12.5 提审材料与审核话术（新增部分）

1. 功能说明：本功能为「音频本地制作/剪辑工具」，用户从微信聊天导入自己拥有权利的音频，进行裁剪/拼接/音量/淡入淡出/自有配乐混音，导出文件可转发给自己或好友；无曲库、无检索、无公开播放。
2. 内容安全：说明送检机制、命中后删除、24h 清理。
3. 隐私：说明收集范围、受托处理方（腾讯云）、保留期限、删除路径。
4. 版权：说明用户承诺与投诉入口。
5. 界面截图：编辑页、导出确认（含版权提示）、结果页；**截图避免出现第三方歌曲名/歌词**。

---

## 13. 测试计划

### 13.1 单元/契约测试（服务端优先，可在本地 Node 跑）

| 测试 | 方法 | 通过标准 |
| :--- | :--- | :--- |
| `plan.js` 校验 | 表驱动：合法/越界/缺字段/超时长/超片段/非法格式 | 每条用例返回预期错误码 |
| `filtergraph.js` 编译 | 黄金用例：单段/双段/配乐/变速/快剪，断言 args 关键片段 | 与快照一致；新增效果必须加用例 |
| `peaks.js` | 合成正弦 PCM：全 0 / 全幅 / 渐变 | 桶数与 peak/rms 值误差 <1 |
| 边界 | 0.2s 片段、600s 成片、fade=clip 时长、speed=0.5/2.0 | 无非法命令 |
| 错误映射 | ffmpeg stderr 样本 → code | 不把 stderr 直接透传用户 |

### 13.2 服务端矩阵（云函数实测）

- 输入格式：mp3/wav/m4a/aac/flac/ogg/amr/ape/wma 各 1 个（≤10min），分析成功、peaks 合理、`playable` 标记正确（iOS 不可播格式）。
- 操作组合：单段裁剪 / 删除中间段 / 两段拼接 / 三段拼接 / 淡入淡出 / 音量 ±dB / 变速 0.5/1.5/2.0 / 配乐循环 / 全部叠加。
- 输出：mp3 128/192/320、wav、flac；校验时长误差（重编码 ≤0.1s、copy ≤0.05s）、可播放、无爆音、声道/采样率正确。
- 边界：0 字节、损坏文件、改扩展名、无音轨、8k 单声道、<1s、超出源边界、成片 0.3s/600s、铃声 40/41s。
- 超时：10min 最坏组合是否 <45s（FFmpeg）/ <55s（函数）；超时后任务状态与额度返还正确。
- 快剪：mp3/m4a/wav 的 copy 精度与可播性（flac 禁止 copy）；copy 失败自动降级。
- 工程护栏：无 `-t` 反例（超时/SIGKILL/临时文件清理）；复杂 filter 加 `-filter_complex_threads 1`；输出 >50MB 拦截；`-map_metadata -1` 生效。
- 探测：`ffmpeg -i` 退出码恒 1 的解析路径；0 字节/无音轨/改扩展名/8k 单声道/超短文件错误码正确。

### 13.3 客户端真机 Spike 清单（阻塞开发前必须过）

> 本节是开发阻塞项（E1～E11）；更完整的客户端能力 Spike（S1～S13：decode 格式矩阵、PCM 内存、onTimeUpdate 频率、双实例、fileID/URL、Canvas、上传、callFunction、恢复等）见 [CLIENT_CAPABILITIES.md §8](./research/CLIENT_CAPABILITIES.md)，两者合并作为 M9.0 真机验证清单。

| 编号 | 验证项 | 方法 | 通过标准 | 不通过降级 |
| :--- | :--- | :--- | :--- | :--- |
| SPIKE-E1 | 导出两段式 + 长调用/中断恢复 | 真机走 create→run→poll；`runEditTask` 30/45/55s；切后台、锁屏、飞行模式各一次 | 前台 55s 内能拿到结果；切后台回来能靠 taskId 查询/续跑；不重复扣次 | 缩到 ≤20s 预算；启用 P1 事件触发器 |
| SPIKE-E2 | InnerAudioContext 顺序预览 | 3 段拼接预览，比较段间间隙；播放中切后台 | 间隙 ≤300ms；切后台能停/恢复；无重叠播放 | 单实例 seek + UI 说明 |
| SPIKE-E3 | playbackRate 保调与范围 | 1.25/1.5/2.0 真机听感 | 音调基本不变或可接受；文档标注差异 | 预览不启用变速，仅导出生效 |
| SPIKE-E4 | 双实例（主+BGM）同步 | 同时播放 3min，观察漂移/音量 | 漂移 ≤200ms；可独立调音量 | 预览不混 BGM，导出后试听 |
| SPIKE-E5 | Canvas 2D 性能 | 3min/10min 波形，拖动选区/缩放 30 次 | 中端安卓 ≥50fps；无掉帧卡死 | 降采样/简化柱数/减少重绘 |
| SPIKE-E6 | peaks 体积与解析 | 10min 12000 桶 base64 | 解析 ≤100ms；analysis 响应 ≤64KB | 降为 100ms 桶或两级采样 |
| SPIKE-E7 | fileID 播放与 URL 兜底 | `InnerAudioContext.src=fileID` 播 30s/拖动 seek；对比临时 URL | fileID 播放/seek 正常；iOS/Android 一致 | 退回临时 URL 现取现用（受 10min 限制） |
| SPIKE-E8 | 50MB 级输出上传 | 服务端 uploadFile 50/100MB | 成功且耗时可控 | 输出硬上限保持 50MB |
| SPIKE-E9 | iOS 静音键/中断 | 开启静音键播放预览；来电/切后台 | 遵守静音键（默认）；中断后可恢复；无幽灵播放 | 首次提示检查静音键；`onAudioInterruption` 恢复 |
| SPIKE-E10 | 数据库事件触发器（P1 后台化） | 按量付费环境配置 edit_tasks 事件触发器，验证 payload/触发条件/防重入 | queued 任务能被自动执行；不产生循环触发 | 保持两段式前台执行 |
| SPIKE-E11 | 50MB 上传与后台中断 | 上传 10/30/50MB，弱网 + 切后台 5s | 50MB 可传或明确上限；中断可重试 | 下调单文件上限/提示保持前台 |
| SPIKE-E12 | 5 源拼接 + 效果 + BGM（云端真实 vCPU） | 5 源 × 2/4min + 效果 + BGM，云函数内实测；同 plan 3 源对照 | 函数内 ≤55s、FFmpeg ≤45s；时长/顺序/无爆音；否则收敛 3 源/900s | 保持 P0 3 源；5 源延后 |

### 13.4 客户端功能与体验测试

| 场景 | 步骤 | 通过标准 |
| :--- | :--- | :--- |
| 自由剪辑 | 选 3min 歌曲 → 拖选区 → 删除 → 导出 mp3 | ≤3 次主要点击完成；成片时长正确；可试听/转发 |
| 铃声模板 | 选歌 → 点铃声 → 选 ≤40s → 导出 | 默认选区合理；>40s 被阻止；文案说明不能直接设置系统铃声 |
| 多选拼接 | 选 2 个语音 → 排序 → 导出 | 顺序正确；接缝无明显爆音 |
| 配乐混音 | 主音频 + 配乐 → 调音量/循环 → 导出 | 配乐可循环；人声不被压没；导出可播 |
| 预览一致性 | 同参数预览 vs 导出 | 片段内容/顺序一致；差异有提示 |
| 撤销重做 | 连续 10 次操作撤销/重做 | 状态与时长正确；不崩溃 |
| 草稿 | 编辑中杀进程 → 重进 | 提示恢复；plan 保留；过期提示重新导入 |
| 弱网 | 上传中断/导出中断/切飞行模式 | 可重试；不重复扣次；不丢结果（可查） |
| 额度 | 用到第 5 次 | 第 6 次被拦截；分析/预览仍可用；次日重置 |
| 后台/来电 | 预览中切后台、导出中切后台 | 预览停止；回来可查导出结果 |
| 重复点击 | 快速点导出 5 次 | 只产生 1 个任务/1 次扣次 |
| 历史 | 导出后杀进程 → 历史 | 记录存在；过期标记正确；可继续剪辑 |

### 13.5 性能/兼容/安全测试

- 机型：iOS 13+（至少 iPhone SE2/13）、Android 8+（低端 2GB 内存 1 台、中端 1 台）、PC 微信；鸿蒙按微信支持情况抽测。
- 性能：首屏/进入编辑/分析/导出/拖动帧率按 §6.10 预算；10 次连续编辑无内存增长。
- 安全：plan 注入（超长字符串/非法字符/越界数字/伪造 analysisId 越权）、**上传票据/源文件归属（他人 fileID/过期 ticket/复用一个 ticket → FORBIDDEN）**、ffmpeg args 注入（数字/枚举白名单）、日志脱敏、临时文件清理、cloudPath 不含用户名。
- 合规：隐私弹窗、协议、投诉入口、版权提示、无曲库/公开分享入口。

### 13.6 验收清单（与 §16 对应）

- [ ] 设计评审 v0.2 复审通过（B1~B3 关闭、M1~M12 有结论）
- [ ] 13.3 的 SPIKE 全部通过或有降级方案（含 E1/E2/E5/E12）
- [ ] 13.2 服务端矩阵通过率 100%
- [ ] 13.4 客户端功能场景全部通过
- [ ] 性能预算达标（真机数据）
- [ ] 安全/合规检查项全部通过
- [ ] 埋点可计算 §2.4 指标
- [ ] 灰度/回滚方案就绪

---

## 14. 排期、WBS 与里程碑

### 14.1 前置条件

1. v1.0 的 M4 核心链路稳定（云函数/存储/额度/清理/转发）；编辑复用，不重复造。
2. 云函数已有的 60s 超时、FFmpeg 二进制、`converted_files`/`quota` 集合可用。
3. 用户确认 §17 的 3 个关键决策（v1.1 时间、额度共享、WAV/m4a 取舍）。
4. 真机 Spike（§13.3）完成，尤其是 SPIKE-E1/E2/E5。

### 14.2 里程碑

| 里程碑 | 内容 | 产出 | 估时 | 依赖 |
| :--- | :--- | :--- | :---: | :--- |
| 里程碑 | 内容 | 产出 | 估时 | 依赖 |
| :--- | :--- | :--- | :---: | :--- |
| M9.0a | 真机 Spike（S1～S13 + E1～E11 + E12 五源） | Spike 报告 + 5 源性能结论 + E1 录屏 | **3～5d** | v1.0 M4 |
| M9.0b | 设计评审 + v0.3 冻结契约 | 评审通过 + 契约基线 | 0.5～1d | M9.0a 并行/之后 |
| M9.1 | 服务端契约/分析链路 | `analyzeAudio` + peaks + `playable` + `createUploadTicket` + 单测 | 1.5d | M9.0b |
| M9.2 | 编辑器 P0（裁剪/删除/铃声/导出） | 编辑页 + 波形 + 预览 + 单段导出链路 | 3.5d | M9.1 |
| M9.3 | 拼接/配乐/变速/静音清理（P1） | 多源、BGM、模板、撤销/草稿 | 3.0d | M9.2 + E12 |
| M9.4 | 联调、测试、合规、提审 | 测试报告 + 提审材料 | 2.5d | M9.3 |
| **合计** | | | **约 15～20 个有效人日（AI 辅助乐观 13～16）** | |
> 可与 v1.0 的 M5/M6 并行约 1～2 人日（编辑器骨架、波形组件用 mock 数据先行），但**不建议压缩测试与 Spike**。

### 14.3 WBS（更细）

| 工作流 | 任务 | 估时 |
| :--- | :--- | :--- |
| 设计 | 本文档 + UX 规格 + 评审 v0.2/复审 | 1.0～1.5d |
| 服务端 | `plan.js`/`filtergraph.js`/`peaks.js`/`upload-ticket.js` + 单测 | 2.0d |
| 服务端 | `analyzeAudio`（探测/peaks/落库/限流/归属校验） | 1.0d |
| 服务端 | 导出任务（create/run/get + 下载/渲染/上传/幂等/额度/超时/退次） | 2.0d |
| 服务端 | cleanup/超时补偿、内容安全接入 | 0.5d |
| 客户端 | 首页入口/结果页入口/路由/草稿/taskId 恢复 | 0.5d |
| 客户端 | `waveform-timeline`（canvas/手势/缩放/标尺/选区/DPR 降级） | 2.0d |
| 客户端 | 预览引擎（顺序播放/BGM/淡入淡出/变速/降级） | 0.5d |
| 客户端 | 工具面板 + 片段条 + 撤销/重做 + 模板 | 1.5d |
| 客户端 | 分析/导出/结果/错误/额度/取消说明 | 0.5d |
| 测试 | 服务端矩阵 + 真机 + 弱网 + 性能 + 安全 | 3.0d |
| 发布 | 提审材料/灰度/监控 | 0.5d |
| **合计** | | **≈15.5d（范围 15～20；AI 辅助乐观 13～16）** |

### 14.4 关键路径与并行

```text
M9.0 Spike ──▶ M9.1 分析 ──▶ M9.2 编辑器P0 ──▶ M9.3 拼接/配乐 ──▶ M9.4 测试提审
                   │              │
                   └─ 客户端 mock 波形/手势可提前 1.5d 并行
```

**关键路径**：Spike-E1/E2 → 分析链路 → 导出任务链路 → 真机联调 → 测试。
**最大风险**：SPIKE-E1 不通过会导致导出交互/架构调整（+1～2d）；SPIKE-E12 未过时多源拼接收敛到 3 源/900s（功能范围缩水）。

---

## 15. 风险登记册（编辑新增）

| # | 风险 | 概率 | 影响 | 应对 | 触发条件/负责人 |
| :--- | :--- | :---: | :---: | :--- | :--- |
| R-E1 | `runEditTask` 长调用被平台/网络/切后台中断，用户拿不到结果 | 中 | 高 | 两段式 taskId + 幂等 + `getEditTask` 查询/续跑；SPIKE-E1 先行；必要时缩预算或启用事件触发器 | 真机 45s/切后台用例失败 |
| R-E2 | 最坏组合渲染超 60s | 中 | 高 | 10min 上限 + 格式矩阵 + `-t` 保护；实测后收紧；提示缩短 | FFmpeg >45s / 函数 >55s |
| R-E3 | 预览与导出一致性差，用户投诉「剪的不是这个」 | 高 | 中 | 预览只做近似并明确提示；片段顺序/时间映射严格同一 plan；导出后默认播放成片；收集反馈 | 预览与导出片段占位偏差 |
| R-E4 | 低端安卓 canvas/手势卡顿 | 中 | 中 | 按列聚合、只重绘可见区、播放头独立更新；降采样；真机矩阵 | 中端安卓 <35fps |
| R-E5 | 流拷贝裁剪精度/容器兼容问题（m4a/mp3） | 中 | 中 | 白名单 + 自动降级重编码 + UI 说明误差；m4a copy 未通过就不启用 | SPIKE-E 快剪用例失败 |
| R-E6 | BGM `aloop` 内存/耗时不可行 | 中 | 中 | 改 `-stream_loop` 整首循环或要求配乐 ≥成片（只淡出）；必要时 P0 去掉循环 | 5min 配乐混音 >30s |
| R-E7 | AAC/M4A 编辑导出超时 | 中 | 低 | P0 不默认提供；m4a ≤8min（2× 安全系数） | 实测 >45s |
| R-E8 | iOS 静音键导致「没声音」投诉 | 中 | 中 | `wx.setInnerAudioOption` + 首次预览提示；真机验证 | SPIKE-E9 |
| R-E9 | 内容安全权限不可用，审核质疑 | 中 | 高 | 沿用 v1.0 披露策略；输出送检开关预留；提审材料主动说明 | 提审反馈 |
| R-E10 | 类目被判定为「文娱>音乐」 | 低 | 高 | 文案/材料强调本地工具、无曲库；预备「音频剪辑」更名 | 审核驳回 |
| R-E11 | 版权投诉（铃声/混音） | 中 | 中 | 协议 + 投诉入口 + 删除机制；不内置素材 | 投诉到达 |
| R-E12 | 分析接口被刷（免费算力） | 中 | 低 | 30 次/日 + 单文件限制 + 同 fileID 复用 + 监控 | 分析量异常 |
| R-E13 | 存储输出体积超预期/成本上升 | 中 | 中 | 50MB 硬上限、24h 清理、WAV/FLAC 收紧、监控日成本 | 日存储增速异常 |
| R-E14 | 与 v1.0 共用云函数导致互相影响（超时/配额/发布） | 中 | 中 | 按 action 隔离；共享额度明确；灰度发布；监控错误码 | v1.0 转换成功率下降 |
| R-E15 | 文档/代码被并发工具覆盖（历史问题 R11） | 高 | 中 | 本设计文档置为只读/纳入评审流程；变更记录 | 文件 mtime 异常 |
| R-E16 | BGM 无限循环缺 `-t` / SIGTERM 杀不掉 | 低 | 高 | 所有命令强制 `-t`；`execFile` 用 `killSignal:'SIGKILL'`；/tmp 监控 | 出现超大临时文件 |
| R-E17 | flac copy 容器时长错误导致进度/seek/波形错位 | 中 | 高 | flac 永久禁用 copy；输出时长以解码/探测回传为准 | 回传时长与计划不一致 |
| R-E18 | 显式 aresample×N + 默认线程在 1 核抖动 3 倍 | 中 | 中 | 不显式归一；复杂 filter 固定 `-filter_complex_threads 1` | 3×2min 拼接 >10s |

---

## 16. 验收标准（Given / When / Then）

### 16.1 核心链路

| # | Given | When | Then |
| :--- | :--- | :--- | :--- |
| AC-01 | 用户在微信会话里有 3min mp3 | 从首页进入音乐剪辑并选择该文件 | 上传/分析成功，波形可交互，时长显示正确（±0.1s） |
| AC-02 | 已进入编辑态 | 拖动选区到 30～50s，点「裁剪保留」 | 成片约 20s；导出确认显示时长/预计大小/剩余额度；导出后试听正常 |
| AC-03 | 已选中一段 | 点「删除选区」 | 选区消失，前后片段自动拼接；总时长减少对应值 |
| AC-04 | 媒体有 2 个片段 | 拖动片段 2 到片段 1 前 | 片段顺序变化，预览与导出顺序一致 |
| AC-05 | 编辑任意状态 | 连续撤销 10 次再重做 10 次 | 最终状态与撤销前一致；无崩溃、无时长错乱 |
| AC-06 | 编辑中强杀小程序 | 重新进入 | 提示恢复草稿；恢复后 plan 完整；素材过期时有明确提示 |
| AC-07 | 选择 flac 源（iOS） | 进入编辑 | 显示「iPhone 不支持该格式试听，可编辑并导出，或先转 MP3」；波形/编辑/导出正常 |
| AC-08 | 源 12min | 选择后 | 立即拦截并提示「剪辑支持 10 分钟以内」，给出转换入口 |

### 16.2 导出与结果

| # | Given | When | Then |
| :--- | :--- | :--- | :--- |
| AC-09 | 成片 1min（额度开关开启时剩余 3/5） | 导出 mp3 192k | 成功；额度变 2/5；结果可试听；文件名含「剪辑」；大小合理 |
| AC-10 | 单段裁剪、同格式、无效果 | 导出 | 走快速导出（日志 `fastCopy=true`），耗时 <3s，时长误差 ≤0.05s |
| AC-11 | 有淡入淡出/音量/拼接/配乐 | 导出 | 重编码；淡入淡出听感存在；无爆音；时长误差 ≤0.1s |
| AC-12 | 最坏组合（10min 源 + 效果 + BGM；SPIKE 后含 3 源） | 导出 | FFmpeg 在 45s 内、函数在 55s 内成功；若超时，任务 TIMEOUT、额度返还、客户端提示缩短/改格式 |
| AC-13 | 导出成功 | 点「转发给好友」 | 调起 `shareFileMessage`，发送到所选聊天成功；PC 端可保存/复制链接 |
| AC-14 | 导出失败/断网 | 重试 | 不重复扣次；同一 clientToken 能查回已成功结果 |
| AC-15 | 额度开关开启且 5/5 | 点导出 | 拦截并提示；分析/预览仍可用；次日恢复；测试期开关关闭时不拦截、显示「不限次数（测试阶段）」 |

### 16.3 内容、合规与安全

| # | Given | When | Then |
| :--- | :--- | :--- | :--- |
| AC-16 | 任意编辑页/结果页 | 查看 | 有版权提示；无曲库/在线听歌/公开分享入口；无「设置系统铃声」承诺 |
| AC-17 | 隐私未授权 | 点选择文件 | 弹隐私说明；拒绝后不可选文件；同意后可正常使用 |
| AC-18 | 内容安全命中（权限开通后） | 导出/查询 | 输出被删、任务 blocked、不可转发；文案不泄露细节 |
| AC-19 | 恶意 plan（越界/超长/伪造 analysisId） / 他人 fileID 无 ticket | 直接调用云函数 | 返回 INVALID_PLAN/FORBIDDEN；不执行渲染；不扣次 |
| AC-20 | 用户投诉侵权 | 通过投诉入口提交 | 可触达；文件可按 fileID 删除；流程留痕 |

### 16.4 非功能

| # | 指标 | 目标 |
| :--- | :--- | :--- |
| AC-21 | 分析 P95（10min mp3，上传完成后） | ≤8s；上传 P95 另计 ≤15s；波形首帧 ≤300ms |
| AC-22 | 3min 精修导出 P95 | ≤25s |
| AC-23 | 波形拖动帧率（真机测，发布前） | 中端安卓 ≥50fps |
| AC-24 | 包体增量 | ≤150KB（编辑页 + 组件 + utils） |
| AC-25 | 连续 10 次编辑/导出 | 无内存泄漏（播放器销毁、无 OOM） |
| AC-26 | 崩溃率（上线灰度/线上抽样） | <0.5% |
| AC-27 | 24h 清理（上线后抽样） | 源/输出/analyses/tickets 记录全部按时删除（P1 代理同理） |
| AC-28 | 多源拼接（P0 3 源 / SPIKE 后 5 源）+ BGM + 效果 | 导出 | 在 55s 内成功（或按 §8.6 降级成片）；时长/顺序正确；无爆音 |
| AC-29 | BGM offset=5s、fadeOut=2s | 导出 | 淡出发生在成片结尾前 2s，不被硬切；无爆音 |
| AC-30 | 源 44.1k 立体声，导出选 48k/单声道 | 导出 | 走重编码；输出采样率/声道与选择一致（fastCopy=false） |
| AC-31 | WAV 成片 4min / 4min1s、FLAC 7min / 7min1s | 导出 | 边界内成功、超限被 EXPORT_LIMIT 拦截且不扣次 |
| AC-32 | create 成功后杀进程/切后台 | 重新进入 | 能从 `editor_task_v1` 查到 taskId 并恢复结果；不重复扣次 |
| AC-33 | queued 任务超 90s 未执行 | 查询/清理 | 标 failed+TIMEOUT 并退次（quotaRefunded 幂等） |
| AC-34 | 重复点导出（不同 clientToken、相同 plan） | 24h 内 | planHash 命中已成功结果直接返回，不重复渲染/扣次 |
| AC-35 | 内容安全权限未开通 | 提审/导出 | 沿用窗口策略并在协议披露；权限开通后 risky 输出被删、blocked |
| AC-36 | 取消语义 | 导出中点返回/切后台 | 无取消按钮；可退后台，回前台按 taskId 查结果（与 UX 旧稿"取消退次"不同，以行为表为准） |

---

## 17. 待确认问题（需用户/产品决策）

| # | 问题 | 建议 | 影响 |
| :--- | :--- | :--- | :--- |
| Q1 | 编辑功能进入 **v1.1** 还是 **v1.0**？ | v1.1（v1.0 提审上线后 2～4 周）；若进 v1.0，只做 P0-lite 且发布顺延 4～6d | 排期/范围 |
| Q2 | 源时长上限 **10min** 是否接受？ | 接受；覆盖歌曲/语音备忘主场景；30min 编辑需路线 B，列为 P2（同 UX Q3） | 覆盖范围 vs 成功率 |
| Q3 | 额度策略：测试期不限次数，正式是否**与转换共享 5 次/日**？ | 测试期保持关闭；上线前按成本决定 5 次/日或 8 次/日共享，实现已做成开关 | 成本/体验 |
| Q4 | P0 输出是否只保留 **mp3 + flac + wav**（m4a 放 P1）？ | 是；m4a 受 AAC 编码速度限制；WAV 上限 **4min**（≈42MB） | 格式选择/体积 |
| Q5 | 主轨源文件数 **P0 ≤3（上限 5）**（UX 建议 ≤9）是否够用？ | P0 3 源/900s；SPIKE-E12 通过后放开 5 源/1200s；9 段不采纳 | 拼接范围/服务端复杂度 |
| Q6 | iOS 不可播格式（flac/ogg/amr/ape/wma）是否做试听代理？ | **P0 不做**（接受「有波形、能编辑、不能试听」+ 先转 MP3 入口）；P1 视反馈做短文件代理（同 UX Q13） | 体验/60s 预算 |
| Q7 | 「手机铃声」模板是否保留（不能直接设为系统铃声）？ | 保留但文案写明「导出铃声片段，需自行设置」；或更名「铃声片段」（同 UX Q9） | 用户预期/审核 |
| Q8 | 效果作用范围：MVP 整段全局是否够？ | 是；MVP 全局淡入淡出/音量/变速，选区级 V1.1（同 UX Q5） | 服务端 filter 复杂度 |
| Q9 | BGM 仅支持用户第二段会话音频（无素材库）是否够用？ | 是（合规与成本最优）；默认 -12dB，自动闪避 V1.1（同 UX Q7） | 功能范围 |
| Q10 | 云函数是否更名 `audioStudio`？ | 建议更名（语义更准），保留旧名一个版本；或 v1.1 继续用 `ffmpegProbe` | 迁移成本 |
| Q11 | 内容安全权限未开通时是否上线编辑？ | 沿 v1.0 窗口策略 + 披露；若审核要求先过检，则等权限/降级 | 上线时间 |
| Q12 | 是否接受「预览为近似效果」的体验定位？ | 接受；若要求所见即所得，需路线 B + 服务端实时预览，成本/工期翻倍 | 架构 |
| Q13 | 云开发环境是否为**按量付费**、是否允许配置「数据库事件触发器」？ | 若可，P1 后台化导出；否则保持两段式前台执行 | 后台完成能力 |
| Q14 | 是否允许录音直接进编辑器（沿用 RecorderManager ≤10min）？ | 允许；与 PRD FR-02 一致（同 UX Q11） | 隐私声明/交互 |
| Q15 | 草稿仅本地 1 条、24h 是否够？ | 足够；不上云（同 UX Q10） | 跨设备恢复 |

---

## 18. 独立评审意见处理记录（v0.2）

> 评审原文：[DESIGN_REVIEW.md](./research/DESIGN_REVIEW.md)（B3/M12/m8，共 23 条）。处理原则：Blocker 全关；Major 逐条改文档/加测试；Minor 能改就改，不能改的显式记录。复审基线为本文档 v0.2。

| 编号 | 评审问题 | 处理 | 状态 |
| :--- | :--- | :--- | :--- |
| B1 | `edit_tasks` 不存完整 plan，两段式恢复断裂 | §10.1 增加 `plan`（≤32KB，服务端专用，48h）+ `planSchema`；§8.3 create 事务内写入、run 读取；隐私说明同步（§12.2） | ✅ 已关闭 |
| B2 | EditPlan/API 三份材料三套写法 | §5.2+§5.6+§9 声明唯一契约；UX/CLIENT 文首加对齐说明；`cancel` 明确不实现（§9.5）；补 planHash 规范化（§5.6 备注） | ✅ 已关闭 |
| B3 | 6 组用户可见行为冲突 | §5.6 冻结行为表逐条给出唯一值；UX 文首对齐说明；PRD FR-19 同步 | ✅ 已关闭 |
| M1 | 状态机/错误码不闭合 | §4.3 统一 `queued→running→succeeded\|failed\|blocked` + `safetyStatus` 独立；补 FORBIDDEN/EXPORT_RUNNING/UPLOAD_FAILED/STORAGE_ERROR；去 downloadUrl 矛盾 | ✅ 已改 |
| M2 | 额度预占/返还与 taskId 恢复 | taskId 立即写 storage；getEditTask 增加 queued>90s 惰性失败+退次；cleanup「每日+顺带」；planHash 24h 去重 | ✅ 已改 |
| M3 | 超时预算多套数字 | 统一 60s 硬超时 / 55s 函数内 / 45s FFmpeg / 90s 客户端轮询 / 75s lease；全文替换 | ✅ 已改 |
| M4 | 5 源拼接无实测、16.7s 与 7.3s 矛盾 | P0 收敛 3 源/900s；SPIKE-E12 通过后放 5 源/1200s；§11.2 表更新（含 fct1 7.3s）；删除"待 memo" | ✅ 已改（待 Spike 结论） |
| M5 | sampleRate/channels 语义与快剪静默忽略 | §5.2 定义 SR 规则；§8.4 快剪条件增加 sampleRate/channels 校验；WAV 固定 44100 | ✅ 已改 |
| M6 | BGM afade 在 adelay 前，正偏移淡出错误 | §8.4 BGM 链改为 `atrim(扣 offset) → asetpts → adelay → volume → afade`；补 AC-29 | ✅ 已改 |
| M7 | 画布/手势/阈值多处矛盾 | §6.3/§6.4/§7.3 统一 UX §4/§5 尺寸（主轨 276pt/配乐 56pt/标尺 22pt）、zoom≤20×、选区 0.2s、长按 500ms、单指编辑优先；预览 2 常驻 | ✅ 已改 |
| M8 | P0 与铃声/拼接/配乐场景错位 | 铃声模板提到 P0；拼接/配乐 P1 + feature flag；入口不曝光未上线模板 | ✅ 已改 |
| M9 | 分析 P95 含上传不可达 | §2.4/AC-21 拆为上传 ≤15s、分析 ≤8s（不含上传）、波形首帧 ≤300ms；导出标注口径 | ✅ 已改 |
| M10 | Spike/排期不现实、WBS 加总不一致 | Spike 单列 M9.0a 3~5d；WBS 重算 ≈15.5d（范围 15~20）；M9.0b 设计评审 0.5~1d | ✅ 已改 |
| M11 | AC/测试覆盖不足 | 新增 AC-28～AC-36（多源/BGM/格式边界/参数快剪/taskId 恢复/queued 退次/planHash/取消语义）；AC-12/18/23/26/27 调整 | ✅ 已改 |
| M12 | 源文件无 openid 归属，存在越权 | 新增 `createUploadTicket` + `upload_tickets` 集合 + `edit_sources/{openid}/` 路径；analyze 校验 ticket/fileID；补 AC-19/§13.5 | ✅ 已改 |
| m1 | WAV 4/4.7/4.9/5min 四种口径 | 统一「输入 ≤4.7min（50MB）/ 输出 ≤4min（42MB）」 | ✅ 已改 |
| m2 | M4A 5/8/10min 三种口径 | 统一 8min（P1，2× 安全系数）；数值标注 16.9/18.3/35.9s 三档 | ✅ 已改 |
| m3 | 分析等待 8/10/15/20s 四套 | 统一 20s 总预算：8s 文案、10s 重试、20s 失败；peaks 15s | ✅ 已改 |
| m4 | "int8" 实际是 uint8、缺 buckets | 全文改 uint8 0–255；接口/数据模型增加 `buckets` | ✅ 已改 |
| m5 | playable 单端误伤、flac 结果页无提示 | 改 `playableIos/playableAndroid/playable`；结果页对 flac 提示 iPhone 可能无法试听 | ✅ 已改 |
| m6 | 页面清单/行数/埋点名不一致 | §1.2 改 719 行；UX 文首说明现实只有 index/settings+editor；埋点以 §7.5 为准 | ✅ 已改 |
| m7 | cloudPath 含用户名、TTL 48h vs 7d | 输出路径改 `edit_outputs/{taskId}.{ext}`；edit_tasks 统一 48h | ✅ 已改 |
| m8 | E-C13 缺号、9.5 缺节、A5 用 -af | 约束重编号 E-C11～E-C18；补 §9.5 取消语义；A5 改 `-filter_complex` | ✅ 已改 |

**复审 Gate（v0.3 之前必须完成）**
1. 用户拍板 §17 Q1～Q5（v1.0/v1.1、10min、额度、格式、3/5 源）——尤其 Q5 决定 UX 待重画范围。
2. 完成 SPIKE-E1/E2/E5/E12（导出中断恢复、顺序预览、Canvas、5 源拼接），并把 FFmpeg memo §8.2 的云端真实 vCPU 复测补进 M9.0a。
3. 按 v0.2 契约回写 UX/CLIENT/PRD 的字段名与行为值（已加 banner；评审后如仍冲突，以 §5.6 为准）。
4. 复审本文档 v0.2 → 通过后启动 M9.1；未过之前不启动 M9.2/M9.3。


---

## 19. MVP 实现落地（2026-10-28，同步实现）

> 设计 v0.2 仍按两段式/多源/多格式规划；为尽快让用户在**同一个小程序内切换入口**，本轮先落地单文件同步 MVP，后续按设计迭代。实现契约见 [EDITOR_IMPL_CONTRACT](./EDITOR_IMPL_CONTRACT.md)，后端细节见 [editor-impl/BACKEND](./editor-impl/BACKEND.md)。

### 19.1 已交付

| 项 | 实现 | 文件 |
| :--- | :--- | :--- |
| 双入口切换 | `tabBar`：**格式转换 / 音乐剪辑**（文字+图标）；首页「音乐剪辑」入口卡；导航标题改为「音频工具箱」 | `miniprogram/app.json`、`pages/index/*`、`miniprogram/images/tab-*.png` |
| 剪辑页 | 空态→上传→分析→编辑→导出中→结果；Canvas 2D 波形/选区/播放头；裁剪/删除/保留/全选/撤销；淡入淡出/音量；预览；结果试听/转发 | `miniprogram/pages/editor/*`、`utils/editor-utils.js` |
| 云函数 analyzeAudio | 下载→`ffmpeg -i` 解析→4kHz mono PCM→50ms 桶 uint8 peak/rms→base64；≤600s/≤50MB | `cloudfunctions/ffmpegProbe/index.js`、`lib/editor-core.js` |
| 云函数 renderEdit | 1~20 段→atrim×N→concat→整体 afade→volume→alimiter→mp3 192k；SIGKILL/`-t`/`-filter_complex_threads 1`；上传 `edited_audios/`；`converted_files(kind=edit_output)` | 同上 |
| 实测 | 纯函数 91×2、Docker 实测 88、action mock 49 全过；成片时长误差 0.000s；600s analyze 2.1~4.7s；40s 渲染 0.8~2.5s | `scripts/editor-spike/run.sh` |
| 真机/工具 E2E（v1） | 开发者工具：mock chooseMessageFile → 上传 → 分析（4s WAV，1.6s）→ 波形 → 拖选 0.8~2.4s → 删除 → 导出（2.4s/57.59KB/1.5s）→ 结果；**格式转换回归 SUCCESS**；`cli preview` 编译通过 123.2KB | [双 tab 首页](../screenshots/dual-tab-home.png) · [波形编辑](../screenshots/editor-e2e-waveform.png) · [导出结果](../screenshots/editor-e2e-result.png) |
| **v2 多片段/每片淡入淡出** | 2 个 WAV（3s/440Hz、2s/660Hz）多选导入 → 2 片段；设置片段 2「淡入 1s/淡出 0.5s」→ 上移 → 在 1s 处分割 → 3 片段 → 导出 **5.0s / 118.82KB / 3 段**；对成片再分析，RMS 包络为 **15→46→61→31→61…61**（首段淡入、第二段淡出在 1.5~2s 处下陷、第三段满幅），证明**顺序 + 每片淡入淡出均生效**；跨源播放自动跟随片段 | [v2 片段时间线](../screenshots/editor-v2-clips.png) · [v2 每片淡入淡出](../screenshots/editor-v2-fades.png) · [v2 导出结果](../screenshots/editor-v2-result.png) |

### 19.2 与设计的偏差（MVP 有意简化，需按迭代补齐）

| 设计项（v0.2） | MVP 实现 | 后续 |
| :--- | :--- | :--- |
| create/run/get 两段式导出 + 额度预占/返还 | **同步 `renderEdit`**（FFmpeg ≤50s；前端防重入） | M9.2 拆任务化；补 taskId 恢复 |
| upload ticket / 源文件 openid 归属 | 客户端直传 `edit_sources/...`，服务端只校验 fileID 可用 | M9.1 补 `createUploadTicket` |
| 多源拼接（P0 3 源）/每片段缓入缓出 | **v2 已实现**：≤5 源、≤40 片、跨源拼接、每片段独立 fade（前后端一致）、上移/下移/分割/裁剪/ripple delete；输出仍仅 mp3 | M9.3 补 BGM/变速/多格式/模板 |
| P0 铃声模板 | 未做模板，仅自由剪辑（可手动裁 ≤40s） | M9.2/M9.3 |
| 额度/内容安全 | 沿用测试期 `QUOTA_ENFORCED=false`、`MEDIA_CHECK_ENABLED=false` | 上线前按合规接入 |
| 波形缩放/横向滚动/片段拖动排序 | 整段视口波形 + 点按/拖选；片段顺序用「上移/下移」按钮；无缩放/拖拽 | M9.3 |
| iOS 不可播格式 | `playableIos=false` 顶部提示 + 禁用预览；不生成代理 | P1 |
| 草稿持久化 | 仅页面内存（tab 切换保留） | M9.3 |

### 19.3 复现方式

```bash
# 1) 部署（需 DevTools 服务端口 44120 + 登录）
cli cloud functions deploy --env cloud1-d0g1pwjogd2f39be2 --names ffmpegProbe --project "$PWD" --remote-npm-install
# 2) 本地测试
bash scripts/editor-spike/run.sh
# 3) 编译
cli preview --project "$PWD"
```

> 本轮没有改动 v1.0 转换的云函数行为与首页转换流程；双入口在同一 AppID/云环境下运行。

---

## 附录 A｜FFmpeg 命令库（摘要）

> 完整实测命令、耗时、坑见 [FFMPEG_EDIT_SPIKE.md](./research/FFMPEG_EDIT_SPIKE.md)。以下为设计基线，实现时以实测为准。

```bash
# 通用前缀（所有命令）：-hide_banner -nostdin -y -loglevel error
# 复杂 filter（concat/amix）加：-filter_complex_threads 1

# A1 快剪（单段、无损、同格式；flac 禁用；m4a 不要加 -avoid_negative_ts）
ffmpeg -hide_banner -nostdin -loglevel error -y -ss 30.0 -to 60.0 -i in.mp3 \
  -map 0:a:0 -c copy -map_metadata -1 out.mp3

# A2 裁剪 + 整体淡入淡出 + 音量（重编码；fade 在 tempo 之后，st 用输出时间轴）
ffmpeg -hide_banner -nostdin -loglevel error -y -i in.mp3 -vn \
  -filter_complex "[0:a]atrim=start=30:end=60,asetpts=PTS-STARTPTS,\
volume=2.0dB,afade=t=in:st=0:d=1.0,afade=t=out:st=28.5:d=1.5,\
alimiter=limit=0.95:level=false[out]" \
  -map "[out]" -map_metadata -1 -ar 44100 -ac 2 -t 30 -c:a libmp3lame -b:a 192k out.mp3

# A3 删除中间段 = 两段拼接（单 filter concat，不显式 aresample/aformat）
ffmpeg -hide_banner -nostdin -loglevel error -y -i in.mp3 -vn \
  -filter_complex_threads 1 \
  -filter_complex "[0:a]atrim=start=0:end=12,asetpts=PTS-STARTPTS[a0];\
  [0:a]atrim=start=20:end=180,asetpts=PTS-STARTPTS[a1];\
  [a0][a1]concat=n=2:v=0:a=1[out]" \
  -map "[out]" -map_metadata -1 -ar 44100 -ac 2 -t 172 -c:a libmp3lame -b:a 192k out.mp3

# A4 多文件拼接（FFmpeg 7 自动做采样率/声道转换；输出端 -ar/-ac 定规格）
ffmpeg -hide_banner -nostdin -loglevel error -y -i a.mp3 -i b.m4a -vn \
  -filter_complex_threads 1 \
  -filter_complex "[0:a]atrim=start=0:end=60,asetpts=PTS-STARTPTS[a0];\
  [1:a]atrim=start=0:end=30,asetpts=PTS-STARTPTS[a1];\
  [a0][a1]concat=n=2:v=0:a=1[out]" \
  -map "[out]" -map_metadata -1 -ar 44100 -ac 2 -t 90 -c:a libmp3lame -b:a 192k out.mp3

# A5 变速（保持音调；>2 串联 atempo；输出时长 = 输入/速度）
ffmpeg -hide_banner -nostdin -loglevel error -y -i in.mp3 -vn \
  -filter_complex "[0:a]atempo=1.25[out]" -map "[out]" -map_metadata -1 \
  -ar 44100 -ac 2 -t 144 -c:a libmp3lame -b:a 192k out.mp3

# A6 BGM 循环混音（输入侧 -stream_loop -1 + atrim 精确裁到成片时长）
ffmpeg -hide_banner -nostdin -loglevel error -y -i main.mp3 -stream_loop -1 -i bgm.mp3 -vn \
  -filter_complex_threads 1 \
  -filter_complex "[0:a]atrim=start=0:end=60,asetpts=PTS-STARTPTS,volume=0dB[m];\
  [1:a]atrim=start=0:end=60,asetpts=PTS-STARTPTS,volume=-12dB,\
  afade=t=out:st=57:d=3[b];\
  [m][b]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,\
  afade=t=out:st=57:d=3,alimiter=limit=0.95:level=false[out]" \
  -map "[out]" -map_metadata -1 -ar 44100 -ac 2 -t 60 -c:a libmp3lame -b:a 192k out.mp3

# A7 响度标准化（P2；仅 ≤3min；必须固定采样率）
ffmpeg -hide_banner -nostdin -loglevel error -y -i in.mp3 -vn \
  -af "loudnorm=I=-16:TP=-1.5:LRA=11" -map_metadata -1 -ar 44100 -ac 2 -t 180 \
  -c:a libmp3lame -b:a 192k out.mp3
```

**强制规则**：
- 所有用户输入只作为数字/枚举，经白名单与范围校验后拼进 filter graph；**不拼接原始字符串到 shell**，使用 `execFile(bin, argsArray)`。
- 命令统一带 `-hide_banner -nostdin -y -loglevel error`；复杂 filter 加 `-filter_complex_threads 1`；输出必须带 `-t`。
- `execFile` 必须 `{ timeout: 45000, killSignal: 'SIGKILL' }`；输出后 `statSync ≤50MB`。
- 输出统一 `-map_metadata -1`（隐私最小化）；`alimiter` 必须 `level=false`；`amix` 必须 `normalize=0`。
- ffmpeg `-i` 探测无输出文件时退出码恒为 1，不能以退出码判失败。

## 附录 B｜波形 peaks 规格

**算法（服务端，Node 16，无依赖）**

```js
// pcm: Buffer，s16le、单声道、4000Hz；BUCKET_MS=50 → 每桶 200 样本
function computePeaks(pcm, sampleRate = 4000, bucketMs = 50) {
  const bucketSamples = Math.max(1, Math.round(sampleRate * bucketMs / 1000));
  const n = Math.ceil((pcm.length / 2) / bucketSamples);
  const peak = new Uint8Array(n);
  const rms = new Uint8Array(n);
  for (let b = 0; b < n; b++) {
    let maxAbs = 0, sumSq = 0, count = 0;
    const start = b * bucketSamples;
    for (let i = 0; i < bucketSamples; i++) {
      const idx = (start + i) * 2;
      if (idx + 1 >= pcm.length) break;
      const s = pcm.readInt16LE(idx) / 32768;
      const a = Math.abs(s);
      if (a > maxAbs) maxAbs = a;
      sumSq += s * s; count++;
    }
    peak[b] = Math.min(255, Math.round(maxAbs * 255));
    rms[b] = Math.min(255, Math.round(Math.sqrt(sumSq / Math.max(1, count)) * 255));
  }
  return {
    bucketMs,
    buckets: n,
    peak: Buffer.from(peak).toString('base64'),
    rms: Buffer.from(rms).toString('base64')
  };
}
```

- 输入：`ffmpeg -hide_banner -nostdin -v error -i src -ac 1 -ar 4000 -f s16le /tmp/x.pcm`（超时 15s）。
- **已实测（1 CPU / Node16）**：10min mp3 解码 **4.06s**，PCM **4.8MB**，Node 分桶 **31ms**，base64 **32KB**（仅 peak 为 16KB）；总计 ≈4.1s，远低于 20s 分析预算。
- 100ms 桶可把数据减半（16KB），缩放感知差异不大；MVP 用 50ms（更好支持 1s 窗口放大）。
- 客户端：`base64ToArrayBuffer` → `Uint8Array`；绘制时按屏幕列聚合 `max`；10min=12000 桶，视口只画 ≤800 根柱。
- 为什么不用 `showwavespic` 出图片：静态图无法随缩放/选区重绘，且体积比 peaks 大；peaks 可复用、可做静音检测。
- Node 内存：peaks 脚本 RSS≈45MB；源文件 ≤50MB + PCM 4.8MB，975MB 限额内安全。

## 附录 C｜低保真线框（375×812，浏览器可直接打开）

| 线框 | 覆盖 |
| :--- | :--- |
| [首页入口卡 + 模板 chips](./research/ux/mockup-01-home-entry.svg) | 入口/模板 |
| [编辑器默认态](./research/ux/mockup-02-editor-default.svg) | 波形/标尺/主轨+配乐轨/工具/导出栏 |
| [选区 + 音量面板](./research/ux/mockup-03-selection-volume.svg) | 选区手柄/时间气泡/底部面板 |
| [导出中（三步进度）](./research/ux/mockup-04-exporting.svg) | PREPARING/RENDERING/POLLING |
| [导出结果](./research/ux/mockup-05-export-result.svg) | 试听/转发/保存/续剪/额度 |
| [手势局部放大](./research/ux/mockup-06-timeline-gestures.svg) | 44pt 命中区/手势阈值 |
| [模板卡](./research/ux/mockup-07-templates.svg) | 5 个场景模板 |

> 线框与文案以 [UX_EDITOR_SPEC.md](./research/UX_EDITOR_SPEC.md) 为准；本设计文档只负责边界与限额。

## 附录 D｜术语

| 术语 | 含义 |
| :--- | :--- |
| EditPlan | 客户端的非破坏性编辑计划 JSON，唯一事实源 |
| 片段（clip） | 从某个源音频截取的一段 [in, out)，按顺序组成主轨 |
| 主轨 | 输出的主干音频（1～5 个源的片段序列） |
| 配乐轨 | 叠加在主轨上的第二路音频（0～1 个源） |
| 快剪 | 单段、无效果、同格式时的 `-c copy` 无损导出 |
| peaks | 服务端生成的 50ms 桶波形摘要（uint8 0–255，base64） |
| 分平台可播标记 | `playableIos/playableAndroid`；当前平台不可播时只可编辑不可试听（P0） |
| 试听代理（P1） | 不可跨平台播放的源转成的低码率 mp3 预览文件（P0 不做） |
| 分析 | ffmpeg 探测 + peaks + `playable` 标记的前置步骤（P0 不生成代理） |
| 渲染 | 服务端按 EditPlan 执行 FFmpeg 生成成片 |

## 附录 E｜调研材料与核实

| 材料 | 内容 | 状态 |
| :--- | :--- | :--- |
| [CLIENT_CAPABILITIES.md](./research/CLIENT_CAPABILITIES.md) | 微信客户端 API 能力、波形/预览/手势选型、真机 Spike 清单 | 本轮产出 |
| [FFMPEG_EDIT_SPIKE.md](./research/FFMPEG_EDIT_SPIKE.md) | FFmpeg 剪辑命令、1 CPU 耗时、坑、限额建议 | 本轮产出 |
| [UX_EDITOR_SPEC.md](./research/UX_EDITOR_SPEC.md) | 用户流程、布局/手势/面板/文案/埋点、线框 | 本轮产出 |
| [FEASIBILITY.md](./FEASIBILITY.md) | 平台能力与合规依据（v1.0 基线） | 既有 |
| [TASK_PLAN.md](./TASK_PLAN.md) / [PRD.md](./PRD.md) / [DEV_LOG.md](./DEV_LOG.md) | 路线、需求、进度 | 既有，随本设计更新 |

---

*变更记录：v0.1（2026-10-28）首版详细设计；v0.2（2026-10-28）按独立评审 B1~B3/M1~M12 修订（plan 持久化、契约唯一化、冻结行为表、两段式超时统一、5 源收敛、BGM 时序、上传票据归属、SLO/排期/AC 修订）；待复审通过后作为 v1.1 开发基线。*




