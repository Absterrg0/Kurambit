// The world, built once behind the loading screen and kept across runs: terrain, the stairs, the
// painted sky and mountains, the props and rocks, and the colliders the bodies slide along.
import * as THREE from "../vendor/three.module.js";
import { mergeGeometries } from "../vendor/addons/utils/BufferGeometryUtils.js";
import {
  GN,
  GX0,
  GZ0,
  PLATEAU_H,
  STAIR_A,
  STAIR_B,
  buildGrid,
  clearOfPath,
  grid,
  groundAt,
  path,
  rng,
  sample,
} from "./level.js";
import { propMaterials, reskin, terrainMaterial, tex, triplanar } from "./materials.js";

export const SUN_DIR = new THREE.Vector3(-1.0, 0.21, -0.62).normalize(); // toward the sun: low, ahead-left of the climb
export const SUN_COLOR = new THREE.Color(1.0, 0.78, 0.55);

/** Circles {x, z, r} and boxes {x, z, hx, hz, rot} the bodies cannot enter. */
export const colliders = { circles: [], boxes: [] };

/** A heightfield patch from the 1 m grid, every `step` metres, lowered by `drop`. */
function terrainPatch(g, x0, z0, x1, z1, step, drop) {
  const nx = Math.round((x1 - x0) / step);
  const nz = Math.round((z1 - z0) / step);
  const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0, nx, nz);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + (x0 + x1) / 2;
    const z = pos.getZ(i) + (z0 + z1) / 2;
    const at = Math.round(z - GZ0) * GN + Math.round(x - GX0);
    pos.setXYZ(i, x, g.h[at] - (typeof drop === "function" ? drop(x, z) : drop), z);
    col[i * 3] = g.path[at];
    col[i * 3 + 1] = g.grass[at];
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function terrain() {
  const g = buildGrid();
  const mat = terrainMaterial();
  const group = new THREE.Group();
  group.name = "terrain";
  // the play area at 1 m; the far hills at 4 m, a little lower, so the near patch covers it
  // where they overlap and no crack shows at the seam. Far triangles of 1 m were sub-pixel.
  const near = new THREE.Mesh(terrainPatch(g, -52, -80, 52, 56, 1, 0), mat);
  // under the near patch the far one sinks out of sight, so its coarse triangles never cut the path
  const sink = (x, z) => (x > -48 && x < 48 && z > -76 && z < 52 ? 6 : 0.12);
  const far = new THREE.Mesh(terrainPatch(g, GX0, GZ0, GX0 + GN - 1, GZ0 + GN - 1, 4, sink), mat);
  for (const m of [near, far]) {
    m.receiveShadow = true;
    m.castShadow = true;
    group.add(m);
  }
  return group;
}

function stairs(mats) {
  const a = STAIR_A;
  const b = STAIR_B;
  const n = 26;
  const run = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z).divideScalar(n);
  const runLen = Math.hypot(run.x, run.z);
  const group = new THREE.Group();
  const tread = new THREE.BoxGeometry(4.0, 1.2, runLen + 0.06);
  const treads = new THREE.InstancedMesh(tread, mats.steps, n);
  const m = new THREE.Matrix4();
  const r = rng(5);
  for (let i = 0; i < n; i++) {
    const top = a.y + ((b.y - a.y) * (i + 1)) / n;
    const c = { x: a.x + run.x * (i + 0.5), z: a.z + run.z * (i + 0.5) };
    m.makeRotationY(r.range(-0.006, 0.006)).setPosition(c.x, top - 0.6, c.z);
    treads.setMatrixAt(i, m);
  }
  treads.castShadow = treads.receiveShadow = true;
  treads.computeBoundingSphere();
  group.add(treads);
  const len = Math.hypot(b.z - a.z, b.y - a.y);
  const tilt = Math.atan2(b.y - a.y, -(b.z - a.z));
  const mid = new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  for (const sx of [-1, 1]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, len + 0.8), mats.stone);
    w.position.set(mid.x + sx * 2.25, mid.y + 0.25, mid.z);
    w.rotation.x = tilt;
    w.castShadow = w.receiveShadow = true;
    group.add(w);
    // the wall as a long thin box on x/z
    colliders.boxes.push({ x: mid.x + sx * 2.25, z: mid.z, hx: 0.25, hz: (Math.abs(b.z - a.z) + 0.8) / 2, rot: 0, minY: -1e9 });
  }
  return group;
}

