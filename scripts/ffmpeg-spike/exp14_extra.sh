#!/usr/bin/env bash
set -u
source /spike/lib.sh
init_exp "14_extra"
O="$OUT/14"; mkdir -p "$O"
MAIN10="$SAMPLES/music_600s.mp3"; BGM="$SAMPLES/music_60s.mp3"

# 1) 修正后的 5min 完整计划：keep [0,120)+[180,300)=240s → 1.5x = 160s
bench_run "full_5m_mp3_fixed" "$O/full_5m_fixed.mp3" "160" "5min: keep[0,120)+[180,300)→160s + BGM循环+fade+alimiter" -- \
  ffb -i "$SAMPLES/music_300s.mp3" -stream_loop -1 -i "$BGM" -filter_complex \
    "[0:a]atrim=start=0:end=120,asetpts=PTS-STARTPTS[s1];[0:a]atrim=start=180:end=300,asetpts=PTS-STARTPTS[s2];[s1][s2]concat=n=2:v=0:a=1,atempo=1.5,volume=-3dB[main];[1:a]volume=0.20,atrim=0:160,asetpts=PTS-STARTPTS[bg];[main][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,afade=t=in:st=0:d=3,afade=t=out:st=155:d=5,alimiter=limit=0.95:level=false[out]" \
    -map "[out]" -t 160 -c:a libmp3lame -b:a 192k "$O/full_5m_fixed.mp3"

# 2) 10min 最坏组合复测（方差）
bench_run "full_10m_mp3_rep2" "$O/full_10m_rep2.mp3" "280" "10min 最坏组合复测" -- \
  ffb -i "$MAIN10" -stream_loop -1 -i "$BGM" -filter_complex \
    "[0:a]atrim=start=0:end=120,asetpts=PTS-STARTPTS[s1];[0:a]atrim=start=300:end=600,asetpts=PTS-STARTPTS[s2];[s1][s2]concat=n=2:v=0:a=1,atempo=1.5,volume=-3dB[main];[1:a]volume=0.20,atrim=0:280,asetpts=PTS-STARTPTS[bg];[main][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,afade=t=in:st=0:d=3,afade=t=out:st=275:d=5,alimiter=limit=0.95:level=false[out]" \
    -map "[out]" -t 280 -c:a libmp3lame -b:a 192k "$O/full_10m_rep2.mp3"

# 3) loudnorm 输出采样率（wav 容器不看编码器上限）
bench_run "loudnorm_60s_wav_rate" "$O/loudnorm_60s.wav" "60" "loudnorm 单遍 60s → wav（检查输出采样率）" -- \
  ffb -i "$SAMPLES/music_60s.mp3" -af "loudnorm=I=-16:TP=-1.5:LRA=11" -c:a pcm_s16le "$O/loudnorm_60s.wav"
echo "[extra] loudnorm→wav 输出流参数: $(probe_stream "$O/loudnorm_60s.wav")"

# 4) 信号处理：无限输入时 SIGTERM vs SIGKILL
t0=$(date +%s%N)
# 外层 SIGKILL 9s 守护：若 elapsed≈9000ms 说明 TERM 未生效
timeout -s KILL 9 timeout -s TERM 5 "$FFMPEG" -hide_banner -nostdin -y -stream_loop -1 -i "$BGM" -f null - >/dev/null 2>&1; rc=$?
t1=$(date +%s%N)
echo "[sig] SIGTERM(5s, outer-kill@9s) rc=$rc elapsed=$(( (t1-t0)/1000000 ))ms（≈9000 说明未响应 TERM）"
t0=$(date +%s%N)
timeout -s KILL 5 "$FFMPEG" -hide_banner -nostdin -y -stream_loop -1 -i "$BGM" -f null - >/dev/null 2>&1; rc=$?
t1=$(date +%s%N)
echo "[sig] SIGKILL(5s) rc=$rc elapsed=$(( (t1-t0)/1000000 ))ms"
echo "[exp14] done"
