#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 实验 3：多文件拼接（同格式 / 异格式 / 参数不一致归一化）
#   - 2×3min mp3：filter concat 重编码 vs concat demuxer copy
#   - 3×2min mp3：filter concat
#   - 混合源：mp3 44.1k stereo + 8k mono wav + m4a 44.1k → aresample/aformat 归一
#   - 反例：不做归一直接 concat（预期失败）
# ---------------------------------------------------------------------------
set -u
source /spike/lib.sh
init_exp "03_concat_multi"

O="$OUT/03"; mkdir -p "$O"
PRE="$RESULTS/03_concat_precision.tsv"
printf 'label\tcontainer_dur\texact_dur\tdelta_ms\tdecode_rc\tnote\n' > "$PRE"
prec() {
  local label="$1" f="$2" want="$3" note="$4"
  [ -s "$f" ] || { printf '%s\t-\t-\t-\t-\tFILE_MISSING %s\n' "$label" "$note" >> "$PRE"; return; }
  local cd ed dms rc
  cd=$(probe_dur "$f"); ed=$(exact_dur "$f"); rc=$(decode_ok "$f")
  dms=$(awk -v a="$ed" -v b="$want" 'BEGIN{printf "%.1f", (a-b)*1000}')
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$cd" "$ed" "$dms" "$rc" "$note" >> "$PRE"
  printf '[prec] %-38s container=%-9s exact=%-9s delta=%s ms decode=%s\n' "$label" "$cd" "$ed" "$dms" "$rc"
}

# ---- 准备 3 个 2min 片段（2×3min 与 3×2min 均需要） ----
for p in 0 1 2; do
  s=$((p * 120))
  w="$O/part2m_$p.wav"
  [ -s "$w" ] || ff -ss "$s" -t 120 -i "$SAMPLES/music_600s.wav" -c:a copy "$w" 2>/dev/null
  m="$O/part2m_$p.mp3"
  [ -s "$m" ] || bench_run "gen_part2m_${p}_mp3" "$m" "120" "2min 片段 $p mp3 192k" -- \
    ffb -i "$w" -c:a libmp3lame -b:a 192k "$m"
done

# ---- A. 2×3min mp3：filter concat ----
A="$O/concat_2x3m_filter.mp3"
bench_run "concat_2x3m_filter" "$A" "360" "2×3min mp3 filter concat 重编码" -- \
  ffb -i "$SAMPLES/music_180s.mp3" -i "$SAMPLES/music_180s_128.mp3" -filter_complex \
    "[0:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a0];[1:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a1];[a0][a1]concat=n=2:v=0:a=1[out]" \
    -map "[out]" -c:a libmp3lame -b:a 192k "$A"
prec "concat_2x3m_filter" "$A" 360 "192k+128k 归一后拼接"

# ---- B. 2×3min mp3：concat demuxer copy ----
printf "file '%s'\nfile '%s'\n" "$SAMPLES/music_180s.mp3" "$SAMPLES/music_180s_128.mp3" > "$O/list2x3.txt"
B="$O/concat_2x3_copy.mp3"
bench_run "concat_2x3_copy" "$B" "360" "2×3min 不同码率 mp3 concat demuxer copy" -- \
  ffb -f concat -safe 0 -i "$O/list2x3.txt" -c copy "$B"
prec "concat_2x3_copy" "$B" 360 "不同码率 copy 拼接（容器支持性测试）"

# 同码率 copy 拼接
printf "file '%s'\nfile '%s'\n" "$SAMPLES/music_180s.mp3" "$SAMPLES/music_180s.mp3" > "$O/list2x3same.txt"
B2="$O/concat_2x3same_copy.mp3"
bench_run "concat_2x3same_copy" "$B2" "360" "2×3min 同码率 mp3 concat demuxer copy" -- \
  ffb -f concat -safe 0 -i "$O/list2x3same.txt" -c copy "$B2"
prec "concat_2x3same_copy" "$B2" 360 "同码率 copy 拼接"

# ---- C. 3×2min mp3：filter concat ----
C="$O/concat_3x2m_filter.mp3"
bench_run "concat_3x2m_filter" "$C" "360" "3×2min mp3 filter concat 重编码" -- \
  ffb -i "$O/part2m_0.mp3" -i "$O/part2m_1.mp3" -i "$O/part2m_2.mp3" -filter_complex \
    "[0:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a0];[1:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a1];[2:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a2];[a0][a1][a2]concat=n=3:v=0:a=1[out]" \
    -map "[out]" -c:a libmp3lame -b:a 192k "$C"
prec "concat_3x2m_filter" "$C" 360 "3 段 2min 拼接"

# ---- D. 混合格式/参数归一（mp3 44.1k stereo + 8k mono wav + m4a） ----
D="$O/concat_mixed_norm.mp3"
bench_run "concat_mixed_norm" "$D" "90" "mp3 44.1k+8k mono wav+m4a 归一后拼接" -- \
  ffb -i "$SAMPLES/music_60s.mp3" -i "$SAMPLES/edge_8k_mono.wav" -i "$SAMPLES/music_60s.m4a" -filter_complex \
    "[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a0];[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a1];[2:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a2];[a0][a1][a2]concat=n=3:v=0:a=1[out]" \
    -map "[out]" -c:a libmp3lame -b:a 192k "$D"
prec "concat_mixed_norm" "$D" 120 "60s+30s+60s=150s? 以实际为准"

# ---- E. 反例：不归一直接 concat ----
E="$O/concat_mixed_raw.mp3"
bench_run "concat_mixed_raw_FAIL" "$E" "150" "反例：不 aresample/aformat 直接 concat（预期失败）" -- \
  ffb -i "$SAMPLES/music_60s.mp3" -i "$SAMPLES/edge_8k_mono.wav" -filter_complex \
    "[0:a][1:a]concat=n=2:v=0:a=1[out]" -map "[out]" -c:a libmp3lame -b:a 192k "$E"

# ---- F. 拼接结果爆音扫描（2×3min filter 拼接的接缝在 180s） ----
"$FFMPEG" -hide_banner -nostdin -loglevel error -ss 178.5 -t 3 -i "$A" -ac 1 -ar 44100 -f s16le "$ANALYSIS/concat_filter_join.s16le" 2>/dev/null || true
"$FFMPEG" -hide_banner -nostdin -loglevel error -ss 178.5 -t 3 -i "$B2" -ac 1 -ar 44100 -f s16le "$ANALYSIS/concat_copy_join.s16le" 2>/dev/null || true

echo "[exp03] done"
