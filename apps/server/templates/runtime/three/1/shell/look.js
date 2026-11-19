// The look every frame goes through: the light, the sky, the fog and the post chain,
// set for the game's own mood. A preset ("day", "golden" for golden hour, "night",
// "interior", "flat" for stylised) is only a starting point for each part, which
// main.js sets as the game needs. A game with no LOOK gets "plain": the renderer draws
// the scene as the game built it (its background, lights, fog and ctx.renderer's tone
// mapping), adding nothing; a LOOK that names no preset starts from a neutral "day":
//
//   export const LOOK = {
//     preset: "<one of them>", // optional
//     exposure: 1.1,
//     toneMapping: "aces",    // "neutral" keeps base colours, "agx" and "aces" are filmic, "none"
//     environment: "sky",     // the light around the scene: "sky" (the preset's sky, or the scene's
//                             // own background texture), "room" (a studio interior), false: none
//     ambient: 1,             // that light's strength
//     sky: { top: 0x4a6ea8, horizon: 0xf2b27a, ground: 0x5a4a3c, light: 0.45 }, // the drawn sky;
//                             // its light is the same sky at `light` saturation
//     // physical: true draws the sky by scattering from the sun instead (three's Sky:
//     // { turbidity: 2, rayleigh: 1.2, mie: 0.005 } to tune it), and clouds lays a cloud deck
//     // over either: { cover: 0.4 (0..1), scale: 1 (bigger is smaller clouds), shade: 0x8f9aab }.
//     // Both are drawn once into the backdrop and the light, so they cost nothing per frame.
//     quality: "auto",        // "high", "low": how much the water, clouds, shadows and post
//                             // spend (low: no ao, a smaller shadow map, coarser clouds and
//                             // mirror); auto is high on a GPU, low drawn in software
//     sun: { direction: { x: -0.6, y: 0.22, z: 0.75 }, color: 0xffc98a, intensity: 3.6 },
//     fog: { density: 0.008, height: 0.05, color: 0xf2b27a }, // height fog: thick low, thin high;
//                             // false: none
//     shadows: true,
//     ao: { radius: 1.5, intensity: 2.5 },        // ambient occlusion in corners and contacts; false
//     bloom: { strength: 0.5, threshold: 0.95 },  // colours above the threshold glow; false
//     grade: { saturation: 1.08, contrast: 1.05, warmth: 0.05, vignette: 0.5 },
//     resolution: "adaptive", // the render scale follows the GPU's time to hold 60 fps, with a
//                             // sharpen; or a fixed scale such as 1 or 0.75
//     ground: true,           // a large plain floor (one colour, no texture) gets soft patches of
//                             // light and dark, as a field or floor has; false: drawn flat
//   };
//
// "day" and "flat" draw straight to the canvas with its MSAA, the tone mapping and
// the grade inside the materials: they cost what a plain three.js frame costs.
// "golden", "night" and "interior", or any look that asks for ao or bloom, draw
// through one merged post chain (AO, bloom, tone mapping, the grade, SMAA) over a
// half-float frame, with no MSAA under it; a browser drawing in software always
// gets the straight path. The
// sky is drawn behind the scene and lights it (an environment probe), unless
// the game sets scene.background (a texture there becomes the probe) or
// scene.environment itself; below the horizon it is distant ground in haze. The look's fog is set when the game sets none;
// three.js's own Fog and FogExp2 still work as documented.
//
// Through an orthographic camera with no preset and no toneMapping named, the
// frame draws straight and untouched, so a 2D or pixel-art game's sprites keep
// their files' exact colours (with LOOK = { environment: false, shadows: false }),
// over the sky's horizon colour unless the game sets scene.background.
//
// A sun whose soft shadows follow the player:
//   const sun = ctx.look.sun({ follow: ctx.player, size: 30 }); // a DirectionalLight, in the scene
// A static world's shadow, rendered once instead of every frame (do it after
// building the level, before adding anything that moves; the sun's own shadow
// then holds only what moves, which is far cheaper on a big level):
//   ctx.look.bake(level.root);              // or bake(group, { bounds: box3, size: 4096 })
// Models from ASSETS already cast and receive shadows; a mesh you build needs
// mesh.castShadow = true (and receiveShadow for the ground). A material with
// its own onBeforeCompile calls lookShader(shader) first, so the fog and the
// baked shadow still reach it.
import * as THREE from "../vendor/three.module.js";

const TONE = {
  neutral: THREE.NeutralToneMapping,
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  none: THREE.NoToneMapping,
};
const ENVIRONMENTS = new Set(["sky", "room", false]);

const PRESETS = {
  day: {
    toneMapping: "neutral",
    exposure: 1,
    ambient: 1,
    // A clear day reads deep and crisp: a saturated sky, a thin bluish haze, a little contrast.
    sky: { top: 0x3f7fd6, horizon: 0xc2d8ee, ground: 0x3a3936 },
    sun: { direction: { x: -0.45, y: 0.8, z: 0.4 }, color: 0xfff2de, intensity: 2.6 },
    fog: { density: 0.0022, height: 0.06 },
    ao: false,
    bloom: false,
    grade: { saturation: 1.1, contrast: 1.07, warmth: 0.01, vignette: 0.2 },
  },
  golden: {
    toneMapping: "aces",
    exposure: 1,
    ambient: 0.9,
    // Warm light over a clear sky: the haze thin enough that islands a few hundred metres off
    // keep their colour, the sky's top still blue.
    sky: { top: 0x3d64a8, horizon: 0xeeb07e, ground: 0x3a3029 },
    sun: { direction: { x: -0.6, y: 0.22, z: 0.75 }, color: 0xffc58a, intensity: 3.4 },
    fog: { density: 0.0045, height: 0.05 },
    ao: { radius: 1.5, intensity: 2.4 },
    bloom: { strength: 0.5, threshold: 0.95 },
    grade: { saturation: 1.1, contrast: 1.08, warmth: 0.04, vignette: 0.4 },
  },
  // Night must still read: a warm key so the player stands out from a blue world, a lower and
  // less saturated blue around it, a light vignette. The old blue key tinted every model navy.
  night: {
    toneMapping: "aces",
    exposure: 1.4,
    ambient: 3.4,
    sky: { top: 0x0d1838, horizon: 0x34497a, ground: 0x0b0d14, light: 0.15 },
    sun: { direction: { x: -0.35, y: 0.75, z: 0.45 }, color: 0xffd9ae, intensity: 1.9 },
    fog: { density: 0.009, height: 0.05 },
    ao: { radius: 1.2, intensity: 1.5 },
    bloom: { strength: 0.8, threshold: 0.8 },
    grade: { saturation: 1, contrast: 1.06, warmth: 0.02, vignette: 0.3 },
  },
  interior: {
    toneMapping: "agx",
    exposure: 1.1,
    ambient: 0.8,
    environment: "room",
    background: 0x17130f,
    sky: { top: 0x2a2520, horizon: 0x3a3028, ground: 0x15120f },
    sun: { direction: { x: 0.4, y: 0.9, z: 0.25 }, color: 0xffe2c0, intensity: 1.6 },
    fog: false,
    ao: { radius: 0.8, intensity: 2.6 },
    bloom: { strength: 0.4, threshold: 1 },
    grade: { saturation: 1.04, contrast: 1.05, warmth: 0.04, vignette: 0.45 },
  },
  // Nothing of the look's own: no sky, light, fog, grade or ground, and the renderer's tone
  // mapping left as the game sets it. The sky and sun values only light the model sheet.
  plain: {
    toneMapping: "none",
    exposure: 1,
    ambient: 1,
    environment: false,
    sky: { top: 0x3f7fd6, horizon: 0xc2d8ee, ground: 0x3a3936 },
    sun: { direction: { x: -0.45, y: 0.8, z: 0.4 }, color: 0xffffff, intensity: 2.6 },
    fog: false,
    ao: false,
    bloom: false,
    grade: false,
  },
  flat: {
    toneMapping: "neutral",
    exposure: 1,
    ambient: 1.3,
    sky: { top: 0x86bff5, horizon: 0xe2f0fd, ground: 0x6e6a60 },
    sun: { direction: { x: -0.4, y: 0.85, z: 0.35 }, color: 0xffffff, intensity: 2.2 },
    fog: { density: 0.002, height: 0.05 },
    ao: false,
    bloom: false,
    grade: false,
  },
};

