# Game layer

> For maintainers. The code lives in `apps/server/src/game/`, `apps/server/src/mcp/toolkits/game/`,
> `packages/contracts/src/game.ts`, `apps/web/src/components/game/`.

A new game is a chat: its first message is the brief, and every turn that changes the game is a
build (the turn's T3 checkpoint). On engines whose profile has `turnLoop`, the harness plays that
build on the Stage and measures its facts in the background. Undo restores the build it was made
from (`base`). Keep going is a run on top of the same turns. The harness, not the model, owns every
check that matters.

## Decisions that span the services

- Game operations are exclusive per game (`GameOperations.exclusive`) and reported as events, so
  the Game panel and the agent tools see the same operation, and a second operation on a game
  refuses as busy rather than racing the first. A restore's folder moves (captures, restores,
  kept names) run as operations of the game, taking the operation lock and then the checkpoint
  workspace lock; T3's turn captures take only the latter, so the two never wait in a cycle.
- Keep going never launches a thread of its own: its steps are turns of the chat that turned it
  on, so no game thread is owned by anything but its chat. Event logs still hold the role threads
  (`role` lineage) and run records an earlier Kurambit's production runs wrote; their shapes keep
  decoding, `role` threads are left out of a game's chats, and nothing else reads them.
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
- `GameToolchain` detects the user's own Blender, and an active engine's own tool (Godot, Unity),
  the way providers are detected, and never installs them: they are other vendors' software with their own upkeep and licences on
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
- `GameAssetLibrary` serves the pinned open library. Every entry is a "pack": a curated one in
  `assetLibraryCatalog.ts`, a generated one in `library/packs.json` (the rest of Kenney's 3D kits,
  Quaternius' site packs, KayKit), or one asset of a per-asset source (`assetLibrarySources.ts`:
  Poly Haven and ambientCG from the shipped `library/*.json`, Poly Pizza searched live with the
  person's own key). The index files are written by `apps/server/scripts/library-index.ts`, one
  adapter per source, and shipped rather than crawled per install: ambientCG is one person's
  server, and search then works offline. An entry is a download URL, or a list of loose files,
  pinned by what its source publishes: a SHA-256 we hashed when pinning, Poly Haven's MD5 and size,
  ambientCG's size, or only a ceiling for Poly Pizza, which publishes neither; when the pin holds no
  hash, ASSETS.md records the SHA-256 that arrived. Bytes that differ from the pin are refused,
  never re-pinned at runtime: a source can change contents or licence silently, and a refusal is
  the only honest answer. A pin changes only in a reviewed commit that rechecks the licence.
  An entry with bytes on a host that throttles every install (Google Drive, `awaitsMirror`) stays
  in the index with its pins but is not offered, and a direct request says it waits for the
  mirror; re-pinning it to the release mirror is all it takes to offer it. Only licences a sold game may ship under are indexed (`shippableLicence`: CC0, CC BY 3.0 and 4.0
  with a credit line, MIT, Apache-2.0, the OFL for fonts); per-asset licences (Poly Pizza) are
  checked one by one. The add credits each entry in ASSETS.md and gives the game's credits file one
  line, in the source's own credit wording when its licence asks for credit. Kenney packs come from
  Kenney's own OpenGameArt uploads, because kenney.nl hands out short-lived signed links behind a
  session cookie, which cannot be pinned. Quaternius' packs come from the public Drive folders his
  site links, one file per model; KayKit packs are GitHub commit archives of Kay Lousberg's own
  repositories, pinned by commit; itch.io links are signed and cannot be pinned either, so
  Quaternius' itch-only packs (the 65-joint Universal Animation Library and the Universal Base
  Characters) are pinned from a Kurambit release mirror of the same zips, by SHA-256. A pack's
  `root` names the archive folder that holds it. Entries are fetched on first look into
  `asset-library/` beside Kurambit's tools folder, unpacked with path, link and size limits, and
  kept under a size ceiling by an LRU ledger (`lru-cache`) that removes the least recently used
  pack folders. Every server on the machine (the installed app and any dev server) shares that
  cache, so fetches lock per pack only within one process, scratch names carry the fetching
  server's pid (a start-up sweep spares live ones), and placing a pack accepts a complete copy
  another server placed first; a pack another server evicted is fetched again.
