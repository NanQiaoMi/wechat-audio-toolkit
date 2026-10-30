# 可行性研究：微信小程序「音频格式转换」

> 调研日期：2026-10-27 ｜ 调研对象：微信小程序端 + 微信云开发 / 微信云托管 / 自建后端
> **后续修正（2026-10-27）**：本报告 §7.2 建议的“同步转码”不成立——`wx.cloud.callContainer` 的 `timeout` 官方上限为 15 秒。最终方案改为“任务入队 + 客户端轮询”的异步模型，见 [TASK_PLAN](./TASK_PLAN.md) ADR-003 与 [DEV_LOG](./DEV_LOG.md)。另外：上传路径改为服务端下发票据（客户端拿不到 openid，不能用 `in/{openid}/`）；内容安全代理码率按时长自适应（64k×30min 会超 10MB）；任务增加惰性超时补偿与额度计数（ADR-013/014）。其余事实与结论不变，本报告作为依据文档保留。
> 方法说明：本次 `web_search` 检索通道不可用（无 API key），改用 `curl` 直连官方文档站逐页核验；文档页「最后一次编辑于」日期可佐证时效性。
> 置信度约定：**高**=官方文档原文明确；**中**=官方文档间接/同源底座推断；**低**=二手信息或推断；**待核实/待实测**=本次未取得官方依据，禁止当作既定事实。
> 工程现状：`miniprogram/` + `cloudfunctions/` 为空模板，`libVersion=3.17.5`，云环境 `envList` 为空，尚无业务代码。

---
## 0. 结论摘要（10 条）
1. **端内 ffmpeg / lame 转码不可行**：单包 2MB、全部分包 30MB，且 `WXWebAssembly.instantiate` 只接受**代码包内路径**，无法按需从 CDN 拉取 wasm；无线程/大内存保证。端内最多做「轻量重封装/元信息读取」，通用转码必须上云。
2. **推荐架构：小程序端 + 微信云托管（Docker + FFmpeg）+ 云托管对象存储**。云托管支持自定义镜像、任意语言、缩容至 0、`wx.cloud.callContainer` 免域名内网调用，官方 FAQ 明确「面向全用户，私人企业和个人均可使用」。
3. **注意**：「云开发中的云托管」已停止功能更新，新项目应直接用独立的**微信云托管**（独立控制台、独立计费，与云开发环境互不可见）。
4. **关键限制数字**：单包 2MB / 分包总量 30MB；`downloadFile` 单次 ≤200MB；本地临时文件运行时 4GB、本地缓存+用户文件共 200MB；云函数 `/tmp` 512MB；`wx.cloud.callContainer` 需基础库 ≥2.23.0；云托管请求超时 60s、请求包体 20MB（后者来自腾讯云 CloudBase 文档，微信端待实测）。
5. **产品硬约束：小程序不能浏览/读取用户手机本地文件**。唯一合规入口是「微信会话文件」`wx.chooseMessageFile`（一次最多 100 个）或录音；没有文件选择器 API。这决定 UX 必须引导用户「先把音频发到微信会话/收藏」。
6. **播放兼容性是最大隐性错误源**：`InnerAudioContext` 在 iOS 不支持 flac/ogg/amr/ape/wma（Android 支持），因此**试听输出必须收敛到 mp3 / m4a(aac) / wav**；输入 ape/wma/amr 只能先转码再试听。
7. **导出路径受限**：`wx.shareFileMessage`（2.16.1+，仅点击行为）可转发给好友；`saveFileToDisk` 仅 PC；`openDocument` 仅 doc/pdf 等文档，**不支持音频** → 手机端「保存到本地」基本无官方通道，产品文案不要承诺。
8. **合规硬门槛**：类目选「工具 > 图片处理」（明确覆盖「音频的本地制作、剪辑」，无资质要求，但不得传播/公开访问）；**不要碰「文娱 > 音乐」**（需《网络文化经营许可证》/《信息网络传播视听节目许可证》，个人主体拿不到）。必须完成**小程序备案**（个人主体可备案，上限 5 个小程序）、隐私指引（「收集你选中的文件」+「访问你的麦克风」）、内容安全 `mediaCheckAsync`（音频检测单个 ≤10MB，且不支持 amr/ape）。
9. **变现**：虚拟支付仅**企业/个体户**可开通，个人主体不能做付费；个人可申请流量主广告（开通门槛本次未核验到，待核实）。
10. **MVP 边界建议**：单文件 ≤50MB / 时长 ≤30 分钟、异步任务（入队 + 客户端轮询，`callContainer` 15s 上限）、输入 10 种格式（amr/ape/wma 探测失败则友好报错）、输出 mp3/m4a/wav（flac/ogg 仅 Android 可试听）；本机可先用 Docker 跑 FFmpeg 验证格式矩阵与耗时（见 §7.4）。

---
## 1. 端内转码可行性
### 1.1 包体积现行上限
| 项目 | 现行数值 | 来源（核实日期 2026-10-27） | 置信度 |
| :--- | :--- | :--- | :--- |
| 整个小程序所有分包合计 | **≤30MB**（服务商代开发 ≤20MB） | https://developers.weixin.qq.com/miniprogram/dev/framework/subpackages.html （改版编辑 2026-07-28） | 高 |
| 单个分包 / 主包 | **≤2MB** | 同上 | 高 |
| 代码包内文件 | 运行后**不可动态修改/删除**，替换需重新发布 | https://developers.weixin.qq.com/miniprogram/dev/framework/ability/file-system.html （2026-07-23） | 高 |

