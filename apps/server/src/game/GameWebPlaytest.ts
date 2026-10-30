// @effect-diagnostics globalTimers:off globalDate:off -- Boot polling and the pause-bridge sleeps run on wall-clock timers; runs are interrupted through an AbortSignal.
// @effect-diagnostics nodeBuiltinImport:off -- This module owns the Playwright browser through the managed executable.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { BrowserContext, Keyboard, Mouse, Page } from "playwright-core";
import {
  GameOperationError,
  GamePlaytestProbe,
  type GameAcceptanceCriterion,
  type GameConsoleMessage,
  type GamePlaytestScreenshot,
  type GamePlaytestStep,
  type GameWebPlaytestResult,
} from "@t3tools/contracts";
import { playtestStepWithEvidence, trailingWaitObservation } from "./playtestInputPairs.ts";
import { runCaptureWindow, type ControlledClock } from "./playtestTiming.ts";
import { sandboxDisabled } from "../preview/PreviewBrowserHost.ts";
import {
  compareFrameSamples,
  FRAME_SAMPLE_HEIGHT,
  FRAME_SAMPLE_WIDTH,
  type FrameSample,
} from "./playtestFrames.ts";
import {
  describePlaytestState,
  evaluatePlaytestRun,
  type GamePlaytestSample,
  summarizePlaytestSamples,
} from "./playtestState.ts";
import { createConsoleCollector } from "./consoleCollector.ts";

export interface GameWebPlaytestInput {
  /** Headless browser executable, resolved the same way as for the preview pane. */
  readonly executable: string;
  /** URL of the served web build. */
  readonly url: string;
  /** Scratch directory handed to `--user-data-dir`; removed again when the run ends. */
  readonly profileDirectory: string;
  readonly width: number;
  readonly height: number;
  readonly bootTimeoutMs: number;
  readonly steps: readonly GamePlaytestStep[];
  readonly captureEveryMs?: number;
  readonly captureAllSteps?: boolean;
  /**
   * INTERNAL experiment-only capture boundary: execute steps before this
   * zero-based index with the exact same clock/input path but take no PNG,
   * sample or interval captures there. Observed suffix keeps original
   * full-route stepIndex values so pairs stay truthful. Only the isolated
   * experiment path may set it; normal qualification and public verify never do.
   */
  readonly captureFromStep?: number;
  /** The engine owes a probe, so qualification reads the probe samples. */
  readonly probeRequired: boolean;
  /** The approved acceptance, or null for a game created without a design. */
  readonly acceptance: readonly GameAcceptanceCriterion[] | null;
}

// Godot's HTML shell keeps #status visible while loading and hides it once the canvas takes over.
// Exported for the persistent exploration driver, which boots the same way.
export const BOOT_CHECK = `(() => {
  const canvas = document.querySelector("canvas");
  const status = document.getElementById("status");
  const hidden =
    !status ||
    status.hidden ||
    status.style.display === "none" ||
    getComputedStyle(status).display === "none" ||
    getComputedStyle(status).visibility === "hidden";
  return Boolean(canvas && canvas.width > 0 && canvas.height > 0 && hidden);
})()`;

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 500;

const isOperationError = Schema.is(GameOperationError);

/**
 * Reads StudioProbe's snapshot. The probe parks the JSON on the window because a
 * JavaScriptBridge callback's return value does not cross back into JavaScript;
 * the return value is still accepted for templates that can return one.
 */
export const READ_PROBE = `(() => {
  const probe = window.__studioProbe;
  if (typeof probe !== "function") return null;
  try {
    window.__studioProbeLast = null;
    const returned = probe();
    if (typeof returned === "string") return returned;
    return typeof window.__studioProbeLast === "string" ? window.__studioProbeLast : null;
  } catch (error) {
    return null;
  }
})()`;
export const decodeProbe = Schema.decodeUnknownOption(Schema.fromJsonString(GamePlaytestProbe));

/**
 * The pause bridge's parked ack, the driver's window into whether the game's
 * StudioProbe really applied a requested visibility. The probe parks the same
 * object it postMessages to the parent document, so the driver tests the
 * identical contract the stage's play surface runs against.
 */
