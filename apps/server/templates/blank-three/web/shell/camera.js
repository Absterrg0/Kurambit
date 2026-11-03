// Follow cameras. Make one in start(ctx); the shell moves it every frame
// after update(dt, ctx), on game time, and Juice.shake still applies on top.
//
//   import { followCamera2D, followCamera3D } from "./shell/camera.js";
//
// 2D (side view on x/y, or top-down on x/z), with an orthographic or a
// perspective camera; it keeps the camera's offset from the target as placed:
//   camera.position.set(player.position.x, player.position.y, 20);
//   followCamera2D(ctx, player, {
//     plane: "xy",                      // "xz" for top-down
//     deadZone: { x: 1.5, y: 1 },       // the target moves this far before the camera does
//     lookAhead: 2,                     // world units ahead in the moving direction
//     smooth: 6,                        // higher catches up faster
//     bounds: { minX: 0, maxX: 80, minY: -2, maxY: 20 }, // level edges (minZ/maxZ for xz), or a Box3
//                                       // such as buildLevel's level.bounds; the view stays inside
//   });
//
// 3D third person: behind and above the target, lagging, looking a little
// ahead, pulled in when anything in `blockers` (the level meshes or a group
// of them) is between it and the target, so it never ends inside a wall.
// Drag with the right mouse button (or under pointer lock) or the right
// stick to orbit; without input it settles behind the target's facing.
//   const cam = followCamera3D(ctx, player, { blockers: [level], distance: 6, height: 2 });
//   // move relative to the view: forward is (-sin(cam.yaw), -cos(cam.yaw)) on x/z,
//   // and face the move direction with player.rotation.y = Math.atan2(dir.x, dir.z)
import * as THREE from "../vendor/three.module.js";

const live = new Set();
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);

export function followCamera2D(ctx, target, options = {}) {
  const { plane = "xy", deadZone = { x: 1, y: 1 }, lookAhead = 1.5, smooth = 6 } = options;
  const box = options.bounds;
  const bounds = box?.isBox3
    ? {
        minX: box.min.x,
        maxX: box.max.x,
        minY: box.min.y,
        maxY: box.max.y,
        minZ: box.min.z,
        maxZ: box.max.z,
      }
    : (box ?? null);
  const camera = ctx.camera;
  // u/v are the two axes the target moves on; the third keeps its offset.
  const v = plane === "xz" ? "z" : "y";
  const focus = new THREE.Vector2(target.position.x, target.position[v]);
  // The whole offset as placed, so a tilted top-down camera stays tilted; the
  // third axis stays where the target started, so a jump does not bob the view.
  const offset = new THREE.Vector3().subVectors(camera.position, target.position);
  const third = target.position[plane === "xz" ? "y" : "z"];
  const base = new THREE.Vector3();
  const ahead = new THREE.Vector2();
  const last = focus.clone();
  const rig = {
    camera,
    target,
    update(dt) {
      if (dt <= 0) return;
      const at = new THREE.Vector2(target.position.x, target.position[v]);
      const moved = at.clone().sub(last).divideScalar(dt);
      last.copy(at);
      // Ahead in the moving direction, easing back to centre when the target stops.
      // The dead zone holds the focus a box-edge behind the goal, so reach past it to lead.
      const dzY = deadZone.y ?? deadZone.z ?? 0;
      const want = new THREE.Vector2();
      if (moved.lengthSq() > 0.25) {
        const dir = moved.normalize();
        want.copy(dir).multiplyScalar(lookAhead);
        if (Math.abs(dir.x) > 0.3) want.x += Math.sign(dir.x) * deadZone.x;
        if (Math.abs(dir.y) > 0.3) want.y += Math.sign(dir.y) * dzY;
      }
      ahead.lerp(want, ease(2.5, dt));
      const goal = at.add(ahead);
      // The dead zone: the focus only moves to keep the goal inside the box.
      if (goal.x > focus.x + deadZone.x)
        focus.x += (goal.x - deadZone.x - focus.x) * ease(smooth, dt);
      else if (goal.x < focus.x - deadZone.x)
        focus.x += (goal.x + deadZone.x - focus.x) * ease(smooth, dt);
      if (goal.y > focus.y + dzY) focus.y += (goal.y - dzY - focus.y) * ease(smooth, dt);
      else if (goal.y < focus.y - dzY) focus.y += (goal.y + dzY - focus.y) * ease(smooth, dt);
      if (bounds !== null) clampFocus(focus);
      if (plane === "xz") base.set(focus.x, third, focus.y);
      else base.set(focus.x, focus.y, third);
      camera.position.copy(base).add(offset);
      if (plane === "xz") camera.lookAt(base);
    },
  };
  const clampFocus = (f) => {
    const minV = plane === "xz" ? bounds.minZ : bounds.minY;
    const maxV = plane === "xz" ? bounds.maxZ : bounds.maxY;
    // An orthographic camera keeps its whole view inside; a perspective one its centre.
    const halfW = camera.isOrthographicCamera ? (camera.right - camera.left) / 2 / camera.zoom : 0;
    const halfH = camera.isOrthographicCamera ? (camera.top - camera.bottom) / 2 / camera.zoom : 0;
    const fit = (x, lo, hi, half) =>
      lo === undefined || hi === undefined
        ? x
        : hi - lo < half * 2
          ? (lo + hi) / 2
          : THREE.MathUtils.clamp(x, lo + half, hi - half);
    f.x = fit(f.x, bounds.minX, bounds.maxX, halfW);
    f.y = fit(f.y, minV, maxV, halfH);
  };
  if (bounds !== null) clampFocus(focus);
  live.add(rig);
  rig.update(1e-3);
  return rig;
}

