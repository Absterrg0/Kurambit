// @effect-diagnostics nodeBuiltinImport:off -- PNGs decode in process with node:zlib.
// Pure pixel work on RGBA images: PNGs decode in process (node:zlib) and encode with pngjs;
// downscale, OKLab colour, a shared palette and a contact sheet. Same input, same bytes.
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";
import { PNG } from "pngjs";

const MAX_IMAGE_PIXELS = 2048 * 2048;
// Unfiltered bytes of a 2048x2048 8-bit RGBA image: a 16-bit image of that size is over it.
const MAX_RAW_BYTES = 2048 * (2048 * 4 + 1);

const inflate = NodeUtil.promisify(NodeZlib.inflate);

export interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

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
const pngHeader = (file: Buffer): Header | Skip => {
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

/** Pixels at or above this alpha are kept when alpha goes hard; the rest become clear. */
const HARD_ALPHA = 128;

const pack = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;
const red = (c: number) => (c >> 16) & 255;
const green = (c: number) => (c >> 8) & 255;
const blue = (c: number) => c & 255;

/** Box average over k x k blocks with alpha-weighted colour, or the block's centre pixel. */
export const downscale = (img: Rgba, k: number, mode: "area" | "nearest"): Rgba => {
  if (k === 1) return { width: img.width, height: img.height, data: Uint8Array.from(img.data) };
  const width = Math.floor(img.width / k);
  const height = Math.floor(img.height / k);
  const data = new Uint8Array(width * height * 4);
  const c = Math.floor(k / 2);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (mode === "nearest") {
        const i = ((y * k + c) * img.width + x * k + c) * 4;
        data.set(img.data.subarray(i, i + 4), o);
        continue;
      }
      let a = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < k; dy++)
        for (let dx = 0; dx < k; dx++) {
          const i = ((y * k + dy) * img.width + x * k + dx) * 4;
          const w = img.data[i + 3]!;
          a += w;
          r += img.data[i]! * w;
          g += img.data[i + 1]! * w;
          b += img.data[i + 2]! * w;
        }
      if (a > 0) {
        data[o] = Math.round(r / a);
        data[o + 1] = Math.round(g / a);
        data[o + 2] = Math.round(b / a);
      }
      data[o + 3] = Math.round(a / (k * k));
    }
  return { width, height, data };
};

const linear = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** OKLab, so "nearest colour" means nearest as seen. */
export const oklab = (c: number): readonly [number, number, number] => {
  const r = linear(red(c));
  const g = linear(green(c));
  const b = linear(blue(c));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};

/** Distinct opaque colours across images with their pixel counts, most used first (ties by value). */
const colourCounts = (images: ReadonlyArray<Rgba>): Array<[number, number]> => {
  const counts = new Map<number, number>();
  for (const img of images)
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i + 3]! < HARD_ALPHA) continue;
      const c = pack(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
};

const nearest = (
  c: readonly [number, number, number],
  options: ReadonlyArray<readonly [number, number, number]>,
) => {
  let best = 0;
  let distance = Infinity;
  for (const [i, o] of options.entries()) {
    const d = (c[0] - o[0]) ** 2 + (c[1] - o[1]) ** 2 + (c[2] - o[2]) ** 2;
    if (d < distance) {
      distance = d;
      best = i;
    }
  }
  return best;
};

/** Weighted median cut in RGB: deterministic, and every box keeps its pixels' mean colour. */
const medianCut = (counts: ReadonlyArray<[number, number]>, n: number): number[] => {
  type Box = Array<[number, number]>;
  let boxes: Box[] = [[...counts]];
  const range = (box: Box, ch: (c: number) => number) => {
    let lo = 255;
    let hi = 0;
    for (const [c] of box) {
      lo = Math.min(lo, ch(c));
      hi = Math.max(hi, ch(c));
    }
    return hi - lo;
  };
  while (boxes.length < n) {
    let pick = -1;
    let widest = 0;
    let channel = red;
    for (const [i, box] of boxes.entries()) {
      if (box.length < 2) continue;
      for (const ch of [red, green, blue]) {
        const w = range(box, ch);
        if (w > widest) {
          widest = w;
          pick = i;
          channel = ch;
        }
      }
    }
    if (pick < 0) break;
    const box = [...boxes[pick]!].sort((a, b) => channel(a[0]) - channel(b[0]) || a[0] - b[0]);
    const total = box.reduce((s, [, w]) => s + w, 0);
    let run = 0;
    let cut = 1;
    for (const [i, [, w]] of box.entries()) {
      run += w;
      if (run >= total / 2) {
        cut = Math.min(Math.max(i + 1, 1), box.length - 1);
        break;
      }
    }
    boxes = [...boxes.slice(0, pick), box.slice(0, cut), box.slice(cut), ...boxes.slice(pick + 1)];
  }
  return boxes.map((box) => {
    const total = box.reduce((s, [, w]) => s + w, 0);
    const mean = (ch: (c: number) => number) =>
      Math.round(box.reduce((s, [c, w]) => s + ch(c) * w, 0) / total);
    return pack(mean(red), mean(green), mean(blue));
  });
};

