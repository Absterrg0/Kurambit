<a href="https://kurambit.com/"><img src="apps/marketing/brand/github/social-preview.jpg" alt="Kurambit. Nobody made the game you want. So make it." /></a>

<h1 align="center">Kurambit</h1>

<p align="center">
  Open source · local first · bring your own coding agent
</p>

<p align="center">
  <a href="https://kurambit.com/">Website</a> ·
  <a href="./docs/user/making-games.md">Making games</a> ·
  <a href="./docs/README.md">Docs</a>
</p>

---

Kurambit is a desktop app for making games with coding agents. Describe a game, and the agent you
already use (Codex, Claude Code, Cursor, Grok Build, OpenCode, or Antigravity) builds it with real
production tools: three.js for the game and Blender for its models.
You play the result inside the app, ask for changes in plain language, and export a build.

What sets it apart is the loop around the model. Kurambit plays every build with a separate tester
session, compares builds blind so a worse one never lands, and stops when the game is done or stops
getting better.

## What it does

- **New game from a brief.** Name, folder, brief, optional art direction, and the agent and model
  to use. Kurambit scaffolds a portable project and starts its production run on the brief.
- **A production loop that plays its own builds.** Every new game is made by a run: the harness builds,
  plays every build with a separate tester session, compares builds blind so a worse one never
  lands, and stops when the game is done or stops getting better.
- **Real tools, one execution system.** Agents reach Blender and the running game through Kurambit's own
  `game_*` tools in the app's MCP server, which every provider session already gets. Nothing to
  configure per agent.
- **Assets you can edit.** Each Blender asset keeps its `.blend` source and the script that made it.
  The engine-ready `.glb` is exported into the game's `web/` project.
- **Play, revise, export.** Play the real build in the app, rebuild, and export a web build. Follow-up requests ("make the rocks taller") revise the same sources and exports.

## Requirements

- Linux x86_64 (the platform this build targets and is tested on).
- At least one coding agent installed and signed in, for example `codex login` or
  `claude auth login`. OpenCode and others can be enabled in **Settings → Providers**.
- Blender 4.2 or later for model art, found on PATH or set in **Settings → General → Game tools**.
- `uvx` (or `uv`) on PATH for the live Blender view behind the `game_blender` tool. The
  **Install tools** button does not install it; get it from https://docs.astral.sh/uv/.

<a id="run-it"></a>

## Run it

From this checkout:

```bash
vp i                  # install dependencies
vp run dev:desktop    # Kurambit desktop app (development build)
```

`vp run dev` serves the same UI in a browser instead. Development state lives in the checkout's
gitignored `.kurambit` directory. An installed build keeps its state in `~/.kurambit`
(override with `KURAMBIT_HOME`).

## Game project layout

```
<game>/
  game.json        manifest: brief, art direction, engine version, assets
  BRIEF.md         brief and art direction, editable
  AGENTS.md        instructions for the agent working on this game
  art/blender/     editable .blend sources
  web/             the three.js project (index.html, main.js, assets and exported .glb models)
  builds/          web exports and operation logs (gitignored)
  .studio/         production run rounds, notes, bots and videos
```

Each game is its own git repository, so it can be opened, moved, and continued anywhere Kurambit
runs.

## Documentation

- [Making games](./docs/user/making-games.md)
- [Architecture](./docs/internals/overview.md) and [game layer](./docs/internals/game-layer.md)
- [Development](./docs/operations/development.md)

## License

MIT. See [LICENSE](./LICENSE). Third-party notices are kept in the app's open source license view.
