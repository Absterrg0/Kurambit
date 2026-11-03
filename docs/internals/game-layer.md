# Game layer

> For maintainers. The code lives in `apps/server/src/game/`, `apps/server/src/mcp/toolkits/game/`,
> `packages/contracts/src/game.ts`, `apps/web/src/components/game/`.

One brief produces a game through a harness-run loop, and the harness — not the model — owns every
check that matters: it plays every build with a separate session, compares builds blind so a worse
one never lands, and keeps working until a ship review says yes, it stalls, or the creator stops it.

## Services

- `GameService` owns the native boundary: import, check, export (Web, Linux, Windows), web
  preview, exploration sessions, bot runs. Operations are exclusive per game and reported as events.
- `GameProjectService` owns game records: create (blank scaffold), open, list, resolve, inventory.
- `GameRun` owns the production loop. Every role is a fresh ordinary Kurambit thread on the game's
  project with a `role` lineage under the creator's chat. `role` only groups: sidebars, game opens
  and session lists skip it, and it has none of the subagent run takeover, controls or completion
  delivery, which would tie a role to the creator's live turn. State is `.studio/run.json` +
  `.studio/rounds.jsonl` plus git, so a crash resumes from the folder. Code never interprets model prose apart from declared STATUS/SHIP/COMPARE/ART lines.
- `GameBot` plays a model-written bot file in real time on a private display and records video plus
  detector findings. `GameBlender` keeps a live Blender with its pinned MCP addon per game on a
  private display. `GameUnity` does the same for Unity: one batchmode editor on a private display
  (one per server, since an editor costs 2-3 GB), reached through the official `unity` CLI and its
  `unity mcp` server, with the same session.json pid records, reaping and idle shutdown
  (`liveProcess.ts` holds the shared display, record and reap code). A record's pids are signalled
  only while their argv names the executables the live toolchain would launch now, never paths
  from the record, and of the editor's process tree only processes running from the pinned editor
  directory, CLI or Xvfb; a Unity Licensing Client is never signalled. Unity also keeps a copy of
  its record under the server state dir, reaped at startup, so a crashed server's editor dies
  even if its game is never reopened. Every call or operation holds the editor; another game's
  open closes it only while it is idle, and fails `busy` naming the holder otherwise.
  `GameToolchain` manages Blender/Godot/Unity installs; `GamePreview` serves builds;
  `GameProcesses` tracks child processes; `GameOperations` keeps the last operation per game.
- `GameAssetLibrary` serves the curated CC0 library in `assetLibraryCatalog.ts`. Each pack is a
  download URL pinned by SHA-256 and size, fetched on first look into `asset-library/` beside the
  pinned tools, and unpacked with path, link and size limits. Bytes that differ from the pin are
  refused, never re-pinned at runtime: a source can change contents or licence silently, and a
  refusal is the only honest answer. A pin changes only in a reviewed commit that rechecks the
  licence. Kenney packs come from Kenney's own OpenGameArt uploads, because kenney.nl hands out
  short-lived signed links behind a session cookie, which cannot be pinned. Every server on the
  machine (the installed app and any dev server) shares that cache, so fetches lock per pack only
  within one process, scratch names carry the fetching server's pid (a start-up sweep spares live
  ones), and placing a pack accepts a complete copy another server placed first.
