# Making games

Kurambit turns a written brief into a playable game. Your coding agent does the work with
Blender and Godot or Unity for native games, or three.js for browser games; you direct it, play the result, and ask for changes.

## Game tools

three.js browser games need nothing installed. Native games use engines you install yourself,
the same way you install your coding agents: Kurambit finds them, checks their versions, and
**Settings → General → Game tools** shows each one's status, where it was found, and a **Get**
link to the vendor's download page when it is missing or the wrong version. After installing
something, press **Check again**.

- **Godot** builds and plays Godot games. Use Godot 4.7.x from
  [godotengine.org/download](https://godotengine.org/download), plus its export templates: in the
  Godot editor choose **Editor → Manage Export Templates** and download them. Without templates a
  Godot game cannot be built for play; without the Windows ones, only Windows exports are refused.
- **Unity** builds Unity games. Install [Unity Hub](https://unity.com/download) and add a Unity 6
  editor, 6000.6.7f1 or later, with **Windows Build Support (Mono)**. When several are installed,
  a new game uses the newest; a game already made keeps the version its project names when that
  editor is installed, and Game tools warns you when only a newer one is, because opening the
  project there upgrades it. Unity also needs a licence: in Unity Hub, sign in and add a free
  Unity Personal licence under **Preferences → Licenses**. Kurambit only reads that the licence is
  active; it never asks for or stores your Unity account. Unity games run on Linux only for now.
- **Blender** makes game art for every engine. Use Blender 4.2 or later from
  [blender.org/download](https://www.blender.org/download/).

Kurambit looks for each tool in this order: the path you enter in **Game tools**, the
`KURAMBIT_GODOT`, `KURAMBIT_UNITY_EDITOR` or `KURAMBIT_BLENDER` environment variable, known install
locations (Unity Hub's editors folder and its secondary install folder, and copies an earlier
Kurambit installed), then your PATH (`godot`, `godot4`, `blender`). A path you enter is the only
place it looks, so a wrong one shows as an error instead of being skipped.

The live Blender view's helper runs through uv; Kurambit uses yours if it is on PATH and otherwise
fetches it once by itself. Playing native games and the live Blender and Unity editors also need
the system Xvfb package (`xorg-x11-server-Xvfb` on Fedora, `xvfb` on Debian and Ubuntu): everything
runs on a private virtual display, so nothing opens on your desktop.

A Unity editor uses 2-3 GB of memory, so Kurambit keeps at most one open at a time and closes it
after ten idle minutes; while one Unity game is checking, playing or exporting, another Unity
game's request reports the editor busy instead of closing it.

Kurambit refuses to open a live editor when the machine is short of memory: about 4 GB free for
Unity, whose builds bring their own tools, and 1.5 GB for the live Blender view, plus about 2 GB
more for a rendered look. Play sessions and bot runs check too, after waiting up to about a minute
for memory to free: about 1.3 GB for a Godot session, 1 GB for a browser session and 1.5 GB for a
bot run. Work started with less tends to be killed by the system midway, or to make the whole
machine hang on swap; a production run waits for memory rather than failing, and if memory stays
short it pauses, ready to resume. The refusal says how much is needed and how much is free; close
other apps or wait a few minutes, then ask again. Kurambit never closes your other apps to make
room. If free memory falls under about 1 GB while an editor sits idle, Kurambit closes it and
reopens it on the next request; it never closes one mid-task. `KURAMBIT_UNITY_MEMORY_MB`,
`KURAMBIT_BLENDER_MEMORY_MB`, `KURAMBIT_EXPLORE_NATIVE_MEMORY_MB`,
`KURAMBIT_EXPLORE_WEB_MEMORY_MB` and `KURAMBIT_BOT_MEMORY_MB` change the requirement, and 0
turns the check off.

You also need a signed-in agent. Codex and Claude are enabled by default; enable others in
**Settings → Providers**.

## Start a game

Choose **New game** on the home screen or in the sidebar. Name the game, write a brief and optional
art direction, and choose where to save it (`~/Games/<slug>` by default). Pick the agent and model,
choose how the run decides (Guided or Autopilot, see below), then choose **Create game**. Kurambit creates the project folder, starts a production run on your
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
then round after round of building, playtesting and judging until the ladder is done and a ship
review has played the game, the budget ends, the run stalls, or you stop it. A new game starts its run on its own. To run again, or to run a game you
opened, give a one-line brief and an optional budget in minutes, then **Start run**. The status
line says what the run is doing, how long it has been going and what comes next; the sidebar and
**Your games** say a game's run is working and on which step. The timeline starts with the
prototype pick: which prototype the game continued from, the comparator's reasoning and each blind
player's report and frames. Each round after it says what it tried and whether it was kept, tied
(inconclusive), rejected or never judged. Open a round to read the evidence: the blind judges'
verdicts and reasoning, the blind players' reports, the bot's results and video, the tester's note
and the reviewer's direction. Your agent can read the same with `game_run_round`, so you can ask it
what happened in a round. Role threads, grouped by stage and round, link to the sessions that did
the work. **Stop run** ends it; every build the run made, rejected ones too, stays kept. The run never
commits, switches branches or touches your git: its builds are Kurambit checkpoints, and your
game folder holds the current build as uncommitted work you commit when you like. Starting the run again without
a new brief continues it where it stopped, and if Kurambit restarts during a run, the run picks up
where it was on its own. A game whose run was made by an earlier version of Kurambit needs a new
run from your brief, which continues from the game as it is: no new vision or prototypes, a plan
writes a ladder for the game, then rounds build it. The earlier run's rounds, ladder and decisions
are not carried over; its history stays in git.

A run is **Guided** (the default) or on **Autopilot**. A Guided run asks you at the moments that
shape the game: once the vision and its key art exist, once both prototypes are built, and once
the plan has written its ladder. Your agent posts the question in the game's chat with the key
art, each prototype's frames and its two-line pitch, or the ladder, and asks what you want. Answer
in your own words: keep it or ask for changes ("pinker, rounder"), pick a prototype or combine
them ("the second one, with the first one's camera"), ask for one more pair of prototypes, edit
the ladder, or let the run decide. Each kind of redo happens once. If nobody answers within about
three minutes of the question reaching the chat, the run goes on with its own choice: it keeps the
vision and the ladder and lets the blind pick choose the prototype. The Run tab says what the run
is waiting for and when it goes on. Autopilot never asks. Choose the profile in the new-game
dialog or next to **Start run**, switch it on the Run tab while a run is live, or ask your agent
to switch; switching to Autopilot while a question waits lets the run decide it at once.

The plan writes a ladder: four to seven steps from the first playable build to a game shaped like
a Steam demo (the core loop end to end, a complete first area with a win and a loss, progression,
a title-to-ending flow, feel and audio), each with checks a player could verify. Each round builds
the next step. A tester plays it and passes or fails each check, and the round is kept when every
check passes and the blind judges do not find the old build clearly better. A step that does not
land in two rounds is set aside and tried once more after the rest. When the ladder is done, a
ship review plays the whole game and the run ends with its verdict and reasons. The run never
polishes on its own: ask for what you want polished in the chat, and the run comes back for one
round on it. Three rounds in a row that land nothing stop the run as **Stalled**, with the last
round's reason; fix what it names (or ask for a change), then resume. A plan that wrote no valid
ladder stops the run as **No ladder**; resuming gives the plan another go. The **Ladder** list on the Run tab shows which steps landed, which one is being built and
which were set aside and why; each round shows how many of its checks passed.

To go back to an earlier kept round, stop the run, open the round and choose **Restore this
round**, or ask your agent to restore it. The engine project, the art sources under `art/` and `ASSETS.md` return to that build in the
game folder, and restoring a later kept round goes forward again. What the folder held before is
kept as a build first, so a restore never discards work: the restore's answer and `.studio/run.log`
name that build with the command that brings it back. Work a run left unfinished when its budget
ran out or it ended mid-round is kept and named in `.studio/run.log` the same way. Notes, `PLAN.md`, `VISION.md`, `BRIEF.md`,
bots and the run's records stay as they are. A resumed run judges its next round against the
restored build. Restore refuses while a run is live and while a stopped run is in the middle of a
round.

While a run is live, steer it instead of editing the game yourself: type what should change into
**Steer the next round** on the Run tab, or tell your agent in the game's chat, which passes it to
the run. The round in progress finishes as planned; the next round starts with your note, ahead of
its ladder step or the reviewer's direction, and the rounds list shows what you asked. A stopped
run keeps your note for when it continues. When no run is live, your agent works on the game
directly.

A game has one run at a time: every chat of the game sees and steers the same run, and starting a
run from another chat continues the one already there. While a run is live, **Stop game** stops
only your own work on the game; stop the run to stop its builds and players. The command palette
can also start, resume and stop a game's run.

## Play and revise

A game opens on its latest session: the game owns the middle of the window and the chat is docked to
its right.

- **Play** serves the selected build, even when the game's files have changed. If no build exists,
  it builds the web version and plays it in the stage. It is the real game, not a recording; click
  the picture once so the keyboard reaches it, and use **Fullscreen** to give it the whole screen.
  A game made from the starter opens on its title screen: choose Play there, or press Enter.
  Opening **Run** or **Builds** keeps the game running; it pauses and mutes while hidden
  and resumes when you come back. Only **Stop**, a rebuild that lands a new build, or pressing Play
  again starts a new session.
- **Rebuild** always exports a fresh web build. When the game's files changed after the last build,
  the stage says so and offers to rebuild.
- **Stop** ends only the processes Kurambit
  started for this game, and closes its preview server.
- **Export Windows** writes a 64-bit build to `builds/windows/game.exe` (Godot and Unity games;
  three.js games export Web only and Windows and Linux are refused with the reason). The standard preset embeds
  the game data, so you can copy that one file to a Windows PC. A game whose Windows preset does not
  embed it also gets `builds/windows/game.pck`, and both files must be copied together; the export
  result says which files to share. **Download package** on the same card zips the checked release
  files Kurambit already exported — `game.exe` alone, or `game.exe` and `game.pck` — without
  exporting again. If the game sources changed since that export, export Windows again before
  packaging. **Export Linux** writes a standalone build to `builds/linux/`. Kurambit checks the
  Windows executable it produced but does not run it, so try it on Windows before sharing it. If
  Godot's Windows export templates are missing, add them in the Godot editor under **Editor →
  Manage Export Templates**. The **Builds**
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

## Asset library

Agents can use a built-in library of free game art and sound: 2D sprites and tilesets, UI kits and
icons, fonts, sound effects, short music, animated 3D characters, 3D kits and textures, from
creators such as Kenney, Quaternius and ambientCG. Everything in it is CC0 (public domain), so you
can ship and sell games that use it without credit. No account or API key is needed.

A production run looks through it on its own: the vision step can choose one pack as the game's
style source, and the art step takes what fits from it before making the rest to match. In a chat
you can ask for it too, for example "use library characters and UI". The agent looks at a contact
sheet of the files before it picks, copies them into the game under
`assets/library/<pack>/` (`unity/Assets/Library/<pack>/` for Unity), and lists each file, its pack
and source page in `ASSETS.md`. It never replaces a file already in the game.

Each pack downloads once, the first time an agent looks inside it, into
`~/.local/share/kurambit/asset-library`, which every game on the machine shares. Each download is
checked against the copy Kurambit was released with; if a source site has changed the file, that pack
is refused rather than used.

## What is in a game folder

Each game is a self-contained git repository you can move, back up, or open on another machine:

- `game.json` and `BRIEF.md` describe the game.
- `godot/` is a normal Godot 4.7 project you can open in the Godot editor (three.js games hold
  `web/` instead: a static three.js project with `index.html`, `main.js`, `style.css`, `assets/`
  and vendored `vendor/three.*.js`). A new game, on any engine, starts inside a demo shell: a
  title screen, pause (Esc or P), settings for volume and fullscreen, a Controls screen where
  players rebind keys (gamepads work too), a win or lose screen with Retry, and credits. Best
  scores and unlocks are saved between launches, and Settings can reset them. The game's icon
  (`assets/ui/icon.png`, cut from the key art) shows on the window, the browser tab and the
  Windows `.exe`. The gameplay lives in `godot/scenes/game.tscn` (`web/main.js` for
  three.js), and the credits screen shows `godot/credits.txt` (`web/credits.txt`).
- Unity games hold `unity/` instead: a normal Unity project you can open in Unity Hub with
  the Unity version its `ProjectSettings/ProjectVersion.txt` names. The gameplay lives in `unity/Assets/Scenes/Game.unity`, the icon is
  `unity/Assets/UI/icon.png` and the credits are `unity/Assets/credits.txt`. Its `Library/`,
  `Temp/` and `Logs/` folders are Unity's caches and are not committed. A Unity export is a folder: copy all of `builds/linux/` or `builds/windows/`, not just
  the executable.
- `art/blender/` holds the editable `.blend` files.
- `builds/` holds exports and operation logs and is not committed.
- `.studio/` holds the production run's rounds, notes, bots and videos.
