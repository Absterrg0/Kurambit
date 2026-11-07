// The look every frame goes through. A preset picks the light, the sky, the fog
// and the post chain; main.js chooses one in one line and may override any part:
//
//   export const LOOK = { preset: "day" };   // "day" (the default), "golden" (golden hour),
//                                            // "night", "interior", "flat" (stylised, no post)
//   export const LOOK = {
//     preset: "golden",
//     exposure: 1.1,
//     toneMapping: "aces",    // "neutral" keeps base colours, "agx" and "aces" are filmic, "none"
//     environment: "sky",     // the light around the scene: "sky" (the preset's sky, or the scene's
//                             // own background texture), "room" (a studio interior), false: none
//     ambient: 1,             // that light's strength
//     sky: { top: 0x4a6ea8, horizon: 0xf2b27a, ground: 0x5a4a3c, light: 0.45 }, // the drawn sky;
//                             // its light is the same sky at `light` saturation
//     sun: { direction: { x: -0.6, y: 0.22, z: 0.75 }, color: 0xffc98a, intensity: 3.6 },
//     fog: { density: 0.008, height: 0.05, color: 0xf2b27a }, // height fog: thick low, thin high;
//                             // false: none
//     shadows: true,
//     ao: { radius: 1.5, intensity: 2.5 },        // ambient occlusion in corners and contacts; false
//     bloom: { strength: 0.5, threshold: 0.95 },  // colours above the threshold glow; false
//     grade: { saturation: 1.08, contrast: 1.05, warmth: 0.05, vignette: 0.5 },
//     resolution: "adaptive", // the render scale follows the GPU's time to hold 60 fps, with a
//                             // sharpen; or a fixed scale such as 1 or 0.75
//   };
//
// The post chain (AO, bloom, tone mapping, the grade, SMAA) is one merged chain
// over a half-float frame, with no MSAA under it. "flat" draws straight to the
// canvas with its MSAA, as does any look in a browser drawing in software. The
// sky is drawn behind the scene and lights it (an environment probe), unless
// the game sets scene.background (a texture there becomes the probe) or
// scene.environment itself. The look's fog is set when the game sets none;
// three.js's own Fog and FogExp2 still work as documented.
//
// Through an orthographic camera with no preset and no toneMapping named, the
// frame draws straight and untouched, so a 2D or pixel-art game's sprites keep
// their files' exact colours (with LOOK = { environment: false, shadows: false }).
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
    sky: { top: 0x5b8fd8, horizon: 0xd0e0ee, ground: 0x3a3936 },
    sun: { direction: { x: -0.45, y: 0.8, z: 0.4 }, color: 0xfff2de, intensity: 2.6 },
    fog: { density: 0.004, height: 0.06 },
    ao: { radius: 1.2, intensity: 1.8 },
    bloom: { strength: 0.25, threshold: 1.1 },
    grade: { saturation: 1.06, contrast: 1.04, warmth: 0.01, vignette: 0.25 },
  },
  golden: {
    toneMapping: "aces",
    exposure: 1,
    ambient: 0.9,
    sky: { top: 0x46689e, horizon: 0xf0ae78, ground: 0x3a3029 },
    sun: { direction: { x: -0.6, y: 0.22, z: 0.75 }, color: 0xffc58a, intensity: 3.4 },
    fog: { density: 0.008, height: 0.05 },
    ao: { radius: 1.5, intensity: 2.4 },
    bloom: { strength: 0.5, threshold: 0.95 },
    grade: { saturation: 1.08, contrast: 1.06, warmth: 0.05, vignette: 0.5 },
  },
  night: {
    toneMapping: "aces",
    exposure: 1.3,
    ambient: 2.4,
    sky: { top: 0x0a1430, horizon: 0x2c3e68, ground: 0x0b0d14, light: 0.8 },
    sun: { direction: { x: -0.35, y: 0.75, z: 0.45 }, color: 0xa9bdff, intensity: 1.5 },
    fog: { density: 0.012, height: 0.05 },
    ao: { radius: 1.2, intensity: 2 },
    bloom: { strength: 0.9, threshold: 0.75 },
    grade: { saturation: 0.92, contrast: 1.08, warmth: -0.04, vignette: 0.6 },
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
export function resolveLook(options = {}) {
  const name = options.preset ?? "day";
  const preset = PRESETS[name];
  if (preset === undefined)
    throw new Error(`LOOK.preset must be one of ${Object.keys(PRESETS).join(", ")}.`);
  const part = (key) => {
    const own = options[key];
    if (own === false) return false;
    if (own === true) return preset[key] === false ? (DEFAULT_PARTS[key] ?? {}) : preset[key];
    if (own === undefined) return preset[key];
    return { ...(preset[key] || DEFAULT_PARTS[key] || {}), ...own };
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
    resolution: options.resolution ?? "adaptive",
    // A 2D game's exact colours: an orthographic camera with nothing about the look named.
    exactWhenOrthographic: options.preset === undefined && options.toneMapping === undefined,
  };
  if (TONE[look.toneMapping] === undefined)
    throw new Error(`LOOK.toneMapping must be one of ${Object.keys(TONE).join(", ")}.`);
  if (!ENVIRONMENTS.has(look.environment))
    throw new Error('LOOK.environment must be "sky", "room" or false.');
  if (look.resolution !== "adaptive" && !(look.resolution > 0))
    throw new Error('LOOK.resolution must be "adaptive" or a scale such as 0.75.');
  // "flat" is the cheap look: no chain at all, the canvas's own MSAA.
  look.post = name !== "flat" || look.ao !== false || look.bloom !== false || look.grade !== false;
  return look;
}
const DEFAULT_PARTS = PRESETS.day;

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
};

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
  const lit =
    shader.fragmentShader.includes("#include <lights_fragment_begin>") &&
    shader.vertexShader.includes("#include <worldpos_vertex>") &&
    shader.vertexShader.includes("#include <beginnormal_vertex>");
  if (fog || lit) Object.assign(shader.uniforms, shared);
  if (!lit) return;
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      "#include <common>\n#define LOOK_BAKED\nuniform mat4 lookBakedMatrix;\nuniform float lookBakedPush;\nvarying vec4 vLookBaked;",
    )
    .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>\n${BAKED_VERTEX}`);
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n#define LOOK_BAKED\n${BAKED_FRAGMENT}`)
    .replace("#include <lights_fragment_begin>", LIGHTS_BAKED);
}
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
varying vec3 vDir;
void main() {
  vec3 d = normalize( vDir );
  vec3 c = d.y > 0.0
    ? mix( horizon, top, pow( smoothstep( 0.0, 1.0, d.y ), 0.55 ) )
    : mix( horizon, ground, smoothstep( 0.0, 0.2, - d.y ) );
  float s = max( dot( d, sunDir ), 0.0 );
  c += sunColor * ( pow( s, 6.0 ) * 0.18 + pow( s, 90.0 ) * 0.5 + smoothstep( 0.9990, 0.9994, s ) * 3.0 );
  c = mix( vec3( dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ) ), c, saturation );
  gl_FragColor = vec4( c, 1.0 );
}`;

/**
 * The drawn sky and the light it gives, as two probes: the light's sky is
 * desaturated, so a blue sky does not turn every model blue (library models are
 * coloured for neutral light) while the backdrop keeps its colour.
 */
async function skyProbes(renderer, look, sunDir) {
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
    },
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), material);
  const scene = new THREE.Scene().add(sphere);
  const background = pmrem.fromScene(scene, 0, 0.1, 400).texture;
  let light;
  if (look.environment === "room") {
    const { RoomEnvironment } = await import("three/addons/environments/RoomEnvironment.js");
    light = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  } else {
    material.uniforms.saturation.value = look.sky.light ?? 0.45;
    light = pmrem.fromScene(scene, 0, 0.1, 400).texture;
  }
  sphere.geometry.dispose();
  material.dispose();
  pmrem.dispose();
  return { background, light };
}

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
  const renderer = new THREE.WebGLRenderer({
    canvas,
    // MSAA only without the chain: under it the frame is a float target and SMAA does the edges.
    antialias: !look.post,
    powerPreference: "high-performance",
  });
  const devicePixels = Math.min(window.devicePixelRatio ?? 1, 2);
  renderer.setPixelRatio(devicePixels);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = look.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMappingExposure = look.exposure;
  const gpu = isSoftware(renderer);
  const post = look.post && !gpu.software;

  const sunDir = new THREE.Vector3(
    look.sun.direction.x,
    look.sun.direction.y,
    look.sun.direction.z,
  );
  sunDir.normalize();
  shared.lookSunDir.value.copy(sunDir);
  if (look.fog !== false)
    shared.lookSunGlow.value.set(look.sun.color).multiplyScalar(look.sun.intensity * 0.25);
  const sky = await skyProbes(renderer, look, sunDir);
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
  const scale = createScale(renderer, look, devicePixels, (s) => {
    chain?.resize(s);
  });
  const stats = createStats();
  const probes = new WeakMap();
  const prepared = new WeakSet();
  const suns = new Set();

  /** The scene's sky, light and fog, once per scene, after the game has built it. */
  const dress = (scene, camera) => {
    if (prepared.has(scene)) return;
    prepared.add(scene);
    if (exact(camera)) return;
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

  const draw = (scene, camera, dt) => {
    dress(scene, camera);
    if (chain === null || exact(camera)) {
      renderer.toneMapping = exact(camera) ? THREE.NoToneMapping : TONE[look.toneMapping];
      renderer.render(scene, camera);
      return;
    }
    renderer.toneMapping = THREE.NoToneMapping;
    chain.render(scene, camera, dt);
  };

  const bake = (root, { bounds = null, size = 4096 } = {}) => {
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
      timer.begin();
      work();
      timer.end();
      const gpuMs = timer.poll();
      scale.update(gpuMs, realMs);
      if (playing) stats.add(realMs, gpuMs, scale.value);
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
        renderer.compileAsync(scene, camera).catch(() => undefined),
        new Promise((done) => setTimeout(done, waitMs)),
      ]);
    },
    /**
     * Compiles every program a run will use (the models lit as a run is, the
     * shadow pass and the post chain) and draws them once, off screen behind
     * the loading screen, so the first frame of play does not stall on them.
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
      await renderer.compileAsync(scene, camera).catch(() => undefined);
      draw(scene, camera, 0);
      renderer.clear();
      scene.remove(sun, ...models);
    },
    resize(width, height) {
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
          light.shadow.mapSize.set(1024, 1024);
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
          const rig = { light, follow, toLight, distance: size * 1.5, texel: size / 1024 };
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
const SCALE_MIN = 0.5;

/**
 * The render scale: a share of the device's pixels per side. Adaptive, it
 * follows the GPU's median time over the last half second toward the budget
 * (pixels cost as the square of the scale), in 0.05 steps so the frame
 * buffers are not remade every frame; without GPU timers it only steps down
 * when frames run long.
 */
function createScale(renderer, look, devicePixels, onChange) {
  const fixed = look.resolution === "adaptive" ? null : Math.min(look.resolution, 1);
  let value = fixed ?? 1;
  const gpu = [];
  const real = [];
  let since = 0;
  let settle = 0.5;
  const apply = () => {
    renderer.setPixelRatio(devicePixels * value);
    onChange(value);
  };
  const median = (list) => list.toSorted((a, b) => a - b)[list.length >> 1];
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
      since = 0;
      // The first half second after a change settles (new buffers, first draws).
      if (settle > 0) {
        settle -= 0.5;
        gpu.length = 0;
        real.length = 0;
        return;
      }
      let next = value;
      if (gpu.length >= 8) {
        const ms = median(gpu);
        if (ms > GPU_BUDGET_MS) next = value * Math.max(0.8, Math.sqrt(GPU_BUDGET_MS / ms));
        else if (ms < GPU_BUDGET_MS * 0.65)
          next = value * Math.min(1.1, Math.sqrt((GPU_BUDGET_MS * 0.8) / ms));
      } else if (real.length >= 8 && median(real) > 20) next = value * 0.9;
      gpu.length = 0;
      real.length = 0;
      next = Math.min(1, Math.max(SCALE_MIN, Math.round(next * 20) / 20));
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
  return {
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
    },
    read(extra) {
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
        low1Fps: worst.length === 0 ? null : round(1000 / mean(worst)),
        gpuMs: round(at(gpus, 0.5), 2),
        gpuP95Ms: round(at(gpus, 0.95), 2),
        scale: round(at(take(scales, frames), 0.5), 2),
        ...extra,
      };
    },
  };
}
