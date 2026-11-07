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
//   const cat = ctx.tune("Cat", { jump: 8, lives: 3 }, { jump: [2, 20], lives: [1, 9, 1] });
//   // read cat.jump every frame: the Stage's sliders change it live, and
//   // "Keep as a build" writes it to tune.json, which this file loads at boot.
import * as THREE from "../vendor/three.module.js";

const BRIDGE = 1;
const CAPABILITIES = ["freeze", "select", "tune", "trace"];
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
// The game folder's engine directory: ids and asset paths are game-relative.
const LANE = "web/";
const THINGS_EVERY_MS = 500;
const HOVER = new THREE.Color(0xffffff);
const SELECTED = new THREE.Color(0xe2582a);

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

// Tuned values outlive runs: a Retry keeps what the person set on the Stage.
let saved = {};
const tunes = new Map();

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

const rangeOf = (range) => {
  if (Array.isArray(range)) {
    const [min, max, step] = range;
    return { min, max, step };
  }
  return range !== null && typeof range === "object" ? range : {};
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

/**
 * The Stage end of the bridge. The shell passes how to reach the run: `view()`
 * is the scene and camera on screen (or null), `freeze(on)` holds play and
 * sound, `redraw()` asks for one frame, `drawClean()` draws one frame with no
 * outline (for a capture).
 */
export function createStageBridge({ canvas, renderer, view, freeze, redraw, drawClean }) {
  let active = false;
  let frozen = false;
  let hovered = null;
  let selected = null;
  let changed = false;
  let postedAt = 0;
  let traceClock = 0;
  const things = new Map();
  const byObject = new Map();
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
  const add = (record) => {
    if (things.size >= MAX_REGISTERED) return null;
    things.set(record.id, { ring: null, head: 0, count: 0, ...record });
    if (record.object !== null) byObject.set(record.object, things.get(record.id));
    changed = true;
    return record;
  };
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
    const kind = KINDS.has(options.kind)
      ? options.kind
      : (earlier?.kind ?? (body === null ? "rule" : "other"));
    const name = text(options.name, 120) ? options.name : (earlier?.name ?? humanName(kind));
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
    const { id, n } = unique(path, "#");
    add({
      id,
      name: n === null ? label : `${label} ${n}`,
      kind: source.kind,
      object: copy,
      asset: {
        path,
        ...(source.sidecar === undefined ? {} : { sidecar: `${LANE}${source.sidecar}` }),
      },
      auto: true,
    });
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
        const start = fits(file[name], fallback) ? file[name] : fallback;
        entry.live[name] = typeof start === "number" ? clamp(start, range) : start;
      }
    }
    if (!things.has(key)) add(placeholder(key));
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
        ...(finite(range.min) ? { min: range.min } : {}),
        ...(finite(range.max) ? { max: range.max } : {}),
        ...(finite(range.step) && range.step > 0 ? { step: range.step } : {}),
        ...(entry.labels[key] === undefined ? {} : { label: entry.labels[key] }),
      };
    });
  };

  // Screen maths, with no allocation per call.
  const at = new THREE.Vector3();
  const box = new THREE.Box3();
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
    box.setFromObject(record.object);
    if (box.isEmpty()) return undefined;
    const { w, h } = size();
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < 8; i += 1) {
      at.set(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
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
    return {
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
    const list = [...things.values()].toSorted((a, b) => Number(a.auto) - Number(b.auto));
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
    const points = [];
    for (let i = 0; i < record.count; i += 1) {
      const slot = ((record.head - record.count + i + TRACE_POINTS) % TRACE_POINTS) * 3;
      if (Number.isNaN(record.ring[slot])) continue;
      at.set(record.ring[slot], record.ring[slot + 1], record.ring[slot + 2]).project(seen.camera);
      if (Math.abs(at.z) > 1 || Math.abs(at.x) > 4 || Math.abs(at.y) > 4) continue;
      const x = tenth(((at.x + 1) / 2) * w);
      const y = tenth(((1 - at.y) / 2) * h);
      // A thing standing still is one point, not three hundred.
      const prev = points.at(-1);
      if (prev === undefined || Math.abs(prev[0] - x) + Math.abs(prev[1] - y) >= 1)
        points.push([x, y]);
    }
    return { points };
  };

  const postSelected = () => {
    const seen = view();
    if (selected === null) return toStage({ type: "studio-selected", thing: null });
    const rect = rectOf(selected, seen);
    const trace = traceOf(selected, seen);
    toStage({
      type: "studio-selected",
      thing: describe(selected, seen),
      ...(rect === undefined ? {} : { rect }),
      ...(trace === undefined ? {} : { trace }),
    });
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
    const bodies = [];
    for (const record of things.values())
      if (record.object !== null && attached(record.object, seen.scene) && shown(record.object))
        bodies.push(record.object);
    // The nearest visible hit, then the nearest registered thing up its parents.
    for (const hit of raycaster.intersectObjects(bodies, true)) {
      if (!shown(hit.object)) continue;
      for (let node = hit.object; node !== null; node = node.parent) {
        const record = byObject.get(node);
        if (record !== undefined) return record;
      }
    }
    return null;
  };

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

  /** After the frame's draw: the outline, or nothing at all unless frozen with something to show. */
  const overlay = () => {
    if (!frozen || (hovered === null && selected === null)) return;
    const seen = view();
    if (seen === null) return;
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
        if (which === "hover" && record === selected) continue;
        flat(record.object, which);
        try {
          renderer.render(record.object, seen.camera);
        } finally {
          unflat();
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
    for (const id of tunes.keys()) add(placeholder(id));
    hovered = null;
    if (selected !== null) {
      selected = null;
      if (active) postSelected();
    }
    traceClock = 0;
    changed = true;
  };

  const setFrozen = (on) => {
    if (on === frozen) return;
    frozen = on;
    freeze(on);
    if (!on && hovered !== null) {
      hovered = null;
      toStage({ type: "studio-hover", id: null });
    }
    toStage({ type: "studio-frozen", on });
    if (on) postThings();
    redraw();
  };

  const capture = () => {
    drawClean();
    const png = canvas.toDataURL("image/png");
    redraw();
    toStage({ type: "studio-frame", png });
  };

  const valid = (data) => {
    switch (data?.type) {
      case "studio-freeze":
        return typeof data.on === "boolean";
      case "studio-pointer":
        return (
          finite(data.x) && finite(data.y) && (data.action === "hover" || data.action === "select")
        );
      case "studio-select":
        return data.id === null || text(data.id, 400);
      case "studio-tune":
        return (
          text(data.id, 400) &&
          text(data.key, 120) &&
          (finite(data.value) || typeof data.value === "boolean")
        );
      case "studio-things-request":
      case "studio-capture":
        return true;
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
      case "studio-pointer": {
        const record = pick(data.x, data.y);
        if (data.action === "select") {
          selected = record;
          postSelected();
        } else if (record !== hovered) {
          hovered = record;
          const rect = rectOf(record, view());
          toStage({
            type: "studio-hover",
            id: record?.id ?? null,
            ...(rect === undefined ? {} : { rect }),
          });
        }
        return redraw();
      }
      case "studio-select":
        selected = data.id === null ? null : (things.get(data.id) ?? null);
        postSelected();
        return redraw();
      case "studio-tune": {
        const entry = tunes.get(data.id);
        const fallback = entry?.defaults[data.key];
        if (entry === undefined || !fits(data.value, fallback)) return;
        entry.live[data.key] =
          typeof data.value === "number" ? clamp(data.value, entry.ranges[data.key]) : data.value;
        changed = true;
        if (selected?.id === data.id) postSelected();
        return redraw();
      }
      case "studio-things-request":
        return postThings();
      case "studio-capture":
        return capture();
    }
  });

  return {
    /** What studio-ready carries: the Stage learns the bridge from it. */
    hello: { bridge: BRIDGE, capabilities: CAPABILITIES },
    thing,
    tune,
    assetCopy,
    tick,
    overlay,
    reset,
    get frozen() {
      return frozen;
    },
  };
}
