// @effect-diagnostics globalTimers:off globalDate:off -- Boot polling and kill escalation run on wall-clock timers; runs are interrupted through an AbortSignal.
// @effect-diagnostics nodeBuiltinImport:off -- This module owns the browser process and the raw DevTools WebSocket boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  GameOperationError,
  GamePlaytestProbe,
  type GameAcceptanceCriterion,
  type GameConsoleMessage,
  type GamePlaytestScreenshot,
  type GamePlaytestStep,
  type GameWebPlaytestResult,
} from "@t3tools/contracts";
import { playtestStepWithEvidence } from "./playtestInputPairs.ts";
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
  /** The engine owes a probe, so qualification reads the probe samples. */
  readonly probeRequired: boolean;
  /** The approved acceptance, or null for a game created without a design. */
  readonly acceptance: readonly GameAcceptanceCriterion[] | null;
}

// Godot's HTML shell keeps #status visible while loading and hides it once the canvas takes over.
const BOOT_CHECK = `(() => {
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
const CONNECT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Reads StudioProbe's snapshot. The probe parks the JSON on the window because a
 * JavaScriptBridge callback's return value does not cross back into JavaScript;
 * the return value is still accepted for templates that can return one.
 */
const READ_PROBE = `(() => {
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
const decodeProbe = Schema.decodeUnknownOption(Schema.fromJsonString(GamePlaytestProbe));

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

interface BrowserHandle {
  readonly child: NodeChildProcess.ChildProcess;
  readonly wsUrl: Promise<string>;
}

interface CdpSocket {
  send: <T>(method: string, params?: object, sessionId?: string) => Promise<T>;
  onSession: (
    sessionId: string,
    handle: (message: { method: string; params: any }) => void,
  ) => void;
  close: () => void;
}

interface KeyEvent {
  readonly type: "keyDown" | "keyUp";
  readonly key: string;
  readonly code: string;
  readonly windowsVirtualKeyCode: number;
  readonly text?: string;
}

/** KeyboardEvent names DevTools expects; unknown keys fall back to the DOM name alone. */ const keyEvent =
  (key: string, type: "keyDown" | "keyUp"): KeyEvent => {
    const named: Record<string, KeyEvent> = {
      ArrowUp: { type, key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
      ArrowDown: { type, key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
      ArrowLeft: { type, key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
      ArrowRight: { type, key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
      Space: { type, key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
      Enter: { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
      Tab: { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
      Backspace: { type, key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
      Escape: { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
      Shift: { type, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 },
      Control: { type, key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
      Alt: { type, key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 },
    };
    const held = named[key] ?? (key === " " ? named.Space : undefined);
    if (held) return held;
    if (key.length === 1 && /[a-z]/.test(key)) {
      return {
        type,
        key,
        code: `Key${key.toUpperCase()}`,
        windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
        text: key,
      };
    }
    if (key.length === 1 && /[A-Z]/.test(key)) {
      return { type, key, code: `Key${key}`, windowsVirtualKeyCode: key.charCodeAt(0), text: key };
    }
    if (key.length === 1 && /[0-9]/.test(key)) {
      return { type, key, code: `Digit${key}`, windowsVirtualKeyCode: 48 + Number(key), text: key };
    }
    return { type, key, code: key, windowsVirtualKeyCode: 0 };
  };

/** Centre of the game canvas in viewport coordinates, or null before it exists. */
const CANVAS_CENTRE = `(() => {
  const canvas = document.querySelector("canvas");
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
})()`;

const canvasCentre = async (
  cdp: CdpSocket,
  sessionId: string,
): Promise<{ x: number; y: number } | null> => {
  const evaluated = await cdp.send<{ result?: { value?: { x: number; y: number } | null } }>(
    "Runtime.evaluate",
    { expression: CANVAS_CENTRE, returnByValue: true },
    sessionId,
  );
  const centre = evaluated.result?.value;
  return centre ?? null;
};

/**
 * Downscales the game canvas into a small RGBA buffer. Reading the canvas is
 * cheaper and steadier than decoding two PNG screenshots, and it samples the
 * same rendered frame the screenshots capture.
 */
const SAMPLE_FRAME = `(() => {
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

const sampleFrame = async (cdp: CdpSocket, sessionId: string): Promise<FrameSample | null> => {
  const evaluated = await cdp.send<{ result?: { value?: number[] | null } }>(
    "Runtime.evaluate",
    { expression: SAMPLE_FRAME, returnByValue: true },
    sessionId,
  );
  const data = evaluated.result?.value;
  if (!Array.isArray(data)) return null;
  return { width: FRAME_SAMPLE_WIDTH, height: FRAME_SAMPLE_HEIGHT, data };
};

/**
 * Presses and releases one mouse button at the centre of the canvas. Web games need
 * a real click before the shell lets them capture the pointer, and menu buttons need
 * one to be pressed at all.
 */
const clickCanvas = async (
  cdp: CdpSocket,
  sessionId: string,
  button: "left" | "middle" | "right",
): Promise<{ x: number; y: number } | null> => {
  const centre = await canvasCentre(cdp, sessionId);
  if (!centre) return null;
  const at = { x: Math.round(centre.x), y: Math.round(centre.y) };
  // No mouseMoved first: moving the pointer from wherever it happens to be would hand
  // the game one huge relative motion, which is not what a player clicking sees.
  const options = { ...at, clickCount: 1 };
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", ...options, button },
    sessionId,
  );
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", ...options, button },
    sessionId,
  );
  return at;
};

const launchBrowser = (input: GameWebPlaytestInput): BrowserHandle => {
  const flags = [
    "--headless=new",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    "--hide-scrollbars",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    `--user-data-dir=${input.profileDirectory}`,
    `--window-size=${input.width},${input.height}`,
    "about:blank",
  ];
  // Same sandbox switch HtmlRender uses, so the operator keeps one policy.
  if (sandboxDisabled(process.env)) flags.unshift("--no-sandbox");
  const child = NodeChildProcess.spawn(input.executable, flags, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  const wsUrl = new Promise<string>((resolve, reject) => {
    let pending = true;
    const settle = (value: { ok: boolean; detail: string }) => {
      if (!pending) return;
      pending = false;
      if (value.ok) resolve(value.detail);
      else reject(new Error(value.detail));
    };
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      // Chrome prints the endpoint once its DevTools server accepts connections.
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) settle({ ok: true, detail: match[1]! });
    });
    child.once("exit", () =>
      settle({
        ok: false,
        detail: `Browser exited before opening DevTools: ${stderr.slice(-2000)}`,
      }),
    );
    child.once("error", (cause) =>
      settle({ ok: false, detail: `Browser failed to launch: ${String(cause)}` }),
    );
  });
  return { child, wsUrl };
};

const closeBrowser = (handle: BrowserHandle) =>
  new Promise<void>((resolve) => {
    const { child } = handle;
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const escalation = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(escalation);
      resolve();
    });
    child.kill("SIGTERM");
  });

const connectCdp = (wsUrl: string): Promise<CdpSocket> => {
  const socket = new WebSocket(wsUrl);
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (cause: unknown) => void; method: string }
  >();
  const sessions = new Map<string, (message: { method: string; params: any }) => void>();
  const failAll = (cause: unknown) => {
    for (const entry of pending.values()) entry.reject(cause);
    pending.clear();
  };
  socket.addEventListener("close", () => failAll(new Error("DevTools socket closed")), {
    once: true,
  });
  socket.addEventListener("error", () => failAll(new Error("DevTools socket failed")), {
    once: true,
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message: any;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error)
        entry.reject(new Error(`${entry.method}: ${message.error.message ?? "error"}`));
      else entry.resolve(message.result);
      return;
    }
    if (typeof message.method === "string" && typeof message.sessionId === "string") {
      sessions.get(message.sessionId)?.({ method: message.method, params: message.params ?? {} });
    }
  });
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => {
      reject(new Error("DevTools socket timed out"));
      socket.close();
    }, CONNECT_TIMEOUT_MS);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(guard);
        let nextId = 0;
        resolve({
          send: <T>(method: string, params?: object, sessionId?: string): Promise<T> =>
            new Promise((resolveSend, rejectSend) => {
              const id = ++nextId;
              const timer = setTimeout(() => {
                pending.delete(id);
                rejectSend(new Error(`${method} timed out`));
              }, REQUEST_TIMEOUT_MS);
              pending.set(id, {
                resolve: (value: unknown) => {
                  clearTimeout(timer);
                  resolveSend(value as T);
                },
                reject: (cause) => {
                  clearTimeout(timer);
                  rejectSend(cause);
                },
                method,
              });
              socket.send(
                JSON.stringify({
                  id,
                  method,
                  ...(sessionId ? { sessionId } : {}),
                  ...(params ? { params } : {}),
                }),
              );
            }),
          onSession: (sessionId, handle) => {
            sessions.set(sessionId, handle);
          },
          close: () => socket.close(),
        });
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(guard);
        reject(new Error("DevTools socket failed to open"));
      },
      { once: true },
    );
  });
};

const sleep = (signal: AbortSignal | undefined, ms: number) =>
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

/** Reads the byte order of a PNG header, so screenshot dimensions do not need another round trip. */
const decodePngSize = (base64: string) => {
  const png = Buffer.from(base64, "base64");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};

const screenshot = async (
  cdp: CdpSocket,
  sessionId: string,
  label: string,
  probe: GamePlaytestProbe | null,
): Promise<GamePlaytestScreenshot> => {
  const shot = await cdp.send<{ data: string }>(
    "Page.captureScreenshot",
    { format: "png" },
    sessionId,
  );
  return {
    label,
    mimeType: "image/png" as const,
    data: shot.data,
    ...decodePngSize(shot.data),
    ...(probe === null ? {} : { probe }),
  };
};

/**
 * Exercising the pause bridge like the stage's play surface: one hide, one
 * show, decided by the probe's acks. A game that never answers — an old probe
 * or a bridge that does not pause and mute as promised — reads as unconfirmed
 * rather than as a crashed run; the honest tool reports what it could verify.
 */
const readVisibilityAck = async (
  cdp: CdpSocket,
  sessionId: string,
): Promise<{ visible: boolean; paused: boolean; muted: boolean } | null> => {
  const evaluated = await cdp
    .send<{ result?: { value?: { visible: boolean; paused: boolean; muted: boolean } | null } }>(
      "Runtime.evaluate",
      { expression: READ_VISIBILITY_ACK, returnByValue: true },
      sessionId,
    )
    .catch(() => null);
  return evaluated?.result?.value ?? null;
};

const waitForVisibilityAck = async (
  cdp: CdpSocket,
  sessionId: string,
  visible: boolean,
  signal: AbortSignal | undefined,
): Promise<{ visible: boolean; paused: boolean; muted: boolean } | null> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await sleep(signal, 120);
    const ack = await readVisibilityAck(cdp, sessionId);
    if (ack !== null && ack.visible === visible) return ack;
  }
  return null;
};

const verifyPauseBridge = async (
  cdp: CdpSocket,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<boolean> => {
  /** The GameState JSON as the probe just reported it, or null when it cannot. */
  const probeState = async (): Promise<string | null> => {
    const evaluated = await cdp
      .send<{ result?: { value?: unknown } }>(
        "Runtime.evaluate",
        { expression: READ_PROBE, returnByValue: true },
        sessionId,
      )
      .catch(() => null);
    return typeof evaluated?.result?.value === "string" ? evaluated.result.value : null;
  };
  try {
    await cdp.send(
      "Runtime.evaluate",
      { expression: sendVisibility(false), returnByValue: true },
      sessionId,
    );
    const hiddenAck = await waitForVisibilityAck(cdp, sessionId, false, signal);
    if (hiddenAck === null || !hiddenAck.paused || !hiddenAck.muted) return false;
    // The ack is the engine's word about itself; this is the world's word: two
    // spaced probe reads while hidden must show the same GameState, so the
    // per-frame clocks the probe reports are held, not just claimed held. A
    // game that genuinely ticks a value while hidden keeps this unconfirmed.
    const held = await probeState();
    await sleep(signal, 700);
    const stillHeld = await probeState();
    if (held === null || stillHeld === null || held !== stillHeld) return false;
    await cdp.send(
      "Runtime.evaluate",
      { expression: sendVisibility(true), returnByValue: true },
      sessionId,
    );
    const shownAck = await waitForVisibilityAck(cdp, sessionId, true, signal);
    return shownAck !== null && !shownAck.paused && !shownAck.muted;
  } catch {
    // A page that interrupts evaluation (a reload, a navigation) cannot confirm.
    return false;
  }
};

/** Drives one browser run to completion; the caller's acquire/release finalizers own cleanup. */
const runPlaytest = async (
  handle: BrowserHandle,
  input: GameWebPlaytestInput,
  signal: AbortSignal | undefined,
): Promise<GameWebPlaytestResult> => {
  const wsUrl = await Promise.race([
    handle.wsUrl,
    sleep(signal, CONNECT_TIMEOUT_MS).then(() => {
      throw new Error("Browser did not report a DevTools endpoint");
    }),
  ]);
  signal?.throwIfAborted();
  const cdp = await connectCdp(wsUrl);
  const consoleMessages: GameConsoleMessage[] = [];
  const screenshots: GamePlaytestScreenshot[] = [];
  let engineCookie = false;
  const record = (level: GameConsoleMessage["level"], text: string) => {
    const message = text.slice(0, MAX_MESSAGE_CHARS);
    if (message.includes("Godot Engine v4")) engineCookie = true;
    if (consoleMessages.length < MAX_MESSAGES) consoleMessages.push({ level, text: message });
  };
  try {
    const target = await cdp.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    const session = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    cdp.onSession(session.sessionId, (event) => {
      if (event.method === "Runtime.consoleAPICalled") {
        const type = String(event.params.type ?? "log");
        const level: GameConsoleMessage["level"] =
          type === "error"
            ? "error"
            : type === "warning"
              ? "warning"
              : type === "info"
                ? "info"
                : "log";
        const text = (event.params.args ?? [])
          .map((arg: any) => arg.description ?? (typeof arg.value === "string" ? arg.value : ""))
          .join(" ")
          .trim();
        record(level, text || `console ${type}()`);
      } else if (event.method === "Runtime.exceptionThrown") {
        const details = event.params.exceptionDetails ?? {};
        const text =
          details.exception?.description ??
          [details.text, details.exception?.value ? String(details.exception.value) : ""]
            .filter(Boolean)
            .join(": ");
        record("error", text || details.text || "uncaught exception");
      }
    });
    await cdp.send("Page.enable", undefined, session.sessionId);
    await cdp.send("Runtime.enable", undefined, session.sessionId);
    await cdp.send("Log.enable", undefined, session.sessionId);
    await cdp.send("Page.navigate", { url: input.url }, session.sessionId);

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
        const check = await cdp.send<{ result?: { value?: unknown } }>(
          "Runtime.evaluate",
          { expression: BOOT_CHECK, returnByValue: true },
          session.sessionId,
        );
        if (check.result?.value === true) {
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
      const evaluated = await cdp
        .send<{ result?: { value?: unknown } }>(
          "Runtime.evaluate",
          { expression: READ_PROBE, returnByValue: true },
          session.sessionId,
        )
        .catch(() => null);
      const value = evaluated?.result?.value;
      if (typeof value !== "string") return null;
      const probe = decodeProbe(value);
      if (Option.isNone(probe)) return null;
      samples.push({ probe: probe.value, afterInput: sawInput });
      return probe.value;
    };
    const latestProbe = () => samples.findLast((sample) => sample.probe)?.probe ?? null;
    screenshots.push(await screenshot(cdp, session.sessionId, "booted", null));
    const bootSample = await sampleFrame(cdp, session.sessionId).catch(() => null);
    let pointer: { x: number; y: number } | null = null;
    await readProbe();
    // Games whose policy owes the probe owe its pause bridge too; run the
    // round trip once, before any step, so the samples never span a pause.
    let pauseConfirmed: boolean | null = null;
    if (booted && input.probeRequired && samples.length > 0)
      pauseConfirmed = await verifyPauseBridge(cdp, session.sessionId, signal);

    let executedInputSteps = 0;
    for (const [stepIndex, step] of input.steps.entries()) {
      signal?.throwIfAborted();
      const paired = await playtestStepWithEvidence({
        step,
        stepIndex,
        capture: async () => {
          const probe = await readProbe();
          return {
            screenshot: await screenshot(cdp, session.sessionId, "input", probe),
            pixels: await sampleFrame(cdp, session.sessionId).catch(() => null),
            probe,
          };
        },
        execute: async () => {
          if (!("waitMs" in step) && !("screenshot" in step)) sawInput = true;
          if ("waitMs" in step) await sleep(signal, step.waitMs);
          else if ("screenshot" in step) {
            screenshots.push(
              await screenshot(cdp, session.sessionId, step.screenshot, latestProbe()),
            );
            // The frame itself is the step's product; the next read pairs the probe
            // that follows it, not the one before it.
            await readProbe();
            return false;
          } else if ("click" in step) {
            const clicked = await clickCanvas(cdp, session.sessionId, step.click);
            pointer = clicked ?? pointer;
            return clicked !== null;
          } else if ("mouseMove" in step) {
            const centre: { x: number; y: number } | null =
              pointer ?? (await canvasCentre(cdp, session.sessionId));
            if (centre) {
              const next: { x: number; y: number } = {
                x: Math.max(0, Math.min(input.width, centre.x + step.mouseMove.dx)),
                y: Math.max(0, Math.min(input.height, centre.y + step.mouseMove.dy)),
              };
              await cdp.send(
                "Input.dispatchMouseEvent",
                {
                  type: "mouseMoved",
                  x: Math.round(next.x),
                  y: Math.round(next.y),
                  button: "none",
                },
                session.sessionId,
              );
              pointer = next;
              return true;
            }
          } else {
            try {
              await cdp.send<unknown>(
                "Runtime.evaluate",
                { expression: `document.querySelector("canvas")?.focus()` },
                session.sessionId,
              );
            } catch {
              // The canvas may not be up yet; keyboard events still reach the document.
            }
            const keys = "keys" in step ? step.keys : [step.key];
            for (const key of keys)
              await cdp.send("Input.dispatchKeyEvent", keyEvent(key, "keyDown"), session.sessionId);
            await sleep(signal, step.holdMs);
            for (const key of [...keys].toReversed())
              await cdp.send("Input.dispatchKeyEvent", keyEvent(key, "keyUp"), session.sessionId);
          }
          return !("waitMs" in step) && !("mouseMove" in step);
        },
      });
      if (paired.executed) executedInputSteps++;
      screenshots.push(...paired.frames);
      await readProbe();
    }
    screenshots.push(await screenshot(cdp, session.sessionId, "after-steps", latestProbe()));
    const afterSample = await sampleFrame(cdp, session.sessionId).catch(() => null);
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
    const errors = consoleMessages.filter((message) => message.level === "error").length;
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
      screenshots,
      state,
      pauseConfirmed,
      qualifies: verdict.qualifies,
      blockers: [...verdict.blockers],
      interaction: verdict.interaction,
    };
  } finally {
    cdp.close();
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
        Effect.try({
          try: () => launchBrowser(input),
          catch: operationError(input),
        }),
        (handle: BrowserHandle) =>
          Effect.tryPromise({
            try: (signal) => runPlaytest(handle, input, signal),
            catch: operationError(input),
          }),
        (handle) => Effect.promise(() => closeBrowser(handle)),
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
