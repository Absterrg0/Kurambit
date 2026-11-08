import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";
import { GameBotDecider } from "./gameBot.ts";
import { GameBuildId } from "./gameBuildId.ts";
import { GameAssetSource } from "./gameModel.ts";
import {
  type GameSceneFinding,
  type GameSceneFindingKind,
  GameSceneReport,
  sceneEmptyText,
  sceneFindingText,
  scenePlayerText,
} from "./gameScene.ts";

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
      }),
    ),
  }),
  /** The folder before a restore, or a person's kept edit. */
  Schema.TaggedStruct("saved", {
    label: Schema.String,
    /** A person's edit kept as a build outside a turn: what it kept ("values": the Stage's Keep as a build). */
    edit: Schema.optionalKey(Schema.Literals(["values"])),
  }),
]);
export type GameBuildSource = typeof GameBuildSource.Type;

/** A build Undo belongs to while it is the game's newest: a chat turn's, or a person's kept edit. */
export const ownsUndo = (source: GameBuildSource) =>
  source._tag === "turn" || (source._tag === "saved" && source.edit !== undefined);

/** A saved build's label for what the folder held when a restore replaced it. */
export const RESTORE_BEFORE_LABEL = "The game before a restore";

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
  "performance",
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
  /** Why it cannot be restored, else null. */
  noRestore: Schema.NullOr(Schema.String),
  facts: GameBuildFactsSummary,
  /**
   * The build this one was made from: restoring it undoes this build. A turn's is
   * the build the folder held when the turn started (turn 1's: the thread's start
   * checkpoint, ordinal 0); null when unknown.
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

export const GameModelFact = Schema.Struct({
  /** Game-relative GLB. */
  path: Schema.String,
  /** Read from the GLB's JSON. */
  triangles: NonNegativeInt,
  bytes: NonNegativeInt,
  maxTextureSide: NonNegativeInt,
  /** The rig id whose joints its skin holds (aliases resolved); null when unskinned or on no known rig. */
  skeleton: Schema.NullOr(Schema.String),
  clips: NonNegativeInt,
  /** The export's measurement, valid only while the GLB's bytes match its sidecar. */
  pipeline: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("measured"),
      sidecar: Schema.String,
      kind: Schema.Literals(["character", "prop"]),
      height: Schema.Number,
      reviewedAt: IsoDateTime,
      groundSpeeds: Schema.Array(
        Schema.Struct({ clip: Schema.String, speed: Schema.NullOr(Schema.Number) }),
      ).check(Schema.isMaxLength(16)),
      seamsBroken: Schema.Array(Schema.String).check(Schema.isMaxLength(16)),
      drifting: Schema.Array(Schema.String).check(Schema.isMaxLength(16)),
      source: GameAssetSource,
    }),
    GameFactNotMeasured,
  ]),
});
export type GameModelFact = typeof GameModelFact.Type;
export const GameAssetFacts = Schema.Struct({
  /** Models under the engine's assets folder, outside library/, path order. */
  models: Schema.Array(GameModelFact).check(Schema.isMaxLength(24)),
  /** Models past the cap, counted only. */
  more: NonNegativeInt,
  /** Library files ASSETS.md credits; not measured one by one. */
  libraryFiles: NonNegativeInt,
});
export type GameAssetFacts = typeof GameAssetFacts.Type;

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

/**
 * How the random-input play ran, as the game's shell measured it while the harness
 * played (three.js): play's frame rate, its 1% low, the GPU's time per frame and the
 * render scale the look settled on, at the play's canvas size.
 */
export const GamePerformance = Schema.Struct({
  /** Frames per second from the median frame time. */
  fps: Schema.Number,
  /** Frames per second over the slowest 1% of frames. */
  low1: Schema.Number,
  /** The GPU's median milliseconds per frame (timer queries); null where the browser has none. */
  gpuMs: Schema.NullOr(Schema.Number),
  /** The median render scale: the share of the canvas's pixels per side the frame was drawn at. */
  scale: Schema.NullOr(Schema.Number),
  width: NonNegativeInt,
  height: NonNegativeInt,
  frames: NonNegativeInt,
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
  idle: gameFact(GameBotTier),
  masher: gameFact(GameBotTier),
  skilled: gameFact(GameSkilledTier),
  winnableWithoutSkill: gameFact(Schema.Boolean),
  liveness: gameFact(GameLiveness),
  firstResponse: gameFact(GameFirstResponse),
  /** Static: read from the build's GLBs and sidecars, never played; Keep going does not watch it. */
  assets: gameFact(GameAssetFacts).pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        status: "not-measured" as const,
        why: "measured before asset facts existed",
        retry: false,
      }),
    ),
  ),
  /** Measured during the random-input play: frame rate, 1% low, GPU time and render scale. */
  performance: gameFact(GamePerformance).pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        status: "not-measured" as const,
        why: "measured before performance was measured",
        retry: false,
      }),
    ),
  ),
  /** Measured during the plays: which shipped files the game loaded and which sounds played. */
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
   * Measured during the random-input play by the game's shell: what a person sees at a
   * glance (the player in view, bodies buried, inside each other or fallen out of the
   * world, the camera inside a wall, sliding, things never on screen), with frames.
   */
  scene: gameFact(GameSceneReport).pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        status: "not-measured" as const,
        why: "measured before scene reports existed",
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
  performance: "Performance",
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

