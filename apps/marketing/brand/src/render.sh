#!/usr/bin/env bash
# Renders the brand kit from its templates with headless Chrome, into a
# folder per platform next to this one. CHROME overrides the browser; display
# variables are dropped so nothing opens on screen. Everything but the logos
# is saved as JPEG (Python 3 with Pillow), which every platform takes and
# which halves the files; the logos stay PNG for their transparency.
set -euo pipefail

src="$(cd "$(dirname "$0")" && pwd)"
kit="$(dirname "$src")"
chrome="${CHROME:-google-chrome}"

shot() {
  local page="$1" size="$2" out="$kit/$3"
  mkdir -p "$(dirname "$out")"
  env -u DISPLAY -u WAYLAND_DISPLAY "$chrome" --headless=new --disable-gpu --hide-scrollbars \
    --allow-file-access-from-files --force-device-scale-factor=1 --window-size="$size" \
    --default-background-color=00000000 --virtual-time-budget=6000 \
    --screenshot="$out" "file://$src/$page" >/dev/null 2>&1
  echo "$3"
}

card() {
  local query="$1" w="$2" h="$3" out="$4"
  shot "card.html?$query&w=$w&h=$h" "$w,$h" "$out"
}

# Logos, on transparent grounds.
shot "logo.html?v=lockup&w=1600&h=440" 1600,440 logo/kurambit-lockup.png
shot "logo.html?v=lockup&t=dark&w=1600&h=440" 1600,440 logo/kurambit-lockup-light.png
shot "logo.html?v=pixel&w=2200&h=560" 2200,560 logo/kurambit-wordmark-pixel.png
shot "logo.html?v=pixel&t=dark&w=2200&h=560" 2200,560 logo/kurambit-wordmark-pixel-light.png

# Profile pictures: square, made to be cropped round.
for v in seal paper dark; do
  shot "avatar.html?v=$v&w=1024&h=1024" 1024,1024 "avatar/avatar-$v.png"
done

posts="make tell played better agents join"

# Headers and banners: the wall of games, edge to edge. The profile's name
# and bio sit under it, so it carries no words; header-headline adds them.
wall() {
  local query="$1" w="$2" h="$3" out="$4"
  shot "shelf.html?$query&w=$w&h=$h" "$w,$h" "$out"
}

# X: the header and six posts.
wall "t=paper" 1500 500 x/header.png
wall "t=dark" 1500 500 x/header-dark.png
wall "t=paper&copy=1" 1500 500 x/header-headline.png
n=1
for m in $posts; do
  card "m=$m" 1600 900 "x/post-$n-$m.png"
  n=$((n + 1))
done

# Instagram: the same six as a carousel, and two stories.
n=1
for m in $posts; do
  card "m=$m" 1080 1350 "instagram/post-$n-$m.png"
  n=$((n + 1))
done
card "m=make&t=dark" 1080 1920 instagram/story-make.png
card "m=join" 1080 1920 instagram/story-join.png

# LinkedIn, YouTube and GitHub.
wall "t=paper" 1584 396 linkedin/banner-profile.png
wall "t=paper&rows=2" 1128 191 linkedin/banner-company.png
wall "t=paper&rows=9" 2560 1440 youtube/banner.png
# The link card: the fox's face over a vermilion sun, and the headline. The
# site serves it as ../site/og.png; GitHub's social preview and the README
# banner are the same.
shot "og.html?w=1200&h=630" 1200,630 web/og.png
shot "og.html?w=1280&h=640" 1280,640 github/social-preview.png

find "$kit" -path "$kit/src" -prune -o -path "$kit/logo" -prune -o -name "*.png" -print0 |
  xargs -0 python3 -c '
import os, sys
from PIL import Image
for path in sys.argv[1:]:
    Image.open(path).convert("RGB").save(path[:-4] + ".jpg", quality=92, subsampling=0, optimize=True, progressive=True)
    os.remove(path)
'
