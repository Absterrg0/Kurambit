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
- The live editor (Blender with its pinned MCP addon per game) runs on private displays with session.json launch records, reaping and idle shutdown
  (`liveProcess.ts`, `liveEditor.ts`). A session something showed unusable (its MCP child exited,
  a call timed out on a frozen main thread) closes when its last holder lets go, and the next call
  opens a fresh one; a session whose source on disk changed since it last opened or saved it
  (Blender's live.blend) reopens instead of saving over it. A start cut short
  stops what it launched. A record is acted on only while its process still verifies as the launch
  (below) and its command line names the executables the live toolchain would launch now, never
  paths from the record; of the editor's process tree only processes running from a detected
  editor's directory or Xvfb are signalled.
  The editor keeps a copy of its record under the server state dir, reaped at startup, so a
  crashed server's editor dies even if its game is never reopened. Blender runs under its own
  user-folder override (`BLENDER_USER_RESOURCES`) and installs the addon where Blender itself
  says its user addons live, so no version or OS layout is assumed. Every call or operation holds the
  editor; another game's open closes it only while it is idle, and fails `busy` naming the holder.
- `GameToolchain` detects the user's own Blender, and an engine's own tool where its profile names
  one (three.js needs none), the way providers are detected, and never installs them: they are
  other vendors' software with their own upkeep and licences on every OS. It fetches only harness
  plumbing (uv) itself, through `downloadPinned`
  against vendor-published sizes and SHA-256s.
- Every process the game layer starts goes through one process host
  ([processHost.ts](../../apps/server/src/game/processHost.ts)), the only per-OS process code. A
  child carries a fresh launch token in its environment (and on its command line where the program
  ignores extra arguments: Blender), and its launch record is pid, OS start time
  and token. A record is signalled only while the live process has that start time and carries that
  token, so a reused pid or a record an agent wrote never names another process. A tree is a
  process group on Linux and macOS; on Windows every owned child joins one kill-on-close Job Object
  held by a helper whose stdin is the server's pipe, so the tree dies with the server however it
  exits. A tree stop on Windows ends the root and its descendants pid by pid, never `/T`. Free memory is `os.freemem()` (libuv's MemAvailable
  on Linux). Every game page closes with its browser, so a crashed server leaves no game running;
  only the live editor outlives it, and its record reaps it.
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
  their own (animals, creatures, vehicles) names no rig: each model comes with its own clips.
  Made characters share the `standard-humanoid` skeleton, so
  every standard clip plays on every made or library body on it.
- `STYLE.json` at the game root records the game's look (`packages/contracts/src/gameStyle.ts`),
  read by `gameStyle.ts` on every call of every tool that brings art in, and never cached, so an
  edit takes effect at once. `game_assets` op `add`'s optional `lock` writes it from a style family
  (`styleFromLock`), so agents never hand-write its shape. Tools fill defaults from it (sprite
  palette and views, export budgets, loudness targets, the clip packs a character gets) and search
  ranks its packs first, but nothing is refused for falling outside it: refusals that kept a game
  inside a family the harness picked decided the look for the agent, which is its and the
  person's. The rig exists only so library clips fit every character, so an armature marked on its
  own rig (`kurambit_rig`) plays its own: the mark stands when a creature generation of this game
  delivered the armature, or, with no generation named, when it carries clips of its own and none
  from the library (`ownRigRefusal`). A STYLE.json that is a link, not JSON or names unknown
  library ids fails every art tool with the field. It is a game file, so checkpoints carry it and
  a run's restore brings it back with the art (`restoredPaths`). How a game's
  models are made (code, Blender or generated) and whether the free library's models may come in
  are the person's choice, kept in `game.json` (`characters`, `library`) rather than STYLE.json, so
  they can be set before the first turn writes one; the tools enforce them, and the agent changes
  them in `game.json` only when the person asks. A keep-going step is no one asking: its
  `game-run.step.start` records the choice its turn started under on the step
  (`GameRunStep.models`), its art and Blender ops refuse a `game.json` whose choice has moved, and
  when its turn is over `GameRunTurnReactor` puts the two fields back, read from the record so a
  restart changes nothing. The Game panel's change is refused while a step turn works
  (`GameRunControl.setModelChoice`), since the step's end would undo it. The code route
  is written as no `characters` key, so an older install, which knows only `library`, `blender` and
  `generated`, still opens the game; a game.json with no `library` key predates the switch and
  keeps its library on (`gameModelChoice`).
- Made characters are conformed, not retargeted: `game_blender` op `character` fits the standard
  armature to the body once, keeping the standard rest frames, so library clips play unchanged
  and a body off those frames is refused at export rather than playing broken. An asset ships
  only as reviewed: `game_blender` op `look` mode review runs the style pass and measurement in a
  separate one-shot Blender on a saved copy of the live scene, and `game_blender` op `export` writes
  exactly that candidate or refuses when the scene changed since; a refusal is only for what the
  agent or person must change, while the pass fixes what it can (it scales over-budget textures
  and says so). Where the player downloads the GLB itself (three.js, `compressedModels` in the
  profile) the pass writes WebP images and the export then meshopt-compresses the geometry with
  gltfpack: Blender cannot import meshopt, so the review measures the uncompressed candidate and
  the sidecar names the shipped bytes and triangles, which keeps the asset fact valid. The asset is its sidecar `<name>.asset.json` (skeleton, clips with ground speed,
  springs, height, source and licence), which the three.js shell reads from `ASSETS` and which
  another engine can read later; GLB extras are not used because native engines drop them.
  Painting from a sheet (`game_blender` op `paint`) and carving (`game_blender` op `carve`) run in a
  one-shot Blender too, since their bakes outlast the live server's 180 s per command; the live
  scene only adopts the result, after checking its objects did not change meanwhile.
  `game_blender` op `animate` compiles a move spec in the live scene itself (a pass takes seconds) and keeps
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
  (`threeProfile.ts`, read through `engineProfile.ts`) is pure data the services, the client
  tables and the run's pure policy share: directories, its releases (target, artifact, whether it
  ships as a file or a folder, whether Kurambit packages it), how its games play, check messages,
  its tool descriptions, skill and prompt lines. Its driver (`GameThreeEngine`, registered in
  `GameEngine` as a `GameEngineBackend`) holds the behaviour that differs: the project, its tool's
  status, viewport, import, check, writing one release into a staging folder and checking its own
  files, replays and model sheets. A per-engine table outside a driver is a
  `Record<GameEngineId, …>` (`GAME_ENGINES` in contracts, the profiles, the capabilities), so a new
  engine does not compile without its entries. Adding one is: its `GameEngineId` literal and
  `GAME_ENGINES` entry, its profile and driver, its template (`templates/<id>/` plus a
  `GAME_TEMPLATES` entry) and studio skill, and, if it needs a program of its own, a
  `GameToolName` and its detection in `GameToolchain`. The Stage kinds (`live`, `export`,
  `window`) and the play-session protocol below are already engine-neutral. The three.js look's
  default draws straight to the canvas, as a plain three.js frame does, so a first build costs
  what it always did; its post chain (AO, bloom, SMAA) runs only for the presets and options that
  ask for it, and a browser drawing in software always takes the straight path, where full-screen
  passes cost several times over. The game is known by its manifest's engine id (and its project
  folder by `manifestProject`), never by the folder's name; a run records the engine it started
  with (`runEngine` derives it from the lane for older records).
