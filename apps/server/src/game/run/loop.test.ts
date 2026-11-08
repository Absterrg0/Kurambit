// The keep-going policy's tricky rules: what counts as worse, what counts as
// gain, never repeating a failed step, and the person's captured notes.
import { describe, expect, it } from "@effect/vitest";
import {
  type GameBuildFacts,
  GameBuildId,
  type GameRunProposal,
  type GameRunStep,
  type GameRunTurnStep,
  GameRunId,
  RunId,
  ThreadId,
  gameRunStepId,
} from "@kurambit/contracts";

import * as Loop from "./loop.ts";
import type { RunState } from "./state.ts";

const BASE = GameBuildId.make("a".repeat(40));
const BUILD = GameBuildId.make("b".repeat(40));
const NOW = 1_800_000_000_000;

type Ending = "won" | "lost" | "no-ending" | "crashed" | "unresponsive" | "did-not-boot";
const tier = (ending: Ending, at: number | null = 20) => ({
  status: "measured" as const,
  value: { ending, at, played: 60, note: "", evidence: "builds/logs/x" },
});
const facts = (patch: Partial<GameBuildFacts> = {}): GameBuildFacts => ({
  build: BASE,
  key: "web:" + "c".repeat(40),
  harness: "h1",
  state: "measured",
  measuredAt: null,
  renderer: "GPU",
  boots: { status: "measured", value: { ok: true, detail: "" } },
  idle: tier("lost", 30),
  masher: tier("lost", 20),
  skilled: {
    status: "measured",
    value: {
      ...tier("won", 40).value,
      bot: { file: ".studio/bot/play.mjs", hash: "x", decider: "policy" },
      botWord: null,
    },
  },
  winnableWithoutSkill: { status: "measured", value: false },
  liveness: {
    status: "measured",
    value: {
      freezes: [],
      longestFreeze: 0,
      motion: 5,
      detail: 40,
      dominantColour: 0.2,
      longestStall: 0,
      seconds: 60,
    },
  },
  firstResponse: { status: "measured", value: { seconds: 0.1, window: 2, resolution: 0.05 } },
  assets: { status: "measured", value: { models: [], more: 0, libraryFiles: 0 } },
  use: { status: "not-measured", why: "not played", retry: false },
  performance: { status: "not-measured", why: "not played", retry: false },
  scene: { status: "not-measured", why: "not played", retry: false },
  message: "",
  ...patch,
});
const skilledWith = (ending: Ending, hash = "x"): Partial<GameBuildFacts> => ({
  skilled: {
    status: "measured",
    value: {
      ...tier(ending, 40).value,
      bot: { file: ".studio/bot/play.mjs", hash, decider: "policy" },
      botWord: null,
    },
  },
});

const state = (patch: Partial<RunState> = {}): RunState => ({
  profile: "autopilot",
  budgetMinutes: null,
  budgetEndsAt: null,
  steer: [],
  setAside: [],
  stallStreak: 0,
  lastFailure: "",
  ending: null,
  records: [],
  n: 1,
  ...patch,
});

const proposal = (patch: Partial<GameRunProposal> = {}): GameRunProposal => ({
  why: "next",
  text: "Add a second enemy type.",
  target: null,
  key: "next:1",
  ...patch,
});
const turnStep = (patch: Partial<GameRunTurnStep> = {}): GameRunTurnStep => ({
  kind: "turn",
  id: 3,
  proposal: proposal(),
  steer: [],
  base: BASE,
  capMs: 15 * 60_000,
  startedBy: "autopilot",
  ...patch,
});
// `startBuild` is the folder's build when the turn started (T's report).
type Turned = Loop.TurnResult & { readonly startBuild?: GameBuildId | null };
const turnResult = (patch: Partial<Turned> = {}): Loop.TurnResult =>
  ({
    kind: "turn",
    startBuild: BASE,
    runId: RunId.make("run-t3-1"),
    outcome: "completed",
    build: BUILD,
    files: 2,
    tokens: 40_000,
    elapsedMs: 180_000,
    personSteered: false,
    reason: "",
    ...patch,
  }) as Loop.TurnResult;
