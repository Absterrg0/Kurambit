#!/usr/bin/env bash
# A blind judge of one pair of frames: a fresh, bare Claude (no CLAUDE.md, memory, MCP or skills)
# sees the two lanes' frames at the cap in a random order, with the reference when the task has
# one, and says which a player would rather play and why. It never learns which lane made which.
#   judge.sh <out.json> "<brief>" <bare.png> <kurambit.png> [reference.png] [model=claude-opus-5-5] [effort=high]
# Writes {order, winner, why} to <out.json>; `winner` is "bare", "kurambit" or null when the
# answer named neither.
set -u
L=$(cd "$(dirname "$0")/bare" && pwd)
OUT=$1; BRIEF=$2; BARE=$3; KURAMBIT=$4; REF=${5:-}; MODEL=${6:-claude-opus-5-5}; EFFORT=${7:-high}
D=$(mktemp -d "${TMPDIR:-/tmp}/judge.XXXXXX")
if (( RANDOM % 2 )); then ORDER="bare kurambit"; cp "$BARE" "$D/first.png"; cp "$KURAMBIT" "$D/second.png"
else ORDER="kurambit bare"; cp "$KURAMBIT" "$D/first.png"; cp "$BARE" "$D/second.png"; fi
SEEN="first.png and second.png"
if [ -n "$REF" ]; then cp "$REF" "$D/reference.png"; SEEN="$SEEN, and reference.png (the picture the person asked the game to match)"; fi
PROMPT="Two games were made for the same brief: \"$BRIEF\". In this folder are $SEEN: one screenshot of each game in play. Look at the pictures with the Read tool. Which game would a player rather play, judging from what they see? Answer with a first line that is exactly WINNER: first or WINNER: second, then why in at most three sentences."
cd "$D"
env -u DISPLAY -u WAYLAND_DISPLAY -u XAUTHORITY CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
  claude -p --model "$MODEL" --effort "$EFFORT" --setting-sources project,local \
  --settings "$L/settings.json" --strict-mcp-config --disable-slash-commands \
  --allowedTools Read --output-format json "$PROMPT" < /dev/null > "$D/answer.json" 2> "$D/answer.err"
ORDER="$ORDER" python3 -I - "$D/answer.json" "$OUT" <<'PY'
import json, os, sys
order = os.environ["ORDER"].split()
try:
    text = json.load(open(sys.argv[1])).get("result", "")
except Exception:
    text = ""
first = text.strip().splitlines()[0].strip().upper() if text.strip() else ""
slot = {"WINNER: FIRST": 0, "WINNER: SECOND": 1}.get(first)
json.dump({"order": order, "winner": None if slot is None else order[slot], "why": text.strip()},
          open(sys.argv[2], "w"), indent=2)
print(None if slot is None else order[slot])
PY
rm -rf "$D"