- Stored records name engines this version does not have: earlier versions made Godot and Unity
  games, and their `game.json`, facts rows, run records and events say so. Every schema that
  decodes stored data reads `GameEngineName` (every engine ever named); `GameEngineId` is only the
  engines this version runs, and `isAvailableEngine` narrows one to the other. Such a game still
  opens with its chats, builds and history; engine work on it is refused `engine-parked`
  (`unavailableEngine` in `engineProfile.ts`, worded "not available in this version"), its tool is
  not looked for, and its agent gets no engine tools. The reason keeps its old literal because
  stored errors and clients already decode it.
  The game tools an agent is listed follow from the same data. There are six, each one schema
  whose keys are its ops ([gameTools.ts](../../packages/contracts/src/gameTools.ts)); the op is the
  key rather than a tagged union because providers refuse a tool input that is not one object at
  the top. [placement.ts](../../apps/server/src/mcp/toolkits/game/placement.ts) says what each op
  needs of the engine (`engineCapabilities`, derived from the profile, empty for an engine this
  version does not have).
  A tool is listed from a game thread's first turn whenever the game runs any of its ops: its
  engine, and for `game_blender` the person's model choice (the routes that make models in
  Blender: blender, generated and code with the library on), so a code chat never reads Blender's
  schemas. A missing Blender never changes the listing. An op the game
  or machine cannot run is refused when called, with why. A retired tool name stays registered,
  never listed: the MCP auth middleware reads a `tools/call`'s name from the request body
  (`calledTool`), only that call can see the retired name, and it answers with the tool and op
  that do its work now. Clients that kept an older listing reach it; the rest refuse an unlisted
  name themselves.
