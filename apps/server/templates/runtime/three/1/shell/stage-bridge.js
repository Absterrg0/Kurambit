// The Stage bridge: the Kurambit Stage that frames this page freezes play,
// points at things, tunes their values live and sees where a thing has been.
// The messages are packages/contracts/src/gameStageBridge.ts in the Kurambit
// repository; each one is checked here and what does not fit is ignored.
//
// Nothing here costs a frame until the Stage first asks: a page opened on its
// own, the harness's plays and their recordings never send a message, so they
// never trace, outline or post. Registering things and reading tuned values
// is a Map write at the time the game makes them, never per frame.
//
//   ctx.thing(object, { name: "Cat", kind: "character" }) // a thing people can select
//   ctx.thing(null, { name: "Rules", kind: "rule" })      // one with no body
//   const cat = ctx.tune("Cat", { jump: 8, lives: 3, look: 0 },
//     { jump: [2, 20, 0.5, "m"], lives: [1, 9, 1], look: ["Tabby", "Ginger", "Ghost"] });
//   // read cat.jump every frame: the Stage's sliders change it live and save it
//   // to tune.json as they are let go; this file loads it at boot.
import * as THREE from "../vendor/three.module.js";

const BRIDGE = 1;
const CAPABILITIES = [
  "freeze",
  "select",
  "tune",
  "trace",
  "speed",
  "mute",
  "controls",
  "cannot-lose",
  "dev",
  "runs",
  "rewind",
  "portrait",
];
const KINDS = new Set([
  "character",
  "creature",
  "prop",
  "level",
  "effect",
  "ui",
  "rule",
  "sound",
  "other",
]);
const MAX_THINGS = 200;
// Copies a game spawns past this many stop registering (the Stage lists 200).
const MAX_REGISTERED = 500;
const MAX_VALUES = 64;
const TRACE_HZ = 30;
const TRACE_POINTS = TRACE_HZ * 10;
// Feel: the speed trace's points, the jumps kept, and what counts as one (world units, seconds).
const FEEL_MIN_SAMPLES = 10;
const FEEL_SPEEDS = 60;
const FEEL_JUMPS = 3;
const JUMP_RISE = 0.6;
const JUMP_MIN_HEIGHT = 0.15;
const JUMP_MIN_SECONDS = 0.15;
// The game folder's engine directory: ids and asset paths are game-relative.
const LANE = "web/";
const THINGS_EVERY_MS = 500;
const HOVER = new THREE.Color(0xffffff);
const SELECTED = new THREE.Color(0xe2582a);
// A thing's kind as its name tag says it.
const KIND_WORDS = {
  character: "character",
  creature: "creature",
  prop: "prop",
  level: "level",
  effect: "effect",
  ui: "interface",
  rule: "rule",
  sound: "sound",
  other: "thing",
};

