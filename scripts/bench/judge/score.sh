#!/usr/bin/env bash
# score.sh <out.json> "<brief>" <game root> <opened.png> [judges=3]: how close a finished game looks
# to a polished release of its kind, 1-10, by fresh, bare Claudes (no CLAUDE.md, memory, MCP or
# skills) blind to who made it, from its four pictures (frames.sh). The median of the judges is the
# score; their spread says how sure it is. Whole points only: two runs of the same brief a judge
# clearly tells apart can score the same, so decide between versions with pair.sh, not this.
# Writes {score, scores, why: [...]} to <out.json> and prints the score.
set -u
J=$(cd "$(dirname "$0")" && pwd); L=$J/../bare
OUT=$1; BRIEF=$2; ROOT=$3; OPENED=$4; N=${5:-3}
D=$(mktemp -d "${TMPDIR:-/tmp}/score.XXXXXX")
"$J/frames.sh" "$ROOT" "$OPENED" "$D" G || { echo '{"score": null, "why": ["no frames"]}' > "$OUT"; rm -rf "$D"; echo none; exit 0; }
PROMPT="These four pictures are one browser game made from this brief: \"$BRIEF\". G-1-opened.png is the game as a player opens it; G-2-play-start.png, G-3-play-middle.png and G-4-play-end.png are moments of an automated player playing it (it plays crudely: judge the game, not the player's skill). Look at all four with the Read tool. Rate from 1 to 10 how close this game looks to a finished, polished game of this kind on Steam or itch.io: 10 = a top release, 8 = clearly good, would ship, 6 = playable prototype, 4 = crude, 2 = barely the brief. Judge what a player sees across the pictures: does it read as this game, its art, layout and interface, polish. First line exactly SCORE: <n>. Then the three biggest problems, one line each, most important first."
cd "$D"
for i in $(seq 1 "$N"); do
  env -u DISPLAY -u WAYLAND_DISPLAY -u XAUTHORITY CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude -p --model claude-opus-5-5 --effort medium \
    --setting-sources project,local --settings "$L/settings.json" --strict-mcp-config --disable-slash-commands \
    --allowedTools Read --output-format json "$PROMPT" < /dev/null > "answer-$i.json" 2> "answer-$i.err" &
done
wait
python3 -I - "$OUT" answer-*.json <<'PY'
import json, re, statistics, sys
whys, scores = [], []
for f in sys.argv[2:]:
    try:
        t = json.load(open(f)).get("result", "")
    except Exception:
        continue
    m = re.search(r"SCORE:\s*(\d+(?:\.\d+)?)", t)
    if m:
        scores.append(float(m.group(1)))
        whys.append(t.strip())
score = statistics.median(scores) if scores else None
json.dump({"score": score, "scores": scores, "why": whys}, open(sys.argv[1], "w"), indent=2)
print(score)
PY
cd /; rm -rf "$D"
