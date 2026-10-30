# 在线音乐编辑 · 客户端能力核验

| 项 | 内容 |
| :--- | :--- |
| 文档 | `CLIENT_CAPABILITIES` v1.0（「在线音乐编辑」客户端能力研究与选型） |
| 工作区 | `/Users/mimi/WeChatProjects/miniprogram-1`（原生小程序；开发者工具 libVersion 3.17.5；产品最低基础库 2.23.0） |
| 核实日期 | **2026-10-28**（官方文档逐页抓取核验；`docs/FEASIBILITY.md` 既有结论复核于 2026-10-27） |
| 核实方式 | 微信官方文档站（developers.weixin.qq.com）原文抓取。站内搜索与外部搜索引擎本次不可用，因此**凡未定位到官方原文的说法一律标【待实测】，不把社区二手结论写成结论** |
| 标注 | 【官方】文档明确 ｜【实测】本项目/团队已验证 ｜【社区】二手说法（仅供线索，不作结论） ｜【待实测】必须真机 Spike |
| 读者 | 《在线音乐编辑详细设计》编写者，结论可直接引用 |

> **一句话结论**：客户端只做「导入 → 波形展示 → 手势编辑 → 近似试听 → 计划提交」，渲染一律回云端 FFmpeg。**波形用服务端 peaks（10min 约 32KB）而不是端内解码**；**预览用 InnerAudioContext 顺序播放 + 音量步进近似**，并在 UI 明示「近似预览，以导出文件为准」。

---

> **【对齐说明 · 2026-10-28 Lead 回写】客户端能力结论仍然有效，但接口命名与产品边界以 [MUSIC_EDITOR_DESIGN v0.2](../MUSIC_EDITOR_DESIGN.md) 为准**：① 本文 §6.3 的 `analyze`/`render`/`renderStatus`/`cancel` 是研究建议命名，实际实现为 `analyzeAudio`/`createUploadTicket`/`createEditTask`/`runEditTask`/`getEditTask`，**没有 cancel**（v1.1 不提供取消）；② 编辑源上限 **P0 3 源/900s**（SPIKE 后 5 源/1200s），成片 ≤10min；③ P0 **不生成 iOS 试听代理**，`playable` 改为分平台字段；④ 预览常驻 **2 实例**（主轨+BGM），A/B 预热默认关闭；⑤ 额度测试期 `QUOTA_ENFORCED=false`。其余 Spike/数值/官方来源不变。


## 0. 结论先行

### 0.1 八条决策

| # | 决策 | 结论 | 关键依据 |
| :--- | :--- | :--- | :--- |
| D1 | 波形数据来源 | **服务端生成 peaks 为唯一主路径**；端内 `decodeAudioData` 不作主路径，仅保留「≤60s 短音频秒开/服务端失败兜底」的可选开关（V1.1） | 10min 立体声 44.1kHz PCM≈**212MB**（见 §2.2）；官方称 AudioBuffer 为「短音频」资源；decode 格式矩阵官方未列 → 待实测 |
| D2 | peaks 规格 | 50ms 桶、int8（peak/rms 各 1 字节）、单声道、base64；10min=12000 桶≈**31.3KiB**，JSON 传输无压力 | callFunction 建议 data ≤100KB【官方】；10min 体积可算（§2.3） |
| D3 | 编辑预览 | **InnerAudioContext 顺序播放**：`startTime`/`seek` 定位 + `onTimeUpdate`/定时器判界 + `volume` 步进近似淡入淡出 + **BGM 第二实例** + `playbackRate` 0.5~2.0 | §3；`playbackRate` 范围、`seek` ms 精度、`volume` 0~1 均【官方】 |
| D4 | 端内 WebAudio 精确预览 | **MVP 不做**。内存（212MB@10min）、格式矩阵未知、AudioParam 无自动化方法、与 `setInnerAudioOption` 不兼容，收益只在「淡入淡出/变速音调」 | §3.6；内存可算（§2.2）+ 官方 API 限制（§5.2） |
| D5 | 时间轴实现 | **canvas `type="2d"` 视口画布 + view 覆盖层**；不采用 view 拼装波形 | 官方：canvas 2D 最大 1365×1365、touch 事件带 canvas 相对 `x/y`、同层渲染、`disable-scroll` |
| D6 | 手势 | 单指：空白区 scrub/滚动、选区内拖动、手柄调边界；双指：pinch 缩放（中点锚定）+ 平移；阈值与冲突规则见 §4.4 | canvas touch 事件【官方】；实现需 Spike 验证跟手性 |
| D7 | 导出调用方式 | **必须异步**：`render` 只做「建任务」快返回，客户端 1.5s→3s 轮询；**不要**用一次 callFunction 等 30~50s | callFunction **无 timeout 参数**【官方】；网络默认 60s、切后台 5s 中断【官方】（§5.3） |
| D8 | 编辑源时长/大小 | 沿用 10min / 50MB 上限；注意 **WAV 10min 立体声≈106MB>50MB**，实际等效约 4.9min（立体声 44.1k/16bit） | 体积可算；readFile ≤100MB【官方】 |

### 0.2 Lead 追加核验（3 点，先给答案）

| # | 问题 | 结论 | 依据等级 |
| :--- | :--- | :--- | :--- |
| Q1 | `wx.cloud.callFunction` 客户端超时：可配？默认多少？最长？30~50s 会不会提前断？ | **官方 API 无客户端 timeout 参数**（`config` 仅 `env`）。客户端网络层**默认 60s**（`app.json networkTimeout` 或单次调用可配，但对 `wx.cloud.*` 是否生效未见官方说明）；**小程序切后台 5s 内网络请求未结束会 `fail interrupted`**。云函数自身超时官方文档亦未载明（本项目控制台已配 60s）。→ **30~50s 同步调用风险高，导出必须 taskId+轮询**；单次调用预算按 ≤20s 设计 | 【官方】API 定义、网络超时/后台中断；【实测】本项目云函数超时=60s（DEV_LOG 23:32）；上限与 callFunction 是否独立计时【待实测】 |
| Q2 | `InnerAudioContext.src` 支持 `cloud://` fileID 吗？还是必须换临时 URL？临时 URL 播放是否免域名校验？ | **官方明确支持云文件 ID：`src` 自基础库 2.2.3 起支持云文件 ID**；云存储文档亦称「支持在 image、audio 等组件中传入云文件 ID」。**因此播放优先直接传 fileID，可绕开临时链接时效问题**。临时 https URL 播放「免域名校验」**没有官方依据**（域名白名单文档只列 `wx.request/uploadFile/downloadFile`，未把音频播放列入）→ 现有实现用 `downloadUrl` 播放属项目实测（模拟器 E2E），**真机需 Spike 复验**；设计上不依赖它 | 【官方】fileID 支持；【实测】临时 URL 播放（模拟器）；URL 域名口径【待实测】 |
| Q3 | 多实例上限？主音轨+BGM 两实例可行？`onTimeUpdate` 间隔多少（官方说 250ms？） | **官方没有任何「同时实例数上限」的说法**，也没写 `onTimeUpdate` 触发频率（**没有 250ms 的官方描述**）。社区常见「约 250ms/200~300ms」属二手说法，本文不作结论。工程上按 **2 个常驻实例**（主轨+BGM）设计，禁止按片段创建实例；频率与双实例混播均列入 Spike（S3/S4） | 【官方】无该两项说明；【待实测】频率、双实例混播、上限 |

### 0.3 追加核验：`chooseMessageFile` / `uploadFile`

