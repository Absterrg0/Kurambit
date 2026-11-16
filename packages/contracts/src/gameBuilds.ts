import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";
import { GameBuildId } from "./gameBuildId.ts";
import {
  GameQaReport,
  GameScreens,
  gameQaFindings,
  gameScreensFindings,
  gameScreensWords,
  listedNames,
  loadedWords,
} from "./gameQa.ts";
import { GameSavedPlaysReading, savedPlaysWords } from "./gamePlays.ts";

// GameBuildId has a module of its own so game.ts (GameStatus.buildPlays) can name
// it without importing this module, which would close an import cycle through gameBot.ts.
export { GameBuildId } from "./gameBuildId.ts";

/** Bounds of one measurement, the same for every engine. */
export const GAME_FACTS_BOUNDS = {
  /** No harness play uses it now; kept because the tier bots' bounds file still names it. */
  idleSeconds: 60,
  masherSeconds: 60,
  skilledSeconds: 60,
  startSeconds: 10,
} as const;

/**
 * Why a build's skilled fact was not measured: the play bot plays only when the person or
 * their agent asks to prove the game can be won, never as part of a build's measure.
 */
export const GAME_FACTS_SKILLED_DEFERRED =
  "not asked for: the play bot plays only when you or your agent ask to prove the game can be won";
/** The skilled fact of a game with no play bot yet. */
export const GAME_FACTS_NO_PLAY_BOT =
  "no play bot: ask your agent to prove the game can be won, and it writes one";

/** Push names on the game's operation stream: the list changed, or a build's facts did. */
export const GAME_BUILDS_EVENT = "builds";
export const GAME_FACTS_EVENT = "facts";
/** A push: files under the live-served folder changed and settled. Its message is "Changed <path>". */
export const GAME_LIVE_EVENT = "live";

/** How a keep-going step ended, as its record and the strip word it. */
export const GameStepVerdict = Schema.Literals([
  /** No watched fact got worse. */
  "kept",
  /** The run (or the person, before it) restored the step's base. */
  "undone",
  /** It regressed, but the game changed after it, so nothing was undone. */
  "kept-moved-on",
  /** The turn changed no game files. */
  "no-change",
  /** The facts could not be compared; kept, never undone. */
  "not-measured",
  /** The person stopped the step's turn. */
  "stopped",
]);
export type GameStepVerdict = typeof GameStepVerdict.Type;

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
    /** The keep-going step this turn was; null for a person's turn. */
    step: Schema.NullOr(
      Schema.Struct({
        n: PositiveInt,
        /** Null while the step is still being judged. */
        verdict: Schema.NullOr(GameStepVerdict),
        /** One plain line: "no fact got worse", "Random input now crashes at 12 s". */
        reason: Schema.String,
        /** What the step set out to change, in one line ("Make the moth flash before it dives"); empty when unknown. */
        move: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
      }),
    ),
  }),
  /**
   * One version of a "try it N ways" message, built in a child thread of its own. It owns Undo
   * once kept, as the turn the chat continues from.
   */
  Schema.TaggedStruct("version", {
    /** The chat the person asked in. */
    threadId: ThreadId,
    /** The try's own run in that chat. */
    runId: Schema.String,
    /** The person's request, first line, at most 140 characters. */
    request: Schema.String,
    n: PositiveInt,
    of: PositiveInt,
    /** The version's own one line on its approach; empty when it gave none. */
    approach: Schema.String,
    /** The try's newest keep names this version. */
    kept: Schema.Boolean,
  }),
  /** The folder before a restore, or a person's kept edit. */
  Schema.TaggedStruct("saved", {
    label: Schema.String,
    /** A person's edit kept as a build outside a turn: what it kept ("values": the Stage's Keep as a build). */
    edit: Schema.optionalKey(Schema.Literals(["values"])),
    /**
     * Its place among the game's saved builds with the same label, oldest 1: two builds tuned
     * on the Stage are "Tuned 1" and "Tuned 2". Absent on a saved build the server could not place.
     */
    nth: Schema.optionalKey(PositiveInt),
  }),
]);
export type GameBuildSource = typeof GameBuildSource.Type;

/** A build Undo belongs to while it is the game's newest: a chat turn's, or a person's kept edit. */
export const ownsUndo = (source: GameBuildSource) =>
  source._tag === "turn" ||
  (source._tag === "version" && source.kept) ||
  (source._tag === "saved" && source.edit !== undefined);

/** A saved build's label for what the folder held when a restore replaced it. */
export const RESTORE_BEFORE_LABEL = "The game before restore";

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

/**
 * The facts measured now, in display order: the shared names of the rail, compare, card and
 * tools. Only what a person acts on: does it start, does it play without errors, do the QA
 * play's controls, Retry and HUD hold, does it keep its frame rate, do the game's saved plays
 * still end the same, and (only when someone asks) can Kurambit's play bot win it.
 */
const MEASURED_FACT_IDS = [
  "boots",
  "errors",
  "controls",
  "retry",
  "hud",
  "performance",
  "screens",
  "saved-plays",
  "skilled",
] as const;
export type GameMeasuredFactId = (typeof MEASURED_FACT_IDS)[number];
const GAME_FACT_IDS: ReadonlyArray<GameMeasuredFactId> = MEASURED_FACT_IDS;
/**
 * A fact's id. Keep going's stored step records name facts no longer measured (rows nobody
 * acted on: endings with no or random input, motion, the scene report's rows, asset counts),
 * so their ids still decode; nothing reads or diffs them.
 */
