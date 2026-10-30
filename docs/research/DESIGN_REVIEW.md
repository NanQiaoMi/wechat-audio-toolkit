# 《在线音乐编辑详细设计 v0.1》独立评审意见

| 项 | 内容 |
| :--- | :--- |
| 评审对象 | [MUSIC_EDITOR_DESIGN.md](../MUSIC_EDITOR_DESIGN.md)（v0.1） |
| 评审基线 | **2026-10-28 04:44 版**（136,397 B，sha256 `162c77a5…`，约 1,900 行）。评审期间主文档仍在修订（04:28 初稿 → 04:39 → 04:44），本意见按 04:44 时点内容逐条核对；若后续继续修改，请按文中章节号复核，而不是按行号 |
| 支撑材料 | [CLIENT_CAPABILITIES.md](./CLIENT_CAPABILITIES.md)（04:13）、[UX_EDITOR_SPEC.md](./UX_EDITOR_SPEC.md)（04:16）+ `ux/*.svg`、[FFMPEG_EDIT_SPIKE.md](./FFMPEG_EDIT_SPIKE.md)（**04:36 才落盘**） |
| 交叉对照 | [PRD.md](../PRD.md)、[TASK_PLAN.md](../TASK_PLAN.md)、[DEV_LOG.md](../DEV_LOG.md)、[README.md](../../README.md)、[docs/README.md](../README.md)、`miniprogram/pages/index/index.js`（719 行）、`cloudfunctions/ffmpegProbe/index.js`（410 行） |
| 评审人 | design-reviewer（独立评审，非设计作者） |
| 日期 | 2026-10-28 |

**评审方法说明**

1. 逐节通读主文档与 3 份支撑材料；SVG 线框抽取文本核对布局/文案；追查 8 处数字到 `scripts/ffmpeg-spike/` 脚本与 `/tmp/ffmpeg-spike-work/results/*.tsv` 原始记录（原始结果未入库，见文末证据说明）。
2. 在当前运行的 `ffmpeg-spike` Docker 容器内复验了快剪命令的时间语义：`-ss 30 -to 60 -i` → 30.015s，`-ss 30 -to 90 -i` → 60.029s（即输入侧 `-ss + -to` 的 `-to` 相对 seek 点，设计 A1/规则 0 的写法结果正确，但可读性差，建议改写 `-t`）。
3. 代码事实核对：`QUOTA_ENFORCED = false`（`ffmpegProbe/index.js:15`）、`MEDIA_CHECK_ENABLED = false`（:17）；当前小程序只有 `pages/index`、`pages/settings` 两页；`pages/index/index.js` 实为 **719 行**（文档写 688 行）。
4. **关于「FFmpeg memo 未交付」**：评审开始时（04:33）`docs/research/FFMPEG_EDIT_SPIKE.md` **不存在**，属 B 级交付缺陷；04:36 该 memo 落盘，04:39/04:44 主文档吸收了其中 SIGKILL、`-filter_complex_threads 1`、`stream_loop`、`level=false`、flac 禁用 copy 等修订。因此本评审按 04:44 版进行，仍保留「memo 与主文档未完全对齐」的问题（见 M4、M5、数字表），但不再把「memo 未交付」本身列为 Blocker。若以 04:28 版为准，则该项本身就是 Blocker。

---

## 0. 结论先行

**结论：有条件通过（Conditional Go）——可进入开发评审，但必须先出 v0.2 关闭 3 个 Blocker，再启动 M9.1。**

一句话理由：**「服务端 peaks + 视口 Canvas + InnerAudioContext 近似预览 + 云端 FFmpeg 单命令渲染 + create/run/get 两段式任务」的总体架构成立，FFmpeg 的关键坑（flac copy、afade 顺序、amix normalize、SIGKILL、-t、复杂 filter 线程）也已在 04:39 修订中吸收；但编辑数据契约与三份支撑材料尚未收敛，`edit_tasks` 又不持久化执行所需的 plan，直接用 v0.1 开工会在前后端联调与「导出恢复/重试」处返工。**

**进入 M9.1 前必须关闭（Gate）：**

1. **B1**：`edit_tasks` 持久化完整 plan（或 `planFileID`），使两段式导出/重试/恢复/事件触发器可执行。
2. **B2**：确定唯一 EditPlan/API/取消语义契约（主文档 §5.2+§9 为唯一事实源），回写 UX/CLIENT/PRD。
3. **B3**：收敛主文档与 UX 规格的 6 组用户可见行为冲突（5/9 源、格式矩阵、草稿 TTL、铃声限额、额度、选区最小值）。
4. 用户拍板 §17 **Q1（v1.0/v1.1）、Q2（10min）、Q3（额度）、Q4（格式）、Q5（5/9 源）**；其中 Q5 直接决定 UX 要重画多少。
5. 完成 §13.3 的 **SPIKE-E1/E2/E5**（导出中断恢复、顺序预览、Canvas 手势），并把 FFmpeg memo §8.2 的「云函数内复测」补进 M9.0。

上述完成后，M9.1（分析链路）即可开工；**不建议按当前 v0.1 直接开始 M9.2/M9.3**（编辑器与拼接/配乐会依赖 B1/B3/M4/M7 的契约结论）。

---

## 1. 问题清单

> 编号规则：B = Blocker（不修复会阻塞开发或导致架构返工）；M = Major（影响正确性/体验/排期，进入 M9 前必须处理）；m = Minor（可随实现修正，但应记录）。
> 每条含【位置】【问题】【影响】【建议修改】。

### B1｜`edit_tasks` 不持久化 plan，两段式导出/恢复闭环断裂【Blocker】

