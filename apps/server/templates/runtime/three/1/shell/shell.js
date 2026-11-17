// The bridge that runs a game's main.js (the import map's "#main"): the render loop, the run's
// fixed steps, its input and the studio bridge for the Stage, Tune, Controls, the checks and
// replays. It draws nothing a player sees: the game draws its own title, HUD, menus and endings
// (TEMPLATE.md's contract). main.js:
//
//   export function start(ctx) {}   // build the run into ctx.scene; set ctx.camera, ctx.player
//   export function update(dt, ctx) {} // every step of the run, on its title and past its end too
//   export function stop(ctx) {}     // optional: undo anything start() did outside ctx
//   export function resize(ctx) {}   // optional: every window resize, paused or not
//   export function setState(target, values, ctx) {} // optional studio reach; ctx is null
//                                    // with no run, then return false
//   export const KEEP_ACROSS_RUNS = ["best"]; // GameState values a retry keeps, saved between visits
//   export const ASSETS = { knight: "assets/models/knight.glb" }; // loaded before the first run
//   export const LOOK = { … };          // optional: the light, sky, fog and post chain (shell/look.js);
//                                    // without it the scene draws as the game built it
//   export async function prepare({ renderer, assets, look }) {} // optional: once, before the
//                                    // first run (build a big world, bake, compile)
//   export function render(ctx, dt) {} // optional: draw the frame yourself (your own chain);
//                                    // ctx.look.render(scene, camera) draws through the look
//
// Play runs in fixed steps: update(dt) is called once per display frame at the display's own
// rate (more on a slow frame), so a run plays the same on any machine, ctx.random() (and
// Math.random inside update) comes from the run's seed, and performance.now() and Date.now()
// inside update read the run's own clock. The Stage keeps a person's runs and plays them again
// on a newer build, and saved plays on every build (shell/replay.js).
//
// ctx, fresh each run: renderer, canvas, scene, camera, player, look (sun(), bake(), render();
// shell/look.js), assets (model(name) / texture(name), shell/assets.js), input (named actions
// from keys, mouse and gamepad, which the player can rebind: input.down("jump"),
// input.pressed("action"), input.vector(); the table and the calls are in shell/controls.js),
// keys (raw keys: keys.down("KeyW"), keys.pressed("Space")), thing(object, { name, kind }) and
// tune(id, defaults, ranges) for the Stage (selecting things and tuning their values live;
// shell/stage-bridge.js), mouse (x, y in canvas pixels, ndc.x / ndc.y from -1 to 1 for a
// Raycaster, movement.x / movement.y this frame, also under pointer lock, and down(button) /
// pressed(button), 0 the left button), listen(target, type, fn) and after(seconds, fn).
// Listeners and timers made through ctx fire only while the run is live and go away with it; the
// scene is emptied before the next one. The shell refits ctx.camera, perspective or
// orthographic, on resize.
//
// A run ends with GameState.win(text) or GameState.lose(text); the game moves the run with
// GameState.title/play/menu/pause/resume (shell/run-state.js), and its update keeps running past
// its end. A page made on the older demo shell (index.html with its section.screen elements) is
// not supported: it says so and runs nothing.
import * as THREE from "../vendor/three.module.js";
import { errors as studioErrors, installStudio } from "./studio.js";
import { createQa } from "./qa.js";
import { createStageBridge, loadTuning } from "./stage-bridge.js";
import { createSceneReport } from "./scene-report.js";
import {
  GameState,
  loadProgress,
  newRun,
  onLoseIgnored,
  onRunEnded,
  onShellCalls,
  cannotLose,
  setCanLose,
} from "./run-state.js";
import { Juice, juiceShell } from "./juice.js";
import { animateShell } from "./animate.js";
import { cameraShell } from "./camera.js";
import { createLook } from "./look.js";
import { assets, onModelCopy, preloadAssets } from "./assets.js";
import { createControls, createInput } from "./controls.js";
import {
  continuation,
  createPlayer,
  createRate,
  createRecorder,
  freshSeed,
  mark,
  seeded,
} from "./replay.js";
import { createDevView } from "./dev-view.js";
import { modelShell } from "./model.js";
import { waterShell } from "./water.js";
import { createSheet } from "./sheet.js";
import { VOLUME_NAMES, getVolume, holdAudio, setVolume, unlockAudio, muteAudio } from "./audio.js";
import * as game from "#main";

const SETTINGS_KEY = `settings:${location.pathname}`;
const KEEP = Array.isArray(game.KEEP_ACROSS_RUNS) ? game.KEEP_ACROSS_RUNS : [];

const byId = (id) => document.getElementById(id);
const canvas = byId("game");

/**
 * The older demo shell's page: all of its screens, as section.screen elements. Its games relied on
 * screens, a HUD kit and a default look this runtime no longer has, so the page says so and runs
 * nothing; the throw is the page's error, which a check or play reports at once. Kurambit tells
 * the person the same before it loads the page (carriesOldShell).
 */
const OLD_SHELL_SCREENS = ["loading", "title", "pause", "settings", "end", "credits", "controls"];
if (OLD_SHELL_SCREENS.every((id) => byId(id)?.matches("section.screen") === true)) {
  const message = "This game was made with an older Kurambit and is not supported in this version.";
  const note = document.createElement("p");
  note.textContent = message;
  note.style.cssText =
    "position:fixed;inset:0;margin:auto;height:fit-content;max-width:32em;padding:1em;z-index:2147483647;font:16px/1.5 system-ui,sans-serif;color:#eee;background:#111;text-align:center";
  document.body.append(note);
  throw new Error(message);
}

