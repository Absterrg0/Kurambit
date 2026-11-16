import * as Schema from "effect/Schema";
import { NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import { GameBuildId } from "./gameBuildId.ts";
import { GamePlay, GamePlayMark, GamePlayOutcome } from "./gamePlays.ts";

/**
 * The bridge between the Stage and a running game: plain `postMessage`
 * objects, each with a `type`, between the Stage's iframe and the game page.
 * The game page runs on its own origin, so both ends decode every message and
 * ignore what does not decode.
 *
 * The three.js shell (templates/runtime/three/1/shell/stage-bridge.js) is the
 * game end; an engine without one has no bridge. A game says it has the bridge with
 * `studio-ready` carrying `bridge`. Shells from before the bridge post a bare
 * `{ type: "studio-ready" }` as their boot signal: that game has no bridge, and
 * the agent can update its shell. Every engine's shell answers `studio-visibility`.
 *
 * Coordinates (`x`, `y`, `rect`, trace points) are CSS pixels from the game
 * canvas's top-left corner. The shell's canvas fills its page, so they are the
 * iframe's own viewport pixels.
 */
const GAME_STAGE_BRIDGE_VERSION = 1;
/** The most things a game reports; the rest are left out. */
const GAME_STAGE_MAX_THINGS = 200;

export const GameStageCapability = Schema.Literals([
  "freeze",
  "select",
  "tune",
  "trace",
  "speed",
  "mute",
  "controls",
  "cannot-lose",
  "dev",
  /** Keeps the person's runs, left ones too, and answers studio-run-request. */
  "runs",
  /** Hands the run so far to the Stage, and replays a run to a moment to go on from there live. */
  "rewind",
]);
export type GameStageCapability = typeof GameStageCapability.Type;

export const GameThingKind = Schema.Literals([
  "character",
  "creature",
  "prop",
  "level",
  "effect",
  "ui",
  "rule",
  "sound",
  "other",
]);
export type GameThingKind = typeof GameThingKind.Type;

export const GameThingValue = Schema.Struct({
  key: Schema.String,
  value: Schema.Union([Schema.Finite, Schema.Boolean]),
  min: Schema.optionalKey(Schema.Finite),
  max: Schema.optionalKey(Schema.Finite),
  step: Schema.optionalKey(Schema.Finite),
  label: Schema.optionalKey(Schema.String),
  /** A value that picks one of these by its index (a theme, a weapon): its names, in order. */
  choices: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(40))).check(Schema.isMaxLength(24)),
  ),
  /** Its value in the game's code; tune.json holds only values that differ from it. */
  default: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.Boolean])),
  /** What its number counts ("s", "m/s", "%"), as the game declared it. */
  unit: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(12))),
});
export type GameThingValue = typeof GameThingValue.Type;

export const GameThing = Schema.Struct({
  /** Stable across reloads: the asset path, or the name the game gave. */
  id: Schema.String,
  /** "Cat", "Slime 3". */
  name: Schema.String,
  kind: GameThingKind,
  /** Game-relative; the Look tab reads the sidecar and its generation. */
  asset: Schema.optionalKey(
    Schema.Struct({ path: Schema.String, sidecar: Schema.optionalKey(Schema.String) }),
  ),
  /** Its tuned values (`ctx.tune`), with the ranges the game registered. */
  values: Schema.optionalKey(Schema.Array(GameThingValue)),
  onScreen: Schema.Boolean,
  /** It is drawn as many instances of one mesh (a field of grass): how many. */
  instances: Schema.optionalKey(NonNegativeInt),
  /** One instance of it was picked (a double click into its group): which, and of how many. */
  instance: Schema.optionalKey(Schema.Struct({ index: NonNegativeInt, count: NonNegativeInt })),
});
export type GameThing = typeof GameThing.Type;

export const GameStageRect = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  w: Schema.Finite,
  h: Schema.Finite,
});
export type GameStageRect = typeof GameStageRect.Type;

export const GameStagePoint = Schema.Tuple([Schema.Finite, Schema.Finite]);

