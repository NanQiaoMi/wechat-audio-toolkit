#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 实验 10：完整编辑计划 —— 一条 filter_complex 命令完成
#   裁剪 + 删除片段 + 拼接 + 音量 + 淡入淡出 + 1.5x 变速 + 1min BGM 循环混音 + alimiter
#
# 计划示例（10min 主音频）：
#   keep1 = [0,120)  keep2 = [300,600) → 420s；atempo=1.5 → 280s
#   BGM 60s 循环铺满 280s @ volume 0.20；最终 afade in 3s / out 5s；alimiter；-t 280
# 同时测 3min / 5min 版本，以及 m4a 输出 10min 版本。
# ---------------------------------------------------------------------------
set -u
source /spike/lib.sh
init_exp "10_full_edit"

O="$OUT/10"; mkdir -p "$O"
PRE="$RESULTS/10_full_edit_precision.tsv"
printf 'label\tcontainer_dur\texact_dur\tdelta_ms\tdecode_rc\tnote\n' > "$PRE"
prec() {
  local label="$1" f="$2" want="$3" note="$4"
  local cd ed dms rc
  cd=$(probe_dur "$f"); ed=$(exact_dur "$f"); rc=$(decode_ok "$f")
  dms=$(awk -v a="$ed" -v b="$want" 'BEGIN{printf "%.1f", (a-b)*1000}')
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$cd" "$ed" "$dms" "$rc" "$note" >> "$PRE"
  printf '[prec] %-34s container=%-9s exact=%-9s delta=%s ms decode=%s\n' "$label" "$cd" "$ed" "$dms" "$rc"
}

# 生成计划函数：$1=主输入 $2=keep2 起点 $3=总时长(未变速) $4=输出时长(变速后) $5=输出文件 $6=编码参数 $7=BGM
run_plan() {
  local input="$1" k2s="$2" total="$3" outdur="$4" out="$5" codec="$6" bgm="${7:-$SAMPLES/music_60s.mp3}"
  local fadeout_st
  fadeout_st=$(awk -v d="$outdur" 'BEGIN{printf "%.3f", d-5}')
  bench_run "$(basename "$out" .mp3)" "$out" "$outdur" \
    "keep [0,120)+[${k2s},${total}) → atempo1.5 → ${outdur}s + BGM循环 + fade + alimiter" -- \
    ffb -i "$input" -stream_loop -1 -i "$bgm" -filter_complex \
      "[0:a]atrim=start=0:end=120,asetpts=PTS-STARTPTS[s1];[0:a]atrim=start=${k2s}:end=${total},asetpts=PTS-STARTPTS[s2];[s1][s2]concat=n=2:v=0:a=1,atempo=1.5,volume=-3dB[main];[1:a]volume=0.20,atrim=0:${outdur},asetpts=PTS-STARTPTS[bg];[main][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,afade=t=in:st=0:d=3,afade=t=out:st=${fadeout_st}:d=5,alimiter=limit=0.95:level=false[out]" \
      -map "[out]" -t "$outdur" $codec "$out"
}

# ---- A. 10min 主音频（keep [0,120)+[300,600) = 420s → 1.5x = 280s） ----
A="$O/full_10m_mp3.mp3"
run_plan "$SAMPLES/music_600s.mp3" 300 600 280 "$A" "-c:a libmp3lame -b:a 192k"
prec "full_10m_mp3" "$A" 280 "10min→280s 最坏组合"
pcm_head() { "$FFMPEG" -hide_banner -nostdin -loglevel error -i "$1" -t "${3:-4}" -ac 1 -ar 44100 -f s16le "$ANALYSIS/$2.s16le" 2>/dev/null || true; }
pcm_head "$A" full_10m_head 4
"$FFMPEG" -hide_banner -nostdin -loglevel error -ss 274 -t 5 -i "$A" -ac 1 -ar 44100 -f s16le "$ANALYSIS/full_10m_tail.s16le" 2>/dev/null || true

