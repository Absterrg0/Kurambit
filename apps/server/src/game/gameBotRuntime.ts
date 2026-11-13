// @effect-diagnostics globalTimers:off nodeBuiltinImport:off preferSchemaOverJson:off -- Shared by bot runs: pids, child lines and run frames.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { GAME_BOT_BOUNDS, GameOperationError, type GameBotPerf } from "@kurambit/contracts";
import { engineChildEnv } from "./GameProcesses.ts";
import { runOwned, type OwnedProcess, type ProcessHostState } from "./processHost.ts";

export const CHILD_FIRST_INPUT_MS = 400;
export const CHILD_EXTRA_MS = 30;

/** One bot run call: a stop flips `stopped` and stops every process the run started. */
export interface Session {
  readonly root: string;
  readonly runId: string;
  stopped: boolean;
  readonly processes: OwnedProcess[];
}

export const opError = (
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

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The middle value; null for none. */
export const medianOf = (xs: ReadonlyArray<number>): number | null => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/** The 4 m map cell a point falls in, over x and z: the one coverage grid. */
export const cellOf = (x: number, z: number) => {
  const cx = Math.floor(x / 4) * 4;
  const cz = Math.floor(z / 4) * 4;
  return { cx, cz, key: `${cx},${cz}` };
};

/** The bot child's structured evidence, kept only when its JSON fits 4 KB. */
export const boundEvidence = (
  evidence: unknown,
): { readonly value: unknown; readonly dropped: boolean } => {
  if (evidence === undefined || evidence === null) return { value: undefined, dropped: false };
  let text: string | undefined;
  try {
    text = JSON.stringify(evidence);
  } catch {
    return { value: undefined, dropped: true };
  }
  if (text === undefined) return { value: undefined, dropped: false };
  return Buffer.byteLength(text, "utf8") > 4096
    ? { value: undefined, dropped: true }
    : { value: evidence, dropped: false };
};

/**
 * The bot child's environment: the engine allowlist (on Windows it carries
 * SYSTEMROOT and the temp dirs Node needs), never a key or a display route.
 * The desktop app runs the server as Electron in Node mode, and the child is
 * started with the same executable, so it must be told to be Node too.
 */
export const botChildEnv = (): NodeJS.ProcessEnv =>
  engineChildEnv({
    NODE_OPTIONS: "--max-old-space-size=1536",
    ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
  });

export const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const asGameState = (value: unknown): Record<string, number | boolean | string | null> => {
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

// The bot's own status word in plain terms; anything else it declared stays as said.
const ENDINGS: Readonly<Record<string, string>> = {
  done: "won",
  failed: "lost",
  budget: "timed out",
  stalled: "stalled",
  crashed: "crashed",
  unresponsive: "stopped answering",
  "not-booted": "did not boot",
  "bot-error": "bot error",
  stopped: "stopped",
};
export const botEnding = (state: string): string => ENDINGS[state] ?? state.slice(0, 40);

/** The endings only the harness measures; a bot's own status can never claim one. */
const HARNESS_STATES: ReadonlySet<string> = new Set([
  "crashed",
  "unresponsive",
  "not-booted",
  "bot-error",
  "stopped",
]);

/**
 * A bot's own end word, kept as the bot's: its "error" is about the bot, and a
 * word the harness reserves (a bot that sees a death screen and says
 * "crashed") is kept as `bot:<word>`, so it never reads as a measured ending.
 */
export const botsOwnWord = (state: string): string => {
  const word = state.slice(0, 40);
  if (word === "error") return "bot-error";
  return HARNESS_STATES.has(word) ? `bot:${word}` : word;
};

/**
 * Folds one observation's node counts into the run's: the first reading is
 * the start, the latest the end, the largest the peak. A reading without
 * counts (the web runner, a non-sweep tick) keeps what was there.
 */
export const perfFrom = (raw: unknown, prev: GameBotPerf | null): GameBotPerf | null => {
  if (raw === null || typeof raw !== "object") return prev;
  const nodes = asNumber((raw as Record<string, unknown>)["nodes"]);
  const orphans = asNumber((raw as Record<string, unknown>)["orphans"]);
  if (nodes === null || orphans === null || !Number.isInteger(nodes) || !Number.isInteger(orphans))
    return prev;
  return {
    nodesStart: prev?.nodesStart ?? nodes,
    nodesPeak: Math.max(prev?.nodesPeak ?? nodes, nodes),
    nodesEnd: nodes,
    orphansEnd: orphans,
  };
};

// Numbers first, then flags: progress, scores and counts read as how far a run got.
const finalRank = (value: number | boolean | string | null): number =>
  typeof value === "number" ? 0 : typeof value === "boolean" ? 1 : 2;

/**
 * The game's last probe state, cut to a few primitive keys: a result row and a
 * comparator prompt carry it, so it stays small whatever the game exposes.
 */
export const botFinalState = (
  state: Readonly<Record<string, number | boolean | string | null>>,
): Record<string, number | boolean | string | null> => {
  const entries = Object.entries(state);
  // The sort is stable, so a game's own key order holds within each kind.
  const kept =
    entries.length <= 12
      ? entries
      : entries.toSorted(([, a], [, b]) => finalRank(a) - finalRank(b)).slice(0, 12);
  return Object.fromEntries(
    kept.map(([key, value]) => [
      key.slice(0, 40),
      typeof value === "string" ? value.slice(0, 60) : value,
    ]),
  );
};

export const posOf = (obs: Record<string, unknown>): [number, number, number] | null => {
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

export const FRACTION_RE = /(\d+)\s*\/\s*(\d+)/g;

/**
 * Frames for the result: one still every 5 wall seconds, at most 8 spread over
 * the run, and always the run's last screen (`END_FRAME`, taken before the game
 * quits), where its ending is: a 5-second grid alone misses it.
 */
export const END_FRAME = "frame-end.png";
export const extractRunFrames = async (
  host: ProcessHostState,
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
  const runFfmpeg = (args: ReadonlyArray<string>) =>
    runOwned(host, ffmpeg, args, { env: headlessEnv(), timeoutMs: 120_000 });
  await runFfmpeg([
    "-y",
    "-i",
    videoPath,
    "-vf",
    "fps=1/5",
    NodePath.join(framesDir, "frame-%03d.png"),
  ]);
  const files = await NodeFSP.readdir(framesDir).catch(() => [] as string[]);
  const grid = files
    .filter((file) => /^frame-\d+\.png$/.test(file))
    .sort()
    .map((file) => NodePath.join(framesDir, file));
  const end = files.includes(END_FRAME) ? [NodePath.join(framesDir, END_FRAME)] : [];
  const room = GAME_BOT_BOUNDS.maxFrames - end.length;
  if (grid.length <= room) return [...grid, ...end];
  const picked: string[] = [];
  for (let i = 0; i < room; i++)
    picked.push(grid[Math.min(grid.length - 1, Math.floor(((i + 0.5) * grid.length) / room))]!);
  return [...new Set(picked), ...end];
};

/** Stills extraction runs fixed ffmpeg args on already-written video: allowlisted engine base only. */
const headlessEnv = (): NodeJS.ProcessEnv => engineChildEnv();
