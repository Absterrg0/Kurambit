// A game run's long work runs here, never inside an effect: effect claims are
// short leases on a pool every thread's provider work shares. A step's effect
// hands its job over and returns at once; the job reports back with commands.
// Jobs are in-process only, so a restart loses them and GameRunRecovery
// starts again what a lost job left unfinished (every step is safe to repeat).
// A step's timers (a read and a dispatch or an interrupt) and a landing's
// outputs (notes written, copies released) are short, so they run inside their
// effects instead: the effect stays unsettled until its work is done, and the
// outbox runs it again after a failure or a server death.
import {
  GameRunId as GameRunIdSchema,
  type GameRunId,
  type GameRunQuestion,
  type GameRunStepId,
  type ThreadId,
} from "@kurambit/contracts";
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

export interface GameRunFinishJob {
  readonly threadId: ThreadId;
  readonly runId: GameRunId;
  /** The ending this finish is for: a run that ends again owes a finish of its own. */
  readonly endedAt: string;
}

export interface GameRunResend extends GameRunStepJob {
  /** Why the turn goes again: an instant failure, or an explore start refused for memory. */
  readonly turn: "retry" | "memory";
  readonly n: number;
}

/** What a step's landing asks of the game folder; GameRunOutputs' effect does it. */
export interface GameRunOutputs {
  readonly threadId: ThreadId;
  readonly runId: GameRunId;
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>;
  readonly release: ReadonlyArray<ThreadId>;
}

/** A timer's or an outputs effect's work that did not get done; its effect is tried again. */
export class GameRunEffectError extends Data.TaggedError("GameRunEffectError")<{
  readonly cause: unknown;
}> {}

export interface GameRunRestoreJob {
  readonly threadId: ThreadId;
  readonly runId: GameRunId;
  readonly requestId: string;
}

/** What a step's job does; the game layer supplies it once its services exist. */
export interface GameRunJobRunner {
  /** A step's work, reported with game-run.step.complete or game-run.step.fail. */
  readonly execute: (job: GameRunStepJob) => Effect.Effect<void>;
  /** A role turn's cap: interrupts its run once due, else sets the timer again; inside its effect. */
  readonly deadline: (job: GameRunStepJob) => Effect.Effect<void, GameRunEffectError>;
  /** A run's ending: stops its turns and jobs, does its last outputs and exports, records it. */
  readonly finish: (job: GameRunFinishJob) => Effect.Effect<void>;
  /** A creator's restore of a kept round: moves the folder, lands with game-run.restore. */
  readonly restore: (job: GameRunRestoreJob) => Effect.Effect<void>;
  /** A role turn sent again once its pause is over, then capped like the first; inside its effect. */
  readonly resend: (job: GameRunResend) => Effect.Effect<void, GameRunEffectError>;
  /** A landing's records written and copies released; inside its effect, and safe to repeat. */
  readonly outputs: (job: GameRunOutputs) => Effect.Effect<void, GameRunEffectError>;
  /** Whether the game folder holds anything of a decision's evidence to show the creator. */
  readonly showable: (
    threadId: ThreadId,
    lane: string,
    decision: GameRunQuestion,
  ) => Effect.Effect<boolean>;
}

// Heavy work inside a step takes the game layer's own locks and memory guards;
// this bounds how many steps of all games run at once.
const STEP_CONCURRENCY = 4;

export class GameRunJobs extends Context.Service<
  GameRunJobs,
  {
    /** Starts the step's work unless a job for that attempt is live; returns at once. */
    readonly execute: (job: GameRunStepJob) => Effect.Effect<void>;
    /** A role turn's cap, run in the caller's fiber: the step.deadline effect's own work. */
    readonly deadline: GameRunJobRunner["deadline"];
    /** Finishes an ending unless its finish is live; returns at once. Finishing twice is safe. */
    readonly finish: (job: GameRunFinishJob) => Effect.Effect<void>;
    /** Runs a restore unless one for that request is live; returns at once. */
    readonly restore: (job: GameRunRestoreJob) => Effect.Effect<void>;
    /** A role turn sent again, run in the caller's fiber: the step.resend effect's own work. */
    readonly resend: GameRunJobRunner["resend"];
    /** A landing's outputs, run in the caller's fiber: the game-run.outputs effect's own work. */
    readonly outputs: GameRunJobRunner["outputs"];
    /** Any other work of a run's (a settled role turn's landing), once per key. */
    readonly fork: (
      key: string,
      runId: GameRunId,
      work: Effect.Effect<void>,
    ) => Effect.Effect<void>;
    /** Interrupts every job of the run and waits for them to end. */
    readonly stopRun: (runId: GameRunId) => Effect.Effect<void>;
    readonly isLive: (key: string) => Effect.Effect<boolean>;
    /** The runner's answer, once it is attached. */
    readonly showable: GameRunJobRunner["showable"];
    readonly attach: (runner: GameRunJobRunner) => Effect.Effect<void>;
  }
>()("kurambit/orchestration-v2/gameRun/GameRunJobs") {}

const finishOwner = (runId: GameRunId) => GameRunIdSchema.make(`${runId}:finish`);

export const stepJobKey = (job: GameRunStepJob): string =>
  `execute:${job.stepId}:attempt:${job.attempt}`;

export const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const runner = yield* Deferred.make<GameRunJobRunner>();
  const permits = yield* Semaphore.make(STEP_CONCURRENCY);

  // Registered before the fork and removed only once the work ends, so a job
  // whose last act was a committed report is never started twice meanwhile. A
  // job asked for while it runs (a pair half handed back while its sibling is
  // still preparing) runs once more when it ends, reading the records afresh:
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
            : Effect.logWarning("game run job failed", { key, cause }),
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
        Deferred.await(runner).pipe(Effect.flatMap((each) => each.execute(job))),
      ),
    );
  // Kept apart from the run's own jobs, which the finish stops first.
  const finish = (job: GameRunFinishJob) =>
    fork(
      `finish:${job.runId}:${job.endedAt}`,
      finishOwner(job.runId),
      Deferred.await(runner).pipe(Effect.flatMap((each) => each.finish(job))),
    );

  // Its own owner too: a finish's stop must not cut a restore that already holds the folder.
  const restore = (job: GameRunRestoreJob) =>
    fork(
      `restore:${job.runId}:${job.requestId}`,
      GameRunIdSchema.make(`${job.runId}:restore`),
      Deferred.await(runner).pipe(Effect.flatMap((each) => each.restore(job))),
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
    finish,
    restore,
    resend: (job) => Deferred.await(runner).pipe(Effect.flatMap((each) => each.resend(job))),
    outputs: (job) => Deferred.await(runner).pipe(Effect.flatMap((each) => each.outputs(job))),
    fork,
    stopRun,
    isLive: (key) => Effect.sync(() => live.has(key)),
    showable: (threadId, lane, decision) =>
      Deferred.await(runner).pipe(
        Effect.flatMap((each) => each.showable(threadId, lane, decision)),
      ),
    attach: (each) => Deferred.succeed(runner, each).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GameRunJobs, make);
