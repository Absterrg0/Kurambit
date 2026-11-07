// @effect-diagnostics nodeBuiltinImport:off -- PNGs decode in process with node:zlib.
// Measured facts on one image (its box, edges and colours, and how two frames
// differ): numbers, never verdicts. Blender's sprite render checks its frames
// with them. PNGs decode in process (node:zlib), so no tool is needed.
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";

const MAX_IMAGE_PIXELS = 2048 * 2048;
// Unfiltered bytes of a 2048x2048 8-bit RGBA image: a 16-bit image of that size is over it.
const MAX_RAW_BYTES = 2048 * (2048 * 4 + 1);
const COLOUR_CAP = 4096;
// Below this alpha a pixel counts as background; soft render fringes stay out of the box.
const VISIBLE_ALPHA = 16;
// A background is "transparent" only when a real share of the canvas is; tiles stay out of the edge facts.
const TRANSPARENT_SHARE = 0.1;

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

/** `colours`, when given, collects the distinct visible RGBA values, capped like the count. */
export const measure = ({ width, height, data }: Rgba, colours = new Set<number>()): Measure => {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  let visible = 0;
  let luma = 0;
  const edges = { top: 0, bottom: 0, left: 0, right: 0 };
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

type Skip = { readonly skip: string };
type Decoded = Rgba | Skip;

interface Header {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly type: number;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// The bit depths the PNG spec allows for each colour type; any other pair is a broken file.
const DEPTHS: Record<number, ReadonlyArray<number>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
const UNREADABLE: Skip = { skip: "unreadable PNG" };
// A real PNG has a few thousand chunks at most; a file of millions of empty ones is not walked.
const MAX_CHUNKS = 65536;
// Rows of unfiltered bytes decoded between yields, so a big image never holds the event loop long.
const YIELD_BYTES = 1024 * 1024;

const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const crcOk = (file: Buffer, at: number, length: number) =>
  NodeZlib.crc32(file.subarray(at + 4, at + 8 + length)) === file.readUInt32BE(at + 8 + length);
const rawBytes = ({ width, height, depth, type }: Header) =>
  height * (Math.ceil((width * CHANNELS[type]! * depth) / 8) + 1);

/** The IHDR, read from the first 33 bytes, or why the file is not a PNG this decoder reads. */
export const pngHeader = (file: Buffer): Header | Skip => {
  if (file.length < 8 || file.readUInt32BE(0) !== 0x89504e47 || file.readUInt32BE(4) !== 0x0d0a1a0a)
    return { skip: "not a PNG" };
  if (file.length < 33 || file.readUInt32BE(8) !== 13 || file.toString("latin1", 12, 16) !== "IHDR")
    return UNREADABLE;
  if (!crcOk(file, 8, 13)) return UNREADABLE;
  const width = file.readUInt32BE(16);
  const height = file.readUInt32BE(20);
  const depth = file[24]!;
  const type = file[25]!;
  if (width === 0 || height === 0 || file[26] !== 0 || file[27] !== 0 || file[28]! > 1)
    return UNREADABLE;
  if (DEPTHS[type]?.includes(depth) !== true) return UNREADABLE;
  if (file[28] === 1) return { skip: "interlaced PNG" };
  return { width, height, depth, type };
};

/** Whether a header fits one image's caps: pixels, and unfiltered bytes so 16-bit counts double. */
const overCap = (header: Header) =>
  header.width * header.height > MAX_IMAGE_PIXELS || rawBytes(header) > MAX_RAW_BYTES;

/** Non-interlaced PNG of any colour type and bit depth to 8-bit RGBA; anything else is a named skip.
 * A corrupt, truncated or invalid file is a skip, never a failure or invented numbers. */
export const decodePng = (file: Buffer, maxPixels = MAX_IMAGE_PIXELS): Promise<Decoded> =>
  decode(file, maxPixels).catch(() => UNREADABLE);

const decode = async (file: Buffer, maxPixels: number): Promise<Decoded> => {
  const header = pngHeader(file);
  if ("skip" in header) return header;
  const { width, height, depth, type } = header;
  if (overCap(header) || width * height > maxPixels) return { skip: "over the pixel cap" };
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  let chunks = 0;
  for (let at = 33; at < file.length;) {
    if (at + 12 > file.length || ++chunks > MAX_CHUNKS) return UNREADABLE;
    const length = file.readUInt32BE(at);
    if (at + 12 + length > file.length) return UNREADABLE;
    const name = file.toString("latin1", at + 4, at + 8);
    const body = file.subarray(at + 8, at + 8 + length);
    // Critical chunks and tRNS feed the pixels, so their CRCs are checked; ancillary ones are skipped.
    if (["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(name) && !crcOk(file, at, length))
      return UNREADABLE;
    if (name === "IHDR") return UNREADABLE;
    if (name === "PLTE") {
      if (length === 0 || length % 3 !== 0 || length > 768) return UNREADABLE;
      palette = body;
    } else if (name === "tRNS") trns = body;
    else if (name === "IDAT") idat.push(body);
    else if (name === "IEND") break;
    at += 12 + length;
  }
  if (idat.length === 0 || (type === 3 && palette === null)) return UNREADABLE;
  const entries = palette === null ? 0 : palette.length / 3;
  // As libpng: tRNS is ignored where the pixels carry alpha (types 4 and 6),
  // and an over-long palette tRNS is cut to the palette.
  if (type === 4 || type === 6) trns = null;
  else if (type === 3 && trns !== null && trns.length > entries) trns = trns.subarray(0, entries);
  if (trns !== null && (type === 0 ? trns.length !== 2 : type === 2 ? trns.length !== 6 : false))
    return UNREADABLE;
  const channels = CHANNELS[type]!;
  const bits = channels * depth;
  const stride = Math.ceil((width * bits) / 8);
  const step = Math.max(1, bits >> 3);
  let raw: Buffer;
  try {
    // The output cap stops a small file from inflating past its declared size.
    raw = await inflate(Buffer.concat(idat), { maxOutputLength: height * (stride + 1) + 1024 });
  } catch {
    return UNREADABLE;
  }
  if (raw.length < height * (stride + 1)) return UNREADABLE;
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
  let sinceYield = 0;
  for (let y = 0; y < height; y++) {
    sinceYield += stride;
    if (sinceYield > YIELD_BYTES) {
      sinceYield = 0;
      await yieldLoop();
    }
    const base = y * (stride + 1);
    const filter = raw[base]!;
    if (filter > 4) return UNREADABLE;
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
        if (index >= entries) return UNREADABLE;
        out[o] = palette![index * 3]!;
        out[o + 1] = palette![index * 3 + 1]!;
        out[o + 2] = palette![index * 3 + 2]!;
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