export const GameFactId = Schema.Literals([
  ...MEASURED_FACT_IDS,
  "idle",
  "masher",
  "motion",
  "detail",
  "first-response",
  "assets",
  "use",
  "player-view",
  "empty",
  "buried",
  "clipping",
  "fell",
  "camera",
  "sliding",
  "unseen",
  "winnable-without-skill",
  "freeze",
  "colour",
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
  /** Measured facts that read good and bad: the build card's two marks. */
  good: NonNegativeInt,
  bad: NonNegativeInt,
  /**
   * The lead checks, the rows a build's detail shows first: how many pass, of
   * how many. Every surface says a build's checks in these words, so none
   * disagrees. Absent on summaries counted before it existed.
   */
  lead: Schema.optionalKey(
    Schema.Struct({
      pass: NonNegativeInt,
      of: NonNegativeInt,
      /**
       * Which lead checks have a reading and which of those pass, so two builds are compared
       * only on the checks both measured. Absent on summaries counted before it existed.
       */
      measured: Schema.optionalKey(Schema.Array(GameFactId)),
      passing: Schema.optionalKey(Schema.Array(GameFactId)),
    }),
  ),
});
export type GameBuildFactsSummary = typeof GameBuildFactsSummary.Type;

export const GameBuild = Schema.Struct({
  id: GameBuildId,
  at: IsoDateTime,
  source: GameBuildSource,
  /**
   * Its place in the game's one sequence of builds, oldest 1: a chat's turn, a keep-going step
   * and values kept from the Stage all count, so it never moves as older pages load. Null for a
   * restore's parked folder (named by its label).
   */
  number: Schema.NullOr(PositiveInt),
  /**
   * A small fix the agent folded into the build before it: it keeps that build's number and
   * is its `fix`th fix. Absent on a build of its own.
   */
  fix: Schema.optionalKey(PositiveInt),
  summary: Schema.String,
  /** At most 8, most changed first. */
  files: Schema.Array(GameBuildFile),
  /** Null when the change was not counted (no build before it to diff with): never shown as 0. */
  fileCount: Schema.NullOr(NonNegativeInt),
  /** False when its ref was pruned: listed for history, no play or restore. */
  available: Schema.Boolean,
  /** Why it cannot be played here (an engine with no Web build), else null. */
  noPlay: Schema.NullOr(Schema.String),
  /** Why it cannot be restored, else null. */
  noRestore: Schema.NullOr(Schema.String),
  facts: GameBuildFactsSummary,
  /**
   * A frame of the build playing, game-relative: a facts play's own screen
   * (the random-input run's, else the no-input run's). Null before a play kept
   * one; the file may since have been cleaned up with the logs.
   */
  still: Schema.NullOr(Schema.String),
  /**
   * The build this one was made from: restoring it undoes this build. A turn's is
   * the build the folder held when the turn started (turn 1's: the thread's start
   * checkpoint, ordinal 0); null when unknown.
   */
  base: Schema.NullOr(GameBuildId),
});
export type GameBuild = typeof GameBuild.Type;

/**
 * What kept a fact from being measured, where that changes what a person is told or what the
 * harness does next; other reasons are the build's or the tool's own and say so in `why`.
 * - software: the harness's browser draws without a GPU here, so plays say nothing about the game.
 * - busy: other work held the machine; the next measure takes it again.
 * - slow: the game itself ran below real time on an idle machine (a step can make it faster).
 * - old-shell: the game's copy of the shell predates this measurement; a new build adds it.
 * - no-play-bot: the game has no play bot to measure skilled play with.
 * - deferred: the play bot plays only when the person or their agent asks for it.
 * - no-saved-plays: the game had no saved play to replay. Such a fact is not shown at all.
 */
export const GameFactNotMeasuredCause = Schema.Literals([
  "software",
  "busy",
  "slow",
  "old-shell",
  "no-play-bot",
  "deferred",
  "no-saved-plays",
]);
export type GameFactNotMeasuredCause = typeof GameFactNotMeasuredCause.Type;

export const GameFactNotMeasured = Schema.Struct({
  status: Schema.Literal("not-measured"),
  /** For agents and logs: the full reason, with the machine's figures. */
  why: Schema.String,
  /** Absent on a reason that is the build's own, and on facts stored before causes existed. */
  cause: Schema.optionalKey(GameFactNotMeasuredCause),
  /** Waiting can clear it (a tool or the machine): the next measure tries again. */
  retry: Schema.Boolean,
  /** A tool or the machine that waiting will not fix (a missing program, a game too slow to play here). */
  standing: Schema.optionalKey(Schema.Literal(true)),
});
export const GameFactPending = Schema.Struct({ status: Schema.Literal("pending") });
const gameFact = <S extends Schema.Top>(value: S) =>
  Schema.Union([
    Schema.Struct({ status: Schema.Literal("measured"), value }),
    GameFactNotMeasured,
    GameFactPending,
  ]);

/** How many paths each of the use fact's lists holds. */
export const GAME_ASSET_USE_CAP = 64;
const UsePaths = Schema.Array(Schema.String).check(Schema.isMaxLength(GAME_ASSET_USE_CAP));

/** Generations whose bytes a build ships, and whether its plays loaded them. */
export const GameGenerationUse = Schema.Array(
  Schema.Struct({ id: Schema.String, loaded: Schema.Boolean }),
).check(Schema.isMaxLength(GAME_ASSET_USE_CAP));
export type GameGenerationUse = typeof GameGenerationUse.Type;

/**
 * What the plays used of the files the game ships: measured from the running game, never claimed.
 * Library files ASSETS.md credits are left out; everything else under the engine's assets
 * folder counts (exported, imported and generated art, sounds).
 */
export const GameAssetUse = Schema.Struct({
  /** Game-relative files some play loaded, path order. */
  used: UsePaths,
  /** Files the game ships that no play loaded; filled before `used` reaches its cap. */
  unused: UsePaths,
  /** Sound files that started playing above silence during the plays. */
  played: UsePaths,
  /** Sound files loaded that never started playing. */
  silent: UsePaths,
  /** Used and unused files past the caps, counted only. */
  more: NonNegativeInt,
  /**
   * Generations of this build (their records under art/generated/) whose delivered bytes are
   * also a shipped file, joined by content hash: loaded when some play loaded such a file.
   * A generation missing here ships no file with its bytes (a Blender export rewrites them).
   */
  generations: Schema.optionalKey(GameGenerationUse),
});
export type GameAssetUse = typeof GameAssetUse.Type;

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
  bot: Schema.Struct({ file: Schema.String, hash: Schema.String }),
  /** The bot's own end word when the game reported no result. */
  botWord: Schema.NullOr(Schema.String),
});
/**
 * How the random-input play ran, as the game's shell measured it while the harness
 * played (three.js): play's frame rate, its 1% low, the GPU's time per frame and the
 * render scale the look settled on, at the play's canvas size, and what a frame draws.
 */
