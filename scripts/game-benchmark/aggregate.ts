// @effect-diagnostics nodeBuiltinImport:off -- The benchmark CLI aggregates files it wrote next to the run logs.
import type {
  GameVisualDimension,
  GameVisualDimensionScore,
  GameVisualJudgement,
} from "../../packages/contracts/src/index.ts";
import type {
  GameBenchmarkBrief,
  GameBenchmarkObligationRead,
  GameE2eRunSummary,
  GameE2eTurnRead,
} from "./artifacts.ts";
import { visualRepairDelta } from "./artifacts.ts";

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

export const BENCHMARK_LANES = ["harness", "raw"] as const;
/** `harness` runs today's e2e flow; `raw` asks the bare agent to build the game. */
export type BenchmarkLane = (typeof BENCHMARK_LANES)[number];

/**
 * The independent grader's row, read from `<brief>/grade/grade.json`. It is
 * deliberately small: the full grade and its frames stay next to the run.
 */
export interface BenchmarkGrade {
  readonly build: string;
  readonly quick: {
    readonly booted: boolean;
    readonly consoleErrors: number;
    readonly responded: boolean;
  } | null;
  readonly obligationIds: ReadonlyArray<string>;
  readonly obligations: { readonly yes: number; readonly total: number };
  readonly control: boolean;
  readonly void: boolean;
  readonly solCalls: number;
}

/** A malformed or missing grade reads as absent, never as a pass. */
export function readGradeSummary(value: unknown): BenchmarkGrade | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const build = record.build as { readonly kind?: unknown } | undefined;
  if (build === undefined || typeof build.kind !== "string") return null;
  const quick = record.quick as Record<string, unknown> | null | undefined;
  const obligations = Array.isArray(record.obligations)
    ? (record.obligations as ReadonlyArray<Record<string, unknown>>)
    : [];
  const control = record.control as { readonly yes?: unknown } | undefined;
  return {
    build: build.kind,
    quick:
      quick === null || quick === undefined
        ? null
        : {
            booted: quick.booted === true,
            consoleErrors: Number(quick.consoleErrors ?? 0),
            responded: quick.responded === true,
          },
    obligationIds: obligations
      .filter((obligation) => obligation.yes === true && typeof obligation.id === "string")
      .map((obligation) => obligation.id as string),
    obligations: {
      yes: obligations.filter((obligation) => obligation.yes === true).length,
      total: obligations.length,
    },
    control: control?.yes === true,
    void: record.void === true,
    solCalls: Number(record.solCalls ?? 0),
  };
}

/** What the command observed outside the runner's own summary. */
export interface BenchmarkRunObservation {
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly summary: GameE2eRunSummary | null;
}

export interface BenchmarkBriefResult {
  readonly schemaVersion: 1;
  readonly lane: BenchmarkLane;
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
    /** The recorded (last) judgement's scores, kept for the review table. */
    readonly dimensions: ReadonlyArray<GameVisualDimensionScore>;
    /** Every judgement the run earned, oldest first; a repair adds one. */
    readonly judgements: ReadonlyArray<GameVisualJudgement>;
    readonly frames: ReadonlyArray<{ readonly id: string; readonly role: string }>;
    readonly detail: string | null;
  };
  /**
   * Summed dimension-score change from the first judgement to the last. `null`
   * when the run judged fewer than twice.
   */
  readonly repairDelta: number | null;
  readonly playtest: {
    readonly frames: number;
    readonly responded: boolean;
    readonly qualifies: boolean | null;
    readonly blockers: ReadonlyArray<string>;
  } | null;
  readonly stages: ReadonlyArray<{ readonly stage: string; readonly status: string }>;
  /** The independent grader's reading; null when the game was never gradeable. */
  readonly grade: BenchmarkGrade | null;
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
  // Playable completion, not optional certification: a rule-following run must
  // not fail because test/state were left out.
  if (qualification.completion !== "complete") {
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
  readonly lane?: BenchmarkLane;
  readonly grade?: BenchmarkGrade | null;
}): BenchmarkBriefResult {
  const summary = input.observation.summary;
  const verdict = classifyRun(input.observation);
  const visual = summary === null ? null : visualReading(summary);
  const judgements = summary?.visualJudgements ?? [];
  return {
    schemaVersion: 1,
    lane: input.lane ?? "harness",
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
      judgements,
      frames: visual?.frames ?? [],
      detail: visual?.judgement?.detail ?? null,
    },
    repairDelta: visualRepairDelta(judgements),
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
    grade: input.grade ?? null,
  };
}

