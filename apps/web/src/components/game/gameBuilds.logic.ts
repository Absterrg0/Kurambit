import {
  GAME_LEAD_FACTS,
  gameFactName,
  type GameAssetFacts,
  type GameAssetUse,
  type GameBuild,
  type GameBuildFactsSummary,
  type GameCheck,
  type GameBuildsResult,
  type GameFactDelta,
  type GameFactTone,
  type GameFactId,
  type GameFactView,
} from "@kurambit/contracts";

/** The game's latest restore, as the Builds list carries it. */
export type GameBuildRestore = NonNullable<GameBuildsResult["restore"]>;

/**
 * A build named in a sentence: "Build 5", "Step 2's build", a saved build's
 * label. A person's build goes by the server's number for it, never its turn's:
 * a resumed or stopped turn is no extra build.
 */
export const buildName = (build: Pick<GameBuild, "id" | "source" | "number">): string => {
  const source = build.source;
  switch (source._tag) {
    case "turn":
      return source.step !== null
        ? `Step ${source.step.n}'s build`
        : `Build ${build.number ?? build.id.slice(0, 8)}`;
    case "saved":
      return source.label;
  }
};

/**
 * What a build was asked to do, in a line: the person's request, or what a
 * keep-going step set out to change.
 */
export const buildCaption = (build: Pick<GameBuild, "source" | "summary" | "number">): string => {
  const source = build.source;
  if (source._tag === "saved") return build.summary;
  if (source.step === null) return source.request.trim() || build.summary;
  const move = source.step.move.trim();
  return move === ""
    ? `Keep going, step ${source.step.n}`
    : `${move.charAt(0).toUpperCase()}${move.slice(1)}`;
};

/** Today's builds by time; older ones by day and time. */
export const formatBuildTime = (at: string, now: Date = new Date()): string => {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
};

/** A rail row's facts line when it has no chips to show yet; null when the chips say it all. */
export const factsSummaryLine = (summary: GameBuildFactsSummary): string | null => {
  switch (summary.state) {
    case "never":
      return "Not measured yet";
    case "queued":
      return "Queued to measure";
    case "measuring":
      return "Measuring…";
    case "stale":
      return "Measured by an older Kurambit";
    case "incomplete":
      return `${summary.notMeasured} not measured`;
    case "measured":
      return summary.chips.length === 0 ? "Measured" : null;
  }
};

export interface FactLine {
  readonly label: string;
  readonly text: string;
  /** Only a measured fact has a tone: a missing reading is never good or bad. */
  readonly tone: GameFactTone | null;
}

/** One fact row as drawn: its reading, or why it has none. */
export const factLine = (view: GameFactView): FactLine => {
  const reading = view.reading;
  switch (reading._tag) {
    case "measured":
      return { label: view.label, text: reading.text, tone: reading.tone };
    case "not-measured":
      return { label: view.label, text: `Not measured: ${reading.why}`, tone: null };
    case "pending":
      return { label: view.label, text: "Not measured yet", tone: null };
  }
};

/** The Asset use row's detail: the files the plays never loaded, and sounds never started. */
export const assetUseLines = (use: GameAssetUse): ReadonlyArray<string> => [
  ...(use.unused.length > 0 ? [`Never loaded: ${use.unused.join(", ")}`] : []),
  ...(use.silent.length > 0 ? [`Loaded, never started playing: ${use.silent.join(", ")}`] : []),
];

/**
 * The Assets row's detail: one line per made model, then how many more. A
 * model's numbers are measurements, never a verdict on its look.
 */
export const assetLines = (assets: GameAssetFacts): ReadonlyArray<string> => [
  ...assets.models.map((model) => {
    const triangles = `${model.triangles.toLocaleString("en-US")} triangles`;
    const pipeline = model.pipeline;
    if (pipeline.status === "not-measured")
      return `${model.path}: ${triangles}; not measured: ${pipeline.why}`;
    const notes = [
      pipeline.seamsBroken.length > 0 ? `loop seams in ${pipeline.seamsBroken.join(", ")}` : null,
      pipeline.drifting.length > 0 ? `root drifts in ${pipeline.drifting.join(", ")}` : null,
    ].filter((note) => note !== null);
    return `${model.path}: ${pipeline.kind}, ${pipeline.height.toFixed(2)} m, ${triangles}, reviewed${
      notes.length > 0 ? `; ${notes.join("; ")}` : ""
    }`;
  }),
  ...(assets.more > 0 ? [`${assets.more} more not listed`] : []),
];

/** Where the rest of the Assets row's art comes from: said on hover, it is never a finding. */
export const assetLibraryNote = (assets: GameAssetFacts): string | null =>
  assets.libraryFiles > 0
    ? `${assets.libraryFiles} library file${assets.libraryFiles === 1 ? " is" : "s are"} credited in ASSETS.md.`
    : null;

