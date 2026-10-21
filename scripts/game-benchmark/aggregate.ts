// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- The benchmark CLI aggregates files it wrote next to the run logs.
import type { GameVisualDimensionScore } from "../../packages/contracts/src/index.ts";
import type {
  GameBenchmarkBrief,
  GameBenchmarkObligationRead,
  GameE2eRunSummary,
  GameE2eTurnRead,
} from "./artifacts.ts";

export const BENCHMARK_OUTCOMES = [
  "passed",
  "failed-mechanics",
  "failed-visual",
  "evidence-gap",
  "unsupported",
  "crashed",
  "timeout",
] as const;
export type BenchmarkOutcome = (typeof BENCHMARK_OUTCOMES)[number];

/** What the command observed outside the runner's own summary. */
export interface BenchmarkRunObservation {
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly summary: GameE2eRunSummary | null;
}

export interface BenchmarkBriefMeta {
  readonly id: string;
  readonly title: string;
  readonly template: string;
  readonly checksum: string;
}

export interface BenchmarkBriefResult {
  readonly schemaVersion: 1;
  readonly harnessCommit: string;
  readonly fixtureId: string;
  readonly title: string;
  readonly template: string;
  readonly fixtureChecksum: string;
  readonly outcome: BenchmarkOutcome;
  readonly failureReason: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly turns: ReadonlyArray<GameE2eTurnRead>;
  readonly judgeCalls: number;
  readonly obligations: ReadonlyArray<GameBenchmarkObligationRead>;
  readonly visual: {
    readonly status: "passed" | "failed" | "unavailable" | null;
    readonly dimensions: ReadonlyArray<GameVisualDimensionScore>;
    readonly frames: ReadonlyArray<{ readonly id: string; readonly role: string }>;
    readonly detail: string | null;
  };
  /**
   * Score change from the first to the second judgement. This command runs one
   * generation per brief with no repair turn, so it stays null here; the field
   * exists so a repaired run can report the same table.
   */
  readonly repairDelta: null;
  readonly playtest: {
    readonly frames: number;
    readonly responded: boolean;
    readonly qualifies: boolean | null;
    readonly blockers: ReadonlyArray<string>;
  } | null;
  readonly stages: ReadonlyArray<{ readonly stage: string; readonly status: string }>;
}

const GAMEPLAY_ROLES = new Set(["early", "interaction", "hazard", "later", "finish"]);

const stageSummary = (summary: GameE2eRunSummary): string => {
  const qualification = summary.qualification;
  if (qualification === null) return "no qualification record";
  const failed = qualification.stages
    .filter((stage) => stage.stage !== "visual" && stage.status !== "passed")
    .map((stage) => `${stage.stage}=${stage.status}`);
  return failed.length === 0 ? "every mechanical stage passed" : failed.join(", ");
};

const stateDetail = (summary: GameE2eRunSummary): string | null => {
  const state = summary.qualification?.stages.find((stage) => stage.stage === "state");
  return state?.detail ?? null;
};

const visualReading = (summary: GameE2eRunSummary) => {
  const stage = summary.qualification?.stages.find((entry) => entry.stage === "visual");
  const judgement = stage?.visual ?? null;
  const frames = judgement?.frames.map((frame) => ({ id: frame.id, role: frame.role })) ?? [];
  const dimensions = judgement?.dimensions ?? [];
  const gameplayFrame = frames.some((frame) => GAMEPLAY_ROLES.has(frame.role));
  const scored = dimensions.filter((dimension) => dimension.score !== "missing");
  // Missing evidence is not a failed look: no current judgement, a stale or
  // missing stage, no gameplay frame, or no scored dimension leaves the
  // question unanswered. A result panel alone can never pass.
  const gap =
    judgement === null ||
    judgement.status === "unavailable" ||
    !gameplayFrame ||
    scored.length === 0 ||
    (stage?.status !== "passed" && stage?.status !== "failed");
  return {
    stage,
    judgement,
    frames,
    dimensions,
    gap,
    judgeCalls: judgement === null ? 0 : Math.max(0, 2 - Math.min(2, judgement.roundsLeft)),
  };
};

