// @effect-diagnostics nodeBuiltinImport:off -- The batch tests write real run folders and force a completion race.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  readBenchmarkResult,
  readRawResult,
  type BenchmarkBriefResult,
  type BenchmarkGrade,
} from "./aggregate.ts";
import {
  benchmarkJobLocation,
  createBenchmarkAggregateWriter,
  parseJobCount,
  runBounded,
  runRegradeBatch,
} from "./batch.ts";
import {
  encodeRunSummary,
  type GameE2eRunSummary,
  type LoadedGameBenchmarkBrief,
} from "./artifacts.ts";

const briefFor = (id: string): LoadedGameBenchmarkBrief => ({
  id,
  title: `Game ${id}`,
  template: "blank",
  brief: `Build ${id}.`,
  artDirection: "Simple clay.",
  obligations: [
    {
      id: "moves",
      kind: "control",
      description: "The player can move.",
      key: "moves",
      expect: ">=1",
    },
  ],
  path: `/fixtures/${id}.json`,
  checksum: `checksum-${id}`,
});

const rawRow = (brief: LoadedGameBenchmarkBrief): BenchmarkBriefResult =>
  readRawResult({
    harnessCommit: "harness-commit",
    brief,
    fixtureChecksum: brief.checksum,
    startedAt: "2026-10-24T10:00:00.000Z",
    durationMs: 90_000,
    timedOut: false,
    exitCode: 0,
    grade: null,
  });

const summaryFor = (input: {
  readonly brief: LoadedGameBenchmarkBrief;
  readonly root: string;
  readonly harnessCommit: string;
}): GameE2eRunSummary => ({
  schemaVersion: 1,
  harnessCommit: input.harnessCommit,
  startedAt: "2026-10-24T09:00:00.000Z",
  durationMs: 600_000,
  phase: "done",
  timedOut: false,
  fixture: { id: input.brief.id, checksum: input.brief.checksum },
  game: { name: input.brief.title, root: input.root, threadId: "thread:1" },
  turns: [{ name: "build", status: "completed", durationMs: 480_000 }],
  qualification: null,
  lastPlaytest: null,
  obligations: [],
  visualJudgements: [],
  error: null,
});

const savedRow = (input: {
  readonly brief: LoadedGameBenchmarkBrief;
  readonly root: string;
  readonly harnessCommit: string;
}): BenchmarkBriefResult => {
  const summary = summaryFor(input);
  return readBenchmarkResult({
    harnessCommit: input.harnessCommit,
    brief: input.brief,
    fixtureChecksum: input.brief.checksum,
    startedAt: summary.startedAt,
    durationMs: summary.durationMs,
    observation: { timedOut: false, exitCode: 0, signal: null, summary },
    grade: null,
  });
};

const gradeFor = (model: string): BenchmarkGrade => ({
  build: "existing",
  grader: { provider: "codex", model },
  graderVersion: 3,
  quick: { booted: true, consoleErrors: 0, responded: true },
  obligationIds: ["moves"],
  obligations: { yes: 1, total: 1 },
  control: false,
  void: false,
  solCalls: 2,
});

describe("parseJobCount", () => {
  it("accepts positive integers and defaults nothing implicitly", () => {
    assert.equal(parseJobCount("1"), 1);
    assert.equal(parseJobCount("2"), 2);
    assert.equal(parseJobCount("12"), 12);
  });

  it("refuses zero, negatives, fractions and non-numbers", () => {
    for (const value of ["0", "-1", "1.5", "two", "", " 2", "02"])
      assert.throws(() => parseJobCount(value), /positive integer/);
  });
});

