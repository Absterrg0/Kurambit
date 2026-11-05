// At startup, the ProviderRuntimeRecoveryService way: a running game run whose
// step a restart cut off gets that step's job again. Every step is safe to
// repeat, and the job itself finds what an earlier try left (a role's thread,
// its finished turn) before doing anything. A decision needs no job: its
// deadline is a durable effect, and only a presentation that ended while the
// server was down is caught up. An ended or stopped run is never continued;
// only its finish, if a restart cut it short, runs again. A role turn no step
// record names (a thread an older Kurambit's run launched, which T3 continued
// after the restart) is stopped, so nothing edits a game outside its run.
import { CommandId, type ThreadId } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../Orchestrator.ts";
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
  const engine = yield* Orchestrator.OrchestratorV2;

  const stopUnnamedRoleTurns = Effect.gen(function* () {
    const turns = yield* projections.listLiveGameRunRoleTurns();
    const named = new Map<ThreadId, ReadonlySet<ThreadId>>();
    const namedUnder = (parent: ThreadId) =>
      Effect.gen(function* () {
        const known = named.get(parent);
        if (known !== undefined) return known;
        const records = yield* projections
          .getGameRunRecords(parent)
          .pipe(
            Effect.orElseSucceed(() => ({ gameRuns: [], gameRunSteps: [], gameRunRounds: [] })),
          );
        const threads = new Set(
          records.gameRunSteps.flatMap((step) =>
            step.roles.flatMap((role) => (role.threadId === null ? [] : [role.threadId])),
          ),
        );
        named.set(parent, threads);
        return threads;
      });
    for (const turn of turns) {
      if (
        turn.parentThreadId !== null &&
        (yield* namedUnder(turn.parentThreadId)).has(turn.threadId)
      )
        continue;
      yield* engine
        .dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`server:game-run-unnamed-role:${turn.runId}`),
          threadId: turn.threadId,
          runId: turn.runId,
          reason: "No production run holds this role turn.",
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("an unnamed game run role turn could not be stopped", {
              threadId: turn.threadId,
              cause,
            }),
          ),
        );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("game run recovery could not list role turns", { cause }),
    ),
  );

  const recoverThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const records = yield* projections.getGameRunRecords(threadId, { steps: "in-flight" });
      const run = records.gameRuns.at(-1);
      if (run === undefined) return;
      // An ending whose finish never completed (a death mid-finish, a lost job) finishes again.
      if (run.status === "ended") {
        if (run.endedAt !== null && run.finished !== run.endedAt)
          yield* jobs.finish({ threadId, runId: run.id, endedAt: run.endedAt });
        // A restore whose job a restart cut off runs again: it checks the folder first.
        if (run.restore !== null && run.restore.outcome === null)
          yield* jobs.restore({ threadId, runId: run.id, requestId: run.restore.requestId });
        return;
      }
      if (run.inFlight === null) return;
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
    stopUnnamedRoleTurns.pipe(
      Effect.andThen(projections.listGameRunThreadsToRecover()),
      Effect.flatMap((threads) => Effect.forEach(threads, recoverThread, { discard: true })),
      Effect.catchCause((cause) => Effect.logWarning("game run recovery failed", { cause })),
    );

  return GameRunRecovery.of({ recover });
});

export const layer = Layer.effect(GameRunRecovery, make);