> 结论：2MB 单包墙意味着任何「把 libavcodec 塞进包」的方案在工程上不成立；30MB 总量对 brotli 后的 ffmpeg wasm（业界发行版通常 10MB 量级，**具体体积待实测**）也几乎没有留给业务代码的空间。
### 1.2 WXWebAssembly 能力与限制
| 项目 | 结论 | 来源 | 置信度 |
| :--- | :--- | :--- | :--- |
| 全局访问 | 基础库 **v2.13.0+** | https://developers.weixin.qq.com/miniprogram/dev/framework/performance/wasm.html （2026-06-16） | 高 |
| Worker 内使用 | 基础库 **v2.15.0+**；`.wasm` 必须放在 worker 目录**之外**（worker 目录只打包 .js） | 同上 | 高 |
| 加载方式 | `WXWebAssembly.instantiate(path, imports)`，path **只接受代码包内路径**（支持 `.wasm` / `.wasm.br`） | 同上 | 高 |
| 网络拉取 wasm | **不支持**（不能先 downloadFile 再 instantiate；只能随包发布） | 同上（由「只接受代码包路径」推定） | 高（推定性结论） |
| 能力面 | 支持 Memory/Table/Global；导出函数/内存/表；**iOS 暂不支持 Global 导出** | 同上 | 高 |
| 压缩 | 支持 brotli 压缩 wasm（v2.14.0+），可拆多文件进分包降首包 | 同上 | 高 |
| 插件内使用 | 基础库 **v2.18.1+** 插件支持 WXWebAssembly | 同上 | 高 |
| SIMD | 微信 **8.0.25+** 支持 | 同上 | 高 |
| 线程 / SharedArrayBuffer | 官方文档未提及，**不保证可用** | — | 待实测 |
| wasm 内存上限 | 官方未公布具体值 | — | 待实测 |
### 1.3 微信插件市场是否有成熟「音频转码 / ffmpeg」插件
- 本次检索通道受限（`web_search` 不可用、插件市场页面需登录态），**未能取得可引用的检索结论** → 标记「**待核实**」。
- 即便存在此类插件，仍受三重约束：插件代码包体积（上限**待核实**）、WXWebAssembly 只能加载代码包内 wasm、以及插件调用 API 的白名单限制（https://developers.weixin.qq.com/miniprogram/dev/framework/plugin/api-limit.html）。
- 结论：**不把插件作为主路径**，最多作为备选调研项。
### 1.4 判定：端内转码 ❌ 不可行
1. **体积墙**：单包 2MB；ffmpeg wasm 需多分包 + 30MB 总量，业务代码几乎无空间，且每次升级全量重发。
2. **加载墙**：`instantiate` 只吃代码包路径 → 无法「首屏小包 + 按需下载 wasm」。
3. **算力/内存墙**：转码是 CPU/内存密集型；小程序 JS 线程与内存上限未公开且移动端易被系统回收，长音频（>10 分钟）OOM 风险高。
4. **体验墙**：无多线程保证，转 320k MP3 的耗时会长于用户可接受阈值；后台/息屏会中断。
5. **可行替代**：端内只做「格式探测 + 元信息 + 轻量无损重封装（如 wav/pcm 参数调整）」这类毫秒级操作；**通用转码上云**。

---
## 2. 导入 / 播放 / 文件能力
### 2.1 文件导入：能否直接读手机本地文件？→ **不能（关键产品约束）**
| 能力 | 结论 | 来源 | 置信度 |
| :--- | :--- | :--- | :--- |
| 直接从手机文件系统选择任意文件 | **无公开 API**。小程序运行在沙箱内，文件系统 API 只能访问 `wxfile://` 下的临时/缓存/用户文件，**无法浏览 Android /sdcard 或 iOS「文件」App** | https://developers.weixin.qq.com/miniprogram/dev/framework/ability/file-system.html | 高 |
| 会话文件导入 | `wx.chooseMessageFile`：基础库 **2.5.0+**；`count` **0~100**；`type`=all/video/image/file；`extension` 过滤仅 `type=file` 有效（**2.6.0+**） | https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.chooseMessageFile.html | 高 |
| 返回值 | `tempFiles[]`：`path`（本地临时路径）、`size`(B)、`name`、`type` | 同上 | 高 |
| 单文件大小上限 | 接口文档**未标注**上限（受传输/内存制约） | 同上 | 待实测 |
| 其他导入 | `wx.chooseMedia` 仅图片/视频；录音可用 | https://developers.weixin.qq.com/miniprogram/dev/api/media/recorder/wx.getRecorderManager.html | 高 |

> **产品含义**：用户必须先把音频「发到某个微信会话 / 收藏 / 文件传输助手」，再从小程序内选。PRD 里「从手机本地文件选择」这一入口应删除或改为引导文案。
### 2.2 录音（可作为输入源）
| 参数 | 数值 | 来源 | 置信度 |
| :--- | :--- | :--- | :--- |
| 格式 `format` | **aac（默认）/ mp3 / wav / PCM** | https://developers.weixin.qq.com/miniprogram/dev/api/media/recorder/RecorderManager.start.html | 高 |
| 时长 `duration` | 默认 60000ms，最大 **600000ms（10 分钟）** | 同上 | 高 |
| 采样率 | 8000/11025/12000/16000/22050/24000/32000/44100/48000 | 同上 | 高 |
| 声道 | 1 或 2（默认 2） | 同上 | 高 |
| 帧回调 | `frameSize` 仅 mp3/pcm 支持 | 同上 | 高 |
### 2.3 播放与解码：官方支持格式（重点）
`InnerAudioContext` 支持格式（**官方表格**，来源 https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/InnerAudioContext.html ，置信度 高）：

| 格式 | iOS | Android | 备注 |
| :--- | :---: | :---: | :--- |
| mp3 | √ | √ | 首选输出 |
| m4a | √ | √ | 首选输出（aac 封装） |
| aac | √ | √ | |
| wav | √ | √ | 文件大 |
| flac | **×** | √ | iOS 不能试听 |
| ogg | **×** | √ | iOS 不能试听 |
| amr | **×** | √ | iOS 不能试听（微信语音常用） |
| ape | **×** | √ | iOS 不能试听 |
| wma | **×** | √ | iOS 不能试听 |
| aiff | √ | **×** | |
| caf | √ | **×** | |
| mp4 | **×** | √ | |

- `wx.createInnerAudioContext`：基础库 1.6.0+；`useWebAudioImplement`（2.19.0+）对短音频性能更优、但内存上涨；**音频资源不会自动释放，必须 `destroy()`**（来源：[wx.createInnerAudioContext](https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/wx.createInnerAudioContext.html)，置信度 高）。
- `wx.createWebAudioContext`：基础库 **2.19.0+**，提供 `decodeAudioData` 可把 ArrayBuffer 解码成 PCM（https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/wx.createWebAudioContext.html ）；**解码支持哪些容器/编码取决于底层实现，flac/ape/wma 是否可解未在文档列明 → 待实测**。可用于「读波形/算时长/端内轻处理」，但**不能替代转码**（编码器仍缺）。
- 平台差异结论：**同一产物在 iOS/Android 的试听能力不同**，UI 需按 `wx.getDeviceInfo().platform` 做降级提示。
### 2.4 导出 / 分享 / 保存
| API | 能力 | 关键限制 | 来源 | 置信度 |
| :--- | :--- | :--- | :--- | :--- |
| `wx.shareFileMessage` | 转发文件到聊天 | 基础库 **2.16.1+**；`filePath` 必须本地/临时路径；**仅点击行为时调用**；插件不支持 | https://developers.weixin.qq.com/miniprogram/dev/api/share/wx.shareFileMessage.html | 高 |
| `FileSystemManager.saveFile` | 临时文件→缓存文件 | 与用户文件合计 **≤200MB** | https://developers.weixin.qq.com/miniprogram/dev/framework/ability/file-system.html | 高 |
| `wx.saveFileToDisk` | 保存到用户磁盘 | 基础库 2.11.0+；**仅 PC 端支持**（手机端不可用） | https://developers.weixin.qq.com/miniprogram/dev/api/file/wx.saveFileToDisk.html | 高 |
| `wx.openDocument` | 新页面打开文档 | `fileType` 仅 doc/docx/xls/xlsx/ppt/pptx/pdf，**不支持音频** | https://developers.weixin.qq.com/miniprogram/dev/api/file/wx.openDocument.html | 高 |
| 保存到相册/音乐App | 无音频类 API | — | — | 高（能力缺失） |

