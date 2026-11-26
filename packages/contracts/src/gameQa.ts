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
  /** Its keys as KeyboardEvent codes ("KeyE"), as the play had them. Absent from older shells. */
  keys: Schema.optionalKey(Schema.Array(Text(32)).check(Schema.isMaxLength(4))),
  /**
   * The game asked ctx.input about it: in its run, on its title or at its ending (`visited`). One
   * not read there may still be read on a screen the play never reaches (a shop, an upgrade pick).
   */
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
  /**
   * Animation frames asked for per frame drawn: the loops running, whatever the frame rate.
   * Absent from shells that counted frames a second, which a lighter scene also raised.
   */
  loops: Schema.optionalKey(Count),
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
  /**
   * The game's own screens besides play where the play also read what the game asks ctx.input
   * about. Absent from shells that predate it, which read the title only.
   */
  visited: Schema.optionalKey(
    Schema.Array(Schema.Literals(["title", "end"])).check(Schema.isMaxLength(2)),
  ),
});
export type GameQaReport = typeof GameQaReport.Type;

/** PURE. Where the play looked for a control being read: "in play, on the title or at the end". */
const gameQaWhere = (report: GameQaReport): string => {
  const visited = report.visited ?? ["title"];
  const places = [
    "in play",
    ...(visited.includes("title") ? ["on the title"] : []),
    ...(visited.includes("end") ? ["at the end"] : []),
  ];
  return places.length === 1 ? places[0]! : `${places.slice(0, -1).join(", ")} or ${places.at(-1)}`;
};

/** Where Retry's counts read as state the game kept outside its run. */
const OBJECTS_GROWTH = 1.5;
const OBJECTS_MORE = 30;
/** A whole extra loop, less a frame that ended inside the counted second. */
const LOOPS_MORE = 0.8;

export const listedNames = (names: ReadonlyArray<string>) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * PURE. A QA report as findings. `errors`, `retry` and `hud` are certain (the check fails on
 * them). `dead` controls were not read anywhere the play went (`where`): the check fails on them
 * too, worded as what was seen, since a screen the play never reaches may read them. `silent`
 * controls are read but answered nothing the play could see, which a control that works only in
 * some places also does (a frog's "down" at its start row), so they are never a problem: agents
 * sent to fix them broke working controls.
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
      before.loops !== undefined &&
      after.loops !== undefined &&
      before.loops > 0 &&
      after.loops - before.loops >= LOOPS_MORE
    )
      retry.push({
        said: `Another animation loop runs after Retry (${before.loops} → ${after.loops} frames asked per frame drawn)`,
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
    /** Where the dead controls were not read. */
    where: gameQaWhere(report),
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
        `${listedNames(findings.dead)} ${findings.dead.length === 1 ? "was" : "were"} not read ${findings.where}. The QA play does not reach every screen (a shop, an upgrade pick, a pause menu): if one reads ${findings.dead.length === 1 ? "it" : "them"}, leave ${findings.dead.length === 1 ? "it" : "them"} as ${findings.dead.length === 1 ? "it is" : "they are"}; if none does, drop ${findings.dead.length === 1 ? "it" : "each"} with null in ACTIONS so Controls never lists a dead key. Never bind a key to another action to make this pass.`,
      ]),
  ...findings.errors
    .slice(0, 3)
    .map((error) => `Pressing ${error} (thrown while the QA play pressed it): fix the error.`),
  ...findings.retry.map((each) => `${each.said}: ${each.fix}`),
  ...findings.hud.map((each) => `${each.said}: ${each.fix}`),
];

/**
 * The window sizes the build's boot check also opens the game at, after the QA play: what a
 * player on a phone held upright and one on an ultrawide monitor would get.
 */
export const GAME_SCREEN_SIZES = [
  { name: "phone", width: 390, height: 844 },
  { name: "widescreen", width: 2560, height: 1080 },
] as const;

/** The game's page at one window size, played a moment and read as a player would see it. */
export const GameScreenSize = Schema.Struct({
  name: Schema.Literals(["phone", "widescreen"]),
  width: Count,
  height: Count,
  /** The page reported ready at this size. */
  booted: Schema.Boolean,
  /** The part of the window the game's canvas covers; null: the page drew no canvas. */
  canvas: Schema.NullOr(Schema.Struct({ width: Count, height: Count })),
  /** Errors at this size that the check's own play at its usual size did not throw. */
  errors: Schema.Array(Text(200)).check(Schema.isMaxLength(3)),
  /**
   * The HUD's DOM text that lies off the window. Null: not measured, because the page has no
   * HUD text in its DOM (a HUD drawn inside the canvas) or its shell could not say.
   */
  hudOff: Schema.NullOr(Schema.Array(Text(60)).check(Schema.isMaxLength(8))),
  /** Game-relative PNG of the game at this size; null when none was kept. */
  frame: Schema.NullOr(Schema.String),
});
export type GameScreenSize = typeof GameScreenSize.Type;

