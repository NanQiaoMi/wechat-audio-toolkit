# 下一轮功能更新计划（v5.1）· 音频工具箱小程序

| 项目 | 内容 |
| :--- | :--- |
| 文档版本 | v1.0（2026-10-31） |
| 代码基线 | `v5.0` 现状快照，Git 基线 `d55310f`（`main`），实施分支 `feature/v5.1-audio-capture-library` |
| 适用范围 | `miniprogram/` 客户端全部页面 + 本地存储；**不涉及云函数改动**（本轮零部署风险） |
| 文档状态 | **计划已定稿 + v5.1 客户端实现已落地**（2026-10-31，见 §9.5 实施记录；独立验证与真机签收待完成） |
| 关联文档 | [DEV_LOG](./DEV_LOG.md)（最新实现记录，尾部 v5.0）、[PRD](./PRD.md)、[TASK_PLAN](./TASK_PLAN.md)、[MUSIC_EDITOR_DESIGN](./MUSIC_EDITOR_DESIGN.md)、[FEASIBILITY](./FEASIBILITY.md)、侦察报告 [recon-convert](./planning/recon-convert.md) / [recon-editor](./planning/recon-editor.md) / [baseline-verification](./planning/baseline-verification.md) |

---

## 0. 摘要（先读）

**一句话结论**：转换与剪辑两条主链路在 v5.0 已可用，但产品缺一个完整闭环——**「只进不出」**：用户只能从微信聊天导入，处理完的结果散落在两个页面、24h 后过期且没有沉淀；声音采集端（录音）完全缺失，自传播（分享卡片）为零。下一轮建议补齐 **「采集 → 处理 → 沉淀 → 分享」** 闭环，作为 **v5.1**。

### 0.1 本轮推荐范围（v5.1）

| 优先级 | 功能 | 一句话 | 类型 |
| :---: | :--- | :--- | :--- |
| **P0** | FR-30 录音导入 | 新增「现场录音」页：录音 → 试听 → 去转换 / 去剪辑 | 新功能 + 新页面 |
| **P0** | FR-31 作品库 | 新增「我的作品」页：转换与剪辑产物统一沉淀、可分享/删除/过期提示 | 新功能 + 新页面 |
| **P0** | FR-32 分享卡片 | 各页 `onShareAppMessage` + 设置页转发入口，让工具可被分享 | 传播功能 |
| **P1** | FR-33 设置页升级 + 全局文案清理 | 版本号、额度残留文案、反馈入口、作品库/录音入口 | 界面优化 |
| **P1** | FR-34 入口与导航整理 | 首页三入口快捷区、编辑器空态补「现场录音」、全局标题「音频工具箱」 | 界面优化 |

### 0.2 为什么是这三件事（P0 判定依据）

1. **录音是规划了 3 天却一直没做的 P1**（[TASK_PLAN F-02](./TASK_PLAN.md)、[FEASIBILITY §2.2/§6.4](./FEASIBILITY.md) 已核实能力与隐私要求），而小程序是唯一能直接录音再处理的合规入口——补齐后用户不再必须先把音频发到微信会话。
2. **产物没有家**：转换历史只存本地弹层（`index.js` `audio_convert_history`，20 条、无封面无分类），剪辑导出结果根本不持久化（`editor.js` 只在内存中展示）。24h 云端过期后用户无从找回，也没有任何「我做过什么」的记忆点。
3. **分享缺失是增长硬伤**：全项目没有 `onShareAppMessage`/`onShareTimeline`（已全仓检索确认），用户无法把有用的工具转发给朋友；同时这是最低成本、零后端改动的传播增强。
4. **三者互相咬合**：录音是新的输入源（→ 去转换/去剪辑），作品库是统一出口（← 转换/剪辑），分享是出口的放大器；设置页负责把入口与说明补齐。一个版本即可形成完整体验闭环。

### 0.3 明确不在本轮范围

- ❌ 云函数任何改动（不重命名 `ffmpegProbe`、不加 action、不改渲染参数）——本机无 DevTools 服务端口/无法部署真机验证，云侧变更留到 v5.2。
- ❌ 编辑器主页面大幅改动（只加 1 个「现场录音」入口，不动 4700 行主体逻辑）。
- ❌ 批量转换 / 铃声模板 / BGM 素材库 / 多格式导出 / 两段式任务化（进入 v5.2–v5.3 路线图）。
- ❌ 朋友圈分享（`onShareTimeline`）——类目「工具 > 图片处理」注明**不得传播分享/公开访问**，只做好友/群卡片分享，规避审核风险。
- ❌ 内容安全、额度、上传票据、备案等合规项（维持现状，见 §8 风险）。

### 0.4 交付物清单

1. 本计划文档（`docs/NEXT_UPDATE_PLAN.md`）。
2. 客户端代码：新增 `pages/record/`、`pages/library/`、`utils/library-store.js`（纯函数可测）；修改 `pages/index/*`、`pages/editor/*`（仅入口/入库/分享）、`pages/settings/*`、`app.json`、`app.wxss`。
3. 自动化测试：`scripts/page-smoke/record-library-test.js`（Node 无 DevTools 可跑）+ 既有 `frontend-test.js`/`test_pure.js` 回归全绿。
4. 文档同步：README、docs/README 索引、DEV_LOG 追加 v5.1 条目。
5. 本地 Git 提交：`feature/v5.1-audio-capture-library` → `main`（`--no-ff`）；每个功能一个可回滚提交。

---

## 1. 现状盘点

### 1.1 功能地图（代码实测，2026-10-31）

| 模块 | 页面/文件 | 已实现 | 缺口 |
| :--- | :--- | :--- | :--- |
| 格式转换 | `pages/index`（933 js / 525 wxml / 1637 wxss） | 会话文件单选导入、格式 6 选（mp3/wav/m4a/aac/flac/ogg）、码率 6 档 + 滑块 + 体积预估、采样率/声道高级参数、上传→云端转码、结果试听（本地热切）、转发文件、PC 保存、复制外链、历史弹层（本地 20 条）、隐私授权弹窗 | 导入渠道单一（无录音/批量）；结果无沉淀（弹层、24h 过期）；无分享卡片；额度文案残留（`quotaUsed / 5` 与 `QUOTA_ENFORCED=false` 不一致） |
| 音乐剪辑 | `pages/editor`（4731 js / 1452 wxml / 4256 wxss） | 多源导入 ≤5、动态 1–6 轨、真实波形/缩放/捏合、剃刀、拖动/把手修剪、磁吸、分割/复制/粘贴/撤销、每片淡变、变速、EQ、降噪、增益、ducking、静音/独奏、多轨真混音预览、mp3 导出（64–320k）、草稿自动保存/恢复、防误退 | 导出仅 mp3（硬编码 `format:'mp3'`）；导出结果不持久化；无录音入口；无模板/BGM；单文件 4700 行维护成本高 |
| 设置 | `pages/settings`（69 js / 25 wxml） | 服务说明、协议/隐私/投诉、清空历史/缓存 | 版本号仍是 `0.1.0`；无反馈入口；无作品库/录音入口；无分享入口 |
| 云端 | `cloudfunctions/ffmpegProbe` | `convertFile`、`analyzeAudio`、`renderEdit`(v1/v2)、`cleanup`、`probe`；静态 FFmpeg 7.0.2；timeout 60s；`QUOTA_ENFORCED=false`、`MEDIA_CHECK_ENABLED=false`（测试期） | 上传票据/归属校验、两段式任务、内容安全、正式命名（历史设计已规划，未实现） |

