# FFmpeg 剪辑链路实测报告（在线音乐编辑 · 路线 A）

> 版本：v1.0（2026-10-28）｜实测人：ffmpeg-spike（task-2）
> 环境：微信云开发云函数（Node 16、1 vCPU、975MB、/tmp 512MB、60s 超时）+ 项目静态 FFmpeg 7.0.2
> 结论全部来自**真实命令实测**；命令、脚本、原始 TSV 可复现：`scripts/ffmpeg-spike/`
> 关联：[TASK_PLAN](../TASK_PLAN.md) §3/§4、[DEV_LOG](../DEV_LOG.md) §3.1、`cloudfunctions/ffmpegProbe/index.js`

---

## 0. 结论先行（TL;DR）

### 0.1 一句话结论

**路线 A 的 60s 云函数完全够用**：10 分钟主音频的「多段裁剪/删除 + 拼接 + 整体淡入淡出 + 音量 + 1.5x 变速 + 1 分钟 BGM 循环混音 + 限幅」一条 `filter_complex` 实测 **10.5~22.7s**（冷/竞争环境取高值），最坏情况留有 2~4 倍余量；**纯 10min mp3→mp3 192k 重编码 14.0~14.9s**。真正的风险不在耗时，而在 **copy 快剪的精度/容器时长**、**无限输入命令（BGM 循环）缺 `-t` 会让输出无限增长且 SIGTERM 杀不掉**、**loudnorm 极慢（10min 单遍 42s）** 这三处。

### 0.2 12 组实验关键结论速查

| # | 实验 | 关键结论 | 10min 输入耗时 |
| :-- | :--- | :--- | :--- |
| 1 | copy 裁剪 vs atrim 重编码 | copy 快（40~150ms）但精度受帧对齐限制；**flac copy 容器时长错误（60s 文件仍报 180s）→ 禁用**；atrim 重编码精度 0~1ms | copy ≤0.15s / 重编码 1.9s(裁 60s) |
| 2 | 删除中间区间 | filter concat 重编码 120s 输出 **2.45s**，精确 120.000s；copy+concat demuxer 仅 0.12s 但时长 +23.9ms、多次拼接会漂移 | 5min 输入删段 4.7s |
| 3 | 多文件拼接 | 单 filter concat 即可；**不要显式堆 `aresample/aformat`**（7.0 自动转换更快）；显式归一 + 默认 filter 线程在 1 核下会劣化到 24~26s，加 `-filter_complex_threads 1` 后稳定 7.3s | 6min 输出 ~7.3s |
| 4 | afade | 顺序必须是 **atempo 之后**；`st` 以输出时间轴计算；错误顺序淡出会提前到 38s（期望 77s） | 附带在完整计划内 |
| 5 | volume/alimiter/loudnorm | `alimiter` 必须 `level=false`；**loudnorm 极慢**（5min 单遍 21s、10min 42s），默认还会改采样率（wav 输出变 192kHz）→ 仅 ≤3min | 单遍 42s（不可接受） |
| 6 | atempo 变速 | 3min→1.5x 仅 3.0s，保持音调（实测基频比 1.000）；>2 需串联；`rubberband` 慢 3.3 倍；变调用 asetrate | 变速输出 280s ≈ 3.5s |
| 7 | BGM 混音 | `-stream_loop -1 + atrim + amix=duration=first:normalize=0 + alimiter + -t` 3min 输出 4.5s；`aloop` 内存 ×2；sidechaincompress 可用 4.9s | 完整计划 10.5~22.7s |
| 8 | silenceremove | 语音/铃声前后静音有效（64→60.0s）；去中间间隙需调 `stop_duration/stop_silence`；音乐中的"安静段"容易误判 | 不用于长音乐 |
| 9 | 服务端波形 peaks | 10min mp3 → 4kHz mono s16le **4.06s**（4.8MB /tmp），Node16 无依赖算 12000 桶 **31ms**，int8 peak+rms base64 **32KB**（仅 peak 16KB） | 总计 ≈4.1s |
| 10 | 一条命令完整编辑 | 3min→100s 3.5s；5min→160s 5.4s；10min→280s **10.5s/22.7s**；m4a 9.9s、wav 6.2s、flac 6.3s | ✅ <50s |
| 11 | ffprobe/异常 | 必须校验音频流存在；扩展名不可信（wav 改 .mp3 正常解码）；0 字节/随机字节/无音轨分别有明确错误 | <0.25s |
| 12 | 工程护栏 | `-progress pipe:1` 可用（注意 `out_time_ms` 实际是 µs）；`-filter_complex_threads 1` 防 1 核线程抖动；SIGTERM 对无限输入**无效，必须 SIGKILL** | — |

### 0.3 最危险的 3 个坑

1. **BGM 无限循环缺 `-t` → 输出无限增长 + SIGTERM 杀不掉**：`duration=longest` + `-stream_loop -1` 实测跑了 235s，写出 **259MB / 10824s 音频**（/tmp 512MB 会被吃光）；`timeout -s TERM 3` 后 9s 仍未退出，**只有 SIGKILL 有效**。→ 所有命令强制 `-t <输出时长>`，`execFile` 必须 `killSignal:'SIGKILL'`。
2. **flac `-c copy` 裁剪的容器时长不更新**：60s 输出 `ffprobe format.duration=180.001`（源时长），实际解码 60.08s。客户端会显示错误时长、seek 越界。→ **flac 快剪禁用，改重编码**（10min 仅 +2.6s，代价极小）。
3. **`alimiter` 默认 `level=1` 会自动增益、`loudnorm` 默认改采样率（wav→192kHz）**：不是报错型 bug，静默改变听感/文件参数。→ 固定写 `alimiter=limit=0.95:level=false`；loudnorm 后强制 `-ar 44100`，且仅 ≤3min 使用。

### 0.4 定稿答案（供设计文档直接引用）

| 问题 | 定稿 |
| :--- | :--- |
| 10min 最坏组合能否 <50s | **能**。实测 10.5s（干净环境）/ 22.7s（宿主竞争），留 2~4 倍余量；建议云函数内 FFmpeg 超时 45s、任务总超时 60s |
| 多源拼接推荐 | **单条 `filter_complex` concat**（7.0 自动转换已够快、时长精确 360.002s）；仅在"全部源参数完全相同且完全无效果"时才考虑分段重编码+concat demuxer copy（无收益，且 +66ms 漂移） |
| copy 快剪白名单 | **mp3 / m4a / wav 可用**（精度 mp3 ≤26ms、m4a ≤7ms、wav 0.4ms）；**flac 禁用**（容器时长错误）；ogg/opus 未测不开放；一旦有任何效果（淡入淡出/音量/变速/混音）必须重编码 |
| 格式×时长上限 | 见 §5 表：输出 mp3≤20min、m4a≤10min、flac≤7min、wav≤4min（50MB 硬限）；输入 10min 时仅 WAV(>50MB)/高码率 FLAC 需额外校验 |
| loudnorm | 从 V1.1 移除或**仅限 ≤3min**（单遍 ~5~21s、双遍 3min ≈14s）；>3min 用 `volume` + `alimiter` |
| peaks | 10min：解码 4.06s + Node 31ms，base64 32KB（50ms 桶、int8 peak+rms）；建议 4kHz/50ms |

---

## 1. 实验环境与方法

### 1.1 运行时

| 项目 | 值 |
| :--- | :--- |
| 宿主机 | macOS + Docker 28.3.0（Docker Desktop，linuxkit 6.10 内核） |
| 容器 | `linuxserver/ffmpeg:latest`（Ubuntu 基础，镜像内 ffmpeg/ffprobe **9.0.2**） |
| **待验证二进制** | `cloudfunctions/ffmpegProbe/bin/ffmpeg`：**7.0.2-static**（johnvansickle），79,826,272 B，Linux x86_64；复制进容器 `/tmp/bin/ffmpeg` 并 `chmod +x` 后可直接运行（与云端相同处理方式），`-version` 正常 |
| 资源限制 | `--cpus=1 --memory=1g --memory-swap=1g`（cgroup v2 `cpu.max=100000 100000`、`memory.max=1073741824`），容器内 `nproc` **仍报 12**（这是后文线程坑的根因） |
| 校验工具 | 镜像内 `ffprobe 9.0.2`（项目未打包 ffprobe，生产校验用 `ffmpeg -i` 解析或另行打包） |
| Node | `node:16-alpine`（v16.20.2，接近云端 16.13），`--cpus=1 --memory=1g` 下运行 peaks 脚本 |

