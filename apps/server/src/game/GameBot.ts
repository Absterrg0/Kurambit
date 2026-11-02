// @effect-diagnostics globalTimers:off globalDate:off globalDateInEffect:off nodeBuiltinImport:off globalFetch:off preferSchemaOverJson:off -- This service owns the native display/process boundary; wall-clock ticks, pids and line JSON are the domain here. Jev is one POST with an AbortSignal timeout, like the toolchain downloader.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  GAME_BOT_BOUNDS,
  THREE_VIEWPORT,
  GameOperationError,
  type GameBotFinding,
  type GameBotMode,
  type GameBotReportResult,
  type GameBotRunInput,
  type GameBotRunResult,
  type GameBotViewInput,
  type GameBotViewResult,
} from "@kurambit/contracts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as GameToolchain from "./GameToolchain.ts";
import { prepareNativeUserIsolation, type NativeUserIsolation } from "./gameNativeUserDir.ts";
import { engineChildEnv, findExecutable } from "./GameProcesses.ts";
import { nativeChildEnv, nativeGodotArgs, nativeSessionToken } from "./gameExploreNative.ts";
import { GODOT_BOT_SCRIPT } from "./godotBotScript.ts";
import { GAME_BOT_CHILD_JS } from "./gameBotChild.ts";
import { parseGodotViewport } from "./godotViewport.ts";
import {
  READ_STUDIO_READY,
  READ_STUDIO_STATE,
  STUDIO_SET_STATE,
  chromiumLaunchArgs,
  requireChromium,
  toPlaywrightKey,
} from "./gameChromium.ts";
import { chromiumChildEnv, serveGameDirectory } from "./gameWebServer.ts";

// Playwright needs its files on disk; createRequire also resolves it from a Node SEA executable.
const playRequire = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () => playRequire("playwright-core") as typeof import("playwright-core");

/** The Jev key lives in the server secret store under this name; bots never see it. */
export const GAME_BOT_JEV_SECRET = "game-bot-jev-api-key";
const GAME_BOT_JEV_BASE_SECRET = "game-bot-jev-base-url";
const JEV_DEFAULT_BASE = "https://api.typesafe.ai";
const JEV_MODEL = "jev-latest";
const JEV_TIMEOUT_MS = 4000;
// The connection to Jev is kept warm across decisions (Aura's design): idle
// past this long, a light call goes out before the next decision needs it.
const JEV_WARM_AFTER_MS = 15_000;
const JEV_WARM_TIMEOUT_MS = 5000;
const RUNNER_OBS_TIMEOUT_MS = 3000;
const RUNNER_MISS_LIMIT = 20;
const CHILD_FIRST_INPUT_MS = 400;
const CHILD_EXTRA_MS = 30;
const BOOT_TIMEOUT_MS = 90_000;

const opError = (
  operation: string,
  path: string,
  reason: GameOperationError["reason"],
  detail?: string,
  cause?: unknown,
): GameOperationError =>
  new GameOperationError({
    operation,
    path,
    reason,
    ...(detail === undefined ? {} : { detail }),
    ...(cause === undefined ? {} : { cause }),
  });

