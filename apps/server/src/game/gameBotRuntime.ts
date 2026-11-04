// @effect-diagnostics globalTimers:off globalDate:off nodeBuiltinImport:off globalFetch:off preferSchemaOverJson:off -- Shared by the bot launchers: private displays, pids, runner line JSON, run frames and the Jev call.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import {
  GAME_BOT_BOUNDS,
  GameOperationError,
  type GameBotFinding,
  type GameBotPerf,
} from "@kurambit/contracts";
import { engineChildEnv } from "./GameProcesses.ts";

const JEV_MODEL = "jev-latest";
const JEV_TIMEOUT_MS = 4000;
// The connection to Jev is kept warm across decisions (Aura's design): idle
// past this long, a light call goes out before the next decision needs it.
const JEV_WARM_AFTER_MS = 15_000;
const JEV_WARM_TIMEOUT_MS = 5000;
export const RUNNER_OBS_TIMEOUT_MS = 3000;
export const RUNNER_MISS_LIMIT = 20;
export const CHILD_FIRST_INPUT_MS = 400;
export const CHILD_EXTRA_MS = 30;
export const BOOT_TIMEOUT_MS = 90_000;

/** One bot run call: a stop flips `stopped`, and the run's pids are killed by number. */
export interface Session {
  readonly root: string;
  readonly runId: string;
  stopped: boolean;
  readonly pids: number[];
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

const alive = (pid: number | undefined): boolean => {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Displays this process picked and has not let go: two runs at once (a blind
// comparison's bot on both builds) both see a number free before either's Xvfb
// writes its lock, and the second would then play on the first one's display.
export const claimed = new Set<number>();

/** A free private X display, preferring above the live-Blender range; the caller releases it. */
export const pickDisplay = async (): Promise<number | null> => {
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
    if (claimed.has(n) || (await taken(n)) || claimed.has(n)) continue;
    claimed.add(n);
    return n;
  }
  return null;
};

export const waitDisplay = async (n: number, timeoutMs: number): Promise<boolean> => {
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

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface LineReader {
  readonly next: (timeoutMs: number) => Promise<string | null>;
  readonly close: () => void;
}

export const createLineReader = (stream: NodeJS.ReadableStream): LineReader => {
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

export const parseLine = (line: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
};

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
  error: "error",
};
export const botEnding = (state: string): string => ENDINGS[state] ?? state.slice(0, 40);

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

export const MOVERS = new Set([
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
export const FRACTION_RE = /(\d+)\s*\/\s*(\d+)/g;

export const killPid = (pid: number | undefined): void => {
  if (!alive(pid)) return;
  try {
    process.kill(pid!, "SIGTERM");
  } catch {
    /* gone */
  }
};

/** Jev decisions for one bot service: the warm pool state is shared by its runs. */
export const makeJev = () => {
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
  const pick = async (input: {
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
  const warm = (base: string, key: string): void => {
    void fetch(`${base.replace(/\/$/, "")}/v1/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(JEV_WARM_TIMEOUT_MS),
    }).then(
      () => undefined,
      () => undefined,
    );
  };
  /**
   * Called before each decision: re-warms Jev when it sat idle, so the next
   * decision does not wait on a new connection. True when it was still warm.
   */
  const touch = (base: string, key: string): boolean => {
    const wasWarm = Date.now() - jevLastUse < JEV_WARM_AFTER_MS;
    if (!wasWarm) warm(base, key);
    jevLastUse = Date.now();
    return wasWarm;
  };
  return { pick, touch };
};

export type Jev = ReturnType<typeof makeJev>;

/** Frames for the result: one still every 5 wall seconds, at most 8 spread over the run. */
export const extractRunFrames = async (
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
export const headlessEnv = (): NodeJS.ProcessEnv => engineChildEnv();

/** The frozen-screen probe runs on the extracted frames, never per tick. */
export const frozenScreenFinding = async (
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
