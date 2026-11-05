// The records an older Kurambit's next job would have written survive an
// upgrade: recovery writes the ones the run's last landings still owe.
import { assert, it } from "@effect/vitest";
import {
  type GameRun,
  GameRunId,
  type GameRunStep,
  gameRunStepId,
  ThreadId,
} from "@kurambit/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EffectOutbox from "../EffectOutbox.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as GameRunDecisions from "./GameRunDecisions.ts";
import * as GameRunJobs from "./GameRunJobs.ts";
import * as GameRunRecovery from "./GameRunRecovery.ts";

const threadId = ThreadId.make("thread:creator");
const runId = GameRunId.make("run_upgrade");
const file = (path: string) => ({ path, text: `${path}\n` });
const step = (seq: number, kind: GameRunStep["kind"], files: string[], landed = true) =>
  ({
    id: gameRunStepId(runId, seq),
    runId,
    threadId,
    seq,
    attempt: 1,
    kind,
    status: landed ? "completed" : "planned",
    outputs: { files: files.map(file), release: [] },
    completedAt: landed ? "2026-11-01T00:00:00.000Z" : null,
  }) as unknown as GameRunStep;

it.effect("recovery writes what the landings since the last non-decision step still owe", () =>
  Effect.gen(function* () {
    // A role landed, then a decision; the next decision waits: under the walk-back
    // the job after it would have written both landings' records, in order.
    const run = {
      id: runId,
      threadId,
      status: "waiting",
      versions: "checkpoints",
      inFlight: 5,
      endedAt: null,
      finished: null,
      restore: null,
    } as unknown as GameRun;
    const steps = [
      step(2, "role", [".studio/older.md"]),
      step(3, "role", [".studio/ladder.json"]),
      step(4, "decide", [".studio/next.md"]),
      step(5, "decide", [], false),
    ];
    const written: string[][] = [];
    const layer = GameRunRecovery.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            listLiveGameRunRoleTurns: () => Effect.succeed([]),
            listGameRunThreadsToRecover: () => Effect.succeed([threadId]),
            getThread: () => Effect.succeed({ deletedAt: null } as never),
            getGameRunRecords: (_threadId, filter) =>
              Effect.succeed({
                gameRuns: [run],
                gameRunSteps:
                  filter?.steps === "in-flight" ? steps.filter((s) => s.seq === 5) : steps,
                gameRunRounds: [],
              }),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({ hasUnsettled: () => Effect.succeed(false) }),
          Layer.mock(GameRunJobs.GameRunJobs)({
            outputs: (job) => Effect.sync(() => void written.push(job.files.map((f) => f.path))),
          }),
          Layer.mock(GameRunDecisions.GameRunDecisions)({ presented: () => Effect.void }),
          Layer.mock(Orchestrator.OrchestratorV2)({}),
        ),
      ),
    );
    yield* Effect.flatMap(GameRunRecovery.GameRunRecovery, (recovery) => recovery.recover()).pipe(
      Effect.provide(layer),
    );
    assert.deepEqual(written, [[".studio/ladder.json", ".studio/next.md"]]);
  }),
);