describe("runBounded", () => {
  it("runs two jobs at once, in isolated homes, without losing aggregate rows", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "benchmark-batch-"));
    try {
      const briefs = [briefFor("a"), briefFor("b")];
      const order = ["a", "b", "c"];
      const writer = createBenchmarkAggregateWriter({
        runDirectory: root,
        harnessCommit: "harness-commit",
        lane: "raw",
        order,
        initial: [rawRow(briefFor("c"))],
      });
      const homes: string[] = [];
      let started = 0;
      let releaseBoth!: () => void;
      const bothStarted = new Promise<void>((resolve) => {
        releaseBoth = resolve;
      });
      let active = 0;
      let maxActive = 0;
      let releaseA!: () => void;
      const aMayFinish = new Promise<void>((resolve) => {
        releaseA = resolve;
      });

      await runBounded(briefs, 2, async (brief) => {
        const location = benchmarkJobLocation({
          homeDir: NodePath.join(root, "home"),
          parentDir: NodePath.join(root, "games"),
          jobs: 2,
          briefId: brief.id,
        });
        homes.push(location.homeDir);
        active += 1;
        maxActive = Math.max(maxActive, active);
        started += 1;
        if (started === 2) releaseBoth();
        // Neither job may finish before both have started: that is overlap.
        await bothStarted;
        // Force the completion order opposite the brief order.
        if (brief.id === "b") {
          await writer.record(rawRow(brief));
          releaseA();
        } else {
          await aMayFinish;
          await writer.record(rawRow(brief));
        }
        active -= 1;
      });
      await writer.flush();

      assert.equal(maxActive, 2);
      assert.equal(new Set(homes).size, 2);
      for (const home of homes) assert.match(home, /benchmark-jobs/);
      const aggregate = JSON.parse(
        await NodeFSP.readFile(NodePath.join(root, "results.json"), "utf8"),
      ) as { briefs: ReadonlyArray<BenchmarkBriefResult> };
      assert.deepEqual(
        aggregate.briefs.map((row) => row.fixtureId),
        order,
      );
      assert.equal(aggregate.briefs.length, 3);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the one-job layout unchanged", () => {
    assert.deepEqual(
      benchmarkJobLocation({
        homeDir: "/tmp/home",
        parentDir: "/tmp/games",
        jobs: 1,
        briefId: "a",
      }),
      { homeDir: "/tmp/home", parentDir: "/tmp/games" },
    );
  });

  it("stops every worker when the operator aborts the batch", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    let started = 0;
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const running = runBounded(
      ["a", "b"],
      2,
      async (brief, signal) => {
        events.push(`${brief}:start`);
        const aborted = new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              events.push(`${brief}:abort`);
              resolve();
            },
            { once: true },
          );
        });
        started += 1;
        if (started === 2) releaseBoth();
        await bothStarted;
        await aborted;
        events.push(`${brief}:settled`);
      },
      controller.signal,
    );
    await bothStarted;
    controller.abort(new Error("operator stop"));
    let failure: unknown = null;
    try {
      await running;
    } catch (error) {
      failure = error;
    }
    assert.match(failure instanceof Error ? failure.message : String(failure), /operator stop/);
    assert.deepEqual(events.slice(0, 4), ["a:start", "b:start", "a:abort", "b:abort"]);
    assert.deepEqual(events.filter((event) => event.endsWith(":settled")).sort(), [
      "a:settled",
      "b:settled",
    ]);
  });
  it("aborts and waits for in-flight siblings when one job fails", async () => {
    const events: string[] = [];
    let started = 0;
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    let failure: unknown = null;
    try {
      await runBounded(["a", "b"], 2, async (brief, signal) => {
        events.push(`${brief}:start`);
        const aborted = new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              events.push(`${brief}:abort`);
              resolve();
            },
            { once: true },
          );
        });
        started += 1;
        if (started === 2) releaseBoth();
        await bothStarted;
        if (brief === "a") throw new Error("boom");
        await aborted;
        events.push(`${brief}:settled`);
      });
    } catch (error) {
      failure = error;
    }
    assert.match(failure instanceof Error ? failure.message : String(failure), /boom/);
    assert.deepEqual(events, ["a:start", "b:start", "a:abort", "b:abort", "b:settled"]);
  });
});

