import type {
  GameAcceptanceCriterion,
  GameObservedValue,
  GameScenarioCriterionResult,
  GameScenarioEvidence,
  GameScenarioKindCoverage,
  GameScenarioStageReason,
  GameScenarioSummary,
} from "@t3tools/contracts";
import { NO_LOSE_STATE_TEXT } from "@t3tools/contracts";

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

const numeric = (value: GameObservedValue | null): number | null => {
  if (typeof value === "boolean") return value ? 1 : 0;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/** Whether a single sampled value already satisfies the expectation. */
const satisfiedBy = (
  expectation: ScenarioExpectation,
  value: GameObservedValue | null,
): boolean => {
  // "changes" needs two samples, so one value can never satisfy it.
  if (expectation.kind === "changes") return false;
  const number = numeric(value);
  if (number === null) return false;
  if (expectation.kind === "equals") return Math.abs(number - expectation.value) < 1e-9;
  if (expectation.kind === "atLeast") return number >= expectation.value;
  return number <= expectation.value;
};

const observationFor = (run: GameScenarioEvidence, key: string) =>
  run.observations.find((observation) => observation.key === key);

const valueText = (value: GameObservedValue | null): string => {
  if (value === null) return "missing";
  if (typeof value === "string") return JSON.stringify(value.slice(0, 40));
  return String(value);
};

interface ProvingMatch {
  readonly run: GameScenarioEvidence;
  readonly frame: number;
}

/**
 * One sampled observation can prove the criterion in several routes. The first
 * route whose baseline was false and whose later sample matched wins; a route
 * that already had the value at its baseline cannot prove anything.
 */
const provingMatch = (
  runs: readonly GameScenarioEvidence[],
  criterionId: string,
  key: string,
  expectation: ScenarioExpectation,
  requireFinal: boolean,
): { readonly match: ProvingMatch | null; readonly alreadyTrue: ProvingMatch | null } => {
  let alreadyTrue: ProvingMatch | null = null;
  for (const run of runs) {
    if (run.error !== null) continue;
    const observation = observationFor(run, key);
    if (observation === undefined || typeof run.baselineFrame !== "number") continue;
    const baseline = observation.baseline ?? null;
    if (satisfiedBy(expectation, baseline)) {
      alreadyTrue ??= { run, frame: run.baselineFrame };
      continue;
    }
    const recorded = observation.matches.find((match) => match.id === criterionId);
    if (recorded === undefined) continue;
    if (recorded.frame <= run.baselineFrame) continue;
    // A win or lose claim must describe the state the run ended in. A value
    // that flashed once and then returned to play is not a finished run.
    if (requireFinal && !satisfiedBy(expectation, observation.last ?? null)) continue;
    return { match: { run, frame: recorded.frame }, alreadyTrue };
  }
  return { match: null, alreadyTrue };
};

const coverageOf = (
  criteria: readonly GameScenarioCriterionResult[],
  kinds: readonly string[],
): readonly GameScenarioKindCoverage[] =>
  kinds.map((kind) => {
    const ofKind = criteria.filter((criterion) => criterion.kind === kind);
    return {
      kind,
      proven: ofKind.filter((criterion) => criterion.status === "passed").length,
      failed: ofKind.filter((criterion) => criterion.status === "failed").length,
      missing: ofKind.filter(
        (criterion) => criterion.status === "missing" || criterion.status === "unverified",
      ).length,
    };
  });

/** Mechanical kinds the state stage grades; presentation belongs to visual. */
const MECHANICAL_KINDS = ["control", "mechanic", "content", "win", "lose"] as const;

/** The declared "no lose state" promise is the one mechanical exception. */
export const isNoLoseStateCriterion = (criterion: GameAcceptanceCriterion): boolean =>
  criterion.kind === "lose" &&
  criterion.observe === undefined &&
  criterion.text.trim() === NO_LOSE_STATE_TEXT;

const criterionResult = (
  runs: readonly GameScenarioEvidence[],
  criterion: GameAcceptanceCriterion,
): GameScenarioCriterionResult => {
  const base = { id: criterion.id, kind: criterion.kind, text: criterion.text };
  if (criterion.kind === "presentation")
    return {
      ...base,
      status: "missing",
      observed: "Presentation is graded by the visual stage, which is not implemented yet.",
      scenarios: [],
      provenBy: null,
    };
  if (criterion.observe === undefined) {
    if (isNoLoseStateCriterion(criterion))
      return {
        ...base,
        status: "missing",
        observed: `The design declares "${NO_LOSE_STATE_TEXT}"; there is no lose transition to prove.`,
        scenarios: [],
        provenBy: null,
      };
    return {
      ...base,
      status: "missing",
      observed: `This ${criterion.kind} claim has no observe; mechanical claims must name a GameState property the player changes.`,
      scenarios: [],
      provenBy: null,
    };
  }
  const expectation = parseScenarioExpectation(criterion.observe.expect);
  if (expectation === null)
    return {
      ...base,
      status: "failed",
      observed: `Unreadable expectation ${criterion.observe.expect}.`,
      scenarios: [],
      provenBy: null,
    };
  const terminal = criterion.kind === "win" || criterion.kind === "lose";
  if (terminal && expectation.kind === "changes")
    return {
      ...base,
      status: "failed",
      observed: `A ${criterion.kind} claim must observe the value the run ends at, not a change; starting or pausing the game also changes state.`,
      scenarios: [],
      provenBy: null,
    };
  const key = criterion.observe.key;
  const sampled = runs.filter(
    (run) => run.error === null && observationFor(run, key) !== undefined,
  );
  if (sampled.length === 0)
    return {
      ...base,
      status: "missing",
      observed: `GameState has no "${key}" property to observe.`,
      scenarios: [],
      provenBy: null,
    };
  const { match, alreadyTrue } = provingMatch(runs, criterion.id, key, expectation, terminal);
  if (match !== null) {
    const observation = observationFor(match.run, key)!;
    return {
      ...base,
      status: "passed",
      observed: `${match.run.id}: ${key} ${valueText(observation.baseline ?? null)} → ${valueText(observation.last)} at frame ${match.frame}.`,
      scenarios: [match.run.id],
      provenBy: { scenario: match.run.id, frame: match.frame },
      // The samples stay typed so a stricter benchmark promise can be checked
      // later without parsing `observed`.
      measurement: {
        scenario: match.run.id,
        key,
        baseline: observation.baseline ?? null,
        last: observation.last,
      },
    };
  }
  if (alreadyTrue !== null) {
    const observation = observationFor(alreadyTrue.run, key)!;
    return {
      ...base,
      status: "failed",
      observed: `Failed: already true when play started — observe something the player achieves (${key} was ${valueText(observation.baseline ?? null)} at frame ${alreadyTrue.frame} of ${alreadyTrue.run.id}).`,
      scenarios: [],
      provenBy: null,
    };
  }
  const withoutBaseline = sampled.filter((run) => typeof run.baselineFrame !== "number");
  if (withoutBaseline.length === sampled.length)
    return {
      ...base,
      status: "failed",
      observed: `${sampled.map((run) => run.id).join(", ")} pressed no controls, so play never started; a waiting route proves nothing.`,
      scenarios: [],
      provenBy: null,
    };
  const first = sampled.find((run) => typeof run.baselineFrame === "number")!;
  const observation = observationFor(first, key)!;
  return {
    ...base,
    status: "failed",
    observed: `${first.id}: ${key} stayed at ${valueText(observation.last)} (${valueText(observation.min)}..${valueText(observation.max)}); it never became ${expectationText(expectation)} after play started.`,
    scenarios: [],
    provenBy: null,
  };
};

const expectationText = (expectation: ScenarioExpectation): string => {
  if (expectation.kind === "changes") return "a different value";
  const operator =
    expectation.kind === "equals" ? "==" : expectation.kind === "atLeast" ? ">=" : "<=";
  return `${operator}${expectation.value}`;
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
 * a route that only waits, a pick-up behind a wall, a boot constant and an
 * unreachable finish all fail because nothing changed after play started.
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
      coverage: [],
    };
  if (input.mode === "legacy") {
    const moved = runs.some((run) => run.error === null && run.playerMoved);
    const playing = runs.some((run) => {
      if (run.error !== null || typeof run.baselineFrame !== "number") return false;
      const state = observationFor(run, "state");
      if (state === undefined) return false;
      // The baseline is the first sample after the menu input. Reaching the
      // playing state by then is exactly what the menu is supposed to do.
      return numeric(state.baseline ?? null) === 1;
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
    return { mode: "legacy", passed, reason, detail, criteria: [], coverage: [] };
  }

  const graded = input.criteria.filter((criterion) => criterion.kind !== "presentation");
  const criteria = graded.map((criterion) => criterionResult(runs, criterion));
  const blocking = criteria.filter((criterion) => {
    const approved = input.criteria.find((entry) => entry.id === criterion.id);
    return approved === undefined || !isNoLoseStateCriterion(approved);
  });
  const everyPassed = blocking.every((criterion) => criterion.status === "passed");
  const winPassed = criteria.some(
    (criterion) => criterion.kind === "win" && criterion.status === "passed",
  );
  const moved = runs.some((run) => run.error === null && run.playerMoved);
  const passed = failedRun === undefined && everyPassed && winPassed && moved;
  let reason: GameScenarioStageReason = "criteria-passed";
  let detail =
    "Every graded criterion changed after play started, including a win, and a scenario moved the player.";
  if (failedRun !== undefined) {
    reason = "scenario-failed";
    detail = `Scenario "${failedRun.id}" failed: ${failedRun.error}`;
  } else if (!everyPassed) {
    const failed = blocking.filter((criterion) => criterion.status !== "passed");
    reason = "observable-failed";
    detail = `${failed.length} acceptance criterion/criteria did not pass: ${failed
      .map((criterion) => `${criterion.id} (${criterion.status})`)
      .join(", ")}.`;
  } else if (!winPassed) {
    reason = "win-criterion-failed";
    detail =
      "No `win` criterion with an observe passed; reaching the win state after play starts is required.";
  } else if (!moved) {
    reason = "no-player-movement";
    detail = "No scenario moved the player; a still frame is not gameplay.";
  }
  return {
    mode: "criteria",
    passed,
    reason,
    detail,
    criteria,
    coverage: coverageOf(
      criteria,
      MECHANICAL_KINDS.filter((kind) => criteria.some((criterion) => criterion.kind === kind)),
    ),
  };
}
