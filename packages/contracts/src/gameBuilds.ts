import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";
import { GameBotDecider } from "./gameBot.ts";
import { GameBuildId } from "./gameBuildId.ts";

// GameBuildId has a module of its own so game.ts (GameStatus.buildPlays) can name
// it without importing this module, which would close an import cycle through gameBot.ts.
export { GameBuildId } from "./gameBuildId.ts";

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
/** A push: files under the live-served folder changed and settled. Its message is "Changed <path>". */
export const GAME_LIVE_EVENT = "live";

export const GameBuildSource = Schema.Union([
  Schema.TaggedStruct("turn", {
    threadId: ThreadId,
    threadTitle: Schema.String,
    /** The turn's ordinal in its thread. */
    turn: PositiveInt,
    /** The T3 run that made the turn: what `GameBuildRef`'s turn form names. */
    runId: Schema.String,
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
  /** Null when the change was not counted (no build before it to diff with): never shown as 0. */
  fileCount: Schema.NullOr(NonNegativeInt),
  /** False when its ref was pruned: listed for history, no play or restore. */
  available: Schema.Boolean,
  /** Why it cannot be played here (an engine with no Web build), else null. */
  noPlay: Schema.NullOr(Schema.String),
  /** Why it cannot be restored (a live run, a role thread), else null. */
  noRestore: Schema.NullOr(Schema.String),
  facts: GameBuildFactsSummary,
  /**
   * The build this one was made from: restoring it undoes this build. A turn's is
   * the build the folder held when the turn started (turn 1's: the thread's start
   * checkpoint, ordinal 0); a round's is its base; null when unknown.
   */
  base: Schema.NullOr(GameBuildId),
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

type Fact<A> =
  | { readonly status: "measured"; readonly value: A }
  | typeof GameFactNotMeasured.Type
  | typeof GameFactPending.Type;
type BotTier = typeof GameBotTier.Type;
type Liveness = typeof GameLiveness.Type;

const LABELS: Readonly<Record<GameFactId, string>> = {
  boots: "Boots",
  idle: "No input",
  masher: "Random input",
  skilled: "Tester's bot",
  "winnable-without-skill": "Winnable without skill",
  freeze: "Still stretches",
  motion: "Motion",
  detail: "Detail",
  colour: "Colour",
  "first-response": "First response",
};

const seconds = (s: number) => `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
const at = (tier: BotTier) => (tier.at === null ? "" : ` at ${seconds(tier.at)}`);

// What each tier's ending says about the game: an idle or random player that
// wins means no challenge, one that loses means there is pressure.
const tierText = (id: "idle" | "masher" | "skilled", tier: BotTier) => {
  const who = id === "idle" ? "With no input" : id === "masher" ? "Random input" : "The bot";
  switch (tier.ending) {
    case "won":
      return `${who} wins${at(tier)}`;
    case "lost":
      return `${who} loses${at(tier)}`;
    case "no-ending":
      return `${who}: no ending in ${seconds(tier.played)}`;
    case "crashed":
      return `Crashed${at(tier)}`;
    case "unresponsive":
      return `Stopped answering${at(tier)}`;
    case "did-not-boot":
      return "Did not boot";
  }
};
const tierTone = (id: "idle" | "masher" | "skilled", tier: BotTier): GameFactTone => {
  if (tier.ending === "crashed" || tier.ending === "unresponsive" || tier.ending === "did-not-boot")
    return "bad";
  if (id === "skilled") return tier.ending === "won" ? "good" : "neutral";
  return tier.ending === "won" ? "bad" : tier.ending === "lost" ? "good" : "neutral";
};

/** A bot run's evidence folder as display entries. */
const tierEvidence = (tier: BotTier): GameFactView["evidence"] =>
  tier.evidence === null
    ? []
    : [
        { kind: "video", label: "Run video", path: `${tier.evidence}/run.mp4` },
        { kind: "frame", label: "Last frame", path: `${tier.evidence}/frames/end.png` },
        { kind: "log", label: "Trace", path: `${tier.evidence}/trace.json` },
      ];

interface Reading {
  readonly text: string;
  readonly value: number | null;
  readonly tone: GameFactTone;
  /** What must match for two readings to be the same kind (an ending word, a verdict). */
  readonly kind: string;
}
type Read =
  | { readonly _tag: "measured"; readonly reading: Reading }
  | { readonly _tag: "not-measured"; readonly why: string }
  | { readonly _tag: "pending" };

const from = <A>(fact: Fact<A>, read: (value: A) => Reading): Read =>
  fact.status === "measured"
    ? { _tag: "measured", reading: read(fact.value) }
    : fact.status === "pending"
      ? { _tag: "pending" }
      : { _tag: "not-measured", why: fact.why };

const liveness = (facts: GameBuildFacts, read: (live: Liveness) => Reading) =>
  from(facts.liveness, read);

const readFact = (facts: GameBuildFacts, id: GameFactId): Read => {
  switch (id) {
    case "boots":
      return from(facts.boots, (boots) => ({
        text: boots.ok ? "Boots clean" : `Does not boot: ${boots.detail}`,
        value: null,
        tone: boots.ok ? "good" : "bad",
        kind: String(boots.ok),
      }));
    case "idle":
    case "masher":
    case "skilled": {
      const fact: Fact<BotTier> = facts[id];
      return from(fact, (tier) => ({
        text: tierText(id, tier),
        value: tier.at,
        tone: tierTone(id, tier),
        kind: tier.ending,
      }));
    }
    case "winnable-without-skill":
      return from(facts.winnableWithoutSkill, (yes) => ({
        text: yes ? "Won with no skill (no input or random input)" : "Needs skill to win",
        value: null,
        tone: yes ? "bad" : "good",
        kind: String(yes),
      }));
    case "freeze":
      return liveness(facts, (live) => ({
        text:
          live.freezes.length === 0
            ? "No still stretch of 2 s or more in play"
            : `${live.freezes.length} still stretch${live.freezes.length === 1 ? "" : "es"}, longest ${seconds(live.longestFreeze)}`,
        value: live.longestFreeze,
        tone: live.longestFreeze >= 3 ? "bad" : "good",
        kind: "freeze",
      }));
    case "motion":
      return liveness(facts, (live) => ({
        text:
          live.motion < 1
            ? `Almost no motion (${live.motion.toFixed(1)})`
            : `Motion ${live.motion.toFixed(1)}`,
        value: live.motion,
        tone: live.motion < 1 ? "bad" : "neutral",
        kind: "motion",
      }));
    case "detail":
      return liveness(facts, (live) => ({
        text: `Detail ${Math.round(live.detail)}`,
        value: live.detail,
        tone: "neutral",
        kind: "detail",
      }));
    case "colour":
      return liveness(facts, (live) => ({
        text: `One colour fills ${Math.round(live.dominantColour * 100)}%`,
        value: live.dominantColour,
        tone: live.dominantColour > 0.6 ? "bad" : "neutral",
        kind: "colour",
      }));
    case "first-response":
      return from(facts.firstResponse, (response) => ({
        text:
          response.seconds === null
            ? `No movement answered a held key within ${seconds(response.window)}`
            : `Moves ${response.seconds.toFixed(1)} s after a held key`,
        value: response.seconds,
        tone:
          response.seconds === null || response.seconds > 0.5
            ? "bad"
            : response.seconds <= 0.2
              ? "good"
              : "neutral",
        kind: response.seconds === null ? "none" : "moved",
      }));
  }
};

const evidenceOf = (facts: GameBuildFacts, id: GameFactId): GameFactView["evidence"] => {
  const tier = (fact: Fact<BotTier>) =>
    fact.status === "measured" ? tierEvidence(fact.value) : [];
  switch (id) {
    case "idle":
    case "masher":
    case "skilled":
      return tier(facts[id]);
    // Liveness and the first response are read from the random-input run.
    case "freeze":
    case "motion":
    case "detail":
    case "colour":
    case "first-response":
      return tier(facts.masher).filter((entry) => entry.kind === "video");
    default:
      return [];
  }
};

/**
 * PURE. A build's facts as display rows, in GameFactId order. The one wording
 * every surface and the agent tools share.
 */
export const gameFactsView = (facts: GameBuildFacts): ReadonlyArray<GameFactView> =>
  GameFactId.literals.map((id) => {
    const read = readFact(facts, id);
    return {
      id,
      label: LABELS[id],
      reading:
        read._tag === "measured"
          ? {
              _tag: "measured",
              text: read.reading.text,
              value: read.reading.value,
              tone: read.reading.tone,
            }
          : read._tag === "pending"
            ? { _tag: "pending" }
            : { _tag: "not-measured", why: read.why },
      evidence: read._tag === "measured" ? evidenceOf(facts, id) : [],
    };
  });

/** For these numbers lower is better; the other numbers are neutral. */
const LOWER_IS_BETTER: ReadonlySet<GameFactId> = new Set(["freeze", "colour", "first-response"]);
const BROKE: ReadonlySet<string> = new Set(["crashed", "unresponsive", "did-not-boot"]);
/** How good a reading's kind is, for the facts whose kinds have an order; null for the rest. */
const rank = (id: GameFactId, kind: string): number | null => {
  switch (id) {
    case "boots":
      return kind === "true" ? 1 : 0;
    case "winnable-without-skill":
      return kind === "false" ? 1 : 0;
    case "idle":
    case "masher":
      // A player that does nothing (or anything) should lose; winning means no challenge.
      return BROKE.has(kind) ? 0 : kind === "won" ? 1 : kind === "no-ending" ? 2 : 3;
    case "skilled":
      return BROKE.has(kind) ? 0 : kind === "won" ? 2 : 1;
    default:
      return null;
  }
};

const notComparable = (id: GameFactId, why: string, a: string | null, b: string | null) =>
  ({ id, label: LABELS[id], a, b, change: "not-comparable", tone: "neutral", why }) as const;

const sideWhy = (side: "A" | "B", read: Read) =>
  read._tag === "pending"
    ? `${side} is still measuring`
    : read._tag === "not-measured"
      ? `${side} not measured: ${read.why}`
      : "";

/**
 * PURE. The one diff of two builds' facts, shared by the compare view, the
 * round card and game_builds. A fact not measured on either side is
 * not-comparable with its reason, never "same".
 */
export const diffBuildFacts = (
  a: GameBuildFacts | null,
  b: GameBuildFacts | null,
): ReadonlyArray<GameFactDelta> =>
  GameFactId.literals.map((id): GameFactDelta => {
    if (a === null || b === null)
      return notComparable(id, `${a === null ? "A" : "B"} has never been measured`, null, null);
    const ra = readFact(a, id);
    const rb = readFact(b, id);
    const textA = ra._tag === "measured" ? ra.reading.text : null;
    const textB = rb._tag === "measured" ? rb.reading.text : null;
    if (ra._tag !== "measured" || rb._tag !== "measured")
      return notComparable(
        id,
        [sideWhy("A", ra), sideWhy("B", rb)].filter((why) => why !== "").join("; "),
        textA,
        textB,
      );
    if (a.harness !== b.harness)
      return notComparable(id, "measured by different versions of the harness", textA, textB);
    if (
      id === "skilled" &&
      a.skilled.status === "measured" &&
      b.skilled.status === "measured" &&
      a.skilled.value.bot.hash !== b.skilled.value.bot.hash
    )
      return notComparable(
        id,
        "the tester's bot changed between the two measurements",
        textA,
        textB,
      );
    const x = ra.reading;
    const y = rb.reading;
    const base = { id, label: LABELS[id], a: x.text, b: y.text, why: null };
    if (x.kind !== y.kind) {
      const before = rank(id, x.kind);
      const after = rank(id, y.kind);
      const tone =
        before === null || after === null || before === after
          ? "neutral"
          : after > before
            ? "better"
            : "worse";
      return { ...base, change: "changed", tone };
    }
    if (x.value === null || y.value === null || x.text === y.text)
      return { ...base, change: "same", tone: "neutral" };
    const change = y.value > x.value ? "up" : y.value < x.value ? "down" : "same";
    const tone =
      change === "same" || !LOWER_IS_BETTER.has(id)
        ? "neutral"
        : change === "down"
          ? "better"
          : "worse";
    return { ...base, change, tone };
  });

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
  /** A round's build of a stopped run becomes the run's best (Keep on its card). */
  asBest: Schema.optionalKey(Schema.Boolean),
});
/** Stops one build's play copy; the folder's own Play is never touched. */
export const GameBuildStopInput = Schema.Struct({ threadId: ThreadId, build: GameBuildRef });
export const GameBuildRestoreResult = Schema.Struct({
  requestId: Schema.String,
  done: Schema.Boolean,
  message: Schema.String,
});