export const GamePerformance = Schema.Struct({
  /**
   * Frames per second from the median frame time. Null when the play drew in software, where
   * frame times say nothing about a game; what a frame draws is still the game's own.
   */
  fps: Schema.NullOr(Schema.Number),
  /** Frames per second over the slowest 1% of frames; null with `fps`. */
  low1: Schema.NullOr(Schema.Number),
  /** The GPU's median milliseconds per frame (timer queries); null where the browser has none. */
  gpuMs: Schema.NullOr(Schema.Number),
  /** The median render scale: the share of the canvas's pixels per side the frame was drawn at. */
  scale: Schema.NullOr(Schema.Number),
  width: NonNegativeInt,
  height: NonNegativeInt,
  frames: NonNegativeInt,
  /**
   * The median frame's draw calls and triangles (renderer.info, sampled through play): why a
   * frame costs what it does. Absent on readings from before they were kept.
   */
  drawCalls: Schema.optionalKey(NonNegativeInt),
  triangles: Schema.optionalKey(NonNegativeInt),
});
export type GamePerformance = typeof GamePerformance.Type;

export const GameBuildFacts = Schema.Struct({
  build: GameBuildId,
  /** The content key the facts are cached by (the engine project's tree) and the harness that measured them. */
  key: Schema.String,
  harness: Schema.String,
  state: GameFactsState,
  measuredAt: Schema.NullOr(IsoDateTime),
  /** The renderer the plays drew with, when it differs from what the export ships ("Compatibility; native exports draw Forward+"). */
  renderer: Schema.NullOr(Schema.String),
  /**
   * The Kurambit runtime the plays loaded ("three 1.0.0+3f2a9c1d0b7e"), so a change a runtime
   * update made reads apart from the game's own; absent for a game that carries its own copy.
   */
  runtime: Schema.optionalKey(Schema.String),
  boots: gameFact(Schema.Struct({ ok: Schema.Boolean, detail: Schema.String })),
  /** The random-input play: whether it crashes or stops answering (errors), and its frame times. */
  masher: gameFact(GameBotTier),
  /** Kurambit's play bot, only when the person or their agent asks to prove it can be won. */
  skilled: gameFact(GameSkilledTier),
  /** Measured during the random-input play: frame rate, 1% low, GPU time, render scale, draw calls and triangles. */
  performance: gameFact(GamePerformance).pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        status: "not-measured" as const,
        why: "measured before performance was measured",
        retry: false,
      }),
    ),
  ),
  /**
   * Measured during the plays: which shipped files the game loaded and which sounds played. No
   * row: the generation cards read which generations a build loaded (`latestUse`).
   */
  use: gameFact(GameAssetUse).pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        status: "not-measured" as const,
        why: "measured before asset use was measured",
        retry: false,
      }),
    ),
  ),
  /**
   * The QA play (three.js), from the build's boot check: every declared control answers, Retry
   * starts a clean run, the HUD stays on screen, and pressing controls throws nothing.
   */
  qa: gameFact(GameQaReport).pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        status: "not-measured" as const,
        why: "measured before the QA play existed",
        retry: false,
      }),
    ),
  ),
  /**
   * From the build's boot check (three.js), after the QA play: the game at phone portrait and
   * at widescreen, and what its page downloads to start.
   */
  screens: gameFact(GameScreens).pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        status: "not-measured" as const,
        why: "measured before other screen sizes were checked",
        retry: false,
      }),
    ),
  ),
  /** The game's saved plays (.studio/plays), each replayed on the build in its copy. */
  savedPlays: gameFact(GameSavedPlaysReading).pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        status: "not-measured" as const,
        why: "no saved play was replayed on this build",
        cause: "no-saved-plays" as const,
        retry: false,
      }),
    ),
  ),
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
    Schema.TaggedStruct("not-measured", {
      why: Schema.String,
      cause: Schema.optionalKey(GameFactNotMeasuredCause),
    }),
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

const LABELS: Readonly<Record<GameFactId, string>> = {
  boots: "Boots",
  errors: "Errors in play",
  controls: "Controls",
  retry: "Retry",
  hud: "HUD",
  idle: "No input",
  masher: "Random input",
  skilled: "Kurambit's play bot",
  "winnable-without-skill": "Winnable without skill",
  freeze: "Still stretches",
  motion: "Motion",
  detail: "Detail",
  colour: "Colour",
  "first-response": "First response",
  performance: "Performance",
  screens: "Screens",
  "saved-plays": "Saved plays",
  assets: "Assets",
  use: "Asset use",
  "player-view": "Player in view",
  empty: "Empty view",
  buried: "Buried",
  clipping: "Clipping",
  fell: "Out of the world",
  camera: "Camera",
  sliding: "Sliding",
  unseen: "Never on screen",
};

const seconds = (s: number) => `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
const at = (tier: BotTier) => (tier.at === null ? "" : ` at ${seconds(tier.at)}`);

/** Kurambit's play bot's ending; a run that broke is the errors check's, so it is counted once. */
const tierText = (tier: BotTier) => {
  switch (tier.ending) {
    case "won":
      return `Kurambit's play bot wins${at(tier)}`;
    case "lost":
      return `Kurambit's play bot loses${at(tier)}`;
    case "no-ending":
      return `Kurambit's play bot: no ending in ${seconds(tier.played)}`;
    case "crashed":
      return `Crashed${at(tier)}`;
    case "unresponsive":
      return `Stopped answering${at(tier)}`;
    case "did-not-boot":
      return "Did not boot";
  }
};

