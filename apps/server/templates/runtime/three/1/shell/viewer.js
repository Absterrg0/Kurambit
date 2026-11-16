// The Workbench's Art tab's model viewer: one model file of the game, alone, with orbit, pan and
// zoom under a neutral studio light, on a one-metre grid beside the 1.8 m figure the model sheet
// draws (shell/sheet.js). It draws only when something changed (a drag, a toggle, a clip
// playing), never in an idle loop. The Art tab drives it with postMessage; the page answers
// what the model holds (triangles, materials, textures, clips, bones, size).
//
// With `?thumbnails`, the page draws small pictures for the Art tab's list instead, one model at
// a time, and keeps nothing between them.
import * as THREE from "../vendor/three.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VertexNormalsHelper } from "three/addons/helpers/VertexNormalsHelper.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { drawnBox, stats } from "./model.js";
import { personFigure } from "./sheet.js";

const THUMBNAILS = new URLSearchParams(location.search).has("thumbnails");
const THUMBNAIL_SIZE = 192;
// Normals of more vertices than this read as fur, and cost a draw each: the toggle says so instead.
const MAX_NORMALS = 60_000;
const BACKDROP = 0x17181b;

const canvas = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
const scene = new THREE.Scene();
scene.background = THUMBNAILS ? null : new THREE.Color(BACKDROP);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.9;
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(3, 6, 4);
scene.add(key);

const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 2000);
const controls = THUMBNAILS ? null : new OrbitControls(camera, canvas);
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

const stage = new THREE.Group();
scene.add(stage);
const figure = personFigure();
const grid = new THREE.Group();
if (!THUMBNAILS) stage.add(figure, grid);

/** What is shown now: the model's root, its clips and helpers, and the toggles. */
let model = null;
let mixer = null;
let action = null;
let clips = [];
let playing = false;
let helpers = { normals: null, skeleton: null, bounds: null, pivot: null };
const view = { wireframe: false, normals: false, skeleton: false, bounds: false };
const look = { tint: 0xffffff, scale: 1 };
let token = 0;

const post = (message) => window.parent.postMessage({ source: "kurambit-viewer", ...message }, "*");

// ─── Drawing on demand ─────────────────────────────────────────────────────────

let queued = false;
const draw = () => {
  queued = false;
  renderer.render(scene, camera);
};
const requestDraw = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    if (!playing) draw();
  });
};
controls?.addEventListener("change", requestDraw);

const resize = () => {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  requestDraw();
};
if (!THUMBNAILS) new ResizeObserver(resize).observe(canvas);

// A clip playing is the one time the page draws every frame, and only until it is paused.
const clock = new THREE.Clock();
let lastTimePost = 0;
const tick = () => {
  if (!playing || mixer === null || action === null) return;
  mixer.update(clock.getDelta());
  helpers.normals?.update();
  draw();
  const now = performance.now();
  if (now - lastTimePost > 100) {
    lastTimePost = now;
    post({ type: "time", time: action.time });
  }
  requestAnimationFrame(tick);
};

// ─── The model ──────────────────────────────────────────────────────────────────

const disposeModel = () => {
  for (const helper of Object.values(helpers)) {
    helper?.removeFromParent();
    helper?.dispose?.();
  }
  helpers = { normals: null, skeleton: null, bounds: null, pivot: null };
  mixer?.stopAllAction();
  mixer = null;
  action = null;
  clips = [];
  playing = false;
  if (model === null) return;
  model.removeFromParent();
  model.traverse((node) => {
    node.geometry?.dispose();
    for (const material of [node.material ?? []].flat()) {
      for (const value of Object.values(material)) if (value?.isTexture === true) value.dispose();
      material.dispose();
    }
  });
  model = null;
};

const materialsOf = (root) => {
  const found = new Map();
  root.traverse((node) => {
    for (const material of [node.material ?? []].flat()) found.set(material.uuid, material);
  });
  return [...found.values()];
};

const texturesOf = (materials) => {
  const found = new Map();
  for (const material of materials)
    for (const [slot, value] of Object.entries(material))
      if (value?.isTexture === true && !found.has(value.uuid))
        found.set(value.uuid, {
          name: value.name || value.image?.currentSrc?.split("/").pop() || slot,
          slot,
          width: value.image?.width ?? 0,
          height: value.image?.height ?? 0,
        });
  return [...found.values()];
};

const bonesOf = (root) => {
  const bones = new Set();
  root.traverse((node) => {
    if (node.isSkinnedMesh) for (const bone of node.skeleton.bones) bones.add(bone.uuid);
  });
  return bones.size;
};

const hex = (color) => `#${color.getHexString()}`;

