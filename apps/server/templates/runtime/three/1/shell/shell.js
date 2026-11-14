// The demo shell around the game: title, pause, settings, end and credits
// screens, the render loop and the studio bridge. The game plugs in at its
// main.js (the import map's "#main") and never builds these screens itself:
//
//   export function start(ctx) {}   // build the run into ctx.scene; set ctx.camera, ctx.player
//   export function update(dt, ctx) {} // every frame while playing (and the slow end beat)
//   export function stop(ctx) {}     // optional: undo anything start() did outside ctx
//   export function resize(ctx) {}   // optional: every window resize, paused or not
//   export function setState(target, values, ctx) {} // optional studio reach; ctx is null
//                                    // with no run, then return false
//   export const KEEP_ACROSS_RUNS = ["best"]; // GameState values a retry keeps
//   export const ASSETS = { knight: "assets/models/knight.glb" }; // loaded before the title
//   export const LOOK = { preset: "golden" }; // the light, sky, fog and post chain (shell/look.js)
//   export const CLICK_SOUND = "assets/sfx/click.ogg"; // optional: the menu button sound
//                                    // (default: a short synthesized tick)
//   export async function prepare({ renderer, assets, look, progress }) {} // optional: behind the
//                                    // loading bar, once (build a big world, bake, compile);
//                                    // progress(0..1) fills the bar
//   export function render(ctx, dt) {} // optional: draw the frame yourself (your own chain);
//                                    // ctx.look.render(scene, camera) draws through the look
//   export function title(dt, ctx) {} // optional: a live title; ctx (scene, camera, renderer,
//                                    // assets, look) lasts across visits; drawn every frame
//                                    // the title is up
//
// ctx, fresh each run: renderer, canvas, hud (the game's DOM layer), scene,
// camera, player, ui (the HUD kit: counter, bar, timer, objective, toast,
// hint; shell/hud.js), look (sun(), bake(), render(); shell/look.js), assets (model(name) / texture(name), shell/assets.js),
// input (named actions from keys, mouse and gamepad, which
// the player can rebind: input.down("jump"), input.pressed("action"),
// input.vector(); the table and the calls are in shell/controls.js), keys
// (raw keys, kept for older games: keys.down("KeyW"), keys.pressed("Space")),
// thing(object, { name, kind }) and tune(id, defaults, ranges) for the Stage
// (selecting things and tuning their values live; shell/stage-bridge.js),
// mouse (x, y in canvas pixels, ndc.x / ndc.y from -1 to 1 for a Raycaster,
// movement.x / movement.y this frame, also under pointer lock, and
// down(button) / pressed(button), 0 the left button), listen(target, type,
// fn) and after(seconds, fn). Keys and mouse see only gameplay input: a click
// on a menu never reaches them, and pause releases them. Listeners and timers
// made through ctx fire only while playing (timers also through the slow end
// beat) and go away with the run; the scene and the hud are emptied before
// the next one. The shell refits ctx.camera, perspective or orthographic, on
// resize.
//
// A run ends with GameState.win(text, stats) or GameState.lose(text, stats).
// The shell owns the loop: gameplay stops while paused or ended, the menus keep
// working, and Retry builds the run fresh. Pause is Esc or P (gamepad Start).
// Restyle the screens in index.html and style.css.
import * as THREE from "../vendor/three.module.js";
import { installStudio } from "./studio.js";
import { createStageBridge, loadTuning } from "./stage-bridge.js";
import { createSceneReport } from "./scene-report.js";
import {
  GameState,
  hasProgress,
  loadProgress,
  newRun,
  onRunEnded,
  resetProgress,
} from "./run-state.js";
import { Juice, juiceShell } from "./juice.js";
import { animateShell } from "./animate.js";
import { cameraShell } from "./camera.js";
import { createLook } from "./look.js";
import { createHud } from "./hud.js";
import { assets, onModelCopy, preloadAssets } from "./assets.js";
import { createControls, createInput } from "./controls.js";
import {
  VOLUME_NAMES,
  getVolume,
  holdAudio,
  playSfx,
  playTick,
  setVolume,
  unlockAudio,
  muteAudio,
} from "./audio.js";
import * as game from "#main";