> 产品结论：手机端「保存到本地」只能靠 **转发给好友/自己（文件传输助手）** 或长按文件消息另存；**小程序内无法直接写手机公共目录**。分享到朋友圈/公开访问对工具类目也不合规（见 §6.1）。
### 2.5 临时文件生命周期与配额
| 项目 | 数值/策略 | 来源 | 置信度 |
| :--- | :--- | :--- | :--- |
| 本地临时文件 | 运行时最多 **4GB**；退出后若占用 >2GB，按「最近使用时间」清理到 <2GB | https://developers.weixin.qq.com/miniprogram/dev/framework/ability/file-system.html （2026-07-23） | 高 |
| 全局临时文件 | 所有小程序合计 >6GB 时按小程序维度清理 | 同上 | 高 |
| 本地缓存文件 + 本地用户文件 | 合计 **≤200MB**（含小游戏） | 同上 | 高 |
| 临时文件有效期 | 仅当前生命周期保证有效，**重启后不一定可用**；需 `saveFile`/`copyFile` 转存 | 同上 | 高 |
### 2.6 上传 / 下载通道
| 通道 | 上限/说明 | 来源 | 置信度 |
| :--- | :--- | :--- | :--- |
| `wx.downloadFile` | **单次下载 ≤200MB**；默认超时 **60s**（可传 timeout） | https://developers.weixin.qq.com/miniprogram/dev/api/network/download/wx.downloadFile.html | 高 |
| `wx.uploadFile` | 文档**未标注大小上限**；`multipart/form-data`；可设 timeout（2.10.0+）；并发上限 10 | https://developers.weixin.qq.com/miniprogram/dev/api/network/upload/wx.uploadFile.html | 高（上限见待实测） |
| `wx.cloud.uploadFile`（云存储直传） | 官方文档未标注单文件上限（**待核实**；社区常见「约 50MB」说法为二手，勿当结论） | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/storage/api.html | 待实测 |
| 云存储临时链接 | 有效期 **2 小时** | 同上（2026-08-24 版） | 高 |

---
## 3. 云端方案核验（重点）
### 3.1 微信云托管（CloudBase Run，独立控制台）
| 核验项 | 结论 | 来源 | 置信度 |
| :--- | :--- | :--- | :--- |
| 支持 Docker / 自定义镜像 | **支持**。镜像部署、本地代码部署（平台构建）、Git 仓库、CLI 四种方式；底层为 Docker + K8S | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/basic/overview.html ；…/src/guide/service/image.html | 高 |
| 能 apt 安装 ffmpeg | **能**（任意基础镜像 + Dockerfile，即标准容器能力；官方「任意语言/框架」承诺） | …/src/basic/intro.html | 高 |
| 镜像架构 | 基于 **X86**，**不支持 ARM 镜像**；支持 AMD 镜像 | https://docs.cloudbase.net/run/deploy/deploy/deploying-image （腾讯云 CloudBase，同源底座） | 中 |
| 镜像仓库 | 每服务分配独立仓库，**可存 100 个镜像**，存储不收费；不支持自定义绑定仓库 | …/src/guide/service/image.html | 高 |
| 镜像大小上限 | **官方文档未载明** → 待核实（构建超时会先撞墙：官方 FAQ 提到构建 >10 分钟易失败） | …/src/guide/service/faq.html | 待核实 |
| 手动上传代码包 | 文件夹/zip，**≤2 MiB**（仅本地代码部署方式） | …/src/guide/service/online.html | 高 |
| 实例规格 | CPU:内存 **固定 1:2**；最小 **0.25 核 0.5GiB**，最大 **16 核 32GiB** | https://docs.cloudbase.net/run/deploy/service-setting | 高 |
| 缩容到 0 | **支持**，无流量时不产生实例费用；官方称 **20s 内**快速扩容 | …/src/basic/intro.html；…/src/basic/overview.html | 高 |
| 请求超时 / 包体 | **超时 60s**、**请求包体 20MB** | https://docs.cloudbase.net/run/limitation （云开发中的云托管口径） | 中（微信云托管同底座，**待实测**） |
| 服务数 / 实例上限 | 单环境 **15 个服务**、最多 **28 个实例** | 同上 | 中（待实测） |
| `wx.cloud.callContainer` | 基础库 **≥2.23.0**（需在后台设最低基础库）；走内网专线、**无需配置服务器域名**、**不产生公网流量**、自动带 openid/unionid header | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/development/call/mini.html | 高 |
| 公网默认域名 / ICP | 平台提供默认公网域名；自定义域名需**已备案**；公网可关闭（关闭不影响 callContainer） | …/src/basic/overview.html；https://docs.cloudbase.net/run/deploy/service-setting | 高 |
| 计费 | 按量后付：CPU **0.055 元/核·小时**、内存 **0.032 元/GB·小时**、公网流量 **0.8 元/GB**、构建 **0.05 元/分钟**；0.25 核 0.5G ≈ **0.02975 元/小时**（≈0.71 元/天） | …/src/Billing/price.html （2026-08-24） | 高 |
| 免费额度 | **首个环境**赠 3 个月：CPU 720 核·时、内存 1440 GB·时、构建 600 分钟、公网流量 5GB、对象存储 5GB 等 | 同上 | 高 |
| **个人主体能否开通** | **能**。官方 FAQ：「微信云托管面向全用户」；但「必须先有微信小程序/公众号才可以开通」 | …/src/info/faq.html （2026-08-24） | 高 |
| 云开发中的云托管 | **已停止功能更新，仅存量运行**，官方建议迁移到微信云托管 | …/src/info/faq.html | 高 |
| 关键限制（重要） | 云托管与云开发是**两套独立环境/计费**，云开发控制台看不到云托管环境 | …/src/info/faq.html | 高 |

