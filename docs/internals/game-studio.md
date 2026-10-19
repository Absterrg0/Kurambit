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

The Game panel's buttons call the same `GameService` methods over RPC. Anything a user can do from
the panel, an agent can do through a tool, and the reverse.

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

`game_web_playtest` loads that real build in the app's managed headless Chrome with software WebGL
(SwiftShader), waits for Godot to boot, sends key presses and canvas clicks, and returns screenshots
and console errors. It launches its own browser without the SOCKS proxy that `html_preview` uses,
because it only ever loads the game's own loopback server. Do not merge it into
`htmlRender/headlessChrome.ts`: that launcher's proxy and sandbox flags protect untrusted HTML.

Agents need a clear stopping point. Without one, a model that passed its gameplay test kept
re-exporting and building its own screenshot tooling for an hour. The scaffolded `AGENTS.md`
defines done: smoke test passes, web playtest boots cleanly, preview URL returned, end the turn.

## Toolchain

Versions are pinned (Godot 4.7.2 and Blender 4.5.14 LTS) and installed with checksum verification
into `$XDG_DATA_HOME/game-studio/tools`. That location is shared by dev and installed instances,
because binaries are not user state. Godot runs in self-contained mode (`._sc_`), so its editor data
and export templates stay beside the binary and never touch another Godot install. Resolution
order is the explicit settings path, then `GAME_STUDIO_BLENDER`/`GAME_STUDIO_GODOT`, then the managed
install, then `PATH`. Readiness means a real headless export and import succeeded, not that a file
exists.
