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
// Unfiltered bytes of a 2048x2048 8-bit RGBA image: a 16-bit image of that size is over it.
const MAX_RAW_BYTES = 2048 * (2048 * 4 + 1);
const MAX_TOTAL_PIXELS = 24 * 1024 * 1024;
const MAX_STYLE_IMAGES = 12;
const MAX_STYLE_TRIES = 24;
const MAX_STYLE_PIXELS = 8 * 1024 * 1024;
const COLOUR_CAP = 4096;
// Below this alpha a pixel counts as background; soft render fringes stay out of the box.
const VISIBLE_ALPHA = 16;
// A background is "transparent" only when a real share of the canvas is; tiles stay out of the edge facts.
const TRANSPARENT_SHARE = 0.1;
const NEAR_IDENTICAL = 3;
const DARK = 40;
const TEXT_BUDGET = 6000;
const LINE_ITEMS = 6;
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
  if (
    trns !== null &&
    (type === 0
      ? trns.length !== 2
      : type === 2
        ? trns.length !== 6
        : type === 3
          ? trns.length > entries
          : true)
  )
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

const readHead = async (full: string): Promise<Buffer | null> => {
  const handle = await NodeFSP.open(full, "r").catch(() => null);
  if (handle === null) return null;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(33), 0, 33, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
};

/**
 * PNGs within a shared pixel budget. `admit` reads only the 33-byte header and checks it
 * against the caps and the budget left, so a folder of huge files costs a header read each;
 * `load` decodes an admitted file after a turn of the event loop.
 */