/** Played on every shell button press (main.js's CLICK_SOUND); empty plays a short synthesized tick. */
const CLICK_SOUND = typeof game.CLICK_SOUND === "string" ? game.CLICK_SOUND : "";
const CREDITS_FILE = "./credits.txt";
const SETTINGS_KEY = `settings:${location.pathname}`;
const KEEP = Array.isArray(game.KEEP_ACROSS_RUNS) ? game.KEEP_ACROSS_RUNS : [];
const controls = createControls(game.ACTIONS);
/** Real seconds and time scale of the slow-motion beat before the end screen. */
const END_BEAT_S = 0.6;
const END_BEAT_SCALE = 0.3;
/** The end screen ignores input this long, so a button mashed as the run ends cannot skip it. */
const END_GUARD_S = 0.4;

const byId = (id) => document.getElementById(id);
const canvas = byId("game");
const hud = byId("hud");
// ctx.ui's own layer: a game writing raw text into ctx.hud cannot wipe it.
const hudKit = byId("hud-kit");
const ui = byId("ui");
const backdrop = byId("backdrop");
const screens = {
  loading: byId("loading"),
  title: byId("title"),
  pause: byId("pause"),
  settings: byId("settings"),
  end: byId("end"),
  credits: byId("credits"),
  controls: byId("controls"),
};

// The look makes the renderer: MSAA only where no post chain runs over it.
const look = await createLook(canvas, game.LOOK);
const { renderer } = look;

let run = null;
/** A live title's lasting scene (the game's title(dt, ctx)), or null. */
let titleCtx = null;
/**
 * The title's backdrop when the game has neither title(dt, ctx) nor title art of its own: its first
 * run's world, built behind the menu, held at its start and orbited slowly, so a game opens on
 * itself rather than on a dark card. Never moved by input; Play builds the real run fresh.
 */
let titleWorld = null;
// A backdrop the game set (style.css's --title-art) keeps the menu on it, as the game chose. Read
// from the style, not fetched: a probe for art the game never made is a 404 the check reports.
const ownTitleArt =
  getComputedStyle(document.documentElement).getPropertyValue("--title-art").trim() !== "";
{
  // While the world is the backdrop: the menu over it through a soft shade, and no HUD (it is play's).
  const style = document.createElement("style");
  style.textContent = `body[data-title-world] #backdrop{background:radial-gradient(ellipse 60% 55% at 50% 45%,rgb(0 0 0/.2),rgb(0 0 0/.62))!important}
body[data-title-world] #hud,body[data-title-world] #hud-kit,body[data-title-world] #flash{visibility:hidden}`;
  document.head.append(style);
}
let openScreen = null;
let settingsFrom = null;
let endBeat = 0;
let ending = null;
let endSerial = 0;
let held = false;
// Play holds while the Stage's tab is hidden or the Stage has frozen it.
let hidden = false;
let frozen = false;
let redraw = true;
let hadPointerLock = false;
/** The action whose key the Controls screen is waiting for, or null. */
let listening = null;
/** The first connected gamepad this frame, or null. */
let gamepad = null;
// Where the pointer last was on the canvas; a new run starts aiming there.
const pointer = { x: 0, y: 0, ndcX: 0, ndcY: 0 };

function newContext() {
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
    hud,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500),
    /** The models and textures main.js lists in ASSETS, loaded before the title (shell/assets.js). */
    assets,
    /** The player object (an Object3D or {x, y, z}); the studio probe reports its position. */
    player: null,
    input: input.api,
    /** HUD widgets by name (shell/hud.js); call them every frame from update(). */
    ui: createHud(hudKit, input.api),
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
        if (GameState.state === "playing") fn(event);
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
  };
  ctx.look = look.forRun(ctx);
  return { ctx, input, down, pressed, buttons, clicked, listeners, timers, reported: false };
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

