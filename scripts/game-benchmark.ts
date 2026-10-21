#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off -- Maintainer CLI owns processes, files, logging and the run directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import {
  decodeRunSummary,
  loadGameBenchmarkBriefs,
  type LoadedGameBenchmarkBrief,
} from "./game-benchmark/artifacts.ts";
import {
  decodeBenchmarkResult,
  readBenchmarkResult,
  renderResultsMarkdown,
  shouldResume,
  summarizeResults,
  type BenchmarkBriefResult,
  type BenchmarkRunObservation,
} from "./game-benchmark/aggregate.ts";

const checkout = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const { values } = NodeUtil.parseArgs({
  options: {
    /** The dev server the runner authenticates against. */
    url: { type: "string" },
    "home-dir": { type: "string", default: NodePath.join(checkout, ".t3") },
    "parent-dir": { type: "string", default: NodePath.join(checkout, ".t3/e2e-games") },
    /** Where `<commit>/<id>/result.json` and the aggregate land. */
    out: { type: "string", default: NodePath.join(checkout, ".t3/game-benchmark") },
    /** Comma-separated brief ids; default all eight. */
    only: { type: "string" },
    /** One physics/agent run per brief; a hook must exit the same way game-e2e does. */
    runner: { type: "string", default: NodePath.join(checkout, "scripts/game-e2e.ts") },
    provider: { type: "string", default: "codex" },
    model: { type: "string", default: "gpt-6.1-sol" },
    "reasoning-effort": { type: "string", default: "medium" },
    "timeout-ms": { type: "string", default: "3600000" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    [
      "Usage: node scripts/game-benchmark.ts [--url http://localhost:PORT] [--home-dir .t3] [--only platformer,sokoban]",
      "       [--out DIR] [--provider opencode] [--model opencode-go/deepseek-v4.1-flash] [--reasoning-effort high]",
      "       [--timeout-ms 3600000] [--runner scripts/game-e2e.ts]",
      "",
      "Runs the frozen briefs serially through game-e2e against an already running dev server.",
      "Results are written to <out>/<harness-commit>/<brief>/result.json plus results.json/.md.",
      "An existing result for the same harness commit and fixture checksum is skipped.",
    ].join("\n"),
  );
  process.exit(0);
}
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const checkoutGit = (args: ReadonlyArray<string>) =>
  exec("git", ["-C", checkout, ...args], { maxBuffer: 16 * 1024 * 1024 });

const harnessCommit = (await checkoutGit(["rev-parse", "HEAD"])).stdout.trim();
const harnessDirty = (
  await checkoutGit([
    "status",
    "--porcelain",
    "--",
    "scripts/game-e2e.ts",
    "scripts/game-benchmark.ts",
    "scripts/game-benchmark",
  ])
).stdout.trim();
// Resume reuses rows by commit, so an uncommitted harness would silently mix
// two runners in one aggregate.
if (harnessDirty !== "")
  throw new Error(
    `Commit or stash the benchmark harness before running it; it is uncommitted:\n${harnessDirty}`,
  );

const allBriefs = await loadGameBenchmarkBriefs(
  NodePath.join(checkout, "scripts/game-benchmark/briefs"),
);
const selected = values.only
  ? values.only
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  : allBriefs.map((brief) => brief.id);
const unknown = selected.filter((id) => !allBriefs.some((brief) => brief.id === id));
if (unknown.length > 0)
  throw new Error(
    `Unknown brief id(s): ${unknown.join(", ")}. Known: ${allBriefs.map((brief) => brief.id).join(", ")}`,
  );
const briefs = allBriefs.filter((brief) => selected.includes(brief.id));
const runDirectory = NodePath.join(NodePath.resolve(values.out), harnessCommit.slice(0, 8));
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "");
const runnerPath = NodePath.resolve(values.runner);

const writeFile = async (path: string, text: string) => {
  const temporary = `${path}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temporary, text);
  await NodeFSP.rename(temporary, path);
};
const writeJson = (path: string, value: unknown) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

/** Runs one brief. Only PIDs this spawn created are ever signalled. */
const runBrief = async (
  brief: LoadedGameBenchmarkBrief,
  directory: string,
): Promise<BenchmarkRunObservation> => {
  const summaryPath = NodePath.join(directory, "run.json");
  const logPath = NodePath.join(directory, "run.log");
  // A previous attempt's summary must not be read as this run's facts if this
  // run dies before writing one.
  await NodeFSP.rm(summaryPath, { force: true });
  const log = await NodeFSP.open(logPath, "w");
  const args = [
    runnerPath,
    "--fixture",
    brief.path,
    "--summary",
    summaryPath,
    "--plan-first",
    "true",
    "--name",
    `${brief.title} ${stamp}`,
    "--parent-dir",
    NodePath.resolve(values["parent-dir"]),
    "--home-dir",
    NodePath.resolve(values["home-dir"]),
    "--timeout-ms",
    String(timeoutMs),
    "--provider",
    values.provider,
    "--model",
    values.model,
    "--reasoning-effort",
    values["reasoning-effort"],
    ...(values.url === undefined ? [] : ["--url", values.url]),
  ];
  const child = NodeChildProcess.spawn(process.execPath, args, {
    cwd: checkout,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  let timedOut = false;
  const signal = (name: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, name);
    } catch {
      // The group already exited; its close event decides the result.
    }
  };
  // The runner has its own Effect timeout; this is the backstop for a hang.
  const timer = setTimeout(() => {
    timedOut = true;
    signal("SIGTERM");
    setTimeout(() => signal("SIGKILL"), 20_000).unref();
  }, timeoutMs + 120_000);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.on("close", (code, closedBy) => resolve({ code, signal: closedBy })),
  );
  clearTimeout(timer);
  await log.close();
  const summaryText = await NodeFSP.readFile(summaryPath, "utf8").catch(() => null);
  const summary = summaryText === null ? null : decodeRunSummary(summaryText);
  if (summaryText !== null && summary === null)
    console.log(`[${brief.id}] run.json did not decode; treating the run as crashed.`);
  return { timedOut, exitCode: exit.code, signal: exit.signal, summary };
};

const aggregate = async (results: ReadonlyArray<BenchmarkBriefResult>) => {
  await writeJson(NodePath.join(runDirectory, "results.json"), {
    schemaVersion: 1,
    harnessCommit,
    generatedAt: new Date().toISOString(),
    totals: summarizeResults(results),
    briefs: results,
  });
  await writeFile(
    NodePath.join(runDirectory, "results.md"),
    renderResultsMarkdown({ harnessCommit, results }),
  );
};

await NodeFSP.mkdir(runDirectory, { recursive: true });
const results: BenchmarkBriefResult[] = [];
console.log(`Harness commit ${harnessCommit}; running ${briefs.length} brief(s) serially.`);
for (const brief of briefs) {
  const directory = NodePath.join(runDirectory, brief.id);
  const resultPath = NodePath.join(directory, "result.json");
  const previous = decodeBenchmarkResult(
    await NodeFSP.readFile(resultPath, "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => null),
  );
  if (previous !== null && shouldResume(previous, { harnessCommit, checksum: brief.checksum })) {
    console.log(`[${brief.id}] resume ${previous.outcome} from ${previous.startedAt}`);
    results.push(previous);
    continue;
  }
  await NodeFSP.mkdir(directory, { recursive: true });
  console.log(`[${brief.id}] running…`);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const observation = await runBrief(brief, directory);
  const result = readBenchmarkResult({
    harnessCommit,
    brief,
    fixtureChecksum: brief.checksum,
    startedAt,
    durationMs: Date.now() - started,
    observation,
  });
  await writeJson(resultPath, result);
  results.push(result);
  await aggregate(results);
  console.log(
    `[${brief.id}] ${result.outcome} (${(result.durationMs / 1000).toFixed(0)}s): ${result.failureReason}`,
  );
}
// Keep one deterministic order in the aggregate regardless of --only.
const ordered = [...results].sort(
  (left, right) =>
    allBriefs.findIndex((brief) => brief.id === left.fixtureId) -
    allBriefs.findIndex((brief) => brief.id === right.fixtureId),
);
await aggregate(ordered);
const totals = summarizeResults(ordered);
console.log(
  `${totals.outcomes.passed}/${totals.attempted} passed; results: ${NodePath.join(runDirectory, "results.md")}`,
);
