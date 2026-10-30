#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 实验 1：流拷贝裁剪(-c copy) vs atrim 重编码 —— 精度/耗时/可播放/元数据
#   输入：3min 样本（mp3 192/128、m4a、flac、wav）+ 10min mp3 长文件
#   请求：[30.0s, 90.0s]（时长 60s）；另测从 0 开始 [0,60s]
#   产出：$RESULTS/01_trim.tsv + 01_trim_precision.tsv（精确解码时长与偏差）
#   另存开头 1s 原始 PCM 到 $ANALYSIS/，供爆音扫描
# ---------------------------------------------------------------------------
set -u
source /spike/lib.sh
init_exp "01_trim"

O="$OUT/01"; mkdir -p "$O"
PRE="$RESULTS/01_trim_precision.tsv"
printf 'label\tcontainer_dur\texact_dur\tdelta_ms\tdecode_rc\tnote\n' > "$PRE"

# 精确时长 + 偏差记录
prec() {
  local label="$1" f="$2" want="$3" note="$4"
  local cd ed dms rc
  cd=$(probe_dur "$f"); ed=$(exact_dur "$f"); rc=$(decode_ok "$f")
  dms=$(awk -v a="$ed" -v b="$want" 'BEGIN{printf "%.1f", (a-b)*1000}')
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$cd" "$ed" "$dms" "$rc" "$note" >> "$PRE"
  printf '[prec] %-40s container=%-9s exact=%-9s delta=%s ms decode_rc=%s\n' "$label" "$cd" "$ed" "$dms" "$rc"
}

# 取开头 1s 原始 PCM（44.1k 单声道），供爆音/起始电平扫描
pcm_head() {
  local f="$1" tag="$2"
  "$FFMPEG" -hide_banner -nostdin -loglevel error -i "$f" -t 1 -ac 1 -ar 44100 -f s16le "$ANALYSIS/$tag.head.s16le" 2>/dev/null || true
}

# 给 mp3 打标签，验证 copy 是否保留元数据
TAGGED="$SAMPLES/tagged_180s.mp3"
if [ ! -s "$TAGGED" ]; then
  bench_run "gen_tagged_mp3" "$TAGGED" "180" "元数据样本 title/artist/album" -- \
    ff -i "$SAMPLES/music_180s.mp3" -c copy -metadata title="测试标题Spike" -metadata artist="测试歌手" -metadata album="测试专辑" -metadata comment="ffmpeg-spike" "$TAGGED"
fi

