// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- The batch runner owns benchmark job folders, files and abortable workers.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  decodeBenchmarkResult,
  renderResultsMarkdown,
  replaceIndependentGrade,
  summarizeResults,
  type BenchmarkBriefResult,
  type BenchmarkGrade,
  type BenchmarkLane,
} from "./aggregate.ts";
import {
  decodeRunSummary,
  resolveSelectedArtifact,
  type LoadedGameBenchmarkBrief,
  type SelectedWebArtifact,
} from "./artifacts.ts";
import type { DisplaySandbox } from "../lib/display-sandbox.ts";

/** A positive job count; `parseArgs` hands these through as strings. */
export function parseJobCount(value: string): number {
  if (!/^[1-9]\d*$/.test(value))
    throw new Error(`--jobs must be a positive integer, got "${value}".`);
  const jobs = Number(value);
  if (!Number.isSafeInteger(jobs)) throw new Error(`--jobs is too large: "${value}".`);
  return jobs;
}

export const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error("The benchmark job was aborted.");

/**
 * Runs at most `jobs` workers. The first rejected worker aborts the rest, and
 * the promise settles only after every worker has stopped, so a failure never
 * leaves a sibling process group running behind us.
 */
export async function runBounded<T>(
  items: ReadonlyArray<T>,
  jobs: number,
  worker: (item: T, signal: AbortSignal) => Promise<void>,
  parentSignal?: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(jobs) || jobs < 1)
    throw new Error(`The job count must be a positive integer, got ${jobs}.`);
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal !== undefined) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  let failure: unknown = null;
  let next = 0;
  const consume = async () => {
    while (!controller.signal.aborted) {
      const index = next++;
      if (index >= items.length) return;
      try {
        await worker(items[index]!, controller.signal);
      } catch (error) {
        // Keep the failure that caused the abort; a sibling's abort error is
        // just fallout and would hide the real cause.
        if (failure === null) failure = error;
        if (!controller.signal.aborted) controller.abort(error);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, () => consume()));
  } finally {
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
  if (failure !== null) throw failure;
  if (controller.signal.aborted) throw abortReason(controller.signal);
}

export interface BenchmarkJobLocation {
  /** Passed to game-e2e, which appends its own `benchmark-server` directory. */
  readonly homeDir: string;
  readonly parentDir: string;
}

/**
 * One job may share the operator's usual benchmark home; concurrent jobs may
 * not, because each game-e2e owns a server, pairing grant and game folder.
 * The one-job layout stays byte-for-byte compatible with older runs.
 */
export function benchmarkJobLocation(input: {
  readonly homeDir: string;
  readonly parentDir: string;
  readonly jobs: number;
  readonly briefId: string;
}): BenchmarkJobLocation {
  const homeDir = NodePath.resolve(input.homeDir);
  const parentDir = NodePath.resolve(input.parentDir);
  if (input.jobs === 1) return { homeDir, parentDir };
  return {
    homeDir: NodePath.join(homeDir, "benchmark-jobs", input.briefId),
    parentDir: NodePath.join(parentDir, "benchmark-jobs", input.briefId),
  };
}

let temporaryCount = 0;

/** Writes a complete file and only then swaps it into place. */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${temporaryCount++}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, contents);
    await NodeFSP.rename(temporary, path);
  } catch (error) {
    await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export const writeJsonAtomic = (path: string, value: unknown): Promise<void> =>
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);

export interface BenchmarkAggregateWriter {
  /** Adds a row and writes the aggregate in completion order, serially. */
  record(result: BenchmarkBriefResult): Promise<void>;
  /** Writes the latest snapshot even when nothing new was recorded. */
  flush(): Promise<void>;
  snapshot(): ReadonlyArray<BenchmarkBriefResult>;
}

/**
 * Concurrent briefs finish in any order; the aggregate does not. Rows are kept
 * by brief id and sorted by the frozen brief order before every write, and all
 * writes go through one queue so two completions cannot race on results.json.
 */