export interface DeltaLine {
  readonly label: string;
  readonly a: string;
  readonly b: string;
  /** Null when the two readings cannot be compared: no arrow and no "=". */
  readonly mark: "↑" | "↓" | "=" | "≠" | null;
  readonly tone: GameFactDelta["tone"] | null;
  readonly why: string | null;
}

const MARK = { up: "↑", down: "↓", same: "=", changed: "≠" } as const;

/** One row of a facts diff as drawn. Direction and tone are the shared diff's, never the UI's. */
export const deltaLine = (delta: GameFactDelta): DeltaLine => {
  const a = delta.a ?? "—";
  const b = delta.b ?? "—";
  if (delta.change === "not-comparable")
    return {
      label: delta.label,
      a,
      b,
      mark: null,
      tone: null,
      why: `Not comparable: ${delta.why ?? "a side has no reading"}`,
    };
  return { label: delta.label, a, b, mark: MARK[delta.change], tone: delta.tone, why: null };
};

/**
 * PURE. A build's checks in the words every surface uses ("5 of 7 pass · 1 to
 * look at"): the lead checks a build's detail lists, so the Log, a card's
 * tooltip and the Checks heading never disagree. Null before any reading.
 */
export const checksPhrase = (
  facts: Pick<GameBuild["facts"], "good" | "bad" | "lead">,
): string | null => {
  if (facts.good + facts.bad === 0) return null;
  const lead = facts.lead;
  const pass = lead === undefined ? `${facts.good} pass` : `${lead.pass} of ${lead.of} pass`;
  // Every lead check is accounted for: one with no reading is said, never left out of the count.
  const notMeasured = lead?.measured === undefined ? 0 : lead.of - lead.measured.length;
  return [
    pass,
    ...(facts.bad > 0 ? [`${facts.bad} to look at`] : []),
    ...(notMeasured > 0 ? [`${notMeasured} not measured`] : []),
  ].join(" · ");
};

/**
 * PURE. A reason a fact was not measured, as a person reads it: the machine's load figures
 * and the old play-bot wording stay in the stored reading, where agents read them.
 */
export const plainWhy = (why: string): string =>
  why
    .replace(/ \(load [\d.]+ on \d+ cores\)/g, "")
    // The renderer probe's raw output is for agents and bug reports.
    .replace(/ \([^()]*RENDERER=[^()]*\)/g, "")
    // The harness's own diagnosis, in a person's words: what this computer could not do.
    .replace(
      /^a harness fault on this machine, not the game's: the plays drew in software.*$/,
      "this computer has no graphics card Kurambit can use, so it cannot judge speed here",
    )
    .replace(
      /^the harness renders in software here, so the game ran at [\d.]+× real time$/,
      "this computer ran the game without a graphics card, too slowly to judge",
    )
    .replace(/, so the game ran at [\d.]+× real time$/, ", so the game ran too slowly to judge")
    .replace(
      "the game's shell predates scene reports",
      "the game was made before Kurambit read scenes; a new build adds it",
    )
    .replace(
      /the game's shell does not report frame times \(its copy of the shell predates performance measurement\)/,
      "the game was made before Kurambit measured speed; a new build adds it",
    )
    .replace(/\btier bot\b/g, "bot")
    .replace(
      "this game has no play bot yet (keep going writes one once, or ask your agent for one)",
      "no play bot yet; Keep going writes one, or ask your agent",
    );

/** The bot runs, whose readings are an event and its time. */
const RUN_FACTS: ReadonlySet<GameFactId> = new Set(["idle", "masher", "skilled"]);
/** A run's event in a word, from its check's sentence: "Random input loses" is "Lost". */
const runEvent = (sentence: string): string =>
  /\blos[est]/i.test(sentence)
    ? "Lost"
    : /\bwin|\bwon/i.test(sentence)
      ? "Won"
      : /crash/i.test(sentence)
        ? "Crashed"
        : /answering/i.test(sentence)
          ? "Stopped answering"
          : "No ending";
/** Rows Compare names by what they measure, since their readings are numbers. */
const COMPARE_NAMES: Partial<Record<GameFactId, string>> = {
  colour: "Largest single colour",
  motion: "Picture change (motion)",
};

export interface CompareRow {
  readonly id: GameFactId;
  readonly name: string;
  /** A side's reading; null when that side has none. */
  readonly a: string | null;
  readonly b: string | null;
  readonly mark: DeltaLine["mark"];
  readonly tone: GameFactDelta["tone"] | null;
  /** Why the two readings cannot be compared, under the row; null when they can. */
  readonly note: string | null;
}

