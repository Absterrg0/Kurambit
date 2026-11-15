// Open water: a sea, a lake or a harbour that mirrors the world and the sky, with the sun's
// glitter on it, foam on its crests and a wake behind whatever moves through it. It is three's
// Water (three/addons/objects/Water.js) with foam and wakes added, lit by the look's sun.
//
//   import { ocean } from "./shell/water.js";
//   const sea = ocean(ctx, { colour: "#1fa3a8", deep: "#0a3f6e" }); // a sea to the horizon at
//     // y 0: colour looking down into it, deep toward the horizon
//   const stop = sea.wake(boat, { width: 3 });      // foam behind it as it moves (stop() ends it); stern:
//                                                   // how far behind its centre it starts (m)
//   const lake = ocean(ctx, { size: 200, colour: "#2a4a3a", waves: 0.4, foam: 0 });
//   // options: size (m across), colour, waves (how rough, 1), wave (the swell's length, 1:
//   // bigger is longer), foam (crests, 0..1, 0.35), glitter (the sun on it, 1), clear (how much
//   // of its own colour shows under the reflection, 0..1, 0.6: a tropical shallow high, a dark
//   // lake low), mirror (how much it reflects looking straight down, 0.04; 0.3 a glassy pond),
//   // at (y)
//   boat.position.y = sea.height(boat.position.x, boat.position.z); // ride the swell
//   sea.mesh;                                       // the Mesh, in ctx.scene
//
// What it costs follows LOOK.quality: high mirrors the world at 512 px, low at 256. The mirror
// draws the scene a second time each frame; a game that needs every millisecond keeps
// `quality: "low"`. The swell is the same in the picture and in height(), and fades into a
// flat sea far off; waves 0 is a millpond.
import * as THREE from "../vendor/three.module.js";
import { Water } from "three/addons/objects/Water.js";

const MAX_WAKE_POINTS = 48;
const WAKE_LIFE_S = 9;
const WAKE_EVERY_M = 1.5;

let normals = null;
// Each ctx's oceans (a run's, the title's), stepped with it; they go when the ctx does.
const oceans = new WeakMap();

/** The shell's side: steps a ctx's seas with that ctx's own step. */
export const waterShell = {
  update(dt, ctx) {
    for (const sea of oceans.get(ctx) ?? []) sea.advance(dt);
  },
};

// The swell: a few long crossing waves, the same in the shader and in height(), so what floats
// on the water rides what is drawn. [direction x, direction z, wavelength m, height m]; each
// travels at deep water's speed for its length.
const SWELL = [
  [1, 0.25, 31, 0.22],
  [0.6, 0.8, 17, 0.14],
  [-0.4, 0.9, 9.5, 0.08],
  [0.9, -0.45, 5.5, 0.05],
];
const swellGlsl = (scale) => {
  const terms = SWELL.map(([dx, dz, length, height]) => {
    const n = Math.hypot(dx, dz);
    const k = (Math.PI * 2) / (length * scale.length);
    const w = Math.sqrt(9.8 * k);
    return `${(height * scale.height).toFixed(4)} * sin( dot( vec2( ${(dx / n).toFixed(4)}, ${(dz / n).toFixed(4)} ), p ) * ${k.toFixed(5)} + swellTime * ${w.toFixed(5)} )`;
  });
  return `float lookSwell( vec2 p ) { return ${terms.join(" + ")}; }`;
};

/** A disc of rings, close near its centre and far apart at its rim: it follows the camera. */
function seaDisc(radius) {
  const around = 96;
  const rings = [0];
  for (let r = 0.75; r < radius; r *= 1.075) rings.push(r);
  rings.push(radius);
  const positions = [];
  const index = [];
  positions.push(0, 0, 0);
  for (let i = 1; i < rings.length; i += 1)
    for (let j = 0; j < around; j += 1) {
      const a = (j / around) * Math.PI * 2;
      positions.push(Math.cos(a) * rings[i], Math.sin(a) * rings[i], 0);
    }
  const at = (ring, j) => (ring === 0 ? 0 : 1 + (ring - 1) * around + (j % around));
  for (let i = 0; i < rings.length - 1; i += 1)
    for (let j = 0; j < around; j += 1) {
      if (i === 0) index.push(0, at(1, j), at(1, j + 1));
      else
        index.push(
          at(i, j),
          at(i + 1, j),
          at(i, j + 1),
          at(i, j + 1),
          at(i + 1, j),
          at(i + 1, j + 1),
        );
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(
      positions.map((_, i) => (i % 3 === 2 ? 1 : 0)),
      3,
    ),
  );
  geometry.setIndex(index);
  return geometry;
}

