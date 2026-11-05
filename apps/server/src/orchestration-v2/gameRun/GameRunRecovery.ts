// At startup, the ProviderRuntimeRecoveryService way: a running game run whose
// step a restart cut off gets that step's job again, always through the
// outbox, so it runs behind whatever its thread still owes (a landing's
// outputs). Every step is safe to repeat, and the job itself finds what an
// earlier try left (a role's thread, its finished turn) before doing anything. A decision needs no job: its
// deadline is a durable effect, and only a presentation that ended while the
// server was down is caught up. An ended or stopped run is never continued;
// only its finish, if a restart cut it short, runs again. A role turn no step
// record names (a thread an older Kurambit's run launched, which T3 continued
// after the restart) is stopped, so nothing edits a game outside its run.
import { CommandId, type ThreadId } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EffectOutbox from "../EffectOutbox.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as GameRunDecisions from "./GameRunDecisions.ts";
import { retrying } from "../../game/run/retrying.ts";
import { gitEra, owedOutputs } from "./decide.ts";
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
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const owes = (
    threadId: ThreadId,
    effectTypes: EffectOutbox.OrchestrationEffectRequestV2["type"][],
  ) => outbox.hasUnsettled({ threadId, effectTypes });

  const stopUnnamedRoleTurns = Effect.gen(function* () {
    const turns = yield* retrying(projections.listLiveGameRunRoleTurns());
    const named = new Map<ThreadId, ReadonlySet<ThreadId>>();
    const namedUnder = (parent: ThreadId) =>
      Effect.gen(function* () {
        const known = named.get(parent);
        if (known !== undefined) return known;
        // Records that cannot be read name nothing for sure: no turn under
        // that parent is stopped on a guess (null), since it may be the run's.
        const records = yield* retrying(projections.getGameRunRecords(parent)).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (records === null) return null;
        const threads = new Set(
          records.gameRunSteps.flatMap((step) =>
            step.roles.flatMap((role) => (role.threadId === null ? [] : [role.threadId])),
          ),
        );
        named.set(parent, threads);
        return threads;
      });
    for (const turn of turns) {
      const named =
        turn.parentThreadId === null ? new Set() : yield* namedUnder(turn.parentThreadId);
      if (named === null || named.has(turn.threadId)) continue;
      yield* engine
        .dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`server:game-run-unnamed-role:${turn.runId}`),
          threadId: turn.threadId,
          runId: turn.runId,
          reason: "No production run holds this role turn.",
        })
        .pipe(
          retrying,
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
      // A finish or restore whose effect is still owed runs from it, behind
      // the outputs before it: run here it could move the folder under their
      // writes. One whose effect was already taken (so everything before it
      // ran) lost only its job, which starts again here.
      if (run.status === "ended") {
        if (
          run.endedAt !== null &&
          run.finished !== run.endedAt &&
          !(yield* owes(threadId, ["game-run.finish"]))
        )
          yield* jobs.finish({ threadId, runId: run.id, endedAt: run.endedAt });
        // A restore whose job a restart cut off runs again: it checks the folder first.
        if (
          run.restore !== null &&
          run.restore.outcome === null &&
          !(yield* owes(threadId, ["game-run.restore.execute"]))
        )
          yield* jobs.restore({ threadId, runId: run.id, requestId: run.restore.requestId });
        return;
      }
      // A run an older Kurambit left live on git branches cannot go on: it stops
      // without touching the folder ("stopped" exports nothing), so the work
      // its round left checked out stays exactly where it is.
      if (gitEra(run)) {
        yield* Effect.logWarning("stopping a game run that kept its builds on git branches", {
          threadId,
          runId: run.id,
          stage: run.stage,
        });
        yield* engine.dispatch({
          type: "game-run.stop",
          commandId: CommandId.make(`server:game-run-git-era:${run.id}`),
          threadId,
          runId: run.id,
        });
        return;
      }
      // A live run on a chat deleted before deletion stopped its run: nothing
      // could reach it, so it stops now, and its finish stops its roles.
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
      // Writing them again is harmless; this covers an upgrade from the walk-back.
      const files =
        owedOutputs(run, (yield* projections.getGameRunRecords(threadId)).gameRunSteps)?.files ??
        [];
      if (files.length > 0)
        yield* jobs
          .outputs({
            threadId,
            runId: run.id,
            files,
            release: [],
            effectId: `recovery:${run.id}`,
            final: false,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("a game run's owed records could not be written", {
                threadId,
                error,
              }),
            ),
          );
      if (run.inFlight === null) return;
      const step = records.gameRunSteps.find(
        (each) => each.runId === run.id && each.seq === run.inFlight,
      );
      if (step === undefined || (step.status !== "planned" && step.status !== "running")) return;
      if (step.kind === "decide") return yield* decisions.presented(threadId);
      // An effect still owed drives the step; otherwise a durable wake does,
      // in the outbox's order, never a job started from here.
      if (yield* owes(threadId, ["game-run.step.execute", "game-run.step.wake"])) return;
      yield* engine.dispatch({
        type: "game-run.step.schedule",
        commandId: CommandId.make(
          `server:game-run-recover:${step.id}:attempt:${step.attempt}:${DateTime.toEpochMillis(yield* DateTime.now)}`,
        ),
        threadId,
        runId: run.id,
        stepId: step.id,
        attempt: step.attempt,
        at: DateTime.toEpochMillis(yield* DateTime.now),
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

  // A thread whose reads keep failing is logged and waits for the next startup.
  const recover = () =>
    stopUnnamedRoleTurns.pipe(
      Effect.andThen(retrying(projections.listGameRunThreadsToRecover())),
      Effect.flatMap((threads) => Effect.forEach(threads, recoverThread, { discard: true })),
      Effect.catchCause((cause) => Effect.logWarning("game run recovery failed", { cause })),
    );

  return GameRunRecovery.of({ recover });
});

export const layer = Layer.effect(GameRunRecovery, make);
