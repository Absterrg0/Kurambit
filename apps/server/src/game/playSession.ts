// @effect-diagnostics nodeBuiltinImport:off globalTimers:off preferSchemaOverJson:off -- What every play session is, whatever runs the game: its bounds, and the line protocol a child (the bot) speaks.
import * as NodeReadline from "node:readline";
import type {
  GameConsoleMessage,
  GameExploreInspection,
  GameExploreStep,
  GameExploreUiControl,
  GameExploreUiResult,
  GamePlaytestProbe,
  PlaySessionCapability,
} from "@kurambit/contracts";

/**
 * One running game the harness plays, whatever engine runs it: explore acts
 * while held, or real-time play with held input and the tick stream. The
 * session never owns the process or page behind it; whoever launched it ends
 * that after `close`.
 */
export interface PlaySession {
  /** 0 is a runner from before the protocol was versioned: acts only. */
  readonly protocol: number;
  readonly capabilities: ReadonlySet<PlaySessionCapability>;
  /** The observation the runner booted to, bounded. */
  readonly boot: PlayObservation;
  /** Node counts at boot, where the runner reports them. */
  readonly bootPerf: unknown;
  /** Runs steps and returns the observation after them; throws when the act failed. */
  readonly act: (
    steps: readonly GameExploreStep[],
    screenshotPath: string | null,
    signal?: AbortSignal,
  ) => Promise<PlayActObservation>;
  /**
   * Lets the game run at normal speed for the rest of the session and starts
   * the ticks; with `frames` (runners with that capability) the engine's
   * pictures go to `frames.onFrame` as they arrive.
   */
  readonly realtime: (frames?: PlayFrameRequest) => Promise<void>;
  /** Writes the picture as it is now to `path`; false when it could not. Runners with `frames`. */
  readonly still: (path: string) => Promise<boolean>;
  /**
   * The next tick observation as the runner sent it; `timeout` when none came
   * in time (the session is open but silent), `closed` when the connection is
   * gone. Who closed it is the launch's to say (`PlayLaunch.ended`).
   */
  readonly nextTick: (timeoutMs: number) => Promise<PlayTick>;
  readonly input: (input: {
    readonly held: readonly string[];
    readonly taps: readonly string[];
    readonly clicks: ReadonlyArray<
      { readonly x: number; readonly y: number } | { readonly id: string }
    >;
  }) => Promise<void>;
  readonly setState: (target: string, values: Record<string, unknown>) => Promise<void>;
  /** The state writes the game refused so far, with its reason. */
  readonly refusedStates: () => ReadonlyArray<{ readonly target: string; readonly error: string }>;
  /** Asks the runner to quit and lets go of the connection. Idempotent. */
  readonly close: () => Promise<void>;
  /**
   * The runs the game played to an end since the last call (the three.js shell's recorded
   * plays, shell/replay.js), to keep as the Stage keeps a person's. Absent where none are kept.
   */
  readonly takePlays?: () => Promise<ReadonlyArray<unknown>>;
}

export type PlayTick =
  | { readonly kind: "tick"; readonly observation: Record<string, unknown> }
  | { readonly kind: "timeout" }
  | { readonly kind: "closed" };

/**
 * How a played game ended, by whose side: the game's (its process exited, its
 * page crashed, its runner closed the session) is evidence about the build;
 * the host's (the private display or our browser went away) is a tool fault.
 */
export interface PlayEnd {
  readonly by: "game" | "host";
  readonly detail: string;
}

/** The game stopped answering within an act's bound: evidence about the build. */
export class PlayUnresponsive extends Error {}

/** The game's runner went away mid-act: evidence about the build. */
export class PlayClosed extends Error {}

/**
 * Every wait a play session makes, in one place: nothing waits on a game,
 * page or runner without one of these.
 */
export const PLAY_BOUNDS = {
  /** From launch to the runner's hello or the page's ready. */
  bootMs: 90_000,
  /** A player's page that errored with no studio bridge: how long the bridge has to appear. */
  bootErrorGraceMs: 10_000,
  /** Past the act's own step time, for a page's act. */
  webActGraceMs: 30_000,
  /** One tick of real-time play; misses in a row before the game counts as stopped answering. */
  tickMs: 3_000,
  tickMisses: 20,
  /** One web input or state write: a miss past it. */
  webCallMs: 2_000,
  stillMs: 15_000,
  quitMs: 2_000,
  webStorageMs: 3_000,
  webLeaveMs: 5_000,
  browserCloseMs: 10_000,
  keptSavesMs: 5_000,
  /** After a session closed, how long the launch has to say who ended it. */
  endedMs: 5_000,
} as const;

/** The first call's promise, for every call: a close or stop runs once. */
export const once = <A>(work: () => Promise<A>): (() => Promise<A>) => {
  let running: Promise<A> | null = null;
  return () => (running ??= work());
};

/** `promise`, or TIMED_OUT once `ms` pass; a late rejection is swallowed. */
export const TIMED_OUT: unique symbol = Symbol("timed out");
export const bounded = <T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  promise.catch(() => undefined);
  return Promise.race([
    promise,
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms));
    }),
  ]).finally(() => clearTimeout(timer));
};

