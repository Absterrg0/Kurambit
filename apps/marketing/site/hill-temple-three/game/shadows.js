// Sun shadows for a static sun over a static world: the world's shadow is rendered once, at
// load, into one 4096² depth map over the whole play area (the hills, the temple, the trees),
// and only the characters render a shadow map each frame, in a small box that follows the
// hero. Every lit material multiplies the sun by the baked map's PCF lookup; the moving
// characters still cast and receive through three's own shadow on the same light. Cascaded
// shadow maps redrew the 135k-triangle terrain and every prop three times a frame (15 ms of
// GPU time on the Iris Xe); this costs one small character pass and a few texture taps.
import * as THREE from "../vendor/three.module.js";

const BAKE_SIZE = 4096;

const VERT_PARS = /* glsl */ `
uniform mat4 bakedShadowMatrix;
varying vec4 vBakedCoord;`;
const VERT = /* glsl */ `
{
  vec4 bw = vec4(transformed, 1.0);
  vec3 bn = objectNormal;
  #ifdef USE_INSTANCING
    bw = instanceMatrix * bw;
    bn = mat3(instanceMatrix) * bn;
  #endif
  bw = modelMatrix * bw;
  bn = normalize(mat3(modelMatrix) * bn);
  // a small push along the normal keeps grazing surfaces from shadowing themselves
  vBakedCoord = bakedShadowMatrix * vec4(bw.xyz + bn * 0.42 + vec3(0.0, 0.08, 0.0), 1.0);
}`;
const FRAG_PARS = /* glsl */ `
uniform sampler2DShadow bakedShadowMap;
uniform float bakedTexel;
varying vec4 vBakedCoord;
float bakedShadow() {
  #ifdef BAKE_OFF
  return 1.0;
  #endif
  vec3 c = vBakedCoord.xyz / vBakedCoord.w;
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  float z = c.z - 0.0012;
  float s = 0.0;
  // 4 hardware-filtered (2x2) taps on a rotated square: a soft edge for a few fetches
  vec2 r = vec2(bakedTexel * 1.2);
  s += texture(bakedShadowMap, vec3(c.xy + vec2(-0.7, -0.3) * r, z));
  s += texture(bakedShadowMap, vec3(c.xy + vec2(0.3, -0.7) * r, z));
  s += texture(bakedShadowMap, vec3(c.xy + vec2(0.7, 0.3) * r, z));
  s += texture(bakedShadowMap, vec3(c.xy + vec2(-0.3, 0.7) * r, z));
  return s / 4.0;
}`;

export function createShadows(renderer, sunDir, sunColor, intensity) {
  // the one sun: lights everything; its own shadow map holds only the characters
  const sun = new THREE.DirectionalLight(sunColor, intensity);
  sun.name = "sun";
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 1;
  const half = 11;
  Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: 120 });
  sun.shadow.camera.updateProjectionMatrix();
  const group = new THREE.Group();
  group.name = "sun";
  group.add(sun, sun.target);

  const depth = new THREE.DepthTexture(BAKE_SIZE, BAKE_SIZE, THREE.UnsignedIntType);
  depth.compareFunction = THREE.LessEqualCompare;
  depth.minFilter = depth.magFilter = THREE.LinearFilter;
  const target = new THREE.WebGLRenderTarget(BAKE_SIZE, BAKE_SIZE, { depthTexture: depth, depthBuffer: true });
  const uniforms = {
    bakedShadowMap: { value: depth },
    bakedShadowMatrix: { value: new THREE.Matrix4() },
    bakedTexel: { value: 1 / BAKE_SIZE },
  };
  const patched = new WeakSet();

  return {
    group,
    sun,
    /** Makes a material read the baked shadow (once each); returns it. */
    patch(material) {
      if (patched.has(material)) return material;
      patched.add(material);
      const own = material.onBeforeCompile;
      material.onBeforeCompile = function (shader, r) {
        own?.call(this, shader, r);
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", `#include <common>\n${VERT_PARS}`)
          .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>\n${VERT}`);
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", `#include <common>\n${new URLSearchParams(location.search).has("nobake") ? "#define BAKE_OFF\n" : ""}${new URLSearchParams(location.search).has("showbake") ? `#define BAKE_SHOW ${new URLSearchParams(location.search).get("showbake")}\n` : ""}${FRAG_PARS}`)
          .replace(
            "#include <dithering_fragment>",
            `#include <dithering_fragment>
  #ifdef BAKE_SHOW
  { vec3 bc = vBakedCoord.xyz / vBakedCoord.w; gl_FragColor = BAKE_SHOW == 1 ? vec4(vec3(bakedShadow()), 1.0) : vec4(fract(bc.xy * 8.0), bc.z, 1.0); }
  #endif`,
          )
          .replace(
            "#include <lights_fragment_begin>",
            THREE.ShaderChunk.lights_fragment_begin.replaceAll("RE_Direct( directLight,", "directLight.color *= bakedShadow();\n\t\tRE_Direct( directLight,"),
          );
      };
      const key = material.customProgramCacheKey;
      material.customProgramCacheKey = () => `${key.call(material)}|baked`;
      material.needsUpdate = true;
      return material;
    },
    /** Renders the world's shadow once from the sun over `bounds` (a Box3), then stops it casting. */
    bake(world, bounds) {
      const cam = new THREE.OrthographicCamera();
      const centre = bounds.getCenter(new THREE.Vector3());
      const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
      cam.position.copy(centre).addScaledVector(sunDir, radius + 50);
      cam.lookAt(centre);
      cam.updateMatrixWorld();
      // fit the light-space box tightly around the bounds' corners
      const inv = cam.matrixWorldInverse;
      const box = new THREE.Box3();
      for (let i = 0; i < 8; i++)
        box.expandByPoint(
          new THREE.Vector3(i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z).applyMatrix4(inv),
        );
      Object.assign(cam, { left: box.min.x, right: box.max.x, bottom: box.min.y, top: box.max.y, near: -box.max.z - 30, far: -box.min.z + 5 });
      cam.updateProjectionMatrix();
      const scene = new THREE.Scene();
      const parent = world.parent;
      scene.add(world);
      const hidden = [];
      world.traverse((o) => {
        if ((o.isMesh || o.isPoints) && !o.castShadow && o.visible) {
          o.visible = false;
          hidden.push(o);
        }
      });
      scene.overrideMaterial = new THREE.MeshDepthMaterial();
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, cam);
      renderer.setRenderTarget(null);
      scene.overrideMaterial.dispose();
      for (const o of hidden) o.visible = true;
      scene.remove(world);
      parent?.add(world);
      // texture space: [-1, 1] to [0, 1]
      uniforms.bakedShadowMatrix.value
        .set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
        .multiply(cam.projectionMatrix)
        .multiply(cam.matrixWorldInverse);
      world.traverse((o) => {
        if (o.isMesh) o.castShadow = false; // the world is in the baked map now
      });
    },
    /** Keeps the characters' shadow box on the hero, in whole texels so its edges do not swim. */
    follow(at) {
      const texel = (half * 2) / sun.shadow.mapSize.x;
      const x = Math.round(at.x / texel) * texel;
      const y = Math.round(at.y / texel) * texel;
      const z = Math.round(at.z / texel) * texel;
      sun.target.position.set(x, y, z);
      sun.position.set(x, y, z).addScaledVector(sunDir, 60);
      sun.target.updateMatrixWorld();
    },
  };
}
