import * as Schema from "effect/Schema";

/**
 * The harness's stepped bot runs behind the GameBot service: a bot file under the checkout's
 * `.studio/bot/` played inside the game's page on the run's own clock (the random-input masher
 * a build's facts are measured with).
 */

export const GAME_BOT_BOUNDS = {
  /** Default game seconds for one run. */
  defaultSeconds: 120,
  /** Fewest and most game seconds one run may take. */
  minSeconds: 10,
  maxSeconds: 600,
} as const;

export const GameBotRunInput = Schema.Struct({
  /** Bot file relative to the checkout's root, under `.studio/bot/`, ending `.mjs`. */
  file: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  /** Game seconds the run may play. Omitted means the default. */
  seconds: Schema.optionalKey(Schema.Number),
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
  /**
   * The bot's own word at the end (done, failed, stalled, budget, ...), or the
   * harness's: crashed / unresponsive / not-booted (measured about the game,
   * only while our own host was alive), bot-error (the bot played, then its own
   * child threw or exited), stopped (a stop or cancel; not a measurement).
   */
  state: Schema.String,
  note: Schema.String,
  /** The bot child's structured evidence, at most 4096 bytes encoded; larger is omitted and the note says so. */
  evidence: Schema.optionalKey(Schema.Unknown),
});
export type GameBotStatus = typeof GameBotStatus.Type;

/**
 * Scene node counts over a play run, where the runner reports them: start, peak and end, plus orphan
 * nodes (out of the tree, never freed) at the end. Counts, not timings, so
 * they do not depend on the machine's load.
 */
const GameBotPerf = Schema.Struct({
  nodesStart: Schema.Int,
  nodesPeak: Schema.Int,
  nodesEnd: Schema.Int,
  orphansEnd: Schema.Int,
});

export const GameBotRunResult = Schema.Struct({
  runId: Schema.String,
  /** False only when the bot itself never ran (its module failed to load, its child died before tick 1); absent means true. */
  played: Schema.optionalKey(Schema.Boolean),
  goal: Schema.String,
  status: GameBotStatus,
  ticks: Schema.Int,
  /** Controller ticks per wall second, measured. */
  tickHz: Schema.Number,
  /** Game seconds per wall second, measured from engine physics frames. */
  timeRatio: Schema.Number,
  gameSeconds: Schema.Number,
  decisions: Schema.Int,
  /** True when the bot used an explicit set-state write; the trace lists each one. */
  usedSetState: Schema.Boolean,
  /** State writes the game refused, with its reason; absent when none was. */
  refusedStates: Schema.optionalKey(
    Schema.Array(Schema.Struct({ target: Schema.String, error: Schema.String })),
  ),
  findings: Schema.Array(GameBotFinding),
  finalState: Schema.Record(
    Schema.String,
    Schema.Union([Schema.Number, Schema.Boolean, Schema.String, Schema.Null]),
  ),
  finalPos: Schema.NullOr(Schema.Tuple([Schema.Number, Schema.Number, Schema.Number])),
  /** Absent when the runner reports no counts (the web runner). */
  perf: Schema.optionalKey(GameBotPerf),
  /** Every run id this call made, in order (one entry for a single run). */
  runIds: Schema.Array(Schema.String),
  /** Absolute server-owned paths. */
  tracePath: Schema.String,
  videoPath: Schema.String,
  frames: Schema.Array(Schema.String),
  message: Schema.String,
});
export type GameBotRunResult = typeof GameBotRunResult.Type;
