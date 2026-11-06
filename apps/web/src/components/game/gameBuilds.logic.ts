import * as Schema from "effect/Schema";
import {
  GameBuildId,
  type GameBuild,
  type GameBuildFactsSummary,
  type GameBuildSource,
  type GameBuildsResult,
  type GameFactDelta,
  type GameFactTone,
  type GameFactView,
  type GameRunRoundRef,
} from "@kurambit/contracts";

const isBuildId = Schema.is(GameBuildId);

/** The game's latest restore, as the Builds list carries it. */
export type GameBuildRestore = NonNullable<GameBuildsResult["restore"]>;

/** Where a build came from, in the rail's words. */
export const buildSourceLabel = (source: GameBuildSource): string => {
  switch (source._tag) {
    case "turn":
      return `Turn ${source.turn} · ${source.threadTitle}`;
    case "round":
      return `Round ${source.round} · ${
        source.outcome === "kept"
          ? "kept"
          : source.outcome === "not-kept"
            ? "not kept"
            : "abandoned"
      }${source.best ? " · best" : ""}`;
    case "saved":
      return source.label;
  }
};

/** A build named in a sentence: "Turn 5's build", "Round 3's build", a saved build's label. */
export const buildName = (build: Pick<GameBuild, "source">): string => {
  const source = build.source;
  switch (source._tag) {
    case "turn":
      return `Turn ${source.turn}'s build`;
    case "round":
      return `Round ${source.round}'s build`;
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

/** The latest restore in one line, whoever asked for it. */
export const restoreLine = (restore: GameBuildRestore): string =>
  restore.outcome === null
    ? `Restoring ${restore.label}…`
    : restore.outcome.restored
      ? `Restored ${restore.label}.`
      : `Restoring ${restore.label} failed: ${restore.outcome.message}`;

export interface RoundCardAction {
  readonly kind: "revert" | "keep";
  /** The build the restore puts in the folder. */
  readonly target: GameBuildId;
  /** Keep makes the round's build the run's best (CONTRACT A1), so a resume continues from it. */
  readonly asBest: boolean;
  readonly label: string;
  /** Why it cannot be pressed now, or null. */
  readonly blocked: string | null;
}

/**
 * What a round card offers against the run's own decision (CONTRACT A1). A
 * kept round that is still the best can revert to the best it was judged
 * against; a round that was not kept can be kept, which puts its build in the
 * folder and makes it the run's best. Both wait for a stopped run and an idle
 * chat: while the run is live it decides, and a turn may be writing the folder.
 */
export const roundCardAction = (
  round: Pick<GameRunRoundRef, "outcome" | "build" | "base">,
  run: { readonly active: boolean; readonly best: string | null },
  turnRunning = false,
): RoundCardAction | null => {
  const build = round.build ?? null;
  const base = round.base ?? null;
  if (build === null || !isBuildId(build)) return null;
  const blocked = run.active
    ? "Stop the run to keep or revert a round; while it is live, the run decides."
    : turnRunning
      ? "Wait for the agent's turn to end to keep or revert a round."
      : null;
  if (round.outcome === "kept") {
    if (run.best !== build || base === null || !isBuildId(base) || base === build) return null;
    return {
      kind: "revert",
      target: base,
      asBest: false,
      label: "Revert to the build before it",
      blocked,
    };
  }
  if (round.outcome === "abandoned" || run.best === build) return null;
  return {
    kind: "keep",
    target: build,
    asBest: true,
    label: "Keep this build as the run's best",
    blocked,
  };
};
