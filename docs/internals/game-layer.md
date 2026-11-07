# Game layer

> For maintainers. The code lives in `apps/server/src/game/`, `apps/server/src/mcp/toolkits/game/`,
> `packages/contracts/src/game.ts`, `apps/web/src/components/game/`.

A new game is a chat: its first message is the brief, and every turn that changes the game is a
build (the turn's T3 checkpoint). On engines whose profile has `turnLoop`, the harness plays that
build on the Stage and measures its facts in the background. Undo restores the build it was made
from (`base`). The production run is an older, separate loop. It stays until phase 3, keep going, replaces it
with a run on top of the same turns (phase 2 is the one-screen app). The harness, not the model, owns every check that
matters.

## Decisions that span the services

- Game operations are exclusive per game (`GameOperations.exclusive`) and reported as events, so
  the Game panel and the agent tools see the same operation, and a second operation on a game
  refuses as busy rather than racing the first. While a production run holds the game (live,
  finishing or restoring), it is the folder's one writer: other owners' writing operations are
  refused `busy` with `runReason: "run-live"` (`GameProjectService.admitWrite`), reads and Play of
  an exported build stay open, and the run's role threads pass only for their own agent: admission
  trusts `GameCaller` (the MCP game tools mark an agent and whether it is a run role; a client call
  is the client), never the thread being viewed, so a person looking at a role's chat or a blind
  sample's copy cannot write as that role. The run's own folder moves
  (captures, restores, kept names) run as operations owned by the run, taking the operation lock
  and then the checkpoint workspace lock; T3's turn captures take only the latter, so the two
  never wait in a cycle.
- Every role of a production run is a fresh ordinary Kurambit thread on the game's project with a
  `role` lineage under the creator's chat. `role` only groups: sidebars, game opens and session
  lists skip it, and it has none of the subagent run takeover, controls or completion delivery,
  which would tie a role to the creator's live turn. Code never interprets model prose: a role
  hands its result through `game_run_submit`, typed by the kind its step asks for.
- The live editors (Blender with its pinned MCP addon per game; one batchmode Unity editor per
  server, since one costs 2-3 GB, reached through the official `unity` CLI and its `unity mcp`
  server) run on private displays with session.json launch records, reaping and idle shutdown
  (`liveProcess.ts`, `liveEditor.ts`). A session something showed unusable (its MCP child exited,
  a call timed out on a frozen main thread) closes when its last holder lets go, and the next call
  opens a fresh one; a session whose source on disk changed since it last opened or saved it
  (Blender's live.blend, Unity's open scene) reopens instead of saving over it. A start cut short
  stops what it launched. A record is acted on only while its process still verifies as the launch
  (below) and its command line names the executables the live toolchain would launch now, never
  paths from the record; of the editor's process tree only processes running from a detected
  editor's directory, the CLI or Xvfb are signalled, and a Unity Licensing Client never is.
  Both editors keep a copy of their record under the server state dir, reaped at startup, so a
  crashed server's editor dies even if its game is never reopened. Blender runs under its own
  user-folder override (`BLENDER_USER_RESOURCES`) and installs the addon where Blender itself
  says its user addons live, so no version or OS layout is assumed. Every call or operation holds the
  editor; another game's open closes it only while it is idle, and fails `busy` naming the holder.
- `GameToolchain` detects the user's own Godot, Unity and Blender the way providers are detected,
  and never installs them: they are other vendors' software with their own upkeep and licences on
  every OS. It fetches only harness plumbing (uv, the Unity CLI) itself, through `downloadPinned`
  against vendor-published sizes and SHA-256s.
- Every process the game layer starts goes through one process host
  ([processHost.ts](../../apps/server/src/game/processHost.ts)), the only per-OS process code. A
  child carries a fresh launch token in its environment (and on its command line where the program
  ignores extra arguments: the Unity editor, Blender), and its launch record is pid, OS start time
  and token. A record is signalled only while the live process has that start time and carries that
  token, so a reused pid or a record an agent wrote never names another process. A tree is a
  process group on Linux and macOS; on Windows every owned child joins one kill-on-close Job Object
  held by a helper whose stdin is the server's pipe, so the tree dies with the server however it
  exits; only a child whose launch record is reaped at the next start (the live Unity editor) stays
  out of the job, since a Licensing Client it starts inherits the job and must outlive us. A tree
  stop on Windows ends the root and its descendants pid by pid, never `/T`, so a `keep` filter can
  spare what is the user's. Free memory is `os.freemem()` (libuv's MemAvailable
  on Linux). Every in-game runner quits when its control socket closes, so a crashed server leaves
  no game running; only the live editors outlive it, and their records reap them.
