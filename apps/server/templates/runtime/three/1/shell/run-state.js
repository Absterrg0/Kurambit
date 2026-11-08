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
// Kept values as main.js declared them, before the saved ones loaded: what a
// reset returns to. Empty until loadProgress ran, and nothing saves until then.
const keptStart = new Map();
const PROGRESS_KEY = `progress:${location.pathname}`;

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
  // After the current frame's code: a game usually updates its best score
  // right after calling win().
  queueMicrotask(saveProgress);
}

/** The shell's hook for win() and lose(). */
export function onRunEnded(listener) {
  onEnded = listener;
}

// Retry resets only plain data: numbers, strings, booleans, arrays, typed
// arrays, dates, plain objects, Map and Set, copied so a retry never shares the last run's arrays
// or objects. A function, a class instance or a three.js object would come back
// broken or detached from the scene, so it is left as it is.
function isPlainData(value, seen = new Set()) {
  if (typeof value === "function" || typeof value === "symbol") return false;
  if (value === null || typeof value !== "object") return true;
  if (seen.has(value)) return true;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date)
    return true;
  seen.add(value);
  if (Array.isArray(value)) return value.every((each) => isPlainData(each, seen));
  if (value instanceof Map)
    return [...value].every(([k, v]) => isPlainData(k, seen) && isPlainData(v, seen));
  if (value instanceof Set) return [...value].every((each) => isPlainData(each, seen));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every((each) => isPlainData(each, seen));
}

const NOT_RESET = Symbol("not reset");
const warned = new Set();

function copy(key, value) {
  try {
    if (isPlainData(value))
      return typeof value === "object" && value !== null ? structuredClone(value) : value;
  } catch {
    // A throwing getter, a proxy or very deep nesting: not reset, warned below.
  }
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(
      `GameState.${key} is not plain data, so Retry does not reset it; build it in start().`,
    );
  }
  return NOT_RESET;
}

/**
 * The shell calls this before every Play and Retry, before the game's
 * start(). Every plain-data value the game put on GameState returns to what it
 * was when the first run began, except the names in `keep`; a value first
 * added during a run is removed. So a retry never inherits the last run's
 * score, health or timers.
 */
export function newRun(keep = []) {
  saveProgress();
  if (defaults === null) {
    // Built aside and set once complete: a half-filled table would delete
    // every later value on each Retry.
    const first = {};
    for (const [key, value] of Object.entries(GameState))
      if (SHELL_KEYS.includes(key)) continue;
      // A kept value never resets, so it needs no copy and no warning.
      else if (keep.includes(key)) first[key] = NOT_RESET;
      else first[key] = copy(key, value);
    defaults = first;
  }
  for (const key of Object.keys(GameState)) {
    if (SHELL_KEYS.includes(key) || keep.includes(key)) continue;
    if (!(key in defaults)) delete GameState[key];
    else if (defaults[key] !== NOT_RESET) GameState[key] = copy(key, defaults[key]);
  }
  for (const key of Object.keys(defaults))
    if (!(key in GameState) && defaults[key] !== NOT_RESET)
      GameState[key] = copy(key, defaults[key]);
  GameState.result = "";
  GameState.result_text = "";
}

/**
 * The shell calls this once at launch, before the title, so a title screen can
 * already show the best score from the last visit. Only plain data saves.
 */
export function loadProgress(keep = []) {
  for (const key of keep) {
    const start = GameState[key];
    if (jsonSafe(start)) keptStart.set(key, structuredClone(start));
    else
      console.warn(
        `GameState.${key} is not numbers, strings, booleans, arrays or plain objects, so it is not saved between visits.`,
      );
  }
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? "null", (_, value) =>
      typeof value?.$number === "string" ? Number(value.$number) : value,
    );
  } catch {
    saved = null;
  }
  if (saved !== null && typeof saved === "object")
    for (const key of keptStart.keys()) if (key in saved) GameState[key] = saved[key];
  addEventListener("pagehide", saveProgress);
}

// What JSON gives back as it was: a Map, Set or Date would load as a plain
// object and break the game code that reads it.
function jsonSafe(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return true;
  if (Array.isArray(value)) return value.every(jsonSafe);
  if (typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && Object.values(value).every(jsonSafe);
}

/** Whether the game keeps anything across runs (the Settings reset shows only then). */
export const hasProgress = () => keptStart.size > 0;

/** Puts every kept value back to its starting value and forgets the saved copy. */
export function resetProgress() {
  for (const [key, start] of keptStart) GameState[key] = structuredClone(start);
  try {
    localStorage.removeItem(PROGRESS_KEY);
  } catch {
    // Storage blocked: nothing was saved either.
  }
}

function saveProgress() {
  if (keptStart.size === 0) return;
  const values = {};
  for (const key of keptStart.keys()) if (jsonSafe(GameState[key])) values[key] = GameState[key];
  try {
    // JSON writes Infinity as null; a best time often starts at Infinity.
    const text = JSON.stringify(values, (_, value) =>
      typeof value === "number" && !Number.isFinite(value) ? { $number: String(value) } : value,
    );
    localStorage.setItem(PROGRESS_KEY, text);
  } catch {
    // Storage can be blocked (private mode, sandboxed frames); progress then lasts this visit.
  }
}