/** The run's verdict, in the order that keeps a crash from masquerading as one. */
export function classifyRun(observation: BenchmarkRunObservation): {
  readonly outcome: BenchmarkOutcome;
  readonly reason: string;
} {
  const summary = observation.summary;
  if (observation.timedOut || summary?.timedOut === true)
    return {
      outcome: "timeout",
      reason:
        summary?.error ??
        `The runner did not finish within its timeout (exit ${observation.exitCode ?? observation.signal ?? "?"}).`,
    };
  if (summary === null)
    return {
      outcome: "crashed",
      reason: `The runner wrote no readable summary (exit ${observation.exitCode ?? observation.signal ?? "?"}).`,
    };
  if (observation.exitCode !== null && observation.exitCode !== 0 && summary.error === null)
    return {
      outcome: "crashed",
      reason: `The runner exited ${observation.exitCode} without recording an error.`,
    };
  if (summary.qualification === null)
    return {
      outcome: "crashed",
      reason: summary.error ?? `The run stopped at ${summary.phase} before a build was graded.`,
    };

  const qualification = summary.qualification;
  if (!qualification.mechanicsQualified) {
    const detail = stateDetail(summary);
    return {
      outcome: "failed-mechanics",
      reason: `${stageSummary(summary)}${detail === null ? "" : ` — ${detail}`}${
        summary.error === null ? "" : ` (runner: ${summary.error})`
      }`,
    };
  }
  const failedObligations = summary.obligations.filter(
    (obligation) => obligation.status === "failed" || obligation.status === "missing",
  );
  if (failedObligations.length > 0)
    return {
      outcome: "failed-mechanics",
      reason: `Frozen obligations not proven: ${failedObligations
        .map((obligation) => `${obligation.id} (${obligation.status})`)
        .join(", ")}.`,
    };

  const visual = visualReading(summary);
  if (visual.gap)
    return {
      outcome: "evidence-gap",
      reason:
        visual.judgement?.detail ??
        (visual.stage === undefined
          ? "No visual stage was recorded for the current build."
          : `The visual stage is ${visual.stage.status} without usable gameplay frames.`),
    };
  if (visual.stage?.status !== "passed" || visual.judgement?.status === "failed")
    return {
      outcome: "failed-visual",
      reason:
        visual.judgement?.detail ??
        `The visual stage is ${visual.stage?.status ?? "missing"} on judged gameplay frames.`,
    };
  if (summary.error !== null)
    return { outcome: "crashed", reason: `The run failed after its verdict: ${summary.error}` };

  const unsupported = summary.obligations.filter(
    (obligation) => obligation.status === "unsupported",
  );
  if (unsupported.length > 0)
    return {
      outcome: "unsupported",
      reason: `${unsupported.length} frozen obligation(s) are outside the proof vocabulary: ${unsupported
        .map((obligation) => obligation.id)
        .join(", ")}.`,
    };
  return {
    outcome: "passed",
    reason: "Mechanics, frozen obligations and visual judgement passed.",
  };
}

const unreadObligations = (brief: GameBenchmarkBrief): ReadonlyArray<GameBenchmarkObligationRead> =>
  brief.obligations.map((obligation) => ({
    id: obligation.id,
    kind: obligation.kind,
    description: obligation.description,
    key: obligation.key ?? null,
    expect: obligation.expect ?? null,
    status: obligation.unsupported === undefined ? "missing" : "unsupported",
    detail: obligation.unsupported ?? "The run ended before the approved design could be graded.",
    criteria: [],
  }));

/** Builds the row the aggregate stores for one brief, including its failures. */
export function readBenchmarkResult(input: {
  readonly harnessCommit: string;
  readonly brief: GameBenchmarkBrief;
  readonly fixtureChecksum: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly observation: BenchmarkRunObservation;
}): BenchmarkBriefResult {
  const summary = input.observation.summary;
  const verdict = classifyRun(input.observation);
  const visual = summary === null ? null : visualReading(summary);
  return {
    schemaVersion: 1,
    harnessCommit: input.harnessCommit,
    fixtureId: input.brief.id,
    title: input.brief.title,
    template: input.brief.template,
    fixtureChecksum: input.fixtureChecksum,
    outcome: verdict.outcome,
    failureReason: verdict.reason,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    turns: summary?.turns ?? [],
    judgeCalls: visual?.judgeCalls ?? 0,
    obligations:
      summary === null || summary.obligations.length === 0
        ? unreadObligations(input.brief)
        : summary.obligations,
    visual: {
      status: visual?.judgement?.status ?? null,
      dimensions: visual?.dimensions ?? [],
      frames: visual?.frames ?? [],
      detail: visual?.judgement?.detail ?? null,
    },
    repairDelta: null,
    playtest:
      summary?.lastPlaytest === null || summary?.lastPlaytest === undefined
        ? null
        : {
            frames: summary.lastPlaytest.frames.length,
            responded: summary.lastPlaytest.responded,
            qualifies: summary.lastPlaytest.qualifies ?? null,
            blockers: summary.lastPlaytest.blockers ?? [],
          },
    stages:
      summary?.qualification?.stages.map((stage) => ({
        stage: stage.stage,
        status: stage.status,
      })) ?? [],
  };
}

export interface BenchmarkTotals {
  readonly attempted: number;
  readonly outcomes: Readonly<Record<BenchmarkOutcome, number>>;
  readonly obligations: {
    readonly proven: number;
    readonly failed: number;
    readonly unsupported: number;
  };
  readonly passRate: number;
}