### 1.2 工程现状

| 项 | 现状 |
| :--- | :--- |
| 技术栈 | 微信原生小程序 + 云开发（环境 `cloud1-d0g1pwjogd2f39be2`）+ 云函数内静态 FFmpeg 7.0.2 |
| 页面规模 | 3 页；`miniprogram` 目录 528KB；无 npm 依赖、无构建步骤 |
| 自动化测试 | `scripts/editor-spike/frontend-test.js` **41 项**（页面级 + 纯函数）、`test_pure.js` **150 项**（云函数纯函数）、`test_integration.js`/`test_actions_mock.js`（需 Docker） |
| 本机环境 | 系统 PATH 无 node；可用 DSH 内置 Node v24 + Docker 28.3；微信开发者工具已安装但**服务端口 44120 未监听**（IDE 未运行），本机无法执行 `cli preview`/云函数部署 |
| 版本管理 | 本轮首次 `git init`：基线 `d55310f`（`main`），已忽略 76MB 静态 FFmpeg 与本地私有配置 |

### 1.3 文档与实现偏差（需要在收尾时对齐）

| 文档 | 偏差 |
| :--- | :--- |
| `README.md` | 仍描述 v1.0「待办：备案/类目/真机」与双 tab 入口；实际已无 tabBar、首页入口卡进入编辑器，编辑器功能已远超 v2 |
| `docs/README.md` | 索引最后更新 2026-10-28，未收录 v1.9–v5.0 的 UI/交互迭代 |
| `docs/PRD.md` / `TASK_PLAN.md` | 基于 v1.0/v1.1 规划，未反映多轨、降噪、EQ、导出码率、草稿等已实现能力 |
| `docs/DEV_LOG.md` | **最新最准**（尾部 v5.0），但缺少 v5.1 计划条目；工作记录按行追加，无小节结构 |
| `docs/REFERO_DESIGN.md` | 视觉参考稿（warm paper / marker orange），已被实际 UI 采纳为色彩基线；文件尾部残留抓取 HTML（`$RS(...)`），不影响阅读 |

### 1.4 已识别问题/技术债（本轮相关）

| ID | 问题 | 影响 | 处置 |
| :--- | :--- | :--- | :--- |
| GAP-01 | 导入仅 `chooseMessageFile` 单文件 | 采集场景缺失；用户必须先发微信会话 | v5.1 录音导入 |
| GAP-02 | 转换历史为本地弹层，剪辑结果不落盘 | 结果不可找回、无沉淀 | v5.1 作品库 |
| GAP-03 | 无分享卡片，设置页无分享入口 | 工具无法自传播 | v5.1 分享卡片 |
| GAP-04 | 额度文案残留（页脚 `今日免费额度 X/5`、设置页 `当前次数`） | 前后端行为矛盾，易误导 | v5.1 文案清理 |
| GAP-05 | 设置页版本 `0.1.0`、无反馈渠道 | 用户无法反馈 | v5.1 设置升级 |
| GAP-06 | 编辑器导出仅 mp3 | 用户想导出无损/WAV 时无解 | v5.2 多格式导出 |
| GAP-07 | 无批量转换 | 一次只能转一首 | v5.2 批量 |
| GAP-08 | 无铃声模板 | 高频场景（微信铃声 40s）要多步手工 | v5.2 模板 |
| GAP-09 | 云端同步 + 两段式导出未做 | 长成片 60s 超时风险 | v5.3 |
| GAP-10 | 隐私指引未补「麦克风」声明 | 录音入口上线后会被隐私校验拦截 | v5.1 上线前置（后台配置） |

---

## 2. 用户视角的差距与机会

### 2.1 关键旅程缺口

| 旅程 | 现状 | 目标（v5.1 后） |
| :--- | :--- | :--- |
| 想转格式 | 先把音频发到微信会话 → 选文件 → 改格式 | 也可**直接录一段** → 选格式 |
| 想剪音频 | 发微信会话 → 进剪辑页 → 选文件 | 也可**录完直接进剪辑** |
| 想知道做过什么 | 转换：历史弹层；剪辑：无 | 统一**作品库**，按时间/类型浏览 |
| 想分享给朋友 | 只能转发音频文件 | 转发音频文件 + **分享小程序卡片** |
| 想反馈问题 | 无入口 | 设置页反馈入口（邮件/客服兜底） |

### 2.2 平台约束（设计必须遵守）

1. **小程序不能读手机本地文件**：输入只能是「会话文件」「录音」（[FEASIBILITY §2.1](./FEASIBILITY.md)）。
2. **录音需隐私声明**：`wx.authorize(scope.record)` / `RecorderManager.start` 需后台隐私指引声明「访问你的麦克风」；未配置会被平台拦截（[FEASIBILITY §6.4](./FEASIBILITY.md)）。
3. **录音上限 10 分钟**：`duration` 最大 `600000ms`；默认 60s，必须显式设置（[FEASIBILITY §2.2](./FEASIBILITY.md)）。
4. **iOS 播放限制**：录音产物选 `mp3` 保证双端可试听；不要用默认 aac 作为唯一格式（虽双端可播，但 mp3 兼容面更广、命名直观）。
5. **转发文件只能点击触发**：`wx.shareFileMessage` 必须在用户手势内调用；下载/准备需「首次点击准备、再次点击转发」（现有转换页已按此实现，作品库复用同一模式）。
6. **类目合规**：不做公开分享/曲库/在线播放；分享卡片只做**工具分享**（好友/群），不做朋友圈。

---

## 3. 候选功能池与评估

### 3.1 评估口径

- **价值**：用户价值（1–5，5 最高）。
- **工作量**：S（≤0.5 人日）/ M（1 人日）/ L（2–3 人日）/ XL（>3 人日）。
- **风险**：低/中/高（含审核、平台限制、回归风险、真机验证难度）。
- **切片**：是否适合进入 v5.1 本轮落地。

### 3.2 候选清单（14 项）

