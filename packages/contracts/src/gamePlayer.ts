import * as Schema from "effect/Schema";

/**
 * What a player experiences in a game's first minutes, measured by the harness on the page as a
 * player opens it (no `?play`), with no model call. Each reading is a value, or why it could not
 * be measured: never a pass by default. The pass lines are DESIGN-RECIPES' (Poki, XAG 101, Steam
 * Deck; the rest the studies' judgement), and they colour a reading, never fail a build.
 */
const NotMeasured = Schema.Struct({ notMeasured: Schema.String });
const reading = <S extends Schema.Top>(value: S) => Schema.Union([value, NotMeasured]);
const Seconds = Schema.Number;

export const GamePlayerReport = Schema.Struct({
  /** Seconds from navigation to the first drawn frame (the bridge says ready once it drew one). */
  load: reading(Schema.Struct({ ready: Seconds })),
  /** Whether the first frame changes over the next second: something on the Stage moves. */
  moves: reading(Schema.Boolean),
  /** Share of the first frame a title, menu or text in the page covers (0..1). */
  cover: reading(Schema.Number),
  /**
   * Presses and seconds from navigation to play (the probe's own reading between presses left
   * out); `by` names the press that started it, or that none did.
   */
  open: reading(
    Schema.Struct({
      inputs: Schema.Int,
      seconds: Seconds,
      by: Schema.String,
      started: Schema.Boolean,
    }),
  ),
  /** The longest block of page text from opening through 10 s of play, in words. */
  textWall: reading(Schema.Struct({ words: Schema.Int, text: Schema.String })),
  /** The smallest text on screen, as its font's pixel size at 1920×1080 and at 1280×800. */
  text1080: reading(Schema.Number),
  text800: reading(Schema.Number),
  /** Whether a run with no input at all ends in a loss within 120 s; how such a run ended, and when. */
  lost: reading(Schema.Boolean),
  idleEnded: Schema.optionalKey(Schema.Struct({ won: Schema.Boolean, at: Seconds })),
  /** From a loss back to play: presses, seconds from the first, and the press that did it. */
  retry: reading(
    Schema.Struct({
      inputs: Schema.Int,
      seconds: Seconds,
      by: Schema.String,
      started: Schema.Boolean,
    }),
  ),
  /** A sound started within 1 s of the player's first input; the mix's sample peak in dBFS. */
  sound: reading(
    Schema.Struct({ firstInput: Schema.Boolean, peakDb: Schema.NullOr(Schema.Number) }),
  ),
  /** Escape during play holds the run (GameState "paused" and its clock). */
  pause: reading(Schema.Boolean),
  /** A frame of play: its median light (0..1) and the share of clipped pixels. */
  frame: reading(Schema.Struct({ median: Schema.Number, clipped: Schema.Number })),
});
export type GamePlayerReport = typeof GamePlayerReport.Type;
type Key = Exclude<keyof GamePlayerReport, "idleEnded">;

/**
 * The lines the readings are held to. A reading off its line names the line in its words, so the
 * person and the agent both see what it missed and by how much.
 */
const LINE = {
  loadSeconds: 1,
  openSeconds: 10,
  words: 30,
  px1080: 18,
  px800: 9,
  retrySeconds: 3,
  peakDb: -1,
} as const;

