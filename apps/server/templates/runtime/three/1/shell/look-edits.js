// A thing's look as the person edits it in the Workbench's Art, the way an engine's inspector edits
// a selected object: its scale and turn about up, whether it casts and takes shadows, and each of
// its materials' colours and finish. The edits are tuned values of the thing's look id
// (`look:<thing id>`) in tune.json, so they save, fold and undo like any tuned value. A material is
// keyed by its place among the thing's materials and its name, so the edits find it again each
// time the game makes the thing.
//
// Materials are often shared (shell/model.js's palette hands every thing the same paint), so an
// edited material is cloned for this thing alone; one put back gets its own material again. A
// thing and its parts each have a look: they are put on together, the game's own first, then the
// thing's and each part's in turn, so where both edit one material the part's (nearer) one shows.
//
// A mesh painted per vertex under one white material (a merged model) has its colours there, not
// on the material: each distinct one is a value of that material too (`2:hull/paint:e5b04c`,
// keyed by the colour the game gave), and an edit repaints those vertices on this thing's own
// copy of the geometry's colours.
import * as THREE from "../vendor/three.module.js";

export const LOOK = "look:";
/** A look has a value per material property, so it holds many more than a game's ctx.tune. */
export const MAX_LOOK_VALUES = 400;

const finite = (value) => typeof value === "number" && Number.isFinite(value);
// A name a person would use: letters first, no `|` or `.` (a cache key), and not an exporter's
// stand-in ("Material.001", "lambert2", "Object_12"), whose copy number is dropped first.
const HUMAN = /^[A-Za-z][A-Za-z0-9 _-]{0,39}$/;
const STAND_IN =
  /^(material|mat|mtl|default|lambert|phong|blinn|standard|basic|initialshadinggroup|surface|shader|scene|root|rootnode|group|object|mesh|node|geometry|model|untitled|none|armature|gltf|auxscene)[\s._-]*\d*$/i;
const human = (name) => {
  if (typeof name !== "string") return null;
  const bare = name.replace(/[._-]\d+$/, "");
  if (!HUMAN.test(bare) || STAND_IN.test(bare)) return null;
  const words = bare
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const drawn = (node) => node.isMesh || node.isPoints || node.isLine || node.isSprite;

// Exporters' and loaders' generic names say nothing a person would.
export const meaningful = (name) =>
  typeof name === "string" &&
  name.length > 0 &&
  name.length <= 80 &&
  !/^(scene|root|rootnode|group|object|mesh|node|armature|gltf|model|auxscene)[\s._-]*\d*$/i.test(
    name,
  );
/** A key or node name as words: "plankDark" → "Plank dark", "big_tree" → "Big tree". */
export const humanName = (key) => {
  const words = String(key)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const PART_NAME = /^[A-Za-z][A-Za-z0-9 '_-]{0,59}$/;
/**
 * The name a node inside a thing is a part by (letters first, no `|` or `.`, not a loader's
 * generic name, not its holder's own name), or null when it is no part. The Stage bridge walks a
 * thing's parts by it, and the model viewer finds a part of a glb again by it.
 */
export const partName = (node, holderName) => {
  if (!PART_NAME.test(node.name) || !meaningful(node.name)) return null;
  const name = humanName(node.name);
  return name.toLowerCase() === String(holderName).toLowerCase() ? null : name;
};
/** Whether anything under `node`, itself included, draws. */
export const drawsAnything = (node) => {
  let found = false;
  node.traverse((each) => {
    if (drawn(each)) found = true;
  });
  return found;
};

/**
 * The nodes of the part `segments` names below `root` (["Cabin", "Roof"] for Island › Cabin ›
 * Roof), found the way the Stage bridge's walk names them: siblings of one name are one part.
 * Empty when the model has no such part.
 */
export function partNodes(root, rootName, segments) {
  let holders = [root];
  let holderName = rootName;
  for (const segment of segments) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        const name = drawsAnything(child) ? partName(child, holderName) : null;
        if (name === null) {
          if (!child.isInstancedMesh) visit(child);
        } else if (name === segment) found.push(child);
      }
    };
    for (const holder of holders) visit(holder);
    if (found.length === 0) return [];
    holders = found;
    holderName = segment;
  }
  return holders;
}
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
  ["visible", (m) => typeof m.visible === "boolean", { label: "shown" }],
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

