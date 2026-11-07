// The keep-going cycle through the decider: a run made by an earlier Kurambit
// is history (it takes a stop, nothing continues it); a turns run looks,
// proposes, takes its turn, judges, undoes and records, and every report is
// checked against the step in flight so a late or repeated one changes nothing.
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  type GameBuildFacts,
  GameBuildId,
  GameRun,
  GameRunId,
  type GameRunRound,
  type GameRunStep,
  type GameRunStepResult,
  type OrchestrationV2GameRunCommand,
  ProjectId,
  RunId,
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

// ── A turns run, through a small in-memory store of its records. ──────────
const chat = ThreadId.make("thread:chat");
const project = ProjectId.make("project:game");
const BASE = GameBuildId.make("a".repeat(40));
const BUILD = GameBuildId.make("b".repeat(40));
const T0 = Date.parse("2026-11-07T10:00:00.000Z");

const facts = (patch: Partial<GameBuildFacts> = {}): GameBuildFacts => ({
  build: BASE,
  key: "web:k",
  harness: "h1",
  state: "measured",
  measuredAt: null,
  renderer: "GPU",
  boots: { status: "measured", value: { ok: true, detail: "" } },
  idle: {
    status: "measured",
    value: { ending: "lost", at: 30, played: 60, note: "", evidence: null },
  },
  masher: {
    status: "measured",
    value: { ending: "lost", at: 20, played: 60, note: "", evidence: null },
  },
  skilled: { status: "not-measured", why: "no play-mode bot", retry: false },
  winnableWithoutSkill: { status: "measured", value: false },
  liveness: { status: "not-measured", why: "off", retry: false },
  firstResponse: { status: "measured", value: { seconds: 0.1, window: 2, resolution: 0.05 } },
  message: "",
  ...patch,
});
const crashes = facts({
  boots: { status: "measured", value: { ok: false, detail: "main.js threw" } },
});

type Sent = OrchestrationV2GameRunCommand extends infer C
  ? C extends unknown
    ? Omit<C, "commandId" | "threadId">
    : never
  : never;

class Store {
  runs: GameRun[] = [];
  steps = new Map<string, GameRunStep>();
  rounds: GameRunRound[] = [];
  now = T0;
  effects: Decide.GameRunDecision["effects"] = [];
  private n = 0;

  get run() {
    const run = this.runs.at(-1);
    if (run === undefined) throw new Error("no run");
    return run;
  }
  get inFlight() {
    const run = this.runs.at(-1);
    return run === undefined || run.inFlight === null
      ? null
      : (this.steps.get(gameRunStepId(run.id, run.inFlight)) ?? null);
  }
  step() {
    const step = this.inFlight;
    if (step === null) throw new Error("no step in flight");
    return step;
  }
  records(): Decide.GameRunRecords {
    return {
      projectId: project,
      projectRun: this.runs.at(-1) ?? null,
      runs: this.runs,
      rounds: this.rounds,
      inFlight: this.inFlight,
      chatDeleted: false,
      steps: [...this.steps.values()],
    };
  }
  send(command: Sent) {
    const decided = Decide.decide(
      {
        ...command,
        commandId: CommandId.make(`c${++this.n}`),
        threadId: chat,
      } as OrchestrationV2GameRunCommand,
      this.records(),
      { at: DateTime.makeUnsafe(this.now), coin: 0.5, id: "x" },
    );
    if (Result.isSuccess(decided)) {
      for (const event of decided.success.events) {
        if (event.type === "game-run.created") this.runs.push(event.payload);
        else if (event.type === "game-run.updated")
          this.runs = this.runs.map((r) => (r.id === event.payload.id ? event.payload : r));
        else if (event.type === "game-run-step.updated")
          this.steps.set(event.payload.id, event.payload);
        else this.rounds.push(event.payload);
      }
      this.effects = decided.success.effects;
    }
    return decided;
  }
  ok(command: Sent) {
    const decided = this.send(command);
    if (Result.isFailure(decided)) throw new Error(decided.failure.message);
    return decided.success;
  }
  /** Reports on the step in flight, for its current attempt. */
  complete(result: GameRunStepResult) {
    const step = this.step();
    return this.ok({
      type: "game-run.step.complete",
      runId: this.run.id,
      stepId: step.id,
      attempt: step.attempt,
      result,
    });
  }
  start(profile: "guided" | "autopilot", budgetMinutes: number | null = null) {
    return this.ok({
      type: "game-run.start",
      runId: GameRunId.make("run_turns"),
      engine: "three",
      lane: "web",
      profile,
      budgetMinutes,
    });
  }
}

const look = (patch: Partial<Extract<GameRunStepResult, { kind: "look" }>> = {}) =>
  ({
    kind: "look",
    current: BASE,
    facts: facts(),
    next: { text: "Add a score counter." },
    bot: true,
    ...patch,
  }) as const;
