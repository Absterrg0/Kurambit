#!/usr/bin/env bash
# The two lanes side by side, at equal wall time (ImageMagick's montage):
#   sheet.sh <out.png> <bare run dir> <kurambit game root> <kurambit turn seconds> [reference.png]
# Columns: the reference; the bare lane's last screenshot by the second Kurambit's turn ended, and
# its final frame; Kurambit's last look at its game (the agent's final game_check frame); a frame
# of Kurambit's build playing (the bench's shots, when the facts recorded one).
set -u
OUT=$1; BARE=$2; GAME=$3; KSEC=$4; REF=${5:-}
LABEL=()
add() { [ -f "$1" ] && LABEL+=(-label "$2" "$1"); }
[ -n "$REF" ] && add "$REF" "reference"
BSTART=$(cat "$BARE/start"); BSEC=$(( $(cat "$BARE/end") - BSTART ))
# Only its screenshots of its own page (the final frame's size), not crops it made of the reference.
size=$(identify -format '%wx%h' "$BARE/final.png" 2>/dev/null)
at=""
for f in $(ls "$BARE/shots" 2>/dev/null); do
  [ "$(( 10#${f:1:4} ))" -le "$KSEC" ] && [ "$(identify -format '%wx%h' "$BARE/shots/$f" 2>/dev/null)" = "$size" ] && at=$f
done
if [ -n "$at" ]; then add "$BARE/shots/$at" "bare at ${KSEC}s (its frame at ${at:1:4}s)"
else LABEL+=(-label "bare at ${KSEC}s: no frame yet" "xc:#1a1a1e[640x360]"); fi
add "$BARE/final.png" "bare final (${BSEC}s)"
look=$(ls -t "$GAME"/builds/logs/three-check-*/view-gameplay.png 2>/dev/null | head -1)
[ -n "$look" ] && add "$look" "Kurambit last look (${KSEC}s)"
play=$(ls "$(dirname "$(dirname "$GAME")")"/shots/*-2.jpg 2>/dev/null | head -1)
[ -n "$play" ] && add "$play" "Kurambit build in play"
montage "${LABEL[@]}" -tile x1 -geometry 640x360+8+8 -background '#1a1a1e' -fill '#e8e8e8' -pointsize 18 "$OUT"
echo "$OUT"
