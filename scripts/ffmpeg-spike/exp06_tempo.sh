#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 实验 6：变速 atempo（0.5~2.0，>2 串联）/ 音调保持验证 / rubberband / asetrate 变调
# ---------------------------------------------------------------------------
set -u
source /spike/lib.sh
init_exp "06_tempo"

O="$OUT/06"; mkdir -p "$O"
PRE="$RESULTS/06_tempo_precision.tsv"
printf 'label\tcontainer_dur\texact_dur\tdelta_ms\tdecode_rc\tnote\n' > "$PRE"
prec() {
  local label="$1" f="$2" want="$3" note="$4"
  local cd ed dms rc
  cd=$(probe_dur "$f"); ed=$(exact_dur "$f"); rc=$(decode_ok "$f")
  dms=$(awk -v a="$ed" -v b="$want" 'BEGIN{printf "%.1f", (a-b)*1000}')
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$cd" "$ed" "$dms" "$rc" "$note" >> "$PRE"
  printf '[prec] %-34s container=%-9s exact=%-9s delta=%s ms decode=%s\n' "$label" "$cd" "$ed" "$dms" "$rc"
}
# 解码前 n 秒为 44.1k 单声道 raw（自相关测基频）
pcm_head() { "$FFMPEG" -hide_banner -nostdin -loglevel error -i "$1" -t "${3:-2}" -ac 1 -ar 44100 -f s16le "$ANALYSIS/$2.s16le" 2>/dev/null || true; }

SRC="$SAMPLES/music_180s.mp3"

# ---- A. 五种档位（输入 3min，期望输出 = 180 / speed） ----
for spec in "0.5:360" "0.75:240" "1.25:144" "1.5:120" "2.0:90"; do
  sp=${spec%%:*}; want=${spec##*:}
  bench_run "atempo_${sp//./}_3m" "$O/atempo_${sp//./}.mp3" "$want" "atempo=$sp 3min→${want}s" -- \
    ffb -i "$SRC" -af "atempo=$sp" -c:a libmp3lame -b:a 192k "$O/atempo_${sp//./}.mp3"
  prec "atempo_${sp//./}_3m" "$O/atempo_${sp//./}.mp3" "$want" "atempo=$sp"
done

# ---- B. 4x：必须串联 atempo（单个 atempo 上限 2.0） ----
bench_run "atempo_4x_chained_3m" "$O/atempo_4x.mp3" "45" "atempo=2,atempo=2 → 45s" -- \
  ffb -i "$SRC" -af "atempo=2,atempo=2" -c:a libmp3lame -b:a 192k "$O/atempo_4x.mp3"
prec "atempo_4x_chained_3m" "$O/atempo_4x.mp3" 45 "4x 串联"
bench_run "atempo_3x_chained_3m" "$O/atempo_3x.mp3" "60" "atempo=2,atempo=1.5 → 60s" -- \
  ffb -i "$SRC" -af "atempo=2,atempo=1.5" -c:a libmp3lame -b:a 192k "$O/atempo_3x.mp3"

# ---- C. 音调验证：440Hz 正弦，atempo 后基频应仍为 440Hz ----
SINE="$SAMPLES/sine_440_5s.wav"
[ -s "$SINE" ] || ff -f lavfi -i "sine=frequency=440:duration=5:sample_rate=44100" -c:a pcm_s16le "$SINE"
ff -i "$SINE" -af "atempo=1.5" -c:a pcm_s16le "$O/sine_tempo15.wav" 2>/dev/null
ff -i "$SINE" -af "asetrate=66150,aresample=44100" -c:a pcm_s16le "$O/sine_asetrate15.wav" 2>/dev/null
ff -i "$SINE" -af "rubberband=tempo=1.5" -c:a pcm_s16le "$O/sine_rubber_tempo15.wav" 2>/dev/null
ff -i "$SINE" -af "rubberband=pitch=1.5" -c:a pcm_s16le "$O/sine_rubber_pitch15.wav" 2>/dev/null
for f in "$SINE" "$O/sine_tempo15.wav" "$O/sine_asetrate15.wav" "$O/sine_rubber_tempo15.wav" "$O/sine_rubber_pitch15.wav"; do
  tag=$(basename "$f" .wav)
  pcm_head "$f" "pitch_$tag" 2
  echo "[pitch] $tag dur=$(probe_dur "$f") -> $ANALYSIS/pitch_$tag.s16le"
done

# ---- D. rubberband 变速（保持音调）性能与时长（3min） ----
bench_run "rubberband_tempo15_3m" "$O/rubberband_tempo15.mp3" "120" "rubberband=tempo=1.5（保持音调）" -- \
  ffb -i "$SRC" -af "rubberband=tempo=1.5" -c:a libmp3lame -b:a 192k "$O/rubberband_tempo15.mp3"
prec "rubberband_tempo15_3m" "$O/rubberband_tempo15.mp3" 120 "rubberband 1.5x"
bench_run "rubberband_tempo05_3m" "$O/rubberband_tempo05.mp3" "360" "rubberband=tempo=0.5（保持音调）" -- \
  ffb -i "$SRC" -af "rubberband=tempo=0.5" -c:a libmp3lame -b:a 192k "$O/rubberband_tempo05.mp3"

# ---- E. asetrate 变调（不保持音调，V1.1 可选） ----
bench_run "asetrate_pitch_up_3m" "$O/asetrate_pitch_up.mp3" "120" "asetrate=66150,aresample=44100（变速变调 = 1.5x 花栗鼠）" -- \
  ffb -i "$SRC" -af "asetrate=66150,aresample=44100" -c:a libmp3lame -b:a 192k "$O/asetrate_pitch_up.mp3"
prec "asetrate_pitch_up_3m" "$O/asetrate_pitch_up.mp3" 120 "asetrate 变调"
# 变调但保持时长：asetrate + atempo 补偿
bench_run "pitchshift_keepdur_3m" "$O/pitchshift_keepdur.mp3" "180" "asetrate=66150,aresample=44100,atempo=0.6667（升调保时长）" -- \
  ffb -i "$SRC" -af "asetrate=66150,aresample=44100,atempo=0.6666667" -c:a libmp3lame -b:a 192k "$O/pitchshift_keepdur.mp3"
prec "pitchshift_keepdur_3m" "$O/pitchshift_keepdur.mp3" 180 "升调保持时长"

# ---- F. 变速 + 裁剪组合（输出时长计算：先裁后变速） ----
bench_run "trim120_tempo15" "$O/trim120_tempo15.mp3" "80" "裁剪60s再 atempo=1.5 → 40s? 用例：atrim 0-120 后 1.5x = 80s" -- \
  ffb -i "$SRC" -af "atrim=start=0:end=120,asetpts=PTS-STARTPTS,atempo=1.5" -c:a libmp3lame -b:a 192k "$O/trim120_tempo15.mp3"
prec "trim120_tempo15" "$O/trim120_tempo15.mp3" 80 "120s/1.5=80s"

echo "[exp06] done"
