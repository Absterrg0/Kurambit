# Game layer

> For maintainers. Why the game layer is shaped the way it is, and the constraints that span
> components. The code lives in `apps/server/src/game/`, `apps/server/src/mcp/toolkits/game/`,
> `packages/contracts/src/game.ts`, and `apps/web/src/components/game/`.

## One execution system

Agents reach Blender and Godot only through the `game_*` toolkit in the app's own MCP server. Every
provider session already receives that server, so a new game needs no per-provider MCP
configuration, and provider adapters contain no game logic. Each tool resolves the game from the
calling thread's project. A thread whose workspace has no `game.json` gets an actionable error
instead of acting on an arbitrary directory.

The game stage's buttons call the same `GameService` methods over RPC. Anything a user can do from
the stage, an agent can do through a tool, and the reverse.

## Design before building

A plan-first game starts with `design.status: "draft"` in `game.json`. The scaffolded `AGENTS.md`
says a draft turn may only write `DESIGN.md`, and the first prompt asks for it, so no Blender or
Godot work starts before the creator agrees to a design. The Design tab renders that file.

Approval records a specific `DESIGN.md` revision in `<stateDir>/game-design/`, outside the game:
the document hash, its parsed acceptance and an approval id. `GameStatus` returns the DESIGN.md
bytes (bounded to 64 KB), their hash and the parsed acceptance as one snapshot; the Design tab
renders that snapshot and submits its hash, so it cannot approve bytes it did not display. The game's own `game.json` design
status is only a display mirror. `GameProjectService.approveDesign` runs read, validate, record
and dispatch as one operation serialized per game, so two approvals cannot both release a build
turn; approving the same hash again returns the existing record, and re-approving changed scope
updates it without dispatching. The record also owns the build attempt: it stores the command and
message ids plus `pending | dispatched` before anything is sent. A retry of a pending attempt asks
the orchestration receipt store whether that exact command already committed and then either marks
it dispatched or sends the same ids. A dispatch failure therefore keeps the creator's approval and
a retry cannot create a second build message; only a failed display-mirror write, before any
dispatch, rolls the record back. The
document is valid only when every scaffold section has real content and the fenced `acceptance`
block parses with at least one `control`, `mechanic`, `win` and `lose`, and every mechanical
criterion carries an `observe`. The only exception is a design whose "Win & lose" section
declares that there is no lose state: it writes a `lose` criterion with the text "No lose
state" and no observe. `presentation` criteria carry no observe and remain outside mechanical certification. Creation also writes an intent record
beside the approval: `auto` for a plan-first game (the default), `required` for one whose creator
opted into review, `skipped` for one created without planning. An `auto` game never gates staging on
the design: each status read records the current DESIGN.md as a server-owned revision once its
acceptance parses and differs from the scaffold's example block. A revision with the same
acceptance keeps the exam's `designHash` (only `documentHash` moves), so prose edits never stale the
state stage; a changed acceptance set is a new exam. Skeleton hint lines are warnings in
every mode.
A skipped game is explicitly `legacy` and passes the design stage; a required game whose
`DESIGN.md` is deleted stays a draft with a missing-document issue. Only a game with no server
record at all (created before the record existed) is legacy.
Qualification includes a `design` stage, so a draft or changed design leaves the game
unqualified, and the staging gate in `GameService` reads that record rather than `game.json`.

The same creation record carries the game's verification policy: the canonical `testSuite`, the
`gameplayScene` the check boots, and whether a qualifying playtest owes the StudioProbe. The
service reads that record, never `game.json`, which keeps only a display mirror. A game created
before the policy existed adopts one on first read; the adoption also inspects the game tree, so
a pre-27 template game carrying `scripts/studio_probe.gd` or its autoload adopts `probe: true`
even though its record never named the obligation. The adoption is persisted and logged, so later
manifest edits and deleting the probe files cannot change the exam; only an explicit change can.
Changing the policy is an explicit `game.updateVerificationPolicy` RPC and deliberately not a
`game_*` tool: an agent must not widen or weaken its own exam. Each policy has a derived revision,
and check, test and state results store the revision they ran under, so a change makes those passes
stale. A playtest stores whether it owed the probe for the same reason. Arbitrary diagnostic scripts still run through `game_godot_test`
but only the policy's canonical suite records the test stage.

