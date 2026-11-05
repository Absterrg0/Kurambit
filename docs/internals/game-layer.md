# Game layer

> For maintainers. The code lives in `apps/server/src/game/`, `apps/server/src/mcp/toolkits/game/`,
> `packages/contracts/src/game.ts`, `apps/web/src/components/game/`.

One brief produces a game through a harness-run production run, and the harness — not the model — owns every
check that matters: it plays every build with a separate session, compares builds blind so a worse
one never lands, and keeps working until a ship review says yes, it stalls, or the creator stops it.

## Decisions that span the services

- Game operations are exclusive per game (`GameOperations.exclusive`) and reported as events, so
  the Game panel and the agent tools see the same operation, and a second operation on a game
  refuses as busy rather than racing the first. While a production run holds the game (live,
  finishing or restoring), it is the folder's one writer: other owners' writing operations are
  refused `busy` with `runReason: "run-live"` (`GameProjectService.admitWrite`), reads and Play of
  an exported build stay open, and the run's role threads pass. The run's own folder moves
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
  (`liveProcess.ts`). A record is acted on only while its process still verifies as the launch
  (below) and its command line names the executables the live toolchain would launch now, never
  paths from the record; of the editor's process tree only processes running from a detected
  editor's directory, the CLI or Xvfb are signalled, and a Unity Licensing Client never is. Unity
  also keeps a copy of its record under the server state dir, reaped at startup, so a crashed
  server's editor dies even if its game is never reopened. Every call or operation holds the
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
  exits, and a tree stop is `taskkill /T /F`. Free memory is `os.freemem()` (libuv's MemAvailable
  on Linux). Every in-game runner quits when its control socket closes, so a crashed server leaves
  no game running; only the live editors outlive it, and their records reap them.
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
  Blind samples play plain copies of a build, each a separate Unity project with no `Library/`.
  Before an editor opens on one, `GameUnity` gives it a copy-on-write copy
  (`cp -a --reflink=auto`) of its game folder's `Library/`, found through the folder the copy
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
reports are shared; an engine adds only how a session launches.

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

So the harness needs exactly two things from an OS: a **process host**
([processHost.ts](../../apps/server/src/game/processHost.ts), above) and a **window host**
([windowHost.ts](../../apps/server/src/game/windowHost.ts)): one `launch(command, viewport)` that
gives a game or editor a window it draws into, which the user never sees and which never takes
focus. Exploration, bots and the live Unity editor (which runs the Unity check and builds players)
and Blender all launch through it; the Godot check needs no window and runs headless. On Linux every launch gets its own Xvfb display; the display outlives its command and ends right
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

## The run as an orchestration domain

The run is records of the game's creator thread (`GameRun`, `GameRunStep`, `GameRunRound` in
[gameRunRecords.ts](../../packages/contracts/src/gameRunRecords.ts)), changed only by `game-run.*`
commands. The pure decider ([decide.ts](../../apps/server/src/orchestration-v2/gameRun/decide.ts))
folds them into the run policy's state, lets [policy.ts](../../apps/server/src/game/run/policy.ts)
plan or apply, and commits the new records with their outbox effects in one transaction. So a run
has the guarantees every thread has: a retried command changes nothing, a restart loses no
decision, and nothing outside the event log is the run's truth. Its events stay off the chat's
stream; the Run tab and `game_run_status` read the records.

A game has one run, not one per chat: the records sit on the thread that started the run, and every
chat of the game's project reaches that run through `getProjectGameRun`. A start from another chat
resumes or reports the live run instead of opening a second one, and the run's own role threads
reach none of its controls.

- **Long work runs in jobs, never in effects.** An effect claim is a short lease on a worker pool
  every thread's provider work shares. A step's effect (`game-run.step.execute`) hands its work to
  `GameRunJobs` (in-process, bounded, scoped fibers) and settles at once; the job reports with
  `game-run.step.complete` or `game-run.step.fail`. A role step's job only launches the role.
  The step's timers are short (a role's cap is a read and an interrupt or a reschedule; a turn sent
  again is a read and a dispatch), so they run inside their effects, as the decisions do: the
  effect stays unsettled until its act is committed, and the outbox runs it again after a failure
  or a server death. A timer that only forked a job would be done before its work, and a death in
  between would leave the step running with no job and no timer.