const READ_VISIBILITY_ACK = `(() => {
  const ack = window.__studioVisibilityAck;
  if (ack === null || typeof ack !== "object") return null;
  return { visible: ack.visible === true, paused: ack.paused === true, muted: ack.muted === true };
})()`;

const sendVisibility = (visible: boolean): string =>
  `window.postMessage({ type: "studio-visibility", visible: ${visible} }, "*")`;

/** Centre of the game canvas in viewport coordinates, or null before it exists. Exported for the persistent exploration driver. */
export const CANVAS_CENTRE = `(() => {
  const canvas = document.querySelector("canvas");
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
})()`;

/**
 * Downscales the game canvas into a small RGBA buffer. Reading the canvas is
 * cheaper and steadier than decoding two PNG screenshots, and it samples the
 * same rendered frame the screenshots capture.
 */
export const SAMPLE_FRAME = `(() => {
  const canvas = document.querySelector("canvas");
  if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
  const sample = document.createElement("canvas");
  sample.width = ${FRAME_SAMPLE_WIDTH};
  sample.height = ${FRAME_SAMPLE_HEIGHT};
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(canvas, 0, 0, sample.width, sample.height);
  return Array.from(context.getImageData(0, 0, sample.width, sample.height).data);
})()`;

/** Playwright needs its files on disk; createRequire also resolves it from a Node SEA executable. */
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

/**
 * The browser key name Playwright's keyboard expects. The route vocabulary
 * uses the DOM name "Space"; Playwright (and the DOM key value) wants " ".
 * Every other route key already names the physical key Playwright accepts.
 */
export const toPlaywrightKey = (key: string): string => (key === "Space" ? " " : key);

export type PlaywrightKeyboard = Pick<Keyboard, "down" | "up">;
export type PlaywrightMouse = Pick<Mouse, "move" | "down" | "up" | "click">;

/**
 * Holds keys for a nominal duration on the controlled clock, always releasing
 * them. The hold advances only through `clock.runFor`; captures and wall-clock
 * round trips while paused never stretch it. Cleanup runs even on abort or a
 * clock failure, so a cancelled run never leaves a key stuck down.
 */
export const holdKeysWithClock = async (input: {
  readonly keyboard: PlaywrightKeyboard;
  readonly clock: ControlledClock;
  readonly signal?: AbortSignal | undefined;
  readonly keys: readonly string[];
  readonly holdMs: number;
  readonly captureEveryMs?: number | undefined;
  readonly capture?: ((elapsedMs: number) => Promise<void>) | undefined;
}): Promise<void> => {
  const pressed: string[] = [];
  let releaseError: unknown;
  try {
    for (const key of input.keys.map(toPlaywrightKey)) {
      await input.keyboard.down(key);
      pressed.push(key);
    }
    await runCaptureWindow({
      duration: input.holdMs,
      ...(input.captureEveryMs === undefined ? {} : { captureInterval: input.captureEveryMs }),
      clock: input.clock,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.capture === undefined ? {} : { capture: input.capture }),
    });
  } finally {
    for (const key of pressed.toReversed()) {
      try {
        await input.keyboard.up(key);
      } catch (cause) {
        releaseError ??= cause;
      }
    }
  }
  if (releaseError !== undefined) throw releaseError;
};

/**
 * Drags from one point to another over a nominal duration on the controlled
 * clock, always releasing the button. Pointer fractions advance only through
 * `clock.runFor`; the button release runs even on abort or clock failure.
 */