| ID | 候选 | 类别 | 价值 | 工作量 | 风险 | 依赖 | 结论 |
| :--- | :--- | :--- | :---: | :---: | :--- | :--- | :--- |
| C-01 | 录音导入（录音→转换/剪辑） | 新功能 | 5 | M | 中（隐私/权限/真机） | 隐私指引麦克风声明 | ✅ **v5.1 P0** |
| C-02 | 作品库（转换+剪辑统一沉淀） | 新页面 | 5 | M | 中（存储迁移/分享手势） | 无 | ✅ **v5.1 P0** |
| C-03 | 分享卡片（onShareAppMessage + 入口） | 传播 | 4 | S | 低 | 无 | ✅ **v5.1 P0** |
| C-04 | 设置页升级 + 文案/版本清理 | 界面优化 | 3 | S | 低 | 无 | ✅ **v5.1 P1** |
| C-05 | 首页三入口快捷区 + 全局标题 | 界面优化 | 3 | S | 低 | C-01/C-02 | ✅ **v5.1 P1** |
| C-06 | 编辑器多格式导出（mp3/wav/m4a） | 现有功能优化 | 4 | M | 中（云函数+编码器+限额） | 云函数部署/真机 | ⏭ v5.2 P0 |
| C-07 | 批量转换（多文件队列） | 新功能 | 4 | L | 中（状态机/成本/并发） | 无 | ⏭ v5.2 P1 |
| C-08 | 铃声/模板工坊（≤40s 一键出片） | 新功能 | 4 | L | 中（产品规则/音质） | 云渲染 | ⏭ v5.3 |
| C-09 | 编辑器页面拆分/组件化 | 技术优化 | 2 | L | 高（回归面大） | 测试覆盖 | ⏭ v5.2 P1（先抽组件） |
| C-10 | 导出两段式任务化（create/run/get） | 技术优化 | 4 | L | 高（云 DB/幂等/真机） | 云环境 + 真实耗时数据 | ⏭ v5.3（先记录 timings） |
| C-11 | BGM 素材库/智能配乐 | 新功能 | 4 | XL | 高（版权/素材） | 素材授权 | ⏭ v5.3 |
| C-12 | 云端作品同步（跨设备） | 新功能 | 3 | L | 中（账号/openid） | 云 DB | ⏭ v5.3 |
| C-13 | 变速变调/音效锦上添花（回声、混响、变声） | 新功能 | 3 | M | 中（云渲染） | 云函数 | ⏭ v5.3 |
| C-14 | 数据埋点/转化漏斗 | 技术优化 | 2 | M | 低 | 无 | ⏭ 随版本 |

> 说明：C-06 是「用户最可能追问」的缺口（现在只能导 mp3），但云函数需重新部署且本机无法验证真机，放到 v5.2 与铃声模板一起做更划算；v5.1 先把「采集—沉淀—分享」闭环做扎实。

### 3.3 评分（简化 RICE：价值×可达性 ÷ 成本）

| 候选 | Reach★ | Impact★ | Confidence | Effort | 得分 | 排名 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| C-02 作品库 | 5 | 5 | 0.9 | 1.0 | 22.5 | 1 |
| C-03 分享卡片 | 5 | 4 | 0.95 | 0.5 | 38.0 | 2 |
| C-01 录音导入 | 4 | 5 | 0.8 | 1.0 | 16.0 | 3 |
| C-05 首页入口 | 5 | 3 | 0.95 | 0.5 | 28.5 | 4 |
| C-04 设置升级 | 3 | 3 | 0.95 | 0.5 | 17.1 | 5 |
| C-06 多格式导出 | 3 | 4 | 0.7 | 1.0 | 8.4 | 6 |

> Reach/Impact 采用产品经验值，仅用于本轮排序说明；不作为长期量化指标。详细论证见 §4。

---

## 4. 版本路线图

### 4.1 v5.1（本轮，1 个迭代）

**主题：采集—沉淀—分享闭环。**

| 编号 | 功能 | 验收要点（AC 详见 §5） |
| :--- | :--- | :--- |
| FR-30 | 录音导入 | 权限引导、录制/暂停/完成、试听、两种去向、10min 上限、错误兜底 |
| FR-31 | 作品库 | 新旧数据迁移、转换/剪辑自动入库、分享两段式、删除/清空、过期标记 |
| FR-32 | 分享卡片 | 4 个页面 `onShareAppMessage`、设置页 `open-type="share"` 入口 |
| FR-33 | 设置页升级 | 版本号、无额度残留、反馈入口、作品库/录音说明 |
| FR-34 | 入口与导航 | 首页三入口、编辑器空态录音入口、全局标题「音频工具箱」 |

**发布定义**：客户端代码完成 + 静态/单测/结构检查全绿 + 手工验证清单可执行（本机无法跑 DevTools 模拟器时，由用户在 IDE 验证并签收）+ 文档同步 + 本地合并。

### 4.2 v5.2（下一轮，2–3 个迭代）

> 依据 recon-editor（[docs/planning/recon-editor.md](./planning/recon-editor.md) §3–§5）：v5.2 主题是「**导出闭环**」——先把现有导出做稳、做透明，再扩格式与场景。

| 方向 | 内容 | 前置条件 |
| :--- | :--- | :--- |
| 导出可靠性加固（P0） | 导出中阶段文案（下载/渲染/上传）+「请勿离开」提示；错误码→可行动建议表（`OUTPUT_TOO_LARGE`/`UNSUPPORTED_FORMAT`/`TIMEOUT` 等）；导出失败保留工程（已有）补提示；云函数记录 `timings`（downloadMs/renderMs/uploadMs）与失败码到 `converted_files` 积累真实数据 | 云函数可部署 |
| 导出格式扩展（P0） | mp3/wav/m4a 格式 chips + 每格式时长/体积上限联动（WAV ≤4min、FLAC ≤7min、M4A ≤8min，见 recon-editor §3a）；`editor-core` 的 `OUTPUT_FORMATS`/编码器/输出命名/台账同步；导出名不再写死 `_剪辑.mp3` | 云函数 + 真机验证 |
| 压缩面板去重（P1） | 声音抽屉与吸底浮岛的压缩面板重复（`editor.wxml` 两处）；抽 `<export-dock>` 组件或合并为单一面板，消除 1/3 屏占用与状态不同步 | 与格式扩展同批 |
| 批量转换（P1） | 首页多选（≤3）→ 前端串行队列 → 逐个转换/失败重试；云端 `convertFile` 零改动 | 首页状态机扩展 + 回归 |
| 工程护栏（P1） | 编辑器抽 utils/behavior/组件（微信页面只能一个 js，不建议拆 page）；优先抽压缩面板/导出栏；draft v2（多工程，peaks 不落盘、恢复时按 fileID 重跑 analyzeAudio）可选 | 现有 191 项 + page-smoke 测试兜底 |

### 4.3 v5.3（3–4 个迭代）