/** One jump of the selected thing: its arc on the canvas, its apex, and how it measured. */
export const GameStageJump = Schema.Struct({
  points: Schema.Array(GameStagePoint),
  apex: GameStagePoint,
  /** World units above where it left the ground. */
  height: Schema.Finite,
  /** Game seconds in the air. */
  seconds: Schema.Finite,
  /** World units along the ground from takeoff to landing. */
  distance: Schema.Finite,
});
export type GameStageJump = typeof GameStageJump.Type;

export const GameStageTrace = Schema.Struct({
  /** Oldest first; a point while the thing was off screen or not yet made is left out. */
  points: Schema.Array(GameStagePoint),
  /**
   * How it moved over the same seconds, for tuning its feel: ground speed (world units a game
   * second, oldest first), the top of it, and its last jumps. Absent from older shells.
   */
  feel: Schema.optionalKey(
    Schema.Struct({
      speeds: Schema.Array(Schema.Finite).check(Schema.isMaxLength(64)),
      top: Schema.Finite,
      jumps: Schema.Array(GameStageJump).check(Schema.isMaxLength(3)),
    }),
  ),
});
export type GameStageTrace = typeof GameStageTrace.Type;

/** One of the game's actions as its own Controls screen lists it. */
export const GameStageControl = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(64)),
  label: Schema.String.check(Schema.isMaxLength(80)),
  /** Its keys as KeyboardEvent codes, the first the one a HUD hint names. */
  codes: Schema.Array(Schema.String).check(Schema.isMaxLength(8)),
  /** The same keys as a player reads them ("Space", "Left"). */
  keys: Schema.Array(Schema.String).check(Schema.isMaxLength(8)),
  mouse: Schema.Array(Schema.String).check(Schema.isMaxLength(4)),
  pad: Schema.Array(Schema.String).check(Schema.isMaxLength(8)),
  /** The shell's own (pause): never rebound. */
  fixed: Schema.Boolean,
  /** The player rebound it away from the game's own keys. */
  changed: Schema.Boolean,
});
export type GameStageControl = typeof GameStageControl.Type;

// Stage → game

/** Pause the game loop, its timers and its audio, with no menu; while frozen, hovering outlines things. */
export const StudioFreeze = Schema.Struct({
  type: Schema.Literal("studio-freeze"),
  on: Schema.Boolean,
});
export const StudioPointer = Schema.Struct({
  type: Schema.Literal("studio-pointer"),
  x: Schema.Finite,
  y: Schema.Finite,
  /** select-inner: a double click, which goes into a group to one instance of it. */
  action: Schema.Literals(["hover", "select", "select-inner"]),
});
/** Select from the Things list: highlights the thing (and frames it if it is on screen); null clears. */
export const StudioSelect = Schema.Struct({
  type: Schema.Literal("studio-select"),
  id: Schema.NullOr(Schema.String),
});
/** A live value change; the game clamps it to the range it registered. */
export const StudioTune = Schema.Struct({
  type: Schema.Literal("studio-tune"),
  id: Schema.String,
  key: Schema.String,
  value: Schema.Union([Schema.Finite, Schema.Boolean]),
});
/** Outline a thing from the Things list as the pointer passes its row; null clears. Shown while frozen. */
export const StudioHoverThing = Schema.Struct({
  type: Schema.Literal("studio-hover-thing"),
  id: Schema.NullOr(Schema.String),
});
export const StudioThingsRequest = Schema.Struct({
  type: Schema.Literal("studio-things-request"),
});
/**
 * Asks for the canvas as a PNG, drawn with no outline (the Inspector's Ask
 * attaches it): a page on another origin is the only one that can read it.
 */
export const StudioCapture = Schema.Struct({
  type: Schema.Literal("studio-capture"),
});
/**
 * Asks for the run in play so far, as a play that has not ended (left), for "Tell the agent
 * about this run" while paused: answered with studio-play, `asked` set.
 */
export const StudioRunRequest = Schema.Struct({
  type: Schema.Literal("studio-run-request"),
});

