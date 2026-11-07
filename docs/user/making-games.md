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
- **MPFB2** is optional: it gives characters built in Blender a human body. See
  [Characters](#characters).

Kurambit looks for each tool in this order: the path you enter in **Game tools**, the
`KURAMBIT_GODOT`, `KURAMBIT_UNITY_EDITOR` or `KURAMBIT_BLENDER` environment variable, known install
locations (Unity Hub's editors folder and its secondary install folder, and copies an earlier
Kurambit installed), then your PATH (`godot`, `godot4`, `blender`). A path you enter is the only
place it looks, so a wrong one shows as an error instead of being skipped.

ffmpeg records bot runs' videos, so bot runs need it; the asset library also uses it to draw
contact sheets of a pack's pictures, and without it lists the pack's files with no picture.
Kurambit finds it on your PATH or at `KURAMBIT_FFMPEG`.

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
machine hang on swap. The refusal says how much is needed and how much is free; close other apps or
wait a few minutes, then ask again. Starts also take turns across the machine, so a start can wait
behind another game's. If Kurambit cannot measure two keep-going steps in a row (the browser, an
engine editor or a copy of the game kept failing), keep going pauses with what failed; it never
judges or undoes a step on it, and **Resume** goes on once the cause is fixed. Kurambit never closes
your other apps to make room. If free memory falls under about 1 GB while an editor sits idle,
Kurambit closes it and reopens it on the next request; it never closes one mid-task. `KURAMBIT_UNITY_MEMORY_MB`,
`KURAMBIT_BLENDER_MEMORY_MB`, `KURAMBIT_EXPLORE_NATIVE_MEMORY_MB`,
`KURAMBIT_EXPLORE_WEB_MEMORY_MB`, `KURAMBIT_EXPLORE_UNITY_MEMORY_MB` (1 GB for a Unity session),
`KURAMBIT_BLENDER_RENDER_MEMORY_MB` (sprite renders and rendered looks) and
`KURAMBIT_BOT_MEMORY_MB` change the requirement, and 0 turns the check off.

You also need a signed-in agent. Codex and Claude are enabled by default; enable others in
**Settings → Providers**.

## Making a game

Choose **New game** on the home screen or in the sidebar. Name the game, write a brief and optional
art direction, choose the engine and where to save it (`~/Games/<slug>` by default), pick the agent
and model, then choose **Create game**. Kurambit creates the project folder and opens the game's
chat with your brief already sent as its first message, so you see exactly what the agent was told.
Your agent builds a first playable version in a few minutes; every message after that makes it
better.

A three.js game is live on the stage from the moment it exists: Kurambit serves the game folder and
plays it, so you watch the starter turn into your game while your agent works. When the agent saves,
the game reloads straight into play: at once when no turn is running, and while your agent's turn
runs, at most every ten seconds and once more when the turn ends. If you are playing at that moment (you clicked into
the game), it is not reloaded under you: the stage says your agent changed the game while you were
playing, with **Reload**. A hidden stage catches up when you show it. If a save breaks the game, the
stage names the error: quietly while the turn runs, since the agent may be mid-change, and with
**Ask agent to fix** once the turn has ended. Godot and Unity games are not live: a Godot game plays
its latest Web build, with **Play** and **Rebuild**, and a Unity game plays in its own window.

Engine: three.js browser (default), Godot native or Unity native. Godot is the full native lane: a real Godot 4.7 project
with Blender-made art, native play, and Web, Windows and Linux exports. Its Windows and Linux builds
draw with Forward+; its Web build, Play and the agent's play sessions draw with the simpler
Compatibility renderer, so a few effects only the native builds draw are left out of the default look. three.js is the quick
browser lane: a static browser game with three.js vendored (no install step), played in real time
through the same tools, with a Web export only. Play, preview and web packaging work the same on both. Unity native is a Unity 6 project in C#: the agent edits it through one live Unity
editor on a private display, plays real Linux builds of it, and exports Linux and Windows builds.
Unity games have no Web export, so Play and web packaging are not available for them; explore
sessions and bot runs play a Linux player of the current sources, built once per change.