/** What a LOOK export asks for, with its preset filled in. */
// Every setting LOOK takes; anything else is named back to the game rather than ignored.
const LOOK_KEYS = new Set([
  "preset",
  "toneMapping",
  "exposure",
  "ambient",
  "environment",
  "sky",
  "sun",
  "fog",
  "shadows",
  "ao",
  "bloom",
  "grade",
  "resolution",
  "quality",
  "ground",
]);
const SKY_KEYS = new Set(["physical", "clouds", "top", "horizon", "ground", "light"]);

export function resolveLook(options = {}) {
  // A misplaced setting would otherwise do nothing, silently: say where it belongs. The check
  // reports console warnings with the turn's other findings.
  for (const key of Object.keys(options))
    if (!LOOK_KEYS.has(key))
      console.warn(
        `LOOK.${key} is not a look setting, so it does nothing${SKY_KEYS.has(key) ? `: it belongs under LOOK.sky (LOOK.sky.${key})` : ""}. The settings are ${[...LOOK_KEYS].join(", ")}.`,
      );
  const name = options.preset ?? "day";
  const preset = PRESETS[name];
  if (preset === undefined)
    throw new Error(`LOOK.preset must be one of ${Object.keys(PRESETS).join(", ")}.`);
  const part = (key) => {
    const own = options[key];
    if (own === false) return false;
    if (own === true) return preset[key] === false ? (DEFAULT_PARTS[key] ?? {}) : preset[key];
    if (own === undefined) return preset[key];
    return { ...(preset[key] || DEFAULT_PARTS[key]), ...own };
  };
  const look = {
    name,
    toneMapping: options.toneMapping ?? preset.toneMapping,
    exposure: options.exposure ?? preset.exposure,
    ambient: options.ambient ?? preset.ambient,
    environment: options.environment ?? preset.environment ?? "sky",
    background: preset.background ?? null,
    sky: { ...preset.sky, ...options.sky },
    sun: {
      ...preset.sun,
      ...options.sun,
      direction: { ...preset.sun.direction, ...options.sun?.direction },
    },
    fog: part("fog"),
    ao: part("ao"),
    bloom: part("bloom"),
    grade: part("grade"),
    shadows: options.shadows !== false,
    ground: options.ground !== false && name !== "plain",
    plain: name === "plain",
    resolution: options.resolution ?? "adaptive",
    quality: options.quality ?? "auto",
    // A 2D game's exact colours: an orthographic camera with nothing about the look named.
    exactWhenOrthographic: options.preset === undefined && options.toneMapping === undefined,
  };
  if (TONE[look.toneMapping] === undefined)
    throw new Error(`LOOK.toneMapping must be one of ${Object.keys(TONE).join(", ")}.`);
  if (!ENVIRONMENTS.has(look.environment))
    throw new Error('LOOK.environment must be "sky", "room" or false.');
  if (!["auto", "high", "low"].includes(look.quality))
    throw new Error('LOOK.quality must be "auto", "high" or "low".');
  if (look.resolution !== "adaptive" && !(look.resolution > 0))
    throw new Error('LOOK.resolution must be "adaptive" or a scale such as 0.75.');
  // A game that asks for low quality drops the chain's dearest pass, decided here, before the
  // renderer chooses its anti-aliasing from whether a chain runs.
  if (look.quality === "low") look.ao = false;
  // The chain runs only for what needs whole-frame passes; tone mapping and the grade
  // also work inside the materials.
  look.post = look.ao !== false || look.bloom !== false;
  return look;
}
// What `ao: true` or `bloom: true` turns on where the preset has none.
const DEFAULT_PARTS = {
  fog: PRESETS.day.fog,
  ao: { radius: 1.2, intensity: 1.8 },
  bloom: { strength: 0.3, threshold: 1 },
  grade: PRESETS.day.grade,
};

// ── Shared shader state: the height fog's sun glow and base, and the baked sun shadow.
// Every built-in material gets these through one compile hook, so a game's own
// materials need nothing; one with its own onBeforeCompile calls lookShader(shader).
const shared = {
  lookSunDir: { value: new THREE.Vector3(0, 1, 0) },
  lookSunGlow: { value: new THREE.Color(0, 0, 0) },
  lookFogBase: { value: 0 },
  lookBakedMap: { value: null },
  lookBakedMatrix: { value: new THREE.Matrix4() },
  lookBakedTexel: { value: 1 / 4096 },
  lookBakedPush: { value: 0.1 },
  lookBakedOn: { value: 0 },
  lookGrade: { value: new THREE.Vector4(1, 1, 0, 0) },
  lookResolution: { value: new THREE.Vector2(1, 1) },
};
// The grade inside the materials, for looks without the chain: after tone mapping.
const GRADE_PARS = /* glsl */ `
uniform vec4 lookGrade;
uniform vec2 lookResolution;
vec3 lookGraded( vec3 c ) {
  c *= vec3( 1.0 + lookGrade.z, 1.0, 1.0 - lookGrade.z );
  c = ( c - 0.5 ) * lookGrade.y + 0.5;
  c = mix( vec3( dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ) ), c, lookGrade.x );
  vec2 v = gl_FragCoord.xy / lookResolution - 0.5;
  return max( c * mix( 1.0, 1.0 - dot( v, v ) * 1.6, lookGrade.w ), 0.0 );
}`;
let gradeInMaterials = false;

// Height fog inside every material that has fog: dense near the ground, thinning
// with height, integrated along the view ray and lit toward the sun. It needs no
// depth pass. Marked by a negative near: new HeightFog(color, density, falloff).
// three's own Fog (near, far) and FogExp2 behave exactly as documented.
THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorld;
#endif`;
THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorld = cameraPosition + transpose( mat3( viewMatrix ) ) * mvPosition.xyz;
#endif`;
THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorld;
  uniform vec3 lookSunDir;
  uniform vec3 lookSunGlow;
  uniform float lookFogBase;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    vec3 fogTint = fogColor;
  #else
    float fogFactor;
    vec3 fogTint = fogColor;
    if ( fogNear < 0.0 ) {
      vec3 ray = vFogWorld - cameraPosition;
      float dist = length( ray );
      ray /= max( dist, 1e-4 );
      float k = fogFar;
      float base = - fogNear * exp( - k * ( cameraPosition.y - lookFogBase ) );
      float rise = ray.y * dist;
      float amount = abs( rise ) > 1e-3 ? base * ( 1.0 - exp( - k * rise ) ) / ( k * ray.y ) : base * dist;
      fogFactor = 1.0 - exp( - max( amount, 0.0 ) );
      float toSun = max( dot( ray, lookSunDir ), 0.0 );
      fogTint += lookSunGlow * ( pow( toSun, 6.0 ) * 0.6 + pow( toSun, 32.0 ) * 0.5 );
    } else {
      fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    }
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogTint, fogFactor );
#endif`;

/** Height fog: `density` per metre at the ground, `falloff` per metre of height. */
export class HeightFog extends THREE.Fog {
  constructor(color, density = 0.006, falloff = 0.06) {
    super(color, -Math.max(density, 1e-6), Math.max(falloff, 1e-4));
    this.isHeightFog = true;
  }
  get density() {
    return -this.near;
  }
  set density(value) {
    this.near = -Math.max(value, 1e-6);
  }
}

const BAKED_VERTEX = /* glsl */ `
#ifdef LOOK_BAKED
  {
    vec4 lookWorld = vec4( transformed, 1.0 );
    vec3 lookNormal = objectNormal;
    #ifdef USE_BATCHING
      lookWorld = batchingMatrix * lookWorld;
    #endif
    #ifdef USE_INSTANCING
      lookWorld = instanceMatrix * lookWorld;
      lookNormal = mat3( instanceMatrix ) * lookNormal;
    #endif
    lookWorld = modelMatrix * lookWorld;
    lookNormal = normalize( mat3( modelMatrix ) * lookNormal );
    // A push along the normal keeps grazing surfaces from shadowing themselves.
    vLookBaked = lookBakedMatrix * vec4( lookWorld.xyz + lookNormal * lookBakedPush, 1.0 );
  }
#endif`;
const BAKED_FRAGMENT = /* glsl */ `
#ifdef LOOK_BAKED
uniform sampler2DShadow lookBakedMap;
uniform float lookBakedTexel;
uniform float lookBakedOn;
varying vec4 vLookBaked;
float lookBakedShadow() {
  if ( lookBakedOn < 0.5 ) return 1.0;
  vec3 c = vLookBaked.xyz / vLookBaked.w;
  if ( c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0 ) return 1.0;
  float z = c.z - 0.0015;
  // Four hardware-filtered taps on a rotated square: a soft edge for a few fetches.
  vec2 r = vec2( lookBakedTexel * 1.2 );
  float s = texture( lookBakedMap, vec3( c.xy + vec2( -0.7, -0.3 ) * r, z ) );
  s += texture( lookBakedMap, vec3( c.xy + vec2( 0.3, -0.7 ) * r, z ) );
  s += texture( lookBakedMap, vec3( c.xy + vec2( 0.7, 0.3 ) * r, z ) );
  s += texture( lookBakedMap, vec3( c.xy + vec2( -0.3, 0.7 ) * r, z ) );
  return s * 0.25;
}
#endif`;
const DIRECTIONAL = "getDirectionalLightInfo( directionalLight, directLight );";
const LIGHTS_BAKED = THREE.ShaderChunk.lights_fragment_begin.replace(
  DIRECTIONAL,
  `${DIRECTIONAL}\n\t\t#ifdef LOOK_BAKED\n\t\tdirectLight.color *= lookBakedShadow();\n\t\t#endif`,
);

