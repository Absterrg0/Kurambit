import {
  type GameAssetFacts,
  type GameAssetUse,
  type GameBuild,
  type GameBuildFactsSummary,
  type GameBuildSource,
  type GameBuildsResult,
  type GameFactDelta,
  type GameFactTone,
  type GameFactView,
} from "@kurambit/contracts";

/** The game's latest restore, as the Builds list carries it. */
export type GameBuildRestore = NonNullable<GameBuildsResult["restore"]>;

/** Where a build came from, in the rail's words. */
export const buildSourceLabel = (source: GameBuildSource): string => {
  switch (source._tag) {
    case "turn":
      return `Turn ${source.turn} · ${source.threadTitle}`;
    case "saved":
      return source.label;
  }
};

/** A build named in a sentence: "Turn 5's build", "Step 2's build", a saved build's label. */
export const buildName = (build: Pick<GameBuild, "source">): string => {
  const source = build.source;
  switch (source._tag) {
    case "turn":
      return source.step === null ? `Turn ${source.turn}'s build` : `Step ${source.step.n}'s build`;
    case "saved":
      return source.label;
  }
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
 * The Assets row's detail: one line per made model, then what was only
 * counted. A model's numbers are measurements, never a verdict on its look.
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
  ...(assets.libraryFiles > 0
    ? [
        `${assets.libraryFiles} library file${assets.libraryFiles === 1 ? "" : "s"} credited in ASSETS.md`,
      ]
    : []),
];

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
