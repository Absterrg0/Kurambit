// @effect-diagnostics nodeBuiltinImport:off -- This module owns the native TCP boundary (node:net) for exploration sessions.
import * as NodeNet from "node:net";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { GAME_EXPLORE_BOUNDS, type GameExploreStep } from "@t3tools/contracts";
import { findExecutable } from "./GameProcesses.ts";
import { headlessEnvironment, DISPLAY_VARIABLES } from "./GameProcesses.ts";
import { GODOT_EXPLORE_SCRIPT } from "./godotExploreScript.ts";
import { prepareNativeUserIsolation, type NativeUserIsolation } from "./gameNativeUserDir.ts";

/** Nominal game time for new step kinds. Web kinds keep their existing accounting. */
export const exploreStepNominalMs = (step: GameExploreStep): number => {
  if ("press" in step) return 50;
  if ("waitMs" in step) return step.waitMs;
  if ("holdMs" in step) return step.holdMs;
  if ("ui" in step) return 100;
  return 0;
};

export const exploreStepsNominalMs = (steps: readonly GameExploreStep[]): number => {
  let total = 0;
  for (const step of steps) total += exploreStepNominalMs(step);
  return total;
};

export interface SanitizedNativeObservation {
  readonly probe: {
    readonly gameState: Record<string, number | boolean | string>;
    readonly player: { readonly x: number; readonly y: number; readonly z: number } | null;
    readonly hudText?: string;
  } | null;
  readonly screenText: Record<string, string>;
  readonly ui: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly enabled: boolean;
    readonly rect: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
  }>;
  readonly errors: ReadonlyArray<{ readonly message: string; readonly where: string }>;
  readonly uiResults: ReadonlyArray<{
    readonly id: string;
    readonly action: string;
    readonly received: boolean;
    readonly detail: string;
  }>;
  readonly inspections: ReadonlyArray<{
    readonly path: string;
    readonly values: Record<string, string | number | boolean | Array<number> | null>;
    readonly error?: string;
  }>;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown, max: number): string =>
  typeof value === "string" ? value.slice(0, max) : "";

const asBool = (value: unknown): boolean => value === true;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Bounds a runner observation before the service persists it. The runner is
 * trusted for play values, but text, control lists and error lines are capped
 * so one run cannot bloat the trace. Malformed entries are dropped.
 */
