# Making games

Game Studio turns a written brief into a playable Godot game. Your coding agent does the work with
Blender and Godot; you direct it, play the result, and ask for changes.

## Set up the tools once

Open **Settings → General → Game tools** and choose **Install tools**. Game Studio downloads
Blender 4.5.14 LTS and Godot 4.7.2 with the matching export templates, checks their published
checksums, and keeps them in `~/.local/share/game-studio/tools`. **Verify** runs a real Blender
export and a real Godot import, so a green status means the tools work, not just that files exist.

To use your own installs, enter their paths in **Game tools**. Godot must be 4.7.x so its export
templates match; Blender 4.2 or newer works.

The live Blender view additionally needs `uvx` (or `uv`) on PATH: it runs the pinned 3D-server
package behind the `game_blender_*` tools. Install uv from https://docs.astral.sh/uv/ if those
tools report it missing.

You also need a signed-in agent. Codex and Claude are enabled by default; enable others in
**Settings → Providers**.

## Start a game

Choose **New game** on the home screen or in the sidebar. Name the game, write a brief and optional
art direction, and choose where to save it (`~/Games/<slug>` by default). Pick the agent and model,
then choose **Create game**. Game Studio creates the project folder, starts a session with your
brief, and opens the game workspace.

To continue an existing game, choose its card under **Your games**, or use **Open game** and pick a
folder that contains `game.json`. Opening a game resumes its latest session instead of starting an
empty one.

## Run the production loop

The **Run** tab in the stage drives the whole build: vision, prototypes, a blind pick, plan, art,
then round after round of building, playtesting and judging until the budget ends or a ship review
passes. Give it a one-line brief and an optional budget in minutes, then **Start run**. The status
line says where the run is; the rounds list shows each round's move, whether it was kept, the
judges' verdicts and the tester's note; role threads link to the sessions that did the work.
**Stop run** ends it; rejected work stays on its branch.

## Play and revise

A game opens on its latest session: the game owns the middle of the window and the chat is docked to
its right.

- **Play** serves the selected build, even when the game's files have changed. If no build exists,
  it builds the web version and plays it in the stage. It is the real game, not a recording; click
  the picture once so the keyboard reaches it, and use **Fullscreen** to give it the whole screen.
  Opening **Run** or **Builds** keeps the game running; it pauses and mutes while hidden
  and resumes when you come back. Only **Stop**, a rebuild that lands a new build, or pressing Play
  again starts a new session.
- **Rebuild** always exports a fresh web build. When the game's files changed after the last build,
  the stage says so and offers to rebuild.
- **Stop** ends only the processes Game Studio
  started for this game, and closes its preview server.
- **Export Windows** writes a 64-bit build to `builds/windows/game.exe`. The standard preset embeds
  the game data, so you can copy that one file to a Windows PC. A game whose Windows preset does not
  embed it also gets `builds/windows/game.pck`, and both files must be copied together; the export
  result says which files to share. **Download package** on the same card zips the checked release
  files Game Studio already exported — `game.exe` alone, or `game.exe` and `game.pck` — without
  exporting again. If the game sources changed since that export, export Windows again before
  packaging. **Export Linux** writes a standalone build to `builds/linux/`. Game Studio checks the
  Windows executable it produced but does not run it, so try it on Windows before sharing it. If
  the Windows export templates are missing, **Install tools** in Settings adds them. The **Builds**
  tab lists every target with its time, folder and logs, and a freshness check against the current
  sources.
- **Download package** on the Web card zips the exact build Play serves, without exporting or
  rebuilding. Later source edits are not included; only a new export changes what a new package
  contains. Upload the extracted files to an ordinary static HTTP host and serve them over HTTP;
  opening `index.html` directly from disk (`file://`) is not a supported way to play a WebAssembly
  export.
- The chat column is resizable; drag its edge, or hide it with the panel control in the stage header
  to give the game the whole window.

To change the game, write a follow-up in the session, for example "make the rocks taller and spread
the trees out". The agent edits the same Blender sources and re-exports to the same paths, so scenes
keep their references.

Stopping the agent's turn stops its Blender and Godot commands, but a game that is already running
keeps running; use **Stop** in the stage to close it.

## What is in a game folder

Each game is a self-contained git repository you can move, back up, or open on another machine:

- `game.json` and `BRIEF.md` describe the game.
- `godot/` is a normal Godot 4.7 project you can open in the Godot editor.
- `art/blender/` holds the editable `.blend` files.
- `builds/` holds exports and operation logs and is not committed.
- `.studio/` holds the production run's rounds, notes, bots and videos.