- A game thread's provider session gets Kurambit's MCP server and the provider's built-in tools,
  never the person's own MCP servers, account connectors or synced account skills
  (`kurambitToolsOnly` on the turn input): they cost context on every call and could reach the
  person's mail or files. Claude enforces it with its strict MCP config and per-invocation
  settings; Codex, Cursor, Grok, OpenCode and Antigravity have no per-session way to drop the
  person's servers yet, so there it is not enforced.
- Every release takes one path (`GameExport`'s `releaseTo`): staged beside its destination,
  written and checked by the driver, compared with the sources before and after (an
  unidentifiable tree is refused before the engine runs), then published by `publishStaged`, which
  moves the incumbent aside and puts it back on any failure. A Web build becomes the
  content-addressed candidate Play selects, and only the selected build and the one before it are
  kept, with their preview servers. A crash between the two renames leaves a `.retired` copy with
  no final, which the next export's sweep puts back. The check's verdict is `GameEngine.check`:
  everything the game did is a check error or warning, and it fails only when a tool or the
  machine kept the check from being made. A harness fault is `tool-failed`, never
  `command-failed`. three.js owns a headless-Chromium boundary: import is a no-op, the check loads
  the page (a page crash is the game's, a lost browser a tool's), the release copies the folder.
- Web play shares the services: the browser host (`webPlaySession`) opens real-time
  headless-Chromium sessions on the served static folder (real keyboard/mouse, the read-only
  `window.__studio` probe, console and page errors; no pause between acts). `gameChromium`
  takes T3's pinned headless shell from `PreviewBrowser` (installed on first use, sandboxed as
  preview is, so three.js needs no browser on the machine) and holds the `__studio` snippets; `gameWebServer` serves a game-relative directory over loopback for check/explore/bot
  without touching Preview state.
- `game_play` op `start` plays the game's own lane. The same content-addressed export machinery
  (hash, compare, move into place, select) serves exploration and Play; the expected-files check
  is engine-aware.

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
own clock on every engine: it stops while the game pauses itself (a page sums its frames'
clamped deltas).

- three.js has no runner process. The browser host speaks the protocol to the page through the
  shell's `window.__studio` bridge, which the game owns and may have edited, so the protocol stays in
  the server instead of the page. Pages read no control tree: no ui or inspect steps, and a bot's
  id-clicks are skipped and counted.

Pictures and video belong to the engine, never the OS: from protocol 2 a bot run asks `realtime`
for frames, which the browser host streams from the CDP screencast. Each frame carries the
engine's own drawn-frame counter. [frameVideo.ts](../../apps/server/src/game/frameVideo.ts) pipes
them into one ffmpeg on a wall-clock grid, repeating the last picture in a slot with no new one, so
a game that draws slowly or stops looks exactly like that, and writes `run.frames.json` beside the
video with each frame's counter, game time and arrival (the evidence route is `engine-frames`). The
run's end frame is the session's own `still`. A native engine would add a process runner speaking
the same protocol over a loopback socket; earlier versions had one for Godot and Unity, and git
history keeps it.

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
live serve. An `export` engine would play the selected Web export, rebuilt when stale, and a
`window` engine in its own window; both kinds are kept for the next engine.