/** One engine picture from the real-time stream. */
export interface PlayFrame {
  /** The engine's own count of drawn frames. */
  readonly frame: number;
  /** Game seconds since real-time play began. */
  readonly t: number;
  readonly jpeg: Buffer;
}

export interface PlayFrameRequest {
  readonly fps: number;
  readonly width: number;
  readonly onFrame: (frame: PlayFrame) => void;
}

export interface PlayObservation {
  readonly probe: GamePlaytestProbe | null;
  /** The fields below are absent where the runner reads no control tree (the browser). */
  readonly screenText?: Record<string, string>;
  readonly ui?: ReadonlyArray<GameExploreUiControl>;
  readonly errors?: ReadonlyArray<{ readonly message: string; readonly where: string }>;
  /** Browser only: console messages since the previous observation. */
  readonly consoleMessages?: ReadonlyArray<GameConsoleMessage>;
  readonly consoleTruncated?: number;
}

export interface PlayActObservation extends PlayObservation {
  readonly executedInputSteps: number;
  readonly screenshot: boolean;
  readonly uiResults?: ReadonlyArray<GameExploreUiResult>;
  readonly inspections?: ReadonlyArray<GameExploreInspection>;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** A runner's probe, bounded; null when it sent none. */
export const sanitizeProbe = (raw: unknown): GamePlaytestProbe | null => {
  const candidate = asRecord(raw);
  if (Object.keys(candidate).length === 0) return null;
  const gameState: Record<string, number | boolean | string> = {};
  for (const [key, value] of Object.entries(asRecord(candidate["gameState"]))) {
    if (Object.keys(gameState).length >= 64 || key.length > 64) break;
    if (typeof value === "number" && Number.isFinite(value)) gameState[key] = value;
    else if (typeof value === "boolean") gameState[key] = value;
    else if (typeof value === "string") gameState[key] = value.slice(0, 256);
  }
  const rawPlayer = asRecord(candidate["player"]);
  const x = asNumber(rawPlayer["x"]);
  const y = asNumber(rawPlayer["y"]);
  const z = asNumber(rawPlayer["z"]);
  const player = x !== null && y !== null && z !== null ? { x, y, z } : null;
  const hudText =
    typeof candidate["hudText"] === "string" ? candidate["hudText"].slice(0, 2000) : "";
  return hudText === "" ? { gameState, player } : { gameState, player, hudText };
};

export const parseLine = (line: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const FRAME_PREFIX = '{"op":"frame"';

/**
 * A frame line's picture, bounded; null for anything malformed. Frames are
 * the largest and most frequent lines, so they skip schema decoding.
 */
const frameOf = (line: string): PlayFrame | null => {
  const record = parseLine(line);
  if (record === null || typeof record["jpeg"] !== "string") return null;
  const frame = asNumber(record["frame"]);
  const t = asNumber(record["t"]);
  if (frame === null || t === null || record["jpeg"].length > 8 * 1024 * 1024) return null;
  return { frame, t, jpeg: Buffer.from(record["jpeg"], "base64") };
};

/**
 * Lines from a stream (a runner's socket, the bot child's stdout), awaited one
 * at a time with a deadline. Frame lines never queue: they go to the frame
 * sink as they arrive (or are dropped while no one asked for frames), so a
 * stream of pictures never delays an act's reply or a tick.
 */
export const createLineReader = (stream: NodeJS.ReadableStream) => {
  const reader = NodeReadline.createInterface({ input: stream, crlfDelay: Infinity });
  const ready: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  let onFrame: ((frame: PlayFrame) => void) | null = null;
  reader.on("line", (line: string) => {
    if (line.startsWith(FRAME_PREFIX)) {
      const frame = onFrame === null ? null : frameOf(line);
      if (frame !== null) onFrame?.(frame);
      return;
    }
    ready.push(line);
    wake?.();
  });
  const onClose = () => {
    closed = true;
    wake?.();
  };
  reader.on("close", onClose);
  stream.on("error", onClose);
  /** One line, "closed" when the stream is gone, or "timeout". */
  const next = (timeoutMs: number, signal?: AbortSignal): Promise<string | "closed" | "timeout"> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      const first = ready.shift();
      if (first !== undefined) return resolve(first);
      if (closed) return resolve("closed");
      const finish = (value: string | "closed" | "timeout" | Error) => {
        wake = null;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      const onAbort = () => finish(new Error("aborted"));
      const timer = setTimeout(() => finish("timeout"), Math.max(0, timeoutMs));
      signal?.addEventListener("abort", onAbort, { once: true });
      wake = () => {
        const line = ready.shift();
        if (line !== undefined) finish(line);
        else if (closed) finish("closed");
      };
    });
  return {
    next,
    closed: () => closed,
    frames: (sink: ((frame: PlayFrame) => void) | null) => {
      onFrame = sink;
    },
    close: () => reader.close(),
  };
};
export type LineReader = ReturnType<typeof createLineReader>;