/** The painted sky: a gradient dome, the low sun's glow, soft cloud bands. */
function sky() {
  const geo = new THREE.SphereGeometry(950, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      sunDir: { value: SUN_DIR },
      time: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 sunDir;
      uniform float time;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { s += a * n(p); p *= 2.03; a *= 0.5; } return s * 1.15; }
      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;
        float sd = max(dot(d, sunDir), 0.0);
        // linear HDR: zenith dusk blue, a peach horizon that warms toward the sun
        vec3 zenith = vec3(0.13, 0.18, 0.34);
        vec3 horizon = mix(vec3(1.05, 0.68, 0.42), vec3(1.5, 0.85, 0.42), pow(sd, 2.0));
        vec3 col = mix(horizon, zenith, pow(clamp(y, 0.0, 1.0), 0.55));
        col = mix(col, vec3(0.72, 0.55, 0.45), smoothstep(0.0, -0.15, y));
        // clouds: stretched bands, lit from the sun's side
        vec2 cp = d.xz / max(y + 0.12, 0.05) * 0.9;
        float c = fbm(cp * vec2(0.6, 1.8) + vec2(time * 0.004, 0.0));
        float cloud = smoothstep(0.52, 0.8, c) * smoothstep(0.02, 0.18, y) * (1.0 - smoothstep(0.55, 0.9, y));
        vec3 cloudCol = mix(vec3(0.72, 0.5, 0.42), vec3(1.8, 1.1, 0.6), pow(sd, 2.0));
        col = mix(col, cloudCol, cloud * 0.75);
        // the sun: a disc and its halo
        col += vec3(1.6, 1.0, 0.55) * pow(sd, 18.0) * 1.2 + vec3(1.0, 0.6, 0.3) * pow(sd, 4.0) * 0.35;
        col += vec3(20.0, 14.0, 8.0) * smoothstep(0.9993, 0.9997, sd);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "sky";
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * The painted mountains: two image layers on open cylinders around the level, mirrored on repeat
 * so the seams meet, tinted toward the sky by distance (aerial perspective).
 */
function backdrop() {
  const group = new THREE.Group();
  const layers = [
    { name: "sky_far", radius: 700, height: 230, base: -95, repeat: 3, tint: [1.05, 0.95, 0.98], haze: 0.35 },
    { name: "sky_mid", radius: 420, height: 120, base: -38, repeat: 4, tint: [0.92, 0.86, 0.82], haze: 0.42 },
  ];
  for (const L of layers) {
    const map = tex(L.name, true);
    map.wrapS = THREE.MirroredRepeatWrapping;
    map.wrapT = THREE.ClampToEdgeWrapping;
    map.repeat.set(L.repeat, 1);
    const geo = new THREE.CylinderGeometry(L.radius, L.radius, L.height, 128, 1, true);
    geo.translate(0, L.base + L.height / 2, -40);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      uniforms: { map: { value: map }, tint: { value: new THREE.Color(...L.tint) }, haze: { value: L.haze }, rep: { value: L.repeat }, sunDir: { value: SUN_DIR } },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vDir;
        void main() { vUv = uv; vDir = normalize(position - vec3(0.0, 0.0, -40.0));
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map; uniform vec3 tint; uniform float haze; uniform float rep; uniform vec3 sunDir;
        varying vec2 vUv; varying vec3 vDir;
        void main() {
          vec2 uv = vec2(vUv.x * rep, vUv.y);
          vec4 c = texture2D(map, uv);
          if (c.a < 0.02) discard;
          vec3 col = pow(c.rgb, vec3(2.2)) * tint;
          // warm the side facing the sun, haze toward the horizon colour
          float sd = max(dot(normalize(vec3(vDir.x, 0.0, vDir.z)), normalize(vec3(sunDir.x, 0.0, sunDir.z))), 0.0);
          vec3 hazeCol = mix(vec3(0.85, 0.68, 0.58), vec3(1.2, 0.85, 0.6), pow(sd, 3.0));
          col = mix(col, hazeCol, haze + 0.25 * pow(sd, 4.0)) * 1.15;
          gl_FragColor = vec4(col, c.a);
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = L.name;
    mesh.frustumCulled = false;
    mesh.renderOrder = -5;
    group.add(mesh);
  }
  return group;
}

const ground = (x, z) => groundAt(x, z);

function instanceSet(source, transforms, { cast = true } = {}) {
  // one InstancedMesh per mesh of the model, every instance placed by its transform
  const out = new THREE.Group();
  source.updateMatrixWorld(true);
  source.traverse((o) => {
    if (!o.isMesh) return;
    const inst = new THREE.InstancedMesh(o.geometry, o.material, transforms.length);
    const local = o.matrixWorld.clone();
    transforms.forEach((t, i) => inst.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(t, local)));
    inst.castShadow = cast;
    inst.receiveShadow = true;
    inst.computeBoundingSphere();
    out.add(inst);
  });
  return out;
}
const T = (x, y, z, yaw = 0, s = 1, tilt = 0) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, yaw, 0)),
    new THREE.Vector3(s, s, s),
  );

