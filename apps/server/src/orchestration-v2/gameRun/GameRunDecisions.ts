// A Guided run's creator decisions, the DelegatedTaskQuestionReactor way: the
// wake effect sends the question to the creator's chat as one queued message,
// the chat's turn ending starts the wait (game-run.step.start), the deadline
// effect asks for the default (game-run.decision.expire), and an answer
// cancels a wake still queued behind a busy chat. No fiber holds a decision.
import {
  CommandId,
  type GameRun,
  type GameRunId,
  type GameRunStep,
  type GameRunStepId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ThreadId,
  gameRunStepCommandId,
} from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { PRESENTING, SUMMARY, wakeText } from "../../game/run/decisionText.ts";
import { forkParked } from "../../serverActivation.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as TurnAdmission from "../TurnAdmission.ts";
import { decisionWakeIds, isDecisionWake } from "./ids.ts";

interface DecisionEffect {
  /** The effect's own id: each deadline asks under a command id of its own. */
  readonly effectId: string;
  readonly threadId: ThreadId;
  readonly runId: GameRunId;
  readonly stepId: GameRunStepId;
  readonly decisionId: string;
}

export class GameRunDecisions extends Context.Service<
  GameRunDecisions,
  {
    readonly wake: (
      effect: DecisionEffect,
    ) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
    readonly expire: (
      effect: DecisionEffect,
    ) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
    /** The question reached the creator's agent: the wait for an answer starts. */
    readonly presented: (
      threadId: ThreadId,
    ) => Effect.Effect<
      void,
      Orchestrator.OrchestratorV2Error | ProjectionStore.ProjectionStoreV2Error
    >;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("kurambit/orchestration-v2/gameRun/GameRunDecisions") {}

const isWaitingOn = (run: GameRun | undefined, step: GameRunStep | undefined, decisionId: string) =>
  run !== undefined &&
  step !== undefined &&
  run.status === "waiting" &&
  run.inFlight === step.seq &&
  step.step.kind === "decide" &&
  step.step.decision.id === decisionId;

// The run refuses a command that no longer fits (the decision was answered, the
// run stopped); that refusal is the answer, not a failure of the effect.
const settledByRefusal = <A, R>(
  dispatch: Effect.Effect<A, Orchestrator.OrchestratorV2Error, R>,
): Effect.Effect<void, Orchestrator.OrchestratorV2Error, R> =>
  dispatch.pipe(
    Effect.asVoid,
    Effect.catchTags({
      OrchestratorGameRunRefusedError: () => Effect.void,
      OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
    }),
  );

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const turnAdmission = yield* TurnAdmission.TurnAdmission;

  const current = (threadId: ThreadId, runId: GameRunId) =>
    projections.getGameRunRecords(threadId, { steps: "in-flight" }).pipe(
      Effect.map((records) => {
        const run = records.gameRuns.at(-1);
        return {
          run: run?.id === runId ? run : undefined,
          step: records.gameRunSteps.find((step) => step.runId === runId),
        };
      }),
    );

  const wake: GameRunDecisions["Service"]["wake"] = (effect) =>
    Effect.gen(function* () {
      const { run, step } = yield* current(effect.threadId, effect.runId).pipe(Effect.orDie);
      if (!isWaitingOn(run, step, effect.decisionId) || step?.step.kind !== "decide") return;
      const decision = step.step.decision;
      const { commandId, messageId } = decisionWakeIds(effect.runId, decision.id);
      // The wake starts a turn on the creator's chat, so it takes the same
      // admission as any other message turn before it reaches the orchestrator.
      const thread = yield* projections.getThread(effect.threadId).pipe(Effect.orDie);
      const admitted = yield* turnAdmission.admit(thread).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("game run decision wake not admitted; the default will fire", {
            threadId: effect.threadId,
            decisionId: decision.id,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (!admitted) return;
      yield* settledByRefusal(
        engine.dispatch({
          type: "message.dispatch",
          commandId,
          threadId: effect.threadId,
          messageId,
          text: wakeText(decision),
          notification: {
            source: { kind: "game_run" },
            outcome: "updated",
            summary: SUMMARY[decision.kind],
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        }),
      );
    });

  const expire: GameRunDecisions["Service"]["expire"] = (effect) =>
    settledByRefusal(
      engine.dispatch({
        type: "game-run.decision.expire",
        commandId: CommandId.make(`server:game-run-expire:${effect.effectId}`),
        threadId: effect.threadId,
        runId: effect.runId,
        decisionId: effect.decisionId,
      }),
    );

  const wakeRunOf = (
    runs: ReadonlyArray<OrchestrationV2Run>,
    runId: GameRunId,
    decisionId: string,
  ) => runs.find((each) => each.userMessageId === decisionWakeIds(runId, decisionId).messageId);

  // The user can answer only once the agent finished presenting: its turn
  // reading the decision and building the visual takes a minute or two, so the
  // wait counts from that turn's end. Policy.DECISION_DELIVERY_MS bounds a
  // question that never got there; the decide step's first deadline effect holds it.
  const presented: GameRunDecisions["Service"]["presented"] = (threadId) =>
    Effect.gen(function* () {
      const records = yield* projections.getGameRunRecords(threadId, { steps: "in-flight" });
      const run = records.gameRuns.at(-1);
      const step = records.gameRunSteps.find((each) => each.runId === run?.id);
      if (run === undefined || step === undefined || step.step.kind !== "decide") return;
      if (!isWaitingOn(run, step, step.step.decision.id) || step.step.deadline !== null) return;
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      const woke = wakeRunOf(runs, run.id, step.step.decision.id);
      if (woke === undefined || PRESENTING.has(woke.status)) return;
      yield* settledByRefusal(
        engine.dispatch({
          type: "game-run.step.start",
          commandId: gameRunStepCommandId(step.id, step.attempt, "start"),
          threadId,
          runId: run.id,
          stepId: step.id,
        }),
      );
    });

  // An answer that arrives first leaves a still-queued question with nothing to ask.
  const dropQueuedWake = (threadId: ThreadId, step: GameRunStep) =>
    Effect.gen(function* () {
      if (step.step.kind !== "decide") return;
      const { messageId, commandId } = decisionWakeIds(step.runId, step.step.decision.id);
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      const queued = runs.find((run) => run.status === "queued" && run.userMessageId === messageId);
      if (queued === undefined) return;
      yield* settledByRefusal(
        engine.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`${commandId}:cancel`),
          threadId,
          runId: queued.id,
        }),
      );
    });

  const handle: GameRunDecisions["Service"]["handle"] = (event) =>
    Effect.gen(function* () {
      if (event.type === "run.updated") {
        if (!isDecisionWake(event.payload.userMessageId) || PRESENTING.has(event.payload.status))
          return;
        yield* presented(event.threadId);
        return;
      }
      if (
        event.type === "game-run-step.updated" &&
        event.payload.kind === "decide" &&
        event.payload.status !== "planned" &&
        event.payload.status !== "running"
      )
        yield* dropQueuedWake(event.threadId, event.payload);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("game run decision reactor failed", { threadId: event.threadId, cause }),
      ),
    );

  const start: GameRunDecisions["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("game run decision event stream failed", { cause }),
        ),
      ),
    );

  return GameRunDecisions.of({ wake, expire, presented, start, handle });
});

export const layer = Layer.effect(GameRunDecisions, make);
