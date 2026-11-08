// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off preferSchemaOverJson:off -- This module owns headless Chromium for browser play sessions: wall-clock boot polling and real-time input.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import type { GameConsoleMessage, GameExploreStep } from "@kurambit/contracts";
import {
  READ_STUDIO_PERF,
  READ_STUDIO_READY,
  READ_STUDIO_STATE,
  STUDIO_SET_STATE,
  toPlaywrightKey,
  type GameBrowser,
} from "./gameChromium.ts";
import { asGameState } from "./gameBotRuntime.ts";
import { READ_SCENE, START_SCENE, type PageScene } from "./sceneReport.ts";
import { chromiumChildEnv } from "./gameWebServer.ts";
import {
  PLAY_BOUNDS,
  PlayClosed,
  PlayUnresponsive,
  TIMED_OUT,
  bounded,
  once,
  parseLine,
  sanitizeProbe,
  type PlayEnd,
  type PlayFrame,
  type PlaySession,
} from "./playSession.ts";

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

export type WebPageEvent =
  | {
      readonly kind: "console";
      readonly level: string;
      readonly text: string;
      readonly url: string;
    }
  | { readonly kind: "pageerror"; readonly text: string; readonly stack: string | undefined }
  | { readonly kind: "script-failed"; readonly url: string; readonly status: number };

/** The page never set `window.__studio.ready`: by the deadline, or because it errored first. */
export class WebPageNotReady extends Error {
  readonly timedOut: boolean;
  /** Why the page could not be opened at all, when it could not. */
  readonly navigation: string | null;
  constructor(timedOut: boolean, bootTimeoutMs: number, navigation: string | null = null) {
    super(
      timedOut
        ? `The page never reported ready (window.__studio.ready stayed false past ${Math.round(bootTimeoutMs / 1000)}s${navigation === null ? "" : `; its navigation failed: ${navigation}`}); no session was opened.`
        : navigation !== null
          ? `The page could not be opened (${navigation}); no session was opened.`
          : "The page errored before window.__studio appeared; no session was opened.",
    );
    this.timedOut = timedOut;
    this.navigation = navigation;
  }
}

/** Headless Chromium itself would not start: the host's problem, never the page's. */
export class WebBrowserLaunchFailed extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

/** The game's page crashed (Chromium's page "crash"): evidence about the build. */
export class WebPageCrashed extends Error {
  constructor(message = "The game's page crashed.") {
    super(message);
  }
}

/** Our browser went away (disconnected or closed) while the page ran: a tool fault, never the game's. */
export class WebBrowserGone extends Error {
  constructor(message = "Headless Chromium disconnected while the page was running.") {
    super(message);
  }
}

/**
 * Counts the page's animation frames and its own clock: the engine-side frame
 * counter of a browser game, and seconds of play (each frame's delta, clamped
 * the way games clamp dt, so a page that stalls gains no time for the stall).
 * Both stop when the page's main thread does.
 */
const FRAME_COUNTER = `(() => {
  let frames = 0;
  let seconds = 0;
  let last = null;
  const raf = window.requestAnimationFrame.bind(window);
  const count = (now) => {
    frames += 1;
    if (last !== null) seconds += Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    raf(count);
  };
  raf(count);
  Object.defineProperty(window, "__kurambitFrames", { get: () => frames });
  Object.defineProperty(window, "__kurambitTime", { get: () => seconds });
})()`;

/** The page calls it once per sound that started playing above silence. */
const SOUND_BINDING = "__kurambitSoundStarted";

/**
 * Which sounds started playing, without unmuting anything (Chromium runs with
 * --mute-audio; the graph still runs). Web Audio: an AudioBufferSourceNode's
 * start, its buffer known by the SHA-256 and length of the bytes
 * decodeAudioData decoded (loaders rewrap responses, so a URL does not survive
 * to the decode; the bytes do), counted once its context runs, the buffer
 * holds more than silence and a path of non-zero gains reaches the speakers.
 * Media elements: by their URL, once playing, unmuted and with volume, or
 * routed into such a path. Anything not yet audible is looked at again twice
 * a second while it plays. "Started playing" is all it says: nobody listened.
 */
