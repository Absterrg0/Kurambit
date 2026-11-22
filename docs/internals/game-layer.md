# Game layer

> For maintainers. The code lives in `apps/server/src/game/`, `apps/server/src/mcp/toolkits/game/`,
> `packages/contracts/src/game.ts`, `apps/web/src/components/game/`.

A new game is a chat: its first message is the brief, and every turn that changes the game is a
build (the turn's T3 checkpoint). On engines whose profile has `turnLoop`, the harness plays that
build on the Stage and measures its facts in the background. Undo reverses one build's change
against the build it was made from (`base`), keeping later builds. Keep going is a run on top of
the same turns. The harness, not the model, owns every
check that matters.

## Decisions that span the services

- Game operations are exclusive per game (`GameOperations.exclusive`) and reported as events, so
  the Game panel and the agent tools see the same operation, and a second operation on a game
  refuses as busy rather than racing the first. A restore's folder moves (captures, restores,
  kept names) run as operations of the game, taking the operation lock and then the checkpoint
  workspace lock; T3's turn captures take only the latter, so the two never wait in a cycle.
- **One writer per game folder; a second writer waits or works in a copy.** A chat's turn writes
  the game folder only while no other chat's turn is at work there; a chat and the subagent
  threads it delegated to share one slot ([GameFolders](../../apps/server/src/game/GameFolders.ts)).
  The claim is made at T3's turn admission (`TurnAdmission`), which every message surface passes
  before its turn commits, under one lock per folder, so two chats sending at once are decided in
  order; the claim stays live while its chat has a run at work and for a short grace before its
  run commits, and after a restart the projection's runs are the truth. A turn that would be a
  second writer commits as T3's own held queued run with a reason (`queueHeldReason`) and starts
  through `queue.resume` when the folder frees; a folder move (a bring-in, an undo, a restore, a
  held kept edit) holds the folder too. Nothing copies on its own: **Run in a copy** is the
  person's choice, and an agent's `delegate_task` with a worktree, `thread_launch` with one and
  the worktree handoff make copies because someone asked. A child delegated without a worktree
  shares its parent's slot, so a parent's turn ending while its child works keeps the folder
  claimed until the child's run ends.
- **A copy is a chat in a T3 worktree, seated on a recorded build, and comes in only by Bring in**
  ([GameCopies](../../apps/server/src/game/GameCopies.ts)). Game projects set T3's `worktreeSeed`
  to `working-tree`, so every worktree path seats on a capture of its source folder's files (in a
  game all work is uncommitted, and `HEAD` is the empty scaffold), and the capture is the thread's
  seed ref, its seat. The seat is never inferred: a three-way merge from any other base silently
  drops the game's newer work without a conflict. It moves only by Update. A copy is sticky, so a
  provider session keeps its directory, and a turn's build is recorded in the folder its chat
  worked in as it landed; the move in and out is kept (`copies/<chat>/in|out`) so a copy's rail
  lists its own builds since it was made or last brought in. Bring in is `merge-tree` from the seat (`mergeBuilds`: union for `ASSETS.md` and
  the credits file through `attr.tree`, `tune.json` per value, a binary kept whole from the side
  the person chose), checked in a build copy (boots, saved plays), and landed by
  `GameBuilds.land`: the landing's build commits with its restore, and the folder moves as that
  restore's outbox effect, with `expect` on the folder the merge read. Conflicts go back to the copy, never the game. Decisions
  stay the game's: read and written at the project's root whatever folder a chat works in.
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
  edit takes effect at once. `game_assets` op `lock` writes the look of what the game makes
  (`styleFromLook`: a colour per role, shape, finish, surfaces) and needs no library pack; op
  `add`'s optional `lock` adds a style family's packs and rig (`styleFromLock`). The made look
  has two readers that must agree, so one lock gives one family: the Blender kit reads the file
  (`kurambit/look.py`), and the game's own code reads it at `_kurambit/look.json`
  (`shell/model.js`), which the game servers answer from the file and an export carries as a
  file, because STYLE.json lives outside the served folder. The `lock` op is published as a bare
  object and decoded by the service, so its fields are not paid for with every tool call. Tools fill defaults from it (sprite
  palette and views, export budgets, loudness targets, the clip packs a character gets) and search
  ranks its packs first, but nothing is refused for falling outside it: refusals that kept a game
  inside a family the harness picked decided the look for the agent, which is its and the
  person's. The rig exists only so library clips fit every character, so an armature marked on its
  own rig (`kurambit_rig`) plays its own: the mark stands when the armature carries clips of its
  own and none from the library (`ownRigRefusal`). A STYLE.json that is a link, not JSON or names unknown
  library ids fails every art tool with the field. It is a game file, so checkpoints carry it and
  a run's restore brings it back with the art (`restoredPaths`). How a game's
  models are made (code or Blender) and whether the free library's models may come in
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
  keeps its library on, and one that says `generated` (the removed generated-art route) reads as
  `blender` (`gameModelChoice`). New games default to `any`: the agent picks per model, told
  that Blender is there and recommended for characters, creatures and anything sculpted or
  hard-surface. A route the harness chose by kind of model was the harness deciding how a
  model is made; the person can still lock `code` or `blender`, and that lock is said in the
  first turn as theirs, never enforced by refusing a model halfway. A game.json with no key
  stays code, whatever the default becomes.
