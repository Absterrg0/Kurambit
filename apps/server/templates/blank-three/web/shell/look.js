// The look every frame goes through: tone mapping, an environment light, soft
// shadows and anti-aliasing (the canvas's own MSAA), plus bloom on bright
// colours when the game asks for it. The shell builds it once and draws
// through it; main.js tunes it with one export:
//
//   export const LOOK = {
//     toneMapping: "neutral", // "neutral" shifts base colours little and rolls highlights off,
//                             // "agx" is filmic, "none" leaves colours exact
//     exposure: 1,
//     environment: "sky",     // "sky": light from above and the ground; "room": an image-based
//                             // light that metals reflect (heavier); false: none
//     ambient: 1,             // the environment light's strength
//     shadows: true,
//     bloom: false,           // true, or { strength: 0.5, radius: 0.4, threshold: 1 }: colours
//                             // above 1 (emissive, HDR) glow
//   };
//
// Bloom is off unless asked for: it draws every frame through extra
// full-screen passes, about ten times the cost of the plain look in a software
// renderer (the browser the harness plays in) and on weak GPUs. Turn it on for
// a game whose glows matter, and keep emissive colours above 1 so only they glow.
//
// Through an orthographic camera (a 2D or pixel-art game) nothing is tone
// mapped unless LOOK names a toneMapping, so a sprite draws its file's exact
// colours. A 2D game also drops the 3D lighting with
//   export const LOOK = { environment: false, shadows: false };
//
// A sun that casts soft shadows wherever the player goes (its shadow camera
// follows the target, so shadows never end at the edge of a fixed box):
//   const sun = ctx.look.sun({ follow: ctx.player, size: 30 }); // a DirectionalLight, in the scene
//   sun.intensity = 2.5;
// Models from ASSETS already cast and receive shadows; a mesh you build needs
// mesh.castShadow = true (and receiveShadow for the ground).
// The bloom and room-light add-ons load only when LOOK asks for them.
import * as THREE from "../vendor/three.module.js";

const TONE = {
  neutral: THREE.NeutralToneMapping,
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  none: THREE.NoToneMapping,
};
const BLOOM = { strength: 0.5, radius: 0.4, threshold: 1 };
const ENVIRONMENTS = new Set(["sky", "room", false]);

export async function createLook(renderer, options = {}) {
  const tone = TONE[options.toneMapping ?? "neutral"];
  // An orthographic camera draws sprites; they keep their colours unless LOOK says otherwise.
  const toneFor = (camera) =>
    options.toneMapping === undefined && camera.isOrthographicCamera === true
      ? THREE.NoToneMapping
      : tone;
  if (tone === undefined)
    throw new Error(`LOOK.toneMapping must be one of ${Object.keys(TONE).join(", ")}.`);
  const environment = options.environment ?? "sky";
  if (!ENVIRONMENTS.has(environment))
    throw new Error('LOOK.environment must be "sky", "room" or false.');
  const ambient = options.ambient ?? 1;
  renderer.toneMapping = tone;
  renderer.toneMappingExposure = options.exposure ?? 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = options.shadows !== false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  let room = null;
  if (environment === "room") {
    const { RoomEnvironment } = await import("three/addons/environments/RoomEnvironment.js");
    const pmrem = new THREE.PMREMGenerator(renderer);
    room = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  }

  // Without bloom the renderer draws straight to the canvas, tone mapping in
  // the material shaders: no extra pass at all.
  let composer = null;
  let scenePass = null;
  if (options.bloom !== undefined && options.bloom !== false) {
    const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] =
      await Promise.all([
        import("three/addons/postprocessing/EffectComposer.js"),
        import("three/addons/postprocessing/RenderPass.js"),
        import("three/addons/postprocessing/UnrealBloomPass.js"),
        import("three/addons/postprocessing/OutputPass.js"),
      ]);
    const bloom = { ...BLOOM, ...(options.bloom === true ? {} : options.bloom) };
    const size = renderer.getSize(new THREE.Vector2());
    // Half-float keeps colours above 1 for the bloom; the canvas's own
    // antialias does not reach a render target, so it takes 4x MSAA itself.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    composer = new EffectComposer(renderer, target);
    scenePass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    composer.addPass(scenePass);
    composer.addPass(new UnrealBloomPass(size, bloom.strength, bloom.radius, bloom.threshold));
    // Tone mapping and the sRGB conversion, from the renderer's settings.
    composer.addPass(new OutputPass());
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(size.x, size.y);
  }

  const suns = new Set();

  return {
    /** Lights a run's fresh scene with the environment. */
    prepare(scene) {
      if (environment === "room") {
        scene.environment = room;
        scene.environmentIntensity = ambient;
      } else if (environment === "sky") {
        const light = new THREE.HemisphereLight(0xdde8ff, 0x5c5248, ambient * 1.4);
        light.name = "look-environment";
        scene.add(light);
      }
    },
    render(scene, camera) {
      renderer.toneMapping = toneFor(camera);
      if (composer === null) {
        renderer.render(scene, camera);
        return;
      }
      scenePass.scene = scene;
      scenePass.camera = camera;
      composer.render();
    },
    /**
     * Compiles the shaders the models will need (lit by the environment and a
     * shadow-casting sun, as a run is) and draws them once, off screen behind
     * the loading screen. Without it the first frame of play compiles them,
     * which freezes the start for a second or more in a software renderer.
     */
    warm(models) {
      if (models.length === 0) return;
      const scene = new THREE.Scene();
      this.prepare(scene);
      const sun = new THREE.DirectionalLight(0xffffff, 1);
      sun.castShadow = true;
      scene.add(sun, ...models);
      const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
      camera.position.set(0, 4, 12);
      camera.lookAt(0, 1, 0);
      // One draw compiles the scene's and the shadow pass's programs alike.
      this.render(scene, camera);
      renderer.clear();
    },
    resize(width, height) {
      if (composer === null) return;
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(width, height);
    },
    /** The run's API, as ctx.look. */
    forRun(ctx) {
      return {
        sun({ follow = null, size = 30, intensity = 2.5, color = 0xfff2dd, direction } = {}) {
          const light = new THREE.DirectionalLight(color, intensity);
          const toLight = new THREE.Vector3(-0.5, 1, 0.35);
          if (direction !== undefined) toLight.set(direction.x, direction.y, direction.z);
          toLight.normalize();
          light.castShadow = true;
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
      };
    },
    /** Moves each sun's shadow box to its target; the shell calls it every frame of play. */
    update() {
      for (const rig of suns) place(rig);
    },
    /** Drops the run's suns and frees their shadow maps. */
    reset() {
      for (const rig of suns) rig.light.shadow.dispose();
      suns.clear();
    },
  };
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
