import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";
import { GameBotDecider } from "./gameBot.ts";

/**
 * A build: a playable version of the game the person and the agent can list,
 * play, compare and go back to. Every turn that changed the game is one (its
 * T3 checkpoint), and so is every run round and saved build. The id is the
 * build's commit oid; the UI treats it as opaque.
 */
export const GameBuildId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
).pipe(Schema.brand("GameBuildId"));
export type GameBuildId = typeof GameBuildId.Type;

/** Bounds of one measurement, the same for every engine. */
export const GAME_FACTS_BOUNDS = {
  idleSeconds: 60,
  masherSeconds: 60,
  skilledSeconds: 60,
  startSeconds: 10,
} as const;

/** Push names on the game's operation stream: the list changed, or a build's facts did. */
export const GAME_BUILDS_EVENT = "builds";
export const GAME_FACTS_EVENT = "facts";

export const GameBuildSource = Schema.Union([
  Schema.TaggedStruct("turn", {
    threadId: ThreadId,
    threadTitle: Schema.String,
    /** The turn's ordinal in its thread. */
    turn: PositiveInt,
    /** The person's request, first line, at most 140 characters. */
    request: Schema.String,
  }),
  Schema.TaggedStruct("round", {
    runId: Schema.String,
    round: PositiveInt,
    rung: Schema.NullOr(Schema.String),
    move: Schema.String,
    outcome: Schema.Literals(["kept", "not-kept", "abandoned"]),
    /** The run's best is this build now. */
    best: Schema.Boolean,
    durationMs: Schema.Number,
    linesChanged: Schema.Number,
  }),
  /** A run's prototype, stage, ending, unfinished work, or the folder before a restore or resume. */
  Schema.TaggedStruct("saved", {
    runId: Schema.NullOr(Schema.String),
    label: Schema.String,
  }),
]);
export type GameBuildSource = typeof GameBuildSource.Type;

export const GameBuildFile = Schema.Struct({
  path: Schema.String,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});

export const GameFactsState = Schema.Literals([
  "never",
  "queued",
  "measuring",
  "measured",
  /** Some facts measured, others not measured with a reason. */
  "incomplete",
  /** Measured on an older harness; a measure refreshes it. */
  "stale",
]);
export type GameFactsState = typeof GameFactsState.Type;

/** One fact's id, in display order: the shared names of the rail, compare, card and tools. */
export const GameFactId = Schema.Literals([
  "boots",
  "idle",
  "masher",
  "skilled",
  "winnable-without-skill",
  "freeze",
  "motion",
  "detail",
  "colour",
  "first-response",
]);
export type GameFactId = typeof GameFactId.Type;
export const GameFactTone = Schema.Literals(["good", "bad", "neutral"]);
export type GameFactTone = typeof GameFactTone.Type;

/** What a list row shows: a few facts the server picked, already worded. */
export const GameBuildFactsSummary = Schema.Struct({
  state: GameFactsState,
  chips: Schema.Array(
    Schema.Struct({ id: GameFactId, text: Schema.String, tone: GameFactTone }),
  ).check(Schema.isMaxLength(3)),
  notMeasured: NonNegativeInt,
});
export type GameBuildFactsSummary = typeof GameBuildFactsSummary.Type;

export const GameBuild = Schema.Struct({
  id: GameBuildId,
  at: IsoDateTime,
  source: GameBuildSource,
  summary: Schema.String,
  /** At most 8, most changed first. */
  files: Schema.Array(GameBuildFile),
  fileCount: NonNegativeInt,
  /** False when its ref was pruned: listed for history, no play or restore. */
  available: Schema.Boolean,
  /** Why it cannot be played here (an engine with no Web build), else null. */
  noPlay: Schema.NullOr(Schema.String),
  /** Why it cannot be restored (a live run, a role thread), else null. */
  noRestore: Schema.NullOr(Schema.String),
  facts: GameBuildFactsSummary,
});
export type GameBuild = typeof GameBuild.Type;