export const dragWithClock = async (input: {
  readonly mouse: PlaywrightMouse;
  readonly clock: ControlledClock;
  readonly signal?: AbortSignal | undefined;
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
  readonly holdMs: number;
  readonly captureEveryMs?: number | undefined;
  readonly capture?: ((elapsedMs: number) => Promise<void>) | undefined;
}): Promise<void> => {
  await input.mouse.move(input.from.x, input.from.y);
  await input.mouse.down({ button: "left" });
  let releaseError: unknown;
  try {
    await runCaptureWindow({
      duration: input.holdMs,
      ...(input.captureEveryMs === undefined ? {} : { captureInterval: input.captureEveryMs }),
      clock: input.clock,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      move: async (fraction) => {
        await input.mouse.move(
          input.from.x + (input.to.x - input.from.x) * fraction,
          input.from.y + (input.to.y - input.from.y) * fraction,
        );
        input.signal?.throwIfAborted();
      },
      ...(input.capture === undefined ? {} : { capture: input.capture }),
    });
  } finally {
    try {
      await input.mouse.up({ button: "left" });
    } catch (cause) {
      releaseError = cause;
    }
  }
  if (releaseError !== undefined) throw releaseError;
};

export const sleep = (signal: AbortSignal | undefined, ms: number) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** PNG IHDR guard, so screenshot dimensions never read past a truncated file. */
export const decodePngSize = (bytes: Buffer) => {
  if (bytes.length < 24 || bytes.subarray(1, 4).toString("ascii") !== "PNG")
    throw new Error("Screenshot did not decode as a PNG.");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

export const screenshot = async (
  page: Page,
  label: string,
  probe: GamePlaytestProbe | null,
): Promise<GamePlaytestScreenshot> => {
  const bytes = await page.screenshot({ type: "png" });
  const data = bytes.toString("base64");
  return {
    label,
    mimeType: "image/png" as const,
    data,
    ...decodePngSize(bytes),
    ...(probe === null ? {} : { probe }),
  };
};

export const canvasCentre = async (page: Page): Promise<{ x: number; y: number } | null> => {
  try {
    const centre = await page.evaluate(CANVAS_CENTRE);
    if (
      centre !== null &&
      typeof centre === "object" &&
      typeof (centre as { x?: unknown }).x === "number" &&
      typeof (centre as { y?: unknown }).y === "number"
    )
      return centre as { x: number; y: number };
    return null;
  } catch {
    return null;
  }
};

export const sampleFrame = async (page: Page): Promise<FrameSample | null> => {
  try {
    const data = await page.evaluate(SAMPLE_FRAME);
    if (!Array.isArray(data)) return null;
    return { width: FRAME_SAMPLE_WIDTH, height: FRAME_SAMPLE_HEIGHT, data };
  } catch {
    return null;
  }
};

/**
 * Presses and releases one mouse button at the centre of the canvas. Web games need
 * a real click before the shell lets them capture the pointer, and menu buttons need
 * one to be pressed at all. Exported for the persistent exploration driver.
 */
export const clickCanvas = async (
  page: Page,
  button: "left" | "middle" | "right",
): Promise<{ x: number; y: number } | null> => {
  const centre = await canvasCentre(page);
  if (!centre) return null;
  const at = { x: Math.round(centre.x), y: Math.round(centre.y) };
  await page.mouse.click(at.x, at.y, { button });
  return at;
};

/**
 * Exercising the pause bridge like the stage's play surface: one hide, one
 * show, decided by the probe's acks. A game that never answers — an old probe
 * or a bridge that does not pause and mute as promised — reads as unconfirmed
 * rather than as a crashed run; the honest tool reports what it could verify.
 */
const readVisibilityAck = async (
  page: Page,
): Promise<{ visible: boolean; paused: boolean; muted: boolean } | null> => {
  try {
    const ack = (await page.evaluate(READ_VISIBILITY_ACK)) as {
      visible?: unknown;
      paused?: unknown;
      muted?: unknown;
    } | null;
    if (ack === null || typeof ack !== "object") return null;
    return {
      visible: ack.visible === true,
      paused: ack.paused === true,
      muted: ack.muted === true,
    };
  } catch {
    return null;
  }
};

const waitForVisibilityAck = async (
  page: Page,
  visible: boolean,
  signal: AbortSignal | undefined,
): Promise<{ visible: boolean; paused: boolean; muted: boolean } | null> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await sleep(signal, 120);
    const ack = await readVisibilityAck(page);
    if (ack !== null && ack.visible === visible) return ack;
  }
  return null;
};