const look = (patch: Partial<Loop.LookResult> = {}): Loop.LookResult => ({
  kind: "look",
  current: BASE,
  facts: facts(),
  next: { text: "Add a score counter." },
  bot: true,
  ...patch,
});
const cycle = (turn = turnStep(), result = turnResult()): Loop.Cycle => ({
  turn,
  result,
  since: NOW - 300_000,
});
const judged = (s: RunState, base: GameBuildFacts, build: GameBuildFacts, c = cycle()) =>
  Loop.applyJudge(s, c, { kind: "judge", base, build: { ...build, build: BUILD } }, NOW);

describe("worse", () => {
  it("counts a crossing into bad, never a fact already bad that gets worse", () => {
    const crashed = facts({ masher: tier("crashed", 12) });
    expect(Loop.regressions(facts(), crashed, false).map((r) => [r.delta.id, r.kind])).toEqual([
      ["masher", "health"],
    ]);
    const froze = (s: number) =>
      facts({
        liveness: {
          status: "measured",
          value: {
            freezes: [{ at: 4, seconds: s }],
            longestFreeze: s,
            motion: 5,
            detail: 40,
            dominantColour: 0.2,
            longestStall: 0,
            seconds: 60,
          },
        },
      });
    expect(Loop.regressions(froze(1), froze(3.2), false).map((r) => r.delta.id)).toEqual([
      "freeze",
    ]);
    // Already bad on the base: the next blocker step's business, not an undo.
    expect(Loop.regressions(froze(3.1), froze(6), false)).toEqual([]);
  });

  it("never counts what cannot be compared: a renderer, a harness or a bot that changed", () => {
    const crashed = facts({
      boots: { status: "measured", value: { ok: false, detail: "throws" } },
    });
    expect(Loop.regressions(facts(), { ...crashed, renderer: "SwiftShader" }, false)).toEqual([]);
    expect(Loop.regressions(facts(), { ...crashed, harness: "h2" }, false)).toEqual([]);
    expect(Loop.regressions(facts(), facts(skilledWith("lost", "y")), false)).toEqual([]);
    expect(Loop.regressions(facts(), { ...crashed, boots: { status: "pending" } }, false)).toEqual(
      [],
    );
  });

  it("splits health from design, and a step the person asked for keeps its design", () => {
    const easier = facts({
      masher: tier("won", 9),
      winnableWithoutSkill: { status: "measured", value: true },
    });
    expect(Loop.regressions(facts(), easier, false).map((r) => [r.delta.id, r.kind])).toEqual([
      ["masher", "design"],
      ["winnable-without-skill", "design"],
    ]);
    expect(Loop.regressions(facts(), easier, true)).toEqual([]);
    // Skilled stopping winning is design; skilled crashing is health and always counts.
    expect(Loop.regressions(facts(), facts(skilledWith("lost")), true)).toEqual([]);
    expect(
      Loop.regressions(facts(), facts(skilledWith("crashed")), true).map((r) => r.kind),
    ).toEqual(["health"]);
  });

  it("undoes a regression, keeps a steer step's design change, and keeps the unmeasured", () => {
    const easier = facts({ winnableWithoutSkill: { status: "measured", value: true } });
    expect(judged(state(), facts(), easier).plan).toEqual({
      kind: "undo",
      target: BASE,
      expect: BUILD,
    });
    const asked = cycle(turnStep({ proposal: proposal({ why: "steer", key: "steer:1" }) }));
    expect(judged(state(), facts(), easier, asked).record?.step.verdict).toBe("kept");
    const steered = cycle(turnStep(), turnResult({ personSteered: true }));
    expect(judged(state(), facts(), easier, steered).record?.step.verdict).toBe("kept");
    const unmeasured = judged(state(), facts(), { ...easier, harness: "h2" });
    expect(unmeasured.plan).toEqual({ kind: "look" });
    expect(unmeasured.record).toMatchObject({
      failure: "harness",
      step: { verdict: "not-measured" },
    });
  });
});

