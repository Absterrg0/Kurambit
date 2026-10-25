import { assert, describe, it } from "@effect/vitest";
import {
  GAME_VISUAL_DIMENSIONS,
  type GameVisualJudgement,
  type LegacyGameQualificationRead as GameQualificationRead,
  type LegacyGameQualificationStageRead as GameQualificationStageRead,
} from "../../packages/contracts/src/legacyGameVisual.ts";
import {
  type GameLastPlaytest,
  type GameQualificationStageStatus,
  type GameSubmissionFacts,
} from "../../packages/contracts/src/index.ts";
import {
  assertGradeDescribesArtifact,
  readBenchmarkResult,
  readGradeSummary,
  classifyRun,
  decodeBenchmarkResult,
  renderResultsMarkdown,
  shouldRegradeReusedRaw,
  shouldResume,
} from "./aggregate.ts";
import type { BenchmarkEvaluationProfile, BenchmarkGrade } from "./aggregate.ts";
import type {
  GameBenchmarkBrief,
  GameBenchmarkObligationRead,
  GameE2eRunSummary,
} from "./artifacts.ts";

const stage = (
  name: GameQualificationStageRead["stage"],
  status: GameQualificationStageStatus,
  extra: Partial<GameQualificationStageRead> = {},
): GameQualificationStageRead => ({
  stage: name,
  status,
  sourceId: null,
  buildId: null,
  finishedAt: null,
  ...extra,
});

const judgement = (overrides: Partial<GameVisualJudgement> = {}): GameVisualJudgement => ({
  status: "passed",
  judgedAt: "2026-10-21T00:00:00.000Z",
  model: "judge/model",
  sourceId: "source",
  buildId: "build",
  designHash: "design",
  evidenceDirectory: "builds/playtests/run",
  frames: [{ id: "F1", label: "early", path: "F1.png", role: "early" }],
  dimensions: GAME_VISUAL_DIMENSIONS.map((dimension) => ({ dimension, score: 3 })),
  repairRequests: [],
  roundsLeft: 1,
  detail: "Every dimension reached the bar, with all required evidence.",
  ...overrides,
});

const qualification = (
  input: {
    readonly mechanicsQualified?: boolean;
    readonly completion?: GameQualificationRead["completion"];
    readonly stages?: ReadonlyArray<GameQualificationStageRead>;
    readonly withVisual?: boolean;
  } = {},
): GameQualificationRead => ({
  state: "qualified",
  completion: input.completion ?? "complete",
  mechanicsQualified: input.mechanicsQualified ?? true,
  sourceId: "source",
  buildId: "build",
  servedArtifactId: "build",
  stages: input.stages ?? [
    stage("design", "passed"),
    stage("check", "passed"),
    stage("test", "passed"),
    stage("export", "passed"),
    stage("playtest", "passed"),
    stage("state", "passed", { detail: "Every graded criterion changed after play started." }),
    ...(input.withVisual === false
      ? [stage("visual", "missing")]
      : [stage("visual", "passed", { visual: judgement() })]),
  ],
});

const obligation = (
  id: string,
  status: GameBenchmarkObligationRead["status"],
): GameBenchmarkObligationRead => ({
  id,
  kind: "mechanic",
  description: `${id} description`,
  key: "moves",
  expect: ">=1",
  status,
  detail: `${id} detail`,
  criteria: status === "unsupported" ? [] : ["moves-count"],
});

const selectedBuildId = "a".repeat(64);

const selectedBuildFacts = (overrides: Partial<GameSubmissionFacts> = {}): GameSubmissionFacts => ({
  buildId: selectedBuildId,
  directory: `builds/candidates/${selectedBuildId}`,
  checks: [
    { id: "build", status: "passed" },
    { id: "bytes", status: "passed" },
    { id: "sources", status: "passed" },
    { id: "playtest", status: "passed" },
    { id: "boot", status: "passed" },
    { id: "console", status: "passed" },
    { id: "input", status: "passed", detail: "4 input steps executed" },
  ],
  passed: true,
  reason: null,
  ...overrides,
});

