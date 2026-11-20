// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Drives a headless page in real time, as GameThreeEngine does. Reads the probe's own stills to compare and measure them.
// The first minute as a player meets it (GamePlayerReport): the page opened as a player opens it,
// no `?play`, pressed as a person would press it. No model call: every reading is the page's own
// clock, DOM and audio graph, or the pixels of a still. What cannot be read says why.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { PNG } from "pngjs";
import { THREE_VIEWPORT, type GamePlayerReport } from "@kurambit/contracts";
import type { GameBrowser } from "./gameChromium.ts";
import { openWebPlaySession, type WebPlaySession } from "./webPlaySession.ts";

/** How long a press may take to start play before the next kind of press is tried. */
const PRESS_WAIT_MS = 1_500;
/** DESIGN-RECIPES: the text wall is read from opening through this much play. */
const WALL_PLAY_MS = 10_000;
/** The no-input run: a loss within this much game time is "can be lost early". */
const IDLE_SECONDS = 120;
const IDLE_WALL_MS = 30_000;
/** A sound within this long of the first input answers it. */
const ANSWER_MS = 1_000;
const SIZES = { text1080: [1920, 1080], text800: [1280, 800] } as const;
const BOOT_MS = 30_000;

/**
 * Before any script: when the page was ready (its first frame drawn), every key and pointer press, every
 * sound that started (Web Audio sources and media elements), and the mix's sample peak, read by
 * an analyser placed between the graph and the speakers.
 */
const PROBE = `(() => {
  const kp = { ready: null, played: null, inputs: [], sounds: [], peak: 0, graph: false };
  window.__kp = kp;
  const raf = window.requestAnimationFrame.bind(window);
  const watch = () => {
    if (kp.ready === null && window.__studio?.ready === true) kp.ready = performance.now();
    if (kp.played === null && document.body?.dataset.state === "playing") kp.played = performance.now();
    if (kp.ready === null || (kp.played === null && performance.now() < ${BOOT_MS})) raf(watch);
  };
  raf(watch);
  for (const type of ["keydown", "pointerdown"])
    window.addEventListener(type, () => kp.inputs.push(performance.now()), { capture: true });
  if (typeof AudioNode === "undefined") return;
  const started = () => kp.sounds.push(performance.now());
  const start = AudioScheduledSourceNode.prototype.start;
  AudioScheduledSourceNode.prototype.start = function (...args) {
    started();
    return start.apply(this, args);
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    started();
    return play.apply(this, args);
  };
  const taps = new Map();
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (target, ...rest) {
    if (!(target instanceof AudioDestinationNode)) return connect.call(this, target, ...rest);
    let tap = taps.get(target);
    if (tap === undefined) {
      tap = target.context.createAnalyser();
      tap.fftSize = 2048;
      connect.call(tap, target);
      taps.set(target, tap);
    }
    kp.graph = true;
    connect.call(this, tap, ...rest);
    return target;
  };
  const samples = new Float32Array(2048);
  setInterval(() => {
    for (const tap of taps.values()) {
      tap.getFloatTimeDomainData(samples);
      for (let i = 0; i < samples.length; i++) kp.peak = Math.max(kp.peak, Math.abs(samples[i]));
    }
  }, 40);
})()`;

/** The share of a grid over the window whose topmost thing is page text or an opaque panel, not the game's canvas. */
const COVER = `(() => {
  const opaque = (el) => {
    for (let at = el; at && at !== document.body && at !== document.documentElement; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.backgroundImage !== "none") return true;
      const alpha = style.backgroundColor.match(/rgba?\\(([^)]+)\\)/)?.[1].split(",").map(Number);
      if (alpha && (alpha.length < 4 ? 1 : alpha[3]) * Number(style.opacity) >= 0.5) return true;
    }
    return false;
  };
  const onText = (el, x, y) => {
    for (const node of el.childNodes) {
      if (node.nodeType !== 3 || node.textContent.trim() === "") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    return false;
  };
  let covered = 0, total = 0;
  for (let i = 0; i < 32; i++)
    for (let j = 0; j < 18; j++) {
      const x = ((i + 0.5) / 32) * innerWidth, y = ((j + 0.5) / 18) * innerHeight;
      const el = document.elementFromPoint(x, y);
      total += 1;
      if (el && el.tagName !== "CANVAS" && el !== document.body && el !== document.documentElement && (opaque(el) || onText(el, x, y))) covered += 1;
    }
  return covered / total;
})()`;