/** The model's own colours, kept so a tint multiplies them instead of replacing them. */
const applyLook = () => {
  if (model === null) return;
  const tint = new THREE.Color(look.tint);
  for (const material of materialsOf(model)) {
    if (material.color === undefined) continue;
    material.userData.kurambitColor ??= material.color.clone();
    material.color.copy(material.userData.kurambitColor).multiply(tint);
  }
  model.scale.setScalar(look.scale);
  model.updateMatrixWorld(true);
  rebuildHelpers();
};

const rebuildHelpers = () => {
  for (const name of ["normals", "bounds", "pivot"]) {
    helpers[name]?.removeFromParent();
    helpers[name]?.dispose?.();
    helpers[name] = null;
  }
  if (model === null) return;
  const box = drawnBox(model);
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.05);
  if (view.bounds) {
    helpers.bounds = new THREE.Box3Helper(box, 0xe6b450);
    helpers.pivot = new THREE.AxesHelper(Math.max(radius * 0.35, 0.1));
    helpers.pivot.position.set(0, 0, 0);
    stage.add(helpers.bounds, helpers.pivot);
  }
  if (view.normals) {
    const group = new THREE.Group();
    model.traverse((node) => {
      if (node.isMesh && node.geometry.attributes.normal !== undefined)
        group.add(new VertexNormalsHelper(node, radius * 0.04, 0x58a6ff));
    });
    helpers.normals = group;
    helpers.normals.update = () => group.children.forEach((helper) => helper.update());
    helpers.normals.dispose = () => group.children.forEach((helper) => helper.dispose());
    stage.add(group);
  }
};

const vertexCount = (root) => {
  let count = 0;
  root.traverse((node) => {
    if (node.isMesh) count += node.geometry.attributes.position?.count ?? 0;
  });
  return count;
};

/** The grid under the model, metre lines (five metres past 20 m), wide enough for both. */
const layGrid = (box) => {
  grid.clear();
  const size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.z, 1) + 2.5;
  const cell = span > 20 ? 5 : 1;
  const across = Math.ceil(span / cell) * 2 * cell;
  const lines = new THREE.GridHelper(across, across / cell, 0x4a4f57, 0x2c3036);
  lines.position.y = 0.001;
  grid.add(lines);
  return cell;
};

/** Frames the model and the figure from a low front three-quarter, as the sheet's second view. */
const frame = (box, size) => {
  const all = box.clone();
  if (!THUMBNAILS) all.union(new THREE.Box3().setFromObject(figure));
  const centre = all.getCenter(new THREE.Vector3());
  const radius = Math.max(all.getSize(new THREE.Vector3()).length() / 2, 0.1);
  const distance = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.05;
  camera.position
    .copy(centre)
    .addScaledVector(new THREE.Vector3(1, 0.45, 1.25).normalize(), distance);
  camera.near = distance / 100;
  camera.far = distance * 20;
  camera.lookAt(centre);
  camera.updateProjectionMatrix();
  if (controls !== null) {
    controls.target.copy(centre);
    controls.minDistance = radius * 0.05;
    controls.maxDistance = distance * 6;
    controls.update();
  }
  return size;
};

/** Loads a game file (a path on the game's server) as the model shown, and says what it holds. */
const open = async (url) => {
  const mine = ++token;
  const target = new URL(url, location.origin);
  if (target.origin !== location.origin) throw new Error("only the game's own files open here");
  const gltf = await loader.loadAsync(target.href);
  if (mine !== token) return null;
  disposeModel();
  model = gltf.scene;
  stage.add(model);
  model.updateMatrixWorld(true);
  const materials = materialsOf(model);
  for (const material of materials) material.userData.kurambitColor = material.color?.clone();
  look.tint = 0xffffff;
  look.scale = 1;
  clips = gltf.animations;
  if (clips.length > 0) mixer = new THREE.AnimationMixer(model);
  const box = drawnBox(model);
  const size = box.getSize(new THREE.Vector3());
  const measured = stats(model);
  // The figure stands beside it toward the front, as on the sheet.
  figure.position.set(box.min.x - 0.7, 0, box.max.z + 0.5);
  const cell = layGrid(box);
  frame(box, size);
  if (view.skeleton) setSkeleton(true);
  for (const material of materials) material.wireframe = view.wireframe;
  rebuildHelpers();
  requestDraw();
  return {
    triangles: measured.triangles,
    drawCalls: measured.drawCalls,
    size: [size.x, size.y, size.z].map((n) => Math.round(n * 100) / 100),
    // Its pivot is the origin it is placed by; the bounds say where the body sits around it.
    bounds: [box.min, box.max].map((corner) =>
      [corner.x, corner.y, corner.z].map((n) => Math.round(n * 100) / 100),
    ),
    grid: cell,
    vertices: vertexCount(model),
    materials: materials.map((material) => ({
      name: material.name || material.type,
      type: material.type,
      ...(material.color === undefined ? {} : { color: hex(material.color) }),
    })),
    textures: texturesOf(materials),
    clips: clips.map((clip) => ({ name: clip.name || "clip", duration: clip.duration })),
    bones: bonesOf(model),
  };
};