// An edited material's own (the game's), by its clone; each look's clones, by the first body it
// is put on and the material they stand for; and each node's own shadows.
const owners = new WeakMap();
const clonesOf = new WeakMap();
const ownShadows = new WeakMap();
const ownOf = (material) => owners.get(material) ?? material;

// A geometry's shape as a person says it ("Red box", "Teal cone").
const SHAPES = {
  BoxGeometry: "box",
  RoundedBoxGeometry: "box",
  SphereGeometry: "ball",
  IcosahedronGeometry: "gem",
  DodecahedronGeometry: "gem",
  OctahedronGeometry: "gem",
  TetrahedronGeometry: "pyramid",
  PolyhedronGeometry: "gem",
  ConeGeometry: "cone",
  CylinderGeometry: "cylinder",
  CapsuleGeometry: "capsule",
  TorusGeometry: "ring",
  RingGeometry: "ring",
  TorusKnotGeometry: "knot",
  PlaneGeometry: "plane",
  CircleGeometry: "disc",
  LatheGeometry: "vase",
  ExtrudeGeometry: "slab",
  ShapeGeometry: "shape",
  TubeGeometry: "tube",
};
const shapeOf = (node) =>
  node.isPoints
    ? "points"
    : node.isSprite
      ? "sprite"
      : node.isLine
        ? "line"
        : (SHAPES[node.geometry?.type] ?? null);
const HSL = { h: 0, s: 0, l: 0 };
/** A colour's family as a word ("Red", "Teal", "Grey"). */
const familyOfColour = (color, textured = false) => {
  color.getHSL(HSL, THREE.SRGBColorSpace);
  const { s, l } = HSL;
  const h = HSL.h * 360;
  if (textured && s < 0.1 && l > 0.85) return "Textured";
  if (l < 0.1) return "Black";
  if (s < 0.15) return l > 0.85 ? "White" : "Grey";
  if (h < 15 || h >= 345) return l > 0.75 ? "Pink" : "Red";
  // Wood, leather and skin sit in orange's hue: dark or dull is brown, pale is cream.
  if (h < 45) {
    if (l >= 0.75) return "Cream";
    return l < 0.45 || (s < 0.5 && l < 0.7) ? "Brown" : "Orange";
  }
  if (h < 70) return "Yellow";
  if (h < 160) return "Green";
  if (h < 195) return "Teal";
  if (h < 255) return "Blue";
  if (h < 290) return "Purple";
  return "Pink";
};
/** A material's colour family; a texture under white is "Textured". */
const familyOf = (material) =>
  material.color?.isColor === true ? familyOfColour(material.color, material.map != null) : null;

// ─── Vertex colours ─────────────────────────────────────────────────────────────