> **架构判断**：云托管是唯一同时满足「FFmpeg 完整能力（apt/静态二进制）+ 60s 级请求 + 免域名内网调用」的官方方案。冷启动是唯一体验风险：缩容到 0 后首个请求需等实例拉起（官方只说 20s 扩容，未给冷启动时长 → **待实测**）。
### 3.2 云开发云函数
| 核验项 | 结论 | 来源 | 置信度 |
| :--- | :--- | :--- | :--- |
| 运行环境 | 云端 **Linux**（文档脚注：CentOS 7.2 系），**Node.js** 运行时 | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/functions.html ；…/functions/mechanism.html （2026-08-24） | 高 |
| 临时磁盘 | `/tmp` 提供 **512MB**，函数执行完可能被销毁，**不可依赖持久化** | 同上 | 高 |
| 实例形态 | 无状态、平台自动扩缩容；实例可复用，临时盘可能被复用 | 同上 | 高 |
| Node 运行时版本 | 现行文档**未载明**具体版本（Node 16/18/20 说法为二手） | — | 待核实 |
| 超时上限 | 现行文档**未载明**（网关侧常见 60s 说法为二手） | — | 待核实 |
| 代码包 / 层（layer）大小 | 微信云开发云函数**未见 layer 机制**；代码包大小上限文档未载明 | — | 待核实 |
| 内置 ffmpeg 静态二进制 | **理论上可**（同 Linux x86_64 二进制 + `/tmp` 执行），但受代码包上限 + 512MB `/tmp` + 超时三重限制；社区有做法但**本次未取得可信来源** | — | 待实测（非官方） |

> 结论：云函数适合**编排/元信息/签发临时链接**，**不适合**作为主转码引擎：ffmpeg 静态二进制通常 70MB+（待实测），叠加 512MB `/tmp` 与未知超时，10 分钟以上音频风险高。
### 3.3 云存储 / 云数据库
| 项目 | 结论 | 来源 | 置信度 |
| :--- | :--- | :--- | :--- |
| 云存储用途 | 任意非结构化数据（音频/图片/视频）；组件 `image`/`audio` 可直接用 fileID | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/storage.html | 高 |
| 上传/下载 | `wx.cloud.uploadFile/downloadFile`、`deleteFile`，服务端 SDK 同能力 | …/guide/storage/api.html | 高 |
| 临时链接 | 由 fileID 换临时 URL，**有效期 2 小时** | 同上 | 高 |
| 单文件大小 | 官方未载明（**待核实**） | — | 待核实 |
| 生命周期自动清理 | 云开发存储**未见官方 TTL/生命周期规则**；需自建定时触发器清理（**待核实**云托管对象存储是否可配 COS 生命周期） | — | 待核实 |
| 云数据库 | JSON 文档型（集合/记录），每条记录有 `_id`/`_openid`；单条大小上限未载明 | …/basis/capabilities.html | 高（上限待核实） |

> 建议：**MVP 历史记录存本地 storage 元信息即可**，避免一上来就启用云托管 MySQL（MySQL 算力 0.342 元/个·小时，折合 ≈8.2 元/天，对低频工具是纯浪费）。
### 3.4 三方案对比与推荐
| 维度 | 微信云托管（推荐） | 云开发云函数 | 自建服务器 |
| :--- | :--- | :--- | :--- |
| Docker/apt 装 FFmpeg | ✅ 原生支持 | ⚠️ 需塞静态二进制，体积/超时未知 | ✅ |
| 单次可用时长 | 请求 60s（长任务需异步化） | 未知（恐 <60s） | 自定 |
| 免域名 | ✅ callContainer 内网 | ✅ 云函数天然免域名 | ❌ 需 HTTPS + ICP 备案 |
| 扩缩容 | ✅ 缩容至 0 / 20s 扩容 | ✅ 自动 | ❌ 自行运维 |
| 冷启动 | 有（缩容 0 后），可设最小实例 1（≈0.71 元/天） | 有 | 无 |
| 与云开发关系 | 独立环境/独立计费 | 同环境 | 无关 |
| 成本（低量） | 免费额度 3 个月后约几元~几十元/月 | 按调用量与资源 | 服务器 30~60 元/月 + 备案成本 |
| 工期 | 中（Dockerfile + HTTP 服务，2~4 天） | 低（但 ffmpeg 可行性未闭环） | 高（备案 + 运维 + 鉴权） |
| 主要风险 | 镜像体积/冷启动/异步化 | ffmpeg 包体、超时、`/tmp` 溢出 | 备案周期、鉴权、DDoS |
| **推荐结论** | **主路径** | 编排/元信息/清理任务 | 不建议（MVP 阶段） |

---
## 4. 自建后端备用路径
| 要求项 | 结论 | 来源 | 置信度 |
| :--- | :--- | :--- | :--- |
| 协议 | 只支持 **https**（`wx.request/uploadFile/downloadFile`）与 **wss** | https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html （2026-08-21） | 高 |
| 域名 | **必须 ICP 备案**；不能是 IP 或 localhost；**只支持子域名，不能配父域名** | 同上 | 高 |
| 端口 | 配置了端口就只能用该端口；不配端口则 URL 里连 `:443` 都不能出现 | 同上 | 高 |
| 校验 | 需在「小程序后台-开发-开发设置-服务器域名」配置；`api.weixin.qq.com` 不可配 | 同上 | 高 |
| 超时 | **默认 60s**，可在 `app.json` 的 `networktimeout` 或接口 `timeout` 覆盖 | 同上 | 高 |
| 并发 | `request/uploadFile/downloadFile` 合计**最大并发 10** | 同上 | 高 |
| 下载大小 | 单次 ≤200MB（downloadFile） | downloadFile 文档 | 高 |
| 大文件建议 | ① 小程序端**直传对象存储**（先取签名/临时密钥），业务服务器只传 fileID；② 分片上传 + 断点续传；③ 避免 `uploadFile` 走自家服务器转发（并发 10 + 60s 双重瓶颈）；④ 结果回传用 `downloadFile` 临时 URL（≤200MB） | 综合 | 中 |
| 个人主体 web-view | **个人类型小程序不支持 web-view**（业务域名能力不开放给个人账号） | https://developers.weixin.qq.com/miniprogram/dev/framework/ability/domain.html | 高 |

---
## 5. 格式与 FFmpeg
### 5.1 输入格式识别与解码（FFmpeg 侧，需完整构建）
| 输入 | 容器/编码 | FFmpeg 解码 | 备注 | 置信度 |
| :--- | :--- | :--- | :--- | :--- |
| mp3 | MP3 | 原生 `mp3float` | 全场景 | 高 |
| wav | WAV/PCM | 原生 | 全场景 | 高 |
| flac | FLAC | 原生 | 无损 | 高 |
| aac | ADTS/裸 AAC | 原生 `aac` | | 高 |
| m4a | MP4/AAC | 原生 | iOS 录音常见 | 高 |
| ogg | Ogg/Vorbis | 原生 `vorbis` | | 高 |
| opus | Ogg/Opus | 原生 `libopus`/`opus` | | 高 |
| amr | AMR-NB/WB | 原生**解码** `amrnb`/`amrwb` | 编码需 `libopencore-amrnb`（非默认全量） | 高 |
| ape | Monkey's Audio | 原生 `ape` 解码 | 需 ffmpeg 完整构建，精简镜像可能缺失 | 中 |
| wma | ASF/WMA | 原生 `wmav1/wmav2/wmapro` | 同上 | 中 |
| aiff | AIFF/PCM | 原生 | iOS 播放支持 | 高 |

