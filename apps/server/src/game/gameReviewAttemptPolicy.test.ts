import { describe, expect, it } from "vite-plus/test";

import { classifyReviewAttempt, planReviewPhase } from "./gameReviewAttemptPolicy.ts";

const BUDGET = 45 * 60_000;

describe("classify a review child's end", () => {
  it("does not turn a failed critic with no answer into a game verdict", () => {
    expect(
      classifyReviewAttempt("critic", {
        kind: "terminal",
        status: "failed",
        answer: "missing",
      }),
    ).toMatchObject({ kind: "infrastructure" });
  });

  it("judges a critic whose provider ended failed after recording a usable answer", () => {
    expect(
      classifyReviewAttempt("critic", {
        kind: "terminal",
        status: "failed",
        answer: "usable",
      }),
    ).toEqual({ kind: "judged" });
  });

  it("does not turn a failed ballot with no answer into an invalid vote", () => {
    expect(
      classifyReviewAttempt("ballot", {
        kind: "terminal",
        status: "rolled_back",
        answer: "unusable",
        detail: "the child ended without a bound run.",
      }),
    ).toEqual({
      kind: "infrastructure",
      reason:
        "the ballot ended rolled_back without a usable answer: the child ended without a bound run.",
    });
  });

  it("judges a failed ballot that still recorded a usable answer", () => {
    expect(
      classifyReviewAttempt("ballot", {
        kind: "terminal",
        status: "failed",
        answer: "usable",
      }),
    ).toEqual({ kind: "judged" });
  });

  it("keeps a completed but unusable answer distinct from a provider outage", () => {
    const verdict = classifyReviewAttempt("ballot", {
      kind: "terminal",
      status: "completed",
      answer: "unusable",
      detail: "the answer was cut off.",
    });
    expect(verdict).toEqual({
      kind: "malformed",
      reason: "the ballot completed with an unusable answer: the answer was cut off.",
    });
    expect(verdict.kind).not.toBe("infrastructure");
  });

  it("refunds only a failed repair that produced no candidate", () => {
    expect(
      classifyReviewAttempt("repair", {
        kind: "terminal",
        status: "failed",
        hasCandidate: false,
      }),
    ).toMatchObject({ kind: "infrastructure" });
    expect(
      classifyReviewAttempt("repair", {
        kind: "terminal",
        status: "failed",
        hasCandidate: true,
      }),
    ).toEqual({ kind: "judged" });
  });

  it("keeps a completed repair with no candidate as a real empty attempt", () => {
    expect(
      classifyReviewAttempt("repair", {
        kind: "terminal",
        status: "completed",
        hasCandidate: false,
      }),
    ).toMatchObject({ kind: "no-output" });
  });

  it.each(["cancelled"] as const)("treats a %s child as owned work, not an outage", (status) => {
    expect(classifyReviewAttempt("critic", { kind: "terminal", status })).toMatchObject({
      kind: "cancelled",
    });
  });

  it("treats an interrupted child with no usable answer as owned work, not an outage", () => {
    for (const signal of [
      { kind: "terminal", status: "interrupted" },
      { kind: "terminal", status: "interrupted", answer: "missing" },
      { kind: "terminal", status: "interrupted", answer: "unusable" },
    ] as const)
      expect(classifyReviewAttempt("critic", signal)).toMatchObject({ kind: "cancelled" });
  });

  it("reports an exhausted critic as its own invalid output with the last validation error", () => {
    const lastError =
      "Requirement park-in-bay challenge cannot reuse the positive experiment; cite a separate ordinary-play counterexample experiment.";
    const verdict = classifyReviewAttempt("critic", {
      kind: "terminal",
      status: "interrupted",
      answer: "unusable",
      detail: lastError,
      exhausted: true,
    });
    expect(verdict.kind).toBe("malformed");
    if (verdict.kind === "malformed") expect(verdict.reason).toContain(lastError);
  });

  it("reports an exhausted ballot as invalid, while a user stop stays cancelled", () => {
    const exhausted = classifyReviewAttempt("ballot", {
      kind: "terminal",
      status: "interrupted",
      answer: "unusable",
      detail: "the ballot answer was cut off.",
      exhausted: true,
    });
    expect(exhausted.kind).toBe("malformed");
    expect(
      classifyReviewAttempt("critic", { kind: "terminal", status: "interrupted" }),
    ).toMatchObject({ kind: "cancelled" });
    expect(
      classifyReviewAttempt("critic", { kind: "terminal", status: "failed", answer: "missing" }),
    ).toMatchObject({ kind: "infrastructure" });
  });

  it("judges a host-interrupted critic that already recorded its valid answer", () => {
    // report() intentionally interrupts the run after recording a valid tool
    // answer ("The review answer was recorded."). The persisted answer is
    // bound to the run and evidence hash; the text fallback requires
    // completed. A real user stop interrupts the loop fiber before judgment.
    expect(
      classifyReviewAttempt("critic", {
        kind: "terminal",
        status: "interrupted",
        answer: "usable",
      }),
    ).toEqual({ kind: "judged" });
  });

  it.each([0, 1] as const)("judges a host-interrupted ballot %s with its valid answer", () => {
    expect(
      classifyReviewAttempt("ballot", {
        kind: "terminal",
        status: "interrupted",
        answer: "usable",
      }),
    ).toEqual({ kind: "judged" });
  });

  it("keeps an interrupted ballot without a usable answer owned work, and repair fail-closed", () => {
    expect(
      classifyReviewAttempt("ballot", {
        kind: "terminal",
        status: "interrupted",
        answer: "missing",
      }),
    ).toMatchObject({ kind: "cancelled" });
    expect(
      classifyReviewAttempt("ballot", {
        kind: "terminal",
        status: "interrupted",
        answer: "unusable",
      }),
    ).toMatchObject({ kind: "cancelled" });
    expect(
      classifyReviewAttempt("repair", {
        kind: "terminal",
        status: "interrupted",
        hasCandidate: true,
      }),
    ).toMatchObject({ kind: "cancelled" });
  });

  it("treats a session that never started and a phase expiry as infrastructure and expiry", () => {
    expect(
      classifyReviewAttempt("critic", { kind: "unstarted", detail: "model unavailable" }),
    ).toMatchObject({ kind: "infrastructure" });
    expect(classifyReviewAttempt("repair", { kind: "expired" })).toMatchObject({
      kind: "expired",
    });
  });

  it("judges usable evidence a joined phase cap left on disk", () => {
    expect(
      classifyReviewAttempt("critic", {
        kind: "expired",
        settled: true,
        evidence: "usable",
      }),
    ).toEqual({ kind: "judged" });
    expect(
      classifyReviewAttempt("ballot", {
        kind: "expired",
        settled: true,
        evidence: "usable",
      }),
    ).toEqual({ kind: "judged" });
    expect(
      classifyReviewAttempt("repair", {
        kind: "expired",
        settled: true,
        evidence: "usable",
      }),
    ).toEqual({ kind: "judged" });
  });

  it("keeps an unsettled or evidence-less phase cap an expiry, never a judgment", () => {
    for (const signal of [
      { kind: "expired", settled: false, evidence: "usable" },
      { kind: "expired", settled: true, evidence: "missing" },
      { kind: "expired", settled: true, evidence: "unusable" },
      { kind: "expired" },
    ] as const)
      expect(classifyReviewAttempt("critic", signal)).toMatchObject({ kind: "expired" });
  });
});

