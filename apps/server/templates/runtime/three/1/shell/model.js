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
//   M.paintOf("wall"); M.role("leaf"); // a role of the game's look (STYLE.json): its material, its
//     // colour. M.lock() is the lock: { palette, roles, shape: { edges, bevel, chunky, detail },
//     // finish, surfaces }. Colour by role so what you build sits with what Blender makes.
//   M.paintOf("#fff", { kind: "paint", map: M.canvasTexture(512, 64, (g, w, h) => {...}) });
//     // a texture drawn with the 2D canvas API: windows, panel lines, names, decals
//   const boat = new THREE.Group();
//   boat.add(M.part(M.box(6, 1.2, 2.2, 0.25), paint.hull, { at: [0, 0.6, 0] })); // bevelled box
//   boat.add(M.part(M.lathe([[0, 0], [0.3, 0.1], [0.2, 1.4]]), paint.trim, { at: [1, 1.2, 0] }));
//     // a profile of [radius, y] spun round y: masts, bottles, domes, towers, trunks
//   M.extrude([[0, 0], [2, 0], [0, 3]], 0.05, { bevel: 0.02 }); // a flat [x, y] shape given depth
//   M.tube([[0, 1, 0], [1, 2, 0], [2, 1.5, 1]], 0.04);       // ropes, pipes
//   M.rail([[-3, 1.2, 1], [2, 1.2, 1]], { height: 1 });       // posts and bars in one geometry
//
// Curve-led: draw the silhouette once as curves (side profile, then plan), and build every part
// from them, so the lines stay fair and the parts agree:
//   const sheer = M.curve([[-20, 3.4], [8, 3.9], [21, 5.6]]); // a smooth y over x: sheer(12)
//   const keel = M.curve([[-20, 1], [-15, 0], [12, 0.6], [21, 5.5]]); // meets the sheer: a raked stem
//   const half = M.curve([[-20, 3.6], [4, 4.1], [18, 1.8], [21, 0]]);
//   const hull = M.loft({ from: -20, to: 21, half, top: sheer, bottom: keel }, { flat: 0.9, keel: 0.7 });
//     // a body along x from three curves (or sections [[x, half, height, bottom]...]); keel: V underside
//   const deck = M.mirrored([[-19, 3.4], [6, 3.8], [15, 2.4], [20, 0.3]]); // a plan from one side
//   const house = deck.inset(0.8).cut(-15, 8);         // a closed plan [x, z]: M.outline(points)
//   const top = house.inset(0.2).cut(-15, 6.5);        // the same plan, smaller: the front steps back
//   M.wall(house, 4, top, 6.6);                        // the sides between two plans: curve and taper
//   M.wall(M.blend(house, top, 0.3), 4.8, M.blend(house, top, 0.75), 6); // a band that follows them
//   house.inset(-0.5).slab(6.6, 6.85, { bevel: 0.05 }); // an overhanging roof; plan.band(y0, y1) a strip
//   M.rail(house.inset(-0.35).edge(6.85));             // a rail tracing that roof's edge
//   const merged = M.merge(boat); // one mesh per material: build in parts, draw in few
//   M.stats(merged);              // { triangles, drawCalls, size: [x, y, z] in metres }
//   M.scatter(M.merge(tree), 400, (i, rand) => ({ at: [x, 0, z], turn, scale }), 7);
//     // repeats as instances, one draw per material, seeded; M.seeded(7) gives 0..1 numbers
//   const land = M.ground({ size: 160, height: (x, z) => 2 * Math.sin(x / 19),
//     paths: [[[-30, 4], [0, 0], [22, -9]]], pathWidth: 2.4 });
//     // the ground, in the look's roles: grass in two tones, soil where it is steep, worn
//     // paths. land.height(x, z) is the ground under a foot; scatter tufts and stones on it.
//
// A model whose numbers the person tunes on the Stage, rebuilt whenever one changes (also while
// the Stage has play frozen), and named so they can select it:
//   const boat = M.tuned(ctx, "Patrol boat", { length: 7, beam: 2.4, seed: 1 },
//     { length: [4, 12, 0.25, "m"], beam: [1.5, 4, 0.1, "m"], seed: [1, 99, 1] },
//     (p) => M.merge(buildBoat(p, M.seeded(p.seed))), { kind: "character" });
//   ctx.scene.add(boat); // a Group; move and turn it, its insides are rebuilt in place
//
// A character in code, on the standard humanoid skeleton the animation library's clips play on
// (ASSETS names the library's clip file: game_assets op add quaternius-universal-animation-library
// with Unreal-Godot/UAL1_Standard.glb, allowed with the library off). Parts are placed in the
// body's own metres, feet at y 0, facing +z, at the skeleton's rest pose; each rides one bone.
//   const body = M.rig(ctx.assets.model("rig"));  // the clips' copy, its mannequin taken off
//   body.joint("hand_r");                          // a joint's rest position (Vector3, body metres)
//   body.limb("thigh_l", "calf_l", 0.09, paint.cloth, { end: 0.07 }); // a capsule along a bone
//   body.part(geometry, paint.skin, { at: [0, 1.62, 0.02] }); // nearest bone, or { bone: "Head" }
//   body.part(swordGeometry, paint.metal, { at: [...], bone: "hand_r", rigid: true }); // never bends
//   const hero = animate(body.done());             // skinned to the bones by distance, bending at
//     // the joints, one draw per material; done({ skin: "rigid" }) hangs each part on its bone
//   // body.bones lists the bone names; hero.play("run") plays the library's clips on it.
//
// Name every model's root before you merge or scatter it (`cabin.name = "Cabin"`). Named parts
// are what the person can pick, see in Art and ask about: an island's cabin, dock and trees.
// Models face +z, like the library's, so face the move with rotation.y = Math.atan2(dir.x, dir.z).
// Look at each one alone with game_play op model_sheet before building the game around it.
import * as THREE from "../vendor/three.module.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Shared materials last a run: the shell disposes a run's scene, materials included, so the
// next run makes its own instead of reusing disposed ones.
let paints = new Map();
// Tuned models by Stage id, rebuilt when the Stage changes one of their values.
let tunedModels = new Map();