- **位置**：§8.3-A 步骤 4（"落 `edit_tasks`（`queued`，保存 plan）"）、§8.3-B 步骤 3（"读取 `task.plan`"）、§10.1 `edit_tasks` 字段表（只有 `planHash` + `planBrief`，"不存完整 plan"）、§12.2 隐私最小化。
- **问题**：执行链路依赖 `task.plan`，但数据模型明确不存 plan；`planHash` 只是摘要，`planBrief` 只有源数/片段数/时长/格式。于是 `runEditTask` 的任何一次重试、云函数实例切换、切后台后 `getEditTask` 恢复、P1 事件触发器后台执行，都拿不到可执行的编辑计划。create 时"保存 plan"与数据模型"不存完整 plan"是直接矛盾。
- **影响**：ADR-E09 的"快建任务 + 执行 + 轮询"核心价值（不丢单、可恢复、可重试）无法实现；导出失败后只能让客户端重新提交 plan，又破坏 `clientToken` 幂等；cleanup/审核无法回放问题。这是当前设计的**架构级断点**。
- **建议修改**：
  1. `edit_tasks` 增加 `plan`（≤32KB，与请求 JSON 上限一致）或 `planFileID`（云存储 `edit_plans/{taskId}.json`，48h TTL、仅服务端可读）；
  2. `createEditTask` 事务内与 task 一起写入；`runEditTask` 从该字段/文件读取；`getEditTask` 不回传 plan；
  3. 隐私说明改为"编辑参数（不含音频内容）保留 48h，仅用于重试/排障/审计"，与 §12.2 的最小化承诺对齐；
  4. 若坚持不落库，则必须删掉"读取 task.plan"和"可恢复/可重跑"承诺，并把两段式降级为"客户端每次重传 plan + 新 token"——但这会让 ADR-E09 失去意义，不建议。

### B2｜EditPlan 与 API 契约在三份材料中不一致，"唯一事实源"未落地【Blocker】