> 关键工程点：**用 `ffprobe` 先探测**（而不是只看扩展名），探测失败即友好报错；对 amr/ape/wma 建议先转 mp3 再进内容安全检测（`mediaCheckAsync` 不支持 amr/ape，见 §6.3）。
### 5.2 输出格式在微信内的兼容性
| 输出 | iOS 试听 | Android 试听 | 转发文件后接收方播放 | 建议 |
| :--- | :---: | :---: | :--- | :--- |
| **mp3** | √ | √ | 兼容性最好 | **默认输出** |
| **m4a(aac)** | √ | √ | 好（iOS 生态友好） | 次选默认 |
| **wav** | √ | √ | 体积大，慎用 | 「无损」选项 |
| flac | × | √ | iOS 不可播 | 仅作「无损保存」，试听需另转 mp3 预听 |
| ogg/opus | × | √ | iOS 不可播 | 不建议作为主输出 |
| amr | × | √ | 老旧设备兼容 | 仅「微信语音场景」可选，需提示 iOS 不能试听 |
| aiff | √ | × | — | 不提供 |

> 「转发后能否直接播放」取决于微信聊天内置播放器对该格式的支持，本次**未取得官方格式清单 → 待实测**（建议真机矩阵：iOS/Android × mp3/m4a/wav/flac/amr）。
### 5.3 MP3 / AAC 专利与授权注意点
- **MP3**：核心基础专利在 2017 年前后到期（公开资料口径，**非官方，置信度中**），FFmpeg 的 `libmp3lame` 可用；但仍建议保留「技术实现说明」以备审核。
- **AAC**：仍处于专利池许可范围（Via LA 等，含编码/解码），商用规模化需评估授权；MVP 阶段属低风险但**不等于零风险**（**非官方结论，需法务确认**）。
- **免版税**：FLAC、Ogg Vorbis、Opus 无专利许可费，适合作为「无损/高压缩」选项。
- 参考：FFmpeg 官方法律说明 https://ffmpeg.org/legal.html （非微信来源，置信度中）。
- 行动项：在「关于」页写明「本工具基于 FFmpeg（LGPL/GPL 依构建而定），转码在服务端完成」；**若静态链接 GPL 组件，需提供相应源码或选择 LGPL 配置**。
### 5.4 常用命令与参数预设（8 条）
```bash
# 1) 通用转 MP3（CBR 192k）——默认输出
ffmpeg -y -i in.ext -vn -map_metadata -1 -c:a libmp3lame -b:a 192k -ar 44100 -ac 2 out.mp3
# 2) MP3 VBR（质量优先，体积更小）
ffmpeg -y -i in.ext -vn -c:a libmp3lame -q:a 2 out.mp3
# 3) 转 M4A/AAC（移动端友好）
ffmpeg -y -i in.ext -vn -c:a aac -b:a 192k -movflags +faststart out.m4a
# 4) 转 WAV（16bit/44.1k 立体声，体积大）
ffmpeg -y -i in.ext -vn -c:a pcm_s16le -ar 44100 -ac 2 out.wav
# 5) 转 FLAC（无损压缩）
ffmpeg -y -i in.ext -vn -c:a flac -compression_level 8 out.flac
# 6) 转 Ogg/Opus（低码率语音，体积最小）
ffmpeg -y -i in.ext -vn -c:a libopus -b:a 64k -vbr on out.ogg
# 7) 转 AMR-NB（需构建含 libopencore-amrnb）
ffmpeg -y -i in.ext -vn -c:a libopencore_amrnb -ar 8000 -ac 1 -b:a 12.2k out.amr
# 8) 探测元信息（先探测再决策；服务端必须先跑这条）
ffprobe -v error -show_entries format=format_name,duration,size,bit_rate -show_entries stream=codec_name,sample_rate,channels -of json in.ext
# 附：响度标准化（可选，音量忽大忽小场景）
ffmpeg -y -i in.ext -vn -af loudnorm=I=-16:TP=-1.5:LRA=11 -c:a libmp3lame -b:a 192k out.mp3
```

| 预设名 | 格式 | 码率 | 采样率 | 声道 | 适用场景 | 体积参考 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 标准 MP3 | mp3 | 192k CBR | 44.1k | 2 | 默认/转发 | 1.4MB/分钟 |
| 省流 MP3 | mp3 | 128k CBR | 44.1k | 2 | 语音/会议 | 0.95MB/分钟 |
| 高保真 MP3 | mp3 | 320k CBR | 44.1k | 2 | 音乐 | 2.4MB/分钟 |
| 移动端通用 | m4a | 192k AAC | 44.1k | 2 | iOS 分享 | 1.4MB/分钟 |
| 无损 WAV | wav | PCM 16bit | 44.1k | 2 | 后期制作 | 10.1MB/分钟 |
| 无损 FLAC | flac | 无损 | 同源 | 同源 | 收藏（iOS 不可试听） | ≈5MB/分钟 |
| 语音最小 | ogg | 64k Opus | 48k | 1 | 语音笔记 | 0.48MB/分钟 |
| 兼容语音 | amr | 12.2k | 8k | 1 | 老旧设备（iOS 不可试听） | 0.09MB/分钟 |

（体积为**按码率估算的参考值**，非实测；精确值以 ffprobe 为准。）

---
## 6. 合规与审核
### 6.1 服务类目候选（以最新类目表为准）
| 候选类目 | 资质要求 | 适用范围（原文要点） | 是否推荐 | 来源 |
| :--- | :--- | :--- | :--- | :--- |
| **工具 > 图片处理** | **无** | 「提供图片/音频/视频的本地制作、剪辑等服务，**相关内容不适用于传播分享、公开访问**」 | ✅ **推荐** | https://developers.weixin.qq.com/miniprogram/product/material/ |
| 工具 > 办公 | 无 | 办公工具 | ⚠️ 次选（描述不够贴切） | 同上 |
| 文娱 > 音乐 | 需《网络文化经营许可证》/《信息网络传播视听节目许可证》等 | 音乐娱乐产品制作、传播 | ❌ 不可行（个人拿不到） | https://developers.weixin.qq.com/miniprogram/product/material/wenyu/yinyue.html |