const setSkeleton = (on) => {
  helpers.skeleton?.removeFromParent();
  helpers.skeleton?.dispose();
  helpers.skeleton = null;
  if (on && model !== null && bonesOf(model) > 0) {
    helpers.skeleton = new THREE.SkeletonHelper(model);
    // Drawn over the body, so a bone inside the mesh still shows.
    helpers.skeleton.material.depthTest = false;
    stage.add(helpers.skeleton);
  }
};

const setClip = (index, time, play) => {
  if (mixer === null) return;
  const clip = clips[index];
  if (clip === undefined) {
    mixer.stopAllAction();
    action = null;
    playing = false;
    mixer.update(0);
    requestDraw();
    return;
  }
  if (action?.getClip() !== clip) {
    mixer.stopAllAction();
    action = mixer.clipAction(clip);
    action.play();
  }
  action.paused = false;
  if (time !== undefined) action.time = Math.min(Math.max(0, time), clip.duration);
  mixer.update(0);
  helpers.normals?.update();
  const was = playing;
  playing = play;
  if (play && !was) {
    clock.getDelta();
    requestAnimationFrame(tick);
  } else if (!play) requestDraw();
};

// ─── Pictures ───────────────────────────────────────────────────────────────────

/** The view as it stands, drawn now and read in the same task, so the buffer still holds it. */
const picture = () => {
  draw();
  return canvas.toDataURL("image/png");
};

const thumbnail = async (url) => {
  renderer.setPixelRatio(1);
  renderer.setSize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, false);
  camera.aspect = 1;
  await open(url);
  const png = picture();
  disposeModel();
  return png;
};

// ─── Messages ───────────────────────────────────────────────────────────────────

const finite = (value) => typeof value === "number" && Number.isFinite(value);
// One message at a time, in order: a thumbnail asked for while one draws waits for it.
let queue = Promise.resolve();
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (data?.source !== "kurambit-art" || typeof data.type !== "string") return;
  queue = queue.then(() => handle(data)).catch(() => undefined);
});

const handle = async (data) => {
  switch (data.type) {
    case "open":
      if (typeof data.url !== "string") return;
      try {
        const info = await open(data.url);
        if (info !== null) post({ type: "opened", url: data.url, info });
      } catch (error) {
        post({
          type: "failed",
          url: data.url,
          message: String(error?.message ?? error).slice(0, 300),
        });
      }
      return;
    case "view":
      if (typeof data.wireframe === "boolean" && data.wireframe !== view.wireframe) {
        view.wireframe = data.wireframe;
        if (model !== null)
          for (const material of materialsOf(model)) material.wireframe = view.wireframe;
      }
      if (typeof data.skeleton === "boolean" && data.skeleton !== view.skeleton) {
        view.skeleton = data.skeleton;
        setSkeleton(view.skeleton);
      }
      if (typeof data.normals === "boolean")
        view.normals = data.normals && (model === null || vertexCount(model) <= MAX_NORMALS);
      if (typeof data.bounds === "boolean") view.bounds = data.bounds;
      rebuildHelpers();
      requestDraw();
      return;
    case "clip":
      setClip(
        Number.isInteger(data.index) ? data.index : -1,
        finite(data.time) ? data.time : undefined,
        data.play === true,
      );
      if (action !== null) post({ type: "time", time: action.time });
      return;
    case "look":
      if (finite(data.tint)) look.tint = Math.min(0xffffff, Math.max(0, Math.round(data.tint)));
      if (finite(data.scale)) look.scale = Math.min(10, Math.max(0.05, data.scale));
      applyLook();
      requestDraw();
      return;
    case "reset-view":
      if (model !== null) {
        const box = drawnBox(model);
        frame(box, box.getSize(new THREE.Vector3()));
        requestDraw();
      }
      return;
    case "picture":
      if (typeof data.id === "string")
        post({ type: "picture", id: data.id, png: model === null ? null : picture() });
      return;
    case "thumbnail":
      if (typeof data.url !== "string" || typeof data.id !== "string") return;
      try {
        post({ type: "thumbnail", id: data.id, png: await thumbnail(data.url) });
      } catch {
        post({ type: "thumbnail", id: data.id, png: null });
      }
      return;
  }
};

post({ type: "ready", maxNormals: MAX_NORMALS });