export const sanitizeNativeObservation = (raw: unknown): SanitizedNativeObservation => {
  const record = asRecord(raw);
  let probe: SanitizedNativeObservation["probe"] = null;
  {
    const candidate = asRecord(record["probe"]);
    if (Object.keys(candidate).length > 0) {
      const gameState: Record<string, number | boolean | string> = {};
      for (const [key, value] of Object.entries(asRecord(candidate["gameState"]))) {
        if (Object.keys(gameState).length >= 64 || key.length > 64) break;
        if (typeof value === "number" && Number.isFinite(value)) gameState[key] = value;
        else if (typeof value === "boolean") gameState[key] = value;
        else if (typeof value === "string") gameState[key] = value.slice(0, 256);
      }
      let player: { readonly x: number; readonly y: number; readonly z: number } | null = null;
      {
        const rawPlayer = asRecord(candidate["player"]);
        const x = asNumber(rawPlayer["x"]);
        const y = asNumber(rawPlayer["y"]);
        const z = asNumber(rawPlayer["z"]);
        if (x !== null && y !== null && z !== null) player = { x, y, z };
      }
      const hudText =
        typeof candidate["hudText"] === "string" ? candidate["hudText"].slice(0, 2000) : "";
      probe = hudText === "" ? { gameState, player } : { gameState, player, hudText };
    }
  }
  const screenText: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(record["screenText"]))) {
    if (Object.keys(screenText).length >= GAME_EXPLORE_BOUNDS.maxTextPerAct) break;
    if (typeof value === "string") screenText[key.slice(0, 200)] = value.slice(0, 200);
  }
  const ui: Array<SanitizedNativeObservation["ui"][number]> = [];
  {
    const rawUi = Array.isArray(record["ui"]) ? record["ui"] : [];
    for (const entry of rawUi.slice(0, GAME_EXPLORE_BOUNDS.maxUiPerAct)) {
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
        id: (item["id"] as string).slice(0, 200),
        kind: asString(item["kind"], 32),
        label: asString(item["label"], 200),
        enabled: asBool(item["enabled"]),
        rect: { x, y, width, height },
      });
    }
  }
  const errors: Array<SanitizedNativeObservation["errors"][number]> = [];
  {
    const rawErrors = Array.isArray(record["errors"]) ? record["errors"] : [];
    for (const entry of rawErrors.slice(0, GAME_EXPLORE_BOUNDS.maxErrorsPerAct)) {
      const item = asRecord(entry);
      if (typeof item["message"] !== "string") continue;
      errors.push({
        message: (item["message"] as string).slice(0, 500),
        where: asString(item["where"], 300),
      });
    }
  }
  const uiResults: Array<SanitizedNativeObservation["uiResults"][number]> = [];
  {
    const rawResults = Array.isArray(record["uiResults"]) ? record["uiResults"] : [];
    for (const entry of rawResults.slice(0, GAME_EXPLORE_BOUNDS.maxStepsPerCall)) {
      const item = asRecord(entry);
      if (typeof item["id"] !== "string") continue;
      uiResults.push({
        id: (item["id"] as string).slice(0, 200),
        action: asString(item["action"], 16),
        received: asBool(item["received"]),
        detail: asString(item["detail"], 500),
      });
    }
  }
  const inspections: Array<SanitizedNativeObservation["inspections"][number]> = [];
  {
    const rawInspections = Array.isArray(record["inspections"]) ? record["inspections"] : [];
    for (const entry of rawInspections.slice(0, GAME_EXPLORE_BOUNDS.maxStepsPerCall)) {
      const item = asRecord(entry);
      if (typeof item["path"] !== "string") continue;
      const values: Record<string, string | number | boolean | Array<number> | null> = {};
      for (const [key, value] of Object.entries(asRecord(item["values"]))) {
        if (Object.keys(values).length >= GAME_EXPLORE_BOUNDS.maxInspectValues || key.length > 64)
          break;
        if (
          value === null ||
          typeof value === "boolean" ||
          typeof value === "string" ||
          (typeof value === "number" && Number.isFinite(value)) ||
          (Array.isArray(value) &&
            value.length <= 4 &&
            value.every((entry) => typeof entry === "number" && Number.isFinite(entry)))
        )
          values[key] =
            typeof value === "string"
              ? value.slice(0, 256)
              : (value as number | boolean | Array<number> | null);
      }
      inspections.push({
        path: (item["path"] as string).slice(0, 500),
        values,
        ...(typeof item["error"] === "string" ? { error: item["error"].slice(0, 500) } : {}),
      });
    }
  }
  return { probe, screenText, ui, errors, uiResults, inspections };
};

export interface NativeLineState {
  buffer: string;
  notify: (() => void) | null;
  closed: boolean;
}

/** Awaits one JSON line from the runner. Null means the socket closed. */
export const nextRunnerLine = (
  state: NativeLineState,
  signal?: AbortSignal,
): Promise<string | null> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const take = (): string | null => {
      const index = state.buffer.indexOf("\n");
      if (index < 0) return null;
      const line = state.buffer.slice(0, index);
      state.buffer = state.buffer.slice(index + 1);
      return line;
    };
    const first = take();
    if (first !== null) {
      resolve(first);
      return;
    }
    if (state.closed) {
      resolve(null);
      return;
    }
    const onAbort = () => {
      state.notify = null;
      reject(new Error("aborted"));
    };
    const wait: () => void = () => {
      const line = take();
      if (line !== null) {
        state.notify = null;
        signal?.removeEventListener("abort", onAbort);
        resolve(line);
      } else if (state.closed) {
        state.notify = null;
        signal?.removeEventListener("abort", onAbort);
        resolve(null);
      } else {
        state.notify = wait;
      }
    };
    state.notify = wait;
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export const attachLineState = (socket: NodeNet.Socket, state: NativeLineState): void => {
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    state.buffer += chunk;
    state.notify?.();
  });
  const onClose = () => {
    state.closed = true;
    state.notify?.();
  };
  socket.on("close", onClose);
  socket.on("error", onClose);
};

