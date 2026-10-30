# 音乐剪辑 · 云函数后端实现与本地实测（BACKEND）

> 版本：v1.1（2026-10-28，追加 v2 多源片段时间线）｜负责人：editor-backend（task-6 + task-8）
> 契约：[EDITOR_IMPL_CONTRACT.md](../EDITOR_IMPL_CONTRACT.md) §3（v1）/ §6.3（v2）｜实测依据：[FFMPEG_EDIT_SPIKE.md](../research/FFMPEG_EDIT_SPIKE.md)
> 结论先行：**analyzeAudio、renderEdit v1（单源 segments）与 v2（多源 sources[] + clips[] + 每片段缓入缓出）均已实现并通过本地 Docker 实测（静态 FFmpeg 7.0.2、1 vCPU/1GiB）；action 级 mock 端到端（真实 `exports.main` + mock 云 SDK）通过；`node --check`（Node 16）通过；旧 `convertFile/cleanup/probe` 回归通过；v1 请求行为完全保留。**

---

## 1. 实现位置

| 文件 | 内容 |
| :--- | :--- |
| `cloudfunctions/ffmpegProbe/index.js` | **v1**：`analyzeAudio()`（L235）、`renderEditV1()`（L402，原 v1 逻辑原样保留）、action 分发（`exports.main`，L725）；**v2**：`renderEdit()` 入口分发（L309，有 `sources`/`clips` 走 v2，否则 v1）、`renderEditV2()`（L315：多源下载/probe/clamp/渲染/上传）；`runFfmpeg()` 增加可选 `killSignal` 与 `timedOut/killed/signal` 返回值（L69，**旧调用不传 options，行为不变**） |
| `cloudfunctions/ffmpegProbe/lib/editor-core.js` | 纯函数核心（无第三方依赖）：v1 `parseProbeInfo / computePeaks / normalizeEditRequest / clampSegmentsToDuration / finalizePlan / buildFilterGraph / buildRenderArgs`；**v2** `normalizeRenderRequestV2`（L555）/ `clampClipsToSources`（L529）/ `applyClipFades`（L518）/ `finalizePlanV2`（L580）/ `buildFilterGraphV2`（L612）/ `buildRenderArgsV2`（L666）；随云函数目录一起部署，可本地 Node16 直接单测 |
| `scripts/editor-spike/test_pure.js` | 纯函数单测（146 条断言 = v1 91 + v2 55，宿主机 Node + `node:16-alpine` 各跑一遍） |
| `scripts/editor-spike/test_integration.js` | Docker + 静态 FFmpeg 7.0.2 实测（116 条断言：analyze 链路 / 删除拼接 / 淡入淡出 / 音量限幅 / 异常输入 / 10min 上限与耗时 / **v2 2 源 3 片 8s 拼接+每片 fade+顺序可调**） |
| `scripts/editor-spike/test_actions_mock.js` | action 级端到端（73 条断言）：mock `wx-server-sdk`（download/upload/DB/deleteFile）+ 真实 `exports.main` + 容器内 FFmpeg，覆盖 analyzeAudio、renderEdit v1/v2 全链路与 `probe/convertFile/cleanup` 回归 |
| `scripts/editor-spike/run.sh` | 一键复现（建容器→复制静态二进制→纯函数单测×2→Docker 实测→action 级 mock 实测） |

> 云函数部署包必须**包含 `lib/editor-core.js`**：用开发者工具「上传并部署」整个 `cloudfunctions/ffmpegProbe` 目录（不要只粘贴 index.js）。代码不引入任何 npm 依赖。

---

## 2. `analyzeAudio`

### 2.1 请求 / 响应（与契约 §3.1 一致）

```jsonc
// 请求
{ "action": "analyzeAudio", "fileID": "cloud://...", "fileName": "demo.mp3", "size": 123456 }

// 成功
{ "success": true, "data": {
  "duration": 120.03, "format": "mp3", "sampleRate": 44100, "channels": 1,
  "bucketMs": 50, "buckets": 2400,
  "peaks": { "peak": "<base64 uint8>", "rms": "<base64 uint8>" },
  "playableIos": true, "playableAndroid": true
}}
```

### 2.2 处理流程

1. 参数/大小检查（`event.size > 50MB` 直接 `FILE_TOO_LARGE`）；
2. `cloud.downloadFile(fileID)` → `/tmp/ed_analyze_*.ext`（空文件/下载失败 → `INVALID_FILE`；实际下载体积再校验 50MB）；
3. `ffmpeg -hide_banner -nostdin -i <file>` 解析 stderr 的 `Duration:` / `Audio:` 行。**该命令无输出参数，退出码恒为 1，不能以退出码判失败（spike 坑 P11）**；未打包 ffprobe；
4. `duration > 600s` → `DURATION_TOO_LONG`；无 `Audio:` 行 → `DECODE_FAILED`；stderr 命中坏文件特征（`Invalid data found` 等）→ `INVALID_FILE`；
5. 解码波形 PCM：`ffmpeg -v error -nostdin -y -i <file> -ac 1 -ar 4000 -f s16le <pcm>`（600s ≈ 4.58MB）；
6. 按 **200 samples（50ms）** 分桶：`peak=max|s16|/32768`、`rms=sqrt(mean(s²))/32768`，量化 uint8 0~255，`base64`；两数组等长，`buckets=ceil(样本数/200)`（600s = 12000 桶，peak+rms 共 24KB base64）；
7. `playableIos = format ∈ {mp3,m4a,aac,wav}`；`playableAndroid` 额外允许 flac/ogg；
8. `finally` 删除 `/tmp` 下输入与 PCM。

