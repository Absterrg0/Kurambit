// The frame: cascaded sun shadows, an environment probe baked from the sky, then one post chain
// (pmndrs postprocessing, which merges effects into as few full-screen passes as it can):
// N8AO ambient occlusion at half resolution, analytic height fog with sun in-scatter, god rays,
// bloom on HDR highlights, AgX tone mapping, a colour grade, a vignette and SMAA.
// WebGL2, not WebGPU: the harness's Chromium, Firefox and most Linux browsers draw WebGL2 only,
// and three's WebGPURenderer on its WebGL2 fallback costs more than this hand-built chain.
import * as THREE from "../vendor/three.module.js";
import { createShadows } from "./shadows.js";
import {
  BlendFunction,
  BloomEffect,
  Effect,
  EffectComposer,
  EffectPass,
  GodRaysEffect,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
} from "postprocessing";
import { N8AOPostPass } from "n8ao";
import { SUN_COLOR, SUN_DIR } from "./world.js";

// Height fog in every lit material (three's fog chunks, replaced): exponential in height,
// integrated along the view ray, tinted toward the sun. It needs no depth pass, so it costs
// nothing beyond the shading itself. scene.fog = new THREE.Fog(color, density, falloff).
const S = SUN_DIR;
THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogWorld;
#endif`;
THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogWorld = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif`;
THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;
  varying vec3 vFogWorld;
#endif`;
THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  {
    vec3 rd = vFogWorld - cameraPosition;
    float dist = length(rd);
    rd /= max(dist, 1e-4);
    float k = fogFar;
    float dy = rd.y * dist;
    float base = fogNear * exp(-k * cameraPosition.y);
    float amount = abs(dy) > 1e-3 ? base * (1.0 - exp(-k * dy)) / (k * rd.y) : base * dist;
    float fogF = 1.0 - exp(-max(amount, 0.0));
    float sunF = max(dot(rd, vec3(${S.x.toFixed(4)}, ${S.y.toFixed(4)}, ${S.z.toFixed(4)})), 0.0);
    vec3 fogC = mix(fogColor, vec3(1.9, 1.15, 0.55), pow(sunF, 6.0) * 0.85 + pow(sunF, 32.0) * 0.6);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogC, fogF);
  }
#endif`;
/** The scene's fog: colour, density at the ground, height falloff. */
export const makeFog = () => new THREE.Fog(new THREE.Color(0.95, 0.66, 0.4), 0.0082, 0.06);

// After tone mapping: a warm lift in the shadows, a gentle S, a touch more saturation, a vignette.
const GRADE_FRAG = /* glsl */ `
uniform float gradeSat;
uniform vec3 gradeLift;
uniform vec3 gradeGain;
uniform float gradeVignette;
uniform float gradeSharp;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  {
    // a light sharpen from the scene's own luminance: it gives back the edges a lower render
    // scale softens (the canvas is stretched to the window after this)
    const vec3 W = vec3(0.2126, 0.7152, 0.0722);
    float l0 = dot(texture2D(inputBuffer, uv).rgb, W);
    float ln = dot(texture2D(inputBuffer, uv + vec2(texelSize.x, 0.0)).rgb, W)
      + dot(texture2D(inputBuffer, uv - vec2(texelSize.x, 0.0)).rgb, W)
      + dot(texture2D(inputBuffer, uv + vec2(0.0, texelSize.y)).rgb, W)
      + dot(texture2D(inputBuffer, uv - vec2(0.0, texelSize.y)).rgb, W);
    float detail = (l0 * 4.0 - ln) / max(ln, 1e-3);
    c *= 1.0 + gradeSharp * clamp(detail, -0.4, 0.4);
  }
  c = c * gradeGain + gradeLift * (1.0 - c);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, gradeSat);
  c = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
  vec2 v = uv - 0.5;
  c *= mix(1.0, 1.0 - dot(v, v) * 1.6, gradeVignette);
  // a little noise before the 8-bit canvas, so the long sky and fog gradients do not band
  float n = fract(sin(dot(uv * 1000.0 + fract(time * 7.0), vec2(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) / 255.0;
  outputColor = vec4(clamp(c, 0.0, 1.0), inputColor.a);
}`;
class GradeEffect extends Effect {
  constructor() {
    super("Grade", GRADE_FRAG, {
      uniforms: new Map([
        ["gradeSat", new THREE.Uniform(1.06)],
        ["gradeLift", new THREE.Uniform(new THREE.Vector3(0.022, 0.012, 0.004))],
        ["gradeGain", new THREE.Uniform(new THREE.Vector3(1.04, 0.98, 0.92))],
        ["gradeVignette", new THREE.Uniform(0.55)],
        ["gradeSharp", new THREE.Uniform(0.25)],
      ]),
    });
  }
}