> **静态二进制验证**：项目二进制在容器内 `-version`、`-filters`、`-encoders` 全部正常；`afade/atempo/amix/adelay/aloop/loudnorm/alimiter/silenceremove/concat/atrim/acrossfade/rubberband/sidechaincompress` 等本报告用到的滤镜全部存在（`rubberband` 也在静态构建内）。libmp3lame / native aac / flac / libvorbis / libopus 全部编码器可用，mp3/mp4/ipod/wav/flac/ogg/adts 封装可用。

### 1.2 测试样本（可复现，`scripts/ffmpeg-spike/gen_samples.sh`）

内容：A 大调和弦 110/220/277.18/329.63Hz + 粉噪 + 0.15Hz tremolo，44.1kHz 立体声（避免纯静音/纯单音，让编码器、波形、响度更接近真实音乐）。

| 样本 | 时长 | 大小 | 用途 |
| :--- | :--- | :--- | :--- |
| `music_600s.wav`（母带） | 10:00.000 | 105.8MB | 派生所有样本 |
| `music_{60,180,300,600}s.mp3`（192k） | 1/3/5/10min | 1.44 / 4.32 / 7.20 / 14.40MB | 主测试样本 |
| `music_{60,180,300,600}s_128.mp3` | 同上 | 0.96 / 2.88 / 4.80 / 9.60MB | 低码率对比 |
| `music_{60,180,300,600}s.m4a`（aac fast 192k） | 同上 | 1.46 / 4.36 / 7.27 / 14.55MB | m4a 链路 |
| `music_{60,180,300,600}s.flac`（level5） | 同上 | 2.58 / 7.72 / 12.87 / 25.73MB | flac 链路 |
| `music_{60,180,300,600}s.wav` | 同上 | 10.58 / 31.75 / 52.92 / 105.84MB | wav 链路 |
| `ringtone_40s.wav/.mp3` | 40s | 7.06MB / 0.96MB | 1.2s 响 / 0.8s 数字静音，铃声/静音场景 |
| `voice_64s.mp3` | 64s | 1.54MB | 前后各 2s 静音，语音场景 |
| `edge_8k_mono.wav` | 30s | 0.48MB | 8kHz 单声道（旧素材归一化） |
| `beeps_180s.*` | 180s | — | 每秒 200ms/1kHz 标记音（测 ms 级裁剪偏差） |
| `sine_440_5s.wav` | 5s | — | 变速/变调基频验证 |
| 异常样本 | — | 0B / 50KB / 3.3KB / 2.9KB | 空文件、随机字节、wav 改 .mp3、无音轨 mp4、0.3s 超短 |

### 1.3 测量方法

- **耗时**：`ffmpeg -benchmark` 的 `rtime`（进程实际耗时）+ shell 墙钟（含进程启动），每个关键命令跑 **2~3 次取稳定值**；表格中同时给出 2 次数据的地方说明有宿主竞争。
- **内存**：`-benchmark` 输出的 `maxrss`（ffmpeg 进程 RSS 峰值，不含 Node 父进程）。实测 18~50MB，loudnorm 144MB，`aloop` 50MB —— 与 975MB 限额相比非常安全。
- **精确时长**：完整解码 `a:0` → s16le 单声道，按字节数/采样率计算（比 `ffprobe format.duration` 更可信，尤其 mp3/m4a 的帧对齐与估算时长）。
- **爆音**：解码拼接点前后 3s 为 44.1kHz 单声道 PCM，统计相邻样本最大跳变（自然音频在 44.1k 下通常 <0.02；硬拼接爆音会接近 0.5~2）。
- **音调**：自相关估计基频，比较输出/输入基频比（1.000 = 保持音调）。
- **已知噪声源**：本机 Docker 共享宿主 CPU，其他进程活跃时同一命令可慢 **2~3 倍**（例：10min 最坏组合 22.7s vs 10.5s；3×2min concat 11.7/24/26s vs 7.3s）。表内以"干净值"为准并给出波动范围；云端独占 vCPU 预期更稳定。

> **与 DEV_LOG §3.1 的差异（重要）**：DEV_LOG 记录 5min mp3→M4A（fast）20.2s、默认 coder 80.4s。本次同规格实测（静态 7.0.2、1CPU、mp3 输入）：**fast 5min 6.6~8.1s，10min 16.9s（另一次竞争环境 35.9s）；默认 coder 5min 9.5s**。差异可能来自样本内容/测量口径/宿主竞争。设计文档请以本报告为准，并对 **m4a 保留 ≥2 倍安全系数**。

---

## 2. 命令库（12 组，可直接复制）

> 约定：`$IN` 输入、`$OUT` 输出、`$T` 时长（秒）。云函数中调用项目静态二进制时统一加：`-hide_banner -nostdin -y -loglevel error -filter_complex_threads 1`。
> 输出参数沿用 `index.js` TARGETS：mp3 `-c:a libmp3lame -b:a 192k`、m4a `-c:a aac -aac_coder fast -b:a 192k -movflags +faststart`、wav `-c:a pcm_s16le -ar 44100 -ac 2`、flac `-c:a flac -compression_level 5`。

### 2.1 裁剪：copy 快剪 vs atrim 重编码（实验 1）

```bash
# A. 流拷贝快剪（输入 seek；推荐写法）
ffmpeg -hide_banner -nostdin -y -ss 30 -t 60 -i "$IN" -c copy "$OUT"

# B. 精确重编码裁剪（任意格式 → 任意格式）
ffmpeg -hide_banner -nostdin -y -i "$IN" \
  -af "atrim=start=30:end=90,asetpts=PTS-STARTPTS" \
  -c:a libmp3lame -b:a 192k "$OUT"
```

| 方法 | 格式 | 请求时长 | **精确解码时长** | 偏差 | 容器时长(ffprobe) | 可解码 | 耗时(3min 输入) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| copy `-ss 30 -t 60` | mp3 192k | 60.000 | 60.0174 | **+17.4ms** | 60.029388 | ✅ | 52ms |
| copy `-ss 30 -t 60` | mp3 128k | 60.000 | 60.0174 | +17.4ms | 60.029388 | ✅ | 45ms |
| copy `-ss 30 -t 60` | m4a | 60.000 | 60.0005 | **+0.5ms** | 60.000000 | ✅ | 48ms |
| copy `-ss 30 -t 60` | flac | 60.000 | 60.0816 | **+81.6ms** | **180.001088 ❌** | ✅ | 63ms |
| copy `-ss 30 -t 60` | wav | 60.000 | 60.0004 | +0.4ms | 60.000363 | ✅ | 113ms |
| copy `-ss 0 -t 60` | mp3 | 60.000 | 60.0043 | +4.3ms | 60.016327 | ✅ | 91ms |
| copy 输出 seek `-i X -ss 30` | mp3 | 60.000 | 59.9913 | −8.7ms | 60.003265 | ✅ | 57ms |
| copy `-avoid_negative_ts make_zero` | m4a | 60.000 | 60.0236 | +23.6ms ❌ 别加 | 60.023583 | ✅ | 45ms |
| **atrim 重编码** | mp3 | 60.000 | **60.0000** | 0.0ms | 60.000000 | ✅ | **1.24s** |
| **atrim 重编码** | m4a fast | 60.000 | 60.0004 | +0.4ms | 60.000000 | ✅ | 1.34s |
| **atrim 重编码** | flac | 60.000 | 60.0000 | 0.0ms | 60.000000 | ✅ | 0.41s |
| **atrim 重编码** | wav | 60.000 | 60.0000 | 0.0ms | 60.000000 | ✅ | 0.20s |

- **精度规律**：copy 只能落在编码帧边界（mp3 帧 1152/44100=26.12ms；AAC 1024/44100=23.22ms；FLAC 块 4096/44100=92.9ms；WAV 采样级）。mp3 实测偏差恒为 +17.4ms（与 `-ss` 位置 30.00/30.37/30.90 无关）；m4a 0.5~6.1ms；wav 0.4ms；**flac 时长偏差 81.6ms 且容器时长不更新 → 不可用**。
- **10min 长文件**：mp3 copy 裁剪耗时 74ms、偏差同样 +17.4ms；atrim 重编码 60s 输出耗时 **1.87s**（只解码/重编码需要的区间，不会全量转码）。
- **爆音**：copy 输出开头 1s 的 `maxDelta≈0.005`、首样本 |x|≤0.004，与正常重编码基线（0.006）同量级 → **未发现开头爆音**。
- **越界裁剪**：请求 [170,200]（源 180s）→ copy 输出 9.928s（−71.6ms），atrim 输出 10.001s（+1.1ms）。→ 服务端必须先算 `duration` 再 clamp，并允许 copy 结果有 ≤1 帧误差。
- **元数据**：copy 与重编码默认都保留 ID3（`title/artist/album` 实测均在），并追加 `encoder=Lavf`。若产品要"去元数据"需显式 `-map_metadata -1`。
- **结论**：**要求精确（±0.1s 内）或目标 flac → atrim 重编码**；mp3/m4a/wav 且无效果 → copy 快剪可接受（偏差 ≤1 帧）；**最终交付让所有"编辑过的音频"统一重编码**，copy 仅用于"无损快速导出"入口，并在 UI 标注"保留原编码，切点精度约 0.03s"。