/** How many of a material's vertex colours are values of its look: a palette, not a gradient. */
const MAX_PAINTS = 12;
/** A mesh past this many vertices is not read for its colours. */
const MAX_PAINT_VERTICES = 2_000_000;
const PAINT = "/paint:";
const paintKey = (entry, hex) => `${entry.key}${PAINT}${hex.toString(16).padStart(6, "0")}`;
const SHADE = new THREE.Color();
// A geometry's vertex colours as the game made them, read once: each vertex's colour as
// 0xRRGGBB, and how many vertices each colour paints.
const paintsRead = new WeakMap();
const paintsOf = (geometry) => {
  const attribute = geometry?.attributes?.color;
  if (attribute == null || attribute.count > MAX_PAINT_VERTICES) return null;
  let read = paintsRead.get(geometry);
  if (read !== undefined) return read;
  const hexes = new Uint32Array(attribute.count);
  const counts = new Map();
  let r = NaN;
  let g = NaN;
  let b = NaN;
  let hex = 0;
  for (let i = 0; i < attribute.count; i += 1) {
    const x = attribute.getX(i);
    const y = attribute.getY(i);
    const z = attribute.getZ(i);
    // A merged model's vertices come in runs of one colour.
    if (x !== r || y !== g || z !== b) {
      r = x;
      g = y;
      b = z;
      hex = SHADE.setRGB(x, y, z).getHex();
    }
    hexes[i] = hex;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  read = { hexes, counts };
  paintsRead.set(geometry, read);
  return read;
};
// A look's own copy of a geometry it repaints (its colours alone are copied), by that copy.
const geometryOwners = new WeakMap();
const ownGeometryOf = (geometry) => geometryOwners.get(geometry) ?? geometry;
const repaintable = (own) => {
  const copy = new THREE.BufferGeometry();
  copy.name = own.name;
  copy.setIndex(own.index);
  for (const [name, attribute] of Object.entries(own.attributes))
    copy.setAttribute(name, name === "color" ? attribute.clone() : attribute);
  copy.morphAttributes = own.morphAttributes;
  copy.morphTargetsRelative = own.morphTargetsRelative;
  for (const group of own.groups) copy.addGroup(group.start, group.count, group.materialIndex);
  copy.boundingBox = own.boundingBox;
  copy.boundingSphere = own.boundingSphere;
  copy.drawRange.start = own.drawRange.start;
  copy.drawRange.count = own.drawRange.count;
  copy.userData = own.userData;
  // An acceleration structure a game hung on it (three-mesh-bvh) answers for the copy too.
  if (own.boundsTree !== undefined) copy.boundsTree = own.boundsTree;
  geometryOwners.set(copy, own);
  return copy;
};
/**
 * The colours a material's meshes are painted with per vertex, most used first: up to MAX_PAINTS
 * as `listed` ({ hex, key, word }), and how many `more` there are. Null when it paints none.
 */
const entryPaints = (entry) => {
  if (entry.paints !== undefined) return entry.paints;
  entry.paints = null;
  if (entry.own.vertexColors !== true || propsOf(entry.own).length === 0) return null;
  const counts = new Map();
  for (const node of entry.nodes) {
    if (!node.isMesh) continue;
    const read = paintsOf(ownGeometryOf(node.geometry));
    if (read === null) continue;
    for (const [hex, count] of read.counts) counts.set(hex, (counts.get(hex) ?? 0) + count);
  }
  if (counts.size === 0) return null;
  const most = [...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_PAINTS);
  const said = new Map();
  entry.paints = {
    listed: most.map(([hex]) => {
      const family = familyOfColour(SHADE.setHex(hex)).toLowerCase();
      const count = (said.get(family) ?? 0) + 1;
      said.set(family, count);
      return { hex, key: paintKey(entry, hex), word: count === 1 ? family : `${family} ${count}` };
    }),
    more: counts.size - most.length,
  };
  return entry.paints;
};
/** How many more colours a material's meshes are painted with than its look lists. */
export const morePaints = (entry) => entryPaints(entry)?.more ?? 0;

/**
 * A material's label for a person, from what the game gave it: the material's own name (a glb's
 * "Wood"), else a mesh's name, else the palette's name for it (these are the game's own names),
 * else its shape and colour ("Red box", "Teal cone"); null when none says anything, for "Part N".
 * Never a key or a hex.
 */
const gameNameOf = (entry) => {
  const own = entry.own;
  const palette = own.userData?.kurambitKey !== undefined;
  if (!palette && human(own.name) !== null) return human(own.name);
  for (const node of entry.nodes) if (human(node.name) !== null) return human(node.name);
  if (palette && human(own.name) !== null) return human(own.name);
  return null;
};
const labelOf = (entry) => {
  const family = familyOf(entry.own);
  if (family === null) return null;
  return `${family} ${shapeOf(entry.nodes[0]) ?? "part"}`;
};

/**
 * The materials one thing draws with, in the order its meshes are met: each once, keyed by that
 * place and its name, named for a person (labelOf) or by the name the person gave it (`names`, as
 * the look keeps them: "2:roof/name"), else "Part N". Two of one label are told apart by a number.
 */
export function lookMaterials(bodies, names = {}) {
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
          entry = { own, key: `${list.length}:${name}`, label: null, named: false, nodes: [] };
          seen.set(own, entry);
          list.push(entry);
        }
        if (!entry.nodes.includes(node)) entry.nodes.push(node);
      }
    });
  const said = new Map();
  for (const entry of list) {
    const given = names[`${entry.key}/name`];
    if (typeof given === "string" && given !== "") {
      entry.label = given;
      entry.named = true;
      continue;
    }
    if (propsOf(entry.own).length === 0) continue;
    const gameName = gameNameOf(entry);
    entry.named = gameName !== null;
    const label = gameName ?? labelOf(entry) ?? `Part ${++parts}`;
    const count = (said.get(label) ?? 0) + 1;
    said.set(label, count);
    entry.label = count === 1 ? label : `${label} ${count}`;
  }
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
  for (const entry of materials) {
    for (const [prop, , range] of propsOf(entry.own))
      add(`${entry.key}/${prop}`, read(entry.own, prop), {
        ...range,
        label: `${entry.label} ${range.label}`,
      });
    for (const paint of entryPaints(entry)?.listed ?? [])
      add(paint.key, paint.hex, { colour: true, label: `${entry.label} ${paint.word}` });
  }
  return { defaults, ranges };
}

