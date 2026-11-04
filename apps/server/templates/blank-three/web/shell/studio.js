// The read-only studio bridge. Bots and the harness read getState(), reach
// late content through setState() when the game implements a target, and find
// page errors in errors[]. Nothing here writes to the game except setState and
// the hidden-stage hold. Extend GameState, not this bridge.
import { GameState, SHELL_KEYS } from "./run-state.js";

const MAX_KEYS = 64;
const MAX_HUD_CHARS = 2000;

// Installed when this module first evaluates, before the game module runs,
// so errors while the game loads land here too.
const errors = [];
const record = (message, stack) => {
  if (errors.length < 50)
    errors.push({
      message: String(message).slice(0, 500),
      stack: String(stack ?? "").slice(0, 500),
      t: performance.now() / 1000,
    });
};
window.addEventListener("error", (event) =>
  record(event.message ?? "unknown error", event.error?.stack),
);
window.addEventListener("unhandledrejection", (event) =>
  record(event.reason?.message ?? event.reason ?? "unhandled rejection", event.reason?.stack),
);

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
 * and sound while the stage tab is hidden and returns whether sound is muted.
 */
export function installStudio({ ui, player, setState, hold }) {
  const studio = {
    engine: "three",
    version: 1,
    ready: false,
    errors,
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
