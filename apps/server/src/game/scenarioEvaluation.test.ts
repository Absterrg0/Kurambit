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
  matches: [],
  ...values,
});

const run = (input: Partial<GameScenarioEvidence> = {}): GameScenarioEvidence => ({
  id: "full-run",
  frames: 900,
  durationMs: 1_000,
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

  it("requires every observable criterion, an observed end, and real movement", () => {
    const criteria = [
      criterion("coins", "content", { key: "collected", expect: ">=3" }),
      criterion("win", "end", { key: "state", expect: "==3" }),
      criterion("looks-right", "mechanic"),
    ];
    const summary = evaluateScenarios({
      mode: "criteria",
      criteria,
      runs: [
        run({
          observations: [
            observation("collected", { min: 0, max: 5, first: 0, last: 5 }),
            observation("state", {
              min: 0,
              max: 3,
              first: 0,
              last: 3,
              matches: [
                { id: "coins", frame: 400 },
                { id: "win", frame: 880 },
              ],
            }),
          ],
        }),
      ],
    });
    expect(summary.passed).toBe(true);
    expect(summary.reason).toBe("criteria-passed");
    expect(summary.criteria.map((entry) => [entry.id, entry.status])).toEqual([
      ["coins", "passed"],
      ["win", "passed"],
      ["looks-right", "unverified"],
    ]);
  });

  it("fails a route whose animation moved but whose pickup never changed", () => {
    const summary = evaluateScenarios({
      mode: "criteria",
      criteria: [
        criterion("pearls", "content", { key: "collected", expect: "changes" }),
        criterion("win", "end", { key: "state", expect: "==3" }),
      ],
      runs: [
        run({
          observations: [
            observation("collected", { min: 0, max: 0, first: 0, last: 0 }),
            observation("state", {
              min: 1,
              max: 1,
              first: 1,
              last: 1,
              matches: [{ id: "win", frame: 1 }],
            }),
          ],
        }),
      ],
    });
    expect(summary.passed).toBe(false);
    expect(summary.reason).toBe("observable-failed");
    expect(summary.detail).toContain("pearls");
  });

  it("fails an observable end that never happens, even when other criteria pass", () => {
    const summary = evaluateScenarios({
      mode: "criteria",
      criteria: [
        criterion("jump", "mechanic", { key: "score", expect: ">=1" }),
        criterion("win", "end"),
      ],
      runs: [
        run({
          observations: [
            observation("score", { min: 1, max: 1, matches: [{ id: "jump", frame: 10 }] }),
            observation("state", { min: 1, max: 1, first: 1, last: 1 }),
          ],
        }),
      ],
    });
    expect(summary).toMatchObject({ passed: false, reason: "end-criterion-failed" });
  });

  it("fails when no route moves the player, however many criteria matched", () => {
    const summary = evaluateScenarios({
      mode: "criteria",
      criteria: [criterion("win", "end", { key: "state", expect: "==3" })],
      runs: [
        run({
          playerMoved: false,
          observations: [observation("state", { matches: [{ id: "win", frame: 5 }] })],
        }),
      ],
    });
    expect(summary).toMatchObject({ passed: false, reason: "no-player-movement" });
  });

  it("fails the stage when a scenario reported a script error", () => {
    const summary = evaluateScenarios({
      mode: "criteria",
      criteria: [criterion("win", "end", { key: "state", expect: "==3" })],
      runs: [
        run({ error: "Godot reported: res://player.gd:4 boom" }),
        run({
          id: "other",
          observations: [observation("state", { matches: [{ id: "win", frame: 5 }] })],
        }),
      ],
    });
    expect(summary).toMatchObject({ passed: false, reason: "scenario-failed" });
  });

  it("reports a missing GameState property instead of passing it", () => {
    const summary = evaluateScenarios({
      mode: "criteria",
      criteria: [criterion("won", "end", { key: "won", expect: "==1" })],
      runs: [run({ observations: [observation("state")] })],
    });
    expect(summary.criteria[0]?.status).toBe("missing");
    expect(summary.passed).toBe(false);
  });

  it("grades legacy games on movement and reaching play through the menu", () => {
    const state = observation("state", {
      min: 0,
      max: 1,
      first: 0,
      last: 1,
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
      runs: [run({ observations: [observation("state")] })],
    });
    expect(neverPlayed).toMatchObject({ passed: false, reason: "legacy-unproven" });
  });
});
