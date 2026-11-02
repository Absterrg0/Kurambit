// {{GAME_NAME}} — blank three.js starter. Move the rover with WASD or the
// arrow keys. Keep GameState as the single source of truth and the
// window.__studio probe read-only: bots and the harness read the game through
// it, never through internals.
import * as THREE from "./vendor/three.module.js";

const canvas = document.getElementById("game");
const hud = document.getElementById("hud");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);
scene.fog = new THREE.Fog(0x0b0e14, 18, 46);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);

const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
sun.position.set(-6, 10, 4);
scene.add(sun);
scene.add(new THREE.HemisphereLight(0x8fb4ff, 0x1a2418, 0.9));

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({ color: 0x1d3320, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const grid = new THREE.GridHelper(60, 60, 0x3a5f43, 0x24382a);
grid.position.y = 0.01;
scene.add(grid);

const beacon = new THREE.Mesh(
  new THREE.OctahedronGeometry(0.7),
  new THREE.MeshStandardMaterial({
    color: 0xffc94d,
    emissive: 0xff9d2e,
    emissiveIntensity: 1.4,
    roughness: 0.35,
  }),
);
beacon.position.set(6, 1.2, -4);
scene.add(beacon);

const rover = new THREE.Mesh(
  new THREE.SphereGeometry(0.45, 24, 18),
  new THREE.MeshStandardMaterial({ color: 0x7fd4ff, roughness: 0.4, metalness: 0.1 }),
);
rover.position.set(0, 0.45, 3);
scene.add(rover);

// The game's run state. Public primitives only: the probe reports these, so
// keep the values that matter on screen too.
const GameState = {
  state: "play",
  moves: 0,
  score: 0,
};

const keys = new Set();
window.addEventListener("keydown", (event) => {
  if (event.key.length === 1) keys.add(event.key.toLowerCase());
  else keys.add(event.key);
});
window.addEventListener("keyup", (event) => {
  if (event.key.length === 1) keys.delete(event.key.toLowerCase());
  else keys.delete(event.key);
});
window.addEventListener("blur", () => keys.clear());

const speed = 5;
let lastMoveCount = 0;

function step(dt) {
  let dx = 0;
  let dz = 0;
  if (keys.has("a") || keys.has("ArrowLeft")) dx -= 1;
  if (keys.has("d") || keys.has("ArrowRight")) dx += 1;
  if (keys.has("w") || keys.has("ArrowUp")) dz -= 1;
  if (keys.has("s") || keys.has("ArrowDown")) dz += 1;
  if (dx !== 0 || dz !== 0) {
    const len = Math.hypot(dx, dz);
    rover.position.x = THREE.MathUtils.clamp(rover.position.x + (dx / len) * speed * dt, -28, 28);
    rover.position.z = THREE.MathUtils.clamp(rover.position.z + (dz / len) * speed * dt, -28, 28);
    GameState.moves += 1;
  }
  beacon.rotation.y += dt * 0.8;
  // Touch the beacon to score, then it hops somewhere else.
  if (rover.position.distanceTo(beacon.position) < 1.2) {
    GameState.score += 1;
    beacon.position.set(THREE.MathUtils.randFloat(-10, 10), 1.2, THREE.MathUtils.randFloat(-12, 4));
  }
  camera.position.set(rover.position.x, 7, rover.position.z + 9);
  camera.lookAt(rover.position.x, 0.5, rover.position.z);
  if (hud !== null && GameState.moves !== lastMoveCount) {
    lastMoveCount = GameState.moves;
    hud.textContent = `{{GAME_NAME}}\nscore ${GameState.score} · moves ${GameState.moves}\nWASD or arrows to roam, touch the beacon`;
  }
}

// Read-only studio bridge. Bots and the harness read getState(), reach late
// content through setState() when the game implements a target, and find
// page errors in errors[]. Nothing here writes to the game except setState.
const studioErrors = [];
window.addEventListener("error", (event) => {
  if (studioErrors.length < 50)
    studioErrors.push({
      message: String(event.message ?? "unknown error").slice(0, 500),
      stack: String(event.error?.stack ?? "").slice(0, 500),
      t: performance.now() / 1000,
    });
});
window.addEventListener("unhandledrejection", (event) => {
  if (studioErrors.length < 50)
    studioErrors.push({
      message: String(event.reason?.message ?? event.reason ?? "unhandled rejection").slice(0, 500),
      stack: String(event.reason?.stack ?? "").slice(0, 500),
      t: performance.now() / 1000,
    });
});

let paused = false;
let muted = false;
window.addEventListener("message", (event) => {
  if (event.data?.type !== "studio-visibility") return;
  paused = event.data.visible === false;
  // This starter has no audio; a game with sound suspends it here and reports muted.
  const ack = { type: "studio-visibility-ack", visible: !paused, paused, muted: true };
  event.source?.postMessage?.(ack, "*");
  window.__studioVisibilityAck = ack;
});

window.__studio = {
  engine: "three",
  version: 1,
  ready: false,
  errors: studioErrors,
  getState() {
    const gameState = {};
    for (const [key, value] of Object.entries(GameState)) {
      if (Object.keys(gameState).length >= 64 || key.length > 64) break;
      if (typeof value === "number" && Number.isFinite(value)) gameState[key] = value;
      else if (typeof value === "boolean") gameState[key] = value;
      else if (typeof value === "string") gameState[key] = value.slice(0, 256);
    }
    return {
      gameState,
      player: { x: rover.position.x, y: rover.position.y, z: rover.position.z },
      hudText: typeof hud?.textContent === "string" ? hud.textContent.slice(0, 2000) : "",
    };
  },
  // Named reaches the harness may use to start late content. The starter has
  // no targets and refuses; a game with menus or levels implements its own
  // (every call is reported, and verdicts still come from real input after).
  setState(_target, _values) {
    return false;
  },
};

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

hud.textContent = `{{GAME_NAME}}\nscore 0 · moves 0\nWASD or arrows to roam, touch the beacon`;
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  if (!paused) step(Math.min(clock.getDelta(), 0.1));
  renderer.render(scene, camera);
  window.__studio.ready = true;
});