超时：probe 12s、解码 20s；实测 600s 音频 analyze 全流程 **3.1~4.7s**，远小于 20s。

### 2.3 真实 `-i` 解析示例（实测）

```text
$ ffmpeg -hide_banner -nostdin -i /work/samples/music_loud_quiet_120s_v2.mp3
Input #0, mp3, from '/work/samples/music_loud_quiet_120s_v2.mp3':
  Metadata:
    encoder         : Lavf61.1.100
  Duration: 00:02:00.03, start: 0.025057, bitrate: 192 kb/s
  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, mono, fltp, 192 kb/s
At least one output file must be specified        # ← 退出码 1，但不影响解析
```

`parseProbeInfo()` 解析结果：

```json
{"duration":120.03,"format":"mp3","sampleRate":44100,"channels":1,"codec":"mp3","container":"mp3","hasAudio":true}
```

`Duration` 缺失（如 `Duration: N/A`）时用解码样本数兜底：`duration = 样本数 / 4000`。

### 2.4 错误码

| code | 场景 |
| :--- | :--- |
| `INVALID_FILE` | 下载失败、0 字节、随机字节/坏容器（stderr 命中坏文件特征） |
| `FILE_TOO_LARGE` | 声明或实际 >50MB |
| `DURATION_TOO_LONG` | 源时长 >600s（10min） |
| `DECODE_FAILED` | 无音轨、解码失败/为空、解码超时、`Duration` 与音轨都解析不出 |
| `INTERNAL` | 未预期异常（统一用户可读文案，不暴露内部栈） |
| `PARAM_ERROR`（契约外的扩展） | 缺 `fileID`；前端正常流程不会触发 |

---

## 3. `renderEdit` v1（单源 segments，兼容保留）

### 3.1 请求 / 响应（与契约 §3.2 一致）

```jsonc
// 请求
{
  "action": "renderEdit", "fileID": "cloud://...", "fileName": "demo.mp3",
  "segments": [{ "in": 12.5, "out": 45.0 }, { "in": 60.0, "out": 90.0 }],
  "fadeIn": 0, "fadeOut": 1.5, "volumeDb": 0,
  "format": "mp3", "bitrate": "192k"
}

// 成功
{ "success": true, "data": {
  "fileID": "cloud://.../edited_audios/xxx.mp3",
  "fileName": "demo_剪辑.mp3", "size": 2531123, "duration": 62.5, "costMs": 8123
}}
```

### 3.2 校验（下载前先做便宜校验；下载后再按服务端真实时长 clamp）

- `segments` 必须是 1~20 段，每段 `{in,out}` 为有限数字，`0 <= in < out`，`out-in >= 0.2s`，总时长 `<= 600s`（否则 `PARAM_ERROR` / `DURATION_TOO_LONG`）；
- `format` 仅支持 `mp3`（MVP）；`bitrate` 白名单 `64k~320k`，非法值回退 `192k`；
- `volumeDb` 夹到 `[-60, +24]`（前端滑杆 -24~+12，正常值不受影响）；`0` 时省略 `volume` 滤镜；
- 淡入淡出：先按 `<=5s` 封顶，再保证 `fadeIn+fadeOut <= 成片时长`（与前端 `editor-utils.resolveFades()` 同规则，**客户端预览与服务端成片一致**）；
- 下载源 → probe 真实时长后：`out` 超出源尾自动 clamp（整段越界/有效长度 <0.2s → `PARAM_ERROR`）；并按 clamp 后的时长重算 `outDur` 与淡化上限；
- 源文件 >50MB → `FILE_TOO_LARGE`；成片 >50MB → `OUTPUT_TOO_LARGE`（mp3 192k 600s ≈14MB，仅兜底）。

### 3.3 FFmpeg 命令（实测通过的完整参数）

以契约示例（[12.5,45] + [60,90]，淡入 2s / 淡出 1.5s / -3dB，成片 62.5s）生成：