| 项 | 结论 | 等级 |
| :--- | :--- | :--- |
| 多选 `count` | **0~100**，默认 1；返回 `tempFiles[]`（`path/size/name/type/time`） | 【官方】 |
| count=3 的返回顺序 | 官方**未说明**是否按选择顺序、是否跨会话排序 | 【待实测】S9 |
| 单文件大小上限 | `chooseMessageFile` 文档**未标注**上限；本项目按产品规则本地拦截 50MB | 【待实测】S9 |
| `wx.cloud.uploadFile` 单文件上限 | 官方**未标注**；`wx.uploadFile` 也未标注；本项目已实测 6.87MB 成功；社区「50MB」说法未核实 | 【实测 6.87MB】/【待实测 30/50MB】S10 |

---

## 1. 能力矩阵（客户端能做什么）

| 能力 | 官方结论（含基础库版本） | 标签 | 对编辑器的含义 |
| :--- | :--- | :--- | :--- |
| 从会话导入音频 | `wx.chooseMessageFile` 2.5.0+；`type:'file'`；`extension` 过滤 2.6.0+ | 【官方】 | 唯一导入入口；波形/编辑需该文件 |
| 读手机本地文件 | 无公开 API，仅 `wxfile://` 沙箱 | 【官方】 | 产品文案引导「先发到微信会话」 |
| 读文件为 ArrayBuffer | `FileSystemManager.readFile`，**单文件 ≤100MB**，不传 `encoding` 返回 ArrayBuffer | 【官方】 | 端内解码上限受此约束（50MB 产品上限更小） |
| 端内解码 PCM | `wx.createWebAudioContext` 2.19.0+；`decodeAudioData(ArrayBuffer)`；返回 `AudioBuffer`（`getChannelData` Float32Array） | 【官方】 | 能力存在，但格式/内存边界未知（§2.2） |
| 端内播放 | `wx.createInnerAudioContext` 1.6.0+；mp3/m4a/aac/wav 双端支持；flac/ogg/amr/ape/wma iOS 不支持 | 【官方】 | iOS 上部分源无法试听 → 必须提示/降级（§3.5） |
| 播放本地临时路径 | 文档未显式写，现有实现 `src = tempFilePath`（`index.js:268`） | 【实测】 | 编辑预览用「会话临时文件」即可，无需先上传 |
| 播放云 fileID | `src` 2.2.3+ 支持云文件 ID | 【官方】 | 结果/历史播放优先 fileID，不依赖临时 URL |
| 多个实例同时播 | 无官方数量说明 | 【待实测】 | 只用 2 个（主轨+BGM），且必须 `destroy()` |
| 变速播放 | `playbackRate` 2.11.0+，**0.5~2.0**，默认 1，Android 需 6+ | 【官方】 | 预览变速范围与导出一致（≤2.0） |
| 音量/淡入淡出 | `volume` 0~1（1.9.90+）；无自动化包络 API | 【官方】 | 只能定时器步进近似（§3.3） |
| 精确 WebAudio 播放 | `BufferSourceNode.start(when, offset, duration)`；`playbackRate` 0<r≤2.0；`GainNode`；`AudioParam` 仅 `value` 等属性 | 【官方】 | 理论可做精确片段播放，但内存/格式/自动化限制 → 不做（§3.6） |
| Canvas 2D | `<canvas type="2d">` 2.9.0+；需显式宽高，**最大 1365×1365**；同层渲染 | 【官方】 | 视口画布必须；整条 10min 时间轴不能画进单画布 |
| Canvas 触摸 | `bind:touchstart/move/end/cancel`；Touch 含**相对 canvas 左上角的 `x,y`** | 【官方】 | 手势坐标系直接用 `e.touches[0].x/y` |
| 阻止页面滚动 | canvas `disable-scroll` 属性 | 【官方】 | 拖拽波形不带动页面 |
| 离屏 canvas | `wx.createOffscreenCanvas({type:'2d',width,height})` 2.16.1+ | 【官方】 | 波形静态层缓存、减少重绘 |
| 云上传/下载 | `wx.cloud.uploadFile/downloadFile`；无大小上限文字（下载层 ≤200MB）；并发 10 为 `wx.*` 网络接口口径 | 【官方】/【待实测】 | 源文件上传是波形的先决条件（§6.1） |
| 云函数调用 | `callFunction({name,data,config:{env}})`；无客户端 timeout 参数 | 【官方】 | 导出必须异步任务（D7） |
| 内存/包体 | 主包/分包 ≤2MB、总分包 ≤30MB【官方】；**运行内存无官方数值**，iOS 连续内存告警会销毁小程序【官方】 | 【官方】 | 峰值内存预算需自控（§2.2/§5.4） |

---

## 2. A｜波形数据从哪来：服务端 peaks vs 端内 decode

### 2.1 决策

> **主路径：服务端 peaks。** 上传源文件后，由分析接口（ffprobe + FFmpeg 解码到 4kHz 单声道 + Node 分桶）返回 `duration + peaks`。**端内 `decodeAudioData` 不作为波形主路径**，原因按权重排序：内存 > 格式矩阵 > 首屏收益有限 > 实现成本。

| 维度 | 服务端 peaks（推荐） | 端内 decodeAudioData |
| :--- | :--- | :--- |
| 内存 | 服务端解码后在云端释放；端内只存 31KB/10min | **10min 立体声 PCM≈212MB**（§2.2），触发内存告警/被回收概率高 |
| 格式兼容 | FFmpeg 全格式（flac/ogg/amr/ape/wma 均可） | 官方未列支持格式；iOS/Android 底层实现不同 → 待实测（很可能 iOS 解不了 flac/ogg） |
| 首屏耗时 | 上传（网络瓶颈）+ 云端 1~8s；**上传无论如何都省不掉**（导出必须传源文件） | 省掉上传等待中的空白，decode 1~3s；但不能替代上传 |
| 数据体积 | 32KB/10min（base64），callFunction 100KB 建议内 | 0 传输 |
| 实现成本 | 服务端 ~80 行分桶脚本（task-2 已实测）+ 接口 | 端内需处理 readFile→decode→分桶→降采样→失败矩阵；双端差异大 |
| 可靠性 | 云端 CPU 稳定，可缓存 | 受机型/内存/解码器版本影响，不可控 |

### 2.2 端内解码内存估算（float32，`AudioBuffer` 口径）

| 时长 | 单声道 44.1kHz | 立体声 44.1kHz | 立体声 48kHz（设备重采样） | 判断 |
| :--- | ---: | ---: | ---: | :--- |
| 60s | 10.1MiB | 20.2MiB | 22.0MiB | 可行（含源文件/Peaks 临时对象约 +10MB） |
| 3min | 30.3MiB | 60.6MiB | 66.0MiB | 边界，低端机可能告警 |
| 5min | 50.5MiB | 100.9MiB | 110.0MiB | 高风险 |
| 10min | 100.9MiB | **201.9MiB** | 219.9MiB | 不可接受 |

> 计算：`时长 × 采样率 × 声道 × 4B`；`AudioBuffer` 文档亦称其为「存在内存里的一段**短小**的音频资源」。另需叠加：源文件 ArrayBuffer（≤50MB）+ 解码中间对象。iOS 内存告警策略见官方《内存优化》文档（连续告警会主动销毁小程序）。

### 2.3 peaks 数据规格与体积（建议写入接口契约）