### 2.2 删除中间区间 = 两段拼接（实验 2）

3min 输入，删除 [60s,120s]，输出应为 120s。

```bash
# A. 推荐：atrim×2 + concat 重编码（一条命令，精确）
ffmpeg -hide_banner -nostdin -y -i "$IN" -filter_complex \
 "[0:a]atrim=start=0:end=60,asetpts=PTS-STARTPTS[s1];\
  [0:a]atrim=start=120:end=180,asetpts=PTS-STARTPTS[s2];\
  [s1][s2]concat=n=2:v=0:a=1[out]" \
 -map "[out]" -c:a libmp3lame -b:a 192k "$OUT"

# B. 最快但会漂移：两段 copy + concat demuxer
printf "file '%s'\nfile '%s'\n" seg1.mp3 seg2.mp3 > list.txt
ffmpeg -hide_banner -nostdin -y -f concat -safe 0 -i list.txt -c copy "$OUT"

# C. 拼接点交叉淡化（消除硬切阶跃；输出时长 = 总长 - 淡化时长）
... [s1][s2]acrossfade=d=1:c1=tri:c2=tri[out]     # 60+60-1 = 119s
```

| 方法 | 输出时长 | 精确时长 | 偏差 | 耗时 | 爆音扫描（拼接点） | 备注 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| A filter concat mp3 | 120.000 | 120.0000 | 0.0ms | **2.45s** | maxDelta 0.012（基线 0.006） | ✅ 推荐 |
| A filter concat m4a | 120.000 | 120.0007 | +0.7ms | 2.58s | — | ✅ |
| B copy 段1 [0,60] | 60.016 | 60.0043 | +4.3ms | 78ms | — | 单段 |
| B copy 段2 [120,180] | 59.927 | 59.9267 | **−73.3ms** | 48ms | — | 帧对齐 |
| B concat demuxer copy | 120.024 | 120.0239 | **+23.9ms** | **0.12s** | maxDelta 0.0065（无爆音） | 快但累计漂移 |
| C acrossfade 1s | 119.000 | 119.0000 | 0.0ms | 2.38s | maxDelta 0.0060 | 听感最平滑 |
| A 5min 删 60s | 240.000 | 240.0000 | 0.0ms | 4.72s | — | 线性可外推 |

- copy 拼接**单次只差 24ms、未检测到爆音**，但每多拼一段误差与 LAME 帧/gapless 处理都会累积；且**客户端时间轴必须用服务端回传的精确时长重新校准**。
- 硬拼接的阶跃实测为 0.012（约源幅度 12%），理论上有轻微"咔"声风险 → 产品可在**拼接点默认加 5~20ms acrossfade**（或提供"平滑拼接"开关，默认开，成本可忽略）。
- **推荐实现**：删除区间/多选保留区间统一生成"保留段列表"，用 A 的 `filter_complex concat` 一次成片。

### 2.3 多文件拼接与参数归一（实验 3 / 13）

```bash
# 推荐：直接 concat，让 FFmpeg 7.0 自动做采样率/声道/格式转换（auto_conversion_filters 默认开）
ffmpeg -hide_banner -nostdin -y -i a.mp3 -i b.wav -i c.m4a -filter_complex \
 "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]" -map "[out]" \
 -c:a libmp3lame -b:a 192k -ar 44100 -ac 2 "$OUT"

# 若确需显式归一：加 -filter_complex_threads 1，否则 1 核下可能严重抖动！
ffmpeg -hide_banner -nostdin -y -filter_complex_threads 1 -i a -i b -filter_complex \
 "[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a0];\
  [1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a1];\
  [a0][a1]concat=n=2:v=0:a=1[out]" ...
```

| 场景 | 耗时 | 输出时长 | 偏差 | 结论 |
| :--- | :--- | :--- | :--- | :--- |
| 2×3min filter concat（显式归一） | 8.1s | 360.002 | +2.2ms | 可用 |
| 2×3min concat demuxer copy | 0.28~1.02s | 360.037 | **+37.0ms** | 快，有漂移 |
| 3×2min filter concat（显式归一，默认线程） | **16.7 / 24.0 / 26.2s（抖动）** | 360.002 | +2.2ms | 抖动不可接受 |
| 3×2min filter concat（**去显式归一**） | **7.6s** | 360.002 | +2.2ms | ✅ 推荐 |
| 3×2min + `-filter_complex_threads 1` | **7.3s** | 360.002 | +2.2ms | ✅ 稳定 |
| 3×2min + `-threads 1` | 7.2s | 360.002 | +2.2ms | 可用 |
| 2×3min（同文件）显式归一 | 7.1s | 360.002 | +2.2ms | 输入数不是主因 |
| 替代：3 段各重编码(2.3+2.4+3.1s)+concat demuxer copy(0.34s) | **8.4s** | 360.066 | **+66.0ms** | 无收益、有漂移 |
| 混合格式（mp3 44.1k stereo + 8k mono wav + m4a）自动转换 | **1.8s** | 90.000 | 准 | ✅ 7.0 自动转换足够 |
| 同上显式归一 | 5.7s | 150.000 | 准 | 慢 3 倍 |

- **3×2min 慢的根因不是 concat 本身**：容器内 `nproc=12`（尽管 --cpus=1），FFmpeg 默认 `filter_complex_threads=av_cpu_count()=12`，多输入 + 显式 `aresample` 时线程池在 1 核上互相抢核，耗时 7→26s 抖动。**加 `-filter_complex_threads 1` 或省略显式归一后稳定在 7~8s**。
- **推荐实现**：**单条 filter_complex concat**；源参数不同时优先依赖 7.0 自动转换（输出端用 `-ar/-ac` 指定最终参数），**不要**给每路都写 `aresample/aformat`；如果为可读性必须写，则**必须同时加 `-filter_complex_threads 1`**。

### 2.4 淡入淡出 afade（实验 4）

```bash
# 裁剪 + 淡入 2s / 淡出 3s（st 基于输出时间轴：总长 60s → 淡出 st=57）
ffmpeg -hide_banner -nostdin -y -i "$IN" \
 -af "atrim=start=30:end=90,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=2,afade=t=out:st=57:d=3" \
 -c:a libmp3lame -b:a 192k "$OUT"
```

| 命令 | 输出时长 | 偏差 | 耗时 |
| :--- | :--- | :--- | :--- |
| 裁剪 60s + 淡入 2s/淡出 3s | 60.000 | 0.0ms | 1.47s |
| 删除区间拼接 120s + 淡入 3s/淡出 3s（st=0/117） | 120.000 | 0.0ms | 2.88s |
| 反例：先 `afade out st=57` 再 `atempo=1.5` | 80.000 | — | 1.80s |
| 正确：先 `atempo=1.5` 再 `afade out st=77` | 80.000 | −5.1ms | 1.92s |
| 淡入 12s 用在 10s 片段 | 10.000 | — | 0.22s（静默截断，不报错） |

- **顺序定稿（重要）**：
  `atrim/asetpts（每段） → concat → volume → atempo → afade(in/out) → amix(BGM) → afade(整体) → alimiter → -t`
  - 淡入淡出必须在 **atempo 之后**：反例输出时长虽仍是 80s，但淡出实际发生在 38s（=57/1.5），听感提前一半且用户无法理解。
  - 若希望每个片段各自的淡入淡出**不随变速缩放**：先对每段 `atempo`，再在段内用输出时间轴 `st` 做 `afade`，最后 concat；淡出 `st_i = L_i/r_i − d`。
- **变速后 st 公式**：设第 i 段裁剪长度 `L_i`、全局变速倍率 `r`（或每段 `r_i`），则
  `T_out = Σ(L_i / r_i)`、`start_i = Σ_{j<i}(L_j / r_j)`；
  - 全局淡入：`st=0`、`d=min(5, T_out/4)`；全局淡出：`st = T_out − d`；
  - 片段级淡出：`st_i = start_i + L_i/r_i − d`；
  - **在 atempo 之前做 afade** 时，实际淡化时长会被缩放为 `d/r`（若产品文案写"淡入 2 秒"就不能这么写）。
- **参数校验**：`d ≥ 0`；`d ≤ min(5s, 片段时长/2)`；FFmpeg 对 `d > 片段时长` 不报错而是静默铺满 → 必须服务端校验。
- **MP3 gapless**：重编码输出时长精确（60.000/80.000s），LAME 头完整，未出现首尾空隙；copy 快剪输出的时长误差见 §2.1。

