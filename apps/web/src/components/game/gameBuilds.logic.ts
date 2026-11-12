import {
  type GameAssetFacts,
  type GameAssetUse,
  type GameBuild,
  type GameBuildFactsSummary,
  type GameBuildsResult,
  type GameFactDelta,
  type GameFactTone,
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
      return "Not measured";
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
  const pass =
    facts.lead === undefined ? `${facts.good} pass` : `${facts.lead.pass} of ${facts.lead.of} pass`;
  return facts.bad > 0 ? `${pass} · ${facts.bad} to look at` : pass;
};
