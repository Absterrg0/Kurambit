// A decision that settled while the server was down still owes its clean-up:
// recovery drops its wake, so no queued question asks what is decided.
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
const runId = GameRunId.make("run_recovered");
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

it.effect("recovery cleans up the decision that settled last", () =>
  Effect.gen(function* () {
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
      step(3, "decide", []),
      step(4, "decide", [".studio/next.md"]),
      step(5, "decide", [], false),
    ];
    const dropped: number[] = [];
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
          Layer.mock(GameRunJobs.GameRunJobs)({}),
          Layer.mock(GameRunDecisions.GameRunDecisions)({
            presented: () => Effect.void,
            drop: (_thread, settled) => Effect.sync(() => void dropped.push(settled.seq)),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({}),
        ),
      ),
    );
    yield* Effect.flatMap(GameRunRecovery.GameRunRecovery, (recovery) => recovery.recover()).pipe(
      Effect.provide(layer),
    );
    assert.deepEqual(dropped, [4]);
  }),
);