/**
 * The look's uniforms and the baked sun shadow on a built-in material's shader.
 * The shell does this for every material; a material with its own
 * onBeforeCompile calls it first: material.onBeforeCompile = (shader) => { lookShader(shader); ... }.
 */
export function lookShader(shader) {
  const fog = shader.fragmentShader.includes("#include <fog_pars_fragment>");
  if (gradeInMaterials && shader.fragmentShader.includes("#include <tonemapping_fragment>")) {
    Object.assign(shader.uniforms, shared);
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", `${GRADE_PARS}\nvoid main() {`)
      .replace(
        "#include <tonemapping_fragment>",
        "#include <tonemapping_fragment>\n#if defined( TONE_MAPPING )\n\tgl_FragColor.rgb = lookGraded( gl_FragColor.rgb );\n#endif",
      );
  }
  const lit =
    shader.fragmentShader.includes("#include <lights_fragment_begin>") &&
    shader.vertexShader.includes("#include <worldpos_vertex>") &&
    shader.vertexShader.includes("#include <beginnormal_vertex>");
  if (fog || lit) Object.assign(shader.uniforms, shared);
  if (!lit) return;
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      "#include <common>\n#define LOOK_BAKED\nuniform mat4 lookBakedMatrix;\nuniform float lookBakedPush;\nvarying vec4 vLookBaked;\n#ifdef LOOK_GROUND\nvarying vec2 vLookGround;\n#endif",
    )
    .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>\n${BAKED_VERTEX}`)
    .replace("#include <begin_vertex>", `#include <begin_vertex>\n${GROUND_VERTEX}`);
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>\n#define LOOK_BAKED\n${BAKED_FRAGMENT}\n${GROUND_PARS}`,
    )
    .replace("#include <normal_fragment_begin>", FOLIAGE_NORMAL)
    .replace("#include <color_fragment>", GROUND_FRAGMENT)
    .replace("#include <lights_fragment_begin>", LIGHTS_BAKED);
}
// A large plain floor (createLook's markGrounds): soft patches of light and dark and a little
// warmth on the light ones, from its world position, so it never tiles and never moves.
const GROUND_VERTEX = /* glsl */ `
#ifdef LOOK_GROUND
  vLookGround = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;
#endif`;
// A made model's paint (shell/assets.js marks it) carries a baked shade in its vertex colour's
// alpha, which an opaque material never draws: creases, a gradient, a darker underside. The colour
// itself stays flat, so each colour of the model is still one swatch to read and repaint.
const GROUND_FRAGMENT = /* glsl */ `#include <color_fragment>
#if defined( LOOK_SHADE ) && defined( USE_COLOR_ALPHA ) && defined( OPAQUE )
	diffuseColor.rgb *= vColor.a;
#endif
#ifdef LOOK_GROUND
{
  float lookPatch = lookGroundNoise( vLookGround * 0.09 ) * 0.5
    + lookGroundNoise( vLookGround * 0.33 + 17.0 ) * 0.35
    + lookGroundNoise( vLookGround * 1.3 + 41.0 ) * 0.15;
  // Blended noise stays near its middle: its range is stretched before it shades.
  lookPatch = smoothstep( 0.28, 0.72, lookPatch );
  diffuseColor.rgb *= mix( 0.7, 1.12, lookPatch );
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.08, 1.05, 0.84 ),
    smoothstep( 0.65, 1.0, lookPatch ) * 0.6 );
}
#endif`;
const GROUND_PARS = /* glsl */ `
#ifdef LOOK_GROUND
varying vec2 vLookGround;
float lookGroundHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float lookGroundNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( lookGroundHash( i ), lookGroundHash( i + vec2( 1.0, 0.0 ) ), u.x ),
    mix( lookGroundHash( i + vec2( 0.0, 1.0 ) ), lookGroundHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
#endif`;
// Foliage (shell/assets.js marks it): a double-sided card whose normals point up, as grass and
// leaves are made for engines that light both faces alike. three.js turns a back face's normal
// around, to point down away from the sun, and every blade seen from behind draws black.
const FOLIAGE_NORMAL = /* glsl */ `#include <normal_fragment_begin>
#if defined( LOOK_FOLIAGE ) && ! defined( FLAT_SHADED )
	normal = normalize( vNormal );
	nonPerturbedNormal = normal;
#endif`;
// Every material without its own hook goes through the look's; three keys its
// programs by this function's text, the same for all of them.
THREE.Material.prototype.onBeforeCompile = function (shader) {
  lookShader(shader);
};

// ── The sky: a gradient with the sun's glow, drawn once into an environment
// probe that is both the background and the light around the scene.
const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;
const SKY_FRAGMENT = /* glsl */ `
uniform vec3 top;
uniform vec3 horizon;
uniform vec3 ground;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float saturation;
uniform float groundShare;
varying vec3 vDir;
void main() {
  vec3 d = normalize( vDir );
  vec3 c = d.y > 0.0
    ? mix( horizon, top, pow( smoothstep( 0.0, 1.0, d.y ), 0.55 ) )
    : mix( horizon, ground, smoothstep( 0.0, 0.2, - d.y ) * groundShare );
  float s = max( dot( d, sunDir ), 0.0 );
  c += sunColor * ( pow( s, 6.0 ) * 0.18 + pow( s, 90.0 ) * 0.5 + smoothstep( 0.9990, 0.9994, s ) * 3.0 );
  c = mix( vec3( dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ) ), c, saturation );
  gl_FragColor = vec4( c, 1.0 );
}`;

// A deck of cumulus over the sky, raymarched through a slab of 3D noise: flat grey bases, lit
// rounded tops, thinning into haze at the horizon. It is drawn once into the backdrop's cube at
// load, never per frame, so it can afford the march; low quality takes fewer steps.
const CLOUD_FRAGMENT = /* glsl */ `
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 shade;
uniform vec3 lit;
uniform float cover;
uniform float scale;
uniform float steps;
varying vec3 vDir;
float hash( vec3 p ) {
  p = fract( p * 0.3183099 + 0.1 );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float noise( vec3 x ) {
  vec3 i = floor( x ), f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( hash( i ), hash( i + vec3( 1, 0, 0 ) ), f.x ),
                   mix( hash( i + vec3( 0, 1, 0 ) ), hash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
              mix( mix( hash( i + vec3( 0, 0, 1 ) ), hash( i + vec3( 1, 0, 1 ) ), f.x ),
                   mix( hash( i + vec3( 0, 1, 1 ) ), hash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
float fbm( vec3 p, int octaves ) {
  float v = 0.0, a = 0.5;
  for ( int i = 0; i < 5; i ++ ) {
    if ( i >= octaves ) break;
    v += a * noise( p );
    p = p * 2.02 + vec3( 3.1, 1.7, 5.3 );
    a *= 0.5;
  }
  return v;
}
// The slab runs from y 1 to 2.4 (the sky's own units); a cloud is a heap: flat at its base,
// rounded toward its top, where the low octaves say a cloud stands.
float cloud( vec3 p, int octaves ) {
  float h = ( p.y - 1.0 ) / 1.4;
  if ( h < 0.0 || h > 1.0 ) return 0.0;
  vec2 q = p.xz * 0.32 * scale;
  float where = fbm( vec3( q, 0.5 ), 3 );
  float heap = smoothstep( 0.0, 0.07, h ) * ( 1.0 - smoothstep( 0.25, 1.0, h ) * ( 1.2 - where ) );
  float detail = fbm( p * 2.6 * scale, octaves );
  float d = where * 1.5 + detail * 0.42 - ( 1.42 - cover * 0.95 );
  return clamp( d * heap * 14.0, 0.0, 1.0 );
}
void main() {
  vec3 d = normalize( vDir );
  if ( d.y <= 0.015 ) discard;
  float t0 = 1.0 / d.y, t1 = 2.4 / d.y;
  // Far decks thin into the horizon's haze; the march spans no more than a few cloud lengths.
  float far = min( t1, t0 + 14.0 );
  int n = int( steps );
  float dt = ( far - t0 ) / steps;
  float transmit = 1.0;
  vec3 colour = vec3( 0.0 );
  // Each ray starts at its own fraction of a step, so the steps blur instead of banding.
  float jitter = hash( d * 913.7 );
  for ( int i = 0; i < 64; i ++ ) {
    if ( i >= n || transmit < 0.03 ) break;
    vec3 p = d * ( t0 + ( float( i ) + jitter ) * dt );
    float c = cloud( p, 4 );
    if ( c <= 0.0 ) continue;
    // Light: how much cloud lies between here and the sun.
    float toward = 0.0;
    // Read from the cloud's broad shape only (one octave), so its shade is smooth, never grainy.
    for ( int j = 1; j <= 3; j ++ ) toward += cloud( p + sunDir * 0.18 * float( j ), 1 );
    float sunlight = exp( - toward * 0.7 ) * ( 1.0 - exp( - c * 2.0 ) * 0.3 );
    float h = clamp( ( p.y - 1.0 ) / 1.4, 0.0, 1.0 );
    vec3 here = mix( shade, shade * 1.25, h ) + lit * mix( vec3( 1.0 ), sunColor, 0.5 ) * sunlight;
    float a = 1.0 - exp( - c * dt * 14.0 );
    colour += transmit * a * here;
    transmit *= 1.0 - a;
  }
  float alpha = ( 1.0 - transmit ) * smoothstep( 0.012, 0.06, d.y );
  if ( alpha < 0.003 ) discard;
  gl_FragColor = vec4( colour / max( 1.0 - transmit, 1e-3 ), alpha );
}`;

