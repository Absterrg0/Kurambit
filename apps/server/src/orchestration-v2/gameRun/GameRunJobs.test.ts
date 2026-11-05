import { assert, it } from "@effect/vitest";
import { GameRunId } from "@kurambit/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";

import * as GameRunJobs from "./GameRunJobs.ts";

const runId = GameRunId.make("run_jobs");

// A job that reports each start and then waits to be let go.
const gated = Effect.gen(function* () {
  const started = yield* Queue.unbounded<number>();
  const gates: Array<Deferred.Deferred<void>> = [];
  let runs = 0;
  const work = Effect.gen(function* () {
    runs += 1;
    const gate = yield* Deferred.make<void>();
    gates.push(gate);
    yield* Queue.offer(started, runs);
    yield* Deferred.await(gate);
  });
  const release = (run: number) => Deferred.succeed(gates[run - 1]!, undefined);
  return { started, work, release, runs: () => runs };
});

it.effect("a job asked for while it runs runs once more, and an ask during that run is kept", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const jobs = yield* GameRunJobs.make;
      const job = yield* gated;
      yield* jobs.fork("step", runId, job.work);
      assert.equal(yield* Queue.take(job.started), 1);
      // Asked three times while it runs: one re-run is pending, not three.
      yield* jobs.fork("step", runId, job.work);
      yield* jobs.fork("step", runId, job.work);
      yield* jobs.fork("step", runId, job.work);
      yield* job.release(1);
      assert.equal(yield* Queue.take(job.started), 2);
      // Asked during the re-run: kept for one more.
      yield* jobs.fork("step", runId, job.work);
      yield* job.release(2);
      assert.equal(yield* Queue.take(job.started), 3);
      yield* job.release(3);
      assert.equal(job.runs(), 3);
    }),
  ),
);

it.effect("a stop drops the re-run a job had pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const jobs = yield* GameRunJobs.make;
      const job = yield* gated;
      yield* jobs.fork("step", runId, job.work);
      assert.equal(yield* Queue.take(job.started), 1);
      yield* jobs.fork("step", runId, job.work);
      yield* jobs.stopRun(runId);
      assert.isFalse(yield* jobs.isLive("step"));
      // A later ask is a new job, not the dropped re-run.
      const next = yield* Effect.forkChild(Queue.take(job.started));
      yield* jobs.fork("step", runId, job.work);
      assert.equal(yield* Fiber.join(next), 2);
      assert.equal(job.runs(), 2);
    }),
  ),
);
