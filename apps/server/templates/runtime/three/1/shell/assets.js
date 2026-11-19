// Models and textures the game names in main.js load once, before the first run:
//
//   export const ASSETS = {
//     knight: "assets/models/knight.glb",
//     cat: "assets/blender/space_cat.asset.json", // an exported model: its sidecar
//     grass: "assets/textures/grass.png",
//     oak: "assets/textures/oak.surface.json", // a made surface (kurambit.surface): its texture set
//   };
//
// then, in start(ctx) or later, synchronously:
//
//   const knight = ctx.assets.model("knight"); // a fresh copy each call; knight.animations holds its clips
//   ground.material.map = ctx.assets.texture("grass");
//   floor.material = ctx.assets.surface("oak", { size: [8, 6] }); // tiled at its own metres over 8 x 6 m
//
// A copy is safe to add, move and animate on its own (skinned characters keep
// their own skeleton), so every Retry gets new copies without reloading.
// Copies share materials: clone a material before changing its colour.
// A `.asset.json` entry is the sidecar game_blender op export writes beside its
// GLB: the GLB it names loads in its place, and every copy carries the sidecar
// as `copy.userData.asset` (clips' ground speeds, spring chains, height), which
// animate() reads.
// Sounds need no entry here: Juice.sfx and playMusic load them by path.
import * as THREE from "../vendor/three.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { clone as cloneObject } from "three/addons/utils/SkeletonUtils.js";

const models = new Map();
const textures = new Map();
const surfaces = new Map();
// The shell's Stage bridge hears of each copy, so ASSETS models are things the
// Stage can select with no code in the game (shell/stage-bridge.js).
let copied = null;
export const onModelCopy = (fn) => {
  copied = fn;
};

const SIDECAR = ".asset.json";
const SURFACE = ".surface.json";
// A surface names its images by file name only, beside it.
const SURFACE_IMAGE = /^[A-Za-z0-9_.-]{1,120}\.(webp|png|jpg|jpeg)$/;
// The sidecar names its GLB by file name only, so it can never reach outside its folder.
const SIDECAR_MODEL = /^[A-Za-z0-9_.-]{1,120}\.glb$/;

const kindOf = (path) => {
  const file = path.toLowerCase().split("?")[0];
  if (file.endsWith(SIDECAR)) return "sidecar";
  if (file.endsWith(SURFACE)) return "surface";
  const extension = file.split(".").pop();
  if (extension === "glb" || extension === "gltf") return "model";
  if (["png", "jpg", "jpeg", "webp"].includes(extension)) return "texture";
  return null;
};

const missing = (kind, name, loaded) =>
  new Error(
    `No ${kind} "${name}" in ASSETS (main.js). Loaded ${kind}s: ${[...loaded.keys()].join(", ") || "none"}.`,
  );

export const assets = {
  /** A new copy of a loaded model, ready to add to the scene; `.animations` holds its clips. */
  model(name) {
    const gltf = models.get(name);
    if (gltf === undefined) throw missing("model", name, models);
    const copy = cloneObject(gltf.scene);
    copy.animations = gltf.animations;
    if (gltf.userData.asset !== undefined) copy.userData.asset = gltf.userData.asset;
    copied?.(copy, name, gltf.userData.source);
    return copy;
  },
  /** The loaded texture (shared; colour textures are already sRGB). */
  texture(name) {
    const texture = textures.get(name);
    if (texture === undefined) throw missing("texture", name, textures);
    return texture;
  },
  /**
   * A made surface as a material of its own: its colour, normal and occlusion-roughness-metal
   * maps tiled over the mesh's 0..1 UVs. `size: [across, up]` is the metres those UVs span (the
   * surface repeats at its own scale), or `repeat` the tiles outright; `colour` tints it.
   */
  surface(name, { size, repeat, colour } = {}) {
    const surface = surfaces.get(name);
    if (surface === undefined) throw missing("surface", name, surfaces);
    const metres = surface.info.metres > 0 ? surface.info.metres : 1;
    const [rx, ry] =
      repeat !== undefined
        ? [repeat, repeat].flat().slice(0, 2)
        : size !== undefined
          ? [size[0] / metres, size[1] / metres]
          : [1, 1];
    const tiled = (texture) => {
      const copy = texture.clone();
      copy.wrapS = copy.wrapT = THREE.RepeatWrapping;
      copy.repeat.set(rx, ry);
      copy.needsUpdate = true;
      return copy;
    };
    const orm = tiled(surface.orm);
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colour ?? surface.info.colour ?? "#ffffff"),
      map: tiled(surface.color),
      normalMap: tiled(surface.normal),
      aoMap: orm,
      roughnessMap: orm,
      metalnessMap: orm,
      roughness: 1,
      metalness: 1,
    });
    material.name = name;
    return material;
  },
  /** The whole loaded glTF (scene, animations, cameras; `userData.asset` for a sidecar entry), not copied. */
  gltf(name) {
    const gltf = models.get(name);
    if (gltf === undefined) throw missing("model", name, models);
    return gltf;
  },
};

/**
 * Loads every entry of the game's ASSETS.
 * A file that fails is reported as a page error (the check sees it) and the
 * rest still load, so one bad path names itself instead of blanking the game.
 */
