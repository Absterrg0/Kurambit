#!/usr/bin/env bash
# measure.sh <run dir> [port]: wall time, turns, tokens, cost, tool calls, images it looked at,
# lines of code, every screenshot it made (named by the second it was made), and a final frame of
# the page it built, served here on a spare port and stopped after.
set -u
R=$1; PORT=$(( ${2:-47311} + 1 )); L=$(cd "$(dirname "$0")" && pwd)
START=$(cat "$R/start")
{
echo "wall_min $(( ($(cat "$R/end") - START) / 60 )) exit $(cat "$R/exit")"
python3 -I - "$R/run.jsonl" <<'PY'
import json, sys
for l in open(sys.argv[1]):
    d = json.loads(l)
    if d.get("type") == "result":
        u = d.get("usage", {})
        print("turns", d.get("num_turns"), "duration_min", round(d.get("duration_ms", 0) / 60000, 1), "cost_usd", d.get("total_cost_usd"))
        print("tokens", {k: u.get(k) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")})
PY
python3 -I "$L/summ.py" "$R/run.jsonl" | grep -E '^(tool calls|images seen)'
echo "lines of code:"; (cd "$R/work" && find . -path ./node_modules -prune -o -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.html' -o -name '*.css' -o -name '*.glsl' \) ! -name shot.mjs -print0 | xargs -0 wc -l)
} > "$R/report.txt" 2>&1
# Every picture the agent made, in order, named by the seconds since the start (s0123-…).
find "$R/tmp" "$R/work" -path '*/node_modules' -prune -o -name '*.png' ! -name reference.png -printf '%T@ %p\n' | sort -n |
  while read -r t p; do cp "$p" "$R/shots/s$(printf %04d $(( ${t%.*} - START )))-$(basename "$p")"; done
cd "$R/work"; python3 -m http.server "$PORT" --bind 127.0.0.1 > /dev/null 2>&1 & SRV=$!
sleep 1; env -u DISPLAY -u WAYLAND_DISPLAY node shot.mjs "http://127.0.0.1:$PORT/" "$R/final.png" 8000 >> "$R/report.txt" 2>&1
kill "$SRV"
cat "$R/report.txt"
