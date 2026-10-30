# Late-game evidence: setupSteps prelude for game_try_input

## Problem

Copper Kitchen (held-out, completed) proves 3-serves win / 2-fail loss only
through long routes: three orders need >12 ordinary inputs (pointer + waits
more), yet fit 30s. `game_try_input` capped observed steps at 12, so the
reviewer explicitly could not assess the late win/loss within the step limit
(`tool-answer.json` notes "only2of3 step limit blocks full win").

## Change (minimal, bounded, no cap raises)

Optional `setupSteps` on `game_try_input`: a bounded physical-input/wait
prelude replayed from fresh boot, then the existing observed `steps` suffix.

- Setup max 48 + observed max 12 = 60 total (shared `GAME_PLAYTEST_BOUNDS.maxSteps`).
- SAME total 30s nominal duration across setup+observed
  (`GAME_TRY_INPUT_BOUNDS.maxSequenceMs`), same 180s wall
  (`maxRunMs`), same 32 planned/effective evidence frames
  (`maxFrames`, observed suffix only — setup adds none), same 6 calls
  (`maxCalls`), same 10s per-step cap.
- No screenshot steps in setup (not useful reaching state); combined
  coordinates, durations, keys and frame plan are validated before any browser
  launch or budget reservation.
- Setup and observed stay distinct (no opaque checkpoint/state injection, no
  teleports, no GameState helper calls, no arbitrary JS, no live source
  access, no persistent critic browser, no new RPC/scopes/tools; sealed
  critic/ballot boundaries kept).
- INTERNAL `captureFromStep` on the one-shot driver (`GameWebPlaytest`) and
  the service experiment options (`GameService.webPlaytestBuild`): setup runs
  the exact same clock/input path (holds, releases, drags, waits,
  cancellation) with NO discarded PNG/sampleFrame/interval captures and no
  probe reads. `playtestStepWithEvidence` takes an explicit `skipCapture`
  flag to share execution instead of duplicating action drivers. No added
  game time, no stretched holds, no omitted input, no lost key
  release/cancel, no waits folded across the observation boundary. Observed
  suffix keeps original full-route `stepIndex` values so pairs/labels stay
  truthful. Full executed route stays in trace/result for replay; setup has
  no citable frames and cannot prove promises.
- Persistence/replay: `try-N.json` stores `setupSteps` alongside observed
  `steps` (omitted when empty, so default bytes are unchanged);
  `GameReviewExperimentRoute.setupSteps` is optional/backward-compatible.
  `GameRepairStudio.experiment` and `GameRepairLoop.replayExperimentPairs`
  replay ALL steps fresh with the same capture boundary, so `tryNfM`
  citations and ballot defect witnesses never alias frame indices or omit
  setup. `inputRouteKey` dedup uses the full route.
- `captureFromStep` is restricted to the isolated evidence-only experiment
  path (`experimentDirectory` set); normal qualification and public recorded
  verify can never set it. Path-first defaults, image budget, source/build
  binding and frozen temporal witness validation are unchanged.
- Discoverability: `game_try_input` tool description documents `setupSteps`;
  the critic prompt gains ONE sentence: setup reaches the later question,
  only the observed suffix is citable, missing evidence is cannot-tell.
- No AGENTS/scaffold enlargement, no genre keywords, no new
  dependency/framework, no timestamp/hash rewrites.

## Files

- `packages/contracts/src/game.ts`: `GAME_TRY_INPUT_BOUNDS.maxSetupSteps=48`,
  `GameTryInput.setupSteps` (optional, max 48).
- `packages/contracts/src/gameReview.ts`:
  `GameReviewExperimentRoute.setupSteps` (optional).
- `packages/contracts/src/playtestBounds.ts`: `tryInputIssues` validates
  setup+observed as one bounded route (combined 60 steps, 30s total,
  observed-only 32-frame plan, no setup screenshots, combined numbering).
- `apps/server/src/game/playtestInputPairs.ts`:
  `playtestStepWithEvidence({ skipCapture })`.
- `apps/server/src/game/GameWebPlaytest.ts`:
  internal `captureFromStep`, uncaptured setup loop, observed loop from the
  boundary with full-route indices.