/**
 * A tileable water normal map, made once: crossing swells of whole-tile wavelengths (so it
 * repeats with no seam) and a little chop, as the normal map three's example ships would be.
 */
function waterNormals() {
  if (normals !== null) return normals;
  const size = 256;
  const height = new Float32Array(size * size);
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const waves = [];
  for (let i = 0; i < 28; i += 1) {
    const k = 1 + Math.floor(rand() * (i < 8 ? 4 : 14));
    const a = rand() * Math.PI * 2;
    waves.push({
      kx: Math.round(Math.cos(a) * k),
      ky: Math.round(Math.sin(a) * k),
      amp: 1 / (k * 0.7 + 1),
      phase: rand() * Math.PI * 2,
    });
  }
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      let h = 0;
      for (const w of waves)
        h += w.amp * Math.sin(((w.kx * x + w.ky * y) / size) * Math.PI * 2 + w.phase);
      height[y * size + x] = h;
    }
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 2.6;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 2.6;
      const n = new THREE.Vector3(-dx, -dy, 1).normalize();
      const i = (y * size + x) * 4;
      data[i] = (n.x * 0.5 + 0.5) * 255;
      data[i + 1] = (n.y * 0.5 + 0.5) * 255;
      data[i + 2] = (n.z * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  normals = new THREE.DataTexture(data, size, size);
  normals.wrapS = normals.wrapT = THREE.RepeatWrapping;
  normals.generateMipmaps = true;
  normals.minFilter = THREE.LinearMipmapLinearFilter;
  normals.needsUpdate = true;
  return normals;
}

// Foam: on the crests, where the normal map tilts most, and along each wake's trail of points,
// in two bands at the trail's spreading edge and churned water down its middle.
const FOAM_PARS = /* glsl */ `
uniform float swellTime;
SWELL_FUNCTION
uniform vec4 wakePoints[${MAX_WAKE_POINTS}];
uniform float wakeLinks[${MAX_WAKE_POINTS}];
uniform float crestFoam;
uniform float glitter;
uniform float body;
uniform vec3 deepColour;
float foamHash( vec2 p ) { return fract( sin( dot( p, vec2( 41.3, 289.1 ) ) ) * 43758.5453 ); }
float foamNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( foamHash( i ), foamHash( i + vec2( 1, 0 ) ), u.x ), mix( foamHash( i + vec2( 0, 1 ) ), foamHash( i + vec2( 1, 1 ) ), u.x ), u.y );
}
float wakeFoam( vec2 p ) {
  // The nearest point of the trail decides: measured once, the wake is one smooth V that widens
  // with age, never a string of beads.
  float best = 1e9, age = 0.0, width = 1.0;
  for ( int i = 0; i < ${MAX_WAKE_POINTS - 1}; i ++ ) {
    if ( wakeLinks[ i ] < 0.5 ) continue;
    vec4 a = wakePoints[ i ];
    vec4 b = wakePoints[ i + 1 ];
    vec2 ab = b.xy - a.xy;
    float t = clamp( dot( p - a.xy, ab ) / max( dot( ab, ab ), 1e-4 ), 0.0, 1.0 );
    float d = length( p - a.xy - ab * t );
    if ( d < best ) { best = d; age = mix( a.z, b.z, t ); width = mix( a.w, b.w, t ); }
  }
  if ( best > 1e8 ) return 0.0;
  float spread = width * ( 0.5 + age * 0.55 );
  float fade = exp( - age / 3.0 );
  // Fresh water beside the hull rolls well out from it; older wake narrows to two lines.
  float fresh = exp( - age / 0.8 );
  float edge = smoothstep( spread * ( 0.3 + 0.5 * fresh ), 0.0, abs( best - spread ) ) * 0.9;
  float churn = smoothstep( spread * ( 0.8 + 0.6 * fresh ), 0.0, best ) * exp( - age / 1.5 );
  return max( edge, churn ) * fade;
}`;
// The swell's slope tilts the surface the normal map ripples; its crests carry more foam.
const SWELL_NORMAL = /* glsl */ `
  vec3 surfaceNormal = normalize( noise.xzy * vec3( 1.5, 1.0, 1.5 ) );
  {
    float e = 0.25;
    float hx = lookSwell( worldPosition.xz + vec2( e, 0.0 ) ) - lookSwell( worldPosition.xz - vec2( e, 0.0 ) );
    float hz = lookSwell( worldPosition.xz + vec2( 0.0, e ) ) - lookSwell( worldPosition.xz - vec2( 0.0, e ) );
    surfaceNormal = normalize( surfaceNormal + vec3( - hx, 0.0, - hz ) / ( 2.0 * e ) * 1.4 );
  }`;