export const GameFactNotMeasured = Schema.Struct({
  status: Schema.Literal("not-measured"),
  why: Schema.String,
  /** Waiting can clear it (a tool or the machine): the next measure tries again. */
  retry: Schema.Boolean,
});
export const GameFactPending = Schema.Struct({ status: Schema.Literal("pending") });
const gameFact = <S extends Schema.Top>(value: S) =>
  Schema.Union([
    Schema.Struct({ status: Schema.Literal("measured"), value }),
    GameFactNotMeasured,
    GameFactPending,
  ]);

export const GameBotEnding = Schema.Literals([
  "won",
  "lost",
  "no-ending",
  "crashed",
  "unresponsive",
  "did-not-boot",
]);
export const GameBotTier = Schema.Struct({
  ending: GameBotEnding,
  /** Game seconds from the start of play to the ending; null without one. */
  at: Schema.NullOr(Schema.Number),
  /** Game seconds of play. */
  played: Schema.Number,
  note: Schema.String,
  /** The trace and video folder, relative to the game root. */
  evidence: Schema.NullOr(Schema.String),
});
export const GameSkilledTier = Schema.Struct({
  ...GameBotTier.fields,
  bot: Schema.Struct({ file: Schema.String, hash: Schema.String, decider: GameBotDecider }),
  /** The bot's own end word when the game reported no result. */
  botWord: Schema.NullOr(Schema.String),
});
export const GameLiveness = Schema.Struct({
  freezes: Schema.Array(Schema.Struct({ at: Schema.Number, seconds: Schema.Number })).check(
    Schema.isMaxLength(10),
  ),
  longestFreeze: Schema.Number,
  /** Mean temporal information (ITU-T P.910). */
  motion: Schema.Number,
  /** Mean spatial information. */
  detail: Schema.Number,
  /** Share of the frame held by one colour, 0–1. */
  dominantColour: Schema.Number,
  /** Seconds, from the engine's own frame counter. */
  longestStall: Schema.Number,
  /** Seconds of play analysed. */
  seconds: Schema.Number,
});
export const GameFirstResponse = Schema.Struct({
  /** Null: nothing moved within the window. */
  seconds: Schema.NullOr(Schema.Number),
  window: Schema.Number,
  resolution: Schema.Number,
});

export const GameBuildFacts = Schema.Struct({
  build: GameBuildId,
  /** The content key the facts are cached by (the engine project's tree) and the harness that measured them. */
  key: Schema.String,
  harness: Schema.String,
  state: GameFactsState,
  measuredAt: Schema.NullOr(IsoDateTime),
  /** The renderer the plays drew with, when it differs from what the export ships ("Compatibility; native exports draw Forward+"). */
  renderer: Schema.NullOr(Schema.String),
  boots: gameFact(Schema.Struct({ ok: Schema.Boolean, detail: Schema.String })),
  idle: gameFact(GameBotTier),
  masher: gameFact(GameBotTier),
  skilled: gameFact(GameSkilledTier),
  winnableWithoutSkill: gameFact(Schema.Boolean),
  liveness: gameFact(GameLiveness),
  firstResponse: gameFact(GameFirstResponse),
  /** For people and agents: what is measuring, queued behind what, about how long is left. */
  message: Schema.String,
});
export type GameBuildFacts = typeof GameBuildFacts.Type;

/** One fact as a person reads it: the display row the rail, compare view and card draw. */
export const GameFactView = Schema.Struct({
  id: GameFactId,
  label: Schema.String,
  reading: Schema.Union([
    Schema.TaggedStruct("measured", {
      text: Schema.String,
      value: Schema.NullOr(Schema.Number),
      tone: GameFactTone,
    }),
    Schema.TaggedStruct("not-measured", { why: Schema.String }),
    Schema.TaggedStruct("pending", {}),
  ]),
  evidence: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["video", "frame", "log"]),
      label: Schema.String,
      /** Relative to the game root. */
      path: Schema.String,
    }),
  ),
});
export type GameFactView = typeof GameFactView.Type;

