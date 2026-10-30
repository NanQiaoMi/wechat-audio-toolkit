#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# FFmpeg 剪辑链路实测 · 公共库（在容器内 source）
#
# 约定：
#   FFMPEG  默认 /tmp/bin/ffmpeg —— 项目静态二进制 7.0.2（由 run.sh 复制进容器）
#   FFPROBE 默认镜像自带 /usr/local/bin/ffprobe（9.0.2，仅用于结果校验）
#   WORK    默认 /work —— 宿主机 /tmp/ffmpeg-spike-work 挂载点
#   /spike  本目录（脚本只读使用；不要在这里写大文件）
#
# 输出：$RESULTS/<实验名>.tsv，列：
#   label  rc  wall_ms  rtime_s  maxrss_kb  out_bytes  out_dur_s  expect_s  note
# ---------------------------------------------------------------------------
set -u

FFMPEG=${FFMPEG:-/tmp/bin/ffmpeg}
FFPROBE=${FFPROBE:-/usr/local/bin/ffprobe}
WORK=${WORK:-/work}
SAMPLES=${SAMPLES:-$WORK/samples}
OUT=${OUT:-$WORK/out}
RESULTS=${RESULTS:-$WORK/results}
ANALYSIS=${ANALYSIS:-$WORK/out/analysis}
mkdir -p "$SAMPLES" "$OUT" "$RESULTS" "$ANALYSIS"

# 当前实验的 TSV（由 init_exp 设置）
TSV=""

init_exp() {
  local name="$1"
  TSV="$RESULTS/$name.tsv"
  printf 'label\trc\twall_ms\trtime_s\tmaxrss_kb\tout_bytes\tout_dur_s\texpect_s\tnote\n' > "$TSV"
  echo "[exp] $name -> $TSV"
}

now_ms() { date +%s%N | cut -b1-16; }  # 毫秒级时间戳（截断到 ms）

# ffprobe 容器时长（秒，6 位小数）；失败输出 0
probe_dur() {
  local f="$1"
  [ -s "$f" ] || { echo 0; return; }
  "$FFPROBE" -v error -show_entries format=duration -of default=nw=1:nk=1 "$f" 2>/dev/null || echo 0
}

# ffprobe 采样率/声道/编码（stdout 形如 "44100|2|mp3"）
probe_stream() {
  local f="$1"
  [ -s "$f" ] || { echo "0|0|none"; return; }
  "$FFPROBE" -v error -select_streams a:0 \
    -show_entries stream=sample_rate,channels,codec_name -of csv=p=0 "$f" 2>/dev/null | head -1
}

# 精确解码时长（秒）：完整解码 a:0 → s16le 单声道，按字节数/采样率计算
# 注意：比 ffprobe 的容器时长更准（mp3/m4a 容器时长受帧对齐/estimating 影响）
exact_dur() {
  local f="$1" rate bytes
  [ -s "$f" ] || { echo 0; return; }
  rate=$("$FFPROBE" -v error -select_streams a:0 -show_entries stream=sample_rate -of default=nw=1:nk=1 "$f" 2>/dev/null | head -1)
  [ -n "$rate" ] || { echo 0; return; }
  bytes=$("$FFMPEG" -hide_banner -nostdin -loglevel error -i "$f" -map 0:a:0 -ac 1 -f s16le - 2>/dev/null | wc -c)
  awk -v b="$bytes" -v r="$rate" 'BEGIN{ if (r>0) printf "%.4f", b/(2*r); else print 0 }'
}

# 解码是否成功（完整解码一遍，返回 ffmpeg 退出码；0 表示无错误）
decode_ok() {
  local f="$1"
  "$FFMPEG" -hide_banner -nostdin -loglevel error -i "$f" -map 0:a:0 -f null - >/dev/null 2>&1
  echo $?
}