// How far the backdrop below the horizon goes from the horizon's haze toward the sky's ground
// tone. The ground tones are dark so the light from below stays dim; drawn at full strength
// behind a board seen from above, the tone mapping's toe and the grade's contrast crush them
// to black, and the board floats in a void. Halfway reads as distant ground in haze.
const BACKDROP_GROUND = 0.5;

/**
 * The drawn sky and the light it gives, as two probes: the light's sky is
 * desaturated, so a blue sky does not turn every model blue (library models are
 * coloured for neutral light) while the backdrop keeps its colour.
 */
async function skyProbes(renderer, look, sunDir, quality) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(look.sky.top) },
      horizon: { value: new THREE.Color(look.sky.horizon) },
      ground: { value: new THREE.Color(look.sky.ground) },
      sunDir: { value: sunDir.clone() },
      sunColor: { value: new THREE.Color(look.sun.color) },
      saturation: { value: 1 },
      groundShare: { value: BACKDROP_GROUND },
    },
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), material);
  const scene = new THREE.Scene().add(sphere);
  const owned = [sphere.geometry, material];
  if (look.sky.physical) {
    const { Sky } = await import("three/addons/objects/Sky.js");
    const sky = new Sky();
    sky.scale.setScalar(150);
    const tune = look.sky.physical === true ? {} : look.sky.physical;
    const u = sky.material.uniforms;
    // A clear day: deep blue overhead, a thin haze at the horizon.
    u.turbidity.value = tune.turbidity ?? 2.2;
    u.rayleigh.value = tune.rayleigh ?? 2.6;
    u.mieCoefficient.value = tune.mie ?? 0.003;
    u.mieDirectionalG.value = 0.8;
    u.sunPosition.value.copy(sunDir);
    // Below the horizon the gradient's hazy ground stays (the Sky alone goes black there), and
    // the scattering is brought to the scale of the look's exposure.
    sky.material.uniforms.lookGain = { value: tune.gain ?? 0.5 };
    sky.material.fragmentShader = `uniform float lookGain;\n${sky.material.fragmentShader.replace(
      "gl_FragColor = vec4( retColor, 1.0 );",
      "gl_FragColor = vec4( retColor * lookGain, smoothstep( -0.01, 0.05, direction.y ) );",
    )}`;
    sky.material.transparent = true;
    sky.material.depthTest = false;
    sky.renderOrder = -1;
    sphere.renderOrder = -2;
    material.uniforms.groundShare.value = BACKDROP_GROUND;
    scene.add(sky);
    owned.push(sky.geometry, sky.material);
  }
  let clouds = null;
  let cloudUniforms = null;
  if (look.sky.clouds) {
    const c = look.sky.clouds === true ? {} : look.sky.clouds;
    clouds = new THREE.Mesh(
      new THREE.SphereGeometry(90, 48, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        uniforms: {
          sunDir: { value: sunDir.clone() },
          sunColor: { value: new THREE.Color(look.sun.color) },
          shade: { value: new THREE.Color(c.shade ?? 0xa4b0c2) },
          lit: { value: new THREE.Color(c.lit ?? 0xffffff).multiplyScalar(1.25) },
          cover: { value: c.cover ?? 0.4 },
          scale: { value: c.scale ?? 1 },
          steps: { value: quality === "low" ? 24 : 56 },
        },
        vertexShader: SKY_VERTEX,
        fragmentShader: CLOUD_FRAGMENT,
      }),
    );
    clouds.renderOrder = 1;
    scene.add(clouds);
    owned.push(clouds.geometry, clouds.material);
    cloudUniforms = clouds.material.uniforms;
  }
  let background;
  let target = null;
  if (look.sky.physical || look.sky.clouds) {
    // Drawn once at full detail into a cube the backdrop shows as it is: a PMREM's top level
    // is too soft for a cloud's edge.
    target = new THREE.WebGLCubeRenderTarget(quality === "low" ? 512 : 1024, {
      type: THREE.HalfFloatType,
      // Every sky material draws with no depth test: a depth buffer here would only hold memory.
      depthBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    });
    new THREE.CubeCamera(0.1, 400, target).update(renderer, scene);
    background = target.texture;
  } else background = pmrem.fromScene(scene, 0, 0.1, 400).texture;
  // Under a long lens the cube's clouds are magnified past its texels. High quality also marches
  // the band a long lens looks at (the horizon up to BAND_TOP) once into a wide panorama, and
  // keeps the sky without clouds; the backdrop then draws from both (bandSky).
  let band = null;
  if (clouds !== null && quality === "high") {
    clouds.visible = false;
    const bareTarget = new THREE.WebGLCubeRenderTarget(512, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    });
    new THREE.CubeCamera(0.1, 400, bareTarget).update(renderer, scene);
    const bandTarget = new THREE.WebGLRenderTarget(BAND_WIDTH, BAND_HEIGHT, {
      depthBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      wrapS: THREE.RepeatWrapping,
    });
    const march = new THREE.ShaderMaterial({
      uniforms: {
        ...cloudUniforms,
        steps: { value: 64 },
        bandTop: { value: BAND_TOP },
        strip: { value: new THREE.Vector2(0, 1) },
      },
      vertexShader: BAND_VERTEX,
      fragmentShader: CLOUD_FRAGMENT.replace(
        "gl_FragColor = vec4( colour / max( 1.0 - transmit, 1e-3 ), alpha );",
        BAND_ENCODE,
      ),
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), march);
    // Its vertex shader places it on the screen itself; no camera frustum applies.
    quad.frustumCulled = false;
    const quadScene = new THREE.Scene().add(quad);
    const was = renderer.getRenderTarget();
    const clear = renderer.getClearAlpha();
    renderer.setRenderTarget(bandTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    // In strips: one long draw can trip an integrated GPU's hang check. Each strip's draw must
    // not clear the strips before it.
    const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    for (let i = 0; i < BAND_STRIPS; i += 1) {
      const w = BAND_WIDTH / BAND_STRIPS;
      bandTarget.viewport.set(i * w, 0, w, BAND_HEIGHT);
      march.uniforms.strip.value.set(i / BAND_STRIPS, 1 / BAND_STRIPS);
      renderer.setRenderTarget(bandTarget);
      renderer.render(quadScene, quadCamera);
    }
    bandTarget.viewport.set(0, 0, BAND_WIDTH, BAND_HEIGHT);
    renderer.autoClear = autoClear;
    renderer.setRenderTarget(was);
    renderer.setClearAlpha(clear);
    quad.geometry.dispose();
    march.dispose();
    band = { bare: bareTarget.texture, clouds: null, texture: bandTarget.texture };
  }
  let light;
  if (look.environment === "room") {
    const { RoomEnvironment } = await import("three/addons/environments/RoomEnvironment.js");
    light = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  } else if (target !== null) {
    // A sky this real lights the scene in its own colours: reflections show the clouds.
    light = pmrem.fromCubemap(target.texture).texture;
  } else {
    material.uniforms.saturation.value = look.sky.light ?? 0.45;
    material.uniforms.groundShare.value = 1;
    light = pmrem.fromScene(scene, 0, 0.1, 400).texture;
  }
  if (band !== null) band.clouds = background;
  for (const thing of owned) thing.dispose();
  pmrem.dispose();
  return { background, light, band };
}

