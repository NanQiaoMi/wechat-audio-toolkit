#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 实验 2：删除中间区间（3min 输入，删除 [60s,120s] → 输出应为 120s）
#   方法A：filter_complex atrim×2 + concat 重编码（推荐）
#   方法B：先 copy 裁两段，再 concat demuxer + -c copy（最快，测风险）
#   方法C：A + acrossfade 交叉淡化 1s（消除拼接爆音）
#   额外：拼接点爆音扫描（解码 join 附近 3s 为 raw，供 analyze_pcm.js）
# ---------------------------------------------------------------------------
set -u
source /spike/lib.sh
init_exp "02_remove"

O="$OUT/02"; mkdir -p "$O"
SRC="$SAMPLES/music_180s.mp3"
PRE="$RESULTS/02_remove_precision.tsv"
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
# 从文件某时刻解码 dur 秒为 44.1k 单声道 raw（爆音扫描用）
pcm_at() {
  local f="$1" start="$2" dur="$3" tag="$4" rate="${5:-44100}"
  "$FFMPEG" -hide_banner -nostdin -loglevel error -ss "$start" -t "$dur" -i "$f" -ac 1 -ar "$rate" -f s16le "$ANALYSIS/$tag.s16le" 2>/dev/null || true
}

# ---- A. filter_complex concat 重编码 ----
A_OUT="$O/remove_filter_mp3.mp3"
bench_run "remove_filter_mp3" "$A_OUT" "120" "atrim×2+concat 重编码 mp3 192k（硬拼）" -- \
  ffb -i "$SRC" -filter_complex \
    "[0:a]atrim=start=0:end=60,asetpts=PTS-STARTPTS[a];[0:a]atrim=start=120:end=180,asetpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=0:a=1[out]" \
    -map "[out]" -c:a libmp3lame -b:a 192k "$A_OUT"
prec "remove_filter_mp3" "$A_OUT" 120 "保留[0,60)+[120,180)"
pcm_at "$A_OUT" 58.5 3 "remove_filter_join"

# 同上但 m4a 输出
bench_run "remove_filter_m4a" "$O/remove_filter_m4a.m4a" "120" "atrim×2+concat 重编码 aac fast" -- \
  ffb -i "$SRC" -filter_complex \
    "[0:a]atrim=start=0:end=60,asetpts=PTS-STARTPTS[a];[0:a]atrim=start=120:end=180,asetpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=0:a=1[out]" \
    -map "[out]" -c:a aac -aac_coder fast -b:a 192k -movflags +faststart "$O/remove_filter_m4a.m4a"
prec "remove_filter_m4a" "$O/remove_filter_m4a.m4a" 120 "aac fast 硬拼"

# ---- B. 两段 copy + concat demuxer（最快，测风险） ----
bench_run "seg1_copy_0_60" "$O/seg1.mp3" "60" "copy 裁 [0,60]" -- \
  ffb -ss 0 -t 60 -i "$SRC" -c copy "$O/seg1.mp3"
bench_run "seg2_copy_120_180" "$O/seg2.mp3" "60" "copy 裁 [120,180]" -- \
  ffb -ss 120 -t 60 -i "$SRC" -c copy "$O/seg2.mp3"
prec "seg1_copy" "$O/seg1.mp3" 60 "copy 段1"
prec "seg2_copy" "$O/seg2.mp3" 60 "copy 段2"
printf "file '%s'\nfile '%s'\n" "$O/seg1.mp3" "$O/seg2.mp3" > "$O/list.txt"
B_OUT="$O/remove_concatcopy_mp3.mp3"
bench_run "remove_concatcopy_mp3" "$B_OUT" "120" "concat demuxer + copy 拼接 mp3" -- \
  ffb -f concat -safe 0 -i "$O/list.txt" -c copy "$B_OUT"
prec "remove_concatcopy_mp3" "$B_OUT" 120 "concat demuxer copy（无重编码）"
pcm_at "$B_OUT" 58.5 3 "remove_concatcopy_join"
decode_ok "$B_OUT" >/dev/null && echo "[check] concatcopy decode ok" || echo "[check] concatcopy decode FAILED"

# 拼接后容器时长 vs 精确解码时长（mp3 gapless/帧对齐问题）
echo "[check] concatcopy container_dur=$(probe_dur "$B_OUT") exact_dur=$(exact_dur "$B_OUT")"

# ---- C. acrossfade 交叉淡化（0.05s / 1s） ----
CF_OUT="$O/remove_filter_crossfade1s_mp3.mp3"
bench_run "remove_filter_crossfade1s_mp3" "$CF_OUT" "119" "concat 后跨段 acrossfade=1s（输出 119s）" -- \
  ffb -i "$SRC" -filter_complex \
    "[0:a]atrim=start=0:end=60,asetpts=PTS-STARTPTS[a];[0:a]atrim=start=120:end=180,asetpts=PTS-STARTPTS[b];[a][b]acrossfade=d=1:c1=tri:c2=tri[out]" \
    -map "[out]" -c:a libmp3lame -b:a 192k "$CF_OUT"
prec "remove_filter_crossfade1s_mp3" "$CF_OUT" 119 "acrossfade 1s → 60+60-1=119s"
pcm_at "$CF_OUT" 57.5 3 "remove_crossfade_join"

# ---- D. 参考：整段重编码（无剪辑）供爆音基线 ----
REF="$O/ref_full_mp3.mp3"
bench_run "ref_full_mp3" "$REF" "180" "3min 整段重编码（爆音基线）" -- \
  ffb -i "$SRC" -c:a libmp3lame -b:a 192k "$REF"
pcm_at "$REF" 58.5 3 "ref_join"

# ---- E. 5min 输入删一段（线性外推参考） ----
bench_run "remove_5m_filter_mp3" "$O/remove_5m_filter_mp3.mp3" "240" "5min 输入删 [60,120] → 240s" -- \
  ffb -i "$SAMPLES/music_300s.mp3" -filter_complex \
    "[0:a]atrim=start=0:end=60,asetpts=PTS-STARTPTS[a];[0:a]atrim=start=120:end=300,asetpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=0:a=1[out]" \
    -map "[out]" -c:a libmp3lame -b:a 192k "$O/remove_5m_filter_mp3.mp3"
prec "remove_5m_filter_mp3" "$O/remove_5m_filter_mp3.mp3" 240 "5min 删 60s"

echo "[exp02] done"