/** Visible page text now: the longest block in words, and the smallest font's pixel size on screen. */
const TEXT = `(() => {
  let words = 0, text = "", smallest = null;
  for (const el of document.body.querySelectorAll("*")) {
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== "");
    if (!own) continue;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width < 1 || rect.height < 1 || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) continue;
    const said = el.innerText.trim();
    const count = said.split(/\\s+/).filter(Boolean).length;
    if (count > words) { words = count; text = said.slice(0, 160); }
    const scale = el.offsetHeight > 0 ? rect.height / el.offsetHeight : 1;
    const px = parseFloat(style.fontSize) * scale;
    if (Number.isFinite(px) && px > 0 && (smallest === null || px < smallest)) smallest = px;
  }
  return { words, text, smallest };
})()`;

const STATE = `({ state: window.__studio?.getState?.()?.gameState?.state ?? null, now: performance.now() })`;

/** Where a person would click to go on: the visible button or link whose words say so. */
const buttonAt = (words: string) => `(() => {
  for (const el of document.querySelectorAll("button, a, [role=button], [onclick]")) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4 || !/${words}/i.test(el.innerText || el.getAttribute("aria-label") || "")) continue;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  return null;
})()`;

type Kp = {
  readonly ready: number | null;
  /** When the page first said it was in play (its <body data-state>). */
  readonly played: number | null;
  readonly inputs: ReadonlyArray<number>;
  readonly sounds: ReadonlyArray<number>;
  readonly peak: number;
  readonly graph: boolean;
};
type Press =
  | { readonly by: string; readonly tap: string }
  | { readonly by: string; readonly button: string }
  | { readonly by: string; readonly centre: true };

const not = (notMeasured: string) => ({ notMeasured });
const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pixels = async (path: string) => PNG.sync.read(await NodeFSP.readFile(path));

/** Share of pixels that changed between two stills, any channel by more than a few levels. */
const changed = (a: PNG, b: PNG) => {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let moved = 0;
  for (let i = 0; i < a.data.length; i += 4)
    if (
      Math.abs(a.data[i]! - b.data[i]!) > 8 ||
      Math.abs(a.data[i + 1]! - b.data[i + 1]!) > 8 ||
      Math.abs(a.data[i + 2]! - b.data[i + 2]!) > 8
    )
      moved += 1;
  return moved / (a.width * a.height);
};

/** A play frame's median light (Rec. 709 luma of the shown values, 0..1) and its clipped share. */
const light = (png: PNG) => {
  const counts = Array.from({ length: 256 }, () => 0);
  let clipped = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i]!,
      g = png.data[i + 1]!,
      b = png.data[i + 2]!;
    counts[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]! += 1;
    if (r >= 254 || g >= 254 || b >= 254) clipped += 1;
  }
  const total = png.width * png.height;
  let seen = 0;
  let median = 0;
  for (; median < 255; median += 1) if ((seen += counts[median]!) >= total / 2) break;
  return { median: round(median / 255), clipped: round(clipped / total, 3) };
};

/**
 * The first minute, measured on its own page. Null when the page never booted (the boot check
 * says why); a reading that could not be taken says so.
 */
export const measurePlayer = async (input: {
  readonly browser: GameBrowser;
  readonly url: string;
  readonly folder: string;
  readonly signal?: AbortSignal | undefined;
}): Promise<GamePlayerReport | null> => {
  const session = await openWebPlaySession({
    browser: input.browser,
    url: input.url,
    ...THREE_VIEWPORT,
    bootTimeoutMs: BOOT_MS,
    signal: input.signal,
    initScript: PROBE,
  }).catch(() => null);
  if (session === null) return null;
  try {
    return await probe(session, input.folder);
  } finally {
    await session.close();
  }
};

