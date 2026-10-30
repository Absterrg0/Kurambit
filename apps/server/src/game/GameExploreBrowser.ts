// @effect-diagnostics nodeBuiltinImport:off -- This module owns the Playwright browser through the managed executable.
// @effect-diagnostics globalDate:off globalTimers:off -- Boot polling and the pause bridge run on wall-clock timers like the one-shot driver; runs are interrupted through an AbortSignal.
import * as NodeFSP from "node:fs/promises";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { Page } from "playwright-core";
import {
  type GameConsoleMessage,
  type GamePlaytestProbe,
  type GamePlaytestStep,
} from "@t3tools/contracts";
import {
  BOOT_CHECK,
  READ_PROBE,
  canvasCentre,
  clickCanvas,
  clockError,
  decodeProbe,
  dragWithClock,
  holdKeysWithClock,
  launchContext,
  screenshot,
  sleep,
  verifyPauseBridge,
} from "./GameWebPlaytest.ts";
import { createConsoleCollector } from "./consoleCollector.ts";
import { runCaptureWindow, type ControlledClock } from "./playtestTiming.ts";

export interface ExploreBrowserOpenInput {
  readonly executable: string;
  readonly url: string;
  readonly profileDirectory: string;
  readonly width: number;
  readonly height: number;
  readonly bootTimeoutMs: number;
}

export interface ExploreBrowserBoot {
  readonly booted: boolean;
  readonly bootMs: number | null;
  readonly probe: GamePlaytestProbe | null;
  /** Null when the check did not run; false only means unconfirmed, never a crash. */
  readonly pauseConfirmed: boolean | null;
  readonly consoleMessages: readonly GameConsoleMessage[];
}

export interface ExploreBrowserObservation {
  readonly executedInputSteps: number;
  readonly nominalMs: number;
  readonly probe: GamePlaytestProbe | null;
  readonly screenshotData: string;
  readonly screenshotWidth: number;
  readonly screenshotHeight: number;
  /** Console messages since the previous act, bounded. */
  readonly consoleMessages: readonly GameConsoleMessage[];
  readonly consoleTruncated?: number;
}

export interface ExploreBrowserHandle {
  /** Executes steps on the controlled clock and samples one observation after. */
  readonly act: (
    steps: readonly GamePlaytestStep[],
    firstStepIndex: number,
    signal?: AbortSignal,
  ) => Promise<ExploreBrowserObservation>;
  readonly close: () => Promise<void>;
}

export type ExploreBrowserOpen = (
  input: ExploreBrowserOpenInput,
  signal?: AbortSignal,
) => Promise<{ readonly handle: ExploreBrowserHandle; readonly boot: ExploreBrowserBoot }>;

/**
 * The headless-browser seam. Production uses `openBrowser` below through
 * `layer`; tests inject a fake through `layerOf` so no browser launches.
 */
export class GameExploreBrowser extends Context.Service<
  GameExploreBrowser,
  { readonly open: ExploreBrowserOpen }
>()("t3/game/GameExploreBrowser") {}

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 500;

const readProbe = async (page: Page): Promise<GamePlaytestProbe | null> => {
  let value: unknown;
  try {
    value = await page.evaluate(READ_PROBE);
  } catch {
    return null;
  }
  if (typeof value !== "string") return null;
  const decoded = decodeProbe(value);
  return decoded._tag === "Some" ? decoded.value : null;
};