| 方向 | 内容 |
| :--- | :--- |
| 可靠性 | 导出两段式任务化（create/run/get + 幂等 + 24h 清理），覆盖 10min/多轨/重效果；**前置**：先积累 2–4 周 timings 数据，若「导出 >30s」或「函数超时」占比 >2–3% 再落地（recon-editor §3b 结论） |
| 内容 | BGM 素材库（需版权素材）、智能配乐/自动避让增强、变声/回声等音效 |
| 沉淀 | 云端作品同步（openid 维度）、历史跨设备 |

### 4.4 v6.0（上线合规版本）

- 内容安全 `mediaCheckAsync` 接入与回调、额度正式策略（转换+剪辑共享）、上传票据与归属校验、正式云函数命名 `audioStudio`、备案/类目/隐私指引全量核对、真机矩阵回归。

> 路线图边界：v5.1 刻意做成「零云函数改动」的纯客户端版本，原因是当前环境无法部署/真机验证云侧；v5.2 起必须恢复 DevTools 服务端口并做真机矩阵，否则不合并云函数变更。

---

## 5. v5.1 详细设计

### 5.0 信息架构与导航

```
首页（格式转换）
├── 快捷工具区：✂️ 音乐剪辑 | 🎙 现场录音 | 📚 我的作品      ← 新增（FR-34）
├── 转换主流程（不变）
└── 设置（不变入口）

现场录音页 pages/record/record（新增，FR-30）
└── 完成 → 去转换（回首页预置源）/ 去剪辑（进编辑器并自动导入）

我的作品 pages/library/library（新增，FR-31）
└── 分享文件 / 复制外链 / 删除 / 清空；点击「继续处理」回到对应工具

音乐剪辑页（不变，仅空态加「🎙 现场录音」入口 + 结果页入库 + 分享）
设置页（升级，FR-33）
```

- 页面栈：`wx.navigateTo`（录音/作品库/设置），与现有 `goEditor` 一致；不使用 tabBar（v2.0 已移除，避免大改）。
- 页面标题：`app.json` 全局 `navigationBarTitleText` 改为「音频工具箱」；各页 `*.json` 可覆盖（录音「现场录音」、作品库「我的作品」、剪缉「音乐剪辑」）。

### 5.1 FR-30 录音导入（pages/record/record）

#### 5.1.1 目标与用户故事

> 作为用户，我想在小程序里直接录一段声音（说话、哼唱、现场），然后立刻转成 MP3 或进入多轨剪辑，不用先把音频发到微信会话。

#### 5.1.2 入口

1. 首页快捷工具区「🎙 现场录音」。
2. 编辑器空态「🎙 现场录音」次按钮（与「从微信选择音频」并列）。
3. 来源标记：`options.from = 'index' | 'editor'`，决定「完成」后的默认去向提示。

#### 5.1.3 状态机与交互

| 状态 | UI | 可用操作 |
| :--- | :--- | :--- |
| `IDLE` | 大圆形收音按钮、提示「点击开始录音」、上限/格式说明（MP3 · 最长 10 分钟） | 开始录音 |
| `RECORDING` | 计时 `00:00`、脉动波形动效、`暂停` / `完成` | 暂停、完成（≥1s 可完成） |
| `PAUSED` | 计时暂停、`继续` / `完成` | 继续、完成 |
| `REVIEW` | 试听播放器（播放/暂停/进度）、文件名/时长/大小、「去转换」「去剪辑」「重录」 | 试听、去向、重录 |
| 异常 | 权限拒绝/隐私未配置/录音失败：说明 + 重试/去设置 | — |

- 计时：`setInterval` 100ms 刷新文本（`mm:ss`），内部记录 `elapsedMs`（暂停不计）。
- 录音参数：`wx.getRecorderManager().start({ duration: 600000, sampleRate: 44100, numberOfChannels: 2, encodeBitRate: 192000, format: 'mp3' })`。
  - 声波动效用 CSS/`view` 条做假动效（真波形需 `onFrameRecorded`，仅 mp3/PCM 支持且徒增复杂度，本轮不做）。
- 停止：`recorder.stop()` → `onStop(res)` 拿到 `tempFilePath`、`duration`、`fileSize`；若 `res.duration < 1000` 提示「录音太短」并要求重录（不进入 REVIEW）。
- 文件命名：`录音_YYYYMMDD_HHmmss.mp3`（展示名）；物理临时路径由微信生成。
- 试听：`wx.createInnerAudioContext()`，`obeyMuteSwitch=false`（沿用现有播放器约定）；`onUnload` 销毁。
- 去向：
  - **去转换**：`app.globalData.pendingAudio = { path, name, size, extName:'MP3', extLower:'mp3', durationSec, source:'record' }` → `wx.navigateBack()`（若页面栈只有录音页则 `reLaunch` 首页）；首页 `onShow` 消费并写入 `sourceFile`、`sourcePlayable=true`、`sourceDuration`。
  - **去剪辑**：同上写 `pendingAudio` → `wx.redirectTo({url:'/pages/editor/editor?from=record'})`；编辑器 `onLoad/onShow` 消费后走 `importFiles([{file:{path,name,size}}])`（复用现有上传→analyze→建 source 流程），导入完成清除 `pendingAudio`。
- 互斥：同一时刻只允许一个录音任务；`onHide` 自动暂停并提示（避免后台录音异常）；`onUnload` 停止并释放。

#### 5.1.4 权限与隐私

1. `wx.getSetting` 查 `authSetting['scope.record']`：
   - 已授权 → 直接开始；
   - 未授权 → `wx.authorize({scope:'scope.record'})`；失败 → 弹窗说明并 `wx.openSetting` 引导。
2. 隐私校验：若启动录音返回错误文案包含 `privacy`（隐私指引未声明），提示：「需在小程序后台『用户隐私保护指引』中声明『访问你的麦克风』后重试」——与现有 `chooseMessageFile` 的隐私错误处理保持一致风格（`index.js` `chooseAudioFile.fail`）。
3. 生命周期：`onAudioInterruptionBegin/End` 处理来电/微信语音打断（暂停录音，恢复后保持暂停，不自动继续）。

#### 5.1.5 数据结构

```js
// app.globalData.pendingAudio（跨页一次性传递；用后即清）
{
  path: 'wxfile://tmp_xxx.mp3',
  name: '录音_20261031_0415.mp3',
  size: 1234567,
  extName: 'MP3',
  extLower: 'mp3',
  durationSec: 12.3,
  source: 'record'
}
```

> 选择 `globalData` 而非 `eventChannel`/URL 参数：路径含特殊字符且体积小，`globalData` 最稳；URL 传参会触发页面栈参数污染与长度限制。

#### 5.1.6 边界与异常

| 场景 | 处理 |
| :--- | :--- |
| 权限拒绝 | 弹窗 + 「去设置」；回到页面重新检测 |
| 隐私指引未配置 | 明确文案指向后台配置；不崩溃 |
| 录音 <1s | 不进入 REVIEW，提示重录 |
| 达到 10min | 微信自动停止（`onStop` 被动触发），UI 提示「已达 10 分钟上限，已自动保存」 |
| 来电/语音打断 | 暂停录音；恢复后显示「继续录音」 |
| 页面返回/卸载 | 停止录音、销毁播放器、清计时器 |
| 临时文件被系统清理 | 去向时 `getFileSystemManager().accessSync` 校验，失效提示「录音文件已失效，请重录」 |