export const verifyPauseBridge = async (
  page: Page,
  signal: AbortSignal | undefined,
): Promise<boolean> => {
  /** The GameState JSON as the probe just reported it, or null when it cannot. */
  const probeState = async (): Promise<string | null> => {
    try {
      const value = await page.evaluate(READ_PROBE);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  };
  try {
    await page.evaluate(sendVisibility(false));
    const hiddenAck = await waitForVisibilityAck(page, false, signal);
    if (hiddenAck === null || !hiddenAck.paused || !hiddenAck.muted) return false;
    // The ack is the engine's word about itself; this is the world's word: two
    // spaced probe reads while hidden must show the same GameState, so the
    // per-frame clocks the probe reports are held, not just claimed held. A
    // game that genuinely ticks a value while hidden keeps this unconfirmed.
    const held = await probeState();
    await sleep(signal, 700);
    const stillHeld = await probeState();
    if (held === null || stillHeld === null || held !== stillHeld) return false;
    await page.evaluate(sendVisibility(true));
    const shownAck = await waitForVisibilityAck(page, true, signal);
    return shownAck !== null && !shownAck.paused && !shownAck.muted;
  } catch {
    // A page that interrupts evaluation (a reload, a navigation) cannot confirm.
    return false;
  }
};

export const clockError = (cause: unknown): GameOperationError =>
  new GameOperationError({
    operation: "Web playtest",
    path: "",
    reason: "command-failed",
    detail:
      `The controlled clock is unavailable in this browser and the run stayed paused instead of guessing: ${
        cause instanceof Error ? cause.message : String(cause)
      }`.slice(0, 1000),
    ...(cause === undefined ? {} : { cause }),
  });

export const launchContext = async (input: {
  readonly executable: string;
  readonly profileDirectory: string;
  readonly width: number;
  readonly height: number;
}): Promise<BrowserContext> => {
  const { chromium } = loadPlaywright();
  const env = process.env;
  // Same sandbox switch HtmlRender uses, so the operator keeps one policy.
  // Playwright's chromiumSandbox option carries it instead of a raw flag.
  const context = await chromium.launchPersistentContext(input.profileDirectory, {
    executablePath: input.executable,
    headless: true,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--mute-audio",
      "--hide-scrollbars",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-dev-shm-usage",
    ],
    chromiumSandbox: !sandboxDisabled(env),
    viewport: { width: input.width, height: input.height },
  });
  return context;
};