const reviewStatus = (
  selectedFacts: GameSubmissionFacts | null | undefined,
): NonNullable<GameE2eRunSummary["review"]> => ({
  loop: null,
  phase: "interrupted",
  held: false,
  repairsLeft: 3,
  timeLeftMs: 0,
  budget: { repairs: 3, elapsedMs: 2_700_000 },
  restoreOffered: false,
  ...(selectedFacts === undefined ? {} : { selectedBuildFacts: selectedFacts }),
});

const selectedLoop = (buildId: string | null): NonNullable<GameE2eRunSummary["loop"]> => ({
  id: "loop-1",
  status: "interrupted",
  decision: "interrupt",
  reason: "deadline: the review did not finish within its budget.",
  startedAt: "2026-10-21T00:00:00.000Z",
  finishedAt: "2026-10-21T00:05:00.000Z",
  repairsUsed: 1,
  budget: { repairs: 3, elapsedMs: 2_700_000 },
  rounds: [],
  selectedBuildId: buildId,
  waitedMs: 300_000,
  timedOut: false,
});

const summary = (
  input: {
    readonly schemaVersion?: 1 | 2;
    readonly qualification?: GameQualificationRead | null;
    readonly obligations?: ReadonlyArray<GameBenchmarkObligationRead>;
    readonly error?: string | null;
    readonly phase?: string;
    readonly timedOut?: boolean;
    readonly lastPlaytest?: GameLastPlaytest | null;
    readonly visualJudgements?: ReadonlyArray<GameVisualJudgement>;
    readonly review?: GameE2eRunSummary["review"];
    readonly loop?: GameE2eRunSummary["loop"];
    readonly production?: GameE2eRunSummary["production"];
  } = {},
): GameE2eRunSummary => ({
  schemaVersion: input.schemaVersion ?? 1,
  harnessCommit: "commit",
  startedAt: "2026-10-21T00:00:00.000Z",
  durationMs: 1_000,
  phase: input.phase ?? "done",
  timedOut: input.timedOut ?? false,
  fixture: { id: "sokoban", checksum: "checksum" },
  game: null,
  turns: [{ name: "design", status: "completed", durationMs: 12_000 }],
  qualification: input.qualification === undefined ? qualification() : input.qualification,
  lastPlaytest: input.lastPlaytest ?? null,
  obligations: input.obligations ?? [obligation("count-move", "proven")],
  visualJudgements: input.visualJudgements ?? [],
  review: input.review ?? null,
  loop: input.loop ?? null,
  production: input.production ?? null,
  error: input.error ?? null,
});

const observe = (overrides: Partial<Parameters<typeof summary>[0]> = {}) => ({
  timedOut: false,
  exitCode: 0,
  signal: null,
  summary: summary(overrides),
});

const brief: GameBenchmarkBrief = {
  id: "sokoban",
  title: "Crate Dock",
  template: "blank",
  brief: "Push crates onto goals.",
  artDirection: "Warm crates on pale tiles.",
  obligations: [
    { id: "count-move", kind: "control", description: "A move.", key: "moves", expect: ">=1" },
    {
      id: "illegal-move",
      kind: "mechanic",
      description: "A rejected move is free.",
      unsupported: "No invariance check.",
    },
  ],
};

