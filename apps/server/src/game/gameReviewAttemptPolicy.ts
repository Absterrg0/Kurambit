/**
 * The two decisions the repair loop must make before it can treat a review
 * child as evidence:
 *
 * - did the child actually produce a judgment, or did the review infrastructure
 *   end before it could?
 * - how much of the frozen loop budget may this phase use before the phases
 *   that decide a candidate still fit?
 *
 * Both are pure so the loop has one seam to test instead of three branches.
 */

export type ReviewAttemptRole = "critic" | "ballot" | "repair";

type ReviewChildStatus = "completed" | "failed" | "cancelled" | "interrupted" | "rolled_back";

export type ReviewAnswerReadiness = "usable" | "unusable" | "missing";

export type ReviewAttemptSignal =
  /**
   * The phase allowance ended while the child was still running. The join may
   * already have stopped the writer, and evidence may already be on disk.
   */
  | {
      readonly kind: "expired";
      /** The interrupt and join confirmed the child's writer stopped. */
      readonly settled?: boolean | undefined;
      /**
       * What the child left before the cut: a usable recorded answer, or for a
       * repair a candidate exported from the exact source it left behind.
       */
      readonly evidence?: ReviewAnswerReadiness | undefined;
    }
  /** The session could not start, or its record vanished before the wait. */
  | { readonly kind: "unstarted"; readonly detail: string }
  | {
      readonly kind: "terminal";
      readonly status: ReviewChildStatus;
      /** Critic and ballot only. A repair reports through the folder. */
      readonly answer?: ReviewAnswerReadiness | undefined;
      /** Repair only: a candidate the child exported before it ended. */
      readonly hasCandidate?: boolean | undefined;
      readonly detail?: string | undefined;
      /**
       * True when the child used all three tool attempts without recording a
       * valid answer. The host then interrupts the run, so the status reads
       * interrupted even though no user stopped it.
       */
      readonly exhausted?: boolean | undefined;
    };

export type ReviewAttemptVerdict =
  | { readonly kind: "judged" }
  | { readonly kind: "infrastructure"; readonly reason: string }
  | { readonly kind: "malformed"; readonly reason: string }
  | { readonly kind: "cancelled"; readonly reason: string }
  | { readonly kind: "expired"; readonly reason: string }
  | { readonly kind: "no-output"; readonly reason: string };

const evidenceNoun = (role: ReviewAttemptRole) => (role === "repair" ? "candidate" : "answer");

const withDetail = (reason: string, detail: string | undefined) =>
  detail === undefined || detail.trim() === "" ? reason : `${reason}: ${detail.trim()}`;

/**
 * A provider that ends `failed` after recording a usable answer or exporting a
 * candidate still produced evidence, so it may be judged. Without that
 * evidence the end is infrastructure: never a game verdict, never a malformed
 * answer. A `completed` child with no usable answer is the review's own
 * malformed output, which is a different failure from the provider going away.
 *
 * A phase cap is different from a user stop: the loop interrupted and joined
 * the child itself, so a usable answer or source-matching candidate it wrote
 * before the cut is still judgment. An unsettled writer or absent evidence
 * stays an expiry, because the cut may have landed mid-write.
 */
