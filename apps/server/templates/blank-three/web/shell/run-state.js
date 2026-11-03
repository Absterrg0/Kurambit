// The run state: one GameState object that the shell, the studio probe and
// bots read. The shell owns `state`, `result` and `result_text`; the game adds
// its own values in main.js and ends a run with one call:
//
//   GameState.win("You escaped!", { Time: "1:42", Coins: 12 });
//   GameState.lose("Out of fuel", { Distance: "340 m" });
//
// Either call freezes play after a short slow-motion beat and opens the end
// screen with the message and the stats (shown in the order given), plus Retry
// and Main menu.

export const GameState = {
  /** "title", "playing", "paused" or "ended". The shell sets it; games read it. */
  state: "title",
  /** "won" or "lost" once the run ended, "" while it runs. */
  result: "",
  /** The message the end screen shows. */
  result_text: "",
};

export const SHELL_KEYS = ["state", "result", "result_text"];

let onEnded = null;
let defaults = null;

const method = (name, fn) =>
  Object.defineProperty(GameState, name, { value: fn, enumerable: false });

method("win", (text = "You win!", stats = {}) => end(true, text, stats));
method("lose", (text = "Game over", stats = {}) => end(false, text, stats));
method("isPlaying", () => GameState.state === "playing");

function end(won, text, stats) {
  if (GameState.state !== "playing") return;
  GameState.result = won ? "won" : "lost";
  GameState.result_text = String(text);
  GameState.state = "ended";
  onEnded?.(won, GameState.result_text, stats ?? {});
}

/** The shell's hook for win() and lose(). */
export function onRunEnded(listener) {
  onEnded = listener;
}

// A copy, never a shared reference: a retry must not inherit the last run's
// arrays, objects or vectors.
function copy(value) {
  if (value === null || typeof value !== "object") return value;
  if (typeof value.clone === "function") return value.clone();
  return structuredClone(value);
}

/**
 * The shell calls this before every Play and Retry, before the game's
 * start(). Every value the game put on GameState returns to what it was when
 * the first run began, except the names in `keep`; a value first added during
 * a run is removed. So a retry never inherits the last run's score, health or
 * timers.
 */
export function newRun(keep = []) {
  if (defaults === null) {
    defaults = {};
    for (const [key, value] of Object.entries(GameState))
      if (!SHELL_KEYS.includes(key)) defaults[key] = copy(value);
  }
  for (const key of Object.keys(GameState)) {
    if (SHELL_KEYS.includes(key) || keep.includes(key)) continue;
    if (key in defaults) GameState[key] = copy(defaults[key]);
    else delete GameState[key];
  }
  for (const key of Object.keys(defaults))
    if (!(key in GameState)) GameState[key] = copy(defaults[key]);
  GameState.result = "";
  GameState.result_text = "";
}