const s = (seconds: number) => `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
const percent = (share: number) => `${Math.round(share * 100)}%`;

/**
 * PURE. One line per reading, as the person and the agent read it: the value, then ✓ or ✗ against
 * its line, and off it, the line it missed. A reading off its line also says, as a headline, what
 * it trips. A reading that is the game's choice (a title, a quiet start) is told with no mark.
 */
const gamePlayerReadings = (
  report: GamePlayerReport,
): ReadonlyArray<{ readonly line: string; readonly trips: string | null }> => {
  const line = <K extends Key>(
    key: K,
    label: string,
    said: (value: Exclude<GamePlayerReport[K], { readonly notMeasured: string }>) => string,
    ok: (value: Exclude<GamePlayerReport[K], { readonly notMeasured: string }>) => boolean | null,
    trips: (value: Exclude<GamePlayerReport[K], { readonly notMeasured: string }>) => string = () =>
      "",
    missed = "",
  ) => {
    const value: unknown = report[key];
    if (typeof value === "object" && value !== null && "notMeasured" in value)
      return { line: `${label}: not measured (${String(value.notMeasured)})`, trips: null };
    const good = ok(value as never);
    return {
      line: `${label}: ${said(value as never)}${good === null ? "" : good ? " ✓" : `${missed && `; ${missed}`} ✗`}`,
      trips: good === false ? trips(value as never) : null,
    };
  };
  const opened = report.open;
  // The press the sound reading answers: the one that started play, or Space in a game that opens in it.
  const pressed =
    "notMeasured" in opened || !opened.started
      ? "the first input"
      : opened.inputs === 0
        ? "Space in play"
        : `${opened.by} starts play`;
  return [
    line(
      "load",
      "load",
      (v) => `first frame drawn at ${s(v.ready)}`,
      (v) => v.ready <= LINE.loadSeconds,
      (v) => `First frame takes ${s(v.ready)}`,
      `a player waits on a blank page past ${s(LINE.loadSeconds)}`,
    ),
    line(
      "moves",
      "opening moves",
      (v) => (v ? "yes" : "no, the first frame is still a second later"),
      (v) => v,
      () => "Opens on a still frame",
    ),
    line(
      "cover",
      "title covers",
      (v) => `${percent(v)} of the first frame`,
      // No mark: a title or rules screen is a game's choice, and judges read it as finish.
      () => null,
    ),
    line(
      "open",
      "to play",
      (v) =>
        v.started
          ? `${v.inputs} input${v.inputs === 1 ? "" : "s"}, ${s(v.seconds)} (${v.by})`
          : `${v.by} (${v.inputs} tried)`,
      (v) => v.started && v.inputs <= 1 && v.seconds <= LINE.openSeconds,
      (v) =>
        !v.started
          ? "No input starts play"
          : v.inputs > 1
            ? `Takes ${v.inputs} inputs to start`
            : `Takes ${s(v.seconds)} to start`,
      `play starts on the first input within ${s(LINE.openSeconds)}`,
    ),
    line(
      "textWall",
      "longest text before 10 s of play",
      (v) => `${v.words} words`,
      (v) => v.words <= LINE.words,
      (v) => `${v.words} words to read before play`,
      `players skip text over ${LINE.words} words before play`,
    ),
    line(
      "text1080",
      "smallest text at 1080p",
      (v) => `${Math.round(v)} px`,
      (v) => v >= LINE.px1080,
      (v) => `Text as small as ${Math.round(v)} px at 1080p`,
      `text under ${LINE.px1080} px at 1080p is hard to read`,
    ),
    line(
      "text800",
      "smallest text at 1280×800",
      (v) => `${Math.round(v)} px`,
      (v) => v >= LINE.px800,
      (v) => `Text as small as ${Math.round(v)} px at 1280×800`,
      `text under ${LINE.px800} px at 1280×800 is hard to read`,
    ),
    line(
      "lost",
      "lost with no input",
      (v) =>
        v
          ? `at ${s(report.idleEnded?.at ?? 0)}`
          : report.idleEnded?.won === true
            ? `no: it won itself at ${s(report.idleEnded.at)}`
            : "not within 120 s",
      () => null,
    ),
    line(
      "retry",
      "retry",
      (v) =>
        v.started
          ? `${v.inputs} press${v.inputs === 1 ? "" : "es"}, ${s(v.seconds)} (${v.by})`
          : `${v.by} (${v.inputs} tried)`,
      (v) => v.started && v.inputs <= 1 && v.seconds <= LINE.retrySeconds,
      (v) =>
        !v.started
          ? "No press retries"
          : v.inputs > 1
            ? `Retry takes ${v.inputs} presses`
            : `Retry takes ${s(v.seconds)}`,
      `one press is back in play within ${s(LINE.retrySeconds)}`,
    ),
    line(
      "sound",
      "sound",
      (v) =>
        `${pressed}, ${v.firstInput ? "a sound" : "no sound"} within 1 s${v.peakDb === null ? "" : `, mix peak ${v.peakDb.toFixed(1)} dBFS`}`,
      // A clipping mix is off its line; a quiet first press is the game's choice (a puzzle's start).
      (v) => (v.peakDb !== null && v.peakDb > LINE.peakDb ? false : v.firstInput || null),
      (v) => `Sound clips at ${v.peakDb?.toFixed(1)} dBFS`,
      `a mix over ${LINE.peakDb.toFixed(1)} dBFS clips`,
    ),
    line(
      "pause",
      "Esc pauses",
      (v) => (v ? "yes" : "no"),
      (v) => v,
      () => "Esc does not pause",
    ),
    line(
      "frame",
      "play frame",
      (v) => `median light ${v.median.toFixed(2)}, ${percent(v.clipped)} clipped`,
      () => null,
    ),
  ];
};

export const gamePlayerLines = (report: GamePlayerReport): ReadonlyArray<string> =>
  gamePlayerReadings(report).map((reading) => reading.line);

/** PURE. What each reading off its line trips, in the order a player meets them. */
export const gamePlayerTrips = (report: GamePlayerReport): ReadonlyArray<string> =>
  gamePlayerReadings(report).flatMap((reading) => (reading.trips === null ? [] : [reading.trips]));
