// The Stage's dev views over a running game, each off until the Stage turns it on: the bounds of
// every thing the game named (drawn after the frame), a frame-rate readout, and a free camera
// that orbits the frozen frame. Nothing here touches the run: the free camera only replaces the
// camera a frozen frame is drawn with, and goes back to the game's own the moment play goes on.
import * as THREE from "../vendor/three.module.js";

const PERF_EVERY_MS = 250;
const MAX_BOXES = 200;
// A box's 12 edges as pairs of its 8 corners (corner bits: x, y, z).
const EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];

/**
 * `view()` is the scene and the game's camera on screen, `eachBody(fn)` walks the named things'
 * bodies, `redraw()` asks for one frame.
 */
export function createDevView({ renderer, view, eachBody, redraw }) {
  let bounds = false;
  let perf = false;
  let free = false;
  let frozen = false;

  // ── Bounds ────────────────────────────────────────────────────────────
  const positions = new Float32Array(MAX_BOXES * EDGES.length * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const lines = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color: 0x4ade80, depthTest: false, transparent: true }),
  );
  lines.frustumCulled = false;
  const box = new THREE.Box3();
  const corner = new THREE.Vector3();
  const drawBounds = (camera) => {
    let count = 0;
    eachBody((body) => {
      if (count >= MAX_BOXES || !body.visible) return;
      box.setFromObject(body);
      if (box.isEmpty()) return;
      const base = count * EDGES.length * 3;
      for (let i = 0; i < EDGES.length; i += 1) {
        const bits = EDGES[i];
        corner.set(
          bits & 1 ? box.max.x : box.min.x,
          bits & 2 ? box.max.y : box.min.y,
          bits & 4 ? box.max.z : box.min.z,
        );
        positions[base + i * 3] = corner.x;
        positions[base + i * 3 + 1] = corner.y;
        positions[base + i * 3 + 2] = corner.z;
      }
      count += 1;
    });
    if (count === 0) return;
    geometry.setDrawRange(0, count * EDGES.length);
    geometry.attributes.position.needsUpdate = true;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.render(lines, camera);
    } finally {
      renderer.autoClear = autoClear;
    }
  };

  // ── Frame rate ────────────────────────────────────────────────────────
  let panel = null;
  const times = [];
  let shownAt = 0;
  let last = { calls: 0, triangles: 0 };
  const showPerf = (now) => {
    if (panel === null) {
      panel = document.createElement("div");
      panel.style.cssText =
        "position:fixed;top:8px;right:8px;z-index:2147483646;pointer-events:none;padding:4px 7px;border-radius:5px;background:rgb(0 0 0/.72);color:#ecebe7;font:11px/1.35 ui-monospace,monospace;white-space:pre;font-variant-numeric:tabular-nums";
      document.body.append(panel);
    }
    if (now - shownAt < PERF_EVERY_MS) return;
    shownAt = now;
    const sorted = times.toSorted((a, b) => a - b);
    const median = sorted[sorted.length >> 1] ?? 0;
    const worst = sorted.at(-1) ?? 0;
    panel.textContent = `${median > 0 ? Math.round(1000 / median) : 0} fps  ${median.toFixed(1)} ms (worst ${worst.toFixed(1)})\n${last.calls} draws  ${(last.triangles / 1000).toFixed(1)}k tris`;
  };

  // ── Free camera ───────────────────────────────────────────────────────
  const orbit = { camera: null, target: new THREE.Vector3(), radius: 10, yaw: 0, pitch: 0.4 };
  const place = () => {
    const camera = orbit.camera;
    orbit.pitch = Math.max(-1.45, Math.min(1.45, orbit.pitch));
    camera.position.set(
      orbit.target.x + Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * orbit.radius,
      orbit.target.y + Math.sin(orbit.pitch) * orbit.radius,
      orbit.target.z + Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * orbit.radius,
    );
    camera.lookAt(orbit.target);
    camera.updateMatrixWorld();
  };
  /** From where the game's camera stands, around what it looks at (or the selected thing). */
  const seed = (focus) => {
    const seen = view();
    if (seen === null || seen.camera?.isCamera !== true) return false;
    const own = seen.camera;
    orbit.camera = own.isPerspectiveCamera
      ? new THREE.PerspectiveCamera(own.fov, own.aspect, own.near, Math.max(own.far, 2000))
      : own.clone();
    const forward = new THREE.Vector3();
    own.getWorldDirection(forward);
    const from = new THREE.Vector3();
    own.getWorldPosition(from);
    if (focus !== null) orbit.target.copy(focus);
    else orbit.target.copy(from).addScaledVector(forward, 10);
    const offset = from.clone().sub(orbit.target);
    orbit.radius = Math.max(1, offset.length());
    orbit.yaw = Math.atan2(offset.x, offset.z);
    orbit.pitch = Math.asin(Math.max(-1, Math.min(1, offset.y / orbit.radius)));
    place();
    return true;
  };

  return {
    /** The Stage's switches; `focus` is where a new free camera orbits (the selected thing). */
    set(next, focus) {
      bounds = next.bounds === true;
      perf = next.perf === true;
      const wasFree = free && orbit.camera !== null;
      free = next.freeCamera === true;
      if (free && frozen && !wasFree) seed(focus);
      if (!free) orbit.camera = null;
      if (!perf && panel !== null) {
        panel.remove();
        panel = null;
      }
      redraw();
    },
    /** Play froze or went on: a free camera starts from the frozen frame, and ends with it. */
    frozen(on, focus) {
      frozen = on;
      if (on && free) seed(focus);
      if (!on) orbit.camera = null;
    },
    /** A drag (radians) and a wheel (a factor) from the Stage while the free camera is on. */
    orbit(dx, dy, zoom) {
      if (orbit.camera === null) return;
      orbit.yaw -= dx;
      orbit.pitch += dy;
      orbit.radius = Math.max(0.5, Math.min(1000, orbit.radius * zoom));
      place();
      redraw();
    },
    /** The camera a frame is drawn with: the free one while it flies, else null (the game's). */
    camera() {
      if (orbit.camera === null) return null;
      const seen = view();
      if (seen?.camera?.isPerspectiveCamera === true && orbit.camera.isPerspectiveCamera) {
        orbit.camera.aspect = seen.camera.aspect;
        orbit.camera.updateProjectionMatrix();
      }
      return orbit.camera;
    },
    /** After each drawn frame: the bounds over it, and the frame's time and cost. */
    after(camera, frameMs, now) {
      // The frame's own cost, read before the bounds add a draw of their own.
      if (perf) {
        if (frameMs > 0) {
          times.push(frameMs);
          if (times.length > 60) times.shift();
        }
        last = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
        showPerf(now);
      }
      if (bounds && camera !== null) drawBounds(camera);
    },
  };
}
