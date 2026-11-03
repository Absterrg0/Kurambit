// @effect-diagnostics nodeBuiltinImport:off -- Plain filesystem facts read from the game folder.
// Measured facts on the game's own images for the art director: numbers and file names, never verdicts.
// PNGs decode in process (node:zlib), so no tool is needed and a big game stays fast within the caps.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";
import { laneAssets, laneLibrary } from "./roles.ts";

const MAX_IMAGES = 160;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 2048 * 2048;
const MAX_TOTAL_PIXELS = 24 * 1024 * 1024;
const MAX_STYLE_IMAGES = 12;
const COLOUR_CAP = 4096;
// Below this alpha a pixel counts as background; soft render fringes stay out of the box.
const VISIBLE_ALPHA = 16;
// A background is "transparent" only when a real share of the canvas is; tiles stay out of the edge facts.
const TRANSPARENT_SHARE = 0.1;
const NEAR_IDENTICAL = 3;
const DARK = 40;
const TEXT_BUDGET = 6000;
const LIST_CAP = 16;
const NOTABLE_BUDGET = 1500;

const inflate = NodeUtil.promisify(NodeZlib.inflate);

export interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface Measure {
  readonly width: number;
  readonly height: number;
  readonly transparentShare: number;
  readonly visible: number;
  /** Inclusive pixel bounds of the visible pixels; null when nothing is visible. */
  readonly box: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  } | null;
  /** Visible pixels lying on each canvas edge. */
  readonly edges: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
  };
  /** Distinct RGBA values of visible pixels, capped at COLOUR_CAP + 1. */
  readonly colours: number;
  /** Mean Rec. 709 luma of visible pixels, 0-255; null when nothing is visible. */
  readonly luminance: number | null;
}

export const measure = ({ width, height, data }: Rgba): Measure => {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  let visible = 0;
  let luma = 0;
  const edges = { top: 0, bottom: 0, left: 0, right: 0 };
  const colours = new Set<number>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3]!;
      if (a < VISIBLE_ALPHA) continue;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      visible++;
      luma += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (colours.size <= COLOUR_CAP) colours.add(((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (y === 0) edges.top++;
      if (y === height - 1) edges.bottom++;
      if (x === 0) edges.left++;
      if (x === width - 1) edges.right++;
    }
  }
  const total = width * height;
  return {
    width,
    height,
    transparentShare: total === 0 ? 0 : (total - visible) / total,
    visible,
    box: visible === 0 ? null : { x0, y0, x1, y1 },
    edges,
    colours: colours.size,
    luminance: visible === 0 ? null : luma / visible,
  };
};

/**
 * Mean absolute RGBA difference (0-255) over the pixels visible in either frame, with
 * background pixels read as clear, so a small sprite on a big canvas is not diluted.
 * Null when the canvases differ or neither frame shows anything.
 */
export const frameDifference = (a: Rgba, b: Rgba): number | null => {
  if (a.width !== b.width || a.height !== b.height) return null;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const av = a.data[i + 3]! >= VISIBLE_ALPHA;
    const bv = b.data[i + 3]! >= VISIBLE_ALPHA;
    if (!av && !bv) continue;
    count++;
    for (let c = 0; c < 4; c++)
      sum += Math.abs((av ? a.data[i + c]! : 0) - (bv ? b.data[i + c]! : 0));
  }
  return count === 0 ? null : sum / (count * 4);
};

type Decoded = Rgba | { readonly skip: string };

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Non-interlaced PNG of any colour type and bit depth to 8-bit RGBA; anything else is a named skip.
 * A corrupt or truncated file is a skip, never a failure: these facts must not break a step. */
export const decodePng = (file: Buffer, maxPixels = MAX_IMAGE_PIXELS): Promise<Decoded> =>
  decode(file, maxPixels).catch(() => ({ skip: "unreadable PNG" }));

const readPng = (full: string): Promise<Decoded> =>
  NodeFSP.readFile(full).then(
    (file) => decodePng(file),
    () => ({ skip: "unreadable" }),
  );