const controls = createControls(game.ACTIONS);
/**
 * Whether play's input and the run's own listeners reach the game now: in play, and on its own
 * title and its ending, where its own update decides what they do.
 */
const live = () =>
  GameState.state === "playing" || GameState.state === "title" || GameState.state === "ended";

// The look makes the renderer: MSAA only where no post chain runs over it. A game with no LOOK
// gets the plain renderer: its scene's own background, lights and fog, as three.js draws them.
const look = await createLook(canvas, game.LOOK ?? { preset: "plain" });
const { renderer } = look;

let run = null;
let held = false;
// Play holds while the Stage's tab is hidden or the Stage has frozen it.
let hidden = false;
let frozen = false;
/** Play holds while its tab is hidden; the game decides what pause looks like. */
let tabHidden = false;
/** The harness's model sheet is over the page (shell/sheet.js): play holds under it. */
let sheetShown = false;
let redraw = true;
/** The first connected gamepad this frame, or null. */
let gamepad = null;
// Where the pointer last was on the canvas; a new run starts aiming there.
const pointer = { x: 0, y: 0, ndcX: 0, ndcY: 0 };
/** The display's frame time, which a new run steps at. */
const rate = createRate();
const nativeRandom = Math.random;
const nativeNow = performance.now;
const nativeDateNow = Date.now;
/** A play the next run replays (window.__studio.replay, studio-replay), and who waits for its end. */
let nextReplay = null;
let replayDone = null;
/** A measuring replay draws one frame in this many: its answer is the run, not the picture. */
let replayDrawEvery = 1;
let replayFrames = 0;
/** A replay asked to stop at a moment, `{ at }` a second of play or `{ step }`: null, to its end. */
let replayStop = null;
/**
 * A Stage replay (studio-replay) going on: at its moment the run is handed over to live play,
 * frozen. It keeps what the Stage had set (speed, Can't lose), which the replay's own recorded
 * changes stand in for until then. Null otherwise.
 */
let handover = null;
/** A Stage replay plays at the run's own pace from this step on, so a moment can be watched. */
let replayPace = null;
/** Each recent run's tuned values as it began, by seed and clock: a Stage replay starts from them. */
const runTunes = new Map();
const runKey = (play) => `${play.seed}:${play.clock?.join(":") ?? ""}`;
/** Runs played to an end on a page the Stage does not hold, for the harness to keep. */
const finishedPlays = [];
/** Most steps one frame runs: a slow frame catches up at most 0.1 s, as play always has. */
const CATCH_UP_S = 0.1;
/** A replay steps as fast as this much of each frame allows. */
const REPLAY_FRAME_MS = 12;
/** Past where the kept run ended, a replay plays on this long before it calls the run unended. */
const REPLAY_AFTER_S = 10;
/** A Stage replay draws one frame in this many while it hurries to its moment. */
const STAGE_REPLAY_DRAW_EVERY = 30;
/**
 * A Stage replay still short of its moment after this much real time gives up and starts a
 * fresh run: a long run on a heavy game in software rendering would keep the person waiting.
 */
const STAGE_REPLAY_MAX_MS = 20_000;
/** A loss Can't lose kept from ending the run is noted at most this often (play seconds). */
const LOSS_NOTE_EVERY_S = 1;

/**
 * Runs `work` with Math.random drawing from the run's seed and the clock reading the run's game
 * time, so a replay draws and times the same.
 */
function seededWork(context, work) {
  Math.random = context.random;
  performance.now = context.now;
  Date.now = context.dateNow;
  try {
    return work();
  } finally {
    Math.random = nativeRandom;
    performance.now = nativeNow;
    Date.now = nativeDateNow;
  }
}

/** A run's clock bases: performance.now() and Date.now() as the run began. */
const clockNow = () => [nativeNow.call(performance), nativeDateNow()];

function newContext(seed = freshSeed(), clock = clockNow()) {
  const down = new Set();
  const pressed = new Set();
  const listeners = [];
  const timers = [];
  const buttons = new Set();
  const clicked = new Set();
  const input = createInput(controls);
  const ctx = {
    renderer,
    canvas,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500),
    /** The models and textures main.js lists in ASSETS, loaded before the title (shell/assets.js). */
    assets,
    /** The player object (an Object3D or {x, y, z}); the studio probe reports its position. */
    player: null,
    input: input.api,
    keys: {
      down: (code) => down.has(code),
      pressed: (code) => pressed.has(code),
    },
    mouse: {
      x: pointer.x,
      y: pointer.y,
      ndc: { x: pointer.ndcX, y: pointer.ndcY },
      movement: { x: 0, y: 0 },
      down: (button = 0) => buttons.has(button),
      pressed: (button = 0) => clicked.has(button),
    },
    listen(target, type, fn, options) {
      const wrapped = (event) => {
        if (live()) fn(event);
      };
      target.addEventListener(type, wrapped, options);
      listeners.push(() => target.removeEventListener(type, wrapped, options));
    },
    after(seconds, fn) {
      timers.push({ left: seconds, fn });
    },
    /** Names an object (or null: a rule, the music, a difficulty) so the Stage can select it. */
    thing: (object, options) => bridge.thing(object, options),
    /** The live values of a thing: web/tune.json over these defaults, changed live by the Stage. */
    tune: (id, defaults, ranges) => bridge.tune(id, defaults, ranges),
    /** The Stage's "Can't lose" is on: the player takes no damage (a loss never ends the run). */
    get cannotLose() {
      return cannotLose();
    },
    /** 0..1 from the run's seed: a replay of the run draws the same numbers. */
    random: seeded(seed),
  };
  ctx.look = look.forRun(ctx);
  const context = {
    ctx,
    input,
    down,
    pressed,
    buttons,
    clicked,
    listeners,
    timers,
    reported: false,
    random: ctx.random,
    clock,
    now: () => clock[0] + context.time * 1000,
    dateNow: () => Math.floor(clock[1] + context.time * 1000),
    seed,
    dt: 1 / 60,
    steps: 0,
    time: 0,
    left: 0,
    recorder: null,
    player: null,
  };
  return context;
}

