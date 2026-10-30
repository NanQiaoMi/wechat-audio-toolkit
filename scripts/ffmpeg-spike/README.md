# FFmpeg 剪辑链路实测脚本（task-2）

对应报告：[docs/research/FFMPEG_EDIT_SPIKE.md](../../docs/research/FFMPEG_EDIT_SPIKE.md)

## 用法（宿主机，需要 Docker）

```bash
bash scripts/ffmpeg-spike/run.sh            # 全量：建 1C/1G 容器 → 生成样本 → 实验 01~14
bash scripts/ffmpeg-spike/run.sh 01 04 10   # 只跑指定实验（00=生成样本）
WORK=/tmp/my-spike bash scripts/ffmpeg-spike/run.sh   # 自定义工作目录
```

- 容器固定 `--cpus=1 --memory=1g`，模拟云函数 1 核 975MB；
- 静态 FFmpeg 7.0.2 直接取 `cloudfunctions/ffmpegProbe/bin/ffmpeg`，复制进容器 `/tmp/bin/ffmpeg` 后 `chmod +x`（与云端处理一致）；
- 镜像自带 ffprobe 9.0.2 仅用于结果校验；
- 样本/中间文件/结果均写 `$WORK`（默认 `/tmp/ffmpeg-spike-work`），**不写入仓库**；
- 结果表：`$WORK/results/*.tsv`；PCM 分析：`$WORK/results/analysis.jsonl`。

## 文件

| 文件 | 作用 |
| :--- | :--- |
| `lib.sh` | 计时（`-benchmark` 的 rtime/maxrss）、精确时长、解码校验 |
| `gen_samples.sh` | 1/3/5/10min 样本（mp3 128/192k、m4a、flac、wav）+ 铃声/8k mono/标记音/异常样本 |
| `exp01`~`exp14` | 各实验原始命令（与报告命令一一对应） |
| `exp09_peaks.sh` | 波形 peaks：ffmpeg 解码 + node:16-alpine 计算 |
| `analyze_pcm.js` | 无依赖 PCM 分析：click/envelope/stats/beeps/freq/peaks |
| `analyze_all.sh` | 对保存的 PCM 做统一分析 |

## 依赖

Docker 28+；`linuxserver/ffmpeg:latest`、`node:16-alpine` 两个镜像（首次会拉取/需已存在）。
