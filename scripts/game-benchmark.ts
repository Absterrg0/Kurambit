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
  shouldRegradeReusedRaw,
  shouldResume,
  summarizeResults,
  type BenchmarkBriefResult,
  type BenchmarkEvaluationProfile,
  type BenchmarkGrade,
  type BenchmarkLane,
  type BenchmarkRunObservation,
} from "./game-benchmark/aggregate.ts";
import {
  CODEX_GRADER_MODEL,
  GRADER_VERSION,
  OPENCODE_GRADER_MODEL,
  defaultGodotBinary,
} from "./game-grade.ts";
import { makeCompareReviewer, runComparison } from "./game-benchmark/compare.ts";
import {
  abortReason,
  benchmarkJobLocation,
  createBenchmarkAggregateWriter,
  parseJobCount,
  readSavedBenchmarkRows,
  runBounded,
  runRegradeBatch,
} from "./game-benchmark/batch.ts";
import { externalServerOrigin, stopBenchmarkServerAt } from "./lib/benchmark-server.ts";
import { prepareDisplaySandbox } from "./lib/display-sandbox.ts";

const checkout = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const { values, positionals } = NodeUtil.parseArgs({
  options: {
    /** The dev server the runner authenticates against. */
    url: { type: "string" },
    /** Reuse that server even though its children inherit the operator's environment. */
    "allow-external-server": { type: "boolean", default: false },
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
    /** How many briefs may run at once; each concurrent job owns its own homes. */
    jobs: { type: "string", default: "1" },
    /** Regrade the saved game roots under this run directory without rebuilding. */
    regrade: { type: "string" },
    /** Which model family grades the finished games: codex (Sol) or opencode. */
    grader: { type: "string", default: "codex" },
    /** The model the opencode grader uses. */
    "grader-model": { type: "string" },
    /** The raw lane's own cap: two hours of bare agent work. */
    "raw-timeout-ms": { type: "string", default: "7200000" },
    /** Copy cached raw-lane results from this directory instead of rebuilding. */
    "reuse-raw": { type: "string" },
    /** Compare two lanes' saved grades blindly; takes two directories as positionals. */
    compare: { type: "boolean", default: false },
    opencode: { type: "string", default: "opencode" },
    provider: { type: "string", default: "codex" },
    model: { type: "string", default: "gpt-6.1-sol" },
    "reasoning-effort": { type: "string", default: "medium" },
    "timeout-ms": { type: "string", default: "3600000" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: true,
});
if (values.help) {
  console.log(
    [
      "Usage: node scripts/game-benchmark.ts [--url http://localhost:PORT [--allow-external-server]] [--home-dir .t3] [--only platformer,sokoban]",
      "       [--out DIR] [--provider opencode] [--model opencode-go/deepseek-v4.1-flash] [--reasoning-effort high]",
      "       [--timeout-ms 3600000] [--runner scripts/game-e2e.ts] [--jobs 1]",
      "       [--lane harness|raw] [--opencode opencode] [--grade-timeout-ms 2700000] [--raw-timeout-ms 7200000]",
      "       [--grader codex|opencode] [--grader-model opencode-go/minimax-m3.1-flash-free]",
      "       [--reuse-raw <benchmark-out-dir>]",
      "       [--regrade <saved-run-dir>]",
      "       [--compare <harnessDir> <rawDir> [--out DIR]]",
      "",
      "Runs the frozen briefs through game-e2e, up to --jobs at once. Without --url each brief starts",
      "its own private server under the display sandbox; an external server needs",
      "--allow-external-server and cannot be used with --jobs above 1.",
      "The raw lane (--lane raw) lets the bare agent build one in a scratch folder; either way the",
      "finished game is graded by scripts/game-grade.ts. Results are written to",
      "<out>/<harness-commit>/<brief>/result.json plus results.json/.md.",
      "An existing result for the same harness commit, lane, fixture checksum and evaluation profile is skipped.",
      "--reuse-raw copies a cached raw-lane build per brief and regrades it when the grader profile differs,",
      "instead of spending the agent's two-hour budget again.",
      "--regrade <saved-run-dir> grades the game root recorded in each <brief>/run.json under that",
      "directory, using the current frozen grader. It never asks an agent to build, refuses missing or",
      "mismatched fixture evidence, and replaces only each row's grade and evaluation profile.",
      "--compare reads two lanes' already-saved grade frames and asks the frozen grader model which",
      "build reads better, in both orders plus an identical-pair control. It writes <out>/comparison.json",
      "and comparison.md and is never summed with the obligations totals.",
    ].join("\n"),
  );
  process.exit(0);
}
if (values.compare) {
  // The comparison is a separate ruler: it reuses the frozen grader model and
  // never runs the lane machinery, so none of the run flags apply.
  if (values.regrade !== undefined) throw new Error("--regrade cannot be combined with --compare.");
  if (values.grader !== "codex")
    throw new Error("--compare measures with the frozen codex grader; drop --grader.");
  const [harnessDir, rawDir] = positionals;
  if (harnessDir === undefined || rawDir === undefined || positionals.length !== 2)
    throw new Error("--compare takes a harness directory and a raw directory.");
  const allBriefs = await loadGameBenchmarkBriefs(
    NodePath.join(checkout, "scripts/game-benchmark/briefs"),
  );
  const only = values.only
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const selected =
    only === undefined ? allBriefs : allBriefs.filter((brief) => only.includes(brief.id));
  const unknown = (only ?? []).filter((id) => !allBriefs.some((brief) => brief.id === id));
  if (unknown.length > 0)
    throw new Error(
      `Unknown brief id(s): ${unknown.join(", ")}. Known briefs: ${allBriefs.map((brief) => brief.id).join(", ")}`,
    );
  const { report, markdownPath } = await runComparison({
    harnessDir: NodePath.resolve(harnessDir),
    rawDir: NodePath.resolve(rawDir),
    out: NodePath.resolve(values.out),
    briefs: selected,
    review: makeCompareReviewer(),
    log: (line) => console.log(line),
  });
  for (const brief of report.briefs)
    console.log(`${brief.briefId}: ${brief.verdict} (${brief.frameCount} cards)`);
  console.log(`comparison: ${markdownPath}`);
  process.exit(0);
}
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
const lane = values.lane as BenchmarkLane;
if (lane !== "harness" && lane !== "raw") throw new Error("--lane must be harness or raw.");
const reuseRaw = values["reuse-raw"] === undefined ? null : NodePath.resolve(values["reuse-raw"]);
if (reuseRaw !== null && lane !== "raw") throw new Error("--reuse-raw only applies to --lane raw.");
const jobs = parseJobCount(values.jobs);
const savedRunDirectory = values.regrade === undefined ? null : NodePath.resolve(values.regrade);
if (savedRunDirectory !== null) {
  if (lane !== "harness") throw new Error("--regrade only reads --lane harness saved runs.");
  if (reuseRaw !== null) throw new Error("--regrade cannot be combined with --reuse-raw.");
  if (values.url !== undefined)
    throw new Error("--regrade reads saved files and never starts a server; drop --url.");
}
const gradeTimeoutMs = Number(values["grade-timeout-ms"]);
if (!Number.isFinite(gradeTimeoutMs) || gradeTimeoutMs <= 0)
  throw new Error("--grade-timeout-ms must be positive");
const grader = values.grader as string;
if (grader !== "codex" && grader !== "opencode")
  throw new Error("--grader must be codex or opencode.");
// An external server runs game and provider children with its own environment,
// so harness work may only use one when the operator says that is understood.
const externalServerUrl = externalServerOrigin({
  url: values.url,
  allowExternalServer: values["allow-external-server"] === true,
});
// Briefs above 1 each need their own server; an external server is shared, so
// concurrent harness runs would also share its provider and game processes.
if (externalServerUrl !== null && jobs > 1)
  throw new Error(
    "--jobs above 1 needs a private server per brief; drop --url/--allow-external-server.",
  );
// Which grader a row must be measured by before it may be resumed.
const expectedEvaluation: BenchmarkEvaluationProfile = {
  grader: {
    provider: grader,
    model:
      grader === "opencode"
        ? (values["grader-model"] ?? OPENCODE_GRADER_MODEL)
        : CODEX_GRADER_MODEL,
  },
  version: GRADER_VERSION,
};
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
    "scripts/lib/benchmark-server.ts",
    "scripts/lib/display-sandbox.ts",
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
const shutdown = new AbortController();
const onSigint = () => shutdown.abort(new Error("Stopped by SIGINT."));
const onSigterm = () => shutdown.abort(new Error("Stopped by SIGTERM."));
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);
const stopListeningForShutdown = () => {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
};
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
  location: ReturnType<typeof benchmarkJobLocation>,
  environment: NodeJS.ProcessEnv,
  abort: AbortSignal,
): Promise<BenchmarkRunObservation> => {
  if (abort.aborted) throw abortReason(abort);
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
    location.parentDir,
    "--home-dir",
    location.homeDir,
    "--timeout-ms",
    String(timeoutMs),
    "--provider",
    values.provider,
    "--model",
    values.model,
    "--reasoning-effort",
    values["reasoning-effort"],
    ...(externalServerUrl === null ? [] : ["--url", externalServerUrl, "--allow-external-server"]),
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
  const stopOnAbort = () => {
    signal("SIGTERM");
    setTimeout(() => signal("SIGKILL"), 20_000).unref();
  };
  abort.addEventListener("abort", stopOnAbort, { once: true });
  if (abort.aborted) stopOnAbort();
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
  abort.removeEventListener("abort", stopOnAbort);
  await log.close();
  // game-e2e stops its private server in an Effect finalizer. If it was
  // SIGKILLed before that ran, the pid file it left is the only captured handle
  // to the detached server group, so finish the cleanup here.
  if (externalServerUrl === null && child.pid !== undefined) {
    const serverHome = NodePath.join(location.homeDir, "benchmark-server");
    await stopBenchmarkServerAt({
      logPath: NodePath.join(serverHome, "server.log"),
      homeDir: serverHome,
      ownerPid: child.pid,
    });
  }
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
  readonly abort?: AbortSignal;
}): Promise<{ timedOut: boolean; exitCode: number | null; signal: string | null }> => {
  const abort = input.abort;
  if (abort !== undefined && abort.aborted) throw abortReason(abort);
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
  const stopOnAbort = () => {
    signal("SIGTERM");
    setTimeout(() => signal("SIGKILL"), 20_000).unref();
  };
  abort?.addEventListener("abort", stopOnAbort, { once: true });
  if (abort !== undefined && abort.aborted) stopOnAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    signal("SIGTERM");
    setTimeout(() => signal("SIGKILL"), 20_000).unref();
  }, input.timeoutMs);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.on("close", (code, closedBy) => resolve({ code, signal: closedBy })),
  );
  clearTimeout(timer);
  abort?.removeEventListener("abort", stopOnAbort);
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
  abort: AbortSignal,
): Promise<BenchmarkGrade | null> => {
  if (abort.aborted) throw abortReason(abort);
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
      "--grader",
      grader,
      ...(values["grader-model"] === undefined ? [] : ["--grader-model", values["grader-model"]!]),
    ],
    cwd: checkout,
    env: environment,
    logPath: NodePath.join(directory, "grade.log"),
    timeoutMs: gradeTimeoutMs,
    abort,
  });
  if (abort.aborted) throw abortReason(abort);
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
  abort: AbortSignal,
): Promise<{ timedOut: boolean; exitCode: number | null; grade: BenchmarkGrade | null }> => {
  if (abort.aborted) throw abortReason(abort);
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
    abort,
  });
  if (abort.aborted) throw abortReason(abort);
  const grade = await gradeFinishedGame(brief, scratch, directory, environment, abort);
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
 * budget again. When the cached row was graded under another profile, only its
 * build is reused and the copied build is regraded by the requested grader.
 */