- `GameAssetLibrary` serves the curated CC0 library in `assetLibraryCatalog.ts`. Each pack is a
  download URL pinned by SHA-256 and size, fetched on first look into `asset-library/` beside Kurambit's
  tools folder, and unpacked with path, link and size limits. Bytes that differ from the pin are
  refused, never re-pinned at runtime: a source can change contents or licence silently, and a
  refusal is the only honest answer. A pin changes only in a reviewed commit that rechecks the
  licence. Kenney packs come from Kenney's own OpenGameArt uploads, because kenney.nl hands out
  short-lived signed links behind a session cookie, which cannot be pinned. KayKit packs are
  GitHub commit archives of Kay Lousberg's own repositories, pinned by commit; itch.io links are
  signed and cannot be pinned either, so Quaternius' itch-only packs (the 65-joint Universal
  Animation Library and the Universal Base Characters) are pinned from a Kurambit release mirror of
  the same zips, by SHA-256. A pack's `root` names the archive folder that holds it. Every server on the
  machine (the installed app and any dev server) shares that cache, so fetches lock per pack only
  within one process, scratch names carry the fetching server's pid (a start-up sweep spares live
  ones), and placing a pack accepts a complete copy another server placed first.
- Every pack belongs to a style family (`LIBRARY_FAMILIES`), and a pack with rigged characters
  names its rig, read from its GLBs' skin joints when it is pinned (`LIBRARY_RIG_JOINTS`; the
  FBX-only rigs are named from their authors' descriptions): a game whose characters share
  one rig can play any clip on any character. Made characters share the `standard-humanoid`
  skeleton, so every standard clip plays on every made or library body on it.
- `STYLE.json` at the game root is the style lock (`packages/contracts/src/gameStyle.ts`), read
  by `gameStyle.ts` on every call of every tool that brings art in, and never cached, so an edit
  takes effect at once. The tools refuse what drifts rather than warn: a library add outside its
  packs (checked before the pack is fetched) or of a possible character on another rig (any model
  whose clips cannot be read counts), a sprite render in another palette or mode, a Blender
  import from a source it does not list, and an import or export carrying an armature whose
  bones are not the lock's rig. A lock without `rig` says nothing is rigged, so no armature
  enters; one without `audio.packs` leaves sound unlocked. Each
  refusal names the one edit that changes direction on purpose. A lock that is a link, not JSON
  or names unknown library ids fails every art tool with the field, so a broken lock is never
  silently lifted. It is a game file, so checkpoints carry it and a run's restore brings it back
  with the art (`restoredPaths`). `rig` names the skeleton made characters are conformed to; a
  pack the lock lists may still bring characters on its own rig with its own clips. How a game's
  characters are made (library, Blender or Tripo) is the person's choice, kept in `game.json`
  `characters` rather than the lock, so it can be set before the first turn writes one; the
  export enforces it and the agent never changes it on its own.
- Made characters are conformed, not retargeted: `game_blender_character` fits the standard
  armature to the body once, keeping the standard rest frames, so library clips play unchanged
  and a body off those frames is refused at export rather than playing broken. An asset ships
  only as reviewed: `game_blender_look` mode review runs the style pass and measurement in a
  separate one-shot Blender on a saved copy of the live scene, and `game_blender_export` writes
  exactly that candidate or refuses when the scene changed since; a refusal is only for what the
  agent or person must change, while the pass fixes what it can (it scales over-budget textures
  and says so). Where the player downloads the GLB itself (three.js, `compressedModels` in the
  profile) the pass writes WebP images and the export then meshopt-compresses the geometry with
  gltfpack: Blender cannot import meshopt, so the review measures the uncompressed candidate and
  the sidecar names the shipped bytes and triangles, which keeps the asset fact valid. The asset is its sidecar `<name>.asset.json` (skeleton, clips with ground speed,
  springs, height, source and licence), which the three.js shell reads from `ASSETS` and which
  Godot and Unity can read later; GLB extras are not used because those engines drop them.
  Painting from a sheet (`game_blender_paint`) and carving (`game_blender_carve`) run in a
  one-shot Blender too, since their bakes outlast the live server's 180 s per command; the live
  scene only adopts the result, after checking its objects did not change meanwhile.
  MPFB2 is GPL code with CC0 output, so it is downloaded into Kurambit's own Blender folder on the
  person's request and never bundled.