/**
 * Asks for the run in play so far (answered with studio-run): for the Stage's timeline, or
 * (`leave`) because the page is about to go away, when the Stage keeps it and resumes it on the
 * page that comes up, so the page's own leaving keeps nothing.
 */
export const StudioRunTake = Schema.Struct({
  type: Schema.Literal("studio-run-take"),
  leave: Schema.Boolean,
});

/**
 * Replays `play` from its seed up to a moment, as fast as the game steps, then hands it over to
 * live play there, frozen: the person's input takes over and the run's recording goes on from
 * it. The moment is `step` (exact: a reload's resume) or `at`, a second of play (the timeline).
 * `pace`: from that step on the replay plays at the run's own pace, so a moment can be watched.
 * `fork`: the run goes on as a new run from that second of the old one. Answered with
 * studio-replayed, `id` echoed.
 */
export const StudioReplay = Schema.Struct({
  type: Schema.Literal("studio-replay"),
  id: Schema.Finite,
  play: GamePlay,
  step: Schema.optionalKey(NonNegativeInt),
  at: Schema.optionalKey(Schema.Finite),
  pace: Schema.optionalKey(NonNegativeInt),
  fork: Schema.optionalKey(Schema.Finite),
});
export type StudioReplay = typeof StudioReplay.Type;

/** A fresh run in play, not frozen: the Stage's "Start fresh" instead of where the person was. */
export const StudioNewRun = Schema.Struct({ type: Schema.Literal("studio-new-run") });

/** How fast play runs, 1 being the game's own pace: slow motion to look at a jump or a hit. */
export const StudioSpeed = Schema.Struct({
  type: Schema.Literal("studio-speed"),
  value: Schema.Finite,
});
/** Silences the game's sound, or gives it back, without touching its own volume settings. */
export const StudioMute = Schema.Struct({
  type: Schema.Literal("studio-mute"),
  on: Schema.Boolean,
});

/**
 * The Stage's "Can't lose" while tuning: a loss does not end the run (a win still does). Only
 * the Stage sends it; the harness's own plays never do, so no measurement sees it.
 */
export const StudioCannotLose = Schema.Struct({
  type: Schema.Literal("studio-cannot-lose"),
  on: Schema.Boolean,
});
/** Asks for the game's actions (answered with studio-controls). */
export const StudioControlsRequest = Schema.Struct({
  type: Schema.Literal("studio-controls-request"),
});
/** Puts a key first on an action, as the game's Controls screen does, saved with its settings. */
export const StudioRebind = Schema.Struct({
  type: Schema.Literal("studio-rebind"),
  name: Schema.String,
  code: Schema.String,
});
/** Every action back on the game's own keys. */
export const StudioControlsReset = Schema.Struct({
  type: Schema.Literal("studio-controls-reset"),
});

/**
 * The Stage's dev views, all of them each time: the named things' bounds drawn over the game, a
 * frame-rate readout in its corner, and a free camera that orbits the frozen frame.
 */
export const StudioDev = Schema.Struct({
  type: Schema.Literal("studio-dev"),
  bounds: Schema.Boolean,
  perf: Schema.Boolean,
  freeCamera: Schema.Boolean,
});
export type StudioDev = typeof StudioDev.Type;
/** One fixed step of a frozen game, as play would take it. */
export const StudioStep = Schema.Struct({ type: Schema.Literal("studio-step") });
/** A free camera's drag (radians across and up) and wheel (a distance factor). */
export const StudioOrbit = Schema.Struct({
  type: Schema.Literal("studio-orbit"),
  dx: Schema.Finite,
  dy: Schema.Finite,
  zoom: Schema.Finite,
});

/** The Stage's tab is hidden (or shown): the game holds play and sound, and acknowledges. */
export const StudioVisibility = Schema.Struct({
  type: Schema.Literal("studio-visibility"),
  visible: Schema.Boolean,
});

