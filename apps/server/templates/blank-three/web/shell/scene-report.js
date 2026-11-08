// The scene report: what a person sees at a glance that the play facts miss.
// While the harness measures a play (game_check's short play, the facts'
// random-input play), the shell looks at the scene a few times a second and
// keeps only what a person would agree is broken: the player out of view or
// too small to read, a body sunk into the ground or inside a solid, two bodies
// inside each other, a thing fallen out of the world, the camera inside a
// wall, a skinned body sliding over the ground in idle or a frozen pose, and
// things that never came on screen. Each comes with the time, the thing's name
// and one frame with it outlined.
//
// It reads only what the shell already knows: the scene and camera on screen,
// ctx.player and the Stage bridge's things with their kinds. Nothing runs and
// nothing is allocated per frame until the harness calls start(): a play
// nobody measures never samples.
import * as THREE from "../vendor/three.module.js";
import { GameState } from "./run-state.js";

/** Every threshold the report judges by. */
export const LIMITS = {
  // Four looks a second catch anything that lasts a moment and keep frame times honest.
  hz: 4,
  // Feet sunk less than this (metres, and share of the body's height) read as standing on it:
  // a model's sole, grass and the shell's foot placement sit a little into the ground.
  buriedM: 0.15,
  buriedShare: 0.25,
  // A surface higher than this above the feet (heights of the body, or the body plus half a
  // metre) is a roof or canopy over it, never the ground it stands in.
  buriedMaxHeights: 1.5,
  // Longer than this is "longer than a moment": a hit, a pickup, a dash or a crossfade is shorter.
  momentS: 1,
  // Two bodies whose boxes share this much of the smaller one are inside each other, not touching.
  overlapShare: 0.5,
  // The player hidden or off screen for more of the play than this cannot be followed.
  hiddenShare: 0.25,
  // A player drawn shorter than this share of the canvas height is too small to read.
  smallShare: 0.025,
  // This far below the level (metres, or the level's own height if more) and for a moment:
  // fell out of the world. A pit's fall ends sooner, and a lose screen stops the sampling.
  fallM: 20,
  // Faster than this over the ground (m/s, and body heights per second) is walking, not drifting.
  slideMps: 0.5,
  slideHeights: 0.5,
  // Ground within this share of the body's height (plus 5 cm) of its feet: it stands on it.
  groundShare: 0.15,
  // Vertices a skinned body's bounds read per look: its posed extent at a bounded cost.
  skinVertices: 300,
  // Bodies measured per look, the player first; past it they take turns.
  bodies: 12,
  // Frames kept for the report, and their width in pixels.
  frames: 8,
  frameWidth: 640,
  // Lines the report names at most.
  findings: 24,
  unseen: 16,
};

const BODY_KINDS = new Set(["character", "creature"]);
const NOT_SOLID_KINDS = new Set(["character", "creature", "effect", "ui"]);
const SEEN_KINDS = new Set(["character", "creature", "prop", "level"]);
const MAX_HITS = 32;
const PLAYER_ID = "\0player";
const HEIGHTS = 4096;