- A character's or creature's review picture is kept in `art/sheets/` for Art
  ([heroSheets.ts](../../apps/server/src/game/heroSheets.ts)). Nothing asks for a critique of it:
  a written critique quoting numbers was bookkeeping the picture never showed, and agents spent
  turns on it.
- Made characters are rigged, not conformed: `game_blender` op `character` fits a Mesh2Motion
  template (or chains, for a body no template fits) to a static model and weights it with
  Blender's automatic weights, a voxel copy where bone heat fails; the template's own clips play
  on it. Conforming bodies to the standard skeleton by bone-name maps broke on every body whose
  names or rest frames differed, and hand weighting part by part tore at the joints. Each clip's
  stretch, foot slide and floor depth come back as notes, never refusals. The style pass and measurement run in a separate one-shot Blender on a saved copy of the live
  scene, keyed by the objects' digests and the lock (not the kit: a pass an older kit made is run
  again, but nothing else goes stale). `game_blender` op `look` mode review renders that pass;
  `game_blender` op `export` ships it, running it first when no review did, and returns the same
  facts. The review is eyes, never a toll: the export refuses only a file that would be broken in
  the game (an over-limit texture the pass cannot scale, clips that move nothing, skin following no
  bone). Everything else measured (budgets, gates, rest frames off the standard skeleton, a missing
  idle) is a note, because the harness measures and the agent decides; the pass fixes what it can
  (it scales over-budget textures and says so). With no palette lock it also folds a model's flat colours that share a finish into
  one material painted per vertex, and the sidecar keeps each colour's material name (`paints`)
  for Art: a colour must cost nothing, or a material count becomes a reason to drop a detail. Where the player downloads the GLB itself (three.js, `compressedModels` in the
  profile) the pass writes WebP images and the export then meshopt-compresses the geometry with
  gltfpack: Blender cannot import meshopt, so the review measures the uncompressed candidate and
  the sidecar names the shipped bytes and triangles, which keeps the asset fact valid. The asset is its sidecar `<name>.asset.json` (skeleton, clips with ground speed,
  springs, height, source and licence), which the three.js shell reads from `ASSETS` and which
  another engine can read later; GLB extras are not used because native engines drop them.
  Painting from a sheet (`game_blender` op `paint`) runs in a
  one-shot Blender too, since its bakes outlast the live server's 180 s per command; the live
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
  MPFB2 is GPL code with CC0 output, so it is an entry of the add-ons list
  (`BLENDER_ADDONS` in [GameToolchain.ts](../../apps/server/src/game/GameToolchain.ts)): tools
  that make something, each pinned, checksummed and fetched into Kurambit's own Blender folder,
  never bundled and never into the person's Blender (`KURAMBIT_MPFB` may name a copy of the same
  pinned zip). A small extension from Blender's own platform installs on first need; a large one
  or one from anywhere else is asked for. The ask is the agent's own question and the install is
  its own op (`game_blender` op `addon`), because the server cannot raise a question in a chat:
  a `user_input_request` comes only from a provider. Finished assets are never add-ons: those
  stay under the library switch.