> 注意类目备注的合规边界：`工具>图片处理` **不允许传播分享/公开访问**。因此：小程序内**不得做公开分享链接/曲库/社区**；「转发给好友」是用户对**自己文件**的操作，属于本地工具行为，风险可控但要避免任何「一键分享到公开频道」的设计。
> 另注：上表备注文字来自**非个人主体**类目表；**个人主体**的「工具>图片处理」描述为「图片/音频/视频制作、剪辑服务」，无该备注，但个人主体无法新增社交类目，传播边界结论不变；提审材料引用时需注明主体类型与日期。
### 6.2 小程序备案与主体
| 项目 | 结论 | 来源 | 置信度 |
| :--- | :--- | :--- | :--- |
| 是否必须 | **必须**（未备案不得从事互联网信息服务；备案是发布前置） | https://developers.weixin.qq.com/miniprogram/product/record/record_guidelines.html | 高 |
| 个人主体 | 可备案（备案类型「新增备案」主体含个人、单位） | 同上 | 高 |
| 个人备案数量上限 | **5 个**小程序（个体工商户 5 个；企业/政府/媒体/其他组织 50 个） | https://developers.weixin.qq.com/miniprogram/product/record/record_faq.html | 高 |
| 所需材料 | 主体证件、主体负责人证件、小程序负责人证件、承诺书、负责人现场核验照片等；涉及前置审批类目另需批文 | record_guidelines.html | 高 |
| 个人主体额外限制 | **不支持 web-view**（业务域名不开放给个人账号） | https://developers.weixin.qq.com/miniprogram/dev/framework/ability/domain.html | 高 |
### 6.3 音频内容安全检测
| 项目 | 结论 | 来源 | 置信度 |
| :--- | :--- | :--- | :--- |
| 接口 | `mediaCheckAsync`（异步校验图片/音频是否违法违规） | https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_mediacheckasync.html （编辑 2026-07-04） | 高 |
| `media_type` | **1=音频，2=图片** | 同上 | 高 |
| 支持音频格式 | **mp3, aac, ac3, wma, flac, vorbis, opus, wav**（**不含 amr / ape**） | 同上 | 高 |
| 单文件大小 | **≤10MB** | 同上 | 高 |
| 频率限制 | 单 appId **2000 次/分钟、200,000 次/天** | 同上 | 高 |
| 权限集 id | 18（第三方平台代调用权限集；自研小程序不涉及） | 同上 | 高 |
| 接入要求 | 音频在创建任务时送检（可与转码并行，异步回填结果）；`suggest=risky` 时删除产物并**阻断导出/转发**；异步结果需回调落库；保留检测记录 | 同上（结合运营规范） | 高 |

> 工程影响：**>10MB 的音频不能直接送检** → 建议按时长自适应降码率（30min 用 32kbps 单声道 ≈7.2MB），仍超限则截取片段送检（抽检，需在协议中说明）；amr/ape 必须先转 mp3 再送检。
### 6.4 隐私保护指引必须声明项
必须声明的「处理的信息 ↔ 触发接口」（官方对照表，来源 https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/miniprogram-intro.html ，置信度 高）：

| 处理的信息 | 触发接口/组件 | 本项目是否涉及 |
| :--- | :--- | :--- |
| **收集你选中的文件** | `wx.chooseMessageFile` | ✅ 必填 |
| **访问你的麦克风** | `wx.authorize({scope:'scope.record'})`、`RecorderManager.start` | ✅ 若提供录音入口（否则不填） |
| 收集你选中的照片或视频信息 | `wx.chooseMedia` 等 | ❌ 不涉及 |
| 其他（位置/通讯录/手机号…） | — | ❌ 不涉及 |

- 隐私指引填写入口：小程序后台「账号设置-服务内容声明-用户隐私保护指引」；提审时会校验**隐私接口调用与声明是否一致**（来源 https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/ ，编辑 2026-07-28，置信度 高）。
- 必须补充的文案要点：①音频仅用于**格式转换**，转码在腾讯云完成（受托处理方）；②服务端临时文件保留期限（建议 24 小时）；③不用于训练/不对外公开；④用户可删除历史记录。
- 若收集「文件」信息，需在小程序内提供**隐私弹窗 + 隐私协议入口**（官方要求处理个人信息需告知同意）。
### 6.5 版权风险
- 用户转码的音乐可能是盗版/未授权内容：小程序本身不存储曲库、不提供检索/公开播放，仅**用户自有文件的格式转换**，属工具行为；但必须在用户协议声明「用户须保证对文件拥有合法权利，侵权责任自负」。
- 禁止：内置示例音乐（除非已授权）、公开榜单、分享墙、任何形式的「在线听歌」功能；不要提供「去除版权水印/DRM 解密」类能力。
- 需提供**侵权投诉入口**（邮箱/客服），并在收到通知后删除相关文件（云存储可删除）。
### 6.6 流量主 / 虚拟支付（变现）
| 项目 | 结论 | 来源 | 置信度 |
| :--- | :--- | :--- | :--- |
| 虚拟支付主体 | 仅**企业、个体户**；个人主体不可开通 | https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html | 高 |
| iOS 虚拟支付 | 需走 **Apple 支付**（iOS 15+、微信 8.0.68+，需单独开通条件） | 同上 | 高 |
| 广告（流量主） | 可用 `ad` 组件（Banner/激励视频等）；需先开通「流量主」 | https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/ad/banner-ad.html （2026-07-23） | 高 |
| 个人主体能否接广告 | 二手信息普遍认为可开通（需满足 UV 门槛，具体门槛**本次未核验到**） | — | **待核实** |
| 广告合规 | 不得以广告中断核心转换流程；不得诱导点击；激励视频换取「额度」需注意虚拟支付边界 | 运营规范 https://developers.weixin.qq.com/miniprogram/product/ | 中 |

---
## 7. 结论建议
### 7.1 推荐架构（MVP）
```
小程序端                          微信云托管（独立控制台，env 独立）
┌──────────────┐  1. uploadFile     ┌────────────────────────────┐
│ chooseMessageFile │ ────────────▶ │ 对象存储（云托管 COS）       │
│ 本地试听(InnerAudio)│              │   ↓ fileID                  │
│ 参数选择/进度/历史 │  2. callContainer │ Node HTTP 服务(Express)    │
│ 结果试听/转发     │ ◀──────────── │   ffprobe → ffmpeg → 回传   │
└──────────────┘  3. 返回 fileID/临时URL └────────────────────────┘
                                  4. 定时清理（>24h 文件）
```

> 上传路径说明（评审修订）：客户端无法获知 openid，文件路径改为 `in/{ticketId}.{ext}`；`POST /v1/upload-tickets` 由服务端绑定 openid 后下发路径，`POST /v1/tasks` 再校验归属。详见 TASK_PLAN ADR-013。

