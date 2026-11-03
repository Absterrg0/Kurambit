// @effect-diagnostics nodeBuiltinImport:off -- Pure pixel work on decoded PNGs; node:zlib encodes.
// The deterministic half of game_blender_render_sprites: Blender renders large, this turns the
// renders into pixel art (downscale, hard alpha, a palette shared by every frame, an outline) and
// draws the contact sheet. Same input, same bytes.
import * as NodeZlib from "node:zlib";
import type { Rgba } from "./run/spriteFacts.ts";
import type { SpriteCamera, SpriteFit } from "./spriteRenderPy.ts";

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

/** Pixel art has no soft edges: each pixel is fully there or clear. */
export const hardAlpha = (img: Rgba): void => {
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3]! >= HARD_ALPHA) img.data[i + 3] = 255;
    else img.data.fill(0, i, i + 4);
  }
};

const linear = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** OKLab, so "nearest colour" means nearest as seen. */
const oklab = (c: number): readonly [number, number, number] => {
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
export const colourCounts = (images: ReadonlyArray<Rgba>): Array<[number, number]> => {
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

/** The darkest colour as seen, for an outline that reads against the palette. */
export const darkest = (colours: ReadonlyArray<number>): number | null => {
  let best: number | null = null;
  let lightness = Infinity;
  for (const c of colours) {
    const l = oklab(c)[0];
    if (l < lightness || (l === lightness && best !== null && c < best)) {
      lightness = l;
      best = c;
    }
  }
  return best;
};

/** A 1 px outline: every clear pixel beside an opaque one (4-neighbour) takes the colour. In place. */
export const outline = (img: Rgba, colour: number): void => {
  const { width, height, data } = img;
  const solid = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && data[(y * width + x) * 4 + 3]! >= HARD_ALPHA;
  const edge: number[] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (
        !solid(x, y) &&
        (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))
      )
        edge.push((y * width + x) * 4);
  for (const i of edge) data.set([red(colour), green(colour), blue(colour), 255], i);
};

export const hexColour = (hex: string): number | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return m === null ? null : Number.parseInt(m[1]!, 16);
};
export const colourHex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

const chunk = (name: string, body: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(name, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(NodeZlib.crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
};

/** 8-bit RGBA PNG, no filtering, fixed deflate level: the same pixels give the same bytes. */
export const encodePng = (img: Rgba): Buffer => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++)
    raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", NodeZlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/** Frames side by side, one row per view: the strip as an engine loads a sheet. */
export const sheet = (rows: ReadonlyArray<ReadonlyArray<Rgba>>): Rgba => {
  const w = rows[0]![0]!.width;
  const h = rows[0]![0]!.height;
  const columns = Math.max(...rows.map((r) => r.length));
  const out: Rgba = {
    width: w * columns,
    height: h * rows.length,
    data: new Uint8Array(w * columns * h * rows.length * 4),
  };
  rows.forEach((row, ry) =>
    row.forEach((img, cx) => {
      for (let y = 0; y < h; y++)
        out.data.set(
          img.data.subarray(y * w * 4, (y + 1) * w * 4),
          ((ry * h + y) * out.width + cx * w) * 4,
        );
    }),
  );
  return out;
};

/**
 * Every frame enlarged by a whole number on a checker, one row per view, with each row's
 * ground line (-1 for none) drawn behind the sprite in red: what a reviewer needs to judge framing, drift and colour.
 */
export const contactSheet = (
  rows: ReadonlyArray<ReadonlyArray<Rgba>>,
  anchorRows: ReadonlyArray<number>,
  maxWidth = 1280,
): { image: Rgba; zoom: number } => {
  const w = rows[0]![0]!.width;
  const h = rows[0]![0]!.height;
  const columns = Math.max(...rows.map((r) => r.length));
  const gap = 6;
  const zoom = Math.max(
    1,
    Math.min(8, Math.floor((maxWidth - gap) / (columns * w + gap * columns))),
  );
  const cw = w * zoom;
  const ch = h * zoom;
  const width = gap + columns * (cw + gap);
  const height = gap + rows.length * (ch + gap);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([24, 24, 28, 255], i);
  const square = Math.max(4, zoom * 4);
  rows.forEach((row, ry) =>
    row.forEach((img, cx) => {
      const ox = gap + cx * (cw + gap);
      const oy = gap + ry * (ch + gap);
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

export interface Framing {
  /** World units per output pixel, the same in every frame and view. */
  readonly unitsPerPixel: number;
  readonly orthoScale: number;
  readonly cameras: ReadonlyArray<SpriteCamera>;
  /** Per view: the output pixel row the subject stands on (feet) or is centred on, and the centre column. */
  readonly anchors: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly kind: "feet" | "center";
  }>;
}

/**
 * Fixed orthographic cameras fitted to the union of the subject's extents across every frame:
 * nothing is cut off, one scale serves every frame and view, and the anchor never moves.
 * `inset` is the clear border in output pixels on every side.
 */
export const frameCameras = (
  fit: SpriteFit,
  width: number,
  height: number,
  inset: number,
  anchors: ReadonlyArray<"feet" | "center">,
): Framing | null => {
  const room = { x: width - 2 * inset, y: height - 2 * inset };
  if (room.x < 1 || room.y < 1) return null;
  const unitsPerPixel = Math.max(
    ...fit.views.map((v) => Math.max((v.x1 - v.x0) / room.x, (v.y1 - v.y0) / room.y)),
  );
  if (!(unitsPerPixel > 0) || !Number.isFinite(unitsPerPixel)) return null;
  const cameras = fit.views.map((v, i) => {
    const { right: r, up: u, forward: f } = fit.basis[i]!;
    const cx = (v.x0 + v.x1) / 2;
    const cy =
      anchors[i] === "feet" ? v.y0 + (height / 2 - inset) * unitsPerPixel : (v.y0 + v.y1) / 2;
    const depth = v.d1 - v.d0;
    const pad = Math.max(0.5, depth * 0.1);
    const at = (k: number) => cx * r[k]! + cy * u[k]! + (v.d0 - pad) * f[k]!;
    return {
      view: v.name,
      matrix: [0, 1, 2].map((k) => [r[k]!, u[k]!, -f[k]!, at(k)]).concat([[0, 0, 0, 1]]),
      clipEnd: depth + 2 * pad,
    };
  });
  return {
    unitsPerPixel,
    orthoScale: unitsPerPixel * Math.max(width, height),
    cameras,
    anchors: anchors.map((kind) => ({
      x: width / 2,
      y: kind === "feet" ? height - inset : height / 2,
      kind,
    })),
  };
};
