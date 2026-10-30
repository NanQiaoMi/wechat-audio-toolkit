#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 实验 4：淡入淡出 afade（与裁剪/拼接组合、st 计算、MP3 编码器延迟影响）
# ---------------------------------------------------------------------------
set -u
source /spike/lib.sh
init_exp "04_fade"

O="$OUT/04"; mkdir -p "$O"
PRE="$RESULTS/04_fade_precision.tsv"
printf 'label\tcontainer_dur\texact_dur\tdelta_ms\tdecode_rc\tnote\n' > "$PRE"
prec() {
  local label="$1" f="$2" want="$3" note="$4"
  local cd ed dms rc
  cd=$(probe_dur "$f"); ed=$(exact_dur "$f"); rc=$(decode_ok "$f")
  dms=$(awk -v a="$ed" -v b="$want" 'BEGIN{printf "%.1f", (a-b)*1000}')
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$cd" "$ed" "$dms" "$rc" "$note" >> "$PRE"
  printf '[prec] %-34s container=%-9s exact=%-9s delta=%s ms decode=%s\n' "$label" "$cd" "$ed" "$dms" "$rc"
}
pcm() { "$FFMPEG" -hide_banner -nostdin -loglevel error "$@" -ac 1 -ar 44100 -f s16le 2>/dev/null; }

SRC="$SAMPLES/music_180s.mp3"

# ---- A. 裁剪 + 淡入 2s / 淡出 3s ----
A="$O/fade_trim_60s.mp3"
bench_run "fade_trim_60s" "$A" "60" "裁剪[30,90]+afade in 2s/out 3s，st=0/57" -- \
  ffb -i "$SRC" -af "atrim=start=30:end=90,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=2,afade=t=out:st=57:d=3" \
     -c:a libmp3lame -b:a 192k "$A"
prec "fade_trim_60s" "$A" 60 "裁剪+淡入淡出"
pcm -i "$A" -t 4 "$ANALYSIS/fade_in_head.s16le"
pcm -ss 56 -i "$A" -t 4 "$ANALYSIS/fade_out_tail.s16le"

# ---- B. 删除中间区间 + 淡入淡出（拼接后 st 以总时长 120 计算） ----
B="$O/fade_remove_120s.mp3"
bench_run "fade_remove_120s" "$B" "120" "拼接(保留[0,60)+[120,180))+淡入3s/淡出3s st=0/117" -- \
  ffb -i "$SRC" -filter_complex \
    "[0:a]atrim=start=0:end=60,asetpts=PTS-STARTPTS[a];[0:a]atrim=start=120:end=180,asetpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=0:a=1,afade=t=in:st=0:d=3,afade=t=out:st=117:d=3[out]" \
    -map "[out]" -c:a libmp3lame -b:a 192k "$B"
prec "fade_remove_120s" "$B" 120 "拼接+淡入淡出"

# ---- C. *错误示范*：先 afade 再 atempo（st 按变速前时间，输出中淡出位置偏移） ----
C="$O/fade_wrong_order.mp3"
bench_run "fade_wrong_order_before_tempo" "$C" "80" "反例：afade out st=57 放在 atempo=1.5 之前" -- \
  ffb -i "$SRC" -af "atrim=start=0:end=120,asetpts=PTS-STARTPTS,afade=t=out:st=57:d=3,atempo=1.5" \
     -c:a libmp3lame -b:a 192k "$C"
prec "fade_wrong_order_before_tempo" "$C" 80 "输出 80s，淡出实际在 38s（57/1.5）"

D="$O/fade_right_order.mp3"
bench_run "fade_right_order_after_tempo" "$D" "80" "正确：atempo=1.5 后 afade out st=77（输出时长 80）" -- \
  ffb -i "$SRC" -af "atrim=start=0:end=120,asetpts=PTS-STARTPTS,atempo=1.5,afade=t=out:st=77:d=3" \
     -c:a libmp3lame -b:a 192k "$D"
prec "fade_right_order_after_tempo" "$D" 80 "淡出在输出 77s"

# ---- D. 淡入淡出时长上限/下限检查（0s、5s>时长一半的校验） ----
bench_run "fade_invalid_12s_on_10s" "$O/fade_invalid.mp3" "10" "淡入 12s > 片段 10s（行为验证）" -- \
  ffb -i "$SRC" -af "atrim=start=0:end=10,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=12" \
     -c:a libmp3lame -b:a 192k "$O/fade_invalid.mp3"

echo "[exp04] done"
