#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 实验 8：静音清理 silenceremove（铃声/语音的前后静音、中间停顿）
# ---------------------------------------------------------------------------
set -u
source /spike/lib.sh
init_exp "08_silence"

O="$OUT/08"; mkdir -p "$O"
PRE="$RESULTS/08_silence_precision.tsv"
printf 'label\tcontainer_dur\texact_dur\tdelta_ms\tdecode_rc\tnote\n' > "$PRE"
prec() {
  local label="$1" f="$2" want="$3" note="$4"
  local cd ed dms rc
  cd=$(probe_dur "$f"); ed=$(exact_dur "$f"); rc=$(decode_ok "$f")
  dms=$(awk -v a="$ed" -v b="$want" 'BEGIN{printf "%.1f", (a-b)*1000}')
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$cd" "$ed" "$dms" "$rc" "$note" >> "$PRE"
  printf '[prec] %-34s container=%-9s exact=%-9s delta=%s ms decode=%s\n' "$label" "$cd" "$ed" "$dms" "$rc"
}

# 语音样本：前后各 2s 数字静音 + 中间正常音乐（模拟录音/语音条）
VOICE="$SAMPLES/voice_64s.mp3"
if [ ! -s "$VOICE" ]; then
  bench_run "gen_voice_64s" "$VOICE" "64" "音乐前后各补 2s 静音（adelay+apad）" -- \
    ffb -i "$SAMPLES/music_60s.mp3" -af "adelay=2000|2000,apad=pad_dur=2" -c:a libmp3lame -b:a 192k "$VOICE"
fi

# ---- A. 去掉首尾静音（start_periods=1 / stop_periods=1） ----
A="$O/trim_edges.mp3"
bench_run "silence_trim_edges" "$A" "60" "silenceremove 去首尾静音(-50dB/0.1s)" -- \
  ffb -i "$VOICE" -af "silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB:stop_periods=1:stop_duration=0.1:stop_threshold=-50dB,asetpts=PTS-STARTPTS" \
     -c:a libmp3lame -b:a 192k "$A"
prec "silence_trim_edges" "$A" 60 "64s→约60s"

# ---- B. 铃声场景：删除中间的静音段（stop_periods=-1） ----
B="$O/ringtone_compact.mp3"
bench_run "silence_compact_40s" "$B" "24" "silenceremove 删除所有>0.3s 停顿(1.2s响/0.8s静)" -- \
  ffb -i "$SAMPLES/ringtone_40s.mp3" -af "silenceremove=stop_periods=-1:stop_duration=0.3:stop_threshold=-50dB:stop_silence=0.05,asetpts=PTS-STARTPTS" \
     -c:a libmp3lame -b:a 192k "$B"
prec "silence_compact_40s" "$B" "24" "40s→约24s（理论：去掉约16s静音）"

# ---- C. 阈值敏感性（-50/-40/-30dB） ----
for th in -50 -40 -30; do
  out="$O/compact_${th#-}db.mp3"
  bench_run "silence_threshold_${th#-}db" "$out" "24" "stop_threshold=${th}dB 阈值敏感性" -- \
    ffb -i "$SAMPLES/ringtone_40s.mp3" -af "silenceremove=stop_periods=-1:stop_duration=0.3:stop_threshold=${th}dB,asetpts=PTS-STARTPTS" \
       -c:a libmp3lame -b:a 192k "$out"
  prec "silence_threshold_${th#-}db" "$out" "24" "threshold=${th}dB"
done

# ---- D. 前后都处理 + 中间停顿一起（一条命令） ----
D="$O/voice_clean_all.mp3"
bench_run "silence_all_40s" "$D" "24" "start_periods=1+stop_periods=-1 组合" -- \
  ffb -i "$SAMPLES/ringtone_40s.mp3" -af "silenceremove=start_periods=1:start_duration=0.05:start_threshold=-50dB:stop_periods=-1:stop_duration=0.3:stop_threshold=-50dB,asetpts=PTS-STARTPTS" \
     -c:a libmp3lame -b:a 192k "$D"

# ---- E. 波形包络（证明静音确实被删） ----
"$FFMPEG" -hide_banner -nostdin -loglevel error -i "$D" -ac 1 -ar 4000 -f s16le "$ANALYSIS/silence_clean_4k.s16le" 2>/dev/null || true
"$FFMPEG" -hide_banner -nostdin -loglevel error -i "$SAMPLES/ringtone_40s.mp3" -ac 1 -ar 4000 -f s16le "$ANALYSIS/silence_src_4k.s16le" 2>/dev/null || true

echo "[exp08] done"