/**
 * The raw lane's row: there is no run summary, so the independent grade is the
 * only reading. `outcome` records whether a gradable build came out of the run,
 * not how good the game was; the obligation table carries quality.
 */
export function readRawResult(input: {
  readonly harnessCommit: string;
  readonly brief: GameBenchmarkBrief;
  readonly fixtureChecksum: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly grade: BenchmarkGrade | null;
}): BenchmarkBriefResult {
  const grade = input.grade;
  const outcome: BenchmarkOutcome = input.timedOut
    ? "timeout"
    : grade === null || grade.build === "no-build"
      ? "crashed"
      : "passed";
  const reason = input.timedOut
    ? "The raw agent hit its cap."
    : grade === null
      ? `No grade was written (exit ${input.exitCode ?? "?"}).`
      : `build=${grade.build}; quick=${
          grade.quick === null
            ? "—"
            : `${grade.quick.booted ? "booted" : "no-boot"}, ${grade.quick.consoleErrors} console error(s), ${
                grade.quick.responded ? "responded" : "no response"
              }`
        }; obligations ${grade.obligations.yes}/${grade.obligations.total} YES; void=${grade.void}.`;
  return {
    schemaVersion: 1,
    lane: "raw",
    harnessCommit: input.harnessCommit,
    fixtureId: input.brief.id,
    title: input.brief.title,
    template: input.brief.template,
    fixtureChecksum: input.fixtureChecksum,
    outcome,
    failureReason: reason,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    turns: [],
    judgeCalls: grade?.solCalls ?? 0,
    obligations: input.brief.obligations.map((obligation) => ({
      id: obligation.id,
      kind: obligation.kind,
      description: obligation.description,
      key: obligation.key ?? null,
      expect: obligation.expect ?? null,
      status:
        grade !== null && grade.obligationIds.includes(obligation.id)
          ? ("proven" as const)
          : ("failed" as const),
      detail:
        grade === null
          ? "No gradable build."
          : grade.void
            ? "The grade is void: the control item passed."
            : obligation.description,
      criteria: [],
    })),
    visual: { status: null, dimensions: [], judgements: [], frames: [], detail: null },
    repairDelta: null,
    playtest:
      grade?.quick === null || grade?.quick === undefined
        ? null
        : {
            frames: 0,
            responded: grade.quick.responded,
            qualifies: grade.quick.booted && grade.quick.consoleErrors === 0,
            blockers: [],
          },
    stages: [],
    grade,
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

/** Initials keep one judgement's six scores on one line in the report. */
const DIMENSION_KEYS: Record<GameVisualDimension, string> = {
  readability: "r",
  valueSeparation: "v",
  cameraFraming: "c",
  styleConsistency: "s",
  feedback: "f",
  designCompliance: "d",
};

const signed = (value: number) => (value > 0 ? `+${value}` : String(value));

/** `first→last` when the run judged twice, the single score otherwise. */
const dimensionCell = (
  result: BenchmarkBriefResult,
  dimension: GameVisualDimension,
  last: string,
): string => {
  const first = result.visual.judgements[0]?.dimensions.find(
    (score) => score.dimension === dimension,
  )?.score;
  return result.visual.judgements.length > 1 && first !== undefined ? `${first}→${last}` : last;
};

const judgementLine = (judgement: GameVisualJudgement): string =>
  `${judgement.judgedAt} ${judgement.status} ${judgement.dimensions
    .map((score) => `${DIMENSION_KEYS[score.dimension]}=${score.score}`)
    .join(" ")}`;

/** A row is only reused when it measures the same commit, lane and fixture bytes. */
export function shouldResume(
  existing: {
    readonly harnessCommit: string;
    readonly fixtureChecksum: string;
    readonly lane?: BenchmarkLane;
  } | null,
  expected: {
    readonly harnessCommit: string;
    readonly checksum: string;
    readonly lane?: BenchmarkLane;
  },
): boolean {
  return (
    existing !== null &&
    existing.harnessCommit === expected.harnessCommit &&
    existing.fixtureChecksum === expected.checksum &&
    (existing.lane ?? "harness") === (expected.lane ?? "harness")
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
    !(BENCHMARK_OUTCOMES as ReadonlyArray<string>).includes(record.outcome) ||
    (record.lane !== undefined &&
      !(BENCHMARK_LANES as ReadonlyArray<string>).includes(record.lane as string))
  )
    return null;
  return record as unknown as BenchmarkBriefResult;
}

/** The human table a reviewer reads; every attempted brief keeps its row. */
export function renderResultsMarkdown(input: {
  readonly harnessCommit: string;
  readonly lane?: BenchmarkLane;
  readonly results: ReadonlyArray<BenchmarkBriefResult>;
}): string {
  const lane = input.lane ?? "harness";
  const totals = summarizeResults(input.results);
  const outcomeText = BENCHMARK_OUTCOMES.filter((outcome) => totals.outcomes[outcome] > 0)
    .map((outcome) => `${totals.outcomes[outcome]} ${outcome}`)
    .join(", ");
  const lines = [
    `# Game Studio benchmark — ${input.harnessCommit} (${lane} lane)`,
    "",
    `${totals.attempted} brief(s) attempted: ${outcomeText || "none"}.`,
    ...(lane === "harness"
      ? [
          `Pass rate ${totals.outcomes.passed}/${totals.attempted} (${percent(totals.passRate)}); failures stay in the denominator.`,
          `Obligations: ${totals.obligations.proven} proven, ${totals.obligations.failed} failed, ${totals.obligations.unsupported} unsupported.`,
        ]
      : [
          "The outcome column only records whether a gradable build came out of the run; the independent grade below carries quality.",
          `Obligations (independent grade): ${totals.obligations.proven} YES, ${totals.obligations.failed} NO.`,
        ]),
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
      return `| ${result.fixtureId} | ${result.outcome} | ${proven}/${failed}/${unsupported} | ${visual} | ${result.repairDelta === null ? "—" : signed(result.repairDelta)} | ${result.judgeCalls} | ${turnCell(result.turns)} |`;
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
        dimensionCell(result, dimension, String(byDimension.get(dimension) ?? "—")),
      ).join(" | ")} |`;
    }),
    "",
    "## Independent grade",
    "",
    "`scripts/game-grade.ts` over pixels and console only; obligations are judged from their descriptions,",
    "so the design vocabulary's `unsupported` ones are graded too. A passing control item voids the grade.",
    "",
    "| Brief | Build | Boot | Console errors | Input changed | Obligations YES | Control | Void | Sol calls |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...input.results.map((result) => {
      const grade = result.grade;
      if (grade === null) return `| ${result.fixtureId} | no grade | — | — | — | — | — | — | — |`;
      return `| ${result.fixtureId} | ${grade.build} | ${
        grade.quick === null ? "—" : grade.quick.booted ? "booted" : "no boot"
      } | ${grade.quick === null ? "—" : grade.quick.consoleErrors} | ${
        grade.quick === null ? "—" : grade.quick.responded ? "yes" : "no"
      } | ${grade.obligations.yes}/${grade.obligations.total} | ${grade.control ? "YES" : "no"} | ${
        grade.void ? "VOID" : "no"
      } | ${grade.solCalls} |`;
    }),
    "",
    "## Judgements",
    "",
    ...input.results.flatMap((result) =>
      result.visual.judgements.length === 0
        ? []
        : [
            `- **${result.fixtureId}**: ${result.visual.judgements
              .map((judgement, index) => `#${index + 1} ${judgementLine(judgement)}`)
              .join("; ")}`,
          ],
    ),
    ...(input.results.every((result) => result.visual.judgements.length === 0) ? ["- None."] : []),
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
    "> Repair Δ sums the dimension-score change from the first judgement to the last;",
    "> a repair round inside the build turn adds a second judgement. Scores are 0–4, `missing`",
    "> means the frames showed no evidence, and scores are compared per dimension, never averaged.",
    "",
  ];
  return lines.join("\n");
}