- **Attempts.** A step planned again (a resume) is a new attempt. Every report carries its attempt
  and a command id derived from step, attempt and action (`gameRunStepCommandId`), so a late report
  of an earlier try is refused and a retried one is a no-op. Each attempt has its own role thread
  id; `game-run.step.start` records a role's thread before its first turn, and replaces a thread
  only when it names the one it replaces.
- **A landing's outputs are an effect of its commit.** The records a step's result writes (the
  ladder, notes, comparisons) and the copies it frees go in a `game-run.outputs` effect committed
  with the landing, ahead of the next step's effect, so the outbox's order writes them before the
  next step and a stop never cancels them. No later job does an earlier step's work.
- **Finish is an effect.** The commit that ends a run emits `game-run.finish`; its job stops the
  run's jobs and live role turns, exports the best build, then records `game-run.finished`. A finish is safe to run twice: an ending mid-round keeps the folder's
  unfinished work as a build once per ending, restores the best for the exports and puts the work
  back, so a resume goes on from it.
- **Restore is a command first.** `game-run.restore.request` records the pending restore, a job does
  the git work, and `game-run.restore` lands its outcome. The git work and a run's next move would
  race on the game folder, so the decider refuses resume, steer and another restore while an ending
  is unfinished (`finishing`) or a restore is pending (`restoring`), and refuses start and resume
  during a restore. A stopped run's round in progress is dropped only when a `restored` outcome
  lands (`Policy.abandonRound`), never at the request: a refused restore leaves it resumable, and a
  job a restart cut short sees the same round and makes the same choice.
- **Recovery** (`GameRunRecovery`, at startup): a live run's unfinished step gets its job again,
  and an ending whose finish is not recorded finishes again. Every step is safe to repeat because
  its job first finds what an earlier try left: a role's thread, a turn of this attempt that ended
  (landed now), one still running (its cap set again as a timer). A stopped run is never continued except
  by `game-run.resume`.
- **The role reactor's rule.** A role turn's message id names its step and attempt; a restart's
  continuation of a turn (`restartContinuationOfRunId`) is the same turn. `GameRunRoleReactor`
  lands a settled turn only when the step is still that attempt's, the step record names that
  thread, the thread is the run's project's and was launched by the run, and the turn is the
  step's latest. It never goes by role names or launch order. A turn is capped only by the cap's
  own interrupt (its command id), never by any interrupt.
- **Decisions** wake the creator's chat the `DelegatedTaskQuestionReactor` way: one queued
  `message.dispatch` per decision and attempt with a `game_run` notification source (stored as
  `background_task` for older clients). The answer's wait starts when that turn finished presenting
  (`game-run.step.start`), its default fires from the `game-run.decision.deadline` effect with no
  fiber holding it, and an answer cancels a wake still queued.
- **The outbox timer exception.** The outbox runs a thread's effects in order, and an earlier
  pending effect holds later ones. The run's timers (a role's cap, a decision's deadline) wait
  minutes on the creator thread, so a pending `game-run.step.deadline`, `game-run.step.resend` or
  `game-run.decision.deadline` holds nothing back
  ([EffectOutbox.ts](../../apps/server/src/orchestration-v2/EffectOutbox.ts)); otherwise the next
  step, the finish and the creator's own turns would wait out every cap and every default. Each
  timer checks the run again when it fires; a cap extended meanwhile schedules itself again at the
  new due time (`game-run.step.schedule`) instead of polling.

The run's builds are T3 checkpoints under the run's own refs (`checkpointRefForGameRun`,
[builds.ts](../../apps/server/src/game/run/builds.ts)), and the game folder is the live build: a
build step captures the folder, restores a build's engine project, art and `ASSETS.md` (a path-scoped
`restoreCheckpoint`), or keeps a build under names (`best`, `round-N/kept`; [buildNames.ts](../../apps/server/src/game/run/buildNames.ts):
git stores refs as files, so no name is both a build and a folder of builds). The run never commits,
checks out, merges or writes the user's index, HEAD or branches, so the user's git and an agent's
own git use are theirs, and a cut capture or restore leaves no lock or merge that could fail a
resume: captures and restores work through private indexes, and a restore writes only the files
that differ (an unchanged file keeps its mtime, so an engine watching the folder reimports
nothing). Records hold builds by commit oid; labels (`round-N`, `proto-N`) only name files and
text. A builder turn's change is measured at its landing: the folder is captured and diffed with
the build before it, and a diff that cannot be read counts as a change. A run from before kept
its builds on git branches (`GameRun.versions` absent): it is history, read but never continued,
and recovery stops one left live without touching the folder.