```bash
ffmpeg -hide_banner -nostdin -y -loglevel error -filter_complex_threads 1 \
  -i /tmp/ed_render_xxx.mp3 \
  -filter_complex \
  "[0:a]atrim=start=12.5:end=45,asetpts=PTS-STARTPTS[s0];\
   [0:a]atrim=start=60:end=90,asetpts=PTS-STARTPTS[s1];\
   [s0][s1]concat=n=2:v=0:a=1[cat];\
   [cat]afade=t=in:st=0:d=2,afade=t=out:st=61:d=1.5,volume=-3dB,alimiter=limit=0.95:level=false[out]" \
  -map "[out]" -map_metadata -1 -t 62.5 \
  -c:a libmp3lame -b:a 192k \
  /tmp/ed_render_xxx.mp3
```

要点（逐条对应 spike §2.4/§2.10/§3.1 与契约 §3.2）：

- 滤镜顺序：每段 `atrim+asetpts` → `concat` → **整体 afade（在 concat 之后，st 用输出时间轴：`st = outDur - fadeOut`）** → `volume` → `alimiter=limit=0.95:level=false`（必须 `level=false`，spike 坑 P6）；
- 不加显式 `aresample/aformat`（7.0 自动转换即可，spike 规则 6）；固定 `-filter_complex_threads 1` 防 1 vCPU 抖动（spike 坑 P7）；
- **永远带 `-t <outDur>`**（精确裁尾 + 防无限输出）；`-map_metadata -1` 去元数据；
- 进程：`runFfmpeg(args, 50000, { killSignal: 'SIGKILL' })` → 底层 `execFile(bin, args, { timeout: 50000, killSignal: 'SIGKILL', maxBuffer: 4MB, windowsHide: true })`。超时（`timedOut`）→ `TIMEOUT`；SIGTERM 对长任务不可靠，必须 SIGKILL（spike §3.1）；
- 输出 mp3：`-c:a libmp3lame -b:a 192k`；
- 上传 `edited_audios/{Date.now()}_{rand}.mp3`，返回 fileID（不返回长期 URL）；
- 写 `converted_files`：`{openid, fileID, size, format:'mp3', createdAt, kind:'edit_output'}`；首次写失败自动去掉 `kind` 字段重试一次，仍失败**不影响主流程**（集合/字段容错）；
- `finally` 删除 `/tmp` 输入/输出；返回 `costMs = 下载+探测+渲染+上传+DB` 耗时。

### 3.4 错误码

| code | 场景 |
| :--- | :--- |
| `PARAM_ERROR` | 缺 fileID、segments 非法、片段越界（clamp 后无效） |
| `DURATION_TOO_LONG` | 计划成片 >600s |
| `UNSUPPORTED_FORMAT` | `format` 不是 mp3 |
| `FILE_TOO_LARGE` | 源文件 >50MB |
| `INVALID_FILE` | 下载失败 / 坏文件 |
| `DECODE_FAILED` | 无音轨 / 解析不出 |
| `TIMEOUT` | FFmpeg 超过 50s 被 SIGKILL |
| `RENDER_FAILED` | FFmpeg 非 0 退出或输出不存在/为空 |
| `OUTPUT_TOO_LARGE` | 成片 >50MB |
| `INTERNAL` | 上传/DB/未预期异常（统一用户可读文案） |

### 3.5 `renderEdit` v2：多源片段 + 每片段缓入缓出（契约 §6.3）

v2 入口与 v1 共用 `renderEdit` action：**请求里出现 `sources` 或 `clips` 数组即走 v2**；否则按 v1 `segments` 处理（v1 行为完全不变）。

#### 3.5.1 请求 / 响应

```jsonc
// 请求（v2）
{
  "action": "renderEdit",
  "sources": [
    { "fileID": "cloud://...a.mp3", "fileName": "a.mp3", "size": 123456 },
    { "fileID": "cloud://...b.wav", "fileName": "b.wav", "size": 234567 }
  ],
  "clips": [
    { "sourceIndex": 0, "in": 0, "out": 12.5, "fadeIn": 1, "fadeOut": 0.5 },
    { "sourceIndex": 1, "in": 3.0, "out": 9.0, "fadeIn": 0, "fadeOut": 2 }
  ],
  "volumeDb": -3, "format": "mp3", "bitrate": "192k"
}
// 成功/失败响应与 v1 相同：{ success:true, data:{fileID,fileName,size,duration,costMs} } / { success:false, code, errorMessage }
```

- `clips` 顺序即成片顺序；同一 source 可被多个 clip 引用（分割/复用源文件）。
- **v2 不读顶层 `fadeIn/fadeOut`**（全局淡入淡出已改为每片段独立）；`volumeDb` 仍为全局音量。
- 返回的 `duration = Σ(out-in)`（clamp 后、fade 不改变时长）；`fileName` 取第一个源文件名 + `_剪辑.mp3`。

#### 3.5.2 校验与错误码