- An engine is two modules, and nothing above them names an engine. Its profile
  (`godotProfile.ts`, `threeProfile.ts`, `unityProfile.ts`, read through `engineProfile.ts`) is pure
  data the services, the client tables and the run's pure policy share: directories, its releases
  (target, artifact, whether it ships as a file or a folder, whether Kurambit packages it), what of
  the project is build input, how its games play, the harness's runner files, check messages, its
  tool descriptions, skill and prompt lines. Its driver (`GameGodotEngine`, `GameThreeEngine`,
  `GameUnityEngine`, registered in `GameEngine`) holds the behaviour that differs: the project and
  its binary, its tool's status, viewport, import, check, writing one release into a staging folder
  and checking its own files, how a play session starts its runner (`playProcess`; null for a
  browser page), and the optional `editor` (a live editor that refuses a second user) and `player`
  (where a game keeps its built players). A per-engine table outside a driver is a
  `Record<GameEngineId, …>`, so a new engine does not compile without its entries. A Godot
  game draws Forward+ in native exports and Compatibility in its Web export
  (`rendering_method.web`), and every play on a private display forces Compatibility because Xvfb
  has only software GL: the facts and frames the harness takes are Compatibility's. The template's
  look therefore uses only what both renderers draw. The three.js shell's bloom is opt-in for the
  same reason: the harness plays in Chromium on SwiftShader, where bloom cost several times the
  plain look per frame, and the harness must play the build the player gets. The game is
  known by its manifest's engine id (and its project folder by `manifestProject`), never by the
  folder's name; a run records the engine it started with (`runEngine` derives it from the lane for
  older records).
