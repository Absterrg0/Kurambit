// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off -- This module owns headless Chromium for web exploration sessions: wall-clock boot polling and real-time input.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import {
  type GameConsoleMessage,
  type GameExploreStep,
  type GamePlaytestProbe,
} from "@kurambit/contracts";
import {
  READ_STUDIO_READY,
  READ_STUDIO_STATE,
  chromiumLaunchArgs,
  toPlaywrightKey,
} from "./gameChromium.ts";
import { chromiumChildEnv } from "./gameWebServer.ts";

// Playwright needs its files on disk; createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 500;

export interface ExploreWebObservation {
  readonly executedInputSteps: number;
  readonly nominalMs: number;
  readonly probe: GamePlaytestProbe | null;
  readonly screenshotData: string;
  readonly consoleMessages: readonly GameConsoleMessage[];
  readonly consoleTruncated: number;
}

export interface ExploreWebHandle {
  readonly viewport: { width: number; height: number };
  readonly bootMs: number | null;
  readonly bootProbe: GamePlaytestProbe | null;
  readonly bootConsole: readonly GameConsoleMessage[];
  /** Executes steps in real time against the live page, then samples one observation. */
  readonly act: (
    steps: readonly GameExploreStep[],
    firstStepIndex: number,
    signal?: AbortSignal,
  ) => Promise<ExploreWebObservation>;
  readonly close: () => Promise<void>;
}

