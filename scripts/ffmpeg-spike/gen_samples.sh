#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 生成可复现测试样本（容器内执行，路径默认 /work/samples）
#
# 内容：A 大调和弦（110/220/277.18/329.63Hz）+ 粉噪，加慢速 tremolo；
#       避免纯静音/纯单音导致编码器与实际音乐差异过大。
# 时长：60/180/300/600s；格式：mp3 128k/192k、m4a(aac fast)、flac、wav 44.1k stereo
# 附加：40s 铃声场景（1.2s 响 / 0.8s 静音的门控信号）、8k 单声道、0.3s 超短、
#       异常样本（空文件/随机字节/wav 改扩展名/无音轨 mp4）
# ---------------------------------------------------------------------------
set -u
source /spike/lib.sh
init_exp "gen_samples"

MASTER="$SAMPLES/music_600s.wav"   # 10 min 母带，后续所有样本由它派生

gen_master() {
  [ -s "$MASTER" ] && { echo "[gen] master exists, skip"; return; }
  bench_run "gen_master_600s_wav" "$MASTER" "600" \
    "lavfi 5源合成: 和弦+粉噪 tremolo, 44.1k stereo pcm_s16le" -- \
    ffb -f lavfi -i "sine=frequency=110:duration=600:sample_rate=44100" \
        -f lavfi -i "sine=frequency=220:duration=600:sample_rate=44100" \
        -f lavfi -i "sine=frequency=277.18:duration=600:sample_rate=44100" \
        -f lavfi -i "sine=frequency=329.63:duration=600:sample_rate=44100" \
        -f lavfi -i "anoisesrc=color=pink:sample_rate=44100:duration=600:amplitude=0.10" \
        -filter_complex "[0:a]volume=0.30[a0];[1:a]volume=0.24[a1];[2:a]volume=0.18[a2];[3:a]volume=0.15[a3];[4:a]volume=0.12[a4];[a0][a1][a2][a3][a4]amix=inputs=5:duration=longest:normalize=0,tremolo=f=0.15:d=0.10,pan=stereo|c0=c0|c1=c0,volume=1.0[out]" \
        -map "[out]" -c:a pcm_s16le -ar 44100 -ac 2 "$MASTER"
}

# 从母带切出各时长 wav（pcm copy，采样级精确）
gen_wav_slices() {
  local d
  for d in 60 180 300 600; do
    local f="$SAMPLES/music_${d}s.wav"
    [ -s "$f" ] && continue
    bench_run "gen_wav_${d}s" "$f" "$d" "母带 -t $d -c copy" -- \
      ff -ss 0 -t "$d" -i "$MASTER" -c:a copy "$f"
  done
}

# 从 wav 片段转各格式（用于各格式的吞吐与体验对比）
gen_formats() {
  local d
  for d in 60 180 300 600; do
    local w="$SAMPLES/music_${d}s.wav"
    [ -s "$SAMPLES/music_${d}s.mp3" ] || bench_run "gen_mp3_192_${d}s" "$SAMPLES/music_${d}s.mp3" "$d" "mp3 libmp3lame 192k" -- \
      ffb -i "$w" -c:a libmp3lame -b:a 192k "$SAMPLES/music_${d}s.mp3"
    [ -s "$SAMPLES/music_${d}s_128.mp3" ] || bench_run "gen_mp3_128_${d}s" "$SAMPLES/music_${d}s_128.mp3" "$d" "mp3 libmp3lame 128k" -- \
      ffb -i "$w" -c:a libmp3lame -b:a 128k "$SAMPLES/music_${d}s_128.mp3"
    [ -s "$SAMPLES/music_${d}s.m4a" ] || bench_run "gen_m4a_fast_${d}s" "$SAMPLES/music_${d}s.m4a" "$d" "aac -aac_coder fast 192k" -- \
      ffb -i "$w" -c:a aac -aac_coder fast -b:a 192k -movflags +faststart "$SAMPLES/music_${d}s.m4a"
    [ -s "$SAMPLES/music_${d}s.flac" ] || bench_run "gen_flac_${d}s" "$SAMPLES/music_${d}s.flac" "$d" "flac compression_level 5" -- \
      ffb -i "$w" -c:a flac -compression_level 5 "$SAMPLES/music_${d}s.flac"
  done
}

# 铃声场景：40s 门控（1.2s 有声 / 0.8s 数字静音），用于 silenceremove / 去空白
gen_ringtone() {
  local f="$SAMPLES/ringtone_40s.wav"
  [ -s "$f" ] || bench_run "gen_ringtone_40s" "$f" "40" \
    "音乐+门控(1.2s on/0.8s off) 铃声场景" -- \
    ff -i "$SAMPLES/music_60s.wav" \
       -af "volume='if(lt(mod(t,2),1.2),1,0)':eval=frame,atrim=0:40" -c:a pcm_s16le "$f"
  local m="$SAMPLES/ringtone_40s.mp3"
  [ -s "$m" ] || bench_run "gen_ringtone_40s_mp3" "$m" "40" "铃声场景 mp3 192k 重编码" -- \
    ffb -i "$f" -c:a libmp3lame -b:a 192k "$m"
}

# 边界样本
gen_edge() {
  local f="$SAMPLES/edge_8k_mono.wav"
  [ -s "$f" ] || bench_run "gen_edge_8k_mono" "$f" "30" "8kHz 单声道（旧语音/铃声）" -- \
    ff -i "$SAMPLES/music_60s.wav" -af aresample=8000 -ac 1 -t 30 -c:a pcm_s16le "$f"

  local s="$SAMPLES/short_300ms.mp3"
  [ -s "$s" ] || bench_run "gen_short_300ms" "$s" "0.3" "0.3s 超短 mp3" -- \
    ff -i "$SAMPLES/music_60s.wav" -t 0.3 -c:a libmp3lame -b:a 192k "$s"

  local vid="$SAMPLES/video_only.mp4"
  [ -s "$vid" ] || bench_run "gen_video_only" "$vid" "2" "无音轨 mp4（用于异常用例）" -- \
    ff -f lavfi -i "testsrc=duration=2:size=64x64:rate=5" -c:v libx264 -pix_fmt yuv420p "$vid"

  : > "$SAMPLES/bad_empty.mp3"
  head -c 50000 /dev/urandom > "$SAMPLES/bad_random.mp3"
  cp "$SAMPLES/music_60s.wav" "$SAMPLES/bad_renamed.mp3"
  echo "[gen] edge bad samples ready"
}

gen_master
gen_wav_slices
gen_formats
gen_ringtone
gen_edge

ls -la "$SAMPLES" | head -40
echo "[gen] done"
