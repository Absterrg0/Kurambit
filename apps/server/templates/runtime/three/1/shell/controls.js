// Named actions: the one table every control in the game reads, shown in the
// Stage's Controls and rebindable there. The game reads ctx.input, never raw
// keys, so a player's rebinding reaches every check:
//
//   ctx.input.down("jump")      // held now
//   ctx.input.pressed("action") // went down this frame (once per press)
//   ctx.input.released("alt")   // went up this frame
//   ctx.input.vector()          // {x, y} from move_left/right/up/down, length <= 1, y down
//   ctx.input.axis("move_left", "move_right") // -1..1, analog on a stick
//   ctx.input.label("dash")     // its first key's name ("Space"), for HUD hints
//
// main.js changes the table with `export const ACTIONS = {...}`: a new name
// adds an action, a default's name replaces its bindings, null drops one the
// game never reads (so Controls never lists a dead control):
//
//   export const ACTIONS = { dash: { keys: ["ShiftLeft"], pad: ["rb"] }, alt: null };
//
// keys are KeyboardEvent.code values ("KeyW", "ArrowLeft", "Space", "Enter").
// pad names a standard-mapping gamepad input: a b x y (south east west north),
// lb rb lt rt, back start, ls rs (stick clicks), up down left right (d-pad),
// lstick_left/right/up/down and rstick_left/right/up/down. mouse lists buttons
// (0 left, 2 right) and counts only presses on the game canvas. label is the
// Controls' name for it (default: the name, "move_left" -> "Move left").
//
// `look` is the runtime's own pointer action: held, the pointer's movement drives it. It is listed
// once a game reads it, and takes a key like any action (hold it and move the pointer);
// `look: { mouse: [1] }` moves it to another button.

/** Defaults every genre can read; each one has a reason in TEMPLATE.md. */
export const DEFAULT_ACTIONS = {
  move_left: { keys: ["KeyA", "ArrowLeft"], pad: ["lstick_left", "left"] },
  move_right: { keys: ["KeyD", "ArrowRight"], pad: ["lstick_right", "right"] },
  move_up: { keys: ["KeyW", "ArrowUp"], pad: ["lstick_up", "up"] },
  move_down: { keys: ["KeyS", "ArrowDown"], pad: ["lstick_down", "down"] },
  jump: { keys: ["Space"], pad: ["a"] },
  action: { keys: ["KeyJ", "Enter"], pad: ["x"], mouse: [0] },
  alt: { keys: ["KeyK", "ShiftLeft"], pad: ["b"] },
  // For a camera the game orbits. The right button: the left is the game's action, and a
  // trackpad has no middle one. `pointer`: it acts through the pointer's movement while held.
  look: { keys: [], mouse: [2], pad: ["rstick"], label: "Look around", pointer: true },
  // The shell's own; it stays bound so a player can always reach the game's pause.
  pause: { keys: ["Escape", "KeyP"], pad: ["start"], fixed: true },
};

const DEADZONE = 0.25;
const BUTTONS = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  lb: 4,
  rb: 5,
  lt: 6,
  rt: 7,
  back: 8,
  start: 9,
  ls: 10,
  rs: 11,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
};
const STICKS = {
  lstick_left: [0, -1],
  lstick_right: [0, 1],
  lstick_up: [1, -1],
  lstick_down: [1, 1],
  rstick_left: [2, -1],
  rstick_right: [2, 1],
  rstick_up: [3, -1],
  rstick_down: [3, 1],
};
const PAD_NAMES = {
  a: "A",
  b: "B",
  x: "X",
  y: "Y",
  lb: "LB",
  rb: "RB",
  lt: "LT",
  rt: "RT",
  back: "Back",
  start: "Start",
  ls: "L3",
  rs: "R3",
  up: "D-pad up",
  down: "D-pad down",
  left: "D-pad left",
  right: "D-pad right",
  rstick: "Right stick",
};
const KEY_NAMES = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Escape: "Esc",
  ShiftLeft: "Shift",
  ShiftRight: "Right Shift",
  ControlLeft: "Ctrl",
  ControlRight: "Right Ctrl",
  AltLeft: "Alt",
  AltRight: "Right Alt",
  MetaLeft: "Meta",
  MetaRight: "Right Meta",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};
const MOUSE_NAMES = ["Left click", "Middle click", "Right click"];

export function keyName(code) {
  if (KEY_NAMES[code] !== undefined) return KEY_NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
}

function padName(name) {
  if (PAD_NAMES[name] !== undefined) return PAD_NAMES[name];
  const [stick, way] = name.split("_");
  return `${stick === "rstick" ? "Right stick" : "Stick"} ${way}`;
}

const labelOf = (name) => {
  const words = name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const strings = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === "string") : []);

