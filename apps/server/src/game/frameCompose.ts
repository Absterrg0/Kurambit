// @effect-diagnostics nodeBuiltinImport:off -- Pair cards read the PNG the playtest captured.
import * as NodeFSP from "node:fs/promises";
import { PNG } from "pngjs";

/**
 * Ballot evidence shows an input's before and after as two files. One card per
 * pair cuts the files a ballot opens in half and makes the causal comparison
 * the first thing it reads, so a still frame is never judged on its own.
 *
 * The composition is deliberately plain: PNG bytes in, PNG bytes out, no
 * network, no browser and no engine. It draws its own labels so a card stays
 * readable without the manifest.
 */

const BACKGROUND = { r: 16, g: 20, b: 24, a: 255 } as const;
const LABEL = { r: 238, g: 242, b: 245, a: 255 } as const;
const DIVIDER = { r: 64, g: 72, b: 80, a: 255 } as const;

const SCALE = 4;
const GLYPH_WIDTH = 3;
const GLYPH_HEIGHT = 5;
const GLYPH_ADVANCE = GLYPH_WIDTH * SCALE + 2;
const LINE_HEIGHT = GLYPH_HEIGHT * SCALE;
const PADDING = 8;
const GAP = 8;

/**
 * A 3x5 uppercase font. Three pixels a row keeps labels legible at three times
 * the scale on a 960-wide capture without an image or font dependency.
 */
const GLYPHS: Readonly<Record<string, ReadonlyArray<number>>> = {
  A: [0b111, 0b101, 0b111, 0b101, 0b101],
  B: [0b110, 0b101, 0b110, 0b101, 0b110],
  C: [0b111, 0b100, 0b100, 0b100, 0b111],
  D: [0b110, 0b101, 0b101, 0b101, 0b110],
  E: [0b111, 0b100, 0b111, 0b100, 0b111],
  F: [0b111, 0b100, 0b111, 0b100, 0b100],
  G: [0b111, 0b100, 0b101, 0b101, 0b111],
  H: [0b101, 0b101, 0b111, 0b101, 0b101],
  I: [0b111, 0b010, 0b010, 0b010, 0b111],
  J: [0b001, 0b001, 0b001, 0b101, 0b111],
  K: [0b101, 0b101, 0b110, 0b101, 0b101],
  L: [0b100, 0b100, 0b100, 0b100, 0b111],
  M: [0b101, 0b111, 0b111, 0b101, 0b101],
  N: [0b110, 0b101, 0b101, 0b101, 0b101],
  O: [0b111, 0b101, 0b101, 0b101, 0b111],
  P: [0b111, 0b101, 0b111, 0b100, 0b100],
  Q: [0b111, 0b101, 0b101, 0b111, 0b001],
  R: [0b111, 0b101, 0b111, 0b110, 0b101],
  S: [0b011, 0b100, 0b010, 0b001, 0b110],
  T: [0b111, 0b010, 0b010, 0b010, 0b010],
  U: [0b101, 0b101, 0b101, 0b101, 0b111],
  V: [0b101, 0b101, 0b101, 0b101, 0b010],
  W: [0b101, 0b101, 0b111, 0b111, 0b101],
  X: [0b101, 0b101, 0b010, 0b101, 0b101],
  Y: [0b101, 0b101, 0b010, 0b010, 0b010],
  Z: [0b111, 0b001, 0b010, 0b100, 0b111],
  "0": [0b111, 0b101, 0b101, 0b101, 0b111],
  "1": [0b010, 0b110, 0b010, 0b010, 0b111],
  "2": [0b111, 0b001, 0b111, 0b100, 0b111],
  "3": [0b111, 0b001, 0b111, 0b001, 0b111],
  "4": [0b101, 0b101, 0b111, 0b001, 0b001],
  "5": [0b111, 0b100, 0b111, 0b001, 0b111],
  "6": [0b111, 0b100, 0b111, 0b101, 0b111],
  "7": [0b111, 0b001, 0b001, 0b001, 0b001],
  "8": [0b111, 0b101, 0b111, 0b101, 0b111],
  "9": [0b111, 0b101, 0b111, 0b001, 0b111],
  ",": [0b000, 0b000, 0b000, 0b010, 0b100],
  ".": [0b000, 0b000, 0b000, 0b000, 0b010],
  ":": [0b000, 0b010, 0b000, 0b010, 0b000],
  "/": [0b001, 0b001, 0b010, 0b100, 0b100],
  "-": [0b000, 0b000, 0b111, 0b000, 0b000],
  "+": [0b000, 0b010, 0b111, 0b010, 0b000],
  "(": [0b001, 0b010, 0b010, 0b010, 0b001],
  ")": [0b100, 0b010, 0b010, 0b010, 0b100],
};