| 项 | 建议值 | 理由 |
| :--- | :--- | :--- |
| 桶宽 | 50ms | 10min=12000 点；最大缩放窗口建议 ≥1s（20 点，客户端插值平滑） |
| 采样 | ≤4kHz 单声道（s16le） | 波形包络足够；10min PCM 仅 4.8MB（云端 /tmp 512MB 内） |
| 每桶字段 | `peak:int8`、`rms:int8`（桶内 `max(abs)` / RMS，均归一化） | 2B/桶；peak 画柱、rms 画内层 |
| 编码 | `base64`（客户端 `wx.base64ToArrayBuffer`→`Int8Array`） | JSON 安全、无额外依赖 |
| 体积 | 3min≈9.4KiB、5min≈15.6KiB、10min≈**31.3KiB**（base64） | 远低于 callFunction「data 建议 100KB」【官方】 |
| 附带 | `duration`、`sampleRate`、`channels`、`bucketMs`、`version`、`peaksHash` | 便于缓存/版本化；波形缓存键=fileID+hash |

### 2.4 分级策略（决策落地）

| 场景 | 策略 |
| :--- | :--- |
| 默认（所有文件） | 选文件 → 本地校验（≤50MB/扩展名）→ 上传（进度条）→ `analyze` 返回 duration+peaks → 进入编辑 |
| 上传中 | 显示骨架波形 + 「分析中…」；不做假波形（避免用户误以为已可编辑） |
| `analyze` 失败/超时（>10s） | 重试 1 次；仍失败则提示换格式/重试；**不自动切端内解码** |
| 短音频（可选 V1.1） | ≤60s 且格式在 decodeAudioData 白名单（待 Spike S1 确认）时，本地 `readFile→decodeAudioData` 立即出图，上传后台并行；上传完成后再以服务端 peaks 覆盖（一致性兜底） |
| 超长/超大 | 沿用 50MB/10min 上限；>10min 直接拒绝（产品边界） |

> 不建议「端内 decode 作为无网络兜底」：无网络时导出同样不可用，波形出来也无意义。

---

## 3. B｜编辑预览怎么做

### 3.1 预览能力与精度

| 预览能力 | 实现方式 | 精度/限制 | 等级 |
| :--- | :--- | :--- | :--- |
| 从任意位置开始 | `src` + `startTime`（秒）再 `play()`；或 `seek(position)`（秒，**官方称精确到 ms**） | `seek` 精度官方承诺到 0.001s；实际听感与设备有关 | 【官方】 |
| 停止在片段末尾 | `onTimeUpdate` 观察 `currentTime` + 定时器双保险 | **`onTimeUpdate` 频率官方未承诺**，边界误差按 ±300ms 设计 | 【官方】+【待实测】S3 |
| 暂停/继续 | `pause()` 后再 `play()` 从暂停处继续 | 官方明确 | 【官方】 |
| 从头重播/换片段 | `stop()` 后下次 `play()` 从头开始；换片段用 `seek` | `stop` 语义官方明确；`startTime` 与 `seek` 叠加行为【待实测】 | 【官方】/【待实测】 |
| 音量 | `volume` 0~1 | 无包络 API，只能定时器步进 | 【官方】 |
| 淡入淡出（近似） | 定时器每 50~100ms 改 `volume`（16~20 步） | 非线性听感 + 定时器抖动；仅示意 | 【官方】能力+近似 |
| BGM 混音 | **第二个 InnerAudioContext**：`src=BGM`、`loop=true`、`volume`、`startTime` 偏移 | 双实例混播官方无说明；iOS 可能被音频会话策略影响 | 【待实测】S4 |
| 变速 | `playbackRate` 0.5~2.0 | 是否保持音调官方未说明；导出 `atempo` 保持音调 → **预览与导出音调可能不一致** | 【官方】范围/【待实测】音调 |
| 进度显示 | `onTimeUpdate` 的 `currentTime` 驱动 UI | 频率未知 → 进度条更新按 4~5Hz 预期设计 | 【待实测】 |
| 系统中断 | `wx.onAudioInterruptionBegin/End` 处理来电等 | 官方提示音频可能被系统中断 | 【官方】 |

### 3.2 顺序播放（时间轴 → 播放调度）

设计要点（不写实现，仅约束）：

1. **一个主轨实例 + 一个 BGM 实例**，页面 `onUnload`/`onHide` 时停止并 `destroy()`；官方明确「音频资源不会自动释放」。
2. 播放时把编辑计划展开为「片段队列」（保留段：`in/out`；删除段不播；拼接=相邻片段顺序播）。
3. 每段：定位（`seek`/`startTime`）→ `play` → 到 `out` 停止；**判界用 `onTimeUpdate` + 一个按 `(out-in)/rate` 估算的定时器双保险**，谁先到用谁。
4. 段间切换会有 **0.1~0.3s 间隙**（`seek`+起播开销）；这是「近似预览」的主要听感差异，导出文件无此间隙。
5. 变速按全局 `playbackRate` 作用于所有片段（**MVP 不做逐段变速**，否则预览无法用单实例表达）；导出侧变速需与预览同一参数，避免「预览 0.75x、导出 0.75x」以外的组合。
6. 预览进度条总时长 = 计划计算时长（按 atempo 后时长求和），不是源时长。
7. 播放中改选区/删除片段：先 `pause()`，重排队列后从当前段重定位播放（避免状态错乱）。

### 3.3 淡入淡出 / 音量（近似）

| 项 | 方案 | 用户可感知差异 |
| :--- | :--- | :--- |
| 淡入淡出 | 播放到淡入区间时用定时器把 `volume` 从 0 步进到目标值（反向同理） | 阶跃感、时长受定时器抖动影响 ±100ms |
| 音量增益 | 计划里的 dB 换算成 0~1 系数后设 `volume`；>0dB 时音量封顶 1（无法预览放大） | 预览听不出「+6dB 更响」，只听到相对比例 |
| BGM 音量 | BGM 实例单独 `volume` | 系统混音，无削波保护；与导出的 `alimiter` 结果不同 |

> 文案要求：音量/淡入淡出面板顶部标注「**试听为近似效果，导出后以文件为准**」。

### 3.4 变速

- 预览：`playbackRate` 取计划值（钳制 0.5~2.0，超出不允许）。
- **音调**：官方未承诺保持音调 → 预览可能出现「变快变尖/变慢变低沉」；导出 FFmpeg `atempo` 默认保持音调。UI 需提示「变速试听音调可能不同，导出会保持音调」。
- 变速 + 淡入淡出同开时，定时器判界要用 `(out-in)/rate`，淡入步进间隔也应随 rate 缩短。

### 3.5 「预览不了」清单与解释话术

| 效果 | 为什么预览不了 | 建议文案 |
| :--- | :--- | :--- |
| 精确淡入淡出/包络 | 无音量自动化 API，只有定时器步进 | 「试听为近似淡化，导出为准」 |
| 拼接处无缝/无爆音 | 预览段间有起播间隙；编码/容器间隙由导出决定 | 「试听拼接处可能有短暂停顿，导出为连续音频」 |
| 真实混音电平/削波 | 两个实例由系统混音，无 limiter | 「试听混音音量仅供参考，导出已做限幅」 |
| 变速音调 | 平台播放器行为未承诺 | 「试听音调可能不同，导出保持原音调」 |
| 编码后音质/体积 | 端内不编码 | 「音质与大小以导出结果为准」 |
| 选区边界 sample 级 | seek+onTimeUpdate 精度 | 「试听起止点可能有 0.1~0.3 秒偏差，导出按你设定的时间点精确裁剪」 |
| iOS 不支持的源格式 | 见下 | 「当前格式 iPhone 无法试听，可直接导出；或先转成 MP3 再编辑」 |

