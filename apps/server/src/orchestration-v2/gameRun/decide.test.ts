// A run made by an earlier Kurambit is history: its records still decode, it
// takes a stop, and nothing continues it.
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  GameRun,
  GameRunId,
  type GameRunStep,
  ProjectId,
  ThreadId,
  gameRunStepId,
} from "@kurambit/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { STAGE_ERA_SENTENCE } from "../../game/run/runView.ts";
import * as Decide from "./decide.ts";

const threadId = ThreadId.make("thread:creator");
const runId = GameRunId.make("run_stage_era");
const at = "2026-11-01T00:00:00.000Z";

// A live stage-era run and its role step in flight, as an earlier Kurambit wrote them.
const stageEraRun = Schema.decodeUnknownSync(GameRun)({
  id: runId,
  threadId,
  projectId: "project:game",
  lane: "web",
  brief: "A small arena game.",
  artDirection: "",
  profile: "guided",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "full-access",
  budgetMinutes: null,
  budgetEndsAt: null,
  status: "running",
  ending: null,
  stage: "round-3",
  best: "0123456789abcdef0123456789abcdef01234567",
  ladder: { rungs: [], note: "" },
  steer: [],
  decided: [],
  pendingDecision: null,
  stallStreak: 0,
  lastFailure: "",
  shipNoReasons: "",
  ledger: "",
  lastDirection: "",
  buildNotes: "",
  pickNotes: "",
  picked: null,
  protos: [],
  played: null,
  pending: null,
  task: { _tag: "init" },
  seq: 7,
  inFlight: 7,
  versions: "checkpoints",
  startedAt: at,
  updatedAt: at,
});
const roleStep: GameRunStep = {
  id: gameRunStepId(runId, 7),
  runId,
  threadId,
  seq: 7,
  attempt: 1,
  kind: "role",
  step: { kind: "role", id: 7, role: "builder-3", prompt: "Build round 3." },
  status: "running",
  roles: [{ seq: 7, threadId: "thread:builder", submission: null }],
  result: null,
  logs: [],
  plannedAt: at,
  startedAt: at,
  completedAt: null,
};

const records: Decide.GameRunRecords = {
  projectId: ProjectId.make("project:game"),
  projectRun: stageEraRun,
  runs: [stageEraRun],
  rounds: [],
  inFlight: roleStep,
  chatDeleted: false,
  steps: [],
};
const input = { at: DateTime.makeUnsafe("2026-11-07T00:00:00.000Z"), coin: 0.5, id: "x" };

describe("a stage-era run", () => {
  it("refuses a resume with why, and stops with its step cancelled", () => {
    const resumed = Decide.decide(
      { type: "game-run.resume", commandId: CommandId.make("c1"), threadId, runId },
      records,
      input,
    );
    expect(Result.isFailure(resumed) && resumed.failure).toEqual({
      reason: "not-resumable",
      message: STAGE_ERA_SENTENCE,
    });

    const stopped = Decide.decide(
      {
        type: "game-run.stop",
        commandId: CommandId.make("c2"),
        threadId,
        runId,
        reason: STAGE_ERA_SENTENCE,
      },
      records,
      input,
    );
    if (Result.isFailure(stopped)) return expect.unreachable(stopped.failure.message);
    const [step, run] = stopped.success.events;
    expect(step?.type === "game-run-step.updated" && step.payload.status).toBe("cancelled");
    // Its stage-era fields and the role step's own keys survive the stop untouched.
    expect(run?.type === "game-run.updated" && run.payload).toMatchObject({
      status: "ended",
      ending: "stopped",
      lastFailure: STAGE_ERA_SENTENCE,
      inFlight: null,
      stage: "round-3",
      ladder: { rungs: [], note: "" },
    });
    expect(step?.type === "game-run-step.updated" && step.payload.step).toEqual(roleStep.step);
    expect(stopped.success.cancelEffects).toBe(true);
  });
});
