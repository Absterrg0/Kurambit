// Models made in code: the few things models need again and again and get wrong. It holds
// no look of its own: every colour, size and shape comes from the game.
//
//   import * as M from "./shell/model.js";
//   const paint = M.palette({ hull: ["#e8e2d4", { kind: "paint" }], trim: "#24364a",
//     glass: ["#1d2a33", { kind: "glass" }], deck: ["#9a7650", { kind: "wood" }] });
//     // one shared material per name: kind matte (default, flat facets), plastic, paint (clear
//     // coat), metal, chrome, glass, wood, rubber, cloth, stone, water; or { rough, metal, coat,
//     // glow, smooth, opacity, map }. They mirror the look's sky. Every model drawing with
//     // paint.hull is one world, and merges into one draw.
//   const bands = M.canvasTexture(512, 64, (g, w, h) => { g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
//     g.fillStyle = "#222"; g.fillRect(0, 20, w, 18); }); // windows, panel lines, names, decals
//   const hullPaint = M.paintOf("#ffffff", { kind: "paint", map: bands });
//   const boat = new THREE.Group();
//   boat.add(M.part(M.box(6, 1.2, 2.2, 0.25), paint.hull, { at: [0, 0.6, 0] })); // bevelled box
//   boat.add(M.part(M.lathe([[0, 0], [0.3, 0.1], [0.2, 1.4]]), paint.trim, { at: [1, 1.2, 0] }));
//     // a profile of [radius, y] spun round y: masts, bottles, domes, towers, trunks
//   boat.add(M.part(M.extrude([[0, 0], [2, 0], [0, 3]], 0.05, { bevel: 0.02 }), paint.trim));
//     // a flat shape of [x, y] given depth along z: sails, fins, blades, signs, walls with holes
//   boat.add(M.part(M.tube([[0, 1, 0], [1, 2, 0], [2, 1.5, 1]], 0.04), paint.trim)); // ropes, pipes
//   boat.add(M.part(M.rail([[-3, 1.2, 1], [2, 1.2, 1], [3, 1.2, 0]], { height: 1 }), paint.trim));
//     // a railing along a deck's edge: posts and bars in one geometry
//   const hull = M.loft([[-3, 0.3, 0.2], [0, 1.1, 0.6], [3, 0.6, 0.15]], { width: 1 });
//     // a hull or body from cross-sections along x: [x, half-width, height, bottom y]; { keel: 1 }
//     // draws its underside to a V
//   const merged = M.merge(boat); // one mesh per material: build in parts, draw in few
//   M.stats(merged);              // { triangles, drawCalls, size: [x, y, z] in metres }
//   const forest = M.scatter(M.merge(tree), 400, (i, rand) => ({
//     at: [rand() * 80 - 40, 0, rand() * 80 - 40], turn: rand() * 6.28, scale: 0.8 + rand() * 0.5,
//   }), 7); // repeats as instances: 400 trees, one draw per material; the last number is the seed
//   const rand = M.seeded(7); // 0..1, the same numbers for the same seed: variants
//
// A model whose numbers the person tunes on the Stage, rebuilt whenever one changes (also while
// the Stage has play frozen), and named so they can select it:
//   const boat = M.tuned(ctx, "Patrol boat", { length: 7, beam: 2.4, seed: 1 },
//     { length: [4, 12, 0.25, "m"], beam: [1.5, 4, 0.1, "m"], seed: [1, 99, 1] },
//     (p) => M.merge(buildBoat(p, M.seeded(p.seed))), { kind: "character" });
//   ctx.scene.add(boat); // a Group; move and turn it, its insides are rebuilt in place
//
// A character in code, on the standard humanoid skeleton the animation library's clips play on
// (ASSETS names the library's clip file: game_assets_add quaternius-universal-animation-library
// with Unreal-Godot/UAL1_Standard.glb, allowed with the library off). Parts are placed in the
// body's own metres, feet at y 0, facing +z, at the skeleton's rest pose; each rides one bone.
//   const body = M.rig(ctx.assets.model("rig"));  // the clips' copy, its mannequin taken off
//   body.joint("hand_r");                          // a joint's rest position (Vector3, body metres)
//   body.limb("thigh_l", "calf_l", 0.09, paint.cloth, { end: 0.07 }); // a capsule along a bone
//   body.part(new THREE.SphereGeometry(0.13), paint.skin, { at: [0, 1.62, 0.02] }); // the nearest
//     // bone takes it, or name one: { bone: "Head" }; a mesh you built goes in as body.add(mesh)
//   body.part(swordGeometry, paint.metal, { at: [...], bone: "hand_r", rigid: true }); // never bends
//   const hero = animate(body.done());             // skinned to the bones by distance, bending at
//     // the joints, one draw per material; done({ skin: "rigid" }) hangs each part on its bone
//   // body.bones lists the bone names; hero.play("run") plays the library's clips on it.
//
// Models face +z, like the library's, so face the move with rotation.y = Math.atan2(dir.x, dir.z).
// Look at each one alone with game_model_sheet before building the game around it.
import * as THREE from "../vendor/three.module.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Shared materials last a run: the shell disposes a run's scene, materials included, so the
// next run makes its own instead of reusing disposed ones.
let paints = new Map();
// Tuned models by Stage id, rebuilt when the Stage changes one of their values.
let tunedModels = new Map();

