# The bare lane

The same model alone in an empty folder, with the brief, the picture and a screenshot script: no
Kurambit, kit, CLAUDE.md, memory, MCP, claude.ai skills or plugins, or slash commands
(`settings.json`, `--strict-mcp-config`). Every harness change is judged against it on what a
person sees: if the bare agent's frame is better, cut harness before adding any.

    scripts/bench/bare/run.sh <out dir> "<brief>" [reference.png] [minutes=30] [port] [model] [effort]

Run the Kurambit lane on the same brief, picture, model and cap: its first turn, then Keep going on
Autopilot until the cap, as a person who pressed Keep going would, with its frame taken at the cap
(`<out>/<stamp>/lane/<id>.png`). Then put the two side by side:

    vp run bench --brief "<brief>" --reference <png> --minutes 30 \
      --model claudeAgent/claude-opus-5-5 --effort high --home <spare home> --out <dir>
    scripts/bench/sheet.sh <out.png> <bare run dir> <kurambit game root> <turn seconds> [reference.png]

`run.sh` writes `bare-<stamp>/`: `work/` (the agent's folder), `run.jsonl` (its transcript),
`shots/` (every picture it made, named by the second it was made), `final.png` (its page, served
afterwards and shot at 1600x900) and `report.txt` (wall time, turns, tokens, cost, tool calls,
images it looked at, lines of code). `measure.sh <run dir>` measures a finished run again;
`summ.py <jsonl> --log` reads any Claude transcript, a Kurambit game session's included.

Both lanes run headless with no display, WebGL on the machine's GPU; note `uptime` beside any frame
rate. The sheet needs ImageMagick (`montage`).
