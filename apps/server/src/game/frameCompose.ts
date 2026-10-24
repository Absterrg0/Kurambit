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
    const columns = glyph(character);
    if (columns !== null) {
      for (const [column, bits] of columns.entries()) {
        for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
          if ((bits & (1 << row)) === 0) continue;
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
 * One card for one input: BEFORE | AFTER side by side under their labels and
 * the input that caused the change. Both captures keep their exact pixels.
 */
export const composePairPng = (input: {
  readonly before: Buffer;
  readonly after: Buffer;
  readonly caption: string;
}): ComposedPair => {
  const before = PNG.sync.read(input.before);
  const after = PNG.sync.read(input.after);
  const caption = composeCaption(input.caption);
  const labelsY = PADDING;
  const captionY = labelsY + LINE_HEIGHT + 4;
  const headerHeight =
    caption === "" ? labelsY + LINE_HEIGHT + PADDING : captionY + LINE_HEIGHT + PADDING;
  const width = before.width + GAP + after.width;
  const height = headerHeight + Math.max(before.height, after.height);
  const png = new PNG({ width, height });
  fill(png, 0, 0, width, height, BACKGROUND);
  drawText(png, PADDING, labelsY, "BEFORE", LABEL);
  drawText(png, before.width + GAP + PADDING, labelsY, "AFTER", LABEL);
  if (caption !== "") drawText(png, PADDING, captionY, caption, LABEL);
  fill(png, 0, headerHeight - 1, width, 1, DIVIDER);
  blit(png, before, 0, headerHeight);
  blit(png, after, before.width + GAP, headerHeight);
  if (before.height < after.height)
    fill(
      png,
      0,
      headerHeight + before.height,
      before.width,
      after.height - before.height,
      BACKGROUND,
    );
  if (after.height < before.height)
    fill(
      png,
      before.width + GAP,
      headerHeight + after.height,
      after.width,
      before.height - after.height,
      BACKGROUND,
    );
  const bytes = PNG.sync.write(png);
  return { png: bytes, width, height };
};

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
