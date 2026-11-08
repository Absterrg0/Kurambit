// @effect-diagnostics globalTimers:off globalDate:off globalDateInEffect:off nodeBuiltinImport:off globalFetch:off preferSchemaOverJson:off -- This service owns the native display/process boundary; wall-clock ticks, pids and line JSON are the domain here. Jev is one POST with an AbortSignal timeout, like the toolchain downloader.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { writeFileStringAtomically } from "@kurambit/shared/atomicWrite";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import {
  GAME_BOT_BOUNDS,
  GameOperationError,
  isGameEngineActive,
  type GameBotMode,
  type GameBotPerf,
  type GameBotReportResult,
  type GameBotRunInput,
  type GameBotRunResult,
  type GameBotViewInput,
  type GameBotViewResult,
  type ThreadId,
  manifestProject,
} from "@kurambit/contracts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotEvidence from "./botEvidence.ts";
import * as ExploreEvidence from "./exploreEvidence.ts";
import * as GameEngine from "./GameEngine.ts";
import * as GamePlayer from "./GamePlayer.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { insideGame } from "./GameProjectService.ts";
import { findExecutable } from "./GameProcesses.ts";
import { GAME_BOT_CHILD_JS } from "./gameBotChild.ts";
import { makeGameBrowser } from "./gameChromium.ts";
import { ProcessHost } from "./processHost.ts";
import { findWindowHost } from "./windowHost.ts";
import * as GameProcesses from "./GameProcesses.ts";
import { PlayDidNotBoot, openPagePlay, openRunnerPlay } from "./playLaunch.ts";
import { encodePlayUse, PLAY_USE_FILE } from "./assetUse.ts";
import { PLAY_PERF_FILE } from "./playPerf.ts";
import { encodeSceneFile, keepSceneReport, SCENE_FILE } from "./sceneReport.ts";
import {
  appendNoFollow,
  ensureGameDir,
  keptSavesFor,
  keptWebStorage,
  writeKeptStorage,
} from "./gameKeptSaves.ts";
import { playBot, runWithoutPlay } from "./gameBotPlay.ts";
import {
  botEnding,
  botFinalState,
  cellOf,
  makeJev,
  medianOf,
  opError,
  type Session,
} from "./gameBotRuntime.ts";
import * as GameMemoryGate from "./GameMemoryGate.ts";
import { runtimesFor } from "./gameRuntime.ts";
import * as GameTemplates from "./GameTemplates.ts";
import type { MemoryRoom } from "./GameMemoryGate.ts";
import { isPathInside } from "./gameNativeUserDir.ts";
import { PLAY_BOUNDS, bounded } from "./playSession.ts";

const GAME_BOT_JEV_BASE_SECRET = "game-bot-jev-base-url";

/**
 * A Godot bot peaked at 710 MB in its import and 505 MB playing (Godot,
 * ffmpeg recording, its display, bot child); a Chromium bot at 630 MB. Each
 * run's import and boot hold the memory gate, so the next start's check sees
 * what this one took.
 */
const BOT_ROOM: MemoryRoom = {
  what: "bot run",
  neededMb: 1536,
  env: "KURAMBIT_BOT_MEMORY_MB",
};

/** How long a stop waits for a bot call to end: its run's teardown is bounded well inside. */
const STOP_WAIT_MS = 60_000;
const STOP_WAIT = Duration.millis(STOP_WAIT_MS);
const JEV_DEFAULT_BASE = "https://api.typesafe.ai";

export interface RunOptions {
  /** Hears each start's wait for the operation lock and the memory gate, and why it was refused. */
  readonly onWaited?: (waitedMs: number, refused: "low-memory" | "busy" | null) => void;
}

/** The people-facing copy of a run in `.studio/bot-results.jsonl`, never through a planted link. */
const appendResult = async (root: string, line: string) => {
  try {
    await appendNoFollow(
      NodePath.join(await ensureGameDir(root, ".studio"), "bot-results.jsonl"),
      line,
    );
  } catch {
    // A copy for people: the run decides by its record, so a refused write costs nothing.
  }
};

