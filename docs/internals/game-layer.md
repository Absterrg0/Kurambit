# Game layer

> For maintainers. The code lives in `apps/server/src/game/`, `apps/server/src/mcp/toolkits/game/`,
> `packages/contracts/src/game.ts`, `apps/web/src/components/game/`.

One brief produces a game through a harness-run loop, and the harness — not the model — owns every
check that matters: it plays every build with a separate session, compares builds blind so a worse
one never lands, and keeps working until a ship review says yes, it stalls, or the creator stops it.

## Services

- `GameService` owns the native boundary: import, check, export (Web, Linux, Windows), web
  preview, exploration sessions, bot runs. Operations are exclusive per game and reported as events.
- `GameProjectService` owns game records: create (blank scaffold), open, list, resolve, inventory.
- `GameRun` owns the production loop. Every role is a fresh ordinary Kurambit thread on the game's
  project; state is `.studio/run.json` + `.studio/rounds.jsonl` plus git, so a crash resumes from
  the folder. Code never interprets model prose apart from declared STATUS/SHIP/COMPARE/ART lines.
- `GameBot` plays a model-written bot file in real time on a private display and records video plus
  detector findings. `GameBlender` keeps a live Blender with its pinned MCP addon per game on a
  private display. `GameToolchain` manages Blender/Godot installs; `GamePreview` serves builds;
  `GameProcesses` tracks child processes; `GameOperations` keeps the last operation per game.
- `GameEngine`/`GameGodotEngine`/`GameThreeEngine` is the engine adapter seam: import, check,
  export release. Godot owns the native process boundary (headless editor import, check script,
  export presets; Web, Linux and Windows releases). three.js owns a headless-Chromium boundary
  instead: the static folder is the game, so import is a no-op success, check loads the page
  and reports console/page errors, export copies the folder. Windows and Linux exports are
  refused plainly for three.js (`backend.exportTargets`); the interface carries `displayName`
  so core messages name the engine without naming it in core code.
- Web play shares the services: `gameExploreWeb` opens real-time headless-Chromium sessions on
  the served static folder (real keyboard/mouse, one screenshot per act, console errors, the
  read-only `window.__studio` probe; no pause between acts). `gameChromium` resolves the
  executable (`KURAMBIT_CHROME` override, then host lookup) and holds the `__studio`
  snippets; `gameWebServer` serves a game-relative directory over loopback for check/explore/bot
  without touching Preview state. `GameBot` plays three.js games in the same Chromium lane:
  identical bot-child protocol and trace shape, stills stitched to video with ffmpeg, the
  overlap/long-fall detectors not applicable, id-clicks counted and skipped (no control tree),
  explicit state writes through the game's own `setState`.
- `GameService` routes by manifest engine with an explicit target override: `game_explore_start`
  defaults to the game's lane, Godot web and native-on-three are refused plainly. The same
  content-addressed export machinery (hash, compare, move into place, select) serves both lanes;
  the expected-files check is engine-aware.

## Tools

Agents reach the services through the `game_*` MCP toolkit; the client reaches the same services
over RPC. Threads the GameRun loop launches get play-level tools only (status, check, import,
export, explore start/act/close, bot run/view, blender tools). Packaging, preview, stop and the
run's own status and steer tools stay outside their catalog.

The creator's session and a live run share the game folder, and the run's git resets would undo the
session's edits. The game's AGENTS.md tells the creator's agent to pass requests to the run with
`game_run_steer` while one is live; the composer is never rerouted. Notes land in
`.studio/steer.jsonl`, the driver folds them into `run.json` before each plan and each result, and
the policy leads the next round's direction with them.

## Loop

Vision, two core-loop prototypes, a blind pick, plan, art, one full build, then rounds until a ship
review says yes, the run stalls, the creator stops it, or an optional budget ends: builder block, boot check, tester play with a bot run,
blind compare in both orders, keep or revert, reviewer notes for the next round. Before the
comparators run, the tester's last bot plays both builds in fresh worktrees for the same real time;
its ending and final probe values sit beside each anonymous report as facts, and a bot that cannot
run on one build is reported, never a reason to drop the round. The only hard
checks are boots, exports and keep-or-revert verdicts. A fresh art director judges the art stage's
renders against the vision and may ask for one bounded redo (`ART: REDO`) before the art is
committed; a missing verdict keeps the art.

## Why this shape

A model left alone grades its own work, stops when it feels done, and says it tested things. The
harness makes these true regardless of what the model says: a separate tester plays every build,
fresh sessions review it, blind compare reverts the loser, and the clock enforces bold moves in
every round. Craft advice lives in the skill pack under `apps/server/templates/studio/` (plus `three.md`
for the browser lane) and the bot
kit under `apps/server/templates/bot-kit/`; both are copied into each game, not the product. `GameCreateInput.engine`
(`godot` default, `three` for the browser lane) picks the starter template (`blank` / `blank-three`)
and the scaffold (`godot/` Godot 4.7 project / `web/` static three.js project with vendored three.js
r0.180.0, MIT); `copyTemplateIntoGame` copies whichever engine tree the template ships. The manifest's
`godotProject` names the engine project directory for either lane (`web` for three.js), so snapshots,
exports and the loop resolve it unchanged. `GameRun` reads the manifest once per loop (`laneOf`) for
the engine directory and prompt paths; everything else in the loop is engine-neutral.

Two constraints hold everywhere:

- Nothing opens on the user's desktop. Every game process drops `DISPLAY`, `WAYLAND_DISPLAY` and
  `XAUTHORITY`; pictures come from a private virtual display.
- No test suites for the game layer beyond data-safety checks; games are played, not asserted.