// The game's look: STYLE.json as Kurambit serves it beside the runtime (and writes it into an
// export), read once before the game's own module runs. Its roles always hold the defaults.
const look = await fetch(new URL("../../../../look.json", import.meta.url), { cache: "no-store" })
  .then((response) => (response.ok ? response.json() : null))
  .catch(() => null);

/** The game's look, or null for a game served without one: see the header. */
export const lock = () => look;

/** A role's colour ("#rrggbb"): the lock's, so made things share one palette. */
export function role(name) {
  const hex = look?.roles?.[name];
  if (hex === undefined)
    throw new Error(`No role "${name}" in the look: ${Object.keys(look?.roles ?? {}).join(", ")}`);
  return hex;
}

const colour = (value) =>
  new THREE.Color(
    typeof value === "string" && look?.roles?.[value] !== undefined ? look.roles[value] : value,
  );

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
  // A soft-edged look shades everything smooth; otherwise matte and stone show their facets.
  const smooth =
    o.smooth ??
    (look?.shape?.edges === "soft" ||
      (o.kind !== undefined && o.kind !== "matte" && o.kind !== "stone"));
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
    // The cache key is no name a person reads: a palette names the material (palette()).
    material.userData.kurambitKey = key;
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
  for (const [name, entry] of Object.entries(colours)) {
    named[name] = Array.isArray(entry) ? paintOf(entry[0], entry[1]) : paintOf(entry);
    // The name a person reads for it (Art's materials): the first palette's to name it.
    if (named[name].name === "") named[name].name = name;
  }
  return named;
}