#### 5.1.7 验收标准（AC）

- [ ] AC-30.1 首次点击录音弹出系统授权；拒绝后再次点击可经「去设置」重新授权。
- [ ] AC-30.2 录制中计时准确（±1s/分钟），暂停时计时冻结。
- [ ] AC-30.3 完成录音后可试听，试听进度/时长正确。
- [ ] AC-30.4「去转换」返回首页且源文件已就绪（名称/大小/时长正确），可直接转换。
- [ ] AC-30.5「去剪辑」进入编辑器并自动完成上传+分析（原有导入逻辑复用，不重复造轮子）。
- [ ] AC-30.6 录音 <1s 被拦截；10 分钟自动停止；录音中断电/来电不崩溃。
- [ ] AC-30.7 页面返回不残留计时器/播放器（`onUnload` 清理，无后台发声）。
- [ ] AC-30.8 隐私指引未配置时给出版本可理解的错误文案（不出现英文堆栈）。

### 5.2 FR-31 作品库（pages/library/library）

#### 5.2.1 目标与用户故事

> 作为用户，我想在一个地方看到我转换过、剪辑过的所有音频，能试听/转发/删除，并且知道哪些已经过期；不想在首页弹层里翻 20 条没有分类的转换记录。

#### 5.2.2 存储设计（`utils/library-store.js` 纯函数 + 薄 IO 层）

```js
// 新键：audio_library_v1
{
  version: 1,
  items: [
    {
      id: 'lib_1712345678901_ab12',   // 唯一
      kind: 'convert' | 'edit',
      name: '录音_20261031_0415.mp3',  // 结果文件名
      sourceName: 'demo.flac',         // 转换输入名（clip 时为首源名）
      format: 'mp3',
      size: 1234567,
      sizeText: '1.2 MB',
      durationText: '03:45',           // 可空
      fileID: 'cloud://...',           // 分享/重新下载用
      downloadUrl: 'https://...',      // 可选，转换结果有
      createdAt: 1712345678901,
      expiresAt: 1712432078901,        // createdAt + 24h（云端清理口径）
      extra: { targetFormat:'MP3', clipCount: 3 }  // 展示用
    }
  ]
}
// 上限：50 条；超出丢最旧；同 fileID 去重（重复入库更新 createdAt 并置顶）
```

- **迁移**：首次读取时若没有 `audio_library_v1`，读取旧键 `audio_convert_history`，逐条映射为 `kind:'convert'` 并写入新键（保留旧键不删，可回滚）；映射后 `notes.migratedFrom = 'audio_convert_history'`。
- **过期判定**：纯函数 `isExpired(item, now)`（`now > expiresAt`）；展示「已过期」灰态，分享时提示「云端文件仅保留 24 小时」。
- **容量**：50 条 × 约 200B ≈ 10KB，远低于微信 1MB/键限制；仍做 `try/catch` 与降级。
- **API**（纯函数优先，便于 Node 测试）：
  - `normalizeItem(raw)`、`addItem(list, item)`、`removeItem(list, id)`、`clearAll()`、`mergeLegacy(legacyList)`、`sortItems(list)`、`isExpired(item, now)`、`stats(list)`；
  - IO 薄层：`loadLibrary()`、`saveLibrary(list)`（页面调用；`wx.getStorageSync/setStorageSync` 同步即可）。

#### 5.2.3 页面 UI

| 区域 | 内容 |
| :--- | :--- |
| 顶部 | 标题「我的作品」+ 统计（共 N 个 · 云端保留 24h）+ 清空入口 |
| 筛选 | 分段器「全部 / 转换 / 剪辑」（本地过滤，不重新请求） |
| 列表 | 卡片：类型徽标（🔄 转换 / ✂️ 剪辑）、结果名、源名、格式/体积/时间、过期徽标；操作：`分享`（转发文件）、`复制外链`（convert 且有 downloadUrl）、`删除` |
| 空态 | 插画式空态 + 「去转换」「去剪辑」「现场录音」三个入口 |
| 过期 | 卡片置灰 + 「文件已过期（24h）」+ 「重新处理」引导（记录 entry 参数回工具） |
| 底部 | 「清空全部」二次确认；隐私说明文案 |

- 分享复用现有「首次点击准备、再次点击转发」流程（`wx.cloud.downloadFile` 缓存到页面内存 map，`wx.shareFileMessage` 需手势）；失败文案统一「文件已过期/网络异常」。
- 点击卡片本身：`kind=convert` → `wx.navigateTo('/pages/index/index')`（不能带 fileID 回填，页面无「按 fileID 重新试听」入口，本轮不做）；`kind=edit` → 编辑器（不带草稿，仅提示）。**不做跨页回填**，避免引入新的复杂状态。

#### 5.2.4 写入点

| 页面 | 位置 | 动作 |
| :--- | :--- | :--- |
| `index.js` | 转换成功（现 `saveHistoryRecord` 调用处，约 L593） | 组装 item → `libraryStore.addItem` + 保存；保留旧键写入或改为新键（见下） |
| `editor.js` | 导出成功 `handleExportSuccess`（约 L4443） | 组装 `kind:'edit'` item 入库（`fileID/size/duration/clipCount`） |
| `index.js` | 历史弹层 | **移除**，改为入口跳作品库（减少双份 UI/逻辑；旧数据由作品库迁移承接） |

> 兼容策略：`audio_convert_history` 保留只读迁移（不再写入）；新写入统一 `audio_library_v1`。如用户降级旧版本，旧键仍在，不丢数据。

#### 5.2.5 验收标准（AC）

- [ ] AC-31.1 首次打开作品库自动迁移旧转换历史，条目数量/字段匹配。
- [ ] AC-31.2 新转换成功后作品库出现记录（含格式/体积/时间），无需手动刷新（`onShow` 重新加载）。
- [ ] AC-31.3 剪辑导出成功后作品库出现「剪辑」记录（含片段数/时长）。
- [ ] AC-31.4 分享：首次点击准备并提示，再次点击成功转发；过期记录分享给出明确提示。
- [ ] AC-31.5 单条删除、清空全部（二次确认）后存储与 UI 一致。
- [ ] AC-31.6 50 条上限生效，最旧记录被淘汰，不影响最新记录。
- [ ] AC-31.7 空态/筛选/过期态三态渲染正确。

### 5.3 FR-32 分享卡片

#### 5.3.1 设计