const alive = (pid: number | undefined): boolean => {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A free private X display, preferring above the live-Blender range. */
const pickDisplay = async (): Promise<number | null> => {
  const taken = async (n: number): Promise<boolean> => {
    try {
      await NodeFSP.access(`/tmp/.X${n}-lock`);
      return true;
    } catch {
      /* candidate */
    }
    return new Promise<boolean>((resolve) => {
      const s = NodeNet.connect(6000 + n, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => {
        s.destroy();
        resolve(false);
      });
    });
  };
  const ranges: number[] = [];
  for (let n = 251; n < 350; n++) ranges.push(n);
  for (let n = 119; n < 251; n++) ranges.push(n);
  for (const n of ranges) {
    if (!(await taken(n))) return n;
  }
  return null;
};

const waitDisplay = async (n: number, timeoutMs: number): Promise<boolean> => {
  // Readiness is the server's lock file: this platform's Xvfb build never
  // listens on TCP, so a TCP probe would wait out the whole timeout.
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      await NodeFSP.access(`/tmp/.X${n}-lock`);
      return true;
    } catch {
      /* not yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface LineReader {
  readonly next: (timeoutMs: number) => Promise<string | null>;
  readonly close: () => void;
}

const createLineReader = (stream: NodeJS.ReadableStream): LineReader => {
  const rl = NodeReadline.createInterface({ input: stream, crlfDelay: Infinity });
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  let closed = false;
  rl.on("line", (line: string) => {
    if (waiter !== null) {
      const w = waiter;
      waiter = null;
      w(line);
    } else queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    if (waiter !== null) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });
  return {
    next: (timeoutMs: number) => {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => {
          waiter = null;
          resolve(null);
        }, timeoutMs);
        waiter = (line) => {
          clearTimeout(timer);
          resolve(line);
        };
      });
    },
    close: () => rl.close(),
  };
};

const parseLine = (line: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
};

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asGameState = (value: unknown): Record<string, number | boolean | string | null> => {
  const out: Record<string, number | boolean | string | null> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= 64 || key.length > 64) break;
    if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
    else if (typeof entry === "boolean") out[key] = entry;
    else if (typeof entry === "string") out[key] = entry.slice(0, 256);
    else if (entry === null) out[key] = null;
  }
  return out;
};

const posOf = (obs: Record<string, unknown>): [number, number, number] | null => {
  const probe = obs["probe"] as Record<string, unknown> | null | undefined;
  const player = probe?.["player"] as { x?: unknown; y?: unknown; z?: unknown } | null | undefined;
  if (
    player !== null &&
    player !== undefined &&
    typeof player.x === "number" &&
    typeof player.y === "number" &&
    typeof player.z === "number"
  )
    return [player.x, player.y, player.z];
  return null;
};

const MOVERS = new Set([
  "W",
  "A",
  "S",
  "D",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
]);
const FRACTION_RE = /(\d+)\s*\/\s*(\d+)/g;

export class GameBot extends Context.Service<
  GameBot,
  {
    readonly run: (
      root: string,
      input: GameBotRunInput,
    ) => Effect.Effect<GameBotRunResult, GameOperationError>;
    readonly view: (
      root: string,
      input: GameBotViewInput,
    ) => Effect.Effect<GameBotViewResult, GameOperationError>;
    /** Rebuild the facts-only player report across recorded runs. */
    readonly report: (root: string) => Effect.Effect<GameBotReportResult, GameOperationError>;
    /** Stop one game's live bot session by root; game_stop calls this. */
    readonly stop: (root: string) => Effect.Effect<void>;
  }
>()("kurambit/game/GameBot") {}

interface Session {
  readonly root: string;
  readonly runId: string;
  stopped: boolean;
  readonly pids: number[];
}

interface Session {
  readonly root: string;
  readonly runId: string;
  stopped: boolean;
  readonly pids: number[];
}

interface RunTrace {
  runId: string;
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
  videoPath?: string;
}

/** Newest-first run traces under each builds-logs game-bot run dir (at most 20). */
const listRunTraces = async (
  root: string,
): Promise<Array<{ runId: string; trace: RunTrace; mtime: number }>> => {
  const logs = NodePath.join(root, "builds/logs");
  const entries = await NodeFSP.readdir(logs).catch(() => [] as string[]);
  const out: Array<{ runId: string; trace: RunTrace; mtime: number }> = [];
  for (const entry of entries) {
    if (!entry.startsWith("game-bot-")) continue;
    const tracePath = NodePath.join(logs, entry, "trace.json");
    try {
      const stat = await NodeFSP.stat(tracePath);
      if (!stat.isFile()) continue;
      const trace = JSON.parse(await NodeFSP.readFile(tracePath, "utf8")) as RunTrace;
      if (typeof trace?.runId !== "string") continue;
      out.push({ runId: trace.runId, trace, mtime: stat.mtimeMs });
    } catch {
      // One bad trace never breaks the report.
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 20);
};

const medianOf = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
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
const buildPlayerReport = async (
  root: string,
  wanted: string[] | null,
): Promise<{ rel: string; runs: string[] } | null> => {
  const found = await listRunTraces(root);
  const picked =
    wanted === null || wanted.length === 0
      ? found
      : wanted.flatMap((runId) => {
          const direct = found.find((entry) => entry.runId === runId);
          return direct === undefined ? [] : [direct];
        });
  // Oldest first so the report reads in play order.
  const ordered = [...picked].sort((a, b) => a.mtime - b.mtime);
  if (ordered.length === 0) return null;
  const lines: string[] = [
    "# Player report (facts only, by code)",
    "",
    `Runs: ${ordered.length}. No interpretation: positions, times and counts only.`,
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
      const cx = Math.floor(x / 4) * 4;
      const cz = Math.floor(z / 4) * 4;
      const key = `${cx},${cz}`;
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
  const rel = ".studio/player-report.md";
  try {
    await NodeFSP.mkdir(NodePath.join(root, ".studio"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, rel), `${lines.join("\n")}\n`);
  } catch {
    return null;
  }
  return { rel, runs: ordered.map((entry) => entry.runId) };
};

const make = Effect.gen(function* () {
  const tools = yield* GameToolchain.GameToolchain;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sessions = new Map<string, Session>();
  const runs = new Map<string, { root: string; result: GameBotRunResult }>();

  const killPid = (pid: number | undefined): void => {
    if (!alive(pid)) return;
    try {
      process.kill(pid!, "SIGTERM");
    } catch {
      /* gone */
    }
  };

  const drop = (root: string): void => {
    const session = sessions.get(root);
    if (session === undefined) return;
    sessions.delete(root);
    session.stopped = true;
    for (const pid of session.pids) killPid(pid);
  };

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

  // One warm pool for all Jev decisions is impossible here: the npm
  // undici Agent is version-mismatched with the runtime's global fetch
  // ("invalid onRequestStart"), so decisions use the global fetch pool
  // (per-origin keepalive) plus a light warm call whenever Jev sat idle.
  // At reflex tempo (4-8 asks/s) the pool stays warm through play; only
  // the first call after idle is cold. Warm/cold is tracked per call.
  let jevLastUse = 0;

  /**
   * Jev Choice call, Aura's shape (Apache-2.0; adapted with attribution, code
   * our own): goal, situation, per-option facts, what is running and for how
   * long, recent outcomes, plan standing. Answers carry probabilities; the
   * child applies the switch margin against dithering. Only the service runs
   * this: the key never leaves this closure, and failures fall back to the
   * bot's policy, never an error.
   *
   * Exploration shaping (Aura's "an exploration"): every option's facts
   * carry how many times it was tried and what happened; the state carries
   * what has been visited and tried, where this run stands among its
   * siblings, and whether the player is stuck re-picking one option without
   * moving. An option that arrived or has nothing left is done: the child
   * already stops offering it until the situation changes, and the
   * instructions say the same, so a stuck pick cannot repeat hundreds of
   * times across identical situations.
   */
  const jevPick = async (input: {
    readonly key: string;
    readonly base: string;
    readonly goal: string;
    readonly facts: unknown;
    readonly options: ReadonlyArray<{ name: string; description: string; facts: unknown }>;
    readonly nowDoing: string | null;
    readonly nowDoingFor: number | null;
    readonly recent: ReadonlyArray<{ name: string; ok: boolean }>;
    readonly plan: unknown;
    readonly tried: Readonly<Record<string, { picks: number; ok: number; fail: number }>>;
    readonly coverage: {
      readonly cells4m: number;
      readonly samples: number;
      readonly bbox: string | null;
    } | null;
    readonly run: {
      readonly index: number;
      readonly total: number;
      readonly priorRuns: ReadonlyArray<{
        readonly topOptions: string;
        readonly cells: number;
        readonly ending: string;
      }>;
    } | null;
    readonly stuck: {
      readonly option: string;
      readonly picks: number;
      readonly movedM: number;
    } | null;
  }): Promise<{
    pick: string | null;
    probs: Record<string, number>;
    failure: string | null;
    latencyMs: number;
  }> => {
    const criteria: Record<string, string> = {};
    for (const o of input.options)
      criteria[o.name] = `${o.description} Facts: ${JSON.stringify(o.facts).slice(0, 500)}`;
    const doing =
      input.nowDoing === null
        ? "nothing"
        : `${input.nowDoing}${input.nowDoingFor === null ? "" : ` (for ${input.nowDoingFor.toFixed(1)}s)`}`;
    const triedBit =
      Object.keys(input.tried).length === 0
        ? "nothing tried yet"
        : Object.entries(input.tried)
            .map(
              ([name, entry]) =>
                `${name} tried ${entry.picks} (ok ${entry.ok}, fail ${entry.fail})`,
            )
            .join("; ");
    const stuckBit =
      input.stuck === null
        ? ""
        : ` STUCK: "${input.stuck.option}" was picked ${input.stuck.picks} times in a row while the player moved only ${input.stuck.movedM.toFixed(1)} m: pick something else.`;
    const runBit =
      input.run === null
        ? ""
        : input.run.priorRuns.length === 0
          ? " This is the first run: no earlier coverage."
          : ` Earlier runs covered their own ground, go somewhere they did not: ${input.run.priorRuns
              .map(
                (entry, i) =>
                  `run ${i}: tried ${entry.topOptions}, ${entry.cells} cells, ended ${entry.ending}`,
              )
              .join("; ")
              .slice(0, 800)} (this is run ${input.run.index} of ${input.run.total}).`;
    const body = {
      state:
        `Goal: ${input.goal}. Situation: ${JSON.stringify(input.facts).slice(0, 2000)}. ` +
        `Doing now: ${doing}. Recent: ${JSON.stringify(input.recent.slice(-6))}.` +
        (input.plan === null || input.plan === undefined
          ? ""
          : ` Plan standing: ${JSON.stringify(input.plan).slice(0, 800)}.`) +
        ` Tried: ${triedBit.slice(0, 1200)}.` +
        (input.coverage === null
          ? ""
          : ` Visited: ${input.coverage.cells4m} area cells in ${input.coverage.samples} samples${input.coverage.bbox ?? ""}.`) +
        runBit +
        stuckBit,
      model: JEV_MODEL,
      questions: {
        pick: {
          type: "choice",
          instructions:
            `You are the player. Choose the option to do now that best serves the goal. Let "${input.nowDoing ?? "none"}" finish unless another option is clearly better now.` +
            ` Prefer options with tried 0 or few picks: what has not been tried yet teaches the most. An option that arrived or has nothing left to do is done: do not re-pick it.` +
            ` Don't keep repeating one that keeps failing in the same situation.${stuckBit}` +
            (input.run !== null && input.run.priorRuns.length > 0
              ? " Earlier runs covered their own ground: go somewhere they did not."
              : ""),
          criteria,
        },
      },
    };
    const started = Date.now();
    try {
      const res = await fetch(`${input.base.replace(/\/$/, "")}/v1/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${input.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) return { pick: null, probs: {}, failure: `HTTP ${res.status}`, latencyMs };
      const data = (await res.json()) as {
        answers?: { pick?: { choice?: string; probabilities?: Record<string, number> } };
      };
      const answer = data.answers?.pick ?? null;
      const choice = answer?.choice ?? null;
      const probs: Record<string, number> =
        answer?.probabilities !== null && typeof answer?.probabilities === "object"
          ? (answer.probabilities as Record<string, number>)
          : {};
      if (choice === null || criteria[choice] === undefined)
        return { pick: null, probs: {}, failure: "no usable choice", latencyMs };
      if (probs[choice] === undefined) probs[choice] = 1;
      return { pick: choice, probs, failure: null, latencyMs };
    } catch (error) {
      return {
        pick: null,
        probs: {},
        failure: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
        latencyMs: Date.now() - started,
      };
    }
  };

  // Light call keeping Jev warm and its server awake (best effort: any
  // request warms DNS/TLS/session even when the path 404s).
  const jevWarm = (base: string, key: string): void => {
    void fetch(`${base.replace(/\/$/, "")}/v1/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(JEV_WARM_TIMEOUT_MS),
    }).then(
      () => undefined,
      () => undefined,
    );
  };

  const isGameOperationError = Schema.is(GameOperationError);

  interface ExecuteArgs {
    readonly root: string;
    readonly runId: string;
    readonly runDir: string;
    readonly scriptPath: string;
    readonly requestPath: string;
    readonly childPath: string;
    readonly videoPath: string;
    readonly tracePath: string;
    readonly botFile: string;
    readonly decider: "policy" | "jev";
    readonly mode: GameBotMode;
    readonly jevLive: boolean;
    readonly seconds: number;
    readonly token: string;
    readonly isolation: NativeUserIsolation;
    readonly viewport: { width: number; height: number };
    readonly godotPath: string;
    readonly projectDir: string;
    readonly ffmpeg: string;
    readonly xvfb: string;
    readonly jevKey: string | null;
    readonly jevBase: string;
    readonly policyNote: string | null;
    readonly session: Session;
    readonly signal: AbortSignal | undefined;
    /** Where this run stands among its siblings, so runs differ. */
    readonly runIndex: number;
    readonly runTotal: number;
    readonly seed: number;
    readonly priorRuns: ReadonlyArray<{
      readonly topOptions: string;
      readonly cells: number;
      readonly ending: string;
    }>;
  }

  /**
   * One real-time run: private Xvfb display, Godot unpaused at normal speed,
   * one continuous ffmpeg x11grab, a 10 Hz controller loop bridging the game
   * and the bot child. Per-tick screenshots never happen (that capped T20 at
   * ~1 Hz); the video is the picture and frames are extracted afterwards.
   */
  const executeRun = async (args: ExecuteArgs): Promise<GameBotRunResult> => {
    const stopped = (): boolean => args.session.stopped || args.signal?.aborted === true;
    let godotChild: NodeChildProcess.ChildProcess | undefined;
    let ffmpegChild: NodeChildProcess.ChildProcess | undefined;
    let botChild: NodeChildProcess.ChildProcess | undefined;
    let xvfbChild: NodeChildProcess.ChildProcess | undefined;
    const runner: { socket: NodeNet.Socket | null } = { socket: null };
    const readers: LineReader[] = [];
    const server: NodeNet.Server = NodeNet.createServer();
    const track = (child: NodeChildProcess.ChildProcess | undefined): void => {
      if (child?.pid !== undefined) args.session.pids.push(child.pid);
    };
    const killAll = (): void => {
      for (const pid of args.session.pids) killPid(pid);
      for (const child of [godotChild, botChild, xvfbChild]) {
        try {
          child?.kill("SIGTERM");
        } catch {
          /* gone */
        }
      }
      try {
        // SIGINT lets ffmpeg finalize the mp4; anything else just dies.
        if (ffmpegChild !== undefined && ffmpegChild.exitCode === null) ffmpegChild.kill("SIGINT");
      } catch {
        /* gone */
      }
    };
    const waitExit = async (
      child: NodeChildProcess.ChildProcess | undefined,
      ms: number,
    ): Promise<void> => {
      if (child === undefined || child.exitCode !== null) return;
      const end = Date.now() + ms;
      while (child.exitCode === null && Date.now() < end) await sleep(100);
      if (child.exitCode === null) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* gone */
        }
        const end2 = Date.now() + 2000;
        while (child.exitCode === null && Date.now() < end2) await sleep(100);
        if (child.exitCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* gone */
          }
        }
      }
    };
    try {
      if (stopped()) throw new Error("Bot run stopped.");
      const display = await pickDisplay();
      if (display === null) throw new Error("No free private X display.");
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const port = (server.address() as NodeNet.AddressInfo).port;
      server.on("connection", (sock) => {
        if (runner.socket !== null) {
          sock.destroy();
          return;
        }
        runner.socket = sock;
      });
      await NodeFSP.writeFile(
        args.requestPath,
        JSON.stringify({
          port,
          token: args.token,
          bootScreenshotPath: null,
          expectedUserDataPrefix: args.isolation.dataDir,
        }),
      );
      const displayEnv = { ...nativeChildEnv(args.isolation), DISPLAY: `:${display}` };
      xvfbChild = NodeChildProcess.spawn(
        args.xvfb,
        [`:${display}`, "-screen", "0", `${args.viewport.width}x${args.viewport.height}x24`],
        { env: displayEnv, detached: true, stdio: "ignore" },
      );
      xvfbChild.unref();
      track(xvfbChild);
      if (!(await waitDisplay(display, 15_000)))
        throw new Error("The private display did not start.");
      const ffmpegLog = NodeFS.openSync(NodePath.join(args.runDir, "ffmpeg.log"), "w");
      ffmpegChild = NodeChildProcess.spawn(
        args.ffmpeg,
        [
          "-y",
          "-f",
          "x11grab",
          "-video_size",
          `${args.viewport.width}x${args.viewport.height}`,
          "-framerate",
          "12",
          "-i",
          `:${display}`,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-pix_fmt",
          "yuv420p",
          args.videoPath,
        ],
        {
          env: displayEnv,
          detached: false,
          stdio: ["ignore", ffmpegLog, ffmpegLog],
        },
      );
      track(ffmpegChild);
      const godotLog = NodeFS.openSync(NodePath.join(args.runDir, "godot.log"), "w");
      godotChild = NodeChildProcess.spawn(
        args.godotPath,
        [
          ...nativeGodotArgs({
            projectDir: args.projectDir,
            scriptPath: args.scriptPath,
            requestPath: args.requestPath,
            width: args.viewport.width,
            height: args.viewport.height,
            hasDisplay: true,
          }),
        ],
        {
          env: displayEnv,
          cwd: args.projectDir,
          detached: true,
          stdio: ["ignore", godotLog, godotLog],
        },
      );
      godotChild.unref();
      track(godotChild);
      const waitSocket = async (): Promise<NodeNet.Socket> => {
        const end = Date.now() + BOOT_TIMEOUT_MS;
        while (Date.now() < end) {
          if (runner.socket !== null) return runner.socket;
          if (stopped()) throw new Error("Bot run stopped.");
          await sleep(50);
        }
        throw new Error("The bot runner never connected.");
      };
      const socket = await waitSocket();
      const runnerLines = createLineReader(socket);
      readers.push(runnerLines);
      let hello: Record<string, unknown> | null = null;
      const bootEnd = Date.now() + BOOT_TIMEOUT_MS;
      while (Date.now() < bootEnd) {
        if (stopped()) throw new Error("Bot run stopped.");
        const line = await runnerLines.next(Math.min(2000, Math.max(100, bootEnd - Date.now())));
        if (line === null) continue;
        const parsed = parseLine(line.trim());
        if (parsed === null) continue;
        if (typeof parsed["error"] === "string") throw new Error(parsed["error"] as string);
        if (parsed["token"] === args.token && parsed["boot"] === true) {
          hello = parsed;
          break;
        }
      }
      if (hello === null) throw new Error("The bot runner did not boot in 90s.");
      // The bot child: allowlisted environment only, so no key or display
      // route can reach it. Game data reaches it only through our messages.
      const childLog = NodeFS.openSync(NodePath.join(args.runDir, "child-stderr.log"), "w");
      botChild = NodeChildProcess.spawn(
        process.execPath,
        [
          args.childPath,
          args.botFile,
          args.decider,
          args.mode,
          args.jevLive ? "jev-live" : "no-jev",
        ],
        {
          env: {
            PATH: process.env.PATH ?? "",
            ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
            NODE_OPTIONS: "--max-old-space-size=1536",
            HOME: NodeOS.homedir(),
            LANG: process.env.LANG ?? "C.UTF-8",
          },
          cwd: args.root,
          detached: false,
          stdio: ["pipe", "pipe", childLog],
        },
      );
      track(botChild);
      const childLines = createLineReader(botChild.stdout!);
      readers.push(childLines);
      let goal = "play the game";
      let childDone: { state: string; note: string; evidence: unknown } | null = null;
      const firstLine = await childLines.next(10_000);
      const first = firstLine === null ? null : parseLine(firstLine);
      if (first !== null && first["op"] === "hello" && typeof first["goal"] === "string")
        goal = (first["goal"] as string).slice(0, 500);
      else if (first !== null && first["op"] === "status")
        childDone = {
          state: String(first["state"] ?? "error"),
          note: String(first["note"] ?? "").slice(0, 500),
          evidence: first["evidence"] ?? {},
        };
      let childGone = false;
      botChild.on("exit", () => {
        childGone = true;
      });
      const findings: GameBotFinding[] = [];
      const seen = new Set<string>();
      const picks: Array<{ t: number; name: string; via: string; randomized: boolean }> = [];
      const offered: Array<{ t: number; options: string[] }> = [];
      const setStates: Array<{ t: number; target: string; values: unknown }> = [];
      const samples: Array<{ t: number; pos: [number, number, number] | null; state: unknown }> =
        [];
      const jevLog: Array<{ t: number; failure: string }> = [];
      const jevLatencies: Array<{ ms: number; warm: boolean }> = [];
      let jevCalls = 0;
      let jevFailures = 0;
      let jevDecisions2Plus = 0;
      let decisions = 0;
      let ticks = 0;
      let misses = 0;
      let lastObsWall = Date.now();
      let lastT = 0;
      let lastPos: [number, number, number] | null = null;
      let lastGameState: Record<string, number | boolean | string | null> = {};
      let fallStart: number | null = null;
      let overlapStreak = 0;
      let moveWindow: Array<{ wall: number; pos: [number, number, number] }> = [];
      let noMoveReported = false;
      let lastHeld: string[] = [];
      // Stuck watch (service side, positions only): the last picks with the
      // player position at pick time. Six same-name picks inside a metre
      // means the choice is not moving play, whatever Jev hoped.
      const pickTrail: Array<{ name: string; pos: [number, number, number] | null }> = [];
      const stuckOf = (): {
        readonly option: string;
        readonly picks: number;
        readonly movedM: number;
      } | null => {
        if (pickTrail.length < 6) return null;
        const tail = pickTrail.slice(-6);
        const name = tail[0]!.name;
        if (!tail.every((entry) => entry.name === name)) return null;
        const base = tail[0]!.pos;
        if (base === null) return null;
        let moved = 0;
        for (const entry of tail) {
          if (entry.pos === null) return null;
          moved = Math.max(
            moved,
            Math.hypot(entry.pos[0] - base[0], entry.pos[1] - base[1], entry.pos[2] - base[2]),
          );
        }
        if (moved >= 1) return null;
        return { option: name, picks: tail.length, movedM: moved };
      };
      // Visited-area coverage (service side): 4 m cells over x/z plus the
      // bounding box, from the same samples the report uses.
      const coverageOf = (): {
        readonly cells4m: number;
        readonly samples: number;
        readonly bbox: string | null;
      } => {
        const cells = new Set<string>();
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const sample of samples) {
          if (sample.pos === null) continue;
          const [x, , z] = sample.pos;
          if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minZ = Math.min(minZ, z);
          maxZ = Math.max(maxZ, z);
          cells.add(`${Math.floor(x / 4) * 4},${Math.floor(z / 4) * 4}`);
        }
        return {
          cells4m: cells.size,
          samples: samples.length,
          bbox:
            cells.size === 0
              ? null
              : ` (x ${minX.toFixed(1)}..${maxX.toFixed(1)}, z ${minZ.toFixed(1)}..${maxZ.toFixed(1)})`,
        };
      };
      const wallStart = Date.now();
      const budgetMs = args.seconds * 1000;
      const addFinding = (
        detector: string,
        severity: string,
        summary: string,
        t: number,
        pos: [number, number, number] | null,
        detail: string,
      ): void => {
        const sig = `${detector}:${summary.slice(0, 120)}`;
        if (seen.has(sig) || findings.length >= GAME_BOT_BOUNDS.maxFindings) return;
        seen.add(sig);
        findings.push({ detector, severity, summary, t, pos, detail: detail.slice(0, 400) });
      };
      const writeChild = (msg: Record<string, unknown>): void => {
        try {
          botChild?.stdin?.write(`${JSON.stringify(msg)}\n`);
        } catch {
          /* closed */
        }
      };
      const writeRunner = (msg: Record<string, unknown>): void => {
        try {
          runner.socket?.write(`${JSON.stringify(msg)}\n`);
        } catch {
          /* closed */
        }
      };
      let setStateId = 0;
      let inputId = 0;
      while (!stopped()) {
        if (childDone !== null || childGone) break;
        if (Date.now() - wallStart > budgetMs) break;
        const raw = await runnerLines.next(RUNNER_OBS_TIMEOUT_MS);
        if (raw === null) {
          misses += 1;
          if (misses > RUNNER_MISS_LIMIT) throw new Error("The game stopped answering mid-run.");
          continue;
        }
        const msg = parseLine(raw.trim());
        if (msg === null || typeof msg["tick"] !== "number") continue;
        misses = 0;
        ticks += 1;
        const wallNow = Date.now();
        const gap = wallNow - lastObsWall;
        const t = asNumber(msg["t"]) ?? lastT;
        lastT = t;
        const pos = posOf(msg);
        if (pos !== null) lastPos = pos;
        const gameState = asGameState(
          (msg["probe"] as Record<string, unknown> | undefined)?.["gameState"],
        );
        if (Object.keys(gameState).length > 0) lastGameState = gameState;
        // Detectors, adapted from the Aura in-game checks (Apache-2.0) plus
        // the sweep's movement/hitch probes; the code here is our own.
        if (gap > 1500 && ticks > 2)
          addFinding(
            "hitch",
            "warning",
            `No tick for ${(gap / 1000).toFixed(1)}s wall`,
            t,
            pos,
            "",
          );
        lastObsWall = wallNow;
        for (const entry of (msg["errors"] as Array<{ message: string; where: string }>) ?? []) {
          if (typeof entry?.message !== "string") continue;
          const category = /script|parse/i.test(`${entry.message} ${entry.where ?? ""}`)
            ? "Script"
            : "Engine";
          addFinding(
            "log_error",
            "error",
            `${category} error: ${entry.message.slice(0, 160)}`,
            t,
            pos,
            String(entry.where ?? ""),
          );
        }
        if (pos !== null) {
          if (
            Math.abs(pos[0]) > 2000 ||
            Math.abs(pos[1]) > 2000 ||
            Math.abs(pos[2]) > 2000 ||
            pos[1] < -50
          )
            addFinding(
              "out_of_world",
              "error",
              `Player out of world at (${pos[0].toFixed(0)}, ${pos[1].toFixed(0)}, ${pos[2].toFixed(0)})`,
              t,
              pos,
              "",
            );
        }
        const body = msg["body"] as Record<string, unknown> | null | undefined;
        if (body !== null && body !== undefined && typeof body === "object") {
          const vy = asNumber(body["vy"]);
          if (body["onGround"] === false && vy !== null && vy < -1) {
            if (fallStart === null) fallStart = t;
            else if (t - fallStart >= 6)
              addFinding("long_fall", "error", "Player kept falling for 6s", t, pos, "");
          } else fallStart = null;
        } else fallStart = null;
        const sweep = msg["sweep"] as { overlaps?: unknown; overlapNames?: unknown } | null;
        if (sweep !== null && typeof sweep === "object" && typeof sweep.overlaps === "number") {
          if (sweep.overlaps > 0) {
            overlapStreak += 1;
            if (overlapStreak === 2)
              addFinding(
                "overlap",
                "error",
                `Player overlapping solid geometry (${sweep.overlaps} at ${String(sweep.overlapNames ?? "").slice(0, 120)})`,
                t,
                pos,
                "",
              );
          } else overlapStreak = 0;
        }
        if (pos !== null) {
          moveWindow.push({ wall: wallNow, pos });
          moveWindow = moveWindow.filter((entry) => wallNow - entry.wall < 2000);
          const moving = lastHeld.some((key) => MOVERS.has(key));
          if (moving && !noMoveReported && moveWindow.length >= 2) {
            const first = moveWindow[0]!.pos;
            const dist = Math.hypot(pos[0] - first[0], pos[1] - first[1], pos[2] - first[2]);
            if (wallNow - moveWindow[0]!.wall >= 1900 && dist < 0.3) {
              noMoveReported = true;
              addFinding(
                "no_move",
                "warning",
                `Holding ${lastHeld
                  .filter((key) => MOVERS.has(key))
                  .slice(0, 3)
                  .join("+")} 2s moved nobody (${dist.toFixed(1)}m)`,
                t,
                pos,
                "",
              );
            }
          }
          if (!moving) moveWindow = [];
        }
        const hudText = (msg["probe"] as Record<string, unknown> | undefined)?.["hudText"];
        if (typeof hudText === "string" && hudText !== "") {
          for (const match of hudText.matchAll(new RegExp(FRACTION_RE, "g"))) {
            const a = Number(match[1]);
            const b = Number(match[2]);
            if (b > 0 && a > b)
              addFinding(
                "hud_fraction",
                "error",
                `HUD shows ${a}/${b}: more than its stated maximum`,
                t,
                pos,
                match[0].slice(0, 120),
              );
          }
        }
        if (ticks % 10 === 1) {
          samples.push({
            t,
            pos,
            state: typeof gameState["state"] === "string" ? gameState["state"] : null,
          });
        }
        writeChild({
          op: "obs",
          tick: ticks,
          t,
          observation: msg,
          runContext: {
            seed: args.seed,
            runIndex: args.runIndex,
            runTotal: args.runTotal,
            priorRuns: args.priorRuns,
          },
        });
        // The child answers each tick with its inputs; decide/picked/status
        // ride the same stream and are handled here, never blocking play.
        let answer: {
          held: string[];
          taps: string[];
          clicks: unknown[];
          setStates: unknown[];
        } | null = null;
        for (let i = 0; i < 8; i++) {
          const line = await childLines.next(i === 0 ? CHILD_FIRST_INPUT_MS : CHILD_EXTRA_MS);
          if (line === null) break;
          const childMsg = parseLine(line);
          if (childMsg === null) continue;
          if (childMsg["op"] === "input") {
            answer = {
              held: Array.isArray(childMsg["held"])
                ? (childMsg["held"] as unknown[]).map(String).slice(0, 8)
                : [],
              taps: Array.isArray(childMsg["taps"])
                ? (childMsg["taps"] as unknown[]).map(String).slice(0, 8)
                : [],
              clicks: Array.isArray(childMsg["clicks"]) ? (childMsg["clicks"] as unknown[]) : [],
              setStates: Array.isArray(childMsg["setStates"])
                ? (childMsg["setStates"] as unknown[])
                : [],
            };
          } else if (childMsg["op"] === "decide") {
            if (args.decider === "jev" && args.jevKey !== null) {
              jevCalls += 1;
              const id = childMsg["id"];
              const decideOpts =
                (childMsg["options"] as Array<{
                  name: string;
                  description: string;
                  facts: unknown;
                }>) ?? [];
              const decideFacts = childMsg["facts"] ?? null;
              // The child's own per-option tried counts (picks, ok, fail),
              // tracked for every run even when the bot tracks nothing.
              const decideTried =
                (childMsg["tried"] as Record<
                  string,
                  { picks: number; ok: number; fail: number }
                >) ?? {};
              const decideNow =
                typeof childMsg["nowDoing"] === "string" ? (childMsg["nowDoing"] as string) : null;
              const decideFor =
                typeof childMsg["nowDoingFor"] === "number"
                  ? (childMsg["nowDoingFor"] as number)
                  : null;
              const decideRecent =
                (childMsg["recent"] as Array<{ name: string; ok: boolean }>) ?? [];
              const decidePlan = childMsg["plan"] ?? null;
              // What the bot offered, whether or not Jev was asked: the
              // player report needs offered-but-never-picked options too.
              try {
                const names = (decideOpts as Array<{ name?: unknown }>)
                  .map((o) => String(o?.name ?? ""))
                  .filter((name) => name !== "");
                if (names.length > 0) offered.push({ t, options: names.slice(0, 20) });
              } catch {
                /* offered is best effort */
              }
              // Re-warm when Jev sat idle: the next decision must not wait
              // on a new connection.
              const warm = Date.now() - jevLastUse < JEV_WARM_AFTER_MS;
              if (!warm) jevWarm(args.jevBase, args.jevKey);
              jevLastUse = Date.now();
              void (async () => {
                // Each option's facts carry how many times it was tried and
                // what happened, on top of whatever the bot put there; the
                // state carries what has been visited and tried, where this
                // run stands, and whether one pick is stuck without moving.
                const enriched = decideOpts.map((o) => {
                  const name = String(o.name);
                  const tried =
                    (decideTried as Record<string, unknown>)[name] !== undefined
                      ? (decideTried as Record<string, unknown>)[name]
                      : { picks: 0, ok: 0, fail: 0 };
                  const base =
                    o.facts !== null && typeof o.facts === "object" && !Array.isArray(o.facts)
                      ? (o.facts as Record<string, unknown>)
                      : {};
                  return {
                    name,
                    description: String(o.description ?? ""),
                    facts: { ...base, tried },
                  };
                });
                const { pick, probs, failure, latencyMs } = await jevPick({
                  key: args.jevKey!,
                  base: args.jevBase,
                  goal,
                  facts: decideFacts,
                  options: enriched,
                  nowDoing: decideNow,
                  nowDoingFor: decideFor,
                  recent: decideRecent,
                  plan: decidePlan,
                  tried: decideTried as Record<string, { picks: number; ok: number; fail: number }>,
                  coverage: coverageOf(),
                  run:
                    args.runTotal > 1
                      ? { index: args.runIndex, total: args.runTotal, priorRuns: args.priorRuns }
                      : null,
                  stuck: stuckOf(),
                });
                jevLatencies.push({ ms: latencyMs, warm });
                if (pick === null) {
                  jevFailures += 1;
                  jevLog.push({ t, failure: failure ?? "unknown" });
                }
                writeChild({ op: "decision", id, pick, probs });
              })();
            } else {
              writeChild({ op: "decision", id: childMsg["id"], pick: null, probs: {} });
            }
          } else if (childMsg["op"] === "picked") {
            decisions += 1;
            const via = String(childMsg["via"] ?? "");
            const twoPlus = childMsg["twoPlus"] === true;
            if (via === "jev" && twoPlus) jevDecisions2Plus += 1;
            const pickedName = String(childMsg["name"] ?? "");
            pickTrail.push({ name: pickedName, pos });
            if (pickTrail.length > 12) pickTrail.shift();
            picks.push({
              t,
              name: pickedName,
              via,
              randomized: childMsg["randomized"] === true,
            });
          } else if (childMsg["op"] === "status") {
            childDone = {
              state: String(childMsg["state"] ?? "error"),
              note: String(childMsg["note"] ?? "").slice(0, 500),
              evidence: childMsg["evidence"] ?? {},
            };
          }
        }
        if (answer === null) answer = { held: lastHeld, taps: [], clicks: [], setStates: [] };
        lastHeld = [...answer.held];
        for (const entry of answer.setStates) {
          const spec = entry as { target?: unknown; values?: unknown };
          if (typeof spec?.target !== "string") continue;
          setStateId += 1;
          setStates.push({ t, target: spec.target, values: spec.values ?? null });
          writeRunner({
            op: "setState",
            id: setStateId,
            target: spec.target,
            values: spec.values ?? {},
          });
        }
        inputId += 1;
        writeRunner({
          op: "input",
          id: inputId,
          held: answer.held,
          taps: answer.taps,
          clicks: answer.clicks,
        });
      }
      const wallSeconds = Math.max(0.1, (Date.now() - wallStart) / 1000);
      const tickHz = ticks / wallSeconds;
      const gameSeconds = lastT;
      const timeRatio = gameSeconds / wallSeconds;
      const status = childDone ?? {
        state: stopped() ? "error" : "budget",
        note: stopped() ? "The run was stopped." : `Wall budget of ${args.seconds}s ended.`,
        evidence: {},
      };
      writeRunner({ op: "quit", id: 0 });
      await sleep(500);
      try {
        if (ffmpegChild !== undefined && ffmpegChild.exitCode === null) ffmpegChild.kill("SIGINT");
      } catch {
        /* gone */
      }
      await waitExit(ffmpegChild, 15_000);
      // Every private-display child ends with the run: the bot child's
      // stdin pipe closes so its read loop exits on its own, and the
      // tracked pids (runner, display, bot) get a SIGTERM backstop so one
      // call that makes many runs cannot leak a process per run.
      try {
        botChild?.stdin?.end();
      } catch {
        /* closed */
      }
      killAll();
      await waitExit(botChild, 3000);
      await waitExit(xvfbChild, 3000);
      const usedSetState = setStates.length > 0;
      const frames = await extractRunFrames(args.ffmpeg, args.videoPath, args.runDir);
      const frozen = await frozenScreenFinding(frames, lastT, lastPos);
      const allFindings = frozen === null ? findings : [...findings, frozen];
      const median = (xs: number[]): number | null => {
        if (xs.length === 0) return null;
        const sorted = [...xs].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)]!;
      };
      const jevUsage =
        args.decider === "jev" && args.jevKey !== null
          ? {
              calls: jevCalls,
              failures: jevFailures,
              medianMs: median(jevLatencies.map((entry) => entry.ms)),
              warmMedianMs: median(
                jevLatencies.filter((entry) => entry.warm).map((entry) => entry.ms),
              ),
              decisions2Plus: jevDecisions2Plus,
              valid: jevDecisions2Plus >= 3,
            }
          : null;
      const trace = {
        runId: args.runId,
        file: NodePath.relative(args.root, args.botFile),
        decider: args.decider,
        mode: args.mode,
        goal,
        ticks,
        tickHz: Number(tickHz.toFixed(2)),
        timeRatio: Number(timeRatio.toFixed(3)),
        gameSeconds: Number(gameSeconds.toFixed(2)),
        wallSeconds: Number(wallSeconds.toFixed(1)),
        decisions,
        jev: jevUsage,
        jevLog: jevLog.slice(0, 20),
        policyNote: args.decider === "jev" && args.jevKey === null ? args.policyNote : null,
        usedSetState,
        setStates,
        picks,
        offered: offered.slice(0, 400),
        status,
        findings: allFindings,
        samples,
        finalPos: lastPos,
        finalState: lastGameState,
      };
      await NodeFSP.writeFile(args.tracePath, JSON.stringify(trace, null, 2));
      await NodeFSP.writeFile(
        NodePath.join(args.runDir, "summary.json"),
        JSON.stringify({ ...trace, samples: trace.samples.length }, null, 2),
      );
      const jev: GameBotRunResult["jev"] = trace.jev;
      const jevLine =
        jev === null
          ? ""
          : `, Jev ${jev.calls} calls/${jev.failures} failed` +
            `, latency median ${jev.medianMs ?? "?"}ms${jev.warmMedianMs === null || jev.warmMedianMs === undefined ? "" : ` (${jev.warmMedianMs}ms warm)`}` +
            `, ${jev.decisions2Plus ?? 0} decisions among 2+ options` +
            (jev.valid === true ? "" : " (NOT a valid Jev run: fewer than 3)");
      const message =
        `Bot "${trace.file}" (${args.decider}): ${status.state} — ${status.note}. ` +
        `${ticks} ticks at ${tickHz.toFixed(1)} Hz, game/wall ${timeRatio.toFixed(2)}. ` +
        `${decisions} decisions` +
        jevLine +
        (trace.policyNote !== null ? `. ${trace.policyNote}` : "") +
        `. ${allFindings.length} finding(s). ` +
        (usedSetState ? "Used explicit set-state writes (not pure play)." : "Pure input play.") +
        ` Video: ${args.videoPath}`;
      return {
        runId: args.runId,
        goal,
        status: { state: status.state, note: status.note },
        ticks,
        tickHz: Number(tickHz.toFixed(2)),
        timeRatio: Number(timeRatio.toFixed(3)),
        gameSeconds: Number(gameSeconds.toFixed(2)),
        decisions,
        jev,
        policyNote: trace.policyNote,
        usedSetState,
        findings: allFindings,
        finalState: lastGameState,
        finalPos: lastPos,
        mode: args.mode,
        runIds: [args.runId],
        reportPath: null,
        tracePath: args.tracePath,
        videoPath: args.videoPath,
        frames,
        message,
      };
    } catch (error) {
      killAll();
      throw error;
    } finally {
      for (const reader of readers) reader.close();
      try {
        runner.socket?.destroy();
      } catch {
        /* closed */
      }
      await new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  };

  /** Frames for the result: one still every 5 wall seconds, at most 8 spread over the run. */
  const extractRunFrames = async (
    ffmpeg: string,
    videoPath: string,
    runDir: string,
  ): Promise<string[]> => {
    const present = await NodeFSP.stat(videoPath)
      .then((stat) => stat.isFile() && stat.size > 4096)
      .catch(() => false);
    if (!present) return [];
    const framesDir = NodePath.join(runDir, "frames");
    await NodeFSP.mkdir(framesDir, { recursive: true });
    await new Promise<void>((resolve) => {
      const child = NodeChildProcess.spawn(
        ffmpeg,
        ["-y", "-i", videoPath, "-vf", "fps=1/5", NodePath.join(framesDir, "frame-%03d.png")],
        {
          env: headlessEnv(),
          stdio: "ignore",
        },
      );
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
        resolve();
      }, 120_000).unref?.();
    });
    const files = await NodeFSP.readdir(framesDir).catch(() => [] as string[]);
    const pngs = files
      .filter((file) => file.endsWith(".png"))
      .sort()
      .map((file) => NodePath.join(framesDir, file));
    if (pngs.length === 0) return [];
    if (pngs.length <= GAME_BOT_BOUNDS.maxFrames) return pngs;
    const picked: string[] = [];
    for (let i = 0; i < GAME_BOT_BOUNDS.maxFrames; i++) {
      const index = Math.min(
        pngs.length - 1,
        Math.floor(((i + 0.5) * pngs.length) / GAME_BOT_BOUNDS.maxFrames),
      );
      picked.push(pngs[index]!);
    }
    return [...new Set(picked)];
  };

  /** Stills extraction runs fixed ffmpeg args on already-written video: allowlisted engine base only. */
  const headlessEnv = (): NodeJS.ProcessEnv => engineChildEnv();

  /** The frozen-screen probe runs on the extracted frames, never per tick. */
  const frozenScreenFinding = async (
    frames: string[],
    t: number,
    pos: [number, number, number] | null,
  ): Promise<GameBotFinding | null> => {
    if (frames.length < 3) return null;
    const hashes = new Set<string>();
    for (const frame of frames) {
      try {
        const bytes = await NodeFSP.readFile(frame);
        hashes.add(NodeCrypto.createHash("sha1").update(bytes).digest("hex"));
      } catch {
        return null;
      }
    }
    if (hashes.size > 1) return null;
    return {
      detector: "frozen",
      severity: "error",
      summary: "Screen unchanged across the run video while inputs ran",
      t,
      pos,
      detail: `${frames.length} extracted frames identical`,
    };
  };

  interface WebExecuteArgs {
    readonly root: string;
    readonly runId: string;
    readonly runDir: string;
    readonly childPath: string;
    readonly videoPath: string;
    readonly tracePath: string;
    readonly botFile: string;
    readonly decider: "policy" | "jev";
    readonly mode: GameBotMode;
    readonly jevLive: boolean;
    readonly seconds: number;
    readonly projectDir: string;
    readonly chrome: string;
    readonly ffmpeg: string;
    readonly jevKey: string | null;
    readonly jevBase: string;
    readonly policyNote: string | null;
    readonly session: Session;
    readonly signal: AbortSignal | undefined;
    /** Where this run stands among its siblings, so runs differ. */
    readonly runIndex: number;
    readonly runTotal: number;
    readonly seed: number;
    readonly priorRuns: ReadonlyArray<{
      readonly topOptions: string;
      readonly cells: number;
      readonly ending: string;
    }>;
  }

  /**
   * One real-time web run: headless Chromium on the served static folder at
   * normal speed, screenshots stitched into the run video with ffmpeg, the
   * same bot child protocol as the native runner. Web games have no physics
   * sweep or velocity probe, so the overlap and long-fall detectors do not
   * apply; id-clicks have no control tree to land on and are counted, not
   * applied. Explicit set-state writes ride the game's own
   * `window.__studio.setState`.
   */
  const executeWebRun = async (args: WebExecuteArgs): Promise<GameBotRunResult> => {
    const stopped = (): boolean => args.session.stopped || args.signal?.aborted === true;
    let browser: { close: () => Promise<void> } | null = null;
    let botChild: NodeChildProcess.ChildProcess | undefined;
    const track = (child: NodeChildProcess.ChildProcess | undefined): void => {
      if (child?.pid !== undefined) args.session.pids.push(child.pid);
    };
    const killAll = (): void => {
      for (const pid of args.session.pids) killPid(pid);
      try {
        botChild?.kill("SIGTERM");
      } catch {
        /* gone */
      }
    };
    const waitExit = async (
      child: NodeChildProcess.ChildProcess | undefined,
      ms: number,
    ): Promise<void> => {
      if (child === undefined || child.exitCode !== null) return;
      const end = Date.now() + ms;
      while (child.exitCode === null && Date.now() < end) await sleep(100);
      if (child.exitCode === null) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* gone */
        }
      }
    };
    let serve: { url: string; close: () => Promise<void> } | null = null;
    const readers: LineReader[] = [];
    try {
      if (stopped()) throw new Error("Bot run stopped.");
      serve = await serveGameDirectory(
        args.root,
        NodePath.relative(args.root, args.projectDir) || ".",
      );
      const origin = new URL(serve.url).origin;
      const { chromium } = loadPlaywright();
      const launched = await chromium.launch({
        executablePath: args.chrome,
        headless: true,
        args: [...chromiumLaunchArgs()],
        env: chromiumChildEnv(),
      });
      browser = launched;
      const page = await launched.newPage({
        viewport: { width: THREE_VIEWPORT.width, height: THREE_VIEWPORT.height },
      });
      const pageErrors: Array<{ message: string; stack?: string | undefined }> = [];
      page.on("pageerror", (error) => {
        if (pageErrors.length < 100)
          pageErrors.push({
            message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            stack: error instanceof Error ? error.stack : undefined,
          });
      });
      page.on("console", (message) => {
        if (message.type() !== "error" || pageErrors.length >= 100) return;
        pageErrors.push({ message: message.text().slice(0, 500) });
      });
      await page.goto(serve.url, { timeout: BOOT_TIMEOUT_MS, waitUntil: "load" });
      const bootEnd = Date.now() + BOOT_TIMEOUT_MS;
      let booted = false;
      while (Date.now() < bootEnd) {
        if (stopped()) throw new Error("Bot run stopped.");
        try {
          if ((await page.evaluate(READ_STUDIO_READY)) === true) {
            booted = true;
            break;
          }
        } catch {
          /* navigation race; keep polling */
        }
        await sleep(500);
      }
      if (!booted) throw new Error("The three.js page never reported ready in 90s.");
      const framesDir = NodePath.join(args.runDir, "frames");
      await NodeFSP.mkdir(framesDir, { recursive: true });
      const childLog = NodeFS.openSync(NodePath.join(args.runDir, "child-stderr.log"), "w");
      botChild = NodeChildProcess.spawn(
        process.execPath,
        [
          args.childPath,
          args.botFile,
          args.decider,
          args.mode,
          args.jevLive ? "jev-live" : "no-jev",
        ],
        {
          env: {
            PATH: process.env.PATH ?? "",
            ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
            NODE_OPTIONS: "--max-old-space-size=1536",
            HOME: NodeOS.homedir(),
            LANG: process.env.LANG ?? "C.UTF-8",
          },
          cwd: args.root,
          detached: false,
          stdio: ["pipe", "pipe", childLog],
        },
      );
      track(botChild);
      const childLines = createLineReader(botChild.stdout!);
      readers.push(childLines);
      let goal = "play the game";
      let childDone: { state: string; note: string; evidence: unknown } | null = null;
      const firstLine = await childLines.next(10_000);
      const first = firstLine === null ? null : parseLine(firstLine);
      if (first !== null && first["op"] === "hello" && typeof first["goal"] === "string")
        goal = (first["goal"] as string).slice(0, 500);
      else if (first !== null && first["op"] === "status")
        childDone = {
          state: String(first["state"] ?? "error"),
          note: String(first["note"] ?? "").slice(0, 500),
          evidence: first["evidence"] ?? {},
        };
      let childGone = false;
      botChild.on("exit", () => {
        childGone = true;
      });
      const findings: GameBotFinding[] = [];
      const seen = new Set<string>();
      const picks: Array<{ t: number; name: string; via: string; randomized: boolean }> = [];
      const offered: Array<{ t: number; options: string[] }> = [];
      const setStates: Array<{ t: number; target: string; values: unknown }> = [];
      const samples: Array<{ t: number; pos: [number, number, number] | null; state: unknown }> =
        [];
      const jevLog: Array<{ t: number; failure: string }> = [];
      const jevLatencies: Array<{ ms: number; warm: boolean }> = [];
      let jevCalls = 0;
      let jevFailures = 0;
      let jevDecisions2Plus = 0;
      let decisions = 0;
      let ticks = 0;
      let misses = 0;
      let lastT = 0;
      let lastPos: [number, number, number] | null = null;
      let lastGameState: Record<string, number | boolean | string | null> = {};
      let moveWindow: Array<{ wall: number; pos: [number, number, number] }> = [];
      let noMoveReported = false;
      const browserHeld = new Set<string>();
      let skippedIdClicks = 0;
      let shotIndex = 0;
      const pickTrail: Array<{ name: string; pos: [number, number, number] | null }> = [];
      const stuckOf = (): {
        readonly option: string;
        readonly picks: number;
        readonly movedM: number;
      } | null => {
        if (pickTrail.length < 6) return null;
        const tail = pickTrail.slice(-6);
        const name = tail[0]!.name;
        if (!tail.every((entry) => entry.name === name)) return null;
        const base = tail[0]!.pos;
        if (base === null) return null;
        let moved = 0;
        for (const entry of tail) {
          if (entry.pos === null) return null;
          moved = Math.max(
            moved,
            Math.hypot(entry.pos[0] - base[0], entry.pos[1] - base[1], entry.pos[2] - base[2]),
          );
        }
        if (moved >= 1) return null;
        return { option: name, picks: tail.length, movedM: moved };
      };
      const coverageOf = (): {
        readonly cells4m: number;
        readonly samples: number;
        readonly bbox: string | null;
      } => {
        const cells = new Set<string>();
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const sample of samples) {
          if (sample.pos === null) continue;
          const [x, , z] = sample.pos;
          if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minZ = Math.min(minZ, z);
          maxZ = Math.max(maxZ, z);
          cells.add(`${Math.floor(x / 4) * 4},${Math.floor(z / 4) * 4}`);
        }
        return {
          cells4m: cells.size,
          samples: samples.length,
          bbox:
            cells.size === 0
              ? null
              : ` (x ${minX.toFixed(1)}..${maxX.toFixed(1)}, z ${minZ.toFixed(1)}..${maxZ.toFixed(1)})`,
        };
      };
      const wallStart = Date.now();
      const budgetMs = args.seconds * 1000;
      const addFinding = (
        detector: string,
        severity: string,
        summary: string,
        t: number,
        pos: [number, number, number] | null,
        detail: string,
      ): void => {
        const sig = `${detector}:${summary.slice(0, 120)}`;
        if (seen.has(sig) || findings.length >= GAME_BOT_BOUNDS.maxFindings) return;
        seen.add(sig);
        findings.push({ detector, severity, summary, t, pos, detail: detail.slice(0, 400) });
      };
      const writeChild = (msg: Record<string, unknown>): void => {
        try {
          botChild?.stdin?.write(`${JSON.stringify(msg)}\n`);
        } catch {
          /* closed */
        }
      };
      const WEB_MOVERS = new Set([
        "w",
        "a",
        "s",
        "d",
        "W",
        "A",
        "S",
        "D",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Space",
      ]);
      let errorsSeen = 0;
      while (!stopped()) {
        if (childDone !== null || childGone) break;
        if (Date.now() - wallStart > budgetMs) break;
        const loopStart = Date.now();
        const rawState: unknown = await page.evaluate(READ_STUDIO_STATE).catch(() => null);
        if (typeof rawState !== "string") {
          misses += 1;
          if (misses > RUNNER_MISS_LIMIT) throw new Error("The game stopped answering mid-run.");
          await sleep(Math.max(0, 100 - (Date.now() - loopStart)));
          continue;
        }
        misses = 0;
        ticks += 1;
        const t = (Date.now() - wallStart) / 1000;
        lastT = t;
        let parsed: Record<string, unknown> | null = null;
        try {
          const value: unknown = JSON.parse(rawState);
          if (typeof value === "object" && value !== null)
            parsed = value as Record<string, unknown>;
        } catch {
          parsed = null;
        }
        const pos: [number, number, number] | null =
          parsed !== null &&
          typeof parsed["player"] === "object" &&
          parsed["player"] !== null &&
          typeof (parsed["player"] as Record<string, unknown>)["x"] === "number" &&
          typeof (parsed["player"] as Record<string, unknown>)["y"] === "number" &&
          typeof (parsed["player"] as Record<string, unknown>)["z"] === "number"
            ? [
                (parsed["player"] as Record<string, unknown>)["x"] as number,
                (parsed["player"] as Record<string, unknown>)["y"] as number,
                (parsed["player"] as Record<string, unknown>)["z"] as number,
              ]
            : null;
        if (pos !== null) lastPos = pos;
        const gameState = asGameState(
          (parsed as Record<string, unknown> | null)?.["gameState"] ?? null,
        );
        if (Object.keys(gameState).length > 0) lastGameState = gameState;
        const hudText =
          parsed !== null && typeof parsed["hudText"] === "string"
            ? (parsed["hudText"] as string)
            : "";
        if (pos !== null) {
          if (
            Math.abs(pos[0]) > 2000 ||
            Math.abs(pos[1]) > 2000 ||
            Math.abs(pos[2]) > 2000 ||
            pos[1] < -50
          )
            addFinding(
              "out_of_world",
              "error",
              `Player out of world at (${pos[0].toFixed(0)}, ${pos[1].toFixed(0)}, ${pos[2].toFixed(0)})`,
              t,
              pos,
              "",
            );
        }
        if (hudText !== "") {
          for (const match of hudText.matchAll(new RegExp(FRACTION_RE, "g"))) {
            const a = Number(match[1]);
            const b = Number(match[2]);
            if (b > 0 && a > b)
              addFinding(
                "hud_fraction",
                "error",
                `HUD shows ${a}/${b}: more than its stated maximum`,
                t,
                pos,
                match[0].slice(0, 120),
              );
          }
        }
        if (pos !== null) {
          moveWindow.push({ wall: Date.now(), pos });
          moveWindow = moveWindow.filter((entry) => Date.now() - entry.wall < 2000);
          const moving = [...browserHeld].some((key) => WEB_MOVERS.has(key));
          if (moving && !noMoveReported && moveWindow.length >= 2) {
            const firstPos = moveWindow[0]!.pos;
            const dist = Math.hypot(
              pos[0] - firstPos[0],
              pos[1] - firstPos[1],
              pos[2] - firstPos[2],
            );
            if (Date.now() - moveWindow[0]!.wall >= 1900 && dist < 0.3) {
              noMoveReported = true;
              addFinding(
                "no_move",
                "warning",
                `Holding ${[...browserHeld]
                  .filter((key) => WEB_MOVERS.has(key))
                  .slice(0, 3)
                  .join("+")} 2s moved nobody (${dist.toFixed(1)}m)`,
                t,
                pos,
                "",
              );
            }
          }
          if (!moving) moveWindow = [];
        }
        if (pageErrors.length > errorsSeen) {
          for (const entry of pageErrors.slice(errorsSeen)) {
            addFinding(
              "log_error",
              "error",
              `Page error: ${entry.message.slice(0, 160)}`,
              t,
              pos,
              (entry.stack ?? "").slice(0, 200),
            );
          }
          errorsSeen = pageErrors.length;
        }
        if (ticks % 10 === 1) {
          samples.push({
            t,
            pos,
            state: typeof gameState["state"] === "string" ? gameState["state"] : null,
          });
          shotIndex += 1;
          await page
            .screenshot({
              path: NodePath.join(framesDir, `shot-${String(shotIndex).padStart(4, "0")}.png`),
            })
            .catch(() => undefined);
        }
        writeChild({
          op: "obs",
          tick: ticks,
          t,
          observation: {
            tick: ticks,
            t,
            probe: { gameState, player: pos, hudText },
            errors: pageErrors.slice(-5).map((entry) => ({ message: entry.message, where: "" })),
          },
          runContext: {
            seed: args.seed,
            runIndex: args.runIndex,
            runTotal: args.runTotal,
            priorRuns: args.priorRuns,
          },
        });
        let answer: {
          held: string[];
          taps: string[];
          clicks: unknown[];
          setStates: unknown[];
        } | null = null;
        for (let i = 0; i < 8; i++) {
          const line = await childLines.next(i === 0 ? CHILD_FIRST_INPUT_MS : CHILD_EXTRA_MS);
          if (line === null) break;
          const childMsg = parseLine(line);
          if (childMsg === null) continue;
          if (childMsg["op"] === "input") {
            answer = {
              held: Array.isArray(childMsg["held"])
                ? (childMsg["held"] as unknown[]).map(String).slice(0, 8)
                : [],
              taps: Array.isArray(childMsg["taps"])
                ? (childMsg["taps"] as unknown[]).map(String).slice(0, 8)
                : [],
              clicks: Array.isArray(childMsg["clicks"]) ? (childMsg["clicks"] as unknown[]) : [],
              setStates: Array.isArray(childMsg["setStates"])
                ? (childMsg["setStates"] as unknown[])
                : [],
            };
          } else if (childMsg["op"] === "decide") {
            if (args.decider === "jev" && args.jevKey !== null) {
              jevCalls += 1;
              const id = childMsg["id"];
              const decideOpts =
                (childMsg["options"] as Array<{
                  name: string;
                  description: string;
                  facts: unknown;
                }>) ?? [];
              const decideFacts = childMsg["facts"] ?? null;
              const decideTried =
                (childMsg["tried"] as Record<
                  string,
                  { picks: number; ok: number; fail: number }
                >) ?? {};
              const decideNow =
                typeof childMsg["nowDoing"] === "string" ? (childMsg["nowDoing"] as string) : null;
              const decideFor =
                typeof childMsg["nowDoingFor"] === "number"
                  ? (childMsg["nowDoingFor"] as number)
                  : null;
              const decideRecent =
                (childMsg["recent"] as Array<{ name: string; ok: boolean }>) ?? [];
              const decidePlan = childMsg["plan"] ?? null;
              try {
                const names = (decideOpts as Array<{ name?: unknown }>)
                  .map((o) => String(o?.name ?? ""))
                  .filter((name) => name !== "");
                if (names.length > 0) offered.push({ t, options: names.slice(0, 20) });
              } catch {
                /* offered is best effort */
              }
              const warm = Date.now() - jevLastUse < JEV_WARM_AFTER_MS;
              if (!warm) jevWarm(args.jevBase, args.jevKey);
              jevLastUse = Date.now();
              void (async () => {
                const enriched = decideOpts.map((o) => {
                  const name = String(o.name);
                  const tried =
                    (decideTried as Record<string, unknown>)[name] !== undefined
                      ? (decideTried as Record<string, unknown>)[name]
                      : { picks: 0, ok: 0, fail: 0 };
                  const base =
                    o.facts !== null && typeof o.facts === "object" && !Array.isArray(o.facts)
                      ? (o.facts as Record<string, unknown>)
                      : {};
                  return {
                    name,
                    description: String(o.description ?? ""),
                    facts: { ...base, tried },
                  };
                });
                const { pick, probs, failure, latencyMs } = await jevPick({
                  key: args.jevKey!,
                  base: args.jevBase,
                  goal,
                  facts: decideFacts,
                  options: enriched,
                  nowDoing: decideNow,
                  nowDoingFor: decideFor,
                  recent: decideRecent,
                  plan: decidePlan,
                  tried: decideTried as Record<string, { picks: number; ok: number; fail: number }>,
                  coverage: coverageOf(),
                  run:
                    args.runTotal > 1
                      ? { index: args.runIndex, total: args.runTotal, priorRuns: args.priorRuns }
                      : null,
                  stuck: stuckOf(),
                });
                jevLatencies.push({ ms: latencyMs, warm });
                if (pick === null) {
                  jevFailures += 1;
                  jevLog.push({ t, failure: failure ?? "unknown" });
                }
                writeChild({ op: "decision", id, pick, probs });
              })();
            } else {
              writeChild({ op: "decision", id: childMsg["id"], pick: null, probs: {} });
            }
          } else if (childMsg["op"] === "picked") {
            decisions += 1;
            const via = String(childMsg["via"] ?? "");
            const twoPlus = childMsg["twoPlus"] === true;
            if (via === "jev" && twoPlus) jevDecisions2Plus += 1;
            const pickedName = String(childMsg["name"] ?? "");
            pickTrail.push({ name: pickedName, pos });
            if (pickTrail.length > 12) pickTrail.shift();
            picks.push({
              t,
              name: pickedName,
              via,
              randomized: childMsg["randomized"] === true,
            });
          } else if (childMsg["op"] === "status") {
            childDone = {
              state: String(childMsg["state"] ?? "error"),
              note: String(childMsg["note"] ?? "").slice(0, 500),
              evidence: childMsg["evidence"] ?? {},
            };
          }
        }
        if (answer === null)
          answer = { held: [...browserHeld], taps: [], clicks: [], setStates: [] };
        const wanted = new Set(answer.held.map(String));
        for (const key of wanted)
          if (!browserHeld.has(key)) {
            await page.keyboard.down(toPlaywrightKey(key)).catch(() => undefined);
            browserHeld.add(key);
          }
        for (const key of browserHeld)
          if (!wanted.has(key)) {
            await page.keyboard.up(toPlaywrightKey(key)).catch(() => undefined);
            browserHeld.delete(key);
          }
        for (const tap of answer.taps.slice(0, 8)) {
          await page.keyboard.down(toPlaywrightKey(String(tap))).catch(() => undefined);
          await sleep(15);
          await page.keyboard.up(toPlaywrightKey(String(tap))).catch(() => undefined);
        }
        for (const click of answer.clicks) {
          const spec = click as { x?: unknown; y?: unknown };
          if (typeof spec?.x === "number" && typeof spec?.y === "number") {
            await page.mouse.click(Math.round(spec.x), Math.round(spec.y)).catch(() => undefined);
          } else {
            // No control tree on the web: id-clicks have nothing to land on.
            skippedIdClicks += 1;
          }
        }
        for (const entry of answer.setStates) {
          const spec = entry as { target?: unknown; values?: unknown };
          if (typeof spec?.target !== "string") continue;
          const applied = await page
            .evaluate(STUDIO_SET_STATE, {
              target: spec.target,
              values: (spec.values ?? {}) as Record<string, unknown>,
            })
            .catch(() => false);
          setStates.push({ t, target: spec.target, values: spec.values ?? null });
          void applied;
        }
        const elapsed = Date.now() - loopStart;
        if (elapsed < 100) await sleep(100 - elapsed);
      }
      const wallSeconds = Math.max(0.1, (Date.now() - wallStart) / 1000);
      const tickHz = ticks / wallSeconds;
      const gameSeconds = lastT;
      const timeRatio = gameSeconds / wallSeconds;
      const status = childDone ?? {
        state: stopped() ? "error" : "budget",
        note: stopped() ? "The run was stopped." : `Wall budget of ${args.seconds}s ended.`,
        evidence: {},
      };
      try {
        botChild?.stdin?.end();
      } catch {
        /* closed */
      }
      killAll();
      await waitExit(botChild, 3000);
      await page.close().catch(() => undefined);
      // Stills to video: one frame a second stitched at 2 fps, same codec as
      // the native runner so the report and players treat both lanes alike.
      if (shotIndex > 0) {
        await new Promise<void>((resolve) => {
          const child = NodeChildProcess.spawn(
            args.ffmpeg,
            [
              "-y",
              "-framerate",
              "2",
              "-i",
              NodePath.join(framesDir, "shot-%04d.png"),
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-pix_fmt",
              "yuv420p",
              args.videoPath,
            ],
            {
              env: headlessEnv(),
              stdio: "ignore",
            },
          );
          child.once("exit", () => resolve());
          child.once("error", () => resolve());
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* gone */
            }
            resolve();
          }, 120_000).unref?.();
        });
      }
      const usedSetState = setStates.length > 0;
      const frames = await extractRunFrames(args.ffmpeg, args.videoPath, args.runDir);
      const frozen = await frozenScreenFinding(frames, lastT, lastPos);
      const allFindings = frozen === null ? findings : [...findings, frozen];
      const median = (xs: number[]): number | null => {
        if (xs.length === 0) return null;
        const sorted = [...xs].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)]!;
      };
      const jevUsage =
        args.decider === "jev" && args.jevKey !== null
          ? {
              calls: jevCalls,
              failures: jevFailures,
              medianMs: median(jevLatencies.map((entry) => entry.ms)),
              warmMedianMs: median(
                jevLatencies.filter((entry) => entry.warm).map((entry) => entry.ms),
              ),
              decisions2Plus: jevDecisions2Plus,
              valid: jevDecisions2Plus >= 3,
            }
          : null;
      const trace = {
        runId: args.runId,
        file: NodePath.relative(args.root, args.botFile),
        decider: args.decider,
        mode: args.mode,
        goal,
        ticks,
        tickHz: Number(tickHz.toFixed(2)),
        timeRatio: Number(timeRatio.toFixed(3)),
        gameSeconds: Number(gameSeconds.toFixed(2)),
        wallSeconds: Number(wallSeconds.toFixed(1)),
        decisions,
        jev: jevUsage,
        jevLog: jevLog.slice(0, 20),
        policyNote: args.decider === "jev" && args.jevKey === null ? args.policyNote : null,
        usedSetState,
        setStates,
        skippedIdClicks,
        picks,
        offered: offered.slice(0, 400),
        status,
        findings: allFindings,
        samples,
        finalPos: lastPos,
        finalState: lastGameState,
      };
      await NodeFSP.writeFile(args.tracePath, JSON.stringify(trace, null, 2));
      await NodeFSP.writeFile(
        NodePath.join(args.runDir, "summary.json"),
        JSON.stringify({ ...trace, samples: trace.samples.length }, null, 2),
      );
      const jev: GameBotRunResult["jev"] = trace.jev;
      const jevLine =
        jev === null
          ? ""
          : `, Jev ${jev.calls} calls/${jev.failures} failed` +
            `, latency median ${jev.medianMs ?? "?"}ms${jev.warmMedianMs === null || jev.warmMedianMs === undefined ? "" : ` (${jev.warmMedianMs}ms warm)`}` +
            `, ${jev.decisions2Plus ?? 0} decisions among 2+ options` +
            (jev.valid === true ? "" : " (NOT a valid Jev run: fewer than 3)");
      const message =
        `Bot "${trace.file}" (${args.decider}): ${status.state} — ${status.note}. ` +
        `${ticks} ticks at ${tickHz.toFixed(1)} Hz, game/wall ${timeRatio.toFixed(2)}. ` +
        `${decisions} decisions` +
        jevLine +
        (trace.policyNote !== null ? `. ${trace.policyNote}` : "") +
        `. ${allFindings.length} finding(s). ` +
        (usedSetState ? "Used explicit set-state writes (not pure play)." : "Pure input play.") +
        (skippedIdClicks > 0
          ? ` ${skippedIdClicks} id-click(s) skipped: the web lane has no control tree.`
          : "") +
        ` Video: ${args.videoPath}`;
      void origin;
      return {
        runId: args.runId,
        goal,
        status: { state: status.state, note: status.note },
        ticks,
        tickHz: Number(tickHz.toFixed(2)),
        timeRatio: Number(timeRatio.toFixed(3)),
        gameSeconds: Number(gameSeconds.toFixed(2)),
        decisions,
        jev,
        policyNote: trace.policyNote,
        usedSetState,
        findings: allFindings,
        finalState: lastGameState,
        finalPos: lastPos,
        mode: args.mode,
        runIds: [args.runId],
        reportPath: null,
        tracePath: args.tracePath,
        videoPath: args.videoPath,
        frames,
        message,
      };
    } catch (error) {
      killAll();
      throw error;
    } finally {
      for (const reader of readers) reader.close();
      if (browser !== null) await browser.close().catch(() => undefined);
      if (serve !== null) await serve.close().catch(() => undefined);
    }
  };

  const run = (root: string, input: GameBotRunInput) =>
    Effect.gen(function* () {
      if (sessions.has(root))
        return yield* opError(
          "Bot run",
          root,
          "busy",
          "A bot run is already in progress for this game. Stop it with game_stop first.",
        );
      // A bot is a game file under .studio/bot/*.mjs; anything else is refused.
      const botDir = NodePath.resolve(root, ".studio/bot");
      const botFile = NodePath.resolve(root, input.file);
      if (!botFile.startsWith(`${botDir}/`) || !botFile.endsWith(".mjs"))
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
      const manifest = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8")
          .then(
            (text) =>
              JSON.parse(text) as {
                godotProject?: unknown;
                engine?: { name?: unknown };
              },
          )
          .catch((): { godotProject?: unknown; engine?: { name?: unknown } } => ({})),
      );
      const godotProject =
        typeof manifest.godotProject === "string" ? manifest.godotProject : "godot";
      const isWeb = manifest.engine?.name === "three";
      const projectText = isWeb
        ? ""
        : yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, godotProject, "project.godot"), "utf8").catch(
              () => "",
            ),
          );
      const viewport = isWeb ? { ...THREE_VIEWPORT } : parseGodotViewport(projectText);
      const godot = isWeb ? null : yield* tools.executable("godot");
      const chrome = isWeb ? yield* requireChromium("Bot run", root) : null;
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
      const xvfb = isWeb
        ? null
        : yield* Effect.promise(() =>
            findExecutable("Xvfb", { pathEnv, override: process.env.KURAMBIT_XVFB }),
          );
      if (xvfb === null && !isWeb)
        return yield* opError(
          "Bot run",
          "Xvfb",
          "tool-missing",
          "Xvfb is needed for the run's private display.",
        );
      let jevKey: string | null = null;
      let jevBase = JEV_DEFAULT_BASE;
      let policyNote: string | null = null;
      if (decider === "jev") {
        jevKey = yield* readSecretText(GAME_BOT_JEV_SECRET);
        const base = yield* readSecretText(GAME_BOT_JEV_BASE_SECRET);
        if (base !== null) jevBase = base;
        if (jevKey === null)
          policyNote =
            mode === "explore"
              ? `No Jev key in the server secret store (${GAME_BOT_JEV_SECRET}); this exploration ran with randomised policy choices, not Jev.`
              : `No Jev key in the server secret store (${GAME_BOT_JEV_SECRET}); this run used the bot's own policy.`;
      }
      const jevLive = decider === "jev" && jevKey !== null;
      // One session object spans the whole call: drop() flips its flag, so
      // a stop between runs ends the call with the runs it has. A per-run
      // entry in the map would vanish with each run's cleanup and the loop
      // could never tell "stopped" from "between runs".
      const session: Session = { root, runId: NodeCrypto.randomUUID(), stopped: false, pids: [] };
      sessions.set(root, session);
      const each = yield* Effect.gen(function* () {
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
          yield* Effect.tryPromise({
            try: () => NodeFSP.mkdir(runDir, { recursive: true }),
            catch: (cause) => opError("Bot run", runDir, "io", undefined, cause),
          });
          yield* Effect.tryPromise({
            try: () => NodeFSP.writeFile(childPath, GAME_BOT_CHILD_JS),
            catch: (cause) => opError("Bot run", childPath, "io", undefined, cause),
          });
          const one = isWeb
            ? yield* Effect.tryPromise({
                try: (signal) =>
                  executeWebRun({
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
                    projectDir: NodePath.join(root, godotProject),
                    chrome: chrome!,
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
                  }),
                catch: (cause) =>
                  isGameOperationError(cause)
                    ? cause
                    : opError(
                        "Bot run",
                        root,
                        "command-failed",
                        cause instanceof Error
                          ? cause.message.slice(0, 2000)
                          : String(cause).slice(0, 2000),
                        cause,
                      ),
              })
            : yield* Effect.gen(function* () {
                const scriptPath = NodePath.join(runDir, "bot.gd");
                const requestPath = NodePath.join(runDir, "request.json");
                const isolation = yield* Effect.tryPromise({
                  try: () => prepareNativeUserIsolation(runDir),
                  catch: (cause) => opError("Bot run", runDir, "io", undefined, cause),
                });
                yield* Effect.tryPromise({
                  try: () => NodeFSP.writeFile(scriptPath, GODOT_BOT_SCRIPT),
                  catch: (cause) => opError("Bot run", scriptPath, "io", undefined, cause),
                });
                return yield* Effect.tryPromise({
                  try: (signal) =>
                    executeRun({
                      root,
                      runId,
                      runDir,
                      scriptPath,
                      requestPath,
                      childPath,
                      videoPath,
                      tracePath,
                      botFile,
                      decider,
                      mode,
                      jevLive,
                      seconds,
                      token: nativeSessionToken(),
                      isolation,
                      viewport,
                      godotPath: godot!.path,
                      projectDir: NodePath.join(root, godotProject),
                      ffmpeg,
                      xvfb: xvfb!,
                      jevKey,
                      jevBase,
                      policyNote,
                      session,
                      signal,
                      runIndex: index,
                      runTotal: count,
                      seed: NodeCrypto.randomInt(1_000_000_000),
                      priorRuns: [...priorRuns],
                    }),
                  catch: (cause) =>
                    isGameOperationError(cause)
                      ? cause
                      : opError(
                          "Bot run",
                          root,
                          "command-failed",
                          cause instanceof Error
                            ? cause.message.slice(0, 2000)
                            : String(cause).slice(0, 2000),
                          cause,
                        ),
                });
              });
          out.push(one);
          runs.set(runId, { root, result: one });
          if (runs.size > GAME_BOT_BOUNDS.maxRuns) {
            const oldest = runs.keys().next();
            if (!oldest.done) runs.delete(oldest.value);
          }
          // The service records every run itself so testers cannot forget or
          // double-count: one JSON line per run, the same shape the loop reads.
          yield* Effect.promise(() =>
            NodeFSP.appendFile(
              NodePath.join(root, ".studio", "bot-results.jsonl"),
              `${JSON.stringify({
                runId,
                seconds: one.gameSeconds,
                won: one.status.state === "done",
                video: videoPath,
                findings: one.findings.length,
                mode,
                decider,
                file: NodePath.relative(root, botFile),
                at: new Date().toISOString(),
              })}\n`,
            ).catch(() => undefined),
          );
          // Tell the next run what this one covered: top options by picks,
          // visited 4 m cells, and how it ended. Best effort, never fatal.
          yield* Effect.promise(async () => {
            try {
              const trace = JSON.parse(await NodeFSP.readFile(tracePath, "utf8")) as {
                picks?: Array<{ name?: unknown }>;
                samples?: Array<{ pos?: [number, number, number] | null }>;
                status?: { state?: unknown };
              };
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
                  cells.add(`${Math.floor(pos[0] / 4) * 4},${Math.floor(pos[2] / 4) * 4}`);
              }
              priorRuns.push({
                topOptions: top === "" ? "no picks" : top,
                cells: cells.size,
                ending: String(trace.status?.state ?? "unknown"),
              });
            } catch {
              /* one bad trace never breaks the loop */
            }
          });
        }
        return out;
      }).pipe(
        // The map entry spans the whole call: one game's runs never overlap,
        // and a stop between runs still releases the game for the next call.
        Effect.ensuring(
          Effect.sync(() => {
            if (sessions.get(root) === session) sessions.delete(root);
          }),
        ),
      );
      if (each.length === 0)
        return yield* opError("Bot run", root, "command-failed", "The run was stopped.");
      const last = each[each.length - 1]!;
      const runIds = each.map((entry) => entry.runId);
      let reportPath: string | null = null;
      if (mode === "explore" || each.length > 1) {
        const built = yield* Effect.promise(() =>
          buildPlayerReport(root, runIds).catch(() => null),
        );
        if (built !== null) reportPath = built.rel;
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

  const view = (root: string, input: GameBotViewInput) =>
    Effect.gen(function* () {
      const found = runs.get(input.runId);
      if (found === undefined || found.root !== root)
        return yield* opError(
          "Bot view",
          input.runId,
          "invalid-input",
          "No bot run with that id for this game.",
        );
      const result = found.result;
      return {
        runId: result.runId,
        goal: result.goal,
        status: result.status,
        ticks: result.ticks,
        tickHz: result.tickHz,
        timeRatio: result.timeRatio,
        decisions: result.decisions,
        jev: result.jev,
        usedSetState: result.usedSetState,
        findings: result.findings,
        tracePath: result.tracePath,
        videoPath: result.videoPath,
        frames: result.frames,
        message: result.message,
      } satisfies GameBotViewResult;
    });

  const stop = (root: string) => Effect.sync(() => drop(root));

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
      const built = yield* Effect.promise(() =>
        buildPlayerReport(
          root,
          traces.map((entry) => entry.runId),
        ),
      );
      if (built === null)
        return yield* opError("Bot report", root, "io", "The player report could not be written.");
      return {
        path: built.rel,
        runs: built.runs,
        message: `Player report across ${built.runs.length} run(s): ${built.rel}.`,
      } satisfies GameBotReportResult;
    });

  return GameBot.of({ run, view, stop, report });
});

export const layer = Layer.effect(GameBot, make);
