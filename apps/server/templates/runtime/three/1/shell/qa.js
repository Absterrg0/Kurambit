// The QA play: what a player would hit, measured inside the game while the harness plays it
// (game_check). Three questions, each answered from what the game does, never from how it
// looks:
//
//   - every control works: each action the game declares (ACTIONS, shell/controls.js) is held
//     for a moment on a fresh run, and something answers it: the player moves or turns, a
//     GameState value changes, a Juice effect or a sound fires, or something appears. What
//     the game reads through ctx.input is also collected on its title and its ending: an
//     action read on none of them is reported as not read there, which is what was seen.
//   - Retry starts clean: a run is ended and retried as GameState.play() retries it, and the
//     new run is counted against the one before it: the scene's objects, the listeners on
//     window and document, the intervals running, the animation loops asking for frames, and
//     errors. Growth is state the game kept outside its run.
//   - the HUD fits: the page's text stays inside the view and does not overlap.
//
// A page a player opens never runs this: the harness calls window.__studio.qa on a page it
// opened with its counters on (studio.js). The play moves the run on the game's own clock
// (shell.js harnessClock), stepped as fast as the page allows: a slow machine makes it no longer and
// no different. Only a run compiling and the count of frames a game asks for outside its run
// take real time.
import { sfxAsked } from "./audio.js";
import { Juice } from "./juice.js";
import { GameState, SHELL_KEYS } from "./run-state.js";
import { outsideRun } from "./studio.js";

const SETTLE_MS = 150;
const HOLD_MS = 220;
const AFTER_MS = 380;
/** The no-press span a press is read against: as long as the press's, so a clock ticking once a second is as likely in either. */
const BASE_MS = HOLD_MS + AFTER_MS;
/** After a fresh start: past a round's opening beat, when many games ignore input. */
const OPENING_MS = 1200;
/** Fresh run every few actions, so a player hurt by then still answers. */
const ACTIONS_PER_RUN = 3;
const START_MS = 4000;
/** On the title or the ending, long enough for a screen that takes input only after a beat. */
const SCREEN_MS = 1500;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const positionOf = (player) => {
  if (player == null) return null;
  if (typeof player.getWorldPosition === "function") {
    const at = player.getWorldPosition(player.position.clone());
    return [at.x, at.y, at.z];
  }
  return typeof player.x === "number" ? [player.x, player.y ?? 0, player.z ?? 0] : null;
};
const distance = (a, b) =>
  a === null || b === null ? 0 : Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const turnOf = (player) => (typeof player?.rotation?.y === "number" ? player.rotation.y : null);
const angle = (a, b) => {
  if (a === null || b === null) return 0;
  const d = Math.abs(a - b) % (Math.PI * 2);
  return Math.min(d, Math.PI * 2 - d);
};

/**
 * `current()` is the run (or null), `restart()` starts a fresh one in play, `canLose(on)` lets
 * a loss end the run, `eachThing(fn)` walks the Stage's things and `openTitle()` starts a run
 * that may open on the game's own title.
 */