- A game with the library off makes its textures: `kurambit.surface` bakes a tiling set from
  Blender's procedural nodes on a flat torus (no seam), and the colour map holds only the
  pattern's light and dark, multiplied by the material's colour, so Art's one colour field
  recolours a whole surface on a model and on what the game's code tiles it over.
- Made art ships the agent's own materials as Blender's glTF exporter writes them (metal, glass,
  emission, normal maps, baked AO as `COLOR_0`). The CC0 packs' one material on a gradient-swatch
  atlas (`stylepass.py`) runs only when STYLE.json holds a hex `palette`, which op `lock` keeps
  only under `finish: "flat"`: the export flattening every model to one matte pack look was the
  harness deciding taste (judges read it as "plain, flat-shaded"), so only the person's lock asks
  for it. Voxel models, a material per colour, take an atlas of their own colours either way.
  The art method is the one that wins against a bare agent (art-pipeline.md): a reference first,
  one continuous dense surface per body region (a base body, or `sweep` regions fused by
  `one_skin`), rigid pieces only for what is rigid (`hard_surface`), and `bake_down` only when the
  running scene is too heavy. Parts of low-sided lofted tubes on a skeleton, the earlier method,
  measured like the packs and judged against a library yardstick's silhouette, came out as "a
  pile of unmodified primitives" (2/10 on the model bench); nothing in the harness sets a model's
  triangles or proportions now. The review's pictures (`review.py`) are the loop's eyes.
- Recipes (`templates/studio/recipes/`) are indexed in the studio `AGENTS.md`, which the game's
  AGENTS.md points at, never left for the agent to discover: Vercel's evals saw an available
  skill go unopened in 56% of tasks, and an index always in view score 100%. They are advice the
  agent opens on demand, never graded: a recipe's numbers turned into targets (`game.json`
  `recipes` and a check line per pick) and steered every model toward the pack look, so neither
  exists any more.
- Under a palette, a decal is a painted cell in the model's one atlas, the atlas's width and two swatch rows tall,
  below the swatches: the runtime recolours a swatch by cutting the atlas into rows of equal
  height (`look-edits.js`), so a cell of any other height would shift every swatch it recolours.
  A made body (MPFB2 or the drawn bodies) carries no material, so op `character` paints it
  `<name> skin`; unpainted, it ships the glTF default white.
- No Rigify rig is generated: generating Rigify's rig and baking it onto its DEF bones turned a
  wolf's front thigh 133° at rest, and Rigify's own DEF export flattens the limbs under the rig
  root. The human template's head bone takes the standard name `Head` so `animate`, the clip
  measures and sheet poses still find it.
- The earlier craft kits (`hero`, `world`, `carve` and their modules) were deleted after the asset
  bench. Their `.blend` files still export byte for byte, because the export pass reads only data
  they left (`kurambit_cloth`, the `kurambit_under` group, `kurambit_rig`): `deform.py` keeps
  `drop_under` and the cloth gates for them. Their scripts no longer rebuild. Blender 4.5 bundles only
  Smooth by Angle and the hair groups as node assets (Scatter on Surface and Curve to Tube came
  with 5.x Essentials), so `scatter` and `tube` build those few nodes themselves.
  A machine's moving parts ride bones laid along their hinge lines, because an export carries only
  an armature's clips; a vehicle's wheels stay plain nodes with their origins at the hubs
  (`kurambit.pivot`), since the game turns them by its own speed and a skeleton there would cost a
  skinned draw for nothing. Any bone named `spring_` swings in the three.js runtime under the fixed
  step, so it replays, its cost is part of play's stats, and the Stage tunes it as two values of
  the model.