const keyNames = (event) => [
  event.code,
  event.key.length === 1 ? event.key.toLowerCase() : event.key,
];

function releaseKeys() {
  run?.down.clear();
  run?.pressed.clear();
  run?.buttons.clear();
  run?.clicked.clear();
}

function clearFrameInput() {
  if (run === null) return;
  run.pressed.clear();
  run.clicked.clear();
  run.ctx.mouse.movement.x = 0;
  run.ctx.mouse.movement.y = 0;
}

function dispose(scene) {
  scene.traverse((object) => {
    object.geometry?.dispose?.();
    // An InstancedMesh holds its per-instance matrices on the GPU too.
    if (object.isInstancedMesh) object.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (material == null) continue;
      for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
      material.dispose();
    }
  });
}

/**
 * A run the person leaves before it ends (Retry, the menu, a reload, the Stage closing): kept by
 * the Stage as left, so the agent hears of it too. A run nobody played is not posted.
 */
function leaveRun() {
  if (run === null || run.player !== null || run.recorder == null) return;
  // Handed over by a replay and not played since: the run it came from was kept already.
  if (run.steps === run.handedAt) return;
  const play = run.recorder.soFar(
    Math.round(run.time * 10) / 10,
    mark(run.time, run.ctx.player, GameState),
    run.input.reads,
  );
  run.recorder = null;
  if (play !== null) bridge.play(play);
}

function clearRun() {
  leaveRun();
  juiceShell.reset();
  animateShell.reset();
  cameraShell.reset();
  modelShell.reset();
  look.reset();
  bridge.reset();
  if (run !== null) {
    const ended = run;
    run = null;
    for (const remove of ended.listeners) remove();
    try {
      game.stop?.(ended.ctx);
    } catch (error) {
      reportError(error);
    }
    dispose(ended.ctx.scene);
  }
  Juice.stage = null;
}

/**
 * A fresh run in play. `title`: the run may open on the game's own title instead
 * (GameState.title() in its start), as a page a player opens does and the game's own
 * GameState.menu(); never a retry, `?play`, a replay or a harness play.
 */
function startRun({ title = false } = {}) {
  clearRun();
  GameState.state = "playing";
  const replaying = nextReplay;
  nextReplay = null;
  // A play from before the clock was kept times from now: its game time still matches.
  run = newContext(replaying?.seed ?? freshSeed(), replaying?.clock ?? clockNow());
  run.mayTitle = title && replaying === null;
  run.dt = replaying?.dt ?? rate.step();
  if (replaying === null) {
    run.recorder = createRecorder(run.seed, run.dt, run.clock);
    runTunes.set(runKey(run), bridge.tuneValues());
    if (runTunes.size > 8) runTunes.delete(runTunes.keys().next().value);
    // How the Stage had play when the run began: a replay starts the same way.
    run.recorder.event("speed", studioSpeed);
    run.recorder.event("can-lose", !cannotLose());
  } else run.player = createPlayer(replaying);
  Juice.stage = run.ctx.scene;
  redraw = true;
  // A replay begins with the values its run tuned, as they were when it began.
  if (replaying !== null) bridge.presetTunes(replaying.tunes);
  // A throw here is reported like one in update(), so the loop still starts,
  // the menus keep working and the check sees the error itself.
  try {
    newRun(KEEP);
    run.starting = true;
    seededWork(run, () => game.start?.(run.ctx));
  } catch (error) {
    reportError(error);
    run.reported = true;
  } finally {
    if (run !== null) run.starting = false;
    if (replaying !== null) bridge.presetTunes(null);
  }
  // The run's own programs compile before its first frame, so play never opens on a stall.
  const started = run;
  started.compiling = true;
  look.compile(started.ctx.scene, started.ctx.camera).then(() => (started.compiling = false));
}

/**
 * The game's own title (GameState.title() in start): the run stays on it, stepping, until the
 * game calls GameState.play(), which starts a fresh run in play. A title run is not a play the
 * Stage keeps, so it records nothing.
 */
function holdOnTitle() {
  if (run === null || !run.starting || !run.mayTitle || GameState.state !== "playing") return;
  GameState.state = "title";
  run.recorder = null;
}

/** The game's own GameState.play() and GameState.menu(): after the frame, never inside a step. */
let asked = null;
function ask(next) {
  if (asked === null)
    queueMicrotask(() => {
      const now = asked;
      asked = null;
      startRun({ title: now === "menu" });
    });
  asked = next;
}

