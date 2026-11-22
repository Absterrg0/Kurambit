#!/usr/bin/env bash
# frames.sh <game root> <opened.png> <dir> <prefix>: the four pictures a finished game is judged by,
# copied into <dir> as <prefix>-1-opened.png .. <prefix>-4-play-end.png: the game as a player opens
# it (the bench's frame), then the first, middle and last frame of the harness's own bot play of the
# game's last measured build. One frame of a page after load showed spawn points, dead ends and
# fades; play shows the game. Nearly blank frames (a fade, a black load: a PNG of a few KB against
# hundreds for a real frame) are left out. Exits 1 when the game has no bot play to show.
set -u
ROOT=$1; OPENED=$2; DIR=$3; P=$4
BOT=$(ls -td "$ROOT"/builds/logs/game-bot-facts-* 2>/dev/null | head -1)
mapfile -t PLAY < <(ls "$BOT"/frames/*.png 2>/dev/null | sort | python3 -I -c "
import os, sys
fs = [l.strip() for l in sys.stdin if l.strip()]
big = max((os.path.getsize(f) for f in fs), default=0)
print('\n'.join(f for f in fs if os.path.getsize(f) * 20 >= big))")
[ -f "$OPENED" ] && [ ${#PLAY[@]} -gt 0 ] || exit 1
cp "$OPENED" "$DIR/$P-1-opened.png"
cp "${PLAY[0]}" "$DIR/$P-2-play-start.png"
cp "${PLAY[$(( ${#PLAY[@]} / 2 ))]}" "$DIR/$P-3-play-middle.png"
cp "${PLAY[-1]}" "$DIR/$P-4-play-end.png"