export const classifyReviewAttempt = (
  role: ReviewAttemptRole,
  signal: ReviewAttemptSignal,
): ReviewAttemptVerdict => {
  if (signal.kind === "expired") {
    if (signal.settled === true && signal.evidence === "usable") return { kind: "judged" };
    return {
      kind: "expired",
      reason: `the ${role} used its phase allowance before it finished.`,
    };
  }
  if (signal.kind === "unstarted")
    return {
      kind: "infrastructure",
      reason: withDetail(`the ${role} could not start`, signal.detail),
    };

  const { status } = signal;
  if (status === "cancelled")
    return {
      kind: "cancelled",
      reason: `the ${role} ended cancelled before it was judged.`,
    };

  // A valid tool answer intentionally ends its own run with `run.interrupt`
  // ("The review answer was recorded."). That host-triggered interrupt is
  // judgment, not a user stop: the persisted tool answer is bound to the run
  // and evidence hash, and the fallback text path requires `completed`.
  // A real user stop interrupts the loop fiber before any judgment, so the
  // loop never reaches this read. Repair stays fail-closed: its evidence is
  // the folder, never an audited answer. An exhausted session also ends
  // interrupted after its third invalid tool attempt: that is the review's
  // own invalid output with the last validation error, never a cancellation.
  if (status === "interrupted") {
    const usable = role === "repair" ? signal.hasCandidate === true : signal.answer === "usable";
    if (usable && (role === "critic" || role === "ballot")) return { kind: "judged" };
    if (
      signal.exhausted === true &&
      (role === "critic" || role === "ballot") &&
      signal.answer !== "usable"
    )
      return {
        kind: "malformed",
        reason: withDetail(
          `the ${role} exhausted its answer attempts without a usable ${evidenceNoun(role)}`,
          signal.detail,
        ),
      };
    return {
      kind: "cancelled",
      reason: `the ${role} ended interrupted before it was judged.`,
    };
  }

  const usable = role === "repair" ? signal.hasCandidate === true : signal.answer === "usable";

  if (status === "failed" || status === "rolled_back") {
    if (usable) return { kind: "judged" };
    return {
      kind: "infrastructure",
      reason: withDetail(
        `the ${role} ended ${status} without a usable ${evidenceNoun(role)}`,
        signal.detail,
      ),
    };
  }

  if (role === "repair")
    return usable
      ? { kind: "judged" }
      : {
          kind: "no-output",
          reason: withDetail("the repair completed without exporting a candidate", signal.detail),
        };

  if (usable) return { kind: "judged" };
  return {
    kind: "malformed",
    reason: withDetail(
      `the ${role} completed with an unusable ${evidenceNoun(role)}`,
      signal.detail,
    ),
  };
};

/**
 * Caps share the frozen loop budget so early work leaves time to judge it.
 * They scale with that budget rather than introducing another configuration.
 * The ballot pair runs concurrently under one wallclock allowance: each vote
 * may use up to the full pair window, with no raised total and no extra
 * effort.
 */
const PHASE_CAP = {
  "incumbent-check": 0.07,
  critic: 0.2,
  repair: 0.32,
  "candidate-check": 0.07,
  experiments: 0.03,
  ballot: 0.2,
} as const;

/** The decision commit after the pair. */
const DECISION_RESERVE = 0.04;

export type ReviewPhase =
  | "incumbent-check"
  | "critic"
  | "repair"
  | "candidate-check"
  | "experiments"
  | "ballot";

interface ReviewPhasePlan {
  readonly admitted: boolean;
  /** A hard bound for this phase; the loop deadline still applies on top. */
  readonly allowanceMs: number;
}

const phaseReserve = (phase: ReviewPhase): number => {
  switch (phase) {
    // Critic and incumbent reserve the full repair/check/pair/decision tail;
    // optional experiments are skipped first when the tail does not fit.
    case "incumbent-check":
      return (
        PHASE_CAP.critic +
        PHASE_CAP.repair +
        PHASE_CAP["candidate-check"] +
        PHASE_CAP.ballot +
        DECISION_RESERVE
      );
    case "critic":
      return PHASE_CAP.repair + PHASE_CAP["candidate-check"] + PHASE_CAP.ballot + DECISION_RESERVE;
    case "repair":
      return PHASE_CAP["candidate-check"] + PHASE_CAP.ballot + DECISION_RESERVE;
    case "candidate-check":
    case "experiments":
      // One concurrent pair plus the decision, never two sequential votes.
      return PHASE_CAP.ballot + DECISION_RESERVE;
    case "ballot":
      return DECISION_RESERVE;
  }
};

/**
 * Sizes one phase of one round. `experiments` is optional: a caller that gets
 * `admitted: false` skips it and still runs the candidate check and ballots.
 * Admission requires the full bounded cap plus the required tail, so a phase
 * never starts when its successors could not fit.
 */
export const planReviewPhase = (input: {
  readonly phase: ReviewPhase;
  readonly remainingMs: number;
  readonly totalBudgetMs: number;
  /** Ignored: the pair is budgeted as one wallclock window. Kept for callers. */
  readonly ballotIndex?: 0 | 1 | undefined;
}): ReviewPhasePlan => {
  const total = Math.max(1, input.totalBudgetMs);
  const remaining = Math.max(0, input.remainingMs);
  const reserve = Math.round(total * phaseReserve(input.phase));
  const cap = Math.round(total * PHASE_CAP[input.phase]);
  const admitted = remaining >= cap + reserve;
  // The hard bound never exceeds what fits after the tail; when admitted it
  // is exactly the full cap. The loop deadline still applies on top.
  const allowance = Math.min(cap, Math.max(0, remaining - reserve));
  return {
    admitted,
    allowanceMs: Math.max(0, Math.floor(allowance)),
  };
};