- Every entry belongs to a style family (`LIBRARY_FAMILIES`), and a pack whose characters share a
  skeleton names its rig, read from its GLBs' skin joints when it is pinned (`LIBRARY_RIG_JOINTS`;
  the FBX-only rigs are named from their authors' descriptions): a game whose characters share one
  rig can play any clip on any character. A pack whose animated models each have a skeleton of
  their own (animals, creatures, vehicles) names no rig: each model comes with its own clips, and
  the lock's rig never refuses it. Made characters share the `standard-humanoid` skeleton, so
  every standard clip plays on every made or library body on it.
- `STYLE.json` at the game root is the style lock (`packages/contracts/src/gameStyle.ts`), read
  by `gameStyle.ts` on every call of every tool that brings art in, and never cached, so an edit
  takes effect at once. `game_assets_add`'s `lock` writes it from a style family
  (`styleFromLock`), keeping what else the lock holds, so agents never hand-write its shape. A lock
  admits every pack of its family (one look by definition); `packs` lists the family's curated
  packs and what comes from beyond it, and a source id there (`polyhaven`) admits all its assets.
  The tools refuse what drifts rather than warn: a library add outside its family and packs
  (checked before the pack is fetched) or of a possible character on another rig (any model
  whose clips cannot be read counts), a sprite render in another palette or mode, a Blender
  import from a source it does not list, and an import or export carrying an armature whose
  bones are not the lock's rig. A lock without `rig` says no character shares library clips;
  one without `audio.packs` leaves sound unlocked. The rig exists only so library clips fit every
  character, so an armature marked on its own rig (`kurambit_rig`) is outside it: the mark stands
  when a creature generation of this game delivered the armature, or, with no generation named,
  when it carries clips of its own and none from the library (`ownRigRefusal`). Any scene code
  can set the mark, so the review and the export check that claim, and the route treats a
  marked armature with no generation as made in Blender. Each
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
  `game_animate` compiles a move spec in the live scene itself (a pass takes seconds) and keeps
  each pass's spec, numbers and pictures under `builds/logs/animate/<clip>/<n>`. Its clips follow
  the library's conventions so every consumer treats them alike: travel rides the pelvis (the
  root bone stays at rest; `rootDrift` measures it), and spring chains stay unkeyed because the
  engine springs them. A loop is keyed in place, so the export measures its ground speed; a
  one-shot keeps its travel, and the three.js shell moves the root by it (root motion), or the
  next clip's crossfade would slide the body back. The measurement it shares with the sidecar gives every clip on the standard
  skeleton its stances and strike windows, which the shell's foot IK and `striking` read; a foot
  IK that guesses contacts per frame floats at step edges. Smoothness is judged on what a game
  draws between the 30 fps keys: a bone turning past about 90° against its parent in one frame
  shows as a spin there and nowhere in Blender, so the kit unwraps twists, smooths the prop's
  roll, and reports spins and pops instead of trusting the keyed frames.
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
  look therefore uses only what both renderers draw. The three.js look's default draws straight
  to the canvas, as a plain three.js frame does, so a first build costs what it always did; its
  post chain (AO, bloom, SMAA) runs only for the presets and options that ask for it, and a browser
  drawing in software always takes the straight path, where full-screen passes cost several times
  over. The game is
  known by its manifest's engine id (and its project folder by `manifestProject`), never by the
  folder's name; a run records the engine it started with (`runEngine` derives it from the lane for
  older records).