describe("runRegradeBatch", () => {
  it("refuses missing or mismatched fixture evidence before grading", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "benchmark-refuse-"));
    try {
      const harnessCommit = "saved-commit";
      const brief = briefFor("a");
      const oldBrief = { ...brief, checksum: "old-checksum" };
      const gameRoot = NodePath.join(root, "games", brief.id);
      await NodeFSP.mkdir(gameRoot, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(gameRoot, "game.json"), "{}\n");
      const directory = NodePath.join(root, brief.id);
      await NodeFSP.mkdir(directory, { recursive: true });
      const summary = summaryFor({ brief: oldBrief, root: gameRoot, harnessCommit });
      await NodeFSP.writeFile(NodePath.join(directory, "run.json"), encodeRunSummary(summary));
      await NodeFSP.writeFile(
        NodePath.join(directory, "result.json"),
        `${JSON.stringify(
          savedRow({ brief: oldBrief, root: gameRoot, harnessCommit }),
          null,
          2,
        )}\n`,
      );

      let graded = 0;
      let failure: unknown = null;
      try {
        await runRegradeBatch({
          runDirectory: root,
          briefs: [brief, briefFor("missing")],
          order: ["a", "missing"],
          jobs: 2,
          grade: async () => {
            graded += 1;
            return gradeFor("test-grader");
          },
          sandbox: async (briefDirectory) => ({
            runtimeDirectory: NodePath.join(briefDirectory, "sandbox"),
            environment: process.env,
          }),
        });
      } catch (error) {
        failure = error;
      }
      const message = failure instanceof Error ? failure.message : String(failure);
      assert.match(message, /fixture bytes changed/);
      assert.match(message, /no saved harness evidence/);
      assert.equal(graded, 0);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("regrades saved runs without a builder and leaves their evidence intact", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "benchmark-regrade-"));
    try {
      const harnessCommit = "saved-commit";
      const briefs = [briefFor("a"), briefFor("b")];
      const untouched = briefFor("c");
      const rows = new Map<string, BenchmarkBriefResult>();
      const runJson = new Map<string, string>();
      for (const brief of briefs) {
        const gameRoot = NodePath.join(root, "games", brief.id);
        await NodeFSP.mkdir(NodePath.join(gameRoot, "builds/web"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(gameRoot, "godot"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(gameRoot, "game.json"), "{}\n");
        await NodeFSP.writeFile(
          NodePath.join(gameRoot, "godot/project.godot"),
          "config_version=5\n",
        );
        await NodeFSP.writeFile(NodePath.join(gameRoot, "builds/web/index.html"), "saved build\n");
        const row = savedRow({ brief, root: gameRoot, harnessCommit });
        const directory = NodePath.join(root, brief.id);
        await NodeFSP.mkdir(directory, { recursive: true });
        const summary = summaryFor({ brief, root: gameRoot, harnessCommit });
        const text = encodeRunSummary(summary);
        await NodeFSP.writeFile(NodePath.join(directory, "run.json"), text);
        await NodeFSP.writeFile(NodePath.join(directory, "run.log"), `builder log ${brief.id}\n`);
        await NodeFSP.writeFile(
          NodePath.join(directory, "result.json"),
          `${JSON.stringify(row, null, 2)}\n`,
        );
        rows.set(brief.id, row);
        runJson.set(brief.id, text);
      }
      const untouchedRow = savedRow({
        brief: untouched,
        root: NodePath.join(root, "games", untouched.id),
        harnessCommit,
      });
      rows.set(untouched.id, untouchedRow);
      const seed = createBenchmarkAggregateWriter({
        runDirectory: root,
        harnessCommit,
        lane: "harness",
        order: ["a", "b", "c"],
        initial: [...rows.values()],
      });
      await seed.flush();

      const gradeCalls: Array<{ readonly id: string; readonly root: string }> = [];
      const results = await runRegradeBatch({
        runDirectory: root,
        briefs,
        order: ["a", "b", "c"],
        jobs: 2,
        grade: async (input) => {
          gradeCalls.push({ id: input.brief.id, root: input.root });
          // The real grader writes a grade directory; installStagedGrade moves it.
          await NodeFSP.mkdir(NodePath.join(input.outDirectory, "grade"), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(input.outDirectory, "grade", "grade.json"), "{}\n");
          await NodeFSP.writeFile(NodePath.join(input.outDirectory, "grade.log"), "new grade\n");
          return gradeFor("test-grader");
        },
        sandbox: async (directory) => ({
          runtimeDirectory: NodePath.join(directory, "sandbox"),
          environment: process.env,
        }),
      });

      assert.equal(gradeCalls.length, 2);
      assert.deepEqual(gradeCalls.map((call) => call.id).sort(), ["a", "b"]);
      assert.deepEqual(
        results.map((row) => row.fixtureId),
        ["a", "b", "c"],
      );
      for (const brief of briefs) {
        const previous = rows.get(brief.id)!;
        const updated = results.find((row) => row.fixtureId === brief.id)!;
        // Outcome and timing belong to the builder's run, not to the regrade.
        assert.equal(updated.outcome, previous.outcome);
        assert.equal(updated.startedAt, previous.startedAt);
        assert.equal(updated.durationMs, previous.durationMs);
        assert.deepEqual(updated.turns, previous.turns);
        assert.equal(updated.grade?.grader?.model, "test-grader");
        assert.deepEqual(updated.evaluation, {
          grader: { provider: "codex", model: "test-grader" },
          version: 3,
        });
        // The builder's own evidence is byte-for-byte untouched.
        assert.equal(
          await NodeFSP.readFile(NodePath.join(root, brief.id, "run.json"), "utf8"),
          runJson.get(brief.id),
        );
        assert.equal(
          await NodeFSP.readFile(NodePath.join(root, brief.id, "run.log"), "utf8"),
          `builder log ${brief.id}\n`,
        );
        assert.equal(
          await NodeFSP.readFile(NodePath.join(root, brief.id, "grade.log"), "utf8"),
          "new grade\n",
        );
      }
      const untouchedAfter = results.find((row) => row.fixtureId === "c");
      assert.deepEqual(untouchedAfter, untouchedRow);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