- Every release takes one path (`GameExport.releaseTo`): staged beside its destination, written and
  checked by the driver, compared with the sources before and after (an unidentifiable tree is
  refused before the engine runs), then published by `publishStaged`, which moves the incumbent
  aside and puts it back on any failure. A native release replaces the whole `builds/<target>/`
  folder; a Web build becomes the content-addressed candidate Play selects, and only the selected
  build and the one before it are kept, with their preview servers; a kept Unity player is
  published the same way. A crash between the two renames leaves a `.retired` copy with no final,
  which the next export's sweep puts back. The check's verdict is `GameEngine.check`: everything
  the game did is a check error or warning, and it fails only when a tool or the machine kept the
  check from being made. Each engine has one error reading for import, export and check (Godot's
  `parseGodotIssues`; Unity's `answerOf` over the CLI envelope), and a harness fault is
  `tool-failed`, never `command-failed`. Godot owns the native process boundary (headless editor
  import, check script, export presets); its check skips `.gdignore` folders and files every
  export preset excludes, as the editor and exporter do. three.js owns a headless-Chromium
  boundary: import is a no-op, the check loads the page (a page crash is the game's, a lost
  browser a tool's), the release copies the folder. Unity refuses a second editor on an open
  project, so every Unity operation goes through the game's live editor in `GameUnity`: import
  refreshes and recompiles there, the check plays the first enabled build scene and the gameplay
  scene; a game whose play mode never answers or advances no frame froze (an error, and the editor
  is closed), one that runs below speed is a warning with its frame rate.
  Unity editors run with the real HOME so they reach the user's Licensing Client; Kurambit only
  reads the entitlement file to say whether a licence is active and never stores credentials.
  Every `unity` CLI call (status, command, recompile, mcp) runs under the CLI's own HOME in the
  tools directory, because the CLI logs each invocation with its full arguments to
  `~/.config/unityhub/logs/cli-log.json`; it reaches the live editor through the project's
  `Library/Pipeline` port file, so nothing Kurambit runs writes the user's Unity Hub data.
  Blind samples play plain copies of a build, each a separate Unity project with no `Library/`.
  Before an editor opens on one, `GameUnity` gives it a copy-on-write copy
  (`fs.cp` with `COPYFILE_FICLONE`: a reflink or APFS clone where the filesystem has one) of its game folder's `Library/`, found through the folder the copy
  names in `.kurambit-copy-of` and taken after the game folder's
  idle editor closed, so only what differs in that build is reimported (about a minute warm,
  against two cold). The compiled-script
  state (`Bee/`, `ScriptAssemblies/`, the player data caches) is left out: it is keyed by the main
  checkout's path, a player built from it lost the scene's MonoBehaviours, and the copy
  recompiles its scripts anyway. The editor is
  needed there only to build the Linux player; the role runner closes it before removing the
  copy. Other checkouts whose `.git` is a file (submodules) are
  refused.
- Web play shares the services: the browser host (`webPlaySession`) opens real-time
  headless-Chromium sessions on the served static folder (real keyboard/mouse, the read-only
  `window.__studio` probe, console and page errors; no pause between acts). `gameChromium`
  takes T3's pinned headless shell from `PreviewBrowser` (installed on first use, sandboxed as
  preview is, so three.js needs no browser on the machine) and holds the `__studio` snippets; `gameWebServer` serves a game-relative directory over loopback for check/explore/bot
  without touching Preview state.
- Unity play is a real Linux player of the current sources, built once per source identity
  under `builds/logs/unity-play-*`, run in a window host's window. The role runner makes a Unity sample's
  copy itself and readies its player before the thread exists, so neither side of a
  comparison spends play time on a build: a copy-on-write copy of the game folder's player of
  the same source identity (the content hash), else a build in the copy. The main checkout keeps its three most recently built or
  copied players, so a best that keeps being sampled stays reusable; a best whose player was
  pruned builds in its copy, still outside its clock. Where a player came from stays out of the explore result, since sample notes reach
  the blind comparator verbatim. Bot runs play the same prepared player. The template's
  `StudioProbe.cs` is Unity's play-session runner; input is queued on virtual Input System
  devices, which is why the lane asks games to read input through the Input System.
- `GameExplore` routes by the engine's play kind with an explicit target override:
  `game_explore_start` defaults to the game's lane, Godot web and native-on-three are refused plainly. The same
  content-addressed export machinery (hash, compare, move into place, select) serves both lanes;
  the expected-files check is engine-aware.

## Play sessions

Exploration and bots are clients of one play-session protocol
([gamePlaySession.ts](../../packages/contracts/src/gamePlaySession.ts)), versioned, so neither
knows which engine runs the game. A session opens held: the runner says hello with its
capabilities, plays discrete acts with the game paused between them (exploration), and after
`realtime` lets the game run for good while held keys, taps and clicks stream in and one tick
observation goes out every 100 ms (bots). The policy that plays, the detectors, the video and the
reports are shared; an engine adds only how a session launches. Every wait a session makes has a
bound (`PLAY_BOUNDS` in [playSession.ts](../../apps/server/src/game/playSession.ts)), including
every call into a web page, and its end says by whose side: a game that exits, crashes or stops
answering is evidence about the build (a bot run ends `crashed` or `unresponsive` with its trace
and video), while our display or browser going away is a tool fault. A tick's `t` is the game's
own clock on every engine: it stops while the game pauses itself (Godot counts physics frames only
while the tree runs, Unity reads `Time.time`, a page sums its frames' clamped deltas).

- Godot's runner is one GDScript ([godotPlayRunner.ts](../../apps/server/src/game/godotPlayRunner.ts))
  the server writes under the game's ignored `builds/logs/` for each session, so it always matches
  the server.
- Unity's runner is `Assets/Kurambit/StudioProbe.cs` inside the game, because a player only runs
  code it was built with. The harness owns that file: a new production run copies it from the
  template (`profile.run.harnessFiles`) before the run's base build, so every build the run keeps
  carries the same runner and none counts it as a role's work. A game whose probe predates
  the versioned protocol still explores (it reads as protocol 0, acts only) but refuses bots with a
  message saying so, until a fresh run refreshes it.
- three.js has no runner process. The browser host speaks the protocol to the page through the
  shell's `window.__studio` bridge, which the game owns and may have edited, so the protocol stays in
  the server instead of the page. Pages read no control tree: no ui or inspect steps, and a bot's
  id-clicks are skipped and counted.

Process runners connect out to a loopback port with a per-session token, and quit when that
connection closes. Pictures and video belong to the engine, never the OS: each act's picture is
written by the runner, and from protocol 2 a bot run asks `realtime` for frames, which the runner
streams as JPEGs of its back buffer after draw (Godot: the viewport texture after
`frame_post_draw`; Unity: `CaptureScreenshotIntoRenderTexture` downscaled on the GPU and read back
with `AsyncGPUReadback`; the browser: the CDP screencast). Each frame carries the engine's own
drawn-frame counter. [frameVideo.ts](../../apps/server/src/game/frameVideo.ts) pipes them into one
ffmpeg on a wall-clock grid, repeating the last picture in a slot with no new one, so a game that
draws slowly or stops looks exactly like that, and writes `run.frames.json` beside the video with
each frame's counter, game time and arrival (the evidence route is `engine-frames`). The run's end
frame is the runner's own `still`. A protocol 1 runner (an older game's Unity probe) still plays,
without video.

The person's own play depends on how the engine is staged (`GAME_ENGINES[engine].stage`). A
`live` engine (three.js) is played from its folder: `GamePreview.live`
([GamePreview.ts](../../apps/server/src/game/GamePreview.ts)) is the game's dev server, one
loopback server and one recursive watch per game, so the person watches the agent's saves land. A
settled save (400 ms, Blender sources and editors' temporaries filtered out) is one `live` push
on the game event stream, which the Stage remounts on; it rereads nothing. Serving is not a write,
so Play there takes no lock and records no operation, and Stop closes the watch before the server
so nothing is pushed after it. What the person sees mid-turn is never a build: builds stay the
turns' checkpoints, because facts, Undo and Go back need a fixed tree, and a folder the agent is
still writing is not one. A `live` engine's Web export is a release only and never replaces the
live serve. An `export` engine (Godot) plays the selected Web export, rebuilt when stale, and a
`window` engine (Unity) plays in its own window.

So the harness needs exactly two things from an OS: a **process host**
([processHost.ts](../../apps/server/src/game/processHost.ts), above) and a **window host**
([windowHost.ts](../../apps/server/src/game/windowHost.ts)): one `launch(command, viewport)` that
gives a game or editor a window it draws into, which the user never sees and which never takes
focus. Exploration, bots and the live Unity editor (which runs the Unity check and builds players)
and Blender all launch through it; the Godot check needs no window and runs headless. On Linux every launch gets its own Xvfb display, which Xvfb picks itself (`-displayfd`); the display outlives its command and ends right
after it (an engine that loses its display mid-quit hangs in Xlib's exit path), so a game that quits
because its server died takes its display along. Windows and macOS give an app no private display
(a virtual monitor needs a driver there; macOS's API is private), so the window opens on the
user's desktop far off every monitor, never minimized (a minimized Godot window stops drawing), and
the launched program places it: Godot by `--position`, the Unity player by its probe
(`SetWindowPos` without activation), Blender by `--window-geometry` with `--no-window-focus`. No
capture code differs by OS. macOS stops Godot drawing in a window it counts as occluded, so there
the runner registers an additional output to keep frames coming; what a Mac tester must confirm
is in [macos-play-check.md](../operations/macos-play-check.md). Without a window host a native session runs headless where its engine
can and refuses plainly otherwise; it never falls back to the user's display on Linux.

On Windows, Unity plays a Windows player (macOS plays no Unity game yet). Godot's `user://` is
isolated through the variables Godot reads on each OS (XDG on Linux, `%APPDATA%` on Windows, `HOME`
on macOS; see [gameNativeUserDir.ts](../../apps/server/src/game/gameNativeUserDir.ts)). A Unity
player on Windows keeps PlayerPrefs in the registry, which no environment can move, so its
sessions share the game's real prefs there. Plumbing Kurambit fetches (uv, the Unity CLI) comes
from one per-OS/CPU table of official builds with their published SHA-256
([plumbingBuilds.ts](../../apps/server/src/game/plumbingBuilds.ts)).

## Tools

Agents reach the services through the `game_*` MCP toolkit; the client reaches the same services
over RPC. Threads the production run launches get play-level tools (plus `game_run_submit`) only (status, check, import,
export, explore start/act/close, bot run/view/report, `game_run_checks`, blender, unity and asset library tools); every
other MCP tool (threads, worktrees, projects, previews) hides from them unless it declares
`EnabledWhen` itself, since a blind role that could list threads could map builds to reports. The `game_unity_*` tools
are a curated front for `unity mcp`: a fixed allowlist of editing tools behind one
`game_unity_edit`, plus eval, recompile, play, screenshot and console; builds, tests, packages and
editor lifecycle stay with Kurambit's own operations. The live editor runs with one asset import
worker and `-job-worker-count 2` (the worker count is a per-user setting in
`UserSettings/EditorUserSettings.asset`, rewritten before every start), because Unity's default
three import workers cost about 0.7 GB each. Packaging, preview, stop and the
run's own status, round, steer, decide and profile tools stay outside their catalog.

## Builds and facts

- **A build is no record of its own.** [GameBuilds](../../apps/server/src/game/GameBuilds.ts)
  reads the rail each time from the turn checkpoints and the run's records; a build's id is its
  commit. Every surface (the six RPCs, the `game_builds`, `game_facts` and `game_build_restore`
  tools) is one method of that service.
- **A turn's change is its own.** T3 diffs a turn's checkpoint against its thread's previous
  one, which in a game includes whatever the run or another chat did in between. A turn build
  counts from the newest build of the game captured before the turn began, and says so when the
  turn began while a run round was building, since concurrent edits to one folder cannot be split.
- **Turn builds measure themselves.** On an engine whose profile has `turnLoop`
  (three.js; Godot and Unity are parked), `GameBuildsReactor` takes a chat turn's checkpoint
  that changed files and measures the turn's build in the background. A live-staged engine's
  Stage already shows the folder (Play sessions, above), so nothing is built for it. An engine
  whose Stage plays a Web export also has the folder's Web build made current, as the chat's own
  operation (`GameService.playCurrent`), which the Stage remounts on; a stopped or cancelled turn
  is measured but not played. Freshness is decided inside the game's lock, and a fresh build is
  left as it is, so a turn that changed nothing playable never restarts a game the person
  stopped. Each thread's turns run forked, in order, off the event
  stream, so one game's wait for its lock never holds another's. Subagent turns (and a stage-era
  run's role turns) are no builds of their own. A newer turn's measure drops an earlier turn's
  that is still queued (`supersede`), never one running, a person's or keep going's. A restart can
  cut a turn's work off, so the reconcile measures the newest turn build of each turn-loop game
  that has no facts. A keep-going step is such a turn: its row carries `source.step` (number,
  verdict, reason) from `GameRunControl.steps`, which is how the strip and the timeline mark it.
- **An automatic undo never takes a person's work.** Keep going's undo is the same restore with
  `expect`: the folder must still hold the step's build, unedited, or nothing moves and the answer
  is `moved-on`. It is checked under the game's lock before the restore record is written, so a
  refusal keeps the game's last restore and its Redo, and again against the park inside the
  move, which a repeat after a restart reads too. A folder that already holds the base answers
  `current`: the person undid the step first.
- **A build's base is fixed when it lands.** `base` is what restoring undoes a build to. A
  turn's is the folder as the turn began: T3's diff base (turn 1's is the start checkpoint,
  ordinal 0), or a newer build that landed in between, such as a restore's target. It is
  recorded as a ref (`game-builds/bases/<build>`) on the turn's checkpoint, the way T3 records
  checkpoints, because reading it later from the game's latest restore goes wrong once a second
  restore replaces the first. Undo is that restore, never T3's conversation revert, which is
  refused in a game's shared folder and would make the agent forget the attempt. A live Stage shows
  a restore through its watch; on a turn-loop engine staged from a Web export, a restore plays
  what it brought back, through the same `playCurrent`.
  `folderEdited` compares the folder's restored paths, captured with T3's capture, against
  `current`.
- **Copies, never the folder.** A build is played and measured in a plain copy under the
  worktrees folder's `game-builds/`, which is in `GIT_CEILING_DIRECTORIES` like the run's copies
  ([GameBuildCopies](../../apps/server/src/game/GameBuildCopies.ts)). One engine step at a
  time runs on a copy, so Play's Web export and a bot run never import into one project at
  once. A copy is removed only when nothing leases or serves it.
- **Facts are keyed by content.** A facts row is keyed by the git tree of the build's engine
  folder plus a harness id, so builds with the same project share facts, and facts from another
  harness are never compared. Owed work is data, not memory: a measure writes its row first, so
  a startup reconcile re-measures any row that still owes a tier.
- **Game browsers draw on the GPU.** Once per server process, `makeGameBrowser` probes the pinned
  headless shell for a hardware WebGL backend (Linux: EGL, then Vulkan, on the GPU's render node,
  with no display in its environment) and every game browser launches with the first that drew on
  hardware, else SwiftShader. SwiftShader costs several cores on a lit 3D scene and plays it at a
  fraction of real time, so a facts row records its renderer, facts from different renderers are
  not comparable, and a too-slow run in software is "not measured", never the game's slowness.
- **Only a measurement is a fact.** A tool or machine fault is stored as "not measured": with
  `retry` when waiting can clear it, or as `standing` when it needs a person (their next measure
  tries it again). Tier endings are read from the shell's run state, never from a bot's word.
- **Going back with no run** makes the run's own moves (`withBuildInFolder`) under the
  `game-builds` run-ref folder. The record is written before the folder moves, and a restart
  settles a restore it cut short by running its moves again.

## Keep going

Keep going takes a game's next step itself, in the chat that turned it on. It is records of that
chat (`GameRun` with `loop: "turns"`, `GameRunStep`, and one `GameRunRound` per step with its
`step` record; [gameRunRecords.ts](../../packages/contracts/src/gameRunRecords.ts)), changed only by
`game-run.*` commands. The pure decider
([decide.ts](../../apps/server/src/orchestration-v2/gameRun/decide.ts)) folds them into the run's
state ([state.ts](../../apps/server/src/game/run/state.ts)), lets the policy
([loop.ts](../../apps/server/src/game/run/loop.ts)) choose, and commits the new records with their
outbox effects in one transaction, so a retried command changes nothing and a restart loses no
decision. A game has one run, reached from every chat of its project through `getProjectGameRun`;
`GameRunControl` reads and dispatches under the project's lock, so two chats turning it on at once
cannot both find none.

- **A step is an ordinary chat turn.** The cycle is look, then (Guided) a proposal, then the turn,
  a judge, maybe an undo, then the step's record, then look again. The turn is a message the run
  posts into the chat; its id names the step and attempt
  ([ids.ts](../../apps/server/src/orchestration-v2/gameRun/ids.ts)), which is how the reactor, the
  strip and the timeline know a turn is a step. Everything phases 1 and 2 give a turn (its build,
  facts, strip, Redo, timeline mark) a step gets for free; the run adds only the choice of message,
  keep or undo, and when to stop.
- **The proposal costs no tokens.** The policy writes the step from the facts' own wording and the
  agent's own `Next:` line (one parser, `packages/shared/src/gameNextLine.ts`, so the person sees in
  the Next banner exactly the line the run will use), in a fixed order: the person's notes, a
  blocker, a retry of an undone step, the play bot, a failing fact, the agent's next line. Only
  watched facts are proposed or guarded: motion, detail and colour are heuristics, and a space
  game's black sky must never cost a step.
- **Never two writers.** A look waits until no turn runs or is queued on any chat of the game; a
  step turn that comes up queued is cancelled and the run looks again; any other turn or folder
  move supersedes a pending proposal. A step acts only on the build its look read: its turn
  reports the folder's build at its start (`startBuild`), the judge and the undo use that build,
  and a turn that started on any other build (a Redo, a restore, a person's turn landing during the
  look) is never judged or undone, so the run looks again. A step the person redid is never
  retried. A person's turn is never judged or undone.
- **Worse is a crossing, not a change.** A step regresses a watched fact only on a comparable delta
  whose reading crosses into `bad` (or skilled stops winning). GPU liveness varies between builds
  of one tree, so "any change" would undo good work; a fact already bad that gets worse is the
  next blocker, not an undo. Not-comparable (another harness, renderer or bot) never undoes.
  Health regressions always undo; design ones (winning without skill, skilled losing) do not on a
  step the person asked for or steered: difficulty is their call.
- **The undo cannot hurt the person's work.** It is `GameBuilds.restore(base, { expect: build })`:
  inside the game lock the folder moves only while it still holds the step's build unedited, else
  it is refused `moved-on` and the record reads "the game changed after it". A step the person
  undid first counts as undone.
- **Gain and stopping.** A step gains when it was kept, changed the game (lane, `art/`,
  `ASSETS.md`) and made no watched fact worse; a closed target counts too (the person's own step,
  a kept retry, the bot once skilled is measured). Two steps in a row without gain pause the run
  `stalled`; two unmeasured steps in a row pause it `tool-failed`, since a broken measure would
  otherwise repeat at the game's cost. `Next: none` with nothing else to propose ends it `done`.
  The budget is checked before each turn against a typical step (8 min), and it is what bounds an
  Autopilot that keeps adding content. Every ending but `done` resumes.
- **Never repeat.** Each proposal has a key (`fact:<id>`, `bot`, `steer:<fnv>`, `next:<fnv>`; a
  retry carries the undone step's). Two misses of a key (undone, or kept with its target still
  bad), a blocker or fact step that changed nothing (the agent declined it), Skip, or a bot step
  that left no bot set the key aside for the run.
- **Notes and the captured prefix.** A steer step carries the run's waiting notes; its turn's
  start takes exactly that many off the front of `GameRun.steer`, and a turn that never landed
  (superseded, stopped) gives them back ahead of newer notes. A note only ever appends, so Slice 2
  can count on that prefix (`capturedSteer`).
- **Long work runs in jobs, never in effects.** An effect claim is a short lease on a pool every
  thread's provider work shares. `game-run.step.execute` hands the step to `GameRunJobs` and
  settles at once; the job reports with `game-run.step.complete` or `.fail`. A turn's cap and a
  resend are short, so they run inside their effects, which stay unsettled until done. Every
  report carries its attempt and a derived command id, so a late or repeated report is refused or
  is a receipt.
- **The outbox timer exception.** The outbox runs a thread's effects in order. A turn's cap and a
  proposal's deadline wait minutes on the chat, so a pending `game-run.step.deadline`,
  `game-run.step.resend` or `game-run.decision.deadline` holds nothing back
  ([EffectOutbox.ts](../../apps/server/src/orchestration-v2/EffectOutbox.ts)); otherwise the
  person's own turns would wait out every cap. Each timer checks the run again when it fires.
- **Recovery** (`GameRunRecovery`, at startup): a step whose job died gets it again through a
  `recover` timer, behind whatever its thread still owes; a judge or undo a pause cut off runs
  again on resume. A step turn T3 carried over a restart that its run no longer wants (Off, an
  ended run, a step moved past) is interrupted, so nothing edits a game the person stopped.
- **The stage era.** A run without `loop` was made by an earlier Kurambit. Its records decode
  (stage-era fields as `Schema.Unknown`, steps through `GameRunLegacyStep`), so round cards and
  Past runs still read; it takes only a stop, one still live is stopped at startup with why, and
  turning keep going on starts a new run beside it.

`game_blender_render_sprites` exists because weak models cannot write sprite framing: their
renders cropped heads, drifted across a walk cycle and came out near-black. It fits one fixed
orthographic camera per view to the subject's evaluated geometry across every frame, renders in a
throwaway scene that links the live objects (the live scene and its .blend never change), and
batches renders because the pinned server gives each Blender command 180 s. The pixel-art pass
(downscale, hard alpha, one palette for the whole strip, outline) runs in the server in
`spriteRender.ts`, so the same renders always give the same bytes.

## Why this shape

A model left alone grades its own work, stops when it feels done, and says it tested things. The
harness makes the facts true regardless of what the model says: every turn's build is played and
measured by the harness's own bots (boots, the idle, masher and skilled tiers, liveness, response),
and keep going undoes a step that made a watched fact worse and stops when steps stop landing
changes. Taste stays with the person; the harness never judges it for them. Craft advice lives in the skill pack under `apps/server/templates/studio/` (plus `three.md`
for the browser lane, `unity.md` for Unity) and the bot
kit under `apps/server/templates/bot-kit/`; both are copied into each game when a run starts, not the product. A
resume keeps the run's copy, so every build of one run is made and judged under the same guidance and no
build carries harness text as its own work. `GameCreateInput.engine`
(`godot` when omitted on the wire; the app defaults new games to the first ready engine with `turnLoop`, three.js today; `three` for the browser lane, `unity`) picks the starter template (`blank` /
`blank-three` / `blank-unity`) and the scaffold (`godot/` Godot 4.7 project / `web/` static three.js
project with vendored three.js r0.180.0, MIT / `unity/` Unity 6000.6.7f1 project); `copyTemplateIntoGame` copies whichever engine tree the template ships.
The Godot starter's main scene is a genre-free demo shell (title, pause, settings, controls, end, credits)
and it ships the `Juice` feel kit, because weak builder models skip or break both when they write
them from scratch; the manifest's gameplay scene (`scenes/game.tscn`) is the seam the shell
instances, so the check boots both. The shell pauses with `SceneTree.paused`, which is why the
Godot play runner resumes the game's own pause after each act instead of forcing it off.
The shells carry the controls as named actions (the Godot InputMap, `web/shell/controls.js`,
`Controls.cs` over the Unity Input System)
that players rebind on the Controls screen; every default keeps a keyboard key, because explore
acts and bots press keys by name and cannot reach an action bound only to a gamepad.
The Unity starter carries the same shell in `unity/Assets/Kurambit/Shell/`, built in code at
startup rather than saved in a scene, so no starter UI depends on scene YAML a model might
overwrite. Gameplay is `Game.unity`, which the shell loads additively as the active scene on Play
and Retry; played on its own (the check, editor play) it boots straight into a run, which is why
the template's `gameplayScene` is `Assets/Scenes/Game.unity`. Pause and the end screen use
`Time.timeScale`, the same lever the StudioProbe holds the game with between acts, so the shell's
end beat and Juice's hit pause count only time that runs. A Unity player can load only assets a
scene or a `Resources/` asset references, so an `AssetPostprocessor` points
`Kurambit/Resources/ShellAssets.asset` at the fixed files the art step writes (title art, font,
click sound, credits) and sets `Assets/UI/icon.png` as the player icon when they import. The
template's URP assets are committed as a player build re-saves them; an older serialization
would make every new game's first build change its sources and fail the identity check. The
URP global settings' `m_RuntimeSettings` list is the exception: every editor save empties it
and every player build refills it, so whichever state a game committed, the next build flips it.
The build-source identity leaves that list out ([sourceSnapshot.ts](../../apps/server/src/game/sourceSnapshot.ts));
counting it failed the first boot after every warm-up. Domain reload stays on (`EditorSettings` enter-play-mode options
off): the kits keep static state, and a second play session in one editor would otherwise
reach objects the previous session destroyed.
The three.js starter carries the same shell in `web/shell/`: it owns the render loop and calls
the gameplay module `web/main.js` through `start`/`update`/`stop`. Its page opens on the title,
so the template's `gameplayScene` is `index.html?play` (boots straight into a run) and the
three.js check loads that entry after the plain page, like the Godot check runs `game.tscn`. The manifest's
`godotProject` names the engine project directory for every lane (`web` for three.js, `unity`), so snapshots,
exports and the run resolve it unchanged. A run takes the lane (the engine directory) from the
manifest, and every engine question the run has is the lane's engine profile.

Two constraints hold everywhere:

- Nothing opens on the user's desktop. Every game process drops `DISPLAY`, `WAYLAND_DISPLAY` and
  `XAUTHORITY`; its window comes from the window host, and its pictures from the engine.
- No test suites for the game layer beyond data-safety checks; games are played, not asserted.