# ---- B. 5min 主音频（keep [0,120)+[300,420) = 240s → 1.5x = 160s） ----
B="$O/full_5m_mp3.mp3"
run_plan "$SAMPLES/music_300s.mp3" 300 420 160 "$B" "-c:a libmp3lame -b:a 192k"
prec "full_5m_mp3" "$B" 160 "5min→160s"

# ---- C. 3min 主音频（keep [0,120)+[150,180) = 150s → 1.5x = 100s） ----
C="$O/full_3m_mp3.mp3"
run_plan "$SAMPLES/music_180s.mp3" 150 180 100 "$C" "-c:a libmp3lame -b:a 192k"
prec "full_3m_mp3" "$C" 100 "3min→100s"

# ---- D. 10min → m4a 输出（aac fast） ----
D="$O/full_10m_m4a.m4a"
run_plan "$SAMPLES/music_600s.mp3" 300 600 280 "$D" "-c:a aac -aac_coder fast -b:a 192k -movflags +faststart"
prec "full_10m_m4a" "$D" 280 "10min→m4a 280s"

# ---- E. 10min → wav 输出（体积/耗时参考） ----
E="$O/full_10m_wav.wav"
run_plan "$SAMPLES/music_600s.mp3" 300 600 280 "$E" "-c:a pcm_s16le -ar 44100 -ac 2"
prec "full_10m_wav" "$E" 280 "10min→wav 280s"

# ---- F. 10min → flac 输出 ----
F="$O/full_10m_flac.flac"
run_plan "$SAMPLES/music_600s.mp3" 300 600 280 "$F" "-c:a flac -compression_level 5"
prec "full_10m_flac" "$F" 280 "10min→flac 280s"

# ---- G. 不做变速的 10min 版本（分解变速成本，便于解释耗时构成） ----
G="$O/full_10m_notempo_mp3.mp3"
bench_run "full_10m_notempo_mp3" "$G" "420" "10min 同计划但去掉 atempo（420s 输出）" -- \
  ffb -i "$SAMPLES/music_600s.mp3" -stream_loop -1 -i "$SAMPLES/music_60s.mp3" -filter_complex \
    "[0:a]atrim=start=0:end=120,asetpts=PTS-STARTPTS[s1];[0:a]atrim=start=300:end=600,asetpts=PTS-STARTPTS[s2];[s1][s2]concat=n=2:v=0:a=1,volume=-3dB[main];[1:a]volume=0.20,atrim=0:420,asetpts=PTS-STARTPTS[bg];[main][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,afade=t=in:st=0:d=3,afade=t=out:st=415:d=5,alimiter=limit=0.95:level=false[out]" \
    -map "[out]" -t 420 -c:a libmp3lame -b:a 192k "$G"
prec "full_10m_notempo_mp3" "$G" 420 "无变速对照"

# ---- H. -progress pipe:1 支持验证（云函数进度上报） ----
PROG="$O/progress_probe.mp3"
timeout 60 "$FFMPEG" -hide_banner -nostdin -y -benchmark -progress pipe:1 -stats_period 0.5 -i "$SAMPLES/music_300s.mp3" -af "atempo=1.5,alimiter=limit=0.95:level=false" -c:a libmp3lame -b:a 192k "$PROG" > "$OUT/10/progress_lines.txt" 2>/dev/null
echo "[progress] ffmpeg -progress 输出行数: $(wc -l < "$OUT/10/progress_lines.txt")"
echo "[progress] 首 12 行:"; head -12 "$OUT/10/progress_lines.txt" | sed 's/^/    /'
echo "[progress] 尾 8 行:"; tail -8 "$OUT/10/progress_lines.txt" | sed 's/^/    /'
echo "[progress] 含 out_time_us 行数: $(grep -c out_time_us "$OUT/10/progress_lines.txt")"

echo "[exp10] done"