> **iOS 源格式约束（重要产品约束）**：`InnerAudioContext` 官方格式矩阵中 **flac/ogg/amr/ape/wma 在 iOS 不支持**。这类源在 iPhone 上「有波形、能编辑、不能试听」——只能导出后听。可选缓解（需产品/成本决策，非客户端单方可解）：
> 1. 编辑入口提示「先转换为 MP3 再编辑」（复用现有转换链路，消耗每日次数），转换后再进入编辑器；
> 2. 服务端分析时额外生成 ≤128kbps MP3 预览代理（10min 约 2~4MB，但 1 CPU 下 MP3 编码耗时会挤占 60s 预算 → 仅建议对短文件做）；
> 3. MVP 接受「不能试听」，仅导出后验证。

### 3.6 是否需要端内 WebAudio 精确预览？——**不需要（MVP 不做）**

| 评估项 | 事实 | 结论 |
| :--- | :--- | :--- |
| 精确切片 | `BufferSourceNode.start(when, offset, duration)` 官方支持 | 能力存在 |
| 精确淡入淡出 | 官方 `AudioParam` 只列出 `value` 等属性，**未见 `setValueAtTime/linearRampToValueAtTime` 等自动化方法** | 无法做样本级淡化（最多定时器改 gain.value，优势有限）→ 可行性【待实测】 |
| 内存 | 必须先 `decodeAudioData` 整首 → 3/5/10min 立体声 60.6/100.9/201.9MiB | 10min 不可行；3min 也危险 |
| 格式 | 同期 decode 格式矩阵未知 | iOS 可能连 mp3 以外都不行 |
| 音频会话 | `wx.setInnerAudioOption` 官方明确**不兼容 `wx.createWebAudioContext`**（也不兼容 `useWebAudioImplement`），静音键/混播行为不可控 | 交互体验不可预测 |
| 实现成本 | 双端差异 + AudioContext 生命周期 + 内存回收 + 失败降级 | 高 |

> **替代方案（P1，可选）**：导出前提供「生成 15 秒试听片段」——把一个短区间交给云端 FFmpeg 真实渲染后播放（精确、包含所有效果）。成本：一次函数调用（约 2~6s）+ 几百 KB 下载；是否扣每日次数需产品决定。它比端内 WebAudio 便宜、比近似预览可信，建议作为「导出确认页」的增强。

---

## 4. C｜时间轴手势与 Canvas 2D

### 4.1 选型：canvas 2D（视口）+ view 覆盖层

- **canvas `type="2d"`** 画：波形柱（peak/rms）、选区遮罩、时间刻度网格、静音段标记。
- **view 绝对定位覆盖层**画：播放头、选区手柄、时间气泡、循环标记（同层渲染 2.9.0+，官方支持叠加）。
- **不采用 view 拼装波形**：375pt 宽至少 188 列，每列一个 view 会产生 188+ 节点、每次缩放/滚动触发 setData 与 Shadow 树重排；官方《setData 性能优化》明确节点量与数据量是主要成本。

### 4.2 硬约束（官方）

| 约束 | 官方表述 | 设计含义 |
| :--- | :--- | :--- |
| 画布最大尺寸 | Canvas 2D「需显式设置宽高，默认 300×150，**最大 1365×1365**」；「避免设置过大宽高，安卓下有 crash」 | **只做视口画布**（≈375pt×180pt），绝不做「整条 10min 长画布」 |
| DPR | 官方示例：`wx.getWindowInfo().pixelRatio`；`canvas.width=逻辑宽×dpr`、`ctx.scale(dpr,dpr)` | 高 DPR 设备设置 `min(dpr,3)`；低端机可降 `min(dpr,2)`（参考 `wx.getDeviceInfo().benchmarkLevel`） |
| 同层渲染 | canvas 2.9.0+ 支持同层渲染 | 允许 view 覆盖层与 canvas 叠加；iOS 不支持 `pointer-events`，覆盖层用 `catchtap` 而非穿透 |
| 触摸坐标 | 「对于 canvas 组件生成的触摸类事件，Touch 对象还包含 x,y：距离 canvas 左上角的距离」 | 手势直接用 `e.touches[i].x/y`（需减去画布内 padding，如果 canvas 与波形内边距不重合） |
| 阻止滚动 | canvas `disable-scroll`：「当在 canvas 中移动时且有绑定手势事件时，禁止屏幕滚动以及下拉刷新」 | 编辑器页面画布区域不滚动；面板在画布外 |
| 帧回调 | `Canvas.requestAnimationFrame` / `cancelAnimationFrame` | 拖动/缩放合并到每帧一次重绘 |
| 离屏 | `wx.createOffscreenCanvas({type:'2d'})` 2.16.1+ | 缓存静态波形层（缩放/滚动后重画一次），播放中只 blit |

### 4.3 渲染与性能预算（数千波形柱的问题）

关键结论：**「数千柱」是被错误建模后的数字**。视口下实际只需 **≤800 根**：

| 参数 | 建议 | 计算 |
| :--- | :--- | :--- |
| 视口宽度 | 375pt（320~430） | 设备逻辑宽度 |
| 柱宽 | 2pt（DPR 2~3 时 4~6 物理像素），柱间隙 0 | 375/2≈**188 根/屏** |
| 最大缩放 | 最小窗口 1s（20 个 50ms 桶 → 线性插值到 188 根） | 不足 188 时插值 |
| 最小缩放 | 10min 全览（12000 桶 → 每 64 桶取 max 降采样到 188 根） | 客户端降采样 O(n) 一次，缓存 |
| 重绘频率 | 手势中每帧 1 次（rAF）；播放中**不重画波形**，播放头用 view overlay 的 transform 更新 | 播放不触发 canvas 重绘 |
| 帧预算 | 波形层 <8ms，手势层 <16.7ms | 低端机降 DPR/柱宽到 3pt |
| setData 边界 | 波形数组、滚动量、选区像素值**不放进 `data`** | 官方：data 只放渲染相关数据；频繁 setData 会卡逻辑层 |

> 绘制实现建议：单色 `fillRect` 批绘（peak 实色、rms 半透明同色）；统一 `fillStyle` 不逐柱切换；坐标取整；`ctx.save/restore` 只用在选区裁剪。**不要每根柱建一个渐变**。

### 4.4 手势规格（工程约束，UX 细化由 UX 文档定稿）

| 手势 | 触发条件 | 行为 | 防冲突 |
| :--- | :--- | :--- | :--- |
| 点按 | 单指、位移 <8pt、<250ms | 播放头跳到该时间（吸附到 0.1s） | 与拖动以「位移阈值」判定，抬起前不改状态 |
| 单指拖空白区 | 单指、起点不在选区/手柄上 | 默认 = 移动播放头（scrub）；若 UX 定为「横向滚动」，则需在画布下方明确提示 | 二选一，MVP 建议 scrub（编辑优先），横向滚动由双指/边缘完成；若同时要滚动，采用「拖 >12pt 后进入滚动，点按仍为 scrub」 |
| 拖选区内 | 单指落点距选区边缘 >44pt | 整体平移选区（不改变长度） | 与 scrub 互斥；进入后锁定 |
| 拖手柄 | 单指落点距手柄中心 ≤22pt（有效热区 ≥44pt 宽） | 调整选区起/止；拖到画布边缘 500ms 后自动滚动 | 手柄优先级最高；拖动中显示 0.1s 精度气泡 |
| 双指 pinch | `touches.length===2` | 缩放：`pxPerSec` 按两指距离比例变化，**以两指中点对应的时间为锚点** | 进入 pinch 后忽略单指逻辑，直到 `touchend` 归零 |
| 双指平移 | 双指且距离变化 <5% | 时间轴横向滚动 | 与 pinch 共用一次手势状态机：先比距离变化判定 |
| 边缘自动滚动 | 拖手柄/选区到画布左右 24pt 内持续移动 | 每帧滚动 `±(8~16)px` | 定时器/rAF；离开边缘停止 |
| 长按 | 500ms 不动 | 打开「插入分割点」快捷菜单（可选 P1） | 与点按互斥 |

