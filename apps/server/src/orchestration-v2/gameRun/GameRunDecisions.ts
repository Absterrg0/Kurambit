// A Guided run's creator decisions, the DelegatedTaskQuestionReactor way: the
// wake effect sends the question to the chat the creator last moved the run
// from (the run's own thread when none is live) as one queued message, the
// chat's turn ending starts the wait (game-run.step.start), the deadline
// effect asks for the default (game-run.decision.expire), and an answer
// cancels a wake still queued behind a busy chat. No fiber holds a decision.
// A restart's continuation of the presenting turn is that turn.
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
import * as GameRunJobs from "./GameRunJobs.ts";
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
    /** A settled decision's wake is dropped (queued) or its card dismissed; startup runs it again. */
    readonly drop: (
      threadId: ThreadId,
      step: GameRunStep,
    ) => Effect.Effect<
      void,
      Orchestrator.OrchestratorV2Error | ProjectionStore.ProjectionStoreV2Error
    >;
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
  const jobs = yield* GameRunJobs.GameRunJobs;

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
      // A question with nothing on disk to show is not asked: it takes its
      // default at once. The ladder's decision shows its own text.
      if (
        decision.kind !== "ladder" &&
        run !== undefined &&
        !(yield* jobs.showable(effect.threadId, run.lane, decision))
      )
        return yield* settledByRefusal(
          engine.dispatch({
            type: "game-run.decision.expire",
            commandId: CommandId.make(`server:game-run-expire:${effect.effectId}:nothing-to-show`),
            threadId: effect.threadId,
            runId: effect.runId,
            decisionId: decision.id,
            nothingToShow: true,
          }),
        );
      const { commandId, messageId } = decisionWakeIds(effect.runId, decision.id, step.attempt);
      const to = yield* wakeThreadOf(run!, `${commandId}:unarchive`);
      // The wake starts a turn on the creator's chat, so it takes the same
      // admission as any other message turn before it reaches the orchestrator.
      const thread = yield* projections.getThread(to).pipe(Effect.orDie);
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
          threadId: to,
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

  /**
   * Where a run's questions go: the chat the creator last moved it from, else
   * its own thread, skipping one archived or deleted since; when neither is
   * live the run's own thread is brought back, so a question never waits out
   * its default unseen.
   */
  const wakeThreadOf = (run: GameRun, commandId: string) =>
    Effect.gen(function* () {
      for (const candidate of new Set([run.chat ?? run.threadId, run.threadId])) {
        const thread = yield* projections.getThread(candidate).pipe(Effect.option);
        if (
          thread._tag === "Some" &&
          thread.value.deletedAt === null &&
          thread.value.archivedAt === null
        )
          return candidate;
      }
      yield* settledByRefusal(
        engine.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make(commandId),
          threadId: run.threadId,
        }),
      );
      return run.threadId;
    });

  /**
   * The wake's turn, wherever it went (the creator's chat or the run's
   * thread), and the restart continuations that carried it on: the latest is
   * the turn now. Null when it was never sent.
   */
  const wakeOf = (run: GameRun, step: GameRunStep) =>
    Effect.gen(function* () {
      if (step.step.kind !== "decide") return null;
      const { messageId } = decisionWakeIds(run.id, step.step.decision.id, step.attempt);
      for (const threadId of new Set([run.chat ?? run.threadId, run.threadId])) {
        const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
        const root = runs.find((each) => each.userMessageId === messageId);
        if (root === undefined) continue;
        const chain: OrchestrationV2Run[] = [root];
        for (let next = root; ;) {
          const continued = runs.find((each) => each.restartContinuationOfRunId === next.id);
          if (continued === undefined || chain.includes(continued)) break;
          chain.push(continued);
          next = continued;
        }
        return { threadId, chain, latest: chain.at(-1)! };
      }
      return null;
    });

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
      const woke = yield* wakeOf(run, step);
      if (woke === null || PRESENTING.has(woke.latest.status)) return;
      yield* settledByRefusal(
        engine.dispatch({
          type: "game-run.step.start",
          commandId: gameRunStepCommandId(step.id, step.attempt, "start"),
          threadId,
          runId: run.id,
          stepId: step.id,
          attempt: step.attempt,
        }),
      );
    });

  // A settled decision leaves nothing to ask: a still-queued question is dropped,
  // and a question card the presenting agent opened is dismissed, or the stale
  // card keeps its turn waiting and the creator's chat blocked behind it. A card
  // only a live provider session can answer (OpenCode's questions take answers,
  // never a cancel) cannot be dismissed, so the presenting turn is stopped: an
  // answer sent for it would be words the creator never said.
  const drop: GameRunDecisions["Service"]["drop"] = (runThread, step) =>
    Effect.gen(function* () {
      if (step.step.kind !== "decide") return;
      const records = yield* projections.getGameRunRecords(runThread, { steps: "in-flight" });
      const run = records.gameRuns.find((each) => each.id === step.runId);
      if (run === undefined) return;
      const woke = yield* wakeOf(run, step);
      if (woke === null) return;
      const { commandId } = decisionWakeIds(step.runId, step.step.decision.id, step.attempt);
      const threadId = woke.threadId;
      if (woke.latest.status === "queued")
        return yield* settledByRefusal(
          engine.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`${commandId}:cancel`),
            threadId,
            runId: woke.latest.id,
          }),
        );
      const { nodes, runtimeRequests } = yield* projections.getThreadRecords(threadId, [
        "nodes",
        "runtimeRequests",
      ]);
      // A card the turn or any continuation of it opened is the question's.
      const turns = new Set(woke.chain.map((each) => each.id));
      const wakeNodes = new Set(
        nodes.filter((node) => node.runId !== null && turns.has(node.runId)).map((n) => n.id),
      );
      const open = runtimeRequests.filter(
        (request) =>
          request.status === "pending" &&
          request.kind === "user_input" &&
          wakeNodes.has(request.nodeId),
      );
      for (const request of open.filter((r) => r.responseCapability.type === "message"))
        yield* settledByRefusal(
          engine.dispatch({
            type: "thread.user-input.dismiss",
            commandId: CommandId.make(`${commandId}:dismiss:${request.id}`),
            threadId,
            requestId: request.id,
          }),
        );
      if (open.some((r) => r.responseCapability.type !== "message"))
        yield* settledByRefusal(
          engine.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make(`${commandId}:interrupt`),
            threadId,
            runId: woke.latest.id,
            reason: "The run's decision was settled; its question card has nothing left to ask.",
          }),
        );
    });

  // The run a chat's wake turn belongs to: the chat's project's run.
  const runThreadOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* projections.getThread(threadId);
      const run = yield* projections.getProjectGameRun(thread.projectId);
      return run?.threadId ?? null;
    });

  const handle: GameRunDecisions["Service"]["handle"] = (event) =>
    Effect.gen(function* () {
      if (event.type === "run.updated") {
        // A restart's continuation of a wake turn is that turn: it is read the same way.
        const wakeTurn =
          isDecisionWake(event.payload.userMessageId) ||
          event.payload.restartContinuationOfRunId !== undefined;
        if (!wakeTurn || PRESENTING.has(event.payload.status)) return;
        const runThread = yield* runThreadOf(event.threadId);
        if (runThread !== null) yield* presented(runThread);
        return;
      }
      if (
        event.type === "game-run-step.updated" &&
        event.payload.kind === "decide" &&
        event.payload.status !== "planned" &&
        event.payload.status !== "running"
      )
        yield* drop(event.threadId, event.payload);
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

  return GameRunDecisions.of({ wake, expire, drop, presented, start, handle });
});

export const layer = Layer.effect(GameRunDecisions, make);
