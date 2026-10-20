import type {
  GameAcceptanceCriterion,
  GameScenarioCriterionResult,
  GameScenarioEvidence,
  GameScenarioObservation,
  GameScenarioStageReason,
  GameScenarioSummary,
} from "@t3tools/contracts";

/** Legacy games prove the game started by observing this synthetic promise. */
export const LEGACY_PLAYING_MATCH_ID = "legacy-playing";

type ScenarioExpectation =
  | { readonly kind: "changes" }
  | { readonly kind: "equals"; readonly value: number }
  | { readonly kind: "atLeast"; readonly value: number }
  | { readonly kind: "atMost"; readonly value: number };

/** Reads the approved `==V`, `>=N`, `<=N`, `changes` vocabulary. */
export function parseScenarioExpectation(text: string): ScenarioExpectation | null {
  if (text === "changes") return { kind: "changes" };
  const match = text.match(/^(==|>=|<=)(-?\d+(?:\.\d+)?)$/);
  if (match === null) return null;
  const value = Number(match[2]);
  if (!Number.isFinite(value)) return null;
  if (match[1] === "==") return { kind: "equals", value };
  if (match[1] === ">=") return { kind: "atLeast", value };
  return { kind: "atMost", value };
}

const numeric = (value: GameScenarioObservation["first"]): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const matchesCriterion = (
  observation: GameScenarioObservation | undefined,
  criterionId: string,
  expectation: ScenarioExpectation,
): { readonly matched: boolean; readonly frame: number | null } => {
  if (observation === undefined) return { matched: false, frame: null };
  const recorded = observation.matches.find((match) => match.id === criterionId);
  if (recorded !== undefined) return { matched: true, frame: recorded.frame };
  // Older results (and hand-written fixtures) may not carry matches. Fall back to
  // the statistics: min/max are exact for the numeric bounds, while equality has
  // no safe fallback and stays unmatched.
  if (expectation.kind === "changes")
    return { matched: observation.firstChangeFrame !== null, frame: null };
  const min = numeric(observation.min);
  const max = numeric(observation.max);
  if (min === null || max === null) return { matched: false, frame: null };
  if (expectation.kind === "atLeast") return { matched: max >= expectation.value, frame: null };
  if (expectation.kind === "atMost") return { matched: min <= expectation.value, frame: null };
  return { matched: false, frame: null };
};

const observedLine = (
  runs: readonly GameScenarioEvidence[],
  criterionId: string,
  observationFor: (run: GameScenarioEvidence) => GameScenarioObservation | undefined,
): string => {
  if (runs.length === 0) return "No scenario ran.";
  const parts = runs.map((run) => {
    if (run.error !== null) return `${run.id}: ${run.error}`;
    const observation = observationFor(run);
    if (observation === undefined) return `${run.id}: not sampled`;
    const min = observation.min === null ? "?" : String(observation.min);
    const max = observation.max === null ? "?" : String(observation.max);
    return `${run.id}: ${min}..${max} (first ${String(observation.first)}, last ${String(observation.last)})`;
  });
  const text = parts.join("; ");
  return text.length <= 240 ? text : `${text.slice(0, 237)}...`;
};

const observationFor = (run: GameScenarioEvidence, key: string) =>
  run.observations.find((observation) => observation.key === key);

const criterionResult = (
  runs: readonly GameScenarioEvidence[],
  criterion: GameAcceptanceCriterion,
): GameScenarioCriterionResult => {
  const base = { id: criterion.id, kind: criterion.kind, text: criterion.text };
  if (criterion.observe === undefined)
    return {
      ...base,
      status: "unverified",
      observed: "This criterion has no observe key; the visual judge owns it.",
      scenarios: [],
    };
  const expectation = parseScenarioExpectation(criterion.observe.expect);
  if (expectation === null)
    return {
      ...base,
      status: "failed",
      observed: `Unreadable expectation ${criterion.observe.expect}.`,
      scenarios: [],
    };
  const sampled = runs.some(
    (run) => run.error === null && observationFor(run, criterion.observe!.key) !== undefined,
  );
  if (!sampled)
    return {
      ...base,
      status: "missing",
      observed: `GameState has no "${criterion.observe.key}" property to observe.`,
      scenarios: [],
    };
  const scenarios: string[] = [];
  for (const run of runs) {
    if (run.error !== null) continue;
    const match = matchesCriterion(
      observationFor(run, criterion.observe.key),
      criterion.id,
      expectation,
    );
    if (match.matched) scenarios.push(run.id);
  }
  return {
    ...base,
    status: scenarios.length > 0 ? "passed" : "failed",
    observed: observedLine(runs, criterion.id, (run) =>
      observationFor(run, criterion.observe!.key),
    ),
    scenarios,
  };
};

