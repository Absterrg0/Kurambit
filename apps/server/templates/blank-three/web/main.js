// A placeholder to replace: roam (the move actions), dash, and touch the beacon five times
// before the clock runs out. Everything a player sees is this game's own, the page's
// elements included; the bridge (TEMPLATE.md) only runs it: start(ctx) builds a run,
// update(dt, ctx) moves it, GameState.win and lose end it.
import * as THREE from "./vendor/three.module.js";
import { GameState } from "./shell/run-state.js";

// The run's values: the harness reads them, and each run starts from these again.
GameState.score = 0;
GameState.time_left = 0;

export const ACTIONS = { dash: { keys: ["Space", "ShiftLeft"], pad: ["a", "rb"], mouse: [0] } };

const GOAL = 5;
const TIME_LIMIT_S = 40;
const hud = document.body.appendChild(document.createElement("div"));
hud.style.cssText = "position:fixed;top:12px;left:16px;color:#fff;font:600 18px system-ui";
let rover, beacon, tuned, elapsed, dashLeft;
const heading = new THREE.Vector3();

export function start(ctx) {
  const { scene, camera } = ctx;
  scene.background = new THREE.Color(0x8fb8de);
  scene.add(new THREE.HemisphereLight(0xdfeeff, 0x4a5a3a, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(-6, 12, 8);
  scene.add(sun);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x5b7d46, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  beacon = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.7),
    new THREE.MeshStandardMaterial({ color: 0xffc94d, emissive: 0xff9d2e }),
  );
  beacon.position.set(6, 1.2, -4);
  rover = new THREE.Mesh(
    new THREE.SphereGeometry(0.45, 24, 18),
    new THREE.MeshStandardMaterial({ color: 0x7fd4ff, roughness: 0.4 }),
  );
  rover.position.set(0, 0.45, 3);
  scene.add(ground, beacon, rover);
  ctx.player = rover;
  ctx.thing(rover, { name: "Rover", kind: "character" });
  ctx.thing(beacon, { name: "Beacon", kind: "prop" });
  tuned = ctx.tune("Rover", { speed: 5, dash: 14 }, { speed: [1, 12, 0.5, "m/s"], dash: [4, 30] });
  camera.position.set(0, 7, 12);
  elapsed = 0;
  dashLeft = 0;
  heading.set(0, 0, -1);
  ctx.after(TIME_LIMIT_S, () => GameState.lose("Out of time"));
}

export function update(dt, ctx) {
  if (GameState.state === "ended") hud.textContent = GameState.result_text;
  if (!GameState.isPlaying()) return;
  elapsed += dt;
  GameState.time_left = Math.max(0, Math.ceil(TIME_LIMIT_S - elapsed));
  const move = ctx.input.vector();
  const push = Math.hypot(move.x, move.y);
  if (push > 0) heading.set(move.x, 0, move.y).normalize();
  if (ctx.input.pressed("dash") && dashLeft <= 0) dashLeft = 0.2;
  dashLeft -= dt;
  const speed = dashLeft > 0 ? tuned.dash : tuned.speed * push;
  rover.position
    .addScaledVector(heading, speed * dt)
    .clampScalar(-28, 28)
    .setY(0.45);
  beacon.rotation.y += dt;
  if (rover.position.distanceTo(beacon.position) < 1.2) {
    GameState.score += 1;
    beacon.position.set(ctx.random() * 20 - 10, 1.2, ctx.random() * 16 - 12);
    if (GameState.score >= GOAL) GameState.win("Every beacon found");
  }
  ctx.camera.position.set(rover.position.x, 7, rover.position.z + 9);
  ctx.camera.lookAt(rover.position.x, 0.5, rover.position.z);
  hud.textContent = `Beacons ${GameState.score}/${GOAL} · ${GameState.time_left}s`;
}
