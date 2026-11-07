// At startup, the ProviderRuntimeRecoveryService way. A keep-going run whose
// step a restart cut off gets that step's job again, always through the
// outbox, so it runs behind whatever its thread still owes; every step is
// safe to repeat. A run made by an earlier Kurambit (the stage era) cannot go
// on: one still live is stopped with why, and every role turn such a run
// launched that T3 continued after the restart is stopped, so nothing edits a
// game outside the person's own chats.
import { CommandId, type ThreadId } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EffectOutbox from "../EffectOutbox.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { retrying } from "../../game/run/retrying.ts";
import { STAGE_ERA_SENTENCE } from "../../game/run/runView.ts";
import { stageEra } from "./decide.ts";

export class GameRunRecovery extends Context.Service<
  GameRunRecovery,
  { readonly recover: () => Effect.Effect<void> }
>()("kurambit/orchestration-v2/gameRun/GameRunRecovery") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const engine = yield* Orchestrator.OrchestratorV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;

  // No keep-going run launches a thread of its own: every live role turn is a stage-era run's.
  const stopRoleTurns = Effect.gen(function* () {
    const turns = yield* retrying(projections.listLiveGameRunRoleTurns());
    for (const turn of turns)
      yield* engine
        .dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`server:game-run-unnamed-role:${turn.runId}`),
          threadId: turn.threadId,
          runId: turn.runId,
          reason: "The production run that launched this role turn no longer exists.",
        })
        .pipe(
          retrying,
          Effect.catchCause((cause) =>
            Effect.logWarning("a stage-era role turn could not be stopped", {
              threadId: turn.threadId,
              cause,
            }),
          ),
        );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("game run recovery could not list role turns", { cause }),
    ),
  );

  const recoverThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const records = yield* projections.getGameRunRecords(threadId, { steps: "in-flight" });
      const run = records.gameRuns.at(-1);
      if (run === undefined || run.status === "ended") return;
      if (stageEra(run)) {
        yield* Effect.logWarning("stopping a game run made by an earlier Kurambit", {
          threadId,
          runId: run.id,
        });
        yield* engine.dispatch({
          type: "game-run.stop",
          commandId: CommandId.make(`server:game-run-stage-era:${run.id}`),
          threadId,
          runId: run.id,
          reason: STAGE_ERA_SENTENCE,
        });
        return;
      }
      // A live run on a chat deleted before deletion stopped its run: nothing
      // could reach it, so it stops now.
      const chat = yield* projections.getThread(threadId);
      if (chat.deletedAt !== null) {
        yield* engine.dispatch({
          type: "game-run.stop",
          commandId: CommandId.make(`server:game-run-chat-deleted:${run.id}`),
          threadId,
          runId: run.id,
        });
        return;
      }
      if (run.inFlight === null) return;
      const step = records.gameRunSteps.find(
        (each) => each.runId === run.id && each.seq === run.inFlight,
      );
      if (step === undefined || (step.status !== "planned" && step.status !== "running")) return;
      // An effect still owed drives the step; otherwise a durable wake does,
      // in the outbox's order, never a job started from here.
      if (
        yield* outbox.hasUnsettled({
          threadId,
          effectTypes: ["game-run.step.execute", "game-run.step.wake", "game-run.step.resend"],
        })
      )
        return;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      yield* engine.dispatch({
        type: "game-run.step.schedule",
        commandId: CommandId.make(
          `server:game-run-recover:${step.id}:attempt:${step.attempt}:${now}`,
        ),
        threadId,
        runId: run.id,
        stepId: step.id,
        attempt: step.attempt,
        at: now,
        timer: { kind: "recover" },
      });
    }).pipe(
      // Every part of it is safe to repeat; a thread whose reads never get
      // through is logged and recovered at the next startup.
      retrying,
      Effect.catchCause((cause) =>
        Effect.logWarning("game run recovery failed for a thread", { threadId, cause }),
      ),
    );

  const recover = () =>
    stopRoleTurns.pipe(
      Effect.andThen(retrying(projections.listGameRunThreadsToRecover())),
      Effect.flatMap((threads) => Effect.forEach(threads, recoverThread, { discard: true })),
      Effect.catchCause((cause) => Effect.logWarning("game run recovery failed", { cause })),
    );

  return GameRunRecovery.of({ recover });
});

export const layer = Layer.effect(GameRunRecovery, make);
