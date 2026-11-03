import * as Schema from "effect/Schema";

/**
 * Real-time written-bot playtesting behind the GameBot service. A bot is a
 * game file under `.studio/bot/*.mjs` (goal, observe, options, status, an
 * optional policy); the service runs the real game at normal speed on a
 * private display, drives it through the bot's inputs at 10 Hz, records one
 * continuous video, and reports detectors findings with time and position.
 */

export const GAME_BOT_BOUNDS = {
  /** Default wall budget for one run. */
  defaultSeconds: 120,
  /** Shortest and longest wall budget one run may take. */
  minSeconds: 10,
  maxSeconds: 600,
  /** Nominal controller tick: holds and releases go out at 10 Hz. */
  tickMs: 100,
  /** Findings kept in one run result; detectors dedupe by signature. */
  maxFindings: 40,
  /** Frames extracted from the run video for the result. */
  maxFrames: 8,
  /** Recent bot runs remembered per game for game_bot_view. */
  maxRuns: 20,
} as const;

export const GameBotDecider = Schema.Literals(["policy", "jev"]);
export type GameBotDecider = typeof GameBotDecider.Type;

export const GameBotMode = Schema.Literals(["play", "explore"]);
export type GameBotMode = typeof GameBotMode.Type;

export const GameBotRunInput = Schema.Struct({
  /** Bot file relative to the game root, under `.studio/bot/`, ending `.mjs`. */
  file: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  /** Who picks among the bot's options. Omitted means the bot's own policy. */
  decider: Schema.optionalKey(GameBotDecider),
  /** Wall budget in seconds. Omitted means the default. */
  seconds: Schema.optionalKey(Schema.Number),
  /**
   * What the run is for. `play` tries to finish (a win bot). `explore`
   * wanders the mechanics broadly with no goal of winning (an exploration
   * bot, Aura's "an exploration": options covering the mechanics, preferring
   * what hasn't been tried). Omitted means `play`.
   */
  mode: Schema.optionalKey(GameBotMode),
  /**
   * How many sequential runs this call makes (1–10, default 1). Exploration
   * calls run several so the player report compares across runs.
   */
  runs: Schema.optionalKey(Schema.Int),
});
export type GameBotRunInput = typeof GameBotRunInput.Type;

export const GameBotFinding = Schema.Struct({
  detector: Schema.String,
  severity: Schema.String,
  summary: Schema.String,
  /** Game seconds since the run started. */
  t: Schema.Number,
  pos: Schema.NullOr(Schema.Tuple([Schema.Number, Schema.Number, Schema.Number])),
  detail: Schema.String,
});
export type GameBotFinding = typeof GameBotFinding.Type;

export const GameBotStatus = Schema.Struct({
  /** done | failed | stalled | budget | error: what the bot's own status said at the end. */
  state: Schema.String,
  note: Schema.String,
});
export type GameBotStatus = typeof GameBotStatus.Type;

export const GameBotJevUsage = Schema.Struct({
  calls: Schema.Int,
  failures: Schema.Int,
  /** Median decide round-trip ms; null when no call completed. */
  medianMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /** Median ms of calls on the warm connection. */
  warmMedianMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /** Jev decisions made among 2+ real options. */
  decisions2Plus: Schema.optionalKey(Schema.Int),
  /** True once Jev made at least 3 decisions among 2+ options. */
  valid: Schema.optionalKey(Schema.Boolean),
});
export type GameBotJevUsage = typeof GameBotJevUsage.Type;

/**
 * Scene node counts over a Godot play run: start, peak and end, plus orphan
 * nodes (out of the tree, never freed) at the end. Counts, not timings, so
 * they do not depend on the machine's load.
 */
export const GameBotPerf = Schema.Struct({
  nodesStart: Schema.Int,
  nodesPeak: Schema.Int,
  nodesEnd: Schema.Int,
  orphansEnd: Schema.Int,
});
export type GameBotPerf = typeof GameBotPerf.Type;

export const GameBotRunResult = Schema.Struct({
  runId: Schema.String,
  goal: Schema.String,
  status: GameBotStatus,
  ticks: Schema.Int,
  /** Controller ticks per wall second, measured. */
  tickHz: Schema.Number,
  /** Game seconds per wall second, measured from engine physics frames. */
  timeRatio: Schema.Number,
  gameSeconds: Schema.Number,
  decisions: Schema.Int,
  /** Null when the run never asked Jev (policy decider or no key). */
  jev: Schema.NullOr(GameBotJevUsage),
  /** Set when the run fell back to policy (no key, Jev failing). */
  policyNote: Schema.NullOr(Schema.String),
  /** True when the bot used an explicit set-state write; the trace lists each one. */
  usedSetState: Schema.Boolean,
  findings: Schema.Array(GameBotFinding),
  finalState: Schema.Record(
    Schema.String,
    Schema.Union([Schema.Number, Schema.Boolean, Schema.String, Schema.Null]),
  ),
  finalPos: Schema.NullOr(Schema.Tuple([Schema.Number, Schema.Number, Schema.Number])),
  /** Absent when the runner reports no counts (the web runner). */
  perf: Schema.optionalKey(GameBotPerf),
  /** What this call was for: finishing (`play`) or wandering (`explore`). */
  mode: GameBotMode,
  /** Every run id this call made, in order (one entry for a single run). */
  runIds: Schema.Array(Schema.String),
  /**
   * Game-relative player report across the call's runs, when one was
   * written (exploration calls). Null for single play runs.
   */
  reportPath: Schema.NullOr(Schema.String),
  /** Absolute server-owned paths. */
  tracePath: Schema.String,
  videoPath: Schema.String,
  frames: Schema.Array(Schema.String),
  message: Schema.String,
});
export type GameBotRunResult = typeof GameBotRunResult.Type;

export const GameBotViewInput = Schema.Struct({
  runId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type GameBotViewInput = typeof GameBotViewInput.Type;
export const GameBotViewResult = Schema.Struct({
  runId: Schema.String,
  goal: Schema.String,
  status: GameBotStatus,
  ticks: Schema.Int,
  tickHz: Schema.Number,
  timeRatio: Schema.Number,
  decisions: Schema.Int,
  jev: Schema.NullOr(GameBotJevUsage),
  usedSetState: Schema.Boolean,
  findings: Schema.Array(GameBotFinding),
  tracePath: Schema.String,
  videoPath: Schema.String,
  frames: Schema.Array(Schema.String),
  message: Schema.String,
});
export type GameBotViewResult = typeof GameBotViewResult.Type;

/**
 * Facts-only player report across a game's bot runs, written by code (no
 * interpretation): where runs ended, what was picked and how often, which
 * offered options were never or rarely picked, first-action times, position
 * clusters, and detector findings. Saved as `.studio/player-report.md`.
 */
export const GameBotReportResult = Schema.Struct({
  /** Game-relative report path (`.studio/player-report.md`). */
  path: Schema.String,
  /** Run ids the report covers, oldest first. */
  runs: Schema.Array(Schema.String),
  message: Schema.String,
});
export type GameBotReportResult = typeof GameBotReportResult.Type;