/** Drives one browser run to completion; the caller's acquire/release finalizers own cleanup. */
const runPlaytest = async (
  context: BrowserContext,
  input: GameWebPlaytestInput,
  signal: AbortSignal | undefined,
): Promise<GameWebPlaytestResult> => {
  signal?.throwIfAborted();
  const page = context.pages()[0] ?? (await context.newPage());
  // The viewport the route was recorded at; pointer coordinates are pixels in it.
  await page.setViewportSize({ width: input.width, height: input.height });
  // Bounded retention with honest accounting: the error total counts every
  // error ever recorded, so a failure emitted after forty ordinary logs
  // still fails the run even though its text was not kept.
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
    const level: GameConsoleMessage["level"] =
      type === "error"
        ? "error"
        : type === "warning"
          ? "warning"
          : type === "info"
            ? "info"
            : "log";
    const text = message.text().trim();
    record(level, text || `console ${type}()`);
  });
  page.on("pageerror", (error) => {
    record("error", error instanceof Error ? error.message : String(error));
  });
  const screenshots: GamePlaytestScreenshot[] = [];
  try {
    // Install the fake clock before the game's time APIs start so Date,
    // performance, timers and requestAnimationFrame are all controlled. Boot
    // and the pause bridge then behave naturally while the clock runs.
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
        const check = await page.evaluate(BOOT_CHECK);
        if (check === true) {
          booted = true;
          break;
        }
      } catch {
        // Evaluations race the page navigation; keep polling until the deadline.
      }
    }
    if (booted) bootMs = input.bootTimeoutMs - (bootDeadline - Date.now());
    // The state probe is optional: games created before it existed have none, and
    // a scene change can make one evaluation fail, so a sample is best-effort.
    // Samples carry what made the recorder take them: only input the game can
    // receive as player input proves the game was played, so the first key,
    // click or mouse-move step turns the marker on and it stays on.
    const samples: GamePlaytestSample[] = [];
    let sawInput = false;
    const readProbe = async () => {
      let value: unknown;
      try {
        value = await page.evaluate(READ_PROBE);
      } catch {
        return null;
      }
      if (typeof value !== "string") return null;
      const probe = decodeProbe(value);
      if (Option.isNone(probe)) return null;
      samples.push({ probe: probe.value, afterInput: sawInput });
      return probe.value;
    };
    const latestProbe = () => samples.findLast((sample) => sample.probe)?.probe ?? null;
    screenshots.push(await screenshot(page, "booted", null));
    const bootSample = await sampleFrame(page).catch(() => null);
    let pointer: { x: number; y: number } | null = null;
    await readProbe();
    // Games whose policy owes the probe owe its pause bridge too; run the
    // round trip once, before any step and before the clock pauses, so the
    // samples never span a pause.
    let pauseConfirmed: boolean | null = null;
    if (booted && input.probeRequired && samples.length > 0)
      pauseConfirmed = await verifyPauseBridge(page, signal);

    // Pause after boot and the bridge: from here game time advances only
    // through explicit clock.runFor slices for waits, holds, presses and
    // drags. Screenshots, probe reads and frame samples stay paused, so their
    // wall-clock cost never runs the game. No Node wall-offset bookkeeping.
    try {
      const now = await page.evaluate(`Date.now()`);
      const at = typeof now === "number" && Number.isFinite(now) ? now + 100 : Date.now() + 100;
      await page.clock.pauseAt(at);
    } catch (cause) {
      throw clockError(cause);
    }

    let executedInputSteps = 0;
    const clock: ControlledClock = {
      runFor: async (milliseconds) => {
        try {
          await page.clock.runFor(milliseconds);
        } catch (cause) {
          throw clockError(cause);
        }
      },
    };
    const captureFrom = input.captureFromStep ?? 0;
    if (!Number.isInteger(captureFrom) || captureFrom < 0 || captureFrom > input.steps.length)
      throw new Error(
        `captureFromStep ${String(input.captureFromStep)} is outside the route of ${input.steps.length} steps.`,
      );
    const executeStep = async (
      step: GamePlaytestStep,
      captureDuring?: (elapsed: number) => Promise<void>,
    ): Promise<boolean> => {
      if (!("waitMs" in step) && !("screenshot" in step)) sawInput = true;
      if ("waitMs" in step) {
        await runCaptureWindow({
          duration: step.waitMs,
          clock,
          ...(input.captureEveryMs === undefined ? {} : { captureInterval: input.captureEveryMs }),
          ...(signal === undefined ? {} : { signal }),
          ...(captureDuring === undefined ? {} : { capture: captureDuring }),
        });
      } else if ("screenshot" in step) {
        if (captureDuring === undefined) return false;
        screenshots.push(await screenshot(page, step.screenshot, latestProbe()));
        // The frame itself is the step's product; the next read pairs the probe
        // that follows it, not the one before it.
        await readProbe();
        return false;
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
        if (clicked === null) return false;
      } else if ("drag" in step) {
        const { from, to } = step.drag;
        await dragWithClock({
          mouse: page.mouse,
          clock,
          signal,
          from,
          to,
          holdMs: step.holdMs,
          captureEveryMs: input.captureEveryMs,
          ...(captureDuring === undefined ? {} : { capture: captureDuring }),
        });
        pointer = to;
      } else if ("mouseMove" in step) {
        const centre: { x: number; y: number } | null = pointer ?? (await canvasCentre(page));
        if (centre) {
          const next: { x: number; y: number } = {
            x: Math.max(0, Math.min(input.width, centre.x + step.mouseMove.dx)),
            y: Math.max(0, Math.min(input.height, centre.y + step.mouseMove.dy)),
          };
          await page.mouse.move(Math.round(next.x), Math.round(next.y));
          pointer = next;
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
          signal,
          keys,
          holdMs: "holdMs" in step ? step.holdMs : 50,
          captureEveryMs: input.captureEveryMs,
          ...(captureDuring === undefined ? {} : { capture: captureDuring }),
        });
      }
      return !("waitMs" in step) && !("screenshot" in step) && !("mouseMove" in step);
    };
    // Uncaptured prelude: the exact same clock/input path (holds, releases,
    // drags, waits, cancellation) but no PNG, sample or interval captures and
    // no probe reads. Each declared wait runs once, in order; no observation
    // window folds across the capture boundary.
    for (let setupIndex = 0; setupIndex < captureFrom; setupIndex += 1) {
      const step = input.steps[setupIndex]!;
      signal?.throwIfAborted();
      const paired = await playtestStepWithEvidence({
        step,
        stepIndex: setupIndex,
        skipCapture: true,
        capture: async () => {
          throw new Error("setup steps must not capture");
        },
        execute: () => executeStep(step),
      });
      if (paired.executed) executedInputSteps++;
      signal?.throwIfAborted();
    }
    let stepIndex = captureFrom;
    while (stepIndex < input.steps.length) {
      const step = input.steps[stepIndex]!;
      signal?.throwIfAborted();
      const duringFrames: GamePlaytestScreenshot[] = [];
      const captureDuringFor = (labelStepIndex: number) => async (elapsed: number) => {
        signal?.throwIfAborted();
        duringFrames.push(
          await screenshot(
            page,
            `step ${labelStepIndex + 1} during: ${elapsed}ms`,
            await readProbe(),
          ),
        );
      };
      const captureDuring = captureDuringFor(stepIndex);
      const waitWithCapturesAt = async (labelStepIndex: number, duration: number) =>
        runCaptureWindow({
          duration,
          ...(input.captureEveryMs === undefined ? {} : { captureInterval: input.captureEveryMs }),
          clock,
          ...(signal === undefined ? {} : { signal }),
          capture: captureDuringFor(labelStepIndex),
        });
      // Observe release-queued effects during declared waits without adding
      // game time or extending holds. captureAllSteps keeps wait pairs separate.
      let observationCount = 0;
      let observationDelayMs = 0;
      if (!("waitMs" in step) && !("screenshot" in step) && input.captureAllSteps !== true) {
        const trailing = trailingWaitObservation(input.steps, stepIndex + 1);
        observationCount = trailing.count;
        observationDelayMs = trailing.delayMs;
      }
      const paired = await playtestStepWithEvidence({
        step,
        stepIndex,
        ...(input.captureAllSteps === undefined ? {} : { captureAllSteps: input.captureAllSteps }),
        ...(observationCount > 0
          ? {
              observation: {
                delayMs: observationDelayMs,
                observedAfterStepIndex: stepIndex + observationCount,
              },
            }
          : {}),
        capture: async () => {
          signal?.throwIfAborted();
          const probe = await readProbe();
          return {
            screenshot: await screenshot(page, "input", probe),
            pixels: await sampleFrame(page).catch(() => null),
            probe,
          };
        },
        execute: async () => {
          const executed = await executeStep(step, captureDuring);
          for (let consumed = 1; consumed <= observationCount; consumed += 1) {
            const waited = input.steps[stepIndex + consumed]!;
            if (!("waitMs" in waited)) break;
            await waitWithCapturesAt(stepIndex + consumed, waited.waitMs);
          }
          return executed;
        },
      });
      if (paired.executed) executedInputSteps++;
      screenshots.push(...paired.frames.slice(0, 1), ...duringFrames, ...paired.frames.slice(1));
      signal?.throwIfAborted();
      await readProbe();
      stepIndex += 1 + observationCount;
    }
    // Still paused: the final frame and samples cost wall time but no game time.
    screenshots.push(await screenshot(page, "after-steps", latestProbe()));
    const afterSample = await sampleFrame(page).catch(() => null);
    await readProbe();
    const comparison =
      bootSample !== null && afterSample !== null
        ? compareFrameSamples(bootSample, afterSample)
        : { changedPercent: 0, responded: false };
    const state =
      samples.length === 0
        ? null
        : // One summary serves both the report and the evidence: the same
          // baseline-inclusive picture evaluatePlaytestRun judges.
          summarizePlaytestSamples(samples);
    // Total errors across the whole run, not just the retained suffix: a
    // failure after forty ordinary logs still counts. The retained text is
    // the newest slice; consoleTruncated says how much older text was dropped.
    const errors = consoleCollector.totalErrors();
    const consoleMessages = consoleCollector.messages();
    const consoleTruncated = consoleCollector.dropped();
    const stepsGiven = input.steps.length > 0;
    const verdict = evaluatePlaytestRun({
      samples,
      stepsGiven,
      booted,
      responded: comparison.responded,
      consoleErrors: errors,
      probeRequired: input.probeRequired,
      acceptance: input.acceptance,
    });

    const success = booted && errors === 0 && (!stepsGiven || comparison.responded);
    const summary = [
      booted ? `Booted in ${bootMs}ms` : `Did not boot within ${input.bootTimeoutMs}ms`,
      errors === 0 ? "no console errors" : `${errors} console error(s)`,
      `${input.steps.length} step(s)`,
      comparison.responded
        ? `the game responded (${comparison.changedPercent}% of pixels changed)`
        : `the game did not respond (${comparison.changedPercent}% of pixels changed)`,
      ...(pauseConfirmed === null
        ? []
        : [pauseConfirmed ? "pauses hidden: yes" : "pauses hidden: not confirmed"]),
      `state: ${describePlaytestState(state)}`,
      ...(state?.notOnScreen === undefined
        ? []
        : [
            state.notOnScreen.length === 0
              ? "every GameState value is on screen"
              : `not on screen: ${state.notOnScreen.join(", ")}`,
          ]),
    ].join("; ");
    return {
      success,
      executedInputSteps,
      booted,
      bootMs: booted ? bootMs : null,
      responded: comparison.responded,
      changedPercent: comparison.changedPercent,
      message: success ? `Playtest succeeded: ${summary}` : `Playtest failed: ${summary}`,
      consoleMessages,
      consoleErrorCount: errors,
      consoleTruncated,
      screenshots,
      state,
      pauseConfirmed,
      qualifies: verdict.qualifies,
      blockers: [...verdict.blockers],
      interaction: verdict.interaction,
      timing: "controlled-clock",
    };
  } finally {
    page.removeAllListeners();
    await context.close().catch(() => undefined);
  }
};

