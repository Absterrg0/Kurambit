import { describe, expect, it } from "@effect/vitest";
import type {
  GameAcceptanceCriterion,
  GameScenarioEvidence,
  GameScenarioObservation,
} from "@t3tools/contracts";
import {
  evaluateScenarios,
  LEGACY_PLAYING_MATCH_ID,
  parseScenarioExpectation,
} from "./scenarioEvaluation.ts";

const observation = (
  key: string,
  values: Partial<GameScenarioObservation> = {},
): GameScenarioObservation => ({
  key,
  min: null,
  max: null,
  first: null,
  last: null,
  firstChangeFrame: null,
  baseline: null,
  matches: [],
  ...values,
});

const run = (input: Partial<GameScenarioEvidence> = {}): GameScenarioEvidence => ({
  id: "full-run",
  frames: 900,
  durationMs: 1_000,
  firstInputFrame: 30,
  baselineFrame: 36,
  playerMoved: true,
  error: null,
  invalidActions: [],
  observations: [],
  ...input,
});

const criterion = (
  id: string,
  kind: GameAcceptanceCriterion["kind"],
  observe?: { key: string; expect: string },
): GameAcceptanceCriterion => ({ id, kind, text: id, ...(observe ? { observe } : {}) });

const exam = () => [
  criterion("move", "control", { key: "jumps", expect: ">=1" }),
  criterion("collect", "mechanic", { key: "collected", expect: ">=1" }),
  criterion("coins", "content", { key: "collected", expect: ">=3" }),
  criterion("win", "win", { key: "state", expect: "==3" }),
  criterion("lose", "lose", { key: "lives", expect: "<=0" }),
];

const observations = () => [
  observation("jumps", {
    baseline: 0,
    min: 0,
    max: 4,
    first: 0,
    last: 4,
    matches: [{ id: "move", frame: 72 }],
  }),
  observation("collected", {
    baseline: 0,
    min: 0,
    max: 5,
    first: 0,
    last: 5,
    matches: [
      { id: "collect", frame: 120 },
      { id: "coins", frame: 400 },
    ],
  }),
  observation("state", {
    baseline: 1,
    min: 1,
    max: 3,
    first: 0,
    last: 3,
    matches: [{ id: "win", frame: 880 }],
  }),
  observation("lives", {
    baseline: 3,
    min: 0,
    max: 3,
    first: 3,
    last: 0,
    matches: [{ id: "lose", frame: 300 }],
  }),
];

describe("parseScenarioExpectation", () => {
  it("reads every approved operator", () => {
    expect(parseScenarioExpectation("changes")).toEqual({ kind: "changes" });
    expect(parseScenarioExpectation("==3")).toEqual({ kind: "equals", value: 3 });
    expect(parseScenarioExpectation(">=2")).toEqual({ kind: "atLeast", value: 2 });
    expect(parseScenarioExpectation("<=-1.5")).toEqual({ kind: "atMost", value: -1.5 });
    expect(parseScenarioExpectation("!=3")).toBeNull();
    expect(parseScenarioExpectation("3")).toBeNull();
  });
});

