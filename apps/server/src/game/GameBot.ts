// @effect-diagnostics globalTimers:off globalDate:off globalDateInEffect:off nodeBuiltinImport:off globalFetch:off preferSchemaOverJson:off -- This service owns the native display/process boundary; wall-clock ticks, pids and line JSON are the domain here. Jev is one POST with an AbortSignal timeout, like the toolchain downloader.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  GAME_BOT_BOUNDS,
  GameOperationError,
  type GameBotMode,
  type GameBotPerf,
  type GameBotReportResult,
  type GameBotRunInput,
  type GameBotRunResult,
  type GameBotViewInput,
  type GameBotViewResult,
} from "@kurambit/contracts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as GameEngine from "./GameEngine.ts";
import * as GamePlayer from "./GamePlayer.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { insideGame } from "./GameProjectService.ts";
import { findExecutable } from "./GameProcesses.ts";
import { GAME_BOT_CHILD_JS } from "./gameBotChild.ts";
import { requireChromium } from "./gameChromium.ts";
import { launchPageBot, launchProcessBot } from "./gameBotLaunch.ts";
import { playBot, type BotLaunch } from "./gameBotPlay.ts";
import {
  botEnding,
  botFinalState,
  killPid,
  makeJev,
  opError,
  type Session,
} from "./gameBotRuntime.ts";
import { listenForRunner } from "./playSession.ts";

/** The Jev key lives in the server secret store under this name; bots never see it. */
export const GAME_BOT_JEV_SECRET = "game-bot-jev-api-key";
const GAME_BOT_JEV_BASE_SECRET = "game-bot-jev-base-url";
const JEV_DEFAULT_BASE = "https://api.typesafe.ai";

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
  perf?: GameBotPerf;
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
  const engines = yield* GameEngine.GameEngine;
  const players = yield* GamePlayer.GamePlayer;
  const projects = yield* GameProjectService.GameProjectService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sessions = new Map<string, Session>();
  const runs = new Map<string, { root: string; result: GameBotRunResult }>();

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

  const jevApi = makeJev();

  const isGameOperationError = Schema.is(GameOperationError);

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
      // The engine says how its game plays: a browser page, its runner on the
      // sources, or a prepared player. Everything else here is the same run.
      const manifest = yield* projects.read(root);
      const backend = yield* engines.backendFor(manifest.engine.name);
      const profile = backend.profile;
      const projectDir = insideGame(root, backend.projectDirectory(manifest));
      const isWeb = profile.play === "browser";
      const viewport =
        profile.viewport ??
        backend.projectSettings(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(projectDir, backend.projectSettingsFile), "utf8").catch(
              () => "",
            ),
          ),
        ).viewport;
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
      // A player of the current sources, built once per source identity; an
      // editor that just built it closes, so it never plays beside the run.
      const player = profile.play === "player" ? (yield* players.prepare(root)).player : null;
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
          const failed = (cause: unknown) =>
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
                );
          const opened: BotLaunch = isWeb
            ? yield* Effect.tryPromise({
                try: (signal) =>
                  launchPageBot({
                    root,
                    projectDir,
                    chrome: chrome!,
                    ffmpeg,
                    viewport,
                    runDir,
                    videoPath,
                    session,
                    signal,
                  }),
                catch: failed,
              })
            : yield* Effect.gen(function* () {
                const launch = backend.playProcess;
                if (launch === null)
                  return yield* opError(
                    "Bot run",
                    root,
                    "invalid-input",
                    `${profile.displayName} games have no runner process.`,
                  );
                const listener = yield* Effect.tryPromise({
                  try: () => listenForRunner(),
                  catch: (cause) => opError("Bot run", runDir, "io", undefined, cause),
                });
                const requestPath = NodePath.join(runDir, "request.json");
                const spec = yield* launch({
                  projectDir,
                  player,
                  requestPath,
                  scriptDir: runDir,
                  traceDir: runDir,
                  viewport,
                  display: true,
                }).pipe(Effect.tapError(() => Effect.promise(() => listener.drop())));
                return yield* Effect.tryPromise({
                  try: (signal) =>
                    launchProcessBot({
                      spec,
                      listener,
                      requestPath,
                      xvfb: xvfb!,
                      ffmpeg,
                      viewport,
                      runDir,
                      videoPath,
                      session,
                      signal,
                    }),
                  catch: failed,
                });
              });
          const one = yield* Effect.tryPromise({
            try: (signal) =>
              playBot(jevApi, opened, {
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
              }),
            catch: failed,
          }).pipe(Effect.ensuring(Effect.promise(() => opened.stop())));
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
                ending: botEnding(one.status.state),
                note: one.status.note.slice(0, 160),
                final: botFinalState(one.finalState),
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
