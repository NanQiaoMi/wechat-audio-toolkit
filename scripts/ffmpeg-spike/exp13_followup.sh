#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 实验 13：Lead 追加问题专项
#   A) concat filter 为何 3×2min 比 2×3min 慢一倍：根因与替代方案
#   B) copy 快剪白名单：mp3/m4a/flac/wav 多位置精度、容器时长、可播性
#   C) 推荐 filter 顺序 + 变速后淡入淡出 st 公式验证（含 per-segment 淡化）
#   D) loudnorm 3min 单遍/双遍（定 3min 门槛数据）
# ---------------------------------------------------------------------------
set -u
source /spike/lib.sh
init_exp "13_followup"

O="$OUT/13"; mkdir -p "$O"
PRE="$RESULTS/13_precision.tsv"
printf 'label\tcontainer_dur\texact_dur\tdelta_ms\tdecode_rc\tnote\n' > "$PRE"
prec() {
  local label="$1" f="$2" want="$3" note="$4"
  local cd ed dms rc
  cd=$(probe_dur "$f"); ed=$(exact_dur "$f"); rc=$(decode_ok "$f")
  dms=$(awk -v a="$ed" -v b="$want" 'BEGIN{printf "%.1f", (a-b)*1000}')
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$cd" "$ed" "$dms" "$rc" "$note" >> "$PRE"
  printf '[prec] %-38s container=%-9s exact=%-9s delta=%s ms decode=%s\n' "$label" "$cd" "$ed" "$dms" "$rc"
}
pcm() { "$FFMPEG" -hide_banner -nostdin -loglevel error "$@" -ac 1 -ar 44100 -f s16le 2>/dev/null; }

# ================= A) concat filter 慢的根因 =================
P0="$OUT/03/part2m_0.mp3"; P1="$OUT/03/part2m_1.mp3"; P2="$OUT/03/part2m_2.mp3"
M3A="$SAMPLES/music_180s.mp3"; M3B="$SAMPLES/music_180s_128.mp3"

# A1: 3 段同参数，带 aresample/aformat（exp03 原写法）
bench_run "A1_3x2m_with_resample" "$O/A1_3x2m_resample.mp3" "360" "3×2min（同参数）+aresample+aformat" -- \
  ffb -i "$P0" -i "$P1" -i "$P2" -filter_complex \
    "[0:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a0];[1:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a1];[2:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a2];[a0][a1][a2]concat=n=3:v=0:a=1[out]" \
    -map "[out]" -c:a libmp3lame -b:a 192k "$O/A1_3x2m_resample.mp3"
prec "A1_3x2m_with_resample" "$O/A1_3x2m_resample.mp3" 360 "3输入+归一"

# A2: 3 段同参数，不带 aresample/aformat（7.0 自动转换）
bench_run "A2_3x2m_no_filter_norm" "$O/A2_3x2m_plain.mp3" "360" "3×2min 直接 concat（无 aresample/aformat）" -- \
  ffb -i "$P0" -i "$P1" -i "$P2" -filter_complex \
    "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]" -map "[out]" -c:a libmp3lame -b:a 192k "$O/A2_3x2m_plain.mp3"
prec "A2_3x2m_no_filter_norm" "$O/A2_3x2m_plain.mp3" 360 "自动转换"

# A3: A1 + filter_complex_threads 1
bench_run "A3_3x2m_fct1" "$O/A3_3x2m_fct1.mp3" "360" "A1 + -filter_complex_threads 1" -- \
  ffb -filter_complex_threads 1 -i "$P0" -i "$P1" -i "$P2" -filter_complex \
    "[0:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a0];[1:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a1];[2:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a2];[a0][a1][a2]concat=n=3:v=0:a=1[out]" \
    -map "[out]" -c:a libmp3lame -b:a 192k "$O/A3_3x2m_fct1.mp3"

# A4: A1 + -threads 1
bench_run "A4_3x2m_threads1" "$O/A4_3x2m_threads1.mp3" "360" "A1 + -threads 1" -- \
  ffb -threads 1 -i "$P0" -i "$P1" -i "$P2" -filter_complex \
    "[0:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a0];[1:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a1];[2:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a2];[a0][a1][a2]concat=n=3:v=0:a=1[out]" \
    -map "[out]" -threads 1 -c:a libmp3lame -b:a 192k "$O/A4_3x2m_threads1.mp3"

# A5: 2 输入 3min+3min 带归一（与 A1 同为 6min 输出，对比输入个数/解码量）
bench_run "A5_2x3m_with_resample" "$O/A5_2x3m_resample.mp3" "360" "2×3min（同参数同文件）+aresample+aformat" -- \
  ffb -i "$M3A" -i "$M3A" -filter_complex \
    "[0:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a0];[1:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a1];[a0][a1]concat=n=2:v=0:a=1[out]" \
    -map "[out]" -c:a libmp3lame -b:a 192k "$O/A5_2x3m_resample.mp3"