const reuseRawBrief = async (
  brief: LoadedGameBenchmarkBrief,
  directory: string,
  environment: NodeJS.ProcessEnv,
  expected: BenchmarkEvaluationProfile,
  abort: AbortSignal,
): Promise<BenchmarkBriefResult> => {
  if (abort.aborted) throw abortReason(abort);
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
  // Nothing was graded: there is no verdict to inherit, so the row stands.
  const regrade = shouldRegradeReusedRaw(previous, expected);
  for (const entry of regrade ? ["raw"] : ["grade", "raw"]) {
    const from = NodePath.join(sourceDirectory, entry);
    const to = NodePath.join(directory, entry);
    if (from === to || !(await exists(from))) continue;
    await NodeFSP.cp(from, to, { recursive: true });
  }
  for (const file of regrade ? ["opencode.log"] : ["opencode.log", "result.json"]) {
    const from = NodePath.join(sourceDirectory, file);
    if (from === NodePath.join(directory, file) || !(await exists(from))) continue;
    await NodeFSP.copyFile(from, NodePath.join(directory, file));
  }
  if (!regrade) return previous;
  const rawRoot = NodePath.join(directory, "raw");
  console.log(
    `[${brief.id}] cached build was graded by ${previous.evaluation?.grader.provider ?? "an unknown grader"}/${previous.evaluation?.grader.model ?? "unknown"}; regrading with ${expected.grader.provider}/${expected.grader.model}`,
  );
  const grade = await gradeFinishedGame(brief, rawRoot, directory, environment, abort);
  if (abort.aborted) throw abortReason(abort);
  const regraded = readRawResult({
    harnessCommit,
    brief,
    fixtureChecksum: brief.checksum,
    startedAt: previous.startedAt,
    durationMs: previous.durationMs,
    timedOut: false,
    exitCode: null,
    grade,
  });
  await writeJson(NodePath.join(directory, "result.json"), regraded);
  return regraded;
};

