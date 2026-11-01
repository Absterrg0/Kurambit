# Game layer

> For maintainers. The code lives in `apps/server/src/game/`, `apps/server/src/mcp/toolkits/game/`,
> `packages/contracts/src/game.ts`, `apps/web/src/components/game/`.

One brief produces a game through a harness-run loop, and the harness — not the model — owns every
check that matters: it plays every build with a separate session, compares builds blind so a worse
one never lands, and keeps working until the budget ends.

## Services

- `GameService` owns the native boundary: import, check, export (Web, Linux, Windows), web
  preview, exploration sessions, bot runs. Operations are exclusive per game and reported as events.
- `GameProjectService` owns game records: create (blank scaffold), open, list, resolve, inventory.
- `GameRun` owns the production loop. Every role is a fresh ordinary T3 thread on the game's
  project; state is `.studio/run.json` + `.studio/rounds.jsonl` plus git, so a crash resumes from
  the folder. Code never interprets model prose apart from declared STATUS/SHIP/COMPARE lines.
- `GameBot` plays a model-written bot file in real time on a private display and records video plus
  detector findings. `GameBlender` keeps a live Blender with its pinned MCP addon per game on a
  private display. `GameToolchain` manages Blender/Godot installs; `GamePreview` serves builds;
  `GameProcesses` tracks child processes; `GameOperations` keeps the last operation per game.
- `GameEngine`/`GameGodotEngine` is the engine adapter seam: import, check, export release.

## Tools

Agents reach the services through the `game_*` MCP toolkit; the client reaches the same services
over RPC. Threads the GameRun loop launches get play-level tools only (status, check, import,
export, explore start/act/close, bot run/view, blender tools). Packaging, preview and stop
stay outside their catalog.

## Loop

Vision, two core-loop prototypes, a blind pick, plan, art, one full build, then rounds until the
budget ends or a ship review says yes: builder block, boot check, tester play with a bot run,
blind compare in both orders, keep or revert, reviewer notes for the next round. The only hard
checks are boots, exports and keep-or-revert verdicts.

## Why this shape

A model left alone grades its own work, stops when it feels done, and says it tested things. The
harness makes these true regardless of what the model says: a separate tester plays every build,
fresh sessions review it, blind compare reverts the loser, and the clock enforces bold moves in
every round. Craft advice lives in the skill pack under `apps/server/templates/studio/` and the bot
kit under `apps/server/templates/bot-kit/`; both are copied into each game, not the product.

Two constraints hold everywhere:

- Nothing opens on the user's desktop. Every game process drops `DISPLAY`, `WAYLAND_DISPLAY` and
  `XAUTHORITY`; pictures come from a private virtual display.
- No test suites for the game layer beyond data-safety checks; games are played, not asserted.