/** A bot run's evidence folder as display entries. */
const tierEvidence = (tier: BotTier): GameFactView["evidence"] =>
  tier.evidence === null
    ? []
    : [
        { kind: "video", label: "Run video", path: `${tier.evidence}/run.mp4` },
        { kind: "frame", label: "Last frame", path: `${tier.evidence}/frames/frame-end.png` },
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
  | {
      readonly _tag: "not-measured";
      readonly why: string;
      readonly cause?: GameFactNotMeasuredCause;
    }
  | { readonly _tag: "pending" };
const unmeasured = (fact: typeof GameFactNotMeasured.Type): Read => ({
  _tag: "not-measured",
  why: fact.why,
  ...(fact.cause === undefined ? {} : { cause: fact.cause }),
});

const from = <A>(fact: Fact<A>, read: (value: A) => Reading): Read =>
  fact.status === "measured"
    ? { _tag: "measured", reading: read(fact.value) }
    : fact.status === "pending"
      ? { _tag: "pending" }
      : unmeasured(fact);

const BROKE_ENDINGS: ReadonlySet<string> = new Set(["crashed", "unresponsive", "did-not-boot"]);
/** The plays that can show the game breaking, the one most likely to first. */
const PLAYS = [
  ["masher", "with random input"],
  ["skilled", "by Kurambit's play bot"],
] as const;
/** The first play that broke (crashed, stopped answering, did not start), with who played it. */
const brokenPlay = (facts: GameBuildFacts) => {
  for (const [id, who] of PLAYS) {
    const fact: Fact<BotTier> = facts[id];
    if (fact.status === "measured" && BROKE_ENDINGS.has(fact.value.ending))
      return { id, who, tier: fact.value };
  }
  return null;
};
const brokeText = (tier: BotTier) =>
  tier.ending === "crashed"
    ? "Crashed"
    : tier.ending === "unresponsive"
      ? "Stopped answering"
      : "Did not start";

/** No errors while playing: no play broke, and pressing every control threw nothing. */
const readErrors = (facts: GameBuildFacts): Read => {
  const broke = brokenPlay(facts);
  if (broke !== null)
    return measured({
      text: `${brokeText(broke.tier)}${at(broke.tier)} when played ${broke.who}`,
      value: broke.tier.at,
      tone: "bad",
      kind: "broke",
    });
  const thrown = facts.qa.status === "measured" ? (facts.qa.value.errors ?? []) : [];
  const first = thrown[0];
  if (first !== undefined)
    return measured({
      text: `Throws while playing: ${first}${thrown.length > 1 ? ` (+${thrown.length - 1} more)` : ""}`,
      value: thrown.length,
      tone: "bad",
      kind: "throws",
    });
  // The random-input play is the long one: without it nothing says the game plays clean.
  if (facts.masher.status === "pending") return { _tag: "pending" };
  if (facts.masher.status !== "measured") return unmeasured(facts.masher);
  const played = PLAYS.reduce((sum, [id]) => {
    const fact: Fact<BotTier> = facts[id];
    return sum + (fact.status === "measured" ? fact.value.played : 0);
  }, 0);
  return measured({
    text: `No errors in ${seconds(played)} of play${facts.qa.status === "measured" ? " or pressing every control" : ""}`,
    value: null,
    tone: "good",
    kind: "clean",
  });
};

const fromQa = (
  facts: GameBuildFacts,
  read: (report: GameQaReport, found: ReturnType<typeof gameQaFindings>) => Read,
): Read =>
  facts.qa.status === "measured"
    ? read(facts.qa.value, gameQaFindings(facts.qa.value))
    : facts.qa.status === "pending"
      ? { _tag: "pending" }
      : unmeasured(facts.qa);

const readFact = (facts: GameBuildFacts, id: GameMeasuredFactId): Read => {
  switch (id) {
    case "boots":
      return from(facts.boots, (boots) => ({
        text: boots.ok ? "Boots clean" : `Does not boot: ${boots.detail}`,
        value: null,
        tone: boots.ok ? "good" : "bad",
        kind: String(boots.ok),
      }));
    case "skilled":
      // Only a win proves something: that the game can be won.
      return from(facts.skilled, (tier) => ({
        text: tierText(tier),
        value: tier.at,
        tone: tier.ending === "won" ? "good" : "neutral",
        kind: tier.ending,
      }));
    case "errors":
      return readErrors(facts);
    case "controls":
      return fromQa(facts, (report, found): Read => {
        if (report.controls.length === 0)
          return {
            _tag: "not-measured",
            why: "the QA play pressed no control: none declared, or no run started",
          };
        if (found.dead.length > 0)
          return measured({
            text: `${listedNames(found.dead)} ${found.dead.length === 1 ? "is" : "are"} never read: pressing ${found.dead.length === 1 ? "it does" : "them does"} nothing`,
            value: found.dead.length,
            tone: "bad",
            kind: "dead",
          });
        return measured({
          text:
            found.silent.length === 0
              ? `All ${report.controls.length} controls answer a press`
              : `All ${report.controls.length} controls are read by the game`,
          value: 0,
          tone: "good",
          kind: "clean",
        });
      });
    case "retry":
      return fromQa(facts, (report, found): Read => {
        if (report.retry === null)
          return { _tag: "not-measured", why: "the QA play could not start a run to end" };
        if (!found.retried)
          return { _tag: "not-measured", why: "the run did not end and start again in time" };
        const first = found.retry[0];
        return measured(
          first === undefined
            ? { text: "Retry starts a clean run", value: 0, tone: "good", kind: "clean" }
            : {
                text: `${first.said}${found.retry.length > 1 ? ` (+${found.retry.length - 1} more)` : ""}`,
                value: found.retry.length,
                tone: "bad",
                kind: "leaks",
              },
        );
      });
    case "hud":
      return fromQa(facts, (report, found): Read => {
        if (report.hud.length === 0)
          return { _tag: "not-measured", why: "the HUD could not be read" };
        const first = found.hud[0];
        return measured(
          first === undefined
            ? {
                text: `HUD stays on screen at ${report.hud.map((size) => `${size.width}×${size.height}`).join(" and ")}`,
                value: 0,
                tone: "good",
                kind: "clean",
              }
            : {
                text: `${first.said}${found.hud.length > 1 ? ` (+${found.hud.length - 1} more)` : ""}`,
                value: found.hud.length,
                tone: "bad",
                kind: "off",
              },
        );
      });
    case "saved-plays":
      return from(facts.savedPlays, (reading) => {
        const off = reading.plays.filter((play) => play.reading !== "same");
        // A changed ending, or a play the build can no longer replay, is what a person acts on;
        // a play that moved but ends the same may be the change they asked for.
        const broke = off.some((play) => play.reading !== "plays-differently");
        return {
          text: savedPlaysWords(reading),
          value: off.length,
          tone: off.length === 0 ? "good" : broke ? "bad" : "neutral",
          kind: off.length === 0 ? "same" : broke ? "changed" : "differs",
        };
      });
    case "performance":
      return from(facts.performance, (perf) => {
        const ms = (x: number) => (x < 10 ? x.toFixed(1) : String(Math.round(x)));
        const scale = perf.scale === null ? "" : ` at ${Number(perf.scale.toFixed(2))}×`;
        const counts = drawCounts(perf);
        if (perf.fps === null || perf.low1 === null)
          return {
            text: ["Frame rate not measured (drawn in software)", ...counts].join(" · "),
            value: null,
            tone: "neutral",
            kind: "software",
          };
        const text = [
          [
            `${Math.round(perf.fps)} fps`,
            `1% low ${Math.round(perf.low1)}`,
            ...(perf.gpuMs === null ? [] : [`GPU ${ms(perf.gpuMs)} ms`]),
          ]
            .join(" · ")
            .concat(`${scale} of ${perf.width}×${perf.height}`),
          ...counts,
        ].join(" · ");
        // Whole frames: a tenth of a frame is the machine's noise, never better or worse.
        return {
          text,
          value: Math.round(perf.fps),
          tone: perf.fps >= 55 && perf.low1 >= 30 ? "good" : perf.fps < 30 ? "bad" : "neutral",
          kind: "performance",
        };
      });
    case "screens":
      return from(facts.screens, (report) => {
        const words = gameScreensWords(report);
        return {
          text: words.text,
          value: words.broken,
          tone: words.broken === 0 ? "good" : "bad",
          kind: words.broken === 0 ? "fits" : "breaks",
        };
      });
  }
};

/** "1,900 draw calls", "2.1M triangles": the counts a reading kept, for its row. */
const drawCounts = (perf: GamePerformance): ReadonlyArray<string> => {
  const big = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 10_000
        ? `${Math.round(n / 1000)}k`
        : n.toLocaleString("en-US");
  return [
    ...(perf.drawCalls === undefined
      ? []
      : [`${perf.drawCalls.toLocaleString("en-US")} draw call${perf.drawCalls === 1 ? "" : "s"}`]),
    ...(perf.triangles === undefined ? [] : [`${big(perf.triangles)} triangles`]),
  ];
};

const measured = (reading: Reading): Read => ({ _tag: "measured", reading });
const evidenceOf = (facts: GameBuildFacts, id: GameMeasuredFactId): GameFactView["evidence"] => {
  switch (id) {
    case "skilled":
      return facts.skilled.status === "measured" ? tierEvidence(facts.skilled.value) : [];
    case "errors": {
      const broke = brokenPlay(facts);
      return broke === null ? [] : tierEvidence(broke.tier);
    }
    case "screens": {
      if (facts.screens.status !== "measured") return [];
      // The sizes that broke show first; with none broken, each size's frame.
      const broke = new Set(gameScreensFindings(facts.screens.value).map((found) => found.size));
      const sizes = facts.screens.value.sizes.filter(
        (size) => broke.size === 0 || broke.has(size.name),
      );
      return sizes.flatMap((size) =>
        size.frame === null
          ? []
          : [
              {
                kind: "frame" as const,
                label: `At ${size.width}×${size.height}`,
                path: size.frame,
              },
            ],
      );
    }
    default:
      return [];
  }
};

/** A game with no saved play has no Saved plays fact: none is shown, compared or counted. */
export const noSavedPlays = (facts: Pick<GameBuildFacts, "savedPlays">): boolean =>
  facts.savedPlays.status === "not-measured" && facts.savedPlays.cause === "no-saved-plays";
const shownIds = (facts: GameBuildFacts) =>
  noSavedPlays(facts) ? GAME_FACT_IDS.filter((id) => id !== "saved-plays") : GAME_FACT_IDS;

/**
 * PURE. A build's facts as display rows, in GameFactId order. The one wording
 * every surface and the agent tools share.
 */
export const gameFactsView = (facts: GameBuildFacts): ReadonlyArray<GameFactView> =>
  shownIds(facts).map((id) => {
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
            : {
                _tag: "not-measured",
                why: read.why,
                ...(read.cause === undefined ? {} : { cause: read.cause }),
              },
      evidence: read._tag === "measured" ? evidenceOf(facts, id) : [],
    };
  });

