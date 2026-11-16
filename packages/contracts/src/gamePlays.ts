import * as Schema from "effect/Schema";
import { NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import { GameBuildId } from "./gameBuildId.ts";

/**
 * A run played to its end, as the three.js shell keeps it
 * (templates/runtime/three/1/shell/replay.js): the run's seed, its fixed step, its clock, the raw
 * input of each step where it changed, what the Stage changed mid-run, where the run stood each
 * second, and how it ended. Replayed on another build, the same input meets that build's game.
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
  /**
   * The person left the run before it ended (Retry, the menu, a reload, the Stage closing, or
   * paused to tell the agent): it neither won nor lost, so it is never replayed as a test.
   */
  left: Schema.optionalKey(Schema.Literal(true)),
  /**
   * Where a recorded run stood as it ended or was left, which its once-a-second marks can miss
   * (the fall itself): what the agent hears of the person's runs.
   */
  where: Schema.optionalKey(GamePlayMark),
});
export type GamePlayOutcome = typeof GamePlayOutcome.Type;

export const GamePlay = Schema.Struct({
  version: Schema.Literal(1),
  seed: NonNegativeInt,
  /** The fixed step, in seconds: one frame at the display's rate the run was played at. */
  dt: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1 / 30)),
  /**
   * performance.now() and Date.now() as the run began: a step reads them plus its game time, so
   * a replay times as the run did. Absent on plays kept before the clock was.
   */
  clock: Schema.optionalKey(Schema.Tuple([Schema.Finite, Schema.Finite])),
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
  /** The game's named actions the run pressed: a build without one of them cannot replay it. */
  actions: Schema.optionalKey(Schema.Array(Code).check(Schema.isMaxLength(64))),
});
export type GamePlay = typeof GamePlay.Type;

/** A run the shell's replay played: how it ended (null: it had not, past the kept run's end). */
export const GameReplayRun = Schema.Struct({
  outcome: Schema.NullOr(GamePlayOutcome),
  seconds: Schema.Finite,
  steps: NonNegativeInt,
  marks: Schema.Array(GamePlayMark).check(Schema.isMaxLength(1_600)),
  /** The play pressed actions this build does not have, so it was not run. */
  missing: Schema.optionalKey(Schema.Array(Code).check(Schema.isMaxLength(64))),
  /** Asked to stop at a moment: where the run stood when it stopped there. */
  stopped: Schema.optionalKey(GamePlayMark),
});
export type GameReplayRun = typeof GameReplayRun.Type;

/** The Stage keeps a person's ended run on the game folder (a build's copy has no bridge). */
export const GameKeepPlayInput = Schema.Struct({
  threadId: ThreadId,
  play: GamePlay,
});
export type GameKeepPlayInput = typeof GameKeepPlayInput.Type;
/** A kept run's id, which "Save as a test play" names it by. */
export const GameKeepPlayResult = Schema.Struct({ kept: Schema.String });

