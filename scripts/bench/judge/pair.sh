#!/usr/bin/env bash
# pair.sh <out.json> "<brief>" <root A> <opened A> <root B> <opened B> [judges per order=3]: which of
# two finished games of one brief is closer to a polished release, by fresh, bare Claudes blind to
# who made them, from each game's four pictures (frames.sh). Each judge sees both games; half see A
# first and half B first, so a judge's lean toward one side cancels. Writes {a, b, same, verdicts}
# to <out.json> (a: judges who preferred A; each verdict with its gap 0-3 and why) and prints
# "a b same". Two runs of unchanged code can differ clearly (a gap of 2), so one brief's pair never
# decides a change: count pairs across briefs.
set -u
J=$(cd "$(dirname "$0")" && pwd); L=$J/../bare
OUT=$1; BRIEF=$2; N=${7:-3}
D=$(mktemp -d "${TMPDIR:-/tmp}/pair.XXXXXX")
run() { # <dir> <first root> <first opened> <second root> <second opened>
  mkdir -p "$1"
  "$J/frames.sh" "$2" "$3" "$1" A && "$J/frames.sh" "$4" "$5" "$1" B
}
run "$D/ab" "$3" "$4" "$5" "$6" && run "$D/ba" "$5" "$6" "$3" "$4" || { echo '{"a": 0, "b": 0, "same": 0, "verdicts": [], "error": "no frames"}' > "$OUT"; rm -rf "$D"; echo "no frames"; exit 0; }
PROMPT="Two browser games were made from the same brief: \"$BRIEF\". Game A is in the pictures A-1 to A-4, game B in B-1 to B-4. In each, picture 1 is the game as a player opens it; 2, 3 and 4 are moments of an automated player playing it (it plays crudely: judge the games, not the player's skill). Look at all eight with the Read tool. Which is closer to a finished, polished game of this kind on Steam or itch.io, judging everything a player sees: does it read as this game, its art, layout and interface, polish? First line exactly WINNER: A or WINNER: B or WINNER: same. Second line exactly GAP: <0-3> (0 no visible difference, 1 slight, 2 clear, 3 large). Then one line on why."
for order in ab ba; do
  for i in $(seq 1 "$N"); do
    (cd "$D/$order" && env -u DISPLAY -u WAYLAND_DISPLAY -u XAUTHORITY CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude -p --model claude-opus-5-5 --effort medium \
      --setting-sources project,local --settings "$L/settings.json" --strict-mcp-config --disable-slash-commands \
      --allowedTools Read --output-format text "$PROMPT" < /dev/null > "$D/$order-$i.txt" 2>/dev/null) &
  done
done
wait
python3 -I - "$OUT" "$D" <<'PY'
import glob, json, os, re, sys
verdicts, tally = [], {"a": 0, "b": 0, "same": 0}
for f in sorted(glob.glob(os.path.join(sys.argv[2], "*-*.txt"))):
    t = open(f).read()
    w = re.search(r"WINNER:\s*(A|B|same)", t, re.I)
    g = re.search(r"GAP:\s*([0-3])", t)
    if not w:
        continue
    said = w.group(1).lower()
    # In the "ba" order the pictures named A are game B's.
    flip = os.path.basename(f).startswith("ba-")
    side = said if said == "same" else ("b" if said == "a" else "a") if flip else said
    tally[side] += 1
    verdicts.append({"winner": side, "gap": int(g.group(1)) if g else None, "why": t.strip().splitlines()[-1][:400]})
json.dump({**tally, "verdicts": verdicts}, open(sys.argv[1], "w"), indent=2)
print(tally["a"], tally["b"], tally["same"])
PY
rm -rf "$D"
