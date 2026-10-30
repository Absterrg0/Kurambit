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
   * The value at the gameplay baseline: before the route's first non-wait
   * input when play had already started (an explicit typed `state` marker
   * that is not 0/false, or, in a markerless game, a player present), otherwise
   * the first sample after that input in which play exists and the game is not
   * in its menu state. A criterion passes only when it was false here and true
   * at a later sample.
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
/**
 * One runtime layout probe hit during a scenario run. `kind` separates
 * definite geometry (`clip` and `viewport`: the control is provably outside
 * its visible area or the native viewport) from `overlap-risk` (a later
 * sibling covers enough area to matter, but transparency can hide paint, so
 * geometry alone never proves visual occlusion). Native headless pixels are
 * the game's own layout at its logical size, never the exported Web build, so
 * a finding is a hint for where to look with Web frames, never a Web verdict.
 */
export const GameScenarioLayoutKind = Schema.Literals(["clip", "viewport", "overlap-risk"]);
export type GameScenarioLayoutKind = typeof GameScenarioLayoutKind.Type;
export const GameScenarioLayoutFinding = Schema.Struct({
  kind: GameScenarioLayoutKind,
  /** The control, e.g. `Button "Cook"`. */
  subject: Schema.String,
  /** What the probe measured, in the checker's wording. */
  detail: Schema.String,
  /** Scene-tree path of the control in the running game. */
  nodePath: Schema.String,
  /** Runner scenario frame when the probe ran. */
  scenarioFrame: Schema.Int,
  /** Route step whose boundary the probe followed, or null for the boot probe. */
  step: Schema.NullOr(Schema.Int),
  /** Native viewport the probe measured against. */
  viewport: Schema.Struct({ width: Schema.Number, height: Schema.Number }),
});
export type GameScenarioLayoutFinding = typeof GameScenarioLayoutFinding.Type;
/**
 * How much of the route runtime layout actually inspected. The probes are a
 * small bounded sample near input step boundaries and gameplay baselines, not
 * a full-route proof: `omittedProbes` counts scheduled probes skipped by the
 * finding cap, and `truncated` says a cap stopped the scan. Absence of
 * findings never means full coverage.
 */
export const GameScenarioLayoutCoverage = Schema.Struct({
  probes: Schema.Int,
  omittedProbes: Schema.Int,
  inspectedControls: Schema.Int,
  pairs: Schema.Int,
  truncated: Schema.Boolean,
  viewport: Schema.Struct({ width: Schema.Number, height: Schema.Number }),
});
export type GameScenarioLayoutCoverage = typeof GameScenarioLayoutCoverage.Type;
export const GameScenarioLayout = Schema.Struct({
  findings: Schema.Array(GameScenarioLayoutFinding),
  coverage: GameScenarioLayoutCoverage,
});
export type GameScenarioLayout = typeof GameScenarioLayout.Type;
/**
 * One bounded runtime spatial snapshot: the player-group origin and
 * built-in body velocity plus nearby Area2D/Area3D collision-shape bounds in
 * world coordinates. Portable measurements only, never a verdict engine:
 * rotated and non-box bounds are conservative axis-aligned boxes, and a
 * point-in-box test never means an entire body is inside or that any game
 * trigger fired. Native headless geometry may diverge from Web cadence and
 * runtime, so these numbers are never Web telemetry or quality facts.
 */
export const GameScenarioSpatialPlayer = Schema.Struct({
  /** True when a `player`-group node existed at the probe. */
  present: Schema.Boolean,
  /** World origin as [x, y] or [x, y, z], null when absent or non-spatial. */
  position: Schema.NullOr(Schema.Array(Schema.Number)),
  /** Built-in CharacterBody/RigidBody velocity as [x, y] or [x, y, z]; null otherwise. */
  velocity: Schema.NullOr(Schema.Array(Schema.Number)),
  /** Engine node class (e.g. CharacterBody2D) or null when absent. */
  bodyKind: Schema.NullOr(Schema.String),
});
export type GameScenarioSpatialPlayer = typeof GameScenarioSpatialPlayer.Type;
export const GameScenarioSpatialBounds = Schema.Struct({
  kind: Schema.Literals(["rect2", "aabb3", "unknown"]),
  /** World min as [x, y] or [x, y, z]; null when unknown. */
  min: Schema.NullOr(Schema.Array(Schema.Number)),
  /** World max as [x, y] or [x, y, z]; null when unknown. */
  max: Schema.NullOr(Schema.Array(Schema.Number)),
});
export type GameScenarioSpatialBounds = typeof GameScenarioSpatialBounds.Type;
export const GameScenarioSpatialShape = Schema.Struct({
  /** Scene-tree path of the CollisionShape node in the running game. */
  nodePath: Schema.String,
  /** Engine shape class (e.g. RectangleShape2D, BoxShape3D) or unknown/none. */
  shapeKind: Schema.String,
  /** True when the CollisionShape node is disabled. */
  disabled: Schema.Boolean,
  /** Conservative world AABB; unknown when the shape type is unsupported. */
  bounds: GameScenarioSpatialBounds,
  /** True for rotated or non-box bounds: the box may over-cover. */
  conservative: Schema.Boolean,
  /**
   * Whether the probed player origin sat inside this shape's world bounds.
   * Null when the player was absent, the bounds are unknown, or dimensions
   * mismatch. Never means an entire body is inside or a game trigger fired.
   */
  containsPlayerOrigin: Schema.NullOr(Schema.Boolean),
});
export type GameScenarioSpatialShape = typeof GameScenarioSpatialShape.Type;
export const GameScenarioSpatialArea = Schema.Struct({
  /** Scene-tree path of the Area node in the running game. */
  nodePath: Schema.String,
  /** Engine class: Area2D or Area3D. */
  type: Schema.String,
  monitoring: Schema.Boolean,
  monitorable: Schema.Boolean,
  visible: Schema.Boolean,
  shapes: Schema.Array(GameScenarioSpatialShape),
});
export type GameScenarioSpatialArea = typeof GameScenarioSpatialArea.Type;
export const GameScenarioSpatialSnapshot = Schema.Struct({
  /** Runner scenario frame when the probe ran. */
  scenarioFrame: Schema.Int,
  /** Route step whose boundary the probe followed, or null for the boot probe. */
  step: Schema.NullOr(Schema.Int),
  player: GameScenarioSpatialPlayer,
  areas: Schema.Array(GameScenarioSpatialArea),
});
export type GameScenarioSpatialSnapshot = typeof GameScenarioSpatialSnapshot.Type;
/**
 * How much of the scene the spatial probes actually inspected. Bounded and
 * honest: truncated says a cap stopped the scan, skippedFreed counts nodes
 * that vanished mid-scan, and absence of areas never means full coverage.
 */
