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
// of them) is between it and the target: the view's centre and the corners of
// its near plane are all kept clear, so it never ends inside a wall or a post.
// Drag with the right mouse button (or under pointer lock) or the right
// stick to orbit; without input it settles behind the target's facing.
//   const cam = followCamera3D(ctx, player, { blockers: [level] });
//   // framed by the target's own height (measured once): it looks at its chest
//   // (height: 0.6 of it) from 3 heights away (distance), so any size stays in frame
//   // move relative to the view: forward is (-sin(cam.yaw), -cos(cam.yaw)) on x/z,
//   // and face the move direction with player.rotation.y = Math.atan2(dir.x, dir.z)
// For action:
//   const cam = followCamera3D(ctx, hero.root, {
//     blockers: [level, props],  // anything the camera must not pass through
//     shoulder: 0.55,            // over the right shoulder (negative: the left)
//     orbitButton: 1,            // the middle button drags the view, so right-click
//                                // stays free for a dodge; null: no button, only
//                                // pointer lock and the right stick
//     distance: 4.3, pitch: 0.22,
//     ground: (x, z) => terrainHeight(x, z), // a heightfield to stay above, cheaper than
//                                // raycasting a big terrain mesh as a blocker
//   });
//   cam.focus = foe.root;        // turns to keep this foe in frame; null lets go
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
  const tall = standingHeight(target);
  const {
    distance = Math.max(3, tall * 3),
    height = tall * 0.6,
    lag = 10,
    lookAhead = 1.5,
    blockers = [],
    orbit = true,
    orbitButton = 2,
    shoulder = 0,
    pitch: startPitch = 0.3,
    sensitivity = 0.004,
    minPitch = -0.35,
    maxPitch = 1.1,
    radius = 0.3,
    ground = null,
  } = options;
  const camera = ctx.camera;
  const ray = new THREE.Raycaster();
  const pivot = target.position.clone();
  const ahead = new THREE.Vector3();
  const last = target.position.clone();
  const look = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const back = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const goal = new THREE.Vector3();
  const to = new THREE.Vector3();
  const foeAt = new THREE.Vector3();
  let pitch = startPitch;
  let length = distance;
  let side = shoulder;
  let idle = 0;
  /** The first blocker hit from `from` toward `point`, as a distance; Infinity when clear. */
  const clear = (from, point) => {
    to.subVectors(point, from);
    const far = to.length();
    if (far < 1e-4) return Infinity;
    ray.set(from, to.divideScalar(far));
    ray.far = far;
    return ray.intersectObjects(rig.blockers, true)[0]?.distance ?? Infinity;
  };
  const rig = {
    camera,
    target,
    /** The view's heading around y; 0 looks down -z. Move the player relative to it. */
    yaw: target.rotation.y + Math.PI,
    blockers,
    /** An Object3D or point to keep in frame (a foe), or null. */
    focus: null,
    update(dt) {
      if (dt <= 0) return;
      // Orbit by mouse (the orbit button held, or pointer lock) or the right stick.
      let dx = 0;
      let dy = 0;
      const dragging = orbitButton !== null && ctx.mouse.down(orbitButton);
      if (orbit && (dragging || document.pointerLockElement === ctx.canvas)) {
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
      const focus = rig.focus;
      if (focus != null && idle > 0.6) {
        // Keep the foe ahead: turn only when it leaves a cone around the view's centre.
        if (focus.isObject3D === true) focus.getWorldPosition(foeAt);
        else foeAt.set(focus.x, focus.y ?? 0, focus.z);
        const want = Math.atan2(-(foeAt.x - target.position.x), -(foeAt.z - target.position.z));
        const off = Math.atan2(Math.sin(want - rig.yaw), Math.cos(want - rig.yaw));
        if (Math.abs(off) > 0.35) rig.yaw += (off - Math.sign(off) * 0.35) * ease(3, dt);
      } else if (idle > 1 && moved.lengthSq() > 0.5) {
        // Untouched for a moment and moving: swing behind the target's facing
        // (+z, as glTF models face, turned by rotation.y).
        const behind = target.rotation.y + Math.PI;
        const turn = Math.atan2(Math.sin(behind - rig.yaw), Math.cos(behind - rig.yaw));
        rig.yaw += turn * ease(1.5, dt);
      }
      const want =
        moved.lengthSq() > 0.25 ? moved.normalize().multiplyScalar(lookAhead) : new THREE.Vector3();
      ahead.lerp(want, ease(2.5, dt));
      pivot.lerp(target.position, ease(lag, dt));
      centre.copy(pivot).add(ahead);
      centre.y += height;
      back.set(
        Math.sin(rig.yaw) * Math.cos(pitch),
        Math.sin(pitch),
        Math.cos(rig.yaw) * Math.cos(pitch),
      );
      right.set(Math.cos(rig.yaw), 0, -Math.sin(rig.yaw));
      // The shoulder is pulled in when a wall stands beside the target.
      let reach = shoulder;
      if (shoulder !== 0 && rig.blockers.length > 0) {
        const hit = clear(
          centre,
          goal.copy(centre).addScaledVector(right, shoulder + Math.sign(shoulder) * radius),
        );
        if (hit !== Infinity) reach = Math.sign(shoulder) * Math.max(0, hit - radius);
      }
      side +=
        (reach - side) *
        ease(reach * Math.sign(shoulder) < side * Math.sign(shoulder) ? 20 : 4, dt);
      look.copy(centre).addScaledVector(right, side);
      // Pulled in at once when blocked, eased back out when clear. The near
      // plane's corners are tested too: a thin post beside the line of sight
      // would otherwise fill the view.
      let room = distance;
      if (rig.blockers.length > 0) {
        up.crossVectors(right, back).normalize();
        const halfH = camera.isPerspectiveCamera
          ? Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.near + radius
          : radius;
        const halfW = camera.isPerspectiveCamera ? halfH * camera.aspect : radius;
        for (const [u, v] of [
          [0, 0],
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
        ]) {
          goal
            .copy(look)
            .addScaledVector(back, distance + radius)
            .addScaledVector(right, u * halfW)
            .addScaledVector(up, v * halfH);
          const from = to
            .copy(look)
            .addScaledVector(right, u * halfW * 0.25)
            .addScaledVector(up, v * halfH * 0.25)
            .clone();
          room = Math.min(room, clear(from, goal) - radius);
        }
        room = Math.max(0.2, room);
      }
      length = room < length ? room : length + (room - length) * ease(3, dt);
      camera.position.copy(look).addScaledVector(back, length);
      if (ground !== null) {
        const floor = ground(camera.position.x, camera.position.z) + radius;
        if (camera.position.y < floor) camera.position.y = floor;
      }
      camera.lookAt(look);
    },
  };
  // A drag on the orbit button orbits instead of opening the browser's menu.
  if (orbit && orbitButton === 2)
    ctx.listen(ctx.canvas, "contextmenu", (event) => event.preventDefault());
  live.add(rig);
  rig.update(1e-3);
  return rig;
}

/** How tall the target stands, in world units, from its bounds; 2 when it has none yet. */
function standingHeight(target) {
  target.updateWorldMatrix(true, true);
  const y = new THREE.Box3().setFromObject(target).getSize(new THREE.Vector3()).y;
  return Number.isFinite(y) && y > 0.05 ? y : 2;
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
