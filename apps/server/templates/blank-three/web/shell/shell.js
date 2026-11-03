// The demo shell around the game: title, pause, settings, end and credits
// screens, the render loop and the studio bridge. The game plugs in at
// ../main.js and never builds these screens itself:
//
//   export function start(ctx) {}   // build the run into ctx.scene; set ctx.camera, ctx.player
//   export function update(dt, ctx) {} // every frame while playing (and the slow end beat)
//   export function stop(ctx) {}     // optional: undo anything start() did outside ctx
//   export function resize(ctx) {}   // optional: every window resize, paused or not
//   export function setState(target, values, ctx) {} // optional studio reach; ctx is null
//                                    // with no run, then return false
//   export const KEEP_ACROSS_RUNS = ["best"]; // GameState values a retry keeps
//   export const ASSETS = { knight: "assets/models/knight.glb" }; // loaded before the title
//
// ctx, fresh each run: renderer, canvas, hud (the game's DOM layer), scene,
// camera, player, assets (model(name) / texture(name), shell/assets.js), keys.down(code) / keys.pressed(code) (KeyboardEvent.code
// such as "KeyW", "ArrowLeft", "Space", or the key itself such as "w"),
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
import { assets, preloadAssets } from "./assets.js";
import {
  VOLUME_NAMES,
  getVolume,
  holdAudio,
  playSfx,
  playTick,
  setVolume,
  unlockAudio,
} from "./audio.js";
import * as game from "../main.js";

/** true boots straight into play, skipping the title (handy while building). `?play` in the URL does the same. */
const BOOT_INTO_PLAY = false;
/** Played on every shell button press; empty plays a short synthesized tick. */
const CLICK_SOUND = "";
const CREDITS_FILE = "./credits.txt";
const SETTINGS_KEY = `settings:${location.pathname}`;
const KEEP = Array.isArray(game.KEEP_ACROSS_RUNS) ? game.KEEP_ACROSS_RUNS : [];
/** Real seconds and time scale of the slow-motion beat before the end screen. */
const END_BEAT_S = 0.6;
const END_BEAT_SCALE = 0.3;
/** The end screen ignores input this long, so a button mashed as the run ends cannot skip it. */
const END_GUARD_S = 0.4;

const byId = (id) => document.getElementById(id);
const canvas = byId("game");
const hud = byId("hud");
const ui = byId("ui");
const backdrop = byId("backdrop");
const screens = {
  loading: byId("loading"),
  title: byId("title"),
  pause: byId("pause"),
  settings: byId("settings"),
  end: byId("end"),
  credits: byId("credits"),
};

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

let run = null;
let openScreen = null;
let settingsFrom = null;
let endBeat = 0;
let ending = null;
let endSerial = 0;
let held = false;
let redraw = true;
let hadPointerLock = false;
// Where the pointer last was on the canvas; a new run starts aiming there.
const pointer = { x: 0, y: 0, ndcX: 0, ndcY: 0 };

function newContext() {
  const down = new Set();
  const pressed = new Set();
  const listeners = [];
  const timers = [];
  const buttons = new Set();
  const clicked = new Set();
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
  };
  return { ctx, down, pressed, buttons, clicked, listeners, timers, reported: false };
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
}

function startRun() {
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
  GameState.state = "playing";
}

function showTitle() {
  clearRun();
  GameState.result = "";
  GameState.result_text = "";
  GameState.state = "title";
  show(screens.title);
  redraw = true;
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
  if (openScreen === screens.settings) closeSettings();
  else if (openScreen === screens.credits) show(screens.title);
  else if (GameState.state === "playing" && pauseKey) pause();
  else if (GameState.state === "paused" && openScreen === screens.pause) resume();
  else return false;
  return true;
}

function saveSettings() {
  const values = {};
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
  actions[control.dataset.action]?.();
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
  if (code === "Escape" || code === "KeyP") {
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
  if (pads === 0) return;
  const pad = [...(navigator.getGamepads?.() ?? [])].find((each) => each != null);
  if (pad === undefined) return;
  const isDown = (i) => pad.buttons[i]?.pressed === true;
  const pressedNow = (i) => isDown(i) && padWas[i] !== true;
  if (pad.buttons.some((_, i) => pressedNow(i))) unlockAudio();
  if (pressedNow(9)) back(true);
  else if (openScreen !== null) {
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
  const due = [];
  for (let i = run.timers.length - 1; i >= 0; i -= 1)
    if ((run.timers[i].left -= dt) <= 0) due.unshift(...run.timers.splice(i, 1));
  try {
    for (const timer of due) timer.fn();
    game.update?.(dt, run.ctx);
    animateShell.update(dt);
    cameraShell.update(dt);
  } catch (error) {
    // One report a run: the loop keeps going so the menus keep working.
    if (!run.reported) reportError(error);
    run.reported = true;
  }
  juiceShell.update(dt);
  clearFrameInput();
}

function draw() {
  if (run === null) {
    renderer.clear();
    return;
  }
  const camera = run.ctx.camera;
  juiceShell.beforeRender(camera);
  renderer.render(run.ctx.scene, camera);
  juiceShell.afterRender(camera);
}

// Every resize, whatever the state: fullscreen is toggled from the pause menu.
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  const aspect = window.innerWidth / window.innerHeight;
  const camera = run?.ctx.camera;
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
  if (run !== null)
    try {
      game.resize?.(run.ctx);
    } catch (error) {
      // Once per run: dragging the window would otherwise flood the errors.
      if (!run.reported) reportError(error);
      run.reported = true;
    }
  redraw = true;
});

const studio = installStudio({
  ui,
  player: () => run?.ctx.player ?? null,
  setState: (target, values) => game.setState?.(target, values, run?.ctx ?? null),
  hold(on) {
    held = on;
    releaseKeys();
    return holdAudio(on);
  },
});

loadSettings();
loadProgress(KEEP);
// Before the loop starts, so studio.ready (the harness's boot signal) waits for the assets too.
if (Object.keys(game.ASSETS ?? {}).length > 0) {
  show(screens.loading);
  const fill = byId("loading-fill");
  await preloadAssets(game.ASSETS, (done, total) => {
    fill.style.width = `${total === 0 ? 100 : (done / total) * 100}%`;
  });
}
if (BOOT_INTO_PLAY || new URLSearchParams(location.search).has("play")) startRun();
else showTitle();

let last = performance.now();
renderer.setAnimationLoop((now) => {
  const real = Math.min(Math.max((now - last) / 1000, 0), 0.1);
  last = now;
  pollGamepad(now);
  // Only unpaused, unheld time moves the run, the end beat included.
  if (run !== null && !held && (GameState.state === "playing" || endBeat > 0)) {
    step(real * juiceShell.timeScale() * (endBeat > 0 ? END_BEAT_SCALE : 1));
    if (endBeat > 0 && (endBeat -= real) <= 0) showEnd();
    redraw = true;
  }
  // A frozen frame stays on the canvas; nothing redraws until something moves.
  if (redraw) {
    draw();
    redraw = false;
  }
  studio.ready = true;
});