/** A saved play's name, as the person or the agent gave it: also its file's name, made safe. */
export const GamePlayName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(60),
  Schema.isPattern(/^[\p{L}\p{N}][\p{L}\p{N} _'-]*$/u),
);

/**
 * Saves a kept run as a test play, replayed on every build from now on: `kept` names the run
 * (the Stage's, from keepPlay); without it, the newest run played to an end, by the person or
 * the agent. Refused when the run does not replay the same on the build it was played on.
 */
export const GameSavePlayInput = Schema.Struct({
  threadId: ThreadId,
  name: GamePlayName,
  kept: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
});
export type GameSavePlayInput = typeof GameSavePlayInput.Type;

/** A saved play: its name, when it was saved, the build it was played on, how it ended. */
export const GameSavedPlaySummary = Schema.Struct({
  name: Schema.String,
  at: Schema.String,
  build: Schema.NullOr(GameBuildId),
  outcome: GamePlayOutcome,
});
export type GameSavedPlaySummary = typeof GameSavedPlaySummary.Type;
export const GameSavedPlaysResult = Schema.Array(GameSavedPlaySummary);
export const GameDeletePlayInput = Schema.Struct({ threadId: ThreadId, name: Schema.String });
export type GameDeletePlayInput = typeof GameDeletePlayInput.Type;

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

/** PURE. "won at 41 s", "lost at 12 s", "left at 12 s". */
export const playOutcomeWords = (outcome: GamePlayOutcome | null) =>
  outcome === null
    ? "still playing"
    : `${outcome.left === true ? "left" : outcome.won ? "won" : "lost"} at ${Math.round(outcome.seconds)} s`;

/**
 * `game_play` op `replay` with `run`: one run (a saved play, or a kept run by its id) replayed on
 * the folder to a moment, with the frame there and where it stood.
 */
export const GameReplayMoment = Schema.Struct({
  run: Schema.String,
  /** How the run went when it was played. */
  played: GamePlayOutcome,
  /** The second of play the replay stopped at. */
  at: Schema.Finite,
  /** It ended on the folder before that moment; null: still in play there. */
  ended: Schema.NullOr(GamePlayOutcome),
  /** The player's position and the game's own values at that moment. */
  player: Schema.NullOr(Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite])),
  values: Schema.Record(Schema.String, Schema.Union([Schema.Finite, Schema.Boolean])),
  /** The first second, up to that moment, it played differently than when it was played. */
  differs: Schema.NullOr(Schema.Struct({ seconds: Schema.Finite, what: Schema.String })),
  /** The frame at that moment, relative to the game; null when none was drawn. */
  image: Schema.NullOr(Schema.String),
});
export type GameReplayMoment = typeof GameReplayMoment.Type;

/**
 * PURE. The short id a kept run goes by with the agent: the random end of its id, which the
 * replay and the save take as well as the whole id.
 */
export const keptRunTag = (kept: string) => kept.slice(kept.lastIndexOf("-") + 1);

/**
 * PURE. What "Tell the agent about this run" adds to the person's message, beside the frame: the
 * run's id, how it went and how to see any moment of it.
 */
export const gameRunAskContext = (run: {
  readonly kept: string;
  readonly outcome: GamePlayOutcome;
  readonly paused: boolean;
}): string => {
  const how = run.paused
    ? `paused at ${Math.round(run.outcome.seconds)} s`
    : `${playOutcomeWords(run.outcome)}${run.outcome.text === "" ? "" : ` ("${run.outcome.text}")`}`;
  const tag = keptRunTag(run.kept);
  return `The person is telling you about their run \`${tag}\` on the Stage, ${how}; the attached frame is the game when they asked. \`game_play\` op \`replay\` \`{"run": "${tag}", "at": <seconds>}\` shows any moment of it.`;
};

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

/** Saved plays a build's measure replays, newest saved first; past it, the rest wait their turn. */
export const SAVED_PLAYS_PER_BUILD = 10;

/**
 * What a saved play did on a build: it ends the same way at about the same time (same), it ends
 * otherwise or no longer ends (ending-changed), it ends the same after play moved somewhere else
 * (plays-differently), or it pressed an action this build no longer has (cannot-replay).
 */
export const GameSavedPlayReading = Schema.Literals([
  "same",
  "ending-changed",
  "plays-differently",
  "cannot-replay",
]);
export type GameSavedPlayReading = typeof GameSavedPlayReading.Type;

const PlayDifference = Schema.Struct({ seconds: Schema.Finite, what: Schema.String });