function pause() {
  if (GameState.state !== "playing") return;
  GameState.state = "paused";
  releaseKeys();
  juiceShell.endHitPause();
  if (document.pointerLockElement !== null) document.exitPointerLock?.();
}

function resume() {
  if (GameState.state !== "paused") return;
  run?.input.settle();
  GameState.state = "playing";
}

onShellCalls({
  title: holdOnTitle,
  play: () => ask("play"),
  menu: () => ask("menu"),
  pause,
  resume,
});

// A loss Can't lose kept from ending the run: the run's timeline shows it.
onLoseIgnored((text) => {
  const recorder = run?.recorder;
  if (recorder == null) return;
  if (run.lossNotedAt !== undefined && run.time - run.lossNotedAt < LOSS_NOTE_EVERY_S) return;
  run.lossNotedAt = run.time;
  recorder.event("loss", String(text ?? "").slice(0, 80));
});

onRunEnded((won, text) => {
  if (run === null) return;
  releaseKeys();
  const outcome = {
    won,
    text: String(text ?? "").slice(0, 200),
    seconds: Math.round(run.time * 10) / 10,
  };
  if (run.player !== null) finishReplay(outcome);
  else {
    const where = mark(run.time, run.ctx.player, GameState);
    const play = run.recorder?.finish({ ...outcome, where }, run.input.reads);
    if (play != null) {
      bridge.play(play);
      finishedPlays.push(play);
      if (finishedPlays.length > 3) finishedPlays.shift();
    }
    // Play goes on past the game's own ending, and the kept play ends here.
    run.recorder = null;
  }
});

/**
 * The replay's answer: how its run ended (null when it had not) and where it stood each second.
 * A replay asked to stop at a moment holds there, or where it ended before it, its frame drawn.
 */
function finishReplay(outcome) {
  const done = replayDone;
  replayDone = null;
  replayDrawEvery = 1;
  const stopping = replayStop !== null;
  replayStop = null;
  replayPace = null;
  const handing = handover;
  handover = null;
  const result = {
    outcome,
    seconds: Math.round(run.time * 10) / 10,
    steps: run.steps,
    marks: run.player.marks,
    ...(stopping ? { stopped: mark(run.time, run.ctx.player, GameState) } : {}),
  };
  if (handing !== null && outcome === null) handOver(handing);
  else if (stopping) {
    run.stopped = true;
    redraw = true;
    // A Stage replay that ended before its moment holds at the ending; playing on plays the
    // ending out, as a run that is no longer recorded.
    if (handing !== null) {
      run.playOut = true;
      restoreStage(handing.live);
      bridge.hold();
    }
  }
  done?.(result);
}

/**
 * The replay reached its moment: the run goes on live from here, frozen. The recorder takes over
 * from what was replayed, so the run is one recording; the person's input moves it from now on.
 */
function handOver(handing) {
  const source = run.player.play;
  // What the Stage changed at this very step (a value tuned while frozen here) holds already.
  run.player.events(run.steps, replayEvent);
  run.recorder = createRecorder(
    run.seed,
    run.dt,
    run.clock,
    continuation(source, run.steps, run.player.marks, handing.fork),
  );
  run.player = null;
  run.handedAt = run.steps;
  restoreStage(handing.live);
  redraw = true;
  bridge.hold();
}

/** What the Stage had set before its replay, back now that the run is live again, and recorded. */
function restoreStage(live) {
  studioSpeed = live.speed;
  setCanLose(live.canLose);
  run?.recorder?.event("speed", live.speed);
  run?.recorder?.event("can-lose", live.canLose);
}

/**
 * The Stage's replay (studio-replay): the play run again from its seed up to a moment (`step`, or
 * `at` a second of play) as fast as it steps, drawing now and then, then handed over to live
 * play there, frozen. `pace`: from that step on it plays at the run's own pace, so a moment can be
 * watched. `fork`: the run goes on as a new run from that second of the old one. A play that
 * pressed an action this build lacks, or that takes too long to get back, starts a fresh run
 * instead. Answered with studio-replayed, `id` echoed.
 */
function stageReplay({ id, play, step, at, pace, fork }) {
  // A replay already going keeps what the Stage had set before it.
  const live = handover?.live ?? { speed: studioSpeed, canLose: !cannotLose() };
  const missing = (play.actions ?? []).filter((name) => !controls.has(name));
  if (missing.length > 0) {
    freshRun(live, true);
    bridge.replayed({ id, missing });
    return;
  }
  // A replay cut short by this one has no answer: the Stage asked for this one after it.
  replayDone?.(null);
  bridge.restoreTunes(runTunes.get(runKey(play)) ?? {});
  nextReplay = play;
  startRun();
  replayStop = Number.isFinite(step) ? { step } : { at: Math.max(0, at) };
  replayPace = Number.isFinite(pace) ? pace : null;
  replayDrawEvery = STAGE_REPLAY_DRAW_EVERY;
  replayFrames = 0;
  handover = { id, live, fork, startedAt: nativeNow.call(performance) };
  holdAudio(true);
  replayDone = (result) => {
    applyHold();
    if (result === null) return;
    bridge.replayed({
      id,
      ended: result.outcome,
      seconds: result.seconds,
      steps: result.steps,
      marks: result.marks,
      ...(result.stopped === undefined ? {} : { at: result.stopped }),
    });
  };
}

