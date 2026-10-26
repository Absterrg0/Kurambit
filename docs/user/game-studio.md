# Making games

Game Studio turns a written brief into a playable Godot game. Your coding agent does the work with
Blender and Godot; you direct it, play the result, and ask for changes.

## Set up the tools once

Open **Settings → General → Game tools**, or the setup card in any game, and choose
**Install tools**. Game Studio downloads Blender 4.5.14 LTS and Godot 4.7.2 with the matching export
templates, checks their published checksums, and keeps them in `~/.local/share/game-studio/tools`.
**Verify** runs a real Blender export and a real Godot import, so a green status means the tools
work, not just that files exist.

To use your own installs, enter their paths in **Game tools**. Godot must be 4.7.x so its export
templates match; Blender 4.2 or newer works.

You also need a signed-in agent. Codex and Claude are enabled by default; enable others in
**Settings → Providers**.

## Start a game

Choose **New game** on the home screen or in the sidebar. First pick a starter template — each card
shows a real frame from a working Godot project the agent extends instead of starting from nothing.
Then name the game, write a brief and optional art direction, and choose where to save it
(`~/Games/<slug>` by default). Pick the agent and model, then choose **Create game**. Game Studio
creates the project folder with the template in place, starts a session with your brief, and opens
the game workspace.

The agent models assets in Blender, brings them into Godot, writes the scenes and GDScript, runs a
headless gameplay test, and checks the web build in a headless browser before it reports back.
When an optional pinned art kit fits the game's art direction, ask the agent to use it: it can
search the shipped CC0 kits and import one into `godot/assets/art/kits/`. A kit adds only its own
image, license and provenance files; it never changes the game's scripts, scenes or mechanics, and
the agent chooses whether any kit fits.

## Design the game first

New games start with a design, not code. The agent writes a one-page `DESIGN.md` from your brief and
the starter template: the pitch, core loop, controls, how runs end (or why the game is endless),
content, art direction, audio, scope and milestones. It also writes an **Acceptance** section: a
fenced `acceptance` block of 5 to 12 concrete criteria covering each control, the core mechanic,
content counts, and the endings the game promises. Every control, mechanic, content, win or lose
criterion the design promises names a game value the player changes, except a declared no-lose
state; a value that is already true when play starts does not count, and content counts have to be
collected rather than merely exist. A game does not invent a win or loss it does not have. A game
with no losing state writes a `lose` criterion with `"noLoseState": true` and no observation.
Presentation claims (a glow, an ambience) carry no observation
and are listed as not yet verified. **Plan the design first** in the New game dialog is on by
default; turn it off to skip straight to building.

By default nothing waits for you: the agent writes `DESIGN.md` and builds in the same turn, and Game
Studio records each new version of the design as a revision. Editing prose keeps the same
acceptance; changing the acceptance block makes the new criteria the ones the game is checked
against. Leftover scaffold hint lines show as non-blocking warnings on the **Design** tab. Ask for
design changes in chat.

To review the design yourself, turn on **Approve the design before building** in the New game
dialog. The agent then ends its first turn at the draft. Read it and its acceptance checklist on the
**Design** tab, ask for changes in chat or open **Edit file** to change `DESIGN.md` yourself, and
choose **Approve & build** when it looks right. Approval binds that exact revision:
Game Studio stores its hash and acceptance outside the game, so editing `game.json` cannot grant
approval, and a document that is still the scaffold, missing a section or missing the acceptance
block cannot be approved. The agent then builds it.

For a reviewed design, if `DESIGN.md` changes after approval, the Design tab says **Design changed since approval** and the
game is unqualified until you review the new scope and choose **Re-approve design**. Re-approval
updates the contract without starting another build turn; the agent is told to put scope changes in
`DESIGN.md` and ask for that review instead of quietly dropping a criterion.

Each game card and sidebar row says what the game actually is: **Design draft** before approval,
**Building** while an agent operation runs, **Design changed** when an edit needs review, and
**Checked as of …** once the server's record shows that mechanical checks passed.
State scenarios check the agreed behaviour after play starts, including routes that win or lose
when the design calls for them. Review compares visible changes separately and does not certify
every presentation claim.
The time matters: it is when the record was written, and the Stage re-checks the current files when
you open the game. A card's cover is a frame of real play from the latest run that qualified, not
its menu or a failed attempt.

To continue an existing game, choose its card under **Your games**, or use **Open game** and pick a
folder that contains `game.json`. Opening a game resumes its latest session instead of starting an
empty one. The sidebar keeps one row per game; use its sessions button to reach older sessions or
start a new one.

