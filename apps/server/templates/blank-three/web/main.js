// The gameplay. The demo shell (shell/shell.js) owns the
// title, pause, settings and end screens and the render loop; this module
// builds one run in start(ctx), moves it in update(dt, ctx) and ends it with
// GameState.win(text, stats) or GameState.lose(text, stats). Retry calls
// start() again on a fresh ctx, so build everything here, not at the top level.
//
// The starter: roam (move_*), dash, and touch the beacon five times before
// the clock runs out. It reads named actions through ctx.input, never raw
// keys, so the player's rebinding on the Controls screen reaches it.
import * as THREE from "./vendor/three.module.js";
import { GameState } from "./shell/run-state.js";
import { Juice } from "./shell/juice.js";

// The game's run values. Public primitives only: the probe reports them, so
// keep the values that matter on screen too. Each Play and Retry puts them
// back to these, except the names in KEEP_ACROSS_RUNS.
GameState.score = 0;
GameState.moves = 0;
GameState.time_left = 0;
// The goal's position, so a tester can steer to it. Expose one or two targets
// like this, never every entity: the probe keeps a bounded number of values.
GameState.beacon_x = 0;
GameState.beacon_z = 0;
GameState.best_time = 0;
export const KEEP_ACROSS_RUNS = ["best_time"];
// The shell's default actions (shell/controls.js) plus a dash, minus the ones
// this game never reads, so the Controls screen lists only controls that work.
export const ACTIONS = {
  dash: { keys: ["Space", "ShiftLeft"], pad: ["a", "rb"], mouse: [0] },
  jump: null,
  action: null,
  alt: null,
};

const GOAL = 5;
const SPEED = 5;
const DASH_SPEED = 14;
const DASH_S = 0.2;
const TIME_LIMIT_S = 40;
let rover = null;
let beacon = null;
let elapsed = 0;
let dashLeft = 0;
let wasMoving = false;
const heading = new THREE.Vector3(0, 0, -1);

export function start(ctx) {
  const { scene, camera } = ctx;
  // The sky, its light and the fog come from the look (LOOK, shell/look.js).
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x48683a, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  const grid = new THREE.GridHelper(60, 60, 0x5d7f4c, 0x557446);
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
  placeBeacon(6, -4);
  rover = new THREE.Mesh(
    new THREE.SphereGeometry(0.45, 24, 18),
    new THREE.MeshStandardMaterial({ color: 0x7fd4ff, roughness: 0.4, metalness: 0.1 }),
  );
  rover.position.set(0, 0.45, 3);
  rover.castShadow = beacon.castShadow = true;
  scene.add(beacon, rover);
  ctx.player = rover;
  // A sun whose soft shadows follow the rover; the look's sky lights the rest.
  ctx.look.sun({ follow: rover, size: 24 });
  camera.position.set(0, 7, 12);
  elapsed = 0;
  dashLeft = 0;
  wasMoving = false;
  heading.set(0, 0, -1);
  // ctx.after runs on game time and goes with the run, so pause holds the
  // clock and Retry never inherits the last run's timer.
  ctx.after(TIME_LIMIT_S, () =>
    GameState.lose("Out of time", { Beacons: `${GameState.score} / ${GOAL}` }),
  );
}

function placeBeacon(x, z) {
  beacon.position.set(x, 1.2, z);
  GameState.beacon_x = x;
  GameState.beacon_z = z;
}

export function update(dt, ctx) {
  const { input, camera, ui } = ctx;
  elapsed += dt;
  GameState.time_left = Math.max(0, Math.ceil(TIME_LIMIT_S - elapsed));
  // y is down the screen, which is +z towards this camera; a stick gives less than 1.
  const move = input.vector();
  const push = Math.hypot(move.x, move.y);
  const moving = push > 0;
  if (moving) heading.set(move.x, 0, move.y).normalize();
  if (moving && !wasMoving) GameState.moves += 1;
  wasMoving = moving;
  if (input.pressed("dash") && dashLeft <= 0) {
    dashLeft = DASH_S;
    Juice.squash(rover);
  }
  dashLeft -= dt;
  const speed = dashLeft > 0 ? DASH_SPEED : SPEED * push;
  rover.position.x = THREE.MathUtils.clamp(rover.position.x + heading.x * speed * dt, -28, 28);
  rover.position.z = THREE.MathUtils.clamp(rover.position.z + heading.z * speed * dt, -28, 28);
  beacon.rotation.y += dt * 0.8;
  if (GameState.isPlaying() && rover.position.distanceTo(beacon.position) < 1.2) {
    GameState.score += 1;
    Juice.burst(beacon.position, 0xffc94d, 24);
    Juice.shake(0.25);
    Juice.pop(rover);
    placeBeacon(THREE.MathUtils.randFloat(-10, 10), THREE.MathUtils.randFloat(-12, 4));
    if (GameState.score < GOAL) ui.toast(`Beacon ${GameState.score} found`);
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
  ui.counter("Beacons", GameState.score, GOAL);
  ui.timer("Time", TIME_LIMIT_S - elapsed);
  ui.objective("Reach every beacon before the clock runs out");
  ui.hint("{move_up}{move_left}{move_down}{move_right} to roam", {
    until: () => GameState.moves > 1,
  });
  ui.hint("{dash} to dash", { until: () => dashLeft > 0 });
}