export const GameStageToGameMessage = Schema.Union([
  StudioVisibility,
  StudioFreeze,
  StudioSpeed,
  StudioMute,
  StudioPointer,
  StudioSelect,
  StudioTune,
  StudioHoverThing,
  StudioThingsRequest,
  StudioCapture,
  StudioRunRequest,
  StudioRunTake,
  StudioReplay,
  StudioNewRun,
  StudioControlsRequest,
  StudioRebind,
  StudioControlsReset,
  StudioCannotLose,
  StudioDev,
  StudioStep,
  StudioOrbit,
]);
export type GameStageToGameMessage = typeof GameStageToGameMessage.Type;

// Game → Stage

/** The game drew its first frame. Without `bridge` it is a shell from before the bridge. */
export const StudioReady = Schema.Struct({
  type: Schema.Literal("studio-ready"),
  bridge: Schema.optionalKey(Schema.Literal(GAME_STAGE_BRIDGE_VERSION)),
  capabilities: Schema.optionalKey(Schema.Array(GameStageCapability)),
});
/** The page's first error, once: where it came from when the page knows. */
export const StudioError = Schema.Struct({
  type: Schema.Literal("studio-error"),
  message: Schema.String,
  source: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
  line: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
});
/** The answer to studio-visibility: what the game actually did. */
export const StudioVisibilityAck = Schema.Struct({
  type: Schema.Literal("studio-visibility-ack"),
  visible: Schema.Boolean,
  paused: Schema.Boolean,
  muted: Schema.Boolean,
});
/** On boot and whenever the set changes (or a value does); at most GAME_STAGE_MAX_THINGS. */
export const StudioThings = Schema.Struct({
  type: Schema.Literal("studio-things"),
  things: Schema.Array(GameThing),
});
export const StudioHover = Schema.Struct({
  type: Schema.Literal("studio-hover"),
  id: Schema.NullOr(Schema.String),
  rect: Schema.optionalKey(GameStageRect),
});
export const StudioSelected = Schema.Struct({
  type: Schema.Literal("studio-selected"),
  thing: Schema.NullOr(GameThing),
  /** Absent while the thing is off screen or has no body. */
  rect: Schema.optionalKey(GameStageRect),
  trace: Schema.optionalKey(GameStageTrace),
});
export const StudioFrozen = Schema.Struct({
  type: Schema.Literal("studio-frozen"),
  on: Schema.Boolean,
});

/**
 * Escape pressed while the game's frame has focus and the game is frozen: the frame keeps every
 * key from the Stage, and Tab and an unfrozen Escape are the game's. Sent only once the Stage has
 * spoken to the game.
 */
export const StudioKey = Schema.Struct({
  type: Schema.Literal("studio-key"),
  key: Schema.Literal("Escape"),
});

/**
 * A Kurambit shortcut pressed while the game's frame has focus: Ctrl or Cmd with Alt, a chord no
 * game means, so the Stage's keys (freeze, step a frame, the dev views) work while playing. The
 * game never sees it: one reading P for pause would take Ctrl+Alt+P as its own.
 */
export const StudioShortcut = Schema.Struct({
  type: Schema.Literal("studio-shortcut"),
  key: Schema.String.check(Schema.isMaxLength(32)),
  code: Schema.String.check(Schema.isMaxLength(32)),
  ctrlKey: Schema.Boolean,
  metaKey: Schema.Boolean,
  shiftKey: Schema.Boolean,
});

/** The game's actions, asked for or just changed; `note` says what a rebind did. */
export const StudioControls = Schema.Struct({
  type: Schema.Literal("studio-controls"),
  controls: Schema.Array(GameStageControl).check(Schema.isMaxLength(32)),
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});

/** The answer to studio-capture. */
export const StudioFrame = Schema.Struct({
  type: Schema.Literal("studio-frame"),
  png: Schema.String.check(Schema.isPattern(/^data:image\/png;base64,/)),
});

/**
 * A person's run on the Stage ended, or was left (Retry, the menu, a reload): its play, for the
 * Stage to keep (gamePlays.ts). `asked`: the answer to studio-run-request, the run so far.
 */
export const StudioPlay = Schema.Struct({
  type: Schema.Literal("studio-play"),
  play: GamePlay,
  asked: Schema.optionalKey(Schema.Boolean),
});

