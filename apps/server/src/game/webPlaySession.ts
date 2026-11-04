// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off preferSchemaOverJson:off -- This module owns headless Chromium for browser play sessions: wall-clock boot polling and real-time input.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import type { GameConsoleMessage, GameExploreStep } from "@kurambit/contracts";
import {
  READ_STUDIO_READY,
  READ_STUDIO_STATE,
  STUDIO_SET_STATE,
  chromiumLaunchArgs,
  toPlaywrightKey,
} from "./gameChromium.ts";
import { asGameState } from "./gameBotRuntime.ts";
import { chromiumChildEnv } from "./gameWebServer.ts";
import { parseLine, sanitizeProbe, type PlaySession } from "./playSession.ts";

// Playwright needs its files on disk; createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 500;
const MAX_PAGE_ERRORS = 100;
const TICK_MS = 100;

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

type KeptEntries = ReadonlyArray<{ readonly name: string; readonly value: string }>;

/**
 * A kept session's localStorage, stored without its origin: the served port
 * changes per session, so the entries are restored onto whatever origin the
 * next kept session serves. Unreadable or malformed means none.
 */
const readKeptStorage = async (path: string): Promise<KeptEntries> => {
  const raw: unknown = await NodeFSP.readFile(path, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  const entries =
    raw !== null && typeof raw === "object" && "localStorage" in raw ? raw.localStorage : null;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown) =>
    entry !== null &&
    typeof entry === "object" &&
    "name" in entry &&
    "value" in entry &&
    typeof entry.name === "string" &&
    typeof entry.value === "string"
      ? [{ name: entry.name, value: entry.value }]
      : [],
  );
};

/** Written whole then renamed, so a session killed mid-write keeps the last good saves. */
const writeKeptStorage = async (path: string, entries: KeptEntries): Promise<void> => {
  const partial = NodePath.join(NodePath.dirname(path), `.${NodePath.basename(path)}.partial`);
  await NodeFSP.writeFile(partial, `${JSON.stringify({ localStorage: entries }, null, 2)}\n`);
  await NodeFSP.rename(partial, path);
};

export type WebPlaySession = PlaySession;

/**
 * Counts the page's animation frames: the engine-side frame counter of a
 * browser game, which stops when the page's main thread does.
 */
const FRAME_COUNTER = `(() => {
  let frames = 0;
  const raf = window.requestAnimationFrame.bind(window);
  const count = () => {
    frames += 1;
    raf(count);
  };
  raf(count);
  Object.defineProperty(window, "__kurambitFrames", { get: () => frames });
})()`;

/**
 * The browser host of the play-session protocol: headless Chromium on a
 * served static folder, real keyboard and mouse through the browser, and the
 * page's read-only `window.__studio` bridge (ready, getState, setState) for
 * what the game sees. A page is never held: the game runs between acts, and
 * waits and holds advance it as they run. Pages read no control tree, so the
 * session has no ui or inspect steps; the caller owns the served URL.
 */