/**
 * The game's action table: DEFAULT_ACTIONS with main.js's ACTIONS applied, in
 * that order. Keyboard bindings change at runtime (rebinding); `defaults`
 * keeps each action's declared keys for "Reset to defaults".
 */
export function createControls(gameActions) {
  const declared = { ...DEFAULT_ACTIONS };
  for (const [name, spec] of Object.entries(gameActions ?? {})) {
    if (name === "pause") continue;
    if (spec === null) delete declared[name];
    else if (typeof spec === "object") declared[name] = spec;
  }
  // The game names only its own actions: a key it binds is taken from the defaults it does not
  // name (pause aside), rather than bound twice.
  const taken = new Set(
    Object.entries(gameActions ?? {}).flatMap(([name, spec]) =>
      name === "pause" || spec === null || typeof spec !== "object" ? [] : strings(spec.keys),
    ),
  );
  for (const name of Object.keys(DEFAULT_ACTIONS))
    if (name !== "pause" && !(name in (gameActions ?? {})) && declared[name] !== undefined)
      declared[name] = {
        ...declared[name],
        keys: strings(declared[name].keys).filter((key) => !taken.has(key)),
      };
  // One key on two actions fires both: name it, so the check sees it.
  const owners = new Map();
  for (const [name, spec] of Object.entries(declared))
    for (const key of strings(spec?.keys)) {
      if (owners.has(key))
        console.error(
          `Controls: ${key} is bound to both ${owners.get(key)} and ${name}; give one of them another key or drop it with null in ACTIONS.`,
        );
      else owners.set(key, name);
    }
  // Pause lists last, under the game's own.
  const { pause, ...rest } = declared;
  const actions = new Map();
  for (const [name, spec] of Object.entries({ ...rest, pause })) {
    const keys = strings(spec.keys);
    actions.set(name, {
      name,
      label: typeof spec.label === "string" ? spec.label : labelOf(name),
      keys: [...keys],
      defaults: keys,
      pad: strings(spec.pad).filter(
        (p) => BUTTONS[p] !== undefined || STICKS[p] !== undefined || p === "rstick",
      ),
      mouse: Array.isArray(spec.mouse) ? spec.mouse.filter(Number.isInteger) : [],
      fixed: spec.fixed === true,
      // A game that moves `look` to another button still has an action the pointer drives.
      pointer:
        spec.pointer === true ||
        (DEFAULT_ACTIONS[name]?.pointer === true && spec.pointer !== false),
    });
  }

  const owner = (code) => [...actions.values()].find((each) => each.keys.includes(code));
  // The actions main.js names, and those the game has read in any run: a default neither names
  // nor reads is not one of the game's controls.
  const named = new Set(Object.keys(gameActions ?? {}));
  const used = new Set();

  return {
    actions,
    used,
    /** Whether an action is one of the game's: named in ACTIONS, or read through ctx.input. */
    ownedByGame: (name) => named.has(name) || used.has(name),
    has: (name) => actions.has(name),
    /** The mouse buttons an action answers to, when the game's code names them late. */
    setMouse(name, buttons) {
      const action = actions.get(name);
      if (action !== undefined) action.mouse = buttons.filter(Number.isInteger);
    },
    label(name) {
      const action = actions.get(name);
      if (action === undefined) return "";
      if (action.keys.length > 0) return keyName(action.keys[0]);
      if (action.mouse.length > 0)
        return MOUSE_NAMES[action.mouse[0]] ?? `Mouse ${action.mouse[0]}`;
      return action.pad.length > 0 ? padName(action.pad[0]) : "";
    },
    /** Each binding by the name a player reads, for the Stage's Controls. */
    parts(action) {
      return {
        keys: action.keys.map(keyName),
        mouse: action.mouse.map((b) => MOUSE_NAMES[b] ?? `Mouse ${b}`),
        pad: action.pad.map(padName),
      };
    },
    /**
     * Puts `code` as the action's first key. A key another action holds moves
     * over to it in exchange for this one's old key; a fixed action's key is
     * refused. Returns the sentence the Stage's Controls shows.
     */
    rebind(name, code) {
      const action = actions.get(name);
      if (action === undefined || action.fixed) return "That control cannot be changed";
      const old = action.keys[0];
      if (old === code) return `${action.label} stays on ${keyName(code)}`;
      const other = owner(code);
      if (other?.fixed) return `${keyName(code)} stays on ${other.label}`;
      if (other === action) {
        const at = action.keys.indexOf(code);
        action.keys[at] = old;
        action.keys[0] = code;
        return `${action.label}: ${keyName(code)} first`;
      }
      if (old === undefined) action.keys.push(code);
      else action.keys[0] = code;
      if (other === undefined) return `${action.label} is now ${keyName(code)}`;
      const at = other.keys.indexOf(code);
      if (old === undefined) other.keys.splice(at, 1);
      else other.keys[at] = old;
      return old === undefined
        ? `${action.label} is now ${keyName(code)}, taken from ${other.label}`
        : `${action.label} is now ${keyName(code)}; ${keyName(old)} moved to ${other.label}`;
    },
    reset() {
      for (const action of actions.values()) action.keys = [...action.defaults];
    },
    /** The keyboard bindings that differ from the defaults, for the settings store. */
    saved() {
      const out = {};
      for (const action of actions.values())
        if (action.keys.join() !== action.defaults.join()) out[action.name] = [...action.keys];
      return out;
    },
    load(saved) {
      for (const [name, keys] of Object.entries(saved ?? {})) {
        const action = actions.get(name);
        if (action !== undefined && !action.fixed && Array.isArray(keys))
          action.keys = strings(keys);
      }
    },
  };
}

