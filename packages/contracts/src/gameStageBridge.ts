import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import { GameBuildId } from "./gameBuildId.ts";

/**
 * The bridge between the Stage and a running game: plain `postMessage`
 * objects, each with a `type`, between the Stage's iframe and the game page.
 * The game page runs on its own origin, so both ends decode every message and
 * ignore what does not decode.
 *
 * The three.js shell (templates/runtime/three/1/shell/stage-bridge.js) is the
 * game end; Godot and Unity have none yet. A game says it has the bridge with
 * `studio-ready` carrying `bridge`. Shells from before the bridge post a bare
 * `{ type: "studio-ready" }` as their boot signal, which does not decode here:
 * that game has no bridge, and the agent can update its shell.
 *
 * Coordinates (`x`, `y`, `rect`, trace points) are CSS pixels from the game
 * canvas's top-left corner. The shell's canvas fills its page, so they are the
 * iframe's own viewport pixels.
 */
export const GAME_STAGE_BRIDGE_VERSION = 1;
/** The most things a game reports; the rest are left out. */
export const GAME_STAGE_MAX_THINGS = 200;
/** The trace a selection reports: its last this many seconds of screen path, sampled at this rate. */
export const GAME_STAGE_TRACE_SECONDS = 10;
export const GAME_STAGE_TRACE_HZ = 30;

export const GameStageCapability = Schema.Literals(["freeze", "select", "tune", "trace"]);
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

export const GameStageTrace = Schema.Struct({
  /** Oldest first; a point while the thing was off screen or not yet made is left out. */
  points: Schema.Array(GameStagePoint),
});
export type GameStageTrace = typeof GameStageTrace.Type;

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
  action: Schema.Literals(["hover", "select"]),
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

export const GameStageToGameMessage = Schema.Union([
  StudioFreeze,
  StudioPointer,
  StudioSelect,
  StudioTune,
  StudioHoverThing,
  StudioThingsRequest,
  StudioCapture,
]);
export type GameStageToGameMessage = typeof GameStageToGameMessage.Type;

// Game → Stage

export const StudioReady = Schema.Struct({
  type: Schema.Literal("studio-ready"),
  bridge: Schema.Literal(GAME_STAGE_BRIDGE_VERSION),
  capabilities: Schema.Array(GameStageCapability),
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
 * A Stage key pressed while the game's frame has focus, which keeps every key
 * from the Stage: Tab (freeze, play on) always, Escape only while frozen (the
 * game's own pause otherwise). Sent only once the Stage has spoken to the game.
 */
export const StudioKey = Schema.Struct({
  type: Schema.Literal("studio-key"),
  key: Schema.Literals(["Tab", "Escape"]),
});

/** The answer to studio-capture. */
export const StudioFrame = Schema.Struct({
  type: Schema.Literal("studio-frame"),
  png: Schema.String.check(Schema.isPattern(/^data:image\/png;base64,/)),
});

export const GameToStageMessage = Schema.Union([
  StudioReady,
  StudioThings,
  StudioHover,
  StudioSelected,
  StudioFrozen,
  StudioKey,
  StudioFrame,
]);
export type GameToStageMessage = typeof GameToStageMessage.Type;

/** The Stage's decoder for what a game page posts: None for anything else, old shells' bare ready included. */
export const decodeGameToStageMessage = Schema.decodeUnknownOption(GameToStageMessage);
export const decodeGameStageToGameMessage = Schema.decodeUnknownOption(GameStageToGameMessage);

// Keep as a build

export const GAME_KEEP_VALUES_MAX_THINGS = GAME_STAGE_MAX_THINGS;
export const GAME_KEEP_VALUES_MAX_VALUES = 64;

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
export const gameStageTraceSummary = (trace: GameStageTrace | undefined): string => {
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
  if (thing.kind !== "rule" && thing.kind !== "sound")
    lines.push(`- Its path over the last 10 s: ${gameStageTraceSummary(trace)}`);
  return lines.join("\n");
};
