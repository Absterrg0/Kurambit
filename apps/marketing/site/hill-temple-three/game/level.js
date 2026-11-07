// The level's shape, as data and pure functions: the winding path, the stairs to the plateau,
// the terrain height everywhere, and a 1 m grid of height and path distance the grass, the
// scatter and the bodies read. Ported from round 2's Godot main.gd (same control points, same
// heights), so the two builds share one level.
import { ImprovedNoise } from "../vendor/addons/math/ImprovedNoise.js";

export const PLATEAU = { x: 0, z: -48 };
export const PLATEAU_H = 10;
export const STAIR_B = { x: 0, y: PLATEAU_H, z: -34 };
const CTRL = [
  [0, 40],
  [0, 26],
  [5, 16],
  [-2.5, 6],
  [4, -4],
  [0, -13],
];

const perlin = new ImprovedNoise();
/** Fractal noise in about [-1, 1]: 4 octaves at frequency 0.02, like Godot's FastNoiseLite default. */
export function noise(x, z) {
  let sum = 0;
  let amp = 1;
  let f = 0.02;
  let norm = 0;
  for (let o = 0; o < 4; o++) {
    sum += amp * perlin.noise(x * f, z * f, 11.5);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return (sum / norm) * 1.6;
}

export const ss = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

export function baseHeight(x, z) {
  const d = Math.hypot(x - PLATEAU.x, z - PLATEAU.z);
  const hill = PLATEAU_H * ss(36, 14, d);
  const sides = 11 * ss(18, 75, Math.abs(x)) * (0.7 + 0.5 * noise(x * 0.6, z * 0.6));
  const back = 16 * ss(-62, -120, z);
  const roll = noise(x * 1.3, z * 1.3) * 1.4 * (1 - 0.85 * ss(30, 14, d));
  return hill + sides + back + roll;
}

/** The path: Catmull-Rom through the control points, heights smoothed along it. */
export const path = (() => {
  const pts = [];
  for (let i = 0; i < CTRL.length - 1; i++) {
    const p0 = CTRL[Math.max(i - 1, 0)];
    const p1 = CTRL[i];
    const p2 = CTRL[i + 1];
    const p3 = CTRL[Math.min(i + 2, CTRL.length - 1)];
    for (let k = 0; k < 12; k++) {
      const t = k / 12;
      const t2 = t * t;
      const t3 = t2 * t;
      const c = (j) =>
        0.5 *
        (2 * p1[j] +
          (-p0[j] + p2[j]) * t +
          (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 +
          (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3);
      pts.push([c(0), c(1)]);
    }
  }
  pts.push(CTRL[CTRL.length - 1]);
  let hs = pts.map(([x, z]) => baseHeight(x, z));
  for (let pass = 0; pass < 6; pass++) {
    const nh = hs.slice();
    for (let i = 1; i < hs.length - 1; i++) nh[i] = (hs[i - 1] + hs[i] * 2 + hs[i + 1]) / 4;
    hs = nh;
  }
  return pts.map(([x, z], i) => ({ x, y: hs[i], z }));
})();

export const STAIR_A = path[path.length - 1];

/** Distance to the path (or the stairs) on x/z, the walkway's height there, its kind (0 path, 1 stairs) and the stair fraction. */
export function pathInfo(x, z) {
  let best = 1e9;
  let by = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const t = Math.min(Math.max(((x - a.x) * abx + (z - a.z) * abz) / (abx * abx + abz * abz), 0), 1);
    const d = Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t));
    if (d < best) {
      best = d;
      by = lerp(a.y, b.y, t);
    }
  }
  const s0 = STAIR_A;
  const sx = STAIR_B.x - s0.x;
  const sz = STAIR_B.z - s0.z;
  const st = Math.min(Math.max(((x - s0.x) * sx + (z - s0.z) * sz) / (sx * sx + sz * sz), 0), 1);
  const sd = Math.hypot(x - (s0.x + sx * st), z - (s0.z + sz * st));
  if (sd < best) return { d: sd, y: lerp(s0.y, STAIR_B.y, st), kind: 1, st };
  return { d: best, y: by, kind: 0, st: 0 };
}