const loader = (budget: number) => {
  const skipped = new Map<string, number>();
  const skip = (reason: string, n = 1) => {
    skipped.set(reason, (skipped.get(reason) ?? 0) + n);
    return null;
  };
  const admitted = new Map<string, number>();
  let left = budget;
  const refuse = (reason: string) => {
    skip(reason);
    return false;
  };
  const admit = async (full: string): Promise<boolean> => {
    const stat = await NodeFSP.stat(full).catch(() => null);
    const reason =
      stat === null
        ? "unreadable"
        : stat.size > MAX_FILE_BYTES
          ? "over 16 MB"
          : /\.png$/i.test(full)
            ? null
            : `not a PNG (${NodePath.extname(full).slice(1)})`;
    if (reason !== null) return refuse(reason);
    const head = await readHead(full);
    const header = head === null ? UNREADABLE : pngHeader(head);
    if ("skip" in header) return refuse(header.skip);
    const pixels = header.width * header.height;
    if (overCap(header)) return refuse("over the 2048x2048 8-bit RGBA cap");
    if (pixels > left) return refuse("over the total pixel budget");
    left -= pixels;
    admitted.set(full, pixels);
    return true;
  };
  const load = async (full: string): Promise<Rgba | null> => {
    const pixels = admitted.get(full);
    if (pixels === undefined) return null;
    await yieldLoop();
    const file = await NodeFSP.readFile(full).catch(() => null);
    if (file === null) return skip("unreadable");
    const decoded = await decodePng(file, pixels);
    return "skip" in decoded ? skip(decoded.skip) : decoded;
  };
  return { admit, load, skipped, skip };
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

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const listed = (items: ReadonlyArray<string>) =>
  `${items.slice(0, LINE_ITEMS).join("; ")}${items.length > LINE_ITEMS ? `; and ${items.length - LINE_ITEMS} more` : ""}`;

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/** Every line keeps a fair share of the budget, cut short rather than dropped. */
const fit = (lines: ReadonlyArray<string>, budget: number): string[] => {
  const out = [...lines];
  let left = budget - Math.max(0, lines.length - 1);
  const order = lines.map((_, i) => i).sort((a, b) => lines[a]!.length - lines[b]!.length);
  for (const [k, i] of order.entries()) {
    const share = Math.floor(left / (order.length - k));
    if (out[i]!.length > share) out[i] = `${out[i]!.slice(0, Math.max(0, share - 1))}…`;
    left -= out[i]!.length;
  }
  return out;
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

/** Folders take turns so one big folder cannot fill a cap; `spread` also samples across each folder. */
const roundRobin = (files: ReadonlyArray<string>, spread = false): string[] => {
  const folders = new Map<string, string[]>();
  for (const full of files) {
    const dir = NodePath.dirname(full);
    folders.set(dir, [...(folders.get(dir) ?? []), full]);
  }
  // Golden-ratio order: any prefix of a folder spans the whole folder, not its first names.
  const lists = [...folders.values()].map((list) =>
    spread
      ? list
          .map((full, i) => ({ full, at: (i * 0.618_033_988_75) % 1 }))
          .sort((a, b) => a.at - b.at)
          .map((x) => x.full)
      : list,
  );
  const out: string[] = [];
  for (let i = 0; out.length < files.length; i++)
    for (const list of lists) if (i < list.length) out.push(list[i]!);
  return out;
};

/** Measures, and pools the colours of a transparent-background image into `pool`. */
const measurePooled = (rgba: Rgba, pool: Set<number>): Measure => {
  const own = new Set<number>();
  const m = measure(rgba, own);
  if (hasBackground(m))
    for (const colour of own) {
      if (pool.size > COLOUR_CAP) break;
      pool.add(colour);
    }
  return m;
};

const sizesText = (ms: ReadonlyArray<Measure>) => {
  const counts = new Map<string, number>();
  for (const m of ms)
    counts.set(`${m.width}x${m.height}`, (counts.get(`${m.width}x${m.height}`) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  return `${sorted
    .slice(0, 3)
    .map(([size, n]) => (n > 1 ? `${size} (${n})` : size))
    .join(", ")}${sorted.length > 3 ? ` and ${sorted.length - 3} more sizes` : ""}`;
};

/**
 * How far the opaque box travels as a whole across a numbered set: each file counts only the
 * part of its move from the first file that both opposite edges share, so a box that grows or
 * shrinks (a pulsing glow, a swinging arm) is not a shift.
 */
const wholeShift = (lo: ReadonlyArray<number>, hi: ReadonlyArray<number>) => {
  const moves = lo.map((l, i) => {
    const a = l - lo[0]!;
    const b = hi[i]! - hi[0]!;
    return Math.sign(a) === Math.sign(b) ? Math.sign(a) * Math.min(Math.abs(a), Math.abs(b)) : 0;
  });
  return Math.max(...moves) - Math.min(...moves);
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Where a pack id first appears in `text` as a whole name, or -1. */
const mentionAt = (text: string, id: string) =>
  text.search(new RegExp(`(^|[^\\w-])${escapeRegExp(id)}($|[^\\w-])`));

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
  const game = loader(MAX_TOTAL_PIXELS);

  // Files ASSETS.md lists come first, so the cap and the budget go to the set the game uses.
  const assetsDoc = await NodeFSP.readFile(NodePath.join(root, "ASSETS.md"), "utf8").catch(
    () => "",
  );
  const listedInDoc = (full: string) => assetsDoc.includes(NodePath.basename(full));
  const measured = [
    ...roundRobin(files.filter(listedInDoc)),
    ...roundRobin(files.filter((full) => !listedInDoc(full))),
  ].slice(0, MAX_IMAGES);
  if (files.length > MAX_IMAGES) game.skip("over the image cap", files.length - MAX_IMAGES);
  for (const full of measured) await game.admit(full);
  measured.sort();

  // A numbered set is the same name with a trailing _N in one folder: frames or variants.
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
  const pool = new Set<number>();
  const shots: Shot[] = [];
  const familyLines: string[] = [];
  const smallDifference: string[] = [];
  const mixedSizes: string[] = [];
  const shifted: string[] = [];
  const framed = new Set<string>();
  for (const [key, frames] of families) {
    if (frames.length < 2) continue;
    frames.sort((a, b) => a.n - b.n);
    const label = `${rel(key)}_${frames[0]!.tag}..${frames.at(-1)!.tag}`;
    const sizes = new Set<string>();
    const boxes: Array<NonNullable<Measure["box"]>> = [];
    const diffs: Array<{ d: number; pair: string }> = [];
    let prev: { rgba: Rgba; tag: string } | null = null;
    for (const frame of frames) {
      framed.add(frame.full);
      const rgba = await game.load(frame.full);
      if (rgba === null) continue;
      const m = measurePooled(rgba, pool);
      shots.push({ path: rel(frame.full), m });
      sizes.add(`${m.width}x${m.height}`);
      if (m.box !== null) boxes.push(m.box);
      if (prev !== null) {
        // Measuring and differencing a 2048x2048 pair each take tens of ms: one per loop turn.
        await yieldLoop();
        const d = frameDifference(prev.rgba, rgba);
        if (d !== null) diffs.push({ d, pair: `${prev.tag}->${frame.tag}` });
      }
      prev = { rgba, tag: frame.tag };
    }
    const parts = [
      `${label} (${frames.length} files): ${sizes.size === 1 ? `canvas ${[...sizes][0]} in all` : `canvas sizes ${[...sizes].join(", ")}`}`,
    ];
    if (sizes.size > 1) mixedSizes.push(`${label} ${[...sizes].join("/")}`);
    if (boxes.length > 1) {
      const span = (values: number[]) => Math.round(Math.max(...values) - Math.min(...values));
      const widths = boxes.map((b) => b.x1 - b.x0 + 1);
      const heights = boxes.map((b) => b.y1 - b.y0 + 1);
      const sx = wholeShift(
        boxes.map((b) => b.x0),
        boxes.map((b) => b.x1),
      );
      const sy = wholeShift(
        boxes.map((b) => b.y0),
        boxes.map((b) => b.y1),
      );
      parts.push(
        `opaque box ${Math.min(...widths)}-${Math.max(...widths)} x ${Math.min(...heights)}-${Math.max(...heights)} px, its bottom edge moves ${span(boxes.map((b) => b.y1))} px and its horizontal centre ${span(boxes.map((b) => (b.x0 + b.x1) / 2))} px, whole-box shift ${sx} px in x and ${sy} px in y`,
      );
      const large = (shift: number, sizes: number[]) => shift > Math.max(2, 0.1 * median(sizes));
      if (large(sx, widths) || large(sy, heights))
        shifted.push(`${label} ${sx} px in x, ${sy} px in y`);
    }
    if (diffs.length > 0) {
      const min = diffs.reduce((a, b) => (b.d < a.d ? b : a));
      parts.push(
        `difference min ${min.d.toFixed(1)} (${min.pair}), median ${median(diffs.map((x) => x.d)).toFixed(1)}`,
      );
      const close = diffs.filter((x) => x.d < NEAR_IDENTICAL);
      if (close.length > 0)
        smallDifference.push(
          `${label} ${close
            .slice(0, 4)
            .map((x) => `${x.pair} ${x.d.toFixed(1)}`)
            .join(", ")}${close.length > 4 ? ` and ${close.length - 4} more pairs` : ""}`,
        );
    }
    familyLines.push(parts.join("; "));
  }
  for (const full of measured) {
    if (framed.has(full)) continue;
    const rgba = await game.load(full);
    if (rgba !== null) shots.push({ path: rel(full), m: measurePooled(rgba, pool) });
  }
  // Listed files lead the image lines too, so the text budget drops unlisted ones first.
  const listedPath = (path: string) => (listedInDoc(path) ? 0 : 1);
  shots.sort((a, b) => listedPath(a.path) - listedPath(b.path) || a.path.localeCompare(b.path));

  // The style source is the first pack named after "style source" on a VISION.md line, so a
  // pack the same line rules out is not taken for it; failing that, packs VISION.md names
  // anywhere are compared, labelled only as named.
  const vision = await NodeFSP.readFile(NodePath.join(root, "VISION.md"), "utf8").catch(() => "");
  const packs = (await NodeFSP.readdir(library, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const sources = new Set<string>();
  for (const line of vision.split("\n")) {
    const at = line.search(/style[ -]?source/i);
    if (at < 0) continue;
    const after = line.slice(at);
    const first = packs
      .map((id) => ({ id, at: mentionAt(after, id) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at)[0];
    if (first !== undefined) sources.add(first.id);
  }
  const compared =
    sources.size > 0 ? [...sources] : packs.filter((id) => mentionAt(vision, id) >= 0);
  const named = sources.size > 0 ? "the style source VISION.md names" : "a pack VISION.md names";
  // The pack is a reference, so its decodes have their own budget and stay out of the skip counts.
  const reference = loader(MAX_STYLE_PIXELS);
  const packParts: string[] = [];
  for (const id of compared) {
    const images = (await listImages(NodePath.join(library, id), null)).filter((f) =>
      /\.png$/i.test(f),
    );
    const packPool = new Set<number>();
    const kept: Measure[] = [];
    let tried = 0;
    for (const full of roundRobin(images, true)) {
      if (kept.length >= MAX_STYLE_IMAGES || tried >= MAX_STYLE_TRIES) break;
      tried++;
      if (!(await reference.admit(full))) continue;
      const rgba = await reference.load(full);
      if (rgba === null) continue;
      const m = measurePooled(rgba, packPool);
      if (hasBackground(m)) kept.push(m);
    }
    packParts.push(
      kept.length === 0
        ? `${id} (${named}): no transparent-background image among ${tried} of its ${images.length} PNGs`
        : `${id} (${named}): ${colourText(packPool.size)} over ${plural(kept.length, "image")} (${sizesText(kept)}) sampled across its ${images.length} PNGs`,
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
      `Transparent-background images whose visible pixels touch the top or a side edge while the opposite side stays clear (the shape of a cut-off render; edge contact is also by design for sprite sheets, cursors, bar pieces and effects meant to meet an edge): ${listed(cropped)}.`,
    );
  if (mixedSizes.length > 0)
    notable.push(
      `Files numbered name_N (animation frames or variants) whose canvas sizes differ: ${listed(mixedSizes)}.`,
    );
  if (shifted.length > 0)
    notable.push(
      `Files numbered name_N whose opaque box shifts as a whole (both opposite edges moving the same way) by over a tenth of its size: ${listed(shifted)}.`,
    );
  if (smallDifference.length > 0)
    notable.push(
      `Consecutive files numbered name_N differing by under ${NEAR_IDENTICAL} (mean absolute RGBA difference, 0-255, over visible pixels): ${listed(smallDifference)}.`,
    );
  if (dark.length > 0)
    notable.push(`Mean luminance of visible pixels under ${DARK} (0-255): ${listed(dark)}.`);
  if (packParts.length > 0 && shots.length > 0) {
    const transparent = shots.filter((s) => hasBackground(s.m));
    const most = [...transparent].sort((a, b) => b.m.colours - a.m.colours).slice(0, 3);
    notable.push(
      `Distinct colours (RGBA values of visible pixels, pooled over each side's transparent-background images, so a sheet and its separate tiles count alike), library pack against the game: ${packParts.join("; ")}; the game's own under ${laneAssets(lane)}: ${
        transparent.length === 0
          ? "no transparent-background image"
          : `${colourText(pool.size)} over ${plural(transparent.length, "image")} (${sizesText(transparent.map((s) => s.m))}); most in one image: ${most.map((s) => `${s.path} ${colourText(s.m.colours)}`).join(", ")}`
      }.`,
    );
  }
  const header = `${shots.length} images measured under ${laneAssets(lane)}/ (library packs aside; paths below are relative to it; visible means alpha >= ${VISIBLE_ALPHA}).${
    game.skipped.size > 0
      ? ` Not measured: ${[...game.skipped].map(([reason, n]) => `${n} ${reason}`).join(", ")}.`
      : ""
  }`;
  if (shots.length === 0) return { full: header, notable: "" };
  const lead = "Measured image facts: ";
  return {
    full: take(
      [
        header,
        ...fit(notable, NOTABLE_BUDGET * 2),
        `Files numbered name_N (animation frames or variants). Difference: mean absolute RGBA difference, 0-255, between consecutive files over the pixels visible in either. Whole-box shift: how far the opaque box moves with both opposite edges moving the same way, so growing or shrinking is not a shift:`,
        ...(familyLines.length > 0 ? familyLines : ["none"]),
        "Images:",
        ...shots.map(imageLine),
      ],
      TEXT_BUDGET,
    ),
    notable:
      notable.length === 0 ? "" : `${lead}${fit(notable, NOTABLE_BUDGET - lead.length).join(" ")}`,
  };
};
