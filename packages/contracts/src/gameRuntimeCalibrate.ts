import * as Schema from "effect/Schema";

const scenarioIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const pathText = (cap: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(cap));

/**
 * Bounded native runtime calibration: replays one validated scenario route
 * headlessly at 2-3 render cadences with 2 repeats each, under a fixed seed
 * and fresh per-run user:// isolation. No videos, no qualification writes, no
 * scene or script edits. The verdict covers the tested route and settings
 * only: it is a measured equivalence for those runs, never a global
 * determinism certificate. Physics/render/movie indices stay separate, and a
 * missing value, unobserved probe, error or partial timeout is unknown, never
 * equivalent.
 */
export const RUNTIME_CALIBRATE_BOUNDS = {
  /** Render cadences one calibration may sweep. Headless, so 120 is allowed. */
  cadenceOptions: [30, 60, 120] as const,
  /** Default sweep when the caller names none: the two shipped cadences. */
  defaultCadences: [30, 60] as const,
  minCadences: 2,
  maxCadences: 3,
  /** Repeats per cadence. Same-rate stability is checked before cross-rate. */
  repeatsPerCadence: 2,
  /** Planned physics frames (press 2, hold frames, wait) plus boot one run may execute. */
  maxPlannedFrames: 1800,
  /** Step-boundary timeline entries one run may record. */
  maxTimelineEntries: 4096,
  /** Physics boot frames before the route starts, matching the scenario exam. */
  bootFrames: 30,
  /** Observation sampling stride, matching the scenario exam. */
  sampleEvery: 6,
  /**
   * Physics tick rates the calibration can bound. The project's
   * physics/common/physics_ticks_per_second is read before launch; anything
   * outside this set is refused instead of relabelled.
   */
  supportedPhysicsHz: [30, 60, 120] as const,
  /**
   * Component-wise player-position tolerance in engine units. Counters and booleans
   * compare exactly; positions compare within this bound. A missing or
   * unobserved position is unknown, never equivalent.
   */
  positionToleranceUnits: 0.02,
  /** GameState floats compare exactly; only positions carry a tolerance. */
  maxDifferences: 20,
  maxUnknowns: 20,
  maxRuns: 6,
  perRunTimeoutMs: 300_000,
  /** Fixed seed ceiling: a signed 32-bit int the GDScript seed() accepts. */
  maxSeed: 2_147_483_647,
  /** Default seed when the caller names none, so repeats share one value. */
  defaultSeed: 12345,
} as const;

export const GameRuntimeCalibrateInput = Schema.Struct({
  /** Authored id of one file in godot/tests/scenarios/<id>.json. Never a path or script. */
  scenarioId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.isPattern(scenarioIdPattern),
  ),
  /**
   * Render cadences to sweep, 2-3 unique values from 30/60/120. Omitted means
   * the default [30, 60]. Each cadence runs the same route twice with the same
   * seed and fresh user:// isolation. Different cadences can change input
   * timing and route outcomes; that is what the calibration measures.
   */
  cadences: Schema.optionalKey(
    Schema.Array(Schema.Literals([30, 60, 120])).check(
      Schema.isMinLength(RUNTIME_CALIBRATE_BOUNDS.minCadences),
      Schema.isMaxLength(RUNTIME_CALIBRATE_BOUNDS.maxCadences),
    ),
  ),
  /**
   * Fixed global seed applied before the main scene loads. Same for every run
   * in this calibration. Autoloads that randomized before it, plus
   * RandomNumberGenerator.randomize, time and external state, stay outside
   * guarantees; see the result warnings.
   */
  seed: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(RUNTIME_CALIBRATE_BOUNDS.maxSeed),
    ),
  ),
});
export type GameRuntimeCalibrateInput = typeof GameRuntimeCalibrateInput.Type;

const positionVector = Schema.Array(Schema.Number).check(
  Schema.isMinLength(2),
  Schema.isMaxLength(3),
);

