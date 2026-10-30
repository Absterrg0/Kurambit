// @effect-diagnostics nodeBuiltinImport:off -- Proves calibration comparison semantics without engines.
import { expect, it } from "@effect/vitest";
import { RUNTIME_CALIBRATE_BOUNDS } from "@t3tools/contracts";
import {
  compareCalibratePair,
  playerDisplacementOf,
  verdictOfPairs,
  type CalibrateRunSample,
} from "./gameRuntimeCalibrate.ts";

const base: CalibrateRunSample = {
  cadence: 30,
  repeat: 0,
  scenarioFrames: 100,
  enginePhysicsFrames: 100,
  renderFrames: 50,
  nominalPhysicsSeconds: 100 / 60,
  firstInputFrame: 30,
  baselineFrame: 32,
  playerMoved: true,
  playerFirst: [0, 0],
  playerBaseline: [0, 0],
  playerLast: [3, 4],
  playerDisplacement: 5,
  userDataDirIsolated: true,
  gameState: { collected: 6, won: true },
  error: null,
  timedOut: false,
};

it("measures baseline-to-last displacement in engine units", () => {
  expect(playerDisplacementOf([0, 0], [3, 4])).toBeCloseTo(5, 9);
  expect(playerDisplacementOf([1, 2, 2], [1, 2, 5])).toBeCloseTo(3, 9);
  expect(playerDisplacementOf(null, [3, 4])).toBeNull();
  expect(playerDisplacementOf([0, 0], null)).toBeNull();
  expect(playerDisplacementOf([0, 0], [0, 0, 0])).toBeNull();
});

it("treats identical repeats as equivalent", () => {
  const pair = compareCalibratePair(base, { ...base, repeat: 1 }, "same-rate");
  expect(pair.equivalent).toBe(true);
  expect(pair.unknown).toBe(false);
  expect(pair.differences).toEqual([]);
  expect(pair.comparedFields).toBeGreaterThan(5);
});

it("compares counters and booleans exactly", () => {
  const other = {
    ...base,
    repeat: 1,
    gameState: { collected: 5, won: true },
  };
  const pair = compareCalibratePair(base, other, "same-rate");
  expect(pair.equivalent).toBe(false);
  expect(pair.unknown).toBe(false);
  expect(pair.differences.join("\n")).toContain("GameState.collected");
});

it("tolerates small physical drift but not large jumps", () => {
  const drifted = {
    ...base,
    repeat: 1,
    playerLast: [3 + RUNTIME_CALIBRATE_BOUNDS.positionToleranceUnits / 2, 4],
    playerDisplacement: 5 + RUNTIME_CALIBRATE_BOUNDS.positionToleranceUnits / 2,
  };
  expect(compareCalibratePair(base, drifted, "same-rate").equivalent).toBe(true);
  const jumped = {
    ...base,
    repeat: 1,
    playerLast: [10, 4],
    playerDisplacement: 10,
  };
  const pair = compareCalibratePair(base, jumped, "same-rate");
  expect(pair.equivalent).toBe(false);
  expect(pair.unknown).toBe(false);
  expect(pair.differences.join("\n")).toContain("playerLast");
});

it("marks missing probes, errors and timeouts unknown, never equivalent", () => {
  const missing = { ...base, repeat: 1, playerLast: null, playerDisplacement: null };
  const unknown = compareCalibratePair(base, missing, "same-rate");
  expect(unknown.equivalent).toBe(false);
  expect(unknown.unknown).toBe(true);
  const failed = { ...base, repeat: 1, error: "boom" };
  expect(compareCalibratePair(base, failed, "same-rate").unknown).toBe(true);
  const timedOut = { ...base, repeat: 1, timedOut: true };
  expect(compareCalibratePair(base, timedOut, "same-rate").unknown).toBe(true);
  const unisolated = { ...base, repeat: 1, userDataDirIsolated: false };
  expect(compareCalibratePair(base, unisolated, "same-rate").unknown).toBe(true);
});

it("gates cross-rate pairs on same-rate stability", () => {
  const same = compareCalibratePair(base, { ...base, repeat: 1 }, "same-rate");
  const cross = compareCalibratePair(
    base,
    { ...base, cadence: 60, repeat: 0, scenarioFrames: 100 },
    "cross-rate",
  );
  expect(verdictOfPairs([same, cross])).toBe("equivalent");
  const diverged = compareCalibratePair(
    base,
    { ...base, cadence: 60, repeat: 0, gameState: { collected: 0, won: true } },
    "cross-rate",
  );
  expect(verdictOfPairs([same, diverged])).toBe("different");
  // A repeat variance at one cadence is itself a divergence.
  const unstable = compareCalibratePair(
    base,
    { ...base, repeat: 1, gameState: { collected: 0, won: true } },
    "same-rate",
  );
  expect(verdictOfPairs([unstable, cross])).toBe("different");
  const unknown = compareCalibratePair(
    base,
    { ...base, repeat: 1, playerLast: null, playerDisplacement: null },
    "same-rate",
  );
  expect(verdictOfPairs([unknown, cross])).toBe("unknown");
  expect(verdictOfPairs([])).toBe("unknown");
});

it("detects differing initial save state even when the final state and positions match", () => {
  const a = { ...base, initialGameState: { visits: 1 } };
  const b = { ...base, repeat: 1, initialGameState: { visits: 2 } };
  const compared = compareCalibratePair(a, b, "same-rate");
  expect(compared.equivalent).toBe(false);
  expect(compared.differences.some((value) => value.includes("initial GameState.visits"))).toBe(
    true,
  );
});