/**
 * The checks a person reads first, in order: what a player would hit. Does it start, does it
 * play without errors, does every control work, does Retry start clean, does the HUD fit, does
 * it hold its frame rate, and can it be won at all. Each is measured, never a taste call;
 * every other fact is a further measurement.
 */
export const GAME_LEAD_FACTS = [
  "boots",
  "errors",
  "controls",
  "retry",
  "hud",
  "performance",
  "screens",
  "saved-plays",
  "skilled",
] as const satisfies ReadonlyArray<GameMeasuredFactId>;

/** A lead fact as a check: one plain sentence, its value apart for the right edge. */
export interface GameCheck extends GameFactView {
  readonly sentence: string;
  /** The reading's number or time ("at 4.4 s", "60 fps"); null when the sentence says it all. */
  readonly value: string | null;
  /** A measured bot run's ending; null for every other fact. */
  readonly ending: typeof GameBotEnding.Type | null;
}

export interface GameChecksView {
  readonly checks: ReadonlyArray<GameCheck>;
  /** Measured facts reading good and bad, over every fact: the build card's two counts. */
  readonly pass: number;
  readonly toLook: number;
}

const CHECK_LABELS: Readonly<
  Record<(typeof GAME_LEAD_FACTS)[number], string> & Partial<Record<GameFactId, string>>