/**
 * The renderer's pipeline. `quality` 0..2 picks shadow map size, AO and god rays; the frame
 * scale (render resolution) is set separately so it can adapt.
 */
const Q = new URLSearchParams(location.search);
export function createPipeline(renderer, camera, { quality = 2 } = {}) {
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = true;

  const shadows = createShadows(renderer, SUN_DIR, SUN_COLOR, 4.4);
  const followAt = new THREE.Vector3();

  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
  const renderPass = new RenderPass(new THREE.Scene(), camera);
  composer.addPass(renderPass);
  const size = renderer.getSize(new THREE.Vector2());
  const ao = new N8AOPostPass(new THREE.Scene(), camera, size.x, size.y);
  Object.assign(ao.configuration, {
    aoRadius: 1.6,
    distanceFalloff: 0.6,
    intensity: 2.6,
    aoSamples: Q.has("aos") ? Number(Q.get("aos")) : 5,
    denoiseSamples: 4,
    denoiseRadius: 8,
    denoiseIterations: 1,
    halfRes: true,
    depthAwareUpsampling: true,
    gammaCorrection: false,
    color: new THREE.Color(0.08, 0.05, 0.035),
  });
  if (!Q.has("noao")) composer.addPass(ao);

  const sunDisc = new THREE.Mesh(
    new THREE.CircleGeometry(26, 32),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.82, 0.55), transparent: true, fog: false, depthWrite: false }),
  );
  sunDisc.name = "sun disc";
  sunDisc.frustumCulled = false;
  const godRays =
    quality >= 1 && !Q.has("nogod")
      ? new GodRaysEffect(camera, sunDisc, {
          resolutionScale: 0.4,
          density: 0.94,
          decay: 0.93,
          weight: 0.38,
          exposure: 0.55,
          samples: 48,
          clampMax: 1,
          blur: true,
          blendFunction: BlendFunction.SCREEN,
        })
      : null;
  const bloom = new BloomEffect({ mipmapBlur: true, intensity: 0.55, luminanceThreshold: 0.95, luminanceSmoothing: 0.35, radius: 0.7, levels: 6 });
  const tone = new ToneMappingEffect({ mode: Q.has("agx") ? ToneMappingMode.AGX : ToneMappingMode.ACES_FILMIC });
  const grade = new GradeEffect();
  const smaa = new SMAAEffect({ preset: SMAAPreset.MEDIUM });
  const main = new EffectPass(camera, ...[godRays, Q.has("nobloom") ? null : bloom].filter(Boolean));
  const finish = new EffectPass(camera, ...[tone, grade, Q.has("nosmaa") ? null : smaa].filter(Boolean));
  composer.addPass(main);
  composer.addPass(finish);

  let scale = Q.has("scale") ? Number(Q.get("scale")) : 1;
  const resize = () => {
    renderer.setPixelRatio(scale);
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h, false);
  };

  // GPU time per frame (EXT_disjoint_timer_query_webgl2), when the browser offers it: what the
  // frame costs the GPU, apart from what the machine's other work does to the frame rate
  const gl = renderer.getContext();
  const timer = Q.has("notimer") ? null : gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const queries = [];
  const gpuMs = [];
  const timeBegin = () => {
    if (timer === null) return null;
    const q = gl.createQuery();
    gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
    return q;
  };
  const timeEnd = (q) => {
    if (q === null) return;
    gl.endQuery(timer.TIME_ELAPSED_EXT);
    queries.push(q);
    while (queries.length > 0 && gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)) {
      const done = queries.shift();
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) gpuMs.push(gl.getQueryParameter(done, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(done);
      if (gpuMs.length > 600) gpuMs.shift();
    }
  };
  return {
    gpuMs,
    shadows,
    shadowParent: shadows.group,
    followAt,
    sunDisc,
    composer,
    ao,
    bloom,
    godRays,
    grade,
    /** Makes every lit material under root read the baked sun shadow (once each). */
    prepare(root) {
      root.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          if (m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhysicalMaterial) shadows.patch(m);
      });
    },
    get scale() {
      return scale;
    },
    setScale(s) {
      scale = s;
      grade.uniforms.get("gradeSharp").value = 0.15 + (1 - s) * 0.9;
      resize();
    },
    resize,
    render(scene, dt) {
      // the god rays' light source: drawn only into the effect's own mask, never in the scene
      sunDisc.position.copy(camera.position).addScaledVector(SUN_DIR, 800);
      sunDisc.lookAt(camera.position);
      sunDisc.updateMatrixWorld();
      if (Q.has("noshadow")) renderer.shadowMap.enabled = false;
      shadows.follow(followAt);
      renderPass.mainScene = scene;
      renderPass.scene = scene;
      ao.scene = scene;
      const q = timeBegin();
      composer.render(dt);
      timeEnd(q);
    },
  };
}