function clearRun() {
  endSerial += 1;
  endBeat = 0;
  ending = null;
  juiceShell.reset();
  animateShell.reset();
  cameraShell.reset();
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
  hud.replaceChildren();
  hudKit.replaceChildren();
}

function startRun() {
  closeTitleWorld();
  clearRun();
  GameState.state = "playing";
  show(null);
  run = newContext();
  Juice.stage = run.ctx.scene;
  redraw = true;
  // A throw here is reported like one in update(), so the loop still starts,
  // the menus keep working and the check sees the error itself.
  try {
    newRun(KEEP);
    game.start?.(run.ctx);
  } catch (error) {
    reportError(error);
    run.reported = true;
  }
  // The run's own programs compile before its first frame, so play never opens on a stall.
  const started = run;
  started.compiling = true;
  look.compile(started.ctx.scene, started.ctx.camera).then(() => (started.compiling = false));
}

function pause() {
  if (GameState.state !== "playing") return;
  GameState.state = "paused";
  releaseKeys();
  juiceShell.endHitPause();
  if (document.pointerLockElement !== null) document.exitPointerLock?.();
  show(screens.pause);
}

function resume() {
  if (GameState.state !== "paused") return;
  show(null);
  run?.input.settle();
  GameState.state = "playing";
}

function showTitle() {
  clearRun();
  GameState.result = "";
  GameState.result_text = "";
  GameState.state = "title";
  openTitleWorld();
  show(screens.title);
  redraw = true;
}

const TITLE_ORBIT = 0.06; // radians a second: a slow drift, never a spin

function openTitleWorld() {
  if (game.title !== undefined || game.start === undefined || ownTitleArt || titleWorld !== null)
    return;
  const world = newContext();
  Juice.stage = world.ctx.scene;
  try {
    newRun(KEEP);
    game.start(world.ctx);
  } catch {
    // A start that fails here fails in play too, where the check reports it: the plain title stays.
    disposeTitleWorld(world);
    return;
  }
  GameState.state = "title";
  // Framed as the game frames itself: around its player (or what it built), from where its own
  // camera stands, so the drift shows the world the way play will.
  const scene = world.ctx.scene;
  const target = new THREE.Vector3();
  const player = world.ctx.player;
  if (player?.isObject3D === true) player.getWorldPosition(target);
  else if (player != null && Number.isFinite(player.x))
    target.set(player.x, player.y ?? 0, player.z);
  else new THREE.Box3().setFromObject(scene).getCenter(target);
  const camera = world.ctx.camera;
  const offset = camera.position.clone().sub(target);
  const flat = Math.hypot(offset.x, offset.z);
  world.title = {
    target: target.add(new THREE.Vector3(0, 0.6, 0)),
    radius: flat < 1 ? 9 : Math.min(40, Math.max(4, flat)),
    // A little lower than play's view, so the title shows the world toward its horizon.
    height: offset.length() < 1 ? 4 : Math.min(30, Math.max(1.5, offset.y * 0.65)),
    angle: flat < 1 ? 0.6 : Math.atan2(offset.x, offset.z),
    updating: typeof game.update === "function",
  };
  titleWorld = world;
  document.body.dataset.titleWorld = "";
  world.compiling = true;
  look.compile(scene, camera).then(() => (world.compiling = false));
  placeTitleCamera(0);
}

function placeTitleCamera(dt) {
  const { ctx, title } = titleWorld;
  title.angle += dt * TITLE_ORBIT;
  ctx.camera.position.set(
    title.target.x + Math.sin(title.angle) * title.radius,
    title.target.y + title.height,
    title.target.z + Math.cos(title.angle) * title.radius,
  );
  ctx.camera.lookAt(title.target);
}

/** One held frame of the title world: the game's update with no time passing, so its characters
 * take the poses play gives them, then their clips and the drift advance on real time. */