| 页面 | `onShareAppMessage` 返回值 |
| :--- | :--- |
| index | `{ title: '音频工具箱 · 格式转换/剪辑/录音，一站搞定', path: '/pages/index/index' }` |
| editor | `{ title: '在线多轨剪辑 · 手机上也能精细剪音频', path: '/pages/editor/editor' }` |
| record | `{ title: '现场录音，录完立刻转格式', path: '/pages/record/record' }` |
| library | `{ title: '我的音频作品库', path: '/pages/index/index' }`（分享落地首页，避免暴露用户作品） |

- 入口按钮：设置页「分享给好友」`<button open-type="share">`（微信要求用户点击触发）；作品库空态亦可放一个 `open-type="share"`。
- 配置 `wx.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage'] })`（只开放好友/群；**不开** `shareTimeline`，见 §2.2 合规红线）。
- 自定义封面（`imageUrl`）本轮不做：默认截图即可，避免新增静态资源与 5:4 尺寸适配。

#### 5.3.2 验收标准（AC）

- [ ] AC-32.1 四个页面右上角菜单可转发，落地路径正确。
- [ ] AC-32.2 设置页「分享给好友」可拉起转发面板。
- [ ] AC-32.3 未出现朋友圈/公开传播入口（合规）。

### 5.4 FR-33 设置页升级与全局文案清理

| 项 | 变更 |
| :--- | :--- |
| 版本号 | `0.1.0` → `5.1.0`（与 DEV_LOG 版本线一致） |
| 服务说明 | 单文件 ≤50MB、不限次数（测试阶段）、24h 清理、录音 ≤10min、剪辑 ≤10min；移除「当前次数」歧义行 |
| 新增行 | 「我的作品」→ 作品库；「现场录音」→ 录音页；「分享给好友」button open-type=share |
| 反馈 | 「意见反馈」→ `wx.showModal` 展示反馈方式（邮箱占位 `feedback@example.com` + 「复制」按钮）；不接客服（无后台配置） |
| 清理 | 清空历史/缓存改为同时清 `audio_library_v1`（二次确认，文案说明云端文件不受影响） |
| 关于 | 版本 `5.1.0`、技术说明（微信云开发 + FFmpeg 7.0.2）、隐私承诺 |
| 首页页脚 | 删除「今日免费额度 X / 5 次」；改为「测试阶段 · 不限次数」或移除 |
| 全局标题 | `app.json` `navigationBarTitleText`: 「音频工具箱」 |

AC：
- [ ] AC-33.1 设置页无任何「每日 5 次/额度」矛盾文案。
- [ ] AC-33.2 版本号与关于页一致（5.1.0）。
- [ ] AC-33.3 反馈入口可用且可复制邮箱。
- [ ] AC-33.4 清空操作同时清理作品库且不影响云端文件。

### 5.5 FR-34 入口与导航

- 首页新增「快捷工具区」（替换现有单条 editor banner）：
  - 3 个横向卡片/胶囊：`✂️ 音乐剪辑`、`🎙 现场录音`、`📚 我的作品`；
  - 视觉沿用现有 design tokens（`#F8F6F2` 画布 / `#FFFFFF` 卡片 / `#1C1917` 文字 / `#FF6B00` 强调 / 20–24rpx 圆角 / 轻投影），不引入新色板。
- 编辑器空态：在「+ 从微信选择音频」下方增加次按钮「🎙 现场录音」。
- `app.json` pages 追加 `pages/record/record`、`pages/library/library`。

AC：
- [ ] AC-34.1 首页三个入口均可跳转，返回后状态正常。
- [ ] AC-34.2 编辑器空态录音入口可跳转，录音返回后自动导入。
- [ ] AC-34.3 新页面标题正确、无重复 tabBar、返回栈正常。

### 5.6 本地存储契约汇总

| Key | 用途 | 写入方 | 说明 |
| :--- | :--- | :--- | :--- |
| `audio_library_v1` | 作品库（新） | index/editor/record/library | 50 条上限，版本化 |
| `audio_convert_history` | 旧转换历史 | 只读迁移（不再写） | 降级兼容，保留 |
| `NLE_DRAFT_CACHE_V1` | 剪辑草稿 | editor（现有） | 不变；作品库仅提示入口，不复用 |

### 5.7 错误码与文案（新增）

| 场景 | 文案 | 处理 |
| :--- | :--- | :--- |
| `RECORD_AUTH_DENIED` | 「需要麦克风权限才能录音，请在设置中允许」+ 去设置 | `wx.openSetting` |
| `RECORD_PRIVACY_MISSING` | 「隐私指引未声明麦克风，请在小程序后台补充『访问你的麦克风』」 | 阻断 + 文档指引 |
| `RECORD_TOO_SHORT` | 「录音太短（不足 1 秒），请重新录制」 | 回 IDLE |
| `RECORD_FAILED` | 「录音失败，请检查麦克风是否被占用后重试」 | 错误态 + 重试 |
| `LIB_FILE_EXPIRED` | 「云端文件仅保留 24 小时，该记录已过期」 | 灰态 + 引导重新处理 |
| `LIB_SHARE_PREPARING` | 「文件准备中，请 1 秒后再点一次分享」 | 沿用现有模式 |

---

## 6. 实施计划（WBS）

### 6.1 任务拆分与写范围（并行安全，文件所有权互斥）

| 任务 | 内容 | 负责人 | 写范围（Workspace 相对） | 依赖 | 估时 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| T-A | 计划文档（本文件）+ 侦察结论合并 | Lead | `docs/NEXT_UPDATE_PLAN.md`、`docs/planning/*` | 侦察完成 | 0.3d |
| T-B | 基线验证（静态检查/测试/CLI 探测） | verifier | `docs/planning/baseline-verification.md` | 无 | 0.2d |
| T-C | 录音页 + 录音工具函数 | impl-record | `miniprogram/pages/record/**` | T-A、T-B | 0.5d |
| T-D | 作品库页 + 存储纯函数 + 迁移 | impl-library | `miniprogram/pages/library/**`、`miniprogram/utils/library-store.js` | T-A、T-B | 0.5d |
| T-E | 集成：app.json/app.wxss/index/editor/settings 分享与入库 | Lead | `miniprogram/app.json`、`app.wxss`、`pages/index/**`、`pages/editor/editor.js`、`pages/editor/editor.wxml`、`pages/settings/**` | T-C、T-D（页面存在后注册） | 0.5d |
| T-F | 新增页面 smoke 测试 + 回归 | verifier | `scripts/page-smoke/**`、`docs/planning/*-verify.md` | T-C/T-D/T-E | 0.3d |
| T-G | 文档同步（README/docs/README/DEV_LOG） | Lead | `README.md`、`docs/README.md`、`docs/DEV_LOG.md` | T-E、T-F | 0.2d |
| T-H | 最终验收、合并、报告 | Lead | `main` 合并提交 | 全部 | 0.2d |

### 6.2 执行顺序与并行

