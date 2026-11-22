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

const s = (seconds: number) => `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
const percent = (share: number) => `${Math.round(share * 100)}%`;

/** PURE. One line per reading, as the person and the agent read it: the value, then ✓ or ✗ against its line. */
export const gamePlayerLines = (report: GamePlayerReport): ReadonlyArray<string> => {
  const line = <K extends Key>(
    key: K,
    label: string,
    said: (value: Exclude<GamePlayerReport[K], { readonly notMeasured: string }>) => string,
    ok: (value: Exclude<GamePlayerReport[K], { readonly notMeasured: string }>) => boolean | null,
  ) => {
    const value: unknown = report[key];
    if (typeof value === "object" && value !== null && "notMeasured" in value)
      return `${label}: not measured (${String(value.notMeasured)})`;
    const good = ok(value as never);
    return `${label}: ${said(value as never)}${good === null ? "" : good ? " ✓" : " ✗"}`;
  };
  return [
    line(
      "load",
      "load",
      (v) => `first frame drawn at ${s(v.ready)}`,
      (v) => v.ready <= 1,
    ),
    line(
      "moves",
      "opening moves",
      (v) => (v ? "yes" : "no, the first frame is still"),
      (v) => v,
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
      (v) => v.started && v.inputs <= 1 && v.seconds <= 10,
    ),
    line(
      "textWall",
      "longest text before 10 s of play",
      (v) => `${v.words} words`,
      (v) => v.words <= 30,
    ),
    line(
      "text1080",
      "smallest text at 1080p",
      (v) => `${Math.round(v)} px`,
      (v) => v >= 18,
    ),
    line(
      "text800",
      "smallest text at 1280×800",
      (v) => `${Math.round(v)} px`,
      (v) => v >= 9,
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
      (v) => v.started && v.inputs <= 1 && v.seconds <= 3,
    ),
    line(
      "sound",
      "sound",
      (v) =>
        `${v.firstInput ? "plays" : "silent"} on the first input${v.peakDb === null ? "" : `, mix peak ${v.peakDb.toFixed(1)} dBFS`}`,
      (v) => v.firstInput && (v.peakDb === null || v.peakDb <= -1),
    ),
    line(
      "pause",
      "Esc pauses",
      (v) => (v ? "yes" : "no"),
      (v) => v,
    ),
    line(
      "frame",
      "play frame",
      (v) => `median light ${v.median.toFixed(2)}, ${percent(v.clipped)} clipped`,
      () => null,
    ),
  ];
};
