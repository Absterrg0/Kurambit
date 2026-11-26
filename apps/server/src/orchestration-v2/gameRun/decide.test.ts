// The keep-going cycle through the decider: a run looks, takes its turn,
// judges, undoes and records, and every report is checked against the
// step in flight so a late or repeated one changes nothing.
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  type GameBuildFacts,
  GameBuildId,
  type GameRun,
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

import * as Decide from "./decide.ts";

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
  masher: {
    status: "measured",
    value: { ending: "lost", at: 20, played: 60, note: "", evidence: null },
  },
  use: { status: "not-measured", why: "not played", retry: false },
  performance: { status: "not-measured", why: "not played", retry: false },
  qa: { status: "not-measured", why: "not played", retry: false },
  screens: { status: "not-measured", why: "not played", retry: false },
  player: { status: "not-measured", why: "not played", retry: false },
  savedPlays: {
    status: "not-measured",
    why: "no saved play was replayed on this build",
    cause: "no-saved-plays",
    retry: false,
  },
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
  /** The game's last step in its other chats. */
  gameLastStep = 0;
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
      gameLastStep: this.gameLastStep,
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
      DateTime.makeUnsafe(this.now),
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
  start(budgetMinutes: number | null = null) {
    return this.ok({
      type: "game-run.start",
      runId: GameRunId.make("run_turns"),
      engine: "three",
      lane: "web",
      budgetMinutes,
    });
  }
  /** A proposal an earlier Kurambit's Guided mode left in flight, as its records hold it. */
  legacyProposal() {
    const run = this.run;
    const seq = run.seq + 1;
    const id = gameRunStepId(run.id, seq);
    const at = DateTime.formatIso(DateTime.makeUnsafe(this.now));
    this.steps.set(id, {
      id,
      runId: run.id,
      threadId: chat,
      seq,
      attempt: 1,
      kind: "propose",
      step: {
        kind: "propose",
        id: seq,
        proposal: { why: "next", text: "Add a boss.", target: null, key: "next:boss" },
        deadline: null,
      },
      status: "planned",
      result: null,
      logs: [],
      plannedAt: at,
      startedAt: null,
      completedAt: null,
    });
    this.runs = this.runs.map((r) =>
      r.id === run.id ? { ...r, status: "waiting", seq, inFlight: seq, profile: "guided" } : r,
    );
    return id;
  }
}

const look = (patch: Partial<Extract<GameRunStepResult, { kind: "look" }>> = {}) =>
  ({
    kind: "look",
    current: BASE,
    facts: facts(),
    next: { text: "Add a score counter." },
    edited: false,
    ...patch,
  }) as const;