/**
 * One palette for every frame, so colours never flicker across a strip. With a source palette,
 * each colour snaps to its nearest source colour, the `colors` most used are kept and everything
 * is snapped again to those; without one, a median cut of the frames' own colours. In place.
 */
export const quantize = (
  frames: ReadonlyArray<Rgba>,
  source: ReadonlyArray<number> | null,
  colors: number,
): number[] => {
  const counts = colourCounts(frames);
  if (counts.length === 0) return [];
  let kept: number[];
  if (source === null || source.length === 0) kept = medianCut(counts, colors);
  else {
    const labs = source.map(oklab);
    const usage = new Map<number, number>();
    for (const [c, w] of counts) {
      const i = nearest(oklab(c), labs);
      usage.set(i, (usage.get(i) ?? 0) + w);
    }
    kept = [...usage]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, colors)
      .map(([i]) => source[i]!);
  }
  const keptLab = kept.map(oklab);
  const map = new Map<number, number>();
  for (const [c] of counts) map.set(c, kept[nearest(oklab(c), keptLab)]!);
  for (const img of frames)
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i + 3]! < HARD_ALPHA) continue;
      const c = map.get(pack(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!))!;
      img.data[i] = red(c);
      img.data[i + 1] = green(c);
      img.data[i + 2] = blue(c);
    }
  return [...new Set(map.values())];
};

export const hexColour = (hex: string): number | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return m === null ? null : Number.parseInt(m[1]!, 16);
};
export const colourHex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

/** 8-bit RGBA PNG, no filtering, fixed deflate settings: the same pixels give the same bytes. */
export const encodePng = (img: Rgba): Buffer => {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return PNG.sync.write(png, { filterType: 0, deflateLevel: 9, deflateStrategy: 0 });
};

/**
 * Every frame enlarged by a whole number on a checker, each view's frames wrapped into rows of at
 * most 12 that fit `maxWidth`, with each view's ground line (-1 for none) drawn behind the sprite
 * in red: what a reviewer needs to judge framing, drift and colour.
 */
export const contactSheet = (
  rows: ReadonlyArray<ReadonlyArray<Rgba>>,
  anchorRows: ReadonlyArray<number>,
  maxWidth = 1280,
): { image: Rgba; zoom: number } => {
  const w = rows[0]![0]!.width;
  const h = rows[0]![0]!.height;
  const frames = Math.max(...rows.map((r) => r.length));
  const gap = 6;
  // Balanced rows (16 frames are two rows of 8, not 12 and 4), never wider than maxWidth at 1x.
  const fit = Math.max(1, Math.floor((maxWidth - gap) / (w + gap)));
  const columns = Math.min(fit, Math.ceil(frames / Math.ceil(frames / 12)));
  const lines = Math.ceil(frames / columns);
  const zoom = Math.max(1, Math.min(8, Math.floor((maxWidth - gap) / (columns * (w + gap)))));
  const cw = w * zoom;
  const ch = h * zoom;
  const width = gap + columns * (cw + gap);
  const height = gap + rows.length * lines * (ch + gap);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([24, 24, 28, 255], i);
  const square = Math.max(4, zoom * 4);
  rows.forEach((row, ry) =>
    row.forEach((img, fi) => {
      const ox = gap + (fi % columns) * (cw + gap);
      const oy = gap + (ry * lines + Math.floor(fi / columns)) * (ch + gap);
      for (let y = 0; y < ch; y++)
        for (let x = 0; x < cw; x++) {
          const o = ((oy + y) * width + ox + x) * 4;
          const light = (Math.floor(x / square) + Math.floor(y / square)) % 2 === 0;
          let base = light ? [92, 92, 100] : [70, 70, 78];
          if (Math.floor(y / zoom) === anchorRows[ry]) base = [170, 60, 50];
          const i = (Math.floor(y / zoom) * w + Math.floor(x / zoom)) * 4;
          const a = img.data[i + 3]! / 255;
          data[o] = Math.round(img.data[i]! * a + base[0]! * (1 - a));
          data[o + 1] = Math.round(img.data[i + 1]! * a + base[1]! * (1 - a));
          data[o + 2] = Math.round(img.data[i + 2]! * a + base[2]! * (1 - a));
          data[o + 3] = 255;
        }
    }),
  );
  return { image: { width, height, data }, zoom };
};