describe("gain", () => {
  const input = (patch: Partial<Parameters<typeof Loop.gain>[0]> = {}) => ({
    verdict: "kept" as const,
    files: 0,
    turn: { proposal: proposal(), startedBy: "autopilot" as const },
    deltas: [],
    build: facts(),
    ...patch,
  });

  it("is a kept step that changed the game; flat facts do not take it away", () => {
    expect(Loop.gain(input({ files: 3 }))).toBe(true);
    expect(Loop.gain(input())).toBe(false);
    expect(Loop.gain(input({ files: 3, verdict: "undone" }))).toBe(false);
    expect(Loop.gain(input({ files: 3, verdict: "kept-moved-on" }))).toBe(false);
  });

  it("also counts a closed target: the person's own step, the bot once skilled is measured", () => {
    expect(Loop.gain(input({ turn: { proposal: proposal(), startedBy: "creator" } }))).toBe(true);
    const bot = { proposal: proposal({ why: "bot", key: "bot" }), startedBy: "autopilot" as const };
    expect(Loop.gain(input({ turn: bot }))).toBe(true);
    expect(
      Loop.gain(
        input({
          turn: bot,
          build: facts({
            skilled: { status: "not-measured", why: "no play-mode bot", retry: false },
          }),
        }),
      ),
    ).toBe(false);
  });

  it("pauses the run after two steps in a row that gained nothing", () => {
    const quiet = cycle(turnStep(), turnResult({ files: 0 }));
    const first = Loop.applyTurn(state(), quiet.turn, quiet.result, {
      now: NOW,
      since: NOW,
      started: true,
    });
    expect(first.record?.step.verdict).toBe("no-change");
    expect(first.plan).toEqual({ kind: "look" });
    const second = Loop.applyTurn(first.state, quiet.turn, quiet.result, {
      now: NOW,
      since: NOW,
      started: true,
    });
    expect(second.state.ending).toBe("stalled");
    // A kept change in between resets the streak.
    const kept = judged(first.state, facts(), facts());
    expect(kept.state.stallStreak).toBe(0);
  });

  it("pauses as tool-failed on two unmeasured steps in a row", () => {
    const once = judged(state(), facts(), { ...facts(), harness: "h2" });
    const twice = judged(once.state, facts(), { ...facts(), harness: "h2" });
    expect(twice.state.ending).toBe("tool-failed");
    expect(twice.state.lastFailure).toContain("could not measure two builds in a row");
  });
});

describe("never repeat", () => {
  const easier = facts({ winnableWithoutSkill: { status: "measured", value: true } });
  const undoOnce = (s: RunState, c: Loop.Cycle) =>
    Loop.applyUndo(
      s,
      { ...c, judge: { kind: "judge", base: facts(), build: easier } },
      { kind: "undo", restored: true, why: "restored", message: "" },
      NOW,
    );

  it("retries an undone step once, then sets its key aside", () => {
    const first = undoOnce(state(), cycle());
    expect(first.record?.step).toMatchObject({ verdict: "undone", key: "next:1" });
    const retry = Loop.propose(first.state, look());
    expect(retry).toMatchObject({ why: "regression", key: "next:1" });
    expect(retry?.text).toContain("Add a second enemy type.");
    const second = undoOnce(first.state, cycle(turnStep({ proposal: retry! })));
    expect(second.state.setAside.map((s) => s.key)).toEqual(["next:1"]);
    // The retry is not proposed again; the agent's own line comes instead.
    expect(Loop.propose(second.state, look())).toMatchObject({
      why: "next",
      text: "Add a score counter.",
    });
  });

  it("sets aside a fact step the agent declined, a skipped step, and a bot step that left no bot", () => {
    const fact = turnStep({
      proposal: proposal({
        why: "fact",
        target: "winnable-without-skill",
        key: "fact:winnable-without-skill",
      }),
    });
    const declined = Loop.applyTurn(state(), fact, turnResult({ files: 0 }), {
      now: NOW,
      since: NOW,
      started: true,
    });
    expect(declined.state.setAside.map((s) => s.key)).toEqual(["fact:winnable-without-skill"]);
    expect(Loop.propose(declined.state, look({ facts: easier, next: "none" }))).toBeNull();

    const skipped = Loop.applyDecided(state(), proposal(), BASE, "skip", "creator", NOW);
    expect(skipped.state.setAside).toEqual([
      { key: "next:1", text: "Add a second enemy type.", why: "you skipped it" },
    ]);

    const bot = turnStep({ proposal: proposal({ why: "bot", key: "bot" }) });
    const noBot = Loop.applyTurn(state(), bot, turnResult({ files: 0, build: null }), {
      now: NOW,
      since: NOW,
      started: true,
    });
    expect(noBot.state.setAside.map((s) => s.key)).toEqual(["bot"]);
  });
});

