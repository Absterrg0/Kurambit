#!/usr/bin/env bash
# Renders the social images from their templates with headless Chrome.
# CHROME overrides the browser; display variables are dropped so nothing
# opens on screen.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
chrome="${CHROME:-google-chrome}"

shot() {
  local page="$1" size="$2" out="$3"
  env -u DISPLAY -u WAYLAND_DISPLAY "$chrome" --headless=new --disable-gpu --hide-scrollbars \
    --allow-file-access-from-files --force-device-scale-factor=1 --window-size="$size" \
    --virtual-time-budget=5000 --screenshot="$out" "file://$here/$page" >/dev/null 2>&1
  echo "${out#"$here"/}"
}

shot og.html 1200,630 "$here/../site/og.png"
shot "og.html?w=1280&h=640" 1280,640 "$here/github-social.png"
shot header.html 1500,500 "$here/x-header.png"
shot "header.html?v=wordmark" 1500,500 "$here/x-header-wordmark.png"
shot "avatar.html?v=seal" 800,800 "$here/avatar.png"
shot avatar.html 800,800 "$here/avatar-paper.png"
