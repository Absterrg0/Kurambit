// @effect-diagnostics globalTimers:off globalDate:off -- Boot polling and kill escalation run on wall-clock timers; runs are interrupted through an AbortSignal.
// @effect-diagnostics nodeBuiltinImport:off -- This module owns the browser process and the raw DevTools WebSocket boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import {
  GameOperationError,
  type GameConsoleMessage,
  type GamePlaytestScreenshot,
  type GamePlaytestStep,
  type GameWebPlaytestResult,
} from "@t3tools/contracts";
import { sandboxDisabled } from "../preview/PreviewBrowserHost.ts";

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

/**
 * Presses and releases one mouse button at the centre of the canvas. Web games need
 * a real click before the shell lets them capture the pointer, and menu buttons need
 * one to be pressed at all.
 */
const clickCanvas = async (
  cdp: CdpSocket,
  sessionId: string,
  button: "left" | "middle" | "right",
): Promise<void> => {
  const evaluated = await cdp.send<{ result?: { value?: { x: number; y: number } | null } }>(
    "Runtime.evaluate",
    { expression: CANVAS_CENTRE, returnByValue: true },
    sessionId,
  );
  const centre = evaluated.result?.value;
  if (!centre) return;
  const at = { x: Math.round(centre.x), y: Math.round(centre.y) };
  const options = { ...at, clickCount: 1 };
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...at, button: "none" },
    sessionId,
  );
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
): Promise<GamePlaytestScreenshot> => {
  const shot = await cdp.send<{ data: string }>(
    "Page.captureScreenshot",
    { format: "png" },
    sessionId,
  );
  return { label, mimeType: "image/png" as const, data: shot.data, ...decodePngSize(shot.data) };
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
    screenshots.push(await screenshot(cdp, session.sessionId, "booted"));

    for (const step of input.steps) {
      signal?.throwIfAborted();
      if ("waitMs" in step) {
        await sleep(signal, step.waitMs);
        continue;
      }
      if ("click" in step) {
        await clickCanvas(cdp, session.sessionId, step.click);
        continue;
      }
      try {
        await cdp.send<unknown>(
          "Runtime.evaluate",
          { expression: `document.querySelector("canvas")?.focus()` },
          session.sessionId,
        );
      } catch {
        // The canvas may not be up yet; keyboard events still reach the document.
      }
      await cdp.send("Input.dispatchKeyEvent", keyEvent(step.key, "keyDown"), session.sessionId);
      await sleep(signal, step.holdMs);
      await cdp.send("Input.dispatchKeyEvent", keyEvent(step.key, "keyUp"), session.sessionId);
    }
    screenshots.push(await screenshot(cdp, session.sessionId, "after-steps"));

    const errors = consoleMessages.filter((message) => message.level === "error").length;
    const success = booted && errors === 0;
    const summary = [
      booted ? `Booted in ${bootMs}ms` : `Did not boot within ${input.bootTimeoutMs}ms`,
      errors === 0 ? "no console errors" : `${errors} console error(s)`,
      `${input.steps.length} step(s)`,
    ].join("; ");
    return {
      success,
      booted,
      bootMs: booted ? bootMs : null,
      message: success ? `Playtest succeeded: ${summary}` : `Playtest failed: ${summary}`,
      consoleMessages,
      screenshots,
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
