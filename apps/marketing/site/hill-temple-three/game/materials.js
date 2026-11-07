// Materials the world shares: Poly Haven textures (CC0) laid on in world space (triplanar), so
// Blender's flat named materials (stone, wood_red, roof...) become textured ones by name, as
// round 2 did in Godot. Every material is a MeshStandardMaterial patched in onBeforeCompile, so
// the cascaded shadows, the environment light and the fog keep working on it.
import * as THREE from "../vendor/three.module.js";

const loader = new THREE.TextureLoader();
const cache = new Map();
let maxAniso = 4;
export const setAnisotropy = (n) => (maxAniso = Math.min(n, 8));

/** A texture under assets/tex/, repeating, with mipmaps; colour maps in sRGB. */
export function tex(name, srgb = false) {
  const key = `${name}:${srgb}`;
  if (cache.has(key)) return cache.get(key);
  const t = loader.load(`./assets/tex/${name}.webp`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}
/** Every texture this module loaded, for the loading bar. */
export const loadedTextures = () => [...cache.values()];

const TRIPLANAR_VERT_PARS = /* glsl */ `
varying vec3 vTriPos;
varying vec3 vTriNrm;
`;
const TRIPLANAR_VERT = /* glsl */ `
#include <worldpos_vertex>
{
  vec4 tp = vec4(transformed, 1.0);
  vec3 tn = objectNormal;
  #ifdef USE_INSTANCING
    tp = instanceMatrix * tp;
    tn = mat3(instanceMatrix) * tn;
  #endif
  vTriPos = (modelMatrix * tp).xyz;
  vTriNrm = normalize(mat3(modelMatrix) * tn);
}
`;
const TRIPLANAR_FRAG_PARS = /* glsl */ `
varying vec3 vTriPos;
varying vec3 vTriNrm;
uniform sampler2D triMap;
uniform sampler2D triNormal;
uniform sampler2D triArm;
uniform vec3 triTint;
uniform float triScale;
uniform float triRough;
uniform float triArmOn;
vec3 triW;
vec2 triUvX, triUvY, triUvZ;
vec4 tri(sampler2D s) {
  return texture2D(s, triUvX) * triW.x + texture2D(s, triUvY) * triW.y + texture2D(s, triUvZ) * triW.z;
}
`;
const TRIPLANAR_SETUP = /* glsl */ `
  triW = pow(abs(normalize(vTriNrm)), vec3(4.0));
  triW /= (triW.x + triW.y + triW.z);
  triUvX = vTriPos.zy * triScale;
  triUvY = vTriPos.xz * triScale;
  triUvZ = vTriPos.xy * triScale;
`;

/**
 * A world-space textured surface: map, normal map and an ARM/roughness map from assets/tex.
 * {tint, scale (repeats per metre), roughness, arm: true when the third map is AO-rough-metal}
 */
export function triplanar({ map, normal, arm = null, tint = [1, 1, 1], scale = 0.5, roughness = 0.9, metalness = 0, name = "" }) {
  const m = new THREE.MeshStandardMaterial({ name, roughness, metalness });
  const uniforms = {
    triMap: { value: tex(map, true) },
    triNormal: { value: tex(normal) },
    triArm: { value: arm === null ? tex(normal) : tex(arm) },
    triTint: { value: new THREE.Color(...tint) },
    triScale: { value: scale },
    triRough: { value: roughness },
    triArmOn: { value: arm === null ? 0 : arm.endsWith("_arm") ? 1 : 2 },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${TRIPLANAR_VERT_PARS}`)
      .replace("#include <worldpos_vertex>", TRIPLANAR_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${TRIPLANAR_FRAG_PARS}`)
      .replace(
        "#include <map_fragment>",
        `${TRIPLANAR_SETUP}
  diffuseColor.rgb *= tri(triMap).rgb * triTint;`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `float roughnessFactor = triRough;
  if (triArmOn > 0.5) {
    vec4 arm = tri(triArm);
    roughnessFactor = triArmOn > 1.5 ? arm.r : clamp(arm.g * 1.1, 0.0, 1.0);
  }`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `{
    // whiteout-blended triplanar normals, in world space, then into view space
    vec3 nW = normalize(vTriNrm);
    vec3 tx = texture2D(triNormal, triUvX).xyz * 2.0 - 1.0;
    vec3 ty = texture2D(triNormal, triUvY).xyz * 2.0 - 1.0;
    vec3 tz = texture2D(triNormal, triUvZ).xyz * 2.0 - 1.0;
    tx = vec3(tx.xy + nW.zy, abs(tx.z) * nW.x);
    ty = vec3(ty.xy + nW.xz, abs(ty.z) * nW.y);
    tz = vec3(tz.xy + nW.xy, abs(tz.z) * nW.z);
    vec3 pw = normalize(tx.zyx * triW.x + ty.xzy * triW.y + tz.xyz * triW.z);
    normal = normalize((viewMatrix * vec4(pw, 0.0)).xyz);
  }`,
      );
  };
  m.customProgramCacheKey = () => `tri:${map}:${normal}:${arm}`;
  return m;
}

