// The read-only studio bridge. Bots and the harness read getState(), reach
// late content through setState() when the game implements a target, and find
// page errors in errors[]. Nothing here writes to the game except setState and
// the hidden-stage hold. Extend GameState, not this bridge.
import { GameState, SHELL_KEYS } from "./run-state.js";

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

// Installed when this module first evaluates, before the game module runs,
// so errors while the game loads land here too.
export const errors = [];
let told = false;
const record = (message, stack, where) => {
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
 */
export function installStudio({
  ui,
  player,
  setState,
  hold,
  perf,
  bridge,
  scene,
  qa,
  replay,
  sheet,
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
      if (value === true && !ready) toStage({ type: "studio-ready", ...(bridge?.hello ?? {}) });
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
    // step (shell/replay.js): how it ended, and where the run stood each second.
    replay: (play) => replay(play),
    // The model sheet (shell/sheet.js): one named thing alone, from four sides, with its
    // size, triangles and draw calls; names() lists the things with a body.
    ...(sheet === undefined
      ? {}
      : {
          sheet: {
            draw: (name) => sheet.draw(name),
            close: () => sheet.close(),
          },
        }),
    getState() {
      // innerText skips hidden screens, so this is the text on screen now.
      const text = typeof ui?.innerText === "string" ? ui.innerText : "";
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
  window.addEventListener("message", (event) => {
    if (event.data?.type !== "studio-visibility") return;
    const hidden = event.data.visible === false;
    const muted = hold(hidden);
    const ack = { type: "studio-visibility-ack", visible: !hidden, paused: hidden, muted };
    event.source?.postMessage?.(ack, "*");
    window.__studioVisibilityAck = ack;
  });
  return studio;
}
