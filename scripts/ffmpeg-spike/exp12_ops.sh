#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 实验 12：工程化补充
#   1) 流拷贝裁剪的绝对起点误差（用每秒 1kHz/200ms 标记音精确测量）
#   2) -threads / -filter_complex_threads 在 1 核容器内的实际影响（耗时/内存）
#   3) AAC 编码器默认 vs -aac_coder fast（复核 DEV_LOG §3.1 的 20.2s 数字）
#   4) 关键命令稳定性复测（各 2 次）
#   5) 容器资源/磁盘检查
# ---------------------------------------------------------------------------
set -u
source /spike/lib.sh
init_exp "12_ops"

O="$OUT/12"; mkdir -p "$O"
PRE="$RESULTS/12_precision.tsv"
printf 'label\tcontainer_dur\texact_dur\tdelta_ms\tdecode_rc\tnote\n' > "$PRE"
prec() {
  local label="$1" f="$2" want="$3" note="$4"
  local cd ed dms rc
  cd=$(probe_dur "$f"); ed=$(exact_dur "$f"); rc=$(decode_ok "$f")
  dms=$(awk -v a="$ed" -v b="$want" 'BEGIN{printf "%.1f", (a-b)*1000}')
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$cd" "$ed" "$dms" "$rc" "$note" >> "$PRE"
  printf '[prec] %-34s container=%-9s exact=%-9s delta=%s ms decode=%s\n' "$label" "$cd" "$ed" "$dms" "$rc"
}

# ============ 0) 纯重编码吞吐（lead 关注：10min mp3→mp3 192k 是否可行） ============
for d in 60 180 300 600; do
  bench_run "pure_reenc_mp3_${d}s" "$O/pure_reenc_mp3_${d}s.mp3" "$d" "纯重编码 mp3→mp3 192k ${d}s" -- \
    ffb -i "$SAMPLES/music_${d}s.mp3" -c:a libmp3lame -b:a 192k "$O/pure_reenc_mp3_${d}s.mp3"
done
# 10min 再补 1 次（稳定性）
bench_run "pure_reenc_mp3_600s_r2" "$O/pure_reenc_mp3_600s_r2.mp3" "600" "纯重编码 mp3→mp3 192k 600s 复测" -- \
  ffb -i "$SAMPLES/music_600s.mp3" -c:a libmp3lame -b:a 192k "$O/pure_reenc_mp3_600s_r2.mp3"
# mp3→m4a(aac fast) 5min/10min（lead 关注 m4a 上限）
for d in 300 600; do
  bench_run "pure_reenc_m4a_${d}s" "$O/pure_reenc_m4a_${d}s.m4a" "$d" "mp3→m4a aac fast 192k ${d}s" -- \
    ffb -i "$SAMPLES/music_${d}s.mp3" -c:a aac -aac_coder fast -b:a 192k -movflags +faststart "$O/pure_reenc_m4a_${d}s.m4a"
done

# ============ 1) 标记音样本：每秒 [0,200ms) 1kHz 标记 ============
MARK_WAV="$SAMPLES/beeps_180s.wav"
if [ ! -s "$MARK_WAV" ]; then
  bench_run "gen_beeps_180s" "$MARK_WAV" "180" "每秒前 200ms 1kHz 标记音" -- \
    ff -f lavfi -i "sine=frequency=1000:duration=180:sample_rate=44100" \
       -af "volume='if(lt(mod(t,1),0.2),1,0)':eval=frame" -c:a pcm_s16le "$MARK_WAV"
fi
for fmt in mp3 m4a flac; do
  out="$O/beeps_180s.$fmt"
  [ -s "$out" ] || bench_run "gen_beeps_mp3_m4a_flac_$fmt" "$out" "180" "标记音 $fmt 样本" -- \
    ffb -i "$MARK_WAV" $( [ "$fmt" = mp3 ] && echo "-c:a libmp3lame -b:a 192k" ) $( [ "$fmt" = m4a ] && echo "-c:a aac -aac_coder fast -b:a 192k -movflags +faststart" ) $( [ "$fmt" = flac ] && echo "-c:a flac" ) "$out"
done

# 用 copy 与 atrim 从 30s 处裁 20s；解码开头 5s 为 raw，用 analyze_pcm beeps 检测标记起点
extract_head() { "$FFMPEG" -hide_banner -nostdin -loglevel error -i "$1" -t 5 -ac 1 -ar 44100 -f s16le "$ANALYSIS/$2.s16le" 2>/dev/null || true; }
for fmt in mp3 m4a flac; do
  copy="$O/copy_${fmt}_30_50.$fmt"
  bench_run "mark_copy_${fmt}_30_50" "$copy" "20" "标记音 copy 裁剪 [30,50]" -- \
    ffb -ss 30 -t 20 -i "$O/beeps_180s.$fmt" -c copy "$copy"
  prec "mark_copy_${fmt}" "$copy" 20 "copy 裁剪绝对起点/时长"
  extract_head "$copy" "mark_copy_${fmt}"

  enc="$O/atrim_${fmt}_30_50.$fmt"
  bench_run "mark_atrim_${fmt}_30_50" "$enc" "20" "标记音 atrim 裁剪 [30,50] 重编码" -- \
    ffb -i "$O/beeps_180s.$fmt" -af "atrim=start=30:end=50,asetpts=PTS-STARTPTS" \
       $( [ "$fmt" = mp3 ] && echo "-c:a libmp3lame -b:a 192k" ) $( [ "$fmt" = m4a ] && echo "-c:a aac -aac_coder fast -b:a 192k" ) $( [ "$fmt" = flac ] && echo "-c:a flac" ) "$enc"
  prec "mark_atrim_${fmt}" "$enc" 20 "atrim 重编码"
  extract_head "$enc" "mark_atrim_${fmt}"