- **位置**：主文档 §5.2（EditPlan：`sources` 对象 keyed by `src_*`、`main.clips`、`export`、`bgm.gainDb/startOffsetSec`、`analysisId` 必填）、§9.2–§9.4（`analyzeAudio`/`createEditTask`/`runEditTask`/`getEditTask`）↔ UX 规格 §6.1/§6.2（`sources[]` 数组、`timeline`、`output`、`bgm.volumeDb/offset`、无 `analysisId`，`clientToken` 放在 plan 内）↔ CLIENT_CAPABILITIES §6.3（`analyze`/`render`/`renderStatus`/**`cancel`**）↔ UX §10-S14/CLIENT §6.3 的「取消导出并退次」在主文档 §6.2 是"无取消"且无 `cancelEditTask` action。
- **问题**：三份材料给出三套字段名、两套 API 命名、一套额外 `cancel`；主文档 §7 只声明"边界/限额以主文档为准、交互细节以 UX 为准"，没有规定**数据模型与 API 以谁为准**。`planHash` 的规范化算法（字段顺序、浮点精度、可选字段缺省）也未定义，幂等排重和问题回放都不可复现。
- **影响**：前端 `utils/edit-plan.js`、后端 `plan.js`、契约测试、真机用例会各按一套实现；取消/退次的幂等语义（取消成功 vs 已成功）没有状态机，联调必返工；验收无法判断"同一 clientToken 能查回同一结果"（AC-14）到底比较什么。
- **建议修改**：
  1. 在 v0.2 §0/§5 第一行明确：**§5.2 + §9 为唯一 EditPlan/API 契约；UX 只引用不复述；CLIENT 的 analyze/render/renderStatus/cancel 命名作废**；
  2. 提供版本化 JSON Schema（含字段必填/范围/默认）与 2 个完整示例（单源裁剪、5 源+BGM）；定义 `planHash = sha256(规范化JSON)` 的规范化规则（key 排序、数字统一 3 位小数、省略默认值）；
  3. 取消语义二选一：实现 `cancelEditTask`（仅 `queued/running` 可取消，取消后 `failed`、额度退 1、幂等标记 `quotaRefunded`）并把 UX「取消（退次）」补齐；或删除 UX/CLIENT 的取消承诺、统一为"导出中不可取消，可退后台"；
  4. 回写 UX §6.2/§10、CLIENT §6.3、PRD FR-19，避免开发拿错材料。

### B3｜主文档与 UX 规格存在 6 组用户可见行为硬冲突【Blocker】

- **位置/冲突项**：

| # | 主文档 | UX_EDITOR_SPEC |
| :-- | :--- | :--- |
| 1 | 主轨源文件 **≤5**（§2.5/§11.1、Q5） | 「最多 **9** 段、合计 ≤10min」（§3.2-C、§6.4、§8 语音拼接、§11.1 多选说明） |
| 2 | P0 导出 **mp3/wav/flac**，m4a P1、OGG 不做（§2.5/§11.2/Q4） | 导出设置默认 **MP3/M4A/WAV + 高级 FLAC/OGG**（§7.8）；OGG 服务端明确不做 |
| 3 | 草稿 **24h**（§5.4/§6.8/Q15） | 草稿 **7 天**（§3.4/Q10） |
| 4 | 铃声模板成片 **≤40s 硬拦**（§5.5/V3、§7.4、§13.4） | 「>40s **只提示不硬拦**」（§8 手机铃声行） |
| 5 | 额度可配置、测试期 **不限次数**（§0.6/§11.3/AC-15） | 硬编码 **5 次/日**（§1.1-B5、§10-S17、§11.4 全量文案） |
| 6 | 选区最小 **0.2s**（§5.3-V2、§6.4） | 选区 <**0.1s** 才禁用、文案"至少 0.1 秒"（§7.1/§11.3） |

- **问题**：主文档 §7 把"交互细节"授权给 UX，而以上 6 项都同时是**边界与用户可见承诺**；两份文档同时生效时，前后端/QA 没有唯一答案。
- **影响**：上传 9 个文件后被服务端以 `INVALID_PLAN` 拒绝（5 源上限）；用户选 M4A/OGG 后被拒；草稿在 24h 后消失但 UI 说 7 天；铃声 41s 允许拖选区却在导出时被拒；Android 上看不到测试期"不限次数"，且选区能拖到 0.1s 但服务端拒绝。
- **建议修改**：v0.2 出一张「v1.1 冻结行为表」（源数、格式矩阵、草稿 TTL、铃声限额、额度开关、最小时长），UX 全量引用该表；在 UX 顶部加"与主文档冲突时以主文档 v0.2 为准"；Q5 定案后同步改 UX 文案、多选上限、`count` 参数与 AC。

### M1｜渲染任务状态机与错误码不闭合【Major】

- **位置**：§4.3、§8.3、§9.4、§9.7、§10.1、§11.3。
- **问题**：① 状态枚举三套：§4.3 `queued → running → succeeded|failed`，`succeeded → safety_pending → safety_pass|safety_risky`；§10.1 是 `created/running/succeeded/failed/blocked`；§11.3 预占事务又写 `status:'created'`；§9.4.2 响应出现 `safety:{status:'pending'}`。② 错误码引用未定义：§5.3-V1 的 `FORBIDDEN`、§8.3/§9.4.2 的 `EXPORT_RUNNING`、§9.3 的 `STORAGE_ERROR`/`INVALID_FILE` 都不在 §9.7 总表。③ §4.3 说 `getEditTask` 由服务端"每次按 fileID 重新换取 downloadUrl"，§8.3-C/§9.4.3 说"只返回 fileID，不返回长期 URL"，两处矛盾。④ §9.7 `TIMEOUT` 触发写">50s"，而 §8.3/§8.4 的 FFmpeg 预算已改为 45s。
- **影响**：客户端状态映射、重试/退次判断、错误文案会出现未覆盖分支；`created` 任务能否被 run、`safety_*` 是否占用列表查询，均无定义。
- **建议修改**：给出一张状态转换表（state × event × 副作用），统一为 `queued → running → succeeded|failed|blocked`，安全检测用独立字段 `safetyStatus ∈ {none,pending,pass,risky}` 而不是混进主状态；错误码表补 `FORBIDDEN`/`EXPORT_RUNNING`/`UPLOAD_FAILED`/`STORAGE_ERROR`，并增加"可重试/是否扣次/是否退次"三列；统一 `TIMEOUT >45s`。

### M2｜额度预占/返还与 taskId 恢复不闭环【Major】

- **位置**：§8.3 "失败与返还"、§10.3 清理频率、§6.7.8、§11.3 预占算法。
- **问题**：① `createEditTask` 成功但从未 `run` 的 `queued` 任务，§8.3 说"cleanup 超过 10min 后标记 failed 并返还"，但 §10.3 清理触发器是**每日 1 次**，`getEditTask` 只处理 `running > 75s`，不处理 `queued` 僵死；若 `QUOTA_ENFORCED=true`，用户在最多 24h 内被 1 次预占锁住额度。② `taskId` 只写本地草稿（§6.7.8），草稿触发是"操作后 1s 防抖/onHide/onUnload/导出前"；若在 `createEditTask` 返回后、下一次草稿保存前被杀进程，taskId 丢失，用户重试会生成新 token 再预占 1 次（旧任务靠 cleanup 才退）。③ 同一用户重复点导出（不同 clientToken、相同 plan）没有 `planHash` 兜底去重。
- **影响**：额度开关一旦上线，会出现"什么都没导出成功却少 1 次"的客诉；弱网/杀进程场景的比例不低（官方切后台 5s 中断）。
- **建议修改**：`createEditTask` 返回后**立即同步写 storage**（`editor_task_v1`），不等防抖；`getEditTask`/`cleanup` 增加"`queued` 或 `running` 且超过 90s 无 lease 更新 → failed + 退次"的惰性兜底；退次用 `quotaRefunded` 幂等标记；`planHash` 在 24h 内可作为二次去重（同 openid+planHash 且 succeeded 直接返回结果）；清理改为"每日 + 每次 create/analyze 顺带清理"，与 §8.3 的 10min 承诺一致。

### M3｜超时预算仍有多套数字，端到端 deadline 未定义【Major】

- **位置**：§4.1/§4.2（runEditTask ≤50s/≤55s）、§8.3（FFmpeg 45s、函数总预算 55s）、§8.4（timeout 45s）、§8.6（"FFmpeg 超 50s"）、§9.1（runEditTask ≤60s）、§9.2（55s）、§9.7（TIMEOUT >50s）、服务端惰性 75s、客户端轮询 90s、UX §11.4（"最长等待 60 秒"）。
- **问题**：云函数硬超时 60s，内部现在按"45s FFmpeg + 55s 总预算"设计，但还要覆盖：下载最多 ~100MB 源、`ffmpeg -i` 探测、上传 ≤50MB 成片、DB 写与冷启动；§9.1 又把 `runEditTask` 写成 ≤60s。没有一条明确的端到端断言（例如"下载≤8s + 探测≤1s + FFmpeg≤45s + 上传≤4s + DB≤1s，硬超时 60s"），也没有定义"函数被 60s 硬杀"与"客户端 90s 轮询窗口"的恢复路径。
- **影响**：AC-12（最坏 50s 内成功）无法判定按哪条预算；真机弱网/大文件时，函数被硬杀 → 任务停在 running → 75s 惰性 TIMEOUT，但客户端可能还在 90s 窗口内反复轮询，体验为"卡住后失败"。
- **建议修改**：v0.2 统一为"**硬超时 60s；函数内 deadline=55s；FFmpeg deadline=45s**"，并在 `runEditTask` 入口记录 `startedAt`，下载/探测后若剩余 <42s 直接 `TIMEOUT`（快速失败）；客户端轮询窗口 ≥ 75s+15s=90s 保持，但文案统一为"最长约 75 秒"；全文替换 50s 残留。

### M4｜多源拼接与「5 源 / 源总时长 1200s / ≤45s」缺少实测，且 §11.2 表与 §8.4 结论矛盾【Major】

- **位置**：§2.5-P0、§11.1（主轨 1–5 源、源总时长 ≤1200s）、§11.2（3×2min 16.7s「待 memo 给替代方案」、多源 ≤45s）、§8.4（"复杂 filter 加 `-filter_complex_threads 1`，3×2min 从 7.3s 劣化到 24~26s"）、memo §2.3/§5.1。
- **问题**：① 主文档 §8.4 已采纳 memo 的 `-filter_complex_threads 1`，也知道 3×2min 干净值 7.3s，但 §11.2 实测表仍保留 16.7s 并写"待 memo 给替代方案"——同一文档两套结论。② 所谓"最坏组合 22.7s"实际是**单源 2 段、280s 输出、1 个 BGM 输入**；没有 5 源、没有多源+BGM+变速叠加的实测。③ memo 最大只测到 3 源/6min 输出；§11.1 允许 5 源、源总时长 20min（3×6.7min 或 2×10min），P95 ≤45s 与"50s 预算可行"在这条路径上没有证据。
- **影响**：P1「语音拼接 ≤5 源」可能在实际长语音（5×3–4min）上超过 45s；如果到 M9.3 才发现，要么砍功能要么改架构（分段渲染/concat copy），正好落在 §14 的 2.5d 里。
- **建议修改**：M9.0 加一项 **SPIKE-E12：5 源 × 2/4min + 效果 + BGM 实测**；在结果出来前把 v1.1 产品上限收敛到 **≤3 源、源总时长 ≤900s**（或声明"5 源仅语音短句"）；更新 §11.2 表为"2×3min 7–8.1s / 3×2min 7.3–8.1s（fct1）/ 5 源待测"；删除"待 memo"字样。

### M5｜采样率/声道语义不闭合，快剪会静默忽略用户选择【Major】

- **位置**：§5.2 `export.sampleRate = 0（跟随源）/44100/48000`、`export.channels = 2/1`；§8.4 规则 0 快剪条件；§8.4 规则 1 "输出 `-ar {sr} -ac {ch}`"。
- **问题**：① `sampleRate=0` 在**多源**时没有定义（跟哪个源？）；§8.4 的 `{sr}` 也未定义解析规则。② 快剪条件只校验格式/码率/效果，**不校验 `sampleRate`/`channels`**：用户把 44.1k 立体声源导出为"48k/单声道"，只要无效果、同格式，仍走 `-c copy` → 输出仍是源参数，但结果卡会显示用户选择的 48k/单声道（或至少用户预期落空）。③ WAV 强制 44100 与用户选 48000 的关系未写清。
- **影响**：这是"用户设置了参数但文件没变"的静默错误，AC-10 会通过（只验快剪时长），用户下载后才发现采样率不对；多源不同采样率时 `-ar` 若按源解析还可能生成非法 concat 输入。
- **建议修改**：定义 `SR = export.sampleRate || source.sampleRate`（单源）、多源时 `SR = export.sampleRate || 44100`（或 max 源采样率，需在 §5.2 写明）；快剪条件追加 `(export.sampleRate===0 || export.sampleRate===source.sampleRate) && export.channels===source.channels`，否则重编码；加两条单测（44.1k→48k 必须重编码、mono 必须重编码）；WAV 输出显式 `-ar 44100 -ac 2`（与 §11.2 一致）。

### M6｜BGM 滤镜时序：`afade` 在 `adelay` 之前，正偏移时淡出位置错误【Major】

- **位置**：§8.4 规则 1 配乐链（`atrim → asetpts → volume → afade in/out → adelay`）与"顺序原则"（配乐链 `volume/afade/adelay` → amix）。
- **问题**：`startOffsetSec > 0` 时 `adelay` 把整条流（含已计算的 afade 包络）整体后移。淡出 `st = outputDur - fadeOut` 在 shift 后实际发生在 `outputDur - fadeOut + offset`，若超过 `-t outputDur` 则**淡出根本不发生**（被硬切）；同时 `atrim end = bgm.in + outputDur` 没有扣 offset，BGM 有效长度超出成片，被 `-t` 截断。memo §2.7/§6.2 的推荐顺序是 `stream_loop → adelay → atrim → asetpts`，与本设计相反。
- **影响**：BGM 偏移 >0 时导出结尾可能出现音乐硬切/爆音；预览（InnerAudioContext `startTime/seek`）与导出一致性变差（R-E3 概率上调）。
- **建议修改**：配乐链改为 `-stream_loop -1 → atrim(start=bgm.in, end=bgm.in+outputDur-offset) → asetpts → adelay(offset) → volume → afade(in/out, st 基于延迟后的成片时间轴)`；或保持 adelay 在 afade 前但把 `st_out` 改为 `outputDur - fadeOut - offset`；`adelay` 按输出声道数生成（mono 传 1 个值）；补 SVG/单测用例"BGM offset=5s、fadeOut=2s"。

### M7｜手势、画布尺寸与精度规格自相矛盾【Major】

- **位置**：§6.3 绘制方案文字 vs 同节"画布尺寸"表 vs UX §4.1/§5.1；§6.4 vs §7.3。
- **问题**：① 同一节里主轨高度出现 **88pt**（绘制文字）、**120rpx=60pt**（表格）、**276pt/552rpx**（UX §4.1 波形区）三种值；配乐轨 44pt vs 28pt vs 56pt，标尺 24pt vs 20pt vs 22pt。② §6.4 明确"单指拖波形=新建/调整选区（编辑优先）"，§7.3 却写"zoom>1 单指拖动=平移视口"，UX §5.2 又回到编辑优先。③ 缩放上限主文档 **40×**、UX **20×**；选区最小主文档 **0.2s**、UX **0.1s**；片段芯片长按主文档 **200ms**、阈值汇总与 UX **500ms**。④ 预览实例数主文档是 `mainA/mainB/bgm` **3 个**，CLIENT_CAPABILITIES §0.2-Q3 建议"2 个常驻（主轨+BGM）、禁止按片段创建"；S4 只验证双实例。
- **影响**：Canvas 组件尺寸、手势状态机、命中区、性能预算（重绘列数/DPR）都依赖这些数字；按不同文档实现会出现"拖不动/误触/选区拖不到 0.1s/多实例混播被系统限制"等问题，且 QA 无法判定哪个是预期。
- **建议修改**：v0.2 以 UX §4.1 为准重写 §6.3 的尺寸表（主轨 276pt、配乐 56pt、标尺 22pt，并重算 dpr 最大 1125×~700，仍 <1365）；写一张唯一的"手势状态机表"（touchstart 判定 → move → end），删除 §7.3 的 zoom>1 平移或明确改为"选区模式下编辑优先、浏览模式需显式切换"；统一 zoom 20×、选区最小 0.1s（或把服务端 V2 降到 0.1s，二选一）、长按 500ms；预览按 2 常驻实例设计，A/B 预加载只作为"可选优化"并列入 S4 扩展验证。

### M8｜P0 与用户首要场景错位：铃声/拼接/配乐/静音清理全在 P1，入口却已曝光【Major】

- **位置**：§2.3（首位场景"剪 30–40 秒做铃声/闹钟"）、§2.5-P0（只有裁剪/删除 + 淡入淡出/音量）、§2.5-P1（拼接/配乐/变速/铃声/静音清理）、§7.1（首页 4 个模板 chip）、§14.2-M9.3（P1 才排 2.5d）。
- **问题**：产品的差异化与"方便"主要来自模板（铃声、语音拼接、配乐），但 v1.1 P0 只覆盖"自由裁剪"；首页入口卡与 4 个模板 chip 在 P0 就要上线，P1 一旦延期就出现"入口点了没功能"或"做了 4 个空壳"。另外"3 步搞定"文案未计入上传 + 分析的 10–40s 等待，新用户预期会高。
- **影响**：v1.1 首发可能只是"一个比系统剪辑器弱的手动裁剪器"，留存/传播点不足；入口/文案承诺与 P0 能力不一致，审核与差评风险。
- **建议修改**：把**铃声模板（选区 0–40s + 淡出 + 命名）提到 P0**（它只是预置参数 + 40s 限额，服务端成本几乎为零），语音拼接视 M9.0 性能结论再定；模板 chip 用 feature flag 控制，未上线模板隐藏；入口文案改为"剪一段/套模板，2–3 步完成"，并在分析等待处明确"正在准备波形（约几秒）"。

### M9｜成功指标口径不可测/不可达：分析 P95 8s 含上传，AC-21 又不含上传【Major】

- **位置**：§2.4（"分析 P95 ≤8s｜点击选择文件 → 波形可交互（10min 内 mp3）"）、§6.10（"分析完成 P95 ≤3s/≤8s"）、§16-AC-21（"≤8s（不含上传）"）、CLIENT_CAPABILITIES §5.5（上传耗时：4G 下 10MB≈5–15s、50MB≈30–60s）、memo §2.9（10min 解码 4.06s）。
- **问题**：10min mp3 约 14.4MB，4G 上传 5–15s 已超 8s，指标"点击选择文件→波形可交互"不可达；而 AC-21 改成了"不含上传"，两处口径相反。另"3min 导出 P95 ≤25s"未标注是否含下载源+上传成片+排队。
- **影响**：上线后指标必然不达标，团队会被"指标失败"误导去优化服务端（实际瓶颈在上传）；验收时也会争论是否要算上传。
- **建议修改**：拆为三个 SLO：① 上传 P95（按 10MB/4G ≤15s）；② 分析（从上传完成到 peaks 返回）P95 ≤8s（依据 memo 4.1s + 下载/冷启动余量）；③ 首帧波形可交互 ≤300ms（本地数据）。导出 P95 标注"不含排队、含下载/上传"或分成"服务端渲染耗时 / 端到端耗时"两列；§2.4、§6.10、AC-21 同步改。

### M10｜排期与 Spike 清单明显不现实，WBS 加总也不一致【Major】

- **位置**：§14.2（M9.0 1.5d = 设计评审 + Spike）、§14.3（WBS 明细，合计写 10.5d）、§13.3（E1–E11）+ CLIENT §8（S1–S13）、TASK_PLAN §10.4（服务端矩阵约 60 组）。
- **问题**：① M9.0 的 1.5d 要包含设计评审 + **S1–S13 + E1–E11 共 24 项真机验证**（跨 iOS/Android/低端安卓/PC，含上传 50MB、切后台、锁屏、来电），不可能；而 §14.1 又把 Spike 列为 M9.0 前置条件，前后矛盾。② WBS 逐项相加为 **11.5d**（1.0+1.5+1.0+1.5+0.5+0.5+1.5+0.5+1.0+0.5+1.5+0.5），表内却写 **≈10.5d**；"AI 辅助 8–10 人日"更乐观。③ M9.2 3.0d 要完成编辑页 + Canvas 波形/手势 + 预览引擎 + 导出状态机，M9.4 2.0d 要完成 60 组矩阵 + 真机/弱网/合规/提审，低于同类项目经验值。
- **影响**：按 10.5d 排期会压缩测试与 Spike，正是 R-E1/E5 最容易暴露的阶段；延期后可能砍测试而非砍范围，带来线上问题。
- **建议修改**：Spike 单列为 **M9.0a（3–5d）**，设计评审 0.5–1d；WBS 重算并给出乐观/悲观区间（建议 **15–20 有效人日**），或明确砍掉 P1 的配乐/变速/静音清理；M9.0 通过标准写成"Spike 报告 + 5 源性能结论 + E1 真机录屏"。

### M11｜验收标准（§16）与测试计划（§13）覆盖不足、部分不可验收【Major】

- **位置**：§16.1–§16.4、§13.2–§13.5。
- **问题**：① AC 未覆盖：多源拼接（5 源）、BGM 混音、WAV 4min/FLAC 7min 边界、`sampleRate/channels` 快剪、取消导出、`queued` 未执行退次、taskId 被杀进程恢复、IDOR 越权、BGM offset/fade 时序；② AC-12 的"最坏组合"与真实最坏（多源+BGM+效果）不一致；③ AC-23（帧率）、AC-26（崩溃率）、AC-27（24h 清理）不是开发阶段可自动验收的，需标注"灰度/线上抽样"；④ AC-18 依赖尚未开通的内容安全权限，应标注条件；⑤ §13.2 服务端矩阵写"输入格式各 1 个（≤10min）"与 §11.1 的 WAV/FLAC 源限制不一致。
- **影响**：测试无法证明核心承诺；上线后才发现 AC-12 不成立；AC 与测试计划可能被开发理解为"可选项"。
- **建议修改**：按 §16 补 AC-28～AC-36（多源、BGM、格式边界、取消/退次、taskId 恢复、IDOR、参数快剪、BGM 偏移）；把 AC-12 改为"5 源 × 2min + BGM + 变速 + 淡入淡出，45s 内成功或按 §8.6 降级"；AC-23/26/27 标"上线灰度验收"；AC-18 标"权限开通后"。

### M12｜源文件归属校验不足，存在越权读取/导出他人音频的路径【Major】

- **位置**：§8.2 步骤 2（"ctx.OPENID；fileID 格式校验（cloud:// 前缀 + 去掉非法字符）"）、§4.2-A 步骤 2（上传到 `edit_sources/{rand}.{ext}`，路径不含 openid）、§5.3-V1、§10.1 `audio_analyses.openid`。
- **问题**：`analyzeAudio` 只校验 fileID 的字符串格式，不校验该 fileID 是否属于当前 openid / 是否由当前用户上传；上传路径是随机名，也没有 openid 绑定。只要 fileID 以任何方式泄露（客户端日志/抓包/调试工具/临时链接/历史记录等），他人即可对其 analyze、编辑并导出，形成"读他人音频"的越权链。设计的 `analysis.openid` 只保护"分析记录"本身，不保护底层源文件。
- **影响**：隐私合规风险（个人信息/内容），审核可能质疑；与 v1.0 直接上传模式相同，但编辑的 24h 源保留与转发扩大了暴露面。
- **建议修改**：上传路径改为 `edit_sources/{openid}/{rand}.{ext}`（openid 由服务端签发的上传票据/云函数换取，客户端不可伪造），或在上传后用 `converted_files(kind='edit_source',openid,fileID)` 建立归属记录；`analyzeAudio` 校验 `fileID` 前缀 + 归属记录 + 文件存在；`createEditTask` 再校验 analysis.openid；补 AC-19 的越权用例（他人 fileID → FORBIDDEN，不扣次）。

### m1｜WAV 上限在 4 处出现 4/4.7/4.9/5min 四种口径【Minor】

- **位置**：§3.1 E-C16（"50MB 内约 4.9min"）、§11.1（"WAV 源 ≤4min"）、§6.6（"WAV 源提示 ≤5min"）、UX §6.4（"实际可编辑约 4.9min"）、memo §5.1/§5.2（输出 4min≈42MB、源 4min）。
- **问题/影响**：4.9min 是 50MiB 口径、4.7min 是 50MB 十进制口径；输入/输出上限被混用，UI 提示与拦截值可能不一致。
- **建议**：统一为"**输入 WAV ≤4.7min（50MB）/ 输出 WAV ≤4min（42MB）**"，E-C16、§6.6、§11.1、UX 同步。

### m2｜M4A 限额存在 5/8/10min 三种说法，且与 UX 默认格式冲突【Minor】

- **位置**：§11.2（M4A 8min）、§15 R-E7（"m4a ≤5min"）、memo §5.1（10min）、DEV_LOG §3.1（旧数据 5min fast 20.2s / 默认 80.4s）、UX §7.8（M4A 为默认格式之一）。§8.4 写"10min 16.9s"、§11.2 表写 18.3s。
- **问题/影响**：同一格式三个上限，产品/QA 无法定拦截图；旧 DEV_LOG 数据会让实现者误以为 M4A 不可用。
- **建议**：统一 **M4A 8min（P1，2× 安全系数）**，R-E7 改 8min，UX 标 P1；memo/§8.4 注明"16.9s 干净值 / 18.3s 另一轮 / 竞争 35.9s"。

### m3｜分析等待/超时阈值 8/10/15/20s 四套【Minor】

- **位置**：§6.6（>8s 提示、>10s 重试 1 次）、§8.2（peaks 超时 15s）、§9.1/§9.2（客户端等待 ≤20s）、UX §10-S3/S6（>20s 失败）。
- **建议**：统一"分析预算 20s：8s 切文案、10s 重试 1 次、20s 失败；peaks 子步骤 15s"。

### m4｜peaks 写成 "int8" 但实际是 Uint8 0–255，接口缺 `buckets` 字段【Minor】

- **位置**：§6.3 数据格式、附录 B `computePeaks`、CLIENT_CAPABILITIES §2.3（也写 int8）。
- **问题/影响**：命名不一致会让实现者按 Int8Array 读取（负值/绘制错误）；附录算法返回 `buckets`，接口示例未返回，客户端无法校验长度。
- **建议**：统一"uint8 0–255"；接口回传 `buckets`（或客户端用 `ceil(duration*20)` 校验）；客户端 `base64ToArrayBuffer` 后断长度。

### m5｜iOS 单端 `playable` 门控误伤 Android；flac 输出在 iOS 结果页无法试听未提示【Minor】

- **位置**：§4.2-A 步骤 3（`playable = format ∈ {mp3,m4a,aac,wav}`，按 iOS 视角）、§6.9（"iOS 不支持播放源格式"）、§11.2（P0 允许 flac 导出）、UX §7.8（"高级格式部分手机不能试听"）。
- **建议**：改为 `playableIos`/`playableAndroid`（Android 可播 flac/ogg）；导出格式选 flac 时在确认层提示"iPhone 可能无法试听，可用电脑播放/转 MP3"；结果页对这些格式播放失败给降级文案。

### m6｜UX 页面清单基于不存在的页面，埋点/指标与主文档不一致【Minor】

- **位置**：UX §2.1（"复用现有 5 页：task/result/history…"）、主文档 §1.2（实际只有 `pages/index`、`pages/settings`；且写的 688 行实为 719 行）；主文档 §7.5 `editor_enter` vs UX §12 `editor_entry`；崩溃率主 <0.5%、UX <0.3%；主文档编辑操作中位数 ≤5 vs UX "3 次点击 ≥60%"。
- **问题/影响**：开发若按 UX 找 `pages/result` 入口会落空；事件名不一致导致漏斗无法拼合。
- **建议**：UX §2.1 按现实重写（index/settings + 新增 editor），"结果页/历史"改成"首页结果卡/历史弹窗"；v0.2 出一份事件字典与指标表，主/UX 共用；行数改为 719。

### m7｜导出文件名进入 cloudPath，隐私最小化不彻底；清理 TTL 表述不一致【Minor】

- **位置**：§8.3-B 步骤 7（`edit_outputs/{clean_name}_{taskId}.{ext}`）、§12.2（"日志不落文件名与完整 plan"）、§8.7/§10.3（`edit_tasks` 48h vs "保留脱敏摘要 7 天"）。
- **问题/影响**：cloudPath 里含用户文件名（如"夜曲_剪辑"），会出现在 fileID/日志/分享链接中，与"日志不落文件名"的最小化承诺不一致；`edit_tasks` 清理时间有 48h/7 天两说。
- **建议**：cloudPath 用 `edit_outputs/{taskId}.{ext}`，展示名 `result.fileName` 单独返回；`edit_tasks` 统一 48h 删除（如需 7 天排障另存脱敏摘要集合）。

### m8｜规范/编号小问题【Minor】

- **位置**：§3.1 约束编号从 E-C12 跳到 E-C14（缺 E-C13，但 §3.1 脚注又说 E-C13～E-C19）；§9 编号缺 9.5；附录示例的滤镜写法不统一（A1 无滤镜、A2/A3 用 `-filter_complex`、A5 用 `-af`），正文规则 1 又要求统一 `-filter_complex`。
- **建议**：补齐编号或改脚注；附录示例统一为 `-filter_complex`（或明确"单滤镜可用 -af"），避免实现者直接复制 A5 拼到多段计划时出错。

---

## 2. 数字核对表

> 图例：✅ 一致/有来源；⚠️ 部分一致或来源不足；❌ 不一致/无来源；❓ 待实测。

| # | 文档中的关键数字/结论 | 文档位置 | 声称来源 | 核对结果 | 判定 |
| :-- | :--- | :--- | :--- | :--- | :---: |
| 1 | 编辑源/成片 ≤10min（600s） | §2.5/§11.1/§17-Q2 | 用户决策 + 路线 A 60s | PRD FR-19、TASK_PLAN 一致；UX B4 一致（但多选 9/合计 10min 与主文档 5 源冲突） | ✅（源数除外） |
| 2 | 单文件 ≤50MB；输出 ≤50MB | §3.1-E-C16/§11.1/§11.2 | 产品假设 + v1.0 上传 | CLIENT §0.3/§5.5 明确 uploadFile 单文件上限"官方未标注"；memo/§11.2 也写"待实测 uploadFile 上限"；只有 6.87MB 实测 | ⚠️/❓ |
| 3 | WAV 10min 立体声 ≈106MB；50MB≈4.9min | §3.1-E-C16 | 44.1k×16bit×2ch 计算 | 计算 105.84MB 正确；50MB 十进制=4.7min、50MiB=4.95min，文档混用两种口径 | ⚠️（m1） |
| 4 | WAV 输出 ≤4min（≈42MB），源 ≤4min | §11.1/§11.2 | memo §5.1/§5.2（实测 280s=49.39MB） | 42.3MB 计算一致；但 §6.6 写"WAV 源建议 ≤5min"、UX 写 4.9min | ⚠️（m1） |
| 5 | FLAC 输出 ≤7min（45~50MB） | §11.2 | memo §5.1（真实音乐 700~900kbps） | 与 memo 一致；04:39 修订已用真实音乐口径替换前一稿的"10min≈26MB" | ✅ |
| 6 | M4A 上限 8min | §11.2 | memo 外推 10min + 2× 安全系数 | §15-R-E7 写"m4a ≤5min"；memo §5.1 写 10min；§8.4 写 16.9s、§11.2 写 18.3s | ❌（m2） |
| 7 | 分析 P95 ≤8s | §2.4/§6.10/AC-21 | 实测 4kHz 解码 10min=4.06s | §2.4 口径含上传（4G 14.4MB 上传 5–15s 已超 8s）；AC-21 又写"不含上传"；无端到端实测 | ❌（M9） |
| 8 | 纯重编码 60s/3min/5min/10min = 1.39/3.83/8.37/14.0s | §11.2 | memo §5.3 / exp12 TSV | exp12：1391/3829/8373/14004ms；第二次 14973ms | ✅ |
| 9 | 最坏组合 22.7s（干净 10.5s） | §11.2/§0/§8.4 | exp10/exp14 TSV | 22691ms / 10562ms 一致；但"最坏"=单源 2 段 280s，不含多源/BGM 叠加 | ✅ 数值 / ⚠️ 代表性（M4） |
| 10 | 2×3min 8.1s；3×2min 16.7s | §11.2 | 初测 TSV | 8107/16712ms；memo §2.3 加 `-filter_complex_threads 1` 后 7.3s；§8.4 同文写 7.3s | ❌（M4） |
| 11 | peaks：10min 解码 4.06s + Node 31ms + base64 32KB | §8.2/附录B | memo §2.9 / exp09 | exp09：4061ms、31.2ms、32000B | ✅ |
| 12 | 快剪精度：mp3 +17.4ms、m4a +0.5~6.1ms、wav +0.4ms；flac +81.6ms 且容器时长仍 180s | §8.4/§8.5 | memo §2.1/§4 | TSV 一致；本人在容器内复验 `-ss 30 -to 60`=30.015s、`-ss 30 -to 90`=60.029s（`-to` 语义正确） | ✅ |
| 13 | loudnorm 5min 21.5s / 10min 41.9s → P2 | §8.4/§11.2 | memo §2.5 / exp05 | 21511/41912ms 一致 | ✅ |
| 14 | 正式额度 5 次/日；测试期 `QUOTA_ENFORCED=false` | §0.6/§11.3/AC-15 | 用户 04:00 决策 | 代码 `QUOTA_ENFORCED=false`（ffmpegProbe/index.js:15）；UX 仍全部写死"5 次/日" | ❌（B3-5） |
| 15 | 分析限流 30 次/日 | §8.2/§11.3 | 设计自定护栏 | 无官方/实测来源；5 源编辑 6 次即触顶，UX 未提示 | ❓（m3/M4） |
| 16 | 排期 10.5 人日（AI 辅助 8~10） | §14.2/§14.3 | 自估 | WBS 12 项相加 = 11.5d；M9.0 1.5d 含 24 项 Spike；与 TASK_PLAN "12~14 人日 v1.0" 的粒度对比偏低 | ❌（M10） |
| 17 | 5 源拼接 P95 ≤45s；主轨源总时长 ≤1200s | §11.2/§11.1 | 无 | memo 最大 3 源/6min；无 5 源实测 | ❓（M4） |
| 18 | 输出 50MB 上传/云端耗时可控 | §11.2/§13.3-E8 | 未实测 | 50MB 级 uploadFile 只在 v1.0 测过客户端上传 6.87MB；服务端上传 50MB 未测 | ❓ |
| 19 | 现有 `pages/index` 688 行 | §1.2 | 代码 | 实际 719 行（`wc -l`） | ❌（小） |
| 20 | m4a 10min 纯编码 16.9s / 18.3s | §8.4/§11.2 | memo/exp12 | memo 16.9s（竞争 35.9s）；exp12 18.348s；文档同时出现两值 | ⚠️（m2） |
| 21 | 280s WAV 输出 49.39MB | memo §2.10 | exp10 | 49,392,078B 一致（WAV 4min≈42MB 由此推导） | ✅ |
| 22 | 5 分钟真实文件转码 15.1s | §1.1/DEV_LOG | DEV_LOG 02:42 | 一致（v1.0 同步链路） | ✅ |

---

## 3. 做得好的 3 点

1. **平台约束与证据链扎实，关键结论都有官方来源或实测数字。** 例如 `callFunction` 无客户端 timeout / 切后台 5s 中断（E-C11）、`InnerAudioContext.src` 2.2.3+ 支持 fileID、Canvas 2D 最大 1365×1365、WAV 10min≈106MB、peaks 10min≈32KB/4.1s、copy 裁剪 mp3 +17.4ms/flac 容器时长错误、loudnorm 10min 42s 等。**更难得的是 04:39 修订把 memo 的关键坑（SIGKILL、`-t`、`amix normalize=0`、`alimiter level=false`、flac 禁 copy、`-filter_complex_threads 1`、不显式 aresample）都吸收进了 §8.4/§8.5/R-E16~E18**，说明设计对实测反馈是开放的。
2. **架构克制、符合 60s/1CPU/低端机现实。** 端内不做编码/不整段解码；波形用服务端 peaks + 视口 Canvas（只画 ≤800 根柱，播放头用 view overlay 不重绘）；预览用 InnerAudioContext 顺序播放 + 音量渐变近似并明确"以导出为准"；导出用"快建任务 + 执行 + 轮询"而非一次长调用。这套选型在同类小程序里是最务实的组合，也避免了端内 PCM 200MB 的内存悬崖。
3. **产品与合规边界清晰，且有降级预案。** 无曲库/无公开分享/不提供在线听歌/不承诺设置系统铃声；个人主体 + 工具类目 + 备案 + 内容安全窗口策略都写清；对"音乐"命名可能被判文娱类目给出"更名音频剪辑 + 入口收进工具页"预案；提审话术与截图要求（避免第三方歌曲名/歌词）可直接用。此外，验收/Spike 体系可执行：S1–S13 + E1–E11 都有"方法/通过标准/不通过降级"，Given-When-Then 覆盖了主要导出/额度/隐私/合规路径，FFmpeg 脚本可复现（`run.sh` + 14 组实验 + 原始 TSV），这在个人项目里属于超配。

---

## 4. 建议的评审后修订顺序（最多 5 条）

1. **先关 B1/B2/B3，产出 v0.2 契约基线（0.5–1d）**：`edit_tasks` 增加 plan/planFileID；明确"§5.2+§9 是唯一 EditPlan/API 契约"；补 JSON Schema、planHash 规范化、状态机/错误码全表；取消语义二选一；把 UX 的 6 组硬冲突逐条标注"以主文档 v0.2 为准"并回写 UX/CLIENT/PRD。
2. **统一数字口径与端到端预算（0.5d）**：45/55/60s 三档预算写死；WAV/FLAC/M4A 源/输出边界、`SR` 解析、快剪参数条件、分析/导出 SLO 拆分；把本评审数字表作为 §11.2 的"来源列"附上（CLIENT/memo/现有代码），删除 688 行、16.7s 等过期数字。
3. **修 FFmpeg 剩余规则并补 5 源实测（M9.0 内）**：BGM 链改为 `stream_loop → atrim(扣 offset) → asetpts → adelay → volume/afade`；快剪条件补 sampleRate/channels；增加 SPIKE-E12（5 源 × 2/4min + 效果 + BGM，云函数内复测）；在结果出来前把多源上限收敛到 3 源/900s。
4. **收敛客户端交互与排期（1d 修订 + 3–5d Spike）**：统一画布尺寸/手势状态机/zoom/最小选区/长按阈值；P0 是否前移铃声模板由用户拍板（建议前移或 feature flag）；Spike 单列；WBS 重算为 15–20 人日区间并给砍范围选项；补 AC-28～AC-36。
5. **合规/安全收尾**：源文件 openid 归属（`edit_sources/{openid}/` 或上传票据 + 归属记录）；cloudPath 去文件名；埋点事件字典统一；隐私政策/用户协议补"编辑/混音/24h 删除"；提审材料按 §12.5 准备。完成后安排 0.5–1d 复审，通过即可启动 M9.1。

---

## 附录｜评审证据与假设

- **代码核对**：`cloudfunctions/ffmpegProbe/index.js`（410 行）确认 `DAILY_LIMIT=5`、`QUOTA_ENFORCED=false`、`MEDIA_CHECK_ENABLED=false`、`MAX_FILE_BYTES=50MB`；`miniprogram/` 只有 `index`、`settings` 两页；`pages/index/index.js` 719 行（非 688）。
- **FFmpeg 复验**：在当前 Docker 容器 `ffmpeg-spike`（1 CPU/1g）内用 `music_180s.mp3`：`-ss 30 -to 60 -i` 输出 30.014694s；`-ss 30 -to 90 -i` 输出 60.029388s。结论：输入侧 `-ss + -to` 的 `-to` 相对 seek 点，§8.4 规则 0 的写法结果正确，但建议改为 `-t (out-in)` 以免误读。
- **原始结果**：`/tmp/ffmpeg-spike-work/results/*.tsv`（exp01~exp14、analysis.jsonl）与 `samples/`。该目录为运行时临时目录，**未入库、可能被清理**；建议把关键 TSV（尤其 exp01/02/07/09/10/12/13/14）摘要归档进 `FFMPEG_EDIT_SPIKE.md` 附录或 `docs/research/` 下的结果快照，否则「数字有来源」在仓库内无法复核。
- **版本时点**：`FFMPEG_EDIT_SPIKE.md` 04:36 落盘、主文档 04:39/04:44 修订；本评审基于 04:44 版。若主文档继续修改，请以本文件中的章节号/字段名/数字为准重新核对；**B1/B2/B3 与 M1~M12 的结论建议在 v0.2 中逐条回应（接受/部分接受/拒绝+理由）**。
- 本评审只写 `docs/research/DESIGN_REVIEW.md`，未修改任何其他文件。