# A6: 替代方案：各段先按输出参数重编码（1.7s/段），再 concat demuxer + copy
ALT="$O/A6_segments_then_copy.mp3"
t_a=$(date +%s%N)
for i in 0 1 2; do
  bench_run "A6_seg${i}_reencode" "$O/A6_seg${i}.mp3" "120" "替代方案：段 $i 重编码为统一参数" -- \
    ffb -i "$OUT/03/part2m_$i.mp3" -c:a libmp3lame -b:a 192k -ar 44100 -ac 2 "$O/A6_seg${i}.mp3"
done
printf "file '%s'\nfile '%s'\nfile '%s'\n" "$O/A6_seg0.mp3" "$O/A6_seg1.mp3" "$O/A6_seg2.mp3" > "$O/A6_list.txt"
bench_run "A6_segments_then_copy" "$ALT" "360" "替代方案：concat demuxer + -c copy 拼 3 段" -- \
  ffb -f concat -safe 0 -i "$O/A6_list.txt" -c copy "$ALT"
t_b=$(date +%s%N)
echo "[A6] 替换方案三段总耗时（含 3 次重编码+copy）≈ $(( (t_b - t_a) / 1000000 ))ms"
prec "A6_segments_then_copy" "$ALT" 360 "分段重编码后 copy 拼接"
pcm -ss 118.5 -t 3 -i "$ALT" "$ANALYSIS/A6_copy_join.s16le"
pcm -ss 118.5 -t 3 -i "$O/A1_3x2m_resample.mp3" "$ANALYSIS/A1_filter_join.s16le"