if (savedRunDirectory !== null) {
  await NodeFSP.access(savedRunDirectory).catch(() => {
    throw new Error(`--regrade needs an existing saved run directory: ${savedRunDirectory}`);
  });
  console.log(
    `Regrading ${briefs.length} saved run(s) under ${savedRunDirectory} with up to ${jobs} at a time; no agent build.`,
  );
  let results: ReadonlyArray<BenchmarkBriefResult>;
  try {
    results = await runRegradeBatch({
      runDirectory: savedRunDirectory,
      briefs,
      order: allBriefs.map((brief) => brief.id),
      jobs,
      grade: (input) =>
        gradeFinishedGame(
          input.brief,
          input.root,
          input.outDirectory,
          input.environment,
          input.signal,
        ),
      sandbox: prepareDisplaySandbox,
      signal: shutdown.signal,
      log: (line) => console.log(line),
    });
  } finally {
    stopListeningForShutdown();
  }
  const totals = summarizeResults(results);
  console.log(
    `${briefs.length} saved run(s) regraded; ${totals.outcomes.passed}/${totals.attempted} rows passed; results: ${NodePath.join(savedRunDirectory, "results.md")}`,
  );
  process.exit(0);
}

await NodeFSP.mkdir(runDirectory, { recursive: true });
const savedRows = await readSavedBenchmarkRows(
  runDirectory,
  allBriefs.map((brief) => brief.id),
);
const writer = createBenchmarkAggregateWriter({
  runDirectory,
  harnessCommit,
  lane,
  order: allBriefs.map((brief) => brief.id),
  // Rows from another lane or commit in this directory are not ours to merge.
  initial: savedRows.results.filter(
    (result) => result.harnessCommit === harnessCommit && (result.lane ?? "harness") === lane,
  ),
});
const runOne = async (brief: LoadedGameBenchmarkBrief, abort: AbortSignal) => {
  const directory = NodePath.join(runDirectory, brief.id);
  const resultPath = NodePath.join(directory, "result.json");
  const previous = decodeBenchmarkResult(
    await NodeFSP.readFile(resultPath, "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => null),
  );
  if (
    previous !== null &&
    shouldResume(previous, {
      harnessCommit,
      checksum: brief.checksum,
      lane,
      evaluation: expectedEvaluation,
    })
  ) {
    console.log(`[${brief.id}] resume ${previous.outcome} from ${previous.startedAt}`);
    await writer.record(previous);
    return;
  }
  await NodeFSP.mkdir(directory, { recursive: true });
  if (lane === "raw" && reuseRaw !== null) {
    // The display sandbox is prepared before the cached build is regraded too:
    // the grader launches headless Chrome and must not see the operator's.
    const sandbox = await prepareDisplaySandbox(directory);
    const reused = await reuseRawBrief(
      brief,
      directory,
      sandbox.environment,
      expectedEvaluation,
      abort,
    );
    if (abort.aborted) throw abortReason(abort);
    await writer.record(reused);
    console.log(
      `[${brief.id}] reused raw result measured at ${reused.harnessCommit.slice(0, 8)} (${reused.outcome})`,
    );
    return;
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
    const observation = await runRawBrief(brief, directory, sandbox.environment, abort);
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
    const location = benchmarkJobLocation({
      homeDir: values["home-dir"],
      parentDir: values["parent-dir"],
      jobs,
      briefId: brief.id,
    });
    const observation = await runBrief(brief, directory, location, sandbox.environment, abort);
    if (abort.aborted) throw abortReason(abort);
    const root = observation.summary?.game?.root;
    const grade =
      root === undefined
        ? null
        : await gradeFinishedGame(brief, root, directory, sandbox.environment, abort);
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
  if (abort.aborted) throw abortReason(abort);
  await writeJson(resultPath, result);
  await writer.record(result);
  console.log(
    `[${brief.id}] ${result.outcome} (${(result.durationMs / 1000).toFixed(0)}s): ${result.failureReason}`,
  );
};

console.log(
  `Harness commit ${harnessCommit}; running ${briefs.length} brief(s) ${
    jobs === 1 ? "serially" : `with up to ${jobs} at a time`
  }.`,
);
let failure: unknown = null;
try {
  await runBounded(briefs, jobs, runOne, shutdown.signal);
} catch (error) {
  failure = error;
} finally {
  stopListeningForShutdown();
}
try {
  // Flush even after a failure so rows that did finish are never lost.
  await writer.flush();
} catch (error) {
  if (failure === null) throw error;
}
if (failure !== null) throw failure;
const ordered = writer.snapshot();
const totals = summarizeResults(ordered);
console.log(
  `${totals.outcomes.passed}/${totals.attempted} passed; results: ${NodePath.join(runDirectory, "results.md")}`,
);