const sanitizeProbe = (value: unknown): GamePlaytestProbe | null => {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const gameState: Record<string, number | boolean | string> = {};
  const rawState =
    typeof record["gameState"] === "object" && record["gameState"] !== null
      ? (record["gameState"] as Record<string, unknown>)
      : {};
  for (const [key, entry] of Object.entries(rawState)) {
    if (Object.keys(gameState).length >= 64 || key.length > 64) break;
    if (typeof entry === "number" && Number.isFinite(entry)) gameState[key] = entry;
    else if (typeof entry === "boolean") gameState[key] = entry;
    else if (typeof entry === "string") gameState[key] = entry.slice(0, 256);
  }
  let player: { x: number; y: number; z: number } | null = null;
  const rawPlayer =
    typeof record["player"] === "object" && record["player"] !== null
      ? (record["player"] as Record<string, unknown>)
      : null;
  if (
    rawPlayer !== null &&
    typeof rawPlayer["x"] === "number" &&
    typeof rawPlayer["y"] === "number" &&
    typeof rawPlayer["z"] === "number"
  )
    player = { x: rawPlayer["x"], y: rawPlayer["y"], z: rawPlayer["z"] };
  const hudText =
    typeof record["hudText"] === "string" ? record["hudText"].slice(0, 2000) : undefined;
  return hudText === undefined ? { gameState, player } : { gameState, player, hudText };
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const stepDurationMs = (step: GameExploreStep): number => {
  if ("press" in step) return 50;
  if ("waitMs" in step) return step.waitMs;
  if ("holdMs" in step) return step.holdMs;
  return 0;
};

/**
 * Opens a web exploration session: headless Chromium on the served static
 * project, real input, no pause. The caller owns the server URL and closes
 * the handle; a launch that races an abort closes what it opened.
 */
export const openExploreWeb = async (input: {
  readonly executable: string;
  readonly url: string;
  readonly profileDirectory: string;
  readonly width: number;
  readonly height: number;
  readonly bootTimeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}): Promise<ExploreWebHandle> => {
  input.signal?.throwIfAborted();
  await NodeFSP.mkdir(input.profileDirectory, { recursive: true });
  const { chromium } = loadPlaywright();
  const browser = await chromium
    .launch({
      executablePath: input.executable,
      headless: true,
      args: [...chromiumLaunchArgs()],
      env: chromiumChildEnv(),
    })
    .catch(async (cause: unknown) => {
      if (input.signal?.aborted) throw new Error("aborted");
      throw cause;
    });
  if (input.signal?.aborted) {
    await browser.close().catch(() => undefined);
    throw new Error("aborted");
  }
  try {
    const page = await browser.newPage({ viewport: { width: input.width, height: input.height } });
    const pending: Array<{ level: GameConsoleMessage["level"]; text: string }> = [];
    let dropped = 0;
    const record = (level: GameConsoleMessage["level"], text: string): void => {
      // The browser's own chrome, not the game: a missing favicon is not a
      // game failure (the starter links a data-URI icon so it never fires).
      if (/favicon\.ico/i.test(text)) return;
      if (pending.length >= MAX_MESSAGES) {
        pending.shift();
        dropped += 1;
      }
      pending.push({ level, text: text.slice(0, MAX_MESSAGE_CHARS) });
    };
    page.on("console", (message) => {
      const type = String(message.type() ?? "log");
      record(
        type === "error"
          ? "error"
          : type === "warning"
            ? "warning"
            : type === "info"
              ? "info"
              : "log",
        message.text().trim() || `console ${type}()`,
      );
    });
    page.on("pageerror", (error) => {
      record("error", error instanceof Error ? error.message : String(error));
    });
    const drain = (): { messages: readonly GameConsoleMessage[]; truncated: number } => {
      const messages = [...pending];
      pending.length = 0;
      const truncated = dropped;
      dropped = 0;
      return { messages, truncated };
    };
    const bootWallStart = Date.now();
    let booted = false;
    try {
      await page.goto(input.url, { timeout: input.bootTimeoutMs, waitUntil: "load" });
      const bootDeadline = Date.now() + input.bootTimeoutMs;
      while (!booted && Date.now() < bootDeadline) {
        await sleep(500, input.signal);
        input.signal?.throwIfAborted();
        try {
          if ((await page.evaluate(READ_STUDIO_READY)) === true) {
            booted = true;
            break;
          }
        } catch {
          // Evaluations race the page navigation; keep polling until the deadline.
        }
      }
    } catch (cause) {
      await browser.close().catch(() => undefined);
      throw cause;
    }
    if (!booted) {
      await browser.close().catch(() => undefined);
      throw new Error(
        "The three.js page never reported ready (window.__studio.ready stayed false); no exploration session was opened.",
      );
    }
    const bootMs = Date.now() - bootWallStart;
    const bootProbe = sanitizeProbe(await page.evaluate(READ_STUDIO_STATE).catch(() => null));
    const bootDrained = drain();
    let pointer: { x: number; y: number } | null = null;
    const centre = (): { x: number; y: number } => ({
      x: Math.round(input.width / 2),
      y: Math.round(input.height / 2),
    });
    const act: ExploreWebHandle["act"] = async (steps, firstStepIndex, actSignal) => {
      void firstStepIndex;
      actSignal?.throwIfAborted();
      let executedInputSteps = 0;
      let nominalMs = 0;
      const held: string[] = [];
      try {
        for (const step of steps) {
          actSignal?.throwIfAborted();
          if ("waitMs" in step) {
            await sleep(step.waitMs, actSignal);
          } else if ("screenshot" in step) {
            // The act's single persisted frame is the observation; a labelled
            // mid-route capture adds no second persisted image.
          } else if ("click" in step) {
            const point =
              step.x === undefined || step.y === undefined
                ? (pointer ?? centre())
                : { x: step.x, y: step.y };
            await page.mouse.click(Math.round(point.x), Math.round(point.y), {
              button: step.click,
              clickCount: 1,
            });
            pointer = { x: point.x, y: point.y };
            executedInputSteps += 1;
          } else if ("drag" in step) {
            const { from, to } = step.drag;
            await page.mouse.move(from.x, from.y);
            await page.mouse.down();
            await sleep(step.holdMs, actSignal);
            await page.mouse.move(to.x, to.y, { steps: 8 });
            await page.mouse.up();
            pointer = { x: to.x, y: to.y };
            executedInputSteps += 1;
          } else if ("mouseMove" in step) {
            const base = pointer ?? centre();
            const next = {
              x: Math.max(0, Math.min(input.width, base.x + step.mouseMove.dx)),
              y: Math.max(0, Math.min(input.height, base.y + step.mouseMove.dy)),
            };
            await page.mouse.move(Math.round(next.x), Math.round(next.y));
            pointer = next;
            executedInputSteps += 1;
          } else if ("keys" in step) {
            for (const key of step.keys) {
              const mapped = toPlaywrightKey(key);
              await page.keyboard.down(mapped);
              held.push(mapped);
            }
            await sleep(step.holdMs, actSignal);
            executedInputSteps += 1;
          } else if ("key" in step) {
            const mapped = toPlaywrightKey(step.key);
            await page.keyboard.down(mapped);
            held.push(mapped);
            await sleep(step.holdMs, actSignal);
            executedInputSteps += 1;
          } else if ("hold" in step) {
            const mapped = toPlaywrightKey(step.hold);
            await page.keyboard.down(mapped);
            held.push(mapped);
            await sleep(step.holdMs, actSignal);
            executedInputSteps += 1;
          } else if ("press" in step) {
            const mapped = toPlaywrightKey(step.press);
            await page.keyboard.down(mapped);
            held.push(mapped);
            await sleep(50, actSignal);
            executedInputSteps += 1;
          } else {
            // ui/inspect steps never reach the runner: act validation refuses
            // them for web sessions before any browser work.
            throw new Error("Unsupported web step: ui and inspect steps are native-only.");
          }
          nominalMs += stepDurationMs(step);
          actSignal?.throwIfAborted();
        }
      } finally {
        for (const key of held.splice(0)) await page.keyboard.up(key).catch(() => undefined);
      }
      const probe = sanitizeProbe(await page.evaluate(READ_STUDIO_STATE).catch(() => null));
      const shot = await page.screenshot({ type: "png" }).catch(() => null);
      const drained = drain();
      return {
        executedInputSteps,
        nominalMs,
        probe,
        screenshotData: shot === null ? "" : shot.toString("base64"),
        consoleMessages: drained.messages,
        consoleTruncated: drained.truncated,
      };
    };
    const close = async (): Promise<void> => {
      await browser.close().catch(() => undefined);
    };
    return {
      viewport: { width: input.width, height: input.height },
      bootMs,
      bootProbe,
      bootConsole: bootDrained.messages,
      act,
      close,
    };
  } catch (cause) {
    await browser.close().catch(() => undefined);
    throw cause;
  }
};

/** Web acts never carry ui or inspect steps: those list native controls. */
export const webStepIssues = (steps: readonly GameExploreStep[]): readonly string[] => {
  const issues: string[] = [];
  for (const [index, step] of steps.entries()) {
    if ("ui" in step)
      issues.push(
        `Step ${index + 1} is a ui step: ui steps list native controls, which a browser game has none of.`,
      );
    else if ("inspect" in step)
      issues.push(
        `Step ${index + 1} is an inspect step: read-only reflection lists native nodes, which a browser game has none of.`,
      );
  }
  return issues;
};