The first approval sends the build message through ordinary thread dispatch, so the build is a
normal turn with checkpoints, cancellation and the same tool surface. It builds nothing itself.
There is deliberately no `game_*` tool for approval: the design is the creator's decision, and an
agent must not approve its own design.

## Starter templates

New games start from a template under `apps/server/templates/<id>/`: `template.json` (catalog
metadata), `TEMPLATE.md` (the architecture guide, copied to the game root; the game's AGENTS.md
tells the agent to read it first), and `godot/`, which becomes the game's Godot project. Text files
substitute `{{GAME_NAME}}` or, inside a quoted Godot string, `{{GAME_NAME_ESCAPED}}` — the game name
escaped for a string literal, so a name containing `"` or `\` cannot corrupt a scene or
`project.godot`; every other file is copied byte for byte. The templates
directory resolves relative to the running module — `apps/server/templates` in the dev tree,
`dist/templates` in the packed server — and `apps/server/scripts/cli.ts build` copies it into
`dist`. That single rule is why the CLI archive stages `templates/` beside the executable, next to
`client/`: a game created by an unpacked archive would otherwise fail to copy its `godot/` tree.
`GAME_TEMPLATES` in the contracts is what the New game dialog lists, first entry first; a server
test keeps it in step with the folders.

## Why no third-party Blender/Godot MCP servers

We evaluated ahujasid/mcp-for-blender, hi-godot/godot-ai and Coding-Solo/godot-mcp (all MIT):

- mcp-for-blender drives a GUI Blender through an addon socket on a fixed port. That is not
  project-bound, and its useful core is "run bpy code".
- godot-ai needs a running editor, a plugin, and a Python bridge on fixed ports.
- godot-mcp is the closest fit (headless CLI plus a GDScript ops script), but bundling it means a
  second MCP server configured separately for every provider.

The small set of headless, project-bound operations we need (run a bpy script, import, run a
GDScript test, export, serve, playtest) is cheaper to own than to adapt. Revisit this if we need
live editor manipulation.

## Processes are owned and bounded

Blender runs `--background` per operation. Godot runs `--headless` for import, tests and exports.
`GameProcesses` tracks every child by PID with a timeout and stops it on interruption, Stop, and
server shutdown; nothing is ever killed by name. Operations on one game are exclusive. When a turn
ends `interrupted`, `GameTurnCancellationReactor` cancels that game's in-flight operation and
waits for the child to exit. It deliberately leaves native play and the preview server running,
because those belong to the user. The exclusivity is per game, not per thread: interrupting one
thread also cancels a panel-started operation on the same game.

Failures return the command's output tail (bounded to 4 KB) so an agent can fix a script error
without reading log files. Full output stays in `<game>/builds/logs/`.

## Assets keep their source

A Blender asset is the triple `.blend` source, bpy script, and exported `.glb`, recorded in
`game.json`. Godot imports only `godot/`, so it never sees `.blend` files. A revision re-exports to
the same `.glb` path, which keeps Godot's import UIDs and every scene reference stable. "Used by" is
derived by scanning scenes and scripts for the export's `res://` path, not stored, so it cannot go
stale. `game_blender_run` edits the existing `.blend` unless the agent passes `reset`, in which
case the script rebuilds the asset from an empty scene. Only the latest script is kept in
`art/scripts/`; the `.blend` is the editable source of truth and git holds the history.

## Preview and playtest

The web preview is a single-threaded Godot web export using the Compatibility renderer. That
avoids SharedArrayBuffer, so the loopback static server needs no COOP/COEP headers. The server binds
`127.0.0.1` on an ephemeral port per game and lives in-process, so there is no extra process to
track.

