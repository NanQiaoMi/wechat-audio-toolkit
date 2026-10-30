#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 实验 11：ffprobe 元信息 + 异常输入用例（工程校验用）
#   - ffprobe JSON（镜像自带 9.0.2 仅作校验；生产建议自带 ffprobe 或用 ffmpeg -i 解析）
#   - 异常：0 字节 / 随机字节 / wav 改扩展名 / 无音轨 mp4 / 0.3s 超短 / 8k 单声道
# ---------------------------------------------------------------------------
set -u
source /spike/lib.sh
init_exp "11_probe_errors"

O="$OUT/11"; mkdir -p "$O"
REP="$RESULTS/11_errors_report.tsv"
printf 'file\tbytes\tffprobe_rc\tprobe_audio_stream\tprobe_duration\tffmpeg_decode_rc\tverdict\n' > "$REP"

probe_json() {
  "$FFPROBE" -v error -print_format json -show_format -show_streams "$1" 2>/dev/null
}

# ---- A. ffprobe JSON 输出与耗时（10min mp3 / m4a / flac / wav） ----
for pair in "mp3:$SAMPLES/music_600s.mp3" "m4a:$SAMPLES/music_600s.m4a" "flac:$SAMPLES/music_600s.flac" "wav:$SAMPLES/music_600s.wav"; do
  tag=${pair%%:*}; f=${pair#*:}
  bench_run "ffprobe_json_${tag}" "-" "0" "ffprobe -show_format -show_streams JSON" -- \
    "$FFPROBE" -v error -print_format json -show_format -show_streams "$f"
  # 现有云函数写法：ffmpeg -i 解析 Duration（无 ffprobe 时的退路）
  bench_run "ffmpeg_i_parse_${tag}" "-" "0" "ffmpeg -i 解析 Duration（index.js 现有做法）" -- \
    "$FFMPEG" -hide_banner -nostdin -i "$f"
done

# 打印一份 10min mp3 的 JSON 关键字段
echo "[json] 10min mp3 关键字段："
probe_json "$SAMPLES/music_600s.mp3" | jq -c '{format_name:.format.format_name,duration:.format.duration,size:.format.size,bit_rate:.format.bit_rate,codec:(.streams[]|select(.codec_type=="audio")|.codec_name),sample_rate:(.streams[]|select(.codec_type=="audio")|.sample_rate),channels:(.streams[]|select(.codec_type=="audio")|.channels),start_time:(.streams[]|select(.codec_type=="audio")|.start_time)}' 2>/dev/null || true

# ---- B. 异常用例 ----
check_case() {
  local name="$1" f="$2" note="$3"
  local bytes frc ast dur drc verdict
  bytes=$(stat -c %s "$f" 2>/dev/null || echo 0)
  probe_json "$f" > "$O/probe_$name.json" 2> "$O/probe_$name.err"
  frc=$?
  ast=$(jq '[.streams[]?|select(.codec_type=="audio")]|length' "$O/probe_$name.json" 2>/dev/null || echo "ERR")
  dur=$(jq -r '.format.duration // ""' "$O/probe_$name.json" 2>/dev/null || echo "")
  "$FFMPEG" -hide_banner -nostdin -loglevel error -i "$f" -map 0:a:0 -f null - >/dev/null 2>"$O/decode_$name.err"
  drc=$?
  verdict="OK"
  case "$name" in
    bad_empty) verdict="必须拒绝: 空文件" ;;
    bad_random) verdict="必须拒绝: 无法识别" ;;
    bad_renamed) verdict="内容嗅探成功: 扩展名不可信" ;;
    video_only) verdict="必须拒绝: 无音轨" ;;
    short_300ms) verdict="边界: 过短但可解码" ;;
    edge_8k_mono) verdict="可解码: 8k 单声道需归一化" ;;
  esac
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$bytes" "$frc" "$ast" "$dur" "$drc" "$note" "$verdict" >> "$REP"
  printf '[case] %-14s bytes=%-9s probe_rc=%s audio=%s dur=%-10s decode_rc=%s  %s\n' \
    "$name" "$bytes" "$frc" "$ast" "$dur" "$drc" "$verdict"
}

check_case bad_empty   "$SAMPLES/bad_empty.mp3"     "0 字节"
check_case bad_random  "$SAMPLES/bad_random.mp3"    "随机字节"
check_case bad_renamed "$SAMPLES/bad_renamed.mp3"   "wav 内容改 .mp3 扩展名"
check_case video_only  "$SAMPLES/video_only.mp4"    "无音轨 mp4"
check_case short_300ms "$SAMPLES/short_300ms.mp3"   "0.3s 超短"
check_case edge_8k_mono "$SAMPLES/edge_8k_mono.wav" "8kHz 单声道 30s"
check_case music_180s  "$SAMPLES/music_180s.mp3"    "正常样本"

echo "[err] 0字节/随机字节 stderr 片段:"
head -3 "$O/decode_bad_empty.err" | sed 's/^/    /'
head -3 "$O/decode_bad_random.err" | sed 's/^/    /'
head -3 "$O/decode_video_only.err" | sed 's/^/    /'
echo "[err] 改扩展名实际识别为: $(probe_json "$SAMPLES/bad_renamed.mp3" | jq -r '.format.format_name' 2>/dev/null)"

# ---- C. 拒绝类用例：ffmpeg 输出到 mp3 是否报错 ----
bench_run "decode_video_only_to_mp3_FAIL" "$O/from_video_only.mp3" "0" "无音轨文件尝试转 mp3（预期失败）" -- \
  ffb -i "$SAMPLES/video_only.mp4" -map 0:a:0 -c:a libmp3lame -b:a 192k "$O/from_video_only.mp3"
bench_run "decode_empty_to_mp3_FAIL" "$O/from_empty.mp3" "0" "空文件尝试转 mp3（预期失败）" -- \
  ffb -i "$SAMPLES/bad_empty.mp3" -c:a libmp3lame -b:a 192k "$O/from_empty.mp3"

# ---- D. 读 Duration：ffmpeg -i 的 stderr 正则（index.js 现有实现）在异常文件上的表现 ----
for f in "$SAMPLES/bad_random.mp3" "$SAMPLES/bad_renamed.mp3"; do
  echo "[dur] $(basename "$f"): $("$FFMPEG" -hide_banner -nostdin -i "$f" 2>&1 | sed -n 's/.*Duration: \([0-9:.]*\).*/\1/p' | head -1)"
done

echo "[exp11] done"
