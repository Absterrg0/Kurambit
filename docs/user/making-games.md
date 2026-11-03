# Making games

Kurambit turns a written brief into a playable game. Your coding agent does the work with
Blender and Godot or Unity for native games, or three.js for browser games; you direct it, play the result, and ask for changes.

## Set up the tools once

Open **Settings → General → Game tools** and choose **Install tools**. Kurambit downloads
Blender 4.5.14 LTS and Godot 4.7.2 with the matching export templates, checks their published
checksums, and keeps them in `~/.local/share/kurambit/tools`. **Verify** runs a real Blender
export and a real Godot import, so a green status means the tools work, not just that files exist.

To use your own installs, enter their paths in **Game tools**. Godot must be 4.7.x so its export
templates match; Blender 4.2 or newer works.

The live Blender view additionally needs `uvx` (or `uv`) on PATH: it runs the pinned 3D-server
package behind the `game_blender_*` tools. Install uv from https://docs.astral.sh/uv/ if those
tools report it missing. Playing native games and the live Blender view also need the system
Xvfb package (`xorg-x11-server-Xvfb` on Fedora, `xvfb` on Debian and Ubuntu): everything runs on a
private virtual display, so nothing opens on your desktop.

Unity games need Unity installed separately: choose **Install Unity** in **Game tools**. Kurambit
downloads Unity's official CLI (checked against its published hash) and uses it to install Unity
6000.6.7f1 with Windows build support into the same tools folder, about 4.5 GB. Unity also needs a
licence on this machine: open Unity Hub, sign in, and add a free Unity Personal licence under
**Preferences → Licenses**. Kurambit reads that the licence is active and tells you when it is
missing or needs a refresh; it never asks for or stores your Unity account. A Unity editor uses 2-3
GB of memory, so Kurambit keeps at most one open at a time and closes it after ten idle minutes;
while one Unity game is checking, playing or exporting, another Unity game's request reports the
editor busy instead of closing it.

You also need a signed-in agent. Codex and Claude are enabled by default; enable others in
**Settings → Providers**.

## Start a game

Choose **New game** on the home screen or in the sidebar. Name the game, write a brief and optional
art direction, and choose where to save it (`~/Games/<slug>` by default). Pick the agent and model,
then choose **Create game**. Kurambit creates the project folder, starts a production run on your
brief (see below), and opens the game on its **Run** tab. The game's session stays yours: talk to
your agent there about the game at any time.

Engine: Godot native (default) or three.js browser. Godot is the full lane: a real Godot 4.7 project
with Blender-made art, native play, and Web, Windows and Linux exports. three.js is the quick
browser lane: a static browser game with three.js vendored (no install step), played in real time
through the same tools, with a Web export only. The run loop, Play, preview and web packaging work
the same on both. Unity native is a Unity 6 project in C#: the agent edits it through one live Unity
editor on a private display, plays real Linux builds of it, and exports Linux and Windows builds.
Unity games have no Web export, so Play and web packaging are not available for them, and bot runs
do not play them yet. In a production run, each blind comparison builds a Unity game in a separate
checkout of it, which takes over the one Unity editor for that build; the game's own editor reopens
on its next Unity call.

To continue an existing game, choose its card under **Your games**, or use **Open game** and pick a
folder that contains `game.json`. Opening a game resumes its latest session instead of starting an
empty one.

## Run the production loop

The **Run** tab in the stage drives the whole build: vision, prototypes, a blind pick, plan, art,
then round after round of building, playtesting and judging until a ship review passes, the
run stalls, or you stop it. A new game starts its run on its own. To run again, or to run a game you
opened, give a one-line brief and an optional budget in minutes, then **Start run**. The status
line says where the run is; each round in the list says what it tried and whether it was kept,
tied (inconclusive), rejected or never judged. Open a round to read the evidence: the blind judges'
verdicts and reasoning, the blind players' reports, the bot's results and video, the tester's note
and the reviewer's direction. Your agent can read the same with `game_run_round`, so you can ask it
what happened in a round. Role threads link to the sessions that did the work. **Stop run** ends
it; rejected work stays on its branch.

To go back to an earlier kept round, stop the run, open the round and choose **Restore this
round**. The engine project, the art sources under `art/` and `ASSETS.md` return to that build as
a new commit, so later commits stay in git history, and restoring a later kept round goes forward
again. Notes, `PLAN.md`, `VISION.md`, `BRIEF.md`, bots and the run's records stay as they are. A resumed run judges its next
round against the restored build. Restore refuses while a run is live, while a stopped run is in
the middle of a round, and while the game has uncommitted changes; it never discards work.

While a run is live, steer it instead of editing the game yourself: type what should change into
**Steer the next round** on the Run tab, or tell your agent in the game's chat, which passes it to
the run. The round in progress finishes as planned; the next round starts with your note, ahead of
the reviewer's direction, and the rounds list shows what you asked. When no run is live, your agent
works on the game directly.

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
- **Stop** ends only the processes Kurambit
  started for this game, and closes its preview server.
- **Export Windows** writes a 64-bit build to `builds/windows/game.exe` (Godot games only;
  three.js games export Web only and Windows and Linux are refused with the reason). The standard preset embeds
  the game data, so you can copy that one file to a Windows PC. A game whose Windows preset does not
  embed it also gets `builds/windows/game.pck`, and both files must be copied together; the export
  result says which files to share. **Download package** on the same card zips the checked release
  files Kurambit already exported — `game.exe` alone, or `game.exe` and `game.pck` — without
  exporting again. If the game sources changed since that export, export Windows again before
  packaging. **Export Linux** writes a standalone build to `builds/linux/`. Kurambit checks the
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
- **Check and playtest on three.js.** `game_check` on a three.js game loads the page headless and
  reports console and page errors instead of script errors; `game_explore_*` play it in real time
  with real keys and clicks (see the `three` studio skill for the bridge contract).

To change the game, write a follow-up in the session, for example "make the rocks taller and spread
the trees out". The agent edits the same Blender sources and re-exports to the same paths, so scenes
keep their references.

Stopping the agent's turn stops its Blender and Godot commands, but a game that is already running
keeps running; use **Stop** in the stage to close it.

## What is in a game folder

Each game is a self-contained git repository you can move, back up, or open on another machine:

- `game.json` and `BRIEF.md` describe the game.
- `godot/` is a normal Godot 4.7 project you can open in the Godot editor (three.js games hold
  `web/` instead: a static three.js project with `index.html`, `main.js`, `style.css`, `assets/`
  and vendored `vendor/three.*.js`).
- Unity games hold `unity/` instead: a normal Unity project you can open in Unity Hub with
  Unity 6000.6.7f1. Its `Library/`, `Temp/` and `Logs/` folders are Unity's caches and are not
  committed. A Unity export is a folder: copy all of `builds/linux/` or `builds/windows/`, not just
  the executable.
- `art/blender/` holds the editable `.blend` files.
- `builds/` holds exports and operation logs and is not committed.
- `.studio/` holds the production run's rounds, notes, bots and videos.