Files under `.studio/` (the ladder, next.md, tester and reviewer notes, comparator write-ups,
run.log) are written for people and later roles; nothing the run decides reads them. A game
whose `.studio/run.json` comes from the run's earlier file-based form imports nothing of it but
the fact that the game was built: its new run starts at the rounds (`stage: "build"`), where the
plan writes a ladder for the game as it is, so no placeholder prototypes go over a finished game.

`game_blender_render_sprites` exists because weak models cannot write sprite framing: their
renders cropped heads, drifted across a walk cycle and came out near-black. It fits one fixed
orthographic camera per view to the subject's evaluated geometry across every frame, renders in a
throwaway scene that links the live objects (the live scene and its .blend never change), and
batches renders because the pinned server gives each Blender command 180 s. The pixel-art pass
(downscale, hard alpha, one palette for the whole strip, outline) runs in the server in
`spriteRender.ts`, so the same renders always give the same bytes.

The creator's session and a live run share the game folder, and the run's build restores would
overwrite the session's edits. The game's AGENTS.md tells the creator's agent to pass requests to the run with
`game_run_steer` while one is live; the composer is never rerouted. A note is a `game-run.steer`
command; the policy leads the next round's direction with it.

A Guided run's decisions (the vision's look, the prototype, the ladder) happen in that same chat,
presented by the creator's own agent with whatever visuals it can generate, and answered in free
text; there are no fixed buttons. The policy plans a `decide` step with what to show, the answers
it accepts and a default; Autopilot never plans one, and a decide task planned after a switch to
Autopilot is applied with its default inside `plan`. The wake and its wait are above; `sent` and
`deadline` live on the decide step, so a busy chat does not spend the wait, a resume waits only
what is left, and a question still undelivered after ten minutes takes the default.
`game_run_decide` is `game-run.decide`, checked against the waiting decision (a ladder edit through
`parseLadder`); the decider takes either the answer or the default, never both. Role threads
never see `game_run_decide`.

## The run's course

Vision, two core-loop prototypes, a blind pick, plan, art, one full build, then rounds until a ship
review says yes, the run stalls, the creator stops it, or an optional budget ends: builder block, boot check, tester play with a bot run,
blind compare in both orders, keep or revert, reviewer notes for the next round.

Rounds climb a ladder. The plan submits it, 4 to 7 rungs from the picked
prototype to a game with the shape of a Steam demo, each a sentence of what the game is after it
plus 2 to 4 checks with how to observe them; `game-run.submit` refuses a wrong shape in the plan's
turn, and a plan that submits none gets one fix turn, else the run ends "no-ladder": a creator's
note still gets a finish round, and a resume plans the ladder again. The run's record is the one truth for which rung landed; `.studio/ladder.json` is a
copy for people and roles. A round builds the first open rung, and the tester submits pass or
fail per look check. An earlier run measured why this matters: when every round's goal was the last review's top flaw and judges asked
which build handled that flaw better, a run spent five hours on one flaw while the game never
grew, and two near-identical builds gave noisy ties. So acceptance is the rung's checks, and blind
judging is only a regression gate: a round whose checks pass is kept unless the old build wins
both orders (ties, splits and missing verdicts keep it). A round whose checks fail is not judged
at all, since no verdict could keep it, and its work stays a build of its own. Any round that does not
land its rung (failed checks, a regression, a boot failure, no change) counts against the rung;
the second sets it aside with its reason, and set-aside rungs come back once after the rest. A
run never pays twice for the same work: a retry right after a try that passed some checks grows
that try's build (the gate still judges it against the best), a builder turn that changes no game
file ends its block, a rung round's reviewer writes from the tester's and blind players'
evidence instead of replaying the build, and a gate whose best is the build an earlier gate's
blind player saw reuses that play and plays only the candidate. "The same build" is exact: a kept
round's build is its candidate's own checkpoint, so a play of the candidate is a play of the new
best. The held play lives in the run's record with its question and sample
budget, and is never used under another question (finish rounds ask their own), budget or build.
The comparators cannot tell the reused report from the fresh one; the comparison record names it.
The bot still plays both builds: each round's tester rewrites `.studio/bot`, so an earlier bot
result is not known to come from the same bot. The reviewer's ledger (copied to next.md) lists bugs and DO NOT REGRESS that the builder clears beside the
rung, never a round's goal; the reviewer may add one rung with its ledger
when something blocks the ladder, one open at a time. The old round shape (the review's top flaw,
judged on that flaw) runs only as finish rounds, and only on the creator's ask. The run's end
point is its goal, not a round count: the ladder bounds the building (two tries per rung, one
comeback), a finished ladder gets one ship check, and the run ends ("ready" or "done"). Polish past
that is the creator's call: a game_run_steer note resumes an ended run for one round on it, so no
tokens go to rounds nobody asked for. Three rounds in a row that land nothing, for any reason (a
regression, an unjudged or inconclusive gate, failed checks, a build that could not be kept, a boot failure, no
change), end the run "stalled", resumably, with the last round's reason: otherwise a game whose
checks can never pass (a broken state hook) works through every rung, its retry and its comeback,
30 rounds on a full ladder, for nothing. A kept round resets the count, a round counts once where
it ends (`finishRound` or `stallRound`), and a resume or a note's round starts it fresh.