const colour = (value) => new THREE.Color(value);

/**
 * What each kind of surface is, physically: roughness, metalness, a clear coat over paint, and how
 * strongly it mirrors the sky. Every value can still be given on its own.
 */
const KINDS = {
  matte: { rough: 0.85, metal: 0 },
  plastic: { rough: 0.45, metal: 0 },
  // Painted metal: a hull, a car body. The clear coat is the sharp sky reflection over the colour.
  paint: { rough: 0.38, metal: 0.15, coat: 1, coatRough: 0.06 },
  metal: { rough: 0.28, metal: 1 },
  chrome: { rough: 0.06, metal: 1 },
  // Opaque glass: dark, nearly a mirror; windows read by what they reflect.
  glass: { rough: 0.04, metal: 0.1, coat: 1, coatRough: 0, reflect: 1.6 },
  wood: { rough: 0.62, metal: 0 },
  rubber: { rough: 0.95, metal: 0 },
  cloth: { rough: 1, metal: 0, smooth: true },
  stone: { rough: 0.92, metal: 0 },
  water: { rough: 0.05, metal: 0, opacity: 0.8 },
};

/**
 * A shared material: `colour` a CSS colour or 0xrrggbb; `kind` one of matte (default), plastic,
 * paint, metal, chrome, glass, wood, rubber, cloth, stone, water; over it `rough` 0..1, `metal`
 * 0..1, `coat` 0..1 (a clear coat), `glow` the emissive strength of the colour itself, `smooth`
 * for smooth shading (flat facets by default), `opacity` below 1, `map` a texture (canvasTexture),
 * `reflect` how strongly it mirrors the sky.
 */
export function paintOf(value, options = {}) {
  const o = { ...KINDS[options.kind ?? "matte"], ...options };
  const {
    rough = 0.8,
    metal = 0,
    coat = 0,
    coatRough = 0.1,
    glow = 0,
    opacity = 1,
    map,
    reflect = 1,
  } = o;
  const smooth = o.smooth ?? (o.kind !== undefined && o.kind !== "matte" && o.kind !== "stone");
  const key = `${colour(value).getHexString()}|${rough}|${metal}|${coat}|${coatRough}|${glow}|${smooth}|${opacity}|${reflect}|${map?.uuid ?? ""}`;
  let material = paints.get(key);
  if (material === undefined) {
    const parameters = {
      color: colour(value),
      roughness: rough,
      metalness: metal,
      flatShading: !smooth,
      envMapIntensity: reflect,
      ...(map === undefined ? {} : { map }),
      ...(glow > 0 ? { emissive: colour(value), emissiveIntensity: glow } : {}),
      ...(opacity < 1 ? { transparent: true, opacity, depthWrite: false } : {}),
    };
    // The clear coat is the one thing MeshStandardMaterial lacks; it costs a second lobe.
    material =
      coat > 0
        ? new THREE.MeshPhysicalMaterial({
            ...parameters,
            clearcoat: coat,
            clearcoatRoughness: coatRough,
          })
        : new THREE.MeshStandardMaterial(parameters);
    material.name = key;
    paints.set(key, material);
  }
  return material;
}