The stage letterboxes the preview to the design resolution in `godot/project.godot`, which
`game_status` reports, and loads the loopback URL in a sandboxed iframe instead of the browser
panel: the game is a surface of the app, not a tab in it. The stage stays mounted across the
Design, Assets and Builds workspace tabs and is hidden with `display: none` rather than unmounted:
unmounting recreated the iframe and killed the run, while hiding reports the document as hidden,
which is the signal the Godot web shell pauses and mutes on. The iframe's identity is the preview
URL plus the qualified build; a tab switch does not change it, and only Stop, a deliberate restart
or a selected build change may reset the game. Play keeps the selected immutable artifact when
sources differ; only Rebuild or an accepted repair changes selection. A missing artifact is an
explicit error, never permission to publish the current repair sources. Legacy games without a
selected-build record can still publish their first build.

## Qualification is server-owned

`GameService` writes a qualification record after each real check, test, web export and playtest.
Every game operation also publishes a start and finish/failure/cancellation event on the
`subscribeGameEvents` websocket stream. The Stage subscribes through the game status atom's
`refreshTrigger`, so a stage opened while the agent is idle learns about a later build without
polling; the status query keeps only a ten-second fallback timer while an operation is running.
The games library does not use that exact read: `GameSummary` carries a qualification summary
derived from the record alone plus the record's write time (`Qualified as of …`), the server-owned
design state and the last operation. The Stage remains the place that re-checks the sources; a
library row can say qualified for sources that changed since, which is why the time is shown.
Status also separates the cheap reads (operation, design state, qualification) from the inventory
(asset usage, scenes, viewport): the inventory is cached by the qualification source snapshot, and
only game.json's asset list can invalidate it in between, so a refresh no longer walks and reads
the whole `godot/` tree.
The record lives under the server's `stateDir` (`game-qualification/`), never inside the game, and
each stage stores its outcome, the source snapshot it covered, the verification-policy revision
(for check, test and state) or probe obligation (for a playtest), and for exports and playtests the
build identity. Design and qualification records are keyed by the game root's realpath, so a
directory-symlink alias shares one record, one operation lock and one design state; a record
written under the old lexical key is renamed when the alias is read, and an unreadable required
record is reported as an error rather than downgraded to legacy. The snapshot is the build-source identity: a sorted hash of the `godot/` tree's paths, sizes and mtimes;
additions and deletions change it, while `.godot/`, `*.import` and `*.uid` are excluded because one engine import rewrites them. Design documents, briefs and art sources live outside it, so editing them never stales a build; the full-tree snapshot used for rollback and user-edit detection deliberately covers more. A tree beyond the scan bound reads as
unknown. Symlinks fail closed with the linked path in the reason rather than being followed, and
size+mtime is the identity limit: a same-size edit inside one mtime tick is not detected. A web
export also stores every file in its build-addressed directory (path, size, mtime); a missing, replaced or extra
file makes the export stale even while the source snapshot still matches. A stage counts only while
its snapshot (and, for a playtest, the build captured before it ran) still matches, so
an edit, a deletion, a later failure or a re-export invalidates earlier passes. `GameStatus`
exposes the derived `qualified | unqualified | unknown` read with each stage's status.
Each qualification attempt owns its stage: the previous result is removed before the work runs, and
every exit (success, error, cancellation, defect) writes an outcome through finalization. A failed
terminal record write therefore leaves the stage missing rather than the earlier pass readable.
State acceptance is a server-owned exam: `game_scenarios_run` reads pure input routes from
`godot/tests/scenarios/*.json` (press, hold and wait steps, never code), starts the real main scene
under `--headless --fixed-fps 60`, injects input every physics frame and samples the GameState
autoload plus the `player` group. Routes can only press actions from the InputMap. The runner never
calls a game function or writes a property. Each run records the frame of its first non-wait input
and the gameplay baseline: the first sample at or after that input where a node in group `player`
exists. A criterion passes only when it was false at that baseline and true at a later sample; an
already-true baseline value fails with "already true when play started", and a route with no input
has no baseline and grades every criterion failed. This is what makes content counts a collection
(`collected >= 5`) rather than a world total (`total == 5`), and what stops a menu's playing state
from proving a win. `win` and `lose` must observe the value the run ends at (not `changes`) and keep
it at the final sample, so a pause cannot satisfy a win. The summary lists every mechanical
criterion with its status, proving scenario and frame, plus proven/failed/missing counts per kind;
the state stage passes only when every graded criterion passed and a `win` did. Legacy games without
acceptance pass only when a route moves the player and GameState reaches its playing state at the
baseline. The stage stores the approved source snapshot, the approved design hash and a
per-criterion summary; a newly approved design revision makes the old route result stale even when
the game sources did not change.