export interface CompareRows {
  readonly rows: ReadonlyArray<CompareRow>;
  /** Facts neither build has a reading of, one entry per shared reason, so a reason is said once. */
  readonly unmeasured: ReadonlyArray<{
    readonly names: ReadonlyArray<string>;
    readonly why: string;
  }>;
  /** Facts one side has no reading of, one entry per side and reason, said once above the rows. */
  readonly oneSided: ReadonlyArray<{
    readonly side: "A" | "B";
    readonly names: ReadonlyArray<string>;
    readonly why: string;
  }>;
}

/**
 * PURE. A compare's answer in a line: what differs, or that nothing measured does, or that a
 * side is still being measured so the answer is not in yet.
 */
export const compareHeadline = (compared: CompareRows): string => {
  const pending = compared.oneSided.find((entry) => entry.why === "still being measured");
  if (pending !== undefined)
    return `${pending.side} is still being measured: the comparison fills in as its checks land.`;
  const differ = compared.rows.filter((row) => row.mark !== null && row.mark !== "=").length;
  const same = compared.rows.filter((row) => row.mark === "=").length;
  if (differ === 0 && same === 0) return "Nothing measured on both builds to compare yet.";
  if (differ === 0)
    return `No measured difference: ${same === 1 ? "the one reading both have is" : `all ${same} readings both have are`} the same.`;
  return `${differ} ${differ === 1 ? "reading differs" : "readings differ"}${same > 0 ? `, ${same} the same` : ""}.`;
};

const LEAD_ORDER: ReadonlyArray<GameFactId> = GAME_LEAD_FACTS;
const sideWhy = (view: GameFactView | undefined): string | null =>
  view === undefined || view.reading._tag === "measured"
    ? null
    : view.reading._tag === "pending"
      ? "still being measured"
      : plainWhy(view.reading.why);

/**
 * PURE. Two builds' facts as the compare view draws them: the lead checks first, by the
 * Inspector's names, then the rest; a fact neither side measured joins one row per reason.
 */
export const compareRows = (
  deltas: ReadonlyArray<GameFactDelta>,
  viewsA: ReadonlyArray<GameFactView>,
  viewsB: ReadonlyArray<GameFactView>,
  /** Each side's checks as the Inspector words them, so a cell says its reading, not its row. */
  checks?: {
    readonly a: ReadonlyArray<Pick<GameCheck, "id" | "sentence" | "value" | "reading">>;
    readonly b: ReadonlyArray<Pick<GameCheck, "id" | "sentence" | "value" | "reading">>;
  },
): CompareRows => {
  // A reading in the Inspector's words: its number when it has one ("at 7.9 s"), with its
  // sentence when it is one to look at; else its sentence unless that only repeats the row's
  // name, where it is just "Yes".
  const cell = (
    side: "a" | "b",
    id: GameFactId,
    name: string,
    fallback: string | null,
  ): string | null => {
    if (fallback === null) return null;
    const check = checks?.[side].find((entry) => entry.id === id);
    if (check === undefined) return fallback;
    // A bot run's reading names what happened, not only when: "Lost at 4.8 s".
    if (RUN_FACTS.has(id) && check.value !== null)
      return `${runEvent(check.sentence)} ${check.value}`;
    // Colour and motion are numbers, named by the row: just the number.
    if (id === "colour") return check.value?.replace(/^largest /, "") ?? fallback;
    if (id === "motion") return fallback.replace(/^Motion |^Almost no motion \(|\)$/g, "");
    const bad = check.reading._tag === "measured" && check.reading.tone === "bad";
    if (check.value !== null) return bad ? `${check.sentence} · ${check.value}` : check.value;
    return check.sentence.toLowerCase() === name.toLowerCase() ? "Yes" : check.sentence;
  };
  // Two readings that differ never read alike: when their words match, the measured values show.
  const cells = (delta: GameFactDelta, name: string, same: boolean) => {
    const a = cell("a", delta.id, name, delta.a);
    const b = cell("b", delta.id, name, delta.b);
    return !same && a !== null && a === b ? { a: delta.a, b: delta.b } : { a, b };
  };
  const rows: Array<CompareRow> = [];
  const unmeasured = new Map<string, Array<string>>();
  const oneSided = new Map<string, { side: "A" | "B"; why: string; names: Array<string> }>();
  const missing = (side: "A" | "B", why: string, name: string) => {
    const key = `${side}\0${why}`;
    const entry = oneSided.get(key) ?? { side, why, names: [] };
    entry.names.push(name);
    oneSided.set(key, entry);
  };
  const ordered = [...deltas].sort((x, y) => {
    const rank = (id: GameFactId) => {
      const at = LEAD_ORDER.indexOf(id);
      return at === -1 ? LEAD_ORDER.length : at;
    };
    return rank(x.id) - rank(y.id);
  });
  for (const delta of ordered) {
    // Picture detail is kept to tell builds apart, a fingerprint rather than a reading: its
    // numbers mean nothing to read side by side.
    if (delta.id === "detail") continue;
    const name = COMPARE_NAMES[delta.id] ?? gameFactName(delta.id);
    const whyA = sideWhy(viewsA.find((view) => view.id === delta.id));
    const whyB = sideWhy(viewsB.find((view) => view.id === delta.id));
    if (delta.change === "not-comparable" && delta.a === null && delta.b === null) {
      const why =
        whyA === whyB || whyB === null
          ? (whyA ?? plainWhy(delta.why ?? "no reading"))
          : whyA === null
            ? whyB
            : `A: ${whyA}; B: ${whyB}`;
      unmeasured.set(why, [...(unmeasured.get(why) ?? []), name]);
      continue;
    }
    if (delta.change === "not-comparable") {
      rows.push({
        id: delta.id,
        name,
        ...cells(delta, name, false),
        mark: null,
        tone: null,
        // A side's missing reading is said once, with every row it applies to, above the table.
        note:
          delta.a === null || delta.b === null
            ? null
            : `Not comparable: ${plainWhy(delta.why ?? "measured differently")}`,
      });
      if (delta.a === null) missing("A", whyA ?? "no reading", name);
      else if (delta.b === null) missing("B", whyB ?? "no reading", name);
      continue;
    }
    const line = deltaLine(delta);
    rows.push({
      id: delta.id,
      name,
      ...cells(delta, name, line.mark === "="),
      mark: line.mark,
      tone: line.tone,
      note: null,
    });
  }
  // What differs leads; readings that are the same follow, so the answer is read first.
  const same = (row: CompareRow) => row.mark === "=";
  return {
    rows: [...rows.filter((row) => !same(row)), ...rows.filter(same)],
    unmeasured: [...unmeasured].map(([why, names]) => ({ names, why })),
    oneSided: [...oneSided.values()],
  };
};

