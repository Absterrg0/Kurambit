import { expect, it } from "vite-plus/test";
import {
  decodeScenarioEvidence,
  sanitizeScenarioLayout,
  scenarioRequestJson,
} from "./gameScenarios.ts";
import { evaluateScenarios } from "./scenarioEvaluation.ts";
import type { GameScenarioEvidence } from "@t3tools/contracts";

const evidence = (overrides: Partial<GameScenarioEvidence> = {}): GameScenarioEvidence => ({
  id: "full-run",
  frames: 120,
  durationMs: 2000,
  firstInputFrame: 30,
  baselineFrame: 36,
  playerMoved: true,
  error: null,
  invalidActions: [],
  observations: [],
  ...overrides,
});

it("passes recordLayout through the runner request only when asked", () => {
  const base = {
    scenarioPath: "/tmp/scenario.json",
    observations: [],
    sampleEvery: 6,
    bootFrames: 30,
  };
  expect(JSON.parse(scenarioRequestJson(base))).not.toHaveProperty("recordLayout");
  expect(JSON.parse(scenarioRequestJson({ ...base, recordLayout: true }))).toMatchObject({
    recordLayout: true,
  });
});

it("decodes evidence written before runtime layout probes existed", () => {
  const decoded = decodeScenarioEvidence(
    JSON.stringify({
      id: "full-run",
      frames: 120,
      durationMs: 2000,
      firstInputFrame: 30,
      baselineFrame: 36,
      playerMoved: true,
      error: null,
      invalidActions: [],
      observations: [],
    }),
  );
  expect(decoded).not.toBeNull();
  expect(decoded?.layout).toBeUndefined();
});

it("bounds runner layout before persisting it", () => {
  const findings = Array.from({ length: 30 }, (_, index) => ({
    kind: "overlap-risk",
    subject: `Button "B${index}"`,
    detail: "x".repeat(900),
    nodePath: "y".repeat(900),
    scenarioFrame: index,
    step: 1,
    viewport: { width: 1152, height: 648 },
  }));
  const sanitized = sanitizeScenarioLayout({
    findings,
    coverage: {
      probes: 4,
      omittedProbes: 99,
      inspectedControls: 9999,
      pairs: 9999,
      truncated: true,
      viewport: { width: 1152, height: 648 },
    },
  });
  expect(sanitized).toBeDefined();
  // Bounded output: findings and text are capped, never multiplied without bound.
  expect(sanitized?.findings).toHaveLength(8);
  expect(sanitized?.findings[0]?.detail.length).toBeLessThanOrEqual(500);
  expect(sanitized?.findings[0]?.nodePath.length).toBeLessThanOrEqual(300);
  expect(sanitized?.coverage.omittedProbes).toBe(99);
});

it("drops malformed runner layout instead of persisting it", () => {
  expect(sanitizeScenarioLayout(null)).toBeUndefined();
  expect(sanitizeScenarioLayout({ findings: "nope" })).toBeUndefined();
  expect(sanitizeScenarioLayout({ findings: [], coverage: { probes: 1 } })).toBeUndefined();
});

it("never lets uncertain overlap geometry fail the mechanics gate", () => {
  const run = evidence({
    observations: [
      {
        key: "jumps",
        min: 0,
        max: 4,
        first: 0,
        last: 4,
        firstChangeFrame: 40,
        baseline: 0,
        matches: [{ id: "move", frame: 72 }],
      },
    ],
    layout: {
      findings: [
        {
          kind: "overlap-risk",
          subject: 'Button "Cook"',
          detail:
            "may be obscured by later sibling Panel (overlap risk: 40% overlaps; visual occlusion not proven from geometry).",
          nodePath: "Main/Cook",
          scenarioFrame: 90,
          step: 2,
          viewport: { width: 1152, height: 648 },
        },
      ],
      coverage: {
        probes: 2,
        omittedProbes: 0,
        inspectedControls: 3,
        pairs: 4,
        truncated: false,
        viewport: { width: 1152, height: 648 },
      },
    },
  });
  const summary = evaluateScenarios({
    mode: "criteria",
    criteria: [
      { id: "move", kind: "control", text: "move", observe: { key: "jumps", expect: ">=1" } },
    ],
    runs: [run],
  });
  expect(summary.passed).toBe(true);
  expect(summary.reason).toBe("criteria-passed");
});
