# Game layer

> For maintainers. The code lives in `apps/server/src/game/`, `apps/server/src/mcp/toolkits/game/`,
> `packages/contracts/src/game.ts`, `apps/web/src/components/game/`.

One brief produces a game through a harness-run loop, and the harness — not the model — owns every
check that matters: it plays every build with a separate session, compares builds blind so a worse
one never lands, and keeps working until a ship review says yes, it stalls, or the creator stops it.

## Services

- `GameService` is the facade the RPC handlers and MCP tools call: status, import, check, bot
  runs and the Unity editor tools. `GameExport` makes, publishes and packages releases (Web, Linux,
  Windows), `GameExplore` runs exploration sessions, `GamePlayer` keeps built players per source
  identity and warms a live editor. Operations are exclusive per game (`GameOperations.exclusive`)
  and reported as events.
- `GameProjectService` owns game records: create (blank scaffold), open, list, resolve, inventory.
- `GameRun` owns the production loop. Every role is a fresh ordinary Kurambit thread on the game's
  project with a `role` lineage under the creator's chat. `role` only groups: sidebars, game opens
  and session lists skip it, and it has none of the subagent run takeover, controls or completion
  delivery, which would tie a role to the creator's live turn. State is `.studio/run.json` +
  `.studio/rounds.jsonl` plus git, so a crash resumes from the folder. Code never interprets model prose apart from declared STATUS/SHIP/COMPARE/ART/CHECK lines and the
  shape of the two JSON files the loop asks for (the ladder and a reviewer's rung change).
- `GameBot` plays a model-written bot file in real time, on every engine, and records video plus
  detector findings. `GameBlender` keeps a live Blender with its pinned MCP addon per game on a
  private display. `GameUnity` does the same for Unity: one batchmode editor on a private display
  (one per server, since an editor costs 2-3 GB), reached through the official `unity` CLI and its
  `unity mcp` server, with the same session.json pid records, reaping and idle shutdown
  (`liveProcess.ts` holds the shared display, record and reap code). A record's pids are signalled
  only while their argv names the executables the live toolchain would launch now, never paths
  from the record, and of the editor's process tree only processes running from a detected editor's
  directory, the CLI or Xvfb; a Unity Licensing Client is never signalled. Unity also keeps a copy of
  its record under the server state dir, reaped at startup, so a crashed server's editor dies
  even if its game is never reopened. Every call or operation holds the editor; another game's
  open closes it only while it is idle, and fails `busy` naming the holder otherwise.
  `GameToolchain` detects the user's own Godot, Unity and Blender the way providers are
  detected, and never installs them: they are other vendors' software with their own upkeep and
  licences on every OS. It fetches only harness plumbing (uv, the Unity CLI) itself; `GamePreview` serves builds;
  `GameProcesses` tracks child processes; `GameOperations` keeps the last operation per game.
- `GameAssetLibrary` serves the curated CC0 library in `assetLibraryCatalog.ts`. Each pack is a
  download URL pinned by SHA-256 and size, fetched on first look into `asset-library/` beside Kurambit's
  tools folder, and unpacked with path, link and size limits. Bytes that differ from the pin are
  refused, never re-pinned at runtime: a source can change contents or licence silently, and a
  refusal is the only honest answer. A pin changes only in a reviewed commit that rechecks the
  licence. Kenney packs come from Kenney's own OpenGameArt uploads, because kenney.nl hands out
  short-lived signed links behind a session cookie, which cannot be pinned. Every server on the
  machine (the installed app and any dev server) shares that cache, so fetches lock per pack only
  within one process, scratch names carry the fetching server's pid (a start-up sweep spares live
  ones), and placing a pack accepts a complete copy another server placed first.