function stepTitleWorld(real) {
  const world = titleWorld;
  if (world.title.updating)
    try {
      game.update(0, world.ctx);
    } catch {
      world.title.updating = false;
    }
  try {
    animateShell.update(real);
  } catch {
    // An animation the title cannot play leaves the pose as it is.
  }
  clearTitleInput(world);
  placeTitleCamera(real);
}

function clearTitleInput(world) {
  world.pressed.clear();
  world.clicked.clear();
  world.down.clear();
}

function closeTitleWorld() {
  if (titleWorld === null) return;
  const world = titleWorld;
  titleWorld = null;
  delete document.body.dataset.titleWorld;
  disposeTitleWorld(world);
}

function disposeTitleWorld(world) {
  for (const remove of world.listeners) remove();
  try {
    game.stop?.(world.ctx);
  } catch {
    // Its stop belongs to play; the world is let go either way.
  }
  dispose(world.ctx.scene);
  juiceShell.reset();
  animateShell.reset();
  cameraShell.reset();
  look.reset();
  bridge.reset();
  Juice.stage = null;
  hud.replaceChildren();
  hudKit.replaceChildren();
}

onRunEnded((won, text, stats) => {
  if (run === null) return;
  releaseKeys();
  ending = { won, text, stats };
  endBeat = END_BEAT_S;
});

function showEnd() {
  endBeat = 0;
  const serial = endSerial;
  const { won, text, stats } = ending ?? { won: false, text: "", stats: {} };
  const heading = byId("end-heading");
  heading.textContent = text;
  screens.end.dataset.result = won ? "won" : "lost";
  const list = byId("end-stats");
  list.replaceChildren();
  for (const [name, value] of Object.entries(stats ?? {})) {
    const row = document.createElement("div");
    row.className = "stat";
    const term = document.createElement("dt");
    term.textContent = name;
    const detail = document.createElement("dd");
    detail.textContent = String(value);
    row.append(term, detail);
    list.append(row);
  }
  list.hidden = list.childElementCount === 0;
  const buttons = screens.end.querySelectorAll("button");
  for (const button of buttons) button.disabled = true;
  show(screens.end);
  setTimeout(() => {
    if (serial !== endSerial || openScreen !== screens.end) return;
    for (const button of buttons) button.disabled = false;
    focusFirst(screens.end);
  }, END_GUARD_S * 1000);
}

function show(screen) {
  openScreen = screen;
  if (screen !== screens.controls) listening = null;
  for (const each of Object.values(screens)) each.hidden = each !== screen;
  // Settings and credits opened from the title keep its backdrop behind them.
  backdrop.hidden = !(GameState.state === "title" && screen !== null);
  document.body.dataset.screen = screen?.id ?? "play";
  if (screen === null) document.activeElement?.blur?.();
  else {
    if (document.pointerLockElement != null) document.exitPointerLock?.();
    focusFirst(screen);
  }
}

function focusables(screen) {
  return [...screen.querySelectorAll("button, input")].filter(
    (control) => !control.disabled && control.offsetParent !== null,
  );
}

function focusFirst(screen) {
  focusables(screen)[0]?.focus({ preventScroll: true });
}

function moveFocus(by) {
  const list = focusables(openScreen);
  if (list.length === 0) return;
  const at = list.indexOf(document.activeElement);
  const next = at < 0 ? 0 : (at + by + list.length) % list.length;
  list[next].focus({ preventScroll: true });
  // A long Controls list scrolls inside its card; the selection stays in view.
  list[next].scrollIntoView({ block: "nearest" });
}

