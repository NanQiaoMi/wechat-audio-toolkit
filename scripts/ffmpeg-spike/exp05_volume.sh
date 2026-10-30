#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 实验 5：音量 volume / 削波 / alimiter / loudnorm（单遍+双遍）
#   关键坑：loudnorm 默认输出 192kHz；alimiter 默认 level=1 会自动增益
# ---------------------------------------------------------------------------
set -u
source /spike/lib.sh
init_exp "05_volume"

O="$OUT/05"; mkdir -p "$O"
SRC="$SAMPLES/music_300s.mp3"        # 5min
SRC60="$SAMPLES/music_60s.mp3"
EBU_MAX=95

# 用 ebur128 读集成响度（解析 "I: -16.0 LUFS"）
lufs() {
  local f="$1"
  "$FFMPEG" -hide_banner -nostdin -i "$f" -af ebur128=peak=true -f null - 2>&1 \
    | sed -n 's/.*I: *\(-\?[0-9.]*\) LUFS.*/\1/p' | tail -1
}
# 峰值/削波统计（解码 60s 为 raw 后交给 analyze_pcm stats）
peakstats() {
  local f="$1" tag="$2" dur="${3:-60}"
  "$FFMPEG" -hide_banner -nostdin -loglevel error -i "$f" -t "$dur" -ac 1 -ar 44100 -f s16le "$ANALYSIS/$tag.s16le" 2>/dev/null || true
  node_run() { :; }
  echo "[raw] $ANALYSIS/$tag.s16le $(stat -c %s "$ANALYSIS/$tag.s16le" 2>/dev/null || echo 0) bytes"
}

# ---- A. volume ±dB（输出 mp3，体验端到端） ----
bench_run "volume_plus6dB_60s" "$O/vol_p6.mp3" "60" "volume=+6dB" -- \
  ffb -i "$SRC60" -af "volume=6dB" -c:a libmp3lame -b:a 192k "$O/vol_p6.mp3"
bench_run "volume_minus6dB_60s" "$O/vol_m6.mp3" "60" "volume=-6dB" -- \
  ffb -i "$SRC60" -af "volume=-6dB" -c:a libmp3lame -b:a 192k "$O/vol_m6.mp3"
bench_run "volume_plus18dB_60s" "$O/vol_p18.mp3" "60" "volume=+18dB（应削波）" -- \
  ffb -i "$SRC60" -af "volume=18dB" -c:a libmp3lame -b:a 192k "$O/vol_p18.mp3"

# ---- B. alimiter 两种写法（level 默认 vs disabled） ----
bench_run "volume18_alimiter_default_60s" "$O/vol_p18_lim_default.mp3" "60" "volume=+18dB,alimiter=limit=0.95（默认 level=1 会自动增益）" -- \
  ffb -i "$SRC60" -af "volume=18dB,alimiter=limit=0.95" -c:a libmp3lame -b:a 192k "$O/vol_p18_lim_default.mp3"
bench_run "volume18_alimiter_disabled_60s" "$O/vol_p18_lim_disabled.mp3" "60" "volume=+18dB,alimiter=limit=0.95:level=false" -- \
  ffb -i "$SRC60" -af "volume=18dB,alimiter=limit=0.95:level=false" -c:a libmp3lame -b:a 192k "$O/vol_p18_lim_disabled.mp3"