/** A fresh run in play, frozen when `frozen`: what a Stage replay that cannot get back gives. */
function freshRun(live, frozen) {
  replayDone?.(null);
  replayDone = null;
  replayStop = null;
  replayPace = null;
  handover = null;
  replayDrawEvery = 1;
  // Set before the run starts, so its recording starts with them.
  studioSpeed = live.speed;
  setCanLose(live.canLose);
  startRun();
  applyHold();
  if (frozen) bridge.hold();
  else bridge.release();
}

function saveSettings() {
  const values = { controls: controls.saved() };
  for (const name of VOLUME_NAMES) values[name] = getVolume(name);
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(values));
  } catch {
    // Storage can be blocked (private mode, sandboxed frames); settings then last this visit.
  }
}

function loadSettings() {
  let values = {};
  try {
    values = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") ?? {};
  } catch {
    values = {};
  }
  for (const name of VOLUME_NAMES)
    if (typeof values[name] === "number") setVolume(name, values[name]);
  controls.load(values.controls);
}

window.addEventListener("keydown", (event) => {
  if (!live() || run === null) return;
  for (const name of keyNames(event)) {
    if (!event.repeat) run.pressed.add(name);
    run.down.add(name);
  }
  // Play's keys never scroll the page; a game listening for them itself still hears them.
  if (event.code.startsWith("Arrow") || event.code === "Space") event.preventDefault();
});

window.addEventListener("keyup", (event) => {
  for (const name of keyNames(event)) run?.down.delete(name);
});
window.addEventListener("blur", releaseKeys);

// Gameplay mouse input: only presses on the canvas (or anywhere under pointer
// lock), so a click on the page's own menus never fires a shot.
const gameplayPointer = (event) =>
  run !== null &&
  live() &&
  !held &&
  (event.target === canvas || document.pointerLockElement != null);

window.addEventListener("pointermove", (event) => {
  const rect = canvas.getBoundingClientRect();
  pointer.x = event.clientX - rect.left;
  pointer.y = event.clientY - rect.top;
  pointer.ndcX = rect.width > 0 ? (pointer.x / rect.width) * 2 - 1 : 0;
  pointer.ndcY = rect.height > 0 ? 1 - (pointer.y / rect.height) * 2 : 0;
  if (run === null) return;
  const mouse = run.ctx.mouse;
  if (document.pointerLockElement == null) {
    mouse.x = pointer.x;
    mouse.y = pointer.y;
    mouse.ndc.x = pointer.ndcX;
    mouse.ndc.y = pointer.ndcY;
  }
  if (gameplayPointer(event)) {
    mouse.movement.x += event.movementX;
    mouse.movement.y += event.movementY;
  }
});
window.addEventListener("pointerdown", (event) => {
  if (!gameplayPointer(event)) return;
  run.buttons.add(event.button);
  run.clicked.add(event.button);
});
window.addEventListener("pointerup", (event) => run?.buttons.delete(event.button));
// A cancelled touch never sends pointerup; without this the button stays down.
window.addEventListener("pointercancel", (event) => run?.buttons.delete(event.button));
// A reload or the Stage closing leaves the run in play: the Stage keeps it as left.
window.addEventListener("pagehide", leaveRun);
// A hidden tab only holds play: the game decides what pause looks like. The studio stage hides
// with CSS, which leaves the page visible, so its own hold is unaffected.
document.addEventListener("visibilitychange", () => {
  tabHidden = document.visibilityState === "hidden";
  applyHold();
});

let pads = 0;
const padWas = [];
window.addEventListener("gamepadconnected", () => (pads += 1));
window.addEventListener("gamepaddisconnected", () => (pads = Math.max(0, pads - 1)));

function pollGamepad() {
  gamepad = null;
  if (pads === 0) return;
  const pad = [...(navigator.getGamepads?.() ?? [])].find((each) => each != null);
  if (pad === undefined) return;
  gamepad = pad;
  if (pad.buttons.some((button, i) => button.pressed && padWas[i] !== true)) unlockAudio();
  pad.buttons.forEach((button, i) => (padWas[i] = button.pressed));
}

/** What the Stage changed mid-run, as a replay puts it back at the same step. */
function replayEvent(kind, ...args) {
  if (kind === "speed") studioSpeed = args[0];
  else if (kind === "can-lose") setCanLose(args[0]);
  else if (kind === "tune" && bridge.setTune(args[0], args[1], args[2])) modelShell.tuned(args[0]);
}

/** The run in play so far, however short, as a play that did not end; null with none recorded. */
const runSoFar = () =>
  run === null || run.player !== null
    ? null
    : (run.recorder?.soFar(
        Math.round(run.time * 10) / 10,
        mark(run.time, run.ctx.player, GameState),
        run.input.reads,
        { asked: true },
      ) ?? null);

/** A replay asked to stop at a moment has reached it. */
const reachedStop = (stepping) =>
  replayStop !== null &&
  run === stepping &&
  (replayStop.step !== undefined
    ? stepping.steps >= replayStop.step
    : stepping.time >= replayStop.at);