/**
 * PURE. A row's change in words: better or worse where the check has a better, else which
 * way the number moved. Null when the readings are the same or cannot be compared.
 */
export const changeWord = (row: Pick<CompareRow, "id" | "mark" | "tone">): string | null => {
  if (row.mark === null || row.mark === "=") return null;
  if (row.tone === "better") return "Better";
  if (row.tone === "worse") return "Worse";
  if (row.mark === "≠") return "Changed";
  const up = row.mark === "↑";
  // A time moves later or earlier; an amount is more or less.
  return RUN_FACTS.has(row.id) || row.id === "first-response"
    ? up
      ? "Later"
      : "Earlier"
    : up
      ? "More"
      : "Less";
};

/** PURE. A build's checks have settled: measured, with or without some not measured. */
export const factsSettled = (summary: Pick<GameBuildFactsSummary, "state">): boolean =>
  summary.state === "measured" || summary.state === "incomplete";

/**
 * PURE. How many more lead checks pass on `build` than on `before`, counted only over the
 * checks both measured: a check one build could not measure is no gain or loss. Null when
 * either build has not settled, or they share no measured check, so a build being measured
 * is never shown as better or worse.
 */
export const passDelta = (
  build: Pick<GameBuild, "facts">,
  before: Pick<GameBuild, "facts"> | null,
): number | null => {
  if (before === null || !factsSettled(build.facts) || !factsSettled(before.facts)) return null;
  const now = build.facts.lead;
  const then = before.facts.lead;
  if (now?.measured === undefined || then?.measured === undefined) return null;
  const both = new Set(now.measured.filter((id) => then.measured!.includes(id)));
  if (both.size === 0) return null;
  const passes = (ids: ReadonlyArray<string> | undefined) =>
    (ids ?? []).filter((id) => both.has(id as never)).length;
  return passes(now.passing) - passes(then.passing);
};

/**
 * PURE. A build's checks in one line, as every surface says them: the count once they have
 * settled ("5 of 7 pass · 1 to look at"), else the state they are in ("Measuring…").
 */
export const checksLine = (facts: GameBuild["facts"]): string =>
  factsSettled(facts)
    ? (checksPhrase(facts) ?? "Measured")
    : (factsSummaryLine(facts) ?? "Not measured yet");

/** PURE. A build's name inside a sentence: "build 5", "step 2's build", a saved build's label. */
export const buildPhrase = (name: string): string =>
  name.replace(/^Build /, "build ").replace(/^Step /, "step ");