- `GameEngine`/`GameGodotEngine`/`GameThreeEngine` is the engine adapter seam: import, check,
  export release. Godot owns the native process boundary (headless editor import, check script,
  export presets; Web, Linux and Windows releases). three.js owns a headless-Chromium boundary
  instead: the static folder is the game, so import is a no-op success, check loads the page
  and reports console/page errors, export copies the folder. Windows and Linux exports are
  refused plainly for three.js (`backend.exportTargets`); the interface carries `displayName`
  so core messages name the engine without naming it in core code. Unity refuses a second editor
  on an open project, so every Unity operation goes through the game's live editor in
  `GameUnity`: import refreshes and recompiles there, check recompiles and then plays the main
  scene for 120 frames and reads the console, export builds a player folder that replaces
  `builds/linux` or `builds/windows` only after its files and the source identity check out.
  Unity editors run with the real HOME so they reach the user's Licensing Client; Kurambit only
  reads the entitlement file to say whether a licence is active and never stores credentials.
  Every `unity` CLI call (status, command, recompile, mcp) runs under the CLI's own HOME in the
  tools directory, because the CLI logs each invocation with its full arguments to
  `~/.config/unityhub/logs/cli-log.json`; it reaches the live editor through the project's
  `Library/Pipeline` port file, so nothing Kurambit runs writes the user's Unity Hub data.
  Blind samples play in T3 worktrees at a sha, each a separate Unity project with no `Library/`.
  Before an editor opens on one, `GameUnity` gives it a copy-on-write copy
  (`cp -a --reflink=auto`) of its main checkout's `Library/`, found through git's common dir and
  taken after the main checkout's idle editor closed, so only what differs at that commit is
  reimported (about a minute warm, against two cold). The compiled-script
  state (`Bee/`, `ScriptAssemblies/`, the player data caches) is left out: it is keyed by the main
  checkout's path, a player built from it lost the scene's MonoBehaviours, and the worktree
  recompiles its scripts anyway. The editor is
  needed there only to build the Linux player; the role runner closes it before removing the
  worktree, which removes the copy too. Other checkouts whose `.git` is a file (submodules) are
  refused. The loop drops bot duty and bot facts for the Unity lane.
- Web play shares the services: `gameExploreWeb` opens real-time headless-Chromium sessions on
  the served static folder (real keyboard/mouse, one screenshot per act, console errors, the
  read-only `window.__studio` probe; no pause between acts). `gameChromium` resolves the
  executable (`KURAMBIT_CHROME` override, then host lookup) and holds the `__studio`
  snippets; `gameWebServer` serves a game-relative directory over loopback for check/explore/bot
  without touching Preview state. `GameBot` plays three.js games in the same Chromium lane:
  identical bot-child protocol and trace shape, stills stitched to video with ffmpeg, the
  overlap/long-fall detectors not applicable, id-clicks counted and skipped (no control tree),
  explicit state writes through the game's own `setState`.
- Unity play is a real Linux player of the current sources, built once per source identity
  under `builds/logs/unity-play-*`, run under xvfb-run. The template's `StudioProbe.cs` speaks
  the Godot native runner's TCP protocol, so acts, pictures, probe reads and close share that
  path; input is queued on virtual Input System devices, which is why the lane asks games to read
  input through the Input System.
- `GameService` routes by manifest engine with an explicit target override: `game_explore_start`
  defaults to the game's lane, Godot web and native-on-three are refused plainly. The same
  content-addressed export machinery (hash, compare, move into place, select) serves both lanes;
  the expected-files check is engine-aware.

## Tools

Agents reach the services through the `game_*` MCP toolkit; the client reaches the same services
over RPC. Threads the GameRun loop launches get play-level tools only (status, check, import,
export, explore start/act/close, bot run/view, blender, unity and asset library tools); every
other MCP tool (threads, worktrees, projects, previews) hides from them unless it declares
`EnabledWhen` itself, since a blind role that could list threads could map builds to reports. The `game_unity_*` tools
are a curated front for `unity mcp`: a fixed allowlist of editing tools behind one
`game_unity_edit`, plus eval, recompile, play, screenshot and console; builds, tests, packages and
editor lifecycle stay with Kurambit's own operations. The live editor runs with one asset import
worker and `-job-worker-count 2` (the worker count is a per-user setting in
`UserSettings/EditorUserSettings.asset`, rewritten before every start), because Unity's default
three import workers cost about 0.7 GB each. Packaging, preview, stop and the
run's own status, round and steer tools stay outside their catalog.

`game_blender_render_sprites` exists because weak models cannot write sprite framing: their
renders cropped heads, drifted across a walk cycle and came out near-black. It fits one fixed
orthographic camera per view to the subject's evaluated geometry across every frame, renders in a
throwaway scene that links the live objects (the live scene and its .blend never change), and
batches renders because the pinned server gives each Blender command 180 s. The pixel-art pass
(downscale, hard alpha, one palette for the whole strip, outline) runs in the server in
`spriteRender.ts`, so the same renders always give the same bytes.