describe("the proposal", () => {
  it("follows the order of evidence and ends done only on Next: none", () => {
    const crashing = facts({ masher: tier("crashed", 12) });
    expect(Loop.propose(state({ steer: ["Make it night."] }), look({ facts: crashing }))?.why).toBe(
      "steer",
    );
    const blocker = Loop.propose(state(), look({ facts: crashing }));
    expect(blocker).toMatchObject({ why: "blocker", target: "masher", key: "fact:masher" });
    expect(blocker?.text).toContain("builds/logs/x/trace.json");
    expect(Loop.propose(state(), look({ next: null }))?.text).toBe(
      "Make the one change that most improves the game for BRIEF.md.",
    );
    expect(Loop.applyLook(state(), look({ next: "none" }), NOW).state.ending).toBe("done");
  });

  it("proposes the bot once for a booting game without one, ending or not", () => {
    expect(Loop.propose(state(), look({ bot: false }))?.why).toBe("bot");
    const noEnding = facts({ idle: tier("no-ending", null), masher: tier("no-ending", null) });
    expect(Loop.propose(state(), look({ bot: false, facts: noEnding }))?.why).toBe("bot");
    expect(Loop.propose(state(), look({ bot: true, facts: noEnding }))?.why).toBe("next");
    const tried = Loop.applyTurn(
      state(),
      turnStep({ proposal: proposal({ why: "bot", key: "bot" }) }),
      turnResult({ files: 0 }),
      { now: NOW, since: NOW, started: true },
    );
    expect(tried.plan).toMatchObject({ kind: "judge" });
    const recorded = judged(
      state(),
      facts(),
      facts(),
      cycle(turnStep({ proposal: proposal({ why: "bot", key: "bot" }) }), turnResult({ files: 0 })),
    );
    expect(recorded.record?.step.gain).toBe(true);
    expect(Loop.propose(recorded.state, look({ bot: false }))?.why).toBe("next");
  });

  it("checks the budget before each turn and caps the turn at the time left", () => {
    const ends = (minutes: number) => state({ budgetEndsAt: NOW + minutes * 60_000 });
    expect(Loop.applyLook(ends(7), look(), NOW).state.ending).toBe("budget");
    expect(Loop.applyLook(ends(10), look(), NOW).plan).toMatchObject({
      kind: "turn",
      capMs: 10 * 60_000,
    });
    expect(Loop.applyLook(ends(60), look(), NOW).plan).toMatchObject({ capMs: 15 * 60_000 });
    expect(Loop.applyLook(state({ profile: "guided" }), look(), NOW).plan).toMatchObject({
      kind: "propose",
      deadline: NOW + 60_000,
    });
  });
});