const operationError = (input: GameWebPlaytestInput) => (cause: unknown) =>
  new GameOperationError({
    operation: "playtest",
    path: input.profileDirectory,
    reason: "command-failed",
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

export const playtest = (
  input: GameWebPlaytestInput,
): Effect.Effect<GameWebPlaytestResult, GameOperationError> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        NodeFSP.mkdir(input.profileDirectory, { recursive: true }).then(
          () => input.profileDirectory,
        ),
      catch: operationError(input),
    }),
    () =>
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => launchContext(input),
          catch: operationError(input),
        }),
        (context: BrowserContext) =>
          Effect.tryPromise({
            try: (signal) => runPlaytest(context, input, signal),
            catch: (cause) => (isOperationError(cause) ? cause : operationError(input)(cause)),
          }),
        (context) => Effect.promise(() => context.close().catch(() => undefined)),
      ).pipe(Effect.scoped),
    (profileDirectory) =>
      Effect.promise(() => NodeFSP.rm(profileDirectory, { recursive: true, force: true })),
  );

/**
 * The playtest seam. Production runs the real browser; service tests provide a
 * fake through `layerOf` so qualification rules stay deterministic without Chrome.
 */
export class GamePlaytest extends Context.Service<
  GamePlaytest,
  { readonly run: typeof playtest }
>()("t3/game/GameWebPlaytest/GamePlaytest") {}

export const layer = Layer.succeed(GamePlaytest, GamePlaytest.of({ run: playtest }));
export const layerOf = (run: typeof playtest) =>
  Layer.succeed(GamePlaytest, GamePlaytest.of({ run }));