Review is separate from mechanical qualification. The first playable build is selected before
review starts, so model latency cannot delay Play. Reviews use the originating game's frozen
provider/model by default; unavailable credentials mean unavailable review, never a substitute
model. Critic and comparison children are fresh evidence-only sessions. Repairs write in place,
one at a time, within three repairs or twenty minutes. Opposite-order ballots and identical-build
controls reduce position bias; mechanical regressions and unknown preservation veto selection.
A pairwise improvement does not certify every presentation claim.

Play serves immutable build directories. Candidate exports never replace the selected build until
accepted. Rejection restores the pre-repair source only while it still matches the recorded
post-repair version. User edits take precedence: a conflict stops the review and offers an explicit
Restore previous version. Restore preserves the folder it replaces and never deletes directories
that live previews still serve. Cancellation joins owned sessions before releasing the game;
a session that may still write keeps the game held. Restart marks unfinished work interrupted,
without Resume or automatic model calls.

Review history lives outside the game and persists across restarts. Clients fetch bounded pages
on small revision/decision events; frame bytes never travel in broadcasts. Source freshness is
unknown until explicitly checked. Version-two qualification records archive the old score-judge
stage and keep mechanical evidence and playable completion. Old games have no new review until a
new eligible export, never an inferred promotion. Historical benchmark readers retain legacy
judgements; the frozen grader and historical aggregates keep their original meaning.

`game_web_playtest` loads that real build in the app's managed headless Chrome with software WebGL
(SwiftShader), waits for Godot to boot, sends keys and pointer input, and captures screenshots and
console errors. It launches its own browser without the SOCKS proxy that `html_preview` uses,
because it only ever loads the game's own loopback server. Do not merge it into
`htmlRender/headlessChrome.ts`: that launcher's proxy and sandbox flags protect untrusted HTML.

