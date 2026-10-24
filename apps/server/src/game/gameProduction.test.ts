// @effect-diagnostics globalDate:off -- Fixed timestamps keep the time box deterministic.
import { describe, expect, it } from "vite-plus/test";
import { RunId, type GameProduction } from "@t3tools/contracts";

import { EMPTY_GAME_PRODUCTION, productionBudgetText, productionStatus } from "./gameProduction.ts";

const run = RunId.make("run:builder");
const BUDGET = 45 * 60_000;
const AT = Date.parse("2026-10-24T10:00:00.000Z");

const production = (overrides: Partial<GameProduction> = {}): GameProduction => ({
  firstPlayableAt: "2026-10-24T09:58:00.000Z",
  firstPlayableBuildId: "a".repeat(64),
  runId: run,
  turnFirstSubmitAt: "2026-10-24T09:58:00.000Z",
  turnLastSubmitAt: "2026-10-24T09:58:00.000Z",
  submissions: 1,
  ...overrides,
});

describe("production status", () => {
  it("reports an untouched budget before anything was submitted", () => {
    const status = productionStatus({
      production: null,
      budgetMs: BUDGET,
      activeRun: run,
      nowMs: AT,
    });
    expect(status).toMatchObject({
      ...EMPTY_GAME_PRODUCTION,
      budgetMs: BUDGET,
      elapsedMs: 0,
      remainingMs: BUDGET,
    });
  });

  it("counts the live turn from its first submit", () => {
    const status = productionStatus({
      production: production(),
      budgetMs: BUDGET,
      activeRun: run,
      nowMs: AT,
    });
    expect(status.elapsedMs).toBe(2 * 60_000);
    expect(status.remainingMs).toBe(BUDGET - 2 * 60_000);
    expect(status.firstPlayableAt).toBe("2026-10-24T09:58:00.000Z");
  });

  it("stops at the last submit once the turn is over", () => {
    const status = productionStatus({
      production: production({ turnLastSubmitAt: "2026-10-24T10:05:00.000Z", submissions: 3 }),
      budgetMs: BUDGET,
      activeRun: null,
      nowMs: AT + 60 * 60_000,
    });
    expect(status.elapsedMs).toBe(7 * 60_000);
    expect(status.remainingMs).toBe(BUDGET - 7 * 60_000);
    expect(status.submissions).toBe(3);
  });

  it("starts a different builder turn at zero while keeping the game's first playable", () => {
    const next = RunId.make("run:builder-2");
    const status = productionStatus({
      production: production(),
      budgetMs: BUDGET,
      activeRun: next,
      nowMs: AT,
    });
    expect(status).toMatchObject({
      firstPlayableAt: "2026-10-24T09:58:00.000Z",
      firstPlayableBuildId: "a".repeat(64),
      runId: null,
      turnFirstSubmitAt: null,
      turnLastSubmitAt: null,
      submissions: 0,
      elapsedMs: 0,
      remainingMs: BUDGET,
    });
  });

  it("never reports negative time when the budget is spent", () => {
    const status = productionStatus({
      production: production(),
      budgetMs: BUDGET,
      activeRun: run,
      nowMs: AT + 2 * BUDGET,
    });
    expect(status.remainingMs).toBe(0);
    expect(status.elapsedMs).toBeGreaterThan(BUDGET);
  });
});

describe("production budget text", () => {
  it("names the minutes left out of the game's own budget", () => {
    expect(productionBudgetText(BUDGET, 20 * 60_000)).toBe("20 of 45 minutes left");
    expect(productionBudgetText(60 * 60_000, 0)).toBe("0 of 60 minutes left");
  });
});