/** The scene rows past the player's, the finding kinds each shows, and its clean reading. */
const SCENE_ROWS: Readonly<
  Record<
    "buried" | "clipping" | "fell" | "camera" | "sliding",
    { readonly kinds: ReadonlyArray<GameSceneFindingKind>; readonly clean: string }
  >
> = {
  buried: { kinds: ["buried", "inside"], clean: "Nothing buried or inside a solid" },
  clipping: { kinds: ["clipping"], clean: "No bodies inside each other" },
  fell: { kinds: ["fell"], clean: "Nothing fell out of the world" },
  camera: { kinds: ["camera"], clean: "The camera stays out of walls" },
  sliding: { kinds: ["sliding"], clean: "Nothing slides in idle or a frozen pose" },
};
const sceneFindingsOf = (report: GameSceneReport, id: keyof typeof SCENE_ROWS) =>
  report.findings.filter((finding) => SCENE_ROWS[id].kinds.includes(finding.kind));

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
    case "performance":
      return from(facts.performance, (perf) => {
        const ms = (x: number) => (x < 10 ? x.toFixed(1) : String(Math.round(x)));
        const scale = perf.scale === null ? "" : ` at ${Number(perf.scale.toFixed(2))}×`;
        const text = [
          `${Math.round(perf.fps)} fps`,
          `1% low ${Math.round(perf.low1)}`,
          ...(perf.gpuMs === null ? [] : [`GPU ${ms(perf.gpuMs)} ms`]),
        ]
          .join(" · ")
          .concat(`${scale} of ${perf.width}×${perf.height}`);
        // Whole frames: a tenth of a frame is the machine's noise, never better or worse.
        return {
          text,
          value: Math.round(perf.fps),
          tone: perf.fps >= 55 && perf.low1 >= 30 ? "good" : perf.fps < 30 ? "bad" : "neutral",
          kind: "performance",
        };
      });
    case "assets":
      return from(facts.assets, (assets) => {
        const measured = assets.models.filter(
          (model) => model.pipeline.status === "measured",
        ).length;
        const notMeasured = assets.models.length - measured;
        const text = `${measured} made model${measured === 1 ? "" : "s"} measured${notMeasured > 0 ? `, ${notMeasured} not measured` : ""}`;
        // A triangle count is not taste: the reading is never better or worse, only different.
        return { text, value: measured, tone: "neutral", kind: text };
      });
    case "use":
      return from(facts.use, (use) => {
        const shipped = use.used.length + use.unused.length + use.more;
        // Past the caps the overflow is the used list's while the unused one is not full.
        const exact = use.unused.length < GAME_ASSET_USE_CAP;
        const used = exact ? use.used.length + use.more : use.used.length;
        const parts = [
          `Uses ${used}${exact ? "" : "+"} of ${shipped} file${shipped === 1 ? "" : "s"}`,
          ...(use.unused.length > 0 ? [`${use.unused.length}${exact ? "" : "+"} unused`] : []),
          ...(use.silent.length > 0
            ? [`${use.silent.length} sound${use.silent.length === 1 ? "" : "s"} never played`]
            : []),
        ];
        const text = parts.join(" · ");
        // Evidence for the next step, never a verdict: unused art is no worse a game.
        return { text, value: used, tone: "neutral", kind: "use" };
      });
    case "player-view":
      return fromScene(facts, (report): Read => {
        const player = report.player;
        switch (player.kind) {
          case "none":
            return { _tag: "not-measured", why: "the game sets no ctx.player" };
          case "point":
            return { _tag: "not-measured", why: "ctx.player is a position, not a body on screen" };
          case "hidden-by-game":
            return {
              _tag: "not-measured",
              why: "the game kept the player hidden or out of the scene the whole play",
            };
          case "no-body":
          case "first-person":
            return measured({
              text: "First person: the player has no body on screen",
              value: null,
              tone: "neutral",
              kind: "first-person",
            });
          case "body": {
            const problem = scenePlayerText(player);
            const visible = Math.max(0, 1 - player.hidden - player.offscreen);
            return measured({
              text:
                problem ??
                `In view ${Math.round(visible * 100)}% of play${player.heightPx === null ? "" : ` · ${Math.round(player.heightPx)} px tall`}`,
              value: Math.round(visible * 100),
              tone: problem === null ? "good" : "bad",
              kind: problem === null ? "clean" : "flagged",
            });
          }
        }
      });
    case "empty":
      return fromScene(facts, (report): Read => {
        const empty = report.empty;
        if (empty === undefined)
          return { _tag: "not-measured", why: "the game's shell predates the empty-view measure" };
        const problem = sceneEmptyText(empty);
        return measured({
          text:
            problem ??
            (empty.share === 0
              ? "Something is drawn across the view"
              : `${Math.round(empty.share * 100)}% of the view is empty backdrop`),
          value: Math.round(empty.share * 100),
          tone: problem === null ? "good" : "bad",
          kind: problem === null ? "clean" : "flagged",
        });
      });
    case "buried":
    case "clipping":
    case "fell":
    case "camera":
    case "sliding":
      return fromScene(facts, (report) => {
        const found = sceneFindingsOf(report, id);
        const first = found[0];
        return measured(
          first === undefined
            ? { text: SCENE_ROWS[id].clean, value: 0, tone: "good", kind: "clean" }
            : {
                text: `${sceneFindingText(first)}${found.length > 1 ? ` (+${found.length - 1} more)` : ""}`,
                value: found.length,
                tone: "bad",
                kind: "flagged",
              },
        );
      });
    case "unseen":
      return fromScene(facts, (report) => {
        const count = report.unseen.length + report.unseenMore;
        // Things may come later than a minute of random play reaches: evidence, never a verdict.
        return measured({
          text:
            count === 0
              ? `Every named thing came on screen in ${Math.round(report.seconds)} s of play`
              : `${count} never on screen in ${Math.round(report.seconds)} s of play: ${report.unseen.slice(0, 4).join(", ")}${count > 4 ? ", …" : ""}`,
          value: count,
          tone: "neutral",
          kind: "unseen",
        });
      });
  }
};

