// A game run's long work runs here, never inside an effect: effect claims are
// short leases on a pool every thread's provider work shares. A step's effect
// hands its job over and returns at once; the job reports back with commands.
// Jobs are in-process only, so a restart loses them and GameRunRecovery
// starts again what a lost job left unfinished (every step is safe to repeat).
import {
  GameRunId as GameRunIdSchema,
  type GameRunId,
  type GameRunStepId,
  type ThreadId,
} from "@kurambit/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
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

/** What a step's job does; the game layer supplies it once its services exist. */
export interface GameRunJobRunner {
  /** A step's work, reported with game-run.step.complete or game-run.step.fail. */
  readonly execute: (job: GameRunStepJob) => Effect.Effect<void>;
  /** A role turn's cap: interrupts its run once the cap is due. */
  readonly deadline: (job: GameRunStepJob) => Effect.Effect<void>;
  /** A run's ending: stops its turns and jobs, does its last outputs and exports, records it. */
  readonly finish: (job: GameRunFinishJob) => Effect.Effect<void>;
}

// Heavy work inside a step takes the game layer's own locks and memory guards;
// this bounds how many steps of all games run at once.
const STEP_CONCURRENCY = 4;

export class GameRunJobs extends Context.Service<
  GameRunJobs,
  {
    /** Starts the step's work unless a job for that attempt is live; returns at once. */
    readonly execute: (job: GameRunStepJob) => Effect.Effect<void>;
    /** Watches a role turn's cap unless a watch for that attempt is live; returns at once. */
    readonly deadline: (job: GameRunStepJob) => Effect.Effect<void>;
    /** Finishes an ending unless its finish is live; returns at once. Finishing twice is safe. */
    readonly finish: (job: GameRunFinishJob) => Effect.Effect<void>;
    /** Any other work of a run's (a role turn sent again after a pause), once per key. */
    readonly fork: (
      key: string,
      runId: GameRunId,
      work: Effect.Effect<void>,
    ) => Effect.Effect<void>;
    /** Interrupts every job of the run and waits for them to end. */
    readonly stopRun: (runId: GameRunId) => Effect.Effect<void>;
    readonly isLive: (key: string) => Effect.Effect<boolean>;
    readonly attach: (runner: GameRunJobRunner) => Effect.Effect<void>;
  }
>()("kurambit/orchestration-v2/gameRun/GameRunJobs") {}

const finishOwner = (runId: GameRunId) => GameRunIdSchema.make(`${runId}:finish`);

export const stepJobKey = (job: GameRunStepJob, kind: "execute" | "deadline"): string =>
  `${kind}:${job.stepId}:attempt:${job.attempt}`;

export const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const runner = yield* Deferred.make<GameRunJobRunner>();
  const permits = yield* Semaphore.make(STEP_CONCURRENCY);
  const live = new Map<string, { readonly runId: GameRunId; fiber: Fiber.Fiber<void> | null }>();

  // Registered before the fork and removed only once the work ends, so a job
  // whose last act was a committed report is never started twice meanwhile.
  const fork = (key: string, runId: GameRunId, work: Effect.Effect<void>) =>
    Effect.suspend(() => {
      if (live.has(key)) return Effect.void;
      const entry: { readonly runId: GameRunId; fiber: Fiber.Fiber<void> | null } = {
        runId,
        fiber: null,
      };
      live.set(key, entry);
      return work.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("game run job failed", { key, cause }),
        ),
        Effect.ensuring(Effect.sync(() => live.get(key) === entry && live.delete(key))),
        Effect.forkIn(scope),
        Effect.tap((fiber) => Effect.sync(() => void (entry.fiber = fiber))),
        Effect.uninterruptible,
        Effect.asVoid,
      );
    });

  const execute = (job: GameRunStepJob) =>
    fork(
      stepJobKey(job, "execute"),
      job.runId,
      permits.withPermits(1)(
        Deferred.await(runner).pipe(Effect.flatMap((each) => each.execute(job))),
      ),
    );
  const deadline = (job: GameRunStepJob) =>
    fork(
      stepJobKey(job, "deadline"),
      job.runId,
      Deferred.await(runner).pipe(Effect.flatMap((each) => each.deadline(job))),
    );

  // Kept apart from the run's own jobs, which the finish stops first.
  const finish = (job: GameRunFinishJob) =>
    fork(
      `finish:${job.runId}:${job.endedAt}`,
      finishOwner(job.runId),
      Deferred.await(runner).pipe(Effect.flatMap((each) => each.finish(job))),
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
    deadline,
    finish,
    fork,
    stopRun,
    isLive: (key) => Effect.sync(() => live.has(key)),
    attach: (each) => Deferred.succeed(runner, each).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GameRunJobs, make);