const SWELL_VERTEX = /* glsl */ `
  vec4 lookWorld = modelMatrix * vec4( position, 1.0 );
  // Fades out far away, where the disc's rings are too coarse to draw a wave.
  lookWorld.y += lookSwell( lookWorld.xz ) * ( 1.0 - smoothstep( 120.0, 260.0, distance( lookWorld.xz, cameraPosition.xz ) ) );
  mirrorCoord = lookWorld;
  worldPosition = lookWorld;
  mirrorCoord = textureMatrix * mirrorCoord;
  vec4 mvPosition = viewMatrix * lookWorld;
  gl_Position = projectionMatrix * mvPosition;`;
const FOAM_MIX = /* glsl */ `
  // The water's own colour under the mirror: turquoise looking down into it, deep blue toward the
  // horizon where the eye runs through more water, as a tropical sea reads; a mirror never.
  float looking = clamp( eyeDirection.y, 0.0, 1.0 );
  float away = smoothstep( 40.0, 700.0, distance );
  vec3 waterBody = mix( deepColour, waterColor, smoothstep( 0.05, 0.6, looking ) * ( 1.0 - away * 0.7 ) );
  albedo = mix( albedo, waterBody * ( 0.5 + diffuseLight * 0.45 ) * getShadowMask() + specularLight * 0.5, body * ( 0.45 + 0.55 * ( 1.0 - reflectance ) ) );
  // Sun glitter: a finer ripple than the swell catches the sun in pinpoints.
  vec3 fine = normalize( texture2D( normalSampler, worldPosition.xz * size * 0.031 + vec2( time * 0.11, - time * 0.07 ) ).xzy * 2.0 - 1.0 + surfaceNormal );
  float glint = pow( max( dot( reflect( - sunDirection, fine ), eyeDirection ), 0.0 ), 900.0 );
  albedo += sunColor * glint * 6.0 * glitter * getShadowMask();
  // Whitecaps where the surface tilts most, scattered by a slow field so they come and go in
  // patches; the wake is laced by the same small waves.
  float lookFoam = crestFoam * smoothstep( 0.3, 0.55, length( surfaceNormal.xz ) )
    * smoothstep( 0.45, 0.8, foamNoise( worldPosition.xz * 0.05 + time * 0.02 ) );
  // Lace: foam breaks into a fine net at a smaller scale, as real foam tears.
  lookFoam *= 0.45 + 0.55 * smoothstep( 0.2, 0.75, foamNoise( worldPosition.xz * 2.3 ) * 0.6 + foamNoise( worldPosition.xz * 7.1 ) * 0.4 );
  float lookWake = wakeFoam( worldPosition.xz );
  lookWake *= 0.6 + 0.4 * smoothstep( 0.15, 0.7, foamNoise( worldPosition.xz * 3.7 ) );
  lookWake *= 0.55 + 0.45 * smoothstep( 0.05, 0.25, length( surfaceNormal.xz ) );
  lookFoam = max( lookFoam, lookWake );
  // Foam is the brightest thing on the water: white, lit, a little blue in its shade.
  vec3 foamColour = mix( vec3( 0.62, 0.72, 0.78 ), vec3( 1.0 ), getShadowMask() ) * ( 0.85 + diffuseLight * 0.3 );
  albedo = mix( albedo, foamColour, clamp( lookFoam * 1.3, 0.0, 1.0 ) );
  albedo += specularLight * reflectionSample * ( glitter - 1.0 ) * ( 1.0 - lookFoam );
  vec3 outgoingLight = albedo;`;

