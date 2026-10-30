#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# FFmpeg 剪辑链路实测 · 一键复现脚本（宿主机执行，需要 Docker）
#
# 用法：
#   bash scripts/ffmpeg-spike/run.sh            # 全量：建容器→生成样本→跑 12 组实验
#   bash scripts/ffmpeg-spike/run.sh 01 04 10   # 只跑指定实验（序号）
#   WORK=/tmp/my-spike bash scripts/ffmpeg-spike/run.sh
#
# 说明：
#   - 容器固定 --cpus=1 --memory=1g 模拟微信云函数 1 核 975MB；
#   - 静态 FFmpeg 7.0.2 取自 cloudfunctions/ffmpegProbe/bin/ffmpeg，复制进容器
#     /tmp/bin/ffmpeg 后 chmod +x（部署后丢可执行位，与云端一致的处理方式）；
#   - 样本/中间文件/结果均写 WORK（默认 /tmp/ffmpeg-spike-work），不写入仓库；
#   - 结果表在 $WORK/results/*.tsv。
# ---------------------------------------------------------------------------
set -u
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
WORK=${WORK:-/tmp/ffmpeg-spike-work}
CONTAINER=${CONTAINER:-ffmpeg-spike}
IMAGE=${IMAGE:-linuxserver/ffmpeg:latest}
STATIC_BIN="$REPO_ROOT/cloudfunctions/ffmpegProbe/bin/ffmpeg"
NODE_IMAGE=${NODE_IMAGE:-node:16-alpine}
# 兼容 macOS 自带 bash 3.2：不用数组，直接用 $# / "$@"


log() { printf '\033[1;36m[run]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[err]\033[0m %s\n' "$*"; exit 1; }

[ -x "$(command -v docker)" ] || die "需要 docker"
[ -f "$STATIC_BIN" ] || die "找不到静态 FFmpeg：$STATIC_BIN"

mkdir -p "$WORK"/{samples,out,results}

ensure_container() {
  if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    log "复用已运行容器 $CONTAINER"
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    log "创建容器 $CONTAINER（--cpus=1 --memory=1g）"
    docker run -d --name "$CONTAINER" --cpus=1 --memory=1g --memory-swap=1g \
      -v "$SCRIPT_DIR":/spike \
      -v "$(dirname "$STATIC_BIN")":/spike-bin:ro \
      -v "$WORK":/work \
      --entrypoint /bin/bash "$IMAGE" -c 'trap "exit 0" TERM; sleep infinity' >/dev/null || die "容器启动失败"
  fi
  log "准备静态 FFmpeg 7.0.2（复制到容器 /tmp 并 chmod +x）"
  docker exec "$CONTAINER" bash -lc '
    mkdir -p /tmp/bin
    cp /spike-bin/ffmpeg /tmp/bin/ffmpeg && chmod +x /tmp/bin/ffmpeg
    /tmp/bin/ffmpeg -hide_banner -version | head -2
    /usr/local/bin/ffprobe -version | head -1
  ' || die "静态二进制不可运行（glibc/musl 或架构不匹配？）"
}

in_container() { docker exec "$CONTAINER" bash -lc "cd /spike && $*"; }

# 逐个实验（gen 单独）
run_one() {
  local n="$1"
  case "$n" in
    00) in_container 'bash /spike/gen_samples.sh' ;;
    01) in_container 'bash /spike/exp01_trim.sh' ;;
    02) in_container 'bash /spike/exp02_remove.sh' ;;
    03) in_container 'bash /spike/exp03_concat_multi.sh' ;;
    04) in_container 'bash /spike/exp04_fade.sh' ;;
    05) in_container 'bash /spike/exp05_volume.sh' ;;
    06) in_container 'bash /spike/exp06_tempo.sh' ;;
    07) in_container 'bash /spike/exp07_bgm.sh' ;;
    08) in_container 'bash /spike/exp08_silence.sh' ;;
    09) bash "$SCRIPT_DIR/exp09_peaks.sh" "$WORK" ;;
    10) in_container 'bash /spike/exp10_full_edit.sh' ;;
    11) in_container 'bash /spike/exp11_probe_errors.sh' ;;
    12) in_container 'bash /spike/exp12_ops.sh' ;;
    13) in_container 'bash /spike/exp13_followup.sh' ;;
    14) in_container 'bash /spike/exp14_extra.sh' ;;
    *) die "未知实验编号：$n（可用 00~14）" ;;
  esac
}

ensure_container

log "工作目录：$WORK"
if [ $# -eq 0 ]; then
  log "生成样本"; run_one 00
  for n in 01 02 03 04 05 06 07 08 09 10 11 12 13 14; do
    log "实验 $n"; run_one "$n"
  done
else
  # gen 首次必须（除 12 可依赖已有样本）
  if [ ! -s "$WORK/samples/music_180s.mp3" ]; then log "生成样本"; run_one 00; fi
  for n in "$@"; do log "实验 $n"; run_one "$n"; done
fi

log "完成。结果：$WORK/results/"
ls -la "$WORK/results" | tail -20
