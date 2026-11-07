import * as Schema from "effect/Schema";

/**
 * The bridge between the Stage and a running game: plain `postMessage`
 * objects, each with a `type`, between the Stage's iframe and the game page.
 * The game page runs on its own origin, so both ends decode every message and
 * ignore what does not decode.
 *
 * The three.js shell (templates/blank-three/web/shell/stage-bridge.js) is the
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
export const StudioThingsRequest = Schema.Struct({
  type: Schema.Literal("studio-things-request"),
});

export const GameStageToGameMessage = Schema.Union([
  StudioFreeze,
  StudioPointer,
  StudioSelect,
  StudioTune,
  StudioThingsRequest,
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

export const GameToStageMessage = Schema.Union([
  StudioReady,
  StudioThings,
  StudioHover,
  StudioSelected,
  StudioFrozen,
]);
export type GameToStageMessage = typeof GameToStageMessage.Type;

/** The Stage's decoder for what a game page posts: None for anything else, old shells' bare ready included. */
export const decodeGameToStageMessage = Schema.decodeUnknownOption(GameToStageMessage);
export const decodeGameStageToGameMessage = Schema.decodeUnknownOption(GameStageToGameMessage);
