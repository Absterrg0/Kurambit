// Levels as text maps. Write the level as rows of characters and a legend;
// buildLevel places the pieces on a grid in ctx.scene and returns the spawns,
// the bounds and the wall collision, so nothing is placed by coordinates.
//
//   import { buildLevel } from "./shell/level.js";
//
//   const level = buildLevel(ctx, [
//     "#########   #########",
//     "#P......#   #.....E.#",
//     "#...c...#####...G...#",
//     "#.......=...=.......#",   // two rooms joined by a corridor
//     "#.......#####.....E.#",
//     "#########   #########",
//   ], {
//     "#": { model: "wall" },                 // an ASSETS model; solid unless solid: false
//     "c": { model: "barrel", scale: 0.8 },  // props stand on the floor
//     "=": { floor: "floor-detail" },         // a walkable cell with its own floor piece
//     "P": "spawn", "E": "spawn", "G": "spawn",
//   }, { cell: 1, floor: "floor" });
//
//   player.position.copy(level.spawns.P[0]);   // spawns by letter: arrays of Vector3 at floor height
//   for (const at of level.spawns.E) addEnemy(at);
//   // every frame: slide the player's circle along the walls (never through one)
//   level.move(player.position, velocity.clone().multiplyScalar(dt), 0.35);
//   followCamera3D(ctx, player, { blockers: level.walls });
//   followCamera2D(ctx, player, { plane: "xz", bounds: level.bounds });
//
// " " is void (blocked, nothing drawn) and "." is plain floor unless the legend
// says otherwise; any other character must be in the legend. Every non-void
// cell gets a floor under it: the `floor` model (one cell across at `scale`),
// or a plain tile without one. A legend entry is "spawn", "floor", a model name
// (a solid piece), or { model, solid, floor, spawn, scale, rotate (degrees
// about y), y }. A solid cell blocks its whole square. Column c, row r sits at
// x = (c + 0.5) * cell, z = (r + 0.5) * cell from `origin`; rows run toward +z.
// Rooms are just rows: concatenate arrays to stack them, add strings row by
// row to put them side by side. Repeated pieces are instanced, so a 60x60 map
// costs one draw per piece mesh, not one per cell.
import * as THREE from "../vendor/three.module.js";

const DEFAULTS = { " ": { void: true }, ".": {} };

