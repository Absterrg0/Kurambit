// The gameplay. The demo shell (shell/shell.js) owns the
// title, pause, settings and end screens and the render loop; this module
// builds one run in start(ctx), moves it in update(dt, ctx) and ends it with
// GameState.win(text, stats) or GameState.lose(text, stats). Retry calls
// start() again on a fresh ctx, so build everything here, not at the top level.
//
// The starter: roam with WASD or the arrow keys and touch the beacon five times.
import * as THREE from "./vendor/three.module.js";
import { GameState } from "./shell/run-state.js";
import { Juice } from "./shell/juice.js";

// The game's run values. Public primitives only: the probe reports them, so
// keep the values that matter on screen too. Each Play and Retry puts them
// back to these, except the names in KEEP_ACROSS_RUNS.
GameState.score = 0;
GameState.moves = 0;
GameState.best_time = 0;
export const KEEP_ACROSS_RUNS = ["best_time"];

const GOAL = 5;
const SPEED = 5;
let rover = null;
let beacon = null;
let elapsed = 0;

export function start(ctx) {
  const { scene, camera } = ctx;
  scene.background = new THREE.Color(0x0b0e14);
  scene.fog = new THREE.Fog(0x0b0e14, 18, 46);

  const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
  sun.position.set(-6, 10, 4);
  scene.add(sun, new THREE.HemisphereLight(0x8fb4ff, 0x1a2418, 0.9));

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x1d3320, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  const grid = new THREE.GridHelper(60, 60, 0x3a5f43, 0x24382a);
  grid.position.y = 0.01;
  scene.add(ground, grid);

  beacon = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.7),
    new THREE.MeshStandardMaterial({
      color: 0xffc94d,
      emissive: 0xff9d2e,
      emissiveIntensity: 1.4,
      roughness: 0.35,
    }),
  );
  beacon.position.set(6, 1.2, -4);
  rover = new THREE.Mesh(
    new THREE.SphereGeometry(0.45, 24, 18),
    new THREE.MeshStandardMaterial({ color: 0x7fd4ff, roughness: 0.4, metalness: 0.1 }),
  );
  rover.position.set(0, 0.45, 3);
  scene.add(beacon, rover);
  ctx.player = rover;
  camera.position.set(0, 7, 12);
  elapsed = 0;
}

export function update(dt, ctx) {
  const { keys, camera, hud } = ctx;
  elapsed += dt;
  let dx = 0;
  let dz = 0;
  if (keys.down("KeyA") || keys.down("ArrowLeft")) dx -= 1;
  if (keys.down("KeyD") || keys.down("ArrowRight")) dx += 1;
  if (keys.down("KeyW") || keys.down("ArrowUp")) dz -= 1;
  if (keys.down("KeyS") || keys.down("ArrowDown")) dz += 1;
  if (dx !== 0 || dz !== 0) {
    const len = Math.hypot(dx, dz);
    rover.position.x = THREE.MathUtils.clamp(rover.position.x + (dx / len) * SPEED * dt, -28, 28);
    rover.position.z = THREE.MathUtils.clamp(rover.position.z + (dz / len) * SPEED * dt, -28, 28);
    GameState.moves += 1;
  }
  beacon.rotation.y += dt * 0.8;
  if (GameState.isPlaying() && rover.position.distanceTo(beacon.position) < 1.2) {
    GameState.score += 1;
    Juice.burst(beacon.position, 0xffc94d, 24);
    Juice.shake(0.25);
    Juice.pop(rover);
    beacon.position.set(THREE.MathUtils.randFloat(-10, 10), 1.2, THREE.MathUtils.randFloat(-12, 4));
    if (GameState.score >= GOAL) {
      const time = Math.round(elapsed);
      GameState.best_time = GameState.best_time === 0 ? time : Math.min(GameState.best_time, time);
      GameState.win("Every beacon found", {
        Beacons: GameState.score,
        Time: `${time} s`,
        Best: `${GameState.best_time} s`,
      });
    }
  }
  camera.position.set(rover.position.x, 7, rover.position.z + 9);
  camera.lookAt(rover.position.x, 0.5, rover.position.z);
  // Write the overlay only when it changes: a DOM write every frame costs layout.
  const text = `beacons ${GameState.score} / ${GOAL}\nWASD or arrows to roam, touch the beacon`;
  if (hud.textContent !== text) hud.textContent = text;
}