- `sources` 1~5 个，每源 `fileID` 必填、声明/实际 ≤50MB；`clips` 1~40 段，`sourceIndex` 合法；
- 每片 `0 <= in < out`、`out-in >= 0.2s`；成片总时长 ≤600s；`format` 仅 mp3、`bitrate` 白名单；
- 每片 `fadeIn/fadeOut`：≥0、≤5s；若 `fadeIn+fadeOut > clipDur` 等比缩到 `clipDur`（与前端同规则）；
- 下载后按**每个源的真实 Duration** clamp 片段 `in/out`（源尾越界自动截断；整段越界/残片 <0.2s → `PARAM_ERROR`）；
- 失败清理所有已下载源与输出（`finally`），错误响应 `{success:false,code,errorMessage}`。

| code（v2 新增/复用） | 场景 |
| :--- | :--- |
| `SOURCES_TOO_MANY` | 源文件 >5 个 |
| `CLIPS_TOO_MANY` | 片段 >40 段 |
| `PARAM_ERROR` | 缺 sources/clips、`sourceIndex` 越界、片段非法、源缺 fileID、clamp 后越界 |
| `DURATION_TOO_LONG` | 计划成片 >600s |
| `FILE_TOO_LARGE` | 任一源声明/实际 >50MB |
| `INVALID_FILE` | 某个源下载失败/坏文件（文案含"第 N 个源文件"） |
| `DECODE_FAILED` | 某个源无音轨/解析不出（文案含"第 N 个源文件"） |
| `UNSUPPORTED_FORMAT` / `TIMEOUT` / `RENDER_FAILED` / `OUTPUT_TOO_LARGE` / `INTERNAL` | 同 v1 |

#### 3.5.3 FFmpeg 命令（实测通过的完整参数）

示例：2 源 3 片（源0 被引用两次），`volumeDb=-3`，成片 8s：

```bash
ffmpeg -hide_banner -nostdin -y -loglevel error -filter_complex_threads 1 \
  -i /tmp/ed_render_s0_xxx.mp3 -i /tmp/ed_render_s1_xxx.mp3 \
  -filter_complex \
  "[0:a]asplit=2[s0_0][s0_2];\
   [s0_0]atrim=start=0:end=3,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1,afade=t=out:st=2.5:d=0.5[c0];\
   [1:a]atrim=start=1:end=4,asetpts=PTS-STARTPTS,afade=t=out:st=2:d=1[c1];\
   [s0_2]atrim=start=5:end=7,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.5,afade=t=out:st=1.5:d=0.5[c2];\
   [c0][c1][c2]concat=n=3:v=0:a=1[cat];\
   [cat]volume=-3dB,alimiter=limit=0.95:level=false[out]" \
  -map "[out]" -map_metadata -1 -t 8 \
  -c:a libmp3lame -b:a 192k \
  /tmp/ed_render_out_xxx.mp3
```

要点：

- **同源多片段先 `asplit`**（`[s:a]asplit=k[s<src>_<clipIndex>]…`，标签在引用前定义）；只引用一次的源直接用 `[s:a]`；
- **每片 fade 在 concat 之前、按片段本地时间轴**：淡入 `st=0`、淡出 `st=clipDur-fadeOut`（不是成片时间轴）；
- `concat=n=N:v=0:a=1[cat]` 后做**全局** `volume`（0 省略）+ `alimiter=limit=0.95:level=false`；
- 输出参数与进程护栏同 v1：mp3 libmp3lame 192k、`-map_metadata -1`、`-t totalDur`、`-filter_complex_threads 1`；`execFile` timeout 50000 + `killSignal:'SIGKILL'` + maxBuffer 4MB；
- 多源 `-i` 顺序与 `sources[]` 顺序一致，filter 里的 `[0:a]/[1:a]` 即对应。

---

## 4. 本地实测

### 4.1 环境与方法

- 宿主机 macOS + Docker 28.3.0；容器 `linuxserver/ffmpeg:latest`（**项目静态 FFmpeg 7.0.2** 复制进容器 `/tmp/bin/ffmpeg` 并 `chmod +x`，与云端"部署丢可执行位"的处理一致；
  容器内 ffprobe 9.0.2 仅用于**结果校验**，生产链路不依赖 ffprobe）；
- 资源限制 `--cpus=1 --memory=1g --memory-swap=1g`（容器内 `nproc=1`、`cpu.max=100000 100000`、`memory.max=1073741824`）；
- 测试样本：120s mp3（前 60s 幅度 0.8 FS 响段，后 60s 幅度 0.08 FS 轻段），由 lavfi 正弦+volume 生成。
  *踩坑记录：lavfi `sine` 源默认幅度只有 1/8，测试脚本用 `volume=6.4/0.64` 抬到目标幅度，并断言源峰值≈0.8FS 防止样本漂移。*