/**
 * A texture drawn in code on a canvas: `draw(g, width, height)` paints it with the 2D canvas API
 * (window bands, panel lines, stripes, a name on a hull, a decal). It repeats by default; colour
 * textures are sRGB. Use it as a paint's `map` (`[colour, { map }]`, colour white to keep its own).
 */
export function canvasTexture(
  width,
  height,
  draw,
  { repeat = [1, 1], colour: isColour = true } = {},
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext("2d"), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(...repeat);
  texture.anisotropy = 8;
  if (isColour) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** The game's palette as named shared materials: { name: colour } or { name: [colour, options] }. */
export function palette(colours) {
  const named = {};
  for (const [name, entry] of Object.entries(colours))
    named[name] = Array.isArray(entry) ? paintOf(entry[0], entry[1]) : paintOf(entry);
  return named;
}

/** A box with its edges rounded by `radius` (bevelled with `segments` 1). */
export function box(width, height, depth, radius = 0, segments = 2) {
  if (radius <= 0) return new THREE.BoxGeometry(width, height, depth);
  const most = Math.min(width, height, depth) / 2 - 1e-4;
  return new RoundedBoxGeometry(width, height, depth, segments, Math.min(radius, most));
}

const v2 = (points) => points.map(([x, y]) => new THREE.Vector2(x, y));
const v3 = (points) => points.map(([x, y, z]) => new THREE.Vector3(x, y, z));

/** A profile of [radius, y] points spun round the y axis. */
export function lathe(profile, segments = 16) {
  return new THREE.LatheGeometry(v2(profile), segments);
}

/**
 * A closed shape of [x, y] points (optional `holes`, each a list of points) given `depth` along
 * +z, centred on z; `bevel` rounds its edges by that many metres.
 */
export function extrude(shape, depth, { bevel = 0, holes = [], curve = 1 } = {}) {
  const outline = new THREE.Shape(v2(shape));
  for (const hole of holes) outline.holes.push(new THREE.Path(v2(hole)));
  const geometry = new THREE.ExtrudeGeometry(outline, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: bevel > 0 ? 2 : 0,
    curveSegments: curve === 1 ? 8 : curve,
  });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

/** A tube of `radius` along a smooth curve through [x, y, z] points. */
export function tube(points, radius, { closed = false, segments = 0, sides = 8 } = {}) {
  const curve = new THREE.CatmullRomCurve3(v3(points), closed);
  return new THREE.TubeGeometry(curve, segments || points.length * 8, radius, sides, closed);
}

/**
 * A body lofted through cross-sections along x: each [x, halfWidth, height] (optionally a 4th,
 * the section's bottom y, default 0), each an ellipse-ish rounded section of `sides` points
 * (`flat` 0..1 squares it off, `keel` 0..1 draws its lower half to a V), capped at both ends.
 * Hulls, fuselages, bodies, fish.
 */
export function loft(sections, { sides = 12, flat = 0.4, keel = 0 } = {}) {
  const ring = [];
  for (let i = 0; i < sides; i += 1) {
    const a = (i / sides) * Math.PI * 2;
    const c = Math.cos(a),
      s = Math.sin(a);
    // A superellipse: flat 0 is an ellipse, 1 nearly a rectangle.
    const p = 2 / (1 + flat * 3);
    ring.push([Math.sign(c) * Math.abs(c) ** p, Math.sign(s) * Math.abs(s) ** p]);
  }
  const positions = [];
  const uvs = [];
  const index = [];
  const first = sections[0][0];
  const span = sections.at(-1)[0] - first || 1;
  for (const [x, half, height, bottom = 0] of sections)
    for (const [k, [c, s]] of ring.entries()) {
      // keel narrows the lower half toward its centre line: 1 is a V bottom, as a hull has.
      positions.push(x, bottom + (height / 2) * (1 + s), half * c * (1 - keel * Math.max(0, -s)));
      // u along the length, v round the section: a canvas texture wraps the body.
      uvs.push((x - first) / span, k / sides);
    }
  const n = sections.length;
  for (let j = 0; j < n - 1; j += 1)
    for (let i = 0; i < sides; i += 1) {
      const a = j * sides + i,
        b = j * sides + ((i + 1) % sides),
        c = a + sides,
        d = b + sides;
      index.push(a, c, b, b, c, d);
    }
  // Caps: a fan round each end's centre.
  for (const [j, flip] of [
    [0, true],
    [n - 1, false],
  ]) {
    const [x, , height, bottom = 0] = sections[j];
    const centre = positions.length / 3;
    positions.push(x, bottom + height / 2, 0);
    uvs.push((x - first) / span, 0.5);
    for (let i = 0; i < sides; i += 1) {
      const a = j * sides + i,
        b = j * sides + ((i + 1) % sides);
      if (flip) index.push(centre, a, b);
      else index.push(centre, b, a);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A railing along [x, y, z] points (its foot), as one geometry: posts every `spacing` metres,
 * `bars` rails between `height`'s top and half way, of `radius`. Ships, balconies, bridges, fences.
 */
export function rail(
  points,
  { height = 1, spacing = 1.2, radius = 0.022, bars = 2, closed = false } = {},
) {
  const path = v3(points);
  if (closed) path.push(path[0].clone());
  const pieces = [];
  for (let b = 0; b < bars; b += 1) {
    const lift = height * (1 - (b / Math.max(bars, 1)) * 0.5);
    const raised = path.map((p) => [p.x, p.y + lift, p.z]);
    for (let i = 0; i < raised.length - 1; i += 1)
      pieces.push(tubeBetween(raised[i], raised[i + 1], b === 0 ? radius * 1.3 : radius));
  }
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i],
      c = path[i + 1];
    const n = Math.max(1, Math.round(a.distanceTo(c) / spacing));
    for (let k = 0; k < n + (i === path.length - 2 && !closed ? 1 : 0); k += 1) {
      const p = a.clone().lerp(c, k / n);
      pieces.push(tubeBetween([p.x, p.y, p.z], [p.x, p.y + height, p.z], radius));
    }
  }
  const merged = mergeGeometries(pieces.map(uniform), false);
  for (const piece of pieces) piece.dispose();
  return merged;
}

/** A straight round bar from a to b. */
const tubeBetween = (a, b, radius) => {
  const from = new THREE.Vector3(...a);
  const to = new THREE.Vector3(...b);
  const geometry = new THREE.CylinderGeometry(radius, radius, from.distanceTo(to), 6, 1, true);
  geometry.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(UP, to.clone().sub(from).normalize()),
  );
  geometry.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  return geometry;
};

/** A mesh of `geometry` in `material`, placed: `at` [x, y, z], `turn` [x, y, z] radians, `scale`. */
export function part(geometry, material, { at, turn, scale } = {}) {
  const mesh = new THREE.Mesh(geometry, material);
  if (at !== undefined) mesh.position.set(...at);
  if (turn !== undefined) mesh.rotation.set(...turn);
  if (typeof scale === "number") mesh.scale.setScalar(scale);
  else if (scale !== undefined) mesh.scale.set(...scale);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

// What mergeGeometries needs alike: the same attributes, all indexed or none.
const KEEP = ["position", "normal", "uv"];
const uniform = (geometry) => {
  let g = geometry.index === null ? geometry : geometry.toNonIndexed();
  if (g === geometry) g = geometry.clone();
  for (const name of Object.keys(g.attributes)) if (!KEEP.includes(name)) g.deleteAttribute(name);
  if (g.attributes.normal === undefined) g.computeVertexNormals();
  if (g.attributes.uv === undefined)
    g.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2),
    );
  g.morphAttributes = {};
  g.clearGroups();
  return g;
};