const decode = async (file: Buffer, maxPixels: number): Promise<Decoded> => {
  if (file.length < 8 || file.readUInt32BE(0) !== 0x89504e47 || file.readUInt32BE(4) !== 0x0d0a1a0a)
    return { skip: "not a PNG" };
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= file.length;) {
    const length = file.readUInt32BE(at);
    const name = file.toString("latin1", at + 4, at + 8);
    const body = file.subarray(at + 8, at + 8 + length);
    if (name === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      type = body[9]!;
      if (body[12] !== 0) return { skip: "interlaced PNG" };
      if (CHANNELS[type] === undefined || ![1, 2, 4, 8, 16].includes(depth))
        return { skip: "unsupported PNG format" };
      if (width * height > maxPixels) return { skip: "over the pixel cap" };
    } else if (name === "PLTE") palette = body;
    else if (name === "tRNS") trns = body;
    else if (name === "IDAT") idat.push(body);
    else if (name === "IEND") break;
    at += 12 + length;
  }
  if (width === 0 || height === 0 || idat.length === 0) return { skip: "unreadable PNG" };
  const channels = CHANNELS[type]!;
  const bits = channels * depth;
  const stride = Math.ceil((width * bits) / 8);
  const step = Math.max(1, bits >> 3);
  let raw: Buffer;
  try {
    // The output cap stops a small file from inflating past its declared size.
    raw = await inflate(Buffer.concat(idat), { maxOutputLength: height * (stride + 1) + 1024 });
  } catch {
    return { skip: "unreadable PNG" };
  }
  if (raw.length < height * (stride + 1)) return { skip: "unreadable PNG" };
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let row = new Uint8Array(stride);
  const max = (1 << depth) - 1;
  const sample = (line: Uint8Array, index: number): number => {
    if (depth === 8) return line[index]!;
    if (depth === 16) return (line[index * 2]! << 8) | line[index * 2 + 1]!;
    const bit = index * depth;
    return (line[bit >> 3]! >> (8 - depth - (bit & 7))) & max;
  };
  const to8 = (v: number) =>
    depth === 16 ? Math.round(v / 257) : depth === 8 ? v : Math.round((v * 255) / max);
  const key = (body: Buffer | null, i: number) => (body === null ? -1 : body.readUInt16BE(i));
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[base + 1 + x]!;
      const left = x >= step ? row[x - step]! : 0;
      const up = prev[x]!;
      const corner = x >= step ? prev[x - step]! : 0;
      let p = v;
      if (filter === 1) p = v + left;
      else if (filter === 2) p = v + up;
      else if (filter === 3) p = v + ((left + up) >> 1);
      else if (filter === 4) {
        const e = left + up - corner;
        const da = Math.abs(e - left);
        const db = Math.abs(e - up);
        const dc = Math.abs(e - corner);
        p = v + (da <= db && da <= dc ? left : db <= dc ? up : corner);
      }
      row[x] = p & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (type === 3) {
        const index = sample(row, x);
        out[o] = palette?.[index * 3] ?? 0;
        out[o + 1] = palette?.[index * 3 + 1] ?? 0;
        out[o + 2] = palette?.[index * 3 + 2] ?? 0;
        out[o + 3] = trns !== null && index < trns.length ? trns[index]! : 255;
      } else if (type === 0 || type === 4) {
        const g = sample(row, s);
        out[o] = out[o + 1] = out[o + 2] = to8(g);
        out[o + 3] =
          type === 4 ? to8(sample(row, s + 1)) : trns !== null && g === key(trns, 0) ? 0 : 255;
      } else {
        const r = sample(row, s);
        const g = sample(row, s + 1);
        const b = sample(row, s + 2);
        out[o] = to8(r);
        out[o + 1] = to8(g);
        out[o + 2] = to8(b);
        out[o + 3] =
          type === 6
            ? to8(sample(row, s + 3))
            : trns !== null && r === key(trns, 0) && g === key(trns, 2) && b === key(trns, 4)
              ? 0
              : 255;
      }
    }
    [prev, row] = [row, prev];
  }
  return { width, height, data: out };
};

const IMAGE = /\.(png|jpe?g|webp)$/i;