- 小程序端：`wx.cloud.init` 仅初始化 SDK（env 可空）；云托管环境 ID 通过 `wx.cloud.uploadFile`/`callContainer` 的 `config.env` 传入。先 `POST /v1/upload-tickets` 拿 `cloudPath`（绑定 openid），再直传，再 `callContainer` 建任务/轮询（基础库 ≥2.23.0，后台设最低基础库）。
- 云托管容器：Debian slim + `apt-get install ffmpeg`（或自编译含 `libopencore-amrnb`），暴露 `POST /convert`，内部 `ffprobe` 校验 → 白名单格式 → 执行转码 → 上传结果 → 返回 fileID。
- 安全：上传票据绑定 openid、任务 openid 必须等于 `X-WX-OPENID`、fileID 必须等于票据路径（防 IDOR）；参数白名单（format/bitrate/samplerate/channels）**不拼接 shell**，用 `execFile` 数组传参防命令注入；单请求限 50MB。
- 费用护栏：最小实例设 0 或 1（0.25 核 0.5G ≈0.71 元/天）；免费额度 3 个月内够跑通 MVP；对象存储 5GB 免费额度 ≈ 100 首 50MB 文件（注意留存清理）。
### 7.2 MVP 边界（建议值）
| 项 | 建议值 | 依据 |
| :--- | :--- | :--- |
| 单文件大小 | **≤50MB**（提示语置于选择后） | 60s 超时 + 内存 + 上传耗时（待实测校准） |
| 时长 | **≤30 分钟** | 同上；且 >10MB 需分段送内容安全 |
| 转码模型 | **异步任务**：入队 + 客户端轮询（原同步方案已废弃，见 TASK_PLAN ADR-003） | `callContainer` 15s 上限；云托管请求 60s（待实测） |
| 批量/长任务 | 二期：批量、>30min（队列 + 任务表 + 幂等 + 补偿） | 需独立队列/存储 |
| 输入格式 | mp3/wav/m4a/aac/flac/ogg/amr/ape/wma/aiff（探测失败友好报错） | §5.1 |
| 输出格式 | mp3（默认）、m4a、wav；flac/ogg 仅 Android 可试听需提示 | §2.3 |
| 历史记录 | 本地 storage 存元信息（24h 过期）；云端文件 24h 清理 | 控成本 + 合规 |
| 并发/限流 | 单用户 1 并发、每日 5 次；按 openid 限流 | 防刷 + 控成本 |
### 7.3 上线前必须完成的合规动作（checklist）
- [ ] 类目提交：**工具 > 图片处理**（备好说明：本地音频格式转换、不提供传播/公开访问）。
- [ ] **小程序备案**（个人可；材料齐全后提交管局；备案通过才可发布）。
- [ ] 隐私保护指引：声明「收集你选中的文件」（+录音则「访问你的麦克风」）、受托处理方（腾讯云）、保留期、删除方式；小程序内隐私弹窗。
- [ ] 用户协议/侵权投诉入口（邮箱 + 删除机制）。
- [ ] 内容安全：接入 `mediaCheckAsync`（音频 ≤10MB；amr/ape 先转 mp3），命中 risky 拒绝并留痕。
- [ ] 后台设置最低基础库 ≥2.23.0（callContainer 依赖）。
- [ ] 不出现「曲库/公开分享/在线播放」类功能与文案。
- [ ] 广告（如启用）：先开通流量主，Banner 不遮挡转码主流程。
- [ ] 付费：个人主体**不做**虚拟支付；如需变现先升级为企业/个体户主体。
### 7.4 本机可先做的验证项（Docker 28.3，无本地 Node/FFmpeg）
1. **验证 ffmpeg 能力矩阵**（决定基础镜像）：`docker run --rm linuxserver/ffmpeg -hide_banner -codecs | grep -Ei "amr|ape|wmav|flac|mp3lame|aac|opus"`，确认 ape/wma 解码、amr 编码是否齐全。
2. **跑通 §5.4 八条命令**：构造 mp3/flac/amr/ape/wma 样本，逐个转 mp3/m4a/wav，记录成功率与 ffprobe 输出。
3. **测性能与内存**：`docker run --rm -v $PWD:/w linuxserver/ffmpeg -i /w/in.flac ...` + `/usr/bin/time -v`，得到「10 分钟音频转 192k MP3 的耗时/峰值内存」，用于校准 50MB/30 分钟上限（本机 CPU 不代表云托管，需 ×系数）。
4. **构建云托管目标镜像**：写 `Dockerfile`（node:20-slim + apt ffmpeg）→ `docker build` → `docker images` 记录体积；如果 >500MB，考虑多阶段构建/裁剪（镜像上限待核实，先控小）。
5. **本地冒烟服务**：容器内起 Express，`/convert` 接收 multipart → 转码 → 返回；用 curl 压测 10 并发、60s 超时行为。
6. **前端联调阻塞项**：云托管环境创建（需小程序管理员在 cloud.weixin.qq.com 开通，**本次无法代替完成**）；先用本地 HTTP mock `callContainer` 返回结构。