/**
 * One mesh per material of everything under `root`, in root's own space: a model built from many
 * parts draws in as many calls as it has materials. Skinned meshes, instances, lines and sprites
 * are kept as they are. Returns a new Group; `root` is left untouched.
 */
export function merge(root) {
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert();
  const byMaterial = new Map();
  const kept = [];
  root.traverse((object) => {
    if (object === root) return;
    if (!object.isMesh || object.isSkinnedMesh || object.isInstancedMesh) {
      if (
        object.isSkinnedMesh ||
        object.isInstancedMesh ||
        object.isLine ||
        object.isSprite ||
        object.isPoints
      )
        kept.push(object);
      return;
    }
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const matrix = new THREE.Matrix4().multiplyMatrices(inverse, object.matrixWorld);
    const groups =
      materials.length > 1 && object.geometry.groups.length > 0
        ? object.geometry.groups
        : [{ start: 0, count: Infinity, materialIndex: 0 }];
    // Unrolled once, a group's start and count name its vertices directly.
    const flat =
      groups.length > 1 && object.geometry.index !== null
        ? object.geometry.toNonIndexed()
        : object.geometry;
    for (const group of groups) {
      const material = materials[group.materialIndex ?? 0];
      if (material == null) continue;
      let geometry = flat;
      if (groups.length > 1) {
        const count = Math.min(group.count, flat.attributes.position.count - group.start);
        geometry = new THREE.BufferGeometry();
        for (const name of KEEP) {
          const attribute = flat.attributes[name];
          if (attribute === undefined) continue;
          const size = attribute.itemSize;
          geometry.setAttribute(
            name,
            new THREE.BufferAttribute(
              attribute.array.slice(group.start * size, (group.start + count) * size),
              size,
            ),
          );
        }
      }
      const placed = uniform(geometry).applyMatrix4(matrix);
      if (!byMaterial.has(material)) byMaterial.set(material, []);
      byMaterial.get(material).push(placed);
    }
  });
  const merged = new THREE.Group();
  merged.name = root.name;
  for (const [material, geometries] of byMaterial) {
    const geometry = mergeGeometries(geometries, false);
    for (const g of geometries) g.dispose();
    if (geometry === null) continue;
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = mesh.receiveShadow = true;
    merged.add(mesh);
  }
  for (const object of kept) merged.attach(object);
  return merged;
}

