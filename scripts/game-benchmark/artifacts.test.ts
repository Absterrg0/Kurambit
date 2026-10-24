// @effect-diagnostics nodeBuiltinImport:off -- Fixture tests read the real brief files.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type {
  GameAcceptanceCriterion,
  GameScenarioEvidence,
  GameScenarioObservation,
} from "../../packages/contracts/src/index.ts";
import type {
  GameVisualDimension,
  GameVisualJudgement,
  GameVisualScore,
} from "../../packages/contracts/src/legacyGameVisual.ts";
import { evaluateScenarios } from "../../apps/server/src/game/scenarioEvaluation.ts";
import {
  checksumOfBytes,
  decodeGameBenchmarkBrief,
  decodeRunSummary,
  encodeRunSummary,
  expectationCovers,
  loadGameBenchmarkBrief,
  loadGameBenchmarkBriefs,
  parseExpectation,
  readObligations,
  readProductionTiming,
  readVisualJudgements,
  resolveSelectedArtifact,
  visualRepairDelta,
  type GameBenchmarkBrief,
  type GameBenchmarkObligation,
  type GameE2eRunSummary,
} from "./artifacts.ts";

const briefsDirectory = NodePath.join(
  NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  "briefs",
);

const fixture = (overrides: Record<string, unknown> = {}): unknown => ({
  id: "sokoban",
  title: "Crate Dock",
  template: "blank",
  brief: "Push crates onto goals.",
  artDirection: "Warm crates on pale tiles.",
  obligations: [
    { id: "count-move", kind: "control", description: "A move.", key: "moves", expect: ">=1" },
  ],
  ...overrides,
});