The Stage talks to a live three.js game through the **Stage bridge**
([gameStageBridge.ts](../../packages/contracts/src/gameStageBridge.ts)): `postMessage` objects both
ends decode, since the game runs on its own origin. The game end is the shell's
`stage-bridge.js`, inert until the Stage's first message, so plays and recordings never trace or
outline. A game announces the bridge in `studio-ready`; a shell from before it posts a bare
`studio-ready`, and so does the current `studio.js` refreshed into it as a harness file, which is
why `studio.js` takes the bridge only as an optional input from `shell.js`. An engine without a
bridge says so with a null `tuneFile` and `stageBridge: false`.

So the harness needs exactly two things from an OS: a **process host**
([processHost.ts](../../apps/server/src/game/processHost.ts), above) and a **window host**
([windowHost.ts](../../apps/server/src/game/windowHost.ts)): one `launch(command, viewport)` that
gives a program a window it draws into, which the user never sees and which never takes focus.
The live Blender launches through it today. On Linux every launch gets its own Xvfb display,
which Xvfb picks itself (`-displayfd`); the display outlives its command and ends right after it
(a program that loses its display mid-quit can hang in Xlib's exit path), so a program that quits
because its server died takes its display along. Windows and macOS give an app no private display
(a virtual monitor needs a driver there; macOS's API is private), so the window opens on the
user's desktop far off every monitor, never minimized (a minimized window can stop drawing), and
the launched program places it: Blender by `--window-geometry` with `--no-window-focus`. It never
falls back to the user's display on Linux. Plumbing Kurambit fetches (uv) comes from one
per-OS/CPU table of official builds with their published SHA-256
([plumbingBuilds.ts](../../apps/server/src/game/plumbingBuilds.ts)).

## Tools

Agents reach the services through the `game_*` MCP toolkit; the client reaches the same services
over RPC. A tool and its RPC twin call the same method of the service that owns the operation
(GameBlender, GameExport, GameStage, ...); there is no facade between them. Thread-keyed methods
resolve the thread's game and take its operation lock themselves (`GameProjectService.exclusive`),
so a new operation touches one service.

A game's own `AGENTS.md` holds only its engine's guidance. The harness's rules travel with the
turn instead, so changing them needs no migration of games already made: the first turn's steps
are in the first message (`firstTurnMessage`), and every turn's rules (`gameTurnRules`) go in the
turn input's `harnessInstructions`, which run execution fills from the cwd's `game.json` and each
adapter sends where it sends the orchestration text. The MCP `initialize` instructions cannot
carry them: Codex keeps about its first line, Claude cuts at 4,096 characters, Grok at 2,048.
Codex also cuts each `additional_context` value past 4,000 bytes, so long texts go in several keys
(`codexContextEntries`). The rules must change rarely: Claude reads them into the system prompt
of a process it keeps across turns, and Cursor sends them on the first prompt only. What changes
every turn, the person's runs since the last one (`personRunsForWorkspace`), goes in front of the
turn's message text instead, which every provider reads each turn.

What the person decided (an undo and their next message's first sentence, tuned values kept, a
step skipped, `/remember` notes) is a harness record, not a reasoning skill: a fresh session
cannot know it, so `.studio/decisions.md` keeps it (`GameDecisions.ts`), outside `restoredPaths`
so an undo never rewinds it, written only by the harness and by the person's own edits. It rides
beside the message too, as `<kurambit_game_decisions>`. A session that starts fresh (no turn of
its native session yet: a new chat, a keep-going step, a failed resume) or whose last turn began
before this server did gets all of it, newest first; one that goes on gets only entries stamped
since its native session last started a turn (`sessionLastTurnAt`), which is why each entry
carries its time in a trailing comment the person never needs to touch. A line someone wrote by
hand has no stamp, so only fresh sessions read it.

## Builds and facts

- **A build is no record of its own.** [GameBuilds](../../apps/server/src/game/GameBuilds.ts)
  reads the rail each time from the turn checkpoints and the restore refs; a build's id is its
  commit. Every surface (its RPCs, `game_builds`' list, compare and restore, `game_check`'s
  facts) is one method of that service.
- **A turn's change is its own.** T3 diffs a turn's checkpoint against its thread's previous
  one, which in a game includes whatever another chat or a restore did in between. A turn build
  counts from the newest build of the game captured before the turn began.
- **Turn builds measure themselves.** On an engine whose profile has `turnLoop`
  (three.js), `GameBuildsReactor` takes a chat turn's checkpoint
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
  a startup reconcile re-measures any row that still owes a tier. Exports, checks, explore,
  and Play's freshness key the working folder the same way: the engine folder's
  tree in a capture of the working tree ([sourceTree](../../apps/server/src/game/sourceTree.ts)),
  never a walk of our own. Git records a link, not what it points at, so a link in the engine
  folder makes the sources unknown there.
- **Saved plays are tests outside the build.** A run someone saves (`.studio/plays/`, committed,
  outside `restoredPaths` so an undo never takes a test) is replayed by every build's measure in
  its copy, inside the lane, right after the boot check; keep going's judge waits for it with the
  boots. The plays live outside the engine folder, so the reading stores a hash of the saved set
  and is measured again when the set changes, without a harness bump; rows from before it and
  games with none read `no-saved-plays`, which no surface shows or counts and no reconcile owes.
  A save is refused unless the run replays the same on its own build: during a step the shell
  pins `Math.random`, `performance.now` and `Date.now` to the run's seed and game time, and what
  a game reads outside that would make every reading noise. A changed ending is proposed as the
  next step and never undone (only health undoes): it may be the change the person asked for.
- **Resume and rewind hand a replay over instead of ending it.** The Stage's `studio-replay`
  replays a run to a step, then the shell turns the replay into the live run there, frozen: the
  recorder continues from what was replayed (`continuation` in shell/replay.js), so a reloaded or
  rewound run stays one recording that replays the same on that code. Before any reload into play
  the Stage takes the run from the old page (`studio-run-take`, the page then keeps nothing on
  leaving) and keeps it as left; the run that goes on shares its seed and clock and replaces it in
  the agent's runs, while a fork carries `fork` and counts as a run of its own. A play keeps the
  starting value of each value tuned during it (`tunes`): without them a replay starts from the
  tune file, which already holds the tuned value, and the run can never replay the same.
- **Game browsers draw on the GPU.** Once per server process, `makeGameBrowser` probes the pinned
  headless shell for a hardware WebGL backend (Linux: EGL, then Vulkan, on the GPU's render node,
  with no display in its environment) and every game browser launches with the first that drew on
  hardware, else SwiftShader. SwiftShader costs several cores on a lit 3D scene and plays it at a
  fraction of real time, so a facts row records its renderer, facts from different renderers are
  not comparable, and a too-slow run in software is "not measured", never the game's slowness.
  The browser keeps what each backend printed to the probe, and a play drawn in software leaves
  the performance fact "not measured" with that output: a harness fault, never the game's.
- **One play lane, by who waits.** A build's measure and `game_check`'s play each hold the
  server's one [play lane](../../apps/server/src/game/playLane.ts), so no two of them share the
  GPU and none of their readings needs a "shared" caveat. Holds go to an agent's check, then a
  person's measure, then a chat turn's, then the rest, first asked within each. A holder that a waiter outranks is interrupted at once and runs
  again from its row on its next turn, so a half-played tier is never a fact, and the waiter
  waits only for that teardown (a bot run's stop, bounded in GameBot) plus the holds of its own
  rank ahead of it. An agent's `game_play` op `bot` and explore sessions are outside the lane, and
  another program on the GPU is not visible to it.
- **Only a measurement is a fact.** A tool or machine fault is stored as "not measured": with
  `retry` when waiting can clear it, or as `standing` when it needs a person (their next measure
  tries it again). Tier endings are read from the shell's run state, never from a bot's word.
  A reason that changes what a person is told or what the harness does next carries a `cause`
  literal beside `why`; the client words the cause and the harness branches on it, and neither
  reads meaning out of `why`, which is the agents' text and free to change.
- **Facts skip what is already known or not needed.** The boot check is not run again when this
  server's own final `game_check` (op `final`, the one that also plays the scene report and the
  QA play) booted the same bytes (engine folder and `game.json`) clean, and the play bot plays a
  build only when asked (below).
- **Going back with no run** makes the run's own moves (`withBuildInFolder`) under the
  `game-builds` run-ref folder. The record is written before the folder moves, and a restart
  settles a restore it cut short by running its moves again.
- **A try's versions never write the game folder.** "Try N ways" is a chat turn the harness does,
  never the chat's provider: `ProviderTurnStartService` hands a run with `versions` to the game
  layer (`GameTries`, attached by [GameVersions](../../apps/server/src/game/GameVersions.ts)),
  which captures the folder as the try's base and adds a detached git worktree per version, then
  `game-version.start` makes the version children (the delegated-task path, wake `never`, so each
  is read-only once made) and completes the turn in one transaction. A version's `game_*` tools
  resolve its worktree, with its own operation lock, so only Keep moves the folder: the one
  restore, then a `system_notice` on the try's run that records which version was kept and when
  (the rail reads the newest one to give that version Undo) and a `kept-over` decision. A try is
  no record of its own ([gameTries.ts](../../apps/server/src/game/gameTries.ts)): version n's
  thread id derives from the try's run, and its refs are keyed by the chat and the run's ordinal,
  since a run id passes a ref name's 255 bytes. T3's recovery cancels a version's turn without a
  checkpoint, so a worktree is removed only once its work is a build: its checkpoint, or a capture
  of what it left (`versions/left/`).

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

- **A step is an ordinary chat turn, in a fresh provider session.** The cycle is look, then
  (Guided) a proposal, then the turn, a judge, maybe an undo, then the step's record, then look
  again. The turn is a message the run posts into the chat with `freshContext`, so a step does not
  re-read the whole chat (one step read 7.8 M tokens that way); the message carries a compact
  briefing instead (BRIEF.md, the chat's last reply, the facts, the steps so far). `freshContext` is
  T3's own fresh native session on the thread's provider thread, the one a failed resume falls back
  to (`ProviderTurnStartService`), and the thread's next run without it resumes the native session
  its own runs used and gets the fresh runs as missed runs, so the person's chat keeps its session.
  Its id names the step and attempt
  ([ids.ts](../../apps/server/src/orchestration-v2/gameRun/ids.ts)), which is how the reactor, the
  strip and the timeline know a turn is a step. Everything phases 1 and 2 give a turn (its build,
  facts, strip, Redo, timeline mark) a step gets for free; the run adds only the choice of message,
  keep or undo, and when to stop.
- **The proposal costs no tokens.** The policy writes the step from the facts' own wording and the
  chat's newest `Next:` line, so a reply without one never wipes the plan (one parser, `packages/shared/src/gameNextLine.ts`, so the person sees in
  the Next banner exactly the line the run will use), in a fixed order: the person's notes, a
  blocker, a retry of an undone step, a failing fact, the agent's next line. Only
  what a player would hit is proposed (errors, controls, Retry, HUD, other screen sizes), and only
  health (boots, errors) undoes. A build is measured only for what a person acts on: it boots, the
  QA play and the game at phone and widescreen, one random-input play for errors, freezes and
  frame rate. Endings with no or random input, motion, input response, the scene report's rows and
  asset counts were cut: nobody acted on them, and the plays cost minutes between steps.
- **Nothing between steps waits on a play.** The look reads the facts measured on the folder's
  build so far, so step 1 starts at once from the newest `Next:`. The judge waits only for the
  boot check and the QA play (`upTo: "boots"`), usually the step's own clean `game_check` on the
  same files; the random-input play goes on behind the next step. While the current build's play
  has no reading yet (queued, playing, or dropped for a newer build), the look also reads the build it was made from (`earlier`), so an error that
  play found there is the next blocker rather than an undo. **The look reads the folder's build.** The current build is the newest turn build that changed
  game files, or a later kept edit or restore target; turns that changed only notes are no builds,
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
- **Only health undoes.** A step is undone when it stops booting or errors in play, as far as the
  judge measured. Every other fact is shown on the record and proposed when bad, never guarded:
  one noisy run of a check is not evidence to throw away work, and guarding them biased steps away
  from bosses, harder waves and new verbs. Health is a
  crossing into bad on a comparable delta, never a change: a fact already bad that gets worse is
  the next blocker; not-comparable (another harness, renderer or bot) never undoes. The reason is
  written for a person ("it stopped booting: …") and reaches the next step's briefing.
- **The undo cannot hurt the person's work.** It is `GameBuilds.restore(base, { expect: build })`:
  inside the game lock the folder moves only while it still holds the step's build unedited, else
  it is refused `moved-on` and the record reads "the game changed after it". A step the person
  undid first counts as undone.
- **Gain and stopping.** A step gains when it kept a change: kept (or kept unmeasured) with game
  files changed. Nothing more is claimed: whether a kept boss helps the game is the person's taste.
  The record's line is the step's reply's first sentence, so it names what the step did. Two steps
  in a row without gain pause the run
  `stalled`; three steps in a row that never landed (a superseded proposal or turn, a turn that
  started on another build) pause it `stalled` with why, so no mix of supersedes and looks runs
  without bound; two unmeasured steps in a row pause it `tool-failed`, since a broken measure would
  otherwise repeat at the game's cost. `Next: none` with nothing else to propose ends it `done`.
  The budget is checked before each turn against a typical step (6 min), and it is what bounds an
  Autopilot that keeps adding content. Every ending but `done` resumes.
- **Never repeat.** Each proposal has a key (`fact:<id>`, `steer:<fnv>`, `next:<fnv>`; a retry
  carries the undone step's). Two misses of a key (undone, or kept with its target still bad), any
  step that changed nothing (it is never sent again as it was), or Skip set the key aside for the
  run. Across runs and chats, the look also reads the keys of what the person undid, went
  back from or skipped from the game's decisions (`decidedKeys`), and passes over them the same
  way: a person's undone turn carries the `next:` key of its request, so the Next line it acted on
  is not proposed again.
- **The play bot plays only when asked.** Writing one cost 4 to 10 minutes between steps and its
  one real-time run was noise, so no build's measure and no step plays it. The person asks with
  Measure again in the Workbench's Checks, or asks their agent to prove the game can be won: it writes
  `.studio/bot/play.mjs` with the bot kit, wins one run with `game_play` op `bot`, and calls
  `game_check` op `facts` with `skilled: true`. Otherwise the skilled fact reads not measured with why
  (`deferred`, `no-play-bot`). `.studio/bot` is in `restoredPaths`, so an undo keeps the build's own
  bot. Games from earlier runs keep their `game-builds/bots/<run>` setup points, which list as the
  build they were written on.
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
  proposal's deadline wait minutes on the chat, so keep going enqueues its timers with
  `holdsThread: false` and a pending one holds nothing back
  ([EffectOutbox.ts](../../apps/server/src/orchestration-v2/EffectOutbox.ts)); otherwise the
  person's own turns would wait out every cap. Each timer checks the run again when it fires.
- **Recovery** (`GameRunRecovery`, at startup): a step whose job died gets it again through a
  `recover` timer, behind whatever its thread still owes, and a run whose step it cannot schedule
  pauses with the cause rather than sit on it; a judge or undo a pause cut off runs
  again on resume. A step turn T3 carried over a restart that its run no longer wants (Off, an
  ended run, a step moved past) is interrupted, so nothing edits a game the person stopped.

`game_blender` op `sprites` exists because weak models cannot write sprite framing: their
renders cropped heads, drifted across a walk cycle and came out near-black. It fits one fixed
orthographic camera per view to the subject's evaluated geometry across every frame, renders in a
throwaway scene that links the live objects (the live scene and its .blend never change), and
batches renders because the pinned server gives each Blender command 180 s. The pixel-art pass
(downscale, hard alpha, one palette for the whole strip, outline) runs in the server in
`spriteRender.ts`, so the same renders always give the same bytes.

## Why this shape

A model left alone grades its own work, stops when it feels done, and says it tested things. The
harness makes the facts true regardless of what the model says: every turn's build is played and
measured by the harness's own bots (boots, the QA play, a random-input play),
and keep going undoes a step that broke the game's health and stops when steps stop landing
changes. Taste stays with the person; the harness never judges it for them. Craft advice lives in the skill pack under `apps/server/templates/studio/` and the bot
kit under `apps/server/templates/bot-kit/`; both are copied into each game when a run starts, not the product.
A game gets only its own engine's skill file (`three.md` today), and the pack is
refreshed between turns; a refresh deletes only Kurambit's own files by name (another engine's, or a
retired skill in `runSetup.ts`), never one the person or agent put there. Keep the pack to what code does
not already enforce: a rule a check, a strict tool or a template default holds belongs there, not in prose. A
resume keeps the run's copy, so every build of one run is made and judged under the same guidance and no
build carries harness text as its own work. `GameCreateInput.engine`
(`three` when omitted, `DEFAULT_GAME_ENGINE`; the app defaults new games to the first ready engine
with `turnLoop`) picks the starter template (`blank-three`) and the scaffold (`web/`, a static
three.js project that loads three.js r0.180.0 and the shell from Kurambit's runtime);
`copyTemplateIntoGame` copies whichever engine tree the template ships. The three.js shell carries
the controls as named actions (`shell/controls.js`) that players rebind on the Controls screen;
every default keeps a keyboard key, because explore acts and bots press keys by name and cannot
reach an action bound only to a gamepad.
The three.js runtime owns the render loop too and calls the gameplay module `web/main.js`
through `start`/`update`/`stop`, because fixed steps, seeded chance and recorded input are what
replays, the Stage's freeze and the QA play stand on. It draws nothing a player sees: a new game
starts as an empty page (the template is the bridge's `index.html` and `tune.json`; the game server
answers a missing `main.js` with an empty module so the page boots) and draws its own title, HUD
and look, entering its title through `GameState.title()` in `start`. A game made on the older demo
shell is told apart by markup, since its `game.json` looks like any other: its page carries all of
that shell's `section.screen` elements. The runtime refuses such a page before it runs anything,
and the server reads the same markup (`carriesOldShell`) so the game opens like one in a parked
engine: status carries the message, Play and Keep going refuse. The template's
`gameplayScene` is `index.html?play` (boots straight into a run, past any title) and the three.js
check loads that entry after the plain page. The manifest's `project` (or `godotProject`, its
legacy name in older games) names the engine project directory (`web` for
three.js; `godot` or `unity` in older games), so snapshots,
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
- Within a major, the bridge `main.js` uses stays backward compatible, and a minor or patch
  reaches every game of that major on its next load. Bump `runtime.json`'s version with each
  change. A breaking change is a new major folder; the old majors keep shipping, since games pin
  them. The one exception: 1.7.0 dropped the old demo shell from major 1 rather than starting a
  major 2, because its games are refused whole (above), so no game that still runs sees the break,
  and a major 2 would have stranded every bridge-contract game pinned to 1.
- The URL names only the major, so runtime files are served `no-cache` with a stat ETag rather
  than immutable: a reload revalidates (304) and keeps the browser's compiled modules.
- Facts record the runtime the plays loaded (version and file digest), and two builds measured
  under different runtimes are not comparable, as with different renderers.
- Games made before the runtime keep their copied `web/shell/` and `web/vendor/` and no
  `runtime` key; nothing in the server converts them. They are old demo-shell games too, so they
  open without playing.

A person's look edits from Art are tuned values of the thing's look id, `look:<thing id>`, in
`tune.json`, not a file of their own: the Stage's tuning path (fold into one build, put back,
Undo, the decisions line) then holds for them unchanged, and the runtime applies them when the
game names the thing ([look-edits.js](../../apps/server/templates/runtime/three/1/shell/look-edits.js)).
A material is keyed by its place among the thing's materials and its name, never by reference:
the game makes new materials each run. Palette materials are shared across things, so an edited
one is cloned for that thing's meshes alone. Scale and turn sit on the object only while a frame
draws, because games set their things' transforms themselves. A thing's parts (`Island › Cabin`)
are registry records like any thing, so picking, portraits, chips and looks all key by that path.

Two constraints hold everywhere:

- Nothing opens on the user's desktop. Every game process drops `DISPLAY`, `WAYLAND_DISPLAY` and
  `XAUTHORITY`; its window comes from the window host, and its pictures from the engine.
- No test suites for the game layer beyond data-safety checks; games are played, not asserted.