const turn = (
  patch: Partial<Extract<GameRunStepResult, { kind: "turn" }>> & {
    readonly startBuild?: GameBuildId | null;
  } = {},
) =>
  ({
    kind: "turn",
    startBuild: BASE,
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
  // The person's model choice a step's turn started under is put back from this record when the
  // turn ends, so it must be on the step itself, not in a process's memory.
  it("records the model choice a step's turn started under on the step", () => {
    const store = new Store();
    store.start(60);
    store.complete(look());
    const turnStep = store.step();
    store.ok({
      type: "game-run.step.start",
      runId: store.run.id,
      stepId: turnStep.id,
      attempt: 1,
      models: { route: "code", library: false },
    });
    expect(store.step()).toMatchObject({
      status: "running",
      models: { route: "code", library: false },
    });
  });

  it("goes look, turn, judge, undo, record, and proposes the retry next", () => {
    const store = new Store();
    store.start(60);
    expect(store.run).toMatchObject({ status: "running", budgetMinutes: 60, budgetUsedMs: 0 });
    expect(store.step().step.kind).toBe("look");
    expect(store.effects.map((e) => e.request.type)).toEqual(["game-run.step.execute"]);

    store.complete(look());
    const turnStep = store.step();
    expect(turnStep.step).toMatchObject({ kind: "turn", base: BASE, capMs: 15 * 60_000 });
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
    // Only the turn's own working time spends the budget, not the wall clock since the start.
    expect(store.run.budgetUsedMs).toBe(120_000);

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
          reason: expect.stringMatching(/^it stopped booting: /),
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
    store.start();
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

  it("keeps the person's direction until a step says it is done, and through Off", () => {
    const store = new Store();
    store.start();
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
    // Nothing is taken off the run as the step starts.
    expect(store.run.steer).toEqual(["Make it night.", "And rain."]);
    // A step that does not say it is done leaves the direction for the next one.
    store.complete(turn());
    store.complete({ kind: "judge", base: facts(), build: { ...facts(), build: BUILD } });
    expect(store.run.steer).toEqual(["Make it night.", "And rain."]);
    store.complete(look());
    expect(store.step().step).toMatchObject({
      proposal: { why: "steer" },
      steer: ["Make it night.", "And rain."],
    });
    store.ok({ type: "game-run.stop", runId: store.run.id });
    expect(store.run).toMatchObject({
      status: "ended",
      ending: "stopped",
      steer: ["Make it night.", "And rain."],
    });
    // Turned on again with words of their own, those are its direction.
    store.ok({ type: "game-run.resume", runId: store.run.id, direction: "Add fog instead." });
    expect(store.run.steer).toEqual(["Add fog instead."]);
  });

  it("retires the direction a step carried once its reply says it is done, unless undone", () => {
    const store = new Store();
    store.start();
    store.ok({ type: "game-run.steer", runId: store.run.id, note: "Make it night." });
    store.complete(look());
    store.ok({ type: "game-run.steer", runId: store.run.id, note: "And rain." });
    store.complete(turn({ done: true }));
    store.complete({ kind: "judge", base: facts(), build: { ...crashes, build: BUILD } });
    store.complete({ kind: "undo", restored: true, why: "restored", message: "" });
    expect(store.run.steer).toEqual(["Make it night.", "And rain."]);
    store.complete(look());
    const carried = store.step().step;
    expect(carried).toMatchObject({ steer: ["Make it night.", "And rain."] });
    store.complete(turn({ done: true, runId: RunId.make("t3-run-2") }));
    store.complete({ kind: "judge", base: facts(), build: { ...facts(), build: BUILD } });
    expect(store.run.steer).toEqual([]);
  });

  it("starts a proposal an earlier Kurambit's Guided mode left waiting, on no countdown", () => {
    const store = new Store();
    store.start();
    const proposal = store.legacyProposal();
    store.ok({ type: "game-run.decision.expire", runId: store.run.id, decisionId: proposal });
    expect(store.step().step).toMatchObject({ kind: "turn", proposal: { key: "next:boss" } });
    expect(store.run.status).toBe("running");
    expect(
      refusal(
        store.send({
          type: "game-run.decision.expire",
          runId: store.run.id,
          decisionId: proposal,
        }),
      ),
    ).toBe("no-decision");
  });

  it("a turn on the game supersedes a waiting proposal: the run looks again", () => {
    const store = new Store();
    store.start();
    store.legacyProposal();
    store.complete({ kind: "decided", answer: "superseded", by: "server" });
    expect(store.step().step.kind).toBe("look");
    expect(store.run.status).toBe("running");
  });

  it("a restart or pause during the judge runs that judge again, never a second turn", () => {
    const store = new Store();
    store.start();
    store.complete(look());
    store.complete(turn());
    const judge = store.step();
    const woken = store.ok({
      type: "game-run.step.schedule",
      runId: store.run.id,
      stepId: judge.id,
      attempt: 1,
      at: T0 + 1,
      timer: { kind: "recover" },
    });
    expect(store.effects.map((e) => e.request.type)).toEqual(["game-run.step.wake"]);
    // The orchestrator commits no command without an event: a wake records itself on the step.
    expect(woken.events.map((e) => e.type)).toEqual(["game-run-step.updated"]);
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

  it("keeps a started step's direction when its turn ends on a usage limit (WB2)", () => {
    const store = new Store();
    store.start();
    store.ok({ type: "game-run.steer", runId: store.run.id, note: "Add a boss at wave 5." });
    store.complete(look());
    store.ok({
      type: "game-run.step.start",
      runId: store.run.id,
      stepId: store.step().id,
      attempt: 1,
    });
    expect(store.run.steer).toEqual(["Add a boss at wave 5."]);
    store.complete({
      kind: "ended",
      ending: "usage-limit",
      reason: "Claude's usage limit is reached",
    });
    expect(store.run).toMatchObject({
      status: "ended",
      ending: "usage-limit",
      steer: ["Add a boss at wave 5."],
    });
  });

  it("a retry that starts after a Redo is superseded, never judged (TW1)", () => {
    const store = new Store();
    store.start();
    store.complete(look());
    store.complete(turn());
    store.complete({ kind: "judge", base: facts(), build: { ...crashes, build: BUILD } });
    store.complete({ kind: "undo", restored: true, why: "restored", message: "" });
    store.complete(look());
    expect(store.step().step).toMatchObject({
      kind: "turn",
      base: BASE,
      proposal: { why: "regression" },
    });
    store.complete(turn({ startBuild: BUILD, runId: RunId.make("t3-run-2") }));
    expect(store.step().step.kind).toBe("look");
    expect(store.rounds).toHaveLength(1);
  });

  it("a person's turn landing during the look's facts wait is never judged as the step (TW1)", () => {
    const store = new Store();
    store.start();
    store.complete(look());
    const PERSON = GameBuildId.make("c".repeat(40));
    store.complete(turn({ startBuild: PERSON }));
    expect(store.step().step.kind).toBe("look");
    expect(store.rounds).toEqual([]);
  });

  it("stops on two steps in a row that changed nothing, and resumes afresh", () => {
    const store = new Store();
    store.start();
    store.complete(look());
    store.complete(turn({ files: 0 }));
    store.complete(look({ next: { text: "Polish the menu." } }));
    store.complete(turn({ files: 0 }));
    expect(store.run).toMatchObject({ status: "ended", ending: "stalled", inFlight: null });
    store.ok({ type: "game-run.resume", runId: store.run.id });
    expect(store.run).toMatchObject({ status: "running", stallStreak: 0 });
    expect(store.step().step.kind).toBe("look");
  });

  it("pauses when steps keep never landing, whatever made them", () => {
    const store = new Store();
    store.start();
    // A waiting proposal a turn superseded, a turn that came up behind another, and one that
    // started on another build: each looks again, and the third pauses.
    store.legacyProposal();
    store.complete({ kind: "decided", answer: "superseded", by: "server" });
    expect(store.step().step.kind).toBe("look");
    store.complete(look());
    store.complete(turn({ outcome: "superseded", startBuild: null, build: null }));
    expect(store.step().step).toMatchObject({ kind: "look" });
    expect(store.run.supersededStreak).toBe(2);
    store.complete(look());
    store.complete(turn({ startBuild: GameBuildId.make("c".repeat(40)) }));
    expect(store.run).toMatchObject({ status: "ended", ending: "stalled", inFlight: null });
    expect(store.run.lastFailure).toMatch(/^3 steps in a row never started/);
    expect(store.rounds).toEqual([]);
    // A resume starts the count afresh.
    store.ok({ type: "game-run.resume", runId: store.run.id });
    expect(store.run.supersededStreak).toBe(0);
  });

  it("a landed step ends the streak of steps that never landed", () => {
    const store = new Store();
    store.start();
    for (let i = 0; i < 2; i++) {
      store.complete(look());
      store.complete(turn({ outcome: "superseded", startBuild: null, build: null }));
    }
    expect(store.run.supersededStreak).toBe(2);
    store.complete(look());
    store.complete(turn());
    store.complete({ kind: "judge", base: facts(), build: { ...facts(), build: BUILD } });
    expect(store.run).toMatchObject({ status: "running", supersededStreak: 0 });
    // A look after a landed step measures afresh.
    expect(store.step().step).toEqual({ kind: "look", id: 8 });
  });

  it("pauses on a folder edited outside any build, before planning a step its undo could hurt", () => {
    const store = new Store();
    store.start();
    store.complete(look({ edited: true, facts: null }));
    expect(store.run).toMatchObject({ status: "ended", ending: "stalled" });
    expect(store.run.lastFailure).toContain("changes no build holds");
  });

  it("never sends again a step that changed nothing", () => {
    const store = new Store();
    store.start();
    store.complete(look());
    store.complete(turn({ files: 0 }));
    expect(store.run.setAside?.map((entry) => entry.why)).toEqual([
      "a step at it changed no game files",
    ]);
    // The agent repeats its line: nothing is left to propose, and no turn is spent on it.
    store.complete(look());
    expect(store.run).toMatchObject({ status: "ended", ending: "stalled" });
    expect(store.run.lastFailure).toBe("every step left to propose was set aside");
  });

  it("tells the next step that the time cap, not the person, stopped the last one", () => {
    const store = new Store();
    store.start();
    store.complete(look());
    store.complete(turn({ outcome: "capped" }));
    store.complete({ kind: "judge", base: facts(), build: { ...facts(), build: BUILD } });
    expect(store.rounds.at(-1)?.round.step?.capped).toBe(15);
    // The next step finishes it, once, under the same never-repeat key.
    store.complete(look({ next: { text: "Add a boss." } }));
    const finishing = store.step().step;
    expect(finishing).toMatchObject({ kind: "turn", proposal: { why: "next" } });
    expect(finishing.kind === "turn" ? finishing.proposal.text : "").toMatch(
      /^Finish step 1: Add a score counter\.\n\nKurambit's time cap stopped step 1/,
    );
    expect(store.run.finish).toBeUndefined();
    store.complete(turn({ outcome: "capped", runId: RunId.make("t3-run-2") }));
    store.complete({ kind: "judge", base: facts(), build: { ...facts(), build: BUILD } });
    expect(store.run.finish).toBeUndefined();
    const next = Decide.stepMessage(store.rounds, 0, {
      why: "next",
      text: "Add a boss.",
      target: null,
    });
    expect(next.text).toContain(
      "Kurambit's 15-minute time cap stopped your last keep-going step's turn",
    );
    expect(
      Decide.stepMessage([], 0, { why: "next", text: "Add a boss.", target: null }).text,
    ).not.toContain("time cap");
    const boss = { why: "next", text: "Add a boss.", target: null } as const;
    expect(Decide.stepMessage([], 0, boss, undefined, 4 * 60_000).text).toContain(
      "leaves this turn 4 minute(s)",
    );
    expect(Decide.stepMessage([], 0, boss, undefined, 15 * 60_000).text).not.toContain("leaves");
  });

  it("numbers a chat's first step after the game's steps in its other chats", () => {
    // Builds are listed per game: two chats' steps must never share a name.
    expect(
      Decide.stepMessage([], 3, { why: "next", text: "Add a boss.", target: null }).text,
    ).toMatch(/^Keep going · step 4 /);
    const store = new Store();
    store.gameLastStep = 3;
    store.start();
    store.complete(look());
    store.complete(turn());
    store.complete({ kind: "judge", base: facts(), build: { ...facts(), build: BUILD } });
    expect(store.rounds.at(-1)?.round.round).toBe(4);
  });
});
