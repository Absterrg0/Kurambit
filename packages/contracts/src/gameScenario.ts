import * as Schema from "effect/Schema";

/**
 * The server owns the exam: a scenario is pure input data the server runs against
 * the real game. These bounds keep one run inside the memory and time one Godot
 * process may spend, and keep an agent from hiding a test in a long route.
 */
export const GAME_SCENARIO_LIMITS = {
  /** Scenarios read from godot/tests/scenarios in one run. */
  maxScenarios: 8,
  /** Steps in one scenario. */
  maxSteps: 2_000,
  /** Physics frames in one scenario (10 minutes at 60 Hz). */
  maxFrames: 36_000,
  /** Actions held at once; more than this is a malformed route, not a test. */
  maxActionsPerStep: 8,
} as const;

const scenarioIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** One action down for a frame, then up. */
const GameScenarioPressStep = Schema.Struct({
  press: Schema.String.check(Schema.isMinLength(1)),
});
/** Actions held for a number of physics frames. */
const GameScenarioHoldStep = Schema.Struct({
  hold: Schema.Array(Schema.String).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(GAME_SCENARIO_LIMITS.maxActionsPerStep),
  ),
  frames: Schema.Int.check(Schema.isGreaterThan(0)),
});
/** No new input for a number of physics frames. */
const GameScenarioWaitStep = Schema.Struct({
  wait: Schema.Int.check(Schema.isGreaterThan(0)),
});
export const GameScenarioStep = Schema.Union([
  GameScenarioPressStep,
  GameScenarioHoldStep,
  GameScenarioWaitStep,
]);
export type GameScenarioStep = typeof GameScenarioStep.Type;
export const GameScenario = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(scenarioIdPattern), Schema.isMaxLength(64)),
  steps: Schema.Array(GameScenarioStep).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(GAME_SCENARIO_LIMITS.maxSteps),
  ),
});
export type GameScenario = typeof GameScenario.Type;

export type GameScenarioParseResult =
  | { readonly ok: true; readonly scenario: GameScenario; readonly frames: number }
  | { readonly ok: false; readonly issues: readonly string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const allowedKeys = (record: Record<string, unknown>, keys: readonly string[]): string[] =>
  Object.keys(record).filter((key) => !keys.includes(key));

const positiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/**
 * Strict reader for one scenario file. Unknown keys are errors rather than
 * ignored, so a misspelled step cannot silently become a shorter route.
 */
export function parseGameScenario(value: unknown): GameScenarioParseResult {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ["A scenario must be a JSON object."] };
  for (const key of allowedKeys(value, ["id", "steps"]))
    issues.push(`Unknown scenario key "${key}".`);
  const id = value.id;
  if (typeof id !== "string" || !scenarioIdPattern.test(id))
    issues.push('A scenario id must be a lowercase slug such as "full-run".');
  const rawSteps = value.steps;
  if (!Array.isArray(rawSteps)) {
    issues.push("A scenario needs a steps array.");
    return { ok: false, issues };
  }
  if (rawSteps.length === 0) issues.push("A scenario needs at least one step.");
  if (rawSteps.length > GAME_SCENARIO_LIMITS.maxSteps)
    issues.push(`A scenario may have at most ${GAME_SCENARIO_LIMITS.maxSteps} steps.`);
  let frames = 0;
  rawSteps.slice(0, GAME_SCENARIO_LIMITS.maxSteps).forEach((raw, index) => {
    const where = `Step ${index + 1}`;
    if (!isRecord(raw)) {
      issues.push(`${where} must be an object.`);
      return;
    }
    const keys = Object.keys(raw);
    if ("press" in raw) {
      for (const key of allowedKeys(raw, ["press"]))
        issues.push(`${where} has unknown key "${key}".`);
      if (typeof raw.press !== "string" || raw.press.trim() === "")
        issues.push(`${where}'s press must name one input action.`);
      frames += 2;
      return;
    }
    if ("hold" in raw) {
      for (const key of allowedKeys(raw, ["hold", "frames"]))
        issues.push(`${where} has unknown key "${key}".`);
      if (
        !Array.isArray(raw.hold) ||
        raw.hold.length === 0 ||
        !raw.hold.every((action) => typeof action === "string" && action.trim() !== "")
      )
        issues.push(`${where}'s hold must list at least one input action.`);
      else {
        if (raw.hold.length > GAME_SCENARIO_LIMITS.maxActionsPerStep)
          issues.push(
            `${where} may hold at most ${GAME_SCENARIO_LIMITS.maxActionsPerStep} actions.`,
          );
        const seen = new Set<string>();
        for (const action of raw.hold) {
          if (seen.has(action)) issues.push(`${where}'s hold lists "${action}" twice.`);
          seen.add(action);
        }
      }
      if (!positiveInt(raw.frames)) issues.push(`${where}'s frames must be a positive integer.`);
      else frames += raw.frames;
      return;
    }
    if ("wait" in raw) {
      for (const key of allowedKeys(raw, ["wait"]))
        issues.push(`${where} has unknown key "${key}".`);
      if (!positiveInt(raw.wait)) issues.push(`${where}'s wait must be a positive integer.`);
      else frames += raw.wait;
      return;
    }
    issues.push(`${where} must be a press, hold or wait step, not ${JSON.stringify(keys)}.`);
  });
  if (frames > GAME_SCENARIO_LIMITS.maxFrames)
    issues.push(
      `A scenario may run at most ${GAME_SCENARIO_LIMITS.maxFrames} frames; this one plans ${frames}.`,
    );
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    scenario: { id: id as string, steps: rawSteps as GameScenarioStep[] },
    frames,
  };
}