# 解码 raw 供 stats 分析
for pair in "vol_orig:$SRC60" "vol_p6:$O/vol_p6.mp3" "vol_p18:$O/vol_p18.mp3" \
            "vol_p18_lim_default:$O/vol_p18_lim_default.mp3" "vol_p18_lim_disabled:$O/vol_p18_lim_disabled.mp3"; do
  tag=${pair%%:*}; f=${pair#*:}
  "$FFMPEG" -hide_banner -nostdin -loglevel error -i "$f" -t 20 -ac 1 -ar 44100 -f s16le "$ANALYSIS/$tag.s16le" 2>/dev/null || true
  echo "[stats] $tag -> $ANALYSIS/$tag.s16le"
done

# ---- C. loudnorm 单遍（5min / 10min），注意输出采样率 ----
bench_run "loudnorm_single_5m" "$O/loudnorm_single_5m.mp3" "300" "loudnorm I=-16:TP=-1.5:LRA=11 单遍（未加 -ar）" -- \
  ffb -i "$SRC" -af "loudnorm=I=-16:TP=-1.5:LRA=11" -c:a libmp3lame -b:a 192k "$O/loudnorm_single_5m.mp3"
echo "[probe] loudnorm 单遍输出流参数: $(probe_stream "$O/loudnorm_single_5m.mp3")"
echo "[probe] loudnorm 单遍输出响度: I=$(lufs "$O/loudnorm_single_5m.mp3") LUFS"

bench_run "loudnorm_single_5m_ar44k" "$O/loudnorm_single_5m_ar44k.mp3" "300" "loudnorm + -ar 44100（修正）" -- \
  ffb -i "$SRC" -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 44100 -c:a libmp3lame -b:a 192k "$O/loudnorm_single_5m_ar44k.mp3"
echo "[probe] 修正后输出流参数: $(probe_stream "$O/loudnorm_single_5m_ar44k.mp3")"
echo "[probe] 修正后响度: I=$(lufs "$O/loudnorm_single_5m_ar44k.mp3") LUFS"

bench_run "loudnorm_single_10m" "$O/loudnorm_single_10m.mp3" "600" "loudnorm 单遍 10min" -- \
  ffb -i "$SAMPLES/music_600s.mp3" -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 44100 -c:a libmp3lame -b:a 192k "$O/loudnorm_single_10m.mp3"
echo "[probe] 10min loudnorm 后: I=$(lufs "$O/loudnorm_single_10m.mp3") LUFS"

# ---- D. loudnorm 双遍（5min）：pass1 测量 JSON → pass2 应用 ----
P1="$O/loudnorm_pass1.json"
bench_run "loudnorm_pass1_5m" "-" "300" "loudnorm 双遍 pass1: print_format=json 仅分析" -- \
  ffb -i "$SRC" -af "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json" -f null - 
# 从日志里提取 pass1 JSON（bench_run 的日志文件）
LOG1="$RESULTS/.log_loudnorm_pass1_5m.log"
"$FFMPEG" -hide_banner -nostdin -i "$SRC" -af "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json" -f null - 2> "$P1" || true
echo "[pass1] $(tail -20 "$P1" | tr -d '\n' | head -c 400)"
MI=$(sed -n 's/.*"input_i" : "\([-0-9.]*\)".*/\1/p' "$P1")
MTP=$(sed -n 's/.*"input_tp" : "\([-0-9.]*\)".*/\1/p' "$P1")
MLRA=$(sed -n 's/.*"input_lra" : "\([-0-9.]*\)".*/\1/p' "$P1")
MTH=$(sed -n 's/.*"input_thresh" : "\([-0-9.]*\)".*/\1/p' "$P1")
MOFF=$(sed -n 's/.*"target_offset" : "\([-0-9.]*\)".*/\1/p' "$P1")
echo "[pass1] input_i=$MI input_tp=$MTP input_lra=$MLRA input_thresh=$MTH target_offset=$MOFF"
bench_run "loudnorm_pass2_5m" "$O/loudnorm_2pass_5m.mp3" "300" "loudnorm 双遍 pass2: measured_* 应用" -- \
  ffb -i "$SRC" -af "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=$MI:measured_TP=$MTP:measured_LRA=$MLRA:measured_thresh=$MTH:offset=$MOFF" \
     -ar 44100 -c:a libmp3lame -b:a 192k "$O/loudnorm_2pass_5m.mp3"
echo "[probe] 双遍输出响度: I=$(lufs "$O/loudnorm_2pass_5m.mp3") LUFS"

# ---- E. 常用组合：volume 规范化 + alimiter 防削波 + -3dB ----
bench_run "volume_norm_limiter_5m" "$O/vol_norm_limiter_5m.mp3" "300" "volume=+4dB,alimiter=level=false 5min" -- \
  ffb -i "$SRC" -af "volume=4dB,alimiter=limit=0.95:level=false" -c:a libmp3lame -b:a 192k "$O/vol_norm_limiter_5m.mp3"

echo "[exp05] done"
