#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 实验 7：配乐混音（BGM 循环 / adelay 偏移 / amix duration=first / alimiter / sidechaincompress）
#   主轨 3min + 配乐 1min 循环；输出 3min mp3
# ---------------------------------------------------------------------------
set -u
source /spike/lib.sh
init_exp "07_bgm"

O="$OUT/07"; mkdir -p "$O"
MAIN="$SAMPLES/music_180s.mp3"
BGM="$SAMPLES/music_60s.mp3"
PRE="$RESULTS/07_bgm_precision.tsv"
printf 'label\tcontainer_dur\texact_dur\tdelta_ms\tdecode_rc\tnote\n' > "$PRE"
prec() {
  local label="$1" f="$2" want="$3" note="$4"
  local cd ed dms rc
  cd=$(probe_dur "$f"); ed=$(exact_dur "$f"); rc=$(decode_ok "$f")
  dms=$(awk -v a="$ed" -v b="$want" 'BEGIN{printf "%.1f", (a-b)*1000}')
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$cd" "$ed" "$dms" "$rc" "$note" >> "$PRE"
  printf '[prec] %-34s container=%-9s exact=%-9s delta=%s ms decode=%s\n' "$label" "$cd" "$ed" "$dms" "$rc"
}

# ---- A. 推荐写法：-stream_loop -1 + atrim + amix duration=first + alimiter + -t ----
A="$O/mix_loop_3m.mp3"
bench_run "mix_loop_3m" "$A" "180" "主3min+BGM(1min循环,vol0.22)+amix duration=first+alimiter+-t 180" -- \
  ffb -i "$MAIN" -stream_loop -1 -i "$BGM" -filter_complex \
    "[0:a]volume=1.0[main];[1:a]volume=0.22,atrim=0:180,asetpts=PTS-STARTPTS[bg];[main][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false[out]" \
    -map "[out]" -t 180 -c:a libmp3lame -b:a 192k "$A"
prec "mix_loop_3m" "$A" 180 "BGM 循环混音"

# ---- B. BGM 延迟 5s 进入（adelay，毫秒/每声道） ----
B="$O/mix_adelay5s_3m.mp3"
bench_run "mix_adelay5s_3m" "$B" "180" "BGM adelay=5000|5000 从第5s进入（不循环，60s 后自然结束）" -- \
  ffb -i "$MAIN" -i "$BGM" -filter_complex \
    "[0:a]volume=1.0[main];[1:a]volume=0.22,adelay=5000|5000,apad=whole_dur=180,atrim=0:180,asetpts=PTS-STARTPTS[bg];[main][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false[out]" \
    -map "[out]" -t 180 -c:a libmp3lame -b:a 192k "$B"
prec "mix_adelay5s_3m" "$B" 180 "adelay 偏移混音"

# ---- C. aloop 滤镜内循环（替代 -stream_loop；验证内存/耗时） ----
C="$O/mix_aloop_3m.mp3"
bench_run "mix_aloop_3m" "$C" "180" "aloop=loop=-1:size=2646000 循环 BGM + atrim" -- \
  ffb -i "$MAIN" -i "$BGM" -filter_complex \
    "[0:a]volume=1.0[main];[1:a]aloop=loop=-1:size=2646000,volume=0.22,atrim=0:180,asetpts=PTS-STARTPTS[bg];[main][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false[out]" \
    -map "[out]" -t 180 -c:a libmp3lame -b:a 192k "$C"
prec "mix_aloop_3m" "$C" 180 "aloop 循环"

# ---- D. amix 默认 normalize（不写 normalize=0）会有音量衰减，对比 ----
D="$O/mix_normalize_default_3m.mp3"
bench_run "mix_normalize_default_3m" "$D" "180" "amix 默认 normalize=1（两轨各被衰减~1/2）" -- \
  ffb -i "$MAIN" -stream_loop -1 -i "$BGM" -filter_complex \
    "[0:a]volume=1.0[main];[1:a]volume=0.22,atrim=0:180,asetpts=PTS-STARTPTS[bg];[main][bg]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95:level=false[out]" \
    -map "[out]" -t 180 -c:a libmp3lame -b:a 192k "$D"

# ---- E. sidechaincompress 自动闪避（P1 可行性） ----
E="$O/mix_sidechain_3m.mp3"
bench_run "mix_sidechain_3m" "$E" "180" "BGM 以主轨为 sidechain 自动闪避（threshold=0.02 ratio=8）" -- \
  ffb -i "$MAIN" -stream_loop -1 -i "$BGM" -filter_complex \
    "[0:a]volume=1.0,asplit=2[main][sc];[1:a]volume=0.30,atrim=0:180,asetpts=PTS-STARTPTS[bg];[bg][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=300[duck];[main][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false[out]" \
    -map "[out]" -t 180 -c:a libmp3lame -b:a 192k "$E"
prec "mix_sidechain_3m" "$E" 180 "sidechaincompress 自动闪避"

# ---- F. 反例：amix duration=longest + 无限循环 BGM 且无 -t（会一直跑） ----
F="$O/mix_no_t_should_timeout.mp3"
bench_run "mix_no_t_timeout" "$F" "0" "反例：duration=longest+无限循环且无 -t（预期 8s 超时被杀）" -- \
  timeout 8 "$FFMPEG" -hide_banner -nostdin -y -benchmark -i "$MAIN" -stream_loop -1 -i "$BGM" -filter_complex \
    "[0:a]volume=1.0[main];[1:a]volume=0.22[bg];[main][bg]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[out]" \
    -map "[out]" -c:a libmp3lame -b:a 192k "$F"

# ---- G. 音量平衡测量：主轨 / BGM 0.22 / 混音 的 RMS ----
for pair in "main:$MAIN" "bgm:$BGM" "mix:$A"; do
  tag=${pair%%:*}; f=${pair#*:}
  "$FFMPEG" -hide_banner -nostdin -loglevel error -i "$f" -t 30 -ac 1 -ar 44100 -f s16le "$ANALYSIS/bgm_$tag.s16le" 2>/dev/null || true
  echo "[stats] bgm_$tag -> $ANALYSIS/bgm_$tag.s16le"
done

echo "[exp07] done"