/** Narrower than this, the cube's clouds are magnified enough to blur: the band takes over. */
const BAND_FOV = 40;
/** The band: azimuth all round, elevation from the horizon up to BAND_TOP (radians). */
const BAND_TOP = (32 * Math.PI) / 180;
const BAND_WIDTH = 8192;
const BAND_HEIGHT = 1024;
const BAND_STRIPS = 16;
// The band's texels as directions: u all the way round, v from the horizon up to bandTop.
const BAND_VERTEX = /* glsl */ `
uniform float bandTop;
uniform vec2 strip;
varying vec3 vDir;
void main() {
  vec2 uv = position.xy * 0.5 + 0.5;
  uv.x = strip.x + uv.x * strip.y;
  float az = uv.x * 6.2831853;
  float el = uv.y * bandTop;
  vDir = vec3( cos( el ) * sin( az ), sin( el ), cos( el ) * cos( az ) );
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;
// Stored in 8 bits with headroom and a square root, so bright tops and grey bases both keep detail.
const BAND_ENCODE =
  "gl_FragColor = vec4( sqrt( clamp( colour / max( 1.0 - transmit, 1e-3 ) * 0.5, 0.0, 1.0 ) ), alpha );";
// The sky under a long lens: the band where it reaches, the cube with clouds above it, blended.
const BAND_SKY_FRAGMENT = /* glsl */ `
uniform sampler2D band;
uniform samplerCube bare;
uniform samplerCube clouds;
uniform float bandTop;
varying vec3 vDir;
void main() {
  vec3 d = normalize( vDir );
  vec3 high = textureCube( clouds, d ).rgb;
  vec3 colour = high;
  float el = asin( clamp( d.y, -1.0, 1.0 ) );
  if ( el > 0.0 && el < bandTop ) {
    float az = atan( d.x, d.z ) / 6.2831853;
    vec4 b = texture2D( band, vec2( fract( az ), el / bandTop ) );
    vec3 low = mix( textureCube( bare, d ).rgb, b.rgb * b.rgb * 2.0, b.a );
    colour = mix( low, high, smoothstep( bandTop * 0.8, bandTop, el ) );
  }
  gl_FragColor = vec4( colour, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const isSoftware = (renderer) => {
  const gl = renderer.getContext();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = String(
    info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  );
  return { name, software: /swiftshader|llvmpipe|softpipe|software/i.test(name) };
};

/**
 * Makes the renderer and the look. The post chain's add-ons load only when the
 * look uses them; a browser drawing on the CPU gets the plain path.
 */
export async function createLook(canvas, options = {}) {
  const look = resolveLook(options);
  // three's compileAsync, except that a material disposed while it compiles (a run retried at
  // once, a reset effect) is let go instead of read: three's own throws on it.
  const compileQuietly = (scene, camera) => {
    const waiting = renderer.compile(scene, camera);
    return new Promise((resolve) => {
      const check = () => {
        for (const material of waiting) {
          const program = renderer.properties.get(material).currentProgram;
          if (program === undefined || program.isReady()) waiting.delete(material);
        }
        if (waiting.size === 0) resolve();
        else setTimeout(check, 10);
      };
      setTimeout(check, 10);
    });
  };
  const renderer = new THREE.WebGLRenderer({
    canvas,
    // MSAA only without the chain: under it the frame is a float target and SMAA does the edges.
    antialias: !look.post,
    powerPreference: "high-performance",
  });
  // The screen's own pixels: a game draws at the resolution it is shown at, and only its frame
  // rate takes it down (createScale). Read again on each resize: a zoom or another screen
  // changes it.
  let devicePixels = window.devicePixelRatio || 1;
  renderer.setPixelRatio(devicePixels);
  renderer.setSize(window.innerWidth, window.innerHeight);
  // A frame's draws are counted across all its passes: the shell resets them as a frame begins.
  renderer.info.autoReset = false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = look.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMappingExposure = look.exposure;
  const gpu = isSoftware(renderer);
  // Auto spends where a GPU draws, and saves where the browser draws in software (on the clouds
  // and the water). A named low also drops ambient occlusion (resolveLook) and halves the sun's
  // shadow map.
  look.quality = look.quality === "auto" ? (gpu.software ? "low" : "high") : look.quality;
  // Only a game that names low gets the smaller shadow map: auto (low in software) leaves the
  // shadows of games made before it as they were.
  const shadowSize = options.quality === "low" ? 512 : 1024;
  const post = look.post && !gpu.software;
  if (!post && look.grade !== false) {
    gradeInMaterials = true;
    const g = look.grade;
    shared.lookGrade.value.set(g.saturation ?? 1, g.contrast ?? 1, g.warmth ?? 0, g.vignette ?? 0);
  }

  const sunDir = new THREE.Vector3(
    look.sun.direction.x,
    look.sun.direction.y,
    look.sun.direction.z,
  );
  sunDir.normalize();
  shared.lookSunDir.value.copy(sunDir);
  if (look.fog !== false)
    shared.lookSunGlow.value.set(look.sun.color).multiplyScalar(look.sun.intensity * 0.25);
  const sky = await skyProbes(renderer, look, sunDir, look.quality);
  const backgroundColor = look.background === null ? null : new THREE.Color(look.background);

  // A 1×1 depth map stands in until a bake, so the shadow sampler always has a depth texture.
  const blank = new THREE.WebGLRenderTarget(1, 1, {
    depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
  });
  blank.depthTexture.compareFunction = THREE.LessEqualCompare;
  renderer.setRenderTarget(blank);
  renderer.clear();
  renderer.setRenderTarget(null);
  shared.lookBakedMap.value = blank.depthTexture;
  let bakedTarget = null;

  const chain = post ? await createChain(renderer, look) : null;
  const timer = createTimer(renderer);
  const scale = createScale(
    renderer,
    look,
    () => devicePixels,
    (s) => {
      chain?.resize(s);
      renderer.getDrawingBufferSize(shared.lookResolution.value);
    },
  );
  const stats = createStats();
  const probes = new WeakMap();
  const prepared = new WeakSet();
  const suns = new Set();

  /** The scene's sky, light and fog, once per scene, after the game has built it. */
  const dress = (scene, camera) => {
    if (look.plain || prepared.has(scene)) return;
    prepared.add(scene);
    // A 2D game's exact colours keep no sky probe; its backdrop is the preset's horizon, not
    // the renderer's black.
    if (exact(camera)) {
      if (scene.background === null) scene.background = new THREE.Color(look.sky.horizon);
      return;
    }
    if (look.ground) markGrounds(scene);
    if (scene.background === null) scene.background = backgroundColor ?? sky.background;
    if (scene.environment === null && look.environment !== false) {
      const own = scene.background;
      if (own?.isTexture === true && own !== sky.background) scene.environment = probeOf(own);
      else scene.environment = sky.light;
      scene.environmentIntensity = look.ambient;
    }
    if (scene.fog === null && look.fog !== false) {
      const color = new THREE.Color(look.fog.color ?? look.sky.horizon);
      scene.fog = new HeightFog(color, look.fog.density, look.fog.height);
    }
  };
  const probeOf = (texture) => {
    let probe = probes.get(texture);
    if (probe === undefined) {
      const pmrem = new THREE.PMREMGenerator(renderer);
      probe = texture.isCubeTexture
        ? pmrem.fromCubemap(texture).texture
        : pmrem.fromEquirectangular(texture).texture;
      pmrem.dispose();
      probes.set(texture, probe);
    }
    return probe;
  };
  const exact = (camera) => look.exactWhenOrthographic && camera.isOrthographicCamera === true;
  /**
   * A large plain floor: a lit mesh with one colour and no texture, lying flat and wider than
   * 20 m. One flat colour across a whole field is what makes a first build read as a prototype;
   * its material gets the look's ground variation (GROUND_FRAGMENT), once.
   */
  const markGrounds = (scene) => {
    scene.updateMatrixWorld(true);
    const size = new THREE.Vector3();
    const box = new THREE.Box3();
    scene.traverse((object) => {
      if (!object.isMesh || object.isInstancedMesh || object.isSkinnedMesh) return;
      const material = object.material;
      if (Array.isArray(material) || material == null || material.map != null) return;
      if (material.color === undefined || material.isMeshBasicMaterial) return;
      if (material.defines?.LOOK_GROUND !== undefined) return;
      const geometry = object.geometry;
      if (geometry.boundingBox === null) geometry.computeBoundingBox();
      box.copy(geometry.boundingBox).applyMatrix4(object.matrixWorld).getSize(size);
      const wide = Math.max(size.x, size.z);
      if (wide < 20 || size.y > wide * 0.02) return;
      material.defines = { ...material.defines, LOOK_GROUND: "" };
      material.needsUpdate = true;
    });
  };

  // Under a long lens the backdrop is a dome drawn from the band (bandSky) instead of the cube:
  // one per scene, centred on the camera, drawn first and behind everything, two texture reads a
  // pixel. Wider views keep the cube, whose clouds are sharp enough there.
  const domes = new WeakMap();
  const bandSky = (scene, camera) => {
    if (sky.band === null) return;
    let dome = domes.get(scene);
    if (dome === undefined) {
      if (scene.background !== sky.background) return;
      dome = new THREE.Mesh(
        new THREE.SphereGeometry(1, 48, 24),
        new THREE.ShaderMaterial({
          side: THREE.BackSide,
          depthTest: false,
          depthWrite: false,
          uniforms: {
            band: { value: sky.band.texture },
            bare: { value: sky.band.bare },
            clouds: { value: sky.band.clouds },
            bandTop: { value: BAND_TOP },
          },
          vertexShader: SKY_VERTEX,
          fragmentShader: BAND_SKY_FRAGMENT,
        }),
      );
      dome.name = "Sky";
      dome.renderOrder = -1e9;
      dome.frustumCulled = false;
      // Part of the sky, never of the world: rays (the scene report, the Stage's picking) pass.
      dome.raycast = () => {};
      scene.add(dome);
      domes.set(scene, dome);
    }
    const narrow = camera.isPerspectiveCamera === true && camera.fov <= BAND_FOV;
    dome.visible = narrow;
    scene.background = narrow ? null : sky.background;
    if (narrow) {
      camera.getWorldPosition(dome.position);
      dome.scale.setScalar((camera.near + camera.far) / 2);
    }
  };
  const draw = (scene, camera, dt) => {
    if (look.plain && chain === null) {
      renderer.render(scene, camera);
      return;
    }
    dress(scene, camera);
    if (!exact(camera)) bandSky(scene, camera);
    if (chain === null || exact(camera)) {
      renderer.toneMapping = exact(camera) ? THREE.NoToneMapping : TONE[look.toneMapping];
      renderer.render(scene, camera);
      return;
    }
    renderer.toneMapping = THREE.NoToneMapping;
    chain.render(scene, camera, dt);
  };

  const bake = (root, { bounds = null, size = 4096 } = {}) => {
    if (!look.shadows) return;
    root.updateWorldMatrix(true, true);
    const box = bounds ?? new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return;
    const direction = [...suns][0]?.toLight ?? sunDir;
    const camera = new THREE.OrthographicCamera();
    const centre = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    camera.position.copy(centre).addScaledVector(direction, radius + 50);
    camera.lookAt(centre);
    camera.updateMatrixWorld();
    // The light-space box fitted tightly around the bounds' corners.
    const fit = new THREE.Box3();
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i += 1)
      fit.expandByPoint(
        corner
          .set(
            i & 1 ? box.max.x : box.min.x,
            i & 2 ? box.max.y : box.min.y,
            i & 4 ? box.max.z : box.min.z,
          )
          .applyMatrix4(camera.matrixWorldInverse),
      );
    Object.assign(camera, {
      left: fit.min.x,
      right: fit.max.x,
      bottom: fit.min.y,
      top: fit.max.y,
      near: -fit.max.z - 30,
      far: -fit.min.z + 5,
    });
    camera.updateProjectionMatrix();
    if (bakedTarget === null || bakedTarget.width !== size) {
      bakedTarget?.dispose();
      const depth = new THREE.DepthTexture(size, size, THREE.UnsignedIntType);
      depth.compareFunction = THREE.LessEqualCompare;
      depth.minFilter = depth.magFilter = THREE.LinearFilter;
      bakedTarget = new THREE.WebGLRenderTarget(size, size, { depthTexture: depth });
    }
    const scene = new THREE.Scene();
    const parent = root.parent;
    scene.add(root);
    const hidden = [];
    const casters = [];
    root.traverse((object) => {
      if (!(object.isMesh || object.isPoints || object.isLine) || !object.visible) return;
      if (object.castShadow) casters.push(object);
      else {
        object.visible = false;
        hidden.push(object);
      }
    });
    scene.overrideMaterial = new THREE.MeshDepthMaterial();
    renderer.setRenderTarget(bakedTarget);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    scene.overrideMaterial.dispose();
    for (const object of hidden) object.visible = true;
    scene.remove(root);
    parent?.add(root);
    shared.lookBakedMatrix.value
      .set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(camera.projectionMatrix)
      .multiply(camera.matrixWorldInverse);
    shared.lookBakedMap.value = bakedTarget.depthTexture;
    shared.lookBakedTexel.value = 1 / size;
    // A few world texels along the normal: grazing ground stops shadowing itself.
    shared.lookBakedPush.value = Math.max(0.03, ((fit.max.x - fit.min.x) / size) * 5);
    shared.lookBakedOn.value = 1;
    // In the baked map now: the sun's per-frame map draws only what moves.
    for (const object of casters) object.castShadow = false;
  };

  const api = {
    /**
     * For a picture drawn outside the frame (the model sheet): the look's tone mapping, its light
     * around the scene (the game's own environment when given), no baked level shadow. Returns
     * the call that puts the renderer back.
     */
    /**
     * The look for a picture of one thing drawn straight into a target (the Stage's portraits):
     * its tone mapping on the materials, as a frame without the post chain has it, at a plain
     * exposure, and its grade and baked shadows off, so the picture is the thing and not the
     * game's mood. Returns the call that puts the renderer back.
     */
    forPicture() {
      const tone = renderer.toneMapping;
      const exposure = renderer.toneMappingExposure;
      const baked = shared.lookBakedOn.value;
      const grade = shared.lookGrade.value.clone();
      if (!look.plain) renderer.toneMapping = TONE[look.toneMapping];
      renderer.toneMappingExposure = 1;
      shared.lookBakedOn.value = 0;
      shared.lookGrade.value.set(1, 1, 0, 0);
      return () => {
        renderer.toneMapping = tone;
        renderer.toneMappingExposure = exposure;
        shared.lookBakedOn.value = baked;
        shared.lookGrade.value.copy(grade);
      };
    },
    lightForPicture(scene, environment = null) {
      const tone = renderer.toneMapping;
      const baked = shared.lookBakedOn.value;
      if (!look.plain) renderer.toneMapping = TONE[look.toneMapping];
      shared.lookBakedOn.value = 0;
      scene.environment =
        environment ?? (look.environment === false && !look.plain ? null : sky.light);
      scene.environmentIntensity = look.ambient;
      return () => {
        renderer.toneMapping = tone;
        shared.lookBakedOn.value = baked;
      };
    },
    renderer,
    /** The resolved look: its preset's name and every part. */
    settings: look,
    /** The browser's renderer string, and whether it draws on the CPU. */
    gpu,
    post: chain !== null,
    /** Draws a scene through the look (the shell's frame, or a game's own render hook). */
    render(scene, camera, dt = 0) {
      draw(scene, camera, dt);
    },
    /** Times the frame's GPU work and keeps the render scale on budget. The shell wraps every draw. */
    frame(work, { playing = false, realMs = 0 } = {}) {
      renderer.info.reset();
      // The scale steps before the draw, never after it: a step resizes the canvas, which clears
      // it, and a canvas cleared after its frame was drawn is what the screen shows until the
      // next draw (a blank frame on a GPU, seconds of blank where a frame takes that long).
      const gpuMs = timer.poll();
      scale.update(gpuMs, realMs);
      timer.begin();
      try {
        work();
      } finally {
        timer.end();
      }
      if (playing) {
        stats.add(realMs, gpuMs, scale.value);
        stats.draws(renderer.info.render.calls, renderer.info.render.triangles);
      }
    },
    bake,
    /**
     * Compiles a built scene's programs without blocking (the browser compiles
     * them in parallel where it can); resolves when they are ready or after
     * `waitMs`, whichever is first. The shell holds a run's first frame on it.
     */
    compile(scene, camera, waitMs = 3000) {
      dress(scene, camera);
      return Promise.race([
        compileQuietly(scene, camera),
        new Promise((resolve) => setTimeout(resolve, waitMs)),
      ]);
    },
    /**
     * Compiles every program a run will use (the models lit as a run is, the
     * shadow pass and the post chain) and draws them once, off screen before
     * the first run, so the first frame of play does not stall on them.
     */
    async warm(models, extra = null) {
      const scene = extra?.scene ?? new THREE.Scene();
      const sun = new THREE.DirectionalLight(0xffffff, 1);
      sun.castShadow = look.shadows;
      scene.add(sun, ...models);
      const camera = extra?.camera ?? new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
      if (extra === null) {
        camera.position.set(0, 4, 12);
        camera.lookAt(0, 1, 0);
      }
      dress(scene, camera);
      await compileQuietly(scene, camera);
      draw(scene, camera, 0);
      renderer.clear();
      scene.remove(sun, ...models);
    },
    resize(width, height) {
      devicePixels = window.devicePixelRatio || 1;
      renderer.setSize(width, height);
      scale.apply();
    },
    /** Frame times, GPU time and the render scale over play since the last reset (the studio's perf). */
    stats() {
      return stats.read({
        renderer: gpu.name,
        software: gpu.software,
        post: chain !== null,
        look: look.name,
        width: Math.round(window.innerWidth * devicePixels),
        height: Math.round(window.innerHeight * devicePixels),
        timer: timer.available,
      });
    },
    /** The run's API, as ctx.look. */
    forRun(ctx) {
      return {
        sun({
          follow = null,
          size = 30,
          intensity = look.sun.intensity,
          color = look.sun.color,
          direction = look.sun.direction,
        } = {}) {
          const light = new THREE.DirectionalLight(color, intensity);
          const toLight = new THREE.Vector3(direction.x, direction.y, direction.z).normalize();
          light.castShadow = look.shadows;
          light.shadow.mapSize.set(shadowSize, shadowSize);
          light.shadow.bias = -0.0005;
          light.shadow.normalBias = 0.02;
          const half = size / 2;
          Object.assign(light.shadow.camera, {
            left: -half,
            right: half,
            top: half,
            bottom: -half,
            near: 0.5,
            far: size * 3,
          });
          light.shadow.camera.updateProjectionMatrix();
          ctx.scene.add(light, light.target);
          const rig = { light, follow, toLight, distance: size * 1.5, texel: size / shadowSize };
          suns.add(rig);
          place(rig);
          return light;
        },
        bake,
        render: (scene, camera) => draw(scene, camera, 0),
        settings: look,
      };
    },
    /** Moves each sun's shadow box to its target; the shell calls it every frame of play. */
    update() {
      for (const rig of suns) place(rig);
    },
    /** Drops the run's suns and their shadow maps. A bake stays until the next one. */
    reset() {
      for (const rig of suns) rig.light.shadow.dispose();
      suns.clear();
    },
    /** Starts the play stats afresh (a new run). */
    resetStats() {
      stats.reset();
    },
  };
  return api;
}

const at = new THREE.Vector3();
function place(rig) {
  const target = rig.follow;
  if (target?.isObject3D === true) target.getWorldPosition(at);
  else if (target != null) at.set(target.x ?? 0, target.y ?? 0, target.z ?? 0);
  else at.set(0, 0, 0);
  // Whole shadow texels on each axis, so shadow edges swim less as the box follows.
  at.set(
    Math.round(at.x / rig.texel) * rig.texel,
    Math.round(at.y / rig.texel) * rig.texel,
    Math.round(at.z / rig.texel) * rig.texel,
  );
  rig.light.target.position.copy(at);
  rig.light.position.copy(at).addScaledVector(rig.toLight, rig.distance);
  rig.light.target.updateMatrixWorld();
}

// After tone mapping: lift and gain toward warm or cool, contrast, saturation, a
// vignette, a sharpen that grows as the render scale drops (the canvas is
// stretched to the window after this), and noise under one 8-bit step so long
// sky and fog gradients do not band.
const GRADE = /* glsl */ `
uniform float saturation;
uniform float contrast;
uniform float warmth;
uniform float vignette;
uniform float sharpen;
void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
  vec3 c = inputColor.rgb;
  if ( sharpen > 0.0 ) {
    const vec3 W = vec3( 0.2126, 0.7152, 0.0722 );
    float l0 = dot( texture2D( inputBuffer, uv ).rgb, W );
    float ln = dot( texture2D( inputBuffer, uv + vec2( texelSize.x, 0.0 ) ).rgb, W )
      + dot( texture2D( inputBuffer, uv - vec2( texelSize.x, 0.0 ) ).rgb, W )
      + dot( texture2D( inputBuffer, uv + vec2( 0.0, texelSize.y ) ).rgb, W )
      + dot( texture2D( inputBuffer, uv - vec2( 0.0, texelSize.y ) ).rgb, W );
    c *= 1.0 + sharpen * clamp( ( l0 * 4.0 - ln ) / max( ln, 1e-3 ), -0.4, 0.4 );
  }
  c *= vec3( 1.0 + warmth, 1.0, 1.0 - warmth );
  c = ( c - 0.5 ) * contrast + 0.5;
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c = mix( vec3( l ), c, saturation );
  vec2 v = uv - 0.5;
  c *= mix( 1.0, 1.0 - dot( v, v ) * 1.6, vignette );
  float n = fract( sin( dot( uv * 1000.0 + fract( time * 7.0 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  c += ( n - 0.5 ) / 255.0;
  outputColor = vec4( clamp( c, 0.0, 1.0 ), inputColor.a );
}`;

async function createChain(renderer, look) {
  const pp = await import("postprocessing");
  const ao = look.ao === false ? null : await import("n8ao");
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const composer = new pp.EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: 0,
  });
  const empty = new THREE.Scene();
  const nobody = new THREE.PerspectiveCamera();
  const scenePass = new pp.RenderPass(empty, nobody);
  composer.addPass(scenePass);
  let aoPass = null;
  if (ao !== null) {
    aoPass = new ao.N8AOPostPass(empty, nobody, size.x, size.y);
    Object.assign(aoPass.configuration, {
      aoRadius: look.ao.radius ?? 1.2,
      distanceFalloff: 0.6,
      intensity: look.ao.intensity ?? 2,
      aoSamples: 6,
      denoiseSamples: 4,
      denoiseRadius: 8,
      denoiseIterations: 1,
      halfRes: true,
      depthAwareUpsampling: true,
      gammaCorrection: false,
    });
    composer.addPass(aoPass);
  }
  const grade = look.grade === false ? null : look.grade;
  const gradeEffect =
    grade === null
      ? null
      : new (class extends pp.Effect {
          constructor() {
            super("Grade", GRADE, {
              uniforms: new Map([
                ["saturation", new THREE.Uniform(grade.saturation ?? 1)],
                ["contrast", new THREE.Uniform(grade.contrast ?? 1)],
                ["warmth", new THREE.Uniform(grade.warmth ?? 0)],
                ["vignette", new THREE.Uniform(grade.vignette ?? 0)],
                ["sharpen", new THREE.Uniform(0)],
              ]),
            });
          }
        })();
  const mode = {
    neutral: pp.ToneMappingMode.NEUTRAL,
    agx: pp.ToneMappingMode.AGX,
    aces: pp.ToneMappingMode.ACES_FILMIC,
    none: pp.ToneMappingMode.LINEAR,
  }[look.toneMapping];
  // ToneMappingEffect runs three's own tone mapping, which reads renderer.toneMappingExposure.
  const effects = [
    look.bloom === false
      ? null
      : new pp.BloomEffect({
          mipmapBlur: true,
          intensity: look.bloom.strength ?? 0.5,
          luminanceThreshold: look.bloom.threshold ?? 1,
          luminanceSmoothing: 0.3,
          radius: look.bloom.radius ?? 0.7,
          levels: 6,
        }),
    new pp.ToneMappingEffect({ mode }),
    gradeEffect,
    new pp.SMAAEffect({ preset: pp.SMAAPreset.MEDIUM }),
  ].filter((effect) => effect !== null);
  const effectPass = new pp.EffectPass(nobody, ...effects);
  composer.addPass(effectPass);
  let ortho = false;
  return {
    render(scene, camera, dt) {
      scenePass.mainScene = scene;
      scenePass.mainCamera = camera;
      effectPass.mainCamera = camera;
      if (aoPass !== null) {
        aoPass.scene = scene;
        aoPass.camera = camera;
        if (ortho !== (camera.isOrthographicCamera === true)) {
          ortho = camera.isOrthographicCamera === true;
          const depth = aoPass.configuration.depthBufferType;
          aoPass.configureAOPass(depth, ortho);
          aoPass.configureDenoisePass(depth, ortho);
          aoPass.configureEffectCompositer(depth, ortho);
        }
      }
      composer.render(dt);
    },
    resize(scaleNow) {
      const drawing = renderer.getDrawingBufferSize(new THREE.Vector2());
      composer.setSize(
        drawing.x / renderer.getPixelRatio(),
        drawing.y / renderer.getPixelRatio(),
        false,
      );
      if (gradeEffect !== null)
        gradeEffect.uniforms.get("sharpen").value =
          scaleNow < 0.99 ? 0.1 + (1 - scaleNow) * 0.9 : 0;
    },
  };
}

