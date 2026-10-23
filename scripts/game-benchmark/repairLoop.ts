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
  /** How long the loop has to appear after the builder turn ends. */
  readonly startGraceMs?: number | undefined;
  /** Slack over the loop's own budget before a hung loop stops the wait. */
  readonly marginMs?: number | undefined;
  readonly pollMs?: number | undefined;
  readonly onWait?: ((message: string) => void) | undefined;
}

export interface WatchedRepairLoop {
  readonly loop: RepairLoopView;
  readonly rounds: ReadonlyArray<RepairRoundView>;
  readonly waitedMs: number;
  readonly timedOut: boolean;
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
 * Waits for the review loop the builder turn started, then until that loop is
 * terminal. The wait is bounded by the loop's own budget plus a shutdown
 * margin: a loop that never opens returns `null` after the start grace, and a
 * loop that outlives its bound returns `timedOut` rather than hanging a run.
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

    const started = yield* now;
    let loop = (yield* input.status).loop;
    while (loop === null) {
      if ((yield* now) - started >= startGraceMs) return null;
      yield* sleep;
      loop = (yield* input.status).loop;
    }

    // A loop already terminal on the first read needs no wait at all.
    const loopStartedAt = Date.parse(loop.startedAt);
    const deadline =
      (Number.isFinite(loopStartedAt) ? loopStartedAt : started) + loop.budget.elapsedMs + marginMs;
    let timedOut = false;
    if (loop.status === "running") {
      input.onWait?.(
        `Review loop ${loop.id} is running; waiting up to ${Math.round(
          Math.max(0, deadline - (yield* now)) / 60_000,
        )} more minute(s) for it to finish.`,
      );
      while (loop.status === "running") {
        if ((yield* now) >= deadline) {
          timedOut = true;
          break;
        }
        yield* sleep;
        // A read that briefly reports no loop (a restart) keeps the last one.
        loop = (yield* input.status).loop ?? loop;
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
});