// Regular files only: a link never takes the scan outside the game.
const listImages = async (dir: string, skip: string | null): Promise<string[]> => {
  const found: string[] = [];
  const visit = async (at: string) => {
    for (const entry of await NodeFSP.readdir(at, { withFileTypes: true }).catch(() => [])) {
      const full = NodePath.join(at, entry.name);
      if (entry.isDirectory()) {
        if (full !== skip && !entry.name.startsWith(".")) await visit(full);
      } else if (entry.isFile() && IMAGE.test(entry.name)) found.push(full);
    }
  };
  await visit(dir);
  return found.sort();
};

interface Shot {
  readonly path: string;
  readonly m: Measure;
}

const pct = (share: number) => `${Math.round(share * 100)}%`;
const colourText = (n: number) => (n > COLOUR_CAP ? `${COLOUR_CAP}+` : `${n}`);
const hasBackground = (m: Measure) => m.transparentShare >= TRANSPARENT_SHARE;
const touched = (m: Measure) =>
  (["top", "bottom", "left", "right"] as const).filter((side) => m.edges[side] > 0);

/**
 * Top or side edges the visible pixels touch while the opposite side stays clear by at least
 * 10% of the canvas: the shape of a cut-off render. Trimmed sprites fill both sides of an axis
 * and grounded ones touch only the bottom, so neither is listed. Each comes with the clear margin.
 */
export const cutEdges = (
  m: Measure,
): ReadonlyArray<{ side: "top" | "left" | "right"; clear: number }> => {
  if (m.box === null || m.transparentShare < TRANSPARENT_SHARE) return [];
  const { x0, y0, x1, y1 } = m.box;
  const enough = (clear: number, axis: number) => clear >= Math.max(2, axis * 0.1);
  const cuts: Array<{ side: "top" | "left" | "right"; clear: number }> = [];
  if (y0 === 0 && enough(m.height - 1 - y1, m.height))
    cuts.push({ side: "top", clear: m.height - 1 - y1 });
  if (x0 === 0 && enough(m.width - 1 - x1, m.width))
    cuts.push({ side: "left", clear: m.width - 1 - x1 });
  if (x1 === m.width - 1 && enough(x0, m.width)) cuts.push({ side: "right", clear: x0 });
  return cuts;
};

const imageLine = ({ path, m }: Shot): string => {
  const size = `${m.width}x${m.height}`;
  if (m.box === null) return `${path} ${size}, fully transparent`;
  const parts = [`${path} ${size}`];
  if (m.transparentShare === 0) parts.push("opaque");
  else {
    parts.push(`${pct(m.transparentShare)} transparent`);
    const { x0, y0, x1, y1 } = m.box;
    parts.push(`opaque box ${x1 - x0 + 1}x${y1 - y0 + 1} at ${x0},${y0}`);
    if (hasBackground(m)) {
      const sides = touched(m);
      parts.push(
        sides.length === 0
          ? "touches no edge"
          : `touches ${sides.map((side) => `${side} (${m.edges[side]} px)`).join(", ")}`,
      );
    }
  }
  parts.push(`${colourText(m.colours)} colours`, `mean luminance ${Math.round(m.luminance ?? 0)}`);
  return parts.join(", ");
};

const capped = (items: ReadonlyArray<string>) =>
  `${items.slice(0, LIST_CAP).join("; ")}${items.length > LIST_CAP ? `; and ${items.length - LIST_CAP} more` : ""}`;

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

const take = (lines: ReadonlyArray<string>, budget: number): string => {
  let out = "";
  for (const [i, line] of lines.entries()) {
    if (out.length + line.length + 1 > budget)
      return `${out}(${lines.length - i} more lines omitted)`;
    out += `${line}\n`;
  }
  return out.trimEnd();
};

export interface SpriteFacts {
  /** Every measured fact, bounded for a prompt. */
  readonly full: string;
  /** Only the notable groups, shorter, for roles that judge the whole game. */
  readonly notable: string;
}