# bench_run <label> <outfile|-> <expect_s> <note> -- <cmd...>
# 用 ffmpeg -benchmark 提取 rtime/maxrss；wall_ms 用 shell 计时（含进程启动）
bench_run() {
  local label="$1" out="$2" expect="$3" note="$4"
  shift 4
  [ "${1:-}" = "--" ] && shift
  local logf t0 t1 rc wall rtime rss bytes dur safe
  safe=$(printf '%s' "$label" | tr -c 'A-Za-z0-9_.-' '_')
  logf="$RESULTS/.log_${safe}.log"
  t0=$(date +%s%N)
  "$@" >"$logf" 2>&1
  rc=$?
  t1=$(date +%s%N)
  wall=$(( (t1 - t0) / 1000000 ))
  rtime=$(sed -n 's/.*rtime=\([0-9.]*\)s.*/\1/p' "$logf" | tail -1)
  rss=$(sed -n 's/.*maxrss=\([0-9]*\)KiB.*/\1/p' "$logf" | tail -1)
  if [ "${out#-}" != "$out" ] || [ -z "$out" ]; then
    bytes=0; dur=0
  else
    if [ -f "$out" ]; then
      bytes=$(stat -c %s "$out")
      dur=$(probe_dur "$out")
    else bytes=0; dur=0; fi
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$label" "$rc" "$wall" "${rtime:-0}" "${rss:-0}" "$bytes" "$dur" "$expect" "$note" >> "$TSV"
  printf '[run] %-46s rc=%s wall=%4sms rtime=%-7s rss=%-7s dur=%-9s %s\n' \
    "$label" "$rc" "$wall" "${rtime:-?}" "${rss:-?}" "$dur" "${note:0:60}"
  if [ "$rc" != 0 ]; then
    echo "---- ffmpeg log tail ($label) ----"
    tail -12 "$logf"
    echo "-----------------------------------"
  fi
  return 0
}

# 重复 N 次同一命令，label 追加 #rN（取稳定值用；默认先跑 1 次丢弃热身可选）
bench_rep() {
  local n="$1"; shift
  local i
  for ((i = 1; i <= n; i++)); do
    bench_run "$1#r$i" "${@:2}"
  done
}

# 命令包装：优先静态 7.0.2 二进制，统一加 -hide_banner -nostdin -y
ff() { "$FFMPEG" -hide_banner -nostdin -y "$@"; }
# 带 benchmark 的 ff
ffb() { "$FFMPEG" -hide_banner -nostdin -y -benchmark "$@"; }

# 记录一行非 ffmpeg 的测量（如 Node 脚本耗时）：bench_shell <label> <outfile> <expect> <note> -- <cmd...>
bench_shell() {
  local label="$1" out="$2" expect="$3" note="$4"
  shift 4
  [ "${1:-}" = "--" ] && shift
  local t0 t1 rc wall bytes dur
  t0=$(date +%s%N); "$@" >/dev/null 2>&1; rc=$?; t1=$(date +%s%N)
  wall=$(( (t1 - t0) / 1000000 ))
  bytes=0; dur=0
  if [ -n "$out" ] && [ "$out" != "-" ] && [ -f "$out" ]; then bytes=$(stat -c %s "$out"); fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$label" "$rc" "$wall" "0" "0" "$bytes" "$dur" "$expect" "$note" >> "$TSV"
  printf '[sh ] %-46s rc=%s wall=%4sms %s\n' "$label" "$rc" "$wall" "${note:0:60}"
}

# 时间轴辅助：秒 -> HH:MM:SS.mmm
ts() { awk -v s="$1" 'BEGIN{printf "%02d:%02d:%06.3f", int(s/3600), int(s%3600/60), s%60}'; }

# 校验结果打印
verify() {
  local f="$1"
  printf '  verify %s: dur=%ss stream=%s decode_rc=%s bytes=%s\n' \
    "$(basename "$f")" "$(probe_dur "$f")" "$(probe_stream "$f")" "$(decode_ok "$f")" "$(stat -c %s "$f" 2>/dev/null || echo 0)"
}