export const GameSavedPlayReplay = Schema.Struct({
  name: Schema.String,
  reading: GameSavedPlayReading,
  saved: GamePlayOutcome,
  /** How the replay ended; null when it did not end by the saved end and a little after. */
  now: Schema.NullOr(GamePlayOutcome),
  /** The first second it stood elsewhere than the saved run, and what differed; null: never. */
  differs: Schema.NullOr(PlayDifference),
  /** cannot-replay: the actions this build no longer has. */
  missing: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type GameSavedPlayReplay = typeof GameSavedPlayReplay.Type;

/** The Saved plays fact: every saved play replayed on the build, in the build's copy. */
export const GameSavedPlaysReading = Schema.Struct({
  /**
   * Which saved plays were replayed, as a hash of their names and contents: a play saved,
   * changed or deleted since then is measured again.
   */
  set: Schema.String,
  plays: Schema.Array(GameSavedPlayReplay).check(Schema.isMaxLength(SAVED_PLAYS_PER_BUILD)),
  /** Saved plays past SAVED_PLAYS_PER_BUILD, older ones, not replayed on this build. */
  skipped: NonNegativeInt,
});
export type GameSavedPlaysReading = typeof GameSavedPlaysReading.Type;

/** A second either way, or a twentieth of the run: "at about the same time". */
const sameTime = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.max(a, b) * 0.05);

/** PURE. A saved play's replay on a build, read against how it ended when it was saved. */
export const savedPlayReading = (
  name: string,
  saved: GamePlay,
  run: GameReplayRun,
): GameSavedPlayReplay => {
  const base = { name, saved: saved.outcome, now: run.outcome };
  if (run.missing !== undefined && run.missing.length > 0)
    return { ...base, reading: "cannot-replay", differs: null, missing: run.missing };
  const differs = firstPlayDifference(saved.marks, run.marks);
  const reading =
    run.outcome === null || run.outcome.won !== saved.outcome.won
      ? "ending-changed"
      : differs === null && sameTime(run.outcome.seconds, saved.outcome.seconds)
        ? "same"
        : "plays-differently";
  return { ...base, reading, differs };
};

/** PURE. One play's reading in words: "first boss win now loses at 30 s, health 40 → 0 at 28 s". */
export const savedPlayWords = (play: GameSavedPlayReplay): string => {
  const where =
    play.differs === null ? "" : `, ${play.differs.what} at ${Math.round(play.differs.seconds)} s`;
  switch (play.reading) {
    case "same":
      return `${play.name} ends the same (${playOutcomeWords(play.now)})`;
    case "ending-changed":
      return play.now === null
        ? `${play.name} no longer ends (it ${playOutcomeWords(play.saved)})${where}`
        : `${play.name} now ${play.now.won ? "wins" : "loses"} at ${Math.round(play.now.seconds)} s${where}`;
    case "plays-differently":
      return play.differs === null
        ? `${play.name} ends the same way, at ${Math.round(play.now?.seconds ?? 0)} s instead of ${Math.round(play.saved.seconds)} s`
        : `${play.name} plays differently${where}`;
    case "cannot-replay":
      return `${play.name} can't replay: it presses ${(play.missing ?? []).join(", ")}, which this build no longer has`;
  }
};

/** PURE. The fact in a line: "3 of 4 end the same; first boss win now loses at 30 s, …". */
export const savedPlaysWords = (reading: GameSavedPlaysReading): string => {
  const total = reading.plays.length;
  const same = reading.plays.filter((play) => play.reading === "same").length;
  const skipped = reading.skipped > 0 ? ` (${reading.skipped} older not replayed)` : "";
  if (same === total)
    return `${total === 1 ? "The saved play ends" : `All ${total} saved plays end`} the same${skipped}`;
  // An ending changed or a play that can't replay first: those are what a person acts on.
  const order: ReadonlyArray<GameSavedPlayReading> = [
    "ending-changed",
    "cannot-replay",
    "plays-differently",
  ];
  const off = reading.plays
    .filter((play) => play.reading !== "same")
    .toSorted((a, b) => order.indexOf(a.reading) - order.indexOf(b.reading));
  const more = off.length > 1 ? ` (+${off.length - 1} more)` : "";
  return `${same} of ${total} end the same; ${savedPlayWords(off[0]!)}${more}${skipped}`;
};