/** Measured facts on every image the game owns under the lane's asset dir, library packs aside. */
export const spriteFacts = async (root: string, lane: string): Promise<SpriteFacts> => {
  const assets = NodePath.join(root, laneAssets(lane));
  const library = NodePath.join(root, laneLibrary(lane));
  const files = await listImages(assets, library);
  const rel = (full: string) => NodePath.relative(assets, full);
  const skipped = new Map<string, number>();
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  let pixels = 0;
  const load = async (full: string): Promise<Rgba | null> => {
    const stat = await NodeFSP.stat(full).catch(() => null);
    const reason =
      stat === null
        ? "unreadable"
        : stat.size > MAX_FILE_BYTES
          ? "over 16 MB"
          : /\.png$/i.test(full)
            ? null
            : `not a PNG (${NodePath.extname(full).slice(1)})`;
    const decoded = reason === null ? await readPng(full) : { skip: reason };
    if ("skip" in decoded) {
      skip(decoded.skip);
      return null;
    }
    if (pixels + decoded.width * decoded.height > MAX_TOTAL_PIXELS) {
      skip("over the total pixel budget");
      return null;
    }
    pixels += decoded.width * decoded.height;
    return decoded;
  };

  const measured = files.slice(0, MAX_IMAGES);
  if (files.length > MAX_IMAGES) skipped.set("over the image cap", files.length - MAX_IMAGES);
  // Frames are the same name with a trailing _N in one folder.
  const families = new Map<string, Array<{ n: number; tag: string; full: string }>>();
  for (const full of measured) {
    const match = /^(.+)_(\d+)\.png$/i.exec(NodePath.basename(full));
    if (match === null) continue;
    const key = NodePath.join(NodePath.dirname(full), match[1]!);
    families.set(key, [
      ...(families.get(key) ?? []),
      { n: Number(match[2]), tag: match[2]!, full },
    ]);
  }
  const shots: Shot[] = [];
  const familyLines: string[] = [];
  const nearIdentical: string[] = [];
  const mixedOrDrift: string[] = [];
  const framed = new Set<string>();
  for (const [key, frames] of families) {
    if (frames.length < 2) continue;
    frames.sort((a, b) => a.n - b.n);
    const label = `${rel(key)}_${frames[0]!.tag}..${frames.at(-1)!.tag}`;
    const sizes = new Set<string>();
    const anchorsX: number[] = [];
    const anchorsY: number[] = [];
    const diffs: Array<{ d: number; pair: string }> = [];
    let prev: { rgba: Rgba; tag: string } | null = null;
    for (const frame of frames) {
      framed.add(frame.full);
      const rgba = await load(frame.full);
      if (rgba === null) continue;
      const m = measure(rgba);
      shots.push({ path: rel(frame.full), m });
      sizes.add(`${m.width}x${m.height}`);
      if (m.box !== null) {
        anchorsX.push((m.box.x0 + m.box.x1 + 1) / 2);
        anchorsY.push(m.box.y1 + 1);
      }
      if (prev !== null) {
        const d = frameDifference(prev.rgba, rgba);
        if (d !== null) diffs.push({ d, pair: `${prev.tag}->${frame.tag}` });
      }
      prev = { rgba, tag: frame.tag };
    }
    const span = (values: number[]) =>
      values.length === 0 ? 0 : Math.round(Math.max(...values) - Math.min(...values));
    const dx = span(anchorsX);
    const dy = span(anchorsY);
    const parts = [
      `${label} (${frames.length} frames): ${sizes.size === 1 ? `canvas ${[...sizes][0]} in all` : `canvas sizes ${[...sizes].join(", ")}`}`,
      `anchor (bottom-centre of the opaque box) moves ${dx} px in x and ${dy} px in y`,
    ];
    if (diffs.length > 0) {
      const min = diffs.reduce((a, b) => (b.d < a.d ? b : a));
      parts.push(
        `frame difference min ${min.d.toFixed(1)} (${min.pair}), median ${median(diffs.map((x) => x.d)).toFixed(1)}`,
      );
      const close = diffs.filter((x) => x.d < NEAR_IDENTICAL);
      if (close.length > 0)
        nearIdentical.push(
          `${label} ${close.map((x) => `${x.pair} ${x.d.toFixed(1)}`).join(", ")}`,
        );
    }
    if (sizes.size > 1 || dx > 2 || dy > 2)
      mixedOrDrift.push(
        `${label} ${sizes.size > 1 ? `sizes ${[...sizes].join("/")}` : `anchor moves ${dx} px x, ${dy} px y`}`,
      );
    familyLines.push(parts.join("; "));
  }
  for (const full of measured) {
    if (framed.has(full)) continue;
    const rgba = await load(full);
    if (rgba !== null) shots.push({ path: rel(full), m: measure(rgba) });
  }
  shots.sort((a, b) => a.path.localeCompare(b.path));

  // VISION.md names the style source by its pack id; only a pack already in the game is measured.
  const vision = await NodeFSP.readFile(NodePath.join(root, "VISION.md"), "utf8").catch(() => "");
  const styleLines: string[] = [];
  for (const entry of await NodeFSP.readdir(library, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !vision.includes(entry.name)) continue;
    const pack = NodePath.join(library, entry.name);
    const images = (await listImages(pack, null)).filter((f) => /\.png$/i.test(f));
    const counts: string[] = [];
    // The pack is a reference, so its decodes stay out of the game's own caps and skip counts.
    for (const full of images.slice(0, MAX_STYLE_IMAGES)) {
      const stat = await NodeFSP.stat(full).catch(() => null);
      if (stat === null || stat.size > MAX_FILE_BYTES) continue;
      const rgba = await readPng(full);
      if (!("skip" in rgba))
        counts.push(
          `${NodePath.relative(pack, full)} ${rgba.width}x${rgba.height} ${colourText(measure(rgba).colours)}`,
        );
    }
    if (counts.length > 0)
      styleLines.push(
        `Style source ${entry.name} (named in VISION.md, under ${laneLibrary(lane)}), colours per image: ${counts.join("; ")}${images.length > MAX_STYLE_IMAGES ? ` (${images.length - MAX_STYLE_IMAGES} more not measured)` : ""}.`,
      );
  }

  const opposite = { top: "below", left: "to the right", right: "to the left" } as const;
  const cropped = shots.flatMap((s) => {
    const cuts = cutEdges(s.m);
    return cuts.length === 0
      ? []
      : [
          `${s.path} ${cuts.map((c) => `${c.side} (${s.m.edges[c.side]} px along it, ${c.clear} px clear ${opposite[c.side]})`).join(", ")}`,
        ];
  });
  const dark = shots
    .filter((s) => s.m.luminance !== null && s.m.luminance < DARK)
    .map((s) => `${s.path} ${Math.round(s.m.luminance!)}`);
  const notable: string[] = [];
  if (cropped.length > 0)
    notable.push(
      `Transparent-background images whose visible pixels touch the top or a side edge while the opposite side stays clear: ${capped(cropped)}.`,
    );
  if (nearIdentical.length > 0)
    notable.push(
      `Frame pairs with a frame difference under ${NEAR_IDENTICAL} (mean absolute RGBA, 0-255, over visible pixels): ${capped(nearIdentical)}.`,
    );
  if (mixedOrDrift.length > 0)
    notable.push(
      `Frame families with mixed canvas sizes or an anchor moving over 2 px: ${capped(mixedOrDrift)}.`,
    );
  if (dark.length > 0)
    notable.push(`Mean luminance of visible pixels under ${DARK} (0-255): ${capped(dark)}.`);
  if (styleLines.length > 0 && shots.length > 0) {
    const most = [...shots].sort((a, b) => b.m.colours - a.m.colours).slice(0, 5);
    notable.push(
      ...styleLines,
      `The game's own images: median ${colourText(median(shots.map((s) => s.m.colours)))} colours per image; most: ${most.map((s) => `${s.path} ${colourText(s.m.colours)}`).join("; ")}.`,
    );
  }
  const header = `${shots.length} images measured under ${laneAssets(lane)}/ (library packs aside; paths below are relative to it; visible means alpha >= ${VISIBLE_ALPHA}).${
    skipped.size > 0
      ? ` Not measured: ${[...skipped].map(([reason, n]) => `${n} ${reason}`).join(", ")}.`
      : ""
  }`;
  if (shots.length === 0) return { full: header, notable: "" };
  const notableText = take(notable, NOTABLE_BUDGET);
  return {
    full: take(
      [
        header,
        ...notable,
        `Frame families (frame difference: mean absolute RGBA difference, 0-255, over the pixels visible in either frame):`,
        ...(familyLines.length > 0 ? familyLines : ["none"]),
        "Images:",
        ...shots.map(imageLine),
      ],
      TEXT_BUDGET,
    ),
    notable:
      notable.length === 0 ? "" : `Measured image facts: ${notableText.replaceAll("\n", " ")}`,
  };
};
