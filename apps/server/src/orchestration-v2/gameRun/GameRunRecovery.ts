// At startup, the ProviderRuntimeRecoveryService way. A keep-going run whose
// step a restart cut off gets that step's job again, always through the
// outbox, so it runs behind whatever its thread still owes; every step is
// safe to repeat. A step turn T3 carried over a restart that its run no
// longer wants (the run ended, or moved past that step) is stopped, so
// nothing edits a game the person turned keep going off for. A run made by
// an earlier Kurambit (the stage era) cannot go on: one still live is stopped
// with why, and every role turn such a run launched is stopped too.
import {
  CommandId,
  type GameRunId,
  type OrchestrationV2Run,
  type ThreadId,
} from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { retrying } from "../../game/run/retrying.ts";
import { STAGE_ERA_SENTENCE } from "../../game/run/runView.ts";
import { stageEra } from "../../game/run/state.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { type StepTurn, parseStepTurn } from "./ids.ts";

export class GameRunRecovery extends Context.Service<
  GameRunRecovery,
  { readonly recover: () => Effect.Effect<void> }
>()("kurambit/orchestration-v2/gameRun/GameRunRecovery") {}

const LIVE_TURN: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

interface StopDeps {
  readonly projections: ProjectionStore.ProjectionStoreV2Shape;
  readonly engine: Orchestrator.OrchestratorV2["Service"];
}

/**
 * Stops every live step turn on the thread that `keep` does not want (K11): a
 * queued one is cancelled, a running one interrupted, and its work still
 * becomes a build like any turn's. Only turns a step message started are
 * touched; the person's own turns never are.
 */
export const stopStepTurns = (
  deps: StopDeps,
  threadId: ThreadId,
  keep: (step: StepTurn) => boolean,
) =>
  Effect.gen(function* () {
    const { runs } = yield* deps.projections.getThreadRecords(threadId, ["runs"]);
    for (const turn of runs) {
      const step = parseStepTurn(turn.userMessageId);
      if (step === null || !LIVE_TURN.has(turn.status) || keep(step)) continue;
      const commandId = CommandId.make(`server:game-run-step-stop:${turn.id}`);
      yield* deps.engine.dispatch(
        turn.status === "queued"
          ? { type: "queued-run.cancel", commandId, threadId, runId: turn.id }
          : {
              type: "run.interrupt",
              commandId,
              threadId,
              runId: turn.id,
              reason: "Keep going no longer runs this step.",
            },
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("a keep-going step turn could not be stopped", { threadId, cause }),
    ),
  );

/** Every step turn but the one a live turns run holds in flight. */
const stepTurnsWanted =
  (
    run: { readonly id: GameRunId; readonly live: boolean } | null,
    inFlight: { readonly id: string; readonly attempt: number; readonly turn: boolean } | null,
  ) =>
  (step: StepTurn) =>
    run !== null &&
    run.live &&
    step.runId === run.id &&
    inFlight !== null &&
    inFlight.turn &&
    step.stepId === inFlight.id &&
    step.attempt === inFlight.attempt;

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

  /** A step turn on a thread with a turn running, checked against that thread's run. */
  const stopUnwantedStepTurns = Effect.gen(function* () {
    const shell = yield* retrying(projections.getShellSnapshot({ location: "active" }));
    for (const thread of shell.threads) {
      if (thread.activeRunId === null) continue;
      const records = yield* retrying(
        projections.getGameRunRecords(thread.id, { steps: "in-flight" }),
      );
      const run = records.gameRuns.at(-1) ?? null;
      const step =
        run === null
          ? null
          : (records.gameRunSteps.find((each) => each.seq === run.inFlight) ?? null);
      yield* stopStepTurns(
        { projections, engine },
        thread.id,
        stepTurnsWanted(
          run === null ? null : { id: run.id, live: run.status !== "ended" && !stageEra(run) },
          step === null
            ? null
            : { id: step.id, attempt: step.attempt, turn: step.step.kind === "turn" },
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("game run recovery could not check step turns", { cause }),
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
      // A proposal waits on its deadline effect, which the outbox kept.
      if (step.step.kind === "propose") return;
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
      Effect.andThen(stopUnwantedStepTurns),
      Effect.catchCause((cause) => Effect.logWarning("game run recovery failed", { cause })),
    );

  return GameRunRecovery.of({ recover });
});

export const layer = Layer.effect(GameRunRecovery, make);