/** One fixed step: this step's input, then the game, at the step's slice times the time scale. */
function step() {
  const { down, pressed, buttons, clicked } = run;
  const pad = run.player !== null ? run.player.input(run, run.steps, replayEvent) : gamepad;
  run.recorder?.input(run, gamepad);
  const dt = run.dt * studioSpeed * juiceShell.timeScale();
  juiceShell.pass(run.dt);
  run.input.sample({ down, pressed, buttons, clicked, pad });
  run.recorder?.actions(run.input.held());
  const stepping = run;
  seededWork(stepping, () => {
    const due = [];
    for (let i = stepping.timers.length - 1; i >= 0; i -= 1)
      if ((stepping.timers[i].left -= dt) <= 0) due.unshift(...stepping.timers.splice(i, 1));
    try {
      for (const timer of due) timer.fn();
      game.update?.(dt, stepping.ctx);
      animateShell.update(dt);
      waterShell.update(dt, stepping.ctx);
      cameraShell.update(dt);
    } catch (error) {
      // One report a run: the loop keeps going so the menus keep working.
      if (!stepping.reported) reportError(error);
      stepping.reported = true;
    }
    juiceShell.update(dt);
  });
  if (run !== stepping) return dt;
  run.steps += 1;
  run.time += dt;
  // Where the run stands once a second: a replay names the first second it plays differently.
  const marking = run.steps % Math.max(1, Math.round(1 / run.dt)) === 0;
  const entry = marking ? mark(run.time, run.ctx.player, GameState) : null;
  run.recorder?.stepped(run.steps, entry);
  if (entry !== null && run.player !== null) run.player.marks.push(entry);
  // A person's own play, while it is played: a replay racing to its moment, or an end screen
  // standing still, is not the run they watch.
  else if (entry !== null && GameState.state === "playing") bridge.mark(entry);
  clearFrameInput();
  return dt;
}

// A Stage portrait's camera (stage-bridge.js portrait) for the one frame it draws.
let portraitCamera = null;
function draw(dt) {
  if (run === null) {
    renderer.clear();
    return;
  }
  // A frozen frame the Stage's free camera flies around is drawn from it, the game's own render
  // included; the game's camera is back before anything else reads ctx.camera.
  const own = run.ctx.camera;
  const camera = portraitCamera ?? devView.camera() ?? own;
  run.ctx.camera = camera;
  // The person's look edits from Art (scale, turn) sit on their things only while this draws.
  bridge.shapeLooks(true);
  try {
    juiceShell.beforeRender(camera, renderer);
    if (game.render !== undefined) {
      try {
        game.render(run.ctx, dt);
      } catch (error) {
        if (!run.reported) reportError(error);
        run.reported = true;
      }
    } else look.render(run.ctx.scene, camera, dt);
    juiceShell.afterRender(camera);
  } finally {
    bridge.shapeLooks(false);
    run.ctx.camera = own;
  }
}

// Every resize, whatever the state.
function onResize() {
  look.resize(window.innerWidth, window.innerHeight);
  const aspect = window.innerWidth / window.innerHeight;
  fit(run?.ctx.camera, aspect);
  if (run !== null)
    try {
      game.resize?.(run.ctx);
    } catch (error) {
      // Once per run: dragging the window would otherwise flood the errors.
      if (!run.reported) reportError(error);
      run.reported = true;
    }
  redraw = true;
}
window.addEventListener("resize", onResize);
// A cross-site Stage frame gets its size after its scripts start: one that arrived
// during createLook's awaits fired no listener and left the canvas at 0 x 0, a black game.
onResize();

function fit(camera, aspect) {
  if (camera?.isPerspectiveCamera) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  } else if (camera?.isOrthographicCamera) {
    // Keeps the vertical extent and the centre; the width follows the window.
    const centre = (camera.left + camera.right) / 2;
    const half = ((camera.top - camera.bottom) / 2) * aspect;
    camera.left = centre - half;
    camera.right = centre + half;
    camera.updateProjectionMatrix();
  }
}

function applyHold() {
  held = hidden || frozen || sheetShown || tabHidden;
  releaseKeys();
  return holdAudio(held);
}