describe("brief fixtures", () => {
  it("decodes a supported obligation and an unsupported one", () => {
    const decoded = decodeGameBenchmarkBrief(
      fixture({
        obligations: [
          {
            id: "count-move",
            kind: "control",
            description: "A move.",
            key: "moves",
            expect: ">=1",
          },
          {
            id: "illegal-move",
            kind: "mechanic",
            description: "A rejected move is free.",
            unsupported: "The vocabulary cannot prove an unchanged value.",
          },
        ],
      }),
    );
    assert.equal(decoded.obligations.length, 2);
    assert.equal(decoded.obligations[1]?.unsupported !== undefined, true);
  });

  it("rejects an obligation that is both supported and unsupported", () => {
    assert.throws(() =>
      decodeGameBenchmarkBrief(
        fixture({
          obligations: [
            {
              id: "ambiguous",
              kind: "mechanic",
              description: "Both.",
              key: "moves",
              expect: ">=1",
              unsupported: "and not expressible",
            },
          ],
        }),
      ),
    );
  });

  it("rejects an obligation with neither a key/expect nor an unsupported reason", () => {
    assert.throws(() =>
      decodeGameBenchmarkBrief(
        fixture({
          obligations: [{ id: "empty", kind: "mechanic", description: "Nothing to check." }],
        }),
      ),
    );
  });

  it("rejects repeated obligation ids", () => {
    assert.throws(() =>
      decodeGameBenchmarkBrief(
        fixture({
          obligations: [
            { id: "same", kind: "control", description: "One.", key: "moves", expect: ">=1" },
            { id: "same", kind: "control", description: "Two.", key: "moves", expect: ">=2" },
          ],
        }),
      ),
    );
  });

  it("rejects a fixture with no supported obligation", () => {
    assert.throws(() =>
      decodeGameBenchmarkBrief(
        fixture({
          obligations: [
            {
              id: "only",
              kind: "mechanic",
              description: "No proof.",
              unsupported: "Not expressible.",
            },
          ],
        }),
      ),
    );
  });

  it("hashes fixture bytes so a changed file cannot resume an old result", () => {
    const bytes = new TextEncoder().encode('{"id":"sokoban"}');
    const changed = new TextEncoder().encode('{"id":"sokoban" }');
    assert.equal(checksumOfBytes(bytes), checksumOfBytes(bytes));
    assert.match(checksumOfBytes(bytes), /^[a-f0-9]{64}$/);
    assert.notEqual(checksumOfBytes(bytes), checksumOfBytes(changed));
  });

  it("loads exactly the eight pinned genres with unique ids and a filename match", async () => {
    const briefs = await loadGameBenchmarkBriefs(briefsDirectory);
    assert.deepEqual(briefs.map((brief) => brief.id).sort(), [
      "card-tactics",
      "dialogue-management",
      "first-person-exploration",
      "platformer",
      "racing",
      "sokoban",
      "tower-defense",
      "twin-stick-arena",
    ]);
    assert.equal(new Set(briefs.map((brief) => brief.checksum)).size, briefs.length);
    for (const brief of briefs) {
      assert.equal(brief.path.endsWith(`${brief.id}.json`), true);
      assert.equal(brief.obligations.length > 0, true);
    }
    const platformer = briefs.find((brief) => brief.id === "platformer");
    assert.equal(platformer?.template, "2d-platformer");
    assert.equal(
      platformer?.obligations.every((obligation) => obligation.unsupported === undefined),
      true,
    );
    // The unsupported count per fixture is part of the frozen ruler.
    assert.deepEqual(
      Object.fromEntries(
        briefs.map((brief) => [
          brief.id,
          brief.obligations.filter((o) => o.unsupported !== undefined).length,
        ]),
      ),
      {
        "card-tactics": 3,
        "dialogue-management": 3,
        "first-person-exploration": 2,
        platformer: 0,
        racing: 1,
        sokoban: 1,
        "tower-defense": 2,
        "twin-stick-arena": 0,
      },
    );
  });

  it("refuses a file whose id does not match its filename", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "brief-"));
    try {
      const path = NodePath.join(directory, "wrong.json");
      await NodeFSP.writeFile(
        path,
        JSON.stringify({
          ...(fixture() as Record<string, unknown>),
          id: "sokoban",
        }),
      );
      let thrown = false;
      try {
        await loadGameBenchmarkBrief(path);
      } catch {
        thrown = true;
      }
      assert.equal(thrown, true);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("run summaries", () => {
  it("round-trips the facts game-e2e writes and the benchmark reads", () => {
    const text = encodeRunSummary({
      schemaVersion: 1,
      harnessCommit: "commit",
      startedAt: "2026-10-21T00:00:00.000Z",
      durationMs: 12_000,
      phase: "done",
      timedOut: false,
      fixture: { id: "sokoban", checksum: "checksum" },
      game: { name: "Crate Dock", root: "/games/crate-dock", threadId: "thread:1" },
      turns: [{ name: "design", status: "completed", durationMs: 1_000 }],
      qualification: {
        state: "qualified",
        completion: "complete",
        mechanicsQualified: true,
        sourceId: "source",
        buildId: "build",
        servedArtifactId: "build",
        stages: [
          {
            stage: "state",
            status: "passed",
            sourceId: "source",
            buildId: null,
            finishedAt: "2026-10-21T00:01:00.000Z",
            criteria: [
              {
                id: "moves-count",
                kind: "control",
                text: "Walking counts.",
                status: "passed",
                observed: "full-run: moves 0 → 2 at frame 20.",
                scenarios: ["full-run"],
                provenBy: { scenario: "full-run", frame: 20 },
                measurement: { scenario: "full-run", key: "moves", baseline: 0, last: 2 },
              },
            ],
          },
        ],
      },
      lastPlaytest: null,
      obligations: [
        {
          id: "count-move",
          kind: "control",
          description: "A move.",
          key: "moves",
          expect: ">=1",
          status: "proven",
          detail: "Passed.",
          criteria: ["moves-count"],
        },
      ],
      error: null,
    });
    const decoded = decodeRunSummary(text);
    assert.equal(decoded?.turns[0]?.name, "design");
    assert.equal(decoded?.obligations[0]?.status, "proven");
    assert.equal(decoded?.fixture?.checksum, "checksum");
    // The state stage's typed measurement survives the run.json encoder, and a
    // record written before the field existed still decodes.
    assert.deepEqual(decoded?.qualification?.stages[0]?.criteria?.[0]?.measurement, {
      scenario: "full-run",
      key: "moves",
      baseline: 0,
      last: 2,
    });
    const parsed = JSON.parse(text);
    const legacyText = JSON.stringify({
      ...parsed,
      qualification: {
        ...parsed.qualification,
        stages: [
          {
            stage: "state",
            status: "passed",
            sourceId: "source",
            buildId: null,
            finishedAt: null,
            criteria: [
              {
                id: "moves-count",
                kind: "control",
                text: "Walking counts.",
                status: "passed",
                observed: "full-run: moves 0 → 2 at frame 20.",
                scenarios: ["full-run"],
                provenBy: { scenario: "full-run", frame: 20 },
              },
            ],
          },
        ],
      },
    });
    assert.equal(
      decodeRunSummary(legacyText)?.qualification?.stages[0]?.criteria?.[0]?.measurement,
      undefined,
    );
    const modern = decodeRunSummary(
      JSON.stringify({
        ...JSON.parse(text),
        schemaVersion: 2,
        review: null,
        loop: {
          id: "loop-1",
          status: "stopped",
          decision: "promote",
          reason: "The candidate is better.",
          startedAt: "2026-10-21T00:00:00.000Z",
          finishedAt: "2026-10-21T00:05:00.000Z",
          repairsUsed: 1,
          budget: { repairs: 3, elapsedMs: 1_200_000 },
          rounds: [],
          selectedBuildId: "build",
          waitedMs: 300_000,
          timedOut: false,
        },
      }),
    );
    assert.equal(modern?.schemaVersion, 2);
    assert.equal(modern?.review, null);
    assert.equal(modern?.loop?.status, "stopped");
    assert.equal(modern?.loop?.rounds.length, 0);
  });

  it("treats a truncated or foreign summary as unreadable", () => {
    assert.equal(decodeRunSummary('{"schemaVersion":1}'), null);
    assert.equal(decodeRunSummary("not json"), null);
  });
});

const selectedSummary = (input: {
  readonly buildId: string;
  readonly directory: string;
  readonly loopBuildId?: string | null;
}): GameE2eRunSummary => ({
  schemaVersion: 2,
  review: {
    loop: null,
    phase: "reviewed",
    held: false,
    repairsLeft: 0,
    timeLeftMs: 0,
    budget: { repairs: 0, elapsedMs: 1 },
    restoreOffered: false,
    selectedBuildFacts: {
      buildId: input.buildId,
      directory: input.directory,
      checks: [{ id: "build", status: "passed" }],
      passed: true,
      reason: null,
    },
  },
  harnessCommit: "commit",
  startedAt: "2026-10-24T00:00:00.000Z",
  durationMs: 1,
  phase: "done",
  timedOut: false,
  fixture: { id: "sokoban", checksum: "checksum" },
  game: { name: "Crate Dock", root: "/games/crate-dock", threadId: "thread:1" },
  turns: [],
  qualification: null,
  lastPlaytest: null,
  obligations: [],
  ...(input.loopBuildId === undefined
    ? {}
    : {
        loop: {
          id: "loop",
          status: "stopped" as const,
          decision: "promote" as const,
          reason: "The candidate is better.",
          startedAt: "2026-10-24T00:00:00.000Z",
          finishedAt: "2026-10-24T00:05:00.000Z",
          repairsUsed: 1,
          budget: { repairs: 3, elapsedMs: 1 },
          rounds: [],
          selectedBuildId: input.loopBuildId,
          waitedMs: 0,
          timedOut: false,
        },
      }),
  error: null,
});

/** Asserts a promise rejects with a message matching `pattern`. */
const rejects = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => {
  let failure: unknown = null;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  assert.match(failure instanceof Error ? failure.message : String(failure), pattern);
};

describe("selected artifacts", () => {
  const buildId = "a".repeat(64);
  const directory = `builds/candidates/${buildId}`;

  it("resolves the immutable candidate a schema-2 run selected", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "selected-artifact-"));
    try {
      const absolute = NodePath.join(root, directory);
      await NodeFSP.mkdir(absolute, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(absolute, "index.html"), "selected build");
      const summary = selectedSummary({ buildId, directory, loopBuildId: buildId });
      assert.deepEqual(await resolveSelectedArtifact(summary, root), {
        buildId,
        directory,
        absoluteDirectory: absolute,
      });
      // Schema 1 predates selection: its historical workspace grading stands.
      assert.equal(await resolveSelectedArtifact({ ...summary, schemaVersion: 1 }, root), null);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a selection that names another build, another path or nothing", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "selected-artifact-"));
    try {
      const other = "b".repeat(64);
      // The loop says Play serves a different build than the facts describe.
      await rejects(
        resolveSelectedArtifact(selectedSummary({ buildId, directory, loopBuildId: other }), root),
        /but Play serves/,
      );
      // A directory must be exactly the content-addressed candidate for its id.
      await rejects(
        resolveSelectedArtifact(
          selectedSummary({ buildId, directory: `builds/candidates/${other}` }),
          root,
        ),
        /expected builds\/candidates/,
      );
      for (const escaping of [
        `builds/candidates/../${buildId}`,
        `/games/crate-dock/${directory}`,
        `builds/candidates/${buildId}/nested`,
      ])
        await rejects(
          resolveSelectedArtifact(selectedSummary({ buildId, directory: escaping }), root),
          /expected builds\/candidates/,
        );
      // The named artifact is not on disk: refuse rather than grade sources.
      await rejects(
        resolveSelectedArtifact(selectedSummary({ buildId, directory }), root),
        /missing a nonempty index\.html/,
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

describe("production timings", () => {
  const production = {
    firstPlayableAt: "2026-10-21T00:12:00.000Z",
    firstPlayableBuildId: "a".repeat(64),
    runId: null,
    turnFirstSubmitAt: "2026-10-21T00:12:00.000Z",
    turnLastSubmitAt: "2026-10-21T00:38:00.000Z",
    submissions: 4,
    budgetMs: 45 * 60_000,
    elapsedMs: 26 * 60_000,
    remainingMs: 19 * 60_000,
  };
  const turnStartedAtMs = Date.parse("2026-10-21T00:00:00.000Z");

  it("measures the first playable and the final submit separately from the turn's start", () => {
    const timing = readProductionTiming({ production, turnStartedAtMs });
    assert.equal(timing.firstPlayableMs, 12 * 60_000);
    assert.equal(timing.lastSubmitMs, 38 * 60_000);
    assert.equal(timing.firstPlayableAt, production.firstPlayableAt);
    assert.equal(timing.lastSubmitAt, production.turnLastSubmitAt);
    assert.equal(timing.submissions, 4);
    assert.equal(timing.budgetMs, production.budgetMs);
  });

  it("keeps a missing milestone missing instead of counting from zero", () => {
    const timing = readProductionTiming({
      production: { ...production, firstPlayableAt: null, turnLastSubmitAt: null, submissions: 0 },
      turnStartedAtMs,
    });
    assert.equal(timing.firstPlayableMs, null);
    assert.equal(timing.lastSubmitMs, null);
  });
});

const judgement = (
  judgedAt: string,
  dimensions: ReadonlyArray<readonly [GameVisualDimension, GameVisualScore]>,
): GameVisualJudgement => ({
  status: "failed",
  judgedAt,
  model: "judge/model",
  sourceId: "source",
  buildId: "build",
  designHash: "design",
  evidenceDirectory: "builds/playtests/run",
  frames: [],
  dimensions: dimensions.map(([dimension, score]) => ({ dimension, score })),
  repairRequests: [],
  roundsLeft: 0,
});

describe("visual judgements", () => {
  it("records every judgement in time order and skips what is not a verdict", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "judgements-"));
    const write = async (run: string, body: unknown) => {
      const evidence = NodePath.join(directory, "builds", "playtests", run);
      await NodeFSP.mkdir(evidence, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(evidence, "visual-review.json"), JSON.stringify(body));
    };
    try {
      await write("second", judgement("2026-10-21T00:10:00.000Z", [["readability", 2]]));
      await write("first", judgement("2026-10-21T00:00:00.000Z", [["readability", 1]]));
      await write("broken", { status: "failed" });
      await NodeFSP.mkdir(NodePath.join(directory, "builds", "playtests", "unjudged"), {
        recursive: true,
      });
      // A game that never reached its first judgement has no evidence to read.
      assert.deepEqual(await readVisualJudgements(NodePath.join(directory, "missing")), []);
      const found = await readVisualJudgements(directory);
      assert.deepEqual(
        found.map((entry) => entry.judgedAt),
        ["2026-10-21T00:00:00.000Z", "2026-10-21T00:10:00.000Z"],
      );
      assert.deepEqual(
        found[0]?.dimensions.map((score) => score.score),
        [1],
      );
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("reports the score change from the first judgement to the last", () => {
    assert.equal(visualRepairDelta([]), null);
    assert.equal(
      visualRepairDelta([judgement("2026-10-21T00:00:00.000Z", [["feedback", 2]])]),
      null,
    );
    assert.equal(
      visualRepairDelta([
        judgement("2026-10-21T00:00:00.000Z", [
          ["readability", 1],
          ["valueSeparation", 2],
          ["feedback", 3],
        ]),
        judgement("2026-10-21T00:10:00.000Z", [
          ["readability", 3],
          ["valueSeparation", 2],
          ["feedback", 4],
        ]),
      ]),
      3,
    );
    // `missing` means no frame showed evidence; it cannot be differenced.
    assert.equal(
      visualRepairDelta([
        judgement("2026-10-21T00:00:00.000Z", [["readability", 2]]),
        judgement("2026-10-21T00:10:00.000Z", [["readability", "missing"]]),
      ]),
      null,
    );
  });
});

describe("expectations", () => {
  const covers = (frozen: string, observed: string) =>
    expectationCovers(parseExpectation(frozen)!, parseExpectation(observed)!);

  it("accepts a stronger observation and rejects a weaker one", () => {
    assert.equal(covers(">=1", ">=3"), true);
    assert.equal(covers(">=3", ">=1"), false);
    assert.equal(covers("<=4", "<=2"), true);
    assert.equal(covers("<=2", "<=4"), false);
    assert.equal(covers("==1", ">=1"), false);
    assert.equal(covers(">=1", "==1"), true);
    assert.equal(covers("<=1", "==0"), true);
  });

  it("reads a change only from a change, and a threshold as proof of change", () => {
    assert.equal(covers("changes", "changes"), true);
    assert.equal(covers("changes", ">=1"), true);
    assert.equal(covers(">=1", "changes"), false);
  });
});

describe("obligation grading", () => {
  const brief = decodeGameBenchmarkBrief(fixture()) as GameBenchmarkBrief;
  const acceptance = [
    {
      id: "moves-count",
      kind: "control" as const,
      text: "Walking counts.",
      observe: { key: "moves", expect: ">=2" },
    },
  ];

  it("proves an obligation through a stronger approved observation that passed", () => {
    const [read] = readObligations(brief.obligations, acceptance, [
      { id: "moves-count", status: "passed", observed: "run-a: 0 → 2 at frame 20." },
    ]);
    assert.equal(read?.status, "proven");
    assert.deepEqual(read?.criteria, ["moves-count"]);
  });

  it("reports a missing design observation instead of dropping the obligation", () => {
    const [read] = readObligations(brief.obligations, [], []);
    assert.equal(read?.status, "missing");
    assert.match(read?.detail ?? "", /GameState\.moves/);
  });

  it("reports a graded observation that did not pass", () => {
    const [read] = readObligations(brief.obligations, acceptance, [
      { id: "moves-count", status: "failed", observed: "moves stayed at 0." },
    ]);
    assert.equal(read?.status, "failed");
    assert.match(read?.detail ?? "", /stayed at 0/);
  });

  it("keeps an unsupported obligation visible with its reason", () => {
    const [read] = readObligations(
      [
        {
          id: "negative",
          kind: "mechanic",
          description: "A rejected move is free.",
          unsupported: "No invariance check.",
        },
      ],
      acceptance,
      [],
    );
    assert.equal(read?.status, "unsupported");
    assert.equal(read?.detail, "No invariance check.");
  });
});

describe("typed obligation evidence", () => {
  const acceptance: GameAcceptanceCriterion[] = [
    {
      id: "replies-cost-clock",
      kind: "mechanic",
      text: "Every reply is charged against the 120-second shift clock",
      observe: { key: "time_left", expect: "<=111" },
    },
  ];
  const obligation: GameBenchmarkObligation[] = [
    {
      id: "reply-costs-time",
      kind: "mechanic",
      description: "Sending a reply lowers time_left from its starting 120.",
      key: "time_left",
      expect: "<=100",
    },
  ];
  const scenarioRun = (observation: GameScenarioObservation): GameScenarioEvidence => ({
    id: "lose-run",
    frames: 516,
    durationMs: 8_600,
    firstInputFrame: 30,
    baselineFrame: 36,
    playerMoved: true,
    error: null,
    invalidActions: [],
    observations: [observation],
  });
  const clockRun = (
    baseline: number,
    last: number,
    low = Math.min(baseline, last),
  ): GameScenarioEvidence =>
    scenarioRun({
      key: "time_left",
      min: low,
      max: Math.max(baseline, last),
      first: baseline,
      last,
      firstChangeFrame: 12,
      baseline,
      // The declared 111 threshold first became true here; the frozen 100 did
      // not, so only a later sample can prove the frozen promise.
      matches: [{ id: "replies-cost-clock", frame: 180, value: 108.016666666667 }],
    });

  const grade = (runs: readonly GameScenarioEvidence[], measurementEligible = true) => {
    const evaluated = evaluateScenarios({ mode: "criteria", criteria: acceptance, runs });
    return {
      evaluated,
      reads: readObligations(obligation, acceptance, evaluated.criteria, { measurementEligible }),
    };
  };

  it("proves the frozen threshold from the run's typed samples though the declared one is weaker", () => {
    const { evaluated, reads } = grade([clockRun(119.416666666667, 89.0833333333337)]);
    assert.equal(evaluated.criteria[0]?.status, "passed");
    assert.deepEqual(evaluated.criteria[0]?.measurement, {
      scenario: "lose-run",
      key: "time_left",
      baseline: 119.416666666667,
      last: 89.0833333333337,
    });
    assert.equal(reads[0]?.status, "proven");
    assert.match(reads[0]?.detail ?? "", /89\.08/);
    assert.deepEqual(reads[0]?.criteria, ["replies-cost-clock"]);
  });

  it("keeps a run whose last measured value does not cross the frozen threshold missing", () => {
    const { reads } = grade([clockRun(119.416666666667, 108)]);
    assert.equal(reads[0]?.status, "missing");
    assert.match(reads[0]?.detail ?? "", /108/);
    assert.match(reads[0]?.detail ?? "", /<=100/);
  });

  it("does not credit a value that changed and returned above the promise", () => {
    const { reads } = grade([clockRun(119.416666666667, 119.916666666667, 108.016666666667)]);
    assert.equal(reads[0]?.status, "missing");
  });

  it("does not credit typed samples when the state stage is not current", () => {
    const { reads } = grade([clockRun(119.416666666667, 89.0833333333337)], false);
    assert.equal(reads[0]?.status, "missing");
  });

  it("ignores a measurement for another key or one that already held at baseline", () => {
    const result = (measurement: { key: string; baseline: number; last: number }) => [
      {
        id: "replies-cost-clock",
        status: "passed" as const,
        observed: "lose-run: time_left 119.4 → 89.1 at frame 180.",
        measurement: { scenario: "lose-run", ...measurement },
      },
    ];
    const wrongKey = readObligations(
      obligation,
      acceptance,
      result({ key: "trust", baseline: 119.416666666667, last: 89.0833333333337 }),
      { measurementEligible: true },
    );
    assert.equal(wrongKey[0]?.status, "missing");
    const alreadyTrue = readObligations(
      obligation,
      acceptance,
      result({ key: "time_left", baseline: 95, last: 89.0833333333337 }),
      { measurementEligible: true },
    );
    assert.equal(alreadyTrue[0]?.status, "missing");
  });

  it("keeps an old record without typed samples on the strict declared-threshold rule", () => {
    const reads = readObligations(
      obligation,
      acceptance,
      [
        {
          id: "replies-cost-clock",
          status: "passed",
          observed: "lose-run: time_left 119.4 → 89.1 at frame 180.",
        },
      ],
      { measurementEligible: true },
    );
    assert.equal(reads[0]?.status, "missing");
  });

  it("proves a boolean false-to-true only in that direction", () => {
    const flipAcceptance: GameAcceptanceCriterion[] = [
      {
        id: "won-flip",
        kind: "control",
        text: "Winning flips won",
        observe: { key: "won", expect: "changes" },
      },
    ];
    const flipObligation: GameBenchmarkObligation[] = [
      {
        id: "finish-won",
        kind: "win",
        description: "The shift ends won.",
        key: "won",
        expect: "==1",
      },
    ];
    const wonRun = (baseline: boolean, last: boolean): GameScenarioEvidence =>
      scenarioRun({
        key: "won",
        min: null,
        max: null,
        first: baseline,
        last,
        firstChangeFrame: 500,
        baseline,
        matches: [{ id: "won-flip", frame: 500, value: last }],
      });
    const gradeWon = (run: GameScenarioEvidence) =>
      readObligations(
        flipObligation,
        flipAcceptance,
        evaluateScenarios({ mode: "criteria", criteria: flipAcceptance, runs: [run] }).criteria,
        { measurementEligible: true },
      );
    assert.equal(gradeWon(wonRun(false, true))[0]?.status, "proven");
    assert.equal(gradeWon(wonRun(true, false))[0]?.status, "missing");
  });
});