export function createBenchmarkAggregateWriter(input: {
  readonly runDirectory: string;
  readonly harnessCommit: string;
  readonly lane: BenchmarkLane;
  readonly order: ReadonlyArray<string>;
  readonly initial?: ReadonlyArray<BenchmarkBriefResult>;
}): BenchmarkAggregateWriter {
  const rows = new Map<string, BenchmarkBriefResult>();
  for (const result of input.initial ?? []) rows.set(result.fixtureId, result);
  const positions = new Map(input.order.map((id, index) => [id, index]));
  const ordered = (): ReadonlyArray<BenchmarkBriefResult> =>
    [...rows.values()].sort(
      (left, right) =>
        (positions.get(left.fixtureId) ?? Number.MAX_SAFE_INTEGER) -
          (positions.get(right.fixtureId) ?? Number.MAX_SAFE_INTEGER) ||
        left.fixtureId.localeCompare(right.fixtureId),
    );
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next;
  };
  const write = async () => {
    const results = ordered();
    await NodeFSP.mkdir(input.runDirectory, { recursive: true });
    await writeJsonAtomic(NodePath.join(input.runDirectory, "results.json"), {
      schemaVersion: 1,
      harnessCommit: input.harnessCommit,
      generatedAt: new Date().toISOString(),
      totals: summarizeResults(results),
      briefs: results,
    });
    await writeFileAtomic(
      NodePath.join(input.runDirectory, "results.md"),
      renderResultsMarkdown({
        harnessCommit: input.harnessCommit,
        lane: input.lane,
        results,
      }),
    );
  };
  return {
    record: (result) => {
      rows.set(result.fixtureId, result);
      return enqueue(write);
    },
    flush: () => enqueue(write),
    snapshot: ordered,
  };
}

export interface SavedBenchmarkRows {
  readonly harnessCommit: string | null;
  readonly results: ReadonlyArray<BenchmarkBriefResult>;
}

const parseSavedAggregate = (value: unknown): SavedBenchmarkRows | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.harnessCommit !== "string" || !Array.isArray(record.briefs)) return null;
  const results = record.briefs.map(decodeBenchmarkResult);
  if (results.some((result) => result === null)) return null;
  if (results.some((result) => result!.harnessCommit !== record.harnessCommit)) return null;
  return {
    harnessCommit: record.harnessCommit,
    results: results as ReadonlyArray<BenchmarkBriefResult>,
  };
};

/**
 * Reads the rows already saved in a run directory. A missing results.json is
 * normal (an interrupted first run), so per-brief rows are the fallback. A
 * malformed aggregate is not silently replaced: that would lose rows.
 */