### 2.5 音量 / 削波 / alimiter / loudnorm（实验 5、13）

```bash
# 音量（dB 或线性倍数）
ffmpeg ... -af "volume=6dB" ...                       # +6dB
ffmpeg ... -af "volume=-6dB" ...
# 防削波限幅（必须 level=false，否则会自动把整体电平推到 0dB）
ffmpeg ... -af "volume=6dB,alimiter=limit=0.95:level=false" ...
# 响度标准化（≤3min；且必须 -ar 固定采样率）
ffmpeg ... -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 44100 ...
# 双遍：pass1 只分析拿 measured_*，pass2 应用（3min 合计 ≈14s）
ffmpeg -i "$IN" -af "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json" -f null -
ffmpeg -i "$IN" -af "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=..:measured_TP=..:measured_LRA=..:measured_thresh=..:offset=.." -ar 44100 ...
```

| 命令（60s 输出，除非注明） | 耗时 | RMS | maxAbs | 削波样本 | 备注 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 源样本 | — | 0.0367 | 0.101 | 0 | 合成样本较"轻"（峰值约 −20dBFS） |
| `volume=+6dB` | 1.25s | 0.0711 | 0.194 | 0 | 理论 1.98x ✓ |
| `volume=-6dB` | 1.25s | — | — | 0 | — |
| `volume=+18dB` | 1.18s | 0.2830 | 0.773 | 0 | 本样本仍不削波；真实满幅素材 +6~+12dB 即可能削波 |
| `alimiter=limit=0.95`（默认 level=1） | 1.30s | 0.2979 | 0.814 | 0 | **自动增益 +0.5dB，不推荐** |
| `alimiter=limit=0.95:level=false` | 1.31s | 0.2830 | 0.774 | 0 | 推荐写法 |
| `loudnorm` 单遍 3min | **20.8s** | — | — | — | 输出响度 −16.2 LUFS ✓ |
| `loudnorm` 单遍 5min | **20.8~21.5s** | — | — | — | — |
| `loudnorm` 单遍 10min | **41.9s** | — | — | — | ❌ 仅此一项就吃掉 70% 超时 |
| `loudnorm` 双遍 5min（pass1 15.8s + pass2 7.9s） | **23.7s** | — | — | — | 比单遍更慢但更准 |
| `loudnorm` 双遍 3min（pass1 + pass2 4.3s） | ≈14s | — | — | — | ≤3min 可用 |
| `volume=4dB,alimiter(level=false)` 5min | 6.8s | — | — | — | 推荐的"响度保险"组合 |

- **坑 1**：`loudnorm` 默认内部 192kHz 工作、输出未指定 `-ar` 时：mp3 容器最高 48kHz → 输出变成 **48000Hz**；wav/flac 输出会变成 **192000Hz**（实测 loudnorm→wav：`pcm_s16le,192000,2`，文件体积 ×4.35）。**必须 `-ar 44100`**。
- **坑 2**：`loudnorm` 是逐帧动态处理，CPU 极重（10min 42s）、maxrss 144MB；且对穿插的静音/渐变处理不如离线两遍稳定。
- **结论**：V1.1 **移除 loudnorm 或仅 ≤3min 提供"响度标准化"**；长音频的"音量安全"用 `volume + alimiter(level=false)`（10min 约 13~14s，可接受）。双遍只用于 ≤3min 的"高质量导出"。

### 2.6 变速 atempo（实验 6）

```bash
# 0.5x ~ 2.0x（单个 atempo 范围 0.5~100，但 >2 建议串联，听感更稳）
ffmpeg ... -af "atempo=1.5" ...
# 2x 以上串联（例 3x = 2 * 1.5）
ffmpeg ... -af "atempo=2,atempo=1.5" ...
# 变调（V1.1 可选）：asetrate 升调 1.5x（同时变速），再用 atempo 补偿时长
ffmpeg ... -af "asetrate=66150,aresample=44100,atempo=0.6666667" ...
# 高质量变速（rubberband，静态 7.0.2 已含；但慢 3.3 倍，P1 不建议）
ffmpeg ... -af "rubberband=tempo=1.5" ...
```

| 命令（3min 输入） | 输出时长 | 精确偏差 | 耗时 |
| :--- | :--- | :--- | :--- |
| `atempo=0.5` | 360.000 | −2.6ms | **7.48s** |
| `atempo=0.75` | 240.000 | −11.6ms | 5.43s |
| `atempo=1.25` | 144.000 | −1.3ms | 3.85s |
| `atempo=1.5` | 120.000 | −2.0ms | **3.00s** |
| `atempo=2.0` | 90.000 | +6.2ms | **2.69s** |
| `atempo=2,atempo=2`（4x） | 45.000 | +7.5ms | 1.58s |
| `atempo=2,atempo=1.5`（3x） | 60.000 | −0.6ms | 2.08s |
| `rubberband=tempo=1.5` | 120.000 | −54.6ms | **9.76s** |
| `rubberband=tempo=0.5` | 360.000 | −177.8ms | **24.67s** |
| `asetrate=66150,aresample=44100` | 120.000 | +0.7ms | 2.66s |
| `asetrate=...,atempo=0.6667`（升调保时长） | 180.000 | +0.3ms | 4.38s |

- **是否保持音调（实测基频比）**：输入 440Hz 正弦 → 输出/输入基频比：`atempo=1.5` **1.000**（保持）；`rubberband tempo=1.5` **1.000**（保持）；`asetrate` **1.487**（约 1.5x 变调，符合预期）；`rubberband pitch=1.5` **1.487**（变调）。→ **atempo 本身即保持音调，不需要额外处理**。
- 变速成本与**输出时长**成正比：0.5x 输出翻倍 → 7.5s（10min 输入 0.5x 约 25s，仍安全）。
- **建议**：默认 `atempo`；文案写"保持音调"；>2x 串联；`rubberband` 和 `asetrate` 变调放 V1.1/高级。

### 2.7 BGM 配乐混音（实验 7）

```bash
# 推荐：主轨 3min + 1min BGM 循环铺满 + 音量 + 限幅 + -t 保护
ffmpeg -hide_banner -nostdin -y -i main.mp3 -stream_loop -1 -i bgm.mp3 -filter_complex \
 "[0:a]volume=1.0[main];\
  [1:a]volume=0.20,atrim=0:180,asetpts=PTS-STARTPTS[bg];\
  [main][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,\
  alimiter=limit=0.95:level=false[out]" \
 -map "[out]" -t 180 -c:a libmp3lame -b:a 192k out.mp3

# BGM 延迟 5s 进入（毫秒，每声道）
[1:a]volume=0.22,adelay=5000|5000,apad=whole_dur=180,atrim=0:180,asetpts=PTS-STARTPTS[bg]
# 用 aloop 在 filter 内循环（等效；注意内存翻倍）
[1:a]aloop=loop=-1:size=2646000,volume=0.22,atrim=0:180,asetpts=PTS-STARTPTS[bg]
# 自动闪避（P1）：
[0:a]volume=1.0,asplit=2[main][sc];[1:a]volume=0.30,atrim=0:180,asetpts=PTS-STARTPTS[bg];\
[bg][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=300[duck];\
[main][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=false[out]
```

| 方案（3min 主轨 + 1min BGM） | 耗时 | 输出时长 | maxrss | 结论 |
| :--- | :--- | :--- | :--- | :--- |
| `-stream_loop -1` + `amix=duration=first` + alimiter + `-t` | **4.50s** | 180.000 | 26MB | ✅ **推荐** |
| `adelay=5000` 偏移进入 | 4.19s | 180.000 | 22MB | ✅ 可用 |
| `aloop=loop=-1:size=2646000` | 4.30s | 180.000 | **≈50MB** | 可用但内存 ×2 |
| amix 默认 `normalize=1` | 4.53s | 180.000 | 26MB | ❌ 主轨 RMS 0.0367→0.0217（**−4.6dB 闷掉**） |
| `sidechaincompress` 自动闪避 | 4.89s | 180.000 | 23MB | ✅ 功能可用（P1，听感未主观验收） |
| 反例：`duration=longest` + 无限循环 + 无 `-t` | 235s 未结束 | 10824s | — | ❌ 输出 **259MB**，SIGTERM 杀不掉 |