- A hero's gates are measured numbers (`gates.py`, `deform.py`), taken in the one-shot pass before
  the style pass joins the meshes (clothing and body must still be told apart) and scaled to the
  shipped size; a failing one is a refusal, and the sidecar and `game_check` op `final` carry them.
  Every limit is set from what the library's own clips do on its own base body, so a gate fails
  what is broken rather than what linear blend skinning always does (a T-posed shoulder stretches
  about 3x). Height leaves out what a hand holds and what dangles (a rod raised overhead, a tail
  held up), and the style pass's `scale.character` scales by that same height.
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
  Blender: blender and code with the library on), so a code chat never reads Blender's
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
- The Stage's Play ([`GameStage`](../../apps/server/src/game/GameStage.ts)) plays the game's own lane. The same content-addressed export machinery
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
still writing is not one. The turn that makes a game's first build has no build to hold, so
there the Stage follows the saves (`follow` on `GamePlaySurface`): each save's frame starts
unseen, held and silent, behind the card or the frame that last drew. When its page is ready
(`studio-ready`; a page with no `main.js` yet says `blank`, which does not count) it is let run,
still unseen, and it takes the Stage when it says it drew a frame that way (the second
`studio-visibility-ack`, `drawn`): a held page's first frame is from before its run moved, with
a camera not placed yet, and is not the game to show. A newer save waits for a frame that is
still starting, because a game that takes longer to start than its saves are apart would
otherwise never draw. The Stage bridge stays with the frame on the Stage, so Tune and Art act on
the game the person sees. A `live` engine's Web
export is a release only and never replaces the live serve. An `export` engine would play the selected Web export, rebuilt when stale, and a
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

A game's own `AGENTS.md` holds only its engine's guidance. The harness's own words for agents
(turn rules, the first turn, tool descriptions, review text in results) are files in
`apps/server/templates/studio/harness/`, JSON so the dev tree, tests and the packed server import
them alike (`studioText.ts`); they are never copied into a game. The harness's rules travel with the
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