export const GameScenarioSpatialCoverage = Schema.Struct({
  snapshots: Schema.Int,
  omittedSnapshots: Schema.Int,
  visitedNodes: Schema.Int,
  areas: Schema.Int,
  shapes: Schema.Int,
  skippedFreed: Schema.Int,
  truncated: Schema.Boolean,
});
export type GameScenarioSpatialCoverage = typeof GameScenarioSpatialCoverage.Type;
export const GameScenarioSpatial = Schema.Struct({
  snapshots: Schema.Array(GameScenarioSpatialSnapshot),
  coverage: GameScenarioSpatialCoverage,
});
export type GameScenarioSpatial = typeof GameScenarioSpatial.Type;
export const GameScenarioEvidence = Schema.Struct({
  id: Schema.String,
  /** Physics frames the route ran, including boot and step frames. */
  frames: Schema.Int,
  durationMs: Schema.Int,
  /** Frame of the first press/hold step, or null when the route only waited. */
  firstInputFrame: Schema.NullOr(Schema.Int),
  /**
   * Frame of the gameplay baseline: before `firstInputFrame` when play had
   * already started, otherwise the first sample at or after it where play
   * exists and the game is not in its menu state. Play is an explicit typed
   * `state` marker that is not 0/false, or, in a markerless game, a player
   * present. Without it the route never started play, so nothing can be
   * achieved.
   */
  baselineFrame: Schema.NullOr(Schema.Int),
  /** The player group existed and its position changed from the first sample. */
  playerMoved: Schema.Boolean,
  /** A rejected route, a crash or a script error. A run with an error never qualifies. */
  error: Schema.NullOr(Schema.String),
  invalidActions: Schema.Array(Schema.String),
  observations: Schema.Array(GameScenarioObservation),
  /**
   * Bounded runtime layout probes sampled near input step boundaries, when
   * the runner was asked to inspect layout. Additive diagnostics only: the
   * state exam grades observations, never these findings, so uncertain
   * overlap geometry cannot fail a mechanics gate. Absent on older runs and
   * on runs that did not probe; absence never means fully covered.
   */
  layout: Schema.optionalKey(GameScenarioLayout),
  /**
   * Bounded runtime spatial snapshots (player origin/velocity plus Area
   * collision-shape world bounds) sampled at the same probe schedule, when
   * the runner was asked to record them. Additive measurements only: the
   * state exam grades observations, never this geometry. Absent on older
   * runs and on runs that did not probe; absence never means fully covered.
   * Native headless geometry may diverge from Web cadence and runtime.
   */
  spatial: Schema.optionalKey(GameScenarioSpatial),
});
export type GameScenarioEvidence = typeof GameScenarioEvidence.Type;
export const GameScenarioCriterionStatus = Schema.Literals([
  "passed",
  "failed",
  "unverified",
  "missing",
  /**
   * The design deliberately has nothing for this stage to observe, currently
   * only a declared no-loss state. It is neither proof nor a missing sample.
   */
  "not-applicable",
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
 * `observe` are `missing` and block the stage, except an explicit no-loss
 * declaration, which is `not-applicable` and does not block; presentation
 * claims never reach this result and are reported by the visual stage as
 * `missing` instead.
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
/**
 * One kind's coverage in the state stage. `proven` means the criterion passed;
 * a not-applicable no-loss declaration counts in none of the three counts.
 */
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
  /** Historical universal-win verdict; kept so older persisted summaries decode. */
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
  /** Proven/failed/missing counts for every kind the state stage graded; not-applicable is in none. */
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