- **amix 必须显式 `normalize=0`**，各轨音量自己算；否则默认按输入数归一，两轨时主轨直接 −6dB 左右（实测 −4.6dB）。
- **音量平衡建议**：主轨 1.0；BGM 0.12~0.25（约 −18~−12dB），默认 0.20；最终 `alimiter=limit=0.95:level=false`（约 −0.4dBFS 峰值保护）。
- **`duration=first` 的语义**：输出长度以第一路（主轨）为准；再多路也只到主轨长度；**仍要 `-t` 兜底**（BGM 循环是无限输入，任何图错误都会导致无限输出）。
- **BGM 起点偏移**：用 `adelay`（毫秒）；若同时循环，顺序是 `aloop`/`-stream_loop` → `adelay` → `atrim` → `asetpts`，否则偏移会被裁剪吃掉。
- sidechaincompress 实测可跑（4.9s/3min），P1 再开；参数建议 `threshold=0.02~0.05:ratio=4~8:attack=15~30:release=250~400`。

### 2.8 静音清理 silenceremove（实验 8）

```bash
# 去掉首尾静音（语音条/录音）
ffmpeg ... -af "silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB:\
stop_periods=1:stop_duration=0.1:stop_threshold=-50dB,asetpts=PTS-STARTPTS" ...
# 删除中间停顿（铃声/语音压缩）
ffmpeg ... -af "silenceremove=stop_periods=-1:stop_duration=0.1:stop_threshold=-40dB:stop_silence=0.05,\
asetpts=PTS-STARTPTS" ...
```

| 样本/参数 | 输出时长 | 耗时 | 结论 |
| :--- | :--- | :--- | :--- |
| `voice_64s.mp3`（前后各 2s 静音）→ 去首尾 | **60.02s** | 1.42s | ✅ 准（−3.98s） |
| `ringtone_40s`（实测 14s 静音）`stop_duration=0.3:stop_silence=0.05` | 31.34s | 0.67s | 偏保守 |
| 同上 `stop_duration=0.1:stop_silence=0.05` | **27.29s** | — | 推荐参数 |
| 同上 `stop_duration=0.05:stop_silence=0.05` | 26.29s | — | 最激进（理论 26s） |
| 阈值 −50/−40/−30dB（其他参数同第一行） | 30.34 / 30.29 / 29.81s | 0.63~0.91s | 阈值不敏感（合成静音是数字 0） |

- 关键参数是 **`stop_duration`（判定为停顿的最小时长）与 `stop_silence`（保留的静音长度）**，不是阈值；`stop_periods=-1` 才会处理中间所有停顿。
- 音乐中的安静段（间奏、尾音衰减）会被误删；**长音乐不要用 silenceremove 自动"去空白"**，应由用户在时间轴上选定；silenceremove 只用于"语音/铃声模板"的一键清理。

### 2.9 服务端波形 peaks（实验 9）

```bash
# 1) 解码为波形专用 PCM（4kHz 单声道 s16le；10min 仅 4.8MB）
ffmpeg -hide_banner -nostdin -y -i "$IN" -ac 1 -ar 4000 -f s16le /tmp/peaks_$$.pcm
# 2) Node 16 无依赖脚本按 50ms 桶算 peak/rms → int8 → base64
node peaks.js /tmp/peaks_$$.pcm 4000 50     # 见 scripts/ffmpeg-spike/analyze_pcm.js peaks
```

| 输入 | 解码耗时(ffmpeg) | PCM 大小 | 桶数(50ms) | Node16 计算 | base64(peak+rms) | base64(仅 peak) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1min mp3 | 0.42s | 0.48MB | 1,201 | 38ms | 3.2KB | 1.6KB |
| 3min mp3 | 1.30s | 1.44MB | 3,601 | 27ms | 9.6KB | 4.8KB |
| 5min mp3 | 2.06s | 2.40MB | 6,001 | 25ms | 16.0KB | 8.0KB |
| **10min mp3** | **4.06s** | **4.80MB** | **12,000** | **31ms** | **32.0KB** | **16.0KB** |
| 10min wav 输入 | 1.96s | 4.80MB | 12,000 | — | — | — |
| 10min flac 输入 | 3.28s | 4.80MB | 12,000 | — | — | — |
| 10min m4a 输入 | 3.51s | 4.80MB | 12,000 | — | — | — |
| 10min，100ms 桶 | 4.06s | 4.80MB | 6,000 | 32ms | 16.0KB | 8.0KB |
| 10min，解码 8kHz（×2） | 3.17s | 9.60MB | 24,000 | 47ms | 64.0KB | — |

- **总耗时 ≈ 4.1s（10min）**，其中 ffmpeg 解码占 99%，Node 计算可忽略（31ms，RSS 45MB）。
- **推荐方案**：`-ac 1 -ar 4000 -f s16le` + 50ms 桶 + int8 `(peak, rms)` 交织 → base64 32KB。客户端按画布宽度下采样/线性插值即可；10min 32KB 可直接放 JSON 响应（<1MB 限制），也可入云存储。
- 若客户端需要更细的缩放（40px/s 级别），把 `ar` 提到 8000 或桶降到 25ms，体积可控在 64~128KB。
- 注意：`-ar 4000` 时每桶 200 样本，峰值误差可接受；**不要**用 `-ar 1000`（峰值会漏检）。
- **/tmp 占用**：PCM 4.8MB；务必 `finally` 删除。

### 2.10 一条命令完成完整编辑计划（实验 10、14）★

**场景**：10min 主音频，保留 [0,120s) + [300,600s)（420s），1.5x 变速 → 280s；1min BGM 循环铺满 @0.20；整体淡入 3s / 淡出 5s；音量 −3dB；限幅；输出 mp3。

```bash
ffmpeg -hide_banner -nostdin -y -filter_complex_threads 1 \
  -i main_10m.mp3 -stream_loop -1 -i bgm_1m.mp3 -filter_complex \
 "[0:a]atrim=start=0:end=120,asetpts=PTS-STARTPTS[s1];\
  [0:a]atrim=start=300:end=600,asetpts=PTS-STARTPTS[s2];\
  [s1][s2]concat=n=2:v=0:a=1,atempo=1.5,volume=-3dB[main];\
  [1:a]volume=0.20,atrim=0:280,asetpts=PTS-STARTPTS[bg];\
  [main][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,\
  afade=t=in:st=0:d=3,afade=t=out:st=275:d=5,alimiter=limit=0.95:level=false[out]" \
 -map "[out]" -t 280 -c:a libmp3lame -b:a 192k out_10m.mp3
```

| 版本 | 输出 | mp3 耗时 | m4a(fast) | wav | flac | 文件大小(mp3/m4a/wav/flac) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 3min 主音轨 → 100s | 100.000s | **3.5s** | — | — | — | 2.40MB |
| 5min 主音轨 → 160s | 159.996s | **5.4s** | — | — | — | 3.84MB |
| **10min 主音轨 → 280s** | **280.000s** | **10.5s**（另一竞争环境 22.7s） | **9.9s** | **6.2s** | **6.3s** | 6.72 / 6.79 / **49.39** / 22.61MB |
| 10min 同计划去掉变速（420s） | 420.000s | 11.3s | — | — | — | 控制变量：变速成本≈0 |

- **输出时长公式**：`T_out = Σ(L_i)/r`（本例 420/1.5=280）；`-t 280` 同时作为"保护 + 精确裁尾"。
- **filter 顺序（定稿）**：
  `每段 atrim+asetpts → concat → atempo → volume → amix(BGM: volume+atrim+asetpts, 循环用 -stream_loop -1) → 整体 afade(in/out) → alimiter → -t`
  （`alimiter` 永远最后、`-t` 永远加；BGM 的 `atrim` 用 **变速后的输出时长**。）
- **能否 <50s**：**能，且余量充足**。注意两处放大项：①loudnorm 不参与；②宿主竞争时可能 ×2。云函数内建议 ffmpeg 超时 45s、任务 60s、失败可重试。
- **`-progress pipe:1` 可用**：`-progress pipe:1 -stats_period 1` 每 ~1s 输出一组 `out_time_us/out_time=.../speed=.../progress=continue`，结束 `progress=end`。**坑：`out_time_ms` 字段实际也是微秒**（与 `out_time_us` 相同），解析请用 `out_time_us`。

### 2.11 ffprobe 元信息与异常输入（实验 11）

```bash
# ffprobe JSON（若打包 ffprobe；否则生产用 ffmpeg -i 解析）
ffprobe -v error -print_format json -show_format -show_streams "$IN"
# 仅要关键字段
ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels,bit_rate \
        -show_entries format=duration,size,format_name -of json "$IN"
# 项目现状（未打包 ffprobe）：ffmpeg -i 解析 stderr 的 Duration（index.js parseDuration 已实现）
ffmpeg -hide_banner -nostdin -i "$IN"     # 注意：无输出参数时退出码恒为 1，不能以退出码判断失败
```

