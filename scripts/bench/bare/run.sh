#!/usr/bin/env bash
# The bare lane: the same model alone in an empty folder with the brief, the picture and a
# screenshot script; no Kurambit, kit, CLAUDE.md, memory, MCP, skills or slash commands.
#   run.sh <out dir> "<brief>" [reference.png] [minutes=30] [port=47311] [model=claude-opus-5-5] [effort=high]
# Writes <out dir>/bare-<stamp>/{work,tmp,shots,run.jsonl,report.txt,final.png}.
set -u
L=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$L/../../.." && pwd)
OUT=${1:?out dir}; BRIEF=${2:?brief}; REF=${3:-}; MIN=${4:-30}; PORT=${5:-47311}
MODEL=${6:-claude-opus-5-5}; EFFORT=${7:-high}
R=$OUT/bare-$(date +%Y%m%d-%H%M%S); mkdir -p "$R/work" "$R/tmp" "$R/shots"
PICTURE=""
if [ -n "$REF" ]; then cp "$REF" "$R/work/reference.png"; PICTURE="reference.png in this folder is the picture. "; fi
sed "s|{PLAYWRIGHT}|$REPO/apps/server/node_modules/playwright-core/index.mjs|" "$L/shot.mjs" > "$R/work/shot.mjs"
BRIEF="$BRIEF" PICTURE="$PICTURE" PORT="$PORT" python3 -I -c '
import os, sys
t = open(sys.argv[1]).read()
for k in ("BRIEF", "PICTURE", "PORT"): t = t.replace("{" + k + "}", os.environ[k])
open(sys.argv[2], "w").write(t)' "$L/prompt.txt" "$R/prompt.txt"
date +%s > "$R/start"
cd "$R/work"
env -u DISPLAY -u WAYLAND_DISPLAY -u XAUTHORITY CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 TMPDIR="$R/tmp" \
  timeout $((MIN * 60)) claude -p --model "$MODEL" --effort "$EFFORT" \
  --setting-sources project,local --settings "$L/settings.json" --strict-mcp-config \
  --disable-slash-commands --dangerously-skip-permissions --output-format stream-json --verbose \
  "$(cat "$R/prompt.txt")" < /dev/null > "$R/run.jsonl" 2> "$R/run.err"
echo $? > "$R/exit"; date +%s > "$R/end"
"$L/measure.sh" "$R" "$PORT"