describe("phase allowances", () => {
  const plan = (phase: Parameters<typeof planReviewPhase>[0]["phase"], remainingMs: number) =>
    planReviewPhase({ phase, remainingMs, totalBudgetMs: BUDGET });

  it("never gives a child the whole remaining loop budget", () => {
    expect(plan("critic", BUDGET).allowanceMs).toBe(Math.round(BUDGET * 0.2));
    expect(plan("repair", BUDGET).allowanceMs).toBe(Math.round(BUDGET * 0.32));
    expect(plan("incumbent-check", 60_000).allowanceMs).toBeLessThan(60_000);
  });

  it("does not start a repair that cannot leave the candidate check and the pair", () => {
    // Seven minutes left cannot hold a repair plus the decision tail.
    expect(plan("repair", 7 * 60_000).admitted).toBe(false);
    // Thirty minutes can: 14.4min repair plus the 10.8min check/pair/decision tail.
    expect(plan("repair", 30 * 60_000).admitted).toBe(true);
  });

  it("budgets the pair as one wallclock window plus the decision", () => {
    const pair = planReviewPhase({
      phase: "ballot",
      remainingMs: 12 * 60_000,
      totalBudgetMs: BUDGET,
    });
    expect(pair.admitted).toBe(true);
    // Each concurrent vote may use the full pair window: no raised total.
    expect(pair.allowanceMs).toBe(Math.round(BUDGET * 0.2));
    // Ten minutes cannot hold the 9min pair plus the 1.8min decision tail.
    expect(
      planReviewPhase({ phase: "ballot", remainingMs: 10 * 60_000, totalBudgetMs: BUDGET })
        .admitted,
    ).toBe(false);
    expect(
      planReviewPhase({
        phase: "ballot",
        ballotIndex: 1,
        remainingMs: 6 * 60_000,
        totalBudgetMs: BUDGET,
      }).admitted,
    ).toBe(false);
  });

  it("bounds the candidate check and leaves optional experiments skippable", () => {
    expect(plan("candidate-check", 15 * 60_000).allowanceMs).toBe(Math.round(BUDGET * 0.07));
    expect(plan("candidate-check", 6 * 60_000).admitted).toBe(false);
    expect(plan("experiments", 12 * 60_000).admitted).toBe(false);
  });

  it("scales to a tiny test budget instead of requiring a minutes-long floor", () => {
    const tiny = (phase: "critic" | "repair") =>
      planReviewPhase({ phase, remainingMs: 150, totalBudgetMs: 150 });
    expect(tiny("critic").admitted).toBe(true);
    expect(tiny("repair").admitted).toBe(true);
  });
});
