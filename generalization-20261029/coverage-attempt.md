# Coverage attempt: one bounded play attempt before a no-defect unknown can end

## Problem

Unchanged kitchen no-edit verify/submit passed. The critic then made ZERO
`game_try_input` calls, reported no defects with six requirement unknowns
incl win/all3/loss, and stopped after 105s despite available budget.
`setupSteps` works on the exact frozen source
(`kitchen-setup-service-v2/results.json`: two real service replays, win,
14 frames each) but the model did not use it. Shared loop behavior needs the
fix, not the game/fixture, and unknown must not equal success.

## Change (minimal, bounded, no cap raises)

Small server-enforced work policy for NEW frozen critic sessions with
approved stateful/observe requirements: before an otherwise no-defect review
can end while any such requirement is `cannot-tell` and the build boots, make
at least ONE bounded `game_try_input` attempt to investigate a highest-impact
missing behavior. The prompt says focused question, use `setupSteps` for
preparation, then report actual observation; `cannot-tell` remains neutral
when still unavailable.

- DO NOT require a yes, convert unknown to defect, force exhaustive coverage,
  repeat already attempted trials, weaken budgets/qualification, or add
  calls/time/images. Existing 6 calls / 180s / overall loop deadline still own
  the cost.
- Skip for legacy/unapproved/no-stateful sessions, non-booting/broken builds,
  or an already actionable report (explicit defects / requirement no /
  quality no / fundamental no); fix/stop can proceed.
- Minimum attempt is WORK, not semantic proof or a quality certificate. A
  genuinely failed experiment may still justify abstention, not endless
  retries.
- Uses actual server-owned bound child/run input-attempt records/budget
  (`inputCalls` + recorded `try*` frames), never a model assertion. Invalid
  preflight requests never increment `inputCalls` and do not count.
  Reserved-but-failed counts as work: honest narrow rule, documented in code.
- No generic planner or expensive new metadata ledgers. One small opt-in
  `coverageAttemptPolicyVersion` frozen with the session like the existing
  temporal policy, so old recorded answers stay compatible and
  restart/approval edits do not change obligations. Reuses frozen
  `temporalRequirementIds` eligibility, never keyword rules for
  kitchen/parking.
- SAME guard wired through report-tool and terminal-answer paths, retaining
  <=3 answer attempts and run/evidence hash bindings. Refusal names exact
  unknown ids, orders one focused play attempt, and preserves `cannot-tell`
  when the attempt cannot show the claim. One valid earlier attempt satisfies
  every unknown; no extra attempt per unknown.

## Files

- `apps/server/src/game/GameReviewSessions.ts`:
  `COVERAGE_ATTEMPT_POLICY_VERSION=1`, `coverageAttemptPolicyVersion` session
  field, `coverageAttemptUnknownIds` / `isActionableCriticAnswer` /
  `coverageAttemptRefusal` helpers, frozen flag in `start`, guard in `report`
  and `answer` via `inputCalls` + recorded `try*` frames.
- `apps/server/src/game/gameReviewPrompts.ts`: designed-critic addendum gains
  one focused-attempt sentence (setupSteps from fresh boot, report
  observation, keep cannot-tell).
- Tests: `GameReviewSessions.test.ts` (kitchen-like 8-promise fixture, tool +
  terminal refusal, try-then-accept, empty-attempt abstains, presentation-only
  skips, non-booting skips, defects/requirement-no/quality-no/fundamental-no
  skip, legacy compatible, frozen across approval/restart, preflight does not
  count), `gameReviewPrompts.test.ts` (addendum sentence).
- No public API/RPC/scopes/UI/new tool/deps. Root transport/bootstrap/helper,
  GameService, drivers, contracts, templates/e2e/games untouched.

## Limits (unchanged except additive flag)

- Observed steps 1–12; setup 0–48; total nominal 30s; wall 180s; frames ≤32;
  calls 6 per provider run. The work rule adds zero calls/time/images.
- One attempt does not guarantee focus or semantic truth. It guarantees the
  loop did not end on a static unknown without trying the frozen build once.
  A failed bounded attempt may still abstain; the next loop, not this guard,
  decides whether more evidence is worth the budget.

## Validation (exact commands; light, serial; no live engines/browsers/models/devservers/fullchecks)

All with `TMPDIR=/home/abstergo/.gs-tmp NODE_OPTIONS=--max-old-space-size=1536 RAYON_NUM_THREADS=2`
plus `--maxWorkers=1 --no-file-parallelism` for tests:

- `vp test run --config ../../vite.config.ts --dir src src/GameReviewSessions.test.ts src/gameReviewPrompts.test.ts --maxWorkers=1 --no-file-parallelism`
  (from `apps/server`): 87 passed.
- `vp run --filter @t3tools/contracts typecheck`: clean (suggestions only).
- `vp run --filter t3 typecheck`: clean (suggestions only).
- `vp lint <4 touched files>`: clean.
- `vp fmt <4 touched files>`: applied.
- Unit fixtures stub playtest; worker NEVER launches real engine/browser.
  Parent runs unchanged-game Muse re-review to measure actual autonomous use,
  not declared from unit tests.

## Replay seam

Trustworthy seam unchanged, only gated: `GameReviewSessions.report/answer`
→ `inputCalls` budget + recorded `try*` evidence → `tryInput` →
`GameService.webPlaytestBuild`. No new ledger; the budget file and evidence
tree are the durable proof.