/** A box with its edges rounded by `radius` (the look's bevel by default; bevelled with `segments` 1). */
export function box(width, height, depth, radius = look?.shape?.bevel ?? 0, segments = 2) {
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

// ── Curves: draw a line once, build from it ───────────────────────────
// A silhouette is a few curves: a side profile (sheer, keel, roof line) and a plan. Each is drawn
// once from a handful of points and then reused for every part that follows it, so lines stay
// fair and the parts agree.

/**
 * A smooth curve through [x, y] points, read as y at any x (monotone cubic: no overshoot between
 * points, flat beyond the ends). `sheer(12)` is the curve's height at x 12.
 */
export function curve(points) {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  const n = p.length;
  if (n === 1) return () => p[0][1];
  const d = [];
  const m = Array.from({ length: n }, () => 0);
  for (let i = 0; i < n - 1; i += 1)
    d.push((p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0] || 1e-9));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i += 1) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  // Fritsch-Carlson: tangents limited so the curve never swings past its points.
  for (let i = 0; i < n - 1; i += 1) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i],
      b = m[i + 1] / d[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      m[i] = (3 * a * d[i]) / h;
      m[i + 1] = (3 * b * d[i]) / h;
    }
  }
  return (x) => {
    if (x <= p[0][0]) return p[0][1];
    if (x >= p[n - 1][0]) return p[n - 1][1];
    let i = 0;
    while (x > p[i + 1][0]) i += 1;
    const span = p[i + 1][0] - p[i][0];
    const t = (x - p[i][0]) / span;
    const t2 = t * t,
      t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * p[i][1] +
      (t3 - 2 * t2 + t) * span * m[i] +
      (-2 * t3 + 3 * t2) * p[i + 1][1] +
      (t3 - t2) * span * m[i + 1]
    );
  };
}

const PLAN_POINTS = 96;

/** Points round a closed loop, resampled to `count` evenly spaced along its length. */
const resample = (loop, count) => {
  const lengths = [0];
  for (let i = 1; i <= loop.length; i += 1) {
    const a = loop[i - 1],
      b = loop[i % loop.length];
    lengths.push(lengths[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = lengths.at(-1);
  const out = [];
  let j = 0;
  for (let k = 0; k < count; k += 1) {
    const at = (k / count) * total;
    while (lengths[j + 1] < at) j += 1;
    const a = loop[j],
      b = loop[(j + 1) % loop.length];
    const t = (at - lengths[j]) / (lengths[j + 1] - lengths[j] || 1);
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
};

/**
 * A closed plan in the ground plane: [x, z] points round it (smoothed through them unless
 * `sharp`), resampled evenly. Every plan built from it (inset, blend) keeps the same number of
 * points, so any two can be joined by a wall.
 *   plan.inset(0.8)          the outline 0.8 m inside (negative: outside)
 *   plan.cut(x0, x1)          only the part between x0 and x1 (a deck that stops short)
 *   plan.slab(y0, y1, { bevel })   a flat solid on it: a deck, a roof, a floor
 *   plan.band(y0, y1, { out })     a strip round its edge: window bands, a rubbing strake, a sign
 *   plan.edge(y)              its edge at height y as [x, y, z] points: rail(plan.edge(y)) traces it
 */
export function outline(points, { sharp = false, count = PLAN_POINTS } = {}) {
  let loop = points;
  if (!sharp) {
    const curve = new THREE.CatmullRomCurve3(
      points.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      true,
      "centripetal",
    );
    loop = curve
      .getPoints(count * 2)
      .slice(0, -1)
      .map((v) => [v.x, v.z]);
  }
  return planOf(resample(loop, count));
}

/**
 * A plan symmetric about the x axis from one side's [x, half-width] points, stern to bow (or back
 * to front): hulls, fuselages, decks, cars seen from above. A half-width of 0 is a point (a bow).
 */
export function mirrored(side, { count = PLAN_POINTS } = {}) {
  // Each side is the curve through its points (no bulge past them), sampled closer toward the
  // ends where the line turns fastest; the back is closed straight across, like a transom.
  const half = curve(side);
  const xs = side.map(([x]) => x);
  const from = Math.min(...xs),
    to = Math.max(...xs);
  const steps = Math.max(8, Math.floor(count / 2));
  const right = [];
  for (let i = 0; i <= steps; i += 1) {
    const x = from + ((to - from) * (1 - Math.cos((i / steps) * Math.PI))) / 2;
    right.push([x, Math.max(half(x), 0)]);
  }
  const left = right
    .toReversed()
    .filter(([, w]) => w > 1e-4)
    .map(([x, w]) => [x, -w]);
  return outline([...right, ...left], { sharp: true, count });
}

function planOf(pts) {
  const count = pts.length;
  // Outward normals of a counter-clockwise or clockwise loop alike: the sign of its area says.
  let area = 0;
  for (let i = 0; i < count; i += 1) {
    const a = pts[i],
      b = pts[(i + 1) % count];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const turn = area > 0 ? 1 : -1;
  const edgeNormal = (a, b) => {
    const tx = b[0] - a[0],
      tz = b[1] - a[1];
    const l = Math.hypot(tx, tz) || 1;
    return [(turn * tz) / l, (-turn * tx) / l];
  };
  // Each point moves along the bisector of its two edges, lengthened so both edges move the
  // full distance (a mitre), but never more than three times it at a needle-sharp point.
  // A cut plan holds runs of points clamped onto one spot: each point's edges run to its nearest
  // distinct neighbours, or a zero-length edge would throw it out by the mitre's limit.
  const distinct = (i, step) => {
    for (let k = 1; k < count; k += 1) {
      const q = pts[(i + step * k + count * k) % count];
      if (Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]) > 1e-6) return q;
    }
    return pts[i];
  };
  const normals = pts.map((p, i) => {
    const e0 = edgeNormal(distinct(i, -1), p);
    const e1 = edgeNormal(p, distinct(i, 1));
    let nx = e0[0] + e1[0],
      nz = e0[1] + e1[1];
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    const scale = 1 / Math.max(nx * e0[0] + nz * e0[1], 1 / 3);
    return [nx * scale, nz * scale];
  });
  const plan = {
    points: pts,
    inset: (d) => planOf(pts.map((p, i) => [p[0] - normals[i][0] * d, p[1] - normals[i][1] * d])),
    shift: (dx, dz = 0) => planOf(pts.map(([x, z]) => [x + dx, z + dz])),
    scale: (sx, sz = sx) => planOf(pts.map(([x, z]) => [x * sx, z * sz])),
    cut(x0, x1) {
      // Clamped onto the cut's ends, so the point count and order stay.
      return planOf(pts.map(([x, z]) => [Math.min(Math.max(x, x0), x1), z]));
    },
    edge: (y) => [...pts, pts[0]].map(([x, z]) => [x, y, z]),
    slab(y0, y1, { bevel = 0 } = {}) {
      const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
      const depth = Math.max(y1 - y0 - bevel * 2, 0.001);
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: bevel > 0,
        bevelThickness: bevel,
        bevelSize: bevel,
        bevelSegments: bevel > 0 ? 2 : 0,
        curveSegments: 1,
      });
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, y0 + bevel, 0);
      return geometry;
    },
    band(y0, y1, { out = 0.02 } = {}) {
      const edge = plan.inset(-out);
      return wall(edge, y0, edge, y1);
    },
  };
  return plan;
}

