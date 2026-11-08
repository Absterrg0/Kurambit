// A keep-going step starts from the folder its proposal read: a step turn that
// came up behind someone else's turn is cancelled or stopped, never run late.
import { describe, expect, it } from "@effect/vitest";
import {
  CheckpointId,
  type GameRun,
  GameRunId,
  GameRunStepId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  RunId,
  ThreadId,
} from "@kurambit/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as GameRunJobs from "../../orchestration-v2/gameRun/GameRunJobs.ts";
import { stepTurnMessageId } from "../../orchestration-v2/gameRun/ids.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as GameBuilds from "../GameBuilds.ts";
import * as GameOperations from "../GameOperations.ts";
import * as GameProjectService from "../GameProjectService.ts";
import * as GameRunTurnReactor from "./GameRunTurnReactor.ts";

const STEP = stepTurnMessageId(GameRunStepId.make("run-1:step:2"), 1);
const at = (second: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 7, 10, 0, second));
const run = (
  ordinal: number,
  patch: Partial<OrchestrationV2Run> & Pick<OrchestrationV2Run, "status">,
): OrchestrationV2Run =>
  ({
    id: RunId.make(`run-${ordinal}`),
    ordinal,
    userMessageId: MessageId.make(`message-${ordinal}`),
    requestedAt: at(ordinal * 10),
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    ...patch,
  }) as OrchestrationV2Run;

const moveOf = (runs: ReadonlyArray<OrchestrationV2Run>, started = false) =>
  GameRunTurnReactor.stepTurnMove(GameRunTurnReactor.stepChain(runs, STEP), runs, started).kind;

describe("a step's turn", () => {
  it("is cancelled when it comes up queued behind the person's message", () => {
    const person = run(1, { status: "running", startedAt: at(10) });
    const step = run(2, { status: "queued", userMessageId: STEP });
    expect(moveOf([person, step])).toBe("cancel");
  });

  it("is stopped, never started, once it ran behind a turn that ended after it was sent", () => {
    const person = run(1, { status: "completed", startedAt: at(10), completedAt: at(25) });
    const step = run(2, { status: "running", userMessageId: STEP, startedAt: at(26) });
    expect(moveOf([person, step])).toBe("late");
  });

  it("starts when nothing ran ahead of it, and lands once its checkpoint is in", () => {
    const before = run(1, { status: "completed", startedAt: at(10), completedAt: at(15) });
    const running = run(2, { status: "running", userMessageId: STEP, startedAt: at(21) });
    expect(moveOf([before, running])).toBe("start");
    expect(moveOf([before, running], true)).toBe("wait");
    const stopped = { ...running, status: "interrupted" as const, completedAt: at(40) };
    expect(moveOf([before, stopped], true)).toBe("uncaptured");
    const captured = { ...stopped, checkpointId: CheckpointId.make("checkpoint-2") };
    expect(moveOf([before, captured], true)).toBe("land");
  });

  it("is cut off by a restart's cancel, checkpoint or not, until a continuation carries it on", () => {
    const cut = run(2, { status: "cancelled", userMessageId: STEP, startedAt: at(21) });
    expect(moveOf([cut], true)).toBe("cut-off");
    const continued = run(3, {
      status: "running",
      startedAt: at(40),
      restartContinuationOfRunId: cut.id,
    });
    expect(moveOf([cut, continued], true)).toBe("wait");
  });
});

const THREAD = ThreadId.make("chat");
const GAME_RUN = {
  id: GameRunId.make("run-1"),
  threadId: THREAD,
  status: "running",
  inFlight: null,
} as unknown as GameRun;

/** The reactor over scripted records: what it dispatches and what it pushes. */
const reactorWith = (runs: ReadonlyArray<OrchestrationV2Run>) => {
  const sent: Array<{ readonly type: string; readonly [key: string]: unknown }> = [];
  const pushed: Array<{ readonly root: string; readonly step: string | null }> = [];
  const layer = GameRunTurnReactor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          dispatch: (command) =>
            Effect.sync(() => {
              sent.push(command);
              return {} as Orchestrator.OrchestratorV2DispatchResult;
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getGameRunRecords: () =>
            Effect.succeed({
              gameRuns: [GAME_RUN],
              gameRunSteps: [],
              gameRunRounds: [],
            } as unknown as ProjectionStore.GameRunThreadRecords),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed({ runs } as never),
        }),
        Layer.mock(GameProjectService.GameProjectService)({
          resolve: () => Effect.succeed("/games/arena"),
        }),
        Layer.mock(GameOperations.GameOperations)({
          current: () => null,
          runChanged: (root, step) => Effect.sync(() => void pushed.push({ root, step })),
        }),
        Layer.mock(GameBuilds.GameBuilds)({}),
        Layer.mock(GameRunJobs.GameRunJobs)({}),
        Layer.mock(EffectOutbox.EffectOutboxV2)({}),
      ),
    ),
  );
  const handle = (event: Partial<OrchestrationV2DomainEvent>) =>
    Effect.flatMap(GameRunTurnReactor.GameRunTurnReactor, (reactor) =>
      reactor.handle({ threadId: THREAD, ...event } as OrchestrationV2DomainEvent),
    ).pipe(Effect.provide(layer));
  return { sent, pushed, handle };
};

// The control, the banner, the palette and the sidebar reread keep going only
// on the `run` push: every change of the run's records must publish it.
describe("a keep-going record change", () => {
  it.effect("pushes the run scope to the game's clients", () =>
    Effect.gen(function* () {
      const reactor = reactorWith([]);
      yield* reactor.handle({ type: "game-run.updated", payload: GAME_RUN } as never);
      yield* reactor.handle({ type: "game-run-step.updated" } as never);
      expect(reactor.pushed).toHaveLength(2);
      expect(reactor.pushed[0]).toMatchObject({ root: "/games/arena" });
      expect(reactor.pushed[0]?.step).not.toBeNull();
    }),
  );
});

// Keep going runs in an open chat: archiving it stops the run with why, and
// stops the step's turn at work, never the person's own turn.
describe("archiving the chat keep going runs in", () => {
  it.effect("stops the run and its step turn, and leaves the person's turn alone", () =>
    Effect.gen(function* () {
      const person = run(1, { status: "running", startedAt: at(10) });
      const step = run(2, { status: "running", userMessageId: STEP, startedAt: at(20) });
      const reactor = reactorWith([person, step]);
      yield* reactor.handle({ type: "thread.archived" } as never);
      expect(reactor.sent.map((command) => command.type)).toEqual([
        "game-run.stop",
        "run.interrupt",
      ]);
      expect(reactor.sent[0]).toMatchObject({
        runId: GAME_RUN.id,
        reason: "its chat was archived",
      });
      expect(reactor.sent[1]).toMatchObject({ runId: step.id });
    }),
  );
});