const SOUND_TAP = `(() => {
  if (typeof BaseAudioContext === "undefined") return;
  const reported = new Set();
  const started = (key) => {
    if (typeof key !== "string" || key === "" || reported.has(key)) return;
    reported.add(key);
    try { window[${JSON.stringify(SOUND_BINDING)}]?.(key); } catch {}
  };
  const keys = new WeakMap();
  const decode = BaseAudioContext.prototype.decodeAudioData;
  BaseAudioContext.prototype.decodeAudioData = function (data, onDecoded, ...rest) {
    // Decoding detaches the bytes: they are hashed from a copy.
    let key = null;
    if (data instanceof ArrayBuffer && crypto.subtle) {
      const bytes = data.byteLength;
      key = crypto.subtle.digest("SHA-256", data.slice(0)).then(
        (digest) =>
          "sha256:" +
          [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") +
          ":" +
          bytes,
        () => null,
      );
    }
    const tag = (buffer) => {
      if (key && buffer) keys.set(buffer, key);
      return buffer;
    };
    const decoded = decode.call(
      this,
      data,
      typeof onDecoded === "function" ? (buffer) => onDecoded(tag(buffer)) : onDecoded,
      ...rest,
    );
    if (decoded && typeof decoded.then === "function") decoded.then(tag, () => undefined);
    return decoded;
  };
  const edges = new WeakMap();
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (target, ...rest) {
    let out = edges.get(this);
    if (!out) edges.set(this, (out = new Set()));
    if (target instanceof AudioNode) out.add(target);
    return connect.call(this, target, ...rest);
  };
  const disconnect = AudioNode.prototype.disconnect;
  AudioNode.prototype.disconnect = function (...args) {
    const out = edges.get(this);
    if (out) {
      if (args.length === 0 || typeof args[0] === "number") out.clear();
      else out.delete(args[0]);
    }
    return disconnect.apply(this, args);
  };
  const reaches = (node) => {
    if (!(node.context instanceof AudioContext) || node.context.state !== "running") return false;
    const seen = new Set();
    const stack = [node];
    while (stack.length > 0) {
      const at = stack.pop();
      if (seen.has(at)) continue;
      seen.add(at);
      if (at instanceof AudioDestinationNode) return true;
      if (at instanceof GainNode && Math.abs(at.gain.value) < 1e-4) continue;
      for (const next of edges.get(at) ?? []) stack.push(next);
    }
    return false;
  };
  const loud = new WeakMap();
  const notSilent = (buffer) => {
    let known = loud.get(buffer);
    if (known === undefined) {
      known = false;
      for (let c = 0; c < buffer.numberOfChannels && !known; c++) {
        const samples = buffer.getChannelData(c);
        for (let i = 0; i < samples.length; i++)
          if (Math.abs(samples[i]) > 1e-3) {
            known = true;
            break;
          }
      }
      loud.set(buffer, known);
    }
    return known;
  };
  const waiting = new Set();
  let timer = null;
  const look = (entry) => {
    if (entry.done()) waiting.delete(entry);
    else if (entry.audible()) {
      waiting.delete(entry);
      Promise.resolve(entry.key).then(started);
    }
    if (waiting.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const watch = (entry) => {
    waiting.add(entry);
    look(entry);
    if (waiting.size > 0 && timer === null) timer = setInterval(() => waiting.forEach(look), 500);
  };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    const result = start.apply(this, args);
    const key = this.buffer ? keys.get(this.buffer) : undefined;
    if (key) {
      let ended = false;
      this.addEventListener("ended", () => (ended = true), { once: true });
      watch({ key, done: () => ended, audible: () => notSilent(this.buffer) && reaches(this) });
    }
    return result;
  };
  const routed = new WeakMap();
  const fromElement = AudioContext.prototype.createMediaElementSource;
  AudioContext.prototype.createMediaElementSource = function (element) {
    const node = fromElement.call(this, element);
    routed.set(element, node);
    return node;
  };
  const watched = new WeakSet();
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    const element = this;
    if (!watched.has(element)) {
      watched.add(element);
      element.addEventListener("playing", () =>
        watch({
          key: element.currentSrc,
          done: () => element.paused || element.ended,
          audible: () => {
            const node = routed.get(element);
            return node ? reaches(node) : !element.muted && element.volume > 0;
          },
        }),
      );
    }
    return play.apply(element, args);
  };
})()`;

