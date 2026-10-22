import { assert, describe, it } from "@effect/vitest";
import {
  GAME_VISUAL_DIMENSIONS,
  type GameLastPlaytest,
  type GameQualificationRead,
  type GameQualificationStage,
  type GameQualificationStageRead,
  type GameQualificationStageStatus,
  type GameVisualJudgement,
} from "../../packages/contracts/src/index.ts";
import {
  readBenchmarkResult,
  classifyRun,
  renderResultsMarkdown,
  shouldResume,
} from "./aggregate.ts";
import type {
  GameBenchmarkBrief,
  GameBenchmarkObligationRead,
  GameE2eRunSummary,
} from "./artifacts.ts";

const stage = (
  name: GameQualificationStage,
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

const summary = (
  input: {
    readonly qualification?: GameQualificationRead | null;
    readonly obligations?: ReadonlyArray<GameBenchmarkObligationRead>;
    readonly error?: string | null;
    readonly phase?: string;
    readonly timedOut?: boolean;
    readonly lastPlaytest?: GameLastPlaytest | null;
    readonly visualJudgements?: ReadonlyArray<GameVisualJudgement>;
  } = {},
): GameE2eRunSummary => ({
  schemaVersion: 1,
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
});
