# Game Studio

Game Studio is a local desktop app for making games with coding agents. Describe a game, and the
agent you already use (Codex, Claude Code, Cursor, Grok Build, OpenCode, or Antigravity) builds it
with real production tools: Blender for models and Godot for the engine. You play the result inside
the app, ask for changes in plain language, and export a build.

"Game Studio" is a working name. The app is a fork of [T3 Code](https://github.com/pingdotgg/t3code),
which provides the agent harness: provider sessions, durable threads, approvals, terminals, files,
checkpoints, and the in-app browser. Game Studio adds the game layer on top.

## What it does

- **New game from a brief.** Name, folder, brief, optional art direction, and the agent/model to use.
  Game Studio scaffolds a portable project, starts a thread, and the agent builds the game.
- **A production loop that plays its own builds.** Start a run from the Stage: the harness builds,
  plays every build with a separate tester session, compares builds blind so a worse one never
  lands, and keeps working until the budget ends.
- **Real tools, one execution system.** Agents reach Blender and Godot through Game Studio's own
  `game_*` tools in the app's MCP server, which every provider session already gets. Nothing to
  configure per agent.
- **Assets you can edit.** Each Blender asset keeps its `.blend` source and the script that made it.
  The engine-ready `.glb` is exported into the Godot project.
- **Play, revise, export.** Play the real web build in the app, rebuild, and export
  Windows and Linux builds. Follow-up requests ("make the rocks taller") revise the same sources
  and exports.

## Requirements

- Linux x86_64 (the platform this build targets and is tested on).
- At least one coding agent installed and signed in, for example `codex login` or
  `claude auth login`. OpenCode and others can be enabled in **Settings → Providers**.
- Blender and Godot. Game Studio installs pinned, checksum-verified copies for you from the Game panel
  or **Settings → General → Game tools**: Blender 4.5.14 LTS and Godot 4.7.2 (with its export templates),
  into `~/.local/share/game-studio/tools`. You can point it at your own executables instead.
- `uvx` (or `uv`) on PATH for the live Blender view behind the `game_blender_*` tools. The
  **Install tools** button does not install it; get it from https://docs.astral.sh/uv/.

## Run it

From this checkout:

```bash
vp i                  # install dependencies
vp run dev:desktop    # Game Studio desktop app (development build)
```

`vp run dev` serves the same UI in a browser instead. Development state lives in the checkout's
gitignored `.t3` directory. An installed build keeps its state in `~/.game-studio`
(override with `GAME_STUDIO_HOME`), separate from any T3 Code installation.

## Game project layout

```
<game>/
  game.json        manifest: brief, art direction, engine version, assets
  BRIEF.md         brief and art direction, editable
  AGENTS.md        instructions for the agent working on this game
  art/blender/     editable .blend sources
  godot/           the Godot 4.7 project (scenes, scripts, exported .glb models)
  builds/          web, Windows and Linux exports and operation logs (gitignored)
  .studio/         production run rounds, notes, bots and videos
```

Each game is its own git repository, so it can be opened, moved, and continued anywhere Game Studio
runs.

## Documentation

- [Making games](./docs/user/game-studio.md)
- [Architecture](./docs/internals/overview.md) and [game layer](./docs/internals/game-studio.md)
- [Development](./docs/operations/development.md)

## License

MIT, as inherited from T3 Code. See [LICENSE](./LICENSE). Third-party notices are kept in the app's
open source license view.