- An engine is two modules, and core code asks them instead of naming the engine. Its profile
  (`godotProfile.ts`, `threeProfile.ts`, `unityProfile.ts`, read through `engineProfile.ts`) is pure
  data the services and the run's pure policy share: directories, export targets, how its games play
  (a browser page, the engine's native runner, or a built player), the in-game runner files the
  harness owns, Web build files, check messages, its skill and its prompt lines. Its backend (`GameGodotEngine`, `GameThreeEngine`,
  `GameUnityEngine`, registered in `GameEngine`) holds the behaviour that differs: import, check,
  export readiness and preset, export release, how a play session starts its runner process
  (`playProcess`; null for a browser page), and two optional capabilities, `editor` (a live
  editor that refuses a second user) and `player` (a player folder built from the sources). Godot owns the native process boundary (headless editor import, check script,
  export presets; Web, Linux and Windows releases). three.js owns a headless-Chromium boundary
  instead: the static folder is the game, so import is a no-op success, check loads the page
  and reports console/page errors, export copies the folder. Windows and Linux exports are
  refused plainly for three.js (`profile.exportTargets`). Unity refuses a second editor
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
  refused.
- Web play shares the services: the browser host (`webPlaySession`) opens real-time
  headless-Chromium sessions on the served static folder (real keyboard/mouse, the read-only
  `window.__studio` probe, console and page errors; no pause between acts). `gameChromium`
  resolves the executable (`KURAMBIT_CHROME` override, then host lookup) and holds the `__studio`
  snippets; `gameWebServer` serves a game-relative directory over loopback for check/explore/bot
  without touching Preview state.
- Unity play is a real Linux player of the current sources, built once per source identity
  under `builds/logs/unity-play-*`, run under xvfb-run. The role runner makes a Unity sample's
  worktree itself and readies its player before the thread exists, so neither side of a
  comparison spends play time on a build: a copy-on-write copy of the main checkout's player of
  the same source identity (the content hash, never a commit: samples check out a neutral
  commit), else a build in the worktree. The main checkout keeps its three most recently built or
  copied players, so a best that keeps being sampled stays reusable; a best whose player was
  pruned builds in its worktree, still outside its clock. Where a player came from stays out of the explore result, since sample notes reach
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
reports are shared; an engine adds only how a session launches.

- Godot's runner is one GDScript ([godotPlayRunner.ts](../../apps/server/src/game/godotPlayRunner.ts))
  the server writes under the game's ignored `builds/logs/` for each session, so it always matches
  the server.
- Unity's runner is `Assets/Kurambit/StudioProbe.cs` inside the game, because a player only runs
  code it was built with. The harness owns that file: a new production run copies it from the
  template (`profile.run.harnessFiles`) right after init and commits it alone on trunk, so it never
  rides in (or is rejected with) a role's commit. A game whose probe predates
  the versioned protocol still explores (it reads as protocol 0, acts only) but refuses bots with a
  message saying so, until a fresh run refreshes it.
- three.js has no runner process. The browser host speaks the protocol to the page through the
  shell's `window.__studio` bridge, which the game owns and may have edited, so the protocol stays in
  the server instead of the page. Pages read no control tree: no ui or inspect steps, and a bot's
  id-clicks are skipped and counted.

Process runners connect out to a loopback port with a per-session token. Pictures and video belong
to the display host ([displayHost.ts](../../apps/server/src/game/displayHost.ts)), not the engine:
exploration runs under `xvfb-run` and the runner writes each act's picture; a bot run gets its own
Xvfb display recorded by ffmpeg x11grab, and the browser host stitches one still per second.

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
run's own status, round, steer, decide and profile tools stay outside their catalog.

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

A Guided run's decisions (the vision's look, the prototype, the ladder) happen in that same chat,
presented by the creator's own agent with whatever visuals it can generate, and answered in free
text; there are no fixed buttons. The policy plans a `decide` step with what to show, the answers
it accepts and a default; Autopilot never plans one, and a decide task planned after a switch to
Autopilot is applied with its default inside `plan`. The driver wakes the creator thread the way
`DelegatedTaskQuestionReactor` wakes a parent: a `message.dispatch` with
`queue_after_active`, a command id derived from the run and decision ids (a resume never asks
twice) and a `game_run` notification source, stored as `background_task` so older clients still
decode it. The wait starts when that queued message's run leaves the queue, not when it is sent,
so a busy chat does not spend it; `sent` and `deadline` persist on the in-flight step, so a resume
waits only what is left, and a question still queued after ten minutes takes the default.
`game_run_decide` validates the answer against the waiting decision (a ladder edit through
`parseLadder`) and completes a deferred; a default completes the same deferred, so an answer and a
timeout racing each other cannot both win. Role threads never see `game_run_decide`.

## Loop

Vision, two core-loop prototypes, a blind pick, plan, art, one full build, then rounds until a ship
review says yes, the run stalls, the creator stops it, or an optional budget ends: builder block, boot check, tester play with a bot run,
blind compare in both orders, keep or revert, reviewer notes for the next round.

