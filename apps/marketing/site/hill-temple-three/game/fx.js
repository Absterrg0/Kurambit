// Combat effects: one pooled particle system (sparks, blood, dust, embers) drawn in a single
// call, and a sword trail ribbon. Everything runs on game time, so hit-stop freezes it too.
import * as THREE from "../vendor/three.module.js";

const MAX = 1200;

export function createFx() {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(MAX * 3);
  const col = new Float32Array(MAX * 4);
  const size = new Float32Array(MAX);
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("size", new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: { scale: { value: 600 } },
    vertexShader: /* glsl */ `
      attribute vec4 color; attribute float size; uniform float scale;
      varying vec4 vCol;
      void main() {
        vCol = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * scale / max(-mv.z, 0.1);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec4 vCol;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.15, length(d));
        // premultiplied: an additive particle has alpha 0 (it only adds light), a dusty one covers
        gl_FragColor = vec4(vCol.rgb * a, vCol.a * a);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.name = "fx";
  points.renderOrder = 10;
  const parts = [];
  for (let i = 0; i < MAX; i++)
    parts.push({ life: 0, max: 1, p: new THREE.Vector3(), v: new THREE.Vector3(), c: new THREE.Color(), add: true, s0: 0.05, s1: 0, g: 0, drag: 0 });
  let next = 0;
  const spawn = (o) => {
    const q = parts[next];
    next = (next + 1) % MAX;
    q.life = q.max = o.life;
    q.p.copy(o.p);
    q.v.copy(o.v);
    q.c.copy(o.c);
    q.add = o.add;
    q.s0 = o.s0;
    q.s1 = o.s1;
    q.g = o.g;
    q.drag = o.drag;
    q.a = o.a ?? 1;
  };
  const rand = (a, b) => a + Math.random() * (b - a);
  const dir = new THREE.Vector3();

  // the trail: the last positions of the blade's base and tip, as a fading ribbon
  const TN = 14;
  const trailGeo = new THREE.BufferGeometry();
  const tpos = new Float32Array(TN * 2 * 3);
  const talpha = new Float32Array(TN * 2);
  trailGeo.setAttribute("position", new THREE.BufferAttribute(tpos, 3).setUsage(THREE.DynamicDrawUsage));
  trailGeo.setAttribute("alpha", new THREE.BufferAttribute(talpha, 1).setUsage(THREE.DynamicDrawUsage));
  const tidx = [];
  for (let i = 0; i < TN - 1; i++) tidx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  trailGeo.setIndex(tidx);
  const trail = new THREE.Mesh(
    trailGeo,
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `attribute float alpha; varying float vA;
        void main() { vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `varying float vA;
        void main() { gl_FragColor = vec4(vec3(1.6, 1.25, 0.9) * vA * 0.55, 1.0); }`,
    }),
  );
  trail.frustumCulled = false;
  trail.name = "sword trail";
  const hist = [];
  let trailOn = 0;

  return {
    objects: [points, trail],
    /** Bright sparks off steel, and dark blood, at a hit. */
    hit(at, away, heavy = false) {
      for (let i = 0; i < (heavy ? 34 : 24); i++) {
        dir.set(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).normalize().addScaledVector(away, 0.9).normalize();
        spawn({ life: rand(0.18, 0.4), p: at, v: dir.clone().multiplyScalar(rand(4, 10)), c: new THREE.Color(4.0, 2.2, 0.9), add: true, s0: 0.035, s1: 0.0, g: 14, drag: 2.5 });
      }
      for (let i = 0; i < (heavy ? 26 : 16); i++) {
        dir.set(rand(-1, 1), rand(0, 1.2), rand(-1, 1)).normalize().addScaledVector(away, 1.3).normalize();
        spawn({ life: rand(0.4, 0.8), p: at, v: dir.clone().multiplyScalar(rand(1.5, 4.5)), c: new THREE.Color(0.16, 0.012, 0.008), a: 1, add: false, s0: 0.05, s1: 0.03, g: 9.8, drag: 1 });
      }
    },
    /** A dust puff where feet strike or a body lands. */
    dust(at, n = 10, spread = 0.6) {
      for (let i = 0; i < n; i++) {
        dir.set(rand(-1, 1), rand(0.1, 0.6), rand(-1, 1)).normalize();
        spawn({ life: rand(0.6, 1.3), p: at.clone().add(new THREE.Vector3(rand(-0.2, 0.2), 0.05, rand(-0.2, 0.2))), v: dir.clone().multiplyScalar(rand(0.4, 1.2) * spread * 2), c: new THREE.Color(0.30, 0.21, 0.13), a: 0.22, add: false, s0: 0.12, s1: 0.4, g: -0.15, drag: 2.2 });
      }
    },
    /** Warm motes drifting in the low sun, around a point. */
    motes(at, n = 1) {
      for (let i = 0; i < n; i++)
        spawn({ life: rand(3, 6), p: at.clone().add(new THREE.Vector3(rand(-14, 14), rand(0.3, 4), rand(-14, 14))), v: new THREE.Vector3(rand(0.1, 0.5), rand(-0.05, 0.12), rand(-0.1, 0.2)), c: new THREE.Color(0.9, 0.62, 0.34), add: true, s0: 0.011, s1: 0.011, g: 0, drag: 0 });
    },
    /** Feed the blade's base and tip every frame; the trail shows while `on`. */
    blade(base, tip, on) {
      hist.unshift([base.clone(), tip.clone()]);
      if (hist.length > TN) hist.length = TN;
      trailOn = on ? 1 : Math.max(0, trailOn - 0.25);
    },
    update(dt, camera) {
      let n = 0;
      for (const q of parts) {
        if (q.life <= 0) continue;
        q.life -= dt;
        if (q.life <= 0) continue;
        q.v.y -= q.g * dt;
        q.v.multiplyScalar(Math.max(0, 1 - q.drag * dt));
        q.p.addScaledVector(q.v, dt);
        const k = q.life / q.max;
        pos[n * 3] = q.p.x;
        pos[n * 3 + 1] = q.p.y;
        pos[n * 3 + 2] = q.p.z;
        const fade = Math.min(1, k * 3);
        col[n * 4] = q.c.r * fade * (q.add ? 1 : q.a);
        col[n * 4 + 1] = q.c.g * fade * (q.add ? 1 : q.a);
        col[n * 4 + 2] = q.c.b * fade * (q.add ? 1 : q.a);
        col[n * 4 + 3] = q.add ? 0 : q.a * fade;
        size[n] = q.s1 + (q.s0 - q.s1) * k;
        n++;
      }
      geo.setDrawRange(0, n);
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
      geo.attributes.size.needsUpdate = true;
      mat.uniforms.scale.value = window.innerHeight * 0.9;
      // trail
      for (let i = 0; i < TN; i++) {
        const h = hist[Math.min(i, hist.length - 1)];
        if (h === undefined) continue;
        h[0].toArray(tpos, i * 6);
        h[1].toArray(tpos, i * 6 + 3);
        const a = trailOn * (1 - i / (TN - 1)) ** 1.5;
        talpha[i * 2] = a * 0.15;
        talpha[i * 2 + 1] = a;
      }
      trailGeo.attributes.position.needsUpdate = true;
      trailGeo.attributes.alpha.needsUpdate = true;
      trail.visible = trailOn > 0.01;
    },
    clear() {
      for (const q of parts) q.life = 0;
      hist.length = 0;
      trailOn = 0;
    },
  };
}