/**
 * The GPU's time for each frame (EXT_disjoint_timer_query_webgl2), read a frame
 * or two later when the browser offers it; null where it does not.
 */
function createTimer(renderer) {
  const gl = renderer.getContext();
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const pending = [];
  let active = null;
  return {
    available: ext !== null,
    begin() {
      if (ext === null || active !== null || pending.length > 4) return;
      active = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
    },
    end() {
      if (active === null) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(active);
      active = null;
    },
    /** The newest finished frame's GPU ms, or null. */
    poll() {
      let ms = null;
      while (pending.length > 0 && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const query = pending.shift();
        // A disjoint (a clock change, a context switch) makes the result meaningless.
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT))
          ms = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(query);
      }
      return ms;
    },
  };
}

/** The GPU time a frame may take: a 60 fps frame with room for the browser's own work. */
const GPU_BUDGET_MS = 12.5;
/** A 60 fps frame comes every 16.7 ms; frames later than this on average are missed ones. */
const LATE_MS = 18.5;
/**
 * The most screen pixels a rendered pixel may cover per side: past this the game looks blocky. A
 * HiDPI screen may go to one CSS pixel, the picture a 1x screen shows, never coarser.
 */
const MAX_STRETCH = 1.25;

/**
 * The render scale: a share of the device's pixels per side. Adaptive, it steps down only when
 * the GPU is what makes frames late: its own time says so. Frames late for any other reason (a
 * busy page, a chat streaming beside the game) are not the GPU's, and fewer pixels would only
 * blur the game without making it any faster. A browser that cannot time the GPU steps on
 * frame times alone, slowly. A step down needs a full second over budget, so one busy moment
 * (a load, a hitch) never blurs the game. It never goes coarser than 1.25 screen pixels per
 * rendered pixel, or one CSS pixel on a HiDPI screen, and climbs back once the GPU has room again.
 */
