// Dry grass: instanced clumps of curved blades, dense along the path and thinning outward (round
// 2's placement rules), in chunks that thin out with distance and stop at 75 m. Blades sway in a
// travelling wind, part around the hero, and glow when the low sun is behind them.
import * as THREE from "../vendor/three.module.js";
import { GN, GX0, GZ0, grid, noise, rng, sample, ss } from "./level.js";
import { SUN_COLOR, SUN_DIR } from "./world.js";

const CHUNK = 12;
const FAR = 80;
export const grassUniforms = {
  time: { value: 0 },
  wind: { value: 1 },
  pushers: { value: [new THREE.Vector4(0, -100, 0, 0), new THREE.Vector4(0, -100, 0, 0), new THREE.Vector4(0, -100, 0, 0)] },
  sunDir: { value: SUN_DIR },
  sunCol: { value: SUN_COLOR },
};

function clumpGeometry(blades = 4, segs = 2) {
  const pos = [];
  const uv = [];
  const nrm = [];
  const idx = [];
  const r = rng(91);
  for (let b = 0; b < blades; b++) {
    const ang = r.range(0, Math.PI * 2);
    const ox = Math.cos(ang) * r.range(0.02, 0.12);
    const oz = Math.sin(ang) * r.range(0.02, 0.12);
    const yaw = r.range(0, Math.PI * 2);
    const lean = r.range(0.15, 0.45);
    const hgt = r.range(0.45, 0.8);
    const wid = r.range(0.045, 0.065);
    const fx = Math.cos(yaw);
    const fz = Math.sin(yaw);
    const base = pos.length / 3;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const w = wid * (1 - t * 0.92);
      const bend = lean * t * t;
      const cx = ox + fx * bend * hgt;
      const cz = oz + fz * bend * hgt;
      const y = hgt * t * (1 - 0.15 * t * t);
      // width across the blade (perpendicular to its lean)
      pos.push(cx - fz * w, y, cz + fx * w, cx + fz * w, y, cz - fx * w);
      uv.push(0, t, 1, t);
      // the blade's face normal, leaning back with the curve
      const n = new THREE.Vector3(fx, 0.6 + t, fz).normalize();
      nrm.push(n.x, n.y, n.z, n.x, n.y, n.z);
      if (s < segs) {
        const a = base + s * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function grassMaterial() {
  // Lambert, not PBR: the blades cover half the screen many times over, and a matte blade
  // gains nothing from specular; the sky's light is added as a simple ambient by height
  const m = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, color: 0xffffff });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, grassUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float time;
uniform float wind;
uniform vec4 pushers[3];
varying float vH;
varying vec3 vGW;`,
      )
      .replace(
        "#include <begin_vertex>",
        `vec3 transformed = position;
  vH = uv.y;
  vec3 root = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vGW = root;
  float dist = distance(root, cameraPosition);
  // farther clumps get wider blades, so a thinned chunk still covers the ground
  transformed.xz *= 1.0 + smoothstep(18.0, 70.0, dist) * 1.6;
  float hh = vH * vH;
  // a slow gust travelling up the valley, and a quick flutter on top
  float gust = sin(root.x * 0.08 + root.z * 0.05 - time * 1.1) * 0.5 + 0.5;
  gust = gust * gust;
  float sway = sin(time * 2.1 + root.x * 0.35 + root.z * 0.22) * (0.06 + 0.16 * gust) * wind;
  float flutter = sin(time * 7.0 + root.x * 3.1 + position.x * 9.0) * 0.015 * wind;
  vec3 bend = vec3(sway * 0.9 + flutter, 0.0, sway * 0.45 + 0.08 * gust * wind);
  // bodies push the blades aside
  for (int i = 0; i < 3; i++) {
    vec2 d = root.xz - pushers[i].xz;
    float l = length(d);
    float k = (1.0 - smoothstep(0.0, pushers[i].w, l)) * step(0.001, pushers[i].w);
    bend.xz += normalize(d + vec2(0.0001)) * k * 0.55;
    bend.y -= k * 0.25;
  }
  // into the instance's frame: bend is in world axes
  mat3 inv = transpose(mat3(instanceMatrix));
  transformed += inv * bend * hh / max(length(instanceMatrix[0].xyz), 0.01);`,
      )
      .replace(
        "#include <beginnormal_vertex>",
        `vec3 objectNormal = normalize(mix(normal, vec3(0.0, 1.0, 0.0), 0.6));`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform vec3 sunDir;
uniform vec3 sunCol;
varying float vH;
varying vec3 vGW;
float gHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`,
      )
      .replace(
        "#include <color_fragment>",
        `float v = gHash(floor(vGW.xz * 0.35));
  float v2 = gHash(vGW.xz);
  vec3 rootC = vec3(0.075, 0.042, 0.016);
  vec3 tipC = vec3(0.70, 0.40, 0.17) * (0.62 + 0.55 * v) * vec3(1.0, 0.94 + 0.12 * v2, 0.86 + 0.24 * v2);
  diffuseColor.rgb = mix(rootC, tipC, smoothstep(0.0, 0.75, vH));`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
  {
    // light through the blades when the sun is behind them
    vec3 V = normalize(cameraPosition - vGW);
    float back = pow(max(dot(-V, sunDir), 0.0), 3.0);
    totalEmissiveRadiance += sunCol * diffuseColor.rgb * (back * 1.6 + 0.08) * vH;
    // ambient: warm sky above, dim earth bounce below
    totalEmissiveRadiance += diffuseColor.rgb * mix(vec3(0.20, 0.15, 0.12), vec3(0.62, 0.52, 0.46), vH);
  }`,
      );
  };
  m.customProgramCacheKey = () => "grass";
  return m;
}

/** Builds the grass chunks; returns {group, update(camera)}. */
export function buildGrass({ density = 1 } = {}) {
  const geo = clumpGeometry();
  const mat = grassMaterial();
  const r = rng(13);
  const chunks = new Map();
  const target = Math.round(150000 * density);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  let count = 0;
  for (let tries = 0; count < target && tries < target * 7; tries++) {
    const x = r.range(-72, 72);
    const z = r.range(-78, 50);
    const pd = sample(grid.d, x, z);
    const onStairs = grid.k[Math.round(z - GZ0) * GN + Math.round(x - GX0)] === 1;
    if (pd < (onStairs ? 2.8 : 1.9)) continue;
    if (Math.hypot(x, z + 50) < 7.5) continue;
    const near = ss(30, 6, pd);
    if (r() > 0.35 + 0.65 * near) continue;
    const dens = 0.5 + noise(x * 2.5 + 40, z * 2.5) * 1.3;
    if (r() > Math.min(Math.max(dens, 0.12 + 0.6 * near), 1)) continue;
    const y = sample(grid.h, x, z);
    const s = r.range(0.75, 1.45) * (0.8 + 0.4 * Math.min(Math.max(dens, 0), 1));
    q.setFromAxisAngle(up, r.range(0, Math.PI * 2));
    m.compose(new THREE.Vector3(x, y - 0.03, z), q, new THREE.Vector3(s, s * r.range(0.8, 1.35), s));
    const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    if (!chunks.has(key)) chunks.set(key, []);
    chunks.get(key).push(m.clone());
    count++;
  }
  const group = new THREE.Group();
  group.name = "grass";
  const list = [];
  for (const [key, mats] of chunks) {
    // shuffled, so drawing the first n of a chunk thins it evenly
    for (let i = mats.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [mats[i], mats[j]] = [mats[j], mats[i]];
    }
    const inst = new THREE.InstancedMesh(geo, mat, mats.length);
    mats.forEach((mm, i) => inst.setMatrixAt(i, mm));
    inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    inst.computeBoundingSphere();
    inst.castShadow = false;
    inst.receiveShadow = true;
    inst.name = `grass ${key}`;
    group.add(inst);
    list.push({ inst, full: mats.length, centre: inst.boundingSphere.center.clone() });
  }
  let lod = 1;
  return {
    group,
    count,
    material: mat,
    /** Quality 0..1 scales how much is drawn (the adaptive resolution's partner). */
    setLod(v) {
      lod = v;
    },
    update(camera) {
      let drawn = 0;
      for (const c of list) {
        const d = c.centre.distanceTo(camera.position) - CHUNK * 0.7;
        if (d > FAR) {
          c.inst.visible = false;
          continue;
        }
        c.inst.visible = true;
        // full near the camera, a fifth at the far edge
        const k = d < 9 ? 1 : Math.max(0.07, 1 - (d - 9) / 55) ** 2.2;
        c.inst.count = Math.max(1, Math.round(c.full * k * lod));
        drawn += c.inst.count;
      }
      return drawn;
    },
  };
}