done

# ============ 2) 线程参数影响（3min → mp3 192k 纯重编码 + filter_complex） ============
SRC="$SAMPLES/music_180s.mp3"
for i in 1 2; do
  bench_run "thr_default_r$i" "$O/thr_default_r$i.mp3" "180" "默认线程（容器 1CPU 但 ffmpeg 看到 12 核）" -- \
    ffb -i "$SRC" -c:a libmp3lame -b:a 192k "$O/thr_default_r$i.mp3"
  bench_run "thr_1_r$i" "$O/thr_1_r$i.mp3" "180" "-threads 1" -- \
    ffb -threads 1 -i "$SRC" -threads 1 -c:a libmp3lame -b:a 192k "$O/thr_1_r$i.mp3"
  bench_run "thr_fct1_r$i" "$O/thr_fct1_r$i.mp3" "180" "-filter_complex_threads 1（带 filter_complex）" -- \
    ffb -filter_complex_threads 1 -i "$SRC" -filter_complex "[0:a]volume=1.0[out]" -map "[out]" -c:a libmp3lame -b:a 192k "$O/thr_fct1_r$i.mp3"
  bench_run "thr_all1_r$i" "$O/thr_all1_r$i.mp3" "180" "-threads 1 + -filter_complex_threads 1" -- \
    ffb -filter_complex_threads 1 -i "$SRC" -filter_complex "[0:a]volume=1.0[out]" -map "[out]" -threads 1 -c:a libmp3lame -b:a 192k "$O/thr_all1_r$i.mp3"
done

# ============ 3) AAC coder 对比（1min / 5min，fast vs 默认） ============
for i in 1 2; do
  bench_run "aac_default_1m_r$i" "$O/aac_default_1m_r$i.m4a" "60" "aac 默认 coder 1min" -- \
    ffb -i "$SAMPLES/music_60s.mp3" -c:a aac -b:a 192k -movflags +faststart "$O/aac_default_1m_r$i.m4a"
  bench_run "aac_fast_1m_r$i" "$O/aac_fast_1m_r$i.m4a" "60" "aac -aac_coder fast 1min" -- \
    ffb -i "$SAMPLES/music_60s.mp3" -c:a aac -aac_coder fast -b:a 192k -movflags +faststart "$O/aac_fast_1m_r$i.m4a"
done
# 默认 coder 极慢（DEV_LOG 报 80.4s/5min），只测 1 次避免整体过久
bench_run "aac_default_5m" "$O/aac_default_5m.m4a" "300" "aac 默认 coder 5min（DEV_LOG 报 80.4s）" -- \
  ffb -i "$SAMPLES/music_300s.mp3" -c:a aac -b:a 192k -movflags +faststart "$O/aac_default_5m.m4a"
for i in 1 2; do
  bench_run "aac_fast_5m_r$i" "$O/aac_fast_5m_r$i.m4a" "300" "aac -aac_coder fast 5min（DEV_LOG 报 20.2s）" -- \
    ffb -i "$SAMPLES/music_300s.mp3" -c:a aac -aac_coder fast -b:a 192k -movflags +faststart "$O/aac_fast_5m_r$i.m4a"
done

# 10min m4a 再测 2 次（lead 关注）
for i in 1 2; do
  bench_run "aac_fast_10m_r$i" "$O/aac_fast_10m_r$i.m4a" "600" "aac -aac_coder fast 10min" -- \
    ffb -i "$SAMPLES/music_600s.mp3" -c:a aac -aac_coder fast -b:a 192k -movflags +faststart "$O/aac_fast_10m_r$i.m4a"
done

# ============ 4) 稳定性复测：3×2min 拼接（exp03 曾出现 16.7s 异常值） ============
for i in 1 2; do
  bench_run "concat3x2m_rerun_r$i" "$O/concat3x2m_rerun_r$i.mp3" "360" "3×2min filter concat 复测" -- \
    ffb -i "$OUT/03/part2m_0.mp3" -i "$OUT/03/part2m_1.mp3" -i "$OUT/03/part2m_2.mp3" -filter_complex \
      "[0:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a0];[1:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a1];[2:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a2];[a0][a1][a2]concat=n=3:v=0:a=1[out]" \
      -map "[out]" -c:a libmp3lame -b:a 192k "$O/concat3x2m_rerun_r$i.mp3"
done

# ============ 5) 容器/磁盘/资源检查 ============
echo "=== cgroup 限制 ==="
cat /sys/fs/cgroup/cpu.max 2>/dev/null || cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null || echo "no cgroup v2 cpu.max"
cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || true
echo "=== /tmp 与 /work 空间 ==="
df -h /tmp /work | sed 's/^/    /'
echo "=== ffmpeg 线程默认值（av_cpu_count 依据） ==="
nproc; grep -c ^processor /proc/cpuinfo
echo "=== 静态二进制大小 ==="
ls -l /tmp/bin/ffmpeg
echo "[exp12] done"
