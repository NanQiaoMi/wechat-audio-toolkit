#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 音乐剪辑（analyzeAudio / renderEdit v1+v2）后端本地实测 · 一键复现
#
# 覆盖：
#   - v1：单源 segments（裁剪/删除/拼接、整体淡入淡出、音量、限幅）
#   - v2：多源 sources[] + clips[]（同源 asplit、每片段缓入缓出、顺序可调）
#   - 旧 probe/convertFile/cleanup 回归（action 级 mock）
#
# 用法（宿主机执行，需要 Docker + Node）：
#   bash scripts/editor-spike/run.sh              # 纯函数单测(Node16) + Docker 实测 + action mock 实测
#   bash scripts/editor-spike/run.sh --pure       # 只跑纯函数单测
#
# 做法：
#   - 容器 `linuxserver/ffmpeg` 固定 --cpus=1 --memory=1g（模拟云函数 1 vCPU/975MB）；
#   - 把项目静态 FFmpeg 7.0.2（cloudfunctions/ffmpegProbe/bin/ffmpeg）复制进容器
#     /tmp/bin/ffmpeg 并 chmod +x（与云端"部署丢可执行位"的处理一致）；
#   - test_integration.js 只执行 cloudfunctions/ffmpegProbe/lib/editor-core.js 生成的
#     filter/args（与云函数运行时同一条代码路径）；
#   - test_actions_mock.js 用 mock wx-server-sdk + 真实 exports.main 跑完整 action 链路；
#   - 中间文件/样本/结果全部写 WORK（默认 /tmp/editor-spike-work），不写仓库。
# ---------------------------------------------------------------------------
set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
WORK=${WORK:-/tmp/editor-spike-work}
CONTAINER=${CONTAINER:-ffmpeg-editor-spike}
IMAGE=${IMAGE:-linuxserver/ffmpeg:latest}
NODE_IMAGE=${NODE_IMAGE:-node:16-alpine}
STATIC_BIN="$REPO_ROOT/cloudfunctions/ffmpegProbe/bin/ffmpeg"

MODE=${1:-all}

log() { printf '\033[1;36m[run]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[err]\033[0m %s\n' "$*"; exit 1; }

# Node：优先 $NODE_BIN，其次 PATH，最后本机 DSH 运行时内置 node
NODE_BIN=${NODE_BIN:-}
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN=$(command -v node)
  elif [ -x "/Users/mimi/.dsh/dsh-runtimes/dsh-plugin-desktop-primary-runtime/dependencies/node/bin/node" ]; then
    NODE_BIN="/Users/mimi/.dsh/dsh-runtimes/dsh-plugin-desktop-primary-runtime/dependencies/node/bin/node"
  fi
fi

mkdir -p "$WORK"/{samples,out,results}

# ---------- 纯函数单测（无 Docker，宿主机 Node + Node 16 容器各跑一遍） ----------
run_pure() {
  [ -n "$NODE_BIN" ] || die "找不到 node，可用 NODE_BIN=/path/to/node 指定"
  log "纯函数单测（宿主机: $($NODE_BIN --version 2>/dev/null)）"
  "$NODE_BIN" "$SCRIPT_DIR/test_pure.js" || die "纯函数单测失败（宿主机）"
  command -v docker >/dev/null 2>&1 || die "需要 docker 跑 Node16 兼容性单测"
  log "纯函数单测（Node 16: $NODE_IMAGE）"
  docker run --rm --cpus=1 --memory=1g -v "$REPO_ROOT":/repo:ro \
    "$NODE_IMAGE" node /repo/scripts/editor-spike/test_pure.js || die "纯函数单测失败（Node16）"
  log "语法检查（Node16）"
  docker run --rm -v "$REPO_ROOT":/repo:ro "$NODE_IMAGE" \
    node --check /repo/cloudfunctions/ffmpegProbe/index.js || die "index.js 语法检查失败"
  docker run --rm -v "$REPO_ROOT":/repo:ro "$NODE_IMAGE" \
    node --check /repo/cloudfunctions/ffmpegProbe/lib/editor-core.js || die "editor-core.js 语法检查失败"
  docker run --rm -v "$REPO_ROOT":/repo:ro "$NODE_IMAGE" \
    node --check /repo/scripts/editor-spike/test_integration.js || die "test_integration.js 语法检查失败"
  docker run --rm -v "$REPO_ROOT":/repo:ro "$NODE_IMAGE" \
    node --check /repo/scripts/editor-spike/test_actions_mock.js || die "test_actions_mock.js 语法检查失败"
  log "纯函数单测 + 语法检查通过"
}

ensure_container() {
  command -v docker >/dev/null 2>&1 || die "需要 docker"
  [ -f "$STATIC_BIN" ] || die "找不到静态 FFmpeg：$STATIC_BIN"
  if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    log "复用已运行容器 $CONTAINER"
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    log "创建容器 $CONTAINER（--cpus=1 --memory=1g）"
    docker run -d --name "$CONTAINER" --cpus=1 --memory=1g --memory-swap=1g \
      -v "$SCRIPT_DIR":/spike:ro \
      -v "$(dirname "$STATIC_BIN")":/spike-bin:ro \
      -v "$WORK":/work \
      --entrypoint /bin/bash "$IMAGE" -c 'trap "exit 0" TERM; sleep infinity' >/dev/null \
      || die "容器启动失败"
  fi
  log "准备静态 FFmpeg 7.0.2（复制进容器 /tmp/bin + chmod +x）"
  docker exec "$CONTAINER" bash -lc '
    mkdir -p /tmp/bin
    cp /spike-bin/ffmpeg /tmp/bin/ffmpeg && chmod +x /tmp/bin/ffmpeg
    /tmp/bin/ffmpeg -hide_banner -version | head -1
    /usr/local/bin/ffprobe -version | head -1
  ' || die "静态二进制不可运行（glibc/musl 或架构不匹配？）"
}

run_docker_test() {
  [ -n "$NODE_BIN" ] || die "找不到 node，可用 NODE_BIN=/path/to/node 指定"
  ensure_container
  log "Docker 实测：lib 生成的 filter/args（WORK=$WORK）"
  CONTAINER="$CONTAINER" WORK="$WORK" "$NODE_BIN" "$SCRIPT_DIR/test_integration.js" \
    || die "Docker 实测失败"
  log "action 级 mock 实测：真实 exports.main + mock 云 SDK + 容器内 FFmpeg"
  CONTAINER="$CONTAINER" WORK="$WORK" "$NODE_BIN" "$SCRIPT_DIR/test_actions_mock.js" \
    || die "action 级 mock 实测失败"
}

case "$MODE" in
  --pure) run_pure ;;
  all)
    run_pure
    run_docker_test
    ;;
  *)
    log "用法：bash scripts/editor-spike/run.sh [--pure]"
    exit 1
    ;;
esac

log "完成。容器保留：$CONTAINER（清理：docker rm -f $CONTAINER）；结果：$WORK/results/editor-backend.tsv"