/** Values a GameState property may hold and a runner can sample. */
export const GameObservedValue = Schema.Union([Schema.Number, Schema.Boolean, Schema.String]);
export type GameObservedValue = typeof GameObservedValue.Type;
/**
 * Bounded statistics for one sampled key. Raw samples never leave the runner
 * process; `firstChangeFrame` is the first frame whose value differed from the
 * first sample, and `matches` records the first frame each criterion's
 * expectation became true.
 */
export const GameScenarioObservation = Schema.Struct({
  key: Schema.String,
  min: Schema.NullOr(GameObservedValue),
  max: Schema.NullOr(GameObservedValue),
  first: Schema.NullOr(GameObservedValue),
  last: Schema.NullOr(GameObservedValue),
  firstChangeFrame: Schema.NullOr(Schema.Int),
  /**
   * The value at the gameplay baseline: the first sample at or after the
   * route's first non-wait input where a player existed. A criterion passes
   * only when it was false here and true at a later sample.
   */
  baseline: Schema.NullOr(GameObservedValue),
  matches: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      frame: Schema.Int,
      /** The value sampled when the expectation first became true. */
      value: Schema.optionalKey(Schema.NullOr(GameObservedValue)),
    }),
  ),
});
export type GameScenarioObservation = typeof GameScenarioObservation.Type;
export const GameScenarioEvidence = Schema.Struct({
  id: Schema.String,
  /** Physics frames the route ran, including boot and step frames. */
  frames: Schema.Int,
  durationMs: Schema.Int,
  /** Frame of the first press/hold step, or null when the route only waited. */
  firstInputFrame: Schema.NullOr(Schema.Int),
  /**
   * First sample at or after `firstInputFrame` with a node in group "player".
   * Without it the route never started play, so nothing can be achieved.
   */
  baselineFrame: Schema.NullOr(Schema.Int),
  /** The player group existed and its position changed from the first sample. */
  playerMoved: Schema.Boolean,
  /** A rejected route, a crash or a script error. A run with an error never qualifies. */
  error: Schema.NullOr(Schema.String),
  invalidActions: Schema.Array(Schema.String),
  observations: Schema.Array(GameScenarioObservation),
});
export type GameScenarioEvidence = typeof GameScenarioEvidence.Type;
export const GameScenarioCriterionStatus = Schema.Literals([
  "passed",
  "failed",
  "unverified",
  "missing",
]);
export type GameScenarioCriterionStatus = typeof GameScenarioCriterionStatus.Type;
/**
 * The real samples behind a pass, kept typed so a consumer can check a promise
 * stricter than the criterion declared without reading `observed`. `baseline`
 * is the gameplay baseline the criterion had to be false at, and `last` is a
 * later sample; a scenario that only flashed a value and returned cannot prove
 * a final state. Older results predate this field.
 */