/** PATH discovery for xvfb-run, including the user-space fallback for hosts without one. */
export const findXvfb = async (): Promise<string | null> => {
  const pathEnv = process.env.PATH ?? "";
  const fallback = `${process.env.HOME ?? "~"}/.gs-tmp/xvfb-local/usr/bin`;
  try {
    // The system wrapper comes first: the user-space fallback's script fails
    // to hand Godot a display (hardcoded server number, races on -a), so every
    // native boot times out with no picture when it wins. Hosts without a
    // system xvfb-run still fall back to it.
    const system = await findExecutable("xvfb-run", {
      pathEnv,
      override: process.env.GAME_STUDIO_XVFB_RUN,
    });
    if (system !== null) return system;
    return await findExecutable("xvfb-run", { pathEnv: fallback });
  } catch {
    return null;
  }
};

/**
 * The environment exactly one native explore child sees. Display routes are
 * stripped explicitly here — not only by the process service default — so a
 * shell with DISPLAY/WAYLAND_DISPLAY set can never leak the real desktop
 * into the child. Under Xvfb only xvfb-run's private DISPLAY reaches Godot
 * (plus --display-driver x11 in the args), and headless runs keep none.
 */
export const nativeChildEnv = (isolation: NativeUserIsolation): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...headlessEnvironment(process.env),
    LIBGL_ALWAYS_SOFTWARE: "1",
    LP_NUM_THREADS: "2",
    ...isolation.env,
  };
  for (const name of DISPLAY_VARIABLES) delete env[name];
  return env;
};

export interface NativeScriptStaging {
  readonly scriptDir: string;
  readonly scriptPath: string;
  readonly requestPath: string;
  readonly isolation: NativeUserIsolation;
}

/** Writes the server-owned runner script. Only ignored builds/logs change. */
export const stageNativeScript = async (
  root: string,
  sessionId: string,
  traceDir: string,
): Promise<NativeScriptStaging> => {
  const scriptDir = NodePath.join(root, "builds/logs", `game-explore-${sessionId}`);
  const scriptPath = NodePath.join(scriptDir, "explore.gd");
  const requestPath = NodePath.join(scriptDir, "request.json");
  await NodeFSP.mkdir(scriptDir, { recursive: true });
  await NodeFSP.writeFile(scriptPath, GODOT_EXPLORE_SCRIPT);
  const isolation = await prepareNativeUserIsolation(traceDir);
  return { scriptDir, scriptPath, requestPath, isolation };
};

export const writeNativeRequest = async (
  requestPath: string,
  input: { readonly port: number; readonly token: string; readonly expectedUserDataPrefix: string },
): Promise<void> => {
  await NodeFSP.writeFile(
    requestPath,
    JSON.stringify({
      port: input.port,
      token: input.token,
      bootScreenshotPath: null,
      expectedUserDataPrefix: input.expectedUserDataPrefix,
    }),
  );
};

export const nativeSessionToken = (): string => NodeCrypto.randomUUID();

/** Godot arguments for the explore runner. Headless when no private display exists. */
export const nativeGodotArgs = (input: {
  readonly projectDir: string;
  readonly scriptPath: string;
  readonly requestPath: string;
  readonly width: number;
  readonly height: number;
  readonly hasDisplay: boolean;
}): readonly string[] =>
  input.hasDisplay
    ? [
        "--display-driver",
        "x11",
        "--rendering-method",
        "gl_compatibility",
        "--audio-driver",
        "Dummy",
        "--resolution",
        `${input.width}x${input.height}`,
        "--path",
        input.projectDir,
        "--script",
        input.scriptPath,
        "--",
        input.requestPath,
      ]
    : [
        "--headless",
        "--audio-driver",
        "Dummy",
        "--resolution",
        `${input.width}x${input.height}`,
        "--path",
        input.projectDir,
        "--script",
        input.scriptPath,
        "--",
        input.requestPath,
      ];