const READY = "window.__studio?.ready === true";

/** What a kept session's page left in its storage, for the caller to write back. */
export interface KeptStorage {
  readonly path: string;
  readonly contents: string;
}

export interface WebPlaySession extends PlaySession {
  /** Settles when the page crashed (the game's) or our browser went away (ours). */
  readonly ended: Promise<PlayEnd>;
  /** After `close`: the kept session's storage to write back, or null. */
  readonly keptStorage: () => KeptStorage | null;
  /**
   * After `close`: how play ran, as the page's shell measured it (`__studio.perf()`:
   * frame times, GPU time, the render scale), read just before the page closed; null
   * when the shell has none or the page could not answer.
   */
  readonly perf: () => unknown;
  /**
   * After `close`: the scene report of a session opened with `sceneReport`, read just before
   * the page closed; "no-shell" when the game's shell has none, null when it could not be read
   * or was not asked for.
   */
  readonly scene: () => PageScene;
}

/**
 * The browser host of the play-session protocol: headless Chromium on a
 * served static folder, real keyboard and mouse through the browser, and the
 * page's read-only `window.__studio` bridge (ready, getState, setState) for
 * what the game sees. A page is never held: the game runs between acts, and
 * waits and holds advance it as they run. Pages read no control tree, so the
 * session has no ui or inspect steps; the caller owns the served URL. Every
 * call into the page is bounded (PLAY_BOUNDS): a game whose main thread is
 * stuck never holds a caller.
 */