describe("evaluateScenarios", () => {
  it("fails without an approved design; the agent cannot grade a draft", () => {
    const summary = evaluateScenarios({ mode: "none", criteria: [], runs: [run()] });
    expect(summary).toMatchObject({ mode: "none", passed: false, reason: "no-acceptance" });
  });

  it("passes only when every criterion changed after play started", () => {
    const summary = evaluateScenarios({
      mode: "criteria",
      criteria: exam(),
      runs: [run({ observations: observations() })],
    });
    expect(summary.passed).toBe(true);
    expect(summary.reason).toBe("criteria-passed");
    expect(summary.criteria.map((entry) => [entry.id, entry.status])).toEqual([
      ["move", "passed"],
      ["collect", "passed"],
      ["coins", "passed"],
      ["win", "passed"],
      ["lose", "passed"],
    ]);
    expect(summary.criteria.find((entry) => entry.id === "win")?.provenBy).toEqual({
      scenario: "full-run",
      frame: 880,
    });
    expect(summary.coverage).toEqual([
      { kind: "control", proven: 1, failed: 0, missing: 0 },
      { kind: "mechanic", proven: 1, failed: 0, missing: 0 },
      { kind: "content", proven: 1, failed: 0, missing: 0 },
      { kind: "win", proven: 1, failed: 0, missing: 0 },
      { kind: "lose", proven: 1, failed: 0, missing: 0 },
    ]);
  });

  it("fails a boot constant that is already true when play starts", () => {
    const summary = evaluateScenarios({
      mode: "criteria",
      criteria: [
        criterion("five-pearls", "content", { key: "total", expect: "==5" }),
        criterion("win", "win", { key: "state", expect: "==3" }),
      ],
      runs: [
        run({
          observations: [
            observation("total", { baseline: 5, min: 5, max: 5, first: 5, last: 5 }),
            observation("state", {
              baseline: 1,
              min: 1,
              max: 3,
              first: 0,
              last: 3,
              matches: [{ id: "win", frame: 800 }],
            }),
          ],
        }),
      ],
    });
    expect(summary.passed).toBe(false);
    expect(summary.reason).toBe("observable-failed");
    const total = summary.criteria.find((entry) => entry.id === "five-pearls");
    expect(total?.status).toBe("failed");
    expect(total?.observed).toContain("already true when play started");
    expect(total?.observed).toContain("observe something the player achieves");
  });

  it("fails every criterion when the route never pressed a control", () => {
    const summary = evaluateScenarios({
      mode: "criteria",
      criteria: exam(),
      runs: [
        run({
          firstInputFrame: null,
          baselineFrame: null,
          playerMoved: true,
          observations: observations().map((entry) => ({ ...entry, baseline: null, matches: [] })),
        }),
      ],
    });
    expect(summary.passed).toBe(false);
    expect(summary.reason).toBe("observable-failed");
    expect(summary.criteria.every((entry) => entry.status === "failed")).toBe(true);
    expect(summary.detail).toContain("move");
  });

  it("measures changes from the baseline, not from boot", () => {
    const changedBefore = evaluateScenarios({
      mode: "criteria",
      criteria: [criterion("win", "win", { key: "state", expect: "==3" })],
      runs: [
        run({
          observations: [
            observation("state", {
              first: 0,
              baseline: 1,
              last: 1,
              min: 0,
              max: 1,
              firstChangeFrame: 20,
              matches: [],
            }),
          ],
        }),
      ],
    });
    expect(changedBefore.passed).toBe(false);

    const changedAfter = evaluateScenarios({
      mode: "criteria",
      criteria: [criterion("flag", "mechanic", { key: "flag", expect: "changes" })],
      // A mechanics-only design still needs a win in the real exam; this fixture
      // isolates the change rule.
      runs: [
        run({
          observations: [
            observation("flag", {
              baseline: 0,
              first: 0,
              last: 2,
              min: 0,
              max: 2,
              matches: [{ id: "flag", frame: 90 }],
            }),
          ],
        }),
      ],
    });
    expect(changedAfter.criteria[0]?.status).toBe("passed");
    expect(changedAfter.passed).toBe(false); // no win criterion exists
    expect(changedAfter.reason).toBe("win-criterion-failed");
  });

  it("does not let a state change alone prove a win", () => {
    const summary = evaluateScenarios({
      mode: "criteria",
      criteria: [criterion("win", "win", { key: "state", expect: "changes" })],
      runs: [
        run({
          observations: [
            observation("state", {
              baseline: 1,
              min: 1,
              max: 2,
              first: 0,
              last: 2,
              matches: [{ id: "win", frame: 40 }],
            }),
          ],
        }),
      ],
    });
    expect(summary.passed).toBe(false);
    expect(summary.criteria[0]?.status).toBe("failed");
    expect(summary.criteria[0]?.observed).toContain("value the run ends at");
  });

  it("fails a win that flashed and returned to play", () => {
    const summary = evaluateScenarios({
      mode: "criteria",
      criteria: [criterion("win", "win", { key: "state", expect: "==3" })],
      runs: [
        run({
          observations: [
            observation("state", {
              baseline: 1,
              min: 1,
              max: 3,
              first: 0,
              last: 1,
              matches: [{ id: "win", frame: 300 }],
            }),
          ],
        }),
      ],
    });
    expect(summary.passed).toBe(false);
    expect(summary.criteria[0]?.status).toBe("failed");
  });

  it("fails when no route moves the player, however many criteria matched", () => {
    const summary = evaluateScenarios({
      mode: "criteria",
      criteria: [criterion("win", "win", { key: "state", expect: "==3" })],
      runs: [
        run({
          playerMoved: false,
          observations: [
            observation("state", {
              baseline: 1,
              last: 3,
              min: 1,
              max: 3,
              matches: [{ id: "win", frame: 800 }],
            }),
          ],
        }),
      ],
    });
    expect(summary).toMatchObject({ passed: false, reason: "no-player-movement" });
  });

  it("fails the stage when a scenario reported a script error", () => {
    const summary = evaluateScenarios({
      mode: "criteria",
      criteria: [criterion("win", "win", { key: "state", expect: "==3" })],
      runs: [
        run({ error: "Godot reported: res://player.gd:4 boom" }),
        run({
          id: "other",
          observations: [
            observation("state", {
              baseline: 1,
              last: 3,
              min: 1,
              max: 3,
              matches: [{ id: "win", frame: 5 }],
            }),
          ],
        }),
      ],
    });
    expect(summary).toMatchObject({ passed: false, reason: "scenario-failed" });
  });

  it("reports a missing GameState property instead of passing it", () => {
    const summary = evaluateScenarios({
      mode: "criteria",
      criteria: [criterion("won", "win", { key: "won", expect: "==1" })],
      runs: [run({ observations: [observation("state")] })],
    });
    expect(summary.criteria[0]?.status).toBe("missing");
    expect(summary.passed).toBe(false);
  });

  it("blocks an unobserved mechanical claim and excludes presentation from state", () => {
    const summary = evaluateScenarios({
      mode: "criteria",
      criteria: [
        criterion("jump", "control"),
        criterion("glow", "presentation"),
        criterion("win", "win"),
      ],
      runs: [run()],
    });
    expect(summary.criteria.map((entry) => entry.id)).toEqual(["jump", "win"]);
    expect(summary.criteria[0]?.status).toBe("missing");
    expect(summary.criteria[0]?.observed).toContain("no observe");
    expect(summary.passed).toBe(false);
  });

  it("lets a declared no-lose-state promise stay outside the graded set", () => {
    const summary = evaluateScenarios({
      mode: "criteria",
      criteria: [
        criterion("win", "win", { key: "state", expect: "==3" }),
        { id: "no-lose", kind: "lose", text: "No lose state" },
      ],
      runs: [
        run({
          observations: [
            observation("state", {
              baseline: 1,
              last: 3,
              min: 1,
              max: 3,
              matches: [{ id: "win", frame: 800 }],
            }),
          ],
        }),
      ],
    });
    expect(summary.passed).toBe(true);
    expect(summary.criteria.find((entry) => entry.id === "no-lose")?.status).toBe("missing");
    expect(summary.coverage).toEqual([
      { kind: "win", proven: 1, failed: 0, missing: 0 },
      { kind: "lose", proven: 0, failed: 0, missing: 1 },
    ]);
  });

  it("grades legacy games on movement and reaching play through the menu", () => {
    const state = observation("state", {
      min: 0,
      max: 1,
      first: 0,
      last: 1,
      baseline: 1,
      firstChangeFrame: 30,
      matches: [{ id: LEGACY_PLAYING_MATCH_ID, frame: 30 }],
    });
    const passed = evaluateScenarios({
      mode: "legacy",
      criteria: [],
      runs: [run({ observations: [state] })],
    });
    expect(passed).toMatchObject({ mode: "legacy", passed: true, reason: "legacy-passed" });

    const still = evaluateScenarios({
      mode: "legacy",
      criteria: [],
      runs: [run({ playerMoved: false, observations: [state] })],
    });
    expect(still).toMatchObject({ passed: false, reason: "no-player-movement" });

    const neverPlayed = evaluateScenarios({
      mode: "legacy",
      criteria: [],
      runs: [
        run({
          baselineFrame: null,
          firstInputFrame: null,
          observations: [observation("state", { first: 0, last: 0, baseline: null })],
        }),
      ],
    });
    expect(neverPlayed).toMatchObject({ passed: false, reason: "legacy-unproven" });
  });
});