const probe = async (session: WebPlaySession, folder: string): Promise<GamePlayerReport> => {
  const evaluate = async <A>(expression: string): Promise<A | null> => {
    const answered = await session.evaluate?.(expression);
    return answered !== undefined && "value" in answered ? (answered.value as A) : null;
  };
  const kp = () => evaluate<Kp>("window.__kp");
  const state = () => evaluate<{ state: string | null; now: number }>(STATE);
  const still = async (name: string) => {
    const path = NodePath.join(folder, `first-minute-${name}.png`);
    return (await session.still(path)) ? await pixels(path).catch(() => null) : null;
  };
  const text = () => evaluate<{ words: number; text: string; smallest: number | null }>(TEXT);
  let wall = { words: 0, text: "" };
  const smallest: Record<keyof typeof SIZES, number | null> = { text1080: null, text800: null };
  const readText = async (sizes: boolean) => {
    const now = await text();
    if (now !== null && now.words > wall.words) wall = { words: now.words, text: now.text };
    if (!sizes) return;
    for (const [key, [width, height]] of Object.entries(SIZES) as Array<
      [keyof typeof SIZES, readonly [number, number]]
    >) {
      await session.resize(width, height);
      await sleep(300);
      const at = (await text())?.smallest ?? null;
      if (at !== null) smallest[key] = Math.min(smallest[key] ?? Infinity, at);
    }
    await session.resize(THREE_VIEWPORT.width, THREE_VIEWPORT.height);
    await sleep(200);
  };
  /**
   * Presses as a person would, one kind at a time, until the game is playing: how many presses,
   * the page's seconds from the first to play, the one that worked (null: none did) and when it
   * was pressed. The probe's own reading between presses is never counted.
   */
  const pressUntilPlaying = async (presses: ReadonlyArray<Press>) => {
    let inputs = 0;
    let first: number | null = null;
    let last = 0;
    for (const press of presses) {
      const at =
        "tap" in press
          ? null
          : "centre" in press
            ? { x: THREE_VIEWPORT.width / 2, y: THREE_VIEWPORT.height / 2 }
            : await evaluate<{ x: number; y: number }>(buttonAt(press.button));
      if (!("tap" in press) && at === null) continue;
      const before = (await state())?.now ?? last;
      first ??= before;
      inputs += 1;
      await session.input({
        held: [],
        taps: "tap" in press ? [press.tap] : [],
        clicks: at === null ? [] : [at],
      });
      for (let waited = 0; waited < PRESS_WAIT_MS; waited += 100) {
        const now = await state();
        last = now?.now ?? last;
        if (now?.state === "playing")
          return { inputs, seconds: (last - first) / 1000, by: press.by, pressedAt: before };
        await sleep(100);
      }
    }
    return { inputs, seconds: (last - (first ?? last)) / 1000, by: null, pressedAt: null };
  };

  // Load and the first frame.
  const booted = await kp();
  const load =
    booted?.ready == null
      ? not("the page never said it was ready")
      : { ready: round(booted.ready / 1000) };
  const first = await still("open");
  const cover = (await evaluate<number>(COVER)) ?? null;
  await sleep(1000);
  const second = await still("open-later");
  const moves =
    first === null || second === null
      ? not("the page gave no picture")
      : changed(first, second) > 0.002;
  await readText(true);

  // From the page as opened to play. A first run that already ended by itself still opened in play.
  const opened = await state();
  const endedAlone = opened?.state === "ended" && (await kp())?.played != null;
  const ready = "ready" in load ? load.ready : 0;
  let open: GamePlayerReport["open"];
  // The press a player's first sound should answer: the one that started play, or their first in it.
  let answered: number | null = null;
  if (opened?.state === "playing" || endedAlone) {
    open = { inputs: 0, seconds: ready, by: "opens in play", started: true };
    answered = (await state())?.now ?? null;
    await session.input({ held: [], taps: ["Space"], clicks: [] });
  } else if (opened?.state == null) open = not("the game's runtime does not say its state");
  else {
    const started = await pressUntilPlaying([
      { by: "Enter", tap: "Enter" },
      { by: "Space", tap: "Space" },
      { by: "a click on its start", button: "play|start|begin|continue|new game" },
      { by: "a click", centre: true },
    ]);
    answered = started.pressedAt;
    open = {
      inputs: started.inputs,
      seconds: round(ready + started.seconds),
      by: started.by ?? "none of Enter, Space or a click started play",
      started: started.by !== null,
    };
  }
  const playing = "started" in open && open.started;

  // Ten seconds of play: its text, Esc, a frame of it, the text at the other sizes.
  let pause: GamePlayerReport["pause"] = not("play never started");
  let frame: GamePlayerReport["frame"] = not("play never started");
  if (playing) {
    const began = Date.now();
    await readText(false);
    await sleep(1500);
    // A first run that ended by itself has no play left to hold or picture.
    if ((await state())?.state === "ended") {
      const why = "its first run ended by itself before the probe pressed Esc";
      pause = not(why);
      frame = not(why);
    } else {
      await session.input({ held: [], taps: ["Escape"], clicks: [] });
      await sleep(400);
      pause = (await state())?.state === "paused";
      for (const key of ["Escape", "KeyP", "Enter"]) {
        if ((await state())?.state !== "paused") break;
        await session.input({ held: [], taps: [key], clicks: [] });
        await sleep(300);
      }
      const shot = await still("play");
      frame = shot === null ? not("the page gave no picture") : light(shot);
    }
    await readText(true);
    while (Date.now() - began < WALL_PLAY_MS) {
      await sleep(2000);
      await readText(false);
    }
  }

  // A run with no input: can it be lost early, and back to play from its end.
  let lost: GamePlayerReport["lost"] = not("play never started");
  let idleEnded: GamePlayerReport["idleEnded"];
  let retry: GamePlayerReport["retry"] = not("play never started");
  if (playing && session.stepBot !== undefined) {
    const ran = await session.stepBot("export function decide() { return []; }\n", {
      seconds: IDLE_SECONDS,
      wallMs: IDLE_WALL_MS,
    });
    const outcome = (ran as { outcome?: { won: boolean; seconds: number } | null } | null)?.outcome;
    if (ran === "no-bot" || ran === null || outcome === undefined) {
      lost = not(
        ran === "no-bot"
          ? "the game's runtime predates stepped bots"
          : "the no-input run did not answer",
      );
      retry = not("the no-input run did not end");
    } else {
      lost = outcome !== null && !outcome.won;
      if (outcome !== null) idleEnded = { won: outcome.won, at: outcome.seconds };
      if (lost) {
        const back = await pressUntilPlaying([
          { by: "Enter", tap: "Enter" },
          { by: "Space", tap: "Space" },
          { by: "R", tap: "KeyR" },
          { by: "a click on Retry", button: "retry|again|restart|play|continue" },
          { by: "a click", centre: true },
        ]);
        retry = {
          inputs: back.inputs,
          seconds: round(back.seconds),
          by: back.by ?? "none of Enter, Space, R or a click started play again",
          started: back.by !== null,
        };
      } else retry = not("a run with no input never ended in a loss");
    }
  }

  // Sound: one within a second of the press that started play, and the loudest sample the mix reached.
  const heard = await kp();
  const firstInput = answered ?? undefined;
  const sound: GamePlayerReport["sound"] =
    heard === null
      ? not("the probe did not answer")
      : firstInput === undefined
        ? not("no input reached the page")
        : {
            firstInput: heard.sounds.some((t) => t >= firstInput && t <= firstInput + ANSWER_MS),
            peakDb: heard.graph && heard.peak > 0 ? round(20 * Math.log10(heard.peak), 1) : null,
          };

  return {
    load,
    moves,
    cover: cover ?? not("the page did not answer"),
    open,
    textWall: wall,
    text1080:
      smallest.text1080 ?? not("no page text on screen: text drawn in the canvas is not read"),
    text800:
      smallest.text800 ?? not("no page text on screen: text drawn in the canvas is not read"),
    lost,
    ...(idleEnded === undefined ? {} : { idleEnded }),
    retry,
    sound,
    pause,
    frame,
  };
};