- v2 测试样本：源0 = 8s 440Hz 幅度 0.8FS（RMS≈144）、源1 = 6s 660Hz 幅度 0.2FS（RMS≈36）；幅度差 4 倍便于用波形 RMS 验证片段顺序与每片 fade 包络。
- 两层验证：
  1. `test_integration.js` 只执行 `lib/editor-core.js` 生成的 filter/args（与云函数运行时同一条代码路径），校验真实 FFmpeg 产物；
  2. `test_actions_mock.js` 用 mock `wx-server-sdk` + 真实 `exports.main` 跑完整 action 链路（下载→probe→解码/渲染→上传→DB→finally 清理），`child_process.execFile` 重定向到容器内静态 FFmpeg。
  *该 mock 测试实际发现并修复了 1 个 bug：源为 mp3 时 `renderEdit` 的 /tmp 输入/输出路径同名（`ed_render_<suffix>.mp3`），FFmpeg 会报 "output same as input"；已改为 `ed_render_in_*` / `ed_render_out_*`。*

### 4.2 命令

```bash
# 一键全量（纯函数单测 ×2 + 语法检查 + Docker 实测 + action 级 mock 实测，含 v1+v2）
# 干净环境热跑约 25s；冷启动约 65s（含首次生成 600s 样本 28s）；宿主竞争时会明显变慢（本轮实测 1m50s，仍全部通过）
bash scripts/editor-spike/run.sh

# 只跑纯函数单测（宿主机 Node + Node16 容器）
bash scripts/editor-spike/run.sh --pure

# 单独运行
node scripts/editor-spike/test_pure.js
docker run --rm --cpus=1 --memory=1g -v "$PWD":/repo:ro node:16-alpine node /repo/scripts/editor-spike/test_pure.js
node --check cloudfunctions/ffmpegProbe/index.js
docker run --rm -v "$PWD":/repo:ro node:16-alpine node --check /repo/cloudfunctions/ffmpegProbe/index.js
CONTAINER=ffmpeg-editor-spike WORK=/tmp/editor-spike-work node scripts/editor-spike/test_integration.js
CONTAINER=ffmpeg-editor-spike WORK=/tmp/editor-spike-work node scripts/editor-spike/test_actions_mock.js
```

> 本机若 `node` 不在 PATH：`NODE_BIN=/path/to/node bash scripts/editor-spike/run.sh`（脚本也会尝试 DSH 内置 Node）。

### 4.3 结果（全部通过）

| 套件 | 断言数 | 结果 |
| :--- | :--- | :--- |
| 纯函数单测（宿主机 Node 24） | 146（v1 91 + v2 55） | ✅ 0 fail |
| 纯函数单测（`node:16-alpine`，接近云端 16.13） | 146 | ✅ 0 fail |
| `node --check`（Node 16，index.js + lib + 测试脚本） | — | ✅ |
| Docker 实测（filter/args 层，v1+v2） | 116（首次 117，含样本生成断言） | ✅ 0 fail |
| action 级 mock 实测（真实 `exports.main` + mock 云 SDK，v1 回归 + v2） | 73 | ✅ 0 fail |

**关键实测数据**（`/tmp/editor-spike-work/results/editor-backend.tsv`；耗时含 `docker exec` 开销，冷/热容器两轮取范围）：

| 场景 | 计划时长 | ffprobe 时长 | 精确解码时长 | 耗时 | 备注 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| analyze 120s mp3（ffmpeg -i + 4kHz 解码 + 2400 桶 peaks） | — | — | — | **0.66~1.78s**（Node 算 peaks 17~34ms） | PCM 0.92MB，base64 4.8KB |
| analyze 600s mp3（12000 桶） | — | — | — | **2.12~4.74s**（干净环境；宿主竞争时本轮 8.6s；解码 2.1~8.6s + peaks 11~40ms） | 契约要求 ≤20s，余量 4 倍+ |
| 删除区间 concat：保留 [0,20]+[60,80]（响 20s+轻 20s） | 40.0s | 40.000 | 40.0000 | **0.90~2.51s** | 响段 RMS=136、轻段 RMS=14（源 144/14，删除/顺序生效）；max\|s\|=0.753FS 无削波；拼接点外最大相邻跳变 0.050（≈自然音频），首样本无直流突变 |
| 淡入 3s / 淡出 3s（单段 40s） | 40.0s | 40.000 | 40.0000 | **0.80~2.44s** | 0ms RMS<15% 稳态、1.5s≈50%、4s>90%、36.5s>90%、38.5s（淡出中段 st=37）≈50%、末尾<15% —— 淡入淡出均生效且 st 用输出时间轴 |
| volume -6dB（10s 片段） | 10.0s | 10.000 | 10.0000 | **0.26~1.40s** | RMS 比例 **0.501**（±0.05 内），与理论 10^(-6/20) 一致 |
| volume +12dB + limiter（10s 片段） | 10.0s | 10.000 | 10.0000 | **0.27~0.87s** | max\|s\|=0.931FS（limiter 0.95 生效），接近满幅样本 0 个 → **无硬削波** |
| **v2 多源 2 源 3 片**（源0[0,3]+源1[1,4]+源0[5,7]，每片 fade，volume -6dB → 8s） | 8.0s | 8.000 | 8.0000 | **0.25~0.40s**（宿主竞争时本轮 1.3s） | 响-轻-响 RMS≈68/17/68（源 144/36 ×0.501，顺序正确）；同源 asplit 两片电平均≈源0（Δ<0.15）；每片 fade 起点/中段/末尾包络全部符合（0ms<15%、1s>85%、2.75s≈50%、5.5s≈50%、6.25s≈50%、末尾<15%）；max\|s\|=0.377FS；拼接点外 maxDelta=0.024 |
| **v2 顺序可调**（反向：源1 轻→源0 响，2 片 4s） | 4.0s | 4.000 | 4.0000 | **0.19~0.21s**（竞争时 1.3s） | RMS 34→136（先轻后响），证明 clips 数组顺序即拼接顺序 |
| 异常输入 | — | — | — | — | 随机字节命中 `INVALID_FILE` 特征；空文件/无音轨 mp4 均判 `hasAudio=false`；无音轨视频不误判为坏文件 |
| 610s 输入 Duration 解析 | — | 610.0 | — | — | >600 → 走 `DURATION_TOO_LONG` |