/** The plan `t` of the way from `a` to `b` (0 is a, 1 is b): a wall's outline at a height. */
export function blend(a, b, t) {
  return planOf(
    a.points.map(([x, z], i) => [x + (b.points[i][0] - x) * t, z + (b.points[i][1] - z) * t]),
  );
}

/**
 * The side of a solid from plan `lower` at y0 to plan `upper` at y1: a deckhouse whose front
 * curves and tapers, a tower that leans, a hull's flare. Cap it with each plan's slab.
 */
export function wall(lower, y0, upper, y1) {
  const a = lower.points,
    b = upper.points;
  const count = a.length;
  const positions = [];
  const uvs = [];
  let run = 0;
  for (let i = 0; i <= count; i += 1) {
    const p = a[i % count],
      q = b[i % count];
    if (i > 0) run += Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]);
    positions.push(p[0], y0, p[1], q[0], y1, q[1]);
    uvs.push(run, 0, run, 1);
  }
  const index = [];
  for (let i = 0; i < count; i += 1) {
    const k = i * 2;
    index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  // u runs in metres round the wall, so a texture repeats at its own scale: window bays.
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  // Faces outward whichever way the loop runs: its signed area says which way that is.
  let area = 0;
  for (let i = 0; i < count; i += 1) {
    const p = a[i],
      q = a[(i + 1) % count];
    area += p[0] * q[1] - q[0] * p[1];
  }
  if (area > 0)
    for (let i = 0; i < index.length; i += 3)
      [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A body lofted through cross-sections along x: each [x, halfWidth, height] (optionally a 4th,
 * the section's bottom y, default 0), each an ellipse-ish rounded section of `sides` points
 * (`flat` 0..1 squares it off, `keel` 0..1 draws its lower half to a V), capped at both ends.
 * Hulls, fuselages, bodies, fish.
 */
export function loft(sections, { sides = 12, flat = 0.4, keel = 0, steps = 40 } = {}) {
  // The curve form: { from, to, half(x), top(x), bottom(x) } (functions, curve() for one).
  if (!Array.isArray(sections)) {
    const { from, to, half, top, bottom = () => 0 } = sections;
    const list = [];
    for (let i = 0; i <= steps; i += 1) {
      // Closer together toward the ends, where a bow or a nose turns fastest.
      const t = (1 - Math.cos((i / steps) * Math.PI)) / 2;
      const x = from + (to - from) * t;
      const b = bottom(x);
      list.push([x, Math.max(half(x), 0.001), Math.max(top(x) - b, 0.001), b]);
    }
    sections = list;
  }
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

/** Smooth noise in -1..1 over the plane, the same for the same seed: three octaves of value noise. */
function fieldNoise(seed) {
  const hash = (x, z) => {
    const h = Math.sin(x * 127.1 + z * 311.7 + seed * 74.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const value = (x, z) => {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const u = smooth(x - x0);
    const v = smooth(z - z0);
    const a = hash(x0, z0) * (1 - u) + hash(x0 + 1, z0) * u;
    const b = hash(x0, z0 + 1) * (1 - u) + hash(x0 + 1, z0 + 1) * u;
    return a * (1 - v) + b * v;
  };
  return (x, z) =>
    (value(x, z) * 0.57 + value(x * 2.1, z * 2.1) * 0.29 + value(x * 4.3, z * 4.3) * 0.14) * 2 - 1;
}

/**
 * The ground a game stands on, built in code because the game needs its height under every foot:
 * `height(x, z)` (flat without one) over a square of `size` metres in `step`-metre cells. It is
 * coloured per vertex by the look's roles: `grass` and `grass2` in broad patches, `soil` where it
 * is steeper than `steep` (rise over run), and `path` along each of `paths` (lists of [x, z]),
 * `pathWidth` metres wide with a ragged edge. Returns the mesh, named Ground, which receives
 * shadows; `mesh.height(x, z)` is the ground under a point.
 */
export function ground({
  size = 120,
  step = 1.5,
  height = () => 0,
  paths = [],
  pathWidth = 2.2,
  steep = 0.55,
  patch = 14,
  seed = 1,
  colours = {},
} = {}) {
  const cells = Math.max(2, Math.min(256, Math.round(size / step)));
  const geometry = new THREE.PlaneGeometry(size, size, cells, cells).rotateX(-Math.PI / 2);
  const position = geometry.attributes.position;
  const tone = Object.fromEntries(
    ["grass", "grass2", "soil", "path"].map((name) => [name, colour(colours[name] ?? name)]),
  );
  const noise = fieldNoise(seed);
  const segments = paths.flatMap((points) => points.slice(1).map((to, i) => [points[i], to]));
  const toPath = (x, z) => {
    let nearest = Infinity;
    for (const [[ax, az], [bx, bz]] of segments) {
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(
        0,
        Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)),
      );
      nearest = Math.min(nearest, Math.hypot(x - ax - dx * t, z - az - dz * t));
    }
    return nearest;
  };
  const colours3 = new Float32Array(position.count * 3);
  const mixed = new THREE.Color();
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    position.setY(i, height(x, z));
    const slope = Math.hypot(
      height(x + 0.5, z) - height(x - 0.5, z),
      height(x, z + 0.5) - height(x, z - 0.5),
    );
    const patches = Math.min(1, Math.max(0, 0.5 + noise(x / patch, z / patch) * 1.4));
    mixed.copy(tone.grass).lerp(tone.grass2, patches);
    mixed.lerp(tone.soil, Math.min(1, Math.max(0, (slope - steep) / 0.25)));
    const edge = pathWidth / 2 + noise(x / 2.3 + 40, z / 2.3) * pathWidth * 0.3;
    mixed.lerp(
      tone.path,
      Math.min(1, Math.max(0, (edge - toPath(x, z)) / (pathWidth * 0.35) + 0.5)),
    );
    colours3[i * 3] = mixed.r;
    colours3[i * 3 + 1] = mixed.g;
    colours3[i * 3 + 2] = mixed.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colours3, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      flatShading: look?.shape?.edges === "faceted",
    }),
  );
  mesh.material.name = "Ground";
  mesh.name = "Ground";
  mesh.receiveShadow = true;
  mesh.height = height;
  return mesh;
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
