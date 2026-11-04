// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off preferSchemaOverJson:off -- The loopback TCP boundary every process runner connects back to; one JSON object per line.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
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
  /** Lets the game run at normal speed for the rest of the session and starts the ticks. */
  readonly realtime: () => Promise<void>;
  /** The next tick observation as the runner sent it, or null when none came in time. */
  readonly nextTick: (timeoutMs: number) => Promise<Record<string, unknown> | null>;
  readonly input: (input: {
    readonly held: readonly string[];
    readonly taps: readonly string[];
    readonly clicks: ReadonlyArray<
      { readonly x: number; readonly y: number } | { readonly id: string }
    >;
  }) => Promise<void>;
  readonly setState: (target: string, values: Record<string, unknown>) => Promise<void>;
  /** Asks the runner to quit and lets go of the connection. Idempotent. */
  readonly close: () => Promise<void>;
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

/** Lines from a socket, awaited one at a time with a deadline. */
const lineQueue = (socket: NodeNet.Socket) => {
  let buffer = "";
  let closed = false;
  let wake: (() => void) | null = null;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    wake?.();
  });
  const onClose = () => {
    closed = true;
    wake?.();
  };
  socket.on("close", onClose);
  socket.on("error", onClose);
  const take = (): string | null => {
    const index = buffer.indexOf("\n");
    if (index < 0) return null;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    return line;
  };
  /** One line, "closed" when the runner is gone, or "timeout". */
  const next = (timeoutMs: number, signal?: AbortSignal): Promise<string | "closed" | "timeout"> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      const ready = take();
      if (ready !== null) return resolve(ready);
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
        const line = take();
        if (line !== null) finish(line);
        else if (closed) finish("closed");
      };
    });
  return { next, closed: () => closed };
};

const decodeHandshake = Schema.decodeUnknownOption(PlaySessionHandshake);

/** A runner from before the protocol was versioned (Unity's first StudioProbe) plays acts with ui and inspect. */
const LEGACY_CAPABILITIES: ReadonlyArray<PlaySessionCapability> = ["ui", "inspect"];

const replyOf = (record: Record<string, unknown>): boolean =>
  record["op"] === "reply" || (record["op"] === undefined && typeof record["id"] === "number");

const tickOf = (record: Record<string, unknown>): boolean =>
  record["op"] === "tick" || (record["op"] === undefined && typeof record["tick"] === "number");

const socketSession = (
  socket: NodeNet.Socket,
  lines: ReturnType<typeof lineQueue>,
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
  const send = (command: PlaySessionCommand): void => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(command)}\n`);
  };
  const { probe, screenText, ui, errors } = sanitizeObservation(hello);
  return {
    protocol,
    capabilities,
    boot: { probe, screenText, ui, errors },
    bootPerf: hello["perf"] ?? null,
    act: async (steps, screenshotPath, signal) => {
      const id = nextId++;
      send({ op: "act", id, steps: [...steps], screenshotPath });
      const deadline = Date.now() + 120_000;
      for (;;) {
        const line = await lines.next(deadline - Date.now(), signal);
        if (line === "timeout") throw new Error("The act timed out after 120s.");
        if (line === "closed") throw new Error("The game's runner closed the session.");
        const record = parseLine(line.trim());
        if (record === null || !replyOf(record) || record["id"] !== id) continue;
        if (record["ok"] !== true)
          throw new Error(
            typeof record["error"] === "string" ? record["error"].slice(0, 500) : "The act failed.",
          );
        return sanitizeObservation(record);
      }
    },
    realtime: async () => send({ op: "realtime" }),
    nextTick: async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const line = await lines.next(deadline - Date.now());
        if (line === "timeout" || line === "closed") return null;
        const record = parseLine(line.trim());
        if (record !== null && tickOf(record)) return record;
      }
    },
    input: async ({ held, taps, clicks }) =>
      send({ op: "input", held: [...held], taps: [...taps], clicks: [...clicks] }),
    setState: async (target, values) => send({ op: "setState", id: nextId++, target, values }),
    close: async () => {
      if (closed) return;
      closed = true;
      // The quit line is flushed with end(); whoever launched the runner ends
      // its process tree if it lingers.
      if (!socket.destroyed)
        await new Promise<void>((resolve) => {
          socket.end(`${JSON.stringify({ op: "quit", id: nextId++ })}\n`, () => resolve());
          setTimeout(resolve, 2_000);
        });
      socket.destroy();
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
   * Waits for the runner's hello. `alive` lets the caller end the wait early
   * when the launched process is already gone or the run was stopped.
   */
  const accept = async (input: {
    readonly timeoutMs: number;
    readonly what: string;
    readonly signal?: AbortSignal | undefined;
    readonly alive?: () => boolean;
  }): Promise<PlaySession> => {
    const deadline = Date.now() + input.timeoutMs;
    let socket: NodeNet.Socket | null = null;
    while (socket === null) {
      input.signal?.throwIfAborted();
      if (input.alive !== undefined && !input.alive())
        throw new Error(`${input.what} exited before it connected; no session was opened.`);
      if (Date.now() >= deadline)
        throw new Error(
          `${input.what} did not connect within ${input.timeoutMs}ms; no session was opened.`,
        );
      socket = await Promise.race([
        connection,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
      ]);
    }
    const lines = lineQueue(socket);
    for (;;) {
      const line = await lines.next(Math.min(1000, deadline - Date.now()), input.signal);
      if (line === "closed")
        throw new Error(`${input.what} exited before booting; no session was opened.`);
      if (line === "timeout") {
        if (Date.now() >= deadline)
          throw new Error(
            `${input.what} did not boot within ${input.timeoutMs}ms; no session was opened.`,
          );
        if (input.alive !== undefined && !input.alive())
          throw new Error(`${input.what} exited before booting; no session was opened.`);
        continue;
      }
      const record = parseLine(line.trim());
      if (record === null) continue;
      if (typeof record["error"] === "string") throw new Error(record["error"].slice(0, 2000));
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