# ---- A. copy 裁剪：输入 seek（推荐写法） ----
# mp3 / mp3-128 / m4a / flac / wav，请求 [30,90] = 60s
for pair in "mp3:$SAMPLES/music_180s.mp3" "mp3_128:$SAMPLES/music_180s_128.mp3" "m4a:$SAMPLES/music_180s.m4a" "flac:$SAMPLES/music_180s.flac" "wav:$SAMPLES/music_180s.wav"; do
  name=${pair%%:*}; src=${pair#*:}
  out="$O/copy_${name}_30_90.${name%%_*}"
  [ "$name" = "m4a" ] && out="$O/copy_m4a_30_90.m4a"
  [ "$name" = "flac" ] && out="$O/copy_flac_30_90.flac"
  [ "$name" = "wav" ] && out="$O/copy_wav_30_90.wav"
  [ "$name" = "mp3_128" ] && out="$O/copy_mp3_128_30_90.mp3"
  bench_run "copy_${name}_30_90" "$out" "60" "输入seek -ss 30 -t 60 -c copy" -- \
    ffb -ss 30 -t 60 -i "$src" -c copy "$out"
  prec "copy_${name}_30_90" "$out" 60 "-ss 30 -t 60 -c copy"
  pcm_head "$out" "copy_${name}_30_90"
done

# ---- B. copy 裁剪：从 0 开始 [0,60] ----
for pair in "mp3:$SAMPLES/music_180s.mp3" "m4a:$SAMPLES/music_180s.m4a"; do
  name=${pair%%:*}; src=${pair#*:}
  out="$O/copy_${name}_0_60.${name}"
  bench_run "copy_${name}_0_60" "$out" "60" "输入seek -ss 0 -t 60 -c copy" -- \
    ffb -ss 0 -t 60 -i "$src" -c copy "$out"
  prec "copy_${name}_0_60" "$out" 60 "-ss 0 -t 60 -c copy"
  pcm_head "$out" "copy_${name}_0_60"
done

# ---- C. copy 裁剪：输出 seek（-i 之后 -ss），观察与输入 seek 的差异 ----
for pair in "mp3:$SAMPLES/music_180s.mp3" "m4a:$SAMPLES/music_180s.m4a"; do
  name=${pair%%:*}; src=${pair#*:}
  out="$O/copy_outseek_${name}_30_90.${name}"
  bench_run "copy_outseek_${name}_30_90" "$out" "60" "输出seek -i X -ss 30 -t 60 -c copy" -- \
    ffb -i "$src" -ss 30 -t 60 -c copy "$out"
  prec "copy_outseek_${name}_30_90" "$out" 60 "-i X -ss 30 -t 60 -c copy"
done

# ---- D. m4a copy 负时间戳/可播放性变体 ----
out="$O/copy_m4a_avoidneg_30_90.m4a"
bench_run "copy_m4a_avoidneg_30_90" "$out" "60" "m4a copy + -avoid_negative_ts make_zero" -- \
  ffb -ss 30 -t 60 -i "$SAMPLES/music_180s.m4a" -c copy -avoid_negative_ts make_zero "$out"
prec "copy_m4a_avoidneg_30_90" "$out" 60 "-avoid_negative_ts make_zero"

# ---- E. 元数据：copy vs 重编码 ----
out="$O/copy_tagged_30_90.mp3"
bench_run "copy_tagged_30_90" "$out" "60" "带标签 mp3 copy 裁剪" -- \
  ffb -ss 30 -t 60 -i "$TAGGED" -c copy "$out"
echo "[tags] copy 输出: $("$FFPROBE" -v error -show_entries format_tags -of default=nw=1 "$out" 2>/dev/null | tr '\n' ' ')"
out="$O/reenc_tagged_30_90.mp3"
bench_run "reenc_tagged_30_90" "$out" "60" "带标签 mp3 atrim 重编码" -- \
  ffb -i "$TAGGED" -af "atrim=start=30:end=90,asetpts=PTS-STARTPTS" -c:a libmp3lame -b:a 192k "$out"
echo "[tags] reencode 输出: $("$FFPROBE" -v error -show_entries format_tags -of default=nw=1 "$out" 2>/dev/null | tr '\n' ' ')"

# ---- F. atrim 重编码（各格式） ----
bench_run "atrim_mp3_30_90" "$O/atrim_mp3_30_90.mp3" "60" "atrim+asetpts mp3 192k 重编码" -- \
  ffb -i "$SAMPLES/music_180s.mp3" -af "atrim=start=30:end=90,asetpts=PTS-STARTPTS" -c:a libmp3lame -b:a 192k "$O/atrim_mp3_30_90.mp3"
prec "atrim_mp3_30_90" "$O/atrim_mp3_30_90.mp3" 60 "atrim 重编码"
pcm_head "$O/atrim_mp3_30_90.mp3" "atrim_mp3_30_90"

bench_run "atrim_m4a_30_90" "$O/atrim_m4a_30_90.m4a" "60" "atrim+asetpts aac fast 重编码" -- \
  ffb -i "$SAMPLES/music_180s.m4a" -af "atrim=start=30:end=90,asetpts=PTS-STARTPTS" -c:a aac -aac_coder fast -b:a 192k -movflags +faststart "$O/atrim_m4a_30_90.m4a"
prec "atrim_m4a_30_90" "$O/atrim_m4a_30_90.m4a" 60 "atrim 重编码 aac fast"

bench_run "atrim_flac_30_90" "$O/atrim_flac_30_90.flac" "60" "atrim+asetpts flac 重编码" -- \
  ffb -i "$SAMPLES/music_180s.flac" -af "atrim=start=30:end=90,asetpts=PTS-STARTPTS" -c:a flac -compression_level 5 "$O/atrim_flac_30_90.flac"
prec "atrim_flac_30_90" "$O/atrim_flac_30_90.flac" 60 "atrim 重编码 flac"

bench_run "atrim_wav_30_90" "$O/atrim_wav_30_90.wav" "60" "atrim+asetpts pcm_s16le 重编码" -- \
  ffb -i "$SAMPLES/music_180s.wav" -af "atrim=start=30:end=90,asetpts=PTS-STARTPTS" -c:a pcm_s16le "$O/atrim_wav_30_90.wav"
prec "atrim_wav_30_90" "$O/atrim_wav_30_90.wav" 60 "atrim 重编码 wav"

# ---- G. 10min 长文件 copy 裁剪 vs atrim 重编码 ----
bench_run "copy_mp3_600_30_90" "$O/copy_mp3_600_30_90.mp3" "60" "10min mp3 copy -ss 30 -t 60" -- \
  ffb -ss 30 -t 60 -i "$SAMPLES/music_600s.mp3" -c copy "$O/copy_mp3_600_30_90.mp3"
prec "copy_mp3_600_30_90" "$O/copy_mp3_600_30_90.mp3" 60 "10min copy"
bench_run "atrim_mp3_600_30_90" "$O/atrim_mp3_600_30_90.mp3" "60" "10min mp3 atrim 重编码" -- \
  ffb -i "$SAMPLES/music_600s.mp3" -af "atrim=start=30:end=90,asetpts=PTS-STARTPTS" -c:a libmp3lame -b:a 192k "$O/atrim_mp3_600_30_90.mp3"
prec "atrim_mp3_600_30_90" "$O/atrim_mp3_600_30_90.mp3" 60 "10min atrim 重编码"

# ---- H. 超出边界裁剪（请求 170~200s，输入仅 180s） ----
bench_run "copy_mp3_overshoot" "$O/copy_mp3_170_200.mp3" "10" "请求超出输入末尾(170-200)" -- \
  ffb -ss 170 -t 30 -i "$SAMPLES/music_180s.mp3" -c copy "$O/copy_mp3_170_200.mp3"
prec "copy_mp3_overshoot" "$O/copy_mp3_170_200.mp3" 10 "越界应截断为 ~10s"
bench_run "atrim_mp3_overshoot" "$O/atrim_mp3_170_200.mp3" "10" "atrim 请求超出输入末尾" -- \
  ffb -i "$SAMPLES/music_180s.mp3" -af "atrim=start=170:end=200,asetpts=PTS-STARTPTS" -c:a libmp3lame -b:a 192k "$O/atrim_mp3_170_200.mp3"
prec "atrim_mp3_overshoot" "$O/atrim_mp3_170_200.mp3" 10 "越界应截断为 ~10s"

echo "[exp01] done"
