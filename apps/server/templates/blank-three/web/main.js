// A stand-in so the Stage shows a running frame from the first second: replace its scene with
// the game's, then grow the game in place. TEMPLATE.md is the bridge contract.
import * as THREE from "three";

export function start(ctx) {
  ctx.scene.background = new THREE.Color(0x1d2230);
  ctx.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2420, 2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(4, 8, 3);
  ctx.scene.add(sun);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x3b4a3f }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.name = "Ground";
  const player = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.4, 0.8),
    new THREE.MeshStandardMaterial({ color: 0xe8a33d }),
  );
  player.position.y = 0.8;
  player.name = "Player";
  ctx.scene.add(ground, player);
  ctx.player = player;
  ctx.camera.position.set(0, 6, 9);
}

export function update(dt, ctx) {
  // The arrows and WASD; y is down the screen, toward the camera.
  const move = ctx.input.vector();
  ctx.player.position.x += move.x * 5 * dt;
  ctx.player.position.z += move.y * 5 * dt;
  ctx.camera.lookAt(ctx.player.position);
}
