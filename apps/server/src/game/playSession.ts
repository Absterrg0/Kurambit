// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off preferSchemaOverJson:off -- The loopback TCP boundary every process runner connects back to; one JSON object per line.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeReadline from "node:readline";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  GAME_EXPLORE_BOUNDS,
  PLAY_SESSION_PROTOCOL,
  PlaySessionHandshake,
  type GameConsoleMessage,
  type GameExploreInspection,
  type GameExploreStep,
  type GameExploreUiControl,
  type GameExploreUiResult,
  type GamePlaytestProbe,
  type PlaySessionCapability,
  type PlaySessionCommand,
  type PlaySessionRequest,
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

/** The game never booted: its process exited first, it never connected or never said hello in time. */
export class PlayNotBooted extends Error {}

/**
 * Every wait a play session makes, in one place: nothing waits on a game,
 * page or runner without one of these.
 */
export const PLAY_BOUNDS = {
  /** From launch to the runner's hello or the page's ready. */
  bootMs: 90_000,
  /** One act on a runner (the runner bounds its own steps). */
  socketActMs: 120_000,
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

const asString = (value: unknown, max: number): string =>
  typeof value === "string" ? value.slice(0, max) : "";

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

/**
 * Bounds a process runner's observation before the service persists it. The
 * runner is trusted for play values, but text, control lists and error lines
 * are capped so one run cannot bloat the trace. Malformed entries are dropped.
 */
export const sanitizeObservation = (
  raw: unknown,
): Required<Omit<PlayActObservation, "consoleMessages" | "consoleTruncated">> => {
  const record = asRecord(raw);
  const screenText: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(record["screenText"]))) {
    if (Object.keys(screenText).length >= GAME_EXPLORE_BOUNDS.maxTextPerAct) break;
    if (typeof value === "string") screenText[key.slice(0, 200)] = value.slice(0, 200);
  }
  const ui: GameExploreUiControl[] = [];
  for (const entry of (Array.isArray(record["ui"]) ? record["ui"] : []).slice(
    0,
    GAME_EXPLORE_BOUNDS.maxUiPerAct,
  )) {
    const item = asRecord(entry);
    const rect = asRecord(item["rect"]);
    const x = asNumber(rect["x"]);
    const y = asNumber(rect["y"]);
    const width = asNumber(rect["width"]);
    const height = asNumber(rect["height"]);
    if (
      typeof item["id"] !== "string" ||
      x === null ||
      y === null ||
      width === null ||
      height === null
    )
      continue;
    ui.push({
      id: item["id"].slice(0, 200),
      kind: asString(item["kind"], 32),
      label: asString(item["label"], 200),
      enabled: item["enabled"] === true,
      rect: { x, y, width, height },
    });
  }
  const errors: Array<{ message: string; where: string }> = [];
  for (const entry of (Array.isArray(record["errors"]) ? record["errors"] : []).slice(
    0,
    GAME_EXPLORE_BOUNDS.maxErrorsPerAct,
  )) {
    const item = asRecord(entry);
    if (typeof item["message"] !== "string") continue;
    errors.push({ message: item["message"].slice(0, 500), where: asString(item["where"], 300) });
  }
  const uiResults: GameExploreUiResult[] = [];
  for (const entry of (Array.isArray(record["uiResults"]) ? record["uiResults"] : []).slice(
    0,
    GAME_EXPLORE_BOUNDS.maxStepsPerCall,
  )) {
    const item = asRecord(entry);
    if (typeof item["id"] !== "string") continue;
    uiResults.push({
      id: item["id"].slice(0, 200),
      action: asString(item["action"], 16),
      received: item["received"] === true,
      detail: asString(item["detail"], 500),
    });
  }
  const inspections: GameExploreInspection[] = [];
  for (const entry of (Array.isArray(record["inspections"]) ? record["inspections"] : []).slice(
    0,
    GAME_EXPLORE_BOUNDS.maxStepsPerCall,
  )) {
    const item = asRecord(entry);
    if (typeof item["path"] !== "string") continue;
    const values: Record<string, string | number | boolean | Array<number> | null> = {};
    for (const [key, value] of Object.entries(asRecord(item["values"]))) {
      if (Object.keys(values).length >= GAME_EXPLORE_BOUNDS.maxInspectValues || key.length > 64)
        break;
      if (value === null || typeof value === "boolean") values[key] = value;
      else if (typeof value === "string") values[key] = value.slice(0, 256);
      else if (typeof value === "number" && Number.isFinite(value)) values[key] = value;
      else if (
        Array.isArray(value) &&
        value.length <= 4 &&
        value.every((n) => typeof n === "number" && Number.isFinite(n))
      )
        values[key] = value as number[];
    }
    inspections.push({
      path: item["path"].slice(0, 500),
      values,
      ...(typeof item["error"] === "string" ? { error: item["error"].slice(0, 500) } : {}),
    });
  }
  return {
    probe: sanitizeProbe(record["probe"]),
    screenText,
    ui,
    errors,
    uiResults,
    inspections,
    executedInputSteps:
      typeof record["executedInputSteps"] === "number" ? record["executedInputSteps"] : 0,
    screenshot: record["screenshot"] === true,
  };
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