export async function readSavedBenchmarkRows(
  runDirectory: string,
  order: ReadonlyArray<string>,
): Promise<SavedBenchmarkRows> {
  const aggregatePath = NodePath.join(runDirectory, "results.json");
  const text = await NodeFSP.readFile(aggregatePath, "utf8").catch(() => null);
  if (text !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${aggregatePath} is not valid JSON; refusing to overwrite saved rows.`);
    }
    const saved = parseSavedAggregate(parsed);
    if (saved === null)
      throw new Error(`${aggregatePath} is not a benchmark aggregate; refusing to overwrite it.`);
    return saved;
  }
  const results: BenchmarkBriefResult[] = [];
  for (const briefId of order) {
    const path = NodePath.join(runDirectory, briefId, "result.json");
    const rowText = await NodeFSP.readFile(path, "utf8").catch(() => null);
    if (rowText === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rowText) as unknown;
    } catch {
      throw new Error(`${path} is not valid JSON; refusing to ignore a saved result.`);
    }
    const result = decodeBenchmarkResult(parsed);
    if (result === null)
      throw new Error(`${path} is not a benchmark result; refusing to ignore it.`);
    results.push(result);
  }
  return { harnessCommit: null, results };
}

export interface SavedHarnessRunEvidence {
  readonly brief: LoadedGameBenchmarkBrief;
  readonly directory: string;
  readonly root: string;
  /** The immutable artifact the run selected, or null for a legacy schema-1 run. */
  readonly artifact: SelectedWebArtifact | null;
  readonly result: BenchmarkBriefResult;
}

const exists = (path: string) =>
  NodeFSP.stat(path)
    .then(() => true)
    .catch(() => false);

/**
 * Reads the evidence a regrade may trust: the run's own summary, its saved row
 * and the game folder or immutable artifact they name. Any mismatch is refused
 * before a grader runs, because a row from another fixture or commit cannot be
 * relabelled.
 */
export async function readSavedHarnessRun(input: {
  readonly runDirectory: string;
  readonly brief: LoadedGameBenchmarkBrief;
}): Promise<SavedHarnessRunEvidence> {
  const directory = NodePath.join(input.runDirectory, input.brief.id);
  const summaryPath = NodePath.join(directory, "run.json");
  const summaryText = await NodeFSP.readFile(summaryPath, "utf8").catch(() => null);
  if (summaryText === null)
    throw new Error(`[${input.brief.id}] no saved harness evidence at ${summaryPath}.`);
  const summary = decodeRunSummary(summaryText);
  if (summary === null)
    throw new Error(`[${input.brief.id}] ${summaryPath} did not decode as a run summary.`);

  const resultPath = NodePath.join(directory, "result.json");
  const resultText = await NodeFSP.readFile(resultPath, "utf8").catch(() => null);
  if (resultText === null)
    throw new Error(
      `[${input.brief.id}] no saved outcome at ${resultPath}; refusing to invent one.`,
    );
  let parsedResult: unknown;
  try {
    parsedResult = JSON.parse(resultText) as unknown;
  } catch {
    throw new Error(`[${input.brief.id}] ${resultPath} is not valid JSON.`);
  }
  const result = decodeBenchmarkResult(parsedResult);
  if (result === null)
    throw new Error(`[${input.brief.id}] ${resultPath} did not decode as a benchmark result.`);

  if (summary.fixture === null || summary.fixture.id !== input.brief.id)
    throw new Error(`[${input.brief.id}] the saved run was not measured on this fixture.`);
  if (summary.fixture.checksum !== input.brief.checksum)
    throw new Error(
      `[${input.brief.id}] the fixture bytes changed since this run; refusing to regrade it.`,
    );
  if (result.fixtureId !== input.brief.id || result.fixtureChecksum !== input.brief.checksum)
    throw new Error(`[${input.brief.id}] the saved row does not match the current fixture.`);
  if ((result.lane ?? "harness") !== "harness")
    throw new Error(`[${input.brief.id}] --regrade only reads harness-lane runs.`);
  if (result.harnessCommit !== summary.harnessCommit)
    throw new Error(`[${input.brief.id}] the saved row and run summary name different commits.`);
  if (summary.game === null)
    throw new Error(`[${input.brief.id}] the saved run never recorded a game root.`);

  const root = NodePath.resolve(summary.game.root);
  const artifact = await resolveSelectedArtifact(summary, root);
  // A schema-2 selection is graded from its immutable bytes: the sources may be
  // gone, and requiring them would invite an unwanted rebuild. A schema-1 row
  // keeps the old contract because its grader may have to export.
  if (artifact === null) {
    if (!(await exists(NodePath.join(root, "game.json"))))
      throw new Error(`[${input.brief.id}] the saved game root is missing game.json: ${root}.`);
    if (!(await exists(NodePath.join(root, "godot/project.godot"))))
      throw new Error(
        `[${input.brief.id}] the saved game root is missing godot/project.godot: ${root}.`,
      );
  }
  return { brief: input.brief, directory, root, artifact, result };
}

const replaceDirectory = async (input: {
  readonly staged: string;
  readonly target: string;
  readonly backup: string;
}): Promise<void> => {
  const hadTarget = await exists(input.target);
  if (hadTarget) await NodeFSP.rename(input.target, input.backup);
  try {
    await NodeFSP.rename(input.staged, input.target);
  } catch (error) {
    if (hadTarget) await NodeFSP.rename(input.backup, input.target).catch(() => undefined);
    throw error;
  }
};

const installStagedGrade = async (directory: string, stage: string): Promise<void> => {
  const stagedGrade = NodePath.join(stage, "grade");
  if (!(await exists(NodePath.join(stagedGrade, "grade.json"))))
    throw new Error(`The grader wrote no grade.json under ${stage}.`);
  await replaceDirectory({
    staged: stagedGrade,
    target: NodePath.join(directory, "grade"),
    backup: NodePath.join(stage, "previous-grade"),
  });
  const stagedLog = NodePath.join(stage, "grade.log");
  if (await exists(stagedLog))
    await writeFileAtomic(
      NodePath.join(directory, "grade.log"),
      await NodeFSP.readFile(stagedLog, "utf8"),
    );
};

export interface GradeSavedBuildInput {
  readonly brief: LoadedGameBenchmarkBrief;
  readonly root: string;
  /** The saved selection to serve, or null when only a legacy workspace can be graded. */
  readonly artifact: SelectedWebArtifact | null;
  readonly outDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}

export interface RegradeBatchInput {
  readonly runDirectory: string;
  readonly briefs: ReadonlyArray<LoadedGameBenchmarkBrief>;
  readonly order: ReadonlyArray<string>;
  readonly jobs: number;
  /** The only external effect: grade a saved build. There is deliberately no builder. */
  readonly grade: (input: GradeSavedBuildInput) => Promise<BenchmarkGrade | null>;
  readonly sandbox: (directory: string) => Promise<DisplaySandbox>;
  /** SIGINT/SIGTERM from the operator; aborts every in-flight grade. */
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
}

/**
 * Regrades saved harness runs in place. The builder is never started: only the
 * independent grader reads each recorded game root, then the saved row keeps
 * its outcome and timing with the new grade and evaluation profile.
 */
export async function runRegradeBatch(
  input: RegradeBatchInput,
): Promise<ReadonlyArray<BenchmarkBriefResult>> {
  const signal = input.signal;
  if (signal?.aborted) throw abortReason(signal);
  const evidence: SavedHarnessRunEvidence[] = [];
  const problems: string[] = [];
  for (const brief of input.briefs) {
    try {
      evidence.push(await readSavedHarnessRun({ runDirectory: input.runDirectory, brief }));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (problems.length > 0)
    throw new Error(
      `Cannot regrade saved runs:\n${problems.map((line) => `- ${line}`).join("\n")}`,
    );

  const saved = await readSavedBenchmarkRows(input.runDirectory, input.order);
  const sourceCommit = saved.harnessCommit ?? evidence[0]!.result.harnessCommit;
  for (const row of [...saved.results, ...evidence.map((entry) => entry.result)]) {
    if ((row.lane ?? "harness") !== "harness")
      throw new Error(`[${row.fixtureId}] --regrade only writes harness-lane aggregates.`);
    if (row.harnessCommit !== sourceCommit)
      throw new Error(
        `The saved rows under ${input.runDirectory} come from different commits; refusing to mix them.`,
      );
  }

  const writer = createBenchmarkAggregateWriter({
    runDirectory: input.runDirectory,
    harnessCommit: sourceCommit,
    lane: "harness",
    order: input.order,
    initial: saved.results,
  });

  let failure: unknown = null;
  try {
    await runBounded(
      evidence,
      input.jobs,
      async (entry, workerSignal) => {
        if (workerSignal.aborted) throw abortReason(workerSignal);
        const sandbox = await input.sandbox(entry.directory);
        const stage = await NodeFSP.mkdtemp(NodePath.join(entry.directory, ".regrade-"));
        try {
          input.log?.(`[${entry.brief.id}] regrading the saved build…`);
          const grade = await input.grade({
            brief: entry.brief,
            root: entry.root,
            artifact: entry.artifact,
            outDirectory: stage,
            environment: sandbox.environment,
            signal: workerSignal,
          });
          if (workerSignal.aborted) throw abortReason(workerSignal);
          if (grade === null)
            throw new Error(
              `[${entry.brief.id}] the grader wrote no grade; the saved result and grade are unchanged.`,
            );
          if (grade.void)
            throw new Error(
              `[${entry.brief.id}] the regrade is void; the saved result and grade are unchanged.`,
            );
          if (grade.inconclusive)
            throw new Error(
              `[${entry.brief.id}] the regrade is inconclusive: a control call did not answer, so it cannot replace the saved grade.`,
            );
          if (grade.grader === null || grade.graderVersion === null)
            throw new Error(
              `[${entry.brief.id}] the new grade records no grader profile; refusing to write it.`,
            );
          await installStagedGrade(entry.directory, stage);
          const updated = replaceIndependentGrade(entry.result, grade);
          await writeJsonAtomic(NodePath.join(entry.directory, "result.json"), updated);
          await writer.record(updated);
          input.log?.(`[${entry.brief.id}] ${updated.outcome} (grade replaced)`);
        } finally {
          await NodeFSP.rm(stage, { recursive: true, force: true }).catch(() => undefined);
        }
      },
      input.signal,
    );
  } catch (error) {
    failure = error;
  }
  try {
    await writer.flush();
  } catch (error) {
    if (failure === null) throw error;
  }
  if (failure !== null) throw failure;
  return writer.snapshot();
}