const framed = window.parent !== window;
const toStage = (message) => {
  if (framed) window.parent.postMessage(message, "*");
};
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;
const tenth = (value) => Math.round(value * 10) / 10;
const humanName = (key) => {
  const words = String(key)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

// An ASSETS model's own look, by its asset path: a scale and a tint over its colours, tuned on the
// Stage or in the Workbench's Art tab like any value and kept in tune.json, so a change is a
// build. At their defaults nothing of the model is touched.
const ASSET_LOOK = { scale: 1, tint: 0xffffff };
const ASSET_LOOK_RANGES = {
  scale: { min: 0.1, max: 10, step: 0.05, unit: "×" },
  tint: { min: 0, max: 0xffffff, step: 1, label: "Tint", colour: true },
};
/**
 * Scales a copy's insides about its origin, so the game's own scale of the copy multiplies it,
 * and multiplies its materials' colours (shared by every copy of the model) by the tint.
 */
const applyAssetLook = (copy, look) => {
  const before = copy.userData.kurambitScale ?? 1;
  const scale = Number.isFinite(look.scale) && look.scale > 0 ? look.scale : 1;
  if (scale !== before) {
    for (const child of copy.children) {
      child.position.multiplyScalar(scale / before);
      child.scale.multiplyScalar(scale / before);
    }
    copy.userData.kurambitScale = scale;
  }
  const tint = Number.isFinite(look.tint) ? look.tint : 0xffffff;
  copy.traverse((node) => {
    for (const material of [node.material ?? []].flat()) {
      if (material.color === undefined) continue;
      // Its own colour, as a number, so a material the game clones keeps it readable.
      if (material.userData.kurambitColor === undefined) {
        if (tint === 0xffffff) continue;
        material.userData.kurambitColor = material.color.getHex();
      }
      material.color.setHex(material.userData.kurambitColor).multiply(TINT.setHex(tint));
    }
  });
};
const TINT = new THREE.Color();

// Tuned values outlive runs: a Retry keeps what the person set on the Stage.
let saved = {};
const tunes = new Map();
// A replay's run starts from the values its play tuned, as they were when it began (presetTunes).
let preset = {};

/** Reads web/tune.json once at boot; a missing or broken file tunes nothing. */
export async function loadTuning(url = "./tune.json") {
  try {
    const response = await fetch(url, { cache: "no-store" });
    const file = response.ok ? await response.json() : {};
    saved = file !== null && typeof file === "object" && !Array.isArray(file) ? file : {};
  } catch {
    saved = {};
  }
}

// A range is [min, max, step, unit], or names to pick one of ("Dusk", "Snow"): the value is the
// picked one's index, so code reading a number keeps working.
const rangeOf = (range) => {
  const spec = Array.isArray(range)
    ? range.length > 0 && range.every((each) => typeof each === "string")
      ? { choices: range }
      : { min: range[0], max: range[1], step: range[2], unit: range[3] }
    : range !== null && typeof range === "object"
      ? { ...range }
      : {};
  const choices = Array.isArray(spec.choices)
    ? spec.choices.filter((each) => text(each, 40)).slice(0, 24)
    : [];
  if (choices.length > 1) return { ...spec, choices, min: 0, max: choices.length - 1, step: 1 };
  delete spec.choices;
  return spec;
};
// A tuned number stays inside the range the game gave it.
const clamp = (value, range) => {
  let next = value;
  if (finite(range.min)) next = Math.max(range.min, next);
  if (finite(range.max)) next = Math.min(range.max, next);
  return next;
};
const fits = (value, fallback) =>
  typeof fallback === "boolean" ? typeof value === "boolean" : finite(fallback) && finite(value);
/** A run's play as the Stage sends it back (packages/contracts gamePlays.ts), in outline. */
const isPlay = (play) =>
  play?.version === 1 &&
  Number.isInteger(play.seed) &&
  finite(play.dt) &&
  play.dt > 0 &&
  play.dt <= 1 / 30 &&
  Number.isInteger(play.steps) &&
  Array.isArray(play.inputs) &&
  Array.isArray(play.events) &&
  Array.isArray(play.marks);

/**
 * The Stage end of the bridge. The shell passes how to reach the run: `view()`
 * is the scene and camera on screen (or null), `freeze(on)` holds play and
 * sound, `redraw()` asks for one frame, `drawClean()` draws one frame with no
 * outline (for a capture), `speed(scale)` sets how fast play runs, `mute(on)`
 * silences the game, `controls` lists, rebinds and resets the game's actions as
 * its own Controls screen does, saved with its settings, `canLose(on)`
 * lets a loss end the run or not (the Stage's "Can't lose" while tuning), and
 * `tuned(id, key, value)` hears each value the Stage changed (a run's play keeps it),
 * `runSoFar()` is the run in play so far as a play (or null),
 * `dev` takes the Stage's dev views (shell/dev-view.js) and a frozen run's one-frame step, and
 * `rewind` takes the run so far, replays a play to a moment and hands it over, or starts afresh,
 * and `drawFrom(camera)` draws one frame as play draws it, from another camera (a portrait).
 */
export function createStageBridge({
  canvas,
  renderer,
  view,
  freeze,
  redraw,
  drawClean,
  speed,
  mute,
  controls,
  canLose,
  tuned,
  runSoFar,
  dev,
  rewind,
  drawFrom,
}) {
  let active = false;
  let frozen = false;
  let hovered = null;
  let selected = null;
  // One instance of the selected thing (a clump of its grass, a tree of its forest), picked by
  // a double click, as a design tool goes into a group; null is the whole thing.
  let selectedIndex = null;
  let changed = false;
  let postedAt = 0;
  let traceClock = 0;
  const things = new Map();
  const byObject = new Map();
  // Asset paths whose look values are tuned, and this run's copies of each.
  const lookIds = new Set();
  const lookCopies = new Map();
  const named = new Map();

  // One thing: { id, name, kind, object, asset, auto, placeholder, ring, head, count }.
  // A taken id gets the next free number: "Slime 2", "web/assets/slime.glb#2".
  const unique = (base, separator) => {
    let n = named.get(base) ?? 1;
    let id = base;
    while (things.has(id)) {
      n += 1;
      id = `${base}${separator}${n}`;
    }
    named.set(base, n);
    return { id, n: id === base ? null : n };
  };
  // Where each id first came, so a thing the game names again (a tuned name's model loading
  // at play) keeps its place in the Stage's lists instead of moving to the end.
  const firstSeen = new Map();
  let seen = 0;
  const add = (record) => {
    if (things.size >= MAX_REGISTERED) return null;
    if (!firstSeen.has(record.id)) {
      if (firstSeen.size >= MAX_REGISTERED * 4)
        for (const id of firstSeen.keys()) if (!things.has(id)) firstSeen.delete(id);
      firstSeen.set(record.id, seen++);
    }
    things.set(record.id, { ring: null, head: 0, count: 0, ...record });
    for (const body of bodiesOf(record)) byObject.set(body, things.get(record.id));
    changed = true;
    return record;
  };
  // A thing is one object, or (`parts`) the several meshes one model was drawn as: a tree
  // instanced as a trunk mesh and a leaves mesh is one tree.
  const bodiesOf = (record) =>
    record.parts !== undefined ? record.parts : record.object === null ? [] : [record.object];
  // ctx.tune names a thing before (or without) ctx.thing; the game's own naming takes its place.
  const placeholder = (id) => ({
    id,
    name: id,
    kind: "rule",
    object: null,
    auto: false,
    placeholder: true,
  });

  /** ctx.thing: names an object (or null for a thing with no body) for the Stage. */
  const thing = (object, options = {}) => {
    const body = object?.isObject3D === true ? object : null;
    const earlier = body === null ? undefined : byObject.get(body);
    // A body with no kind is what its ctx.thing call implies: something with a skeleton is a
    // character, any other body a prop; one with no body is a rule.
    const kind = KINDS.has(options.kind)
      ? options.kind
      : (earlier?.kind ?? (body === null ? "rule" : skinned(body) ? "character" : "prop"));
    // Only a name the game gave is listed: its own option, or the object's own name.
    const name = text(options.name, 120)
      ? options.name
      : (earlier?.name ?? (meaningful(body?.name) ? humanName(body.name) : null));
    if (name === null) return object;
    const wanted = text(options.id, 200) ? options.id : name;
    // Named again with nothing new (a game calling it every frame): nothing changes.
    if (earlier !== undefined && !earlier.auto && earlier.id === wanted && earlier.kind === kind)
      return object;
    if (earlier !== undefined) {
      things.delete(earlier.id);
      byObject.delete(body);
    }
    if (things.get(wanted)?.placeholder === true) things.delete(wanted);
    const { id, n } = unique(wanted, " ");
    add({
      id,
      name: n === null ? name : `${name} ${n}`,
      kind,
      object: body,
      asset: earlier?.asset,
      auto: false,
    });
    return object;
  };

  /** A copy of an ASSETS model: registered with its path and sidecar, so old code needs nothing. */
  const assetCopy = (copy, name, source) => {
    if (source === undefined || byObject.has(copy)) return;
    const path = `${LANE}${source.path}`;
    const label = humanName(name);
    const asset = {
      path,
      ...(source.sidecar === undefined ? {} : { sidecar: `${LANE}${source.sidecar}` }),
    };
    // ctx.tune("Fox") before ASSETS.fox's copy: the copy is that thing, values and all.
    if (things.get(label)?.placeholder === true) {
      things.delete(label);
      add({ id: label, name: label, kind: source.kind, object: copy, asset, auto: false });
    } else {
      const { id, n } = unique(path, "#");
      add({
        id,
        name: n === null ? label : `${label} ${n}`,
        kind: source.kind,
        object: copy,
        asset,
        auto: true,
      });
    }
    lookIds.add(path);
    const look = tune(path, ASSET_LOOK, ASSET_LOOK_RANGES);
    let copies = lookCopies.get(path);
    if (copies === undefined) lookCopies.set(path, (copies = new Set()));
    copies.add(copy);
    applyAssetLook(copy, look);
  };

  /** ctx.tune: the live values of one thing, from tune.json over the game's defaults. */
  const tune = (id, defaults = {}, ranges = {}) => {
    const key = String(id);
    let entry = tunes.get(key);
    if (entry === undefined) {
      entry = { live: {}, defaults: {}, ranges: {}, labels: {} };
      tunes.set(key, entry);
    }
    const file = saved[key] !== null && typeof saved[key] === "object" ? saved[key] : {};
    for (const [name, fallback] of Object.entries(defaults ?? {})) {
      if (Object.keys(entry.defaults).length >= MAX_VALUES && !(name in entry.defaults)) break;
      if (!fits(fallback, fallback)) continue;
      const range = rangeOf(ranges?.[name]);
      entry.ranges[name] = range;
      if (text(range.label, 80)) entry.labels[name] = range.label;
      const first = !(name in entry.defaults);
      entry.defaults[name] = fallback;
      if (first) {
        const start = fits(preset[key]?.[name], fallback)
          ? preset[key][name]
          : fits(file[name], fallback)
            ? file[name]
            : fallback;
        entry.live[name] = typeof start === "number" ? clamp(start, range) : start;
      }
    }
    if (!things.has(key) && !lookIds.has(key)) {
      // ctx.tune("Fox") names ASSETS.fox's copy when the game never called ctx.thing: the
      // values belong on the Fox a person clicks, keyed by the id tune.json is read by.
      let copy;
      for (const record of things.values())
        if (record.auto && record.name === key) {
          copy = record;
          break;
        }
      if (copy === undefined) add(placeholder(key));
      else {
        things.delete(copy.id);
        if (selected === copy) {
          selected = null;
          selectedIndex = null;
        }
        if (hovered === copy) hovered = null;
        add({ ...copy, id: key, auto: false });
      }
    }
    changed = true;
    return entry.live;
  };

  const valuesOf = (id) => {
    const entry = tunes.get(id);
    if (entry === undefined) return undefined;
    return Object.keys(entry.defaults).map((key) => {
      const range = entry.ranges[key];
      return {
        key,
        value: entry.live[key],
        default: entry.defaults[key],
        ...(finite(range.min) ? { min: range.min } : {}),
        ...(finite(range.max) ? { max: range.max } : {}),
        ...(finite(range.step) && range.step > 0 ? { step: range.step } : {}),
        ...(entry.labels[key] === undefined ? {} : { label: entry.labels[key] }),
        ...(range.choices === undefined ? {} : { choices: range.choices }),
        ...(text(range.unit, 12) ? { unit: range.unit } : {}),
        ...(range.colour === true ? { colour: true } : {}),
      };
    });
  };

  // Screen maths, with no allocation per call.
  const at = new THREE.Vector3();
  const box = new THREE.Box3();
  const partBox = new THREE.Box3();
  const size = () => {
    const rect = canvas.getBoundingClientRect();
    return { w: rect.width, h: rect.height };
  };
  const attached = (object, scene) => {
    let node = object;
    while (node.parent !== null) node = node.parent;
    return node === scene;
  };
  const shown = (object) => {
    for (let node = object; node !== null; node = node.parent) if (!node.visible) return false;
    return true;
  };
  const onScreen = (record, seen) => {
    if (record.object === null || seen === null) return false;
    if (!attached(record.object, seen.scene) || !shown(record.object)) return false;
    at.setFromMatrixPosition(record.object.matrixWorld).project(seen.camera);
    return Math.abs(at.x) <= 1 && Math.abs(at.y) <= 1 && Math.abs(at.z) <= 1;
  };
  const rectOf = (record, seen) => {
    if (record?.object == null || seen === null || !attached(record.object, seen.scene))
      return undefined;
    // Precise: a skinned character's cached bounds are its bind pose, which can sit far from
    // where it stands. Only selection and hover ask, never a frame.
    box.makeEmpty();
    for (const body of bodiesOf(record)) box.union(partBox.setFromObject(body, true));
    if (box.isEmpty()) return undefined;
    return projectBox(box, seen);
  };
  /** A world box as the rectangle it covers on the canvas, clipped to it; undefined off screen. */
  const projectBox = (world, seen) => {
    const { w, h } = size();
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < 8; i += 1) {
      at.set(
        i & 1 ? world.max.x : world.min.x,
        i & 2 ? world.max.y : world.min.y,
        i & 4 ? world.max.z : world.min.z,
      ).project(seen.camera);
      if (at.z > 1) continue;
      const x = ((at.x + 1) / 2) * w;
      const y = ((1 - at.y) / 2) * h;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    if (!(x1 > 0 && y1 > 0 && x0 < w && y0 < h)) return undefined;
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(w, x1);
    y1 = Math.min(h, y1);
    return { x: tenth(x0), y: tenth(y0), w: tenth(x1 - x0), h: tenth(y1 - y0) };
  };

  const describe = (record, seen) => {
    const values = valuesOf(record.id);
    const instanced = instancedOf(record);
    return {
      ...(instanced.length === 0 ? {} : { instances: instanced[0].count }),
      id: record.id,
      name: record.name,
      kind: record.kind,
      ...(record.asset === undefined ? {} : { asset: record.asset }),
      ...(values === undefined ? {} : { values }),
      onScreen: onScreen(record, seen),
    };
  };

  const postThings = () => {
    if (!active) return;
    const seen = view();
    // Things the game named first, then its copies of ASSETS models.
    const list = [...things.values()].toSorted(
      (a, b) =>
        Number(a.auto) - Number(b.auto) || (firstSeen.get(a.id) ?? 0) - (firstSeen.get(b.id) ?? 0),
    );
    toStage({
      type: "studio-things",
      things: list.slice(0, MAX_THINGS).map((record) => describe(record, seen)),
    });
    changed = false;
    postedAt = performance.now();
  };

  // The path over the last 10 s, in this frame's canvas pixels: kept as world
  // positions, so a frozen frame's camera draws it where the thing really went.
  const traceOf = (record, seen) => {
    if (record.ring === null || seen === null) return undefined;
    const { w, h } = size();
    const onCanvas = (x, y, z) => {
      at.set(x, y, z).project(seen.camera);
      if (Math.abs(at.z) > 1 || Math.abs(at.x) > 4 || Math.abs(at.y) > 4) return null;
      return [tenth(((at.x + 1) / 2) * w), tenth(((1 - at.y) / 2) * h)];
    };
    const points = [];
    // The world positions, oldest first; null where the thing was off screen or not made yet.
    const world = [];
    for (let i = 0; i < record.count; i += 1) {
      const slot = ((record.head - record.count + i + TRACE_POINTS) % TRACE_POINTS) * 3;
      if (Number.isNaN(record.ring[slot])) {
        world.push(null);
        continue;
      }
      world.push([record.ring[slot], record.ring[slot + 1], record.ring[slot + 2]]);
      const point = onCanvas(record.ring[slot], record.ring[slot + 1], record.ring[slot + 2]);
      if (point === null) continue;
      // A thing standing still is one point, not three hundred.
      const prev = points.at(-1);
      if (prev === undefined || Math.abs(prev[0] - point[0]) + Math.abs(prev[1] - point[1]) >= 1)
        points.push(point);
    }
    const feel = feelOf(world, onCanvas);
    return feel === null ? { points } : { points, feel };
  };

  // How the thing moved, for tuning its feel: its ground speed over the last seconds and its
  // last jumps (rise from where it stood, apex, back down), in world units and game seconds.
  const feelOf = (world, onCanvas) => {
    if (world.filter((each) => each !== null).length < FEEL_MIN_SAMPLES) return null;
    const raw = world.map((each, i) => {
      const before = world[i - 1];
      return each === null || before == null
        ? null
        : Math.hypot(each[0] - before[0], each[2] - before[2]) * TRACE_HZ;
    });
    // A round reset, a teleport or a knockback's first frame moves it in one sample: the median
    // of each sample and its neighbours drops that spike and keeps any speed held for longer.
    const speed = raw.map((each, i) => {
      if (each === null) return null;
      const near = [raw[i - 1], each, raw[i + 1]].filter((one) => one != null);
      if (near.length === 1) return null;
      return near.length === 2 ? Math.min(...near) : near.toSorted((a, b) => a - b)[1];
    });
    const speeds = [];
    const per = Math.ceil(world.length / FEEL_SPEEDS);
    for (let start = 0; start < world.length; start += per) {
      const bucket = speed.slice(start, start + per).filter((each) => each !== null);
      speeds.push(
        bucket.length === 0 ? 0 : tenth(bucket.reduce((a, b) => a + b, 0) / bucket.length),
      );
    }
    const jumps = [];
    let from = null;
    let apex = null;
    let fell = false;
    let still = 0;
    for (let i = 1; i < world.length; i += 1) {
      const now = world[i];
      const before = world[i - 1];
      if (now === null || before === null) {
        from = null;
        continue;
      }
      const rise = (now[1] - before[1]) * TRACE_HZ;
      if (from === null) {
        if (rise > JUMP_RISE) {
          from = i - 1;
          apex = i;
          fell = false;
          still = 0;
        }
        continue;
      }
      if (now[1] > world[apex][1]) apex = i;
      if (rise < -JUMP_RISE) fell = true;
      // Landed: back at or under where it left, or level again once it came down (a ledge).
      still = fell && Math.abs(rise) < JUMP_RISE / 2 ? still + 1 : 0;
      const landed = now[1] <= world[from][1] + 0.02 || still >= 2;
      if (!landed) continue;
      const height = world[apex][1] - world[from][1];
      const seconds = (i - from) / TRACE_HZ;
      if (height >= JUMP_MIN_HEIGHT && seconds >= JUMP_MIN_SECONDS) {
        const arc = [];
        for (let k = from; k <= i; k += 1) {
          const point = onCanvas(...world[k]);
          if (point !== null) arc.push(point);
        }
        const top = onCanvas(...world[apex]);
        if (arc.length >= 2 && top !== null)
          jumps.push({
            points: arc,
            apex: top,
            height: Math.round(height * 100) / 100,
            seconds: Math.round(seconds * 100) / 100,
            distance: tenth(Math.hypot(now[0] - world[from][0], now[2] - world[from][2])),
          });
      }
      from = null;
    }
    const known = speed.filter((each) => each !== null);
    return {
      speeds,
      top: tenth(Math.max(0, ...known)),
      jumps: jumps.slice(-FEEL_JUMPS),
    };
  };

  const selectedRect = (seen) => {
    const instances = selectedIndex === null ? [] : instancedOf(selected);
    return instances.length > 0
      ? instanceRect(instances, selectedIndex, seen)
      : rectOf(selected, seen);
  };
  const postHover = (record, seen) => {
    const rect = rectOf(record, seen);
    toStage({
      type: "studio-hover",
      id: record?.id ?? null,
      ...(rect === undefined ? {} : { rect }),
    });
  };
  const postSelected = () => {
    const seen = view();
    if (selected === null) return toStage({ type: "studio-selected", thing: null });
    const instances = selectedIndex === null ? [] : instancedOf(selected);
    const rect = selectedRect(seen);
    const trace = instances.length > 0 ? undefined : traceOf(selected, seen);
    toStage({
      type: "studio-selected",
      thing: {
        ...describe(selected, seen),
        ...(instances.length > 0
          ? { instance: { index: selectedIndex, count: instances[0].count } }
          : {}),
      },
      ...(rect === undefined ? {} : { rect }),
      ...(trace === undefined ? {} : { trace }),
    });
  };

  const instancedOf = (record) => bodiesOf(record).flatMap(instancedIn);
  /** The instanced meshes that draw an object: the object itself, or those inside it. */
  const instancedIn = (object) => {
    const found = [];
    object?.traverse?.((node) => {
      if (node.isInstancedMesh) found.push(node);
    });
    return found;
  };
  const instanceMatrix = new THREE.Matrix4();
  const instanceBox = new THREE.Box3();
  /** One instance's world box, from every instanced mesh that draws it at that index. */
  const instanceBoxOf = (meshes, index) => {
    box.makeEmpty();
    for (const mesh of meshes) {
      if (index >= mesh.count) continue;
      mesh.getMatrixAt(index, instanceMatrix);
      instanceMatrix.premultiply(mesh.matrixWorld);
      if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
      instanceBox.copy(mesh.geometry.boundingBox).applyMatrix4(instanceMatrix);
      box.union(instanceBox);
    }
    return box;
  };
  const instanceRect = (meshes, index, seen) => {
    if (seen === null) return undefined;
    const world = instanceBoxOf(meshes, index);
    if (world.isEmpty()) return undefined;
    return projectBox(world, seen);
  };

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const pick = (x, y) => {
    const seen = view();
    if (seen === null) return null;
    const { w, h } = size();
    if (w === 0 || h === 0) return null;
    pointer.set((x / w) * 2 - 1, 1 - (y / h) * 2);
    raycaster.setFromCamera(pointer, seen.camera);
    // The nearest visible object drawn under the pointer, then the thing it belongs to: the
    // nearest registered thing up its parents, else one named from the scene itself, so a
    // person can point at anything they see (instanced trees, a model the game loaded on its
    // own) and the ground behind it never wins.
    // An animated character: three's ray test can miss a skinned mesh, whose bounds are its
    // bind pose, so a named one is found by its posed box when that is nearer than the hit.
    let posed = null;
    let posedAt = Infinity;
    for (const record of things.values()) {
      if (record.object === null || record.kind === "level" || !skinned(record.object)) continue;
      if (!attached(record.object, seen.scene) || !shown(record.object)) continue;
      box.setFromObject(record.object, true);
      if (raycaster.ray.intersectBox(box, through) === null) continue;
      const distance = through.distanceTo(raycaster.ray.origin);
      if (distance < posedAt) {
        posed = record;
        posedAt = distance;
      }
    }
    for (const hit of raycaster.intersectObjects(seen.scene.children, true)) {
      if (!shown(hit.object) || hit.object.isLine || hit.object.isPoints) continue;
      if (posed !== null && posedAt < hit.distance) return posed;
      let inner = null;
      for (let node = hit.object; node !== null; node = node.parent) {
        const record = byObject.get(node);
        // A level holds everything built into it: a tree in it is a thing the game named, else
        // the level.
        if (record !== undefined)
          return record.kind === "level" && inner !== null
            ? (namedThing(inner, seen.scene) ?? record)
            : record;
        if (inner === null) inner = node;
      }
      // Nothing the game named holds it: only a tuned name or an ASSETS copy it was drawn from.
      return namedThing(hit.object, seen.scene);
    }
    return posed;
  };
  const through = new THREE.Vector3();
  /** The instance of an instanced mesh under the pointer, as [its thing, its index]; or null. */
  const pickInstance = (x, y) => {
    const record = pick(x, y);
    if (record === null) return null;
    const meshes = instancedOf(record);
    if (meshes.length === 0) return null;
    // pick() aimed the raycaster; the nearest hit on one of the thing's own meshes says which.
    for (const hit of raycaster.intersectObjects(meshes, false))
      if (hit.instanceId !== undefined && shown(hit.object)) return [record, hit.instanceId];
    return null;
  };
  const skinned = (object) => {
    let found = false;
    object.traverse((node) => {
      if (node.isSkinnedMesh) found = true;
    });
    return found;
  };

  /**
   * The thing an object the game never named with ctx.thing is, if it is one at all: a copy of an
   * ASSETS model the game drew its own way (an InstancedMesh of its geometry), or a tuned name
   * (ctx.tune("Fox") with no ctx.thing) on the nearest node that carries that name. Anything else
   * is no thing: the runtime never names an object itself, so nothing reads "Thing 2" or a
   * material's key.
   */
  const namedThing = (object, scene) => {
    for (let node = object; node !== null && node !== scene; node = node.parent) {
      const earlier = byObject.get(node);
      if (earlier !== undefined) return earlier;
      if (node.isMesh)
        for (const record of things.values())
          if (record.auto && unplaced(record, scene) && sharesGeometry(record.object, node))
            return rebind(record, node, drawnFrom(record.object, node, scene));
      if (!meaningful(node.name)) continue;
      const label = humanName(node.name.split(":")[0].replace(/[._-]?\d+$/, "")).toLowerCase();
      for (const record of things.values())
        if (
          record.name.toLowerCase() === label &&
          (record.placeholder === true || (record.auto && unplaced(record, scene)))
        )
          return rebind(record, node);
    }
    return null;
  };
  const unplaced = (record, scene) =>
    record.object === null || (record.parts === undefined && !attached(record.object, scene));
  const sharesGeometry = (copy, mesh) => {
    if (copy === null || mesh.geometry === undefined) return false;
    let shared = false;
    copy.traverse((node) => {
      if (node.isMesh && node.geometry === mesh.geometry) shared = true;
    });
    return shared;
  };
  /**
   * Every mesh in the scene drawn from the copy's geometries with the hit mesh's instance count:
   * the parts one model was split into when it was instanced (a tree's trunk and leaves).
   */
  const drawnFrom = (copy, hit, scene) => {
    const geometries = new Set();
    copy?.traverse((node) => {
      if (node.isMesh) geometries.add(node.geometry);
    });
    const parts = [];
    scene.traverse((node) => {
      if (
        node.isMesh &&
        geometries.has(node.geometry) &&
        (node.isInstancedMesh ? node.count : 1) === (hit.isInstancedMesh ? hit.count : 1) &&
        !byObject.has(node)
      )
        parts.push(node);
    });
    return parts.length > 1 ? parts : undefined;
  };
  /** The thing becomes this object (or these parts), keeping its id, name, values and model file. */
  const rebind = (record, body, parts) => {
    things.delete(record.id);
    for (const old of bodiesOf(record)) byObject.delete(old);
    const { parts: _old, ...rest } = record;
    add({
      ...rest,
      object: body,
      ...(parts === undefined ? {} : { parts }),
      kind: record.kind !== "rule" ? record.kind : skinned(body) ? "character" : "prop",
      placeholder: false,
    });
    return things.get(record.id) ?? null;
  };
  // Exporters' and loaders' generic names say nothing a person would.
  const meaningful = (name) =>
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 80 &&
    !/^(scene|root|rootnode|group|object|mesh|node|armature|gltf|model|auxscene)[\s._-]*\d*$/i.test(
      name,
    );

  // The outline: the hovered and selected things drawn flat into a mask, then
  // one full-screen pass draws the mask's edges over the frame. Only while
  // frozen, and only on the frames a frozen Stage redraws.
  let mask = null;
  let quad = null;
  const maskSize = new THREE.Vector2();
  const clearColor = new THREE.Color();
  const solid = (color) =>
    new THREE.MeshBasicMaterial({ color, fog: false, toneMapped: false, side: THREE.DoubleSide });
  const masks = { hover: solid(0x00ff00), selected: solid(0xff0000) };
  const sprites = {
    hover: new THREE.SpriteMaterial({ color: 0x00ff00, alphaTest: 0.5, fog: false }),
    selected: new THREE.SpriteMaterial({ color: 0xff0000, alphaTest: 0.5, fog: false }),
  };
  const swapped = [];
  const flat = (object, which) => {
    object.traverse((node) => {
      if (node.isSprite) {
        const material = sprites[which];
        material.map = node.material.map;
        material.rotation = node.material.rotation;
        material.sizeAttenuation = node.material.sizeAttenuation;
        swapped.push(node, node.material);
        node.material = material;
      } else if (node.isMesh) {
        swapped.push(node, node.material);
        node.material = masks[which];
      }
    });
  };
  const unflat = () => {
    for (let i = 0; i < swapped.length; i += 2) swapped[i].material = swapped[i + 1];
    swapped.length = 0;
  };
  const makeQuad = () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    const material = new THREE.ShaderMaterial({
      uniforms: {
        mask: { value: null },
        texel: { value: new THREE.Vector2() },
        hover: { value: HOVER },
        selected: { value: SELECTED },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = position.xy * 0.5 + 0.5;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D mask;
        uniform vec2 texel;
        uniform vec3 hover;
        uniform vec3 selected;
        varying vec2 vUv;
        vec2 inside(vec2 uv) { return step(vec2(0.02), texture2D(mask, uv).rg); }
        void main() {
          vec2 here = inside(vUv);
          vec2 near = vec2(0.0);
          for (int x = -2; x <= 2; x++)
            for (int y = -2; y <= 2; y++)
              near = max(near, inside(vUv + vec2(float(x), float(y)) * texel));
          vec2 edge = near - here;
          float s = edge.r;
          float h = edge.g * (1.0 - s) * (1.0 - here.r);
          float a = max(max(s, h * 0.85), here.r * 0.14);
          if (a <= 0.0) discard;
          gl_FragColor = vec4(s > 0.0 || h <= 0.0 ? selected : hover, a);
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    return { mesh, material, camera: new THREE.OrthographicCamera() };
  };

  // One instance drawn alone into the mask: a plain mesh of its geometry where it stands.
  const lone = new THREE.Mesh(new THREE.BufferGeometry(), masks.selected);
  lone.matrixAutoUpdate = false;
  lone.frustumCulled = false;
  const drawInstance = (meshes, index, camera) => {
    for (const mesh of meshes) {
      if (index >= mesh.count || !shown(mesh)) continue;
      mesh.getMatrixAt(index, instanceMatrix);
      lone.geometry = mesh.geometry;
      lone.matrix.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
      renderer.render(lone, camera);
    }
  };

  // The selection's name tags and its path, drawn here on a 2D layer over the canvas, in the same
  // animation frame as the outline: tags the Stage drew from a posted rect landed a frame or two
  // after the draw, so they shook and trailed whenever the frozen frame moved (a resize, the free
  // camera, a replay under the freeze). Painted only on the frames a frozen Stage redraws, inside
  // the frame's own timing, and never part of a capture (drawClean reads the game's canvas only).
  let marks = null;
  const markLayer = () => {
    if (marks !== null) return marks;
    const layer = document.createElement("canvas");
    layer.setAttribute("aria-hidden", "true");
    Object.assign(layer.style, {
      position: "fixed",
      left: "0",
      top: "0",
      pointerEvents: "none",
      zIndex: "2147483647",
    });
    document.body.append(layer);
    marks = { layer, paint: layer.getContext("2d"), shown: false };
    return marks;
  };
  const clearMarks = () => {
    if (marks === null || !marks.shown) return;
    marks.paint.clearRect(0, 0, marks.layer.width, marks.layer.height);
    marks.layer.style.display = "none";
    marks.shown = false;
  };
  const MARK = `#${SELECTED.getHexString()}`;
  const INK = "#13110f";
  const PAPER = "#ecebe7";
  const tag = (paint, rect, record, chosen) => {
    const name = record.name;
    const kind = KIND_WORDS[record.kind] ?? "thing";
    paint.font = '500 12px system-ui, -apple-system, "Segoe UI", sans-serif';
    const nameW = paint.measureText(name).width;
    paint.font = '400 10px system-ui, -apple-system, "Segoe UI", sans-serif';
    const kindW = paint.measureText(kind).width;
    const w = nameW + kindW + 18;
    const h = 20;
    const x = Math.max(0, Math.min(rect.x, paint.canvas.clientWidth - w));
    const y = Math.max(0, rect.y - 4 - h);
    paint.fillStyle = chosen ? MARK : "rgba(19, 17, 15, 0.85)";
    paint.beginPath();
    paint.roundRect(x, y, w, h, 6);
    paint.fill();
    paint.textBaseline = "middle";
    paint.fillStyle = chosen ? "#ffffff" : PAPER;
    paint.font = '500 12px system-ui, -apple-system, "Segoe UI", sans-serif';
    paint.fillText(name, x + 6, y + h / 2);
    paint.globalAlpha = 0.75;
    paint.font = '400 10px system-ui, -apple-system, "Segoe UI", sans-serif';
    paint.fillText(kind, x + 12 + nameW, y + h / 2 + 0.5);
    paint.globalAlpha = 1;
  };
  // A Catmull-Rom curve through `count` spans of `points` from span `from`; the points before
  // and after give it its tangents.
  const curve = (paint, points, from, count) => {
    const at = (i) => points[Math.max(0, Math.min(points.length - 1, i))];
    paint.beginPath();
    paint.moveTo(at(from)[0], at(from)[1]);
    for (let i = from; i < from + count && i + 1 < points.length; i += 1) {
      const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
      paint.bezierCurveTo(
        p1[0] + (p2[0] - p0[0]) / 6,
        p1[1] + (p2[1] - p0[1]) / 6,
        p2[0] - (p3[0] - p1[0]) / 6,
        p2[1] - (p3[1] - p1[1]) / 6,
        p2[0],
        p2[1],
      );
    }
    paint.stroke();
  };
  // The path over the last seconds: older is thinner and fainter, a dark line under it keeps it
  // legible on a light floor; each jump's arc dashed, the last one's height and time beside it.
  const path = (paint, trace) => {
    const points = trace.points;
    if (points.length < 2) return;
    paint.lineCap = "round";
    paint.lineJoin = "round";
    const per = Math.max(1, Math.ceil((points.length - 1) / 24));
    for (const [color, under] of [
      [INK, true],
      [MARK, false],
    ]) {
      paint.strokeStyle = color;
      for (let start = 0; start < points.length - 1; start += per) {
        const end = Math.min(points.length - 1, start + per);
        const k = end / (points.length - 1);
        paint.globalAlpha = under ? 0.12 + 0.2 * k : 0.3 + 0.7 * k;
        paint.lineWidth = under ? 2.6 + 3.2 * k : 0.8 + 2.2 * k;
        curve(paint, points, start, end - start);
      }
    }
    paint.globalAlpha = 0.55;
    paint.fillStyle = MARK;
    paint.beginPath();
    paint.arc(points[0][0], points[0][1], 3.5, 0, Math.PI * 2);
    paint.fill();
    paint.globalAlpha = 0.9;
    const jumps = trace.feel?.jumps ?? [];
    for (const [n, jump] of jumps.entries()) {
      paint.strokeStyle = PAPER;
      paint.lineWidth = 2;
      paint.setLineDash([4, 3]);
      curve(paint, jump.points, 0, jump.points.length - 1);
      paint.setLineDash([]);
      paint.fillStyle = PAPER;
      paint.beginPath();
      paint.arc(jump.apex[0], jump.apex[1], 3, 0, Math.PI * 2);
      paint.fill();
      if (n !== jumps.length - 1) continue;
      const words = `${jump.height.toFixed(2)} m · ${jump.seconds.toFixed(2)} s`;
      paint.font = '500 10px system-ui, -apple-system, "Segoe UI", sans-serif';
      paint.textAlign = "center";
      paint.textBaseline = "alphabetic";
      paint.lineWidth = 3;
      paint.strokeStyle = INK;
      paint.strokeText(words, jump.apex[0], jump.apex[1] - 9);
      paint.fillText(words, jump.apex[0], jump.apex[1] - 9);
      paint.textAlign = "start";
    }
    paint.globalAlpha = 1;
  };
  const drawMarks = (seen) => {
    const box = canvas.getBoundingClientRect();
    const { layer, paint } = markLayer();
    const ratio = window.devicePixelRatio || 1;
    const w = Math.round(box.width * ratio);
    const h = Math.round(box.height * ratio);
    if (layer.width !== w || layer.height !== h) {
      layer.width = w;
      layer.height = h;
    }
    Object.assign(layer.style, {
      display: "block",
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    marks.shown = true;
    paint.setTransform(ratio, 0, 0, ratio, 0, 0);
    paint.clearRect(0, 0, box.width, box.height);
    // A thing as big as the view (the level, the sky) gets no tag: it would sit on the game's HUD.
    const tagged = (rect) => rect !== undefined && rect.w * rect.h < box.width * box.height * 0.6;
    const one = selected === null ? [] : instancedOf(selected);
    if (selected !== null && one.length === 0) {
      const trace = traceOf(selected, seen);
      if (trace !== undefined) path(paint, trace);
    }
    if (hovered !== null && hovered !== selected) {
      const rect = rectOf(hovered, seen);
      if (tagged(rect)) tag(paint, rect, hovered, false);
    }
    if (selected !== null) {
      const rect = selectedRect(seen);
      if (tagged(rect)) tag(paint, rect, selected, true);
    }
  };

  /** After the frame's draw: the outline, or nothing at all unless frozen with something to show. */
  const overlay = () => {
    if (!frozen || (hovered === null && selected === null)) return clearMarks();
    const seen = view();
    if (seen === null) return clearMarks();
    renderer.getDrawingBufferSize(maskSize);
    if (mask === null) mask = new THREE.WebGLRenderTarget(maskSize.x, maskSize.y);
    else if (mask.width !== maskSize.x || mask.height !== maskSize.y)
      mask.setSize(maskSize.x, maskSize.y);
    quad ??= makeQuad();
    const target = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const toneMapping = renderer.toneMapping;
    renderer.getClearColor(clearColor);
    const clearAlpha = renderer.getClearAlpha();
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.autoClear = false;
    renderer.setRenderTarget(mask);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    try {
      for (const [record, which] of [
        [hovered, "hover"],
        [selected, "selected"],
      ]) {
        if (record?.object == null || !attached(record.object, seen.scene)) continue;
        if (which === "hover" && record === selected && selectedIndex === null) continue;
        if (which === "selected" && selectedIndex !== null) {
          drawInstance(instancedOf(record), selectedIndex, seen.camera);
          continue;
        }
        for (const body of bodiesOf(record)) {
          flat(body, which);
          try {
            renderer.render(body, seen.camera);
          } finally {
            unflat();
          }
        }
      }
      quad.material.uniforms.mask.value = mask.texture;
      quad.material.uniforms.texel.value.set(1 / maskSize.x, 1 / maskSize.y);
      renderer.setRenderTarget(target);
      renderer.render(quad.mesh, quad.camera);
    } finally {
      renderer.setRenderTarget(target);
      renderer.autoClear = autoClear;
      renderer.toneMapping = toneMapping;
      renderer.setClearColor(clearColor, clearAlpha);
    }
    drawMarks(seen);
  };

  /**
   * Once a frame from the shell's loop, with the game time it moved. Records
   * each thing's world position 30 times a second once the Stage has asked.
   */
  const tick = (dt) => {
    if (!active) return;
    if (changed && performance.now() - postedAt >= THINGS_EVERY_MS) postThings();
    if (dt <= 0) return;
    traceClock += dt;
    if (traceClock < 1 / TRACE_HZ) return;
    traceClock %= 1 / TRACE_HZ;
    const seen = view();
    for (const record of things.values()) {
      if (record.object === null) continue;
      record.ring ??= new Float32Array(TRACE_POINTS * 3);
      const slot = record.head * 3;
      if (seen !== null && attached(record.object, seen.scene) && shown(record.object)) {
        const m = record.object.matrixWorld.elements;
        record.ring[slot] = m[12];
        record.ring[slot + 1] = m[13];
        record.ring[slot + 2] = m[14];
      } else record.ring[slot] = Number.NaN;
      record.head = (record.head + 1) % TRACE_POINTS;
      record.count = Math.min(record.count + 1, TRACE_POINTS);
    }
  };

  /** A new run: its things are made again by its start(); tuned values stay. */
  const reset = () => {
    things.clear();
    byObject.clear();
    named.clear();
    for (const id of tunes.keys()) if (!lookIds.has(id)) add(placeholder(id));
    lookCopies.clear();
    hovered = null;
    // The run on screen is gone (a new one, the menu): the Stage takes down what it showed for it.
    if (active) toStage({ type: "studio-run-reset" });
    if (selected !== null) {
      selected = null;
      selectedIndex = null;
      if (active) postSelected();
    }
    traceClock = 0;
    changed = true;
  };

  /** Where the selected thing stands, which a free camera orbits; null with none. */
  const focus = () => {
    const object = selected?.object;
    if (object == null) return null;
    return new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
  };

  const setFrozen = (on) => {
    if (on === frozen) return;
    frozen = on;
    freeze(on);
    dev?.frozen(on, focus());
    if (!on && hovered !== null) {
      hovered = null;
      toStage({ type: "studio-hover", id: null });
    }
    toStage({ type: "studio-frozen", on });
    if (on) postThings();
    // The path and feel of what is selected, as of the play that just stopped.
    if (on && selected !== null) postSelected();
    redraw();
  };

  // The game's actions, as its Controls screen lists them, with what the last change did.
  const postControls = (note) => {
    if (controls === undefined) return;
    toStage({
      type: "studio-controls",
      controls: controls.list().slice(0, 32),
      ...(text(note, 200) ? { note } : {}),
    });
  };

  const capture = () => {
    drawClean();
    const png = canvas.toDataURL("image/png");
    redraw();
    toStage({ type: "studio-frame", png });
  };

  /**
   * One named thing alone, as play draws it: everything else hidden, the sky and fog let go, a
   * camera around it at `yaw` and `pitch` that frames its bounds, drawn twice (on black, then on
   * white) so its edges come out transparent, and a square of `size` px cut from the middle.
   * Done between two frames and put back exactly before the next, so play never sees it.
   */
  const portrait = ({ id, size, yaw, pitch }) => {
    const record = things.get(id);
    const seen = view();
    if (record === undefined || seen === null || drawFrom === undefined) return null;
    const bodies = bodiesOf(record).filter((body) => attached(body, seen.scene));
    if (bodies.length === 0) return null;
    const bounds = new THREE.Box3();
    for (const body of bodies) bounds.union(partBox.setFromObject(body, true));
    if (bounds.isEmpty()) return null;
    const keep = new Set();
    for (const body of bodies) {
      body.traverse((node) => keep.add(node));
      for (let node = body.parent; node !== null; node = node.parent) keep.add(node);
    }
    const hidden = [];
    seen.scene.traverse((node) => {
      if (keep.has(node) || !node.visible) return;
      if (node.isMesh || node.isSprite || node.isPoints || node.isLine) {
        node.visible = false;
        hidden.push(node);
      }
    });
    const scene = seen.scene;
    const background = scene.background;
    const fog = scene.fog;
    const fogWas = fog === null ? null : { near: fog.near, far: fog.far, density: fog.density };
    const clear = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    const { width: w, height: h } = canvas;
    const side = Math.min(w, h);
    const camera = new THREE.PerspectiveCamera(30, w / h, 0.01, 1000);
    // 30 degrees across the square cut from the middle, whichever way the canvas is long.
    if (w < h)
      camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(Math.PI / 12) * (h / w)));
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.01);
    const distance = (radius / Math.sin(Math.PI / 12)) * 1.08;
    camera.near = distance / 100;
    camera.far = distance * 10;
    camera.position
      .set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
      .multiplyScalar(distance)
      .add(sphere.center);
    camera.lookAt(sphere.center);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const out = [0, 1].map(() => {
      const layer = document.createElement("canvas");
      layer.width = size;
      layer.height = size;
      return layer.getContext("2d", { willReadFrequently: true });
    });
    try {
      scene.background = null;
      if (fog !== null) {
        fog.near = 1e9;
        fog.far = 2e9;
        if (fog.density !== undefined) fog.density = 0;
      }
      for (const [n, paint] of out.entries()) {
        renderer.setClearColor(n === 0 ? 0x000000 : 0xffffff, 1);
        drawFrom(camera);
        paint.drawImage(canvas, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
      }
    } finally {
      for (const node of hidden) node.visible = true;
      scene.background = background;
      if (fog !== null && fogWas !== null) Object.assign(fog, fogWas);
      renderer.setClearColor(clear, clearAlpha);
      redraw();
    }
    // A pixel's alpha is how little the white behind it showed through, against the background's
    // own (tone mapping keeps white under 1).
    const dark = out[0].getImageData(0, 0, size, size);
    const light = out[1].getImageData(0, 0, size, size).data;
    const pixels = dark.data;
    let most = 1;
    for (let i = 0; i < pixels.length; i += 4)
      most = Math.max(
        most,
        light[i] + light[i + 1] + light[i + 2] - pixels[i] - pixels[i + 1] - pixels[i + 2],
      );
    for (let i = 0; i < pixels.length; i += 4) {
      const through =
        (light[i] + light[i + 1] + light[i + 2] - pixels[i] - pixels[i + 1] - pixels[i + 2]) / most;
      const alpha = Math.min(1, Math.max(0, 1 - through));
      for (let c = 0; c < 3; c += 1)
        pixels[i + c] = alpha <= 0 ? 0 : Math.min(255, Math.round(pixels[i + c] / alpha));
      pixels[i + 3] = Math.round(alpha * 255);
    }
    out[0].putImageData(dark, 0, 0);
    // What it is, from what the game made: its triangles, its materials and its size.
    let triangles = 0;
    const materials = new Set();
    for (const body of bodies)
      body.traverse((node) => {
        if (!node.isMesh || node.geometry === undefined) return;
        const geometry = node.geometry;
        const count = geometry.index?.count ?? geometry.attributes.position?.count ?? 0;
        triangles += Math.floor(count / 3) * (node.isInstancedMesh ? node.count : 1);
        for (const material of [node.material ?? []].flat())
          materials.add(
            text(material.name, 60) && !material.name.includes("|") ? material.name : material.type,
          );
      });
    const extent = bounds.getSize(new THREE.Vector3());
    return {
      png: out[0].canvas.toDataURL("image/png"),
      facts: {
        triangles,
        materials: [...materials].slice(0, 12),
        size: [extent.x, extent.y, extent.z].map((each) => Math.round(each * 100) / 100),
      },
    };
  };

  /** A thing's live value, clamped to the range the game gave it; false when it does not fit. */
  const setTune = (id, key, value) => {
    const entry = tunes.get(id);
    const fallback = entry?.defaults[key];
    if (entry === undefined || !fits(value, fallback)) return false;
    const range = entry.ranges[key];
    entry.live[key] =
      typeof value !== "number"
        ? value
        : range.choices === undefined
          ? clamp(value, range)
          : clamp(Math.round(value), range);
    changed = true;
    for (const copy of lookCopies.get(id) ?? []) applyAssetLook(copy, entry.live);
    if (selected?.id === id) postSelected();
    return true;
  };

  const valid = (data) => {
    switch (data?.type) {
      case "studio-freeze":
        return typeof data.on === "boolean";
      case "studio-pointer":
        return (
          finite(data.x) &&
          finite(data.y) &&
          (data.action === "hover" || data.action === "select" || data.action === "select-inner")
        );
      case "studio-select":
      case "studio-hover-thing":
        return data.id === null || text(data.id, 400);
      case "studio-tune":
        return (
          text(data.id, 400) &&
          text(data.key, 120) &&
          (finite(data.value) || typeof data.value === "boolean")
        );
      case "studio-speed":
        return finite(data.value) && data.value > 0 && data.value <= 4;
      case "studio-mute":
      case "studio-cannot-lose":
        return typeof data.on === "boolean";
      case "studio-things-request":
      case "studio-capture":
      case "studio-run-request":
      case "studio-controls-request":
      case "studio-controls-reset":
        return true;
      case "studio-rebind":
        return text(data.name, 64) && text(data.code, 64);
      case "studio-dev":
        return ["bounds", "perf", "freeCamera"].every((key) => typeof data[key] === "boolean");
      case "studio-step":
      case "studio-new-run":
        return true;
      case "studio-run-take":
        return typeof data.leave === "boolean";
      case "studio-replay":
        return (
          finite(data.id) &&
          isPlay(data.play) &&
          (Number.isInteger(data.step) ? data.step >= 0 : finite(data.at) && data.at >= 0) &&
          (data.pace === undefined || Number.isInteger(data.pace)) &&
          (data.fork === undefined || finite(data.fork))
        );
      case "studio-orbit":
        return finite(data.dx) && finite(data.dy) && finite(data.zoom) && data.zoom > 0;
      case "studio-portrait":
        return (
          finite(data.request) &&
          text(data.id, 400) &&
          Number.isInteger(data.size) &&
          data.size >= 32 &&
          data.size <= 512 &&
          finite(data.yaw) &&
          finite(data.pitch)
        );
      default:
        return false;
    }
  };

  window.addEventListener("message", (event) => {
    if (!framed || event.source !== window.parent || !valid(event.data)) return;
    const data = event.data;
    active = true;
    switch (data.type) {
      case "studio-freeze":
        return setFrozen(data.on);
      case "studio-speed":
        return speed?.(data.value);
      case "studio-mute":
        return mute?.(data.on);
      case "studio-cannot-lose":
        return canLose?.(!data.on);
      case "studio-pointer": {
        if (data.action === "select-inner") {
          // A double click goes into a group: one instance of it, else the thing as a click.
          const inner = pickInstance(data.x, data.y);
          selected = inner === null ? pick(data.x, data.y) : inner[0];
          selectedIndex = inner === null ? null : inner[1];
          postSelected();
          return redraw();
        }
        const record = pick(data.x, data.y);
        if (data.action === "select") {
          selected = record;
          selectedIndex = null;
          postSelected();
        } else if (record !== hovered) {
          hovered = record;
          postHover(record, view());
        }
        return redraw();
      }
      case "studio-select":
        selected = data.id === null ? null : (things.get(data.id) ?? null);
        selectedIndex = null;
        postSelected();
        return redraw();
      case "studio-tune": {
        const before = tunes.get(data.id)?.live[data.key];
        if (setTune(data.id, data.key, data.value)) tuned?.(data.id, data.key, data.value, before);
        return redraw();
      }
      case "studio-hover-thing": {
        const record = data.id === null ? null : (things.get(data.id) ?? null);
        if (record === hovered) return;
        hovered = record;
        postHover(record, view());
        return redraw();
      }
      case "studio-things-request":
        return postThings();
      case "studio-capture":
        return capture();
      case "studio-portrait": {
        let made = null;
        try {
          made = portrait({
            id: data.id,
            size: data.size,
            yaw: data.yaw,
            pitch: Math.max(-1.4, Math.min(1.4, data.pitch)),
          });
        } catch {
          made = null;
        }
        return toStage({
          type: "studio-picture",
          request: data.request,
          id: data.id,
          png: made?.png ?? null,
          ...(made === null ? {} : { facts: made.facts }),
        });
      }
      case "studio-run-request": {
        const recorded = runSoFar?.() ?? null;
        if (recorded !== null) toStage({ type: "studio-play", play: recorded, asked: true });
        return;
      }
      case "studio-controls-request":
        return postControls();
      case "studio-rebind":
        return postControls(controls?.rebind(data.name, data.code));
      case "studio-controls-reset":
        controls?.reset();
        return postControls("Controls are back to the game's own");
      case "studio-dev":
        return dev?.set(
          { bounds: data.bounds, perf: data.perf, freeCamera: data.freeCamera },
          focus(),
        );
      case "studio-step":
        if (!frozen) return;
        dev?.step();
        // The selection's path and feel move on with the frame.
        if (selected !== null) postSelected();
        return redraw();
      case "studio-run-take":
        return toStage({ type: "studio-run", play: rewind?.take(data.leave) ?? null });
      case "studio-replay":
        return rewind?.replay(data);
      case "studio-new-run":
        return rewind?.fresh();
      case "studio-orbit":
        if (!frozen) return;
        dev?.orbit(data.dx, data.dy, data.zoom);
        // The path and the name tag are drawn from the new camera's view.
        if (selected !== null) postSelected();
        return;
    }
  });

  // A focused game keeps every key from the Stage: Tab, Escape and the number keys are the game's
  // while it plays (a journal on Tab, a pause on Escape). Escape travels up only while frozen,
  // when nothing is playing. Capture phase, so the shell's keys never see it. Only once the Stage
  // has spoken. Kurambit's own chords (Ctrl or Cmd with Alt) travel up too: a game reading P for
  // pause would take Ctrl+Alt+P for its own, and Focus game's chord hands the keyboard back.
  window.addEventListener(
    "keydown",
    (event) => {
      if (!framed || !active) return;
      // Tab is the game's, and the page's own Tab would move the keyboard out of the game.
      if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey)
        event.preventDefault();
      if (event.repeat) return;
      if (event.altKey && (event.ctrlKey || event.metaKey)) {
        const { key, code, ctrlKey, metaKey, shiftKey } = event;
        event.preventDefault();
        event.stopImmediatePropagation();
        toStage({ type: "studio-shortcut", key, code, ctrlKey, metaKey, shiftKey });
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "Escape" || !frozen) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      toStage({ type: "studio-key", key: "Escape" });
    },
    { capture: true },
  );

  return {
    /** What studio-ready carries: the Stage learns the bridge from it. */
    hello: { bridge: BRIDGE, capabilities: CAPABILITIES },
    thing,
    tune,
    assetCopy,
    /** Every registered thing ({ id, name, kind, object }), for the scene report; read only. */
    eachThing(fn) {
      for (const record of things.values()) fn(record);
    },
    /** The thing an object is (`exact`) or belongs to (its nearest registered parent). */
    thingOf(object, exact) {
      if (exact) return byObject.get(object);
      for (let node = object; node != null; node = node.parent) {
        const record = byObject.get(node);
        if (record !== undefined) return record;
      }
      return undefined;
    },
    tick,
    overlay,
    reset,
    setTune,
    /** A person's run on the Stage ended or was left: its play (shell/replay.js), for the Stage to keep. */
    play(recorded) {
      if (active) toStage({ type: "studio-play", play: recorded });
    },
    /** Where the person's run stands this second (replay.js mark): the Workbench's values watch. */
    mark(entry) {
      if (active) toStage({ type: "studio-mark", mark: entry });
    },
    /** How the Stage's replay went (shell.js stageReplay). */
    replayed(result) {
      if (active) toStage({ type: "studio-replayed", ...result });
    },
    /** Freezes play as the Stage would, saying so: a replay handed over, frozen at its moment. */
    hold: () => setFrozen(true),
    release: () => setFrozen(false),
    /**
     * A replay's run begins with the values its play tuned as they were then (`values`, a play's
     * tunes): set now on the things this page has, and taken by the ones its start() makes.
     * Null lets go once the run has started.
     */
    presetTunes(values) {
      preset = values ?? {};
      for (const [id, entry] of tunes)
        for (const [key, value] of Object.entries(preset[id] ?? {}))
          if (fits(value, entry.defaults[key]))
            entry.live[key] = typeof value === "number" ? clamp(value, entry.ranges[key]) : value;
      changed = true;
    },
    /** Every tuned value now, by thing: what a run started with. */
    tuneValues() {
      const values = {};
      for (const [id, entry] of tunes) values[id] = { ...entry.live };
      return values;
    },
    /**
     * Puts tuned values back as a run started with them (`values`, from tuneValues), the file's
     * or the game's own for any it did not have: a replay of the run starts as it did.
     */
    restoreTunes(values) {
      for (const [id, entry] of tunes) {
        const file = saved[id] !== null && typeof saved[id] === "object" ? saved[id] : {};
        for (const [key, fallback] of Object.entries(entry.defaults)) {
          const start = values[id]?.[key] ?? (fits(file[key], fallback) ? file[key] : fallback);
          entry.live[key] = typeof start === "number" ? clamp(start, entry.ranges[key]) : start;
        }
      }
      changed = true;
      if (selected !== null) postSelected();
    },
    get frozen() {
      return frozen;
    },
  };
}