function nudgeSlider(by) {
  const slider = document.activeElement;
  if (!(slider instanceof HTMLInputElement) || slider.type !== "range") return;
  if (by > 0) slider.stepUp();
  else slider.stepDown();
  slider.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Esc, P, gamepad B and Start. Returns whether the press was used. */
function back(pauseKey) {
  if (listening !== null) stopListening("Not changed");
  else if (openScreen === screens.controls) show(screens.settings);
  else if (openScreen === screens.settings) closeSettings();
  else if (openScreen === screens.credits) show(screens.title);
  else if (GameState.state === "playing" && pauseKey) pause();
  else if (GameState.state === "paused" && openScreen === screens.pause) resume();
  else return false;
  return true;
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
  for (const slider of screens.settings.querySelectorAll("input[data-volume]")) {
    slider.value = String(Math.round(getVolume(slider.dataset.volume) * 100));
    showVolume(slider);
  }
}

function showVolume(slider) {
  const label = screens.settings.querySelector(`[data-volume-value="${slider.dataset.volume}"]`);
  if (label !== null) label.textContent = `${slider.value}%`;
}

// A browser grants fullscreen only from a press, never at load, so there is no
// saved fullscreen to restore; the toggle shows the document's real state.
function syncFullscreen() {
  const toggle = byId("fullscreen");
  const on = document.fullscreenElement != null;
  toggle.setAttribute("aria-pressed", String(on));
  toggle.disabled = document.fullscreenEnabled === false;
  toggle.querySelector(".toggle-state").textContent = toggle.disabled ? "N/A" : on ? "On" : "Off";
}

function toggleFullscreen() {
  if (document.fullscreenElement != null) document.exitFullscreen?.().catch(() => undefined);
  else document.documentElement.requestFullscreen?.().catch(() => undefined);
}

function openSettings() {
  settingsFrom = openScreen;
  syncFullscreen();
  const reset = byId("reset-progress");
  reset.hidden = !hasProgress();
  reset.disabled = false;
  reset.textContent = "Reset progress";
  show(screens.settings);
}

function closeSettings() {
  saveSettings();
  show(settingsFrom ?? screens.title);
}

function openCredits() {
  const text = byId("credits-text");
  show(screens.credits);
  fetch(CREDITS_FILE)
    .then((response) => (response.ok ? response.text() : ""))
    .catch(() => "")
    .then((file) => {
      const lines = file
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => !line.startsWith("#"));
      text.textContent = lines.join("\n").trim() || "Made with three.js";
    });
}

// The Controls screen: one row per action with its keys (a button: select it,
// press a key) and its gamepad inputs, as plain text a tester can read.
function renderControls() {
  const list = byId("controls-list");
  const rows = [];
  for (const action of controls.actions.values()) {
    const { keyboard, gamepad: pad } = controls.describe(action);
    const name = document.createElement("span");
    name.textContent = action.label;
    const keys = document.createElement("button");
    keys.type = "button";
    keys.dataset.action = "rebind";
    keys.dataset.bind = action.name;
    keys.disabled = action.fixed;
    keys.textContent = listening === action.name ? "Press a key" : keyboard || "None";
    const padText = document.createElement("span");
    padText.textContent = pad || "None";
    rows.push(name, keys, padText);
  }
  list.replaceChildren(...rows);
}

function openControls() {
  byId("controls-note").textContent = "Select a key binding, then press the new key";
  renderControls();
  show(screens.controls);
}

function startListening(control) {
  listening = control.dataset.bind;
  byId("controls-note").textContent = "Press a key for it · Esc cancels";
  renderControls();
  screens.controls.querySelector(`[data-bind="${listening}"]`)?.focus({ preventScroll: true });
}

function stopListening(note) {
  const name = listening;
  listening = null;
  byId("controls-note").textContent = note;
  renderControls();
  screens.controls.querySelector(`[data-bind="${name}"]`)?.focus({ preventScroll: true });
}

function rebind(code) {
  const note = controls.rebind(listening, code);
  stopListening(note);
  saveSettings();
}

function resetControls() {
  controls.reset();
  saveSettings();
  byId("controls-note").textContent = "Controls reset to defaults";
  renderControls();
}

const actions = {
  play: startRun,
  retry: startRun,
  resume,
  menu: showTitle,
  settings: openSettings,
  credits: openCredits,
  back: () => back(false),
  fullscreen: toggleFullscreen,
  "reset-progress": confirmResetProgress,
  controls: openControls,
  rebind: startListening,
  "reset-controls": resetControls,
};