/** The answer to studio-run-take: the run so far, or null with none in play (a title, an ending). */
export const StudioRun = Schema.Struct({
  type: Schema.Literal("studio-run"),
  play: Schema.NullOr(GamePlay),
});

/**
 * How a studio-replay went. It reached its moment and was handed over (`ended` null, `at` where
 * it stands); or the run ended before it (`ended`, held there; playing on plays the ending out);
 * or it did not run: the play pressed actions the game no longer has (`missing`), or getting
 * back took longer than `slow` seconds. Those two start a fresh run, frozen. `marks`: where the
 * replay stood each second, to read against the play's own.
 */
export const StudioReplayed = Schema.Struct({
  type: Schema.Literal("studio-replayed"),
  id: Schema.Finite,
  ended: Schema.optionalKey(Schema.NullOr(GamePlayOutcome)),
  seconds: Schema.optionalKey(Schema.Finite),
  steps: Schema.optionalKey(NonNegativeInt),
  marks: Schema.optionalKey(Schema.Array(GamePlayMark).check(Schema.isMaxLength(1_600))),
  at: Schema.optionalKey(GamePlayMark),
  missing: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(64))),
  slow: Schema.optionalKey(Schema.Finite),
});
export type StudioReplayed = typeof StudioReplayed.Type;

/** The run on screen is gone (a new run, the menu): the Stage takes down what it showed for it. */
export const StudioRunReset = Schema.Struct({
  type: Schema.Literal("studio-run-reset"),
});

/**
 * Where the run in play stands, as the recorder kept it this second (gamePlays.ts marks): the
 * Workbench's values watch draws from these, one a second, so it never asks the game per frame.
 */
export const StudioMark = Schema.Struct({
  type: Schema.Literal("studio-mark"),
  mark: GamePlayMark,
});

export const GameLogLevel = Schema.Literals(["error", "warn", "log"]);
export type GameLogLevel = typeof GameLogLevel.Type;
export const GameLogLine = Schema.Struct({
  level: GameLogLevel,
  text: Schema.String.check(Schema.isMaxLength(500)),
  /** Seconds since the page loaded. */
  t: Schema.Finite,
});
export type GameLogLine = typeof GameLogLine.Type;

/**
 * The page's errors and console lines since the last batch, at most a few times a second: the
 * Workbench's console. `dropped` counts lines a chatty game logged past the batch's room.
 */
export const StudioLog = Schema.Struct({
  type: Schema.Literal("studio-log"),
  lines: Schema.Array(GameLogLine).check(Schema.isMaxLength(50)),
  dropped: Schema.optionalKey(NonNegativeInt),
});

export const GameToStageMessage = Schema.Union([
  StudioReady,
  StudioMark,
  StudioLog,
  StudioError,
  StudioVisibilityAck,
  StudioThings,
  StudioHover,
  StudioSelected,
  StudioFrozen,
  StudioKey,
  StudioShortcut,
  StudioFrame,
  StudioControls,
  StudioPlay,
  StudioRun,
  StudioReplayed,
  StudioRunReset,
]);
export type GameToStageMessage = typeof GameToStageMessage.Type;

/** The Stage's decoder for what a game page posts: None for anything else. */
export const decodeGameToStageMessage = Schema.decodeUnknownOption(GameToStageMessage);

// Keep as a build

const GAME_KEEP_VALUES_MAX_THINGS = GAME_STAGE_MAX_THINGS;
const GAME_KEEP_VALUES_MAX_VALUES = 64;

/** One thing's values to keep, with the ranges the game registered (the Stage sends what it got). */
export const GameKeepValuesThing = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
  values: Schema.Array(GameThingValue).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(GAME_KEEP_VALUES_MAX_VALUES),
  ),
});
export type GameKeepValuesThing = typeof GameKeepValuesThing.Type;