const openBrowser: ExploreBrowserOpen = async (input, signal) => {
  signal?.throwIfAborted();
  await NodeFSP.mkdir(input.profileDirectory, { recursive: true });
  const context = await launchContext({
    executable: input.executable,
    profileDirectory: input.profileDirectory,
    width: input.width,
    height: input.height,
  }).catch(async (cause) => {
    // A launch that races an abort must not leave a context behind.
    if (signal?.aborted) throw new Error("aborted");
    throw cause;
  });
  // The launch itself cannot take an abort; a caller that cancelled while it
  // was in flight closes what it opened instead of leaking a browser.
  if (signal?.aborted) {
    await context.close().catch(() => undefined);
    throw new Error("aborted");
  }
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize({ width: input.width, height: input.height });
    // Shared bounded collector: newest forty messages retained, every error
    // counted, drops reported per act. Same accounting as the one-shot driver.
    const consoleCollector = createConsoleCollector({
      maxMessages: MAX_MESSAGES,
      maxChars: MAX_MESSAGE_CHARS,
    });
    let engineCookie = false;
    const record = (level: GameConsoleMessage["level"], text: string) => {
      const message = text.slice(0, MAX_MESSAGE_CHARS);
      if (message.includes("Godot Engine v4")) engineCookie = true;
      consoleCollector.record(level, message);
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
    try {
      try {
        await page.clock.install();
      } catch (cause) {
        throw clockError(cause);
      }
      await page.goto(input.url, { timeout: input.bootTimeoutMs, waitUntil: "load" });
      const bootDeadline = Date.now() + input.bootTimeoutMs;
      let booted = false;
      let bootMs: number | null = null;
      while (!booted && Date.now() < bootDeadline) {
        await sleep(signal, 500);
        signal?.throwIfAborted();
        if (engineCookie) {
          booted = true;
          break;
        }
        try {
          if ((await page.evaluate(BOOT_CHECK)) === true) {
            booted = true;
            break;
          }
        } catch {
          // Evaluations race the page navigation; keep polling until the deadline.
        }
      }
      if (booted) bootMs = input.bootTimeoutMs - (bootDeadline - Date.now());
      const bootProbe = await readProbe(page);
      // The same pause round trip the one-shot driver runs: hidden must pause
      // and mute, shown must resume. Unconfirmed reads as unconfirmed, and the
      // session stays usable either way.
      const pauseConfirmed =
        booted && bootProbe !== null ? await verifyPauseBridge(page, signal) : null;
      try {
        const now = await page.evaluate(`Date.now()`);
        const at = typeof now === "number" && Number.isFinite(now) ? now + 100 : Date.now() + 100;
        await page.clock.pauseAt(at);
      } catch (cause) {
        throw clockError(cause);
      }
      const clock: ControlledClock = {
        runFor: async (milliseconds) => {
          try {
            await page.clock.runFor(milliseconds);
          } catch (cause) {
            throw clockError(cause);
          }
        },
      };
      // The runtime stays paused between calls: only explicit runFor slices
      // advance game time, so captures and probe reads cost no game time.
      let pointer: { x: number; y: number } | null = null;
      const act: ExploreBrowserHandle["act"] = async (steps, firstStepIndex, actSignal) => {
        actSignal?.throwIfAborted();
        // The session still threads the global index for trace order; the
        // single final observation needs no per-step index.
        void firstStepIndex;
        let executedInputSteps = 0;
        let nominalMs = 0;
        const stepDuration = (step: GamePlaytestStep): number => {
          if ("press" in step) return 50;
          if ("waitMs" in step) return step.waitMs;
          if ("holdMs" in step) return step.holdMs;
          return 0;
        };
        // One observation after the whole act already sees every trailing
        // wait, so steps run in order with no folding and one final capture.
        for (const step of steps) {
          actSignal?.throwIfAborted();
          let executed: boolean;
          if ("waitMs" in step) {
            await runCaptureWindow({ duration: step.waitMs, clock, signal: actSignal });
            executed = false;
          } else if ("screenshot" in step) {
            // The act's single persisted frame is the observation; a
            // labelled mid-route capture adds no second persisted image.
            executed = false;
          } else if ("click" in step) {
            const clicked =
              step.x === undefined || step.y === undefined
                ? await clickCanvas(page, step.click)
                : await (async () => {
                    const point = { x: step.x!, y: step.y! };
                    await page.mouse.click(point.x, point.y, {
                      button: step.click,
                      clickCount: 1,
                    });
                    return point;
                  })();
            pointer = clicked ?? pointer;
            executed = clicked !== null;
          } else if ("drag" in step) {
            const { from, to } = step.drag;
            await dragWithClock({
              mouse: page.mouse,
              clock,
              signal: actSignal,
              from,
              to,
              holdMs: step.holdMs,
            });
            pointer = to;
            executed = true;
          } else if ("mouseMove" in step) {
            const centre: { x: number; y: number } | null = pointer ?? (await canvasCentre(page));
            if (centre) {
              const next = {
                x: Math.max(0, Math.min(input.width, centre.x + step.mouseMove.dx)),
                y: Math.max(0, Math.min(input.height, centre.y + step.mouseMove.dy)),
              };
              await page.mouse.move(Math.round(next.x), Math.round(next.y));
              pointer = next;
              executed = true;
            } else {
              executed = false;
            }
          } else {
            try {
              await page.evaluate(`document.querySelector("canvas")?.focus()`);
            } catch {
              // The canvas may not be up yet; keyboard events still reach the document.
            }
            const keys =
              "keys" in step
                ? step.keys
                : ["key" in step ? step.key : "hold" in step ? step.hold : step.press];
            await holdKeysWithClock({
              keyboard: page.keyboard,
              clock,
              signal: actSignal,
              keys,
              holdMs: "holdMs" in step ? step.holdMs : 50,
            });
            executed = true;
          }
          if (executed) executedInputSteps++;
          nominalMs += stepDuration(step);
          actSignal?.throwIfAborted();
        }
        const probe = await readProbe(page);
        const shot = await screenshot(page, "explore", probe);
        const drained = consoleCollector.drain();
        return {
          executedInputSteps,
          nominalMs,
          probe,
          screenshotData: shot.data,
          screenshotWidth: shot.width,
          screenshotHeight: shot.height,
          consoleMessages: drained.messages,
          consoleTruncated: drained.dropped,
        };
      };
      const close = async () => {
        page.removeAllListeners();
        await context.close().catch(() => undefined);
      };
      const drained = consoleCollector.drain();
      const boot: ExploreBrowserBoot = {
        booted,
        bootMs,
        probe: bootProbe,
        pauseConfirmed,
        consoleMessages: drained.messages,
      };
      return { handle: { act, close }, boot };
    } catch (cause) {
      await context.close().catch(() => undefined);
      throw cause;
    }
  } catch (cause) {
    await context.close().catch(() => undefined);
    throw cause;
  }
};

export const layer = Layer.succeed(
  GameExploreBrowser,
  GameExploreBrowser.of({ open: openBrowser }),
);
export const layerOf = (open: ExploreBrowserOpen) =>
  Layer.succeed(GameExploreBrowser, GameExploreBrowser.of({ open }));