The creator's session and a live run share the game folder, and the run's git resets would undo the
session's edits. The game's AGENTS.md tells the creator's agent to pass requests to the run with
`game_run_steer` while one is live; the composer is never rerouted. Notes land in
`.studio/steer.jsonl`, the driver folds them into `run.json` before each plan and each result, and
the policy leads the next round's direction with them.

## Loop

Vision, two core-loop prototypes, a blind pick, plan, art, one full build, then rounds until a ship
review says yes, the run stalls, the creator stops it, or an optional budget ends: builder block, boot check, tester play with a bot run,
blind compare in both orders, keep or revert, reviewer notes for the next round. Before the
comparators run, the tester's last play bot plays both builds in fresh worktrees for the same real
time; its ending and final probe values sit beside each anonymous report as facts. The tester wrote
that bot against the candidate, and a bot that fails on only one build would name it, so the
comparators get bot facts only when the bot ran on both builds; otherwise neither report has them,
and run.log and the comparison record say why. A failing bot never drops the round. A comparison's two plays,
and its two bot runs, run at once (Unity's one at a time, behind its one editor); that holds only
because explore sessions, bot runs and game operations are keyed by checkout root, not by game. Comparators
never work in the game folder, where run.json and run.log map every sample to its sha: each gets a
worktree of its own at one parentless empty-tree commit, holding only its two frame sheets under
neutral names, and writes `.compare/verdict.md`; the root keeps the write-ups once all verdicts are
in. That worktree still links to the game's repository, so its history and the root stay reachable
by path; what is blind by construction is the comparator's folder, HEAD and prompt. The only hard
checks are boots, exports and keep-or-revert verdicts. A fresh art director judges the art stage's
renders against the vision and may ask for one bounded redo (`ART: REDO`) before the art is
committed; a missing verdict keeps the art.

## Why this shape

A model left alone grades its own work, stops when it feels done, and says it tested things. The
harness makes these true regardless of what the model says: a separate tester plays every build,
fresh sessions review it, blind compare reverts the loser, and the clock enforces bold moves in
every round. Craft advice lives in the skill pack under `apps/server/templates/studio/` (plus `three.md`
for the browser lane, `unity.md` for Unity) and the bot
kit under `apps/server/templates/bot-kit/`; both are copied into each game, not the product. `GameCreateInput.engine`
(`godot` default, `three` for the browser lane, `unity`) picks the starter template (`blank` /
`blank-three` / `blank-unity`) and the scaffold (`godot/` Godot 4.7 project / `web/` static three.js
project with vendored three.js r0.180.0, MIT / `unity/` Unity 6000.6.7f1 project); `copyTemplateIntoGame` copies whichever engine tree the template ships.
The Godot starter's main scene is a genre-free demo shell (title, pause, settings, end, credits)
and it ships the `Juice` feel kit, because weak builder models skip or break both when they write
them from scratch; the manifest's gameplay scene (`scenes/game.tscn`) is the seam the shell
instances, so the check boots both. The shell pauses with `SceneTree.paused`, which is why the
native explore runner resumes the game's own pause after each act instead of forcing it off.
The three.js starter carries the same shell in `web/shell/`: it owns the render loop and calls
the gameplay module `web/main.js` through `start`/`update`/`stop`. Its page opens on the title,
so the template's `gameplayScene` is `index.html?play` (boots straight into a run) and the
three.js check loads that entry after the plain page, like the Godot check runs `game.tscn`. The manifest's
`godotProject` names the engine project directory for every lane (`web` for three.js, `unity`), so snapshots,
exports and the loop resolve it unchanged. `GameRun` reads the manifest once per loop (`laneOf`) for
the engine directory and prompt paths; everything else in the loop is engine-neutral.

Two constraints hold everywhere:

- Nothing opens on the user's desktop. Every game process drops `DISPLAY`, `WAYLAND_DISPLAY` and
  `XAUTHORITY`; pictures come from a private virtual display.
- No test suites for the game layer beyond data-safety checks; games are played, not asserted.
