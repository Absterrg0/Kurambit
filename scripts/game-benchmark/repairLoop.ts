// @effect-diagnostics globalTimers:off -- The wait is an Effect sleep so the test clock can drive it.
import type {
  GameRepairLoopStatus,
  GameReviewDecision,
  GameReviewRoundStatus,
} from "../../packages/contracts/src/index.ts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { GameE2eRepairLoopRead } from "./artifacts.ts";

/**
 * The loop fields this waiter reads. Narrower than the persisted record so the
 * test can script one without fabricating ballots, selections and usage.
 */
export interface RepairLoopView {
  readonly id: string;
  /** The builder run whose completed turn opened this loop. */
  readonly originatingRunId: string;
  readonly status: GameRepairLoopStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly budget: { readonly repairs: number; readonly elapsedMs: number };
  readonly decision: GameReviewDecision | null;
  readonly reason: string | null;
  readonly repairsUsed: number;
}

/** The round fields the loop summary reports. */
export interface RepairRoundView {
  readonly id: string;
  readonly status: GameReviewRoundStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly loopId?: string;
  readonly decision?: GameReviewDecision;
  readonly reason?: string;
  readonly candidate: { readonly buildId: string; readonly directory: string } | null;
}

export interface WatchRepairLoopInput<E> {
  readonly status: Effect.Effect<{ readonly loop: RepairLoopView | null }, E>;
  readonly history: Effect.Effect<
    { readonly rounds: ReadonlyArray<{ readonly round: RepairRoundView }> },
    E
  >;
  readonly now?: Effect.Effect<number> | undefined;
  readonly sleep?: Effect.Effect<void> | undefined;
  /** Only a loop opened by this builder run is this turn's loop. */
  readonly forRunId?: string | undefined;
  /** How long the loop has to appear after the builder turn ends. */
  readonly startGraceMs?: number | undefined;
  /** Slack over the loop's own budget before a hung loop stops the wait. */
  readonly marginMs?: number | undefined;
  readonly pollMs?: number | undefined;
  /**
   * The caller's absolute hard stop. The wait never plans past it, so a phase
   * cannot promise time the process will not get.
   */
  readonly deadlineMs?: number | undefined;
  /** Time kept before `deadlineMs` for the caller to record what exists. */
  readonly deadlineReserveMs?: number | undefined;
  readonly onWait?: ((message: string) => void) | undefined;
}

export type RepairLoopTimeoutBound = "loop-budget" | "harness-deadline";

export interface WatchedRepairLoop {
  readonly loop: RepairLoopView;
  readonly rounds: ReadonlyArray<RepairRoundView>;
  readonly waitedMs: number;
  readonly timedOut: boolean;
  /** Which bound ended the wait; null when the loop ended on its own. */
  readonly timedOutBy: RepairLoopTimeoutBound | null;
}

/**
 * How long a playable builder turn may take to open its loop record. The
 * reactor forks `ensure` after the turn's completion event; this covers model
 * bookkeeping and a recapture, never a loop that is already repairing.
 */
export const DEFAULT_REPAIR_LOOP_START_GRACE_MS = 60_000;
/**
 * The loop's own deadline does not include the child join it performs when a
 * repair ignores an interrupt. Give that shutdown five extra minutes before the
 * harness stops waiting and grades what exists.
 */
export const DEFAULT_REPAIR_LOOP_MARGIN_MS = 5 * 60_000;
export const DEFAULT_REPAIR_LOOP_POLL_MS = 5_000;
/**
 * The run summary is written after this wait returns. One minute is enough for
 * the status reads that fill it and keeps the caller's cap honest.
 */
export const DEFAULT_HARNESS_DEADLINE_RESERVE_MS = 60_000;

/**
 * Waits for the review loop the builder turn started, then until that loop is
 * terminal. The wait is bounded by the loop's own budget plus a shutdown
 * margin and, when the caller supplies one, by the caller's hard stop minus a
 * reporting reserve. A loop that never opens returns `null` after the start
 * grace; a loop that outlives its bound returns `timedOut` with the bound that
 * ended it, rather than hanging a run or promising time the caller lacks.
 *
 * Terminal must be observed before completion is asserted: a running repair can
 * legitimately make the sources stale while it writes, and stopping the server
 * then would kill the work the harness was meant to measure.
 */
