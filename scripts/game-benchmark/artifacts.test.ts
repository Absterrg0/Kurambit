// @effect-diagnostics nodeBuiltinImport:off -- Fixture tests read the real brief files.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
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
  type GameBenchmarkBrief,
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
        mechanicsQualified: true,
        sourceId: "source",
        buildId: "build",
        servedArtifactId: "build",
        stages: [],
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
  });

  it("treats a truncated or foreign summary as unreadable", () => {
    assert.equal(decodeRunSummary('{"schemaVersion":1}'), null);
    assert.equal(decodeRunSummary("not json"), null);
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