> = {
  boots: "Starts without errors",
  errors: "No errors while playing",
  controls: "Every control works",
  retry: "Retry starts clean",
  hud: "HUD fits the screen",
  performance: "Holds its frame rate",
  screens: "Fits phone and widescreen",
  "saved-plays": "Saved plays end the same",
  skilled: "Can be won by Kurambit's play bot",
};

/**
 * A fact's one name for people, as the Inspector's checks call it: the lead
 * checks by their check's words, every other fact by its label. The compare
 * view names its rows with it, so a fact is never called two things.
 */
export const gameFactName = (id: GameFactId): string => CHECK_LABELS[id] ?? LABELS[id];

const atTime = (tier: BotTier) => (tier.at === null ? null : `at ${seconds(tier.at)}`);

/** A bot tier's ending as a check: who played and what it came to. */
const tierCheck = (
  who: "with random input" | "by Kurambit's play bot",
  tier: BotTier,
): { sentence: string; value: string | null } => {
  switch (tier.ending) {
    case "won":
      return { sentence: "Can be won by Kurambit's play bot", value: atTime(tier) };
    case "lost":
      return { sentence: "Kurambit's play bot loses", value: atTime(tier) };
    case "no-ending":
      return {
        sentence: "Kurambit's play bot finds no ending",
        value: `in ${seconds(tier.played)}`,
      };
    case "crashed":
      return { sentence: `Crashes when played ${who}`, value: atTime(tier) };
    case "unresponsive":
      return { sentence: `Stops answering when played ${who}`, value: atTime(tier) };
    case "did-not-boot":
      return { sentence: "Does not start", value: null };
  }
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * A measured fact as a person judges it, in a sentence. Only the facts the
 * readings already tone get a verdict; the rest say what was found, so a
 * neutral number never reads as better or worse.
 */
const checkWords = (
  facts: GameBuildFacts,
  id: GameFactId,
): { sentence: string; value: string | null } | null => {
  switch (id) {
    case "boots":
      return facts.boots.status !== "measured"
        ? null
        : facts.boots.value.ok
          ? { sentence: "Starts without errors", value: null }
          : // The check's name, as every check has one; what stopped it is in the row's
            // tooltip and on the Stage's error bar.
            { sentence: "Does not start", value: null };
    case "skilled": {
      if (facts.skilled.status !== "measured") return null;
      const tier = facts.skilled.value;
      // Only a win proves the game can be won; anything short of one leaves it unproven.
      if (tier.ending === "won" || BROKE_ENDINGS.has(tier.ending))
        return tierCheck("by Kurambit's play bot", tier);
      return {
        sentence: "Not yet proven winnable",
        value:
          tier.ending === "lost"
            ? `Kurambit's play bot loses${tier.at === null ? "" : ` at ${seconds(tier.at)}`}`
            : `Kurambit's play bot found no ending in ${seconds(tier.played)}`,
      };
    }
    case "errors": {
      const broke = brokenPlay(facts);
      if (broke !== null)
        return {
          sentence:
            broke.tier.ending === "crashed"
              ? "Crashes while playing"
              : broke.tier.ending === "unresponsive"
                ? "Stops answering while playing"
                : "Does not start for a play",
          value: [broke.who, atTime(broke.tier)].filter((part) => part !== null).join(" "),
        };
      const thrown = facts.qa.status === "measured" ? (facts.qa.value.errors ?? []) : [];
      return thrown.length > 0
        ? { sentence: "Throws errors while playing", value: plural(thrown.length, "error") }
        : { sentence: "No errors while playing", value: null };
    }
    case "controls": {
      if (facts.qa.status !== "measured") return null;
      const found = gameQaFindings(facts.qa.value);
      return found.dead.length === 1
        ? { sentence: `${found.dead[0]} does nothing`, value: null }
        : found.dead.length > 1
          ? { sentence: `${found.dead.length} controls do nothing`, value: listedNames(found.dead) }
          : {
              sentence: "Every control works",
              // Read, but answered nothing the play could see, as one that works only in some
              // places does too: the person's to try, never a failure.
              value: found.silent.length === 0 ? null : `${found.silent.length} to try yourself`,
            };
    }
    case "retry": {
      if (facts.qa.status !== "measured") return null;
      const found = gameQaFindings(facts.qa.value);
      return found.retry.length === 0
        ? { sentence: "Retry starts clean", value: null }
        : {
            sentence: "Retry keeps the last run's leftovers",
            value: plural(found.retry.length, "problem"),
          };
    }
    case "hud": {
      if (facts.qa.status !== "measured") return null;
      const found = gameQaFindings(facts.qa.value);
      const off = facts.qa.value.hud.find((size) => size.off.length > 0);
      return found.hud.length === 0
        ? { sentence: "HUD fits the screen", value: null }
        : off !== undefined
          ? { sentence: "HUD runs off the screen", value: `at ${off.width}×${off.height}` }
          : { sentence: "HUD text overlaps", value: plural(found.hud.length, "place") };
    }
    case "saved-plays": {
      if (facts.savedPlays.status !== "measured") return null;
      const reading = facts.savedPlays.value;
      const off = reading.plays.filter((play) => play.reading !== "same");
      if (off.length === 0) return { sentence: "Saved plays end the same", value: null };
      const ended = off.filter((play) => play.reading === "ending-changed").length;
      const cannot = off.filter((play) => play.reading === "cannot-replay").length;
      return {
        sentence:
          ended > 0
            ? `${plural(ended, "saved play")} ${ended === 1 ? "ends" : "end"} differently`
            : cannot > 0
              ? `${plural(cannot, "saved play")} can't replay`
              : `${plural(off.length, "saved play")} ${off.length === 1 ? "plays" : "play"} differently`,
        value: `${reading.plays.length - off.length} of ${reading.plays.length} the same`,
      };
    }
    case "performance": {
      if (facts.performance.status !== "measured") return null;
      const perf = facts.performance.value;
      if (perf.fps === null || perf.low1 === null)
        return {
          sentence: "Frame rate not measured here",
          value: drawCounts(perf).join(" · ") || null,
        };
      const fps = `${Math.round(perf.fps)} fps`;
      return perf.fps >= 55 && perf.low1 >= 30
        ? { sentence: "Holds its frame rate", value: fps }
        : perf.fps < 30
          ? { sentence: "Runs slowly", value: fps }
          : { sentence: "Frame rate dips", value: `${fps} · 1% low ${Math.round(perf.low1)}` };
    }
    case "screens": {
      if (facts.screens.status !== "measured") return null;
      const report = facts.screens.value;
      const found = gameScreensFindings(report);
      const loads = report.bytes === null ? null : loadedWords(report.bytes);
      if (found.length === 0) return { sentence: "Fits phone and widescreen", value: loads };
      const sizes = new Set(found.map((each) => each.size));
      return {
        sentence:
          sizes.size > 1
            ? "Breaks on phone and widescreen"
            : sizes.has("phone")
              ? "Breaks at phone size"
              : "Breaks on widescreen",
        value: [...new Set(found.map((each) => each.short))].join(", "),
      };
    }
    default:
      return null;
  }
};

/**
 * PURE. A build's facts as a person reads them: the checks in plain
 * sentences. The same readings and tones as `gameFactsView`; only the words differ.
 */
export const gameChecksView = (facts: GameBuildFacts): GameChecksView => {
  const views = gameFactsView(facts);
  const asCheck = (view: GameFactView): GameCheck => {
    const words = view.reading._tag === "measured" ? checkWords(facts, view.id) : null;
    // Winning is never claimed before the play bot has won.
    const fallback =
      view.reading._tag === "measured"
        ? view.reading.text
        : view.id === "skilled"
          ? "Not yet proven winnable"
          : (CHECK_LABELS[view.id] ?? view.label);
    const run = view.id === "skilled" ? facts.skilled : null;
    return {
      ...view,
      sentence: words?.sentence ?? fallback,
      value: words?.value ?? null,
      ending: run?.status === "measured" ? run.value.ending : null,
    };
  };
  const checks = GAME_LEAD_FACTS.flatMap((id) => {
    const view = views.find((entry) => entry.id === id);
    return view === undefined ? [] : [asCheck(view)];
  });
  const tone = (wanted: GameFactTone) =>
    views.filter((view) => view.reading._tag === "measured" && view.reading.tone === wanted).length;
  return {
    checks,
    pass: tone("good"),
    toLook: tone("bad"),
  };
};

/** For these numbers lower is better, for these higher; the other numbers are neutral. */
const LOWER_IS_BETTER: ReadonlySet<GameFactId> = new Set([
  "controls",
  "retry",
  "hud",
  "screens",
  "saved-plays",
]);
const HIGHER_IS_BETTER: ReadonlySet<GameFactId> = new Set(["performance"]);
const BROKE = BROKE_ENDINGS;
/** How good a reading's kind is, for the facts whose kinds have an order; null for the rest. */
const rank = (id: GameFactId, kind: string): number | null => {
  switch (id) {
    case "boots":
      return kind === "true" ? 1 : 0;
    case "errors":
    case "controls":
    case "retry":
    case "hud":
      return kind === "clean" ? 1 : 0;
    case "screens":
      return kind === "fits" ? 1 : 0;
    case "skilled":
      return BROKE.has(kind) ? 0 : kind === "won" ? 2 : 1;
    case "saved-plays":
      return kind === "same" ? 2 : kind === "differs" ? 1 : 0;
    default:
      return null;
  }
};

const notComparable = (id: GameFactId, why: string, a: string | null, b: string | null) =>
  ({ id, label: LABELS[id], a, b, change: "not-comparable", tone: "neutral", why }) as const;

const sideWhy = (side: string, read: Read) =>
  read._tag === "pending"
    ? `${side} had not finished measuring`
    : read._tag === "not-measured"
      ? `${side} not measured: ${read.why}`
      : "";

/** What a reason calls each build: A and B where both are on screen, words where they are not. */
export interface BuildSides {
  readonly a: string;
  readonly b: string;
}

/**
 * PURE. The one diff of two builds' facts, shared by the compare view,
 * game_builds and keep going's judge. A fact not measured on either side is
 * not-comparable with its reason, never "same".
 */
export const diffBuildFacts = (
  a: GameBuildFacts | null,
  b: GameBuildFacts | null,
  sides: BuildSides = { a: "A", b: "B" },
): ReadonlyArray<GameFactDelta> =>
  GAME_FACT_IDS.flatMap((id): ReadonlyArray<GameFactDelta> => {
    // Saved plays are compared only once some were replayed on either side.
    if (id === "saved-plays" && (a === null || noSavedPlays(a)) && (b === null || noSavedPlays(b)))
      return [];
    return [diffFact(id, a, b, sides)];
  });

const diffFact = (
  id: GameMeasuredFactId,
  a: GameBuildFacts | null,
  b: GameBuildFacts | null,
  sides: BuildSides,
): GameFactDelta => {
  if (a === null || b === null)
    return notComparable(
      id,
      `${a === null ? sides.a : sides.b} has never been measured`,
      null,
      null,
    );
  const ra = readFact(a, id);
  const rb = readFact(b, id);
  const textA = ra._tag === "measured" ? ra.reading.text : null;
  const textB = rb._tag === "measured" ? rb.reading.text : null;
  if (ra._tag !== "measured" || rb._tag !== "measured")
    return notComparable(
      id,
      [sideWhy(sides.a, ra), sideWhy(sides.b, rb)].filter((why) => why !== "").join("; "),
      textA,
      textB,
    );
  if (a.harness !== b.harness)
    return notComparable(id, "measured by different versions of the harness", textA, textB);
  // A GPU and a CPU renderer play a game at different speeds.
  if (a.renderer !== b.renderer)
    return notComparable(
      id,
      `measured on different renderers (${sides.a}: ${a.renderer ?? "not recorded"}; ${sides.b}: ${b.renderer ?? "not recorded"})`,
      textA,
      textB,
    );
  // A runtime update changes what every game of its major plays, not the game.
  if (a.runtime !== b.runtime)
    return notComparable(
      id,
      `measured with different Kurambit runtimes (${sides.a}: ${a.runtime ?? "the game's own"}; ${sides.b}: ${b.runtime ?? "the game's own"})`,
      textA,
      textB,
    );
  if (
    id === "skilled" &&
    a.skilled.status === "measured" &&
    b.skilled.status === "measured" &&
    a.skilled.value.bot.hash !== b.skilled.value.bot.hash
  )
    return notComparable(id, "the play bot changed between the two measurements", textA, textB);
  if (
    id === "saved-plays" &&
    a.savedPlays.status === "measured" &&
    b.savedPlays.status === "measured" &&
    a.savedPlays.value.set !== b.savedPlays.value.set
  )
    return notComparable(id, "the saved plays changed between the two measurements", textA, textB);
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
    change === "same" || !(LOWER_IS_BETTER.has(id) || HIGHER_IS_BETTER.has(id))
      ? "neutral"
      : (change === "down") === LOWER_IS_BETTER.has(id)
        ? "better"
        : "worse";
  return { ...base, change, tone };
};

/** A build named by id, or a chat turn's build by the turn the client already holds. */
export const GameBuildRef = Schema.Union([
  Schema.TaggedStruct("build", { build: GameBuildId }),
  Schema.TaggedStruct("turn", { threadId: ThreadId, runId: Schema.String }),
]);
export type GameBuildRef = typeof GameBuildRef.Type;

export const GameBuildRestoreRef = Schema.Struct({
  requestId: Schema.String,
  target: GameBuildId,
  /** "Turn 5's build", "Build 1a2b3c4d". */
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
  /**
   * The first page only: the newest listed build whose asset use was measured, and which of the
   * game's generations it ships (their bytes) and loaded. The generation cards read it.
   */
  latestUse: Schema.optionalKey(
    Schema.Struct({
      build: GameBuildId,
      generations: GameGenerationUse,
    }),
  ),
  /**
   * The first page only: the run of the asking chat whose turn has not settled into a build yet,
   * because it is still running or its checkpoint is still being saved. Read in the same pass as
   * `builds`, so it is gone exactly when the turn's build is listed or is known to be none.
   */
  pendingTurn: Schema.optionalKey(Schema.String),
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

/** One tuned value a build changed in the tune file: "jump 9 → 12". Null: absent on that side. */
export const GameTuneChange = Schema.Struct({
  /** The thing's id, when the change's own lines name it. */
  thing: Schema.NullOr(Schema.String),
  key: Schema.String,
  from: Schema.NullOr(Schema.String),
  to: Schema.NullOr(Schema.String),
});
export type GameTuneChange = typeof GameTuneChange.Type;

/** Everything a build changed from the build it was made from, read when one build is shown. */
export const GameBuildChanges = Schema.Struct({
  /** Most changed first. */
  files: Schema.Array(GameBuildFile).check(Schema.isMaxLength(300)),
  /** Null when there is no build before it to diff with. */
  count: Schema.NullOr(NonNegativeInt),
  tunes: Schema.Array(GameTuneChange).check(Schema.isMaxLength(200)),
});
export type GameBuildChanges = typeof GameBuildChanges.Type;
export const GameBuildChangesInput = Schema.Struct({ threadId: ThreadId, build: GameBuildId });
/** A measure the person asked for; `skilled` also plays the game's play bot, to prove it can be won. */
export const GameBuildMeasureInput = Schema.Struct({
  ...GameBuildRefInput.fields,
  skilled: Schema.optionalKey(Schema.Boolean),
});
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
/** One version of a try, as the Stage lists it. */
export const GameTryVersion = Schema.Struct({
  n: PositiveInt,
  childThreadId: ThreadId,
  /** Working in its own copy; ready with a build; stopped or failed with what it built, if anything. */
  state: Schema.Literals(["working", "ready", "stopped", "failed"]),
  build: Schema.NullOr(GameBuildId),
  approach: Schema.String,
});
export type GameTryVersion = typeof GameTryVersion.Type;

/** A "try it N ways" message of a chat and its versions. */
export const GameTry = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.String,
  request: Schema.String,
  at: IsoDateTime,
  /** The build the versions started from: Undo after a keep goes back to it. */
  base: Schema.NullOr(GameBuildId),
  versions: Schema.Array(GameTryVersion),
  /** The newest keep, when one was made. */
  kept: Schema.NullOr(Schema.Struct({ n: PositiveInt, at: IsoDateTime })),
});
export type GameTry = typeof GameTry.Type;

export const GameTriesInput = Schema.Struct({ threadId: ThreadId });
/** The chat's tries, newest first. */
export const GameTriesResult = Schema.Struct({ tries: Schema.Array(GameTry) });
export type GameTriesResult = typeof GameTriesResult.Type;

/** Keeps one version: the game folder becomes its build through the one restore path. */
export const GameKeepVersionInput = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.String,
  n: PositiveInt,
  commandId: Schema.String,
});

/** Stops one build's play copy; the folder's own Play is never touched. */
export const GameBuildStopInput = Schema.Struct({ threadId: ThreadId, build: GameBuildRef });
export const GameBuildRestoreResult = Schema.Struct({
  requestId: Schema.String,
  done: Schema.Boolean,
  message: Schema.String,
});