export function buildLevel(ctx, rows, legend = {}, options = {}) {
  const { cell = 1, floor = null, scale = 1, origin = { x: 0, z: 0 } } = options;
  const entries = { ...DEFAULTS };
  for (const [char, raw] of Object.entries(legend)) entries[char] = entry(char, raw);
  const height = rows.length;
  const width = Math.max(0, ...rows.map((row) => row.length));
  const solid = new Uint8Array(width * height).fill(1);
  const chars = [];
  const spawns = {};
  // model name -> list of cell matrices; each model becomes one InstancedMesh per mesh it holds
  const placements = new Map();
  const plainFloor = [];
  const unknown = new Set();
  const place = (name, matrix) => {
    if (!placements.has(name)) placements.set(name, []);
    placements.get(name).push(matrix);
  };
  const bounds = new THREE.Box3();
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const char = rows[r][c] ?? " ";
      chars.push(char);
      const e = entries[char];
      if (e === undefined) {
        unknown.add(char);
        continue;
      }
      if (e.void) continue;
      const x = origin.x + (c + 0.5) * cell;
      const z = origin.z + (r + 0.5) * cell;
      solid[r * width + c] = e.solid ? 1 : 0;
      bounds.expandByPoint(new THREE.Vector3(x - cell / 2, 0, z - cell / 2));
      bounds.expandByPoint(new THREE.Vector3(x + cell / 2, cell, z + cell / 2));
      const floorName = e.floor === undefined ? floor : e.floor;
      if (floorName === null) plainFloor.push(new THREE.Matrix4().makeTranslation(x, 0, z));
      else if (floorName !== false) place(floorName, pieceMatrix(x, 0, z, 0, scale));
      if (e.model !== undefined)
        place(e.model, pieceMatrix(x, e.y ?? 0, z, e.rotate ?? 0, e.scale ?? scale));
      if (e.spawn) (spawns[char] ??= []).push(new THREE.Vector3(x, 0, z));
    }
  }
  if (unknown.size > 0)
    throw new Error(
      `buildLevel: no legend entry for ${[...unknown].map((ch) => JSON.stringify(ch)).join(", ")}. Legend has ${Object.keys(
        entries,
      )
        .map((ch) => JSON.stringify(ch))
        .join(", ")}.`,
    );

  const group = new THREE.Group();
  group.name = "level";
  const walls = [];
  const solidModels = new Set(
    Object.values(entries)
      .filter((e) => e.solid && e.model !== undefined)
      .map((e) => e.model),
  );
  for (const [name, matrices] of placements) {
    for (const mesh of instanced(ctx, name, matrices)) {
      group.add(mesh);
      if (solidModels.has(name)) walls.push(mesh);
      bounds.expandByObject(mesh);
    }
  }
  if (plainFloor.length > 0) {
    const tile = new THREE.PlaneGeometry(cell, cell).rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 1 });
    const mesh = new THREE.InstancedMesh(tile, material, plainFloor.length);
    plainFloor.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.computeBoundingSphere();
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  ctx.scene.add(group);

  const colOf = (x) => Math.floor((x - origin.x) / cell);
  const rowOf = (z) => Math.floor((z - origin.z) / cell);
  const blockedCell = (c, r) =>
    c < 0 || r < 0 || c >= width || r >= height || solid[r * width + c] === 1;
  const blocked = (x, z) => blockedCell(colOf(x), rowOf(z));

  // Pushes a circle at (p.x, p.z) out of every blocked cell it overlaps.
  const resolve = (p, radius) => {
    let hit = false;
    const c0 = colOf(p.x - radius);
    const c1 = colOf(p.x + radius);
    const r0 = rowOf(p.z - radius);
    const r1 = rowOf(p.z + radius);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (!blockedCell(c, r)) continue;
        const minX = origin.x + c * cell;
        const minZ = origin.z + r * cell;
        const nx = Math.min(Math.max(p.x, minX), minX + cell);
        const nz = Math.min(Math.max(p.z, minZ), minZ + cell);
        let dx = p.x - nx;
        let dz = p.z - nz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= radius * radius) continue;
        hit = true;
        if (d2 > 1e-12) {
          const d = Math.sqrt(d2);
          p.x += (dx / d) * (radius - d);
          p.z += (dz / d) * (radius - d);
        } else {
          // The centre is inside the cell (spawned there): leave by the nearest side.
          dx = p.x - (minX + cell / 2);
          dz = p.z - (minZ + cell / 2);
          if (Math.abs(dx) > Math.abs(dz)) p.x = dx > 0 ? minX + cell + radius : minX - radius;
          else p.z = dz > 0 ? minZ + cell + radius : minZ - radius;
        }
      }
    }
    return hit;
  };

  return {
    group,
    /** Spawn cells by letter, each an array of Vector3 at floor height. */
    spawns,
    /** The level's box (Box3); pass it to followCamera2D's bounds. */
    bounds,
    /** The solid pieces' meshes: followCamera3D's blockers. */
    walls,
    cell,
    width,
    height,
    /** True when (x, z) is in a wall, the void or outside the map. */
    blocked,
    /** The map character at (x, z); " " outside the map. */
    at(x, z) {
      const c = colOf(x);
      const r = rowOf(z);
      return c < 0 || r < 0 || c >= width || r >= height ? " " : chars[r * width + c];
    },
    /** The centre of column c, row r. */
    toWorld(c, r) {
      return new THREE.Vector3(origin.x + (c + 0.5) * cell, 0, origin.z + (r + 0.5) * cell);
    },
    /**
     * Moves position (x and z; y is left alone) by delta, sliding a circle of
     * this radius along blocked cells. Steps are shorter than the radius, so
     * no speed passes through a wall. Returns true when it touched one.
     */
    move(position, delta, radius = 0.35) {
      const length = Math.hypot(delta.x, delta.z);
      const steps = Math.max(1, Math.ceil(length / (Math.min(radius, cell) * 0.5)));
      const sx = delta.x / steps;
      const sz = delta.z / steps;
      let hit = false;
      for (let i = 0; i < steps; i++) {
        position.x += sx;
        position.z += sz;
        // A second pass settles an inside corner, where leaving one cell can touch the next.
        if (resolve(position, radius)) {
          hit = true;
          resolve(position, radius);
        }
      }
      return hit;
    },
  };
}

function entry(char, raw) {
  if (raw === "spawn") return { spawn: true };
  if (raw === "floor") return {};
  if (raw === "void") return { void: true };
  if (typeof raw === "string") return { model: raw, solid: true };
  if (raw === null || typeof raw !== "object")
    throw new Error(`buildLevel: legend ${JSON.stringify(char)} is ${JSON.stringify(raw)}.`);
  return { ...raw, solid: raw.solid ?? raw.model !== undefined };
}

function pieceMatrix(x, y, z, degrees, scale) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      THREE.MathUtils.degToRad(degrees),
    ),
    new THREE.Vector3(scale, scale, scale),
  );
}

// One InstancedMesh per mesh inside the model, each instance the cell matrix
// times that mesh's own place in the model.
function instanced(ctx, name, matrices) {
  const model = ctx.assets.model(name);
  model.position.set(0, 0, 0);
  model.rotation.set(0, 0, 0);
  model.scale.set(1, 1, 1);
  model.updateMatrixWorld(true);
  const meshes = [];
  const local = new THREE.Matrix4();
  model.traverse((object) => {
    if (!object.isMesh) return;
    const mesh = new THREE.InstancedMesh(object.geometry, object.material, matrices.length);
    mesh.name = `${name}:${object.name}`;
    matrices.forEach((matrix, i) =>
      mesh.setMatrixAt(i, local.multiplyMatrices(matrix, object.matrixWorld)),
    );
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    meshes.push(mesh);
  });
  if (meshes.length === 0) throw new Error(`buildLevel: model "${name}" has no meshes.`);
  return meshes;
}
