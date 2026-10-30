#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 对实验中保存的原始 PCM 做统一分析（宿主机执行）：
#   - click    : 拼接点/裁剪起点的相邻样本跳变（爆音证据）
#   - envelope : 淡入淡出包络形状
#   - stats    : 幅度/RMS/削波
#   - beeps    : 标记音起点（ms 级裁剪偏差）
#   - freq     : 自相关基频（变速是否保持音调）
# 输出：$WORK/results/analysis.jsonl（每行带 tag 的 JSON）
# ---------------------------------------------------------------------------
set -u
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
WORK=${1:-${WORK:-/tmp/ffmpeg-spike-work}}
NODE_IMAGE=${NODE_IMAGE:-node:16-alpine}
A="$WORK/out/analysis"
OUT="$WORK/results/analysis.jsonl"
: > "$OUT"

run() {
  local tag="$1" mode="$2" file="$3" arg="${4:-}"
  [ -s "$A/$file" ] || { echo "[skip] $tag ($file missing)"; return; }
  local json
  json=$(docker run --rm --cpus=1 --memory=1g \
    -v "$WORK":/work -v "$SCRIPT_DIR":/spike \
    "$NODE_IMAGE" node /spike/analyze_pcm.js "$mode" "/work/out/analysis/$file" 44100 "$arg" 2>/dev/null)
  [ -z "$json" ] && { echo "[fail] $tag"; return; }
  printf '{"tag":"%s","result":%s}\n' "$tag" "$json" >> "$OUT"
  printf '[%-9s] %-26s %s\n' "$mode" "$tag" "$(printf '%s' "$json" | cut -c1-190)"
}

echo "== click（爆音/跳变；maxDelta 越接近 1 越可能是硬拼接爆音） =="
for f in remove_filter_join remove_concatcopy_join remove_crossfade_join ref_join concat_filter_join concat_copy_join; do
  run "$f" click "$f.s16le"
done
for f in copy_mp3_30_90 copy_mp3_0_60 copy_m4a_30_90 copy_flac_30_90 copy_mp3_600_30_90; do
  run "${f}_head" click "${f}.head.s16le"
done
run atrim_mp3_30_90_head click atrim_mp3_30_90.head.s16le

echo "== envelope（淡入淡出包络，step=200ms） =="
for f in fade_in_head fade_out_tail; do run "$f" envelope "$f.s16le" 200; done
run full_10m_head envelope full_10m_head.s16le 200
run full_10m_tail envelope full_10m_tail.s16le 250

echo "== stats（音量/削波） =="
for f in vol_orig vol_p6 vol_p18 vol_p18_lim_default vol_p18_lim_disabled; do run "$f" stats "$f.s16le"; done

echo "== stats（BGM 混音音量平衡） =="
for f in bgm_main bgm_bgm bgm_mix; do run "$f" stats "$f.s16le"; done

echo "== beeps（ms 级起点偏差） =="
for f in mark_copy_mp3 mark_copy_m4a mark_copy_flac mark_atrim_mp3 mark_atrim_m4a mark_atrim_flac; do
  run "$f" beeps "$f.s16le"
done

echo "== freq（变速/变调是否保音调；输入 440Hz） =="
for f in sine_440_5s sine_tempo15 sine_asetrate15 sine_rubber_tempo15 sine_rubber_pitch15; do
  run "$f" freq "pitch_$f.s16le"
done

echo "[analyze] -> $OUT"
