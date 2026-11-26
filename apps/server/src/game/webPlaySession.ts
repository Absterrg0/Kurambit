// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off preferSchemaOverJson:off -- This module owns headless Chromium for browser play sessions: wall-clock boot polling and real-time input.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import { PNG } from "pngjs";
import {
  PLAY_SESSION_PROTOCOL,
  type GameConsoleMessage,
  type GameExploreStep,
} from "@kurambit/contracts";
import {
  READ_STUDIO_PERF,
  READ_STUDIO_READY,
  READ_STUDIO_STATE,
  STUDIO_SET_STATE,
  toPlaywrightKey,
  type GameBrowser,
} from "./gameChromium.ts";
import { READ_SCENE, START_SCENE, type PageScene } from "./sceneReport.ts";
import { chromiumChildEnv } from "./gameChromium.ts";
import {
  PLAY_BOUNDS,
  PlayClosed,
  SMALL_FRAME_WIDTH,
  TIMED_OUT,
  bounded,
  once,
  parseLine,
  sanitizeProbe,
  smallFramePath,
  type PlayActObservation,
  type PlayEnd,
  type PlaySession,
} from "./playSession.ts";
import { captureViewport } from "../preview/ServerBrowserPage.ts";

// Playwright needs its files on disk; createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

/**
 * Whether a still is one colour bar a little text: a canvas caught between frames, not a picture of
 * the game. Sampled on a coarse grid, so a page's own text over the canvas does not count.
 */
/**
 * Holds or lets go of the shell's run through its visibility bridge (shell/studio.js), resolving
 * once the shell has heard it; a page without the shell hears nothing and only waits a task.
 */
const HOLD_RUN = `(hold) => new Promise((done) => {
  const heard = (event) => {
    if (event.data?.type !== "studio-visibility") return;
    window.removeEventListener("message", heard);
    setTimeout(done, 0);
  };
  window.addEventListener("message", heard);
  window.postMessage({ type: "studio-visibility", visible: !hold }, "*");
})`;

/** Holds the shell's harness clock (shell.js holdClock): false on a shell without one. */
const HOLD_CLOCK = `typeof window.__studio?.holdClock === "function" && (window.__studio.holdClock(true), true)`;
/**
 * Real time one advance may take: twice its game time and some, so a page slower than real time
 * still plays it, and one that cannot ends the step short rather than holding the act.
 */
const advanceWallMs = (ms: number) => 2 * ms + 10_000;

