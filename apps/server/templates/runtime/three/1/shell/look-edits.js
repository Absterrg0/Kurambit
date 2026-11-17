// A thing's look as the person edits it in the Workbench's Art, the way an engine's inspector edits
// a selected object: its scale and turn about up, whether it casts and takes shadows, and each of
// its materials' colours and finish. The edits are tuned values of the thing's look id
// (`look:<thing id>`) in tune.json, so they save, fold and undo like any tuned value. A material is
// keyed by its place among the thing's materials and its name, so the edits find it again each
// time the game makes the thing.
//
// Materials are often shared (shell/model.js's palette hands every thing the same paint), so an
// edited material is cloned for this thing alone; one put back gets its own material again.
import * as THREE from "../vendor/three.module.js";

export const LOOK = "look:";
/** A look has a value per material property, so it holds many more than a game's ctx.tune. */
export const MAX_LOOK_VALUES = 400;

const finite = (value) => typeof value === "number" && Number.isFinite(value);
// A name a person would use: letters first, no `|` or `.` (a cache key, "Material.001").
const HUMAN = /^[A-Za-z][A-Za-z0-9 _-]{0,39}$/;
const human = (name) => {
  if (typeof name !== "string" || !HUMAN.test(name)) return null;
  const words = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const drawn = (node) => node.isMesh || node.isPoints || node.isLine || node.isSprite;
const lit = (m) =>
  m.isMeshStandardMaterial ||
  m.isMeshPhongMaterial ||
  m.isMeshLambertMaterial ||
  m.isMeshToonMaterial ||
  m.isMeshMatcapMaterial ||
  m.isMeshNormalMaterial;

// Each property an inspector edits, the materials that have it, its words and its range.
const PROPS = [
  ["color", (m) => m.color?.isColor === true, { label: "colour", colour: true }],
  ["emissive", (m) => m.emissive?.isColor === true, { label: "glow colour", colour: true }],
  [
    "emissiveIntensity",
    (m) => m.emissive?.isColor === true && finite(m.emissiveIntensity),
    { label: "glow", min: 0, max: 10, step: 0.05 },
  ],
  ["roughness", (m) => finite(m.roughness), { label: "roughness", min: 0, max: 1, step: 0.01 }],
  ["metalness", (m) => finite(m.metalness), { label: "metalness", min: 0, max: 1, step: 0.01 }],
  ["opacity", (m) => finite(m.opacity), { label: "opacity", min: 0, max: 1, step: 0.01 }],
  ["flatShading", (m) => lit(m) && typeof m.flatShading === "boolean", { label: "flat shaded" }],
];
const propsOf = (material) =>
  material.isShaderMaterial ? [] : PROPS.filter(([, has]) => has(material));
const read = (material, prop) =>
  prop === "color" || prop === "emissive" ? material[prop].getHex() : material[prop];
const write = (material, prop, value, own) => {
  if (prop === "color" || prop === "emissive") material[prop].setHex(value);
  else if (prop === "flatShading") {
    if (material.flatShading !== value) material.needsUpdate = true;
    material.flatShading = value;
  } else if (prop === "opacity") {
    material.opacity = value;
    material.transparent = own.transparent || value < 1;
  } else material[prop] = value;
};

// An edited material's own (the game's), by its clone; and each node's own shadows.
const owners = new WeakMap();
const ownShadows = new WeakMap();
const ownOf = (material) => owners.get(material) ?? material;

/**
 * The materials one thing draws with, in the order its meshes are met: each once, keyed by that
 * place and its name, named for a person by the palette, the material or its mesh, else "Part N".
 */
export function lookMaterials(bodies) {
  const list = [];
  const seen = new Map();
  let parts = 0;
  for (const body of bodies)
    body.traverse((node) => {
      if (!drawn(node)) return;
      for (const material of [node.material ?? []].flat()) {
        const own = ownOf(material);
        let entry = seen.get(own);
        if (entry === undefined) {
          const name = String(own.name ?? "").slice(0, 60);
          entry = {
            own,
            key: `${list.length}:${name}`,
            label: human(own.name) ?? human(node.name),
            nodes: [],
          };
          seen.set(own, entry);
          list.push(entry);
        }
        if (!entry.nodes.includes(node)) entry.nodes.push(node);
      }
    });
  for (const entry of list) if (propsOf(entry.own).length > 0) entry.label ??= `Part ${++parts}`;
  return list;
}

/** The look's values as the game made the thing (`defaults`) and their ranges, by key. */
export function lookDefaults(bodies, materials, { scale = true } = {}) {
  const defaults = {};
  const ranges = {};
  const add = (key, value, range) => {
    defaults[key] = value;
    ranges[key] = range;
  };
  if (scale) {
    add("scale", 1, { min: 0.05, max: 10, step: 0.01, unit: "×", label: "Scale" });
    for (const axis of ["X", "Y", "Z"])
      add(`scale${axis}`, 1, { min: 0.05, max: 10, step: 0.01, unit: "×", label: `Scale ${axis}` });
  }
  add("turn", 0, { min: -180, max: 180, step: 1, unit: "°", label: "Turn" });
  let meshes = 0;
  let casts = false;
  let takes = false;
  for (const body of bodies)
    body.traverse((node) => {
      if (!node.isMesh) return;
      meshes += 1;
      const [cast, receive] = ownShadows.get(node) ?? [node.castShadow, node.receiveShadow];
      casts ||= cast;
      takes ||= receive;
    });
  if (meshes > 0) {
    add("castShadow", casts, { label: "Casts shadows" });
    add("receiveShadow", takes, { label: "Takes shadows" });
  }
  for (const entry of materials)
    for (const [prop, , range] of propsOf(entry.own))
      add(`${entry.key}/${prop}`, read(entry.own, prop), {
        ...range,
        label: `${entry.label} ${range.label}`,
      });
  return { defaults, ranges };
}

/**
 * Puts the look's live values on the thing's materials and shadows. Transforms are drawn per
 * frame (lookShape), since the game moves and turns its things itself.
 */
export function applyLook(bodies, materials, live, defaults) {
  for (const entry of materials) {
    const props = propsOf(entry.own);
    const edited = props.filter(([prop]) => {
      const key = `${entry.key}/${prop}`;
      return key in live && live[key] !== read(entry.own, prop);
    });
    let clone = null;
    for (const node of entry.nodes)
      for (const material of [node.material ?? []].flat())
        if (owners.get(material) === entry.own) clone = material;
    if (edited.length === 0) {
      if (clone !== null) swap(entry.nodes, clone, entry.own);
      continue;
    }
    if (clone === null) {
      clone = entry.own.clone();
      // A shader the game or the look patched compiles the same for the clone.
      clone.onBeforeCompile = entry.own.onBeforeCompile;
      clone.customProgramCacheKey = entry.own.customProgramCacheKey;
      owners.set(clone, entry.own);
      swap(entry.nodes, entry.own, clone);
    }
    for (const [prop] of props) {
      const key = `${entry.key}/${prop}`;
      write(clone, prop, key in live ? live[key] : read(entry.own, prop), entry.own);
    }
  }
  if ("castShadow" in defaults)
    for (const body of bodies)
      body.traverse((node) => {
        if (!node.isMesh) return;
        let own = ownShadows.get(node);
        if (own === undefined) ownShadows.set(node, (own = [node.castShadow, node.receiveShadow]));
        node.castShadow = live.castShadow === defaults.castShadow ? own[0] : live.castShadow;
        node.receiveShadow =
          live.receiveShadow === defaults.receiveShadow ? own[1] : live.receiveShadow;
      });
}

const swap = (nodes, from, to) => {
  for (const node of nodes)
    if (Array.isArray(node.material))
      node.material = node.material.map((material) => (material === from ? to : material));
    else if (node.material === from) node.material = to;
};

const TURN = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
/**
 * The look's scale and turn put on `object` over the game's own for one draw: returns how to put
 * the game's back, or null when the look leaves them as they are.
 */
export function lookShape(object, live) {
  const s = finite(live.scale) ? live.scale : 1;
  const x = s * (finite(live.scaleX) ? live.scaleX : 1);
  const y = s * (finite(live.scaleY) ? live.scaleY : 1);
  const z = s * (finite(live.scaleZ) ? live.scaleZ : 1);
  const turn = finite(live.turn) ? live.turn : 0;
  if (x === 1 && y === 1 && z === 1 && turn === 0) return null;
  const scale = object.scale.clone();
  const quaternion = object.quaternion.clone();
  object.scale.multiply(new THREE.Vector3(x, y, z));
  if (turn !== 0)
    object.quaternion.multiply(TURN.setFromAxisAngle(UP, THREE.MathUtils.degToRad(turn)));
  if (!object.matrixAutoUpdate) object.updateMatrix();
  return () => {
    object.scale.copy(scale);
    object.quaternion.copy(quaternion);
    if (!object.matrixAutoUpdate) object.updateMatrix();
  };
}

// A texture's picture for the inspector, drawn once per texture.
const MAP_PX = 48;
const maps = new WeakMap();
/** A material's colour texture as a small PNG; null without one or when it cannot be read. */
export function mapPicture(material) {
  const texture = material.map;
  const image = texture?.image;
  if (texture == null || image == null) return null;
  if (maps.has(texture)) return maps.get(texture);
  let url = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = MAP_PX;
    canvas.height = MAP_PX;
    canvas.getContext("2d").drawImage(image, 0, 0, MAP_PX, MAP_PX);
    url = canvas.toDataURL("image/png");
  } catch {
    url = null;
  }
  maps.set(texture, url);
  return url;
}