export const watchRepairLoop = <E>(
  input: WatchRepairLoopInput<E>,
): Effect.Effect<WatchedRepairLoop | null, E> =>
  Effect.gen(function* () {
    const now = input.now ?? Clock.currentTimeMillis;
    const pollMs = input.pollMs ?? DEFAULT_REPAIR_LOOP_POLL_MS;
    const sleep = input.sleep ?? Effect.sleep(Duration.millis(pollMs));
    const startGraceMs = input.startGraceMs ?? DEFAULT_REPAIR_LOOP_START_GRACE_MS;
    const marginMs = input.marginMs ?? DEFAULT_REPAIR_LOOP_MARGIN_MS;
    const reserveMs = input.deadlineReserveMs ?? DEFAULT_HARNESS_DEADLINE_RESERVE_MS;
    const harnessDeadlineMs =
      input.deadlineMs === undefined ? null : input.deadlineMs - Math.max(0, reserveMs);
    const forRunId = input.forRunId;

    // A revision build turn can finish while the previous build's stopped loop
    // is still the newest record. That loop is not this turn's: accepting it
    // would grade mid-repair and report a review that never ran.
    const forThisTurn = (candidate: RepairLoopView | null): RepairLoopView | null =>
      candidate === null ||
      forRunId === undefined ||
      String(candidate.originatingRunId) === String(forRunId)
        ? candidate
        : null;

    const started = yield* now;
    let loop = forThisTurn((yield* input.status).loop);
    while (loop === null) {
      const current = yield* now;
      if (current - started >= startGraceMs) return null;
      // A loop that has not opened yet cannot justify spending the last of the
      // caller's budget; the caller reports what the build already submitted.
      if (harnessDeadlineMs !== null && current >= harnessDeadlineMs) return null;
      yield* sleep;
      loop = forThisTurn((yield* input.status).loop);
    }

    // A loop already terminal on the first read needs no wait at all.
    const loopStartedAt = Date.parse(loop.startedAt);
    const loopDeadlineMs =
      (Number.isFinite(loopStartedAt) ? loopStartedAt : started) + loop.budget.elapsedMs + marginMs;
    const deadlineMs =
      harnessDeadlineMs === null ? loopDeadlineMs : Math.min(loopDeadlineMs, harnessDeadlineMs);
    const bound: RepairLoopTimeoutBound =
      harnessDeadlineMs !== null && harnessDeadlineMs < loopDeadlineMs
        ? "harness-deadline"
        : "loop-budget";
    const boundName = bound === "harness-deadline" ? "the run timeout" : "the loop's bound";
    let timedOut = false;
    let timedOutBy: RepairLoopTimeoutBound | null = null;
    if (loop.status === "running") {
      const nowMs = yield* now;
      const waitMs = Math.max(0, deadlineMs - nowMs);
      input.onWait?.(
        waitMs <= 0
          ? `Review loop ${loop.id} is running; no time is left before ${boundName}.`
          : `Review loop ${loop.id} is running; waiting up to ${Math.ceil(
              waitMs / 60_000,
            )} more minute(s), limited by ${boundName}${
              bound === "harness-deadline"
                ? ` (the loop's own bound allowed ${Math.ceil(
                    Math.max(0, loopDeadlineMs - nowMs) / 60_000,
                  )} more minute(s))`
                : ""
            }.`,
      );
      while (loop.status === "running") {
        if ((yield* now) >= deadlineMs) {
          timedOut = true;
          timedOutBy = bound;
          break;
        }
        yield* sleep;
        // A read that briefly reports no loop (a restart) keeps the last one.
        loop = forThisTurn((yield* input.status).loop) ?? loop;
      }
    }

    const history = yield* input.history;
    const rounds = history.rounds
      .map((entry) => entry.round)
      .filter((round) => round.loopId === loop.id);
    return {
      loop,
      rounds,
      waitedMs: (yield* now) - started,
      timedOut,
      timedOutBy,
    };
  });

/** The durable summary a run writes: rounds, decisions, reasons and the final build. */
export const summarizeRepairLoop = (input: {
  readonly watched: WatchedRepairLoop;
  readonly selectedBuildId: string | null;
}): GameE2eRepairLoopRead => ({
  id: input.watched.loop.id,
  status: input.watched.loop.status,
  decision: input.watched.loop.decision,
  reason: input.watched.loop.reason,
  startedAt: input.watched.loop.startedAt,
  finishedAt: input.watched.loop.finishedAt,
  repairsUsed: input.watched.loop.repairsUsed,
  budget: input.watched.loop.budget,
  rounds: input.watched.rounds.map((round) => ({
    id: round.id,
    status: round.status,
    decision: round.decision ?? null,
    reason: round.reason ?? null,
    candidateBuildId: round.candidate?.buildId ?? null,
    candidateDirectory: round.candidate?.directory ?? null,
    startedAt: round.startedAt,
    finishedAt: round.finishedAt,
  })),
  selectedBuildId: input.selectedBuildId,
  waitedMs: input.watched.waitedMs,
  timedOut: input.watched.timedOut,
  timedOutBy: input.watched.timedOutBy,
});