/**
 * The world: everything static, in one group. `models` maps names (gate, temple, lantern, lion,
 * pine_0.., tree_0.., boulder_02, rock_moss) to loaded scenes.
 */
export function buildWorld(models) {
  colliders.circles.length = 0;
  colliders.boxes.length = 0;
  const world = new THREE.Group();
  world.name = "world";
  const mats = propMaterials();
  world.add(terrain(), stairs(mats), sky(), backdrop());
  const r = rng(7);
  const copy = (name) => {
    const m = models[name].clone(true);
    reskin(m, mats);
    m.traverse((o) => {
      if (o.isMesh) o.castShadow = o.receiveShadow = true;
    });
    return m;
  };

  // the gate across the path
  const gate = copy("gate");
  gate.position.set(0, ground(0, 26) - 0.15, 26);
  world.add(gate);
  for (const sx of [-1, 1]) colliders.circles.push({ x: sx * 2.3, z: 26, r: 0.45 });

  // the temple on the plateau, and its court
  const temple = copy("temple");
  temple.position.set(0, PLATEAU_H - 0.05, -50);
  world.add(temple);
  colliders.boxes.push({ x: 0, z: -51.5, hx: 6.2, hz: 4.6, rot: 0 });

  // lions: a pair at the stair foot and a pair before the temple, mirrored
  const lions = [];
  for (const sx of [-1, 1]) {
    lions.push([sx * 3.3, STAIR_A.z + 1.2, sx * -0.15, 1.05, sx]);
    lions.push([sx * 3.4, -44.5, sx * -0.1, 0.95, sx]);
  }
  for (const [x, z, yaw, s, sx] of lions) {
    const l = copy("lion");
    l.position.set(x, z < -40 ? PLATEAU_H : ground(x, z) - 0.1, z);
    l.rotation.y = yaw;
    l.scale.set(s * sx * -1, s, s);
    world.add(l);
    colliders.circles.push({ x, z, r: 0.75 * s });
  }
  // lanterns: on the stair walls, before the temple, and along the path on alternating sides
  const lanterns = [];
  for (const k of [0.25, 0.55, 0.85])
    for (const sx of [-1, 1]) {
      const y = STAIR_A.y + (STAIR_B.y - STAIR_A.y) * k;
      const z = STAIR_A.z + (STAIR_B.z - STAIR_A.z) * k;
      lanterns.push(T(sx * 2.25, y + 0.55, z, 0, 0.7));
    }
  for (const sx of [-1, 1]) {
    lanterns.push(T(sx * 3.2, PLATEAU_H, -40));
    colliders.circles.push({ x: sx * 3.2, z: -40, r: 0.3 });
  }
  let k = 0;
  for (let i = 6; i < path.length - 4; i += 9) {
    const p = path[i];
    const q = path[i + 1];
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const l = Math.hypot(dx, dz);
    const side = k % 2 === 0 ? 2.7 : -2.7;
    const x = p.x + (-dz / l) * side;
    const z = p.z + (dx / l) * side;
    lanterns.push(T(x, ground(x, z) - 0.05, z, r.range(-0.2, 0.2)));
    colliders.circles.push({ x, z, r: 0.28 });
    k++;
  }
  const lanternSet = instanceSet(copy("lantern"), lanterns);
  lanternSet.name = "lanterns";
  world.add(lanternSet);
  world.userData.lanterns = lanterns.map((m) => new THREE.Vector3().setFromMatrixPosition(m));

  // rocks: two Poly Haven scans, near the path more often
  const rockKinds = ["boulder_02", "rock_moss"];
  const rocks = [[], []];
  for (let placed = 0, tries = 0; placed < 46 && tries < 3000; tries++) {
    const x = r.range(-45, 45);
    const z = r.range(-70, 40);
    if (!clearOfPath(x, z, 3.2)) continue;
    const near = sample(grid.d, x, z) < 9;
    if (!near && r() < 0.6) continue;
    const kind = r.int(0, 1);
    const s = kind === 0 ? r.range(0.8, 2.2) : r.range(0.4, 0.9);
    rocks[kind].push(T(x, ground(x, z) - 0.2 * s, z, r.range(0, Math.PI * 2), s, r.range(-0.15, 0.15)));
    colliders.circles.push({ x, z, r: kind === 0 ? 0.9 * s : 2.2 * s });
    placed++;
  }
  // small stones along both path edges, so the path reads as laid, not painted
  const edge = [];
  for (let i = 0; i < path.length - 1; i++) {
    const p = path[i];
    const q = path[i + 1];
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const l = Math.hypot(dx, dz);
    for (const sgn of [-1, 1])
      for (let n = 0; n < 2; n++) {
        if (r() < 0.35) continue;
        const t = r();
        const off = sgn * r.range(1.75, 2.3);
        const x = p.x + dx * t + (-dz / l) * off;
        const z = p.z + dz * t + (dx / l) * off;
        const s = r.range(0.1, 0.24);
        edge.push(T(x, ground(x, z) - 0.15 * s, z, r.range(0, Math.PI * 2), s, r.range(-0.3, 0.3)));
      }
  }
  rockKinds.forEach((kind, i) => world.add(instanceSet(models[kind], rocks[i])));
  // the edge stones: a 430-triangle cut of the same scan, wearing the scan's own material
  const pebble = models.pebble.clone(true);
  let rockMat = null;
  models.boulder_02.traverse((o) => o.isMesh && (rockMat = o.material));
  pebble.traverse((o) => o.isMesh && (o.material = rockMat));
  world.add(instanceSet(pebble, edge, { cast: false }));

  // bare trees and wind-bent pines
  const trees = [[], [], []];
  for (let placed = 0, tries = 0; placed < 16 && tries < 2000; tries++) {
    const x = r.range(-40, 40);
    const z = r.range(-62, 34);
    const d = sample(grid.d, x, z);
    if (d < 5 || d > 24 || !clearOfPath(x, z, 5)) continue;
    trees[r.int(0, 2)].push(T(x, ground(x, z) - 0.2, z, r.range(0, Math.PI * 2), r.range(0.9, 1.5)));
    colliders.circles.push({ x, z, r: 0.35 });
    placed++;
  }
  trees.forEach((list, i) => list.length > 0 && world.add(instanceSet(copy(`tree_${i}`), list)));
  const pines = [[], [], []];
  const spots = [[-9, -44], [10, -52], [-12, -56], [13, -40], [-16, -20], [18, -8], [-20, 6], [16, 20], [-14, 38], [22, -30], [-28, -34], [27, 8], [-30, 22], [32, -50]];
  spots.forEach(([x, z], i) => {
    if (!clearOfPath(x, z, 5)) return;
    pines[i % 3].push(T(x, ground(x, z) - 0.25, z, r.range(0, Math.PI * 2), r.range(0.9, 1.3)));
    colliders.circles.push({ x, z, r: 0.4 });
  });
  pines.forEach((list, i) => list.length > 0 && world.add(instanceSet(copy(`pine_${i}`), list)));

  return world;
}

