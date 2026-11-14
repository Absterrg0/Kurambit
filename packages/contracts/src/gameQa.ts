import * as Schema from "effect/Schema";

/**
 * The QA play (three.js, templates/runtime/three/1/shell/qa.js): what a player would hit,
 * measured inside the game while the harness plays it. Every action the game declares must
 * answer, Retry must start a clean run, and the HUD must stay on screen. game_check runs it and
 * the build's facts keep it.
 */
const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Count = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** One declared action as the QA play pressed it. */
export const GameQaControl = Schema.Struct({
  name: Text(64),
  label: Text(80),
  /** The game asked ctx.input about it during the run: an action never read is dead for certain. */
  read: Schema.Boolean,
  /** What two of its presses agreed answered it ("moved", "juice", "changed score"); empty: nothing. */
  answers: Schema.Array(Text(80)).check(Schema.isMaxLength(12)),
});
export type GameQaControl = typeof GameQaControl.Type;

/** A run counted a second after it started. */
export const GameQaCount = Schema.Struct({
  objects: Count,
  things: Count,
  /** Listeners on window and document, which a run's ctx.listen never adds. */
  listeners: Count,
  intervals: Count,
  /** Animation frames asked for in a second: one loop asks for about the display's rate. */
  framesPerSecond: Count,
});
export type GameQaCount = typeof GameQaCount.Type;

export const GameQaRetry = Schema.Struct({
  before: GameQaCount,
  /** Null: the run did not end or start again in time, so Retry was not measured. */
  after: Schema.NullOr(GameQaCount),
  /** Errors after Retry, first first. */
  errors: Schema.Array(Text(200)).check(Schema.isMaxLength(10)),
});
export type GameQaRetry = typeof GameQaRetry.Type;

/** The HUD's text at one page size: what lies off the view, and pairs that overlap. */
export const GameQaHud = Schema.Struct({
  width: Count,
  height: Count,
  off: Schema.Array(Text(60)).check(Schema.isMaxLength(8)),
  over: Schema.Array(Schema.Tuple([Text(60), Text(60)])).check(Schema.isMaxLength(8)),
});
export type GameQaHud = typeof GameQaHud.Type;

export const GameQaReport = Schema.Struct({
  version: Schema.Literal(1),
  controls: Schema.Array(GameQaControl).check(Schema.isMaxLength(32)),
  retry: Schema.NullOr(GameQaRetry),
  /** At the play's own size, then a narrow 4:3. */
  hud: Schema.Array(GameQaHud).check(Schema.isMaxLength(2)),
  /**
   * Errors the game threw while its controls were pressed, each named by the control
   * ("Jump: x is undefined"). Absent from shells that predate it.
   */
  errors: Schema.optionalKey(Schema.Array(Text(240)).check(Schema.isMaxLength(10))),
});
export type GameQaReport = typeof GameQaReport.Type;

/** Where Retry's counts read as state the game kept outside its run. */
const OBJECTS_GROWTH = 1.5;
const OBJECTS_MORE = 30;
const FRAMES_GROWTH = 1.5;
const FRAMES_MORE = 30;

export const listedNames = (names: ReadonlyArray<string>) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * PURE. A QA report as findings. `dead`, `errors`, `retry` and `hud` are certain (the check
 * fails on them); `silent` controls answered nothing the play could see, which a control that
 * works only in some places also does.
 */
export const gameQaFindings = (report: GameQaReport) => {
  const dead = report.controls.filter((control) => !control.read).map((control) => control.label);
  const silent = report.controls
    .filter((control) => control.read && control.answers.length === 0)
    .map((control) => control.label);
  // Each finding as a person reads it (`said`) and what the agent does about it (`fix`).
  const retry: Array<{ readonly said: string; readonly fix: string }> = [];
  const before = report.retry?.before;
  const after = report.retry?.after ?? null;
  const s = (count: number) => (count === 1 ? "" : "s");
  if (before !== undefined && after !== null) {
    const more = after.objects - before.objects;
    if (after.objects >= before.objects * OBJECTS_GROWTH && more >= OBJECTS_MORE)
      retry.push({
        said: `Retry starts with ${more} more objects in the scene (${before.objects} → ${after.objects})`,
        fix: "what the last run made is not cleared; add it with ctx.add or remove it in stop().",
      });
    const listeners = after.listeners - before.listeners;
    if (listeners > 0)
      retry.push({
        said: `Retry adds ${listeners} listener${s(listeners)} on window or document`,
        fix: "input handlers pile up, so one press acts more than once. Use ctx.listen, which the shell removes.",
      });
    const intervals = after.intervals - before.intervals;
    if (intervals > 0)
      retry.push({
        said: `Retry leaves ${intervals} more interval${s(intervals)} running`,
        fix: "use ctx.after, or clear them in stop().",
      });
    if (
      after.framesPerSecond >= before.framesPerSecond * FRAMES_GROWTH &&
      after.framesPerSecond - before.framesPerSecond >= FRAMES_MORE
    )
      retry.push({
        said: `A second animation loop runs after Retry (${before.framesPerSecond} → ${after.framesPerSecond} frames asked a second)`,
        fix: "the game speeds up each Retry. Move per-frame work into update().",
      });
  }
  for (const error of report.retry?.errors.slice(0, 2) ?? [])
    retry.push({ said: `Retry throws: ${error}`, fix: "the new run must start clean." });
  const hud: Array<{ readonly said: string; readonly fix: string }> = [];
  for (const size of report.hud) {
    const at = `${size.width}×${size.height}`;
    if (size.off.length > 0)
      hud.push({
        said: `At ${at}, HUD text runs off the screen: ${listedNames(size.off.map((t) => `"${t}"`))}`,
        fix: "anchor it to the view's edges and let it wrap or shrink, never a fixed position past the narrowest window.",
      });
    for (const [a, b] of size.over.slice(0, 2))
      hud.push({
        said: `At ${at}, HUD text overlaps: "${a}" and "${b}"`,
        fix: "give each its own corner or stack them in one flex column.",
      });
  }
  return {
    dead,
    silent,
    retry,
    hud,
    errors: report.errors ?? [],
    /** Retry was measured: the run ended and started again. */
    retried: after !== null,
  };
};
export type GameQaFindings = ReturnType<typeof gameQaFindings>;

/** PURE. The findings as what the agent fixes, one sentence each, in the order to fix them. */
export const gameQaProblems = (findings: GameQaFindings): ReadonlyArray<string> => [
  ...(findings.dead.length === 0
    ? []
    : [
        `${listedNames(findings.dead)} ${findings.dead.length === 1 ? "is" : "are"} in ACTIONS but the game never reads ${findings.dead.length === 1 ? "it" : "them"}: make each do something, or drop it with null in ACTIONS so Controls never lists a dead key.`,
      ]),
  ...findings.errors
    .slice(0, 3)
    .map((error) => `Pressing ${error} (thrown while the QA play pressed it): fix the error.`),
  ...findings.retry.map((each) => `${each.said}: ${each.fix}`),
  ...findings.hud.map((each) => `${each.said}: ${each.fix}`),
  ...(findings.silent.length === 0
    ? []
    : [
        `${listedNames(findings.silent)}: pressed twice on a fresh run, nothing answered (no movement, value, Juice or sound). Give every press a visible answer; one that works only in certain places can stay.`,
      ]),
];