function createScale(renderer, look, devicePixels, onChange) {
  const fixed = look.resolution === "adaptive" ? null : Math.min(look.resolution, 1);
  const floor = () => Math.min(1 / MAX_STRETCH, 1 / devicePixels());
  let value = fixed ?? 1;
  const gpu = [];
  const real = [];
  let since = 0;
  let settle = 0.5;
  let hold = 0;
  let lateFor = 0;
  let overFor = 0;
  const apply = () => {
    if (fixed === null) value = Math.max(value, floor());
    renderer.setPixelRatio(devicePixels() * value);
    onChange(value);
  };
  const median = (list) => list.toSorted((a, b) => a - b)[list.length >> 1];
  const mean = (list) => list.reduce((sum, x) => sum + x, 0) / list.length;
  apply();
  return {
    get value() {
      return value;
    },
    apply,
    update(gpuMs, realMs) {
      if (fixed !== null) return;
      if (gpuMs !== null) gpu.push(gpuMs);
      if (realMs > 0 && realMs < 250) real.push(realMs);
      since += realMs / 1000;
      if (since < 0.5) return;
      const span = since;
      hold = Math.max(0, hold - since);
      since = 0;
      // The first half second after a change settles (new buffers, first draws).
      if (settle > 0 || real.length < 3) {
        settle = Math.max(0, settle - 0.5);
        gpu.length = 0;
        real.length = 0;
        return;
      }
      const late = mean(real) > LATE_MS;
      const ms = gpu.length >= 3 ? median(gpu) : null;
      lateFor = late ? lateFor + span : 0;
      const over = ms !== null && ms > GPU_BUDGET_MS && late;
      overFor = over ? overFor + span : 0;
      let next = value;
      if (ms !== null) {
        // The GPU's own time decides: over budget for a second, fewer pixels by what the
        // overrun needs.
        if (over) {
          if (overFor >= 1) {
            next = value * Math.max(0.85, Math.sqrt(GPU_BUDGET_MS / ms));
            overFor = 0;
            hold = 3;
          }
        } else if (hold === 0 && ms < GPU_BUDGET_MS * 0.75)
          next = value * Math.min(1.1, Math.sqrt((GPU_BUDGET_MS * 0.85) / ms));
      } else if (lateFor >= 2) {
        // No GPU timer: two seconds of late frames in a row, then a small step.
        next = value * 0.95;
        lateFor = 0;
        hold = 3;
      } else if (hold === 0 && !late) next = value * 1.05;
      gpu.length = 0;
      real.length = 0;
      next = Math.min(1, Math.max(floor(), Math.round(next * 20) / 20));
      if (next !== value) {
        value = next;
        settle = 0.5;
        apply();
      }
    },
  };
}