export const openWebPlaySession = async (input: {
  readonly executable: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly bootTimeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  /**
   * A kept session's localStorage file: restored before the page loads and
   * written back when the session closes. Omitted, the page starts with none.
   */
  readonly keptStorage?: string | null | undefined;
}): Promise<WebPlaySession> => {
  input.signal?.throwIfAborted();
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
    const origin = new URL(input.url).origin;
    const keptStorage = input.keptStorage ?? null;
    const context = await browser.newContext({
      viewport: { width: input.width, height: input.height },
      ...(keptStorage === null
        ? {}
        : {
            storageState: {
              cookies: [],
              origins: [{ origin, localStorage: [...(await readKeptStorage(keptStorage))] }],
            },
          }),
    });
    await context.addInitScript(FRAME_COUNTER);
    const page = await context.newPage();
    const pending: GameConsoleMessage[] = [];
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
    // Page errors and console errors for the tick stream, with the stack as `where`.
    const pageErrors: Array<{ message: string; where: string }> = [];
    let pageErrorsSeen = 0;
    const pageError = (message: string, stack: string | undefined): void => {
      if (pageErrors.length < MAX_PAGE_ERRORS)
        pageErrors.push({ message: message.slice(0, 500), where: (stack ?? "").slice(0, 200) });
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
      if (type === "error") pageError(message.text(), undefined);
    });
    page.on("pageerror", (error) => {
      record("error", error instanceof Error ? error.message : String(error));
      pageError(
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? error.stack : undefined,
      );
    });
    const drain = (): { messages: GameConsoleMessage[]; truncated: number } => {
      const messages = [...pending];
      pending.length = 0;
      const truncated = dropped;
      dropped = 0;
      return { messages, truncated };
    };
    // The page's frame count as of the last state read; frames carry it.
    let pageFrames = 0;
    const readState = async (): Promise<Record<string, unknown> | null> => {
      const raw: unknown = await page
        .evaluate(`[${READ_STUDIO_STATE}, window.__kurambitFrames ?? 0]`)
        .catch(() => null);
      if (!Array.isArray(raw)) return null;
      if (typeof raw[1] === "number") pageFrames = raw[1];
      return typeof raw[0] === "string" ? parseLine(raw[0]) : null;
    };
    let booted = false;
    try {
      await page.goto(input.url, { timeout: input.bootTimeoutMs, waitUntil: "load" });
      const bootDeadline = Date.now() + input.bootTimeoutMs;
      while (!booted && Date.now() < bootDeadline) {
        await sleep(500, input.signal);
        try {
          booted = (await page.evaluate(READ_STUDIO_READY)) === true;
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
        "The three.js page never reported ready (window.__studio.ready stayed false); no session was opened.",
      );
    }
    const bootProbe = sanitizeProbe(await readState());
    const bootConsole = drain();
    let pointer: { x: number; y: number } | null = null;
    const centre = () => ({ x: Math.round(input.width / 2), y: Math.round(input.height / 2) });
    const act: PlaySession["act"] = async (steps, screenshotPath, signal) => {
      signal?.throwIfAborted();
      let executedInputSteps = 0;
      const held: string[] = [];
      // Each step releases its own keys, as the process runners do: a key held
      // into the next step would move the player through it, and pressing the
      // same key again would arrive as auto-repeat, which games ignore.
      const holdKeys = async (keys: ReadonlyArray<string>, ms: number) => {
        const mapped = keys.map(toPlaywrightKey);
        for (const key of mapped) {
          await page.keyboard.down(key);
          held.push(key);
        }
        await sleep(ms, signal);
        for (const key of mapped) {
          await page.keyboard.up(key);
          held.splice(held.indexOf(key), 1);
        }
        executedInputSteps += 1;
      };
      try {
        for (const step of steps as readonly GameExploreStep[]) {
          signal?.throwIfAborted();
          if ("waitMs" in step) {
            await sleep(step.waitMs, signal);
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
            await sleep(step.holdMs, signal);
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
            await holdKeys(step.keys, step.holdMs);
          } else if ("key" in step) {
            await holdKeys([step.key], step.holdMs);
          } else if ("hold" in step) {
            await holdKeys([step.hold], step.holdMs);
          } else if ("press" in step) {
            await holdKeys([step.press], 50);
          } else {
            // The session lists no ui or inspect capability, so explore refuses
            // those steps before any browser work.
            throw new Error("Unsupported browser step: ui and inspect steps need a control tree.");
          }
          signal?.throwIfAborted();
        }
      } finally {
        for (const key of held.splice(0)) await page.keyboard.up(key).catch(() => undefined);
      }
      const probe = sanitizeProbe(await readState());
      const shot =
        screenshotPath === null ? null : await page.screenshot({ type: "png" }).catch(() => null);
      const saved =
        shot !== null && screenshotPath !== null
          ? await NodeFSP.writeFile(screenshotPath, shot).then(
              () => true,
              () => false,
            )
          : false;
      const drained = drain();
      return {
        probe,
        executedInputSteps,
        screenshot: saved,
        consoleMessages: drained.messages,
        consoleTruncated: drained.truncated,
      };
    };
    // Real-time play: the host paces the ticks, since the page streams nothing.
    let tickStart = 0;
    let realtimeStart = 0;
    let ticks = 0;
    const keysDown = new Set<string>();
    let screencast: Awaited<ReturnType<typeof context.newCDPSession>> | null = null;
    const session: WebPlaySession = {
      protocol: 2,
      capabilities: new Set(["realtime", "setState", "frames"]),
      boot: { probe: bootProbe, consoleMessages: bootConsole.messages },
      bootPerf: null,
      act,
      realtime: async (frames) => {
        realtimeStart = Date.now();
        tickStart = 0;
        if (frames === undefined) return;
        // The compositor's own frames, as the page drew them; a page that
        // draws nothing new sends none, and the video repeats its last one.
        const cdp = await context.newCDPSession(page);
        screencast = cdp;
        cdp.on("Page.screencastFrame", (event) => {
          void cdp
            .send("Page.screencastFrameAck", { sessionId: event.sessionId })
            .catch(() => undefined);
          frames.onFrame({
            frame: pageFrames,
            t: (Date.now() - realtimeStart) / 1000,
            jpeg: Buffer.from(event.data, "base64"),
          });
        });
        const width = Math.min(frames.width, input.width);
        await cdp.send("Page.startScreencast", {
          format: "jpeg",
          quality: 75,
          maxWidth: width,
          maxHeight: Math.round((input.height * width) / input.width),
        });
      },
      nextTick: async () => {
        const wait = tickStart + TICK_MS - Date.now();
        if (wait > 0) await sleep(wait);
        tickStart = Date.now();
        const state = await readState();
        if (state === null) return null;
        ticks += 1;
        const errors = pageErrors
          .slice(pageErrorsSeen)
          .map((entry) => ({ ...entry, kind: "page" as const }));
        pageErrorsSeen = pageErrors.length;
        const player = sanitizeProbe({ gameState: {}, player: state["player"] })?.player ?? null;
        return {
          op: "tick",
          tick: ticks,
          t: (Date.now() - realtimeStart) / 1000,
          probe: {
            gameState: asGameState(state["gameState"]),
            player,
            hudText: typeof state["hudText"] === "string" ? state["hudText"] : "",
          },
          errors,
        };
      },
      input: async ({ held, taps, clicks }) => {
        const wanted = new Set(held);
        for (const key of wanted)
          if (!keysDown.has(key)) {
            await page.keyboard.down(toPlaywrightKey(key)).catch(() => undefined);
            keysDown.add(key);
          }
        for (const key of keysDown)
          if (!wanted.has(key)) {
            await page.keyboard.up(toPlaywrightKey(key)).catch(() => undefined);
            keysDown.delete(key);
          }
        for (const tap of taps) {
          await page.keyboard.down(toPlaywrightKey(tap)).catch(() => undefined);
          await sleep(15);
          await page.keyboard.up(toPlaywrightKey(tap)).catch(() => undefined);
        }
        for (const click of clicks)
          if ("x" in click)
            await page.mouse.click(Math.round(click.x), Math.round(click.y)).catch(() => undefined);
      },
      setState: async (target, values) => {
        // Playwright evaluates a string as an expression and never calls it, so the
        // call and its JSON argument are part of the expression.
        const call = `(${STUDIO_SET_STATE})(${JSON.stringify({ target, values })})`;
        await page.evaluate(call).catch(() => false);
      },
      still: (path) =>
        page.screenshot({ path }).then(
          () => true,
          () => false,
        ),
      close: async () => {
        await screencast?.send("Page.stopScreencast").catch(() => undefined);
        try {
          if (keptStorage !== null) {
            // Leaving the page fires pagehide as closing the tab would, so a game
            // that saves then (the starter shell's progress does) has written it.
            await page.goto("about:blank", { timeout: 5_000 }).catch(() => undefined);
            // storageState has no timeout and reads through the page, so a game
            // whose main thread is stuck would hold the close forever.
            const state = await Promise.race([
              context.storageState().catch(() => null),
              sleep(3_000).then(() => null),
            ]);
            // A page that never answered keeps the last saves rather than erasing them.
            if (state !== null)
              await writeKeptStorage(
                keptStorage,
                state.origins.find((entry) => entry.origin === origin)?.localStorage ?? [],
              ).catch(() => undefined);
          }
        } finally {
          await browser.close().catch(() => undefined);
        }
      },
    };
    return session;
  } catch (cause) {
    await browser.close().catch(() => undefined);
    throw cause;
  }
};