export const GameScenarioCriterionMeasurement = Schema.Struct({
  scenario: Schema.String,
  key: Schema.String,
  baseline: Schema.NullOr(GameObservedValue),
  last: Schema.NullOr(GameObservedValue),
});
export type GameScenarioCriterionMeasurement = typeof GameScenarioCriterionMeasurement.Type;
/**
 * One approved criterion checked against the run. Mechanical claims without
 * `observe` are `missing` and block the stage; presentation claims never reach
 * this result and are reported by the visual stage as `missing` instead.
 */
export const GameScenarioCriterionResult = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  text: Schema.String,
  status: GameScenarioCriterionStatus,
  /** What the runs actually saw, in one line, for the agent and the stage UI. */
  observed: Schema.String,
  /** Scenarios that satisfied this criterion. */
  scenarios: Schema.Array(Schema.String),
  /** The first scenario and frame that proved the criterion, when it passed. */
  provenBy: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ scenario: Schema.String, frame: Schema.Int })),
  ),
  /** The proving scenario's baseline and final samples, when it passed. */
  measurement: Schema.optionalKey(GameScenarioCriterionMeasurement),
});
export type GameScenarioCriterionResult = typeof GameScenarioCriterionResult.Type;
/** One kind's coverage in the state stage. `proven` means the criterion passed. */
export const GameScenarioKindCoverage = Schema.Struct({
  kind: Schema.String,
  proven: Schema.Int,
  failed: Schema.Int,
  missing: Schema.Int,
});
export type GameScenarioKindCoverage = typeof GameScenarioKindCoverage.Type;
export const GameScenarioStageReason = Schema.Literals([
  "criteria-passed",
  "observable-failed",
  "win-criterion-failed",
  "no-player-movement",
  "no-acceptance",
  "legacy-unproven",
  "legacy-passed",
  "scenario-failed",
]);
export type GameScenarioStageReason = typeof GameScenarioStageReason.Type;
/**
 * What the server recorded for the `state` stage. It is a summary, not the raw
 * run: the details stay in games/builds/logs, and the record stays small.
 */
export const GameScenarioSummary = Schema.Struct({
  mode: Schema.Literals(["criteria", "legacy", "none"]),
  passed: Schema.Boolean,
  reason: GameScenarioStageReason,
  /** A human-readable explanation of the reason, including the failing rule. */
  detail: Schema.String,
  criteria: Schema.Array(GameScenarioCriterionResult),
  /** Proven/failed/missing counts for every kind the state stage graded. */
  coverage: Schema.optionalKey(Schema.Array(GameScenarioKindCoverage)),
});
export type GameScenarioSummary = typeof GameScenarioSummary.Type;
export const GameScenariosRunResult = Schema.Struct({
  ok: Schema.Boolean,
  summary: GameScenarioSummary,
  scenarios: Schema.Array(GameScenarioEvidence),
  /** Route or file problems that stopped a scenario before its result was usable. */
  errors: Schema.Array(Schema.String),
  /** Where the runner kept its result files for this run. */
  evidenceDirectory: Schema.NullOr(Schema.String),
});
export type GameScenariosRunResult = typeof GameScenariosRunResult.Type;
