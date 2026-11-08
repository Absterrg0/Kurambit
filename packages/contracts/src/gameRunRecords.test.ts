// Event logs still hold the runs an earlier Kurambit's production runs wrote.
// Nothing reads their extra fields, but every one must decode, or the log
// they sit in fails to load.
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { GameRun, GameRunStep } from "./gameRunRecords.ts";

const at = "2026-11-01T00:00:00.000Z";
const decodeRun = Schema.decodeUnknownSync(GameRun);
const decodeStep = Schema.decodeUnknownSync(GameRunStep);

describe("game run records an earlier Kurambit wrote", () => {
  it("decode", () => {
    const run = decodeRun({
      id: "run_stage_era",
      threadId: "thread:creator",
      projectId: "project:game",
      lane: "web",
      brief: "A small arena game.",
      profile: "guided",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      budgetMinutes: null,
      budgetEndsAt: null,
      status: "waiting",
      ending: "no-ladder",
      stage: "round-3",
      best: "0123456789abcdef0123456789abcdef01234567",
      ladder: { rungs: [], note: "" },
      steer: [],
      stallStreak: 0,
      lastFailure: "",
      seq: 7,
      inFlight: 7,
      versions: "checkpoints",
      startedAt: at,
      updatedAt: at,
    });
    expect(run).toMatchObject({ id: "run_stage_era", status: "waiting", ending: "no-ladder" });

    const step = decodeStep({
      id: "run_stage_era:step:7",
      runId: "run_stage_era",
      threadId: "thread:creator",
      seq: 7,
      attempt: 1,
      kind: "role",
      step: { kind: "role", id: 7, role: "builder-3", prompt: "Build round 3." },
      status: "running",
      roles: [{ seq: 7, threadId: "thread:builder", submission: null }],
      result: { kind: "landed", outputs: [] },
      logs: [],
      plannedAt: at,
      startedAt: at,
      completedAt: null,
    });
    expect(step.step).toEqual({ kind: "role", id: 7, role: "builder-3", prompt: "Build round 3." });
  });
});
