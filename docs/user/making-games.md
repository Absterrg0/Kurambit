# Making games

Kurambit turns a written brief into a playable game. Your coding agent builds it as a three.js
browser game, with Blender for its art; you direct it, play the result, and ask for changes.

three.js is the one engine in this version. three.js games made on the older demo shell still
open: see [Games from earlier versions](#games-from-earlier-versions).

## Game tools

three.js games play and are measured without anything installed. Art tools are programs you
install yourself, the same
way you install your coding agents: Kurambit finds them, checks their versions, and
**Settings → Game tools** shows each one's status, where it was found, and a **Get**
button for the vendor's download page when it is missing or the wrong version. After installing
something, press **Check again**.

- **Blender** makes game art on the Blender route. Use Blender 5.3 (5.0 or later works; 4.2 to
  4.5 still run) from [blender.org/download](https://www.blender.org/download/).
- **MPFB2** is optional: it gives characters built in Blender a human body. See
  [Models](#models).
- **ffmpeg** is optional: the asset library draws its contact sheets with it. Install it with your package manager (`sudo apt install ffmpeg`
  on Debian and Ubuntu, `sudo dnf install ffmpeg` on Fedora with RPM Fusion, `brew install ffmpeg`
  on macOS, `winget install ffmpeg` on Windows), or get it from
  [ffmpeg.org/download](https://ffmpeg.org/download.html).

Kurambit looks for Blender in this order: the path you enter in **Game tools**, the
`KURAMBIT_BLENDER` environment variable, a copy an earlier Kurambit installed, then your PATH
(`blender`). The path can be Blender itself or the folder it unpacked to. A path you enter is the
only place it looks, so a wrong one shows as an error instead of being skipped.

The asset library also uses ffmpeg to draw
contact sheets of a pack's pictures, and without it lists the pack's files with no picture.
Kurambit finds it on your PATH or at `KURAMBIT_FFMPEG`.

The live Blender view's helper runs through uv; Kurambit uses yours if it is on PATH and otherwise
fetches it once by itself. The live Blender view also needs the system Xvfb package (`xorg-x11-server-Xvfb` on Fedora, `xvfb` on Debian and Ubuntu): everything
runs on a private virtual display, so nothing opens on your desktop.

Kurambit refuses to open the live Blender view when the machine is short of memory: about 1.5 GB
free, plus about 2 GB more for a rendered look. Play sessions and bot runs check too, after waiting
up to about a minute for memory to free: about 1 GB for a browser session and 1.5 GB for a bot run. Work started with less tends to be killed by the system midway, or to make the whole
machine hang on swap. The refusal says how much is needed and how much is free; close other apps or
wait a few minutes, then ask again. Starts also take turns across the machine, so a start can wait
behind another game's. If Kurambit cannot measure two keep-going steps in a row (the browser, an
engine editor or a copy of the game kept failing), keep going pauses with what failed; it never
judges or undoes a step on it, and **Resume** goes on once the cause is fixed. Kurambit never closes
your other apps to make room. If free memory falls under about 1 GB while an editor sits idle,
Kurambit closes it and reopens it on the next request; it never closes one mid-task. `KURAMBIT_BLENDER_MEMORY_MB`,
`KURAMBIT_EXPLORE_WEB_MEMORY_MB`, `KURAMBIT_BLENDER_RENDER_MEMORY_MB` (sprite renders and rendered looks) and
`KURAMBIT_BOT_MEMORY_MB` change the requirement, and 0 turns the check off. On Linux, Blender's looks
use every core; `KURAMBIT_BLENDER_THREADS` gives each game's Blender fewer when you run several games at once.

You also need a signed-in agent. Codex and Claude are enabled by default; enable others in
**Settings → Providers**.

## Making a game

Describe the game in the box on the home screen, including the look you want. To aim for a
picture (a screenshot, concept art, a photo), attach it with the picture button or paste it into
the box: the game keeps it as `art/reference.png`, and the agent works until its game looks like
it. **New game** in the
sidebar and the command palette bring you back to that box, and so does `mod+N` from anywhere but
a game's screen. The box grows with what you write. Under it are the agent and
model (your last game's, else Claude) and one options button for how characters are made. New games
are saved in `~/Games`. Kurambit names the game from your brief; rename it any time from the game's
name above the stage, or from its card's menu on the home screen. **Start building**
creates the folder and opens the game while its first build is being made, with your brief sent as
the first message, so you see exactly what the agent was told. Your game is playable on the stage within a few minutes, on models
from the asset library; when the library has no model of your hero or its main threat, the agent
then makes that one in Blender in the same turn, which can take several minutes more. Every message
after that makes it better, and what you ask for is done in that turn rather than put off.

A three.js game is live on the stage from the moment it exists: Kurambit serves the game folder and
plays it. While the first build is being made, the stage shows the game as soon as it draws
anything, and follows the agent's saves from then on: a save takes the stage once it has drawn
too, so a half-written one never shows. The bar on top says **Making build 1** until the turn ends.
A turn's changes reach the stage when the turn ends, as its build. If you are playing at that moment (you clicked into
the game), it is not reloaded under you: the stage says your agent changed the game while you were
playing, with **Reload**. A hidden stage catches up when you show it. If a save breaks the game, the
stage names the error: quietly while the turn runs, since the agent may be mid-change, and with
**Ask agent to fix** once the turn has ended.

A game is a static three.js browser game (no install step), played in real time through the same
tools, with a Web export.

The sidebar lists your chats, every one on its own row: its game's picture and name, when you
last wrote in it, and under them the chat's title. Two chats of one game are two rows. Pinned chats
come first, then the rest with the latest on top. A row ends in a spinner while an agent works, an
amber dot when the chat waits for your answer or for you to keep one of several tries, or a red
triangle when the game's build does not start. A third line appears only when there is something to
say: the chat works in a copy, or its message waits for another chat to finish in the game. Up and
down arrows move through the rows.

Right-click a row to rename the chat, pin it, settle it or delete it, and to start a **New chat**
in its game. On a game's screen the game's name above the stage is its menu: a new chat, rename,
its folder, export, **Archive** and **Delete…**; the chat's title beside it is the chat's menu.
`mod+N` on a game's screen starts a new chat in that game (`mod+shift+O` in a browser). Each card
under **Your games** on the home screen has the same game menu on its picture.

When a chat's work is done, **Settle** it: hover its row and press **Settle**, right-click it, drag
it onto **Settled**, press `mod+shift+S`, or use the chat's menu above the stage. It leaves the
list for the **Settled** shelf at the bottom of the sidebar; its builds stay in the game's History.
Settling the chat you are in moves you to the next one in the list. A notice offers **Undo** for
five seconds (`mod+Z`). **Un-settle** brings it back the same ways, and so does sending it a
message. A chat that is still working, has a message queued, or waits on your answer can't be
settled until that is done.

Chats left alone settle on their own after seven days; change that in **Settings → General →
Advanced**. One you un-settle stays in the list until you work in it again, and changing the days
does not bring settled chats back. Your agent can settle a chat as well, when you ask it to.

A game whose chats are all settled has no row in the sidebar. It is still under **Your games** on
the home screen and in the command palette, and it opens on the chat you last worked in.
**Archive** in a game's menu puts the whole game away: its chats move to the **Archived** shelf at
the bottom of the sidebar, where **Unarchive** on a row brings that chat, and with it the game,
back. **Delete…** removes a game from Kurambit and leaves its folder on disk.

To continue a game, choose one of its rows or its card under **Your games**, or use **Open a game**
(on the home screen or in the command palette) and pick a folder that contains `game.json`. A game
opens on the chat you last worked in. A **New
chat** opens the game's screen with an empty chat: the game fills the screen above the box, which
offers your agent's latest suggestion (Tab takes it), and the game settles into the column once you
send. A game keeps one empty chat, so asking again opens that one.

## Style

A game's look can be recorded in `STYLE.json` at the game's root. For what the game makes itself:
a colour for each kind of thing (bark, leaf, stone, wall, roof and so on), how things are shaped
(faceted or soft, how chunky, how detailed) and whether surfaces are flat colour, painted or
realistic. Models keep the materials they were made with (metal, glass, glow) unless you choose a
flat finish with a palette: then every model shares one small atlas of those colours, the look of
the low-poly packs. With the library on: which family of the built-in CC0 art library it uses (KayKit,
Kenney low-poly, Kenney pixel art and others) and the packs its art and sound come from. Also
pixel art or smooth, the view, the skeleton its characters share, and loudness targets for music
and effects. The art tools fill their defaults from it, and searches show its
packs first; nothing is refused for falling outside it. Edit it, or ask your agent to, to change
those defaults.

## Models

Each game has one setting for how its models are made, **Make models with**: **Agent's choice**
(the default), **Blender** or **Code**, and a separate **Library models** switch, off by default.
Pick them under the home screen box's options button, so the first turn builds your way, and change
them later in the Scene tab's **Models** row or the command palette's **Make models with…**. You can
also ask your agent in chat to switch; it never switches on its own.

- **Agent's choice**: the agent decides for each model, making characters, creatures and the
  models that matter most in Blender when it is installed, and quick or simple things in code.
- **Code**: the agent builds every model in three.js code inside the game: hulls, buildings,
  vehicles, props, terrain, and characters on the same skeleton the animation library's clips play
  on. They cost nothing to install and download tiny. The agent looks at each model alone (from
  six sides, beside a 1.8 m figure, with its size and cost) before building the game round it.
  Give it a picture to aim for and it compares its work against it, the model from the picture's
  angle and the game's frame beside the picture at the same size: the key art you picked, or any
  picture you attach, which it saves as `art/reference.png`.
- **Blender**: it makes the player, characters, creatures and the models that matter in Blender,
  and builds the ground and small things in code. A person is a body on the shared skeleton, then the head, clothes
  and props it models itself, with the library's animations already fitted; an animal is sculpted
  with its own skeleton and moves. Without Blender installed, it builds the characters in code
  and tells you.
- **Library models** on: the free CC0 asset library's models come first, and the route makes what
  it has no model of. Off, its models, textures and sprites stay out of the game; its animations and
  sounds are always available, and a Blender character may still start from one of its base
  bodies, which the agent reshapes. Games made before this setting existed keep the library on.

Blender building needs Blender installed (Settings › Game tools).

Human bodies on **Blender** come from MPFB2, an add-on Kurambit fetches for you. When a game first
needs it the agent asks you, and adds it on your yes; you can also add it yourself in **Settings →
Game tools**, under Blender, **Human bodies**, **Install**. Its code is GPL-3.0, so Kurambit does not
ship it: it is downloaded from extensions.blender.org (46 MB) into Kurambit's own Blender sessions,
never your Blender settings, and the bodies it makes are CC0. **Remove** deletes it again; a live
Blender view already open keeps it until it reopens. Without MPFB2, Blender characters use library
bodies. Add-ons are tools that make things, not finished models or textures.

The agent looks at a model made in Blender through a review: one image with a turnaround, clay,
silhouettes, the model at the size it appears in play, its walk, run and jump, and your reference
picture or the concept art beside it, with what was measured (height, triangles, texture size,
whether its feet stay planted). A character's review is kept in `art/sheets/`; open the model in
**Art** to see it. The measurements inform the agent; they never block a model that looks right.
An export only refuses a model that would be broken in the game, such as clips that move nothing.
Each export writes the
model and a `.asset.json` file beside it that records its measurements and where every part came
from; three.js games play its animations at the speed the character moves, so its feet stay
planted, and swing its tail, ears, coat hems and scarf ends. Select the character on the stage to
tune how stiff and how damped that swing is while it plays. The turn's build lists the model under **Assets**, and undo
brings back the model the game had before.

## Keep going

Keep going lets your agent take the next step itself, turn after turn, in the chat you turn it on
in. It works on games whose engine Kurambit plays after every turn (three.js); on other games the
control is disabled and says why.

To start, choose **Keep going** in the picker beside the paperclip, under the box where you tell the
game what to change (it says **Once** until you change it; `mod+Shift+A` opens it), then send. The
picker appears once Keep going has something to go on, when a build starts and your agent's reply
ends in a `Next:` line. What you write is its
direction, the first thing it does; you can also send nothing and let it take your agent's latest
`Next:` line. While it runs, a line above the box says which step it is on, with **Stop**, and what
you send goes to it as its next step. **Keep going: Guided** and **Keep going: Autopilot** in the
command palette choose it and start it at once. Its mode is in the same picker:

- **Guided:** each next step is proposed above the composer, "Step 3 · a failing check: …", and
  starts at the time shown unless you act. **Start now** starts it, **Skip** sets it aside for this
  run, and **Edit** puts its text in the composer and holds it, so you can change it and send it as
  your own message.
- **Autopilot:** the agent takes each step at once.

Pick a budget in the same picker, from 30 minutes to 8 hours or no limit (1 hour unless you change
it); while keep going runs, it shows when it ends. **Stop** above the box, or `mod+Alt+X`, stops it: a step that is running stops and
still becomes a build.

The first step starts at once, from what you wrote or your agent's latest `Next:` line, and each step starts as soon
as the one before it is checked to still start cleanly; the rest of its measuring goes on behind.

Each step is an ordinary turn, posted as a message "Keep going · step 3 (…)" that says what to do
and why: notes you left for it first, then a crash or freeze, then a step that was undone, then,
when you asked for the game to match a picture, what your agent's last check found still differs
most from it, then a failing check, then the biggest problem a separate model sees in screenshots of
the game as it is now (shown only your brief), then the agent's newest `Next:` line. Because that
review nearly always finds something, a run ends on its budget or when steps stop changing the game
rather than when your agent says it is done. A step runs in a fresh session of your agent,
so it costs what the step is worth rather than re-reading the whole chat; its message carries what
the agent needs (your brief, the chat's last reply, the current checks and the steps so far). Your
own messages keep your agent's session, and it is told what the steps did. The step's build is
played and measured like any turn. Its builds sit under one **Keep going** bracket in the builds
list, and its line in the chat says what the step did and what happened to it:

- **kept**: the game still boots and plays without errors. Every other check (controls, Retry, the
  HUD) is shown and, when it is bad, proposed as a later step, but never a reason to undo; an error
  the longer random-input play finds after a step was kept becomes the next step;
- **undone**: the step broke the game, so Kurambit put back the build the step started from. The
  chat says why ("undone: it stopped booting: …"), and the next step is told too. **Redo** in the
  chat or the build's tab puts the step back if you want it anyway, and keep going goes on from
  there. A step undone twice is not tried again in this run;
- **not undone**: it broke the game but was left in place, with why: a later turn had already
  changed the game, or the undo itself failed and the builds list says what failed;
- **not measured**: the checks could not be compared, so the step is kept.

Your messages always go first: a message you send is an ordinary turn, never judged or undone, and
keep going waits for it to end. Stopping a step's turn with the chat's Stop pauses keep going.

Keep going stops by itself when two steps in a row are undone or change nothing, when its budget is
up, or when nothing is left to propose and your agent says `Next: none`. It does not judge whether a change made the game better:
that is yours to say. The banner above the composer says why in one line, and
**Resume** (or choosing a mode again) carries on with the same run. **See what it did** there, or
**Show what keep going did** in the command palette, lists the run's steps: each with a picture of
the game before and after it, what it set out to change, and whether it was kept or undone, so a
run left going overnight reads in the morning. **Play** plays any step's build. After the agent says the game is
done, ask it for more and turn keep going on again. The command palette has **Keep going: Guided**,
**Keep going: Autopilot**, **Stop Keep going**, and the proposal's **Start the proposed step now** and
**Skip the proposed step**. Your agent can turn keep going on or off and leave it notes itself.

## Play and revise

A game opens as one column: the game on top, its control bar under it, then your chat with the
agent and the box where you tell the game what to change. A new game starts with just that, and
**Undo** on each build in the chat.

The Workbench and its **Tune**, **Art** and **Checks** are always there. Every other tool appears
when the game first has something for it, and then stays where it is: **Save as test play** once
a run ends; **Responsive view** once a phone or widescreen check finds a problem; **Keep going**
once a build starts with a `Next:` line. A new tool, or a Workbench section the first time it has
something in it, carries a dot until you open it: one dot at a time, on the newest. Their keys and
the command palette reach each one before then.

The bar's buttons stay put while you play,
pause or rewind: **Pause** (or **Play**) and **Restart**, then the speed (1×, ½×, ¼×), **Can't
lose**, sound, **Fullscreen**, and a **⋯** menu. **Can't lose** is there only for a game whose code
can lose a run; while it is on, a loss doesn't end the run and the bar says "Can't lose". While a
game has no sound files, the sound button is dimmed and reads **No sound yet**. Paused, or once a run ends, the run's timeline and
its time fill the middle. The **⋯** menu has the run (tell the agent about it, save it as a test
play), what you see (the game's controls and the dev views) and the Stage (pause when you click
away, hide the game, stop it). The controls list every action with its keys, and a click on one
changes its key; a game with the built-in follow camera lists **Look around** there: hold the right
mouse button, or a key you give it, and move the pointer. Hover a control for its key. Hidden, the game folds into the top bar
with its picture, and **Show the game** brings it back.
Drag the edge under the bar to give the chat more or less of the column. The column keeps a readable
width; for a bigger game beside the chat, set **Settings → Appearance → Chat width** to Wide or
Full.

The bar on top has the game's name, which opens its menu (rename, folder, **Export…**, **Art…**),
then the build on the Stage, such as **Build 4**, which opens **History**: **Undo** and **Redo**,
then every build as a small picture in time order with the one on the Stage ringed.
Click a picture to play that build and show its checks. On the right is the Workbench button.

If a build doesn't start, the game says so in its middle with the error, **Ask the agent to fix
it** and **Undo**. An error while you play shows as one small line in the game's corner.

The **Workbench** is a panel beside the game (`mod+Alt+B`, or **Workbench** in the command palette,
which also opens each section directly). The same key or the header's Workbench button closes it.
Drag its edge to resize it. Its three sections are always there, and one with nothing yet says
what fills it:

- **Tune**: one section for each thing the game names with values to tune, grouped by kind, with
  its values, such as its speed, jump height, timers and counts. The filter at the top finds a
  thing or a value by name. Pointing at a thing on the paused game brings its section into view, or says it has no values.
  Click a value's field to type, or drag the field or its label sideways; the game changes at once,
  and the fill inside the field shows where the value sits in its range.
  Values are saved into the game as you let go, and a tuning session is one build Undo takes back;
  **Keep as a build** ends the session, so your next change starts another. Values kept while an
  agent's turn works in the same folder wait and become their build when that turn ends, on top of
  what the turn left, so none is lost. **Put all back** returns every value to the game's own. A
  game with the built-in follow camera has a **Camera** section here without the agent adding one:
  its distance, height, mouse speed and lens. If a
  game has nothing to tune, one button asks your agent to make the things it names, or the game's
  numbers, tunable.
- **Art** (`mod+Alt+R`): every asset the game has, with search and a filter for models, textures
  and sounds. Models (the ones the game's code builds too) and textures show as pictures, with
  their triangles or size in pixels; sounds are grouped by what they are for (music, ambience,
  footsteps, interface, effects), each with a play button, its waveform and its length; fonts
  show a line set in them. A model or texture the last measured play never used is dimmed, and
  the count beside **Sounds** narrows the list to the sounds it never played. A model
  built from named parts (an island's cabin, dock and trees) is followed by its parts, each with
  its own picture. A model your agent is making in Blender is listed from its first review, as
  its sheet, marked **Being made**, and becomes the model when it is exported; a model in code
  that holds its place until then is marked **Stand-in**. Open a model to see it: it turns as you
  drag it, and under it are its parts and its size. Double-click a model's name to rename it; an
  empty name gives back the game's own. An image shows at full
  size with its alpha and a sprite sheet's frames; a sound shows its waveform. **Ask about this** adds the asset to your message with
  a picture of the view, and **Show on the Stage** points at it in the paused game. Pointing at a
  thing in the paused game opens it here while Art is showing (or says it has no model); click the
  same spot again to step out from a part to what holds it. Pointing never changes which section
  the Workbench shows.
- **Checks**: what the build changed in words, and its files as one line that opens to each file;
  click a file to open it in the diff. Then its checks: each problem with its proof under it, the
  controls that are yours to try (the game read the key but the play saw nothing change), and one
  line for the checks that pass. Open that line, or any check in it, for its proof: the frame
  rate through the play with its 1% low, and the draw calls, triangles and download size with how
  each moved since the build before; the controls as their keys with what each did; the phone
  and widescreen pictures with **Open in responsive view**; the harness's own play to watch; your
  saved test plays with **Replay**. Checks not measured are one line that opens to each one's
  reason. When the game logged errors or warnings, its **Console** follows, and the Checks button
  counts the errors. Last come the game's **Decisions**. A build's checks in
  the chat open here. Opening a diff on a narrow window closes the Workbench to give the game room;
  open it again to see both.

- **A three.js game is always on.** The stage plays the game folder itself, and **Restart** starts
  it again at its title screen. A game you are not in (it just came up, or you clicked into the
  chat or the Workbench) holds on its picture and says **Click to play**: one click plays it and
  gives it the keyboard, and so does pressing a key while the stage itself is focused. Turn off
  **Pause when I click away** in the stage's **More** menu to keep it running.
  **Fullscreen** shows only the game, edge to edge. A game opens on its own title screen when it has one. The game pauses and mutes while the stage is hidden and resumes when you come back.
- **Stop game**, in the stage's **More** menu, ends only the processes Kurambit started for this
  game and closes its preview server. A stopped game stays stopped, in every window and for your
  agent, until **Play** starts it again.
- **Export…**, in the game's name menu or the command palette, lists the targets the game's
  engine makes, each with its time, folder, logs and a freshness check against the current sources.
  A release replaces the previous one only once it is complete and checked, so a failed or
  interrupted export leaves the last good build in place.
- **Download package** on the Web card zips the latest Web export without exporting again. Kurambit keeps the latest web export and the one before it; older
  ones are removed as new ones land. Later source edits are not included; only a new export changes
  what a new package contains. Upload the extracted files to an ordinary static HTTP host and serve
  them over HTTP; opening `index.html` directly from disk (`file://`) is not a supported way to play
  a WebAssembly export.
- **Publish on kurambit.com**, below the Web card, puts the latest Web export at its own address,
  such as `moonlit-pond.kurambit.com`, where anyone with the link can play it in a browser. The
  first time, **Sign in with GitHub to publish** opens kurambit.com in your browser with a short
  code; sign in there, check the code matches the one Kurambit shows, and approve it. Kurambit
  notices on its own. **Update** sends the latest Web export again, so export first when you want new
  changes up. **Unpublish** takes the game down, and **Disconnect** forgets this Kurambit's sign-in.
  A published game can be at most 50 MB, and each GitHub account can have five published at once.
- The Workbench and the right panel, where diffs and files open, are resizable; drag an edge, or
  close one to give the game more room.
- **Point at a thing.** Press Ctrl+Alt+F (⌘⌥F on a Mac), even while you play, or the Stage's pause
  button to freeze the game, then click a character or prop: the Workbench shows it in the section it has
  open (its values in **Tune**, its inspector in **Art**), and it goes into the message box as a
  chip with the frame. A new pick replaces that chip; chips you added with **Ask about this** stay. Sending sends the frame, what the thing is and its values with your words. The
  chip's **×** or Esc stops pointing; Esc again plays on. While frozen, the selected thing's path
  shows its last jumps on the game, so you can see what a tuned value did.
- **Your agent knows how you played (three.js).** Your next message tells the agent about the
  runs you played since its last turn: how each ended, or when you left it (Retry, the menu, a
  reload), and where you stood. It can replay any of them to a moment and look at it. To talk
  about one run, choose **Tell the agent about this run** in the bar's **⋯** menu when it ends, or while
  the game is frozen: it goes into the message box as a chip with its frame.
- **The game remembers what you decided.** When you undo a build, keep tuned values, or skip a
  keep-going step, Kurambit writes a line in the game's `.studio/decisions.md`, with the first
  sentence of your next message after an undo. To add your own standing preference, send
  `/remember no music with lyrics` from the composer. Every new agent session on the game (a new
  chat, a keep-going step, the first turn after a restart) reads the newest lines, and a chat
  that goes on hears each new one once, so the agent does not bring back what you turned down.
  The Workbench's **Checks** lists them under **Decisions**; hover a line to forget it. An undo
  never rewinds this file.
- **Test plays (three.js).** **Save as test play** in the bar's **⋯** menu saves a run under a name,
  such as a win or the run where a bug showed: the run that ended, or the one you are playing, up
  to now or to where you rewound it, so a game with no ending has test plays too. Your first win is
  offered as one. Every build from then on replays it, and its checks say whether each test play
  still ends the same way, or for a run that never ended, whether it plays the same for its length. A run that does not replay
  the same on its own build is refused, with what differed: usually the game timing itself
  outside its update. Your agent can save runs the same way, and both of you can
  list and delete them.
- **Back where you were (three.js).** When your agent changes the game while you play, **Reload**
  brings the new game back to the moment you were at, frozen, replaying your run on the changed
  code: press **Play** to keep going, or **Restart**. Hovering the bar's time says where the change
  first made play differ, or that the run now ends earlier ("With the change, this run now ends at
  1:40").
  A run on a title screen, an ended run, and runs over 10 minutes start fresh instead, and so does
  one that takes over 20 seconds to get back to.
- **Rewind and fork (three.js).** Paused, or after a run ends, the bar's timeline shows the run
  with its losses and its ending marked. Drag or click it at any moment and let go: the game
  pauses and replays your run to there, frozen. Change a value in **Tune** (or let your agent change the
  code), then **Play on**: the run goes on from that second as a new run, which your agent hears
  about and you can save as a test play, and the timeline marks the second it went on from. After a
  fork with tuned values, **Replay as it was** in the bar's **⋯** menu plays the same three seconds
  of your input without the change.
- **Dev views (three.js).** The bar's **⋯** menu, under what you see, steps a frozen game one frame at a
  time, fly a free camera around the frozen frame (drag to orbit, scroll to zoom), draw the bounds
  of the game's named things, and show the frame rate in the game's corner. They and Can't lose
  are in the command palette too, with keys that work while you play (Settings → Keybindings).
- **Responsive view (three.js).** **⋯ → Responsive view** (in the menu once a phone or widescreen
  check finds a problem), its key or the palette turns the Stage into
  a device view like a browser's: pick Phone, Tablet, Laptop, Desktop, Ultrawide or Responsive, type
  a width and height, rotate, or zoom. The game keeps running at that size, so you see how it
  answers a resize; in Responsive, drag the frame's edges. Esc or the same toggle returns to the
  normal Stage. A test play saved here replays at the size it was played at.
- **Check and playtest on three.js.** `game_check` on a three.js game loads the page headless and
  reports console and page errors instead of script errors; `game_play` ops `act` and `close` play it
  with real keys and clicks, its waits and holds stepped on the game's own clock (see the `three` studio skill for the bridge contract).

To change the game, write a follow-up in the chat, for example "make the rocks taller and spread
the trees out". The agent edits the same Blender sources and re-exports to the same paths, so scenes
keep their references. A game's agent ends its reply with the one change it would make next; when
it does, the empty composer shows it as **Next:**, and only there: the chat leaves that line out of
the reply. Press Tab to put that change in the composer, then edit or send it.

Under the box, the composer's footer holds how your message runs (**Once** or **Keep going**) and, on the right, the model, how hard it thinks, and how much of its context the
chat uses, such as **121k**. That number turns amber near the limit; click it to compact the chat.

Stopping the agent's turn stops its Blender commands, but a game that is already running
keeps running; use **Stop game** to close it.

## Builds and undo

Every agent turn that changes the game is a build, in any of the game's chats, keep-going steps
included. A build is the game folder as its turn left it. A three.js game's stage shows the folder live, so while your agent works it can be ahead of
the latest build.

The build beside the play controls opens the builds list: one picture per build, oldest to newest,
with a frame from the build's own play, what you asked for, its number and time, and what changed in
its checks. The build on the stage is outlined, an undone build is dimmed and struck, a keep-going
step carries a step sign, and the build being made waits as a dashed card with its time. **Now**
appears when the game folder is not any build (edited since, or another build plays from a copy);
until the Stage has shown the game, its picture is the last build's, dimmed.
**Older** pages back. Clicking a picture plays that build (an older one from a copy; the game folder
is never touched, and **Back to the current game** or the newest picture returns) and shows it in the right panel's **Build** tab, which lists how many checks pass and how many to look at, the few that matter most as plain lines, each something a player would hit (does it start, does it play without errors, does every control work, does Retry start a clean run, does the HUD fit the screen, does it hold its frame rate (with the draw calls and triangles that cost it), does it fit a phone held upright and a widescreen monitor (and how much it downloads to start)) with every other measurement, each in a plain sentence, under **Other measurements**: among them the **First minute**, the game as a player opens it (how long it takes to show, whether a title covers the game, how many presses and seconds to play, the longest text before play, the smallest text on a 1080p screen and a Steam Deck, whether doing nothing loses, how fast Retry gets back to play, whether the first press makes a sound and how loud the mix peaks, and whether Esc pauses), each reading saying why when it could not be measured, what changed in your agent's words (with the files it changed,
which open the diff), its videos, and in the **⋯** beside the build's name:

- **Undo this build** on any build, which takes that build's change out of the game and keeps every
  build after it. The undo is a build of its own; undoing it is **Redo**. When a later build
  changed the same lines, nothing moves and Kurambit says which files: go back to the build before
  it instead, or ask your agent to take the change out.
- **Go back** on an older build, which puts it in the game folder: the engine project, `art/`
  and `ASSETS.md` return to that build, and notes and saved media
  stay as they are. What the folder held is saved as a build first, so going back never discards work, and
  **Redo** puts it back.

When the game folder has changed since its last build, the tab shows **Now on the Stage** first and
the checks under **Last measured build**, since they belong to that build, not to what plays now.

A turn that changed the game ends in the chat with one line for its build: its name, which plays it;
its checks, which open its **Build** tab; the files it changed, which open the diff; and **Undo** or
**Redo** on the latest turn.

Undo changes the game's files, not the chat: the conversation stays as it is, so your agent still
knows what it tried, and it sees from the files that you undid it. Undo, Redo and going back wait
for another chat's turn in the game to end. The chat's own **Edit from here**
still rewinds the conversation itself.

**Keys.** `mod+Alt+Z` undoes the latest turn's change and `mod+Alt+Shift+Z` redoes it; `mod+Alt+[`
and `mod+Alt+]` play the previous and next build (past the newest, back to the live
game); `mod+Alt+G` puts the keyboard in the game, and pressed while you play, gives it back to the
chat. The command palette has each of these, plus **Export…** and **Go back to
a build…**. A game you clicked into owns every key, Tab, Escape and the number keys included; only
these `mod+Alt` keys reach Kurambit while you play.

**Checks** are what Kurambit measured by playing the build, only what you would act on: whether it
boots, whether it crashes or stops answering in a minute of random input, and for a three.js game a
QA pass (it presses every control the game declares on a fresh run, ends a run and presses Retry,
and reads the HUD at a wide and a narrow window, so a key the game reads nowhere the pass goes, in
play, on its title or at its ending, a Retry that keeps the last run's leftovers or text off the
screen shows up as a failing check; a key read only on a screen the pass never reaches, such as a
shop or an upgrade pick, shows up too, so try it yourself before changing it) and how smoothly
the game ran: frames per second, the slowest 1% of frames, the GPU's time per frame and the share
of the resolution it drew at. On a machine where Kurambit's browser cannot use the GPU, performance
says so instead of guessing.

To prove the game can be won, save a winning run as a test play (see **Test plays** below): every
build after it replays it and says whether it still ends the same.
Opening or playing a build that was never measured measures it, and a three.js game measures its
newest build in the background when a turn ends; a newer build stops the measure of an older one,
which opening that build measures again. A check Kurambit could not measure says **Not measured**
and why, and never counts as a result: if a tool failed, **Measure again** tries once more. Your
agent sees the same builds and checks.

## Working in several chats at once

A game can have many chats, and the game folder takes one chat's turn at a time. When you send a
message while another chat works in the game, it waits above the composer ("Waits for _Rain_ to
finish in the game") and starts by itself when that turn ends. **Run in a copy** beside it (its key
is in the tooltip) starts it now instead, in a copy of the game's newest build. Once your game has
had a copy, the game's menu, a row's menu and the command palette also offer **New chat in a
copy**.

A chat in a copy stays there: its later turns work in the copy, its Stage plays the copy, and
nothing it does reaches the game until you **Bring in** (above the Stage, or the copy's menu at the
left of the composer). Bring in merges the copy's work with everything the game gained meanwhile,
checks that the result still boots and plays your test plays the same (**Bring in now** skips the
wait), and lands it as one build that Undo takes out again; the chat then works in the game. When
the game and the copy changed the same lines, nothing lands: a card above the composer lists the
files, **Ask the agent to resolve** sends it a message, and for art, sound and models you keep the
game's file or the copy's. A result that would stop booting or end a test play differently waits
for **Bring in anyway**. **Update** brings the game's newer builds into the copy; **Throw away**
removes the copy and keeps its builds in History. History lists every copy under **Not in the game
yet**, and Undo on any build there takes out just that build's change, keeping later ones. Keep
going runs only in the game.

Your agent can do the same: it brings in its own copy or one it delegated work to, and updates
its copy; the chat shows each as a line with its result. A chat's decisions are the game's,
wherever the chat works.

## Keep a video or image

Bot videos and play screenshots live with the game's logs, which
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
`assets/library/<pack>/`, and lists each file, its pack
and source page in `ASSETS.md`. It never replaces a file already in the game.

Each pack downloads once, the first time an agent looks inside it, into
`~/.local/share/kurambit/asset-library`, which every game on the machine shares. Each download is
checked against the copy Kurambit was released with; if a source site has changed the file, that pack
is refused rather than used.

## Games from earlier versions

A three.js game made on the older demo shell, whose title, pause, settings and end screens came
from Kurambit rather than from the game, still opens with its chats, builds and history: its stage
says it was made with an older Kurambit and is not supported in this version, and Kurambit no
longer plays it or keeps going on it.

## What is in a game folder

Each game is a self-contained git repository you can move, back up, or open on another machine:

- `game.json` and `BRIEF.md` describe the game.
- `web/` is the game: a static three.js project with `index.html`, `main.js` and `assets/`.
  three.js and Kurambit's bridge come from Kurambit's runtime, the version `game.json` names under
  `runtime`: Kurambit brings fixes to them without changing the game, and every Web export carries
  its own copy, so a release plays from any web server. A game starts as an empty page: the agent
  makes the whole game, its title, menus, HUD, light and look included, for your brief, while the
  bridge gives the Stage, Tune, Controls, the checks and replays what they need. `web/credits.txt`
  lists the credits its library assets' licences ask for.
- `art/blender/` holds the editable `.blend` files.
- `builds/` holds exports and operation logs and is not committed.
- `.studio/` holds the game's bots, their run log, kept play saves, saved test plays and
  `decisions.md`, what you decided about the game.
- `saved/` holds the videos and images you chose to keep; it is not committed.
