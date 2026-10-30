#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 实验 9：服务端波形 peaks（宿主机侧脚本）
#   step1 在 1C/1G 的 ffmpeg 容器内把音频解码为 4kHz 单声道 s16le（计时/体积）
#   step2 在 node:16-alpine（--cpus=1 --memory=1g）内用无依赖脚本按 50ms 桶算 peak/rms
#         → int8，生成 base64；同时测 100ms 桶方案
#   step3 汇总 TSV：$WORK/results/09_peaks.tsv
#
# 运行：bash exp09_peaks.sh [WORK_DIR]   （宿主机执行；不写死绝对路径）
# ---------------------------------------------------------------------------
set -u
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
WORK=${1:-${WORK:-/tmp/ffmpeg-spike-work}}
CONTAINER=${CONTAINER:-ffmpeg-spike}
NODE_IMAGE=${NODE_IMAGE:-node:16-alpine}
TSV="$WORK/results/09_peaks.tsv"
mkdir -p "$WORK/results" "$WORK/out/09"
export WORK_REAL="$WORK"

echo "[exp09] WORK=$WORK CONTAINER=$CONTAINER NODE_IMAGE=$NODE_IMAGE"

# ---------- step1: 容器内解码（含 benchmark 计时） ----------
docker exec "$CONTAINER" bash -lc '
set -u
source /spike/lib.sh
init_exp "09_peaks"
mkdir -p /work/out/09
for d in 60 180 300 600; do
  bench_run "decode_mp3_${d}s_to_4k_mono" "/work/out/09/pcm_${d}s_4k.s16le" "" \
    "mp3→s16le 4kHz mono（波形用）" -- \
    ffb -i "/work/samples/music_${d}s.mp3" -ac 1 -ar 4000 -f s16le "/work/out/09/pcm_${d}s_4k.s16le"
done
# 输入格式对解码耗时的影响（10min）
for fmt in wav flac m4a; do
  bench_run "decode_10m_${fmt}_to_4k" "/work/out/09/pcm_600s_${fmt}_4k.s16le" "600" \
    "10min $fmt→s16le 4kHz mono" -- \
    ffb -i "/work/samples/music_600s.${fmt}" -ac 1 -ar 4000 -f s16le "/work/out/09/pcm_600s_${fmt}_4k.s16le"
done
# 对照：8kHz（体积×2）
bench_run "decode_600s_to_8k_mono" "/work/out/09/pcm_600s_8k.s16le" "600" \
  "mp3→s16le 8kHz mono 对照" -- \
  ffb -i /work/samples/music_600s.mp3 -ac 1 -ar 8000 -f s16le /work/out/09/pcm_600s_8k.s16le
echo "[step1] done"
'

# ---------- step2: Node16 计算 peak/rms + base64 ----------
now_ms() { python3 -c "import time;print(int(time.time()*1000))"; }
run_node_peaks() {
  local pcm="$1" bucket="$2" label="$3"
  local t0 t1 wall json rc
  t0=$(now_ms)
  json=$(docker run --rm --cpus=1 --memory=1g \
    -v "$WORK":/work -v "$SCRIPT_DIR":/spike \
    "$NODE_IMAGE" node /spike/analyze_pcm.js peaks "/work/${pcm#$WORK/}" 4000 "$bucket" 2>/dev/null)
  rc=$?
  t1=$(now_ms)
  wall=$((t1 - t0))
  if [ -z "$json" ]; then echo "[node] FAILED $label"; return 1; fi
  local buckets compute b64 bytes rss dur secs
  buckets=$(printf '%s' "$json" | python3 -c 'import sys,json;print(json.load(sys.stdin)["buckets"])')
  compute=$(printf '%s' "$json" | python3 -c 'import sys,json;print(json.load(sys.stdin)["nodeComputeMs"])')
  b64=$(printf '%s' "$json" | python3 -c 'import sys,json;print(json.load(sys.stdin)["b64Bytes"])')
  bytes=$(printf '%s' "$json" | python3 -c 'import sys,json;print(json.load(sys.stdin)["rawBytes"])')
  rss=$(printf '%s' "$json" | python3 -c 'import sys,json;print(json.load(sys.stdin)["rssMB"])')
  secs=$(printf '%s' "$json" | python3 -c 'import sys,json;print(json.load(sys.stdin)["seconds"])')
  printf '%s\t0\t%s\t0\t0\t%s\t%s\t%s\tbuckets=%s nodeComputeMs=%s rawBytes=%s b64Bytes=%s rssMB=%s wall_incl_docker=%sms\n' \
    "$label" "$wall" "$bytes" "$secs" "$secs" "$buckets" "$compute" "$bytes" "$b64" "$rss" "$wall" >> "$TSV"
  printf '[node] %-34s buckets=%-6s compute=%-7sms raw=%-6s b64=%-6s rss=%sMB wall(docker)=%sms\n' \
    "$label" "$buckets" "$compute" "$bytes" "$b64" "$rss" "$wall"
}

echo "[exp09] node16 基线启动开销:"
t0=$(now_ms); docker run --rm -v "$WORK":/work -v "$SCRIPT_DIR":/spike "$NODE_IMAGE" node -e '0' 2>/dev/null; t1=$(now_ms)
echo "    docker run + node -e 0 = $((t1 - t0))ms（云端运行时已常驻，不计入）"

for d in 60 180 300 600; do
  run_node_peaks "out/09/pcm_${d}s_4k.s16le" 50 "peaks_${d}s_50ms_int8_peakrms"
done
# 10min 100ms 桶 + 10min 8kHz 对照
run_node_peaks "out/09/pcm_600s_4k.s16le" 100 "peaks_600s_100ms_int8_peakrms"
run_node_peaks "out/09/pcm_600s_8k.s16le" 50 "peaks_600s_8k_input_50ms"

echo "[exp09] done -> $TSV"
