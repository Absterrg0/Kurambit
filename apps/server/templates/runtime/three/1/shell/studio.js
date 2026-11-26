// The read-only studio bridge. Bots and the harness read getState(), reach
// late content through setState() when the game implements a target, and find
// page errors in errors[]. Nothing here writes to the game except setState and
// the hidden-stage hold. Extend GameState, not this bridge.
import { GameState, SHELL_KEYS } from "./run-state.js";

/**
 * Whether the page, as written, is the older demo shell's: all of its screens as section.screen
 * elements in index.html. Read here, before any game code runs (shell.js imports the game's
 * main.js, which may build menus of its own with the same ids): a new match-3 game that made
 * title, pause and end screens in code was refused as an old one.
 */
const OLD_SHELL_SCREENS = ["loading", "title", "pause", "settings", "end", "credits", "controls"];
export const oldShellPage = OLD_SHELL_SCREENS.every(
  (id) => document.getElementById(id)?.matches("section.screen") === true,
);

const MAX_KEYS = 64;
const MAX_HUD_CHARS = 2000;

// The Stage that frames this page hears of its first error and of its boot,
// so a save that breaks the game is said there. The game runs on its own
// origin, so these two messages are all the Stage learns of it; a page
// opened on its own posts nothing.
const framed = window.parent !== window;
const toStage = (message) => {
  if (framed) window.parent.postMessage(message, "*");
};
// "http://127.0.0.1:PORT/main.js:42:7" names main.js and line 42.
const whereFrom = (url, line) => {
  const found = /^(\S+?):(\d+)(?::\d+)?$/.exec(String(url ?? ""));
  const source = (found?.[1] ?? String(url ?? "")).replace(`${location.origin}/`, "");
  return { source: source.slice(0, 500), line: Number(line ?? found?.[2] ?? 0) || 0 };
};
const firstFrame = (stack) =>
  /\((\S+:\d+:\d+)\)|at (\S+:\d+:\d+)|@(\S+:\d+:\d+)/.exec(String(stack ?? ""));

// The Workbench's console: the page's errors and console lines, sent up in batches a few times
// a second, so a game that logs every frame costs one message per batch, not one per line.
// Framed pages only; the clock and timer are the page's own, before a run's replay clock.
const LOG_BATCH_MS = 250;
const LOG_BATCH_LINES = 50;
const pageMs = performance.now.bind(performance);
const pageTimeout = window.setTimeout.bind(window);
let logLines = [];
let logDropped = 0;
let logPending = false;
const flushLog = () => {
  logPending = false;
  toStage({
    type: "studio-log",
    lines: logLines,
    ...(logDropped > 0 ? { dropped: logDropped } : {}),
  });
  logLines = [];
  logDropped = 0;
};
const logText = (args) =>
  args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.message;
      try {
        return JSON.stringify(arg) ?? String(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ")
    .slice(0, 500);
const logLine = (level, args) => {
  if (!framed) return;
  if (logLines.length >= LOG_BATCH_LINES) logDropped += 1;
  else logLines.push({ level, text: logText(args), t: Math.round(pageMs()) / 1000 });
  if (logPending) return;
  logPending = true;
  pageTimeout(flushLog, LOG_BATCH_MS);
};
// A lost WebGL context (the browser's GPU process crashed or was reset) makes three.js log a
// shader or program error for every draw after it: those are the renderer's, not the game's, so
// they are logged as the renderer's and never counted among the page's errors. The harness's
// page session reads this line too (webPlaySession.ts RENDERER_LOST). Once lost, the page stays
// so: a restored context recompiles every shader, which is when those errors come.
let rendererLost = false;
window.addEventListener(
  "webglcontextlost",
  () => {
    if (rendererLost) return;
    console.warn(
      "WebGL context lost: the browser's renderer stopped drawing this page; errors after this are the renderer's, not the game's.",
    );
    rendererLost = true;
  },
  true,
);
if (framed)
  for (const [method, level] of [
    ["log", "log"],
    ["info", "log"],
    ["warn", "warn"],
    ["error", "error"],
  ]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      logLine(rendererLost && level === "error" ? "renderer" : level, args);
      original(...args);
    };
  }

// Installed when this module first evaluates, before the game module runs,
// so errors while the game loads land here too.
export const errors = [];
let told = false;
const record = (message, stack, where) => {
  if (rendererLost) {
    logLine("renderer", [String(message)]);
    return;
  }
  logLine("error", [String(message)]);
  if (errors.length < 50)
    errors.push({
      message: String(message).slice(0, 500),
      stack: String(stack ?? "").slice(0, 500),
      t: performance.now() / 1000,
    });
  if (told) return;
  told = true;
  toStage({ type: "studio-error", message: String(message).slice(0, 500), ...where });
};
window.addEventListener("error", (event) =>
  record(
    event.message ?? "unknown error",
    event.error?.stack,
    whereFrom(event.filename, event.lineno),
  ),
);
// A module that fails to fetch fires on its script element, not the window;
// the capture phase sees it. A nested import failing blames the entry script.
window.addEventListener(
  "error",
  (event) => {
    const script = event.target;
    if (script === window || script?.tagName !== "SCRIPT") return;
    record(
      `${script.src.replace(`${location.origin}/`, "")} did not load: a module it imports is missing or could not load.`,
      "",
      whereFrom(script.src, 0),
    );
  },
  true,
);
window.addEventListener("unhandledrejection", (event) => {
  const frame = firstFrame(event.reason?.stack);
  record(
    event.reason?.message ?? event.reason ?? "unhandled rejection",
    event.reason?.stack,
    whereFrom(frame?.[1] ?? frame?.[2] ?? frame?.[3] ?? "", undefined),
  );
});

// What a game registers outside its run, for the QA play's Retry check (shell/qa.js): the
// listeners on window and document, the intervals running and the animation frames asked
// for. Counted only when the harness set window.__studioQa before any script ran; a page a
// player opens never wraps these. Installed here, before the game module runs.
export const outsideRun = { listeners: () => 0, intervals: () => 0, frames: 0 };
if (window.__studioQa === true) {
  const registry = new Map([
    [window, new Map()],
    [document, new Map()],
  ]);
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    const types = registry.get(this);
    if (types !== undefined && listener != null) {
      const set = types.get(type) ?? new Set();
      set.add(listener);
      types.set(type, set);
    }
    return add.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    registry.get(this)?.get(type)?.delete(listener);
    return remove.call(this, type, listener, options);
  };
  outsideRun.listeners = () => {
    let count = 0;
    for (const types of registry.values()) for (const set of types.values()) count += set.size;
    return count;
  };
  const running = new Set();
  const setInterval = window.setInterval;
  const clearInterval = window.clearInterval;
  window.setInterval = (...args) => {
    const id = setInterval(...args);
    running.add(id);
    return id;
  };
  window.clearInterval = (id) => {
    running.delete(id);
    return clearInterval(id);
  };
  outsideRun.intervals = () => running.size;
  const requestFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => {
    outsideRun.frames += 1;
    return requestFrame(callback);
  };
}

