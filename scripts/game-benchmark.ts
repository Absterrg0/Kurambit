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
  readGradeSummary,
  readRawResult,
  renderResultsMarkdown,
  shouldResume,
  summarizeResults,
  type BenchmarkBriefResult,
  type BenchmarkGrade,
  type BenchmarkLane,
  type BenchmarkRunObservation,
} from "./game-benchmark/aggregate.ts";
import { defaultGodotBinary } from "./game-grade.ts";
import { prepareDisplaySandbox } from "./lib/display-sandbox.ts";

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
    /** `harness` runs today's e2e runner; `raw` asks the bare agent to build the game. */
    lane: { type: "string", default: "harness" },
    /** Cap for one independent grade, not for the build under it. */
    "grade-timeout-ms": { type: "string", default: "2700000" },
    /** The raw lane's own cap: two hours of bare agent work. */
    "raw-timeout-ms": { type: "string", default: "7200000" },
    /** Copy cached raw-lane results from this directory instead of rebuilding. */
    "reuse-raw": { type: "string" },
    opencode: { type: "string", default: "opencode" },
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
      "       [--lane harness|raw] [--opencode opencode] [--grade-timeout-ms 2700000] [--raw-timeout-ms 7200000]",
      "       [--reuse-raw <benchmark-out-dir>]",
      "",
      "Runs the frozen briefs serially through game-e2e against an already running dev server,",
      "or (--lane raw) lets the bare agent build one in a scratch folder; either way the finished",
      "game is graded by scripts/game-grade.ts. Results are written to",
      "<out>/<harness-commit>/<brief>/result.json plus results.json/.md.",
      "An existing result for the same harness commit, lane and fixture checksum is skipped.",
      "--reuse-raw copies a cached raw-lane result per brief (build, grade and logs) instead",
      "of spending the agent's two-hour budget again.",
    ].join("\n"),
  );
  process.exit(0);
}
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
const lane = values.lane as BenchmarkLane;
if (lane !== "harness" && lane !== "raw") throw new Error("--lane must be harness or raw.");
const reuseRaw = values["reuse-raw"] === undefined ? null : NodePath.resolve(values["reuse-raw"]);
if (reuseRaw !== null && lane !== "raw") throw new Error("--reuse-raw only applies to --lane raw.");
const gradeTimeoutMs = Number(values["grade-timeout-ms"]);
if (!Number.isFinite(gradeTimeoutMs) || gradeTimeoutMs <= 0)
  throw new Error("--grade-timeout-ms must be positive");
const rawTimeoutMs = Number(values["raw-timeout-ms"]);
if (!Number.isFinite(rawTimeoutMs) || rawTimeoutMs <= 0)
  throw new Error("--raw-timeout-ms must be positive");
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
    "scripts/game-grade.ts",
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
  environment: NodeJS.ProcessEnv,
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
    env: environment,
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

/** Runs one command in its own process group, signalling only the PID this spawn created. */
const runInGroup = async (input: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly logPath: string;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<{ timedOut: boolean; exitCode: number | null; signal: string | null }> => {
  const log = await NodeFSP.open(input.logPath, "w");
  const child = NodeChildProcess.spawn(input.executable, [...input.args], {
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  // The child leads its own group, so an operator stopping this runner needs
  // its PID; the file exists exactly while the command is alive.
  if (child.pid !== undefined)
    await NodeFSP.writeFile(`${input.logPath}.pid`, `${child.pid}\n`).catch(() => undefined);
  let timedOut = false;
  const signal = (name: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, name);
    } catch {
      // The group already exited; its close event decides the result.
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    signal("SIGTERM");
    setTimeout(() => signal("SIGKILL"), 20_000).unref();
  }, input.timeoutMs);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.on("close", (code, closedBy) => resolve({ code, signal: closedBy })),
  );
  clearTimeout(timer);
  await log.close();
  await NodeFSP.rm(`${input.logPath}.pid`, { force: true }).catch(() => undefined);
  return { timedOut, exitCode: exit.code, signal: exit.signal };
};