const turn = (patch: Partial<Extract<GameRunStepResult, { kind: "turn" }>> = {}) =>
  ({
    kind: "turn",
    runId: RunId.make("t3-run-1"),
    outcome: "completed",
    build: BUILD,
    files: 2,
    tokens: 50_000,
    elapsedMs: 120_000,
    personSteered: false,
    reason: "",
    ...patch,
  }) as const;
const refusal = (decided: ReturnType<Store["send"]>) =>
  Result.isFailure(decided) ? decided.failure.reason : "accepted";

describe("a keep-going run", () => {
  it("refuses an engine with no turn loop", () => {
    const store = new Store();
    expect(
      refusal(
        store.send({
          type: "game-run.start",
          runId: GameRunId.make("run_godot"),
          engine: "godot",
          lane: "godot",
          profile: "autopilot",
          budgetMinutes: 60,
        }),
      ),
    ).toBe("no-turn-loop");
  });

  it("goes look, turn, judge, undo, record, and proposes the retry next (K1, K4, K5)", () => {
    const store = new Store();
    store.start("autopilot", 60);
    expect(store.run).toMatchObject({
      loop: "turns",
      status: "running",
      budgetEndsAt: T0 + 3_600_000,
    });
    expect(store.step().step.kind).toBe("look");
    expect(store.effects.map((e) => e.request.type)).toEqual(["game-run.step.execute"]);

    store.complete(look());
    const turnStep = store.step();
    expect(turnStep.step).toMatchObject({
      kind: "turn",
      base: BASE,
      startedBy: "autopilot",
      capMs: 15 * 60_000,
    });
    store.ok({ type: "game-run.step.start", runId: store.run.id, stepId: turnStep.id, attempt: 1 });
    expect(store.effects).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({ type: "game-run.step.deadline" }),
        availableAt: T0 + 15 * 60_000,
      }),
    ]);

    store.now += 180_000;
    store.complete(turn());
    expect(store.step().step).toEqual({ kind: "judge", id: 3, build: BUILD, base: BASE });

    store.complete({ kind: "judge", base: facts(), build: { ...crashes, build: BUILD } });
    expect(store.step().step).toEqual({ kind: "undo", id: 4, target: BASE, expect: BUILD });
    expect(store.rounds).toEqual([]);

    store.complete({ kind: "undo", restored: true, why: "restored", message: "" });
    expect(store.rounds.map((r) => r.round)).toEqual([
      expect.objectContaining({
        round: 1,
        kept: false,
        failure: "game",
        build: BUILD,
        step: expect.objectContaining({
          verdict: "undone",
          turn: "t3-run-1",
          base: BASE,
          gain: false,
          tokens: 50_000,
          reason: expect.stringContaining("Boots"),
        }),
      }),
    ]);
    expect(store.step().step.kind).toBe("look");

    store.complete(look());
    expect(store.step().step).toMatchObject({
      kind: "turn",
      proposal: {
        why: "regression",
        key: turnStep.step.kind === "turn" ? turnStep.step.proposal.key : "",
      },
    });
  });

  it("refuses a late or repeated report: it changes nothing", () => {
    const store = new Store();
    store.start("autopilot");
    const lookStep = store.step();
    store.complete(look());
    const again = store.send({
      type: "game-run.step.complete",
      runId: store.run.id,
      stepId: lookStep.id,
      attempt: 1,
      result: look(),
    });
    expect(refusal(again)).toBe("stale-step");
    expect(store.step().step.kind).toBe("turn");
    // A report of the wrong kind for the step in flight is refused too.
    expect(
      refusal(
        store.send({
          type: "game-run.step.complete",
          runId: store.run.id,
          stepId: store.step().id,
          attempt: 1,
          result: look(),
        }),
      ),
    ).toBe("wrong-kind");
  });

  it("keeps the turn's notes until it starts, and gives them back when Off stops it (K11, K14)", () => {
    const store = new Store();
    store.start("autopilot");
    store.ok({ type: "game-run.steer", runId: store.run.id, note: "Make it night." });
    store.complete(look());
    expect(store.step().step).toMatchObject({
      kind: "turn",
      steer: ["Make it night."],
      proposal: { why: "steer" },
    });
    store.ok({ type: "game-run.steer", runId: store.run.id, note: "And rain." });
    store.ok({
      type: "game-run.step.start",
      runId: store.run.id,
      stepId: store.step().id,
      attempt: 1,
    });
    expect(store.run.steer).toEqual(["And rain."]);
    store.ok({ type: "game-run.stop", runId: store.run.id });
    expect(store.run).toMatchObject({
      status: "ended",
      ending: "stopped",
      steer: ["Make it night.", "And rain."],
    });
  });

  it("Guided: the default starts at its deadline, hold clears it, Skip sets the step aside (K9)", () => {
    const store = new Store();
    store.start("guided");
    store.complete(look());
    const proposal = store.step();
    expect(proposal.step).toMatchObject({ kind: "propose", deadline: T0 + 60_000 });
    expect(store.run.status).toBe("waiting");
    expect(store.effects).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({
          type: "game-run.decision.deadline",
          decisionId: proposal.id,
        }),
        availableAt: T0 + 60_000,
      }),
    ]);
    const expire = () =>
      store.send({
        type: "game-run.decision.expire",
        runId: store.run.id,
        decisionId: proposal.id,
      });
    expect(refusal(expire())).toBe("not-due");
    store.ok({
      type: "game-run.decide",
      runId: store.run.id,
      decisionId: proposal.id,
      answer: "hold",
    });
    store.now += 120_000;
    expect(refusal(expire())).toBe("not-due");
    store.ok({
      type: "game-run.decide",
      runId: store.run.id,
      decisionId: proposal.id,
      answer: "skip",
    });
    expect(store.run.setAside).toEqual([
      { key: expect.stringMatching(/^next:/), text: "Add a score counter.", why: "you skipped it" },
    ]);
    expect(store.step().step.kind).toBe("look");

    store.complete(look({ next: { text: "Add a boss." } }));
    const second = store.step();
    store.now += 60_000;
    store.ok({ type: "game-run.decision.expire", runId: store.run.id, decisionId: second.id });
    expect(store.step().step).toMatchObject({ kind: "turn", startedBy: "default", base: BASE });
    expect(
      refusal(
        store.send({
          type: "game-run.decide",
          runId: store.run.id,
          decisionId: second.id,
          answer: "start",
        }),
      ),
    ).toBe("no-decision");
  });

  it("a turn on the game supersedes the proposal, and a note starts as the person's step (K2, K9)", () => {
    const store = new Store();
    store.start("guided");
    store.complete(look());
    store.complete({ kind: "decided", answer: "superseded", by: "server" });
    expect(store.step().step.kind).toBe("look");
    store.complete(look());
    store.ok({ type: "game-run.steer", runId: store.run.id, note: "Make the jump higher." });
    expect(store.step().step).toMatchObject({
      kind: "turn",
      startedBy: "creator",
      base: BASE,
      proposal: { why: "steer" },
      steer: ["Make the jump higher."],
    });
  });

  it("a restart or pause during the judge runs that judge again, never a second turn", () => {
    const store = new Store();
    store.start("autopilot");
    store.complete(look());
    store.complete(turn());
    const judge = store.step();
    store.ok({
      type: "game-run.step.schedule",
      runId: store.run.id,
      stepId: judge.id,
      attempt: 1,
      at: T0 + 1,
      timer: { kind: "recover" },
    });
    expect(store.effects.map((e) => e.request.type)).toEqual(["game-run.step.wake"]);
    store.complete({
      kind: "ended",
      ending: "tool-failed",
      reason: "the facts runner kept failing",
    });
    expect(store.run).toMatchObject({
      status: "ended",
      ending: "tool-failed",
      inFlight: judge.seq,
    });
    store.ok({ type: "game-run.resume", runId: store.run.id });
    expect(store.step()).toMatchObject({ id: judge.id, attempt: 2, status: "planned" });
    expect(store.effects).toEqual([
      {
        request: {
          type: "game-run.step.execute",
          runId: store.run.id,
          stepId: judge.id,
          attempt: 2,
        },
      },
    ]);
    const late = store.send({
      type: "game-run.step.complete",
      runId: store.run.id,
      stepId: judge.id,
      attempt: 1,
      result: { kind: "judge", base: facts(), build: facts() },
    });
    expect(refusal(late)).toBe("stale-attempt");
    store.complete({ kind: "judge", base: facts(), build: { ...facts(), build: BUILD } });
    expect(store.rounds.map((r) => r.round.step?.verdict)).toEqual(["kept"]);
    expect(store.step().step.kind).toBe("look");
  });

  it("stops on two steps in a row that changed nothing, and resumes afresh", () => {
    const store = new Store();
    store.start("autopilot");
    store.complete(look());
    store.complete(turn({ files: 0 }));
    store.complete(look({ next: { text: "Polish the menu." } }));
    store.complete(turn({ files: 0 }));
    expect(store.run).toMatchObject({ status: "ended", ending: "stalled", inFlight: null });
    store.ok({ type: "game-run.resume", runId: store.run.id, profile: "guided" });
    expect(store.run).toMatchObject({ status: "running", stallStreak: 0, profile: "guided" });
    expect(store.step().step.kind).toBe("look");
  });
});