// Two presses, so a stray click cannot wipe a best score.
function confirmResetProgress() {
  const reset = byId("reset-progress");
  if (reset.textContent !== "Press again to reset") {
    reset.textContent = "Press again to reset";
    return;
  }
  resetProgress();
  reset.textContent = "Progress reset";
  reset.disabled = true;
}

ui.addEventListener("click", (event) => {
  const control = event.target.closest("[data-action]");
  if (control === null || control.disabled || !openScreen?.contains(control)) return;
  if (CLICK_SOUND === "") playTick();
  else playSfx(CLICK_SOUND, { volume: 0.6, pitch: 0.03 });
  if (listening !== null) stopListening("Not changed");
  actions[control.dataset.action]?.(control);
});

ui.addEventListener("input", (event) => {
  const slider = event.target;
  if (!(slider instanceof HTMLInputElement) || slider.dataset.volume === undefined) return;
  setVolume(slider.dataset.volume, Number(slider.value) / 100);
  showVolume(slider);
  saveSettings();
});

// The pointer and the keys move one selection, so a menu never shows two.
// Only a real move counts: a screen opening under a still mouse keeps its focus.
window.addEventListener("pointermove", (event) => {
  if (event.movementX === 0 && event.movementY === 0) return;
  document.documentElement.dataset.input = "pointer";
  const control = event.target.closest?.("button, input");
  if (
    control != null &&
    !control.disabled &&
    openScreen?.contains(control) &&
    control !== document.activeElement
  )
    control.focus({ preventScroll: true });
});

window.addEventListener("keydown", (event) => {
  document.documentElement.dataset.input = "keys";
  const code = event.code;
  if (listening !== null) {
    event.preventDefault();
    if (event.repeat) return;
    if (code === "Escape") stopListening("Not changed");
    else rebind(code);
    return;
  }
  if (code === "Escape" || controls.keysOf("pause").includes(code)) {
    if (!event.repeat && back(true)) event.preventDefault();
    return;
  }
  if (openScreen !== null) {
    const onSlider = document.activeElement?.type === "range";
    if (code === "ArrowUp" || code === "ArrowDown") {
      moveFocus(code === "ArrowUp" ? -1 : 1);
      event.preventDefault();
    } else if ((code === "ArrowLeft" || code === "ArrowRight") && !onSlider) {
      // A slider takes left and right itself; elsewhere they move like up and down.
      moveFocus(code === "ArrowLeft" ? -1 : 1);
      event.preventDefault();
    } else if (
      (code === "Enter" || code === "Space") &&
      !openScreen.contains(document.activeElement)
    ) {
      focusables(openScreen)[0]?.click();
      event.preventDefault();
    }
    return;
  }
  if (GameState.state !== "playing" || run === null) return;
  for (const name of keyNames(event)) {
    if (!event.repeat) run.pressed.add(name);
    run.down.add(name);
  }
  if (code.startsWith("Arrow") || code === "Space") event.preventDefault();
});

window.addEventListener("keyup", (event) => {
  for (const name of keyNames(event)) run?.down.delete(name);
});
window.addEventListener("blur", releaseKeys);

// Gameplay mouse input: only presses on the canvas (or anywhere under pointer
// lock) during play, so the click that closes a menu never fires a shot.
const gameplayPointer = (event) =>
  run !== null &&
  GameState.state === "playing" &&
  openScreen === null &&
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
// Exported web builds pause when their tab is hidden. The studio stage hides
// with CSS, which leaves the page visible, so its own hold is unaffected.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") pause();
});

document.addEventListener("fullscreenchange", syncFullscreen);
document.addEventListener("pointerlockchange", () => {
  // Esc releases a pointer lock before the page sees the key, so losing the
  // lock mid-run is the pause press.
  if (document.pointerLockElement === null && hadPointerLock) pause();
  hadPointerLock = document.pointerLockElement !== null;
});