> 手势状态机建议单一入口（`touchstart` 决定模式 → `touchmove` 执行 → `touchend` 收尾），把「点按 vs 拖动」「单指 vs 双指」放在同一处判定，避免多个 handler 抢事件。

### 4.5 其它 Canvas 注意

- 开发者工具默认关闭 GPU 硬件加速，canvas 2D 表现与真机不同 → 性能结论必须真机（Spike S7/S8）。
- 画布尺寸变化（横屏/分屏/字体缩放）会改 `canvas.width/height` 并清空画布 → 重新取节点、重设尺寸并重绘。
- 少量时间刻度标签可用 view（字体适配更稳）；低端机降 DPR、去 rms 层；`benchmarkLevel` 低时进低画质档。
- 波形只表示幅度，不涉及内容识别；「配乐」导入仍须服务端内容安全（服务端范围）。

---

## 5. D｜关键数值与官方依据（可直接引用）

> 所有【官方】条目均于 **2026-10-28** 从 developers.weixin.qq.com 页面原文核验；URL 见 §10。
> 基础库基线 3.17.5、最低 2.23.0：**2.23.0 以下的能力（如 `currentTime` 可写需 2.26.2+）不能依赖**。

### 5.1 InnerAudioContext

| 项 | 数值/结论 | 标签 |
| :--- | :--- | :--- |
| 创建 | `wx.createInnerAudioContext({useWebAudioImplement})`，1.6.0+ | 【官方】 |
| `useWebAudioImplement` | 2.19.0+，默认 false；短音频/频繁播放建议开，**会增加内存**，长音频建议关 | 【官方】 |
| `src` | 音频地址；**2.2.3 起支持云文件 ID** | 【官方】 |
| `startTime` | 开始播放位置，单位 **s**，默认 0 | 【官方】 |
| `seek(position)` | 跳转到指定位置，单位 s，**精确到小数点后 3 位（ms 级）** | 【官方】 |
| `currentTime` | 播放位置（s，6 位小数）；**2.26.2 起可写，写等价 `seek`** | 【官方】 |
| `duration`/`buffered` | 只读；`duration` 仅在合法 src 时返回 | 【官方】 |
| `pause()` vs `stop()` | pause 后再播从暂停处继续；stop 后再播从头开始 | 【官方】 |
| `volume` | 0~1，默认 1，1.9.90+ | 【官方】 |
| `playbackRate` | **0.5~2.0**，默认 1，2.11.0+，**Android 需 6+** | 【官方】 |
| `loop`/`autoplay` | boolean，默认 false | 【官方】 |
| `obeyMuteSwitch` | 默认 true，**2.3.0 起该参数不生效，改用 `wx.setInnerAudioOption`** | 【官方】 |
| `wx.setInnerAudioOption` | 全局播放选项，2.3.0+：`mixWithOther` 默认 true（与其他音频混播）；`obeyMuteSwitch` 默认 true、仅 iOS（false 时静音键也发声）；`speakerOn` 默认 true（扬声器；**为 true 时忽略 mixWithOther 强制互斥**，且播放中不可切换扬声器）；**不兼容 WebAudioContext / useWebAudioImplement** | 【官方】 |
| `startTime` vs `seek` | `startTime` 是「开始播放位置」属性，`play()` 起播时生效；`seek()` 用于起播前/播放中跳转（ms 级）；2.26.2+ 写 `currentTime` 等价 `seek`；`stop()` 后 `startTime` 是否重新生效官方未说明 → **片段队列统一用 `seek` 定位更可控** | 【官方】/【待实测】 |
| 实例上限 | 官方无说明 | 【待实测】S4 |
| `onTimeUpdate` 频率 | 官方无说明（**没有「250ms」的官方表述**） | 【待实测】S3 |
| `onCanplay/onEnded/onSeeking/onSeeked/onWaiting` | 均提供 | 【官方】 |
| 资源释放 | **不会自动释放，必须 `destroy()`** | 【官方】 |
| 系统中断 | 播放可能被系统中断，用 `wx.onAudioInterruptionBegin/End` | 【官方】 |

### 5.2 WebAudioContext / AudioBuffer

| 项 | 数值/结论 | 标签 |
| :--- | :--- | :--- |
| 创建 | `wx.createWebAudioContext()`，2.19.0+；插件不支持；文档仅列 Windows/Mac 支持行，**未给 iOS/Android 支持矩阵** | 【官方】 |
| 主要 API | `decodeAudioData`、`createBuffer`、`createBufferSource`、`createGain`、`destination`、`createAnalyser`、`createScriptProcessor`、`close/suspend/resume`、`state/currentTime/sampleRate` | 【官方】 |
| `decodeAudioData` | `(ArrayBuffer, successCallback, errorCallback)` → `AudioBuffer`；**支持哪些容器/编码官方未列** | 【官方】/【待实测】S1 |
| `AudioBuffer` | `sampleRate/length/duration/numberOfChannels/getChannelData/copyFromChannel/copyToChannel`；「驻留在内存里的**短小**音频资源」 | 【官方】 |
| `BufferSourceNode` | `buffer/loop/loopStart/loopEnd/playbackRate`（**0<rate≤2.0**）、`onended`、`start(when,offset,duration)`、`stop(when)` | 【官方】 |
| `AudioParam` | 仅 `defaultValue/maxValue/minValue/value`（**未见自动化方法**） | 【官方】 |
| 与 `setInnerAudioOption` | **不兼容** WebAudioContext；也不兼容 `useWebAudioImplement` 的 InnerAudioContext | 【官方】 |
| iOS 静音键 | 官方无说明 | 【待实测】S1 |

### 5.3 网络 / 云函数 / 云存储

| 项 | 数值/结论 | 标签 |
| :--- | :--- | :--- |
| 网络默认超时 | **60s**；可在 `app.json networkTimeout` 或单次接口 `timeout` 配置 | 【官方】 |
| 网络并发 | `wx.request/uploadFile/downloadFile` **最大并发 10**；`connectSocket` 5 | 【官方】 |
| 切后台 | 进入后台后 **5s 内未结束的网络请求回调 `fail interrupted`**，回前台前无法调用网络接口 | 【官方】 |
| `callFunction` 参数 | `name`、`data`、`config{env}`；**无 timeout 字段**；`data` 建议 ≤100KB（大数据用 `wx.cloud.CDN` 标记） | 【官方】 |
| 云函数超时 | 官方文档未载明；本项目在控制台已配置 **60s**（默认 3s） | 【官方未载明】/【实测】 |
| 云函数运行环境 | Linux CentOS 7.2；`/tmp` **512MB**；无状态、会复用实例但不可依赖 | 【官方】 |
| `wx.cloud.uploadFile` | 本地文件→云存储，返回 fileID；**单文件大小上限未标注** | 【官方】/【待实测】S10（本项目已实测 6.87MB 成功） |
| `wx.cloud.downloadFile` | fileID→`tempFilePath`；无大小上限文字；网络层 `wx.downloadFile` ≤200MB | 【官方】/【FEASIBILITY 复核】 |
| `getTempFileURL` | **私有文件链接 10 分钟有效期**；**一次最多 50 个**；示例 `maxAge` 可为 1 小时；官方 guide 另称「有效期两个小时」→ **同一站点口径不一致，按最保守的 10min 设计** | 【官方（存在冲突）】 |
| 云存储 fileID 使用 | 「支持在 image、audio 等组件中传入云文件 ID」 | 【官方】 |
| 云存储临时链接 | 云存储临时 https 链接播放是否需域名白名单 → 官方未见说明；**优先 fileID 规避** | 【待实测】 |