/** Writes the values to the game's tune file and keeps the folder as a build Undo can take back. */
export const GameKeepValuesInput = Schema.Struct({
  threadId: ThreadId,
  things: Schema.Array(GameKeepValuesThing).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(GAME_KEEP_VALUES_MAX_THINGS),
  ),
  commandId: Schema.optionalKey(Schema.String),
  /**
   * The Stage's tuning: fold into the tuning build the folder holds, so values tuned between two
   * builds are one build and one Undo, instead of a build per slider let go.
   */
  fold: Schema.optionalKey(Schema.Boolean),
});
export type GameKeepValuesInput = typeof GameKeepValuesInput.Type;

export const GameKeepValuesResult = Schema.Struct({
  build: GameBuildId,
  /** The build the folder held before: restoring it undoes this one. */
  base: GameBuildId,
  message: Schema.String,
});
export type GameKeepValuesResult = typeof GameKeepValuesResult.Type;

// The Inspector's Ask

const round = (n: number) => Math.round(n);
const valueText = (value: GameThingValue) => {
  const range =
    value.min !== undefined && value.max !== undefined ? ` (${value.min} to ${value.max})` : "";
  const name = value.label === undefined ? `\`${value.key}\`` : `${value.label} (\`${value.key}\`)`;
  return `${name} = ${String(value.value)}${range}`;
};

/** A path in canvas pixels, said in one line: where it began and ended, how far it went and where it stayed. */
const gameStageTraceSummary = (trace: GameStageTrace | undefined): string => {
  const points = trace?.points ?? [];
  if (points.length === 0) return "No path recorded (off screen, or not seen moving yet).";
  const [x0, y0] = points[0]!;
  const [x1, y1] = points.at(-1)!;
  if (points.length === 1) return `Stood still at (${round(x0)}, ${round(y0)}).`;
  let travelled = 0;
  let minX = x0;
  let maxX = x0;
  let minY = y0;
  let maxY = y0;
  for (let i = 1; i < points.length; i += 1) {
    const [x, y] = points[i]!;
    const [px, py] = points[i - 1]!;
    travelled += Math.hypot(x - px, y - py);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return `From (${round(x0)}, ${round(y0)}) to (${round(x1)}, ${round(y1)}), ${round(travelled)} px travelled, within x ${round(minX)} to ${round(maxX)} and y ${round(minY)} to ${round(maxY)} (y grows downward).`;
};

/**
 * PURE. The text block an Ask from the Inspector carries after the person's
 * line, beside the frame it attaches: what the thing is, where it comes from,
 * its live values and its recent path, so the agent can find it in the code.
 */
export const gameStageAskContext = (selection: {
  readonly thing: GameThing;
  readonly rect?: GameStageRect | undefined;
  readonly trace?: GameStageTrace | undefined;
}): string => {
  const { thing, rect, trace } = selection;
  const lines = [
    "The person selected this in the running game (the attached frame is the canvas when they asked):",
    `- Thing: ${thing.name} (${thing.kind}), id \`${thing.id}\`.`,
  ];
  if (thing.instance !== undefined)
    lines.push(
      `- Just one of its ${thing.instance.count} instances: instance ${thing.instance.index} of its InstancedMesh, the one the person double-clicked, not the whole group.`,
    );
  if (thing.asset !== undefined)
    lines.push(
      `- Asset: \`${thing.asset.path}\`${thing.asset.sidecar === undefined ? "" : `, sidecar \`${thing.asset.sidecar}\` (its source and generation)`}.`,
    );
  if (thing.values !== undefined && thing.values.length > 0)
    lines.push(
      `- Live values (ctx.tune("${thing.id}"), kept in web/tune.json): ${thing.values.map(valueText).join("; ")}.`,
    );
  if (rect !== undefined)
    lines.push(
      `- On the frame at x ${round(rect.x)}, y ${round(rect.y)}, ${round(rect.w)} by ${round(rect.h)} px.`,
    );
  else lines.push(thing.onScreen ? "- On screen." : "- Not on screen.");
  if (thing.kind !== "rule" && thing.kind !== "sound" && thing.instance === undefined)
    lines.push(`- Its path over the last 10 s: ${gameStageTraceSummary(trace)}`);
  return lines.join("\n");
};