- Which engines Kurambit works on is one switch: `GAME_ENGINES[id].status` in
  `packages/contracts/src/game.ts`, active or parked, read by the server and every client. Only
  three.js is active. A parked engine keeps its profile, driver and tests, and compiles; nothing
  new is made in it, its tool is not detected, and engine work on its existing games is refused
  `engine-parked` (`GameEngine`'s runner), while their chats, builds and history still open.
  The game tools an agent is listed follow from the same data: each declares in
  [placement.ts](../../apps/server/src/mcp/toolkits/game/placement.ts) what it needs of the
  engine (`engineCapabilities`, derived from the profile, empty for a parked engine) and whether a
  chat lists it only when asked; the MCP auth middleware puts the thread's engine, its character
  route and whether this machine has Blender in the invocation, and `McpSchema.EnabledWhen` decides,
  which Effect's MCP core also applies to calls. A provider reads the list once per session, so
  nothing waits for a request to appear: what a chat uses only when the person asks stays reachable
  through `game_more`, which runs it through its own handler. The Blender tools are listed only
  where the person's route makes characters through Blender (`blender`, or `generated`, whose
  humanoids are conformed there); on the library route they are asked for, so most chats never pay
  for their descriptions. `game_more` is an image tool, so an asked-for look or move still arrives
  as pictures.
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
  code it was built with. The template ships it. A game whose probe predates the versioned
  protocol still explores (it reads as protocol 0, acts only) but refuses bots with a message
  saying so.
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

The Stage talks to a live three.js game through the **Stage bridge**
([gameStageBridge.ts](../../packages/contracts/src/gameStageBridge.ts)): `postMessage` objects both
ends decode, since the game runs on its own origin. The game end is the shell's
`stage-bridge.js`, inert until the Stage's first message, so plays and recordings never trace or
outline. A game announces the bridge in `studio-ready`; a shell from before it posts a bare
`studio-ready`, and so does the current `studio.js` refreshed into it as a harness file, which is
why `studio.js` takes the bridge only as an optional input from `shell.js`. Godot and Unity have
no bridge, and their `tuneFile` is null.

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
over RPC. A tool and its RPC twin call the same method of the service that owns the operation
(GameBlender, GameExport, GameStage, ...); there is no facade between them. Thread-keyed methods
resolve the thread's game and take its operation lock themselves (`GameProjectService.exclusive`),
so a new operation touches one service. The `game_unity_*` tools
are a curated front for `unity mcp`: a fixed allowlist of editing tools behind one
`game_unity_edit`, plus eval, recompile, play, screenshot and console; builds, tests, packages and
editor lifecycle stay with Kurambit's own operations. The live editor runs with one asset import
worker and `-job-worker-count 2` (the worker count is a per-user setting in
`UserSettings/EditorUserSettings.asset`, rewritten before every start), because Unity's default
three import workers cost about 0.7 GB each. Packaging, preview, stop and keep going's tools stay
outside their catalog.

## Builds and facts

- **A build is no record of its own.** [GameBuilds](../../apps/server/src/game/GameBuilds.ts)
  reads the rail each time from the turn checkpoints and the restore refs; a build's id is its
  commit. Every surface (its RPCs, the `game_builds`, `game_facts`, `game_build_restore` and
  `game_tune` tools) is one method of that service.
- **A turn's change is its own.** T3 diffs a turn's checkpoint against its thread's previous
  one, which in a game includes whatever another chat or a restore did in between. A turn build
  counts from the newest build of the game captured before the turn began.