export const GameFactDelta = Schema.Struct({
  id: GameFactId,
  label: Schema.String,
  a: Schema.NullOr(Schema.String),
  b: Schema.NullOr(Schema.String),
  change: Schema.Literals(["up", "down", "same", "changed", "not-comparable"]),
  tone: Schema.Literals(["better", "worse", "neutral"]),
  /** Set for not-comparable: why a side has no reading. */
  why: Schema.NullOr(Schema.String),
});
export type GameFactDelta = typeof GameFactDelta.Type;

/**
 * PURE. A build's facts as display rows, in GameFactId order. The one wording
 * every surface and the agent tools share. Foundation placeholder: builder F
 * implements it.
 */
export const gameFactsView = (_facts: GameBuildFacts): ReadonlyArray<GameFactView> => [];

/**
 * PURE. The one diff of two builds' facts, shared by the compare view, the
 * round card and game_builds. A fact not measured on either side is
 * not-comparable with its reason, never "same". Foundation placeholder:
 * builder F implements it.
 */
export const diffBuildFacts = (
  _a: GameBuildFacts | null,
  _b: GameBuildFacts | null,
): ReadonlyArray<GameFactDelta> => [];

/** A build named by id, or a chat turn's build by the turn the client already holds. */
export const GameBuildRef = Schema.Union([
  Schema.TaggedStruct("build", { build: GameBuildId }),
  Schema.TaggedStruct("turn", { threadId: ThreadId, runId: Schema.String }),
]);
export type GameBuildRef = typeof GameBuildRef.Type;

export const GameBuildRestoreRef = Schema.Struct({
  requestId: Schema.String,
  target: GameBuildId,
  /** "Turn 5's build", "Round 3", "Before restore of round 2". */
  label: Schema.String,
  requestedAt: IsoDateTime,
  /** The folder-before build an undo restores; null once anything changed since. */
  undo: Schema.NullOr(GameBuildId),
  outcome: Schema.NullOr(Schema.Struct({ restored: Schema.Boolean, message: Schema.String })),
});

export const GameBuildsInput = Schema.Struct({
  threadId: ThreadId,
  /** A cursor from `next`. */
  before: Schema.optionalKey(Schema.String),
  /** At most 50; default 30. */
  limit: Schema.optionalKey(PositiveInt),
});
export const GameBuildsResult = Schema.Struct({
  /** Newest first. A run's role-thread turns are folded into its rounds. */
  builds: Schema.Array(GameBuild),
  next: Schema.NullOr(Schema.String),
  /** The build the folder was last made from: a capture or a restore. */
  current: Schema.NullOr(GameBuildId),
  /** Whether the folder has changed since `current`. */
  folderEdited: Schema.Union([Schema.Boolean, Schema.Literal("unknown")]),
  /** The game's latest restore, from any source. */
  restore: Schema.NullOr(GameBuildRestoreRef),
});
export type GameBuildsResult = typeof GameBuildsResult.Type;

export const GameBuildCompareInput = Schema.Struct({
  threadId: ThreadId,
  a: GameBuildRef,
  b: GameBuildRef,
});
export const GameBuildComparison = Schema.Struct({
  a: GameBuild,
  b: GameBuild,
  factsA: GameBuildFacts,
  factsB: GameBuildFacts,
  deltas: Schema.Array(GameFactDelta),
});
export type GameBuildComparison = typeof GameBuildComparison.Type;

/** facts (read only), measure and play name one build. */
export const GameBuildRefInput = Schema.Struct({ threadId: ThreadId, build: GameBuildRef });
export const GameBuildPlayResult = Schema.Union([
  Schema.TaggedStruct("web", { url: Schema.String }),
  Schema.TaggedStruct("window", { message: Schema.String }),
]);
export type GameBuildPlayResult = typeof GameBuildPlayResult.Type;
export const GameBuildRestoreInput = Schema.Struct({
  threadId: ThreadId,
  build: GameBuildRef,
  commandId: Schema.optionalKey(Schema.String),
});
export const GameBuildRestoreResult = Schema.Struct({
  requestId: Schema.String,
  done: Schema.Boolean,
  message: Schema.String,
});