export const GameRuntimeCalibrateRun = Schema.Struct({
  /** Render cadence (--fixed-fps) this run executed at. */
  cadence: Schema.Int,
  /** Zero-based repeat index within its cadence. */
  repeat: Schema.Int,
  /** Physics frames the route ran, including boot. */
  scenarioFrames: Schema.Int,
  /** Engine physics ticks since boot at finish. A different unit from scenario frames. */
  enginePhysicsFrames: Schema.Int,
  /** Engine process (render) ticks since boot at finish. A different unit from physics. */
  renderFrames: Schema.Int,
  /** Nominal physics seconds: engine physics ticks divided by the configured tick rate. */
  nominalPhysicsSeconds: Schema.Number,
  /** Frame of the first press/hold step, or null when the route only waited. */
  firstInputFrame: Schema.NullOr(Schema.Int),
  /** Frame of the gameplay baseline, or null when play never started. */
  baselineFrame: Schema.NullOr(Schema.Int),
  /** The player group existed and its position changed from the first sample. */
  playerMoved: Schema.Boolean,
  /** First observed player position, or null when the player was never seen. */
  playerFirst: Schema.NullOr(positionVector),
  /** Player position at the gameplay baseline, or null without a baseline. */
  playerBaseline: Schema.NullOr(positionVector),
  /** Last observed player position, or null when the player was never seen. */
  playerLast: Schema.NullOr(positionVector),
  /** Baseline-to-last displacement in engine units, or null when either end is missing. */
  playerDisplacement: Schema.NullOr(Schema.Number),
  /** True only when the reported user data dir stays inside this run's isolation. */
  userDataDirIsolated: Schema.Boolean,
  /** GameState values at finish, as sampled by the runner's observations. */
  gameState: Schema.Record(
    Schema.String,
    Schema.Union([Schema.Number, Schema.Boolean, Schema.String, Schema.Null]),
  ),
  initialGameState: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Union([Schema.Number, Schema.Boolean, Schema.String, Schema.Null]),
    ),
  ),
  /** Runner or engine error for this run, or null when it reported cleanly. */
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2000))),
  /** True when this run hit its timeout instead of finishing the route. */
  timedOut: Schema.Boolean,
  /** Game-relative result file for this run. */
  evidencePath: pathText(512),
});
export type GameRuntimeCalibrateRun = typeof GameRuntimeCalibrateRun.Type;

export const GameRuntimeCalibrateComparison = Schema.Struct({
  /** "same-rate" compares repeats at one cadence; "cross-rate" compares across cadences. */
  kind: Schema.Literals(["same-rate", "cross-rate"]),
  /** Human label such as "30fps repeat 0 vs repeat 1" or "30fps r0 vs 60fps r0". */
  label: pathText(200),
  cadenceA: Schema.Int,
  cadenceB: Schema.Int,
  /** True only when every compared field matched (within tolerance for positions). */
  equivalent: Schema.Boolean,
  /** True when a missing value, unobserved probe, error or timeout made the pair undecidable. */
  unknown: Schema.Boolean,
  /** Fields that were actually compared. */
  comparedFields: Schema.Int,
  /** Fields that could not be decided, each naming the run and reason. */
  unknownFields: Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(
    Schema.isMaxLength(RUNTIME_CALIBRATE_BOUNDS.maxUnknowns),
  ),
  /** Concrete per-field differences, each naming the field and both values. */
  differences: Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(
    Schema.isMaxLength(RUNTIME_CALIBRATE_BOUNDS.maxDifferences),
  ),
});
export type GameRuntimeCalibrateComparison = typeof GameRuntimeCalibrateComparison.Type;

export const GameRuntimeCalibrateResult = Schema.Struct({
  scenarioId: pathText(64),
  /** The native build-source identity every run covered, or null when unknown. */
  sourceId: Schema.NullOr(pathText(64)),
  /** Fixed seed every run in this calibration shared. */
  seed: Schema.Int,
  /** Configured physics tick rate every run shared. */
  physicsHz: Schema.Int,
  cadences: Schema.Array(Schema.Int),
  repeatsPerCadence: Schema.Int,
  runs: Schema.Array(GameRuntimeCalibrateRun).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(RUNTIME_CALIBRATE_BOUNDS.maxRuns),
  ),
  comparisons: Schema.Array(GameRuntimeCalibrateComparison).check(Schema.isMaxLength(24)),
  /**
   * Measured verdict for the tested route and settings only. "equivalent"
   * means same-rate repeats and cross-rate pairs all matched within the
   * documented tolerances; "different" names a concrete divergence;
   * "unknown" means a run errored, timed out or left a field unobserved.
   * Never a global determinism certificate.
   */
  verdict: Schema.Literals(["equivalent", "different", "unknown"]),
  comparedCount: Schema.Int,
  unknownCount: Schema.Int,
  /** Game-relative directory holding calibration.json plus per-run result files. */
  evidenceDirectory: pathText(512),
  /** Game-relative calibration summary file. */
  calibrationPath: pathText(512),
  /** Honest limits: seed scope, autoload timing, index units, tolerance, unknown handling. */
  warnings: Schema.Array(Schema.String.check(Schema.isMaxLength(500))),
  message: Schema.String.check(Schema.isMaxLength(2000)),
});
export type GameRuntimeCalibrateResult = typeof GameRuntimeCalibrateResult.Type;