const _v = new THREE.Vector2();
/** Pushes a body (x/z, radius) out of every collider; returns whether it touched one. */
export function collide(pos, radius) {
  let hit = false;
  for (const c of colliders.circles) {
    const dx = pos.x - c.x;
    const dz = pos.z - c.z;
    const min = c.r + radius;
    const d2 = dx * dx + dz * dz;
    if (d2 < min * min && d2 > 1e-8) {
      const d = Math.sqrt(d2);
      pos.x = c.x + (dx / d) * min;
      pos.z = c.z + (dz / d) * min;
      hit = true;
    }
  }
  for (const b of colliders.boxes) {
    _v.set(pos.x - b.x, pos.z - b.z);
    const qx = Math.max(Math.abs(_v.x) - b.hx, 0);
    const qz = Math.max(Math.abs(_v.y) - b.hz, 0);
    const out = Math.hypot(qx, qz);
    if (out < radius) {
      if (out > 1e-6) {
        const push = (radius - out) / out;
        pos.x += Math.sign(_v.x) * qx * push;
        pos.z += Math.sign(_v.y) * qz * push;
      } else {
        // inside: out along the shallow axis
        const px = b.hx + radius - Math.abs(_v.x);
        const pz = b.hz + radius - Math.abs(_v.y);
        if (px < pz) pos.x += Math.sign(_v.x || 1) * px;
        else pos.z += Math.sign(_v.y || 1) * pz;
      }
      hit = true;
    }
  }
  // the world's edge
  pos.x = Math.min(Math.max(pos.x, -60), 60);
  pos.z = Math.min(Math.max(pos.z, -62), 46);
  return hit;
}

export { ground, triplanar };