- **Turn builds measure themselves.** On an engine whose profile has `turnLoop`
  (three.js; Godot and Unity are parked), `GameBuildsReactor` takes a chat turn's checkpoint
  that changed files and measures the turn's build in the background. A live-staged engine's
  Stage already shows the folder (Play sessions, above), so nothing is built for it. An engine
  whose Stage plays a Web export also has the folder's Web build made current, as the chat's own
  operation (`GameStage.playCurrent`), which the Stage remounts on; a stopped or cancelled turn
  is measured but not played. Freshness is decided inside the game's lock, and a fresh build is
  left as it is, so a turn that changed nothing playable never restarts a game the person
  stopped. Each thread's turns run forked, in order, off the event
  stream, so one game's wait for its lock never holds another's. Subagent turns are no builds of
  their own. A newer turn's measure drops an earlier turn's
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
  refused in a game's shared folder and would make the agent forget the attempt. A restore that
  moved the folder, and a kept edit, set the next-turn base of the game's chats to the folder they
  left, so a chat card and its Open diff count the next turn from there, as the rail does, and
  never list an undo as the agent's change. A live Stage shows
  a restore through its watch; on a turn-loop engine staged from a Web export, a restore plays
  what it brought back, through the same `playCurrent`.
  `folderEdited` compares the folder's restored paths, captured with T3's capture, against
  `current`.
- **A person's kept edit is a build too.** The Stage's Keep as a build (`keepValues`) captures
  the folder, writes the engine's tune file and captures it again, under `game-builds/edits/`:
  `<request>-values` is the build and `<request>-from` its base. It lists as a saved build with
  `edit`, joins `current`, and owns Undo while it is the newest (`ownsUndo`), as a turn does; the
  turn after it counts its change from it.
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
  The browser keeps what each backend printed to the probe, and a play drawn in software leaves
  the performance fact "not measured" with that output: a harness fault, never the game's.
- **On a GPU, the no-input and random-input plays share it.** Measured on the Iris Xe laptop
  (5 builds of 5 games, 3 runs each way): facts took 132 s alone and 70 s shared at the median,
  with no verdict changed beyond the run-to-run noise and no play re-played. A shared play whose
  reading sharing could explain is played again alone before it is stored (`sharedPlaySuspect`).
  In SwiftShader plays slowed from 1× to 0.08× real time beside each other, so there they take
  turns; the tester's bot always plays alone. Revisit only with new measurements.
- **Only a measurement is a fact.** A tool or machine fault is stored as "not measured": with
  `retry` when waiting can clear it, or as `standing` when it needs a person (their next measure
  tries it again). Tier endings are read from the shell's run state, never from a bot's word.
- **Facts skip what is already known or not needed.** The boot check is not run again when this
  server's own `game_check` booted the same bytes (engine folder and `game.json`) clean, and the
  tester's bot plays a chat turn's build only while keep going, which judges by it, is on; a
  person's measure and keep going's own measures always play it.
- **Going back with no run** makes the run's own moves (`withBuildInFolder`) under the
  `game-builds` run-ref folder. The record is written before the folder moves, and a restart
  settles a restore it cut short by running its moves again.

## Keep going

Keep going takes a game's next step itself, in the chat that turned it on. It is records of that
chat (`GameRun`, `GameRunStep`, and one `GameRunRound` per step with its
`step` record; [gameRunRecords.ts](../../packages/contracts/src/gameRunRecords.ts)), changed only by
`game-run.*` commands. One pure module
([decide.ts](../../apps/server/src/orchestration-v2/gameRun/decide.ts)) is both the policy and the
domain fold: it reads the records, decides the next step and when to keep, undo, pause or stop,
and its records and outbox effects commit in one transaction, so a retried command changes nothing
and a restart loses no decision. The orchestrator commits no command without an event, so even a
timer (a cap set again, a recovery wake) records itself on its step. A game has one run, reached from every chat of its project through `getProjectGameRun`;
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
  blocker, a retry of an undone step, a failing fact, the agent's next line. Only
  watched facts are proposed or guarded: motion, detail and colour are heuristics, and a space
  game's black sky must never cost a step. Of the scene report only buried bodies, the player in
  view and the empty view are watched, because the scene's geometry decides them (the empty view
  counts only flat backdrop below the horizon with nothing drawn on the ray, so a sky or a space
  backdrop seen level never counts, and it is a design regression a person's step may make);
  clipping, falling, the camera in a
  wall and sliding follow where random input led and how fast the machine ran it, and an undo
  must never hang on a path.
