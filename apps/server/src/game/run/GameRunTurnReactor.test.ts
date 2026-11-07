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

import * as GameRunJobs from "../../orchestration-v2/gameRun/GameRunJobs.ts";
import { stepTurnMessageId } from "../../orchestration-v2/gameRun/ids.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as GameBuilds from "../GameBuilds.ts";
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
    expect(moveOf([before, stopped], true)).toBe("wait");
    const captured = { ...stopped, checkpointId: CheckpointId.make("checkpoint-2") };
    expect(moveOf([before, captured], true)).toBe("land");
  });
});

// Keep going runs in an open chat: archiving it stops the run with why, and
// stops the step's turn at work, never the person's own turn.
describe("archiving the chat keep going runs in", () => {
  it.effect("stops the run and its step turn, and leaves the person's turn alone", () =>
    Effect.gen(function* () {
      const sent: Array<{ readonly type: string; readonly [key: string]: unknown }> = [];
      const thread = ThreadId.make("chat");
      const gameRun = {
        id: GameRunId.make("run-1"),
        threadId: thread,
        loop: "turns",
        status: "running",
      } as GameRun;
      const person = run(1, { status: "running", startedAt: at(10) });
      const step = run(2, { status: "running", userMessageId: STEP, startedAt: at(20) });
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
                  gameRuns: [gameRun],
                  gameRunSteps: [],
                  gameRunRounds: [],
                } as unknown as ProjectionStore.GameRunThreadRecords),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadRecords: () => Effect.succeed({ runs: [person, step] } as never),
            }),
            Layer.mock(GameBuilds.GameBuilds)({}),
            Layer.mock(GameRunJobs.GameRunJobs)({}),
          ),
        ),
      );
      yield* Effect.flatMap(GameRunTurnReactor.GameRunTurnReactor, (reactor) =>
        reactor.handle({ type: "thread.archived", threadId: thread } as OrchestrationV2DomainEvent),
      ).pipe(Effect.provide(layer));
      expect(sent.map((command) => command.type)).toEqual(["game-run.stop", "run.interrupt"]);
      expect(sent[0]).toMatchObject({ runId: gameRun.id, reason: "its chat was archived" });
      expect(sent[1]).toMatchObject({ runId: step.id });
    }),
  );
});