| 输入 | ffprobe | 音频流 | duration | `ffmpeg -i ... -f null -` 退出码 | 判定 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 正常 mp3 3min | 0（0.06s） | 1 | 180.001 | 0 | ✅ |
| 0 字节 mp3 | 1 | 0 | — | 183 | ❌ 拒绝：文件为空/无法识别 |
| 50KB 随机字节改名 .mp3 | 1 | 0 | — | 183 | ❌ 拒绝 |
| WAV 内容改名 .mp3 | **0** | 1 | 60.000 | 0 | ⚠️ **按内容嗅探成功**：扩展名不可信 |
| 无音轨 mp4 | 0 | **0** | 2.000 | 234 | ❌ 拒绝：无音轨 |
| 0.3s mp3 | 0 | 1 | 0.300 | 0 | ⚠️ 边界：可解码但过短 |
| 8kHz 单声道 wav | 0 | 1 | 30.000 | 0 | ✅ 需归一化 |

**校验流程建议（服务端）**：
1. 先 `ffprobe`（或 `ffmpeg -i` 解析）→ 必须有 `a:0` 音频流，否则 `UNSUPPORTED_FILE`；
2. 取 `duration`：0 或缺失 → 拒绝；`< 1s` → 拒绝（无法剪辑）；`> 600s`（编辑源上限）→ 拒绝；
3. 采样率/声道任意，统一在成片时 `-ar 44100 -ac 2`；
4. 同时限制文件大小（≤50MB）与扩展名白名单（仅作 UX 提示，不用于安全判断）；
5. 解码失败再兜底：`ffmpeg -v error -i in -map 0:a:0 -f null -`（错误码 183/234 可区分"坏文件/无音轨"）。

---

## 3. 线程/并发与资源实测（实验 12）

| 配置（3min mp3→mp3 192k，各 2 次） | 耗时 | maxrss | 结论 |
| :--- | :--- | :--- | :--- |
| 默认（容器 nproc=12，实际 1 CPU） | 4.26 / 4.83s | 20MB | 简单转码可用 |
| `-threads 1` | 5.03 / 5.06s | 20MB | 慢 ~10%，无收益 |
| `-filter_complex_threads 1` | 4.76 / 4.81s | 20MB | 单滤镜无差异 |
| 两者都加 | 4.60 / 4.81s | 20MB | 无差异 |
| **多输入 concat + 显式 aresample（默认线程）** | **11.7 / 24.0 / 26.2s** | 21MB | ❌ 抖动严重 |
| **同上 + `-filter_complex_threads 1`** | **7.3s** | 21MB | ✅ 稳定 |

- **结论**：简单的"解码→单滤镜→编码"不需要调线程；**多输入 / 复杂 filter_complex（concat、amix、aresample 组合）必须加 `-filter_complex_threads 1`**，否则 1 vCPU 上可能慢 3 倍且抖动。
- 内存：普通链路 18~30MB；`aloop` 50MB；`loudnorm` 144MB；均远低于 975MB，**内存不是瓶颈**。
- `/tmp`：输入 ≤50MB + 输出 ≤50MB + PCM 峰值 4.8MB/10min + wav 中间文件 → 峰值 <150MB，**512MB 够用**；但"无限输出"命令 235s 就写到 259MB → 必须有 `-t` + SIGKILL。

### 3.1 信号与超时（重要）

| 场景 | 结果 |
| :--- | :--- |
| 有限输入 + `timeout -s TERM` | 正常退出（常规转码可被 SIGTERM 终止） |
| **`-stream_loop -1` 无限输入 + `timeout -s TERM`** | **3s TERM 后 9s 仍未退出**（外层 SIGKILL 才结束） |
| `-stream_loop -1` + `timeout -s KILL 3` | 3.07s 精确结束 ✅ |

→ Node `execFile` 的 `timeout` **默认 killSignal 是 SIGTERM**，对本项目的无限循环命令不可靠。定稿：`execFile(bin, args, { timeout: 45000, killSignal: 'SIGKILL' })`，并**永远**给 ffmpeg 传 `-t`（以及 BGM 的 `atrim`）。

---

## 4. 快剪白名单（`-c copy` 适用性定稿）

**适用前提**：编辑计划中**没有任何**效果（裁剪/删除/排序/拼接 only）、输出容器与源编码兼容、用户接受"切点精度 = 编码帧长"。

| 格式 | copy 快剪 | 实测时长偏差 | 容器时长 | 可解码/播放 | 结论 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **mp3** | ✅ 可用 | +17.4ms（恒定，≤1 帧 26.1ms）；起点偏差 ≤~26ms | +29ms（正常） | ✅ | 白名单；文案"切点精度约 0.03s" |
| **m4a/aac** | ✅ 可用 | +0.5~6.1ms | 准确（含 edit list） | ✅ | 白名单；**不要**加 `-avoid_negative_ts make_zero`（会把误差放大到 +23.6ms） |
| **wav** | ✅ 可用 | +0.4ms | 准确 | ✅ | 白名单（但注意输出体积） |
| **flac** | ❌ 禁用 | **+81.6ms**（块 92.9ms） | **错误：60s 输出仍报 180s** | ✅ 能解码 | **禁用**；flac 一律重编码（10min 仅 +2.6s，代价可忽略） |
| ogg/opus | ⏳ 未测 | — | — | — | 不开放 |
| 有任意效果 | ❌ | — | — | — | 必须重编码 |

**其他 copy 风险**：
1. **多段 copy 拼接会漂移**：3min copy 段（+4ms/−73ms）+ concat demuxer → 120.024s（+23.9ms）；3 段重编码再 copy 拼接 → 360.066s（+66ms）。必须在服务端回传实际时长，客户端时间轴以此为准。
2. **`-ss` 放输入前**（`-ss T -i in`）比放输出前更准/更快；输出 seek（`-i in -ss T`）实测 −8.7ms，不推荐。
3. **flac copy 的容器时长错误会传染**：客户端进度条/seek/波形对齐全部错位。
4. **copy 无法修复响度/削波/淡入淡出**：任何"编辑"都必须重编码；copy 只作为"无损快速导出（仅裁剪）"卖点。
5. 元数据默认保留，需按隐私策略决定是否 `-map_metadata -1`。

---

## 5. 格式 × 时长限额（60s 超时 + 50MB 输出硬限 + 10min 编辑源）

### 5.1 输出（成片）限额建议

预算：云函数 60s，其中 FFmpeg ≤45s（预留 15s 给下载/上传/校验/DB），**输出时长 = 用户计划中的变速/拼接后时长**。

| 输出格式 | 10min→成片实测耗时 | 外推 CPU 上限 | 50MB 体积上限 | **建议产品上限** | 备注 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **mp3 192k** | 完整编辑 280s 输出 10.5s；纯重编码 600s 14.0s | ≈20min（45s 预算） | ≈34min | **20min**（沿用 `FORMAT_LIMIT_SEC.mp3=1200`） | 保留现有 1200s；体积不是问题 |
| **m4a 192k (aac fast)** | 完整编辑 9.9s；纯重编码 600s **16.9s**（竞争时 35.9s） | ≈10~15min（含竞争余量） | ≈34min | **10min**（沿用 `m4a=600`） | 抖动大，保留 2 倍余量，勿放大 |
| **flac** | 完整编辑 6.3s；纯重编码 600s ≈7s | 很大（>30min） | **≈7min**（真实音乐 700~900kbps → 5.3~6.8MB/min） | **7min（420s）** | 现有 1800s 偏高，按体积收紧；输出前 `statSync` 校验 ≤50MB |
| **wav 44.1k stereo** | 完整编辑 6.2s；280s 输出已 **49.39MB** | 很大 | **4.7min（283s）** | **4min（240s，约 42MB）** | 现有 1800s 会直接超 50MB；若要更长：强制 mono（×2）/ 22.05kHz（×4）并在 UI 说明 |
| aac/ogg（若开放） | ≈mp3 量级 | 20min | ≈34/51min | 10min | 建议沿用 600s |

**统一护栏**：
1. 编码后 `statSync(out).size > 50MB` → 删除并返回 `OUTPUT_TOO_LARGE`（现有 index.js 的 100MB 检查需下调/按格式判断）；
2. 输出时长 > 本表上限 → 拒绝并提示"请缩短或改输出格式"；
3. 计划计算：`T_out = Σ(L_i / r_i)`，先算再校验（不要把 `T_out` 当输入时长）。

### 5.2 输入（编辑源）限额

产品 MVP：编辑源 ≤10min。但受 **50MB 上传/下载硬限** 约束：