Booting is not a verdict. The playtest downsamples the boot frame and the after-steps frame and
requires a visible difference when steps were given, so an inert game fails instead of passing on a
clean console. Pixels alone still are not gameplay: both starter templates autoload `StudioProbe`,
which exposes a read-only `window.__studioProbe()` snapshot (GameState's public numeric, boolean and
string members plus the first `player`-group position). The playtest reads it after boot, after
every step and at the end, and reports `state: { before, after }` with a short diff such as
`collected 0→2, player moved 312`. The baseline is the first sample after an input step with a
player present, so starting the game from its menu is not mistaken for play. With an approved
design, a run passes the `playtest` stage only when the player moved from that baseline and at
least one approved mechanic, content, win or lose observation that was false at the baseline came
true; a win or lose has to hold where the run ended. A legacy game without acceptance needs
movement plus a GameState change whose sampled ride is not strictly increasing, so clocks are
excluded by shape rather than by a list of names. A failing run reports structured `blockers` and
`interaction` beside `booted`, never only a sentence on a green success. The creation record is
authoritative about the obligation: templates declare `probe: true` in `template.json`, the
scaffold copies it into `game.json` and the server-owned design-intent record, and a pre-27 game
whose tree carries the probe adopts the obligation on first read. A game whose policy requires the
probe fails its playtest stage with "StudioProbe missing — restore scripts/studio_probe.gd
autoload" when no probe can be read; games that never owed one keep the pixel rule, and the result
says `no state probe`. When the approved design has `observe`
criteria, the result also lists the ones this run happened to satisfy; that list is informational
and the scenario runner still gates the `state` stage. The tool keeps a boot-only smoke result
useful, but only a run that was given input steps, succeeded, responded and met the rule above
records a pass; anything else records a failure with those blockers in the tool result. Each
run is kept under `builds/playtests/<timestamp>/` as frames plus a `result.json` with the steps,
console, probe snapshot, the probe nearest each screenshot and the verdict; the newest five are
kept, and `game_status` (and the Builds tab) reports the last run and whether the web build has
been rebuilt since. Capture is bounded before the browser launches: the result may be 320–1920 px,
one step at most 10 s, the step sequence at most 120 s, at most 60 steps and 12 screenshots, and a
boot timeout at most 120 s. The response
carries at most 6 MB of PNG data; frames over that budget stay on disk as evidence and the result
names how many were dropped. The capture size is a whole-number multiple of the project's base
viewport (`display/window/size/viewport_width` and height) that fits the requested box, 1280×720
by default, so a 640×360 game is recorded at a true 1280×720 rather than letterboxed. The library
cover is the latest qualifying run's first frame whose persisted probe shows a player and an
approved criterion progressing (else a player away from the baseline), then the after-steps frame,
then an asset thumbnail; captions never choose a cover. Screenshots are
evidence of what happened, not a substitute for a gameplay assertion, which stays in the headless
smoke test. Only the suite named by the game's server-owned verification policy (templates set
`res://tests/smoke_test.gd`) owns the `test` stage; other scripts still run as diagnostics but
never record a pass.

The stage keeps the game iframe mounted across workspace tabs, so switching to Design or Assets
does not restart a running game. CSS hiding does not change an iframe document's Page Visibility,
so the play surface sends a `studio-visibility` postMessage instead; the template's StudioProbe
pauses the SceneTree, mutes the master bus, restores the pause and mute state it found when the
game returns, and answers with `studio-visibility-ack` carrying the observed state. The surface
shows a quiet "Game may still be running" hint when a hide gets no applying ack. This is also why
the iframe key is a fold of the preview session plus the _served_ artifact identity: a source edit
or a failed rebuild leaves the bytes under `builds/web` untouched and must not remount the game,
while a successful replacement remounts it exactly once.

`game_godot_check` is the step before either: one bundled SceneTree checker loads every script,
scene and resource, then runs the main scene and the gameplay scene named by the game's
verification policy (the one the menu starts) for 120 physics frames each, and reports which
entries ran. It reports parse
and runtime errors with file:line plus lint findings such as an InputMap action a script uses but
the project never defines, a CharacterBody without a CollisionShape, or a scene with no camera. A
CharacterBody in the `player` group is stricter: it must have a direct, enabled CollisionShape with
a real shape, because a decorative shape nested elsewhere does not move the body. A game whose policy
declares no gameplay scene has its check run only the main scene, and the warning says so rather
than implying gameplay was exercised.
`game_scene_inspect` dumps a scene's node tree when the wiring, not the code, is the problem.

Agents stop after a current playable export and ordinary-input playtest, returning the preview
URL. The server starts bounded review only after the run that produced that export completes;
a later text-only turn cannot start another review budget. Test and state certification remain
optional for playable completion.

## Toolchain

Versions are pinned (Godot 4.7.2 and Blender 4.5.14 LTS) and installed with checksum verification
into `$XDG_DATA_HOME/game-studio/tools`. That location is shared by dev and installed instances,
because binaries are not user state. Godot runs in self-contained mode (`._sc_`), so its editor data
and export templates stay beside the binary and never touch another Godot install. Resolution
order is the explicit settings path, then `GAME_STUDIO_BLENDER`/`GAME_STUDIO_GODOT`, then the managed
install, then `PATH`. Readiness means a real headless export and import succeeded, not that a file
exists.