export function summarizeResults(results: ReadonlyArray<BenchmarkBriefResult>): BenchmarkTotals {
  const outcomes = Object.fromEntries(BENCHMARK_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    BenchmarkOutcome,
    number
  >;
  const obligations = { proven: 0, failed: 0, unsupported: 0 };
  for (const result of results) {
    outcomes[result.outcome] += 1;
    for (const obligation of result.obligations) {
      if (obligation.status === "proven") obligations.proven += 1;
      else if (obligation.status === "unsupported") obligations.unsupported += 1;
      else obligations.failed += 1;
    }
  }
  return {
    attempted: results.length,
    outcomes,
    obligations,
    passRate: results.length === 0 ? 0 : outcomes.passed / results.length,
  };
}

const seconds = (milliseconds: number) => `${Math.round(milliseconds / 1000)}s`;

const turnCell = (turns: ReadonlyArray<GameE2eTurnRead>) =>
  turns.length === 0
    ? "—"
    : turns.map((turn) => `${turn.name} ${seconds(turn.durationMs)}`).join(", ");

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

const DIMENSION_HEADERS = [
  "readability",
  "valueSeparation",
  "cameraFraming",
  "styleConsistency",
  "feedback",
  "designCompliance",
] as const;

/** A row is only reused when it measures the same harness commit and fixture bytes. */
export function shouldResume(
  existing: { readonly harnessCommit: string; readonly fixtureChecksum: string } | null,
  expected: { readonly harnessCommit: string; readonly checksum: string },
): boolean {
  return (
    existing !== null &&
    existing.harnessCommit === expected.harnessCommit &&
    existing.fixtureChecksum === expected.checksum
  );
}

/** Reads a result this command wrote. A malformed row is treated as absent. */
export function decodeBenchmarkResult(value: unknown): BenchmarkBriefResult | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.harnessCommit !== "string" ||
    typeof record.fixtureChecksum !== "string" ||
    typeof record.fixtureId !== "string" ||
    typeof record.outcome !== "string" ||
    !(BENCHMARK_OUTCOMES as ReadonlyArray<string>).includes(record.outcome)
  )
    return null;
  return record as unknown as BenchmarkBriefResult;
}

/** The human table a reviewer reads; every attempted brief keeps its row. */
export function renderResultsMarkdown(input: {
  readonly harnessCommit: string;
  readonly results: ReadonlyArray<BenchmarkBriefResult>;
}): string {
  const totals = summarizeResults(input.results);
  const outcomeText = BENCHMARK_OUTCOMES.filter((outcome) => totals.outcomes[outcome] > 0)
    .map((outcome) => `${totals.outcomes[outcome]} ${outcome}`)
    .join(", ");
  const lines = [
    `# Game Studio benchmark — ${input.harnessCommit}`,
    "",
    `${totals.attempted} brief(s) attempted: ${outcomeText || "none"}.`,
    `Pass rate ${totals.outcomes.passed}/${totals.attempted} (${percent(totals.passRate)}); failures stay in the denominator.`,
    `Obligations: ${totals.obligations.proven} proven, ${totals.obligations.failed} failed, ${totals.obligations.unsupported} unsupported.`,
    "",
    "| Brief | Outcome | Obligations p/f/u | Visual | Repair Δ | Judge calls | Turns |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...input.results.map((result) => {
      const proven = result.obligations.filter((o) => o.status === "proven").length;
      const failed = result.obligations.filter(
        (o) => o.status === "failed" || o.status === "missing",
      ).length;
      const unsupported = result.obligations.filter((o) => o.status === "unsupported").length;
      const visual =
        result.visual.status === null
          ? "—"
          : result.outcome === "evidence-gap"
            ? `evidence gap (${result.visual.status})`
            : result.visual.status;
      return `| ${result.fixtureId} | ${result.outcome} | ${proven}/${failed}/${unsupported} | ${visual} | — | ${result.judgeCalls} | ${turnCell(result.turns)} |`;
    }),
    "",
    "## Visual dimensions",
    "",
    `| Brief | ${DIMENSION_HEADERS.join(" | ")} |`,
    `| --- | ${DIMENSION_HEADERS.map(() => "---").join(" | ")} |`,
    ...input.results.map((result) => {
      const byDimension = new Map(
        result.visual.dimensions.map((dimension) => [dimension.dimension, dimension.score]),
      );
      return `| ${result.fixtureId} | ${DIMENSION_HEADERS.map((dimension) =>
        String(byDimension.get(dimension) ?? "—"),
      ).join(" | ")} |`;
    }),
    "",
    "## Failures and gaps",
    "",
    ...input.results
      .filter((result) => result.outcome !== "passed")
      .map((result) => `- **${result.fixtureId}** (${result.outcome}): ${result.failureReason}`),
    ...(input.results.some((result) => result.outcome !== "passed") ? [] : ["- None."]),
    "",
    "## Unsupported obligations",
    "",
    ...input.results.flatMap((result) => {
      const unsupported = result.obligations.filter(
        (obligation) => obligation.status === "unsupported",
      );
      if (unsupported.length === 0) return [];
      return [
        `- **${result.fixtureId}**: ${unsupported
          .map((obligation) => `${obligation.id} — ${obligation.detail}`)
          .join("; ")}`,
      ];
    }),
    ...(input.results.every((result) =>
      result.obligations.every((obligation) => obligation.status !== "unsupported"),
    )
      ? ["- None."]
      : []),
    "",
    "> Repair Δ stays — because this command runs one generation per brief with no repair",
    "> turn. Judgement 1 is the recorded visual verdict; a second judgement needs a repair run.",
    "",
  ];
  return lines.join("\n");
}