| 输入格式 | 10min 文件大小 | ≤50MB 可行？ | 结论 |
| :--- | :--- | :--- | :--- |
| mp3 192~320k | 14.4~24MB | ✅ | 10min |
| m4a/aac 192~256k | 14.5~19MB | ✅ | 10min |
| flac（真实音乐） | 45~65MB | ⚠️ 可能超 | 10min 但**以实际文件大小为准**（>50MB 拒绝或提示先转 mp3）；建议上限 8min |
| wav 44.1k stereo | **105.8MB** | ❌ | **WAV 源 ≤4min**（约 42MB）；或产品明确"WAV 请先转换" |
| ogg/opus | 6~12MB | ✅ | 10min（若开放） |

> 若产品必须支持"10min WAV 直接编辑"，需要放宽上传/下载上限（云存储单文件上限足够，但 /tmp 512MB 仍 OK），或在客户端先转 mp3（端内无编码能力 → 用现有转码功能先转，成本一次额度）。**建议 MVP 直接限制 WAV 编辑源 ≤4min，转化率影响小。**

### 5.3 性能外推表（干净环境，供排期/压测基线）

| 操作 | 1min | 3min | 5min | 10min | 模型 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 纯重编码 mp3→mp3 192k | 1.39s | 3.83s | 8.37s | **14.0~14.9s** | ≈1.4s/min + 固定开销 |
| mp3→m4a(aac fast) | 1.4~1.5s | 4.0s | 6.6~8.1s | 16.9s（竞争 35.9s） | ≈1.7s/min |
| atempo 1.5x 重编码 | — | 3.0s | — | ≈5~6s（输出 400s） | 按**输出**时长 |
| 删除区间+concat+重编码 | — | 2.45s | 4.72s | ≈9s | ≈0.9s/min 输出 |
| BGM 循环混音 3min 输出 | — | 4.5s | — | (10min 计划内已含) | ≈1.5s/min 输出 |
| 完整编辑计划（裁+拼+淡+音量+1.5x+BGM） | — | 3.5s | 5.4s | **10.5~22.7s** | 与输入/输出双相关 |
| loudnorm 单遍 | ≈4s | 20.8s | 20.8~21.5s | **41.9s** | 异常重，仅 ≤3min |
| peaks 解码 4kHz | 0.42s | 1.30s | 2.06s | 4.06s | ≈0.4s/min |

> 以上为 1 vCPU 容器实测；宿主竞争会让个别命令慢 2~3 倍。云端独占 vCPU 一般更稳；建议上线前用真实云函数复测一次（尤其 m4a/10min）。

---

## 6. 推荐的 Filter Graph Builder 规则（伪代码）

### 6.1 数据模型（客户端 → 服务端 → ffmpeg）

```jsonc
{
  "sourceFileId": "cloud://...",          // 主音频 fileID（已下载到 /tmp/in.mp3）
  "durationSec": 600.0,                   // ffprobe 结果，服务端不信任客户端
  "output": { "format": "mp3", "bitrate": "192k", "sampleRate": 44100, "channels": 2 },
  "segments": [                           // 保留段（按输出顺序）；删除=不出现
    { "start": 0.0,   "end": 120.0 },
    { "start": 300.0, "end": 600.0 }
  ],
  "volumeDb": -3,
  "tempo": 1.5,                           // 0.5~4，>2 自动串联
  "fadeInSec": 3,
  "fadeOutSec": 5,
  "bgm": { "fileId": "cloud://...", "volume": 0.20, "loop": true, "startOffsetSec": 0, "fadeOutSec": 0 },
  "normalizeLoudness": false,             // 仅 <=180s 允许 true
  "limiter": true
}
```

### 6.2 Builder 伪代码（服务端生成 args）