- **A build is a record of the event store.** Every build that lands in a game folder (a turn's
  checkpoint that changed game files, kept values, a Library add, a bring-in, an undo, a
  restore's park) is a `game-build.recorded` event, every restore a `game-build.restored`, and the
  projection ([GameBuildProjection](../../apps/server/src/orchestration-v2/gameBuilds/GameBuildProjection.ts))
  holds each build's number, base and what made it, and each folder's current build, latest
  restore and held keeps. The decider ([plan.ts](../../apps/server/src/orchestration-v2/gameBuilds/plan.ts))
  numbers a build from the projection in the commit that records it, so a number is given once.
  A build's commit stays reachable under a ref named by its id alone
  (`refs/kurambit/game-builds/builds/<id>`, or its turn checkpoint's): refs hold trees and mean
  nothing else, and nothing reads a build's kind, base or name back out of a ref name. Every
  surface (its RPCs, `game_builds`' list, compare and undo, `game_check`'s facts, keep going's
  current build) is one method of [GameBuilds](../../apps/server/src/game/GameBuilds.ts) reading
  the projection, and the web shows the server's `name` and `undone` mark as they are.
- **A game made before the records is read in once.** Earlier servers kept builds in ref-name
  suffixes (`game-builds/edits/<req>-values|-from|-library|-in|-undo|-undid`, `bases/`, `fixes/`,
  `bots/`, `versions/`), a restore row and held-keep files. On startup, and before any build of a
  folder is written, the folder's legacy builds are read into one `game-build.migrate` command,
  numbered and named as the legacy reader numbered them; the folder is then marked migrated. The
  legacy refs are never deleted, and nothing writes them now.
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
  ordinal 0), or a newer build that landed in between, such as a restore's target. It is on the
  build's record, because reading it later from the game's latest restore goes wrong once a
  second restore replaces the first. Undo reverses one build: `merge-tree` from the build to its base,
  onto the folder, landed as a build of its own (kind `undo`, naming the build it undid); for the
  newest build it
  is exactly its base, and Redo is the undo of the undo. Go back is the whole restore. Neither is
  T3's conversation revert, which is refused in a game's shared folder and would make the agent
  forget the attempt. A restore that
  moved the folder, and a kept edit, set the next-turn base of the game's chats to the folder they
  left, so a chat card and its Open diff count the next turn from there, as the rail does, and
  never list an undo as the agent's change. A live Stage shows
  a restore through its watch; on a turn-loop engine staged from a Web export, a restore plays
  what it brought back, through the same `playCurrent`.
  `folderEdited` compares the folder's restored paths, captured with T3's capture, against
  `current`.
- **A person's kept edit is a build too.** The Stage's Keep as a build (`keepValues`) captures
  the folder, writes the engine's tune file and captures it again, and records the second
  capture as a build whose base is the first. It lists with `edit`, joins `current`, and owns
  Undo while it is the newest (`ownsUndo`), as a turn does; the turn after it counts its change
  from it. A session of tuning folds into one build: the record replaces the one before it and
  takes its number. A keep while a turn works in that folder would be written over by an agent
  that writes the file whole, or capture half a turn: it is held in the folder's records
  (`game-build.kept`) and landed when the turn ends, merged onto what the turn left.
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
- **A restore commits, then moves.** Undo, Redo, Go back and a landing commit their restore
  (`game-build.restore`; a landing's build in the same commit) and the folder's moves
  (`withBuildInFolder`, under the `game-builds` run-ref folder) run as that record's outbox
  effect (`game-build.move`), which a restart runs again; the moves find their park and never
  take it again, and a settled restore answers from its record without moving. The effect
  settles the outcome and the park with `game-build.restore.settle`, and the person's Undo waits
  for that settle in the server.

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
- **Never two writers.** Keep going runs in the game folder only, never in a copy. A look waits
  until no turn runs or is queued on any chat working in the game folder; a
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
  While the budget has a minute left another turn starts, capped at the time left (at most
  15 min) and told so when that is shorter, and it is what bounds an Autopilot that keeps adding
  content: a fixed "typical step" ended runs with minutes unused. Every ending but `done` resumes.
- **Never repeat.** Each proposal has a key (`fact:<id>`, `steer:<fnv>`, `next:<fnv>`; a retry
  carries the undone step's). Two misses of a key (undone, or kept with its target still bad), any
  step that changed nothing (it is never sent again as it was), or Skip set the key aside for the
  run. Across runs and chats, the look also reads the keys of what the person undid, went
  back from or skipped from the game's decisions (`decidedKeys`), and passes over them the same
  way: a person's undone turn carries the `next:` key of its request, so the Next line it acted on
  is not proposed again.
- **Every measure plays the game's own play bot.** Writing one cost 4 to 10 minutes between
  steps, so no step writes one: the agent writes `.studio/bot/play.mjs` with the bot kit when the
  person asks it to prove the game can be won. Once it exists, every build's measure plays it
  (after its other plays, so keep going's judge never waits on it), which costs no model call; deferring it to an ask
  left every bench game's facts incomplete within its cap. The skilled fact is not watched by
  keep going, so its one real-time run never proposes or undoes a step. With no bot it reads not
  measured (`no-play-bot`). A build whose own code never calls `.win(` reads `no-win` before
  any bot is looked for (`gameCanWin` on the measured copy): like `no-saved-plays`, no surface shows,
  compares or counts it. Only the code decides that, so one bot play that found no ending never
  hides the check. `.studio/bot` is in `restoredPaths`, so an undo keeps the build's own bot. Games
  from earlier runs keep their `game-builds/bots/<run>` setup points, which list as the build they
  were written on.
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
one is cloned for that thing's meshes alone. A thing's look and its parts' looks are put on
together, the game's own materials first and then from the outside in, so a part's edit of a
material its thing also edits is the one its meshes show; Art's model viewer applies the same
looks to a glb with the same functions. Names a person gives a part or material are text in the
same entry (`name`, `2:roof/name`): labels only, never ids, so paths and the agent's text keep
the game's names. Scale and turn sit on the object only while a frame
draws, because games set their things' transforms themselves. A thing's parts (`Island › Cabin`)
are registry records like any thing, so picking, portraits, chips and looks all key by that path.

Two constraints hold everywhere:

- Nothing opens on the user's desktop. Every game process drops `DISPLAY`, `WAYLAND_DISPLAY` and
  `XAUTHORITY`; its window comes from the window host, and its pictures from the engine.
- No test suites for the game layer beyond data-safety checks; games are played, not asserted.
