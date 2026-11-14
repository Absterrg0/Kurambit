import * as Schema from "effect/Schema";
import { NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import { GameBuildId } from "./gameBuildId.ts";

/**
 * A person's run on the Stage, as the three.js shell keeps it
 * (templates/runtime/three/1/shell/replay.js): the run's seed, its fixed step, the raw input of
 * each step where it changed, what the Stage changed mid-run, where the run stood each second,
 * and how it ended. Replayed on another build, the same input meets that build's game.
 */
const Code = Schema.String.check(Schema.isMaxLength(64));
const Codes = Schema.Array(Code).check(Schema.isMaxLength(32));
const Buttons = Schema.Array(Schema.Finite).check(Schema.isMaxLength(8));

/** One step's input: keys and mouse buttons held (k, b) and pressed (p, c), the mouse, a pad. */
export const GamePlayInput = Schema.Struct({
  k: Codes,
  p: Codes,
  b: Buttons,
  c: Buttons,
  /** x, y in canvas pixels, ndc x and y, movement x and y. */
  m: Schema.Tuple([
    Schema.Finite,
    Schema.Finite,
    Schema.Finite,
    Schema.Finite,
    Schema.Finite,
    Schema.Finite,
  ]),
  /** A gamepad's axes and button values, when one was connected. */
  g: Schema.optionalKey(
    Schema.Tuple([
      Schema.Array(Schema.Finite).check(Schema.isMaxLength(16)),
      Schema.Array(Schema.Finite).check(Schema.isMaxLength(32)),
    ]),
  ),
});

/** Where a run stood at one second of play: the player's position and the game's own values. */
export const GamePlayMark = Schema.Struct({
  t: Schema.Finite,
  at: Schema.NullOr(Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite])),
  values: Schema.Record(Schema.String, Schema.Union([Schema.Finite, Schema.Boolean])),
});
export type GamePlayMark = typeof GamePlayMark.Type;

export const GamePlayOutcome = Schema.Struct({
  won: Schema.Boolean,
  /** The end screen's words ("You fall to the ronin"). */
  text: Schema.String.check(Schema.isMaxLength(200)),
  /** Seconds of play when it ended. */
  seconds: Schema.Finite,
});
export type GamePlayOutcome = typeof GamePlayOutcome.Type;

export const GamePlay = Schema.Struct({
  version: Schema.Literal(1),
  seed: NonNegativeInt,
  /** The fixed step, in seconds: one frame at the display's rate the run was played at. */
  dt: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1 / 30)),
  steps: NonNegativeInt,
  inputs: Schema.Array(Schema.Tuple([NonNegativeInt, GamePlayInput])).check(
    Schema.isMaxLength(20_001),
  ),
  /** [step, "speed" | "can-lose" | "tune", ...its values]. */
  events: Schema.Array(
    Schema.Array(Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])).check(
      Schema.isMaxLength(4),
    ),
  ).check(Schema.isMaxLength(2_000)),
  marks: Schema.Array(GamePlayMark).check(Schema.isMaxLength(1_300)),
  outcome: GamePlayOutcome,
});
export type GamePlay = typeof GamePlay.Type;

/** A run the shell's replay played: how it ended (null: it had not, past the kept run's end). */
export const GameReplayRun = Schema.Struct({
  outcome: Schema.NullOr(GamePlayOutcome),
  seconds: Schema.Finite,
  steps: NonNegativeInt,
  marks: Schema.Array(GamePlayMark).check(Schema.isMaxLength(1_600)),
});
export type GameReplayRun = typeof GameReplayRun.Type;

/** The Stage keeps a person's ended run on the game folder (a build's copy has no bridge). */
export const GameKeepPlayInput = Schema.Struct({
  threadId: ThreadId,
  play: GamePlay,
});
export type GameKeepPlayInput = typeof GameKeepPlayInput.Type;

/** The person's latest kept play, replayed on one build. */
export const GameReplayInput = Schema.Struct({
  threadId: ThreadId,
  build: GameBuildId,
});
export type GameReplayInput = typeof GameReplayInput.Type;

/** A kept play: when, on which build (null: the folder, edited since its build), how it ended. */
export const GamePlaySummary = Schema.Struct({
  at: Schema.String,
  build: Schema.NullOr(GameBuildId),
  outcome: GamePlayOutcome,
});
export type GamePlaySummary = typeof GamePlaySummary.Type;

export const GameReplayResult = Schema.Struct({
  kept: GamePlaySummary,
  /** How the replay ended: null when it had not by the kept run's end and a little after. */
  now: Schema.NullOr(GamePlayOutcome),
  /** The first second the replay stood elsewhere than the kept run, and what differed; null: never. */
  differs: Schema.NullOr(Schema.Struct({ seconds: Schema.Finite, what: Schema.String })),
});
export type GameReplayResult = typeof GameReplayResult.Type;

/** PURE. "won at 41 s", "lost at 12 s". */
export const playOutcomeWords = (outcome: GamePlayOutcome | null) =>
  outcome === null
    ? "still playing"
    : `${outcome.won ? "won" : "lost"} at ${Math.round(outcome.seconds)} s`;

/** PURE. The first second two runs stood apart, and what differed: the player, or a value. */
export const firstPlayDifference = (
  kept: ReadonlyArray<GamePlayMark>,
  now: ReadonlyArray<GamePlayMark>,
): { readonly seconds: number; readonly what: string } | null => {
  const count = Math.min(kept.length, now.length);
  for (let i = 0; i < count; i += 1) {
    const a = kept[i]!;
    const b = now[i]!;
    const keys = [...new Set([...Object.keys(a.values), ...Object.keys(b.values)])];
    const value = keys.find((key) => a.values[key] !== b.values[key]);
    if (value !== undefined)
      return {
        seconds: a.t,
        what: `${value} ${String(a.values[value] ?? "unset")} → ${String(b.values[value] ?? "unset")}`,
      };
    const moved =
      (a.at === null) !== (b.at === null) ||
      (a.at !== null && b.at !== null && a.at.some((each, axis) => each !== b.at![axis]));
    if (moved) return { seconds: a.t, what: "the player is elsewhere" };
  }
  return null;
};