const humanName = (key) => {
  const words = String(key)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const round = (x, d = 2) => Number(x.toFixed(d));

/**
 * The shell's side. `view()` is the scene and camera on screen (or null),
 * `player()` is ctx.player, `bridge` the Stage bridge (its things and kinds),
 * `animation(object)` the animate kit's state for a body ({ state, clip } or null).
 */
export function createSceneReport({ canvas, view, player, bridge, animation }) {
  let active = false;
  let clock = 0;
  let played = 0;
  let samples = 0;
  let turn = 0;
  // What the looks cost, so the harness can say what measuring a play adds to its frames.
  let costMs = 0;
  let worstMs = 0;

  // Scratch, made once: a look allocates only what three's raycaster returns.
  const raycaster = new THREE.Raycaster();
  const hits = [];
  const down = new THREE.Vector3(0, -1, 0);
  const up = new THREE.Vector3(0, 1, 0);
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const point = new THREE.Vector3();
  const v = new THREE.Vector3();
  const cameraAt = new THREE.Vector3();
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();
  const otherBox = new THREE.Box3();
  const levelBox = new THREE.Box3();
  const allBox = new THREE.Box3();
  const frustum = new THREE.Frustum();
  const projection = new THREE.Matrix4();
  const solids = [];
  const notSolid = new Set();
  const levelSolid = new Set();
  const bodies = [];
  const heights = new Float32Array(HEIGHTS);
  let heightCount = 0;
  // One column: the tops a ray from above enters and the bottoms one from below enters.
  const column = {
    tops: new Float64Array(MAX_HITS),
    topObjects: new Array(MAX_HITS).fill(null),
    topInstances: new Int32Array(MAX_HITS),
    nTops: 0,
    bottoms: new Float64Array(MAX_HITS),
    bottomObjects: new Array(MAX_HITS).fill(null),
    bottomInstances: new Int32Array(MAX_HITS),
    nBottoms: 0,
    x: 0,
    z: 0,
    top: 0,
    bottom: 0,
  };
  // What insideAt found: the object, its instance and the top of the solid over the point.
  const found = { object: null, instance: -1, top: 0 };

  // Per body and per problem, kept across runs by the thing's id.
  const trackers = new Map();
  const unseen = new Map();
  const frames = [];
  const playerView = {
    measured: 0,
    hidden: 0,
    offscreen: 0,
    blocker: null,
    blockerSeconds: new Map(),
    frame: null,
    smallFrame: null,
    kind: null,
    name: "Player",
  };

  const reset = () => {
    clock = 0;
    played = 0;
    samples = 0;
    costMs = 0;
    worstMs = 0;
    heightCount = 0;
    trackers.clear();
    unseen.clear();
    frames.length = 0;
    playerView.measured = 0;
    playerView.hidden = 0;
    playerView.offscreen = 0;
    playerView.blocker = null;
    playerView.blockerSeconds.clear();
    playerView.frame = null;
    playerView.smallFrame = null;
    playerView.kind = null;
  };

  // ── Bounds ────────────────────────────────────────────────────────────
  // A skinned mesh's cached bounds are its bind pose, which can sit far from
  // where it stands: its posed vertices are read, a bounded number of them.
  let target = box;
  const expand = (node) => {
    if (!node.isMesh) return;
    const geometry = node.geometry;
    if (node.isSkinnedMesh) {
      const position = geometry.attributes.position;
      if (position === undefined) return;
      const step = Math.max(1, Math.ceil(position.count / LIMITS.skinVertices));
      for (let i = 0; i < position.count; i += step) {
        node.getVertexPosition(i, v);
        target.expandByPoint(v.applyMatrix4(node.matrixWorld));
      }
      return;
    }
    let local;
    if (node.isInstancedMesh) {
      if (node.boundingBox === null) node.computeBoundingBox();
      local = node.boundingBox;
    } else {
      if (geometry.boundingBox === null) geometry.computeBoundingBox();
      local = geometry.boundingBox;
    }
    if (local === null || local.isEmpty()) return;
    target.union(meshBox.copy(local).applyMatrix4(node.matrixWorld));
  };
  const boundsOf = (object, into) => {
    into.makeEmpty();
    target = into;
    object.traverseVisible(expand);
    return into;
  };

  // ── What counts as solid ──────────────────────────────────────────────
  const solidMaterial = (material) =>
    material != null &&
    material.visible !== false &&
    material.side !== THREE.BackSide &&
    material.depthWrite !== false &&
    !(material.transparent === true && material.opacity < 0.5);
  const isSolid = (mesh) => {
    if (!mesh.isMesh || mesh.isSkinnedMesh) return false;
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (let i = 0; i < material.length; i += 1) if (solidMaterial(material[i])) return true;
      return false;
    }
    return solidMaterial(material);
  };
  // Every visible solid mesh outside bodies, effects and ui; the level's own (not a registered
  // prop's or body's) bounds the world, so a thing that falls never drags the world down with it.
  const collect = (node, outside, level) => {
    if (!node.visible) return;
    const out = outside || notSolid.has(node);
    const record = bridge.thingOf(node, true);
    const inLevel = level && (record === undefined || record.kind === "level");
    if (!out && isSolid(node)) {
      solids.push(node);
      boundsOf(node, otherBox);
      allBox.union(otherBox);
      if (inLevel) levelBox.union(otherBox);
    }
    const children = node.children;
    for (let i = 0; i < children.length; i += 1) collect(children[i], out, inLevel);
  };

  // ── Rays ──────────────────────────────────────────────────────────────
  // three's InstancedMesh.raycast rebuilds every instance's matrix for every ray, which on a
  // tiled level is most of a look. Each instanced solid keeps its instances' world spheres,
  // made again only when its matrices change, so a ray reaches three's own Mesh.raycast only
  // for the instances it can touch.
  const proxy = new THREE.Mesh();
  const instanceMatrix = new THREE.Matrix4();
  const instanceHits = [];
  const sphere = new THREE.Sphere();
  const instanced = new WeakMap();
  const spheresOf = (mesh) => {
    let entry = instanced.get(mesh);
    const world = mesh.matrixWorld.elements;
    const stale =
      entry === undefined ||
      entry.version !== mesh.instanceMatrix.version ||
      entry.count !== mesh.count ||
      entry.world.some((value, i) => value !== world[i]);
    if (!stale) return entry;
    if (mesh.geometry.boundingSphere === null) mesh.geometry.computeBoundingSphere();
    const data = new Float32Array(mesh.count * 4);
    for (let i = 0; i < mesh.count; i += 1) {
      mesh.getMatrixAt(i, instanceMatrix);
      instanceMatrix.premultiply(mesh.matrixWorld);
      sphere.copy(mesh.geometry.boundingSphere).applyMatrix4(instanceMatrix);
      data[i * 4] = sphere.center.x;
      data[i * 4 + 1] = sphere.center.y;
      data[i * 4 + 2] = sphere.center.z;
      data[i * 4 + 3] = sphere.radius;
    }
    entry = { version: mesh.instanceMatrix.version, count: mesh.count, world: [...world], data };
    instanced.set(mesh, entry);
    return entry;
  };
  // The ray's hits on every solid, into `hits` (unsorted).
  const intersectSolids = () => {
    const ray = raycaster.ray;
    for (let s = 0; s < solids.length; s += 1) {
      const mesh = solids[s];
      if (!mesh.isInstancedMesh) {
        mesh.raycast(raycaster, hits);
        continue;
      }
      const { data } = spheresOf(mesh);
      proxy.geometry = mesh.geometry;
      proxy.material = mesh.material;
      for (let i = 0; i < mesh.count; i += 1) {
        sphere.center.set(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
        sphere.radius = data[i * 4 + 3];
        if (!ray.intersectsSphere(sphere)) continue;
        mesh.getMatrixAt(i, instanceMatrix);
        proxy.matrixWorld.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
        proxy.raycast(raycaster, instanceHits);
        for (let h = 0; h < instanceHits.length; h += 1) {
          instanceHits[h].instanceId = i;
          instanceHits[h].object = mesh;
          hits.push(instanceHits[h]);
        }
        instanceHits.length = 0;
      }
    }
  };
  const nearestFirst = (a, b) => a.distance - b.distance;

  // ── Columns: what is solid along a vertical line ──────────────────────
  // Front faces only answer a ray, so a ray from above enters each solid at its top and one
  // from below at its bottom: a point is inside an object when more of its tops than its
  // bottoms lie above it. A double-sided mesh counts the same both ways and never holds a
  // point: it can miss a problem, never invent one. The ray from below is cast only when a
  // top lies above a point asked about, which for a body on open ground is never.
  const cast = (x, z, top, bottom) => {
    column.nTops = 0;
    column.nBottoms = -1;
    column.x = x;
    column.z = z;
    column.top = top;
    column.bottom = bottom;
    raycaster.near = 0;
    raycaster.far = top - bottom;
    origin.set(x, top, z);
    raycaster.set(origin, down);
    hits.length = 0;
    intersectSolids();
    for (let i = 0; i < hits.length && column.nTops < MAX_HITS; i += 1) {
      column.tops[column.nTops] = hits[i].point.y;
      column.topObjects[column.nTops] = hits[i].object;
      column.topInstances[column.nTops] = hits[i].instanceId ?? -1;
      column.nTops += 1;
    }
    hits.length = 0;
  };
  const castBottoms = () => {
    column.nBottoms = 0;
    raycaster.near = 0;
    raycaster.far = column.top - column.bottom;
    origin.set(column.x, column.bottom, column.z);
    raycaster.set(origin, up);
    hits.length = 0;
    intersectSolids();
    for (let i = 0; i < hits.length && column.nBottoms < MAX_HITS; i += 1) {
      column.bottoms[column.nBottoms] = hits[i].point.y;
      column.bottomObjects[column.nBottoms] = hits[i].object;
      column.bottomInstances[column.nBottoms] = hits[i].instanceId ?? -1;
      column.nBottoms += 1;
    }
    hits.length = 0;
  };
  /**
   * Whether height y on the last cast column is inside a solid. `closed`: the solid must also
   * close below the point (a one-sided ground plane holds what sank under it, never a body
   * inside a hollow). Fills `found` with the object and the top of the solid over y.
   */
  const insideAt = (y, closed) => {
    for (let i = 0; i < column.nTops; i += 1) {
      if (column.tops[i] <= y) continue;
      if (column.nBottoms < 0) castBottoms();
      const object = column.topObjects[i];
      const instance = column.topInstances[i];
      let above = 0;
      let lowest = Infinity;
      for (let j = 0; j < column.nTops; j += 1)
        if (
          column.topObjects[j] === object &&
          column.topInstances[j] === instance &&
          column.tops[j] > y
        ) {
          above += 1;
          lowest = Math.min(lowest, column.tops[j]);
        }
      let bottomsAbove = 0;
      let closes = false;
      for (let j = 0; j < column.nBottoms; j += 1) {
        if (column.bottomObjects[j] !== object || column.bottomInstances[j] !== instance) continue;
        if (column.bottoms[j] > y) bottomsAbove += 1;
        else closes = true;
      }
      if (above > bottomsAbove && (!closed || closes)) {
        found.object = object;
        found.instance = instance;
        found.top = lowest;
        return true;
      }
    }
    return false;
  };
  // The ground a body stands on: the highest top near its feet, or null.
  const groundAt = (feet, tolerance) => {
    let best = null;
    let bestY = -Infinity;
    for (let i = 0; i < column.nTops; i += 1) {
      const y = column.tops[i];
      if (y <= feet + tolerance && y >= feet - tolerance && y > bestY) {
        bestY = y;
        best = column.topObjects[i];
      }
    }
    return best;
  };

  // ── Names ─────────────────────────────────────────────────────────────
  const nameOf = (object) => {
    if (object === null) return null;
    const record = bridge.thingOf(object, false);
    if (record !== undefined) return record.name;
    for (let node = object; node !== null; node = node.parent)
      if (typeof node.name === "string" && node.name !== "" && !node.isScene)
        // The shell's level names its pieces "model:mesh"; the model is the name people know.
        return humanName(node.name.split(":")[0]);
    return "level geometry";
  };

  // ── Trackers ──────────────────────────────────────────────────────────
  // `body`: the id whose measured seconds a share is of (the first of a pair; none for the camera).
  const trackerOf = (key, kind, thing, body = key) => {
    const id = `${kind}\0${key}`;
    let tracker = trackers.get(id);
    if (tracker === undefined) {
      tracker = {
        kind,
        body,
        thing,
        other: null,
        at: null,
        seconds: 0,
        run: 0,
        longest: 0,
        amount: 0,
        frame: null,
      };
      trackers.set(id, tracker);
    }
    return tracker;
  };
  // A problem held this look; `amount` keeps its worst. Its frame is taken once it lasts a moment.
  const held = (tracker, span, other, amount, outline) => {
    if (tracker.at === null) tracker.at = round(played, 1);
    tracker.seconds += span;
    tracker.run += span;
    tracker.longest = Math.max(tracker.longest, tracker.run);
    if (amount > tracker.amount || tracker.other === null) {
      tracker.amount = Math.max(tracker.amount, amount);
      tracker.other = other;
    }
    if (tracker.frame === null && tracker.run >= LIMITS.momentS - 1e-6)
      tracker.frame = capture(outline, tracker.thing);
  };
  const cleared = (tracker) => {
    if (tracker !== undefined) tracker.run = 0;
  };

  // ── Frames ────────────────────────────────────────────────────────────
  // The frame just drawn, copied while its buffer is still the canvas's, the problem's box
  // outlined. Encoded only when the report is read, after play.
  const capture = (outline, label) => {
    if (frames.length >= LIMITS.frames || canvas.width === 0) return null;
    const seen = view();
    const w = LIMITS.frameWidth;
    const h = Math.max(1, Math.round((w * canvas.height) / canvas.width));
    const copy = document.createElement("canvas");
    copy.width = w;
    copy.height = h;
    const g = copy.getContext("2d");
    if (g === null) return null;
    g.drawImage(canvas, 0, 0, w, h);
    if (outline !== null && seen !== null) {
      const rect = rectOf(outline, seen.camera, w, h);
      if (rect !== null) {
        g.lineWidth = 3;
        g.strokeStyle = "#ff2d55";
        g.strokeRect(rect.x, rect.y, rect.w, rect.h);
        if (label !== null) {
          g.font = "600 14px system-ui, sans-serif";
          const text = String(label).slice(0, 40);
          const width = g.measureText(text).width + 8;
          const y = rect.y >= 20 ? rect.y - 20 : Math.min(h - 20, rect.y + rect.h);
          g.fillStyle = "#ff2d55";
          g.fillRect(rect.x, y, width, 20);
          g.fillStyle = "#ffffff";
          g.fillText(text, rect.x + 4, y + 15);
        }
      }
    }
    const id = `scene-${frames.length + 1}`;
    frames.push({ id, canvas: copy });
    return id;
  };
  // A box on screen, clamped to the frame; null when none of it is in front of the camera.
  const rectOf = (bounds, camera, w, h) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < 8; i += 1) {
      point
        .set(
          i & 1 ? bounds.max.x : bounds.min.x,
          i & 2 ? bounds.max.y : bounds.min.y,
          i & 4 ? bounds.max.z : bounds.min.z,
        )
        .project(camera);
      if (point.z > 1) continue;
      const x = ((point.x + 1) / 2) * w;
      const y = ((1 - point.y) / 2) * h;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    if (!(x1 > 0 && y1 > 0 && x0 < w && y0 < h)) return null;
    x0 = Math.max(1, x0);
    y0 = Math.max(1, y0);
    x1 = Math.min(w - 1, x1);
    y1 = Math.min(h - 1, y1);
    return { x: x0, y: y0, w: Math.max(2, x1 - x0), h: Math.max(2, y1 - y0) };
  };

  // ── One look ──────────────────────────────────────────────────────────
  const attached = (object, scene) => {
    let node = object;
    while (node.parent !== null) node = node.parent;
    return node === scene;
  };
  const shown = (object) => {
    for (let node = object; node !== null; node = node.parent) if (!node.visible) return false;
    return true;
  };
  const isAncestor = (a, b) => {
    for (let node = b.parent; node !== null; node = node.parent) if (node === a) return true;
    return false;
  };
  const finite = (m) =>
    Number.isFinite(m.elements[12]) &&
    Number.isFinite(m.elements[13]) &&
    Number.isFinite(m.elements[14]);

  // Bodies are kept between looks, so a look makes none.
  const pool = [];
  const bodyOf = (id, name, object) => {
    for (let i = 0; i < bodies.length; i += 1) if (bodies[i].object === object) return bodies[i];
    const body = pool[bodies.length] ?? { id, name, object, box: new THREE.Box3() };
    pool[bodies.length] = body;
    body.id = id;
    body.name = name;
    body.object = object;
    bodies.push(body);
    return body;
  };

  // What one look is about, for the registry walks below (made once, never per look).
  let lookScene = null;
  let lookPlayer = null;
  let lookSpan = 0;
  let lookWorld = levelBox;
  const others = [];
  const markNotSolid = (record) => {
    if (record.object !== null && NOT_SOLID_KINDS.has(record.kind)) notSolid.add(record.object);
  };
  const gatherBodies = (record) => {
    if (record.object === null || !BODY_KINDS.has(record.kind)) return;
    if (record.object === lookPlayer) return;
    if (!attached(record.object, lookScene) || !shown(record.object)) return;
    others.push(record);
  };

  const sample = (span) => {
    const seen = view();
    if (seen === null) return;
    const { scene, camera } = seen;
    samples += 1;
    camera.getWorldPosition(cameraAt);
    projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projection);

    // The bodies: the player first, then registered characters and creatures.
    const you = player();
    lookScene = scene;
    lookPlayer = you?.isObject3D === true ? you : null;
    lookSpan = span;
    bodies.length = 0;
    notSolid.clear();
    if (lookPlayer !== null) notSolid.add(lookPlayer);
    bridge.eachThing(markNotSolid);
    let playerBody = null;
    if (lookPlayer !== null && attached(lookPlayer, scene) && shown(lookPlayer)) {
      const record = bridge.thingOf(lookPlayer, true);
      playerBody = bodyOf(record?.id ?? PLAYER_ID, record?.name ?? "Player", lookPlayer);
    }
    others.length = 0;
    bridge.eachThing(gatherBodies);
    // Past the cap the bodies take turns, so every one is looked at.
    const room = Math.min(Math.max(0, LIMITS.bodies - bodies.length), others.length);
    for (let i = 0; i < room; i += 1) {
      const record = others[(turn + i) % others.length];
      bodyOf(record.id, record.name, record.object);
    }
    turn += room;
    others.length = 0;

    solids.length = 0;
    levelBox.makeEmpty();
    allBox.makeEmpty();
    collect(scene, false, true);
    // Columns span every solid; falling is measured against the level's own bounds.
    lookWorld = levelBox.isEmpty() ? allBox : levelBox;
    const canCast = !allBox.isEmpty();
    const top = allBox.max.y + 1;
    const bottom = allBox.min.y - 1;

    for (let n = 0; n < bodies.length; n += 1) {
      const body = bodies[n];
      if (!finite(body.object.matrixWorld)) {
        held(trackerOf(body.id, "fell", body.name), span, null, Infinity, null);
        continue;
      }
      boundsOf(body.object, body.box);
      if (body.box.isEmpty()) continue;
      const b = body.box;
      const feet = b.min.y;
      const height = b.max.y - b.min.y;
      if (!(height > 0.05)) continue;
      trackerOf(body.id, "measured", body.name).seconds += span;
      fell(body.id, body.name, body.object, span, b);
      if (!canCast) continue;
      const cx = (b.min.x + b.max.x) / 2;
      const cz = (b.min.z + b.max.z) / 2;
      const ox = (b.max.x - b.min.x) * 0.15;
      const oz = (b.max.z - b.min.z) * 0.15;

      // The column under the body's middle: the ground it stands on, whether its feet sank,
      // whether its middle is inside a solid.
      cast(cx, cz, top, bottom);
      const groundUnder = groundAt(feet, LIMITS.groundShare * height + 0.05);
      let depth = insideAt(feet + height * 0.02, false) ? found.top - feet : 0;
      const sunkIn = depth > 0 ? found.object : null;
      const sunk = (d) =>
        d > Math.max(LIMITS.buriedM, LIMITS.buriedShare * height) &&
        d <= Math.max(LIMITS.buriedMaxHeights * height, height + 0.5);
      let within = null;
      if (!sunk(depth)) {
        const low = insideAt(feet + height * 0.35, true) ? found.object : null;
        const high =
          low === null ? null : insideAt(feet + height * 0.65, true) ? found.object : null;
        within = high;
      } else
        // Buried only when two more columns sank too: a body at a ledge's edge, half over the
        // drop, is never read as sunk.
        for (let c = 0; c < 2 && depth > 0; c += 1) {
          cast(c === 0 ? cx - ox : cx + ox, c === 0 ? cz - oz : cz + oz, top, bottom);
          depth = Math.min(depth, insideAt(feet + height * 0.02, false) ? found.top - feet : 0);
        }
      const buried = trackerOf(body.id, "buried", body.name);
      if (sunk(depth)) held(buried, span, nameOf(sunkIn), depth, b);
      else cleared(buried);
      const inside = trackerOf(body.id, "inside", body.name);
      if (within !== null) held(inside, span, nameOf(within), 1, b);
      else cleared(inside);

      slide(body, groundUnder, span, height);
    }

    clipping(span);
    if (lookPlayer === null) playerView.kind = you == null ? "none" : "point";
    else if (playerBody === null) playerView.kind ??= "hidden-by-game";
    else look(playerBody, camera, span);
    if (canCast) cameraInside(span, top, bottom);
    bridge.eachThing(checkProp);
    bridge.eachThing(sighting);
  };

  // A thing far under the level, or with no position at all, has left the world.
  const fell = (id, name, object, span, outline) => {
    const tracker = trackerOf(id, "fell", name);
    if (lookWorld.isEmpty()) return cleared(tracker);
    const y = object.matrixWorld.elements[13];
    const floor = lookWorld.min.y - Math.max(LIMITS.fallM, lookWorld.max.y - lookWorld.min.y);
    if (y < floor) held(tracker, span, null, floor - y, outline);
    else cleared(tracker);
  };
  const checkProp = (record) => {
    if (record.object === null || record.kind !== "prop") return;
    if (!attached(record.object, lookScene) || !shown(record.object)) return;
    if (!finite(record.object.matrixWorld))
      held(trackerOf(record.id, "fell", record.name), lookSpan, null, Infinity, null);
    else fell(record.id, record.name, record.object, lookSpan, null);
  };

  // Two bodies inside each other: their boxes share most of the smaller one.
  const clipping = (span) => {
    for (let i = 0; i < bodies.length; i += 1)
      for (let j = i + 1; j < bodies.length; j += 1) {
        const a = bodies[i];
        const b = bodies[j];
        if (a.box.isEmpty() || b.box.isEmpty()) continue;
        if (isAncestor(a.object, b.object) || isAncestor(b.object, a.object)) continue;
        const key = a.id < b.id ? `${a.id}\0${b.id}` : `${b.id}\0${a.id}`;
        const tracker = trackers.get(`clipping\0${key}`);
        const overlap = overlapShare(a.box, b.box);
        if (overlap > LIMITS.overlapShare) {
          otherBox.copy(a.box).union(b.box);
          held(trackerOf(key, "clipping", a.name, a.id), span, b.name, overlap, otherBox);
        } else cleared(tracker);
      }
  };
  const overlapShare = (a, b) => {
    const x = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
    const y = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
    const z = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
    if (x <= 0 || y <= 0 || z <= 0) return 0;
    const volume = (box) =>
      (box.max.x - box.min.x) * (box.max.y - box.min.y) * (box.max.z - box.min.z);
    const smaller = Math.min(volume(a), volume(b));
    return smaller > 0 ? (x * y * z) / smaller : 0;
  };

  // Sliding: a skinned body moving over the ground while its clip is idle or its pose is frozen.
  // Its speed is over the ground under it, so a body riding a moving platform stands still.
  const motion = new Map();
  let firstSkinned = null;
  const findSkinned = (node) => {
    if (firstSkinned === null && node.isSkinnedMesh) firstSkinned = node;
  };
  const slide = (body, ground, span, height) => {
    const tracker = trackerOf(body.id, "sliding", body.name);
    let state = motion.get(body.id);
    if (state === undefined || state.object !== body.object) {
      firstSkinned = null;
      body.object.traverse(findSkinned);
      state = { object: body.object, skinned: firstSkinned, had: false, x: 0, z: 0 };
      Object.assign(state, { ground: null, gx: 0, gz: 0, pose: 0 });
      motion.set(body.id, state);
    }
    if (state.skinned === null) return cleared(tracker);
    const m = body.object.matrixWorld.elements;
    const g = ground === null ? null : ground.matrixWorld.elements;
    let pose = 0;
    const bones = state.skinned.skeleton.bones;
    for (let i = 0; i < bones.length; i += 1) {
      const q = bones[i].quaternion;
      pose += (q.x + 3 * q.y + 5 * q.z + 7 * q.w) * (1 + (i % 7));
    }
    if (state.had && g !== null && ground === state.ground) {
      const dx = m[12] - state.x - (g[12] - state.gx);
      const dz = m[14] - state.z - (g[14] - state.gz);
      const speed = Math.hypot(dx, dz) / span;
      const frozen = Math.abs(pose - state.pose) < 1e-6;
      const playing = animation(body.object);
      const idle = playing !== null && playing.state === "idle";
      if (speed > Math.max(LIMITS.slideMps, LIMITS.slideHeights * height) && (idle || frozen))
        held(tracker, span, idle ? (playing.clip ?? "idle") : null, speed, body.box);
      else cleared(tracker);
    } else cleared(tracker);
    state.had = true;
    state.x = m[12];
    state.z = m[14];
    state.ground = ground;
    state.gx = g === null ? 0 : g[12];
    state.gz = g === null ? 0 : g[14];
    state.pose = pose;
  };

  // The player: in front of the camera, not behind solids, and big enough to read.
  const look = (body, camera, span) => {
    const b = body.box;
    if (b.isEmpty()) {
      playerView.kind ??= "no-body";
      return;
    }
    // A camera inside the player's own box is a first-person view: nothing to see.
    if (b.containsPoint(cameraAt)) {
      playerView.kind ??= "first-person";
      return;
    }
    playerView.kind = "body";
    playerView.name = body.name;
    playerView.measured += span;
    if (!frustum.intersectsBox(b)) {
      playerView.offscreen += span;
      playerView.frame ??= capture(null, null);
      return;
    }
    const rect = rectOf(b, camera, canvas.clientWidth || 1, canvas.clientHeight || 1);
    if (rect !== null && heightCount < HEIGHTS) heights[heightCount++] = rect.h;
    if (rect !== null && rect.h < LIMITS.smallShare * (canvas.clientHeight || 1))
      playerView.smallFrame ??= capture(b, body.name);
    // Hidden: every ray from the camera to the player's middle, chest and knees stops at a solid.
    const height = b.max.y - b.min.y;
    let blockers = 0;
    let first = null;
    for (let k = 0; k < 3; k += 1) {
      point.set(
        (b.min.x + b.max.x) / 2,
        b.min.y + height * (k === 0 ? 0.5 : k === 1 ? 0.85 : 0.2),
        (b.min.z + b.max.z) / 2,
      );
      direction.subVectors(point, cameraAt);
      const distance = direction.length();
      if (distance < 1e-3) continue;
      raycaster.set(cameraAt, direction.divideScalar(distance));
      raycaster.near = 0;
      raycaster.far = Math.max(0, distance - height * 0.05);
      hits.length = 0;
      intersectSolids();
      const blocked = hits.length > 0;
      if (blocked) {
        blockers += 1;
        if (first === null) first = hits.sort(nearestFirst)[0].object;
      }
      hits.length = 0;
      // One clear line to the player is enough to see it.
      if (!blocked) break;
    }
    if (blockers === 3) {
      playerView.hidden += span;
      const name = nameOf(first);
      playerView.blockerSeconds.set(name, (playerView.blockerSeconds.get(name) ?? 0) + span);
      playerView.frame ??= capture(b, body.name);
    }
  };

  // The camera inside a closed solid draws its inside, or nothing.
  const cameraInside = (span, top, bottom) => {
    const tracker = trackerOf("camera", "camera", null, null);
    cast(cameraAt.x, cameraAt.z, top, bottom);
    if (insideAt(cameraAt.y, true)) held(tracker, span, nameOf(found.object), 1, null);
    else cleared(tracker);
  };

  // Things that were in the scene and shown, but never came into the camera's view.
  const sighting = (record) => {
    if (record.object === null || !SEEN_KINDS.has(record.kind)) return;
    let entry = unseen.get(record.id);
    if (entry?.seen === true) return;
    if (!attached(record.object, lookScene) || !shown(record.object)) return;
    if (entry === undefined) {
      entry = { name: record.name, seen: false };
      unseen.set(record.id, entry);
    }
    boundsOf(record.object, otherBox);
    if (!otherBox.isEmpty() && frustum.intersectsBox(otherBox)) entry.seen = true;
  };

  // ── The report ────────────────────────────────────────────────────────
  const read = () => {
    const findings = [];
    const used = new Set();
    const keep = (frame) => {
      if (frame !== null) used.add(frame);
      return frame;
    };
    const measuredOf = (body) =>
      body === null ? 0 : (trackers.get(`measured\0${body}`)?.seconds ?? 0);
    for (const tracker of trackers.values()) {
      if (tracker.kind === "measured" || tracker.at === null) continue;
      // NaN or Infinity positions are reported the moment they happen.
      const instant = tracker.kind === "fell" && tracker.amount === Infinity;
      if (!instant && tracker.longest < LIMITS.momentS - 1e-6) continue;
      const of = measuredOf(tracker.body) || played;
      findings.push({
        kind: tracker.kind,
        thing: tracker.thing,
        other: tracker.other,
        at: tracker.at,
        seconds: round(tracker.seconds, 1),
        share: of > 0 ? round(Math.min(1, tracker.seconds / of)) : 0,
        amount: Number.isFinite(tracker.amount) ? round(tracker.amount) : null,
        frame: keep(tracker.frame),
      });
    }
    findings.sort((a, b) => b.share - a.share);
    let player = null;
    if (playerView.kind === "body" && playerView.measured > 0) {
      const sorted = Array.from(heights.subarray(0, heightCount)).sort((a, b) => a - b);
      const heightPx = sorted.length === 0 ? null : round(sorted[sorted.length >> 1], 0);
      let blocker = null;
      let most = 0;
      for (const [name, seconds] of playerView.blockerSeconds)
        if (seconds > most) [blocker, most] = [name, seconds];
      const hidden = playerView.hidden / playerView.measured;
      const offscreen = playerView.offscreen / playerView.measured;
      const small = heightPx !== null && heightPx < LIMITS.smallShare * (canvas.clientHeight || 1);
      const unseenShare = hidden + offscreen;
      player = {
        kind: "body",
        name: playerView.name,
        seconds: round(playerView.measured, 1),
        hidden: round(hidden),
        offscreen: round(offscreen),
        blocker,
        heightPx,
        canvasHeight: canvas.clientHeight,
        notVisible: unseenShare > LIMITS.hiddenShare,
        small,
        frame: unseenShare > LIMITS.hiddenShare ? keep(playerView.frame) : null,
        smallFrame: small ? keep(playerView.smallFrame) : null,
      };
    } else player = { kind: playerView.kind ?? "none" };
    const never = [];
    for (const entry of unseen.values()) if (!entry.seen) never.push(entry.name);
    return {
      version: 1,
      seconds: round(played, 1),
      samples,
      cost: { meanMs: samples === 0 ? 0 : round(costMs / samples), worstMs: round(worstMs) },
      findings: findings.slice(0, LIMITS.findings),
      player,
      unseen: never.slice(0, LIMITS.unseen),
      unseenMore: Math.max(0, never.length - LIMITS.unseen),
      frames: frames
        .filter((frame) => used.has(frame.id))
        .map((frame) => ({ id: frame.id, png: frame.canvas.toDataURL("image/png") })),
    };
  };

  return {
    /** The harness starts a measured play: from here the shell looks at the scene. */
    start() {
      reset();
      active = true;
      return true;
    },
    /** What the play showed, with its frames as PNG data URLs; the looking goes on until stop. */
    read,
    stop() {
      active = false;
    },
    /**
     * After each frame's draw, with the game time it moved and whether a frame was drawn
     * (its pixels are still the canvas's then). Nothing at all unless started.
     */
    tick(dt, drew) {
      if (!active || dt <= 0 || GameState.state !== "playing") return;
      played += dt;
      clock += dt;
      if (clock < 1 / LIMITS.hz || !drew) return;
      const span = clock;
      clock = 0;
      const from = performance.now();
      sample(span);
      const ms = performance.now() - from;
      costMs += ms;
      worstMs = Math.max(worstMs, ms);
    },
  };
}