/** Gives every body the game's own materials and shadows back, before its looks are put on. */
export function resetLook(bodies) {
  for (const body of bodies)
    body.traverse((node) => {
      if (Array.isArray(node.material)) node.material = node.material.map(ownOf);
      else if (node.material != null) node.material = ownOf(node.material);
      if (node.geometry != null) node.geometry = ownGeometryOf(node.geometry);
      const own = ownShadows.get(node);
      if (own !== undefined) [node.castShadow, node.receiveShadow] = own;
    });
}

/**
 * Puts the look's live values over the bodies as they are (resetLook first, then the thing's
 * look and its parts' in turn): each edited material on its meshes as this look's own clone of
 * it, and shadows that differ from the game's. Transforms are drawn per frame (lookShape), since
 * the game moves and turns its things itself.
 */
export function applyLook(bodies, materials, live, defaults) {
  let clones = clonesOf.get(bodies[0]);
  if (clones === undefined) clonesOf.set(bodies[0], (clones = new Map()));
  for (const entry of materials) {
    // Its vertex colours first: repainted on this look's own copy of each mesh's colours.
    const repaint = new Map();
    for (const paint of entryPaints(entry)?.listed ?? [])
      if (paint.key in live && live[paint.key] !== paint.hex)
        repaint.set(paint.hex, live[paint.key]);
    if (repaint.size > 0)
      for (const node of entry.nodes) {
        if (!node.isMesh) continue;
        const own = ownGeometryOf(node.geometry);
        const read = paintsOf(own);
        if (read === null) continue;
        let copy = clones.get(own);
        if (copy === undefined) clones.set(own, (copy = repaintable(own)));
        const colours = copy.attributes.color;
        colours.array.set(own.attributes.color.array);
        for (const [from, to] of repaint) {
          SHADE.setHex(to);
          for (let i = 0; i < read.hexes.length; i += 1)
            if (read.hexes[i] === from) colours.setXYZ(i, SHADE.r, SHADE.g, SHADE.b);
        }
        colours.needsUpdate = true;
        node.geometry = copy;
      }
    const props = propsOf(entry.own);
    const edited = props.some(([prop]) => {
      const key = `${entry.key}/${prop}`;
      return key in live && live[key] !== read(entry.own, prop);
    });
    if (!edited) continue;
    let clone = clones.get(entry.own);
    if (clone === undefined) {
      clone = entry.own.clone();
      // A shader the game or the look patched compiles the same for the clone.
      clone.onBeforeCompile = entry.own.onBeforeCompile;
      clone.customProgramCacheKey = entry.own.customProgramCacheKey;
      owners.set(clone, entry.own);
      clones.set(entry.own, clone);
    }
    for (const [prop] of props) {
      const key = `${entry.key}/${prop}`;
      write(clone, prop, key in live ? live[key] : read(entry.own, prop), entry.own);
    }
    const mine = (material) => (ownOf(material) === entry.own ? clone : material);
    for (const node of entry.nodes)
      node.material = Array.isArray(node.material) ? node.material.map(mine) : mine(node.material);
  }
  const cast = "castShadow" in defaults && live.castShadow !== defaults.castShadow;
  const receive = "receiveShadow" in defaults && live.receiveShadow !== defaults.receiveShadow;
  if (cast || receive)
    for (const body of bodies)
      body.traverse((node) => {
        if (!node.isMesh) return;
        if (!ownShadows.has(node)) ownShadows.set(node, [node.castShadow, node.receiveShadow]);
        if (cast) node.castShadow = live.castShadow;
        if (receive) node.receiveShadow = live.receiveShadow;
      });
}

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