To continue an existing game, choose its card under **Your games** or its row in the sidebar, or use
**Open game** and pick a folder that contains `game.json`. A game opens on its main chat: the first
chat it was made in, or the next oldest if you archive that one. The arrow on the game's sidebar row
lists its **Other chats** and its **Past runs**, and **+** starts a new chat.

## Style

A game's look is locked in `STYLE.json` at the game's root: which family of the built-in CC0 art
library it uses (KayKit, Kenney low-poly, Kenney pixel art and others), the packs its art and sound
come from, pixel art or smooth, the view, the skeleton its characters share, and loudness targets for
music and effects. The agent writes it when it chooses the look, and its art tools hold the game to
it: art from other packs, characters on another skeleton and sprites in another palette are refused
until the file changes. To change the game's direction, edit `STYLE.json` or ask your agent to,
then have the art redone. Delete it to lift the lock.

## Characters

Each game has one setting for how its characters are made, **Make characters with**: **Library**
(the default), **Blender** or **Generated**. Pick it in the **New game** dialog, so the first turn builds the cast your way, and change it later from the game's **More** menu (**⋯** above the
stage) or the command palette's **Make characters with…**; the stage's build detail shows the
current choice. On **Library** the agent takes characters from the asset library and will not model
one. On **Blender** it builds each character in Blender: a body on the shared skeleton, then the
head, clothes, tail or ears it models itself, with the library's animations already fitted. On
**Generated** an art provider makes them (see [Generated art](#generated-art)): Tripo or Meshy on your
own key makes rigged 3D characters, and with Codex alone they are images, such as character sheets
and sprites. Generated can be picked once a 3D provider
or Codex is ready; until then the choice says what to set up. The agent never changes the setting itself: when the chosen way cannot make
something, it says so and names the others, and you switch the setting when you want to.

Human bodies on **Blender** come from MPFB2, which you install once: **Settings → General → Game
tools**, MPFB2, **Install**. Its code is GPL-3.0, so Kurambit does not ship it; Install downloads
it from extensions.blender.org (46 MB) into Kurambit's own Blender sessions, never your Blender
settings, and the bodies it makes are CC0. **Remove** deletes it again; a live Blender view already
open keeps it until it reopens. Without MPFB2, Blender characters use library bodies.

Before a character or prop made in Blender reaches the game, the agent reviews it: one image with a
turnaround, silhouettes, the model at the size it appears in play, its walk, run and jump, the
palette, and the concept art when the game has one, beside the measurements (height, triangles,
texture size) and anything the export would refuse. An export is refused unless the model was
reviewed exactly as it is now, so change anything and the agent reviews again. Each export writes the
model and a `.asset.json` file beside it that records its measurements and where every part came
from; three.js games play its animations at the speed the character moves, so its feet stay
planted, and swing its tail and ears. The turn's build lists the model under **Assets**, and undo
brings back the model the game had before.

## Generated art

Agents can have art made by specialist providers: images (key art, concepts, character sheets,
sprites, UI art) and textures by Codex, OpenAI or Google Gemini; characters, creatures and props by
Tripo or Meshy; sound effects, music and voice by ElevenLabs. Whatever comes back goes through the
same pipeline as everything else, matched to the game's key art and style, reviewed, recorded in
`ASSETS.md` with its source, an AI flag and its cost, and undone like any other change. Files land
under `art/generated/`.

Set it up in **Settings → General → Art providers**. Codex needs no key: it uses your ChatGPT plan
through the Codex you already run in Kurambit. Every other provider takes your own API key; each row
links to where you get one and shows whether it is ready. **Provider per kind of asset** picks one
provider for a kind or leaves it on **Auto**, the first ready one. The agent never switches provider
or route to get past a refusal; it tells you what is missing.

Paid generations cost money on your provider account. Each one shows its estimate while it is being
made and its cost when it is done, and every paid call counts against the **Daily limit** (5 USD a day
across all games by default). A generation that would go over it is refused, with the numbers.

For key art and hero characters the agent asks for a few candidates. They appear as a card in the
chat: click one, then **Use this** (or use the arrow keys and Enter), and the agent carries on with
it. Keep going takes the first candidate and says so. **Cancel** stops a generation still being made.
**Generated art…** in the game's **More** menu (**⋯**) or the command palette lists everything the game
has generated, with its cost and files, and lets you pick, cancel or show a file in its folder.

Generated assets are yours on a paid plan; free plans of these providers do not allow commercial use.
ElevenLabs music also has a studio-size limit, so check its terms before you ship a game that uses it.

## Keep going

Keep going lets your agent take the next step itself, turn after turn, in the chat you turn it on
in. It works on games whose engine Kurambit plays after every turn (three.js); on other games the
control is disabled and says why.

To start, open the **Keep going** control in the composer, where a coding chat picks its mode
(`mod+Shift+A`, the composer's mode shortcut, opens it), and choose:

- **Guided:** each next step is proposed above the composer, "Step 3 · a failing fact: …", and
  starts at the time shown unless you act. **Start now** starts it, **Skip** sets it aside for this
  run, and **Edit** puts its text in the composer and holds it, so you can change it and send it as
  your own message.
- **Autopilot:** the agent takes each step at once.

Pick a budget in the same menu (1 hour unless you change it); while keep going runs, the menu shows
when it ends. Choose **Off** to stop it: a step that is running stops and still becomes a build.

Each step is an ordinary turn, posted as a message "Keep going · step 3 (…)" that says what to do
and why: notes you left for it first, then a crash or freeze, then a step that was undone, then a
missing bot for the skilled fact, then a failing fact, then the agent's own `Next:` line. The step's build is played and
measured like any turn, and its strip in the chat says what happened to it:

- **kept**: no fact Kurambit watches got worse;
- **undone**: a fact got worse (the game stopped booting, a bot now crashes, it froze, it answers
  later, or it can now be won without skill), so Kurambit put back the build the step started from.
  The strip says what got worse. **Redo** on the strip or the timeline puts the step back if you
  want it anyway, and keep going goes on from there. A step undone twice is not tried again in this
  run;
- **not undone**: it made a fact worse but was left in place, with why: a later turn had already
  changed the game, or the undo itself failed and the strip says what failed;
- **not measured**: the facts could not be compared, so the step is kept.

Your messages always go first: a message you send is an ordinary turn, never judged or undone, and
keep going waits for it to end. Stopping a step's turn with the chat's Stop pauses keep going.

Keep going stops by itself when two steps in a row are undone or change nothing, when its budget is
up, or when your agent says `Next: none`. The banner above the composer says why in one line, and
**Resume** (or choosing a mode again) carries on with the same run. After the agent says the game is
done, ask it for more and turn keep going on again. The command palette has **Keep going: Guided**,
**Keep going: Autopilot**, **Stop keep going**, and the proposal's **Start the proposed step now** and
**Skip the proposed step**. Your agent can turn keep going on or off and leave it notes itself.

**Past runs.** Games made by an earlier Kurambit may have production runs: a vision, prototypes, a
blind pick, a plan, then rounds of building, playtesting and judging. They never continue, but stay
readable: their round cards stay in the chat, their rounds are marks on the build timeline, and the
chats their roles worked in are under **Past runs** in the game's sidebar row. A run that was live
when Kurambit updated is stopped, and keep going starts from the game as it is now.

## Play and revise

A game opens on its main chat: the game owns the middle of the window, its build timeline sits under
it, and the chat is docked to its right.

- **A three.js game is always on.** The stage plays the game folder itself, and **Reload** restarts
  it now, at its title screen. Click the picture once so the keyboard reaches it, and use **Fullscreen** to give it the
  whole screen. A game made from the starter opens on its title screen: choose Play there, or press
  Enter. The game pauses and mutes while the stage is hidden and resumes when you come back.
- **A Godot game** plays its latest Web build. **Play** serves it, building one first if none
  exists, and **Rebuild** exports a fresh one; when the game's files changed after the last build,
  the stage says so and offers to rebuild. **A Unity game** plays in its own window.
- **Stop game**, in the stage's **More** menu, ends only the processes Kurambit started for this
  game and closes its preview server. A stopped game stays stopped, in every window and for your
  agent, until **Play** starts it again.
- **Export…**, in the stage's **More** menu or the command palette, lists the targets the game's
  engine makes, each with its time, folder, logs and a freshness check against the current sources.
  three.js games export Web only.
- **Export Windows** writes a 64-bit build to `builds/windows/` (Godot and Unity games). A Godot
  build is `game.exe`: the standard preset embeds the game data, so you can copy that one file to a
  Windows PC; a preset that does not embed it also writes `game.pck`, and both files must be copied
  together. A Unity build is the whole `builds/windows/` folder (`game.exe` with its `game_Data/`
  and runtime files); ship the folder. **Download package** on the same card zips a Godot release
  Kurambit already exported — `game.exe` alone, or `game.exe` and `game.pck` — without
  exporting again; a Unity folder is not packaged. If the game sources changed since that export,
  export Windows again before packaging. **Export Linux** writes a standalone build to
  `builds/linux/` (for Unity, the whole folder ships). A release replaces the previous one only once
  it is complete and checked, so a failed or interrupted export leaves the last good build in place.
  Kurambit checks the Windows executable it produced but does not run it, so try it on Windows
  before sharing it. If Godot's Windows export templates are missing, add them in the Godot editor
  under **Editor → Manage Export Templates**.
- **Download package** on the Web card zips the latest Web export (for a Godot game, the build Play
  serves) without exporting again. Kurambit keeps the latest web export and the one before it; older
  ones are removed as new ones land. Later source edits are not included; only a new export changes
  what a new package contains. Upload the extracted files to an ordinary static HTTP host and serve
  them over HTTP; opening `index.html` directly from disk (`file://`) is not a supported way to play
  a WebAssembly export.
- The chat column is resizable; drag its edge, or hide it with the panel control in the stage header
  to give the game the whole window.
- **Check and playtest on three.js.** `game_check` on a three.js game loads the page headless and
  reports console and page errors instead of script errors; `game_explore_*` play it in real time
  with real keys and clicks (see the `three` studio skill for the bridge contract).

To change the game, write a follow-up in the chat, for example "make the rocks taller and spread
the trees out". The agent edits the same Blender sources and re-exports to the same paths, so scenes
keep their references. A game's agent ends its reply with the one change it would make next; when
it does, the composer shows it as **Next:**. **Ask for it** puts that change in the composer for you
to edit or send, and dismissing it hides it until the next reply.

Stopping the agent's turn stops its Blender and Godot commands, but a game that is already running
keeps running; use **Stop game** to close it.

## Builds and undo

Every agent turn that changes the game is a build, in any of the game's chats, keep-going steps
included, and so is every round of a past production run. A build is the game folder as its turn
left it. A three.js game's stage shows the folder live, so while your agent works it can be ahead of
the latest build.

The build timeline under the game has one mark per build, oldest to newest, then **Now**, the game
folder itself; while the agent is mid-turn or someone edited the folder, Now says what it changed
since. **Older** pages back. A mark's bar takes the tone of its worst fact, an undone build is dimmed,
a keep-going step's mark carries a step sign before its number, and a round's mark reads R and its
number. The selected mark, by default the latest, shows its summary, changed files, time and up to
three facts, with:

- **Play**, which plays it from a copy on the stage, even an old one; the game folder is never
  touched. **Back to the current game** returns to the live game, and **Stop game** ends the copies
  too. Unity builds cannot be played this way yet; the build says so.
- **Undo** on the latest turn, which puts back the build the turn started from. After an undo,
  **Redo** puts the turn's change back.
- **Go back** on an older build, which puts it in the game folder: the engine project, `art/` and
  `ASSETS.md` return to that build, and notes, `PLAN.md`, `VISION.md`, bots and run records stay as
  they are. What the folder held is saved as a build first, so going back never discards work, and
  **Redo** puts it back.

Clicking a mark opens its detail: every fact, the evidence, the changed files, **Open diff**,
**Play**, **Go back** and **Compare**. **Compare** (or **Compare builds…** in the command palette)
picks two marks and shows them side by side in the game area, each playable, with their facts in a
table: ↑ and ↓ show which way a fact moved, ≠ that it changed without a direction (an ending that
became another), and = that it did not change; a change is coloured when it is better or worse. A
fact that was not measured on one side reads "not comparable" with the reason. Only the side you are
playing runs; the other is paused and muted. **Close** returns to the live game.

Under a turn's changed files in the chat, the turn's build shows the same: up to three facts,
**Play**, **Undo** or **Redo** on the latest turn, **Go back to this build** on an older one, and
**Open build**, which opens its detail on the timeline.

Undo changes the game's files, not the chat: the conversation stays as it is, so your agent still
knows what it tried, and it sees from the files that you undid it. Undo, Redo and going back wait
for the agent's turn to end. The chat's own **Edit from here**
still rewinds the conversation itself.

After each round of a past production run, the run's chat shows a round card: the round's build,
what changed, its facts against the build before it, and the minutes and tokens it took. **Revert to
the build before it** puts back the build a kept round was judged against.

**Keys.** `mod+Alt+Z` undoes the latest turn's change and `mod+Alt+Shift+Z` redoes it; `mod+Alt+[`
and `mod+Alt+]` play the previous and next build on the timeline (past the newest, back to the live
game); `mod+Alt+G` puts the keyboard in the game. The command palette has each of these, plus
**Compare builds…**, **Export…** and **Go back to a build…**. A game you clicked into owns the
keyboard, and its keys never reach Kurambit: click the chat or press Tab before using these.

**Facts** are what Kurambit measured by playing the build: whether it boots, what happens when a
player does nothing (idle) or presses keys at random (masher), what the game's own bot does
(skilled), whether it can be won without skill, how long the picture freezes and how much it moves,
and how soon the game answers the first input. Opening or playing a build that was never measured
measures it, one build at a time; a run measures its builds itself, and a three.js game measures
each turn's build in the background when the turn ends. A fact Kurambit could not
measure says **Not measured** and why, and never counts as a result: if a tool failed, **Measure
again** tries once more. Your agent sees the same builds and facts.

## Keep a video or image

Bot videos, explore screenshots and the blind players' frame sheets live with the game's logs, which
**Settings → Storage** deletes after a while (14 days by default). To keep one, ask your agent to
save it, or choose **Save** under it where Kurambit shows it. The copy goes
into the game's `saved/` folder under a dated name such as `2026-11-05 round 2 bot run.mp4`; open it
or show it in its folder from there. The **Saved** list in **Export…** shows everything saved and
deletes a copy you no longer want. `saved/` is not committed to the game repository, and saving never
replaces a file already there.

## Asset library

Agents can use a built-in library of free game art and sound: 2D sprites and tilesets, UI kits and
icons, fonts, sound effects, short music, animated 3D characters, 3D kits and textures, from
creators such as Kenney, Quaternius and ambientCG. Everything in it is CC0 (public domain), so you
can ship and sell games that use it without credit. No account or API key is needed.

Agents use it when a game needs art or sound, and you can ask for it too, for example "use library
characters and UI". The agent looks at a contact
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
- `.studio/` holds the game's bots, notes and videos, and a past production run's rounds.
- `saved/` holds the videos and images you chose to keep; it is not committed.
