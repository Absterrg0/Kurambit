// A keep-going step starts from the folder its proposal read: a step turn that
// came up behind someone else's turn is cancelled or stopped, never run late.
import { describe, expect, it } from "@effect/vitest";
import {
  CheckpointId,
  GameRunStepId,
  MessageId,
  type OrchestrationV2Run,
  RunId,
} from "@kurambit/contracts";
import * as DateTime from "effect/DateTime";

import { stepTurnMessageId } from "../../orchestration-v2/gameRun/ids.ts";
import { stepChain, stepTurnMove } from "./GameRunTurnReactor.ts";

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
  stepTurnMove(stepChain(runs, STEP), runs, started).kind;

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