## Play and revise

A game opens on its latest session: the game owns the middle of the window and the chat is docked to
its right.

- **Play** serves the selected build, even when the game's files have changed. If no build exists,
  it builds the web version and plays it
  in the stage. It is the real game, not a recording; click the picture once so the keyboard reaches
  it, and use **Fullscreen** to give it the whole screen. The line beside the game name says what the
  stage is doing — playing, building, or waiting for a rebuild. Opening **Design**, **Assets** or
  **Builds** keeps the game running; it pauses and mutes while hidden and resumes when you come
  back. Only **Stop**, a rebuild that lands a new build, or pressing Play again starts a new session.
- **Rebuild** always exports a fresh web build. When the game's files changed after the last build,
  the stage says so and offers to rebuild.
- **Run native** starts the game in its own window. **Stop** ends only the processes Game Studio
  started for this game, and closes its preview server.
- **Export Windows** writes a 64-bit build to `builds/windows/game.exe`. The standard preset embeds
  the game data, so you can copy that one file to a Windows PC. A game whose Windows preset does not
  embed it also gets `builds/windows/game.pck`, and both files must be copied together; the export
  result says which files to share. **Download package** on the same card zips the checked release
  files Game Studio already exported — `game.exe` alone, or `game.exe` and `game.pck` — without
  exporting again. If the game sources changed since that export, export Windows again before
  packaging. **Export Linux** writes a standalone build to `builds/linux/`.
  Both export the game's current files and leave the Web build Play serves alone; Game Studio checks
  the Windows executable it produced but does not run it, so try it on Windows before sharing it. If
  the Windows export templates are missing, **Install tools** in Settings adds them. The **Builds**
  tab lists every target with its time, folder and logs, the last playtest's verdict and frames,
  and the review history with decisions, reasons, defects and frame links. Stop review and Restore
  previous version are explained below.
- **Download package** on the Web card zips the exact selected build Play serves, at
  `builds/web-packages/<build-id>.zip`, without exporting or rebuilding. Later source edits are not
  included; only a new selected build changes what a new package contains. Upload the extracted
  files to an ordinary static HTTP host and serve them over HTTP, with `.wasm` served as
  `application/wasm`. Opening `index.html` directly from disk (`file://`) is not a supported way to
  play a WebAssembly export. If the build declares response headers, the package notes say so;
  configure them on the host.
- **Assets** shows each Blender asset's preview, its `.blend` source, its exported `.glb`, and the
  scenes or scripts that use it.
- The chat column is resizable; drag its edge, or hide it with the panel control in the stage header
  or `Ctrl+Alt+C` (`Cmd+Alt+C` on macOS) to give the game the whole window. It starts narrow and
  never takes more than about half the window, so the game stays the main surface.

To change the game, write a follow-up in the session, for example "make the rocks taller and spread the
artifacts out". The agent edits the same Blender sources and re-exports to the same paths, so scenes
keep their references.

Each turn ends with a one-line summary of what changed in the game, such as "Changed 2 scenes ·
3 scripts · 1 model". Select it to see the files and open the full diff.

Stopping the agent's turn stops its Blender and Godot commands, but a game that is already running
keeps running; use **Stop** in the stage to close it.

## What is in a game folder

Each game is a self-contained git repository you can move, back up, or open on another machine:

- `game.json` and `BRIEF.md` describe the game.
- `TEMPLATE.md` describes the starter template it was built from and what to extend.
- `art/blender/` holds the editable `.blend` files and `art/scripts/` the scripts behind them.
- `godot/` is a normal Godot 4.7 project you can open in the Godot editor.
- `builds/` holds exports and operation logs and is not committed.

## Review and restore

After your agent submits a verified build (or ends a turn with a playable export), Game Studio
reviews its frames and can attempt up to three repairs within forty-five minutes. The first
verified submit is playable at once, and the agent keeps producing: each accepted submit replaces
what Play shows, and review starts on the last one when the turn ends. The production phase is 45
minutes by default; `productionMinutes` in `game.json` sets it, and the server never cuts a turn
short. Play keeps the selected build while review runs. Open Builds to read defects, suggested
fixes, decisions and the frames behind them.
Review compares versions; it does not promise that every aspect of the game is correct.

Choose Stop review to end it. If a repair started but its result could not be kept, or your edits
prevent a safe return, Restore previous version returns the game folder to its saved version and
preserves the version it replaces. A restart does not resume unfinished reviews. If a review session
is still stopping, wait until the held state clears before restoring. Choose Check to compare the
current sources with the selected build when source freshness is unknown.
