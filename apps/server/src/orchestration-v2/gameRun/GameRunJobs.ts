// A keep-going step's long work runs here, never inside an effect: effect
// claims are short leases on a pool every thread's provider work shares. A
// step's effect hands its job over and returns at once; the job reports back
// with commands. Jobs are in-process only, so a restart loses them and
// GameRunRecovery starts again what a lost job left unfinished (every step is
// safe to repeat). A step's timers (a read and a dispatch or an interrupt) are
// short, so they run inside their effects instead: the effect stays unsettled
// until its work is done, and the outbox runs it again after a failure or a
// server death.
import { type GameRunId, type GameRunStepId, type ThreadId } from "@kurambit/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export interface GameRunStepJob {
  /** The game's creator thread, whose stream holds the run's records. */
  readonly threadId: ThreadId;
  readonly runId: GameRunId;
  readonly stepId: GameRunStepId;
  readonly attempt: number;
}

export interface GameRunResend extends GameRunStepJob {
  /** Why the turn goes again: an instant failure ("memory": a stage-era row only). */
  readonly turn: "retry" | "memory";
  readonly n: number;
}

/**
 * Which try of its effect a timer is: on the outbox's last try (`final`) the
 * work gives up its own way, so nothing is lost with it.
 */
export interface GameRunEffectTry {
  readonly effectId: string;
  readonly final: boolean;
}

/** A timer's work that did not get done; its effect is tried again. */
export class GameRunEffectError extends Data.TaggedError("GameRunEffectError")<{
  readonly cause: unknown;
}> {}

/** What a step's job does; the game layer supplies it once its services exist. */
export interface GameRunJobRunner {
  /** A step's work, by its kind (look, turn, judge, undo), reported with game-run.step.complete or .fail. */
  readonly runStep: (job: GameRunStepJob) => Effect.Effect<void>;
  /** A step turn's cap: interrupts its run once due, else sets the timer again; inside its effect. */
  readonly deadline: (
    job: GameRunStepJob & GameRunEffectTry,
  ) => Effect.Effect<void, GameRunEffectError>;
  /** A step turn sent again once its pause is over, then capped like the first; inside its effect. */
  readonly resend: (
    job: GameRunResend & GameRunEffectTry,
  ) => Effect.Effect<void, GameRunEffectError>;
}

// Heavy work inside a step takes the game layer's own locks and memory guards;
// this bounds how many steps of all games run at once.
const STEP_CONCURRENCY = 4;

export class GameRunJobs extends Context.Service<
  GameRunJobs,
  {
    /** Starts the step's work unless a job for that attempt is live; returns at once. */
    readonly execute: (job: GameRunStepJob) => Effect.Effect<void>;
    /** A step turn's cap, run in the caller's fiber: the step.deadline effect's own work. */
    readonly deadline: GameRunJobRunner["deadline"];
    /** A step turn sent again, run in the caller's fiber: the step.resend effect's own work. */
    readonly resend: GameRunJobRunner["resend"];
    /** Any other work of a run's (a settled step turn's landing), once per key. */
    readonly fork: (
      key: string,
      runId: GameRunId,
      work: Effect.Effect<void>,
    ) => Effect.Effect<void>;
    /** Interrupts every job of the run and waits for them to end. */
    readonly stopRun: (runId: GameRunId) => Effect.Effect<void>;
    readonly attach: (runner: GameRunJobRunner) => Effect.Effect<void>;
  }
>()("kurambit/orchestration-v2/gameRun/GameRunJobs") {}

const stepJobKey = (job: GameRunStepJob): string => `execute:${job.stepId}:attempt:${job.attempt}`;

export const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const runner = yield* Deferred.make<GameRunJobRunner>();
  const permits = yield* Semaphore.make(STEP_CONCURRENCY);

  // Registered before the fork and removed only once the work ends, so a job
  // whose last act was a committed report is never started twice meanwhile. A
  // job asked for while it runs (a recovery wake while the first try still
  // winds down) runs once more when it ends, reading the records afresh:
  // at most one re-run is pending, a request during the re-run is kept for
  // the next, and an interrupt (a stop) drops whatever is pending.
  interface LiveJob {
    readonly runId: GameRunId;
    fiber: Fiber.Fiber<void> | null;
    again: boolean;
  }
  const live = new Map<string, LiveJob>();
  const fork = (key: string, runId: GameRunId, work: Effect.Effect<void>) =>
    Effect.suspend(() => {
      const running = live.get(key);
      if (running !== undefined) {
        running.again = true;
        return Effect.void;
      }
      const entry: LiveJob = { runId, fiber: null, again: false };
      live.set(key, entry);
      // The check for a pending re-run and the job's removal are one step, so
      // a request can never land between them and be lost.
      const settle = Effect.suspend((): Effect.Effect<void> => {
        if (entry.again) {
          entry.again = false;
          return runOnce;
        }
        if (live.get(key) === entry) live.delete(key);
        return Effect.void;
      });
      const runOnce: Effect.Effect<void> = work.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("game run job failed", { key, cause: Cause.pretty(cause) }),
        ),
        Effect.andThen(settle),
      );
      return runOnce.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry.again = false;
            if (live.get(key) === entry) live.delete(key);
          }),
        ),
        Effect.forkIn(scope),
        Effect.tap((fiber) => Effect.sync(() => void (entry.fiber = fiber))),
        Effect.uninterruptible,
        Effect.asVoid,
      );
    });

  const execute = (job: GameRunStepJob) =>
    fork(
      stepJobKey(job),
      job.runId,
      permits.withPermits(1)(
        Deferred.await(runner).pipe(Effect.flatMap((each) => each.runStep(job))),
      ),
    );
  // The game layer attaches the work when it builds; a server where it never
  // does would hold every run's effects forever without a word.
  yield* Deferred.await(runner).pipe(
    Effect.timeoutOption("2 minutes"),
    Effect.flatMap((attached) =>
      attached._tag === "None"
        ? Effect.logWarning("no game run job runner attached; game run steps are waiting")
        : Effect.void,
    ),
    Effect.forkIn(scope),
  );

  const stopRun = (runId: GameRunId) =>
    Effect.suspend(() =>
      Fiber.interruptAll(
        [...live.values()].flatMap((entry) =>
          entry.runId === runId && entry.fiber !== null ? [entry.fiber] : [],
        ),
      ),
    );

  return GameRunJobs.of({
    execute,
    deadline: (job) => Deferred.await(runner).pipe(Effect.flatMap((each) => each.deadline(job))),
    resend: (job) => Deferred.await(runner).pipe(Effect.flatMap((each) => each.resend(job))),
    fork,
    stopRun,
    attach: (each) => Deferred.succeed(runner, each).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GameRunJobs, make);