function gameStateValues() {
  const values = {};
  // The shell's run state first, so a game with many values never crowds it out.
  const keys = [...SHELL_KEYS, ...Object.keys(GameState).filter((k) => !SHELL_KEYS.includes(k))];
  for (const key of keys) {
    if (Object.keys(values).length >= MAX_KEYS) break;
    if (key.length > 64 || key.startsWith("_")) continue;
    const value = GameState[key];
    if (typeof value === "number" && Number.isFinite(value)) values[key] = value;
    else if (typeof value === "boolean") values[key] = value;
    else if (typeof value === "string") values[key] = value.slice(0, 256);
  }
  return values;
}

function position(player) {
  if (player == null) return null;
  if (typeof player.getWorldPosition === "function") {
    const at = player.getWorldPosition(player.position.clone());
    return { x: at.x, y: at.y, z: at.z };
  }
  if (typeof player.x === "number") return { x: player.x, y: player.y ?? 0, z: player.z ?? 0 };
  return null;
}

/**
 * Publishes window.__studio. `player()` returns the run's player (an Object3D
 * or {x,y,z}) or null, `setState` is the game's own, `hold(on)` freezes play
 * and sound while the stage tab is hidden and returns whether sound is muted,
 * `perf()` reads the look's play stats. `bridge`, when the shell has one
 * (shell/stage-bridge.js), is announced in studio-ready: a shell without it
 * posts the bare boot signal, and the Stage then offers no selecting.
 * `scene`, when the shell has one, is the scene report the harness reads.
 * `blank`: the game has no main.js yet (the server answers an empty module), so the page runs
 * nothing; studio-ready says so, and the Stage keeps waiting for a game to show.
 */