export function createQa({
  controls,
  current,
  restart,
  canLose,
  eachThing,
  errors,
  openTitle,
  hold,
  advance,
}) {
  /** Game time on the run's own clock. */
  const span = (ms) => advance(ms / 1000);
  // Juice effects asked for, counted by wrapping its methods once the QA play first runs.
  let juice = 0;
  let counting = false;
  const countJuice = () => {
    if (counting) return;
    counting = true;
    for (const [name, value] of Object.entries(Juice)) {
      if (typeof value !== "function") continue;
      Juice[name] = function (...args) {
        juice += 1;
        return value.apply(this, args);
      };
    }
  };

  const playing = async () => {
    const started = performance.now();
    if (GameState.state !== "playing" || current() === null) restart();
    while (performance.now() - started < START_MS) {
      const run = current();
      if (run !== null && run.compiling !== true && GameState.state === "playing") return run;
      await wait(50);
    }
    return null;
  };

  const signature = (run) => {
    const state = {};
    for (const [key, value] of Object.entries(GameState))
      if (!SHELL_KEYS.includes(key) && ["number", "string", "boolean"].includes(typeof value))
        state[key] = value;
    let objects = 0;
    run.ctx.scene.traverse(() => (objects += 1));
    let things = 0;
    eachThing(() => (things += 1));
    return {
      at: positionOf(run.ctx.player),
      turn: turnOf(run.ctx.player),
      state,
      juice,
      sfx: sfxAsked.count,
      objects,
      things,
    };
  };

  // What answered a press, over what changed in the same span with no press. `noisy` holds the
  // values seen changing with no press in any of this action's tries: a timer is never an answer.
  const answers = (s0, s1, s2, noisy) => {
    const ratio = (HOLD_MS + AFTER_MS) / BASE_MS;
    for (const key of Object.keys(s1.state)) if (s0.state[key] !== s1.state[key]) noisy.add(key);
    const drift = distance(s0.at, s1.at) * ratio;
    const more = (key) => s2[key] - s1[key] > (s1[key] - s0[key]) * ratio;
    return {
      moved: distance(s1.at, s2.at) > Math.max(0.05, drift * 2 + 0.02),
      turned: angle(s0.turn, s1.turn) < 0.05 && angle(s1.turn, s2.turn) > 0.15,
      keys: Object.keys(s2.state).filter(
        (key) => !noisy.has(key) && s1.state[key] !== s2.state[key],
      ),
      juice: more("juice"),
      sound: more("sfx"),
      spawned:
        more("things") ||
        s2.objects - s1.objects > Math.max(0, (s1.objects - s0.objects) * ratio) + 2,
    };
  };

  const press = async (run, name, noisy) => {
    await span(SETTLE_MS);
    const s0 = signature(run);
    await span(BASE_MS);
    const s1 = signature(run);
    run.input.force(name, true);
    await span(HOLD_MS);
    run.input.force(name, false);
    await span(AFTER_MS);
    if (current() !== run) return null;
    return answers(s0, s1, signature(run), noisy);
  };

  // A press's answers as kinds: "moved", "juice", "changed score" (one per value), ...
  const kinds = (found) => [
    ...(found.moved ? ["moved"] : []),
    ...(found.turned ? ["turned"] : []),
    ...found.keys.map((key) => `changed ${key}`),
    ...(found.juice ? ["juice"] : []),
    ...(found.sound ? ["sound"] : []),
    ...(found.spawned ? ["spawned"] : []),
  ];
  // The world acts on its own (an enemy's hit knocks the player back, a timer ticks), so one
  // press proves nothing either way: an action answers with what two of its presses agree on.
  // Two silent presses are a dead control; a third settles two that disagree.
  const probe = async (run, name) => {
    const tries = [];
    const noisy = new Set();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const found = await press(run, name, noisy);
      if (found === null) break;
      tries.push(kinds(found));
      const agreed = [...new Set(tries.flat())].filter(
        (kind) =>
          !(kind.startsWith("changed ") && noisy.has(kind.slice(8))) &&
          tries.filter((each) => each.includes(kind)).length >= 2,
      );
      if (agreed.length > 0) return agreed;
      if (tries.length === 2 && tries.every((each) => each.length === 0)) return [];
    }
    return [];
  };

  // A game drawing its own title may read a key there only (the one that leaves it): pressed in
  // play it answers nothing, which is no dead control. A title run's reads name those keys; null
  // when the game shows no title of its own.
  const titleKeys = async () => {
    openTitle();
    const started = performance.now();
    while (current()?.compiling === true && performance.now() - started < START_MS) await wait(50);
    await span(SCREEN_MS);
    const run = current();
    return run !== null && GameState.state === "title" ? new Set(run.input.reads) : null;
  };

  // Errors thrown while a control was pressed, each named by the control.
  const thrown = [];
  const everyControl = async () => {
    const out = [];
    let run = null;
    let onRun = 0;
    for (const action of controls.actions.values()) {
      // A default the game neither names nor reads is not one of its controls. One the pointer
      // drives (look) answers to the pointer's movement, which this play does not make.
      if (action.fixed || action.pointer || !controls.ownedByGame(action.name)) continue;
      if (run === null || onRun >= ACTIONS_PER_RUN || current() !== run) {
        restart();
        run = await playing();
        onRun = 0;
        if (run === null) break;
        await span(OPENING_MS);
      }
      onRun += 1;
      const errorsFrom = errors.length;
      const found = await probe(run, action.name);
      for (const error of errors.slice(errorsFrom))
        if (thrown.length < 10) thrown.push(`${action.label}: ${error.message}`.slice(0, 240));
      out.push({
        name: action.name,
        label: action.label,
        // Its keys as the player has them: Checks names a control by them ("E fish").
        keys: action.keys.filter((key) => typeof key === "string" && key.length <= 32).slice(0, 4),
        read: run.input.reads.has(action.name),
        answers: found,
      });
    }
    return out;
  };

  const count = async (run) => {
    let objects = 0;
    run.ctx.scene.traverse(() => (objects += 1));
    let things = 0;
    eachThing(() => (things += 1));
    const askedFrom = outsideRun.frames;
    const drawnFrom = outsideRun.drawn;
    await wait(1000);
    const drawn = outsideRun.drawn - drawnFrom;
    return {
      objects,
      things,
      listeners: outsideRun.listeners(),
      intervals: outsideRun.intervals(),
      loops: drawn === 0 ? 0 : Math.round(((outsideRun.frames - askedFrom) / drawn) * 10) / 10,
    };
  };

  const retry = async () => {
    const first = await playing();
    if (first === null) return null;
    await span(800);
    const before = await count(first);
    const errorsBefore = errors.length;
    // Ended as a loss ends it, then retried as GameState.play() retries it.
    canLose(true);
    GameState.lose("QA play");
    const ended = performance.now();
    while (GameState.state !== "ended" && performance.now() - ended < START_MS) await span(50);
    if (GameState.state !== "ended") return { report: { before, after: null, errors: [] } };
    // The ending is a screen of its own (Retry, Back to title): what the game reads there, as on
    // the title. The run's reads are its whole life's, and any read anywhere is no dead control.
    await span(SCREEN_MS);
    const atEnd = current() === first ? new Set(first.input.reads) : null;
    restart();
    const again = await playing();
    if (again === null) return { report: { before, after: null, errors: [] }, atEnd };
    await span(800);
    const after = await count(again);
    return {
      report: {
        before,
        after,
        errors: errors.slice(errorsBefore).map((error) => error.message.slice(0, 200)),
      },
      atEnd,
    };
  };

  return {
    async run() {
      countJuice();
      // A loss would end the run between presses; games that read ctx.cannotLose take no damage.
      canLose(false);
      hold(true);
      try {
        const onTitle = await titleKeys();
        const pressed = await everyControl();
        const retried = await retry();
        const atEnd = retried?.atEnd ?? null;
        const elsewhere = (name) => onTitle?.has(name) === true || atEnd?.has(name) === true;
        // A key read only on the title or the ending answers nothing in play: it works there.
        const controlsFound = pressed
          .filter((control) => control.answers.length > 0 || !elsewhere(control.name))
          .map((control) => ({ ...control, read: control.read || elsewhere(control.name) }));
        return {
          version: 1,
          controls: controlsFound,
          retry: retried?.report ?? null,
          errors: thrown,
          visited: [...(onTitle === null ? [] : ["title"]), ...(atEnd === null ? [] : ["end"])],
        };
      } finally {
        hold(false);
        canLose(true);
      }
    },
    /**
     * The HUD's text off the view or over other HUD text, at the page's size now. `texts` is how
     * many HUD texts it read: none means a HUD drawn in the canvas, which this cannot see.
     */
    hud() {
      const items = [];
      for (const element of document.body.querySelectorAll("*")) {
        const own = [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join("")
          .trim();
        if (own === "") continue;
        // Opacity is not inherited: text in a faded-out card reads opacity 1 on its own style.
        // What a player can see is the browser's own answer, ancestors included.
        if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        items.push({ element, text: own.slice(0, 60), rect });
      }
      const width = window.innerWidth;
      const height = window.innerHeight;
      const off = items
        .filter(
          ({ rect }) =>
            rect.left < -2 || rect.top < -2 || rect.right > width + 2 || rect.bottom > height + 2,
        )
        .map((item) => item.text);
      const over = [];
      for (let i = 0; i < items.length; i += 1)
        for (let j = i + 1; j < items.length; j += 1) {
          const a = items[i];
          const b = items[j];
          if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
          const w = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
          const h = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
          if (w <= 0 || h <= 0) continue;
          const smaller = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
          if (w * h > smaller * 0.3) over.push([a.text, b.text]);
        }
      return { width, height, texts: items.length, off: off.slice(0, 8), over: over.slice(0, 8) };
    },
  };
}
