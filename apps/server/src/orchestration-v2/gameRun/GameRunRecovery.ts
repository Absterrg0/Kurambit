// At startup, the ProviderRuntimeRecoveryService way: a running game run whose
// step a restart cut off gets that step's job again. Every step is safe to
// repeat, and the job itself finds what an earlier try left (a role's thread,
// its finished turn) before doing anything. A decision needs no job: its
// deadline is a durable effect, and only a presentation that ended while the
// server was down is caught up. An ended or stopped run is never touched.
import type { ThreadId } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../ProjectionStore.ts";
import * as GameRunDecisions from "./GameRunDecisions.ts";
import * as GameRunJobs from "./GameRunJobs.ts";

export class GameRunRecovery extends Context.Service<
  GameRunRecovery,
  { readonly recover: () => Effect.Effect<void> }
>()("kurambit/orchestration-v2/gameRun/GameRunRecovery") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const jobs = yield* GameRunJobs.GameRunJobs;
  const decisions = yield* GameRunDecisions.GameRunDecisions;

  const recoverThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const records = yield* projections.getGameRunRecords(threadId, { steps: "in-flight" });
      const run = records.gameRuns.at(-1);
      if (run === undefined || run.status === "ended" || run.inFlight === null) return;
      const step = records.gameRunSteps.find(
        (each) => each.runId === run.id && each.seq === run.inFlight,
      );
      if (step === undefined || (step.status !== "planned" && step.status !== "running")) return;
      if (step.kind === "decide") return yield* decisions.presented(threadId);
      yield* jobs.execute({ threadId, runId: run.id, stepId: step.id, attempt: step.attempt });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("game run recovery failed for a thread", { threadId, cause }),
      ),
    );

  const recover = () =>
    projections.listLiveGameRunThreads().pipe(
      Effect.flatMap((threads) => Effect.forEach(threads, recoverThread, { discard: true })),
      Effect.catchCause((cause) => Effect.logWarning("game run recovery failed", { cause })),
    );

  return GameRunRecovery.of({ recover });
});

export const layer = Layer.effect(GameRunRecovery, make);