export function followCamera3D(ctx, target, options = {}) {
  const {
    distance = 6,
    height = 2,
    lag = 10,
    lookAhead = 1.5,
    blockers = [],
    orbit = true,
    sensitivity = 0.004,
    minPitch = -0.35,
    maxPitch = 1.1,
    radius = 0.3,
  } = options;
  const camera = ctx.camera;
  const ray = new THREE.Raycaster();
  const pivot = target.position.clone();
  const ahead = new THREE.Vector3();
  const last = target.position.clone();
  let pitch = 0.3;
  let length = distance;
  let idle = 0;
  const rig = {
    camera,
    target,
    /** The view's heading around y; 0 looks down -z. Move the player relative to it. */
    yaw: target.rotation.y + Math.PI,
    blockers,
    update(dt) {
      if (dt <= 0) return;
      // Orbit by mouse (right button or pointer lock) or the right stick.
      let dx = 0;
      let dy = 0;
      if (orbit && (ctx.mouse.down(2) || document.pointerLockElement === ctx.canvas)) {
        dx = ctx.mouse.movement.x * sensitivity;
        dy = ctx.mouse.movement.y * sensitivity;
      }
      const pad = orbit ? [...(navigator.getGamepads?.() ?? [])].find((p) => p != null) : null;
      const sx = pad?.axes[2] ?? 0;
      const sy = pad?.axes[3] ?? 0;
      if (Math.abs(sx) > 0.15) dx += sx * 2.5 * dt;
      if (Math.abs(sy) > 0.15) dy += sy * 1.5 * dt;
      rig.yaw -= dx;
      pitch = THREE.MathUtils.clamp(pitch + dy, minPitch, maxPitch);
      const moved = target.position.clone().sub(last).divideScalar(dt);
      last.copy(target.position);
      moved.y = 0;
      idle = dx !== 0 || dy !== 0 ? 0 : idle + dt;
      // Untouched for a moment and moving: swing behind the target's facing
      // (+z, as glTF models face, turned by rotation.y).
      if (idle > 1 && moved.lengthSq() > 0.5) {
        const behind = target.rotation.y + Math.PI;
        const turn = Math.atan2(Math.sin(behind - rig.yaw), Math.cos(behind - rig.yaw));
        rig.yaw += turn * ease(1.5, dt);
      }
      const want =
        moved.lengthSq() > 0.25 ? moved.normalize().multiplyScalar(lookAhead) : new THREE.Vector3();
      ahead.lerp(want, ease(2.5, dt));
      pivot.lerp(target.position, ease(lag, dt));
      const look = pivot.clone().add(ahead);
      look.y += height;
      const back = new THREE.Vector3(
        Math.sin(rig.yaw) * Math.cos(pitch),
        Math.sin(pitch),
        Math.cos(rig.yaw) * Math.cos(pitch),
      );
      // Pulled in at once when blocked, eased back out when clear.
      let room = distance;
      if (rig.blockers.length > 0) {
        ray.set(look, back);
        ray.far = distance + radius;
        const hit = ray.intersectObjects(rig.blockers, true)[0];
        if (hit !== undefined) room = Math.max(0.2, hit.distance - radius);
      }
      length = room < length ? room : length + (room - length) * ease(3, dt);
      camera.position.copy(look).addScaledVector(back, length);
      camera.lookAt(look);
    },
  };
  // Right-drag orbits instead of opening the browser's menu.
  if (orbit) ctx.listen(ctx.canvas, "contextmenu", (event) => event.preventDefault());
  live.add(rig);
  rig.update(1e-3);
  return rig;
}

// The shell's side: move every follow camera after the game's update; a new run starts empty.
export const cameraShell = {
  update(dt) {
    for (const rig of live) rig.update(dt);
  },
  reset() {
    live.clear();
  },
};