> 表中的耗时包含 `docker exec` 进程开销与容器调度，真实云函数内只会有 FFmpeg 进程耗时，预计更低；10min 完整编辑（多段+淡入淡出+音量）按 spike §2.10 实测为 **10.5~22.7s**，当前 50s SIGKILL 超时留 2 倍+余量。

### 4.4 覆盖项清单

- ✅ `ffmpeg -i` 无输出时退出码恒 1，仍能正确解析 duration/format/sampleRate/channels；
- ✅ 50ms 桶 uint8 peak/rms、base64 两数组等长、`peak >= rms` 逐桶成立；源响/轻段 RMS 与幅度成正比；
- ✅ 输出 mp3 可完整解码（`-f null -` 返回 0）；成片时长误差 **0.000s**（≤0.2s 要求）；
- ✅ 删除区间/保留段顺序正确；拼接点无额外爆音；无削波；首样本无直流突变；
- ✅ 淡入淡出生效（含淡出 `st` 用输出时间轴，不会被提前）；
- ✅ volume -6dB 比例正确；+12dB 被 alimiter 限幅、无硬削波；
- ✅ 坏文件/空文件/无音轨分支判定正确；600s 上限与时长解析正确；
- ✅ action 级（mock 云 SDK）：`analyzeAudio` 返回结构/波形/`finally` 清理、`INVALID_FILE`/`DURATION_TOO_LONG`/`FILE_TOO_LARGE` 分支；`renderEdit` 全链路（下载→probe→clamp→渲染→上传→写 `converted_files(kind='edit_output')`→清理）、成片可解码且时长 40s、错误码 `PARAM_ERROR`/`DURATION_TOO_LONG`/`UNSUPPORTED_FORMAT`；
- ✅ **v2**：2 源 3 片拼接输出 8s 可解码、时长误差 0.000s；片段顺序（响-轻-响）与同源 `asplit` 两个片段都正确；每片 `fadeIn/fadeOut` 独立生效（起点/中段/末尾 RMS 包络）；反向排列后成片顺序随之改变；`SOURCES_TOO_MANY`/`CLIPS_TOO_MANY`/`PARAM_ERROR`/`DURATION_TOO_LONG`/`FILE_TOO_LARGE`/`INVALID_FILE`/`DECODE_FAILED` 分支正确；多源下载失败路径 `finally` 清理全部 /tmp；
- ✅ 回归：旧 `probe`（FFmpeg 7.0.2 可执行）、`convertFile`（120s mp3→mp3 128k，上传/时长/大小/台账/源文件清理）、`cleanup`（删除云文件+清台账）、**v1 `segments` 导出（40s）** 行为正常。

---

## 5. 已知限制 / 未做（MVP 范围）