- **The look reads the folder's build.** The current build is the newest turn build that changed
  game files, or a later kept edit, restore target or bot setup point; turns that changed only notes are no builds,
  so it is found by walking the turns page by page however far back (`GameBuilds.currentBuild`),
  never in a fixed window. A folder whose game files are no build's (edited outside a turn) pauses
  the run, since a step's undo would take those edits.
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
- **Gain and stopping.** A step gains when it was kept, changed what a restore covers and made no
  watched fact worse; a closed target counts too (the person's own step, a kept retry). Two steps in a row without gain pause the run
  `stalled`; three steps in a row that never landed (a superseded proposal or turn, a turn that
  started on another build) pause it `stalled` with why, so no mix of supersedes and looks runs
  without bound, and a look after one takes the facts its cycle's look measured for the same build; two unmeasured steps in a row pause it `tool-failed`, since a broken measure would
  otherwise repeat at the game's cost. `Next: none` with nothing else to propose ends it `done`.
  The budget is checked before each turn against a typical step (8 min), and it is what bounds an
  Autopilot that keeps adding content. Every ending but `done` resumes.
- **Never repeat.** Each proposal has a key (`fact:<id>`, `steer:<fnv>`, `next:<fnv>`; a retry
  carries the undone step's). Two misses of a key (undone, or kept with its target still bad), any
  step that changed nothing (it is never sent again as it was), or Skip set the key aside for the
  run.
- **The play bot is setup, never a step.** A step must change what a person sees or fix a measured
  fault; the bot is the harness's instrument, and a step's turn re-reads the whole chat. So a look
  that finds a booting game with no play bot has it written once per run in a session of its own
  ([botSetup.ts](../../apps/server/src/game/run/botSetup.ts)): a `game-round.task.request` child
  of the chat's last finished turn (`completionWake: "never"`, so it never wakes the chat, and its
  checkpoint is no build). The look waits on the game being busy, caps each session, sends at most
  one fix-up session, and reports the outcome, which the run keeps (`GameRun.botSetup`); a failed
  setup leaves the skilled fact unmeasured and the run goes on. It decides only once the idle and
  random-input tiers have played: they play the skilled tier's span, so when they ran out of time
  because the harness draws in software (`tooSlowInSoftware`), the setup is kept as skipped
  instead. The kept setup point is the chat's next-turn base
  (`CheckpointService.nextTurnBaseRefForThread`), so the next turn's chat diff, like the rail,
  does not list the bot as its change.
- **An undo includes the bot.** `.studio/bot` (without the kits Kurambit writes) is in
  `restoredPaths`, the one rule for what a restore writes, what a build is and when the folder is
  edited, so an undo is exactly as before and a build's skilled fact is its own bot's. The setup's
  bot would then make the folder differ from its build, and undoing the first step would delete
  it: the setup instead keeps the folder as a hidden point (`game-builds/bots/<run>`, with `-from`
  naming the build it was written on). The point stands in the folder's history like a restore
  target (current build, and the next turn's base) but is no row of the rail, which shows `-from`.
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
  `recover` timer, behind whatever its thread still owes, and a run whose step it cannot schedule
  pauses with the cause rather than sit on it; a judge or undo a pause cut off runs
  again on resume. A step turn T3 carried over a restart that its run no longer wants (Off, an
  ended run, a step moved past) is interrupted, so nothing edits a game the person stopped.

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
changes. Taste stays with the person; the harness never judges it for them. Craft advice lives in the skill pack under `apps/server/templates/studio/` and the bot
kit under `apps/server/templates/bot-kit/`; both are copied into each game when a run starts, not the product.
A game gets only its own engine's skill file (`three.md`, `godot-game.md`, `unity.md`), and the pack is
refreshed between turns; a refresh deletes only Kurambit's own files by name (another engine's, or a
retired skill in `runSetup.ts`), never one the person or agent put there. Keep the pack to what code does
not already enforce: a rule a check, a strict tool or a template default holds belongs there, not in prose. A
resume keeps the run's copy, so every build of one run is made and judged under the same guidance and no
build carries harness text as its own work. `GameCreateInput.engine`
(`godot` when omitted on the wire; the app defaults new games to the first ready engine with `turnLoop`, three.js today; `three` for the browser lane, `unity`) picks the starter template (`blank` /
`blank-three` / `blank-unity`) and the scaffold (`godot/` Godot 4.7 project / `web/` static three.js
project that loads three.js r0.180.0 and the shell from Kurambit's runtime / `unity/` Unity 6000.6.7f1 project); `copyTemplateIntoGame` copies whichever engine tree the template ships.
The Godot starter's main scene is a genre-free demo shell (title, pause, settings, controls, end, credits)
and it ships the `Juice` feel kit, because weak builder models skip or break both when they write
them from scratch; the manifest's gameplay scene (`scenes/game.tscn`) is the seam the shell
instances, so the check boots both. The shell pauses with `SceneTree.paused`, which is why the
Godot play runner resumes the game's own pause after each act instead of forcing it off.
The shells carry the controls as named actions (the Godot InputMap, the three.js runtime's `shell/controls.js`,
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
The three.js shell does the same: it owns the render loop and calls
the gameplay module `web/main.js` through `start`/`update`/`stop`. Its page opens on the title,
so the template's `gameplayScene` is `index.html?play` (boots straight into a run) and the
three.js check loads that entry after the plain page, like the Godot check runs `game.tscn`. The manifest's
`godotProject` names the engine project directory for every lane (`web` for three.js, `unity`), so snapshots,
exports and the run resolve it unchanged. A run takes the lane (the engine directory) from the
manifest, and every engine question the run has is the lane's engine profile.

### The three.js runtime

A three.js game does not carry the shell or three.js. They live once in
`apps/server/templates/runtime/<engine>/<major>/` ([gameRuntime.ts](../../apps/server/src/game/gameRuntime.ts)),
and `game.json`'s `runtime` pins a major per engine (`{ "three": 1 }`). The game's import map
loads `_kurambit/runtime/three/1/`, and maps the game's own `./shell/` and `./vendor/` imports
there, so the recipes and skills read the same for a game with its own copy. The shell loads
`main.js` through the import map's `#main`, since a relative import from the runtime would
resolve inside the runtime.

- Every game server answers that path through `serveGameDirectory`'s `runtimes` option: the
  live Stage, the check, bot and explore plays, and build copies. A selected export is served
  without it, because the export holds the runtime as files (`copyRuntimeInto`); that is what
  lets a release run from any static server, licences and provenance included.
- Within a major, the API `main.js` uses stays backward compatible, and a minor or patch reaches
  every game of that major on its next load. Bump `runtime.json`'s version with each change. A
  breaking change is a new major folder; the old majors keep shipping, since games pin them.
- The URL names only the major, so runtime files are served `no-cache` with a stat ETag rather
  than immutable: a reload revalidates (304) and keeps the browser's compiled modules.
- Facts record the runtime the plays loaded (version and file digest), and two builds measured
  under different runtimes are not comparable, as with different renderers.
- Games made before the runtime keep their copied `web/shell/` and `web/vendor/` and no
  `runtime` key; nothing in the server converts them. Their facts carry no runtime.

Two constraints hold everywhere:

- Nothing opens on the user's desktop. Every game process drops `DISPLAY`, `WAYLAND_DISPLAY` and
  `XAUTHORITY`; its window comes from the window host, and its pictures from the engine.
- No test suites for the game layer beyond data-safety checks; games are played, not asserted.