const measured = (reading: Reading): Read => ({ _tag: "measured", reading });
const fromScene = (facts: GameBuildFacts, read: (report: GameSceneReport) => Read): Read =>
  facts.scene.status === "measured"
    ? read(facts.scene.value)
    : facts.scene.status === "pending"
      ? { _tag: "pending" }
      : { _tag: "not-measured", why: facts.scene.why };

const sceneFrame = (finding: GameSceneFinding): GameFactView["evidence"] =>
  finding.frame === null
    ? []
    : [{ kind: "frame", label: sceneFindingText(finding), path: finding.frame }];

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
    // The scene report's frames, the problem outlined in each.
    case "player-view": {
      if (facts.scene.status !== "measured") return [];
      const player = facts.scene.value.player;
      if (player.kind !== "body") return [];
      const frame = player.notVisible ? player.frame : player.small ? player.smallFrame : null;
      const text = scenePlayerText(player);
      return frame === null || text === null ? [] : [{ kind: "frame", label: text, path: frame }];
    }
    case "empty": {
      const empty = facts.scene.status === "measured" ? facts.scene.value.empty : undefined;
      const text = empty === undefined ? null : sceneEmptyText(empty);
      return empty?.frame == null || text === null
        ? []
        : [{ kind: "frame", label: text, path: empty.frame }];
    }
    case "buried":
    case "clipping":
    case "fell":
    case "camera":
    case "sliding":
      return facts.scene.status === "measured"
        ? sceneFindingsOf(facts.scene.value, id).flatMap(sceneFrame).slice(0, 4)
        : [];
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

/** For these numbers lower is better, for these higher; the other numbers are neutral. */
const LOWER_IS_BETTER: ReadonlySet<GameFactId> = new Set([
  "freeze",
  "colour",
  "first-response",
  "buried",
  "clipping",
  "fell",
  "camera",
  "sliding",
]);
const HIGHER_IS_BETTER: ReadonlySet<GameFactId> = new Set(["performance", "player-view"]);
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
    case "player-view":
    case "buried":
    case "clipping":
    case "fell":
    case "camera":
    case "sliding":
      return kind === "clean" ? 1 : kind === "flagged" ? 0 : null;
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
 * PURE. The one diff of two builds' facts, shared by the compare view and
 * game_builds. A fact not measured on either side is
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
    // A GPU and a CPU renderer play a game at different speeds.
    if (a.renderer !== b.renderer)
      return notComparable(
        id,
        `measured on different renderers (A: ${a.renderer ?? "not recorded"}; B: ${b.renderer ?? "not recorded"})`,
        textA,
        textB,
      );
    // A runtime update changes what every game of its major plays, not the game.
    if (a.runtime !== b.runtime)
      return notComparable(
        id,
        `measured with different Kurambit runtimes (A: ${a.runtime ?? "the game's own"}; B: ${b.runtime ?? "the game's own"})`,
        textA,
        textB,
      );
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
      change === "same" || !(LOWER_IS_BETTER.has(id) || HIGHER_IS_BETTER.has(id))
        ? "neutral"
        : (change === "down") === LOWER_IS_BETTER.has(id)
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
/** Stops one build's play copy; the folder's own Play is never touched. */
export const GameBuildStopInput = Schema.Struct({ threadId: ThreadId, build: GameBuildRef });
export const GameBuildRestoreResult = Schema.Struct({
  requestId: Schema.String,
  done: Schema.Boolean,
  message: Schema.String,
});
