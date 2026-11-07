// Models and textures the game names in main.js load once, behind the
// loading screen, before the title shows:
//
//   export const ASSETS = {
//     knight: "assets/models/knight.glb",
//     cat: "assets/blender/space_cat.asset.json", // an exported model: its sidecar
//     grass: "assets/textures/grass.png",
//   };
//
// then, in start(ctx) or later, synchronously:
//
//   const knight = ctx.assets.model("knight"); // a fresh copy each call; knight.animations holds its clips
//   ground.material.map = ctx.assets.texture("grass");
//
// A copy is safe to add, move and animate on its own (skinned characters keep
// their own skeleton), so every Retry gets new copies without reloading.
// Copies share materials: clone a material before changing its colour.
// A `.asset.json` entry is the sidecar game_blender_export writes beside its
// GLB: the GLB it names loads in its place, and every copy carries the sidecar
// as `copy.userData.asset` (clips' ground speeds, spring chains, height), which
// animate() reads.
// Sounds need no entry here: Juice.sfx and playMusic load them by path.
import * as THREE from "../vendor/three.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneObject } from "three/addons/utils/SkeletonUtils.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

const models = new Map();
const textures = new Map();

const SIDECAR = ".asset.json";
// The sidecar names its GLB by file name only, so it can never reach outside its folder.
const SIDECAR_MODEL = /^[A-Za-z0-9_.-]{1,120}\.glb$/;

const kindOf = (path) => {
  const file = path.toLowerCase().split("?")[0];
  if (file.endsWith(SIDECAR)) return "sidecar";
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
    return copy;
  },
  /** The loaded texture (shared; colour textures are already sRGB). */
  texture(name) {
    const texture = textures.get(name);
    if (texture === undefined) throw missing("texture", name, textures);
    return texture;
  },
  /** The whole loaded glTF (scene, animations, cameras; `userData.asset` for a sidecar entry), not copied. */
  gltf(name) {
    const gltf = models.get(name);
    if (gltf === undefined) throw missing("model", name, models);
    return gltf;
  },
};

/**
 * Loads every entry of the game's ASSETS, reporting progress as (done, total).
 * A file that fails is reported as a page error (the check sees it) and the
 * rest still load, so one bad path names itself instead of blanking the game.
 */
export async function preloadAssets(manifest, onProgress) {
  const entries = Object.entries(manifest ?? {});
  let done = 0;
  onProgress(done, entries.length);
  // GLTFLoader only logs a texture a model references and cannot find (a .glb
  // copied without its Textures/ folder), and the model then renders white.
  const listed = new Set(entries.map(([, path]) => path));
  const manager = new THREE.LoadingManager();
  manager.onError = (url) => {
    // A listed file's own failure is reported once, by name, below.
    if (!listed.has(url))
      reportError(new Error(`${url} did not load: a file an ASSETS model references is missing.`));
  };
  // The Hill Temple: models are meshopt-compressed; the template's loader had no decoder.
  const gltfLoader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
  const textureLoader = new THREE.TextureLoader(manager);
  await Promise.all(
    entries.map(async ([name, path]) => {
      try {
        const kind = typeof path === "string" ? kindOf(path) : null;
        if (kind === "model") models.set(name, withShadows(await gltfLoader.loadAsync(path)));
        else if (kind === "sidecar") {
          const asset = await readSidecar(path);
          const model = path.slice(0, path.lastIndexOf("/") + 1) + asset.model;
          listed.add(model);
          const gltf = withShadows(await gltfLoader.loadAsync(model));
          gltf.userData.asset = asset;
          models.set(name, gltf);
        } else if (kind === "texture") {
          const texture = await textureLoader.loadAsync(path);
          texture.colorSpace = THREE.SRGBColorSpace;
          textures.set(name, texture);
        } else
          throw new Error(
            `ASSETS.${name} is ${JSON.stringify(path)}: list .glb/.gltf models, .asset.json sidecars and .png/.jpg/.webp textures only.`,
          );
      } catch (error) {
        reportError(
          new Error(`ASSETS.${name} (${path}) did not load: ${error?.message ?? "not found"}`),
        );
      }
      onProgress(++done, entries.length);
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

// Every copy of a model casts and receives the look's shadows (shell/look.js).
function withShadows(gltf) {
  gltf.scene.traverse((object) => {
    if (object.isMesh) object.castShadow = object.receiveShadow = true;
  });
  return gltf;
}
