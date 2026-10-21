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

## Design the game first

New games start with a design, not code. The agent writes a one-page `DESIGN.md` from your brief and
the starter template: the pitch, core loop, controls, win and lose conditions, content, art
direction, audio, scope and milestones. It also writes an **Acceptance** section: a fenced
`acceptance` block of 5 to 12 concrete criteria covering each control, the core mechanic, content
counts, and how the game is won and lost. Every control, mechanic, content, win and lose criterion
names a game value the player changes; a value that is already true when play starts does not count,
and content counts have to be collected rather than merely exist. Presentation claims (a glow, an
ambience) carry no observation and are listed as not yet verified. It ends that turn asking you to
review the draft. **Plan the design first** in the New game dialog is on by default; turn it off to
skip straight to building.

The design lives on the **Design** tab, first in the stage while it is a draft. Read it and its
acceptance checklist, then ask for changes in chat, or open **Edit file** to change `DESIGN.md`
yourself. When it looks right, choose **Approve & build**. Approval binds that exact revision:
Game Studio stores its hash and acceptance outside the game, so editing `game.json` cannot grant
approval, and a document that is still the scaffold, missing a section or missing the acceptance
block cannot be approved. The agent then builds milestone 1 and continues through the milestones.

If `DESIGN.md` changes after approval, the Design tab says **Design changed since approval** and the
game is unqualified until you review the new scope and choose **Re-approve design**. Re-approval
updates the contract without starting another build turn; the agent is told to put scope changes in
`DESIGN.md` and ask for that review instead of quietly dropping a criterion.

Each game card and sidebar row says what the game actually is: **Design draft** before approval,
**Building** while an agent operation runs, **Design changed** when an edit needs review, and
**Qualified as of …** once the server's record shows the check, test, web export, playtest, state
scenarios and independent visual review passed. State scenarios prove the acceptance after play
starts, including a route that wins and, when the design has one, a route that loses the run. The
visual review grades the playtest's frames on readability, value separation, camera and framing,
style consistency, feedback and design compliance, and its presentation claims follow that verdict.
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

- **Play** builds the web version when it is missing or older than the game's files, then plays it
  in the stage. It is the real game, not a recording; click the picture once so the keyboard reaches
  it, and use **Fullscreen** to give it the whole screen. The line beside the game name says what the
  stage is doing — playing, building, or waiting for a rebuild. Opening **Design**, **Assets** or
  **Builds** keeps the game running; it pauses and mutes while hidden and resumes when you come
  back. Only **Stop**, a rebuild that lands a new build, or pressing Play again starts a new session.
- **Rebuild** always exports a fresh web build. When the game's files changed after the last build,
  the stage says so and offers to rebuild.
- **Run native** starts the game in its own window. **Stop** ends only the processes Game Studio
  started for this game, and closes its preview server.
- **Export Linux** writes a standalone build to `builds/linux/`. The **Builds** tab lists both
  targets with their times, folders and logs, the last playtest's verdict and frames, and the
  independent visual review with its scores and repair requests. A failed review comes with at most
  three concrete fixes; the agent gets one repair round, then it must report the remaining problems
  instead of restyling on its own judgement.
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