1. T-B（基线）与 T-A（计划）并行 → 计划定稿后创建 T-C/T-D 共享任务并 spawn 实现者。
2. T-C、T-D 并行（写范围互斥）；Lead 同步准备 T-E 的 diff（app.json 等需在页面文件落地后注册，避免引用不存在文件）。
3. T-E 完成后交 T-F 回归；T-F 通过后 T-G 文档，最后 T-H 合并（`git merge --no-ff`）并在 `main` 重跑回归。
4. 任何一步失败：停止后续合并，保留功能分支，记录失败项与复现命令。

### 6.3 提交计划（一个意图一个提交）

| 提交 | 内容 |
| :--- | :--- |
| `docs: add v5.1 next-update plan` | 本计划 + 侦察报告 |
| `feat(record): add in-app recording page` | 录音页 + 入口（app.json/index/editor） |
| `feat(library): add unified audio library` | 作品库 + 存储迁移 + 写入点 |
| `feat(share): enable app-message share cards` | 分享卡片 + 设置入口 |
| `chore(copy): clean quota copy and bump version` | 文案/版本/设置 |
| `docs: sync README and dev log for v5.1` | 文档同步 |

---

## 7. 测试与验收

### 7.1 自动化（本机可执行）

| 检查 | 命令 | 基线/预期 |
| :--- | :--- | :--- |
| JS 语法 | `node --check` 全部 JS | 改动前 11 项全过；改动后全过 |
| 编辑器页面/纯函数 | `node scripts/editor-spike/frontend-test.js` | 基线 **41 通过 / 0 失败**；改动后 ≥41 全过 |
| 云函数纯函数 | `node scripts/editor-spike/test_pure.js` | 基线 **150 通过 / 0 失败**；改动后 ≥150 全过 |
| 新增页面 smoke | `node scripts/page-smoke/record-library-test.js`（新增） | WXML 标签配对、事件处理函数存在、存储纯函数断言、分享配置存在、录音状态机纯函数（可 mock wx） |
| 结构检查 | JSON 可解析、wxml 开闭标签平衡、wxss 花括号平衡 | 0 错误 |
| Git 卫生 | `git status` / `git diff --cached --name-only` | 仅计划内文件 |

### 7.2 手工验证清单（需用户/devtools，本机无法替代）

- [ ] DevTools 模拟器：首页三入口跳转/返回；录音页授权弹窗与录音（模拟器麦克风）；作品库三态；分享菜单。
- [ ] 真机（iOS + Android 各 1 台）：录音授权/隐私弹窗、录制 30s、去转换/去剪辑、试听、分享文件、分享卡片。
- [ ] 真机：作品库分享两段式手势（首次准备→再次转发）、过期记录提示。
- [ ] 回归：格式转换主链路（选文件→转 mp3→试听→转发）、剪辑主链路（导入→剪→导出→试听）、草稿恢复。

### 7.3 回归矩阵

| 模块 | 用例 | 预期 |
| :--- | :--- | :--- |
| 格式转换 | 会话文件转 mp3/wav/flac | 成功率与改动前一致 |
| 格式转换 | 历史→作品库迁移 | 旧记录全部出现 |
| 剪辑 | 导入 2 源 3 片段→导出 | 与改动前一致 |
| 剪辑 | 导出后作品库记录 | 新增 1 条 edit |
| 录音 | 录音→去转换/去剪辑 | 两条路径均可用 |
| 持久化 | 杀进程重进作品库 | 记录仍在 |

### 7.4 验证边界声明

- 本机**没有**运行的微信开发者工具服务端口（44120 未监听），无法执行 `cli preview`/真机预览；WXML/WXSS 只能做结构级校验，**无法替代模拟器渲染验证**。
- 云函数不在本轮改动范围，因此不触发部署；`node --check` 与 `test_pure.js` 仅证明代码未被破坏。

---

## 8. 风险与回滚

| ID | 风险 | 概率 | 影响 | 缓解 |
| :--- | :--- | :---: | :--- | :--- |
| R-01 | 录音权限/隐私指引未配置导致功能不可用 | 高 | 中 | 错误文案指向后台配置；上线前在隐私指引补「麦克风」；提供录音不可用时的降级提示 |
| R-02 | 作品库迁移覆盖旧数据 | 低 | 高 | 只读旧键、新键独立；`mergeLegacy` 幂等；保留旧键 30 天 |
| R-03 | 分享文件两段式手势交互被用户误解 | 中 | 低 | 沿用现有 toast「文件准备中，请 1 秒后再点」；卡片操作文案明确 |
| R-04 | 无 DevTools/真机，UI 细节偏差 | 高 | 中 | 结构测试 + 复用现有样式类/tokens；交付说明标注「待 IDE 真机签收」 |
| R-05 | 录音文件过期/被清理 | 中 | 中 | 去向时 `accessSync` 校验；失效提示重录 |
| R-06 | 首页/编辑器改动引入回归 | 中 | 高 | 改动最小化（只加入口/入库/分享），191 项基线测试兜底；`main` 合并后再跑回归 |
| R-07 | 页面体积增长 | 低 | 低 | 新增两页约 30–40KB；仍远低于 2MB 单包限制 |

**回滚**：功能分支提交可独立 revert；`audio_library_v1` 与旧键并存，删除新键即回到旧行为；`main` 合并后如需回退 `git revert -m 1 <merge-commit>`。

---

## 9. 待确认事项（不阻塞默认实施）

| # | 问题 | 默认决策（未确认即按此执行） |
| :--- | :--- | :--- |
| Q1 | 录音入口放哪里？ | 首页快捷工具区 + 编辑器空态 |
| Q2 | 录音产物格式？ | MP3 44.1kHz / 双声道 / 192kbps（兼容与体积平衡） |
| Q3 | 作品库是否替代首页历史弹层？ | 是（迁移旧数据，入口统一到作品库） |
| Q4 | 是否做朋友圈分享？ | 否（类目合规，仅好友/群） |
| Q5 | 版本号怎么标？ | `5.1.0`（沿用 DEV_LOG v5.x 线） |
| Q6 | 作品库上限？ | 50 条（本地存储），云端仍 24h 清理 |
| Q7 | 录音是否自动入库？ | 不自动；仅当用户「去转换/去剪辑」并产生结果后入库 |

> 若用户对 Q1–Q7 有不同意见，按用户决策修订后再实施；默认值按本计划执行。

---

## 9.5 实施记录与偏差（2026-10-31，已落地）

> 本轮在 `feature/v5.1-audio-capture-library` 分支按本计划 P0/P1 全量实施；以下为实际落地状态与对计划的偏差，供验收与后续迭代对照。

### 9.5.1 已落地文件