# ================= B) copy 快剪白名单：多位置 =================
# 对每种格式在 3 个非帧对齐位置裁剪 60s，看时长偏差分布
for pair in "mp3:$SAMPLES/music_180s.mp3" "m4a:$SAMPLES/music_180s.m4a" "flac:$SAMPLES/music_180s.flac" "wav:$SAMPLES/music_180s.wav"; do
  fmt=${pair%%:*}; src=${pair#*:}
  for ss in 30.00 30.37 30.90; do
    tag="copy_${fmt}_$(echo "$ss" | tr '.' 'p')"
    out="$O/${tag}.${fmt}"
    bench_run "$tag" "$out" "60" "copy -ss $ss -t 60" -- \
      ffb -ss "$ss" -t 60 -i "$src" -c copy "$out"
    prec "$tag" "$out" 60 "copy 位置 $ss"
  done
done

# flac copy 输出的容器/流时长/seek 行为
FLAC_OUT="$O/copy_flac_30p00.flac"
echo "[flac-copy] format.duration=$(probe_dur "$FLAC_OUT") stream.duration=$("$FFPROBE" -v error -select_streams a:0 -show_entries stream=duration -of default=nw=1:nk=1 "$FLAC_OUT" 2>/dev/null) bytes=$(stat -c %s "$FLAC_OUT")"
"$FFMPEG" -hide_banner -nostdin -loglevel error -ss 30 -t 5 -i "$FLAC_OUT" -ac 1 -ar 44100 -f s16le "$ANALYSIS/flac_copy_seek.s16le" 2>/dev/null || true
echo "[flac-copy] seek 后 raw 样本数=$(( $(stat -c %s "$ANALYSIS/flac_copy_seek.s16le" 2>/dev/null || echo 0) / 2 ))（期望 ~220500）"

# mp3/m4a copy 输出元信息（负时间戳/起始时间）
for pair in "mp3:$O/copy_mp3_30p37.mp3" "m4a:$O/copy_m4a_30p37.m4a" "flac:$O/copy_flac_30p37.flac"; do
  tag=${pair%%:*}; f=${pair#*:}
  echo "[meta] $tag start_time=$("$FFPROBE" -v error -show_entries format=start_time -of default=nw=1:nk=1 "$f" 2>/dev/null) codec=$("$FFPROBE" -v error -select_streams a:0 -show_entries stream=codec_name -of default=nw=1:nk=1 "$f" 2>/dev/null)"
done

# ================= C) 推荐 filter 顺序 + st 公式 =================
# 场景：保留 [0,60)+[120,180) = 120s → atempo=1.5 → 输出 80s；
# 全局淡入 2s / 淡出 3s 在 atempo 之后：fade out st = 80-3 = 77
C1="$O/C1_order_recommended.mp3"
bench_run "C1_order_recommended" "$C1" "80" "推荐顺序: atrim/asetpts→concat→volume→atempo→afade(st=77/2)→alimiter" -- \
  ffb -i "$SAMPLES/music_180s.mp3" -filter_complex \
    "[0:a]atrim=0:60,asetpts=PTS-STARTPTS[s1];[0:a]atrim=120:180,asetpts=PTS-STARTPTS[s2];[s1][s2]concat=n=2:v=0:a=1,volume=-3dB,atempo=1.5,afade=t=in:st=0:d=2,afade=t=out:st=77:d=3,alimiter=limit=0.95:level=false[out]" \
    -map "[out]" -t 80 -c:a libmp3lame -b:a 192k "$C1"
prec "C1_order_recommended" "$C1" 80 "调速后全局淡化"
pcm -i "$C1" -t 3 "$ANALYSIS/C1_fade_in.s16le"
pcm -ss 76 -t 4 -i "$C1" "$ANALYSIS/C1_fade_out.s16le"

# C2: per-segment 淡化（每段独立淡入/淡出，在分段本地时间，再 concat 后 atempo）
# seg1 60s 淡入 2s；seg2 60s 淡出 2s；concat 120s → atempo 1.5 → 80s（淡化时长被压成 1.33s）
C2="$O/C2_persegment_fade.mp3"
bench_run "C2_persegment_fade" "$C2" "80" "分段淡化: s1 afade in 2s / s2 afade out st=58，再 concat+atempo" -- \
  ffb -i "$SAMPLES/music_180s.mp3" -filter_complex \
    "[0:a]atrim=0:60,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=2[v1];[0:a]atrim=120:180,asetpts=PTS-STARTPTS,afade=t=out:st=58:d=2[v2];[v1][v2]concat=n=2:v=0:a=1,atempo=1.5[out]" \
    -map "[out]" -t 80 -c:a libmp3lame -b:a 192k "$C2"
prec "C2_persegment_fade" "$C2" 80 "分段淡化（淡化时长随变速缩短）"
pcm -ss 35 -t 6 -i "$C2" "$ANALYSIS/C2_join_region.s16le"

# C3: 在 atempo 之后再对拼接点做 0.2s 交叉淡化（acrossfade）无法用于单输入；
#     改用 concat 前按输出时间换算 st 的 per-segment 淡化（等价于 C1，但分段计算）
C3="$O/C3_persegment_outputtime.mp3"
bench_run "C3_persegment_outputtime" "$C3" "80" "分段淡化按输出时间轴: s1 in 2s@0 / s2 out st=(40-2)=38? s2本地58→39" -- \
  ffb -i "$SAMPLES/music_180s.mp3" -filter_complex \
    "[0:a]atrim=0:60,asetpts=PTS-STARTPTS,atempo=1.5,afade=t=in:st=0:d=2[v1];[0:a]atrim=120:180,asetpts=PTS-STARTPTS,atempo=1.5,afade=t=out:st=38:d=2[v2];[v1][v2]concat=n=2:v=0:a=1[out]" \
    -map "[out]" -t 80 -c:a libmp3lame -b:a 192k "$C3"
prec "C3_persegment_outputtime" "$C3" 80 "分段各自变速后淡化(输出时间轴)"

# ================= D) loudnorm 3min 门槛数据 =================
bench_run "D_loudnorm_single_3m" "$O/D_loudnorm_single_3m.mp3" "180" "loudnorm 单遍 3min" -- \
  ffb -i "$SAMPLES/music_180s.mp3" -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 44100 -c:a libmp3lame -b:a 192k "$O/D_loudnorm_single_3m.mp3"
P3="$O/loudnorm_pass1_3m.json"
"$FFMPEG" -hide_banner -nostdin -i "$SAMPLES/music_180s.mp3" -af "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json" -f null - 2> "$P3" || true
MI=$(sed -n 's/.*"input_i" : "\([-0-9.]*\)".*/\1/p' "$P3")
MTP=$(sed -n 's/.*"input_tp" : "\([-0-9.]*\)".*/\1/p' "$P3")
MLRA=$(sed -n 's/.*"input_lra" : "\([-0-9.]*\)".*/\1/p' "$P3")
MTH=$(sed -n 's/.*"input_thresh" : "\([-0-9.]*\)".*/\1/p' "$P3")
MOFF=$(sed -n 's/.*"target_offset" : "\([-0-9.]*\)".*/\1/p' "$P3")
echo "[D] pass1 input_i=$MI tp=$MTP lra=$MLRA thresh=$MTH offset=$MOFF"
bench_run "D_loudnorm_pass2_3m" "$O/D_loudnorm_2pass_3m.mp3" "180" "loudnorm 双遍 pass2 3min" -- \
  ffb -i "$SAMPLES/music_180s.mp3" -af "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=$MI:measured_TP=$MTP:measured_LRA=$MLRA:measured_thresh=$MTH:offset=$MOFF" \
     -ar 44100 -c:a libmp3lame -b:a 192k "$O/D_loudnorm_2pass_3m.mp3"

echo "[exp13] done"