/** Play's frame times (real ms between frames), GPU ms and render scales, for the harness. */
function createStats() {
  const CAP = 1 << 14;
  const real = new Float32Array(CAP);
  const gpu = new Float32Array(CAP);
  const scales = new Float32Array(CAP);
  let frames = 0;
  let gpuFrames = 0;
  // Draw calls and triangles per frame, sampled: their median says what the scene costs.
  const calls = [];
  const triangles = [];
  return {
    draws(callCount, triangleCount) {
      if (frames % 30 !== 0 || calls.length >= 512) return;
      calls.push(callCount);
      triangles.push(triangleCount);
    },
    add(realMs, gpuMs, scale) {
      if (!(realMs > 0)) return;
      real[frames % CAP] = realMs;
      scales[frames % CAP] = scale;
      frames += 1;
      if (gpuMs !== null) gpu[gpuFrames++ % CAP] = gpuMs;
    },
    reset() {
      frames = 0;
      gpuFrames = 0;
      calls.length = 0;
      triangles.length = 0;
    },
    read(extra) {
      // Frames per second through play, a reading per half second of real time, oldest first.
      const series = [];
      const kept = Math.min(frames, CAP);
      let spent = 0;
      let counted = 0;
      for (let i = 0; i < kept; i += 1) {
        spent += real[(frames - kept + i) % CAP];
        counted += 1;
        if (spent < 500) continue;
        series.push(Math.round((counted * 1000) / spent));
        spent = 0;
        counted = 0;
      }
      while (series.length > 120)
        series.splice(0, series.length, ...series.flatMap((x, i) => (i % 2 === 0 ? [x] : [])));
      const take = (array, n) =>
        Array.from(array.subarray(0, Math.min(n, CAP))).sort((a, b) => a - b);
      const times = take(real, frames);
      const gpus = take(gpu, gpuFrames);
      const at = (sorted, q) =>
        sorted.length === 0
          ? null
          : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
      const worst = times.slice(Math.floor(times.length * 0.99));
      const mean = (list) => list.reduce((sum, x) => sum + x, 0) / list.length;
      const round = (x, d = 1) => (x === null ? null : Number(x.toFixed(d)));
      return {
        frames: times.length,
        seconds: round(times.reduce((sum, x) => sum + x, 0) / 1000),
        medianMs: round(at(times, 0.5), 2),
        p99Ms: round(at(times, 0.99), 2),
        fps: times.length === 0 ? null : round(1000 / at(times, 0.5)),
        series,
        low1Fps: worst.length === 0 ? null : round(1000 / mean(worst)),
        gpuMs: round(at(gpus, 0.5), 2),
        gpuP95Ms: round(at(gpus, 0.95), 2),
        scale: round(at(take(scales, frames), 0.5), 2),
        drawCalls:
          calls.length === 0
            ? null
            : at(
                calls.toSorted((a, b) => a - b),
                0.5,
              ),
        triangles:
          triangles.length === 0
            ? null
            : at(
                triangles.toSorted((a, b) => a - b),
                0.5,
              ),
        ...extra,
      };
    },
  };
}