### 5.4 文件 / 包体 / 内存

| 项 | 数值/结论 | 标签 |
| :--- | :--- | :--- |
| `chooseMessageFile` | 2.5.0+；`count` **0~100**；`type` all/video/image/file；`extension` 2.6.0+ 仅 `type:file` 有效；返回 `tempFiles[path,size,name,type,time]`（`time` 工具暂不支持） | 【官方】 |
| `readFile` | **单文件 ≤100MB**；不传 `encoding` 返回 ArrayBuffer；错误码 1300202 即超限 | 【官方】 |
| 本地临时文件 | 运行时 ≤4GB；退出后若 >2GB 按最近使用清理到 <2GB | 【官方】 |
| 本地缓存+用户文件 | 合计 ≤200MB | 【官方】 |
| 代码包 | 主包/单个分包 ≤2MB；所有分包合计 ≤30MB（服务商 20MB） | 【官方】 |
| 运行内存 | **无官方数值上限**；iOS 连续收到内存告警会主动销毁小程序并提示「运行内存不足」；建议监听 `wx.onMemoryWarning` 清理 | 【官方（无数字）】 |
| 设备像素比 | `wx.getWindowInfo().pixelRatio`（2.20.1+） | 【官方】 |
| 设备信息 | `wx.getDeviceInfo()` 返回 `platform`（ios/android/ohos/windows/mac/devtools）、`benchmarkLevel` 等（2.20.1+） | 【官方】 |

### 5.5 由数值推导的产品约束（建议写入详细设计）

| 约束 | 推导 |
| :--- | :--- |
| WAV 10min 不可行 | 44.1kHz/16bit 立体声 10min≈105.8MB，超 50MB 产品上限，且超 readFile 100MB；50MB 内立体声 WAV 约 **4.9min**、单声道约 9.9min |
| 编辑源建议 | mp3/m4a/aac 为主；wav 提示「≤5min」；flac/ogg/amr/ape/wma 在 iOS 仅可编辑不可试听 |
| 峰值内存预算 | 客户端常驻：peaks(≤32KB)+2 个播放器+编辑计划+手势缓存；**禁止整首 PCM 常驻**（≤60s 场景除外） |
| 上传耗时 | 4G 下 10MB≈5~15s、50MB≈30~60s；上传期间必须保持前台（后台 5s 中断【官方】）→ 提示「请保持小程序在前台」 |
| 导出耗时 | 云端渲染 10min 编辑 + 编码可能在 20~50s，逼近 60s 云函数超时与 60s 网络超时 → **必须异步任务 + 轮询**，且服务端需按 60s 预算限额/分段 |

---

## 6. 客户端架构建议

### 6.1 模块划分（新增 `pages/editor` + 组件/工具）

| 模块 | 职责 | 关键约束 |
| :--- | :--- | :--- |
| `pages/editor` | 编辑页状态机：`UPLOADING→ANALYZING→EDITING→EXPORTING→DONE/FAILED`；草稿恢复 | 只持有计划与 UI 状态，不持有 PCM |
| `components/timeline` | canvas 2D 渲染 + 手势状态机 | 波形/滚动/选区不进 `data`；尺寸变化重取节点 |
| `utils/peaks.js` | base64→Int8Array、降采样、插值、缓存（按 fileID+hash） | 缓存 1~2 份即可，避免内存累积 |
| `utils/preview-engine.js` | InnerAudioContext 编排（主轨+BGM）、片段队列、判界、中断恢复 | 单例；页面 `onUnload` 必销毁 |
| `utils/editor-plan.js` | 编辑计划 JSON 的增删改查、时长计算（含 atempo）、校验 | 纯函数、可单测；与服务端契约同构 |
| `utils/analysis-client.js` | `analyze` 接口封装、超时/重试、错误码 | 单次 ≤10s 预算；失败可重试 1 次 |
| `utils/export-client.js` | 上传 BGM/源 → `render` 建任务 → 轮询 → 结果 fileID | 轮询 1.5s→3s 退避；页面隐藏暂停轮询；退出可恢复 |
| `utils/format-gate.js` | 平台格式矩阵、iOS 不可试听提示、体积/时长预检 | 复用现有 `index.js` 的 `playableFormats` 逻辑（`index.js:245`） |

### 6.2 数据流（客户端视角）

```
选源文件 → 本地预检(≤50MB/≤10min/扩展名) → 上传(进度,前台)
        → analyze(fileID) → {duration, peaks, formatMeta}   （预算 ≤8s）
        → 编辑态：plan JSON（区间列表/淡入淡出/音量/变速/BGM/混音参数）
                 + 波形缓存 + 手势状态
        → 试听：preview-engine 按 plan 顺序播放（近似）
        → 导出：render(plan+源fileID+BGM fileID) → taskId
                 → 轮询(1.5s→3s) → 结果 fileID → 试听/下载/转发
```

### 6.3 接口契约（客户端需要的字段，供详细设计引用）

| 接口 | 入参 | 出参（客户端依赖） | 预算 |
| :--- | :--- | :--- | :--- |
| `analyze` | 源 fileID、（可选）BGM fileID | `duration`、`peaks{bucketMs,encoding,channels,data}`、`formatMeta{codec,sampleRate,channels}`、`peaksHash` | 单次 ≤8s（云函数内解码 4kHz） |
| `render` | `plan`（纯数据）、`sourceFileID`、`bgmFileID`、输出格式参数 | `taskId`、`pollAfterMs` | ≤2s（只建任务） |
| `renderStatus` | `taskId` | `status/progress/outputFileID/error/cost` | 轮询 1.5s→3s |
| `cancel` | `taskId` | `ok` | ≤1s |

> 若服务端选择「同步 render」：10min 编辑在 60s 内完成才有希望，且客户端 60s 网络超时/后台 5s 中断不可控 → **不建议**。客户端侧按异步契约实现，服务端实现方式可替换。

### 6.4 降级矩阵

| 场景 | 客户端行为 |
| :--- | :--- |
| 源格式 iOS 不可播 | 编辑页顶部提示「iPhone 不支持该格式试听」；仍可编辑/导出；提供「先转 MP3」入口（需产品确认额度口径） |
| analyze 失败/超时 | 骨架屏 → 重试 1 次 → 失败提示换格式/稍后重试；不进入编辑 |
| 上传中断（切后台） | 捕获失败 → 提示「请保持前台」→ 支持续传/重试（cloud.uploadFile 无断点续传能力，按重传处理） |
| 双实例混播失败/被系统中断 | 降级为「只播主轨」，BGM 提示「导出后可听到配乐」 |
| 预听边界误差 | 预览进度以 ±0.3s 呈现；导出按用户设定值精确 |
| 低端机 Canvas 卡顿 | 降 DPR（2）、柱宽 3~4pt、关 rms 层；仍卡则降级为「简化波形条」（每 200ms 一根） |
| 内存告警 | `wx.onMemoryWarning` → 释放 peaks 缓存/停止预览/清离屏 canvas；提示用户重启小程序 |

---

## 7. 风险清单