Before the
comparators run, the tester's last play bot plays both builds in fresh copies for the same real
time; its ending and final probe values sit beside each anonymous report as facts. The tester wrote
that bot against the candidate, and a bot that fails on only one build would name it, so the
comparators get bot facts only when the bot ran on both builds; otherwise neither report has them,
and run.log and the comparison record say why. A failing bot never drops the round. A comparison's two plays,
and its two bot runs, run at once (Unity's one at a time, behind its one editor); that holds only
because explore sessions, bot runs and game operations are keyed by checkout root, not by game.
Two starts at once would both pass a free-memory check made before either allocates, so explore
and bot starts and the live Unity and Blender editor opens hold one gate (`GameMemoryGate`) from
that check through their import and boot (a Unity open through its launch and its first minute,
not its whole cold import). Time queued behind the gate counts against the same 75 s bound, after
which the start is refused `low-memory`, never kept waiting unseen. No gated start may open an
editor: the gate is one permit and does not nest. A sample's time waiting there for memory is given back to its clock; a
play turn refused `low-memory` is played again after a pause. A step whose own work is refused
`low-memory`, or finds the game `busy` with another operation, ends its job and comes back on a
durable `game-run.step.wake` timer, so a wait never holds one of the run jobs' shared step slots;
each kind of wait is counted on the step record, and a cause that does not clear ends the run
resumably rather than voiding the sample or judging the build. Samples play
plain copies of their builds with no git (`materializeCheckpoint`, without `.studio` and
`NOTES.md`), so no history, date or note tells the builds apart. Comparators never work in the
game folder, where run.log maps every sample to its build: each gets a folder of its own, empty
but for its two frame sheets under neutral names, and submits its verdict; the root keeps the
write-ups once all verdicts are in. The copies live in a folder of the run's own under
Kurambit's worktrees folder, never in the game repository. A home inside some repository would
otherwise lend every copy that repository's git, so the server puts the copies' folder in
`GIT_CEILING_DIRECTORIES` for itself and everything it starts ([config.ts](../../apps/server/src/config.ts)):
T3 then treats a copy as the non-repository it is. A copy goes with the commit that frees it, as a
`game-run.outputs` effect: the landing of a role with no turn left, or the restore that abandons
its round. An ending nothing can resume (its ending, a deleted chat or project) frees every copy of
the run in its finish; a resumable one keeps its roles' copies until storage cleanup finds them
spent (`copiesSpent`, under the game-logs period), and unbinds their threads first so a resume
makes fresh ones. The game folder stays reachable by
path, and what is blind by construction is the player's or comparator's folder and prompt. The only hard
checks are boots, exports and keep-or-revert verdicts. A fresh art director judges the art stage's
renders against the vision and may ask for one bounded redo before the art is
kept; a missing verdict keeps the art.

The Unity lane needs three things the run does nowhere else. A live editor holds the open scene in
memory and saves it after every edit without reading the disk first, so every restore of the
root closes the root's live editors before it runs; otherwise the next prototype's first edit
writes the previous build's scene over its own (seen live). Its boot is the
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
build carries harness text as its own work. `GameCreateInput.engine`
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
exports and the run resolve it unchanged. A run takes the lane (the engine directory) from the
manifest, and every engine question the run has is the lane's engine profile.

Two constraints hold everywhere:

- Nothing opens on the user's desktop. Every game process drops `DISPLAY`, `WAYLAND_DISPLAY` and
  `XAUTHORITY`; its window comes from the window host, and its pictures from the engine.
- No test suites for the game layer beyond data-safety checks; games are played, not asserted.