1. **同步 MVP，未做两段式/异步任务**：`renderEdit` 在云函数内同步跑完（FFmpeg ≤50s）。云函数控制台超时需 **60s**（现有函数已按 60s 配置；`config.json` 未声明 timeout 字段，如新建函数请确认）。未实现"先建任务→轮询→取结果"的长任务队列。
2. **未实现 upload ticket（直传凭证）**：仍由客户端 `wx.cloud.uploadFile` 后把 fileID 交给云函数；云函数内 `cloud.downloadFile` 受 50MB 限制。
3. **仅导出 mp3**：`format` 非 mp3 返回 `UNSUPPORTED_FORMAT`；未开放 m4a/wav/flac 输出（后续复用 `TARGETS` 即可扩展）。
4. **未实现变速 / BGM / 响度标准化 / 多轨**：v2 已支持多源片段拼接与每片段缓入缓出（≤5 源、≤40 片），但仍是**单轨顺序拼接**；无变速、无 BGM 混音、无 loudnorm、无跨片段交叉淡化（拼接点为硬切，需要平滑可后续加 acrossfade）。
5. **v1 兼容策略**：带 `segments`（无 `sources/clips`）的请求走 v1 原逻辑（顶层 fadeIn/fadeOut 生效于整条成片）；带 `sources` 或 `clips` 的请求走 v2，**v2 忽略顶层 fadeIn/fadeOut**（淡入淡出改为每片）。前端 v2 应只发 `sources/clips`，不要再混发 `segments`。
6. **未接 quota / 内容安全**：编辑链路不计入每日次数（`QUOTA_ENFORCED=false` 的现状），成片未送 `security.mediaCheckAsync`（`MEDIA_CHECK_ENABLED=false`）；若上线需按合规要求补。
7. **未在真实微信云环境部署验证**：本地用静态二进制+容器模拟（Node16.13 语法/纯函数/action 层已覆盖，action 层通过 mock 云 SDK 跑通）；真实 `cloud.downloadFile/uploadFile/db` 的配额、超时与网络行为仍建议部署后 smoke test（建议先 `probe`，再选 1 个 30s mp3 走 analyzeAudio→renderEdit；v2 用 2 个短文件走一次多源导出）。
8. **服务端按 `Duration:` 估算值 clamp 段尾/片段尾**：个别容器 `Duration` 为估算（mp3 可能差几十 ms），输出用 `-t` 精确裁到尾；实测 v1 40s/10s、v2 8s/4s 成片误差 0.000s。若源时长 `<1s` 或极小片段，`parseProbeInfo` 的 duration 精度有限，前端已在选择阶段做最小片段校验。
9. **多源下载串行**：v2 逐个 `cloud.downloadFile` + `probe`（1~5 个源），最坏 5×50MB 下载会显著占用 60s 预算；MP3 10min 源合计通常 <75MB，实测 2 源毫秒级下载（mock）；真实云环境建议前端控制总上传体积并在产品层限制总时长（已限 600s 成片）。
10. **cleanup 策略不变**：`converted_files` 的定时清理（默认 24h）同样会清理 `kind='edit_output'` 的成片云文件；如需长期保留需调整清理策略/加 kind 过滤。
11. **analyze 的 `costMs` 不返回**（严格按契约字段）；`renderEdit` 返回 `costMs`（前端已用于展示）。
12. 未做重复提交幂等/并发限制；前端已有防重复点击，服务端未加锁。

---

## 6. 前端调用注意事项

1. **action 名大小写固定**：`analyzeAudio` / `renderEdit`（云函数 `ffmpegProbe`，`wx.cloud.callFunction({ name:'ffmpegProbe', data:{ action } })`）。
2. **analyzeAudio 响应**：`res.success === true` 时取 `res.data`。`peaks.peak / peaks.rms` 是**标准 base64** 的 uint8 数组（长度 = `buckets`，允许尾部无/有 `=` padding）；每桶 50ms（`bucketMs`），画布按 `秒 → 桶 = floor(t*1000/50)` 映射；`buckets*50ms` 可能比 `duration` 多不足 1 桶（解码尾部 padding），用 `duration` 做时间轴、不要用 `buckets` 反推时长。
3. **`duration` 保留 3 位小数**（如 245.612）；analyze 对 >600s 直接返回 `DURATION_TOO_LONG`，前端选择阶段应先按文件大小/已知时长预筛，省一次上传+分析。
4. **playableIos/Android**：按容器格式映射（mp3/m4a/aac/wav 平台都可播；flac/ogg iOS=false / Android=true）；未知格式两边都 false —— 前端按契约给"iPhone 不支持该格式试听"的提示即可。
5. **v1 `segments` 是"保留段"**，按成片顺序传 `{in, out}`（秒，建议保留 3 位小数），不要传删除段；服务端会按真实源时长 clamp `out`（允许客户端传满整段而不用先扣减）。**v2 请改用 `sources[] + clips[]`**（见下）。
6. **服务端返回的 `duration` 是 clamp 后的实际计划时长**（可能比客户端 `totalDuration(plan)` 略小几十 ms）：前端应以 `res.data.duration` 更新结果区时长。
7. **v1 淡入淡出规则前后端一致**：`fadeIn/fadeOut` 先按 ≤5s 封顶、再按 `fadeIn+fadeOut <= 成片时长` 等比缩短（与 `editor-utils.resolveFades` 相同）；**v2 改为每片独立 fade**，收敛规则为「≤5s + `fadeIn+fadeOut <= 该片时长` 等比缩」，与前端片段 fade 规则一致，预览与成片不会偏差。
8. **错误映射**：统一优先展示 `res.errorMessage`（服务端已给用户可读中文）；程序分支可看 `res.code`：`DURATION_TOO_LONG / FILE_TOO_LARGE / INVALID_FILE / DECODE_FAILED / TIMEOUT / RENDER_FAILED / UNSUPPORTED_FORMAT / OUTPUT_TOO_LARGE / PARAM_ERROR / INTERNAL`，v2 额外有 `SOURCES_TOO_MANY / CLIPS_TOO_MANY`。注意 `TIMEOUT` 只在 renderEdit 出现。
9. **返回只有 fileID**：试听/转发前需 `wx.cloud.downloadFile({fileID})` 拿临时路径（分享的点击时序限制见契约 §4）；不要依赖 `getTempFileURL`（服务端未返回）。
10. **部署清单**：整个 `cloudfunctions/ffmpegProbe` 目录（含 `lib/editor-core.js`、`bin/ffmpeg`、`package.json`）一起上传；确认函数超时 60s、内存 ≥512MB（实测 ffmpeg RSS <50MB，975MB 配置充裕）；部署后先用 `{action:'probe'}` 验证函数与二进制正常，再走剪辑链路。
11. **fileName 建议带扩展名**（仅用于 /tmp 临时文件命名与兜底格式提示；真正的格式判定以 FFmpeg 内容嗅探为准，扩展名不可信 —— spike 坑 P16）。
12. 前端上传路径 `edit_sources/...`、后端成片路径 `edited_audios/...` 均由服务端/客户端各自负责，不要混用 cleanup 逻辑。
13. **v2 请求形态（多源剪辑，契约 §6.3）**：
    ```jsonc
    { "action": "renderEdit",
      "sources": [{ "fileID": "cloud://...", "fileName": "a.mp3", "size": 123456 }], // 1~5 个
      "clips":   [{ "sourceIndex": 0, "in": 0, "out": 12.5, "fadeIn": 1, "fadeOut": 0.5 }], // 1~40 片
      "volumeDb": -3, "format": "mp3", "bitrate": "192k" }
    ```
    `clips` 数组顺序即成片顺序；同一 `sourceIndex` 可被多个 clip 引用（分割/复用源）；`sourceIndex` 是 `sources` 的 0 基下标。