/**
 * `count` copies of `model` as instances, one draw per material: `place(i, rand)` gives each
 * copy's `at` [x, y, z], `turn` (radians about y, or [x, y, z]) and `scale` (number or [x, y, z]),
 * with `rand` seeded by `seed`. Merge the model first: each of its meshes becomes one
 * InstancedMesh. Returns a Group.
 */
export function scatter(model, count, place, seed = 1) {
  const rand = seeded(seed);
  const matrices = [];
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i += 1) {
    const { at = [0, 0, 0], turn = 0, scale = 1 } = place(i, rand) ?? {};
    dummy.position.set(...at);
    if (typeof turn === "number") dummy.rotation.set(0, turn, 0);
    else dummy.rotation.set(...turn);
    if (typeof scale === "number") dummy.scale.setScalar(scale);
    else dummy.scale.set(...scale);
    dummy.updateMatrix();
    matrices.push(dummy.matrix.clone());
  }
  model.updateWorldMatrix(true, true);
  const inverse = model.matrixWorld.clone().invert();
  const group = new THREE.Group();
  group.name = model.name;
  model.traverse((object) => {
    if (!object.isMesh || object.isSkinnedMesh) return;
    const local = new THREE.Matrix4().multiplyMatrices(inverse, object.matrixWorld);
    const instanced = new THREE.InstancedMesh(object.geometry, object.material, count);
    for (let i = 0; i < count; i += 1)
      instanced.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(matrices[i], local));
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
    instanced.castShadow = instanced.receiveShadow = true;
    group.add(instanced);
  });
  return group;
}