function padStrength(pad, name) {
  if (pad == null) return 0;
  const button = BUTTONS[name];
  if (button !== undefined) {
    const each = pad.buttons[button];
    if (each?.pressed !== true) return 0;
    return typeof each.value === "number" && each.value > 0 ? each.value : 1;
  }
  // The whole right stick, whichever way it leans.
  if (name === "rstick") {
    const lean = Math.hypot(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
    return lean <= DEADZONE ? 0 : Math.min(1, (lean - DEADZONE) / (1 - DEADZONE));
  }
  const [axis, sign] = STICKS[name];
  const value = (pad.axes[axis] ?? 0) * sign;
  return value <= DEADZONE ? 0 : Math.min(1, (value - DEADZONE) / (1 - DEADZONE));
}

/**
 * One run's ctx.input. The shell calls sample() once a frame before update()
 * with the gameplay keys, mouse buttons and gamepad, and settle() whenever play
 * starts or resumes, so a button still held from a menu is not a fresh press.
 */
export function createInput(controls) {
  let now = new Map();
  let was = new Map();
  let settling = true;
  // The QA play's: actions it holds itself, and which actions the game has asked about. A
  // press let go before any frame sampled it is held until one does: on a slow machine a
  // frame can outlast the press.
  const forced = new Set();
  const sampled = new Set();
  const letGo = new Set();
  const reads = new Set();
  const read = (name) => {
    if (!controls.has(name))
      throw new Error(
        `Unknown action "${name}": declare it in main.js's ACTIONS (shell/controls.js).`,
      );
    reads.add(name);
    controls.used.add(name);
    return now.get(name) ?? 0;
  };
  const api = {
    down: (name) => read(name) > 0,
    pressed: (name) => read(name) > 0 && !((was.get(name) ?? 0) > 0),
    released: (name) => read(name) === 0 && (was.get(name) ?? 0) > 0,
    axis: (negative, positive) => read(positive) - read(negative),
    vector(left = "move_left", right = "move_right", up = "move_up", down = "move_down") {
      const x = api.axis(left, right);
      const y = api.axis(up, down);
      const length = Math.hypot(x, y);
      return length > 1 ? { x: x / length, y: y / length } : { x, y };
    },
    label(name) {
      read(name);
      return controls.label(name);
    },
    /** Whether the game's table has the action (one it dropped with null is gone). */
    has: (name) => controls.has(name),
    /** Moves an action to these mouse buttons (0 left, 1 middle, 2 right). */
    bindMouse: (name, buttons) => controls.setMouse(name, buttons),
  };
  return {
    api,
    /** Holds an action as if its key were down, or lets it go (the QA play's press). */
    force(name, on) {
      if (on) {
        forced.add(name);
        sampled.delete(name);
        letGo.delete(name);
      } else if (sampled.has(name)) forced.delete(name);
      else letGo.add(name);
    },
    /** The actions the game has read since this run began. */
    reads,
    /** The actions held in the last sample. */
    held: () => now.keys(),
    settle() {
      settling = true;
    },
    sample({ down, pressed, buttons, clicked, pad }) {
      was = now;
      now = new Map();
      for (const action of controls.actions.values()) {
        let strength = 0;
        for (const code of action.keys) if (down.has(code) || pressed.has(code)) strength = 1;
        for (const button of action.mouse)
          if (buttons.has(button) || clicked.has(button)) strength = 1;
        for (const name of action.pad) strength = Math.max(strength, padStrength(pad, name));
        if (forced.has(action.name)) {
          strength = 1;
          sampled.add(action.name);
        }
        if (strength > 0) now.set(action.name, strength);
      }
      for (const name of letGo) {
        forced.delete(name);
        letGo.delete(name);
      }
      if (settling) {
        was = now;
        settling = false;
      }
    },
  };
}