export async function preloadAssets(manifest) {
  const entries = Object.entries(manifest ?? {});
  // GLTFLoader only logs a texture a model references and cannot find (a .glb
  // copied without its Textures/ folder), and the model then renders white.
  const listed = new Set(entries.map(([, path]) => path));
  const manager = new THREE.LoadingManager();
  manager.onError = (url) => {
    // A listed file's own failure is reported once, by name, below.
    if (!listed.has(url))
      reportError(new Error(`${url} did not load: a file an ASSETS model references is missing.`));
  };
  // game_blender op export ships meshopt-compressed geometry (its WebP images three reads natively).
  const gltfLoader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
  const textureLoader = new THREE.TextureLoader(manager);
  await Promise.all(
    entries.map(async ([name, path]) => {
      try {
        const kind = typeof path === "string" ? kindOf(path) : null;
        if (kind === "model") {
          const gltf = withShadows(await gltfLoader.loadAsync(path));
          // A plain GLB says nothing of what it is: one that moves is taken for a character.
          gltf.userData.source = { path, kind: gltf.animations.length > 0 ? "character" : "prop" };
          models.set(name, gltf);
        } else if (kind === "sidecar") {
          const asset = await readSidecar(path);
          const model = path.slice(0, path.lastIndexOf("/") + 1) + asset.model;
          listed.add(model);
          const gltf = withShadows(await gltfLoader.loadAsync(model));
          gltf.userData.asset = asset;
          gltf.userData.source = {
            path: model,
            sidecar: path,
            kind: asset.kind === "character" ? "character" : "prop",
          };
          models.set(name, gltf);
        } else if (kind === "texture") {
          const texture = await textureLoader.loadAsync(path);
          texture.colorSpace = THREE.SRGBColorSpace;
          textures.set(name, texture);
        } else if (kind === "surface") {
          const info = await readSurface(path);
          const folder = path.slice(0, path.lastIndexOf("/") + 1);
          const load = async (file, colourSpace) => {
            listed.add(folder + file);
            const texture = await textureLoader.loadAsync(folder + file);
            texture.colorSpace = colourSpace;
            return texture;
          };
          surfaces.set(name, {
            info,
            color: await load(info.color, THREE.SRGBColorSpace),
            normal: await load(info.normal, THREE.NoColorSpace),
            orm: await load(info.orm, THREE.NoColorSpace),
          });
        } else
          throw new Error(
            `ASSETS.${name} is ${JSON.stringify(path)}: list .glb/.gltf models, .asset.json sidecars, .surface.json surfaces and .png/.jpg/.webp textures only.`,
          );
      } catch (error) {
        reportError(
          new Error(`ASSETS.${name} (${path}) did not load: ${error?.message ?? "not found"}`),
        );
      }
    }),
  );
}

async function readSidecar(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`not found (${response.status})`);
  const asset = await response.json();
  if (asset?.version !== 1)
    throw new Error(`its version is ${JSON.stringify(asset?.version)}; this shell reads version 1`);
  if (typeof asset.model !== "string" || !SIDECAR_MODEL.test(asset.model))
    throw new Error(`its model ${JSON.stringify(asset.model)} is not a .glb file name beside it`);
  return asset;
}

async function readSurface(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`not found (${response.status})`);
  const info = await response.json();
  if (info?.version !== 1)
    throw new Error(`its version is ${JSON.stringify(info?.version)}; this shell reads version 1`);
  for (const key of ["color", "normal", "orm"])
    if (typeof info[key] !== "string" || !SURFACE_IMAGE.test(info[key]))
      throw new Error(
        `its ${key} ${JSON.stringify(info[key])} is not an image file name beside it`,
      );
  return info;
}

// Every copy of a model casts and receives the look's shadows (shell/look.js), and its foliage is
// lit from both faces alike. The model viewer loads its file the same way, so it shows what plays.
export function withShadows(gltf) {
  gltf.scene.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = object.receiveShadow = true;
    if (greyMask(object))
      for (const material of [object.material].flat()) {
        material.vertexColors = false;
        material.needsUpdate = true;
      }
    if (isFoliage(object))
      for (const material of [object.material].flat()) {
        material.defines = { ...material.defines, LOOK_FOLIAGE: "" };
        material.needsUpdate = true;
      }
  });
  return gltf;
}

/**
 * Grey vertex colours on a textured model are a mask the model's own engine reads (wind, ambient
 * occlusion), not a tint: drawn as colour they turn grass and bark nearly black, so they are not
 * drawn. A model coloured by its vertices has no texture, or colours that are not grey.
 */
function greyMask(mesh) {
  const colors = mesh.geometry?.attributes?.color;
  if (colors === undefined || colors.count === 0) return false;
  if (![mesh.material].flat().every((material) => material?.map != null)) return false;
  const step = Math.max(1, Math.floor(colors.count / 256));
  for (let i = 0; i < colors.count; i += step) {
    const r = colors.getX(i);
    if (Math.abs(r - colors.getY(i)) > 0.02 || Math.abs(r - colors.getZ(i)) > 0.02) return false;
  }
  return true;
}

/**
 * Double-sided foliage, authored for engines that light both faces alike (shell/look.js lights it
 * so): a cut-out card (leaves, flowers: alpha-tested) or a mesh whose normals nearly all point up
 * (grass). A solid double-sided cloth or sign keeps three's own two-sided lighting.
 */
function isFoliage(mesh) {
  const materials = [mesh.material].flat();
  if (!materials.every((material) => material?.side === THREE.DoubleSide)) return false;
  if (materials.every((material) => material.alphaTest > 0)) return true;
  const normals = mesh.geometry?.attributes?.normal;
  if (normals === undefined || normals.count === 0) return false;
  const step = Math.max(1, Math.floor(normals.count / 256));
  let up = 0;
  let seen = 0;
  for (let i = 0; i < normals.count; i += step) {
    seen += 1;
    if (normals.getY(i) > 0.9) up += 1;
  }
  return up / seen >= 0.8;
}