- `apps/server/src/game/GameService.ts`: `WebPlaytestOptions.captureFromStep`,
  `webPlaytestBuild(..., internal?)`, experiment-only guards, observed-only
  frame planning, full-route duration/coords, driver pass-through.
- `apps/server/src/game/GameReviewSessions.ts`: `tryInput` builds
  fullSteps + boundary, persists `setupSteps` in `try-N.json`,
  `StoredExperiment.setupSteps`, `experiments()` returns it.
- `apps/server/src/game/GameRepairStudio.ts`: `experiment({ setupSteps })`
  replays full route with the same boundary.
- `apps/server/src/game/GameRepairLoop.ts`: passes `route.setupSteps`
  through; `inputRouteKey` uses the full route.
- `apps/server/src/mcp/toolkits/game/tools.ts`: `game_try_input`
  description documents setup.
- `apps/server/src/game/gameReviewPrompts.ts`: one critic sentence.
- Tests: `packages/contracts/src/tryInputSetup.test.ts` (RED-first),
  `apps/server/src/game/GameTryInputSetup.test.ts`,
  opt-in `apps/server/src/game/GameTryInputSetup.live.test.ts` (created, never run).

## Limits (unchanged except additive setup)

- Observed steps 1–12; setup 0–48; total ≤60.
- Setup+observed nominal ≤30,000ms; per-step ≤10,000ms.
- Planned/effective frames ≤32 (2 boot + 2 per observed step, 1 per
  screenshot, + interval; setup 0).
- Wall `maxRunMs` 180,000ms; calls 6 per provider run; `captureEveryMs`
  default 1000, min 100.

## Validation (exact commands; light, serial; no live engines/browsers/models/devservers/fullchecks)

All with `TMPDIR=/home/abstergo/.gs-tmp NODE_OPTIONS=--max-old-space-size=1536 RAYON_NUM_THREADS=2`
plus `--maxWorkers=1 --no-file-parallelism` for tests:

- `vp test run --config ../../vite.config.ts --dir . src/tryInputSetup.test.ts src/playtestBounds.test.ts --maxWorkers=1 --no-file-parallelism`
  (from `packages/contracts`): 23 passed, incl. T115 13-step rejection and 12-step route.
- `vp test run --config ../../vite.config.ts --dir src src/GameTryInputSetup.test.ts --maxWorkers=1 --no-file-parallelism`
  (from `apps/server`): 9 passed.
- `vp test run --config ../../vite.config.ts --dir src src/playtestInputPairs.test.ts src/gameReviewPrompts.test.ts src/GameTryInputSetup.test.ts --maxWorkers=1 --no-file-parallelism`:
  38 passed.
- `vp test run --config ../../vite.config.ts --dir src src/mcp/toolkits/game/tools.test.ts --maxWorkers=1 --no-file-parallelism`:
  12 passed.
- `vp test run --config ../../vite.config.ts --dir src src/GameRepairStudio.test.ts --maxWorkers=1 --no-file-parallelism`:
  29 passed.
- `vp test run --config ../../vite.config.ts --dir src src/GameRepairLoop.test.ts --maxWorkers=1 --no-file-parallelism`:
  118 passed.
- `vp test run --config ../../vite.config.ts --dir src src/GameReviewSessions.test.ts --maxWorkers=1 --no-file-parallelism`:
  64 passed.
- `vp run --filter @t3tools/contracts typecheck`: clean (2 pre-existing suggestions).
- `vp run --filter t3 typecheck`: clean (suggestions only, no errors).
- `vp lint <13 touched files>`: clean after one unused-import removal.
- `vp fmt <13 touched files>`: applied.
- Opt-in live probe `apps/server/src/game/GameTryInputSetup.live.test.ts`
  (`it.live.skip`, >12-step <30s setup+suffix, 32-frame cap, combined
  indices): created, NEVER run. Parent runs real JS/Godot probes and the
  unchanged selected Kitchen late-order trial.

## Replay seam assessment

Trustworthy seam present, no blocker: `GameReviewSessions.tryInput` →
`GameService.webPlaytestBuild` → `GameWebPlaytest` driver, with
experiments persisted via `try-N.json`/`StoredExperiment` →
`GameReviewExperimentRoute` → `GameRepairStudio.experiment` →
`GameRepairLoop.replayExperimentPairs`. No overbuilding, no evidence
weakening.