export class GameBot extends Context.Service<
  GameBot,
  {
    /**
     * With `owner`, each run is recorded on that thread's bot evidence before
     * the next starts; a run that cannot be recorded fails the call.
     */
    readonly run: (
      root: string,
      input: GameBotRunInput,
      owner?: ThreadId,
      options?: RunOptions,
    ) => Effect.Effect<GameBotRunResult, GameOperationError>;
    /** The bot runs recorded on a thread; a run decides by these, never by a game file. */
    readonly runs: (
      threadId: ThreadId,
    ) => Effect.Effect<BotEvidence.ThreadBots, GameOperationError>;
    readonly view: (
      root: string,
      input: GameBotViewInput,
    ) => Effect.Effect<GameBotViewResult, GameOperationError>;
    /** Rebuild the facts-only player report across recorded runs. */
    readonly report: (root: string) => Effect.Effect<GameBotReportResult, GameOperationError>;
    /** The report of exactly these runs, read-only; null when none has a trace. */
    readonly reportText: (
      root: string,
      runIds: ReadonlyArray<string>,
    ) => Effect.Effect<string | null, GameOperationError>;
    /**
     * The latest play-mode bot any thread ran on this game folder, from the
     * server's records (never the folder's own results file); null when none ran.
     */
    readonly latestPlayBot: (root: string) => Effect.Effect<{
      readonly file: string;
      readonly decider: "policy" | "jev";
      readonly at: string;
    } | null>;
    /** Stops one game's bot call by root and waits for it to end (bounded); game_stop calls this. */
    readonly stop: (root: string) => Effect.Effect<void>;
    /** Stops every bot call a thread started and waits for each to end (bounded): its turn is over. */
    readonly stopOwned: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("kurambit/game/GameBot") {}

interface RunTrace {
  runId: string;
  /** False on a run whose bot never ran: not a run on the record, nor in a report. */
  played?: boolean;
  file: string;
  decider: string;
  mode?: string;
  goal: string;
  ticks: number;
  gameSeconds: number;
  decisions: number;
  jev: {
    calls: number;
    failures: number;
    medianMs?: number | null;
    decisions2Plus?: number;
    valid?: boolean;
  } | null;
  policyNote: string | null;
  usedSetState: boolean;
  setStates: Array<{ t: number; target: unknown; values: unknown }>;
  picks: Array<{ t: number; name: string; via: string; randomized?: boolean }>;
  offered: Array<{ t: number; options: string[] }>;
  status: { state: string; note: string };
  findings: Array<{
    detector: string;
    severity: string;
    summary: string;
    t: number;
    pos: [number, number, number] | null;
    detail: string;
  }>;
  samples: Array<{ t: number; pos: [number, number, number] | null; state: unknown }>;
  finalPos: [number, number, number] | null;
  finalState?: Record<string, number | boolean | string | null>;
  perf?: GameBotPerf;
  videoPath?: string;
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const traceFile = (root: string, runId: string) =>
  NodePath.join(root, "builds/logs", `game-bot-${runId}`, "trace.json");

/** One run's trace, or null when it is missing, unreadable or another run's. */
const readTrace = async (root: string, runId: string): Promise<RunTrace | null> => {
  if (!RUN_ID.test(runId)) return null;
  try {
    const trace = JSON.parse(await NodeFSP.readFile(traceFile(root, runId), "utf8")) as RunTrace;
    return trace?.runId === runId ? trace : null;
  } catch {
    return null;
  }
};

/** The newest run traces under builds/logs (at most 20), found by stat before any is read. */
const listRunTraces = async (
  root: string,
): Promise<Array<{ runId: string; trace: RunTrace; mtime: number }>> => {
  const logs = NodePath.join(root, "builds/logs");
  const entries = await NodeFSP.readdir(logs).catch(() => [] as string[]);
  const stamped: Array<{ runId: string; mtime: number }> = [];
  for (const entry of entries) {
    if (!entry.startsWith("game-bot-")) continue;
    const runId = entry.slice("game-bot-".length);
    const stat = await NodeFSP.stat(traceFile(root, runId)).catch(() => null);
    if (stat?.isFile() === true) stamped.push({ runId, mtime: stat.mtimeMs });
  }
  stamped.sort((a, b) => b.mtime - a.mtime);
  const out: Array<{ runId: string; trace: RunTrace; mtime: number }> = [];
  for (const { runId, mtime } of stamped) {
    if (out.length >= 20) break;
    const trace = await readTrace(root, runId);
    // One bad trace never breaks the report; a bot that never ran is no run.
    if (trace !== null && trace.played !== false) out.push({ runId, trace, mtime });
  }
  return out;
};

const fmtT = (t: number): string => `${t.toFixed(1)}s`;
const fmtPos = (pos: [number, number, number] | null): string =>
  pos === null ? "unknown" : `(${pos[0].toFixed(1)}, ${pos[1].toFixed(1)}, ${pos[2].toFixed(1)})`;
const shortId = (runId: string): string => runId.slice(0, 8);

/**
 * Facts-only player report across runs, written by code. States what
 * happened (positions, times, counts, clusters) and interprets nothing:
 * no causes, no fixes, no recommendations.
 */
const playerReportText = (
  picked: ReadonlyArray<{ runId: string; trace: RunTrace; mtime: number }>,
  unreadable: number,
): { text: string; runs: string[] } | null => {
  // Oldest first so the report reads in play order.
  const ordered = [...picked].sort((a, b) => a.mtime - b.mtime);
  if (ordered.length === 0) return null;
  const lines: string[] = [
    "# Player report (facts only, by code)",
    "",
    `Runs: ${ordered.length}. No interpretation: positions, times and counts only.` +
      (unreadable > 0 ? ` ${unreadable} run's trace could not be read and is left out.` : ""),
    "",
    "## Runs",
    "",
    "| run | bot | decider | game s | decisions | end | findings | jev |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const { trace } of ordered) {
    const jevBit =
      trace.jev !== null && trace.jev !== undefined
        ? `jev ${trace.jev.calls}/${trace.jev.failures} failed${trace.jev.valid === true ? "" : " (NOT valid)"}`
        : (trace.policyNote ?? "policy");
    lines.push(
      `| ${shortId(trace.runId)} | ${trace.file ?? "?"} | ${trace.decider ?? "?"} ${trace.mode ?? ""} | ${Number(trace.gameSeconds ?? 0).toFixed(1)} | ${trace.decisions ?? 0} | ${trace.status?.state ?? "?"} | ${trace.findings?.length ?? 0} | ${jevBit} |`,
    );
  }
  // Ending positions, in 2 m cells below. Old traces predate finalPos;
  // those fall back to their last sampled position.
  const endPosOf = (trace: RunTrace): [number, number, number] | null => {
    if (trace.finalPos !== null && trace.finalPos !== undefined) return trace.finalPos;
    for (let i = trace.samples.length - 1; i >= 0; i--) {
      const pos = trace.samples[i]?.pos ?? null;
      if (pos !== null) return pos;
    }
    return null;
  };
  lines.push("", "## Endings", "", "| run | end | note | final pos |", "| --- | --- | --- | --- |");
  for (const { trace } of ordered) {
    const note = String(trace.status?.note ?? "")
      .replace(/\|/g, "/")
      .slice(0, 160);
    lines.push(
      `| ${shortId(trace.runId)} | ${trace.status?.state ?? "?"} | ${note} | ${fmtPos(endPosOf(trace))} |`,
    );
  }
  // Death/stall cluster: ending positions of runs that did not finish, plus
  // every error-severity finding with a position, in 2 m cells.
  const cells = new Map<string, { cx: number; cy: number; cz: number; hits: Array<string> }>();
  const bump = (pos: [number, number, number] | null, label: string): void => {
    if (pos === null) return;
    const cx = Math.round(pos[0] / 2) * 2;
    const cy = Math.round(pos[1] / 2) * 2;
    const cz = Math.round(pos[2] / 2) * 2;
    const key = `${cx},${cy},${cz}`;
    const cell = cells.get(key) ?? { cx, cy, cz, hits: [] };
    cell.hits.push(label);
    cells.set(key, cell);
  };
  for (const { trace } of ordered) {
    const id = shortId(trace.runId);
    if (trace.status?.state !== "done" && trace.status?.state !== "budget")
      bump(
        endPosOf(trace),
        `${id} end ${trace.status?.state} t=${fmtT(Number(trace.gameSeconds ?? 0))}`,
      );
    for (const finding of trace.findings ?? []) {
      if (finding.severity === "error")
        bump(finding.pos ?? null, `${id} ${finding.detector} t=${fmtT(Number(finding.t ?? 0))}`);
    }
  }
  lines.push("", "## Death/stall positions (2 m cells)", "");
  if (cells.size === 0)
    lines.push("None: every run ended done/budget with no error finding carrying a position.");
  else {
    lines.push("| cell | hits | what |", "| --- | --- | --- |");
    for (const cell of [...cells.values()].sort((a, b) => b.hits.length - a.hits.length))
      lines.push(
        `| (${cell.cx}, ${cell.cy}, ${cell.cz}) | ${cell.hits.length} | ${cell.hits.slice(0, 8).join("; ")} |`,
      );
  }
  // Picks: what was done and how often; offered but never picked.
  const pickCounts = new Map<string, { total: number; runs: Set<string>; firsts: number[] }>();
  const offeredSet = new Set<string>();
  for (const { trace } of ordered) {
    const id = shortId(trace.runId);
    const firstSeen = new Map<string, number>();
    for (const pick of trace.picks ?? []) {
      const name = String(pick.name ?? "?");
      const entry = pickCounts.get(name) ?? { total: 0, runs: new Set<string>(), firsts: [] };
      entry.total += 1;
      entry.runs.add(id);
      if (!firstSeen.has(name)) {
        firstSeen.set(name, Number(pick.t ?? 0));
        entry.firsts.push(Number(pick.t ?? 0));
      }
      pickCounts.set(name, entry);
    }
    for (const offer of trace.offered ?? [])
      for (const name of offer.options ?? []) offeredSet.add(String(name));
  }
  lines.push(
    "",
    "## Options picked",
    "",
    "| option | picks | runs | first t (min / median) |",
    "| --- | --- | --- | --- |",
  );
  const ranked = [...pickCounts.entries()].sort((a, b) => b[1].total - a[1].total);
  if (ranked.length === 0) lines.push("| (none recorded) | 0 | 0 | - |");
  for (const [name, entry] of ranked) {
    const firsts = entry.firsts.sort((a, b) => a - b);
    lines.push(
      `| ${name} | ${entry.total} | ${entry.runs.size}/${ordered.length} | ${fmtT(firsts[0]!)} / ${fmtT(medianOf(firsts) ?? firsts[0]!)} |`,
    );
  }
  const neverPicked = [...offeredSet].filter((name) => !pickCounts.has(name)).sort();
  const rarePicked = ranked.filter(([, entry]) => entry.total <= 2).map(([name]) => name);
  lines.push(
    "",
    `Offered but never picked (${neverPicked.length}): ${neverPicked.length === 0 ? "none" : neverPicked.join(", ")}.`,
    "",
    `Rarely picked, 2 or fewer picks total (${rarePicked.length}): ${rarePicked.length === 0 ? "none" : rarePicked.join(", ")}.`,
  );
  // Coverage: visited 4 m cells over x/z, bounding box, furthest reach.
  const visited = new Map<string, { cx: number; cz: number; n: number }>();
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const { trace } of ordered) {
    for (const sample of trace.samples ?? []) {
      if (sample.pos === null) continue;
      const [x, , z] = sample.pos;
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
      const { cx, cz, key } = cellOf(x, z);
      const cell = visited.get(key) ?? { cx, cz, n: 0 };
      cell.n += 1;
      visited.set(key, cell);
    }
  }
  lines.push("", "## Areas (4 m cells over x/z, from position samples)", "");
  if (visited.size === 0) lines.push("No position samples recorded.");
  else {
    const orderedCells = [...visited.values()].sort((a, b) => b.n - a.n);
    lines.push(
      `Visited cells: ${visited.size}. Bounding box x ${minX.toFixed(1)}..${maxX.toFixed(1)}, z ${minZ.toFixed(1)}..${maxZ.toFixed(1)}.`,
      "",
      `Most-sampled cells: ${orderedCells
        .slice(0, 10)
        .map((cell) => `(${cell.cx}, ${cell.cz}) x${cell.n}`)
        .join("; ")}.`,
    );
    const inside: string[] = [];
    for (let cx = Math.floor(minX / 4) * 4; cx <= maxX && inside.length < 60; cx += 4)
      for (let cz = Math.floor(minZ / 4) * 4; cz <= maxZ && inside.length < 60; cz += 4)
        if (!visited.has(`${cx},${cz}`)) inside.push(`(${cx}, ${cz})`);
    const totalInside =
      (Math.floor(maxX / 4) - Math.floor(minX / 4) + 1) *
      (Math.floor(maxZ / 4) - Math.floor(minZ / 4) + 1);
    lines.push(
      "",
      `Cells inside the bounding box never sampled: ${Math.max(0, totalInside - visited.size)}${inside.length > 0 ? ` (first ${inside.length}: ${inside.join("; ")})` : ""}.`,
    );
  }
  // Findings grouped by detector.
  const byDetector = new Map<string, Array<string>>();
  for (const { trace } of ordered) {
    const id = shortId(trace.runId);
    for (const finding of trace.findings ?? []) {
      const list = byDetector.get(finding.detector) ?? [];
      list.push(
        `${id} t=${fmtT(Number(finding.t ?? 0))} ${fmtPos(finding.pos ?? null)}: ${String(finding.summary ?? "").slice(0, 160)}`,
      );
      byDetector.set(finding.detector, list);
    }
  }
  lines.push("", "## Detector findings", "");
  if (byDetector.size === 0) lines.push("None.");
  else
    for (const [detector, list] of [...byDetector.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    )) {
      lines.push(`- ${detector} (${list.length}):`);
      for (const item of list.slice(0, 20)) lines.push(`  - ${item}`);
    }
  // Explicit state writes are never play.
  let writes = 0;
  const writeLines: string[] = [];
  for (const { trace } of ordered) {
    for (const entry of trace.setStates ?? []) {
      writes += 1;
      if (writeLines.length < 20)
        writeLines.push(
          `- ${shortId(trace.runId)} t=${fmtT(Number((entry as { t?: unknown }).t ?? 0))}: ${String((entry as { target?: unknown }).target ?? "?")}`,
        );
    }
  }
  lines.push("", `## Explicit state writes: ${writes}`, "");
  lines.push(
    ...(writeLines.length > 0 ? writeLines : ["None. Runs without writes are pure input play."]),
  );
  // Honesty footer: which runs Jev actually decided.
  lines.push("", "## Decider honesty", "");
  for (const { trace } of ordered) {
    const id = shortId(trace.runId);
    if (trace.jev !== null && trace.jev !== undefined)
      lines.push(
        `- ${id}: jev ${trace.jev.calls} calls/${trace.jev.failures} failed, ${trace.jev.decisions2Plus ?? 0} decisions among 2+ options${trace.jev.valid === true ? "" : " (NOT a valid Jev run)"}.`,
      );
    else lines.push(`- ${id}: ${trace.policyNote ?? "policy decider"}.`);
    const randomised = (trace.picks ?? []).filter((pick) => pick.randomized === true).length;
    if (randomised > 0) lines.push(`  randomised policy picks: ${randomised} (no key: not Jev).`);
  }
  return { text: `${lines.join("\n")}\n`, runs: ordered.map((entry) => entry.runId) };
};

/** The traces of exactly these runs, with how many could not be read. */
const tracesOf = async (root: string, runIds: ReadonlyArray<string>) => {
  const picked: Array<{ runId: string; trace: RunTrace; mtime: number }> = [];
  let unreadable = 0;
  for (const runId of runIds) {
    const trace = await readTrace(root, runId);
    if (trace === null) {
      unreadable += 1;
      continue;
    }
    if (trace.played === false) continue;
    const stat = await NodeFSP.stat(traceFile(root, runId)).catch(() => null);
    picked.push({ runId, trace, mtime: stat?.mtimeMs ?? 0 });
  }
  return { picked, unreadable };
};

const make = Effect.gen(function* () {
  const processHost = yield* ProcessHost;
  const engines = yield* GameEngine.GameEngine;
  const players = yield* GamePlayer.GamePlayer;
  const projects = yield* GameProjectService.GameProjectService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const processes = yield* GameProcesses.GameProcesses;
  const gameBrowser = yield* makeGameBrowser;
  const scheduler = yield* Scheduler.Scheduler;
  const gate = yield* GameMemoryGate.GameMemoryGate;
  const templates = yield* GameTemplates.GameTemplates;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fileServices = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const evidenceDir = NodePath.join((yield* ServerConfig.ServerConfig).stateDir, "bot-evidence");
  const evidenceLock = Semaphore.makeUnsafe(1);
  // Records untouched as long as explore evidence's belong to runs long finished.
  const prune = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* evidenceLock
      .withPermits(1)(Effect.tryPromise(() => ExploreEvidence.prune(evidenceDir, now)))
      .pipe(
        Effect.catchCause((cause) => Effect.logWarning("Pruning bot evidence failed.", { cause })),
      );
  });
  yield* prune;
  yield* scheduler.register("game-bot-evidence", yield* Scheduler.every(3_600_000, prune));
  /**
   * The caller holds `evidenceLock`. A damaged record counts as none, and says
   * so; the next recorded run moves it aside.
   */
  const loadRecord = (threadId: ThreadId, root: string) =>
    Effect.tryPromise({
      try: () => BotEvidence.read(evidenceDir, threadId),
      catch: (cause) => opError("Bot evidence", evidenceDir, "io", undefined, cause),
    }).pipe(
      Effect.flatMap((found) =>
        found === "damaged"
          ? Effect.logWarning("A thread's bot evidence is unreadable; it counts as none.", {
              threadId,
            }).pipe(Effect.as(BotEvidence.empty(threadId, root)))
          : Effect.succeed(found ?? BotEvidence.empty(threadId, root)),
      ),
    );
  /** Each game's latest play-mode bot, read from the records once and kept as runs are recorded. */
  const latestPlays = new Map<string, BotEvidence.BotRun | null>();
  const recordRun = (threadId: ThreadId, root: string, run: BotEvidence.BotRun) =>
    evidenceLock.withPermits(1)(
      Effect.gen(function* () {
        const found = yield* Effect.tryPromise({
          try: () => BotEvidence.read(evidenceDir, threadId),
          catch: (cause) => opError("Bot run", evidenceDir, "io", undefined, cause),
        });
        if (found === "damaged") {
          const now = yield* Clock.currentTimeMillis;
          const aside = yield* Effect.tryPromise({
            try: () => BotEvidence.setAside(evidenceDir, threadId, now),
            catch: (cause) =>
              opError(
                "Bot run",
                evidenceDir,
                "io",
                "A damaged bot record could not be moved aside.",
                cause,
              ),
          });
          yield* Effect.logWarning("A thread's bot evidence was unreadable; it is kept aside.", {
            threadId,
            aside,
          });
        }
        const next = BotEvidence.add(
          found === null || found === "damaged" ? BotEvidence.empty(threadId, root) : found,
          root,
          run,
        );
        yield* fileServices(BotEvidence.write(evidenceDir, next)).pipe(
          Effect.mapError((cause) =>
            opError("Bot run", evidenceDir, "io", "The bot run could not be recorded.", cause),
          ),
        );
        // The game's latest play bot, as latestPlayBot answers it, follows the record.
        if (run.mode !== "explore") latestPlays.set(root, run);
      }),
    );

  /** One bot call per checkout root, with whose it is and when it has ended. */
  const sessions = new Map<
    string,
    {
      readonly session: Session;
      readonly owner: ThreadId | undefined;
      readonly done: Deferred.Deferred<void>;
      /** Completed by a stop, which every wait of the call races: gate, boot, player build. */
      readonly stopRequested: Deferred.Deferred<void>;
    }
  >();
  const botLocks = yield* KeyedLock.make<string>();
  // A stop flips the flag before it ends anything, so the run reads its end
  // as stopped, never as the game crashing.
  const drop = (root: string) => {
    const entry = sessions.get(root);
    if (entry === undefined) return null;
    entry.session.stopped = true;
    Deferred.doneUnsafe(entry.stopRequested, Exit.void);
    for (const owned of entry.session.processes) void owned.stop();
    return entry.done;
  };
  /** Stops the calls `which` picks and waits for each to end, bounded. */
  const stopWhere = (which: (root: string, owner: ThreadId | undefined) => boolean) =>
    Effect.gen(function* () {
      const ending = [...sessions.entries()]
        .filter(([root, entry]) => which(root, entry.owner))
        .map(([root]) => drop(root))
        .filter((done) => done !== null);
      for (const done of ending) {
        const ended = yield* Deferred.await(done).pipe(Effect.timeoutOption(STOP_WAIT));
        if (Option.isNone(ended))
          yield* Effect.logWarning("A stopped bot run did not end within its bound.");
      }
    });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const root of sessions.keys()) drop(root);
    }),
  );

  const readSecretText = (name: string): Effect.Effect<string | null, GameOperationError> =>
    Effect.gen(function* () {
      const found = yield* secrets
        .get(name)
        .pipe(Effect.mapError((cause) => opError("Bot secret", name, "io", undefined, cause)));
      if (Option.isNone(found)) return null;
      const text = Buffer.from(found.value).toString("utf8").trim();
      return text === "" ? null : text;
    });

  const jevApi = makeJev();

  const isGameOperationError = Schema.is(GameOperationError);

  const runLocked = (
    root: string,
    input: GameBotRunInput,
    owner: ThreadId | undefined,
    options: RunOptions | undefined,
  ) =>
    Effect.gen(function* () {
      // A bot is a game file under .studio/bot/*.mjs; anything else is refused.
      const botDir = NodePath.resolve(root, ".studio/bot");
      const botFile = NodePath.resolve(root, input.file);
      if (!isPathInside(botFile, botDir) || botFile === botDir || !botFile.endsWith(".mjs"))
        return yield* opError(
          "Bot run",
          input.file,
          "invalid-input",
          "The bot file must live under .studio/bot/ and end with .mjs.",
        );
      const isFile = yield* Effect.promise(() =>
        NodeFSP.stat(botFile)
          .then((stat) => stat.isFile())
          .catch(() => false),
      );
      if (!isFile)
        return yield* opError("Bot run", input.file, "invalid-input", "No bot file there.");
      const seconds = Math.min(
        GAME_BOT_BOUNDS.maxSeconds,
        Math.max(GAME_BOT_BOUNDS.minSeconds, input.seconds ?? GAME_BOT_BOUNDS.defaultSeconds),
      );
      const decider = input.decider ?? "policy";
      const mode: GameBotMode = input.mode ?? "play";
      // One call may make several sequential runs (exploration compares
      // across runs). Ten at most; each run gets its own directory.
      const count = Math.min(10, Math.max(1, Math.floor(input.runs ?? 1)));
      const pathEnv = process.env.PATH ?? "";
      // The engine says how its game plays: a browser page, its runner on the
      // sources, or a prepared player. Everything else here is the same run.
      const manifest = yield* projects.read(root);
      if (!isGameEngineActive(manifest.engine.name))
        return yield* GameEngine.parkedEngine(manifest.engine.name);
      const backend = yield* engines.backendFor(manifest.engine.name);
      const profile = backend.profile;
      const projectDir = insideGame(root, manifestProject(manifest));
      const isWeb = profile.play === "browser";
      const viewport = yield* backend.viewport(projectDir);
      const browser = isWeb ? yield* gameBrowser("Bot run", root) : null;
      const runtimes = isWeb ? yield* runtimesFor(templates, manifest) : null;
      const ffmpeg = yield* Effect.promise(() =>
        findExecutable("ffmpeg", { pathEnv, override: process.env.KURAMBIT_FFMPEG }),
      );
      if (ffmpeg === null)
        return yield* opError(
          "Bot run",
          "ffmpeg",
          "tool-missing",
          "ffmpeg is needed for the run video.",
        );
      const host = isWeb ? null : yield* Effect.promise(() => findWindowHost(processHost));
      if (host === null && !isWeb)
        return yield* opError(
          "Bot run",
          "Xvfb",
          "tool-missing",
          "A bot run needs a window for the game, and this machine has no private display; install the system Xvfb package.",
        );
      const saves = yield* keptSavesFor({
        root,
        engine: manifest.engine.name,
        saves: input.saves,
        operation: "Bot run",
      });
      let jevKey: string | null = null;
      let jevBase = JEV_DEFAULT_BASE;
      let policyNote: string | null = null;
      if (decider === "jev") {
        // The Jev key is a settings secret (Settings → Game tools); bots never see it.
        const { gameJevApiKey } = yield* settings.getSettings.pipe(
          Effect.mapError((cause) =>
            opError("Bot secret", "gameJevApiKey", "io", undefined, cause),
          ),
        );
        jevKey = gameJevApiKey === "" ? null : gameJevApiKey;
        const base = yield* readSecretText(GAME_BOT_JEV_BASE_SECRET);
        if (base !== null) jevBase = base;
        if (jevKey === null)
          policyNote =
            mode === "explore"
              ? "No Jev key is set in Settings → Game tools; this exploration ran with randomised policy choices, not Jev."
              : "No Jev key is set in Settings → Game tools; this run used the bot's own policy.";
      }
      const jevLive = decider === "jev" && jevKey !== null;
      // The game's runner imports into its sources first, and that is a write
      // of the folder: under the game's operation lock, then the memory gate,
      // through the boot (GameMemoryGate fixes the order). A browser page and
      // a prepared player write nothing.
      const writesFolder = profile.play === "native";
      const startLock = writesFolder
        ? {
            lock: {
              name: "Bot run start",
              owner: owner === undefined ? "system bot run" : String(owner),
            },
          }
        : undefined;
      // One session object spans the whole call: drop() flips its flag, so
      // a stop between runs ends the call with the runs it has. A per-run
      // entry in the map would vanish with each run's cleanup and the loop
      // could never tell "stopped" from "between runs".
      const session: Session = {
        root,
        runId: NodeCrypto.randomUUID(),
        stopped: false,
        processes: [],
      };
      const each = yield* Effect.acquireUseRelease(
        Effect.gen(function* () {
          const done = yield* Deferred.make<void>();
          const stopRequested = yield* Deferred.make<void>();
          sessions.set(root, { session, owner, done, stopRequested });
          return { done, stopRequested };
        }),
        ({ stopRequested }) =>
          Effect.gen(function* () {
            const stoppedError = opError("Bot run", root, "cancelled", "Bot run stopped.");
            /** A stop ends `effect` wherever it waits; what it started is ended by its own scope. */
            const untilStopped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.raceFirst(
                effect,
                Deferred.await(stopRequested).pipe(Effect.andThen(Effect.fail(stoppedError))),
              );
            // A player of the current sources, built once per source identity
            // (idempotent, so each run asks again cheaply); an editor that just
            // built it closes, so it never plays beside the run. Sources that
            // will not build are the game's: the run is not-booted.
            const preparedPlayer =
              profile.play === "player"
                ? players.prepare(root).pipe(
                    Effect.map((prepared): string | null => prepared.player),
                    Effect.catchTags({
                      GameOperationError: (error) =>
                        error.reason === "command-failed"
                          ? Effect.fail(
                              new PlayDidNotBoot({ detail: error.message.slice(0, 2000) }),
                            )
                          : Effect.fail(error),
                    }),
                  )
                : Effect.succeed(null);
            const out: GameBotRunResult[] = [];
            // What earlier runs of this call covered, told to each next run so
            // runs differ instead of collapsing onto one trajectory.
            const priorRuns: Array<{ topOptions: string; cells: number; ending: string }> = [];
            for (let index = 0; index < count; index++) {
              if (session.stopped) break;
              const runId = NodeCrypto.randomUUID();
              const runDir = NodePath.join(root, "builds/logs", `game-bot-${runId}`);
              const childPath = NodePath.join(runDir, "child.mjs");
              const videoPath = NodePath.join(runDir, "run.mp4");
              const tracePath = NodePath.join(runDir, "trace.json");
              // A fresh folder of its own under a logs folder checked to be the
              // game's: nothing the run writes there can follow a planted link.
              yield* Effect.tryPromise({
                try: async () => {
                  await ensureGameDir(root, "builds/logs");
                  await NodeFSP.mkdir(runDir);
                },
                catch: (cause) => opError("Bot run", runDir, "io", undefined, cause),
              });
              yield* Effect.tryPromise({
                try: () => NodeFSP.writeFile(childPath, GAME_BOT_CHILD_JS),
                catch: (cause) => opError("Bot run", childPath, "io", undefined, cause),
              });
              // Anything the run loop throws that is not already ours to name is
              // a fault of our own side: the game's ends are results.
              const failed = (cause: unknown) =>
                isGameOperationError(cause)
                  ? cause
                  : opError(
                      "Bot run",
                      root,
                      "tool-failed",
                      cause instanceof Error
                        ? cause.message.slice(0, 2000)
                        : String(cause).slice(0, 2000),
                      cause,
                    );
              const launch = (player: string | null) =>
                isWeb
                  ? openPagePlay({
                      operation: "Bot run",
                      root,
                      projectDir,
                      browser: browser!,
                      viewport,
                      bootTimeoutMs: PLAY_BOUNDS.bootMs,
                      keptStorage: keptWebStorage(saves),
                      recordUse: true,
                      sceneReport: true,
                      runtimes,
                    })
                  : openRunnerPlay(processes, {
                      operation: "Bot run",
                      process: "bot-play",
                      root,
                      backend,
                      projectDir,
                      player,
                      viewport,
                      host,
                      scriptDir: runDir,
                      traceDir: runDir,
                      saves,
                      timeoutMs: PLAY_BOUNDS.bootMs + (seconds + 300) * 1000,
                      bootTimeoutMs: PLAY_BOUNDS.bootMs,
                      what: "The game's runner",
                    });
              const imported = writesFolder
                ? Effect.flatMap(engines.importProject(root), (result) =>
                    result.success
                      ? Effect.void
                      : Effect.fail(
                          new PlayDidNotBoot({
                            detail:
                              `The ${profile.displayName} import failed before the bot run started.\n${result.message}`.slice(
                                -2000,
                              ),
                          }),
                        ),
                  )
                : Effect.void;
              // The boot is the start's own memory peak, so it runs inside the gate.
              const open = untilStopped(
                Effect.flatMap(preparedPlayer, (player) =>
                  gate.admit(
                    "Bot run",
                    root,
                    BOT_ROOM,
                    Effect.andThen(imported, launch(player)),
                    options?.onWaited,
                    startLock,
                  ),
                ),
              );
              // An interrupt does not wait for the play promise, and its finally
              // still stops the bot child and the video encoder: the launch ends
              // only once that settled (bounded), so nothing writes into the run's
              // folder once the call returns and its caller removes it.
              let playing: Promise<unknown> = Promise.resolve();
              // A stop during boot interrupts the launch, which ends what it started.
              const one = yield* Effect.acquireUseRelease(
                open.pipe(
                  Effect.interruptible,
                  Effect.mapError((error) =>
                    session.stopped
                      ? opError("Bot run", root, "cancelled", "Bot run stopped.")
                      : error,
                  ),
                ),
                (opened) =>
                  // A stop that landed as the game opened ends it unplayed.
                  (session.stopped ? Effect.fail(stoppedError) : Effect.void).pipe(
                    Effect.andThen(
                      Effect.tryPromise({
                        try: (signal) => {
                          const run = playBot(jevApi, opened, {
                            host: processHost,
                            root,
                            runId,
                            runDir,
                            childPath,
                            videoPath,
                            tracePath,
                            botFile,
                            decider,
                            mode,
                            jevLive,
                            seconds,
                            ffmpeg,
                            jevKey,
                            jevBase,
                            policyNote,
                            session,
                            signal,
                            runIndex: index,
                            runTotal: count,
                            seed: NodeCrypto.randomInt(1_000_000_000),
                            priorRuns: [...priorRuns],
                          });
                          playing = run;
                          return run;
                        },
                        catch: failed,
                      }).pipe(
                        // The backstop behind every per-call bound: a run past it is
                        // our own side hung, never the game.
                        Effect.timeoutOrElse({
                          duration: Duration.millis(PLAY_BOUNDS.bootMs + (seconds + 300) * 1000),
                          orElse: () =>
                            Effect.fail(
                              opError(
                                "Bot run",
                                root,
                                "tool-failed",
                                "The bot run overran its bound.",
                              ),
                            ),
                        }),
                      ),
                    ),
                  ),
                (opened) =>
                  Effect.gen(function* () {
                    yield* Effect.promise(() =>
                      bounded(
                        playing.catch(() => undefined),
                        STOP_WAIT_MS / 2,
                      ),
                    );
                    const stopped = yield* Effect.promise(() => opened.stop());
                    if (stopped.keptStorage !== null)
                      yield* fileServices(writeKeptStorage(stopped.keptStorage));
                    // Evidence beside the trace: the build's facts read it (asset use, performance).
                    const use = stopped.use;
                    if (use !== null)
                      yield* Effect.promise(() =>
                        NodeFSP.writeFile(
                          NodePath.join(runDir, PLAY_USE_FILE),
                          encodePlayUse(use),
                        ).catch(() => undefined),
                      );
                    const perf = stopped.perf;
                    if (perf !== null && perf !== undefined)
                      yield* Effect.promise(() =>
                        NodeFSP.writeFile(
                          NodePath.join(runDir, PLAY_PERF_FILE),
                          `${JSON.stringify(perf)}\n`,
                        ).catch(() => undefined),
                      );
                    // The scene report's frames go beside it, named from the run folder.
                    const scene = stopped.scene;
                    if (scene !== null)
                      yield* Effect.promise(async () => {
                        const kept =
                          scene === "no-shell"
                            ? scene
                            : await keepSceneReport(scene.raw, runDir, "");
                        if (kept !== null)
                          await NodeFSP.writeFile(
                            NodePath.join(runDir, SCENE_FILE),
                            encodeSceneFile(kept),
                          ).catch(() => undefined);
                      });
                  }),
              ).pipe(
                // The game never booted: measured, and a run on the record.
                Effect.catchTags({
                  PlayDidNotBoot: (error) =>
                    Effect.promise(() =>
                      runWithoutPlay(
                        { root, runId, botFile, decider, mode, tracePath, videoPath },
                        { goal: "play the game", state: "not-booted", note: error.detail },
                      ),
                    ),
                  // A stop ends the call with the runs it has.
                  GameOperationError: (error) =>
                    session.stopped && error.reason === "cancelled"
                      ? Effect.succeed(null)
                      : Effect.fail(error),
                }),
              );
              if (one === null) break;
              out.push(one);
              // A bot that never ran is not a bot run, and the same module would
              // fail the same way on every run of the call: nothing is recorded.
              if (one.played === false) break;
              const at = new Date().toISOString();
              // A run that played is recorded even when a stop lands right after it.
              if (owner !== undefined)
                yield* Effect.uninterruptible(
                  recordRun(owner, root, {
                    runId,
                    file: NodePath.relative(root, botFile),
                    mode,
                    decider,
                    won: one.status.state === "done",
                    ending: botEnding(one.status.state),
                    seconds: one.gameSeconds,
                    findings: one.findings.length,
                    at,
                  }),
                );
              // A copy for people reading the game folder; the run decides by the record above.
              yield* Effect.promise(() =>
                appendResult(
                  root,
                  `${JSON.stringify({
                    runId,
                    seconds: one.gameSeconds,
                    won: one.status.state === "done",
                    ending: botEnding(one.status.state),
                    note: one.status.note.slice(0, 160),
                    final: botFinalState(one.finalState),
                    video: videoPath,
                    findings: one.findings.length,
                    mode,
                    decider,
                    file: NodePath.relative(root, botFile),
                    at,
                  })}\n`,
                ),
              );
              // Tell the next run what this one covered: top options by picks,
              // visited 4 m cells, and how it ended. Best effort, never fatal.
              const trace = yield* Effect.promise(() => readTrace(root, runId));
              if (trace !== null) {
                const counts = new Map<string, number>();
                for (const pick of trace.picks ?? []) {
                  const name = String(pick?.name ?? "");
                  if (name !== "") counts.set(name, (counts.get(name) ?? 0) + 1);
                }
                const top = [...counts.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 3)
                  .map(([name, n]) => `${name} x${n}`)
                  .join(", ");
                const cells = new Set<string>();
                for (const sample of trace.samples ?? []) {
                  const pos = sample?.pos ?? null;
                  if (pos !== null && Number.isFinite(pos[0]) && Number.isFinite(pos[2]))
                    cells.add(cellOf(pos[0], pos[2]).key);
                }
                priorRuns.push({
                  topOptions: top === "" ? "no picks" : top,
                  cells: cells.size,
                  ending: String(trace.status?.state ?? "unknown"),
                });
              }
            }
            return out;
          }),
        // The map entry spans the whole call: one game's runs never overlap,
        // and a stop between runs still releases the game for the next call.
        ({ done }) =>
          Effect.sync(() => {
            if (sessions.get(root)?.session === session) sessions.delete(root);
          }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
      );
      if (each.length === 0)
        return yield* opError("Bot run", root, "cancelled", "The run was stopped.");
      const last = each[each.length - 1]!;
      const runIds = each.map((entry) => entry.runId);
      let reportPath: string | null = null;
      if (mode === "explore" || each.length > 1) {
        const written = yield* writeReport(
          root,
          yield* Effect.promise(() => tracesOf(root, runIds)),
        );
        if (written !== null) reportPath = written.rel;
      }
      if (each.length === 1) return { ...last, runIds, reportPath };
      const ticks = each.reduce((sum, entry) => sum + entry.ticks, 0);
      const decisions = each.reduce((sum, entry) => sum + entry.decisions, 0);
      const findings = each
        .flatMap((entry) => entry.findings)
        .slice(0, GAME_BOT_BOUNDS.maxFindings);
      const states = each.map((entry) => entry.status.state).join("/");
      return {
        ...last,
        // The call played if any of its runs did.
        ...(each.some((entry) => entry.played !== false) ? { played: true } : { played: false }),
        ticks,
        decisions,
        findings,
        runIds,
        reportPath,
        message:
          `${mode === "explore" ? "Exploration" : "Bot"} "${NodePath.relative(root, botFile)}" ` +
          `(${decider}): ${each.length} runs, ending ${states}. ` +
          `${decisions} decisions, ${findings.length} finding(s). ` +
          (reportPath === null ? "" : `Player report: ${reportPath}. `) +
          `Last run video: ${last.videoPath}`,
      };
    });

  const run = (root: string, input: GameBotRunInput, owner?: ThreadId, options?: RunOptions) =>
    botLocks
      .tryWithLock(root, 0, runLocked(root, input, owner, options))
      .pipe(
        Effect.flatMap((ran) =>
          Option.isSome(ran)
            ? Effect.succeed(ran.value)
            : Effect.fail(
                opError(
                  "Bot run",
                  root,
                  "busy",
                  "A bot run is already in progress for this game. Stop it with game_stop first.",
                ),
              ),
        ),
      );

  /** The report of these traces at .studio/player-report.md; null when there is none to write. */
  const writeReport = (
    root: string,
    traces: {
      readonly picked: Parameters<typeof playerReportText>[0];
      readonly unreadable: number;
    },
  ) =>
    Effect.gen(function* () {
      const report = playerReportText(traces.picked, traces.unreadable);
      if (report === null) return null;
      const rel = ".studio/player-report.md";
      // In the game folder, where an agent can plant a link at the file or a
      // folder above it: the folder is checked, the file replaced.
      const written = yield* Effect.tryPromise(() => ensureGameDir(root, ".studio")).pipe(
        Effect.flatMap((studio) =>
          fileServices(
            writeFileStringAtomically({
              filePath: NodePath.join(studio, "player-report.md"),
              contents: report.text,
              followLink: false,
            }),
          ),
        ),
        Effect.option,
      );
      return Option.isSome(written) ? { rel, runs: report.runs } : null;
    });

  const view = (root: string, input: GameBotViewInput) =>
    Effect.gen(function* () {
      // Read from the run's own trace, so a view after a restart still works.
      const trace = yield* Effect.promise(() => readTrace(root, input.runId));
      if (trace === null)
        return yield* opError(
          "Bot view",
          input.runId,
          "invalid-input",
          "No bot run with that id for this game.",
        );
      const kept = trace as RunTrace & Partial<GameBotViewResult>;
      return {
        runId: trace.runId,
        goal: trace.goal,
        status: kept.status ?? { state: "unknown", note: "" },
        ticks: trace.ticks,
        tickHz: kept.tickHz ?? 0,
        timeRatio: kept.timeRatio ?? 0,
        decisions: trace.decisions,
        jev:
          trace.jev === null || trace.jev === undefined
            ? null
            : { calls: trace.jev.calls, failures: trace.jev.failures },
        usedSetState: trace.usedSetState ?? false,
        ...(kept.refusedStates === undefined ? {} : { refusedStates: kept.refusedStates }),
        findings: trace.findings ?? [],
        tracePath: traceFile(root, trace.runId),
        videoPath: kept.videoPath ?? "",
        frames: kept.frames ?? [],
        message: kept.message ?? `Bot run ${trace.runId}: ${kept.status?.state ?? "unknown"}.`,
      } satisfies GameBotViewResult;
    });

  const report = (root: string) =>
    Effect.gen(function* () {
      const traces = yield* Effect.promise(() => listRunTraces(root));
      if (traces.length === 0)
        return yield* opError(
          "Bot report",
          root,
          "invalid-input",
          "No bot run traces recorded for this game yet.",
        );
      const written = yield* writeReport(root, { picked: traces, unreadable: 0 });
      if (written === null)
        return yield* opError("Bot report", root, "io", "The player report could not be written.");
      return {
        path: written.rel,
        runs: written.runs,
        message: `Player report across ${written.runs.length} run(s): ${written.rel}.`,
      } satisfies GameBotReportResult;
    });

  const reportText = (root: string, runIds: ReadonlyArray<string>) =>
    Effect.promise(() => tracesOf(root, runIds)).pipe(
      Effect.map((traces) => playerReportText(traces.picked, traces.unreadable)?.text ?? null),
    );

  const threadRuns = (threadId: ThreadId) => evidenceLock.withPermits(1)(loadRecord(threadId, ""));

  const latestPlayBot: GameBot["Service"]["latestPlayBot"] = (root) =>
    Effect.promise(async () => {
      if (latestPlays.has(root)) return latestPlays.get(root) ?? null;
      const play = await BotEvidence.latestPlay(evidenceDir, root);
      if (latestPlays.size > 500) latestPlays.clear();
      latestPlays.set(root, play);
      return play;
    }).pipe(
      Effect.map((play) =>
        play === null
          ? null
          : { file: play.file, decider: play.decider === "jev" ? "jev" : "policy", at: play.at },
      ),
    );

  return GameBot.of({
    run,
    runs: threadRuns,
    latestPlayBot,
    view,
    stop: (root) => stopWhere((each) => each === root),
    stopOwned: (threadId) => stopWhere((_root, owner) => owner === threadId),
    report,
    reportText,
  });
});

export const layer = Layer.effect(GameBot, make);