describe("the captured prefix", () => {
  const runId = GameRunId.make("run_1");
  const record = (status: GameRunStep["status"], steer: ReadonlyArray<string>): GameRunStep => ({
    id: gameRunStepId(runId, 3),
    runId,
    threadId: ThreadId.make("thread:chat"),
    seq: 3,
    attempt: 1,
    kind: "turn",
    step: turnStep({ steer }),
    status,
    result: null,
    logs: [],
    plannedAt: "2026-11-07T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
  });

  it("holds the notes until the turn starts, and gives them back when it never landed", () => {
    expect(Loop.capturedSteer(record("planned", ["a", "b"]))).toBe(2);
    expect(Loop.capturedSteer(record("running", ["a", "b"]))).toBe(0);
    const s = state({ steer: ["a", "b"] });
    const turn = Loop.applyLook(s, look(), NOW).plan;
    expect(turn).toMatchObject({ kind: "turn", steer: ["a", "b"], startedBy: "autopilot" });
    // Started (taken off the run's steer), then superseded: given back ahead of a newer note.
    const step = turnStep({ steer: ["a", "b"], proposal: proposal({ why: "steer" }) });
    const back = Loop.applyTurn(
      state({ steer: ["c"] }),
      step,
      turnResult({ outcome: "superseded" }),
      {
        now: NOW,
        since: NOW,
        started: true,
      },
    );
    expect(back.state.steer).toEqual(["a", "b", "c"]);
    expect(back.plan).toEqual({ kind: "look" });
    // Superseded before it started: the notes never left the run's steer.
    const kept = Loop.applyTurn(
      state({ steer: ["a", "b", "c"] }),
      step,
      turnResult({ outcome: "superseded" }),
      {
        now: NOW,
        since: NOW,
        started: false,
      },
    );
    expect(kept.state.steer).toEqual(["a", "b", "c"]);
  });
});

describe("a step acts only on the build it was planned on (TW1)", () => {
  const started = { now: NOW, since: NOW, started: true };

  it("never judges a turn that started on another build, or on an unknown one", () => {
    // A person's turn landed while the look waited for facts: the step's turn started on it.
    const moved = Loop.applyTurn(state(), turnStep(), turnResult({ startBuild: BUILD }), started);
    expect(moved.plan).toEqual({ kind: "look" });
    expect(moved.record).toBeNull();
    const unknown = Loop.applyTurn(state(), turnStep(), turnResult({ startBuild: null }), started);
    expect(unknown.plan).toEqual({ kind: "look" });
    // An unknown start is never looped on: two in a row pause the run.
    expect(moved.state.stallStreak).toBe(0);
    expect(
      Loop.applyTurn(unknown.state, turnStep(), turnResult({ startBuild: null }), started).state
        .ending,
    ).toBe("stalled");
    // A turn that started where its look read is judged against that build.
    expect(Loop.applyTurn(state(), turnStep(), turnResult(), started).plan).toEqual({
      kind: "judge",
      build: BUILD,
      base: BASE,
    });
  });

  it("never retries a step the person redid", () => {
    const easier = facts({ winnableWithoutSkill: { status: "measured", value: true } });
    const undone = Loop.applyUndo(
      state(),
      { ...cycle(), judge: { kind: "judge", base: facts(), build: easier } },
      { kind: "undo", restored: true, why: "restored", message: "" },
      NOW,
    );
    expect(Loop.propose(undone.state, look({ current: BASE }))?.why).toBe("regression");
    // Redo put the step's build back in the folder: the agent's own line comes next.
    expect(Loop.propose(undone.state, look({ current: BUILD }))?.why).toBe("next");
  });

  it("words a failed undo as failed, and only a moved folder as moved on", () => {
    const easier = facts({ winnableWithoutSkill: { status: "measured", value: true } });
    const judged = { ...cycle(), judge: { kind: "judge" as const, base: facts(), build: easier } };
    expect(Loop.undoReason(judged)).toContain("Winnable without skill");
    const failed = Loop.applyUndo(
      state(),
      judged,
      { kind: "undo", restored: false, why: "refused", message: "the copy could not be made" },
      NOW,
    );
    // Not undone either way; the reason, not the verdict, says the restore failed.
    expect(failed.record?.step).toMatchObject({ verdict: "kept-moved-on", gain: false });
    expect(failed.record?.step.reason).toMatch(
      /^the copy could not be made \(Winnable without skill/,
    );
    const moved = Loop.applyUndo(
      state(),
      judged,
      { kind: "undo", restored: false, why: "moved-on", message: "" },
      NOW,
    );
    expect(moved.record?.step.verdict).toBe("kept-moved-on");
    expect(moved.record?.step.reason).toMatch(/^the game changed after it/);
  });
});