/** 0..1 numbers from a seed: the same seed gives the same model. */
export function seeded(seed = 1) {
  let a = Math.floor(seed * 2654435761) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The box of what draws under `root`: hidden helpers (a hit box, a trigger, a turned-off
 * light's mesh) count in three's Box3.setFromObject, and would size a model by its helpers.
 */
export function drawnBox(root) {
  const box = new THREE.Box3();
  const part = new THREE.Box3();
  // updateMatrixWorld walks down through each SkinnedMesh's own override, which keeps its bind
  // inverse in step with where it stands; updateWorldMatrix does not.
  root.updateWorldMatrix(true, false);
  root.updateMatrixWorld(true);
  // One object's own geometry, without its children (three's expandByObject walks them all).
  const own = (object) => {
    if (!(object.isMesh || object.isLine || object.isPoints) || object.geometry === undefined)
      return;
    if (object.isSkinnedMesh || object.isInstancedMesh) {
      if (object.boundingBox === null) object.computeBoundingBox();
      part.copy(object.boundingBox);
    } else {
      if (object.geometry.boundingBox === null) object.geometry.computeBoundingBox();
      part.copy(object.geometry.boundingBox);
    }
    box.union(part.applyMatrix4(object.matrixWorld));
  };
  const visit = (object) => {
    if (!object.visible) return;
    own(object);
    for (const child of object.children) visit(child);
  };
  // The root draws even when the game has hidden it for now: the sheet shows it.
  own(root);
  for (const child of root.children) visit(child);
  return box;
}

/** What `root` costs to draw: triangles, draw calls, and its size in metres [x, y, z]. */
export function stats(root) {
  let triangles = 0;
  let drawCalls = 0;
  root.updateWorldMatrix(true, true);
  root.traverse((object) => {
    if (!object.isMesh || !object.visible) return;
    const g = object.geometry;
    const per = (g.index !== null ? g.index.count : g.attributes.position.count) / 3;
    const copies = object.isInstancedMesh ? object.count : 1;
    triangles += per * copies;
    drawCalls += Array.isArray(object.material) ? Math.max(1, g.groups.length) : 1;
  });
  const size = drawnBox(root).getSize(new THREE.Vector3());
  return {
    triangles: Math.round(triangles),
    drawCalls,
    size: [size.x, size.y, size.z].map((n) => Math.round(n * 100) / 100),
  };
}

const disposeBuilt = (object) =>
  object.traverse((node) => {
    // Shared materials stay: other models draw with them.
    node.geometry?.dispose?.();
    if (node.isInstancedMesh) node.dispose();
  });

/**
 * A model whose numbers live on the Stage: `ctx.tune(name, defaults, ranges)` feeds
 * `build(values)`, which returns the model (an Object3D); it is built again whenever the person
 * changes a value. The Group returned is named for the Stage (`kind`, default "prop").
 */
export function tuned(ctx, name, defaults, ranges, build, { kind = "prop" } = {}) {
  const values = ctx.tune(name, defaults, ranges);
  const holder = new THREE.Group();
  holder.name = name;
  const rebuild = () => {
    // A copy: removing from the list being walked would skip every other child.
    for (const child of holder.children.slice()) {
      holder.remove(child);
      disposeBuilt(child);
    }
    holder.add(build({ ...values }));
  };
  rebuild();
  ctx.thing(holder, { name, kind });
  if (!tunedModels.has(name)) tunedModels.set(name, []);
  tunedModels.get(name).push(rebuild);
  return holder;
}

// ── Characters on the standard skeleton ───────────────────────────────

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Distance from p to the segment a-b. */
const toSegment = (p, a, b) => {
  const ab = _b.subVectors(b, a);
  const t = THREE.MathUtils.clamp(
    _p.subVectors(p, a).dot(ab) / Math.max(ab.lengthSq(), 1e-9),
    0,
    1,
  );
  return _p.copy(a).addScaledVector(ab, t).distanceTo(p);
};

/**
 * A body built in code onto a rigged copy (the animation library's clip file): its skinned
 * meshes come off, its bones and clips stay, and parts ride the bones.
 */
export function rig(copy) {
  copy.updateWorldMatrix(true, true);
  const toBody = copy.matrixWorld.clone().invert();
  const skinned = [];
  copy.traverse((object) => {
    if (object.isSkinnedMesh) skinned.push(object);
  });
  const bones = new Map();
  copy.traverse((object) => {
    if (object.isBone) bones.set(object.name, object);
  });
  if (bones.size === 0)
    throw new Error(
      "model.rig: this model has no skeleton; name the animation library's clip file in ASSETS",
    );
  for (const mesh of skinned) mesh.removeFromParent();
  const rest = new Map();
  for (const [name, bone] of bones)
    rest.set(
      name,
      new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld).applyMatrix4(toBody),
    );
  // Each bone as a segment to its first bone child; a leaf bone as a point.
  const segments = [...bones].map(([name, bone]) => {
    const child = bone.children.find((c) => c.isBone);
    return {
      name,
      bone,
      a: rest.get(name),
      b: child === undefined ? rest.get(name) : rest.get(child.name),
    };
  });
  // Fingers and leaf tips take no parts by nearness: a hand part rides the hand.
  const carriers = segments.filter((s) => !/_0[1-4]_|_leaf|^ik_|^root$/i.test(s.name));
  const parts = [];
  const nearest = (point) => {
    let best = null;
    let bestDistance = Infinity;
    for (const s of carriers) {
      const d = toSegment(point, s.a, s.b);
      if (d < bestDistance) [best, bestDistance] = [s, d];
    }
    return best.name;
  };
  const jointOf = (name) => {
    const at = rest.get(name);
    if (at === undefined)
      throw new Error(
        `model.rig: no bone "${name}"; the bones are ${[...bones.keys()].join(", ")}`,
      );
    return at;
  };
  const body = {
    root: copy,
    bones: [...bones.keys()],
    /** A joint's rest position in body metres. */
    joint: (name) => jointOf(name).clone(),
    /**
     * Puts a mesh placed in body metres onto `bone` (by default the bone nearest its centre);
     * `rigid` keeps it whole when the body is skinned smooth: a sword, a helmet, a shield.
     */
    add(mesh, bone, { rigid = false } = {}) {
      mesh.updateMatrixWorld(true);
      const centre = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
      const name = bone ?? nearest(centre.lengthSq() > 0 ? centre : mesh.position);
      jointOf(name);
      parts.push({ mesh, bone: name, rigid });
      return mesh;
    },
    /** A mesh of `geometry` and `material` placed in body metres ({ at, turn, scale, bone, rigid }). */
    part(geometry, material, options = {}) {
      return body.add(part(geometry, material, options), options.bone, options);
    },
    /** A capsule from joint `from` to joint `to`, riding `from`; `end` tapers it to that radius. */
    limb(from, to, radius, material, { end = radius, sides = 10, over = 0 } = {}) {
      const a = jointOf(from),
        b = jointOf(to);
      const length = a.distanceTo(b);
      const geometry = new THREE.CylinderGeometry(end, radius, length + over * 2, sides, 1, false);
      // Round ends as spheres keep a bent joint closed.
      const ends = [
        new THREE.SphereGeometry(radius, sides, 6).translate(0, -(length / 2 + over), 0),
        new THREE.SphereGeometry(end, sides, 6).translate(0, length / 2 + over, 0),
      ];
      const merged = mergeGeometries([geometry, ...ends].map(uniform), false);
      const mesh = part(merged, material);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(UP, _a.subVectors(b, a).normalize());
      parts.push({ mesh, bone: from, rigid: false });
      return mesh;
    },
    /**
     * The body, ready for animate(). `skin: "smooth"` (default) merges the parts into one skinned
     * mesh per material and weights each vertex to its part's bone, that bone's parent and its
     * children by distance, so limbs bend at the joints; `"rigid"` hangs each part on its bone,
     * a draw call per bone and material.
     */
    done({ skin = "smooth" } = {}) {
      if (skin === "smooth") smoothSkin(copy, parts, bones, segments);
      else rigidParts(copy, parts, bones);
      copy.userData.codeBody = { parts: parts.length, skin };
      return copy;
    },
  };
  return body;
}

/** Each bone's parts, one mesh per material, riding it. */
function rigidParts(copy, parts, bones) {
  const groups = new Map();
  for (const { mesh, bone } of parts) {
    const key = `${bone}|${mesh.material.uuid}`;
    if (!groups.has(key))
      groups.set(key, { bone: bones.get(bone), material: mesh.material, meshes: [] });
    groups.get(key).meshes.push(mesh);
  }
  copy.updateWorldMatrix(true, true);
  const toBody = copy.matrixWorld.clone().invert();
  for (const { bone, material, meshes } of groups.values()) {
    // Into the bone's own space at rest: the bone's rest frame in body metres, inverted.
    const toBone = new THREE.Matrix4().multiplyMatrices(toBody, bone.matrixWorld).invert();
    const geometries = meshes.map((mesh) => {
      mesh.updateMatrix();
      const placed = uniform(mesh.geometry).applyMatrix4(mesh.matrix).applyMatrix4(toBone);
      mesh.geometry.dispose();
      return placed;
    });
    const mesh = new THREE.Mesh(mergeGeometries(geometries, false), material);
    mesh.castShadow = mesh.receiveShadow = true;
    bone.add(mesh);
  }
}

// The neighbours a vertex may blend with, and how sharply weight falls off with distance.
const SKIN_POWER = 4;
const SKIN_INFLUENCES = 4;

function smoothSkin(copy, parts, bones, segments) {
  const boneList = [...bones.values()];
  const indexOf = new Map(boneList.map((bone, i) => [bone.name, i]));
  const segmentOf = new Map(segments.map((s) => [s.name, s]));
  const byMaterial = new Map();
  for (const { mesh, bone, rigid } of parts) {
    mesh.updateMatrix();
    const geometry = uniform(mesh.geometry).applyMatrix4(mesh.matrix);
    const own = bones.get(bone);
    const near = rigid
      ? [own]
      : [own, own.parent, ...own.children].filter((b) => b?.isBone && indexOf.has(b.name));
    const count = geometry.attributes.position.count;
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    const p = new THREE.Vector3();
    for (let v = 0; v < count; v += 1) {
      p.fromBufferAttribute(geometry.attributes.position, v);
      const scored = near
        .map((b) => {
          const s = segmentOf.get(b.name);
          // The part's own bone wins ties: it is where the part was put.
          const d = toSegment(p, s.a, s.b) * (b === own ? 0.75 : 1);
          return { i: indexOf.get(b.name), w: 1 / Math.max(d, 0.005) ** SKIN_POWER };
        })
        .sort((x, y) => y.w - x.w)
        .slice(0, SKIN_INFLUENCES);
      const total = scored.reduce((sum, s) => sum + s.w, 0);
      scored.forEach((s, k) => {
        skinIndex[v * 4 + k] = s.i;
        skinWeight[v * 4 + k] = s.w / total;
      });
    }
    geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
    geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
    if (!byMaterial.has(mesh.material)) byMaterial.set(mesh.material, []);
    byMaterial.get(mesh.material).push(geometry);
    mesh.geometry.dispose();
  }
  // Bound at the rest pose the parts were placed in: the bones' inverses are taken now, and each
  // mesh sits in the copy's own space, where the parts were placed.
  copy.updateWorldMatrix(true, true);
  const skeleton = new THREE.Skeleton(boneList);
  for (const [material, geometries] of byMaterial) {
    const mesh = new THREE.SkinnedMesh(mergeGeometries(geometries, false), material);
    mesh.castShadow = mesh.receiveShadow = true;
    copy.add(mesh);
    mesh.updateWorldMatrix(true, false);
    mesh.bind(skeleton);
  }
}

/** The shell's side: a new run makes its own materials; a Stage tune rebuilds its model. */
export const modelShell = {
  reset() {
    paints = new Map();
    tunedModels = new Map();
  },
  tuned(id) {
    for (const rebuild of tunedModels.get(id) ?? []) rebuild();
  },
};