export function installStudio({
  player,
  setState,
  hold,
  perf,
  bridge,
  scene,
  qa,
  replay,
  bot,
  takePlays,
  scope,
  holdClock,
  advanceClock,
  sheet,
  play,
  blank,
}) {
  let ready = false;
  const studio = {
    engine: "three",
    version: 1,
    // The shell sets it once a frame has drawn; the first time, the Stage hears it.
    get ready() {
      return ready;
    },
    set ready(value) {
      if (value === true && !ready)
        toStage({
          type: "studio-ready",
          ...bridge?.hello,
          ...(blank === true ? { blank: true } : {}),
        });
      ready = value === true;
    },
    errors,
    // How play ran: frame times, GPU time and the render scale (shell/look.js). The
    // harness reads it once at the end of each facts play.
    perf() {
      return typeof perf === "function" ? perf() : null;
    },
    // The scene report (shell/scene-report.js): the harness starts it as a measured play
    // begins and reads it at the end. A shell without one has no `scene`.
    ...(scene === undefined
      ? {}
      : {
          scene: {
            start: () => scene.start(),
            read: () => scene.read(),
          },
        }),
    // The QA play (shell/qa.js): every control, Retry, and the HUD on screen. Only the
    // harness calls it, on a page it opened with its counters on.
    ...(qa === undefined
      ? {}
      : {
          qa: {
            run: () => qa.run(),
            hud: () => qa.hud(),
          },
        }),
    // A play the Stage kept, run again on this build from its seed and its input at each
    // step (shell/replay.js): how it ended, and where the run stood each second. `options`:
    // { drawEvery } for a measuring replay, { at } to stop and hold at a second of play.
    replay: (play, options) => replay(play, options),
    // A stepped bot's run (shell.js bot): the source of a file that exports decide(obs).
    bot: (source, options) => bot(source, options),
    // The runs this page played to an end since the last call (shell/replay.js), for a harness
    // session, which no Stage holds, to keep as the Stage keeps a person's.
    takePlays: () => takePlays(),
    // The run's ctx and GameState, for an agent's eval (game_play op eval).
    ...(scope === undefined ? {} : { scope: () => scope() }),
    // The harness's clock (shell.js): held, play moves only as `advanceClock(seconds)` steps it,
    // as fast as the page allows; the promise settles once that much game time has played.
    holdClock: (on) => holdClock(on),
    advanceClock: (seconds, wallMs) => advanceClock(seconds, wallMs),
    // The model sheet (shell/sheet.js): one named thing alone, from four sides, with its
    // size, triangles and draw calls; names() lists the things with a body.
    ...(sheet === undefined
      ? {}
      : {
          sheet: {
            draw: (name, views) => sheet.draw(name, views),
            close: () => sheet.close(),
          },
        }),
    getState() {
      // innerText skips hidden elements, so this is the page's text on screen now.
      const text = document.body.innerText;
      return {
        gameState: gameStateValues(),
        player: position(player()),
        hudText: text
          .replace(/\n{3,}/g, "\n\n")
          .trim()
          .slice(0, MAX_HUD_CHARS),
      };
    },
    // Named reaches the harness may use to start late content. The starter has
    // no targets and refuses; a game with levels exports its own setState from
    // main.js (every call is reported, and verdicts still come from real input after).
    setState(target, values) {
      // "game_state" writes run values directly, as every engine's runner does;
      // any other target is the game's own state jump (exported from main.js).
      // "play" starts a fresh run in play, past whatever title the game has.
      if (target === "play") return typeof play === "function" && play() === true;
      if (target === "game_state") {
        for (const [key, value] of Object.entries(values ?? {}))
          if (["number", "boolean", "string"].includes(typeof value) && key.length <= 64)
            GameState[key] = value;
        return true;
      }
      return typeof setState === "function" ? setState(target, values ?? {}) === true : false;
    },
  };
  window.__studio = studio;

  // The stage's visibility bridge: while its tab is hidden the run holds and
  // the sound is suspended, then both come back as they were. The hold is not
  // the shell's pause, so a game paused before the hide stays paused after.
  // Told it is visible, the page answers twice: at once with what it did, and again (`drawn`)
  // when the next frame is on the canvas. A Stage that let a page start behind another shows it
  // on the second: its first frame was drawn held, before the run had moved.
  let shown = null;
  // A held page draws no WebGL, but its own HTML can still animate (a blinking "Press Space"),
  // and with no GPU that alone keeps several cores busy. The hold pauses the page's animations
  // (CSS animations and transitions included) that were running, and plays those on with it; one
  // the game paused or ended meanwhile stays as it is.
  let pausedAnimations = [];
  const holdAnimations = (on) => {
    if (!on) {
      for (const animation of pausedAnimations)
        if (animation.playState === "paused") animation.play();
      pausedAnimations = [];
      return;
    }
    for (const animation of document.getAnimations?.() ?? [])
      if (animation.playState === "running") {
        animation.pause();
        pausedAnimations.push(animation);
      }
  };
  window.addEventListener("message", (event) => {
    if (event.data?.type !== "studio-visibility") return;
    const hidden = event.data.visible === false;
    holdAnimations(hidden);
    const muted = hold(hidden);
    const ack = { type: "studio-visibility-ack", visible: !hidden, paused: hidden, muted };
    event.source?.postMessage?.(ack, "*");
    window.__studioVisibilityAck = ack;
    shown = hidden ? null : ack;
  });
  /** The shell calls it after each frame it draws. */
  studio.frame = () => {
    if (shown === null) return;
    toStage({ ...shown, drawn: true });
    shown = null;
  };
  return studio;
}