export function heightFrom(x, z, info) {
  let h = baseHeight(x, z);
  const pd = Math.hypot(x - PLATEAU.x, z - PLATEAU.z);
  if (h > PLATEAU_H - 3 || pd < 19) h = lerp(PLATEAU_H, h, ss(15, 19, pd));
  if (info.kind === 1) {
    const depth = 0.35 * Math.min(Math.max(Math.min(info.st, 1 - info.st) * 25, 0), 1);
    return lerp(info.y - depth, h, ss(2.4, 5, info.d));
  }
  return lerp(info.y, h, ss(1.8, 4.5, info.d));
}

export const height = (x, z) => heightFrom(x, z, pathInfo(x, z));

// The 1 m grid every runtime query reads (bilinear), filled once by buildGrid().
export const GX0 = -130;
export const GZ0 = -170;
export const GN = 261;
export const grid = { h: null, d: null, k: null, path: null, grass: null };

export function buildGrid() {
  if (grid.h !== null) return grid;
  const n = GN * GN;
  grid.h = new Float32Array(n);
  grid.d = new Float32Array(n);
  grid.k = new Uint8Array(n);
  grid.path = new Float32Array(n);
  grid.grass = new Float32Array(n);
  for (let j = 0; j < GN; j++)
    for (let i = 0; i < GN; i++) {
      const x = GX0 + i;
      const z = GZ0 + j;
      const info = pathInfo(x, z);
      const at = j * GN + i;
      grid.h[at] = heightFrom(x, z, info);
      grid.d[at] = info.d;
      grid.k[at] = info.kind;
      const edge = noise(x * 4, z * 4) * 0.5;
      grid.path[at] = info.kind === 0 ? 1 - ss(1.25 + edge, 2.1 + edge, info.d) : 0;
      grid.grass[at] = Math.min(Math.max(0.5 + noise(x * 2.5 + 40, z * 2.5) * 1.3, 0), 1);
    }
  return grid;
}

export function sample(arr, x, z) {
  const fx = Math.min(Math.max(x - GX0, 0), GN - 1.001);
  const fz = Math.min(Math.max(z - GZ0, 0), GN - 1.001);
  const i = fx | 0;
  const j = fz | 0;
  const tx = fx - i;
  const tz = fz - j;
  const a = arr[j * GN + i] + (arr[j * GN + i + 1] - arr[j * GN + i]) * tx;
  const b = arr[(j + 1) * GN + i] + (arr[(j + 1) * GN + i + 1] - arr[(j + 1) * GN + i]) * tx;
  return a + (b - a) * tz;
}

/** Ground height under a point: the stairs' treads where the stairs are, else the terrain. */
export function groundAt(x, z) {
  const sx = STAIR_B.x - STAIR_A.x;
  const sz = STAIR_B.z - STAIR_A.z;
  const len2 = sx * sx + sz * sz;
  const t = ((x - STAIR_A.x) * sx + (z - STAIR_A.z) * sz) / len2;
  if (t > -0.02 && t < 1.0 && Math.abs(x - (STAIR_A.x + sx * t)) < 2.05) {
    // a smooth ramp under the treads, as round 2's collision ramp: the body glides, the eye sees steps
    return STAIR_A.y + (STAIR_B.y - STAIR_A.y) * Math.max(t, 0) + 0.04;
  }
  return sample(grid.h, x, z);
}

/** Clear of the walkway, the temple court and the gate. */
export function clearOfPath(x, z, margin) {
  if (sample(grid.d, x, z) < margin) return false;
  if (Math.hypot(x, z + 50) < 9) return false;
  if (Math.hypot(x, z - 26) < 3) return false;
  return true;
}

/** A seeded random stream, so every load scatters the same world. */
export function rng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (a, b) => a + (b - a) * next();
  next.int = (a, b) => a + Math.floor(next() * (b - a + 1));
  return next;
}
