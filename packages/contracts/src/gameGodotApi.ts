import * as Schema from "effect/Schema";

const apiText = (cap: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(cap));
const classNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Bounded engine reflection over the installed Godot's ClassDB. No network,
 * no extra server: one headless query against an isolated scratch project, so
 * the game's sources, autoloads and qualification records are never touched.
 * ClassDB covers engine classes only, not script-defined classes or Variant
 * builtin types.
 */
export const GAME_GODOT_API_BOUNDS = {
  maxMethods: 80,
  maxProperties: 80,
  maxSignals: 40,
  maxConstants: 80,
  maxSuggestions: 5,
  maxMemberFilterChars: 64,
  timeoutMs: 60_000,
} as const;

export const GameGodotApiInput = Schema.Struct({
  /** Engine class name, e.g. PointLight2D. Case-sensitive. */
  className: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.isPattern(classNamePattern),
  ),
  /** Optional case-insensitive substring filter over member names. */
  memberFilter: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  ),
});
export type GameGodotApiInput = typeof GameGodotApiInput.Type;

const GameGodotApiMethod = Schema.Struct({
  name: apiText(128),
  /** Human-readable signature, e.g. `enable() -> void`. */
  signature: apiText(500),
});
export type GameGodotApiMethod = typeof GameGodotApiMethod.Type;

const GameGodotApiProperty = Schema.Struct({
  name: apiText(128),
  /** Engine type string, e.g. `float`, when the engine reports one. */
  type: apiText(128),
});
export type GameGodotApiProperty = typeof GameGodotApiProperty.Type;

const GameGodotApiSignal = Schema.Struct({
  name: apiText(128),
  signature: apiText(500),
});
export type GameGodotApiSignal = typeof GameGodotApiSignal.Type;

const GameGodotApiConstant = Schema.Struct({
  name: apiText(128),
  value: Schema.Number,
});
export type GameGodotApiConstant = typeof GameGodotApiConstant.Type;

export const GameGodotApiResult = Schema.Struct({
  className: apiText(64),
  /** Installed engine version that answered, e.g. 4.7.2.stable. */
  engineVersion: apiText(64),
  found: Schema.Boolean,
  /** Direct parent class, null for the root or when unknown. */
  parent: Schema.NullOr(apiText(64)),
  /** Parent chain from the direct parent upward, bounded. */
  inheritance: Schema.Array(apiText(64)),
  methods: Schema.Array(GameGodotApiMethod),
  totalMethods: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  properties: Schema.Array(GameGodotApiProperty),
  totalProperties: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  signals: Schema.Array(GameGodotApiSignal),
  totalSignals: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  constants: Schema.Array(GameGodotApiConstant),
  totalConstants: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** True when any list was cut to its bound; totals still report the full count. */
  truncated: Schema.Boolean,
  /** Up to five similarly named engine classes when the class is unknown. */
  suggestions: Schema.Array(apiText(64)),
  /** Human-readable one-line summary of what was found. */
  message: apiText(600),
});
export type GameGodotApiResult = typeof GameGodotApiResult.Type;