/** The named materials of round 2's Blender props, as Godot's reskin made them. */
export function propMaterials() {
  return {
    stone: triplanar({ name: "stone", map: "lichen_rock_diff", normal: "lichen_rock_nor_gl", arm: "lichen_rock_arm", tint: [0.92, 0.92, 0.86], scale: 0.9 }),
    stone_dark: triplanar({ name: "stone_dark", map: "lichen_rock_diff", normal: "lichen_rock_nor_gl", arm: "lichen_rock_arm", tint: [0.62, 0.63, 0.58], scale: 0.9 }),
    steps: triplanar({ name: "steps", map: "grey_stone_path_diff", normal: "grey_stone_path_nor_gl", arm: "grey_stone_path_arm", tint: [0.9, 0.88, 0.84], scale: 0.45 }),
    wood_red: triplanar({ name: "wood_red", map: "weathered_planks_diff", normal: "weathered_planks_nor_gl", arm: "weathered_planks_rough", tint: [0.78, 0.22, 0.16], scale: 0.8, roughness: 0.7 }),
    lattice: triplanar({ name: "lattice", map: "weathered_planks_diff", normal: "weathered_planks_nor_gl", tint: [0.6, 0.2, 0.16], scale: 2.0, roughness: 0.7 }),
    wood_dark: triplanar({ name: "wood_dark", map: "weathered_planks_diff", normal: "weathered_planks_nor_gl", arm: "weathered_planks_rough", tint: [0.36, 0.27, 0.22], scale: 1.2 }),
    roof: triplanar({ name: "roof", map: "grey_roof_tiles_diff", normal: "grey_roof_tiles_nor_gl", arm: "grey_roof_tiles_rough", tint: [0.62, 0.64, 0.66], scale: 0.35 }),
    bark: triplanar({ name: "bark", map: "weathered_planks_diff", normal: "weathered_planks_nor_gl", tint: [0.42, 0.36, 0.31], scale: 1.5, roughness: 0.95 }),
    pine: triplanar({ name: "pine", map: "withered_grass_diff", normal: "withered_grass_nor_gl", tint: [0.42, 0.52, 0.33], scale: 1.2, roughness: 0.95 }),
    plaster: new THREE.MeshStandardMaterial({ name: "plaster", color: new THREE.Color(0.82, 0.77, 0.68), roughness: 0.95 }),
    bronze: new THREE.MeshStandardMaterial({ name: "bronze", color: new THREE.Color(0.55, 0.38, 0.2), roughness: 0.4, metalness: 1 }),
    dark: new THREE.MeshStandardMaterial({ name: "dark", color: new THREE.Color(0.08, 0.07, 0.06), roughness: 0.8 }),
  };
}

/** Swaps every mesh's material for the named one, when there is one (the material name is the contract). */
export function reskin(root, mats) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const swap = (m) => mats[m.name.replace(/\.\d+$/, "")] ?? m;
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });
}

/**
 * The terrain: dry ground, withered grass and the laid stone path, blended by the vertex colour
 * (r path, g grass), sampled at two scales against tiling, with a slow warm/cool colour drift.
 */
export function terrainMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const u = {
    gMap: { value: tex("dry_ground_01_diff", true) },
    gNor: { value: tex("dry_ground_01_nor_gl") },
    rMap: { value: tex("withered_grass_diff", true) },
    rNor: { value: tex("withered_grass_nor_gl") },
    pMap: { value: tex("grey_stone_path_diff", true) },
    pNor: { value: tex("grey_stone_path_nor_gl") },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vTerrPos;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvTerrPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vTerrPos;
uniform sampler2D gMap, gNor, rMap, rNor, pMap, pNor;
float terrHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float terrNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(terrHash(i), terrHash(i + vec2(1, 0)), f.x), mix(terrHash(i + vec2(0, 1)), terrHash(i + vec2(1, 1)), f.x), f.y);
}
float tPath, tGrass, tMacro;
vec2 tUv, tUv2, tPuv;`,
      )
      .replace("#include <color_fragment>", "")
      .replace(
        "#include <map_fragment>",
        `tUv = vTerrPos.xz * 0.22;
  tUv2 = vTerrPos.xz * 0.061 + vec2(0.37, 0.71);
  tPuv = vTerrPos.xz * 0.30;
  tMacro = terrNoise(vTerrPos.xz * 0.045) * 0.6 + terrNoise(vTerrPos.xz * 0.17) * 0.4;
  tPath = vColor.r;
  float slope = 1.0 - clamp(normalize(vNormal).y, 0.0, 1.0);
  tGrass = clamp(vColor.g * 1.4 - slope * 2.5 + (tMacro - 0.5) * 0.6, 0.0, 1.0);
  // the large-scale drift (tMacro) breaks the tiling; one sample per layer
  vec3 g = texture2D(gMap, tUv).rgb * vec3(0.95, 0.85, 0.72);
  vec3 gr = texture2D(rMap, tUv * 0.7 + tMacro * 0.3).rgb * vec3(0.92, 0.58, 0.27);
  vec3 p = texture2D(pMap, tPuv).rgb * vec3(0.95, 0.93, 0.9);
  vec3 col = mix(g, gr, tGrass);
  col *= mix(vec3(0.92, 0.95, 1.02), vec3(1.06, 1.0, 0.92), tMacro);
  col = mix(col, p, tPath);
  diffuseColor.rgb *= col;`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `{
    vec3 n1 = texture2D(gNor, tUv).xyz * 2.0 - 1.0;
    vec3 n2 = texture2D(rNor, tUv * 0.7).xyz * 2.0 - 1.0;
    vec3 n3 = texture2D(pNor, tPuv).xyz * 2.0 - 1.0;
    vec3 tn = mix(mix(n1, n2, tGrass), n3, tPath);
    tn.xy *= 1.2;
    // the terrain is a heightfield: its tangent frame is the world's x and z, bent by the normal
    vec3 nW = normalize(inverseTransformDirection(normal, viewMatrix));
    vec3 T = normalize(vec3(1.0, 0.0, 0.0) - nW * nW.x);
    vec3 B = normalize(cross(T, nW));
    vec3 pw = normalize(T * tn.x + B * tn.y + nW * tn.z);
    normal = normalize((viewMatrix * vec4(pw, 0.0)).xyz);
  }`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "float roughnessFactor = mix(0.97, 0.82, tPath);",
      );
  };
  m.customProgramCacheKey = () => "terrain";
  return m;
}