const decodeHandshake = Schema.decodeUnknownOption(PlaySessionHandshake);

/** A runner from before the protocol was versioned (Unity's first StudioProbe) plays acts with ui and inspect. */
const LEGACY_CAPABILITIES: ReadonlyArray<PlaySessionCapability> = ["ui", "inspect"];

const replyOf = (record: Record<string, unknown>): boolean =>
  record["op"] === "reply" || (record["op"] === undefined && typeof record["id"] === "number");

const tickOf = (record: Record<string, unknown>): boolean =>
  record["op"] === "tick" || (record["op"] === undefined && typeof record["tick"] === "number");

const socketSession = (
  socket: NodeNet.Socket,
  lines: LineReader,
  hello: Record<string, unknown>,
  server: NodeNet.Server,
): PlaySession => {
  const handshake = decodeHandshake(hello);
  const protocol = Option.isSome(handshake) ? handshake.value.protocol : 0;
  const capabilities = new Set(
    Option.isSome(handshake) ? handshake.value.capabilities : LEGACY_CAPABILITIES,
  );
  let nextId = 1;
  let closed = false;
  // Real-time play does not wait on a state write's reply; it is read with the ticks.
  const pendingStates = new Map<unknown, string>();
  const refused: Array<{ target: string; error: string }> = [];
  const send = (command: PlaySessionCommand): void => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(command)}\n`);
  };
  const { probe, screenText, ui, errors } = sanitizeObservation(hello);
  /**
   * Every line any read loop takes passes here first: a state write's reply
   * can arrive while an act or a still is waiting, and its refusal still counts.
   */
  const read = async (deadline: number, signal?: AbortSignal) => {
    const line = await lines.next(deadline - Date.now(), signal);
    if (line === "timeout" || line === "closed") return line;
    const record = parseLine(line.trim());
    if (record !== null && replyOf(record) && pendingStates.has(record["id"])) {
      const target = pendingStates.get(record["id"])!;
      pendingStates.delete(record["id"]);
      if (record["ok"] !== true && refused.length < 20)
        refused.push({
          target,
          error: typeof record["error"] === "string" ? record["error"].slice(0, 300) : "refused",
        });
      return null;
    }
    return record;
  };
  return {
    protocol,
    capabilities,
    boot: { probe, screenText, ui, errors },
    bootPerf: hello["perf"] ?? null,
    act: async (steps, screenshotPath, signal) => {
      const id = nextId++;
      send({ op: "act", id, steps: [...steps], screenshotPath });
      const deadline = Date.now() + PLAY_BOUNDS.socketActMs;
      for (;;) {
        const record = await read(deadline, signal);
        if (record === "timeout")
          throw new PlayUnresponsive(
            `The game did not answer this act within ${PLAY_BOUNDS.socketActMs / 1000} s.`,
          );
        if (record === "closed") throw new PlayClosed("The game's runner closed the session.");
        if (record === null || !replyOf(record) || record["id"] !== id) continue;
        if (record["ok"] !== true)
          throw new Error(
            typeof record["error"] === "string" ? record["error"].slice(0, 500) : "The act failed.",
          );
        return sanitizeObservation(record);
      }
    },
    realtime: async (frames) => {
      if (frames !== undefined && capabilities.has("frames")) {
        lines.frames(frames.onFrame);
        send({ op: "realtime", frames: { fps: frames.fps, width: frames.width } });
      } else send({ op: "realtime" });
    },
    still: async (path) => {
      if (!capabilities.has("frames")) return false;
      const id = nextId++;
      send({ op: "still", id, path });
      const deadline = Date.now() + PLAY_BOUNDS.stillMs;
      for (;;) {
        const record = await read(deadline);
        if (record === "timeout" || record === "closed") return false;
        if (record !== null && replyOf(record) && record["id"] === id)
          return record["ok"] === true && record["screenshot"] === true;
      }
    },
    nextTick: async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const record = await read(deadline);
        if (record === "timeout" || record === "closed") return { kind: record };
        if (record !== null && tickOf(record)) return { kind: "tick", observation: record };
      }
    },
    input: async ({ held, taps, clicks }) =>
      send({ op: "input", held: [...held], taps: [...taps], clicks: [...clicks] }),
    setState: async (target, values) => {
      const id = nextId++;
      pendingStates.set(id, target);
      send({ op: "setState", id, target, values });
    },
    refusedStates: () => refused,
    close: async () => {
      if (closed) return;
      closed = true;
      lines.frames(null);
      // The quit line is flushed with end(); whoever launched the runner ends
      // its process tree if it lingers.
      if (!socket.destroyed)
        await new Promise<void>((resolve) => {
          socket.end(`${JSON.stringify({ op: "quit", id: nextId++ })}\n`, () => resolve());
          setTimeout(resolve, PLAY_BOUNDS.quitMs);
        });
      socket.destroy();
      lines.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

/**
 * A loopback listener for one process runner. Write the request (its port and
 * token) where the runner reads it, start the runner, then `accept` its
 * handshake. `drop` releases the listener when the session never opened.
 */
export const listenForRunner = async () => {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const token = NodeCrypto.randomUUID();
  const port = (server.address() as NodeNet.AddressInfo).port;
  let runner: NodeNet.Socket | null = null;
  let connected: (socket: NodeNet.Socket) => void = () => undefined;
  const connection = new Promise<NodeNet.Socket>((resolve) => {
    connected = resolve;
  });
  server.on("connection", (socket) => {
    if (runner !== null) {
      socket.destroy();
      return;
    }
    runner = socket;
    connected(socket);
  });
  const writeRequest = (
    path: string,
    extra: Omit<PlaySessionRequest, "protocol" | "port" | "token">,
  ) =>
    NodeFSP.writeFile(
      path,
      JSON.stringify({
        protocol: PLAY_SESSION_PROTOCOL,
        port,
        token,
        ...extra,
      } satisfies PlaySessionRequest),
    );
  /**
   * Waits for the runner's hello. `exited` (the launched process's exit) ends
   * the wait early: a game that dies before its hello never booted.
   */
  const accept = async (input: {
    readonly timeoutMs: number;
    readonly what: string;
    readonly signal?: AbortSignal | undefined;
    readonly exited?: Promise<unknown>;
  }): Promise<PlaySession> => {
    input.signal?.throwIfAborted();
    const deadline = Date.now() + input.timeoutMs;
    let gone = false;
    const exited = (input.exited ?? new Promise<never>(() => undefined)).then(
      () => (gone = true),
      () => (gone = true),
    );
    const aborted = new Promise<"aborted">((resolve) =>
      input.signal?.addEventListener("abort", () => resolve("aborted"), { once: true }),
    );
    const socket = await Promise.race([
      connection,
      exited.then(() => "exited" as const),
      aborted,
      bounded(new Promise<never>(() => undefined), input.timeoutMs),
    ]);
    if (socket === "aborted") throw new Error("aborted");
    if (socket === "exited")
      throw new PlayNotBooted(`${input.what} exited before it connected; no session was opened.`);
    if (socket === TIMED_OUT)
      throw new PlayNotBooted(
        `${input.what} did not connect within ${input.timeoutMs}ms; no session was opened.`,
      );
    const lines = createLineReader(socket);
    for (;;) {
      const line = await lines.next(Math.min(1000, deadline - Date.now()), input.signal);
      if (line === "closed")
        throw new PlayNotBooted(`${input.what} exited before booting; no session was opened.`);
      if (line === "timeout") {
        if (Date.now() >= deadline)
          throw new PlayNotBooted(
            `${input.what} did not boot within ${input.timeoutMs}ms; no session was opened.`,
          );
        if (gone)
          throw new PlayNotBooted(`${input.what} exited before booting; no session was opened.`);
        continue;
      }
      const record = parseLine(line.trim());
      if (record === null) continue;
      // The runner's own boot error: the game's scene or code would not start.
      if (typeof record["error"] === "string")
        throw new PlayNotBooted(record["error"].slice(0, 2000));
      if (record["token"] !== token)
        throw new Error(`${input.what} presented a wrong session token.`);
      return socketSession(socket, lines, record, server);
    }
  };
  const drop = async (): Promise<void> => {
    (runner as NodeNet.Socket | null)?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { writeRequest, accept, drop };
};