export const GameScreens = Schema.Struct({
  sizes: Schema.Array(GameScreenSize).check(Schema.isMaxLength(2)),
  /** Bytes the page loaded from its boot through the moment of play, the larger of the sizes. */
  bytes: Schema.NullOr(Count),
});
export type GameScreens = typeof GameScreens.Type;

const SIZE_WORDS = { phone: "phone", widescreen: "widescreen" } as const;

/** PURE. "loads 14 MB": what a player downloads to start the game. */
export const loadedWords = (bytes: number): string =>
  bytes >= 10_000_000
    ? `loads ${Math.round(bytes / 1_000_000)} MB`
    : bytes >= 1_000_000
      ? `loads ${(bytes / 1_000_000).toFixed(1)} MB`
      : `loads ${Math.max(1, Math.round(bytes / 1000))} KB`;

/**
 * PURE. What broke at each size, in the order a player meets it: as the person reads it
 * (`said`), in a few words (`short`), and what the agent does about it (`fix`).
 */
export const gameScreensFindings = (report: GameScreens) =>
  report.sizes.flatMap((size) => {
    const at = `At ${SIZE_WORDS[size.name]} size (${size.width}×${size.height})`;
    const found: Array<{
      readonly size: GameScreenSize["name"];
      readonly said: string;
      readonly short: string;
      readonly fix: string;
    }> = [];
    if (!size.booted)
      found.push({
        size: size.name,
        said: `${at} the game does not start${size.errors[0] === undefined ? "" : `: ${size.errors[0]}`}`,
        short: "does not start",
        fix: "it must boot at any window size; read innerWidth and innerHeight, never assume 16:9.",
      });
    else {
      const first = size.errors[0];
      if (first !== undefined)
        found.push({
          size: size.name,
          said: `${at} the game throws: ${first}${size.errors.length > 1 ? ` (+${size.errors.length - 1} more)` : ""}`,
          short: "throws",
          fix: "fix the error; it happens only at this window size.",
        });
      if (
        size.canvas !== null &&
        (size.canvas.width < size.width - 2 || size.canvas.height < size.height - 2)
      )
        found.push({
          size: size.name,
          said: `${at} the canvas covers only ${size.canvas.width}×${size.canvas.height} of the window`,
          short: "canvas does not fill",
          fix: "let the canvas fill the window (the shell sizes it); never give it a fixed size or aspect.",
        });
      if (size.canvas === null)
        found.push({
          size: size.name,
          said: `${at} the page draws no canvas`,
          short: "no canvas",
          fix: "the game's canvas must be on screen at every window size.",
        });
      if (size.hudOff !== null && size.hudOff.length > 0)
        found.push({
          size: size.name,
          said: `${at} HUD text runs off the screen: ${listedNames(size.hudOff.map((t) => `"${t}"`))}`,
          short: "HUD off screen",
          fix: "anchor it to the view's edges and let it wrap or shrink, never a fixed position past the narrowest window.",
        });
    }
    return found;
  });

/** PURE. The Screens fact's row: what fits, or the first thing that broke, and the download. */
export const gameScreensWords = (
  report: GameScreens,
): { readonly text: string; readonly broken: number } => {
  const found = gameScreensFindings(report);
  const loads = report.bytes === null ? [] : [loadedWords(report.bytes)];
  const first = found[0];
  if (first !== undefined)
    return {
      text: [
        `${first.said}${found.length > 1 ? ` (+${found.length - 1} more)` : ""}`,
        ...loads,
      ].join(" · "),
      broken: found.length,
    };
  const hudUnread = report.sizes.length > 0 && report.sizes.every((size) => size.hudOff === null);
  return {
    text: [
      `Fits ${report.sizes.map((size) => SIZE_WORDS[size.name]).join(" and ")}`,
      ...(hudUnread ? ["HUD not measured (none in the page's DOM)"] : []),
      ...loads,
    ].join(" · "),
    broken: 0,
  };
};
