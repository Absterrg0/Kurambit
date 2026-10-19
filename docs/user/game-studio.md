# Making games

Game Studio turns a written brief into a playable Godot game. Your coding agent does the work with
Blender and Godot; you direct it, play the result, and ask for changes.

## Set up the tools once

Open **Settings → General → Game tools**, or the **Game** panel of any game, and choose
**Install tools**. Game Studio downloads Blender 4.5.14 LTS and Godot 4.7.2 with the matching export
templates, checks their published checksums, and keeps them in `~/.local/share/game-studio/tools`.
**Verify** runs a real Blender export and a real Godot import, so a green status means the tools
work, not just that files exist.

To use your own installs, enter their paths in **Game tools**. Godot must be 4.7.x so its export
templates match; Blender 4.2 or newer works.

You also need a signed-in agent. Codex and Claude are enabled by default; enable others in
**Settings → Providers**.

## Start a game

Choose **New game** on the home screen or in the sidebar. Give it a name, pick a starter template
(each one is a working Godot project the agent extends instead of starting from nothing), choose a
parent folder (`~/Games` by default), write a brief and optional art direction, then pick the agent
and model. Game Studio creates the project folder with the template's Godot project already in
place, starts a thread with your brief, and opens the **Game** panel.

The agent models assets in Blender, brings them into Godot, writes the scenes and GDScript, runs a
headless gameplay test, and checks the web build in a headless browser before it reports back.

To continue an existing game, choose it under **Recent games**, or use **Open game** and pick a
folder that contains `game.json`.

## Play and revise

In the **Game** panel:

- **Play in app** builds the web version and opens it in the in-app browser. This is the real game,
  not a recording.
- **Run native** starts the game in its own window. **Stop** ends only processes Game Studio started
  for this game, and closes its preview server.
- **Export Linux** writes a standalone build to `builds/linux/`.
- **Assets** lists each Blender asset with its thumbnail, its `.blend` source, its exported `.glb`,
  and the scenes or scripts that use it.
- **Brief** shows what the game is meant to be. Edit `BRIEF.md` to change it.

To change the game, write a follow-up in the thread, for example "make the rocks taller and spread the
artifacts out". The agent edits the same Blender sources and re-exports to the same paths, so scenes
keep their references.

Stopping the agent's turn also stops any Blender or Godot work it started.

## What is in a game folder

Each game is a self-contained git repository you can move, back up, or open on another machine:

- `game.json` and `BRIEF.md` describe the game.
- `TEMPLATE.md` describes the starter template it was built from and what to extend.
- `art/blender/` holds the editable `.blend` files and `art/scripts/` the scripts behind them.
- `godot/` is a normal Godot 4.7 project you can open in the Godot editor.
- `builds/` holds exports and operation logs and is not committed.