/** A sheet of water in ctx.scene, with `wake(object, options)` to trail foam behind a thing. */
export function ocean(
  ctx,
  {
    size = 4000,
    colour = "#1fa3a8",
    deep = "#0a3f6e",
    waves = 1,
    wave = 1,
    foam = 0.35,
    glitter = 1,
    clear = 0.6,
    mirror = 0.04,
    at = 0,
  } = {},
) {
  const look = ctx.look.settings;
  const low = look.quality === "low";
  const sun = look.sun.direction;
  const water = new Water(seaDisc(size / 2), {
    textureWidth: low ? 256 : 512,
    textureHeight: low ? 256 : 512,
    waterNormals: waterNormals(),
    sunDirection: new THREE.Vector3(sun.x, sun.y, sun.z).normalize(),
    sunColor: look.sun.color,
    waterColor: new THREE.Color(colour),
    distortionScale: 3.2 * waves,
    fog: ctx.scene.fog !== null || look.fog !== false,
  });
  const material = water.material;
  // One tile of the normal map is about 25 m of sea at wave 1.
  material.uniforms.size.value = 4 / Math.max(wave, 0.05);
  const points = Array.from({ length: MAX_WAKE_POINTS }, () => new THREE.Vector4());
  const links = Array.from({ length: MAX_WAKE_POINTS }, () => 0);
  material.uniforms.wakePoints = { value: points };
  material.uniforms.wakeLinks = { value: links };
  material.uniforms.crestFoam = { value: foam };
  material.uniforms.glitter = { value: glitter };
  material.uniforms.body = { value: clear };
  material.uniforms.deepColour = { value: new THREE.Color(deep) };
  const scale = { length: Math.max(wave, 0.05), height: waves };
  const swell = swellGlsl(scale);
  material.uniforms.swellTime = { value: 0 };
  // Water reflects about 2% looking straight down; three's example uses 30%, which turns any sea
  // into a mirror of the sky. `mirror` sets it.
  material.uniforms.rf0 = { value: mirror };
  material.fragmentShader = material.fragmentShader
    .replace("float rf0 = 0.3;", "")
    // A rough sea's facets tilt every way, so even at a low angle part of it shows its own colour.
    .replace(
      "float reflectance = rf0 + ( 1.0 - rf0 ) * pow( ( 1.0 - theta ), 5.0 );",
      "float reflectance = ( rf0 + ( 1.0 - rf0 ) * pow( ( 1.0 - theta ), 5.0 ) ) * ( 1.0 - 0.35 * clamp( length( surfaceNormal.xz ) * 3.0 + 0.6, 0.0, 1.0 ) );",
    )
    .replace(
      "void main() {",
      `uniform float rf0;\n${FOAM_PARS.replace("SWELL_FUNCTION", swell)}\nvoid main() {`,
    )
    .replace("vec3 surfaceNormal = normalize( noise.xzy * vec3( 1.5, 1.0, 1.5 ) );", SWELL_NORMAL)
    .replace("vec3 outgoingLight = albedo;", FOAM_MIX);
  material.vertexShader = material.vertexShader
    .replace("void main() {", `uniform float swellTime;\n${swell}\nvoid main() {`)
    .replace(
      /mirrorCoord = modelMatrix \* vec4\( position, 1\.0 \);[\s\S]*?gl_Position = projectionMatrix \* mvPosition;/,
      SWELL_VERTEX,
    );
  water.rotation.x = -Math.PI / 2;
  water.position.y = at;
  // Water shows the sky more than it shows shade: a long low-sun shadow on it reads as a dark
  // slab, and the sun's shadow box edge as a seam on the sea.
  water.receiveShadow = false;
  water.name = "Water";
  ctx.scene.add(water);

  // Each wake keeps its own run of points; all of them share the shader's list.
  const wakes = [];
  // Game time: the shell steps every ocean with play (waterShell), so a replay's swell and wakes
  // are the live play's, and a paused game's sea holds still.
  let clock = 0;
  let drawnAt = 0;
  if (!oceans.has(ctx)) oceans.set(ctx, new Set());
  oceans.get(ctx).add({ advance: (dt) => (clock += dt) });
  const reflect = water.onBeforeRender;
  water.onBeforeRender = (renderer, scene, camera, ...rest) => {
    const dt = clock - drawnAt;
    drawnAt = clock;
    material.uniforms.time.value = clock * 0.6 * waves;
    material.uniforms.swellTime.value = clock;
    // The disc follows the camera; the waves stay where they are in the world.
    camera.getWorldPosition(eye);
    water.position.x = eye.x;
    water.position.z = eye.z;
    water.updateMatrixWorld();
    let n = 0;
    for (const w of wakes) {
      w.object.getWorldPosition(stern);
      w.object.getWorldDirection(ahead);
      stern.addScaledVector(ahead, -w.stern);
      const head = w.trail.at(-1);
      if (head === undefined || Math.hypot(stern.x - head.x, stern.z - head.z) > WAKE_EVERY_M)
        w.trail.push({ x: stern.x, z: stern.z, born: clock });
      while (w.trail.length > 0 && clock - w.trail[0].born > WAKE_LIFE_S) w.trail.shift();
      // How fast it moves now, eased: the wash along its sides and the bow wave grow with it.
      const moved = w.last === null ? 0 : Math.hypot(stern.x - w.last.x, stern.z - w.last.z);
      w.last = { x: stern.x, z: stern.z };
      if (dt > 0) w.speed += (moved / dt - w.speed) * Math.min(1, dt * 3);
      const way = Math.min(1, w.speed / 5);
      // The newest point follows the stern, so the wake starts right behind it; one more runs
      // along the hull to the bow, so the water washes white along its sides.
      const bow = { x: stern.x + ahead.x * w.stern * 2, z: stern.z + ahead.z * w.stern * 2 };
      const shown = [
        ...w.trail.map((p) => ({ ...p, width: w.width })),
        { x: stern.x, z: stern.z, born: clock, width: w.width * way },
        ...(w.stern > 0 ? [{ ...bow, born: clock, width: w.width * 0.8 * way }] : []),
      ];
      for (let i = Math.max(0, shown.length - (MAX_WAKE_POINTS - n)); i < shown.length; i += 1) {
        const p = shown[i];
        points[n].set(p.x, p.z, clock - p.born, p.width);
        links[n] = i < shown.length - 1 ? 1 : 0;
        n += 1;
      }
    }
    for (let i = n; i < MAX_WAKE_POINTS; i += 1) links[i] = 0;
    reflect(renderer, scene, camera, ...rest);
  };
  const stern = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const eye = new THREE.Vector3();
  const swellAt = (x, z) => {
    let h = 0;
    for (const [dx, dz, length, height] of SWELL) {
      const n = Math.hypot(dx, dz);
      const k = (Math.PI * 2) / (length * scale.length);
      h +=
        height *
        scale.height *
        Math.sin(((dx / n) * x + (dz / n) * z) * k + clock * Math.sqrt(9.8 * k));
    }
    return h;
  };
  return {
    mesh: water,
    /** The water's height at a point now (m above `at`): float a boat on it, tilt it by two. */
    height: (x, z) => at + swellAt(x, z),
    /**
     * Foam behind `object` as it moves, and along its sides to its bow (taken as far ahead of its
     * centre as the stern is behind): `width` metres across at the stern, `stern` metres behind
     * its centre. The wash grows with its speed; at rest it leaves none.
     */
    wake(object, { width = 2, stern: behind = 0 } = {}) {
      const wake = { object, width, stern: behind, trail: [], last: null, speed: 0 };
      wakes.push(wake);
      // The way out: a sunk or removed boat stops feeding the shared trail.
      return () => {
        const at = wakes.indexOf(wake);
        if (at >= 0) wakes.splice(at, 1);
      };
    },
  };
}