| 类型 | 文件 | 说明 |
| :--- | :--- | :--- |
| 新增 | `miniprogram/pages/record/{record.js,record.json,record.wxml,record.wxss}` | 现场录音页（937 行 js / 152 行 wxml / 620 行 wxss）：四态状态机、权限与隐私引导、100ms 计时、试听、双去向、分享 |
| 新增 | `miniprogram/pages/library/{library.js,library.json,library.wxml,library.wxss}` | 我的作品页：统计/筛选/两段式分享/复制外链/删除/清空/空态三入口 |
| 新增 | `miniprogram/utils/library-store.js` | 作品库纯函数 + 薄 wx IO：`audio_library_v1`、50 条上限、24h 过期、旧键幂等迁移、无 wx 安全降级 |
| 修改 | `miniprogram/app.json` | 注册 `pages/record/record`、`pages/library/library`；全局标题「音频工具箱」 |
| 修改 | `miniprogram/pages/index/*` | 三入口快捷区（剪辑/录音/作品）、作品角标、pendingAudio 消费、转换成功入库、分享卡片、移除历史弹层与额度死代码、隐私文案校正 |
| 修改 | `miniprogram/pages/editor/*` | 空态「现场录音」入口、`?from=record` 消费 pendingAudio、导出成功入库、分享卡片 |
| 修改 | `miniprogram/pages/settings/*` | 版本 5.1.0、功能入口、分享给好友、意见反馈、清空作品、清缓存保留剪辑草稿、隐私文案校正 |

### 9.5.2 对计划的偏差（均已评估，不影响验收）

| # | 计划 | 实际 | 原因/影响 |
| :--- | :--- | :--- | :--- |
| D-1 | 存储模块名 `library-store` | 一致；键 `audio_library_v1`，条目上限 50、TTL 24h，旧键只读迁移 | 无偏差 |
| D-2 | 录音「去转换」navigateBack | 仅从首页进入时 navigateBack；从剪辑/设置/作品库进入时 reLaunch 首页 | 修复返回栈错误（否则会回到设置页且 pendingAudio 悬空） |
| D-3 | 首页历史弹层移除 | 已移除（约 40 行 wxml + 50 行 js），右上角角标改为作品库数量 | 减少双份 UI；旧数据由迁移承接 |
| D-4 | 分享卡片 | index/editor/record/library/settings 均有 `onShareAppMessage`；设置页 `open-type="share"` 入口；未做朋友圈 | 遵循类目「不得传播分享」红线 |
| D-5 | 文案「24h 物理销毁」 | 全部改为「24 小时内自动清理」 | 与 cleanup 实际行为一致（定时清理，非立刻物理擦除） |
| D-6 | 计划未含清理草稿保护 | 设置页「清理缓存」保留 `NLE_DRAFT_CACHE_V1` 草稿后清理 | 避免误删用户未导出工程（审计发现项） |
| D-7 | 隐私开关 | 未新增 `__usePrivacyCheck__`（维持现状） | 后台隐私指引尚未声明麦克风；新增开关会让未配置时所有隐私接口被拦截。列为上线前置：后台补声明后再开 |
| D-8 | 录音格式 | MP3 44.1kHz / 双声道 / 192kbps（与计划一致） | 规避 aac 默认产物在命名/兼容上的不确定性 |

### 9.5.3 已执行的验证（截至 2026-10-31，本机）

| 检查 | 结果 |
| :--- | :--- |
| `node --check` 全部 JS（13 个文件，含新增） | 全过 |
| `node scripts/editor-spike/frontend-test.js` | 41/41 通过（与基线一致） |
| `node scripts/editor-spike/test_pure.js` | 150/150 通过（与基线一致） |
| `app.json` pages ↔ 磁盘四件套 | 5 页全部齐全 |
| 5 页 wxml 事件绑定 ↔ Page 方法 | 0 缺失（index/editor/settings/record/library） |
| library-store 契约冒烟（去重/上限/迁移幂等/过期/stats） | 通过（Node 内联断言） |
| DevTools 模拟器 / 真机 | **未执行**（IDE 未运行、44120 未监听）→ 需用户签收 |

### 9.5.4 未验证项与上线前置

- 真机录音（iOS/Android 权限弹窗、10min 计时、来电打断）、作品库两段式分享手势、首页三入口跳转需在 DevTools/真机复核。
- 后台隐私指引需补「访问你的麦克风」声明；小程序备案/类目/正式云函数命名等仍在原发布清单中。

---

## 10. 附录

### 10.1 本轮文件清单（预期）

**新增**

| 文件 | 说明 |
| :--- | :--- |
| `miniprogram/pages/record/record.{js,json,wxml,wxss}` | 现场录音页 |
| `miniprogram/pages/library/library.{js,json,wxml,wxss}` | 我的作品页 |
| `miniprogram/utils/library-store.js` | 作品库纯函数 + 迁移 + IO 薄层 |
| `scripts/page-smoke/record-library-test.js` | 新增页面/存储/分享 smoke 测试 |
| `docs/NEXT_UPDATE_PLAN.md` | 本计划 |
| `docs/planning/baseline-verification.md`、`recon-*.md` | 侦察与基线证据 |

**修改**

| 文件 | 说明 |
| :--- | :--- |
| `miniprogram/app.json` | 注册两个新页面、标题改「音频工具箱」 |
| `miniprogram/app.wxss` | 新增少量共享工具类（如页头/空态，若需要） |
| `miniprogram/pages/index/{index.js,wxml,wxss}` | 快捷工具区、作品库入口、录音去向消费、转换入库、分享、移除历史弹层、页脚文案 |
| `miniprogram/pages/editor/{editor.js,wxml}` | 空态录音入口、导出成功入库、分享卡片、录音去向导入（不列 wxss 除非新增少量样式） |
| `miniprogram/pages/settings/{settings.js,wxml,wxss}` | 版本/反馈/入口/分享/清理升级 |
| `README.md`、`docs/README.md`、`docs/DEV_LOG.md` | 文档同步 |

### 10.2 参考

- 官方 API：`RecorderManager.start`、`wx.authorize`、`wx.openSetting`、`onShareAppMessage`、`wx.shareFileMessage`、`wx.showShareMenu`、`wx.cloud.downloadFile`（链接与限制见 [FEASIBILITY §10](./FEASIBILITY.md) 来源表）。
- 既有实现：转换页分享两段式（`pages/index/index.js` `shareHistoryItem`）、编辑器草稿恢复（`pages/editor/editor.js` `checkAndPromptRestoreDraft`）、设计 tokens（`pages/index/index.wxss` 头部注释与 `app.wxss`）。

### 10.3 术语

| 术语 | 含义 |
| :--- | :--- |
| 作品（item） | 一次转换或剪辑产出的云端音频记录 |
| 两段式分享 | 首次点击准备本地文件、再次点击转发（满足 `shareFileMessage` 手势限制） |
| pendingAudio | 录音页 → 首页/编辑器的一次性跨页数据 |
| 零云函数改动 | v5.1 只改客户端，不部署云函数 |

---

*文档变更：v1.0（2026-10-31）首版，基于 v5.0 代码快照与侦察报告。*