| # | 风险 | 影响 | 概率 | 对策 | 关联 Spike |
| :--- | :--- | :--- | :--- | :--- | :--- |
| R1 | 双实例/多实例混播被系统策略限制 | BGM 预览不可用 | 中 | 降级只播主轨；导出后听配乐 | S4 |
| R2 | `onTimeUpdate` 频率低/不稳 | 选区边界预览偏差 | 高 | 双保险判界（定时器+时间戳）；文案说明 | S3 |
| R3 | `playbackRate` 变调 | 预览与导出一致性投诉 | 高 | UI 明示；导出保持音调 | S5 |
| R4 | iOS 源格式不可试听 | 编辑体验断裂 | 高（flac/ogg/amr/ape/wma） | 提示+先转 MP3 入口/导出后验证 | S1 |
| R5 | 端内 decode 内存爆炸 | 闪退/白屏 | 中（若做端内波形） | MVP 不做端内整首解码；短音频才允许 | S2 |
| R6 | 10min 导出逼近 60s 函数与 60s 网络超时 | 导出失败/空白 | 中高 | 异步任务+轮询；服务端限时长/分段；失败重试与额度返还 | S11 |
| R7 | 上传期间切后台 5s 中断 | 上传失败 | 高 | 前台提示+失败重试+进度恢复 | S10 |
| R8 | Canvas 1365 上限/低端安卓崩溃 | 时间轴不可用 | 中 | 视口画布、降 DPR、避免大画布 | S7 |
| R9 | 手势与页面滚动/系统返回手势冲突 | 误操作 | 中 | `disable-scroll`+`catchtouchmove`+阈值状态机 | S7 |
| R10 | 临时 URL 失效导致播放失败 | 结果页异常 | 中 | 播放用 fileID；URL 仅用于转发/下载且现取现用 | S6 |
| R11 | `analyze` 返回 peaks 超传输限制 | 分析失败 | 低 | 31KB/10min，远低于 100KB 建议；超限时改云存储 JSON+downloadFile | S8 |
| R12 | 内存无官方上限，机型差异大 | 低端机崩溃 | 高 | 内存预算+告警清理+Spike 覆盖低端机 | S2/S8 |

---

## 8. E｜真机 Spike 清单（每项含通过标准与降级）

> 原则：能端内验证的先模拟器冒烟，**结论以 iOS + Android 真机为准**；每项记录机型/系统/微信版本。

| # | 验证项 | 验证方法 | 通过标准 | 不通过降级 |
| :--- | :--- | :--- | :--- | :--- |
| S1 | `decodeAudioData` 格式矩阵 | 用 mp3/m4a/aac/wav/flac/ogg/amr 各一段 30s，`readFile`→`decodeAudioData`，记录成功/失败与耗时；iOS+Android 各 1 台 | 至少 mp3/m4a/aac/wav 双端成功且 30s 文件 ≤2s 解码；记录 flac/ogg/amr 结果 | 端内解码仅限白名单格式；否则只走服务端 |
| S2 | PCM 内存与时长边界 | 分别 decode 60s/3min/10min 立体声 44.1k，观察 `wx.onMemoryWarning`、页面卡顿、闪退 | 3min 解码后编辑页可正常操作且无内存告警；10min 允许失败并记录 | 3min 也失败 → 端内解码仅 ≤60s；10min 只走服务端 |
| S3 | `onTimeUpdate` 频率与分段精度 | 播 30s，记录连续回调时间戳；设 10 个片段边界，测实际停点误差 | 回调平均间隔 ≤300ms 且最大间隔 ≤500ms；边界停点误差 ≤±0.3s | 误差大 → 预览文案「边界约 ±0.3s」；导出为准 |
| S4 | 双实例同播（主轨+BGM） | 两个 InnerAudioContext 同时播（不同音量/一个 loop），iOS+Android；再测 `setInnerAudioOption({mixWithOther:true})` | 两路声音同时可闻、音量独立、互不暂停 | 只播主轨；BGM 提示「导出后可听」 |
| S5 | `playbackRate` 音调与边界 | 0.5/0.75/1.25/1.5/2.0 各播 5s，人耳判断是否变调、是否卡顿；再设 2.1/0.4 看是否被钳制 | 0.5~2.0 均能播；2.1/0.4 不生效或钳制不崩溃 | UI 限定 0.5~2.0；文案写明音调可能不同 |
| S6 | fileID 直接播放 & 临时 URL | `src='cloud://...'` 播 30s；再 `getTempFileURL` 播 https URL；记录 URL 过期（10min/1h/2h 口径） | fileID 播放/seek 正常；URL 在有效期内可播 | 播放统一用 fileID；URL 用完即弃 |
| S7 | Canvas 手势/DPR/尺寸 | DPR 2 与 3 机型、低端安卓各 1 台；测点按/拖动/双指缩放/拖手柄/边缘滚动；记录丢帧与崩溃 | 手势跟手无明显滞后；连续操作 3min 无 crash；缩放锚点不漂移 | 降 DPR/柱宽；简化手势（去掉双指平移）；低端机降级 |
| S8 | 大波形绘制性能 | 10min/12000 桶：全览降采样、1s 窗口插值、拖动时 rAF 重绘；用开发者工具 FPS/性能面板 + 真机目测 | 拖动与缩放 ≥45fps；无长任务卡顿；首帧 ≤300ms | 离屏缓存+视口重绘；柱宽加大；关 rms 层 |
| S9 | `chooseMessageFile` 多选与大小 | `count:3` 连续选 3 个文件（不同会话/顺序），记录 `tempFiles` 顺序与字段；选 1 个 >50MB 文件 | 能拿到 3 个文件；顺序可观测并可解释；大文件可拦截/提示 | MVP 仅支持单文件（主轨/配乐各一次单选） |
| S10 | 云上传大小与中断 | 上传 10/30/50MB（弱网 3G 模拟），上传中切后台 5s、锁屏、断网 | 50MB 可传（或明确上限值）；失败可重试；切后台错误可捕获 | 下调单文件上限（如 30MB）；提示保持前台 |
| S11 | callFunction 长任务 | 云函数 `sleep`/真实渲染 30s、45s、55s；前台/切后台/锁屏各一次；记录 errMsg 与耗时 | 前台 45s 内返回成功；后台/超时错误可识别 | 导出改异步任务+轮询；服务端限额（如导出 ≤20s 素材） |
| S12 | 中断与恢复 | 播放/轮询中切后台、来电、锁屏、息屏；返回后检查状态 | 回前台能恢复到可操作状态；不出现「幽灵播放」 | 提供「恢复/重试」按钮；简化恢复逻辑 |
| S13（P1） | 云端 15s 试听片段 | 选一段含淡入/变速/BGM 的区间，云端渲染 15s，客户端下载播放 | 渲染 ≤8s、结果与导出设置一致 | 不做该功能；仅文案说明 |

---

## 9. 遗留待实测 / 待确认

| # | 项 | 影响 | 谁负责/何时 |
| :--- | :--- | :--- | :--- |
| U1 | S1~S13 全部真机结果 | 直接改选型（尤其 A/B） | 客户端负责人，编码前 M0.5 |
| U2 | `callFunction` 相对 60s 网络超时的独立计时/errMsg | 决定导出是否必须异步 | 后端+客户端联调 |
| U3 | `wx.cloud.uploadFile` 真实单文件上限（30/50/100MB） | 编辑源与配乐大小限制 | 云开发控制台实测 |
| U4 | 双实例混播在 iOS 音频会话下的稳定性 | BGM 预览可用性 | S4 |
| U5 | `AudioParam` 是否有未文档化的自动化方法（`setValueAtTime` 等） | 是否可能升级到「轻量精确预览」 | S1 顺带验证 |
| U6 | 临时 URL 播放的域名白名单口径（官方未明确） | 结果页/历史播放实现 | S6 |
| U7 | iOS 源格式「先转 MP3 再编辑」的额度与入口（是否扣次数） | 产品体验与成本 | 产品决策 |
| U8 | 云端 15s 试听片段是否计费/扣次数 | P1 功能可行性 | 产品决策 |
| U9 | 云函数控制台超时上限（是否只能 60s） | 导出时长上限 | 控制台复核 |
| U10 | `chooseMessageFile` 单文件大小上限（官方未标注） | 导入拦截提示 | S9 |