export interface ScenarioEvaluationInput {
  /**
   * `criteria` uses the approved acceptance; `legacy` is a game created without
   * a design; `none` means the design is still a draft, so there is nothing the
   * agent may be graded against yet.
   */
  readonly mode: "criteria" | "legacy" | "none";
  readonly criteria: readonly GameAcceptanceCriterion[];
  readonly runs: readonly GameScenarioEvidence[];
}

/**
 * The server's state-stage verdict. Pure so the unit tests can pin every rule:
 * a route that only animates, a pickup behind a wall and an unreachable finish
 * all fail because the approved observation never becomes true.
 */
export function evaluateScenarios(input: ScenarioEvaluationInput): GameScenarioSummary {
  const runs = input.runs;
  const failedRun = runs.find((run) => run.error !== null);
  if (input.mode === "none")
    return {
      mode: "none",
      passed: false,
      reason: "no-acceptance",
      detail:
        "The design has not been approved, so scenarios cannot be graded against its acceptance.",
      criteria: [],
    };
  if (input.mode === "legacy") {
    const moved = runs.some((run) => run.error === null && run.playerMoved);
    const playing = runs.some((run) => {
      if (run.error !== null) return false;
      const state = observationFor(run, "state");
      if (state === undefined) return false;
      return state.matches.some(
        (match) => match.id === LEGACY_PLAYING_MATCH_ID || match.id === "legacy-playing",
      );
    });
    const passed = moved && playing && runs.length > 0 && failedRun === undefined;
    let reason: GameScenarioStageReason = "legacy-passed";
    let detail = "A scenario moved the player and GameState reached the playing state.";
    if (runs.length === 0) {
      reason = "legacy-unproven";
      detail = "This game has no acceptance criteria and no scenario ran.";
    } else if (failedRun !== undefined) {
      reason = "scenario-failed";
      detail = `Scenario "${failedRun.id}" failed: ${failedRun.error}`;
    } else if (!moved) {
      reason = "no-player-movement";
      detail = "No scenario moved the player; a still frame is not gameplay.";
    } else if (!playing) {
      reason = "legacy-unproven";
      detail = "No scenario reached GameState's playing state through the game's own menu.";
    }
    return { mode: "legacy", passed, reason, detail, criteria: [] };
  }

  const criteria = input.criteria.map((criterion) => criterionResult(runs, criterion));
  const observable = criteria.filter((criterion) => {
    const approved = input.criteria.find((entry) => entry.id === criterion.id);
    return approved?.observe !== undefined;
  });
  const observablePassed = observable.every((criterion) => criterion.status === "passed");
  const endPassed = criteria.some((criterion) => {
    const approved = input.criteria.find((entry) => entry.id === criterion.id);
    return (
      approved?.kind === "end" && approved.observe !== undefined && criterion.status === "passed"
    );
  });
  const moved = runs.some((run) => run.error === null && run.playerMoved);
  const passed = failedRun === undefined && observablePassed && endPassed && moved;
  let reason: GameScenarioStageReason = "criteria-passed";
  let detail =
    "Every observable criterion passed, including an end criterion, and a scenario moved the player.";
  if (failedRun !== undefined) {
    reason = "scenario-failed";
    detail = `Scenario "${failedRun.id}" failed: ${failedRun.error}`;
  } else if (!observablePassed) {
    const failed = observable.filter((criterion) => criterion.status !== "passed");
    reason = "observable-failed";
    detail = `${failed.length} observable criterion/criteria did not pass: ${failed
      .map((criterion) => criterion.id)
      .join(", ")}.`;
  } else if (!endPassed) {
    reason = "end-criterion-failed";
    detail = "No end criterion with an observe passed; reaching the win state is required.";
  } else if (!moved) {
    reason = "no-player-movement";
    detail = "No scenario moved the player; a still frame is not gameplay.";
  }
  return { mode: "criteria", passed, reason, detail, criteria };
}