let pads = 0;
const padWas = [];
let padRepeatAt = 0;
window.addEventListener("gamepadconnected", () => (pads += 1));
window.addEventListener("gamepaddisconnected", () => (pads = Math.max(0, pads - 1)));

function pollGamepad(now) {
  gamepad = null;
  if (pads === 0) return;
  const pad = [...(navigator.getGamepads?.() ?? [])].find((each) => each != null);
  if (pad === undefined) return;
  gamepad = pad;
  const isDown = (i) => pad.buttons[i]?.pressed === true;
  const pressedNow = (i) => isDown(i) && padWas[i] !== true;
  if (pad.buttons.some((_, i) => pressedNow(i))) unlockAudio();
  if (pressedNow(9)) back(true);
  else if (listening !== null) {
    if (pressedNow(1)) back(false);
  } else if (openScreen !== null) {
    if (pressedNow(1)) back(false);
    else if (pressedNow(0) && openScreen.contains(document.activeElement))
      document.activeElement.click();
    const y = (isDown(13) ? 1 : 0) - (isDown(12) ? 1 : 0) || Math.round(pad.axes[1] ?? 0);
    const x = (isDown(15) ? 1 : 0) - (isDown(14) ? 1 : 0) || Math.round(pad.axes[0] ?? 0);
    if ((x !== 0 || y !== 0) && now >= padRepeatAt) {
      if (y !== 0) moveFocus(y);
      else if (document.activeElement?.type === "range") nudgeSlider(x);
      else moveFocus(x);
      padRepeatAt = now + (padRepeatAt === 0 ? 350 : 140);
    } else if (x === 0 && y === 0) padRepeatAt = 0;
  }
  pad.buttons.forEach((button, i) => (padWas[i] = button.pressed));
}

function step(dt) {
  const { down, pressed, buttons, clicked } = run;
  run.input.sample({ down, pressed, buttons, clicked, pad: gamepad });
  const due = [];
  for (let i = run.timers.length - 1; i >= 0; i -= 1)
    if ((run.timers[i].left -= dt) <= 0) due.unshift(...run.timers.splice(i, 1));
  try {
    for (const timer of due) timer.fn();
    game.update?.(dt, run.ctx);
    animateShell.update(dt);
    cameraShell.update(dt);
    run.ctx.ui.update(dt);
  } catch (error) {
    // One report a run: the loop keeps going so the menus keep working.
    if (!run.reported) reportError(error);
    run.reported = true;
  }
  juiceShell.update(dt);
  clearFrameInput();
}

function draw(dt) {
  if (run === null) {
    if (titleCtx !== null) look.render(titleCtx.scene, titleCtx.camera, dt);
    else if (titleWorld !== null) look.render(titleWorld.ctx.scene, titleWorld.ctx.camera, dt);
    else renderer.clear();
    return;
  }
  const camera = run.ctx.camera;
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
}

// Every resize, whatever the state: fullscreen is toggled from the pause menu.
function onResize() {
  look.resize(window.innerWidth, window.innerHeight);
  const aspect = window.innerWidth / window.innerHeight;
  for (const camera of [run?.ctx.camera, titleCtx?.camera, titleWorld?.ctx.camera])
    fit(camera, aspect);
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
  held = hidden || frozen;
  releaseKeys();
  return holdAudio(held);
}