const looksFlat = (png: Buffer) => {
  const { width, height, data } = PNG.sync.read(png);
  const counts = new Map<number, number>();
  let samples = 0;
  for (let y = 0; y < 40; y += 1)
    for (let x = 0; x < 64; x += 1) {
      const i =
        (Math.floor(((y + 0.5) * height) / 40) * width + Math.floor(((x + 0.5) * width) / 64)) * 4;
      const key = ((data[i]! >> 3) << 10) | ((data[i + 1]! >> 3) << 5) | (data[i + 2]! >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      samples += 1;
    }
  return Math.max(...counts.values()) >= samples * 0.97;
};

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 500;
const MAX_PAGE_ERRORS = 100;

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
/** " (at <url>:<line>:<col>)" from a stack's first frame that names a file; "" when none does. */
const atFrame = (stack: string) => {
  const frame = /(?:https?|file):\/\/\S+:\d+:\d+/.exec(stack)?.[0];
  return frame === undefined ? "" : ` (at ${frame})`;
};

export class WebPageNotReady extends Error {
  readonly timedOut: boolean;
  /** Why the page could not be opened at all, when it could not. */
  readonly navigation: string | null;
  constructor(
    timedOut: boolean,
    bootTimeoutMs: number,
    navigation: string | null = null,
    /** The page's first error, so a start that failed says why without another check. */
    error: { readonly message: string; readonly where: string } | null = null,
  ) {
    super(
      timedOut
        ? `The page never reported ready (window.__studio.ready stayed false past ${Math.round(bootTimeoutMs / 1000)}s${navigation === null ? "" : `; its navigation failed: ${navigation}`}); no session was opened.`
        : navigation !== null
          ? `The page could not be opened (${navigation}); no session was opened.`
          : `The page errored before window.__studio appeared${error === null ? "" : `: ${error.message}${atFrame(error.where)}`}; no session was opened.`,
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
/**
 * A page's WebGL context was lost: the shell's own line (shell/studio.js), Chromium's, or
 * three.js's from a shell that predates it.
 */
const RENDERER_LOST = /WebGL context lost|CONTEXT_LOST_WEBGL|THREE\.WebGLRenderer: Context Lost/;
/** Set before any script runs: the shell's QA counters (shell/studio.js) wrap what it watches. */
const QA_COUNTERS = "window.__studioQa = true;";
/**
 * The QA play: every control, then Retry, stepped on the game's own clock (shell/qa.js): a few
 * seconds on any machine. Its bound covers a run that compiles slowly.
 */
const QA_PLAY_MS = 120_000;
const RUN_QA = `(async () => {
  const qa = window.__studio?.qa;
  if (qa === null || typeof qa !== "object" || typeof qa.run !== "function") return "no-qa";
  try {
    return JSON.parse(JSON.stringify(await qa.run()));
  } catch {
    return null;
  }
})()`;
/** A kept play run again (shell/replay.js): far faster than real time, so a bound on its length is generous. */
const REPLAY_MS = (seconds: number) => 60_000 + seconds * 1_000;
const RUN_REPLAY = `(async (play, options) => {
  const replay = window.__studio?.replay;
  if (typeof replay !== "function") return "no-replay";
  try {
    return JSON.parse(JSON.stringify(await replay(play, options)));
  } catch {
    return null;
  }
})`;
const RUN_BOT = `(async (source, options) => {
  const bot = window.__studio?.bot;
  if (typeof bot !== "function") return "no-bot";
  try {
    return JSON.parse(JSON.stringify(await bot(source, options)));
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
})`;
const TAKE_PLAYS = `(() => {
  const take = window.__studio?.takePlays;
  return typeof take === "function" ? JSON.parse(JSON.stringify(take())) : [];
})()`;
/** One view of a model sheet, as shell/sheet.js draws it: a label and the direction it looks from. */
export interface SheetView {
  readonly label: string;
  readonly dir: readonly [number, number, number];
}
/** One model sheet (shell/sheet.js): four draws, which in software on a big model take seconds. */
const SHEET_MS = 20_000;
const DRAW_SHEET = `((name, views) => {
  const sheet = window.__studio?.sheet;
  if (sheet === null || typeof sheet !== "object" || typeof sheet.draw !== "function") return "no-sheet";
  try {
    return JSON.parse(JSON.stringify(sheet.draw(name, views ?? undefined)));
  } catch (error) {
    return { error: String(error).slice(0, 300) };
  }
})`;
const READ_HUD = `(() => {
  const qa = window.__studio?.qa;
  if (qa === null || typeof qa !== "object" || typeof qa.hud !== "function") return null;
  try {
    return JSON.parse(JSON.stringify(qa.hud()));
  } catch {
    return null;
  }
})()`;
/**
 * The window as a player sees it at this size: the part of it the largest canvas covers, and the
 * shell's HUD reading (shell/qa.js) where it has one.
 */
const READ_SCREEN = `(() => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const boxes = [...document.querySelectorAll("canvas")]
    .map((canvas) => canvas.getBoundingClientRect())
    .filter((box) => box.width > 0 && box.height > 0)
    .sort((a, b) => b.width * b.height - a.width * a.height);
  const box = boxes[0];
  const canvas = box === undefined ? null : {
    width: Math.round(Math.max(0, Math.min(box.right, width) - Math.max(box.left, 0))),
    height: Math.round(Math.max(0, Math.min(box.bottom, height) - Math.max(box.top, 0))),
  };
  let hud = null;
  try {
    const qa = window.__studio?.qa;
    if (qa !== null && typeof qa === "object" && typeof qa.hud === "function")
      hud = JSON.parse(JSON.stringify(qa.hud()));
  } catch {}
  return { width, height, canvas, hud };
})()`;
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
const PAGE_ICONS = `[...document.querySelectorAll('link[rel~="icon" i]')].slice(0, 16).map((link) => link.href)`;

/** What a kept session's page left in its storage, for the caller to write back. */
export interface KeptStorage {
  readonly path: string;
  readonly contents: string;
}

/** How long an agent's `eval` expression may run in the page (scaled in software, to EVALUATE_MOST_MS). */
const EVALUATE_MS = 10_000;
const EVALUATE_MOST_MS = 60_000;
/**
 * An agent's expression, run with the run's `ctx` and `GameState` in scope (shell studio.scope):
 * main.js holds them in module scope, so the page's globals never had them. A direct eval in a
 * function keeps the expression's statements and completion value as the page's own eval would.
 */
const scopedEval = (expression: string) => `((__expression) => {
  const __scope = window.__studio?.scope?.() ?? {};
  return (function (ctx, GameState) {
    return eval(__expression);
  })(__scope.ctx ?? undefined, __scope.GameState ?? undefined);
})(${JSON.stringify(expression)})`;

/** The page's own frame time, over three frames drawn as it runs. */
const FRAME_COST = `new Promise((done) => {
  const times = [];
  const tick = (now) => {
    times.push(now);
    if (times.length >= 4) done((times[3] - times[0]) / 3);
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})`;
const FRAME_COST_MS = 10_000;
/** The frame a bound is made for (30 fps), and the most a slower page stretches it. */
const SCALE_FRAME_MS = 33;
const MAX_SCALE = 15;
/** From an act's first input, how long the probe is watched for a change, and in what slices. */
const WATCH_MS = 500;
const WATCH_SLICE_MS = 100;

interface ActProgress {
  gameMs: number;
  wallMs: number;
  /** Where the page fell short, in numbers. */
  short: string | null;
}

/** Milliseconds as seconds to a tenth, as the act's numbers say them. */
const seconds = (ms: number) => String(Math.round(ms / 100) / 10);

/** What an act's probe reading holds, keyed, so its first change can be named. */
const stateKeys = (raw: Record<string, unknown> | null) => {
  const probe = sanitizeProbe(raw);
  const keys = new Map<string, string>();
  if (probe === null) return keys;
  if (probe.player !== null)
    keys.set(
      "player",
      [probe.player.x, probe.player.y, probe.player.z].map((v) => v.toFixed(2)).join(","),
    );
  for (const [key, value] of Object.entries(probe.gameState))
    keys.set(`GameState.${key}`, String(value));
  if (probe.hudText !== undefined) keys.set("hud", probe.hudText);
  return keys;
};
const changedKeys = (before: Map<string, string>, after: Map<string, string>) =>
  [...new Set([...before.keys(), ...after.keys()])]
    .filter((key) => before.get(key) !== after.get(key))
    .slice(0, 8);

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
   * After `close`: the bytes the page loaded since it opened (every finished request's body and
   * headers, as sent), on a session opened with `countBytes`; null otherwise.
   */
  readonly loadedBytes: () => number | null;
  /** The window, the part of it the canvas covers and the HUD's reading (READ_SCREEN); null when the page did not answer. */
  readonly screen: () => Promise<unknown>;
  /**
   * After `close`: the scene report of a session opened with `sceneReport`, read just before
   * the page closed; "no-shell" when the game's shell has none, null when it could not be read
   * or was not asked for.
   */
  readonly scene: () => PageScene;
  /**
   * The shell's QA play on a session opened with `qa` (shell/qa.js): every control, Retry,
   * and the HUD at the session's size and at a narrow 4:3, the page put back after. Null when
   * the page did not answer in time, "no-qa" when the shell has none.
   */
  readonly qa: () => Promise<unknown>;
  /**
   * Runs a kept play again from its seed and input (shell/replay.js) and returns what the page
   * answered: null when it did not in time, "no-replay" when the shell has no replay.
   * `drawEvery`: the page draws one frame in that many while it replays; `at`: it stops and
   * holds at that second of play, its frame drawn.
   */
  readonly replay: (
    play: { readonly steps: number; readonly dt: number },
    options?: { readonly drawEvery: number; readonly at?: number },
  ) => Promise<unknown>;
  /**
   * Lays the model sheet of one named thing over the page (shell/sheet.js) and returns its
   * measures; with null, the things it could draw. Null when the page did not answer in time,
   * "no-sheet" when the shell has none. `still` then takes the picture.
   */
  readonly sheet: (name: string | null, views?: ReadonlyArray<SheetView>) => Promise<unknown>;
  /** The window at another size, as a player's would be; the page lays itself out again. */
  readonly resize: (width: number, height: number) => Promise<void>;
}

/**
 * The browser host of the play-session protocol: headless Chromium on a
 * served static folder, real keyboard and mouse through the browser, and the
 * page's read-only `window.__studio` bridge (ready, getState, setState) for
 * what the game sees. An act holds the shell's clock (holdClock) and its
 * waits and holds step the game by that much game time as fast as the page
 * allows, so the game stands still between acts; a shell without the clock
 * plays in real time. Pages read no control tree, so the
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
   * Hears, once the page is ready, the URLs of its tab icons (`<link rel="icon">`): a tab
   * shows them, but a headless browser never fetches them, so asset use counts them here.
   */
  readonly onPageIcons?: ((urls: ReadonlyArray<string>) => void) | undefined;
  /**
   * Ends the boot wait once a page error or a failed script came before the
   * bridge: the check reports that page as broken. A player's page (explore,
   * bots) gives such a page PLAY_BOUNDS.bootErrorGraceMs to show its bridge.
   */
  readonly stopOnPageError?: boolean | undefined;
  /** Starts the shell's scene report once the page is ready; `scene()` has it after close. */
  readonly sceneReport?: boolean | undefined;
  /** Turns the shell's QA counters on before any script runs, so `qa()` can play its QA play. */
  readonly qa?: boolean | undefined;
  /** Counts the bytes the page loads from the start, for `loadedBytes()`. */
  readonly countBytes?: boolean | undefined;
  /** A probe of the caller's own, run before any of the page's scripts (playerProbe.ts). */
  readonly initScript?: string | undefined;
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
    if (input.qa === true) await context.addInitScript(QA_COUNTERS);
    if (input.initScript !== undefined) await context.addInitScript(input.initScript);
    const onSound = input.onSoundStarted;
    if (onSound !== undefined) {
      await context.exposeBinding(SOUND_BINDING, (_source, sound: unknown) => {
        if (typeof sound === "string") onSound(sound.slice(0, 2000));
      });
      await context.addInitScript(SOUND_TAP);
    }
    const page = await context.newPage();
    // Sizes are read from the browser as each request finishes, so all are in before it closes.
    const sizes: Array<Promise<number>> = [];
    if (input.countBytes === true)
      page.on("requestfinished", (request) => {
        sizes.push(
          request.sizes().then(
            (size) => Math.max(0, size.responseBodySize) + Math.max(0, size.responseHeadersSize),
            () => 0,
          ),
        );
      });
    let loaded: number | null = null;
    page.on("crash", () => settleEnded({ by: "game", detail: new WebPageCrashed().message }));
    const pending: GameConsoleMessage[] = [];
    let dropped = 0;
    const record = (level: GameConsoleMessage["level"], text: string): void => {
      // The browser's own chrome, not the game: a missing favicon is not a
      // game failure (the starter links its own icon so it never fires).
      if (/favicon\.ico/i.test(text)) return;
      if (pending.length >= MAX_MESSAGES) {
        pending.shift();
        dropped += 1;
      }
      pending.push({ level, text: text.slice(0, MAX_MESSAGE_CHARS) });
    };
    // Page errors, with the stack as `where`: the first says why a page did not boot.
    const pageErrors: Array<{ message: string; where: string }> = [];
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
    // After the page's WebGL context was lost, its errors are the renderer's (shell/studio.js):
    // said at level "renderer", never counted as the game's errors or as why it did not boot.
    let rendererLost = false;
    const renderers = (text: string) => {
      notify({ kind: "console", level: "renderer", text, url: "" });
      record("warning", `renderer: ${text.trim()}`);
    };
    page.on("console", (message) => {
      const type = String(message.type() ?? "log");
      if (RENDERER_LOST.test(message.text())) rendererLost = true;
      if (rendererLost && type === "error") return renderers(message.text());
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
      if (rendererLost) return renderers(error instanceof Error ? error.message : String(error));
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
    // A software GPU that is busy or restarting can hand the compositor an empty canvas although
    // the game drew: a proof picture came back black while its own frame counted 8 draws. A flat
    // still is taken again once the page has drawn twice more (or a quarter second has passed).
    // The run is held while its frame is taken (the shell's hidden-stage hold): a game that keeps
    // drawing makes the screenshot wait on its frames, 8 to 12 s in software, while its run moves
    // on past the moment the act's reading describes. Held, the picture is that moment.
    // The small frame an agent is shown comes from the browser's own JPEG encoder at a smaller
    // scale (the preview's capture), taken in the same hold as the PNG, so both are one moment.
    const cdp = once(() => context.newCDPSession(page));
    const small = async () => {
      const data = await cdp()
        .then((session) =>
          captureViewport(page, session, {
            format: "jpeg",
            quality: 80,
            scale: Math.min(1, SMALL_FRAME_WIDTH / size.width),
          }),
        )
        .catch(() => null);
      return data === null ? null : Buffer.from(data, "base64");
    };
    const shoot = async (withSmall = false) => {
      await bounded(
        page.evaluate(`(${HOLD_RUN})(true)`).catch(() => undefined),
        PLAY_BOUNDS.webCallMs,
      );
      let smallShot: Buffer | null = null;
      const first = await page
        .screenshot({ type: "png" })
        .catch(() => null)
        .then(async (png) => {
          if (withSmall && png !== null && !looksFlat(png)) smallShot = await small();
          return png;
        })
        .finally(() =>
          bounded(
            page.evaluate(`(${HOLD_RUN})(false)`).catch(() => undefined),
            PLAY_BOUNDS.webCallMs,
          ),
        );
      if (first === null || !looksFlat(first)) return { png: first, small: smallShot };
      await page
        .evaluate(
          "new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 250); })",
        )
        .catch(() => undefined);
      const second = await page.screenshot({ type: "png" }).catch(() => first);
      return { png: second, small: withSmall ? await small() : null };
    };
    /** A frame kept at `path` (PNG), its small JPEG beside it; false when no picture came. */
    const keepShot = async (path: string) => {
      const shot = await bounded(shoot(true), PLAY_BOUNDS.stillMs * scale);
      if (shot === TIMED_OUT || shot.png === null) return false;
      const kept = await NodeFSP.writeFile(path, shot.png).then(
        () => true,
        () => false,
      );
      if (kept && shot.small !== null)
        await NodeFSP.writeFile(smallFramePath(path), shot.small).catch(() => undefined);
      return kept;
    };
    /** The page's state; TIMED_OUT when its main thread did not answer in `ms`. */
    const readState = async (ms: number) => {
      const raw = await bounded(
        page.evaluate(READ_STUDIO_STATE).catch(() => null),
        ms,
      );
      if (raw === TIMED_OUT) return TIMED_OUT;
      return typeof raw === "string" ? parseLine(raw) : null;
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
      // no bridge together end the wait early: at once for the check, and for a
      // player's page once the bridge is still missing PLAY_BOUNDS.bootErrorGraceMs
      // after the error, as a page that recovers would have shown it by then.
      // Waiting out the whole boot bound cost an agent 90 s per start on a broken page.
      let watchErrors = true;
      const graceMs = input.stopOnPageError === true ? 0 : PLAY_BOUNDS.bootErrorGraceMs;
      let grace: ReturnType<typeof setTimeout> | undefined;
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
            const errored = () => {
              if (!watchErrors || grace !== undefined) return;
              if (graceMs === 0) resolve("errored");
              else grace = setTimeout(() => resolve("errored"), graceMs);
            };
            onPageErrored = errored;
            if (pageErrored) errored();
          }),
        ]);
        onPageErrored = () => undefined;
        clearTimeout(grace);
        grace = undefined;
        if (outcome === "ready") break;
        if (outcome === "timeout") throw new WebPageNotReady(true, input.bootTimeoutMs, navigation);
        if (outcome === "errored") {
          const bridge = await bounded(
            page.evaluate(READ_STUDIO_READY).catch(() => null),
            PLAY_BOUNDS.webCallMs,
          );
          if (bridge === null || bridge === TIMED_OUT)
            throw new WebPageNotReady(
              false,
              input.bootTimeoutMs,
              navigation,
              pageErrors[0] ?? null,
            );
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
    if (input.onPageIcons !== undefined) {
      const icons = await bounded(
        page.evaluate(PAGE_ICONS).catch(() => null),
        PLAY_BOUNDS.webCallMs,
      );
      if (Array.isArray(icons))
        input.onPageIcons(icons.filter((url): url is string => typeof url === "string"));
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
    // The page's size now: an act may resize it, as a player resizes their window.
    let size = { width: input.width, height: input.height };
    const centre = () => ({ x: Math.round(size.width / 2), y: Math.round(size.height / 2) });
    // Whether an act held the shell's clock: a scripted run lets it go while it plays, then holds it again.
    let clockHeld = false;
    // In software one frame can cost a second, and a shader compile several: every bound an
    // act or eval waits on is scaled by the frame cost measured before the first, so a slow
    // page is read as slow, in numbers, never as one that stopped answering.
    let frameMs: number | null = null;
    let scale = 1;
    const measured = once(async () => {
      if (!input.browser.software) return;
      const cost = await bounded(
        page.evaluate(FRAME_COST).catch(() => null),
        FRAME_COST_MS,
      );
      frameMs = typeof cost === "number" && Number.isFinite(cost) ? Math.round(cost) : null;
      scale =
        frameMs === null ? MAX_SCALE : Math.min(MAX_SCALE, Math.max(1, frameMs / SCALE_FRAME_MS));
    });
    const callMs = () => Math.round(PLAY_BOUNDS.webCallMs * scale);
    const software = () =>
      input.browser.software
        ? ` This browser draws in software${frameMs === null ? "" : `: one frame takes about ${frameMs} ms`}.`
        : "";
    // The act before still holding the page (it stopped answering): the next waits for it first.
    let running: Promise<unknown> = Promise.resolve();
    const actBody = async (
      steps: readonly GameExploreStep[],
      screenshotPath: string | null,
      signal: AbortSignal,
      framePath: ((n: number) => string) | undefined,
      progress: ActProgress,
    ) => {
      let executedInputSteps = 0;
      const frames: Array<{ label: string; path: string }> = [];
      const held: string[] = [];
      // Held again each act: the game may have reloaded its page since the last.
      const clocked = await bounded(
        page.evaluate(HOLD_CLOCK).catch(() => false),
        callMs(),
      );
      if (clocked === TIMED_OUT) {
        progress.short = `the page took over ${seconds(callMs())} s to answer before the act began`;
        return null;
      }
      clockHeld ||= clocked === true;
      const first = await readState(callMs());
      if (first === TIMED_OUT) {
        progress.short = `the page took over ${seconds(callMs())} s to answer before the act began`;
        return null;
      }
      const before = stateKeys(first);
      // Set from closures, so held in an object TypeScript does not narrow.
      const seen: {
        watch: { gameMs: number; wallStart: number } | null;
        response?: PlayActObservation["response"];
      } = { watch: null };
      /** `ms` of game time: stepped on the held clock, else played in real time. False when the page fell short. */
      const stepGame = async (ms: number, what: string) => {
        const at = Date.now();
        if (clocked !== true) {
          await sleep(ms, signal);
          progress.gameMs += ms;
          progress.wallMs += Date.now() - at;
          return true;
        }
        const wallMs = Math.round(advanceWallMs(ms) * scale);
        const stepped = await bounded(
          page
            .evaluate(`window.__studio.advanceClock(${ms / 1000}, ${wallMs})`)
            .catch(() => undefined),
          wallMs + callMs(),
        );
        const took = Date.now() - at;
        progress.wallMs += took;
        const steppedMs = typeof stepped === "number" ? stepped * 1000 : 0;
        if (stepped !== TIMED_OUT) progress.gameMs += steppedMs;
        signal.throwIfAborted();
        // Short with its wall bound spent is a page slower than the act allows; short with time
        // to spare is a run nothing could move (ended, paused), which the probe shows.
        if (stepped === TIMED_OUT || (steppedMs < ms - 1 && took >= wallMs)) {
          progress.short = `${what} took ${seconds(took)} s of wall time for ${seconds(stepped === TIMED_OUT ? 0 : steppedMs)} of its ${seconds(ms)} s of game time; the act stopped at ${seconds(progress.gameMs)} s of game time`;
          return false;
        }
        return true;
      };
      // From the first input, play is stepped in slices of one slow frame's game time (the
      // shell's catch-up), each followed by a read: a slice costs about what a frame costs a
      // person, so the first change is timed as they would see it.
      const pass = async (ms: number, what: string) => {
        let left = ms;
        while (seen.watch !== null && left > 0) {
          const slice = Math.min(left, WATCH_SLICE_MS);
          if (!(await stepGame(slice, what))) return false;
          left -= slice;
          seen.watch.gameMs += slice;
          const now = await readState(callMs());
          if (now === TIMED_OUT) {
            progress.short = `the page took over ${seconds(callMs())} s to answer a read during ${what}; the act stopped at ${seconds(progress.gameMs)} s of game time`;
            return false;
          }
          const changed = changedKeys(before, stateKeys(now));
          if (changed.length > 0 || seen.watch.gameMs >= WATCH_MS) {
            seen.response = {
              gameMs: changed.length > 0 ? seen.watch.gameMs : null,
              wallMs: changed.length > 0 ? Date.now() - seen.watch.wallStart : null,
              watchedMs: seen.watch.gameMs,
              changed,
            };
            seen.watch = null;
          }
        }
        return left <= 0 || (await stepGame(left, what));
      };
      const sent = () => {
        if (seen.response === undefined && seen.watch === null)
          seen.watch = { gameMs: 0, wallStart: Date.now() };
      };
      // Each step releases its own keys, as the process runners do: a key held
      // into the next step would move the player through it, and pressing the
      // same key again would arrive as auto-repeat, which games ignore.
      const holdKeys = async (keys: ReadonlyArray<string>, ms: number, what: string) => {
        const mapped = keys.map(toPlaywrightKey);
        for (const key of mapped) {
          await page.keyboard.down(key);
          held.push(key);
        }
        sent();
        const passed = await pass(ms, what);
        for (const key of mapped) {
          await page.keyboard.up(key);
          held.splice(held.indexOf(key), 1);
        }
        executedInputSteps += 1;
        return passed;
      };
      try {
        for (const step of steps) {
          signal.throwIfAborted();
          let passed = true;
          if ("waitMs" in step) {
            passed = await pass(step.waitMs, `a ${seconds(step.waitMs)} s wait`);
          } else if ("screenshot" in step) {
            // The frame as the route stands here; the game holds still while it is taken.
            if (framePath !== undefined) {
              const path = framePath(frames.length + 1);
              if (await keepShot(path)) frames.push({ label: step.screenshot, path });
            }
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
            sent();
            executedInputSteps += 1;
          } else if ("drag" in step) {
            const { from, to } = step.drag;
            await page.mouse.move(from.x, from.y);
            await page.mouse.down();
            sent();
            passed = await pass(step.holdMs, `a ${seconds(step.holdMs)} s drag`);
            await page.mouse.move(to.x, to.y, { steps: 8 });
            await page.mouse.up();
            pointer = { x: to.x, y: to.y };
            executedInputSteps += 1;
          } else if ("mouseMove" in step) {
            const base = pointer ?? centre();
            const next = {
              x: Math.max(0, Math.min(size.width, base.x + step.mouseMove.dx)),
              y: Math.max(0, Math.min(size.height, base.y + step.mouseMove.dy)),
            };
            await page.mouse.move(Math.round(next.x), Math.round(next.y));
            pointer = next;
            sent();
            executedInputSteps += 1;
          } else if ("keys" in step) {
            passed = await holdKeys(step.keys, step.holdMs, `a ${seconds(step.holdMs)} s hold`);
          } else if ("key" in step) {
            passed = await holdKeys([step.key], step.holdMs, `a ${seconds(step.holdMs)} s hold`);
          } else if ("hold" in step) {
            passed = await holdKeys([step.hold], step.holdMs, `a ${seconds(step.holdMs)} s hold`);
          } else if ("press" in step) {
            passed = await holdKeys([step.press], 50, "a press");
          } else {
            // The session lists no ui or inspect capability, so explore refuses
            // those steps before any browser work.
            throw new Error("Unsupported browser step: ui and inspect steps need a control tree.");
          }
          if (!passed) break;
          signal.throwIfAborted();
        }
      } finally {
        for (const key of held.splice(0))
          await bounded(page.keyboard.up(key), PLAY_BOUNDS.webCallMs);
      }
      if (seen.watch !== null)
        seen.response = { gameMs: null, wallMs: null, watchedMs: seen.watch.gameMs, changed: [] };
      const state = await readState(callMs());
      if (state === TIMED_OUT) {
        progress.short ??= `the page took over ${seconds(callMs())} s to answer the read after the act`;
        return {
          executedInputSteps,
          frames,
          response: seen.response,
          probe: null,
          screenshot: false,
        };
      }
      const probe = sanitizeProbe(state);
      const saved = screenshotPath === null ? false : await keepShot(screenshotPath);
      return { executedInputSteps, frames, response: seen.response, probe, screenshot: saved };
    };
    const act: PlaySession["act"] = async (steps, screenshotPath, signal, framePath) => {
      signal?.throwIfAborted();
      if (endedWith !== null) throw endError(endedWith);
      await measured();
      const progress: ActProgress = { gameMs: 0, wallMs: 0, short: null };
      const observed = (body: Awaited<ReturnType<typeof actBody>> | null): PlayActObservation => {
        const drained = drain();
        return {
          probe: body?.probe ?? null,
          executedInputSteps: body?.executedInputSteps ?? 0,
          screenshot: body?.screenshot ?? false,
          frames: body?.frames ?? [],
          consoleMessages: drained.messages,
          consoleTruncated: drained.truncated,
          clock: { gameMs: Math.round(progress.gameMs), wallMs: progress.wallMs },
          ...(body?.response === undefined ? {} : { response: body.response }),
          ...(progress.short === null ? {} : { short: `${progress.short}.${software()}` }),
        };
      };
      const waited = Date.now();
      if ((await bounded(running, callMs())) === TIMED_OUT) {
        progress.short = `the page was still busy with the previous act after another ${seconds(Date.now() - waited)} s of wall time`;
        return observed(null);
      }
      const stepMs = steps.reduce(
        (sum, step) =>
          sum +
          ("waitMs" in step ? step.waitMs : "holdMs" in step ? step.holdMs : 0) +
          ("press" in step ? 50 : 0),
        0,
      );
      const frameSteps = steps.filter((step) => "screenshot" in step).length;
      const stop = new AbortController();
      const body = actBody(
        steps,
        screenshotPath,
        signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]),
        framePath,
        progress,
      );
      running = body.catch(() => undefined);
      // Each step's advance may take its own wall bound on a slow page, each frame its own.
      const boundMs = Math.round(
        (steps.length * advanceWallMs(0) +
          2 * stepMs +
          frameSteps * PLAY_BOUNDS.stillMs +
          PLAY_BOUNDS.webActGraceMs) *
          scale,
      );
      const done = await Promise.race([
        bounded(
          body.catch((cause: unknown) => {
            throw classify(cause);
          }),
          boundMs,
        ),
        ended.then((end) => ({ end })),
      ]);
      if (done !== null && typeof done === "object" && "end" in done) throw endError(done.end);
      if (done === TIMED_OUT) {
        // The session stays: the next act waits for this one's page to answer first.
        stop.abort();
        progress.short ??= `its ${seconds(stepMs)} s of game time had not played after ${seconds(boundMs)} s of wall time; the act stopped at ${seconds(progress.gameMs)} s of game time`;
        return observed(null);
      }
      return observed(done);
    };
    const keysDown = new Set<string>();
    const refused: Array<{ target: string; error: string }> = [];
    let kept: KeptStorage | null = null;
    let perf: unknown = null;
    let scene: PageScene = input.sceneReport === true && sceneStarted === null ? "no-shell" : null;
    const session: WebPlaySession = {
      protocol: PLAY_SESSION_PROTOCOL,
      capabilities: new Set(["setState"]),
      boot: { probe: bootProbe, consoleMessages: bootConsole.messages },
      bootPerf: null,
      ended,
      keptStorage: () => kept,
      perf: () => perf,
      loadedBytes: () => loaded,
      screen: async () => {
        const read = await bounded(
          page.evaluate(READ_SCREEN).catch(() => null),
          PLAY_BOUNDS.webCallMs,
        );
        return read === TIMED_OUT ? null : read;
      },
      scene: () => scene,
      replay: async (play, options) => {
        const answered = await bounded(
          page
            .evaluate(`${RUN_REPLAY}(${JSON.stringify(play)}, ${JSON.stringify(options ?? {})})`)
            .catch(() => null),
          REPLAY_MS(play.steps * play.dt),
        );
        return answered === TIMED_OUT ? null : answered;
      },
      stepBot: async (source, options) => {
        // An act's held clock would keep the run from stepping: let go for the run, held after.
        const held = clockHeld;
        if (held)
          await bounded(
            page.evaluate("window.__studio?.holdClock?.(false)").catch(() => undefined),
            callMs(),
          );
        const answered = await bounded(
          page
            .evaluate(`${RUN_BOT}(${JSON.stringify(source)}, ${JSON.stringify(options)})`)
            .catch(() => null),
          options.wallMs + 15_000,
        );
        if (held)
          await bounded(
            page.evaluate(HOLD_CLOCK).catch(() => undefined),
            callMs(),
          );
        return answered === TIMED_OUT ? null : answered;
      },
      resize: async (width, height) => {
        await bounded(
          page.setViewportSize({ width, height }).then(
            () => {
              size = { width, height };
            },
            () => undefined,
          ),
          PLAY_BOUNDS.webCallMs,
        );
      },
      evaluate: async (expression) => {
        await measured();
        const boundMs = Math.min(EVALUATE_MOST_MS, Math.round(EVALUATE_MS * scale));
        const answered = await bounded(
          page.evaluate(scopedEval(expression)).then(
            (value: unknown) => ({ value: value ?? null }),
            (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
          ),
          boundMs,
        );
        return answered === TIMED_OUT
          ? {
              error: `The expression had not finished after ${seconds(boundMs)} s of wall time.${software()}`,
            }
          : answered;
      },
      takePlays: async () => {
        if (endedWith !== null) return [];
        const taken = await bounded(
          page.evaluate(TAKE_PLAYS).catch(() => null),
          PLAY_BOUNDS.webCallMs,
        );
        return Array.isArray(taken) ? taken : [];
      },
      sheet: async (name, views) => {
        const answered = await bounded(
          page
            .evaluate(`${DRAW_SHEET}(${JSON.stringify(name)}, ${JSON.stringify(views ?? null)})`)
            .catch(() => null),
          SHEET_MS,
        );
        return answered === TIMED_OUT ? null : answered;
      },
      qa: async () => {
        const played = await bounded(
          page.evaluate(RUN_QA).catch(() => null),
          QA_PLAY_MS,
        );
        if (played === TIMED_OUT || played === null) return null;
        if (played === "no-qa") return played;
        const wide = await bounded(
          page.evaluate(READ_HUD).catch(() => null),
          PLAY_BOUNDS.webCallMs,
        );
        await page.setViewportSize({
          width: Math.round((input.height * 4) / 3),
          height: input.height,
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        const narrow = await bounded(
          page.evaluate(READ_HUD).catch(() => null),
          PLAY_BOUNDS.webCallMs,
        );
        await page.setViewportSize({ width: input.width, height: input.height });
        return {
          ...(played as object),
          hud: [wide, narrow].filter((each) => each !== TIMED_OUT && each !== null),
        };
      },
      act,
      // A stuck page's input never lands; the next read finds it not answering.
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
      // A frame an agent is shown waits as an act's does, on the page's measured frame cost: a
      // check's look on a slow software page lost both its frames to a bound made for 30 fps.
      still: async (path, withSmall = false) =>
        withSmall
          ? measured().then(() => keepShot(path))
          : (await bounded(
              shoot().then(({ png }) =>
                png === null
                  ? false
                  : NodeFSP.writeFile(path, png).then(
                      () => true,
                      () => false,
                    ),
              ),
              PLAY_BOUNDS.stillMs,
            )) === true,
      // Once, and never failing: the bot loop and its launch both close the
      // session, and a page our own bound already gave up on has nothing to answer.
      close: once(async () => {
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
              // Reading encodes up to eight frames as PNG on the page's main thread: 0.2 s on a
              // GPU, over 3 s in software with a second play beside it (a build's idle and
              // random-input plays), so it gets a still's bound, not one input's.
              const report = await bounded(
                page.evaluate(READ_SCENE).catch(() => null),
                PLAY_BOUNDS.stillMs,
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
            // that saves then (KEEP_ACROSS_RUNS progress does) has written it.
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
          if (input.countBytes === true) {
            const all = await bounded(Promise.all(sizes), PLAY_BOUNDS.webCallMs);
            if (all !== TIMED_OUT) loaded = all.reduce((sum, bytes) => sum + bytes, 0);
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