/** Grades one finished game folder; a missing grade reads as none, never as a pass. */
const gradeFinishedGame = async (
  brief: LoadedGameBenchmarkBrief,
  root: string,
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<BenchmarkGrade | null> => {
  const out = NodePath.join(directory, "grade");
  await runInGroup({
    executable: process.execPath,
    args: [
      NodePath.join(checkout, "scripts/game-grade.ts"),
      root,
      "--brief",
      brief.path,
      "--out",
      out,
    ],
    cwd: checkout,
    env: environment,
    logPath: NodePath.join(directory, "grade.log"),
    timeoutMs: gradeTimeoutMs,
  });
  const text = await NodeFSP.readFile(NodePath.join(out, "grade.json"), "utf8").catch(() => null);
  if (text === null) return null;
  try {
    return readGradeSummary(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
};

/** The raw lane's scratch folder: only the blank template's project and presets. */
const prepareRawGame = async (brief: LoadedGameBenchmarkBrief, scratch: string) => {
  await NodeFSP.rm(scratch, { recursive: true, force: true });
  await NodeFSP.mkdir(NodePath.join(scratch, "godot"), { recursive: true });
  const template = NodePath.join(checkout, "apps/server/templates/blank/godot");
  const project = await NodeFSP.readFile(NodePath.join(template, "project.godot"), "utf8");
  const escaped = brief.title.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  await NodeFSP.writeFile(
    NodePath.join(scratch, "godot/project.godot"),
    project.replaceAll("{{GAME_NAME_ESCAPED}}", escaped),
  );
  await NodeFSP.copyFile(
    NodePath.join(template, "export_presets.cfg"),
    NodePath.join(scratch, "godot/export_presets.cfg"),
  );
};

const rawPrompt = (brief: LoadedGameBenchmarkBrief): string =>
  `${brief.brief}

Art direction: ${brief.artDirection}

Build this game in Godot 4.7 in ./godot. Export a web build to ./builds/web/index.html with \`${defaultGodotBinary()} --headless --path ./godot --export-release Web ./builds/web/index.html\`. Nobody will answer questions.`;

/**
 * A raw run must be its own session. An inherited OPENCODE_SESSION_ID makes the
 * CLI resume the operator's session and work in its project instead of the
 * scratch folder (t42 hit exactly that: the lane built into the checkout).
 */
const freshOpenCodeEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const fresh: NodeJS.ProcessEnv = { ...environment };
  for (const name of [
    "OPENCODE_SESSION_ID",
    "OPENCODE",
    "OPENCODE_TERMINAL",
    "OPENCODE_PASSWORD",
    "OPENCODE_CONFIG_CONTENT",
    "AI_AGENT",
    "T3CODE_CLI_PATH",
  ])
    delete fresh[name];
  return fresh;
};

/** The bare-model lane: the same model and effort as the harness, no harness. */
const runRawBrief = async (
  brief: LoadedGameBenchmarkBrief,
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ timedOut: boolean; exitCode: number | null; grade: BenchmarkGrade | null }> => {
  const scratch = NodePath.join(directory, "raw");
  await prepareRawGame(brief, scratch);
  const run = await runInGroup({
    executable: values.opencode,
    args: [
      "run",
      "--standalone",
      "--auto",
      "--model",
      `${values.model}#${values["reasoning-effort"]}`,
      "--title",
      `${brief.title} raw`,
      rawPrompt(brief),
    ],
    cwd: scratch,
    logPath: NodePath.join(directory, "opencode.log"),
    timeoutMs: rawTimeoutMs,
    // spawn does not rewrite PWD; the CLI would resolve its project from the
    // inherited checkout path instead of the scratch folder.
    env: { ...freshOpenCodeEnvironment(environment), PWD: scratch },
  });
  const grade = await gradeFinishedGame(brief, scratch, directory, environment);
  return { timedOut: run.timedOut, exitCode: run.exitCode, grade };
};

const exists = (path: string) =>
  NodeFSP.access(path)
    .then(() => true)
    .catch(() => false);

/** The cached raw row for one brief: `<dir>/<brief>` or `<dir>/<commit>/<brief>`. */
const findReusableRawResult = async (root: string, briefId: string): Promise<string | null> => {
  const direct = NodePath.join(root, briefId, "result.json");
  if (await exists(direct)) return direct;
  const entries = await NodeFSP.readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => NodePath.join(root, entry.name, briefId, "result.json"))
    .sort()
    .toReversed();
  for (const candidate of nested) if (await exists(candidate)) return candidate;
  return null;
};

/**
 * Copies a cached raw-lane brief instead of spending the agent's two-hour
 * budget again. The row is kept verbatim, so its `harnessCommit` still names
 * the grader that measured it, and its build comes along for a later re-grade.
 */
const reuseRawBrief = async (
  brief: LoadedGameBenchmarkBrief,
  directory: string,
): Promise<BenchmarkBriefResult> => {
  const source = await findReusableRawResult(reuseRaw!, brief.id);
  if (source === null)
    throw new Error(`--reuse-raw has no cached raw result for ${brief.id} under ${reuseRaw}.`);
  const sourceDirectory = NodePath.dirname(source);
  const previous = decodeBenchmarkResult(
    JSON.parse(await NodeFSP.readFile(source, "utf8")) as unknown,
  );
  if (previous === null) throw new Error(`${source} did not decode as a benchmark result.`);
  if (previous.lane !== "raw") throw new Error(`${source} is not a raw-lane result.`);
  if (previous.fixtureChecksum !== brief.checksum)
    throw new Error(`${source} was measured on different brief bytes; refusing to reuse it.`);
  for (const entry of ["grade", "raw"]) {
    const from = NodePath.join(sourceDirectory, entry);
    const to = NodePath.join(directory, entry);
    if (from === to || !(await exists(from))) continue;
    await NodeFSP.cp(from, to, { recursive: true });
  }
  for (const file of ["opencode.log", "result.json"]) {
    const from = NodePath.join(sourceDirectory, file);
    if (from === NodePath.join(directory, file) || !(await exists(from))) continue;
    await NodeFSP.copyFile(from, NodePath.join(directory, file));
  }
  return previous;
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
    renderResultsMarkdown({ harnessCommit, lane, results }),
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
  if (
    previous !== null &&
    shouldResume(previous, { harnessCommit, checksum: brief.checksum, lane })
  ) {
    console.log(`[${brief.id}] resume ${previous.outcome} from ${previous.startedAt}`);
    results.push(previous);
    continue;
  }
  await NodeFSP.mkdir(directory, { recursive: true });
  if (lane === "raw" && reuseRaw !== null) {
    const reused = await reuseRawBrief(brief, directory);
    results.push(reused);
    await aggregate(results);
    console.log(
      `[${brief.id}] reused raw result measured at ${reused.harnessCommit.slice(0, 8)} (${reused.outcome})`,
    );
    continue;
  }
  // Nothing this brief spawns may reach the operator's display: the raw agent
  // and the harness runner both inherit this environment, and an empty private
  // XDG_RUNTIME_DIR leaves the compositor's socket unfindable.
  const sandbox = await prepareDisplaySandbox(directory);
  console.log(`[${brief.id}] running…`);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let result: BenchmarkBriefResult;
  if (lane === "raw") {
    const observation = await runRawBrief(brief, directory, sandbox.environment);
    result = readRawResult({
      harnessCommit,
      brief,
      fixtureChecksum: brief.checksum,
      startedAt,
      durationMs: Date.now() - started,
      timedOut: observation.timedOut,
      exitCode: observation.exitCode,
      grade: observation.grade,
    });
  } else {
    const observation = await runBrief(brief, directory, sandbox.environment);
    const root = observation.summary?.game?.root;
    const grade =
      root === undefined
        ? null
        : await gradeFinishedGame(brief, root, directory, sandbox.environment);
    result = readBenchmarkResult({
      harnessCommit,
      brief,
      fixtureChecksum: brief.checksum,
      startedAt,
      durationMs: Date.now() - started,
      observation,
      lane,
      grade,
    });
  }
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