Rounds climb a ladder. The plan writes `.studio/ladder.json`, 4 to 7 rungs from the picked
prototype to a game with the shape of a Steam demo, each a sentence of what the game is after it
plus 2 to 4 checks with how to observe them; code checks only the shape (one fix turn, else the
run has an empty ladder and only finish rounds). The ladder then lives in `run.json`, the one
truth for which rung landed; the file is the plan's output and is not read again. A round builds
the first open rung, and the tester declares `CHECK k: PASS|FAIL` per check. The old loop
measured why this matters: when every round's goal was the last review's top flaw and judges asked
which build handled that flaw better, a run spent five hours on one flaw while the game never
grew, and two near-identical builds gave noisy ties. So acceptance is the rung's checks, and blind
judging is only a regression gate: a round whose checks pass is kept unless the old build wins
both orders (ties, splits and missing verdicts keep it). A round whose checks fail is not judged
at all, since no verdict could keep it, and its work stays on its branch. Any round that does not
land its rung (failed checks, a regression, a boot failure, no change) counts against the rung;
the second sets it aside with its reason, and set-aside rungs come back once after the rest. A
run never pays twice for the same work: a retry right after a try that passed some checks grows
that try's branch (the gate still judges it against the best), a builder turn that changes no game
file ends its block, and a rung round's reviewer writes from the tester's and blind players'
evidence instead of replaying the build. The reviewer's next.md is a ledger of bugs and DO NOT REGRESS that the builder clears beside the
rung, never a round's goal; the reviewer may add one rung through `.studio/rung-change.json`
when something blocks the ladder, one open at a time. The old round shape (the review's top flaw,
judged on that flaw, STATUS: ready to the ship review) runs only as finish rounds, once the
ladder is done or the budget's last fifth begins. A run.json from before the ladder writes one at
its next round start.

Before the
comparators run, the tester's last play bot plays both builds in fresh worktrees for the same real
time; its ending and final probe values sit beside each anonymous report as facts. The tester wrote
that bot against the candidate, and a bot that fails on only one build would name it, so the
comparators get bot facts only when the bot ran on both builds; otherwise neither report has them,
and run.log and the comparison record say why. A failing bot never drops the round. A comparison's two plays,
and its two bot runs, run at once (Unity's one at a time, behind its one editor); that holds only
because explore sessions, bot runs and game operations are keyed by checkout root, not by game.
Two starts at once would both pass a free-memory check made before either allocates, so explore
and bot starts hold one gate (`GameMemoryGate`) from that check through their import and boot. A
sample's time waiting there for memory is given back to its clock; a play turn refused
`low-memory` is played again after a pause, and memory that stays short ends the run resumably
rather than voiding the sample. Comparators
never work in the game folder, where run.json and run.log map every sample to its sha: each gets a
worktree of its own at one parentless empty-tree commit, holding only its two frame sheets under
neutral names, and writes `.compare/verdict.md`; the root keeps the write-ups once all verdicts are
in. That worktree still links to the game's repository, so its history and the root stay reachable
by path; what is blind by construction is the comparator's folder, HEAD and prompt. The only hard
checks are boots, exports and keep-or-revert verdicts. A fresh art director judges the art stage's
renders against the vision and may ask for one bounded redo (`ART: REDO`) before the art is
committed; a missing verdict keeps the art.

The Unity lane needs three things the loop does nowhere else. A live editor holds the open scene in
memory and saves it after every edit without reading the disk first, so every run git step that can
move the root's checkout closes the root's live editors before it runs; otherwise the next
prototype's first edit writes the previous branch's scene over its own (seen live). Its boot is the
editor check plus a Linux player build, because testers and samples play only the player and a
build can pass the editor (an editor-only API in a runtime script) and still fail as a player.
And the project's first editor open, a full import of minutes, runs before the first root role's
clock, so the first prototype is not capped on it while the second opens warm.

## Why this shape

A model left alone grades its own work, stops when it feels done, and says it tested things. The
harness makes these true regardless of what the model says: a separate tester plays every build,
fresh sessions review it, blind compare reverts the loser, and the clock enforces bold moves in
every round. Craft advice lives in the skill pack under `apps/server/templates/studio/` (plus `three.md`
for the browser lane, `unity.md` for Unity) and the bot
kit under `apps/server/templates/bot-kit/`; both are copied into each game when a run starts, not the product. A
resume keeps the run's copy, so every build of one run is made and judged under the same guidance and no
build's commit carries harness text. `GameCreateInput.engine`
(`godot` default, `three` for the browser lane, `unity`) picks the starter template (`blank` /
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
exports and the loop resolve it unchanged. `GameRun` takes the lane (the engine directory) from the
manifest, and every engine question the loop has is the lane's engine profile.

Two constraints hold everywhere:

- Nothing opens on the user's desktop. Every game process drops `DISPLAY`, `WAYLAND_DISPLAY` and
  `XAUTHORITY`; pictures come from a private virtual display.
- No test suites for the game layer beyond data-safety checks; games are played, not asserted.