```ts
function buildEditPlan(plan, inputPaths): { args: string[] } {
  // ---- 0. 校验 ----
  assert(plan.segments.length >= 1 && plan.segments.length <= 10)
  const L = plan.segments.map(s => clamp(s.end, 0, plan.durationSec) - clamp(s.start, 0, plan.durationSec))
  assert(L.every(x => x >= 0.2), 'SEGMENT_TOO_SHORT')
  const tempo = chainTempo(plan.tempo)            // [{r:2},{r:1.5}] ; 0.5<=each<=2
  if (plan.tempo < 0.5 || plan.tempo > 4) throw 'TEMPO_RANGE'
  const totalIn = sum(L)
  const outDur = plan.tempo ? totalIn / plan.tempo : totalIn   // 兼容 per-segment tempo 时逐段算
  const fadeIn = Math.min(plan.fadeInSec || 0, Math.min(5, outDur / 4))
  const fadeOut = Math.min(plan.fadeOutSec || 0, Math.min(5, outDur / 4))
  assert(plan.bgm == null || outDur >= 5, 'BGM_TOO_SHORT')
  // 时长限额（见 §5.1）+ 输出体积预估（wav: 176400*outDur；flac: 按 6.8MB/min 估）
  assertOutputLimits(plan.output.format, outDur)

  // ---- 1. 输入 & 基础参数 ----
  const args = ['-hide_banner','-nostdin','-y','-loglevel','error','-filter_complex_threads','1']
  args.push('-i', inputPaths.main)
  if (plan.bgm) args.push('-stream_loop', plan.bgm.loop ? '-1' : '0', '-i', inputPaths.bgm)

  // ---- 2. 每段裁剪 ----
  const graph: string[] = []
  plan.segments.forEach((s, i) => {
    graph.push(`[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[s${i}]`)
  })

  // ---- 3. concat ----
  const segLabels = plan.segments.map((_, i) => `[s${i}]`).join('')
  graph.push(`${segLabels}concat=n=${plan.segments.length}:v=0:a=1[cat]`)

  // ---- 4. 主轨：变速 → 音量 ----
  let mainChain = '[cat]'
  for (const t of tempo) mainChain += `atempo=${t.r},`
  if (plan.volumeDb) mainChain += `volume=${plan.volumeDb}dB,`
  mainChain += '[main]'
  graph.push(mainChain)

  // ---- 5. BGM（循环/偏移/音量；长度=变速后输出时长） ----
  let mixLabel = '[main]'
  if (plan.bgm) {
    const b = plan.bgm
    let bg = `[1:a]volume=${b.volume}`
    if (b.startOffsetSec > 0) bg += `,adelay=${Math.round(b.startOffsetSec*1000)}|${Math.round(b.startOffsetSec*1000)}`
    bg += `,atrim=start=${b.startOffsetSec}:end=${b.startOffsetSec + outDur},asetpts=PTS-STARTPTS[bg]`
    graph.push(bg)
    // duration=first：以主轨为准；normalize=0：保留各自音量；dropout_transition=0：主轨结束后不留淡出尾巴
    graph.push(`[main][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`)
    mixLabel = '[mix]'
  }

  // ---- 6. 整体淡入淡出（务必在 atempo 之后；st 用输出时间轴） ----
  let tail = mixLabel
  if (fadeIn > 0)  tail += `,afade=t=in:st=0:d=${fadeIn}`
  if (fadeOut > 0) tail += `,afade=t=out:st=${(outDur - fadeOut).toFixed(3)}:d=${fadeOut}`
  // ---- 7. 响度（仅 <=180s）：volume+limiter 兜底，loudnorm 仅短音频 ----
  if (plan.normalizeLoudness && outDur <= 180) tail += `,loudnorm=I=-16:TP=-1.5:LRA=11`
  if (plan.limiter) tail += `,alimiter=limit=0.95:level=false`
  tail += '[out]'
  graph.push(tail)

  args.push('-filter_complex', graph.join(';'), '-map', '[out]')
  // ---- 8. 输出参数 + 硬保护 ----
  args.push('-t', outDur.toFixed(3))                       // 永远加：BGM 循环是无限输入
  args.push(...TARGETS[plan.output.format](plan.output))
  if (plan.normalizeLoudness) args.push('-ar','44100')     // loudnorm 默认 192k，必须固定
  args.push(outputPath)
  return { args }
}
```

### 6.3 规则清单（写代码时逐条对照）

1. **永远 `-t`**：所有含 `-stream_loop -1` / `aloop` / `amix duration=longest` 的命令必须 `-t T_out`；`-t` 同时是精确裁尾手段。
2. **顺序**：`atrim+asetpts → concat → atempo → volume → amix(BGM) → afade(整体) → alimiter → -t`。
3. **afade 的 st 用输出时间轴**：`T_out = Σ(L_i)/r`；淡出 `st = T_out - d`；片段级 `st_i = start_i + L_i/r_i - d`；**不要在 atempo 前做全局淡化**。
4. **amix 必须 `normalize=0`**；BGM 音量 0.12~0.25；输出前 `alimiter=limit=0.95:level=false`。
5. **BGM 循环**：输入侧 `-stream_loop -1`（内存省）+ 滤镜内 `atrim=0:T_out`；`duration=first`；`dropout_transition=0`。
6. **不要显式堆 `aresample/aformat`**；靠 7.0 自动转换，输出端 `-ar/-ac` 定规格；确需显式归一 → 加 `-filter_complex_threads 1`。
7. **1 vCPU 固定 `-filter_complex_threads 1`**（简单链路无影响，复杂链路防 3 倍抖动）。
8. **loudnorm 仅 ≤180s**；否则 `volume + alimiter`；loudnorm 后强制 `-ar 44100`。
9. **atempo**：0.5~4；>2 串联；默认保持音调；不做变调（V1.1 再上 `asetrate`/`rubberband`）。
10. **输出体积护栏**：编码后 `statSync` ≤50MB；wav/flac 预先按体积估算拦截。
11. **copy 快路径**：仅当 `segments` 为单一连续区间且无任何效果、格式 ∈ {mp3,m4a,wav} 时；flac 永不 copy。
12. **参数归一化到输出**：`-ar 44100 -ac 2`（或按用户选择）；输入任意 8k/单声道/48k 均可。
13. **进度**：`-progress pipe:1 -stats_period 1`，解析 `out_time_us`（**不是 `out_time_ms`，两者都是微秒**）。
14. **超时**：`execFile(..., { timeout: 45000, killSignal: 'SIGKILL' })`；捕获后清理 /tmp 半成品。
15. **错误码映射**：ffmpeg 退出码 183（文件为空/无法识别）、234（无音轨/参数错误）→ 用户可读文案；`-v error` 限制 stdout 大小。

---

## 7. 坑清单（按危险度排序）

| # | 坑 | 现象/证据 | 规避 |
| :-- | :--- | :--- | :--- |
| P1 | **无限输入 + 无 `-t`** | 235s 写出 259MB/10824s 音频；SIGTERM 3s 后 9s 仍不退出 | 必须 `-t`；`killSignal:'SIGKILL'`；/tmp 配额监控 |
| P2 | **flac copy 容器时长错误** | 60s 输出 `format.duration=180.001`，实际 60.08s；切点误差 81.6ms | flac 禁用 copy，一律重编码 |
| P3 | **afade 在 atempo 前** | 淡出提前到 38s（期望 77s），时长仍"正确" | 顺序固定；st 用输出时间轴；服务端校验 |
| P4 | **loudnorm** 慢 + 改采样率 | 10min 42s；输出 48k（mp3）/192k（wav），体积 ×4.35 | 仅 ≤3min；强制 `-ar 44100`；V1.1 移除 |
| P5 | **amix 默认 normalize=1** | 主轨 RMS −4.6dB，人声/旋律被"闷掉" | `normalize=0` + 显式音量 |
| P6 | **alimiter 默认 level=1** | 自动增益 +0.5dB，目标响度漂移 | `level=false` |
| P7 | **显式 aresample×N + 默认线程** | 3×2min concat 耗时 7s→24~26s 抖动 | 省显式归一；或 `-filter_complex_threads 1` |
| P8 | **m4a copy 加 `-avoid_negative_ts make_zero`** | 时长误差 +0.5ms→+23.6ms | 保持默认；不要加 |
| P9 | **copy 多段拼接时长漂移** | concat demuxer copy 3min 段 +23.9ms；3 段 +66ms | 回传精确时长；或直接用 filter concat |
| P10 | **`out_time_ms` 实际是微秒** | 与 `out_time_us` 数值相同 | 解析 `out_time_us` |
| P11 | **`ffmpeg -i` 无输出时退出码恒 1** | index.js 若用退出码判失败会误判 | 解析 stderr `Duration`；或用 ffprobe |
| P12 | **silenceremove 参数误解** | `stop_duration/stop_silence` 决定效果，阈值不敏感 | 用推荐参数；音乐不要自动去空白 |
| P13 | **aloop 内存翻倍** | 3min BGM 26MB→50.6MB（size=2.65M 样本缓冲） | 优先 `-stream_loop -1`；aloop 仅短 BGM |
| P14 | **m4a 编码器波动** | 10min fast 16.9s vs 35.9s（宿主竞争） | 预设 2x 安全系数；云端复测 |
| P15 | **WAV 输出体积** | 280s 输出已 49.4MB，10min 会 105.8MB | wav 上限 4min（或 mono/低采样率）；50MB 硬检查 |
| P16 | **扩展名不可信** | wav 改名 .mp3 正常解码 | 以 probe 的 `format_name`/音频流为准 |
| P17 | **metadata 默认保留** | copy 与重编码都保留 title/artist | 按隐私策略显式 `-map_metadata -1` |
| P18 | **淡入时长 > 片段时长** | 静默铺满不报错 | 服务端 clamp `d ≤ min(5, T/4)` |

---

## 8. 附录

### 8.1 可复现脚本与数据位置

| 文件 | 说明 |
| :--- | :--- |
| `scripts/ffmpeg-spike/run.sh` | 一键：建 1C/1G 容器、复制静态 7.0.2、生成样本、跑 00~12 实验 |
| `scripts/ffmpeg-spike/gen_samples.sh` | 生成 1/3/5/10min 样本（mp3 128/192k、m4a、flac、wav）、铃声、8k mono、异常样本 |
| `scripts/ffmpeg-spike/exp01_trim.sh` … `exp14_extra.sh` | 各实验原始命令（与本文命令一致） |
| `scripts/ffmpeg-spike/exp09_peaks.sh` | 波形 peaks：容器解码 + node:16-alpine 计算 |
| `scripts/ffmpeg-spike/analyze_pcm.js` | 无依赖 PCM 分析：clicks/envelope/stats/beeps/freq/peaks |
| `scripts/ffmpeg-spike/analyze_all.sh` | 对原始 PCM 统一分析（爆音/包络/基频/响度） |
| 结果（不入库，运行时生成） | `/tmp/ffmpeg-spike-work/results/*.tsv`、`analysis.jsonl`、`/tmp/ffmpeg-spike-work/samples/` |

运行示例：
```bash
bash scripts/ffmpeg-spike/run.sh              # 全量
bash scripts/ffmpeg-spike/run.sh 01 02 10     # 仅指定实验
WORK=/tmp/my-spike bash scripts/ffmpeg-spike/run.sh
```
> 脚本不写死绝对路径；样本/结果默认落在 `/tmp/ffmpeg-spike-work`，仓库内不保留 >5MB 产物。

### 8.2 待实测清单（本文未覆盖）

1. 真实云函数内复测：10min 最坏组合、m4a 10min（本机为 Docker 模拟，云端 vCPU 型号可能不同）。
2. m4a / ogg 的 concat demuxer copy 拼接（本文仅测 mp3/flac/wav 的 copy 与 mp3 的 copy 拼接）。
3. sidechaincompress 的主观听感验收（本文只验证可运行与耗时）。
4. `rubberband` 变速的主观质量（长音频、人声素材）。
5. 微信端 `InnerAudioContext` 播放 copy 裁剪输出（mp3/m4a 的 gapless/edit-list 兼容性，iOS/Android 差异）。
6. 48kHz/单声道/5.1 源素材的完整链路（本文以 44.1k stereo 为主，另有 8k mono 归一用例）。
7. 并发 2 任务同实例的耗时退化（云函数默认单并发，若改用云托管需补测）。

### 8.3 关键命令速查（复制版）

```bash
# 裁剪(精确) + 变速 + 淡入淡出 + 音量 + BGM + 限幅（模板见 §2.10）
ffmpeg -hide_banner -nostdin -y -filter_complex_threads 1 \
 -i main.mp3 -stream_loop -1 -i bgm.mp3 -filter_complex \
 "[0:a]atrim=0:60,asetpts=PTS-STARTPTS[s1];[0:a]atrim=120:180,asetpts=PTS-STARTPTS[s2];\
  [s1][s2]concat=n=2:v=0:a=1,atempo=1.5,volume=-3dB[main];\
  [1:a]volume=0.20,atrim=0:80,asetpts=PTS-STARTPTS[bg];\
  [main][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,\
  afade=t=in:st=0:d=2,afade=t=out:st=77:d=3,alimiter=limit=0.95:level=false[out]" \
 -map "[out]" -t 80 -c:a libmp3lame -b:a 192k out.mp3

# 波形 PCM
ffmpeg -hide_banner -nostdin -y -i in.mp3 -ac 1 -ar 4000 -f s16le pcm.raw

# 无损快剪（仅 mp3/m4a/wav，且计划无任何效果）
ffmpeg -hide_banner -nostdin -y -ss 30 -t 60 -i in.mp3 -c copy out.mp3
```

---

*本报告所有数据可由 `scripts/ffmpeg-spike/run.sh` 在本机 Docker 复现；数据为 2026-10-28 单机 1 vCPU 容器实测，云函数部署后建议按 §8.2 复测关键项。*