---
## 附录 A｜核实清单
| # | 事实 | 来源 URL | 日期 | 置信度 |
| :--- | :--- | :--- | :--- | :--- |
| S1 | 分包总量 ≤30MB（服务商 20MB），单包 ≤2MB | https://developers.weixin.qq.com/miniprogram/dev/framework/subpackages.html | 2026-10-27（编辑 2026-07-28） | 高 |
| S2 | WXWebAssembly：2.13.0 全局/2.15.0 Worker；只接受代码包内路径；支持 .wasm.br；插件 2.18.1；SIMD 微信 8.0.25 | https://developers.weixin.qq.com/miniprogram/dev/framework/performance/wasm.html | 2026-10-27（2026-06-16） | 高 |
| S3 | 代码包文件运行后不可修改；临时文件 4GB/2GB/6GB；缓存+用户文件 200MB | https://developers.weixin.qq.com/miniprogram/dev/framework/ability/file-system.html | 2026-10-27（2026-07-23） | 高 |
| S4 | chooseMessageFile：2.5.0+，count 0~100，type 四值，extension 仅 file（2.6.0+） | https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.chooseMessageFile.html | 2026-10-27 | 高 |
| S5 | InnerAudioContext 格式矩阵（iOS 不支持 flac/ogg/amr/ape/wma） | https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/InnerAudioContext.html | 2026-10-27 | 高 |
| S6 | RecorderManager：aac 默认，mp3/aac/wav/PCM，最长 10 分钟 | https://developers.weixin.qq.com/miniprogram/dev/api/media/recorder/RecorderManager.start.html | 2026-10-27 | 高 |
| S7 | createWebAudioContext 2.19.0+，decodeAudioData | https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/wx.createWebAudioContext.html | 2026-10-27 | 高 |
| S8 | shareFileMessage 2.16.1+，仅点击行为，本地/临时路径 | https://developers.weixin.qq.com/miniprogram/dev/api/share/wx.shareFileMessage.html | 2026-10-27 | 高 |
| S9 | saveFileToDisk 仅 PC；openDocument 不支持音频 | https://developers.weixin.qq.com/miniprogram/dev/api/file/wx.saveFileToDisk.html ；…/wx.openDocument.html | 2026-10-27 | 高 |
| S10 | downloadFile 单次 ≤200MB，默认超时 60s | https://developers.weixin.qq.com/miniprogram/dev/api/network/download/wx.downloadFile.html | 2026-10-27 | 高 |
| S11 | 服务器域名：https、ICP 备案、不可 IP/localhost、子域名、端口严格；默认超时 60s；并发 10 | https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html | 2026-10-27（2026-08-21） | 高 |
| S12 | 个人类型小程序不支持 web-view；业务域名需备案 | https://developers.weixin.qq.com/miniprogram/dev/framework/ability/domain.html | 2026-10-27（2026-07-23） | 高 |
| S13 | 云托管支持 Docker/自定义镜像/Git/CLI；镜像仓库每服务 100 个镜像 | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/basic/overview.html ；…/src/guide/service/image.html | 2026-10-27（2026-08-24） | 高 |
| S14 | 云托管请求超时 60s、请求包体 20MB、15 服务/环境、28 实例/环境 | https://docs.cloudbase.net/run/limitation | 2026-10-27 | 中（微信端待实测） |
| S15 | 云托管实例规格 0.25核0.5G ~ 16核32G，CPU:内存=1:2；公网开关/callContainer 私有链路 | https://docs.cloudbase.net/run/deploy/service-setting | 2026-10-27 | 高（同上底座） |
| S16 | 云托管缩容至 0、20s 扩容、最小 0.25 核 0.5G | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/basic/intro.html | 2026-10-27（2026-08-24） | 高 |
| S17 | 云托管计费单价与 3 个月免费额度；callContainer 不产生公网流量 | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/Billing/price.html | 2026-10-27（2026-08-24） | 高 |
| S18 | 个人可用云托管（面向全用户），但必须先有小程序/公众号；云开发中的云托管已停更 | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/info/faq.html | 2026-10-27（2026-08-24） | 高 |
| S19 | callContainer 需基础库 ≥2.23.0、免服务器域名、自动带 openid | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/development/call/mini.html | 2026-10-27（2026-08-24） | 高 |
| S20 | 云函数 Linux（CentOS 7.2 系）、`/tmp` 512MB、无状态、自动扩缩 | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/functions/mechanism.html | 2026-10-27（2026-08-24） | 高 |
| S21 | 云存储临时链接有效期 2 小时 | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/storage/api.html | 2026-10-27（2026-08-24） | 高 |
| S22 | 类目「工具>图片处理」覆盖音频本地制作/剪辑，无资质、不得传播分享 | https://developers.weixin.qq.com/miniprogram/product/material/ | 2026-10-27 | 高 |
| S23 | 「文娱>音乐」需网络文化经营许可证/信息网络传播视听节目许可证 | https://developers.weixin.qq.com/miniprogram/product/material/wenyu/yinyue.html | 2026-10-27（2026-01-25） | 高 |
| S24 | 小程序备案强制；个人主体可备案，个人上限 5 个 | https://developers.weixin.qq.com/miniprogram/product/record/record_guidelines.html ；…/record_faq.html | 2026-10-27 | 高 |
| S25 | mediaCheckAsync：音频 1/图片 2；支持 mp3/aac/ac3/wma/flac/vorbis/opus/wav；≤10MB；2000 次/分 | https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_mediacheckasync.html | 2026-10-27（2026-07-04） | 高 |
| S26 | 隐私指引：chooseMessageFile→「收集你选中的文件」；RecorderManager→「访问你的麦克风」 | https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/miniprogram-intro.html | 2026-10-27（2026-07-28） | 高 |
| S27 | 虚拟支付仅企业/个体户；iOS 走 Apple 支付 | https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html | 2026-10-27 | 高 |
| S28 | 广告组件可用；流量主需先开通 | https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/ad/banner-ad.html | 2026-10-27（2026-07-23） | 高 |
| S29 | FFmpeg 法律/专利说明 | https://ffmpeg.org/legal.html | 2026-10-27 | 中（非微信来源） |
| S30 | 项目基础库 3.17.5（满足 callContainer ≥2.23.0 要求） | 工程文件 project.private.config.json | 2026-10-27 | 高 |
## 附录 B｜风险与待实测项
| # | 风险/待实测 | 影响 | 建议动作 |
| :--- | :--- | :--- | :--- |
| R1 | **小程序不能读手机本地文件**，用户必须绕行「发到微信会话」 | 转化率最大杀手 | 首页引导「把音频发给文件传输助手→回来选择」；一键复制提示 |
| R2 | 云托管镜像大小上限官方未载明 | 可能构建失败/推送超时 | 构建前用 Docker 测体积；优先 slim 基础镜像 + apt ffmpeg；构建 >10 分钟需优化 |
| R3 | 云托管冷启动时长未实测（缩容 0 后首个请求） | 首单体验差、可能叠加 60s 超时 | 先设最小实例 1（≈0.71 元/天）；压测冷启动 |
| R4 | 「请求 60s / 包体 20MB」来自腾讯云 CloudBase 文档，微信端数值未实测 | 大文件超时/413 | 上线前用 callContainer 实测 50MB 请求与长音频耗时 |
| R5 | `wx.cloud.uploadFile` 单文件上限未核实 | 50MB 上限可能不成立 | 实测 20/50/100MB 上传；必要时改直传 COS 临时密钥方案 |
| R6 | iOS/Android 对产物与「转发后播放」的支持差异未真机验证 | 用户投诉「转了不能听」 | 真机矩阵测试（iOS/Android × mp3/m4a/wav/flac/amr） |
| R7 | 云函数 Node 版本/超时/代码包上限未核验；无 layer 机制 | 影响「云函数兜底」方案 | 若采用，先在控制台查实际配额；ffmpeg 静态二进制体积实测 |
| R8 | 云存储无官方 TTL，需自建清理 | 存储费用上涨、隐私风险 | 定时触发器云函数每日清理 >24h 文件；对象存储生命周期规则（若可用） |
| R9 | 内容安全 10MB 限制与 amr/ape 不支持 | 大文件无法送检、漏检风险 | 送检前降码率转 mp3（≤10MB）或抽帧；留存检测日志 |
| R10 | 类目「工具>图片处理」注明不得传播分享，与「转发给好友」边界需审核实测 | 审核被拒/下架 | 提审版本不出现公开分享/曲库入口；文案强调「用户自有文件」 |
| R11 | MP3/AAC 专利与 FFmpeg GPL/LGPL 合规 | 法务风险 | 选 LGPL 构建；关于页声明；必要时法务评估 |
| R12 | 流量主开通门槛（个人主体）未核验 | 变现路径不确定 | 上线前在 MP 后台查「流量主」入口实际条件 |
| R13 | 插件市场是否存在可用 ffmpeg/音频转码插件（检索通道受限） | 影响「端内备选」判断 | 人工在微信插件市场检索；即使存在也受 2MB/30MB 限制 |
| R14 | 云托管环境需管理员在 cloud.weixin.qq.com 开通，本机/子代理无法完成 | 阻塞联调 | 由 Lead 协调账号方开通并给出环境 ID |