---

## 10. 来源清单（核实日期 2026-10-28）

| # | 来源（官方文档） | 用途 |
| :--- | :--- | :--- |
| 1 | [InnerAudioContext](https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/InnerAudioContext.html) | src/fileID、startTime、playbackRate、volume、格式矩阵、pause/stop、seek、onTimeUpdate |
| 2 | [wx.createInnerAudioContext](https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/wx.createInnerAudioContext.html) | 2.19.0 useWebAudioImplement、必须 destroy |
| 3 | [InnerAudioContext.seek](https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/InnerAudioContext.seek.html) | seek 单位 s、ms 精度 |
| 4 | [InnerAudioContext.onTimeUpdate](https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/InnerAudioContext.onTimeUpdate.html) | 仅「监听进度更新」，无频率 |
| 5 | [wx.setInnerAudioOption](https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/wx.setInnerAudioOption.html) | mixWithOther/obeyMuteSwitch/speakerOn、与 WebAudio 不兼容 |
| 6 | [wx.createWebAudioContext](https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/wx.createWebAudioContext.html) / [WebAudioContext](https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/WebAudioContext.html) | 2.19.0+、平台说明、API 列表、destination、sampleRate |
| 7 | [WebAudioContext.decodeAudioData](https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/WebAudioContext.decodeAudioData.html) | 入参/回调；未列格式 |
| 8 | [AudioBuffer](https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/AudioBuffer.html) | 「短音频」定位、getChannelData |
| 9 | [BufferSourceNode](https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/BufferSourceNode.html) / [.start](https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/BufferSourceNode.start.html) | playbackRate≤2、start(when,offset,duration) |
| 10 | [AudioParam](https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/AudioParam.html) | 仅 value 等属性，无自动化方法 |
| 11 | [canvas 组件](https://developers.weixin.qq.com/miniprogram/dev/component/canvas.html) | type=2d、1365×1365、touch 事件、disable-scroll、同层渲染 |
| 12 | [Canvas](https://developers.weixin.qq.com/miniprogram/dev/api/canvas/Canvas.html) | requestAnimationFrame、createImage、toDataURL |
| 13 | [画布指南](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/canvas.html) | DPR 初始化、帧动画、canvasToTempFilePath |
| 14 | [wx.createOffscreenCanvas](https://developers.weixin.qq.com/miniprogram/dev/api/canvas/wx.createOffscreenCanvas.html) | 2.16.1+、离屏 2d |
| 15 | [事件对象](https://developers.weixin.qq.com/miniprogram/dev/framework/component-framework/event-object.html) | canvas touch 的 x/y 相对画布 |
| 16 | [SelectorQuery](https://developers.weixin.qq.com/miniprogram/dev/api/wxml/SelectorQuery.html) / [NodesRef.fields](https://developers.weixin.qq.com/miniprogram/dev/api/wxml/NodesRef.fields.html) | node/size 取 Canvas 节点 |
| 17 | [wx.getWindowInfo](https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.getWindowInfo.html) | pixelRatio、safeArea |
| 18 | [wx.getDeviceInfo](https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.getDeviceInfo.html) | platform、benchmarkLevel |
| 19 | [wx.chooseMessageFile](https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.chooseMessageFile.html) | count 0~100、extension 2.6.0+、tempFiles 字段 |
| 20 | [FileSystemManager.readFile](https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readFile.html) | ≤100MB、ArrayBuffer |
| 21 | [文件系统](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/file-system.html) | 4GB 临时/2GB 清理/200MB 缓存 |
| 22 | [网络能力](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html) | 60s 默认超时、并发 10、后台 5s 中断 |
| 23 | [wx.cloud.callFunction](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/reference-sdk-api/functions/Cloud.callFunction.html) | 参数与 config、100KB 建议、无 timeout |
| 24 | [wx.cloud.uploadFile](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/reference-sdk-api/storage/uploadFile/client.uploadFile.html) / [downloadFile](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/reference-sdk-api/storage/downloadFile/client.downloadFile.html) | 上传/下载返回值、无大小上限文字 |
| 25 | [Cloud.getTempFileURL](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/reference-sdk-api/storage/Cloud.getTempFileURL.html) | 私有链接 10min、一次 50 个 |
| 26 | [云存储指南](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/storage.html) / [存储 API](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/storage/api.html) | 「audio 等组件可传 fileID」、2h 口径 |
| 27 | [云函数运行机制](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/functions/mechanism.html) | Linux、/tmp 512MB、无状态 |
| 28 | [内存优化](https://developers.weixin.qq.com/miniprogram/dev/framework/performance/tips/runtime_memory.html) | 无内存数值、iOS 内存告警销毁、onMemoryWarning 建议 |
| 29 | [setData 性能](https://developers.weixin.qq.com/miniprogram/dev/framework/performance/tips/runtime_setData.html) | 节点量/更新量成本、避免高频 setData |
| 30 | [分包加载](https://developers.weixin.qq.com/miniprogram/dev/framework/subpackages.html) | 主包/分包 2MB、合计 30MB |

> 备注：本次未能使用站内/外部搜索（工具不可用），因此没有引用任何社区帖子作为依据；「社区常见 50MB」「onTimeUpdate 约 250ms」等说法仅作为 Spike 线索，不作为结论。

---

## 附录 A｜与现有实现/文档的衔接

| 现状 | 位置 | 对新编辑功能的影响 |
| :--- | :--- | :--- |
| 已用两个 InnerAudioContext（源/结果）并提供 onHide 停止、onUnload 销毁 | `miniprogram/pages/index/index.js:141/167/128/132/193` | 预览引擎可复用该模式；编辑页需独立实例，不可与首页共用 |
| 源音频 `src = file.path`（本地临时路径）播放 | `index.js:268` | 编辑预览可直接用本地临时文件，不依赖上传完成 |
| 结果音频 `src = downloadUrl`（服务端临时链接） | `index.js:440` | 按 Q2 结论，**建议改为 fileID 直接播放**，减少 URL 时效问题 |
| `playableFormats = ['mp3','aac','m4a','wav']` 前端格式门控 | `index.js:245` | 编辑页可直接复用该矩阵；iOS 上 flac/ogg/amr/ape/wma 需提示不可试听 |
| 50MB 本地拦截、后端时长预检 | `index.js:229/357` | 编辑入口沿用，并新增 WAV 10min 的等效时长提示（§5.5） |
| 云函数 `ffmpegProbe` 已部署、60s 超时 | `cloudfunctions/ffmpegProbe` | 分析接口可复用同一函数（新增 action），导出任务需新增任务化接口 |
| FEASIBILITY §2.3 已记录 `createWebAudioContext` 2.19.0+、格式支持待实测 | `docs/FEASIBILITY.md` | 本文 §2/§3 与其一致；新增「端内解码内存不可行」的量化结论 |
| TASK_PLAN §6 已规划 `utils/audio.js` | `docs/TASK_PLAN.md` | 建议拆为 `preview-engine.js`（播放编排）与 `audio.js`（能力探测/销毁） |