const glyph = (character: string): ReadonlyArray<number> | null =>
  GLYPHS[character.toUpperCase()] ?? null;

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const fill = (png: PNG, x: number, y: number, width: number, height: number, color: Rgba): void => {
  for (let row = y; row < y + height; row += 1) {
    if (row < 0 || row >= png.height) continue;
    for (let column = x; column < x + width; column += 1) {
      if (column < 0 || column >= png.width) continue;
      const at = (png.width * row + column) * 4;
      png.data[at] = color.r;
      png.data[at + 1] = color.g;
      png.data[at + 2] = color.b;
      png.data[at + 3] = color.a;
    }
  }
};

const drawText = (png: PNG, x: number, y: number, text: string, color: Rgba): void => {
  let cursor = x;
  for (const character of text) {
    const rows = glyph(character);
    if (rows !== null) {
      for (const [row, bits] of rows.entries()) {
        for (let column = 0; column < GLYPH_WIDTH; column += 1) {
          if ((bits & (1 << (GLYPH_WIDTH - column - 1))) === 0) continue;
          fill(png, cursor + column * SCALE, y + row * SCALE, SCALE, SCALE, color);
        }
      }
    }
    cursor += GLYPH_ADVANCE;
  }
};

/** A caption without glyphs the font lacks: uppercase, one line, no surprises. */
export const composeCaption = (text: string): string =>
  text
    .toUpperCase()
    .replace(/[^A-Z0-9 ,.:/+\-()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The height in pixels one drawn label line occupies. */
export const LABEL_LINE_HEIGHT = LINE_HEIGHT;

/** Draws one sanitized label line onto an existing PNG at the given origin. */
export const drawLabel = (
  png: PNG,
  x: number,
  y: number,
  text: string,
  maxWidth?: number,
): void => {
  const caption = composeCaption(text);
  const capacity =
    maxWidth === undefined ? caption.length : Math.max(0, Math.floor(maxWidth / GLYPH_ADVANCE));
  const visible =
    caption.length <= capacity
      ? caption
      : `${caption.slice(0, Math.max(0, capacity - 3))}${".".repeat(Math.min(3, capacity))}`;
  drawText(png, x, y, visible, LABEL);
};

const blit = (target: PNG, source: PNG, x: number, y: number): void => {
  for (let row = 0; row < source.height; row += 1) {
    const targetRow = row + y;
    if (targetRow < 0 || targetRow >= target.height) continue;
    const from = row * source.width * 4;
    const to = (targetRow * target.width + x) * 4;
    source.data.copy(target.data, to, from, from + source.width * 4);
  }
};

export interface ComposedPair {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
}

/**
 * One card for two captures side by side under their own labels and a shared
 * caption. Both captures keep their exact pixels, so a pixel comparison of the
 * card is a comparison of the two runs.
 */
export const composeSideBySidePng = (input: {
  readonly left: Buffer;
  readonly right: Buffer;
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly caption: string;
}): ComposedPair => {
  const left = PNG.sync.read(input.left);
  const right = PNG.sync.read(input.right);
  const caption = composeCaption(input.caption);
  const labelsY = PADDING;
  const captionY = labelsY + LINE_HEIGHT + 4;
  const headerHeight =
    caption === "" ? labelsY + LINE_HEIGHT + PADDING : captionY + LINE_HEIGHT + PADDING;
  const width = left.width + GAP + right.width;
  const height = headerHeight + Math.max(left.height, right.height);
  const png = new PNG({ width, height });
  fill(png, 0, 0, width, height, BACKGROUND);
  drawText(png, PADDING, labelsY, input.leftLabel, LABEL);
  drawText(png, left.width + GAP + PADDING, labelsY, input.rightLabel, LABEL);
  if (caption !== "") drawText(png, PADDING, captionY, caption, LABEL);
  fill(png, 0, headerHeight - 1, width, 1, DIVIDER);
  blit(png, left, 0, headerHeight);
  blit(png, right, left.width + GAP, headerHeight);
  if (left.height < right.height)
    fill(png, 0, headerHeight + left.height, left.width, right.height - left.height, BACKGROUND);
  if (right.height < left.height)
    fill(
      png,
      left.width + GAP,
      headerHeight + right.height,
      right.width,
      left.height - right.height,
      BACKGROUND,
    );
  const bytes = PNG.sync.write(png);
  return { png: bytes, width, height };
};

/**
 * One card for one input: BEFORE | AFTER side by side under their labels and
 * the input that caused the change. Both captures keep their exact pixels.
 */
export const composePairPng = (input: {
  readonly before: Buffer;
  readonly after: Buffer;
  readonly caption: string;
}): ComposedPair =>
  composeSideBySidePng({
    left: input.before,
    right: input.after,
    leftLabel: "BEFORE",
    rightLabel: "AFTER",
    caption: input.caption,
  });

export const composePairFiles = async (input: {
  readonly beforePath: string;
  readonly afterPath: string;
  readonly caption: string;
}): Promise<Buffer> => {
  const [before, after] = await Promise.all([
    NodeFSP.readFile(input.beforePath),
    NodeFSP.readFile(input.afterPath),
  ]);
  return composePairPng({ before, after, caption: input.caption }).png;
};

/** A pixel region inside one evidence frame, in that frame's own pixels. */
export interface DetailRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A channel difference this small is sub-perceptual dither, not an observed
 * effect. PNG evidence is lossless, so anything above it is a real pixel
 * change the reviewer can be shown as a number, never as a verdict.
 */
export const DETAIL_DELTA_THRESHOLD = 4;

/** Exact pixels of one region; throws when the region leaves the image. */
export const cropPng = (source: PNG, region: DetailRegion): PNG => {
  if (
    !Number.isInteger(region.x) ||
    !Number.isInteger(region.y) ||
    !Number.isInteger(region.width) ||
    !Number.isInteger(region.height) ||
    region.x < 0 ||
    region.y < 0 ||
    region.width <= 0 ||
    region.height <= 0 ||
    region.x + region.width > source.width ||
    region.y + region.height > source.height
  )
    throw new Error(
      `Region ${region.width}x${region.height} at ${region.x},${region.y} is outside the ${source.width}x${source.height} frame.`,
    );
  const cropped = new PNG({ width: region.width, height: region.height });
  for (let row = 0; row < region.height; row += 1) {
    const from = ((region.y + row) * source.width + region.x) * 4;
    const to = row * region.width * 4;
    source.data.copy(cropped.data, to, from, from + region.width * 4);
  }
  return cropped;
};

/** Integer nearest-neighbour upscale, so a small effect stays exactly its pixels. */
export const scalePngNearest = (source: PNG, scale: number): PNG => {
  if (!Number.isInteger(scale) || scale < 1)
    throw new Error(`Scale must be a positive integer; received ${scale}.`);
  if (scale === 1) return source;
  const scaled = new PNG({ width: source.width * scale, height: source.height * scale });
  for (let row = 0; row < scaled.height; row += 1) {
    const sourceRow = Math.floor(row / scale);
    for (let column = 0; column < scaled.width; column += 1) {
      const sourceColumn = Math.floor(column / scale);
      const from = (sourceRow * source.width + sourceColumn) * 4;
      const to = (row * scaled.width + column) * 4;
      scaled.data[to] = source.data[from]!;
      scaled.data[to + 1] = source.data[from + 1]!;
      scaled.data[to + 2] = source.data[from + 2]!;
      scaled.data[to + 3] = source.data[from + 3]!;
    }
  }
  return scaled;
};

export type RgbMean = readonly [number, number, number];

const rounded = (value: number): number => Math.round(value * 10) / 10;

/** Mean RGB of every pixel, to one decimal: a measurement, never a verdict. */
export const meanColor = (source: PNG): RgbMean => {
  let red = 0;
  let green = 0;
  let blue = 0;
  const pixels = source.width * source.height;
  for (let at = 0; at < source.data.length; at += 4) {
    red += source.data[at]!;
    green += source.data[at + 1]!;
    blue += source.data[at + 2]!;
  }
  return [rounded(red / pixels), rounded(green / pixels), rounded(blue / pixels)];
};

export interface RegionDelta {
  /** Mean per-channel absolute difference, to one decimal. */
  readonly meanAbs: RgbMean;
  /** Share of pixels whose strongest channel differs past the dither threshold. */
  readonly changedPercent: number;
}

/** Pixel comparison of two equal-size crops; throws when the sizes differ. */
export const deltaStats = (left: PNG, right: PNG): RegionDelta => {
  if (left.width !== right.width || left.height !== right.height)
    throw new Error(
      `Cannot compare a ${left.width}x${left.height} crop with a ${right.width}x${right.height} crop.`,
    );
  let red = 0;
  let green = 0;
  let blue = 0;
  let changed = 0;
  const pixels = left.width * left.height;
  for (let at = 0; at < left.data.length; at += 4) {
    const dr = Math.abs(left.data[at]! - right.data[at]!);
    const dg = Math.abs(left.data[at + 1]! - right.data[at + 1]!);
    const db = Math.abs(left.data[at + 2]! - right.data[at + 2]!);
    red += dr;
    green += dg;
    blue += db;
    if (Math.max(dr, dg, db) > DETAIL_DELTA_THRESHOLD) changed += 1;
  }
  return {
    meanAbs: [rounded(red / pixels), rounded(green / pixels), rounded(blue / pixels)],
    changedPercent: rounded((changed / pixels) * 100),
  };
};
