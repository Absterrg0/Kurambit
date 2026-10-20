# Game layer

> For maintainers. Why the game layer is shaped the way it is, and the constraints that span
> components. The code lives in `apps/server/src/game/`, `apps/server/src/mcp/toolkits/game/`,
> `packages/contracts/src/game.ts`, and `apps/web/src/components/game/`.

## One execution system

Agents reach Blender and Godot only through the `game_*` toolkit in the app's own MCP server. Every
provider session already receives that server, so a new game needs no per-provider MCP
configuration, and provider adapters contain no game logic. Each tool resolves the game from the
calling thread's project. A thread whose workspace has no `game.json` gets an actionable error
instead of acting on an arbitrary directory.

The game stage's buttons call the same `GameService` methods over RPC. Anything a user can do from
the stage, an agent can do through a tool, and the reverse.

## Design before building

A plan-first game starts with `design.status: "draft"` in `game.json`. The scaffolded `AGENTS.md`
says a draft turn may only write `DESIGN.md`, and the first prompt asks for it, so no Blender or
Godot work starts before the creator agrees to a design. The Design tab renders that file.

Approval flips the status in `game.json`, then sends the build message through ordinary thread
dispatch, so the build is a normal turn with checkpoints, cancellation and the same tool surface.
It builds nothing itself. There is deliberately no `game_*` tool for approval: the design is the
creator's decision, and an agent must not approve its own design.

## Starter templates

New games start from a template under `apps/server/templates/<id>/`: `template.json` (catalog
metadata), `TEMPLATE.md` (the architecture guide, copied to the game root; the game's AGENTS.md
tells the agent to read it first), and `godot/`, which becomes the game's Godot project. Text files
substitute `{{GAME_NAME}}` or, inside a quoted Godot string, `{{GAME_NAME_ESCAPED}}` — the game name
escaped for a string literal, so a name containing `"` or `\` cannot corrupt a scene or
`project.godot`; every other file is copied byte for byte. The templates
directory resolves relative to the running module — `apps/server/templates` in the dev tree,
`dist/templates` in the packed server — and `apps/server/scripts/cli.ts build` copies it into
`dist`. That single rule is why the CLI archive stages `templates/` beside the executable, next to
`client/`: a game created by an unpacked archive would otherwise fail to copy its `godot/` tree.
`GAME_TEMPLATES` in the contracts is what the New game dialog lists, first entry first; a server
test keeps it in step with the folders.

## Why no third-party Blender/Godot MCP servers

We evaluated ahujasid/mcp-for-blender, hi-godot/godot-ai and Coding-Solo/godot-mcp (all MIT):

- mcp-for-blender drives a GUI Blender through an addon socket on a fixed port. That is not
  project-bound, and its useful core is "run bpy code".
- godot-ai needs a running editor, a plugin, and a Python bridge on fixed ports.
- godot-mcp is the closest fit (headless CLI plus a GDScript ops script), but bundling it means a
  second MCP server configured separately for every provider.

The small set of headless, project-bound operations we need (run a bpy script, import, run a
GDScript test, export, serve, playtest) is cheaper to own than to adapt. Revisit this if we need
live editor manipulation.

## Processes are owned and bounded

Blender runs `--background` per operation. Godot runs `--headless` for import, tests and exports.
`GameProcesses` tracks every child by PID with a timeout and stops it on interruption, Stop, and
server shutdown; nothing is ever killed by name. Operations on one game are exclusive. When a turn
ends `interrupted`, `GameTurnCancellationReactor` cancels that game's in-flight operation and
waits for the child to exit. It deliberately leaves native play and the preview server running,
because those belong to the user. The exclusivity is per game, not per thread: interrupting one
thread also cancels a panel-started operation on the same game.

Failures return the command's output tail (bounded to 4 KB) so an agent can fix a script error
without reading log files. Full output stays in `<game>/builds/logs/`.

## Assets keep their source

A Blender asset is the triple `.blend` source, bpy script, and exported `.glb`, recorded in
`game.json`. Godot imports only `godot/`, so it never sees `.blend` files. A revision re-exports to
the same `.glb` path, which keeps Godot's import UIDs and every scene reference stable. "Used by" is
derived by scanning scenes and scripts for the export's `res://` path, not stored, so it cannot go
stale. `game_blender_run` edits the existing `.blend` unless the agent passes `reset`, in which
case the script rebuilds the asset from an empty scene. Only the latest script is kept in
`art/scripts/`; the `.blend` is the editable source of truth and git holds the history.

## Preview and playtest

The web preview is a single-threaded Godot web export using the Compatibility renderer. That
avoids SharedArrayBuffer, so the loopback static server needs no COOP/COEP headers. The server binds
`127.0.0.1` on an ephemeral port per game and lives in-process, so there is no extra process to
track.

The stage letterboxes the preview to the design resolution in `godot/project.godot`, which
`game_status` reports, and loads the loopback URL in a sandboxed iframe instead of the browser
panel: the game is a surface of the app, not a tab in it. Play reuses an existing build and only
exports when one is missing or older than the newest file under `godot/`; Rebuild always exports.
That staleness walk lives in one place (`webBuild.ts`) and is shared with the playtest's decision
to rebuild, so both stay honest about what is on screen.

`game_web_playtest` loads that real build in the app's managed headless Chrome with software WebGL
(SwiftShader), waits for Godot to boot, sends keys and pointer input, and captures screenshots and
console errors. It launches its own browser without the SOCKS proxy that `html_preview` uses,
because it only ever loads the game's own loopback server. Do not merge it into
`htmlRender/headlessChrome.ts`: that launcher's proxy and sandbox flags protect untrusted HTML.

Booting is not a verdict. The playtest downsamples the boot frame and the after-steps frame and
requires a visible difference when steps were given, so an inert game fails instead of passing on a
clean console. Each run is kept under `builds/playtests/<timestamp>/` as frames plus a `result.json`
with the steps, console and verdict; the newest five are kept, and `game_status` (and the Builds tab)
reports the last run and whether the web build has been rebuilt since. Screenshots are evidence of
what happened, not a substitute for a gameplay assertion, which stays in the headless smoke test.

`game_godot_check` is the step before either: one bundled SceneTree checker loads every script,
scene and resource, runs the main scene for 120 physics frames, and reports parse and runtime errors
with file:line plus lint findings such as an InputMap action a script uses but the project never
defines, a CharacterBody without a CollisionShape, or a main scene with no camera.
`game_scene_inspect` dumps a scene's node tree when the wiring, not the code, is the problem.

Agents need a clear stopping point. Without one, a model that passed its gameplay test kept
re-exporting and building its own screenshot tooling for an hour. The scaffolded `AGENTS.md`
defines done: `game_godot_check` ok, smoke test passes, a web playtest whose steps prove the core
loop responded, preview URL returned, end the turn.

## Toolchain

Versions are pinned (Godot 4.7.2 and Blender 4.5.14 LTS) and installed with checksum verification
into `$XDG_DATA_HOME/game-studio/tools`. That location is shared by dev and installed instances,
because binaries are not user state. Godot runs in self-contained mode (`._sc_`), so its editor data
and export templates stay beside the binary and never touch another Godot install. Resolution
order is the explicit settings path, then `GAME_STUDIO_BLENDER`/`GAME_STUDIO_GODOT`, then the managed
install, then `PATH`. Readiness means a real headless export and import succeeded, not that a file
exists.