// One object, refilled: the bridge's trace reads it 30 times a second.
const stageView = { scene: null, camera: null };
const gameView = () => {
  const shown = run?.ctx;
  return shown?.camera?.isCamera === true ? shown : null;
};
/** What is on screen, from the Stage's free camera while it flies. */
const view = () => {
  const shown = gameView();
  if (shown === null) return null;
  stageView.scene = shown.scene;
  stageView.camera = (run !== null ? devView.camera() : null) ?? shown.camera;
  return stageView;
};
const devView = createDevView({
  renderer,
  view: gameView,
  eachBody(fn) {
    const scene = gameView()?.scene;
    bridge.eachThing((record) => {
      for (const body of record.parts ?? (record.object === null ? [] : [record.object])) {
        let root = body;
        while (root.parent !== null) root = root.parent;
        if (root === scene) fn(body);
      }
    });
  },
  redraw: () => (redraw = true),
});
// The Stage's slow motion: play time runs at this share of real time.
let studioSpeed = 1;
const bridge = createStageBridge({
  canvas,
  renderer,
  view,
  freeze(on) {
    frozen = on;
    // Playing on from a Stage replay that ended early: the ending plays out, unrecorded.
    if (!on && run?.playOut === true) {
      run.playOut = false;
      run.stopped = false;
      run.player = null;
    }
    // The pointer is the Stage's while frozen; giving up the lock is not the pause press.
    if (on && document.pointerLockElement != null) {
      document.exitPointerLock?.();
    }
    applyHold();
  },
  redraw: () => (redraw = true),
  speed(scale) {
    studioSpeed = scale;
    run?.recorder?.event("speed", scale);
  },
  mute: muteAudio,
  canLose(on) {
    setCanLose(on);
    run?.recorder?.event("can-lose", on);
  },
  // "Tell the agent about this run" while paused: the run so far, however short.
  runSoFar,
  rewind: {
    // The run so far for the Stage's timeline, or (`leave`) as its page goes away: it is the
    // Stage's to keep and to resume on the new page, so the page's own leaving keeps nothing.
    take(leave) {
      const play = runSoFar();
      if (play === null || !leave) return play;
      run.recorder = null;
      return { ...play, outcome: { ...play.outcome, text: "" } };
    },
    replay: stageReplay,
    fresh: () => freshRun(handover?.live ?? { speed: studioSpeed, canLose: !cannotLose() }, false),
  },
  tuned(id, key, value, before) {
    run?.recorder?.tuned(id, key, before);
    run?.recorder?.event("tune", id, key, value);
    // A model built from these values (shell/model.js tuned) is built again, frozen or not.
    modelShell.tuned(id);
  },
  dev: {
    set: (next, focus) => devView.set(next, focus),
    frozen: (on, focus) => devView.frozen(on, focus),
    orbit: (dx, dy, zoom) => devView.orbit(dx, dy, zoom),
    // One fixed step of a frozen run, as play would take it.
    step() {
      if (run === null || run.compiling || GameState.state !== "playing") return;
      step();
      redraw = true;
    },
  },
  // The Stage's Controls: the same table, rebinds and saved settings as the Controls screen.
  controls: {
    list: () =>
      [...controls.actions.values()]
        .filter((action) => controls.ownedByGame(action.name))
        .map((action) => ({
          name: action.name,
          label: action.label,
          codes: [...action.keys],
          ...controls.parts(action),
          fixed: action.fixed,
          changed: action.keys.join() !== action.defaults.join(),
        })),
    rebind(name, code) {
      const note = controls.rebind(name, code);
      saveSettings();
      return note;
    },
    reset() {
      controls.reset();
      saveSettings();
    },
  },
  drawClean() {
    if (run?.compiling === true) return;
    look.update();
    draw(0);
  },
  /** False when nothing was drawn: a run whose programs still compile, or none. */
  drawFrom(camera) {
    if (run === null || run.compiling === true) return false;
    portraitCamera = camera;
    try {
      look.update();
      draw(0);
    } finally {
      portraitCamera = null;
    }
    return true;
  },
});
onModelCopy(bridge.assetCopy);

// Looks at the scene only once the harness starts a measured play (window.__studio.scene).
const sceneReport = createSceneReport({
  canvas,
  gl: renderer.getContext(),
  renderer,
  view: () => (run === null ? null : view()),
  player: () => run?.ctx.player ?? null,
  bridge,
  animation: (object) => animateShell.stateOf(object),
});

/** A named thing's record, by its Stage id or name (case aside), with a body to draw. */
const thingNamed = (wanted) => {
  const lower = wanted.toLowerCase();
  let loose = null;
  let exact = null;
  bridge.eachThing((record) => {
    if (exact !== null || record.object?.isObject3D !== true) return;
    if (record.id === wanted || record.name === wanted) exact = record;
    else if (
      loose === null &&
      (record.id.toLowerCase() === lower || record.name.toLowerCase() === lower)
    )
      loose = record;
  });
  return exact ?? loose;
};
const sheet = createSheet({
  renderer,
  find: thingNamed,
  names() {
    const listed = [];
    bridge.eachThing((record) => {
      if (record.object?.isObject3D === true && listed.length < 60)
        listed.push({ name: record.name, kind: record.kind });
    });
    return listed;
  },
  hold(on) {
    sheetShown = on;
    applyHold();
  },
  light: (scene) => look.lightForPicture(scene, run?.ctx.scene.environment ?? null),
});

const studio = installStudio({
  sheet,
  perf: () => ({ ...look.stats(), springs: animateShell.springCost() }),
  player: () => run?.ctx.player ?? null,
  setState: (target, values) => game.setState?.(target, values, run?.ctx ?? null),
  // How the harness starts play on a page opened as a player opens it, whatever its title is.
  play() {
    if (GameState.state === "playing" && run !== null) return true;
    startRun();
    return true;
  },
  hold(on) {
    hidden = on;
    return applyHold();
  },
  bridge,
  scene: sceneReport,
  // A kept play, run again from its seed with its input at each step (shell/replay.js). A play
  // that pressed an action this build no longer has cannot be replayed: it says which.
  // `drawEvery`: a measuring replay draws one frame in that many. `at`: it stops and holds at
  // that second of play (or where it ended before), its frame drawn.
  replay(play, options = {}) {
    const missing = (play.actions ?? []).filter((name) => !controls.has(name));
    if (missing.length > 0)
      return Promise.resolve({ outcome: null, seconds: 0, steps: 0, marks: [], missing });
    return new Promise((resolve) => {
      replayDone?.(null);
      handover = null;
      replayPace = null;
      replayDone = resolve;
      nextReplay = play;
      startRun();
      replayDrawEvery = Math.max(1, Math.floor(Number(options.drawEvery) || 1));
      replayFrames = 0;
      replayStop = Number.isFinite(options.at) ? { at: Math.max(0, options.at) } : null;
    });
  },
  // The runs this page played to an end since the last call, for a harness session to keep.
  takePlays: () => finishedPlays.splice(0),
  // The harness's QA play: a retry is GameState.play()'s own startRun.
  qa: createQa({
    controls,
    current: () => run,
    restart: startRun,
    canLose: setCanLose,
    eachThing: (fn) => bridge.eachThing(fn),
    openTitle: () => startRun({ title: true }),
    errors: studioErrors,
  }),
});