14. **v2 忽略顶层 `fadeIn/fadeOut`**（全局淡入淡出已移除）；只传每片的 `clip.fadeIn/fadeOut`。每片 fade 0~5s，服务端按 `min(5, 片段时长)` 与「两段之和 ≤ 片段时长」等比收敛，与客户端规则一致。
15. **v2 校验前置**：前端应保证 ≤5 源、≤40 片、单片 ≥0.2s、成片 ≤600s、每源 ≤50MB；服务端仍会兜底校验并以真实源时长 clamp 片段 `out`。源文件被清理/过期时返回 `INVALID_FILE`（文案含"第 N 个源文件"）。
16. **v1/v2 不要混发**：带 `sources` 或 `clips` 即走 v2，此时旧 `segments` 不生效；编辑页升级后统一发 v2。旧版 v1 `segments` 请求仍可用（服务端保留完整 v1 逻辑）。
17. **v2 fileName**：服务端默认返回 `第一个源文件名_剪辑.mp3`；结果区如需自定义命名可前端覆盖展示。
18. **v2 性能**：一次 filter_complex 完成全部片段；实测 2 源 3 片（8s 成片）渲染 0.2~0.4s；多源更多片段成本随总时长线性增长，600s 上限内仍在 50s FFmpeg 预算内（spike 单源 10min 完整编辑 10.5~22.7s）。

---

## 7. 与 spike 坑清单的对应（实现自检）

| spike 坑 | 本实现 |
| :--- | :--- |
| P1 无限输入无 `-t`+SIGTERM 杀不掉 | 所有渲染固定 `-t outDur`；`execFile` 显式 `killSignal:'SIGKILL'`、timeout 50s |
| P2 flac copy 时长错误 | 编辑一律重编码，不用 `-c copy` |
| P3 afade 在 atempo 前 | 顺序固定 `atrim→concat→afade→volume→alimiter`，`st=outDur-fadeOut` |
| P4 loudnorm | 未使用 |
| P5 amix normalize | 未使用（无 BGM） |
| P6 alimiter 默认 level=1 | 固定 `alimiter=limit=0.95:level=false` |
| P7 显式 aresample+默认线程抖动 | 不写 aresample/aformat；`-filter_complex_threads 1` |
| P3' v2 同源多片段不能重复引用同一输入流 | 同源片段先 `[s:a]asplit=k[...]` 分发（实测 2 源 3 片、源0 两段引用正常，两片电平均≈源） |
| v2 每片 afade 时间轴 | 每片 fade 在 concat 前、`st` 用**片段本地时间轴**（淡出 `st=clipDur-fadeOut`）；与 v1 全局淡出语义不同，已分别实现 |
| P9 copy 多段漂移 | 不用 copy；filter concat，实测时长误差 0ms |
| P10 out_time_ms 是 µs | 未解析 progress |
| P11 `-i` 退出码恒 1 | 按 stderr 解析，忽略退出码（已实测验证） |
| P15 WAV 输出体积 | MVP 只输出 mp3；成片 >50MB 兜底拦截 |
| P16 扩展名不可信 | 以 `ffmpeg -i` 内容嗅探为准（wav 改名 .mp3 也能正确识别） |