// One object, refilled: the bridge's trace reads it 30 times a second. A game with no title of
// its own opens on its world, whose things the Stage selects and tunes as in play.
const stageView = { scene: null, camera: null };
const view = () => {
  const shown = run?.ctx ?? titleWorld?.ctx ?? titleCtx;
  if (shown?.camera?.isCamera !== true) return null;
  stageView.scene = shown.scene;
  stageView.camera = shown.camera;
  return stageView;
};
// The Stage's slow motion: play time runs at this share of real time.
let studioSpeed = 1;
const bridge = createStageBridge({
  canvas,
  renderer,
  view,
  freeze(on) {
    frozen = on;
    // The pointer is the Stage's while frozen; giving up the lock is not the pause press.
    if (on && document.pointerLockElement != null) {
      hadPointerLock = false;
      document.exitPointerLock?.();
    }
    applyHold();
  },
  redraw: () => (redraw = true),
  speed(scale) {
    studioSpeed = scale;
  },
  mute: muteAudio,
  drawClean() {
    if (run?.compiling === true) return;
    look.update();
    draw(0);
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

const studio = installStudio({
  ui,
  perf: () => look.stats(),
  player: () => run?.ctx.player ?? null,
  setState: (target, values) => game.setState?.(target, values, run?.ctx ?? null),
  hold(on) {
    hidden = on;
    return applyHold();
  },
  bridge,
  scene: sceneReport,
});

loadSettings();
loadProgress(KEEP);
await loadTuning();
// Before the loop starts, so studio.ready (the harness's boot signal) waits for the assets,
// the game's own prepare and the shader warm-up too.
const assetCount = Object.keys(game.ASSETS ?? {}).length;
if (assetCount > 0 || game.prepare !== undefined) {
  show(screens.loading);
  const fill = byId("loading-fill");
  // The assets fill the bar, or its first half when the game prepares after them.
  const share = game.prepare === undefined ? 1 : assetCount > 0 ? 0.5 : 0;
  const bar = (k) => (fill.style.width = `${Math.round(Math.min(Math.max(k, 0), 1) * 100)}%`);
  if (assetCount > 0)
    await preloadAssets(game.ASSETS, (done, total) =>
      bar(total === 0 ? share : (done / total) * share),
    );
  if (game.prepare !== undefined)
    try {
      await game.prepare({
        renderer,
        assets,
        look: { bake: look.bake, render: look.render, settings: look.settings },
        progress: (k) => bar(share + Math.min(Math.max(Number(k) || 0, 0), 1) * (1 - share)),
      });
    } catch (error) {
      reportError(error);
    }
}
// Every program the frame needs (the look's chain, the models lit as a run is) compiles
// behind the loading screen, never on the first frame of play.
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
if (game.title !== undefined) {
  titleCtx = {
    renderer,
    assets,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500),
    player: null,
  };
  titleCtx.look = look.forRun(titleCtx);
}
// `?play` boots straight into play, skipping the title (handy while building).
// The Stage reloads a live game with #kurambit-play once the person has
// played it, so a save lands them back in play, as pressing Play would.
if (new URLSearchParams(location.search).has("play") || location.hash.includes("kurambit-play"))
  startRun();
else showTitle();

let last = performance.now();
let titleError = false;
// The scene report's last sample, which ran after the previous draw: the measuring's own time
// stays out of the frame times the performance fact and the render scale judge the game by.
let measuredMs = 0;
renderer.setAnimationLoop((now) => {
  const elapsedMs = Math.max(now - last, 0);
  const realMs = Math.max(elapsedMs - measuredMs, 0);
  measuredMs = 0;
  const real = Math.min(elapsedMs / 1000, 0.1);
  last = now;
  pollGamepad(now);
  // Only unpaused, unheld time moves the run, the end beat included.
  const moving =
    run !== null && !run.compiling && !held && (GameState.state === "playing" || endBeat > 0);
  let dt = 0;
  if (moving) {
    dt = real * studioSpeed * juiceShell.timeScale() * (endBeat > 0 ? END_BEAT_SCALE : 1);
    step(dt);
    if (endBeat > 0 && (endBeat -= real) <= 0) showEnd();
    redraw = true;
  } else if (run === null && titleWorld !== null && !held && !document.hidden) {
    dt = real;
    stepTitleWorld(real);
    redraw = titleWorld.compiling !== true;
  } else if (run === null && titleCtx !== null && !held && !document.hidden) {
    dt = real;
    try {
      game.title(real, titleCtx);
    } catch (error) {
      if (!titleError) reportError(error);
      titleError = true;
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
    redraw = false;
  }
  bridge.tick(dt);
  measuredMs = sceneReport.tick(dt, drawing);
  studio.ready = true;
});