loadSettings();
loadProgress(KEEP);
await loadTuning();
// Before the loop starts, so studio.ready (the harness's boot signal) waits for the assets,
// the game's own prepare and the shader warm-up too.
const assetCount = Object.keys(game.ASSETS ?? {}).length;
document.body.dataset.state = "loading";
if (assetCount > 0) await preloadAssets(game.ASSETS);
if (game.prepare !== undefined)
  try {
    await game.prepare({
      renderer,
      assets,
      look: { bake: look.bake, render: look.render, settings: look.settings },
      // A game from when a loading bar showed it still calls this.
      progress: () => undefined,
    });
  } catch (error) {
    reportError(error);
  }
// Every program the frame needs (the look's chain, the models lit as a run is) compiles
// before the first frame, never on the first frame of play.
{
  const models = Object.keys(game.ASSETS ?? {}).flatMap((name) => {
    try {
      return [assets.model(name)];
    } catch {
      return [];
    }
  });
  // A warm-up that fails costs only the first frame's compile, never the boot.
  try {
    await look.warm(models);
  } catch (error) {
    console.warn("look: shader warm-up failed", error);
  }
}
// `?play` boots straight into play, skipping the title (handy while building).
// The Stage reloads a live game with #kurambit-play once the person has
// played it, so a save lands them back in play, as pressing Play would.
const straightToPlay =
  new URLSearchParams(location.search).has("play") || location.hash.includes("kurambit-play");
startRun({ title: !straightToPlay });

let last = performance.now();
// The scene report's last sample, which ran after the previous draw: the measuring's own time
// stays out of the frame times the performance fact and the render scale judge the game by.
let measuredMs = 0;
renderer.setAnimationLoop((now) => {
  const elapsedMs = Math.max(now - last, 0);
  const realMs = Math.max(elapsedMs - measuredMs, 0);
  measuredMs = 0;
  const real = Math.min(elapsedMs / 1000, CATCH_UP_S);
  last = now;
  if (!held && !document.hidden) rate.frame(elapsedMs);
  pollGamepad();
  // Only unpaused, unheld time moves the run. A Stage replay goes on
  // through the Stage's own holds (frozen, or the person clicked away to scrub its timeline).
  const holding = handover !== null ? tabHidden || sheetShown : held;
  const moving = run !== null && !run.compiling && !holding && run.stopped !== true && live();
  let dt = 0;
  if (handover !== null && nativeNow.call(performance) - handover.startedAt > STAGE_REPLAY_MAX_MS) {
    const { id, live: before } = handover;
    freshRun(before, true);
    bridge.replayed({ id, slow: STAGE_REPLAY_MAX_MS / 1000 });
  } else if (moving && run.player !== null && (replayPace === null || run.steps < replayPace)) {
    // A replay: as many steps as fit in part of a frame, never waiting on real time.
    const until = performance.now() + REPLAY_FRAME_MS;
    const stepping = run;
    for (;;) {
      // A step can end the run, or start another (a game that restarts itself).
      if (run !== stepping || stepping.stopped === true || performance.now() >= until) break;
      if (GameState.state !== "playing") break;
      if (replayPace !== null && stepping.steps >= replayPace) break;
      dt += step();
      if (reachedStop(stepping)) {
        finishReplay(null);
        break;
      }
      if (
        replayDone !== null &&
        stepping.steps > stepping.player.play.steps + REPLAY_AFTER_S / stepping.dt
      ) {
        finishReplay(null);
        break;
      }
    }
    replayFrames += 1;
    redraw = stepping.stopped === true || replayFrames % replayDrawEvery === 0;
  } else if (moving) {
    // Whole steps of the run's slice; a frame a little early or late still takes one.
    run.left += real;
    const most = Math.ceil(CATCH_UP_S / run.dt);
    const steps = Math.min(Math.round(run.left / run.dt), most);
    run.left = steps === most ? 0 : run.left - steps * run.dt;
    const stepping = run;
    for (let i = 0; i < steps; i += 1) {
      if (run !== stepping) break;
      dt += step();
      // A Stage replay watched at the run's own pace stops at its moment as it would fast.
      if (run.player !== null && reachedStop(stepping)) {
        finishReplay(null);
        break;
      }
    }
    redraw = true;
  }
  // A frozen frame stays on the canvas; nothing redraws until something moves.
  const drawing = redraw && run?.compiling !== true;
  if (drawing) {
    look.update();
    look.frame(
      () => {
        draw(dt);
        bridge.overlay();
      },
      { playing: moving && GameState.state === "playing", realMs },
    );
    devView.after(view()?.camera ?? null, realMs, now);
    redraw = false;
  }
  bridge.tick(dt);
  measuredMs = sceneReport.tick(dt, drawing);
  // The run's state on the page, so a game's own CSS can show its screens by it.
  if (document.body.dataset.state !== GameState.state)
    document.body.dataset.state = GameState.state;
  studio.ready = true;
});