export const openWebPlaySession = async (input: {
  readonly browser: GameBrowser;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly bootTimeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  /**
   * A kept session's localStorage file: restored before the page loads and
   * read back when the session closes. Omitted, the page starts with none.
   */
  readonly keptStorage?: string | null | undefined;
  /** Sees each console message, page error and failed script as the page reports it. */
  readonly onPageEvent?: ((event: WebPageEvent) => void) | undefined;
  /**
   * Hears, once each, the sounds that started playing above silence (SOUND_TAP): a media
   * element's URL, or "sha256:<hex>:<bytes>" of the bytes a Web Audio buffer was decoded from.
   */
  readonly onSoundStarted?: ((sound: string) => void) | undefined;
  /**
   * Ends the boot wait once a page error or a failed script came before the
   * bridge: the check reports that page as broken. A player's page (explore,
   * bots) waits for ready or the deadline, as a page that recovers would.
   */
  readonly stopOnPageError?: boolean | undefined;
  /** Starts the shell's scene report once the page is ready; `scene()` has it after close. */
  readonly sceneReport?: boolean | undefined;
}): Promise<WebPlaySession> => {
  input.signal?.throwIfAborted();
  const { chromium } = loadPlaywright();
  const browser = await chromium
    .launch({
      executablePath: input.browser.executable,
      headless: true,
      chromiumSandbox: input.browser.sandbox,
      args: [...input.browser.args],
      env: chromiumChildEnv(),
    })
    .catch(async (cause: unknown) => {
      if (input.signal?.aborted) throw new Error("aborted");
      throw new WebBrowserLaunchFailed(await input.browser.launchFailure(cause), cause);
    });
  let closing = false;
  const closeBrowser = async () => {
    closing = true;
    await bounded(browser.close(), PLAY_BOUNDS.browserCloseMs);
  };
  if (input.signal?.aborted) {
    await closeBrowser();
    throw new Error("aborted");
  }
  let endedWith: PlayEnd | null = null;
  let settleEnded: (end: PlayEnd) => void = () => undefined;
  const ended = new Promise<PlayEnd>((resolve) => {
    settleEnded = (end) => {
      if (endedWith !== null) return;
      endedWith = end;
      resolve(end);
    };
  });
  // Our browser leaving while we are not closing it is ours, never the game's.
  browser.on("disconnected", () => {
    if (!closing) settleEnded({ by: "host", detail: new WebBrowserGone().message });
  });
  // page.goto takes no signal: an abort mid-boot ends the browser, which ends the wait.
  const abortBoot = () => void closeBrowser();
  input.signal?.addEventListener("abort", abortBoot, { once: true });
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
    const onSound = input.onSoundStarted;
    if (onSound !== undefined) {
      await context.exposeBinding(SOUND_BINDING, (_source, sound: unknown) => {
        if (typeof sound === "string") onSound(sound.slice(0, 2000));
      });
      await context.addInitScript(SOUND_TAP);
    }
    const page = await context.newPage();
    page.on("crash", () => settleEnded({ by: "game", detail: new WebPageCrashed().message }));
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
    const notify = input.onPageEvent ?? (() => undefined);
    // A page error or a script that failed to load: either can stop the
    // modules for good, so the bridge never appears.
    let pageErrored = false;
    let onPageErrored: () => void = () => undefined;
    const errored = () => {
      pageErrored = true;
      onPageErrored();
    };
    page.on("response", (response) => {
      if (response.status() < 400 || response.request().resourceType() !== "script") return;
      errored();
      record("error", `script failed to load: ${response.url()} (${response.status()})`);
      notify({ kind: "script-failed", url: response.url(), status: response.status() });
    });
    page.on("console", (message) => {
      const type = String(message.type() ?? "log");
      notify({
        kind: "console",
        level: type,
        text: message.text(),
        url: message.location()?.url ?? "",
      });
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
      errored();
      notify({
        kind: "pageerror",
        text: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
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
    /** Our side gone, or the page crashed: the error that says whose. */
    const endError = (end: PlayEnd) =>
      end.by === "host" ? new WebBrowserGone(end.detail) : new WebPageCrashed(end.detail);
    /**
     * A Playwright call that failed, said by whose side, so no raw "Target
     * closed" ever leaves the session: the page's end once known, our own
     * close, or a browser that went away under it.
     */
    const classify = (cause: unknown): unknown =>
      endedWith !== null
        ? endError(endedWith)
        : closing
          ? new PlayClosed("The play session was closed.")
          : cause instanceof Error && cause.name === "TargetClosedError"
            ? new WebBrowserGone(cause.message)
            : cause;
    // The page's frame count and clock as of the last state read; frames carry them.
    let pageFrames = 0;
    let pageSeconds = 0;
    // The frame counter and clock a picture is tagged with, read again as
    // pictures arrive (one read in flight), so they stay the page's own between
    // ticks and after play: a counter that stops means the page stopped.
    let reading = false;
    const refreshCounters = () => {
      if (reading) return;
      reading = true;
      void bounded(
        page
          .evaluate("[window.__kurambitFrames ?? 0, window.__kurambitTime ?? 0]")
          .catch(() => null),
        PLAY_BOUNDS.webCallMs,
      ).then((raw) => {
        reading = false;
        if (!Array.isArray(raw)) return;
        if (typeof raw[0] === "number") pageFrames = raw[0];
        if (typeof raw[1] === "number") pageSeconds = raw[1];
      });
    };
    /** The page's state; TIMED_OUT when its main thread did not answer in `ms`. */
    const readState = async (ms: number) => {
      const raw = await bounded(
        page
          .evaluate(
            `[${READ_STUDIO_STATE}, window.__kurambitFrames ?? 0, window.__kurambitTime ?? 0]`,
          )
          .catch(() => null),
        ms,
      );
      if (raw === TIMED_OUT) return TIMED_OUT;
      if (!Array.isArray(raw)) return null;
      if (typeof raw[1] === "number") pageFrames = raw[1];
      if (typeof raw[2] === "number") pageSeconds = raw[2];
      return typeof raw[0] === "string" ? parseLine(raw[0]) : null;
    };
    try {
      const bootDeadline = Date.now() + input.bootTimeoutMs;
      // A page that navigates while it boots (a redirect, a reload) rejects
      // the first goto though it loads; only a bridge that never appears fails.
      let navigation: string | null = null;
      const loaded = await page
        .goto(input.url, { timeout: input.bootTimeoutMs, waitUntil: "load" })
        .then(
          () => true,
          (cause: unknown) => {
            if (input.signal?.aborted) throw cause;
            if (cause instanceof Error && cause.name === "TimeoutError") return false;
            navigation = (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
            return true;
          },
        );
      // Top-level await can delay the bridge past load, so only an error and
      // no bridge together end the wait early, and only for the check.
      let watchErrors = input.stopOnPageError === true;
      for (;;) {
        if (endedWith !== null) throw endError(endedWith);
        const left = bootDeadline - Date.now();
        if (!loaded || left <= 0) throw new WebPageNotReady(true, input.bootTimeoutMs, navigation);
        const outcome = await Promise.race([
          page.waitForFunction(READY, undefined, { timeout: left, polling: 250 }).then(
            () => "ready" as const,
            (cause: unknown) =>
              cause instanceof Error && cause.name === "TimeoutError"
                ? ("timeout" as const)
                : // Evaluations race the page's navigation; wait again on the new page.
                  ("retry" as const),
          ),
          ended.then(() => "ended" as const),
          new Promise<"errored">((resolve) => {
            onPageErrored = () => watchErrors && resolve("errored");
            if (watchErrors && pageErrored) resolve("errored");
          }),
        ]);
        onPageErrored = () => undefined;
        if (outcome === "ready") break;
        if (outcome === "timeout") throw new WebPageNotReady(true, input.bootTimeoutMs, navigation);
        if (outcome === "errored") {
          const bridge = await bounded(
            page.evaluate(READ_STUDIO_READY).catch(() => null),
            PLAY_BOUNDS.webCallMs,
          );
          if (bridge === null || bridge === TIMED_OUT)
            throw new WebPageNotReady(false, input.bootTimeoutMs, navigation);
          // The bridge is there and booting: an error after it is the game's to report.
          watchErrors = false;
        }
        if (outcome === "retry") await sleep(100, input.signal);
      }
    } catch (cause) {
      await closeBrowser();
      throw cause;
    } finally {
      input.signal?.removeEventListener("abort", abortBoot);
    }
    // The scene report looks only at a measured play: started once the page is ready.
    let sceneStarted: boolean | null = null;
    if (input.sceneReport === true) {
      const started = await bounded(
        page.evaluate(START_SCENE).catch(() => false),
        PLAY_BOUNDS.webCallMs,
      );
      sceneStarted = started === null ? null : started === true;
    }
    const bootState = await readState(PLAY_BOUNDS.webCallMs);
    const bootProbe = sanitizeProbe(bootState === TIMED_OUT ? null : bootState);
    const bootConsole = drain();
    let pointer: { x: number; y: number } | null = null;
    const centre = () => ({ x: Math.round(input.width / 2), y: Math.round(input.height / 2) });
    const actBody = async (
      steps: readonly GameExploreStep[],
      screenshotPath: string | null,
      signal: AbortSignal | undefined,
    ) => {
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
        for (const step of steps) {
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
        for (const key of held.splice(0))
          await bounded(page.keyboard.up(key), PLAY_BOUNDS.webCallMs);
      }
      const state = await readState(PLAY_BOUNDS.webCallMs);
      if (state === TIMED_OUT) throw unresponsive();
      const probe = sanitizeProbe(state);
      const shot =
        screenshotPath === null
          ? null
          : await bounded(
              page.screenshot({ type: "png" }).catch(() => null),
              PLAY_BOUNDS.stillMs,
            );
      const saved =
        shot !== null && shot !== TIMED_OUT && screenshotPath !== null
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
    const unresponsive = () =>
      new PlayUnresponsive(
        `The game's page stopped answering (its main thread did not respond within ${PLAY_BOUNDS.webCallMs / 1000} s).`,
      );
    const act: PlaySession["act"] = async (steps, screenshotPath, signal) => {
      signal?.throwIfAborted();
      if (endedWith !== null) throw endError(endedWith);
      const stepMs = steps.reduce(
        (sum, step) =>
          sum +
          ("waitMs" in step ? step.waitMs : "holdMs" in step ? step.holdMs : 0) +
          ("press" in step ? 50 : 0),
        0,
      );
      const done = await Promise.race([
        bounded(
          actBody(steps, screenshotPath, signal).catch((cause: unknown) => {
            throw classify(cause);
          }),
          stepMs + PLAY_BOUNDS.webActGraceMs,
        ),
        ended.then((end) => ({ end })),
      ]);
      if (done === TIMED_OUT) throw unresponsive();
      if ("end" in done) throw endError(done.end);
      return done;
    };
    // Real-time play: the host paces the ticks, since the page streams nothing.
    let tickStart = 0;
    let realtimeSeconds = 0;
    let ticks = 0;
    const keysDown = new Set<string>();
    const refused: Array<{ target: string; error: string }> = [];
    let screencast: Awaited<ReturnType<typeof context.newCDPSession>> | null = null;
    // The compositor sends a picture only when the page drew a different one,
    // so a static screen sends none; the host repeats the last picture with the
    // page's advanced frame counter, and only a page that stopped drawing stalls.
    let frameSink: ((frame: PlayFrame) => void) | null = null;
    let lastJpeg: Buffer | null = null;
    let lastSentFrame = -1;
    const gameT = () => Math.max(0, pageSeconds - realtimeSeconds);
    let kept: KeptStorage | null = null;
    let perf: unknown = null;
    let scene: PageScene = input.sceneReport === true && sceneStarted === null ? "no-shell" : null;
    const session: WebPlaySession = {
      protocol: 2,
      capabilities: new Set(["realtime", "setState", "frames"]),
      boot: { probe: bootProbe, consoleMessages: bootConsole.messages },
      bootPerf: null,
      ended,
      keptStorage: () => kept,
      perf: () => perf,
      scene: () => scene,
      act,
      realtime: async (frames) => {
        realtimeSeconds = pageSeconds;
        tickStart = 0;
        if (frames === undefined) return;
        frameSink = frames.onFrame;
        // A video that never starts is our browser's failure: claimed as a
        // video it would read as a game that drew nothing.
        const opening = context.newCDPSession(page).catch((cause: unknown) => {
          throw classify(cause);
        });
        const cdp = await bounded(opening, PLAY_BOUNDS.webCallMs);
        if (cdp === TIMED_OUT) {
          void opening.then((late) => late.detach()).catch(() => undefined);
          throw new WebBrowserGone("The browser did not start its screencast.");
        }
        screencast = cdp;
        cdp.on("Page.screencastFrame", (event) => {
          void cdp
            .send("Page.screencastFrameAck", { sessionId: event.sessionId })
            .catch(() => undefined);
          lastJpeg = Buffer.from(event.data, "base64");
          lastSentFrame = pageFrames;
          frames.onFrame({ frame: pageFrames, t: gameT(), jpeg: lastJpeg });
          refreshCounters();
        });
        const width = Math.min(frames.width, input.width);
        const started = await bounded(
          cdp
            .send("Page.startScreencast", {
              format: "jpeg",
              quality: 75,
              maxWidth: width,
              maxHeight: Math.round((input.height * width) / input.width),
            })
            .catch((cause: unknown) => {
              throw classify(cause);
            }),
          PLAY_BOUNDS.webCallMs,
        );
        if (started === TIMED_OUT)
          throw new WebBrowserGone("The browser did not start its screencast.");
      },
      nextTick: async (timeoutMs) => {
        if (endedWith !== null) return { kind: "closed" };
        const wait = tickStart + TICK_MS - Date.now();
        if (wait > 0) await sleep(wait);
        tickStart = Date.now();
        const state = await Promise.race([
          readState(timeoutMs),
          ended.then(() => "ended" as const),
        ]);
        if (state === "ended") return { kind: "closed" };
        if (state === TIMED_OUT) return { kind: "timeout" };
        if (state === null) return { kind: "timeout" };
        ticks += 1;
        if (frameSink !== null && lastJpeg !== null && pageFrames > lastSentFrame) {
          lastSentFrame = pageFrames;
          frameSink({ frame: pageFrames, t: gameT(), jpeg: lastJpeg });
        }
        const errors = pageErrors
          .slice(pageErrorsSeen)
          .map((entry) => ({ ...entry, kind: "page" as const }));
        pageErrorsSeen = pageErrors.length;
        const player = sanitizeProbe({ gameState: {}, player: state["player"] })?.player ?? null;
        return {
          kind: "tick",
          observation: {
            op: "tick",
            tick: ticks,
            t: gameT(),
            probe: {
              gameState: asGameState(state["gameState"]),
              player,
              hudText: typeof state["hudText"] === "string" ? state["hudText"] : "",
            },
            errors,
          },
        };
      },
      // A stuck page's input never lands; the next tick reads it as not answering.
      input: async ({ held, taps, clicks }) => {
        const call = (work: Promise<unknown>) =>
          bounded(
            work.catch(() => undefined),
            PLAY_BOUNDS.webCallMs,
          );
        const wanted = new Set(held);
        for (const key of wanted)
          if (!keysDown.has(key)) {
            if ((await call(page.keyboard.down(toPlaywrightKey(key)))) === TIMED_OUT) return;
            keysDown.add(key);
          }
        for (const key of keysDown)
          if (!wanted.has(key)) {
            if ((await call(page.keyboard.up(toPlaywrightKey(key)))) === TIMED_OUT) return;
            keysDown.delete(key);
          }
        for (const tap of taps) {
          if ((await call(page.keyboard.down(toPlaywrightKey(tap)))) === TIMED_OUT) return;
          await sleep(15);
          if ((await call(page.keyboard.up(toPlaywrightKey(tap)))) === TIMED_OUT) return;
        }
        for (const click of clicks)
          if ("x" in click)
            if (
              (await call(page.mouse.click(Math.round(click.x), Math.round(click.y)))) === TIMED_OUT
            )
              return;
      },
      setState: async (target, values) => {
        // Playwright evaluates a string as an expression and never calls it, so the
        // call and its JSON argument are part of the expression.
        const call = `(${STUDIO_SET_STATE})(${JSON.stringify({ target, values })})`;
        const ok = await bounded(
          page.evaluate(call).catch(() => false),
          PLAY_BOUNDS.webCallMs,
        );
        if (ok !== true && refused.length < 20)
          refused.push({
            target,
            error:
              ok === TIMED_OUT
                ? `The page did not answer the write to ${target} within ${PLAY_BOUNDS.webCallMs / 1000} s.`
                : `Unknown setState target ${target}: the game's setState in web/main.js did not accept it.`,
          });
      },
      refusedStates: () => refused,
      still: async (path) =>
        (await bounded(
          page.screenshot({ path }).then(
            () => true,
            () => false,
          ),
          PLAY_BOUNDS.stillMs,
        )) === true,
      // Once, and never failing: the bot loop and its launch both close the
      // session, and a page our own bound already gave up on has nothing to answer.
      close: once(async () => {
        frameSink = null;
        if (screencast !== null)
          await bounded(
            screencast.send("Page.stopScreencast").catch(() => undefined),
            PLAY_BOUNDS.webCallMs,
          );
        try {
          if (endedWith === null) {
            const text = await bounded(
              page.evaluate(READ_STUDIO_PERF).catch(() => null),
              PLAY_BOUNDS.webCallMs,
            );
            if (typeof text === "string")
              try {
                perf = JSON.parse(text);
              } catch {
                perf = null;
              }
            if (sceneStarted === true) {
              const report = await bounded(
                page.evaluate(READ_SCENE).catch(() => null),
                PLAY_BOUNDS.webCallMs,
              );
              if (typeof report === "string")
                try {
                  scene = { raw: JSON.parse(report) };
                } catch {
                  scene = null;
                }
            }
          }
          if (keptStorage !== null && endedWith === null) {
            // Leaving the page fires pagehide as closing the tab would, so a game
            // that saves then (the starter shell's progress does) has written it.
            await page
              .goto("about:blank", { timeout: PLAY_BOUNDS.webLeaveMs })
              .catch(() => undefined);
            // storageState has no timeout and reads through the page, so a game
            // whose main thread is stuck would hold the close forever.
            const state = await bounded(
              context.storageState().catch(() => null),
              PLAY_BOUNDS.webStorageMs,
            );
            // A page that never answered keeps the last saves rather than erasing them.
            if (state !== null && state !== TIMED_OUT)
              kept = {
                path: keptStorage,
                contents: `${JSON.stringify(
                  {
                    localStorage:
                      state.origins.find((entry) => entry.origin === origin)?.localStorage ?? [],
                  },
                  null,
                  2,
                )}\n`,
              };
          }
        } finally {
          await closeBrowser();
        }
      }),
    };
    return session;
  } catch (cause) {
    input.signal?.removeEventListener("abort", abortBoot);
    await closeBrowser();
    throw cause;
  }
};