describe("classifyRun", () => {
  it("passes a run whose mechanics, obligations and visual judgement all held", () => {
    assert.equal(classifyRun(observe()).outcome, "passed");
  });

  it("reports failed mechanics with the failed stage and reason", () => {
    const verdict = classifyRun(
      observe({
        qualification: qualification({
          completion: "incomplete",
          mechanicsQualified: false,
          stages: [
            stage("export", "failed"),
            stage("state", "failed", { detail: "moves stayed at 0." }),
          ],
        }),
      }),
    );
    assert.equal(verdict.outcome, "failed-mechanics");
    assert.match(verdict.reason, /state=failed/);
    assert.match(verdict.reason, /moves stayed at 0/);
  });

  it("passes playable completion without the optional test/state certification", () => {
    const verdict = classifyRun(
      observe({
        qualification: qualification({
          mechanicsQualified: false,
          stages: [
            stage("design", "passed"),
            stage("check", "passed"),
            stage("test", "missing"),
            stage("export", "passed"),
            stage("playtest", "passed"),
            stage("state", "missing"),
            stage("visual", "passed", { visual: judgement() }),
          ],
        }),
      }),
    );
    assert.equal(verdict.outcome, "passed");
  });

  it("passes a schema 2 run on the selected build's verified facts, not stale folder stages", () => {
    const verdict = classifyRun(
      observe({
        schemaVersion: 2,
        qualification: qualification({
          completion: "incomplete",
          mechanicsQualified: false,
          stages: [
            stage("export", "passed"),
            stage("playtest", "stale", { detail: "Interaction: cards_played 0→1." }),
            stage("state", "stale", { detail: "A stale workspace still passed every criterion." }),
          ],
        }),
        review: reviewStatus(selectedBuildFacts()),
        loop: selectedLoop(selectedBuildId),
      }),
    );
    assert.equal(verdict.outcome, "passed");
    assert.notMatch(verdict.reason, /stale/);
  });

  it("keeps schema 1's folder completion gate for a stale workspace", () => {
    const verdict = classifyRun(
      observe({
        qualification: qualification({
          completion: "incomplete",
          mechanicsQualified: false,
          stages: [
            stage("playtest", "stale", { detail: "Interaction: cards_played 0→1." }),
            stage("state", "stale", { detail: "A stale workspace still passed every criterion." }),
          ],
        }),
      }),
    );
    assert.equal(verdict.outcome, "failed-mechanics");
    assert.match(verdict.reason, /playtest=stale, state=stale/);
  });

  it("still fails a schema 2 run whose frozen obligation is missing, not for its stale stages", () => {
    const verdict = classifyRun(
      observe({
        schemaVersion: 2,
        qualification: qualification({
          completion: "incomplete",
          mechanicsQualified: false,
          stages: [stage("state", "stale")],
        }),
        review: reviewStatus(selectedBuildFacts()),
        loop: selectedLoop(selectedBuildId),
        obligations: [obligation("count-move", "proven"), obligation("enemy-hp", "missing")],
      }),
    );
    assert.equal(verdict.outcome, "failed-mechanics");
    assert.match(verdict.reason, /enemy-hp \(missing\)/);
    assert.notMatch(verdict.reason, /stale/);
  });

  it("reports unsupported schema 2 obligations below a verified selected build", () => {
    const verdict = classifyRun(
      observe({
        schemaVersion: 2,
        review: reviewStatus(selectedBuildFacts()),
        loop: selectedLoop(selectedBuildId),
        obligations: [
          obligation("count-move", "proven"),
          obligation("illegal-move", "unsupported"),
        ],
      }),
    );
    assert.equal(verdict.outcome, "unsupported");
    assert.match(verdict.reason, /illegal-move/);
  });

  it("treats schema 2 without selected-build facts as an evidence gap, never a pass", () => {
    const noReview = classifyRun(observe({ schemaVersion: 2, review: null }));
    const noFacts = classifyRun(observe({ schemaVersion: 2, review: reviewStatus(null) }));
    assert.equal(noReview.outcome, "evidence-gap");
    assert.match(noReview.reason, /review status/);
    assert.equal(noFacts.outcome, "evidence-gap");
    assert.match(noFacts.reason, /submission facts/);
  });

  it("reports a selected build that failed its submission checks as failed mechanics", () => {
    const failed = selectedBuildFacts({
      passed: false,
      reason: "console: 2 console error(s)",
      checks: [
        { id: "build", status: "passed" },
        { id: "console", status: "failed", detail: "2 console error(s)" },
      ],
    });
    const verdict = classifyRun(
      observe({
        schemaVersion: 2,
        review: reviewStatus(failed),
        loop: selectedLoop(selectedBuildId),
      }),
    );
    assert.equal(verdict.outcome, "failed-mechanics");
    assert.match(verdict.reason, /selected build failed its submission checks/);
    assert.match(verdict.reason, /2 console error/);
  });

  it("rejects selected-build facts for a different build than Play serves", () => {
    const other = "b".repeat(64);
    const verdict = classifyRun(
      observe({
        schemaVersion: 2,
        review: reviewStatus(
          selectedBuildFacts({ buildId: other, directory: `builds/candidates/${other}` }),
        ),
        loop: selectedLoop(selectedBuildId),
      }),
    );
    assert.equal(verdict.outcome, "evidence-gap");
    assert.include(verdict.reason, other);
    assert.include(verdict.reason, selectedBuildId);
  });

  it("keeps a schema 2 error after the verdict as a crash", () => {
    const verdict = classifyRun(
      observe({
        schemaVersion: 2,
        review: reviewStatus(selectedBuildFacts()),
        loop: selectedLoop(selectedBuildId),
        error: "preview: HTTP 500",
      }),
    );
    assert.equal(verdict.outcome, "crashed");
    assert.match(verdict.reason, /after its verdict/);
  });

  it("reports a schema 2 run that errored before verification as crashed", () => {
    const verdict = classifyRun(
      observe({
        schemaVersion: 2,
        phase: "qualified",
        review: null,
        error: "review status unavailable",
      }),
    );
    assert.equal(verdict.outcome, "crashed");
    assert.match(verdict.reason, /review status unavailable/);
  });

  it("reports an obligation the approved design never named as failed mechanics", () => {
    const verdict = classifyRun(observe({ obligations: [obligation("count-move", "missing")] }));
    assert.equal(verdict.outcome, "failed-mechanics");
    assert.match(verdict.reason, /count-move \(missing\)/);
  });

  it("reports a judged visual failure as failed-visual", () => {
    const failed = judgement({
      status: "failed",
      dimensions: GAME_VISUAL_DIMENSIONS.map((dimension) => ({
        dimension,
        score: dimension === "readability" ? 2 : 3,
      })),
      detail: "readability scored 2 (needs 3)",
    });
    const verdict = classifyRun(
      observe({
        qualification: qualification({ stages: [stage("visual", "failed", { visual: failed })] }),
      }),
    );
    assert.equal(verdict.outcome, "failed-visual");
    assert.match(verdict.reason, /readability scored 2/);
  });

  it("reports a failed judgement even if the stage status lags behind it", () => {
    const failed = judgement({
      status: "failed",
      dimensions: GAME_VISUAL_DIMENSIONS.map((dimension) => ({
        dimension,
        score: dimension === "readability" ? 1 : 3,
      })),
    });
    const verdict = classifyRun(
      observe({
        qualification: qualification({ stages: [stage("visual", "passed", { visual: failed })] }),
      }),
    );
    assert.equal(verdict.outcome, "failed-visual");
  });

  it("reports a missing visual stage as an evidence gap, never a pass", () => {
    const verdict = classifyRun(
      observe({ qualification: qualification({ stages: [stage("visual", "missing")] }) }),
    );
    assert.equal(verdict.outcome, "evidence-gap");
  });

  it("treats a passed visual stage with only a result panel as an evidence gap", () => {
    const resultOnly = judgement({
      frames: [{ id: "F6", label: "result", path: "F6.png", role: "result" }],
    });
    const verdict = classifyRun(
      observe({
        qualification: qualification({
          stages: [stage("visual", "passed", { visual: resultOnly })],
        }),
      }),
    );
    assert.equal(verdict.outcome, "evidence-gap");
  });

  it("treats an unavailable judgement with no dimensions as an evidence gap", () => {
    const unavailable = judgement({ status: "unavailable", dimensions: [], frames: [] });
    const verdict = classifyRun(
      observe({
        qualification: qualification({
          stages: [stage("visual", "failed", { visual: unavailable })],
        }),
      }),
    );
    assert.equal(verdict.outcome, "evidence-gap");
  });

  it("reports unsupported obligations below a passing run", () => {
    const verdict = classifyRun(
      observe({
        obligations: [
          obligation("count-move", "proven"),
          obligation("illegal-move", "unsupported"),
        ],
      }),
    );
    assert.equal(verdict.outcome, "unsupported");
    assert.match(verdict.reason, /illegal-move/);
  });

  it("reports a timeout before anything else", () => {
    assert.equal(
      classifyRun({ timedOut: true, exitCode: null, signal: "SIGTERM", summary: null }).outcome,
      "timeout",
    );
    assert.equal(classifyRun(observe({ timedOut: true })).outcome, "timeout");
  });

  it("reports a run that wrote no summary as crashed", () => {
    const verdict = classifyRun({ timedOut: false, exitCode: 1, signal: null, summary: null });
    assert.equal(verdict.outcome, "crashed");
    assert.match(verdict.reason, /no readable summary/);
  });

  it("reports a failure before any build was graded as crashed", () => {
    const verdict = classifyRun(
      observe({ qualification: null, phase: "design", error: "Turn ended failed" }),
    );
    assert.equal(verdict.outcome, "crashed");
  });

  it("reports a failure after a passing verdict as crashed", () => {
    const verdict = classifyRun(observe({ error: "Preview HTTP 500" }));
    assert.equal(verdict.outcome, "crashed");
    assert.match(verdict.reason, /after its verdict/);
  });
});

describe("benchmark results", () => {
  const passed = readBenchmarkResult({
    harnessCommit: "commit",
    brief,
    fixtureChecksum: "checksum",
    startedAt: "2026-10-21T00:00:00.000Z",
    durationMs: 60_000,
    observation: observe(),
  });

  it("keeps failures in the denominator and counts obligations per status", () => {
    const crashed = readBenchmarkResult({
      harnessCommit: "commit",
      brief,
      fixtureChecksum: "checksum",
      startedAt: "2026-10-21T00:01:00.000Z",
      durationMs: 5_000,
      observation: { timedOut: false, exitCode: 1, signal: null, summary: null },
    });
    const failed = readBenchmarkResult({
      harnessCommit: "commit",
      brief: { ...brief, id: "racing", title: "Ridge Circuit", template: "3d-explorer" },
      fixtureChecksum: "other-checksum",
      startedAt: "2026-10-21T00:02:00.000Z",
      durationMs: 90_000,
      observation: observe({
        qualification: qualification({
          completion: "incomplete",
          mechanicsQualified: false,
          stages: [stage("state", "failed", { detail: "won never became 1." })],
        }),
      }),
    });
    const markdown = renderResultsMarkdown({
      harnessCommit: "commit",
      results: [passed, crashed, failed],
    });
    assert.match(markdown, /Pass rate 1\/3 \(33\.3%\)/);
    assert.match(markdown, /failures stay in the denominator/);
    assert.match(markdown, /\| sokoban \| passed \|/);
    assert.match(markdown, /\| sokoban \| crashed \|/);
    assert.match(markdown, /\| racing \| failed-mechanics \|/);
    assert.match(markdown, /Obligations: 2 proven, 1 failed, 1 unsupported\./);
    // A crashed row still names every frozen promise rather than dropping it.
    assert.match(markdown, /Unsupported obligations/);
    assert.match(markdown, /illegal-move — No invariance check\./);
  });

  it("carries the review loop's rounds, decisions and selected build into the result", () => {
    const loop = {
      id: "loop-1",
      status: "stopped" as const,
      decision: "promote" as const,
      reason: "The candidate is better.",
      startedAt: "2026-10-21T00:00:00.000Z",
      finishedAt: "2026-10-21T00:05:00.000Z",
      repairsUsed: 1,
      budget: { repairs: 3, elapsedMs: 1_200_000 },
      rounds: [
        {
          id: "round-1",
          status: "promoted" as const,
          decision: "promote" as const,
          reason: "The candidate is better.",
          candidateBuildId: "a".repeat(64),
          candidateDirectory: `builds/candidates/${"a".repeat(64)}`,
          startedAt: "2026-10-21T00:01:00.000Z",
          finishedAt: "2026-10-21T00:05:00.000Z",
        },
      ],
      selectedBuildId: "b".repeat(64),
      waitedMs: 300_000,
      timedOut: false,
    };
    const result = readBenchmarkResult({
      harnessCommit: "commit",
      brief,
      fixtureChecksum: "checksum",
      startedAt: "2026-10-21T00:00:00.000Z",
      durationMs: 600_000,
      observation: observe({ loop }),
    });
    assert.deepEqual(result.loop, loop);
  });

  it("records the first playable and final submit as separate report columns", () => {
    const production = {
      firstPlayableAt: "2026-10-21T00:12:00.000Z",
      firstPlayableMs: 12 * 60_000,
      lastSubmitAt: "2026-10-21T00:38:00.000Z",
      lastSubmitMs: 38 * 60_000,
      submissions: 4,
      budgetMs: 45 * 60_000,
    };
    const result = readBenchmarkResult({
      harnessCommit: "commit",
      brief,
      fixtureChecksum: "checksum",
      startedAt: "2026-10-21T00:00:00.000Z",
      durationMs: 600_000,
      observation: observe({ production }),
    });
    assert.deepEqual(result.production, production);
    const markdown = renderResultsMarkdown({ harnessCommit: "commit", results: [result] });
    assert.match(markdown, /\| Production first\/last \|/);
    assert.match(markdown, /\| 12m \/ 38m \|/);
  });

  it("renders per-dimension scores and rates a run that judged once as no repair", () => {
    const markdown = renderResultsMarkdown({ harnessCommit: "commit", results: [passed] });
    assert.match(markdown, /\| readability \| valueSeparation \|/);
    assert.match(markdown, /\| sokoban \| 3 \| 3 \| 3 \| 3 \| 3 \| 3 \|/);
    assert.match(markdown, /Repair Δ sums the dimension-score change/);
    assert.match(markdown, /design 12s/);
  });

  it("records every judgement and shows the first-to-last score change", () => {
    const first = judgement({
      judgedAt: "2026-10-21T00:00:00.000Z",
      status: "failed",
      roundsLeft: 1,
      dimensions: GAME_VISUAL_DIMENSIONS.map((dimension) => ({
        dimension,
        score: dimension === "readability" ? 0 : 3,
      })),
    });
    const last = judgement({
      judgedAt: "2026-10-21T00:10:00.000Z",
      status: "failed",
      roundsLeft: 0,
      dimensions: GAME_VISUAL_DIMENSIONS.map((dimension) => ({
        dimension,
        score: dimension === "readability" ? 2 : 3,
      })),
    });
    const result = readBenchmarkResult({
      harnessCommit: "commit",
      brief,
      fixtureChecksum: "checksum",
      startedAt: "2026-10-21T00:00:00.000Z",
      durationMs: 60_000,
      observation: observe({
        visualJudgements: [first, last],
        qualification: qualification({ stages: [stage("visual", "failed", { visual: last })] }),
      }),
    });
    assert.equal(result.visual.judgements.length, 2);
    assert.equal(result.repairDelta, 2);
    const markdown = renderResultsMarkdown({ harnessCommit: "commit", results: [result] });
    assert.match(markdown, /\| sokoban \| failed-visual \|.*\| \+2 \|/);
    assert.match(markdown, /\| sokoban \| 0→2 \| 3→3 \| 3→3 \| 3→3 \| 3→3 \| 3→3 \|/);
    assert.match(markdown, /#1 2026-10-21T00:00:00.000Z failed r=0 v=3 c=3 s=3 f=3 d=3/);
    assert.match(markdown, /#2 2026-10-21T00:10:00.000Z failed r=2 v=3 c=3 s=3 f=3 d=3/);
  });
});

describe("resume", () => {
  it("reuses a row only for the same commit and fixture bytes", () => {
    const existing = { harnessCommit: "commit", fixtureChecksum: "checksum" };
    assert.equal(shouldResume(existing, { harnessCommit: "commit", checksum: "checksum" }), true);
    assert.equal(shouldResume(existing, { harnessCommit: "next", checksum: "checksum" }), false);
    assert.equal(shouldResume(existing, { harnessCommit: "commit", checksum: "changed" }), false);
    assert.equal(shouldResume(null, { harnessCommit: "commit", checksum: "checksum" }), false);
  });

  it("reuses a graded row only under the same evaluation profile", () => {
    const grade: BenchmarkGrade = {
      build: "existing",
      grader: { provider: "codex", model: "gpt-6.1-sol" },
      graderVersion: 3,
      target: null,
      quick: null,
      obligationIds: [],
      unansweredIds: [],
      obligations: { yes: 0, total: 0 },
      control: false,
      controlAnswered: true,
      void: false,
      inconclusive: false,
      solCalls: 0,
    };
    const evaluation: BenchmarkEvaluationProfile = {
      grader: { provider: "codex", model: "gpt-6.1-sol" },
      version: 3,
    };
    const existing = {
      harnessCommit: "commit",
      fixtureChecksum: "checksum",
      grade,
      evaluation,
    };
    const expected = { harnessCommit: "commit", checksum: "checksum", evaluation };
    assert.equal(shouldResume(existing, expected), true);
    assert.equal(
      shouldResume(existing, {
        ...expected,
        evaluation: { ...evaluation, version: 4 },
      }),
      false,
    );
    assert.equal(
      shouldResume(existing, {
        ...expected,
        evaluation: { ...evaluation, grader: { provider: "opencode", model: "minimax" } },
      }),
      false,
    );
    // A graded row from before the profile was recorded cannot be inherited.
    assert.equal(shouldResume({ ...existing, evaluation: null }, expected), false);
    // Nothing was graded, so the row carries no verdict a profile could change.
    assert.equal(
      shouldResume({ harnessCommit: "commit", fixtureChecksum: "checksum", grade: null }, expected),
      true,
    );
  });

  it("reuses a pre-profile raw row's build and regrades it", () => {
    const grade: BenchmarkGrade = {
      build: "existing",
      grader: { provider: "codex", model: "gpt-6.1-sol" },
      graderVersion: 3,
      target: null,
      quick: null,
      obligationIds: [],
      unansweredIds: [],
      obligations: { yes: 0, total: 0 },
      control: false,
      controlAnswered: true,
      void: false,
      inconclusive: false,
      solCalls: 0,
    };
    const evaluation: BenchmarkEvaluationProfile = {
      grader: { provider: "codex", model: "gpt-6.1-sol" },
      version: 3,
    };
    // The t42 cache predates the profile: its result.json has no evaluation key.
    const cached = decodeBenchmarkResult({
      schemaVersion: 1,
      lane: "raw",
      harnessCommit: "638d309d",
      fixtureId: "platformer",
      fixtureChecksum: "checksum",
      outcome: "passed",
      grade,
    });
    assert.notEqual(cached, null);
    assert.equal(Object.hasOwn(cached!, "evaluation"), false);
    assert.equal(shouldRegradeReusedRaw(cached!, evaluation), true);
    // A row already graded under this profile keeps its build and verdict.
    assert.equal(shouldRegradeReusedRaw({ ...cached!, evaluation }, evaluation), false);
  });
});

describe("grade summaries", () => {
  it("carries the grader that answered and the semantics it used", () => {
    const summary = readGradeSummary({
      build: { kind: "existing" },
      grader: { provider: "opencode", model: "minimax" },
      graderVersion: 3,
    });
    assert.deepEqual(summary?.grader, { provider: "opencode", model: "minimax" });
    assert.equal(summary?.graderVersion, 3);
    // An old grade document without the profile cannot be attributed to one.
    assert.equal(readGradeSummary({ build: { kind: "existing" } })?.graderVersion, null);
  });

  it("reads a failed control call as uncalibrated and a failed vote as no answer", () => {
    const document = {
      build: { kind: "existing" },
      grader: { provider: "codex", model: "gpt-6.1-sol" },
      graderVersion: 4,
      quick: { booted: true, consoleErrors: 0, responded: true },
      obligations: [
        { id: "jumps", yes: true },
        { id: "reaches-flag", yes: null },
        { id: "opens-door", yes: false },
      ],
      control: { yes: false, answered: false, votes: [] },
      void: false,
      inconclusive: true,
      solCalls: 6,
    };
    const summary = readGradeSummary(document);
    assert.equal(summary?.control, false);
    assert.equal(summary?.controlAnswered, false);
    assert.equal(summary?.inconclusive, true);
    assert.equal(summary?.void, false);
    assert.deepStrictEqual(summary?.obligationIds, ["jumps"]);
    assert.deepStrictEqual(summary?.unansweredIds, ["reaches-flag"]);
    // A v3 document never recorded control validity; keep it historical.
    const old = readGradeSummary({
      build: { kind: "existing" },
      grader: { provider: "codex", model: "gpt-6.1-sol" },
      graderVersion: 3,
      control: { yes: false, votes: [] },
      void: false,
    });
    assert.equal(old?.controlAnswered, null);
    assert.equal(old?.inconclusive, false);
    assert.deepStrictEqual(old?.unansweredIds, []);
  });

  it("shows an unread control and unanswered claims in the grade table", () => {
    const grade: BenchmarkGrade = {
      build: "existing",
      grader: { provider: "codex", model: "gpt-6.1-sol" },
      graderVersion: 4,
      target: null,
      quick: null,
      obligationIds: [],
      unansweredIds: ["reaches-flag"],
      obligations: { yes: 0, total: 2 },
      control: false,
      controlAnswered: false,
      void: false,
      inconclusive: true,
      solCalls: 6,
    };
    const result = readBenchmarkResult({
      harnessCommit: "commit",
      brief,
      fixtureChecksum: "checksum",
      startedAt: "2026-10-25T00:00:00.000Z",
      durationMs: 60_000,
      observation: { timedOut: false, exitCode: 0, signal: null, summary: null },
      grade,
    });
    const markdown = renderResultsMarkdown({ harnessCommit: "commit", results: [result] });
    assert.match(markdown, /0\/2 \(1 unanswered\) \| unread \| inconclusive \| 6 \|/);
  });

  it("reads the served target and refuses a grade for another artifact", () => {
    const buildId = "a".repeat(64);
    const artifact = {
      buildId,
      directory: `builds/candidates/${buildId}`,
      absoluteDirectory: `/games/crate-dock/builds/candidates/${buildId}`,
    };
    const summary = readGradeSummary({
      build: { kind: "artifact" },
      target: {
        kind: "artifact",
        directory: artifact.absoluteDirectory,
        buildId,
      },
    });
    assert.deepEqual(summary?.target, {
      kind: "artifact",
      directory: artifact.absoluteDirectory,
      buildId,
    });
    assert.doesNotThrow(() => assertGradeDescribesArtifact(summary!, artifact));
    assert.throws(
      () =>
        assertGradeDescribesArtifact(summary!, {
          ...artifact,
          buildId: "b".repeat(64),
        }),
      /not the requested selected artifact/,
    );
    assert.throws(
      () => assertGradeDescribesArtifact({ ...summary!, target: null }, artifact),
      /no target/,
    );
    // A grade document from before target identity existed stays targetless.
    assert.equal(readGradeSummary({ build: { kind: "existing" } })?.target, null);
  });
});

it("new summaries report completion without requiring a retired visual verdict", () => {
  const modern = observe({
    schemaVersion: 2,
    qualification: qualification({
      stages: [stage("export", "passed"), stage("playtest", "passed")],
    }),
    review: reviewStatus(selectedBuildFacts()),
    loop: selectedLoop(selectedBuildId),
  });
  assert.equal(classifyRun(modern).outcome, "passed");
  assert.match(classifyRun(modern).reason, /Presentation quality is unmeasured/);
  const row = readBenchmarkResult({
    harnessCommit: "commit",
    brief,
    fixtureChecksum: "checksum",
    startedAt: "2026-10-23T00:00:00Z",
    durationMs: 1,
    observation: modern,
  });
  assert.equal(row.review?.selectedBuildFacts?.passed, true);
  assert.equal(row.visual.status, null);
  assert.equal(row.repairDelta, null);
  assert.equal(
    classifyRun(observe({ schemaVersion: 1, qualification: modern.summary.qualification })).outcome,
    "evidence-gap",
  );
});
