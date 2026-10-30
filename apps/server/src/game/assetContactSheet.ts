// @effect-diagnostics nodeBuiltinImport:off -- The contact sheet composes the PNG thumbnails Blender already rendered.
import { PNG } from "pngjs";
import { LABEL_LINE_HEIGHT, drawLabel } from "./frameCompose.ts";

const BACKGROUND = { r: 16, g: 20, b: 24, a: 255 } as const;
const CELL = 160;
const PADDING = 8;
const GAP = 8;
export const MAX_CONTACT_SHEET_THUMBNAILS = 64;

export interface ContactSheetCell {
  readonly id: string;
  /** Thumbnail origin inside the sheet, in pixels. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ContactSheet {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  readonly cells: ReadonlyArray<ContactSheetCell>;
}

const fill = (png: PNG, x: number, y: number, width: number, height: number): void => {
  for (let row = y; row < y + height; row += 1) {
    if (row < 0 || row >= png.height) continue;
    for (let column = x; column < x + width; column += 1) {
      if (column < 0 || column >= png.width) continue;
      const at = (png.width * row + column) * 4;
      png.data[at] = BACKGROUND.r;
      png.data[at + 1] = BACKGROUND.g;
      png.data[at + 2] = BACKGROUND.b;
      png.data[at + 3] = BACKGROUND.a;
    }
  }
};

/** Nearest-neighbour blit scaled to fit the cell, centred, keeping pixels crisp. */
const blitFit = (target: PNG, source: PNG, x: number, y: number): void => {
  const fit = Math.min(CELL / source.width, CELL / source.height);
  const scale = fit < 1 ? fit : Math.floor(fit);
  const width = Math.max(1, Math.floor(source.width * scale));
  const height = Math.max(1, Math.floor(source.height * scale));
  const originX = x + Math.floor((CELL - width) / 2);
  const originY = y + Math.floor((CELL - height) / 2);
  for (let row = 0; row < height; row += 1) {
    const sourceRow = Math.floor(row / scale);
    for (let column = 0; column < width; column += 1) {
      const sourceColumn = Math.floor(column / scale);
      const from = (sourceRow * source.width + sourceColumn) * 4;
      const at = ((originY + row) * target.width + (originX + column)) * 4;
      target.data[at] = source.data[from]!;
      target.data[at + 1] = source.data[from + 1]!;
      target.data[at + 2] = source.data[from + 2]!;
      target.data[at + 3] = source.data[from + 3]!;
    }
  }
};

/**
 * One contact sheet for every asset thumbnail: each id keeps its exact pixels
 * under its own label, so a visual comparison of the set needs no engine.
 * Thumbnails are small renders, never game sources, so composing them reads
 * but changes nothing in the game.
 */
export const composeContactSheet = (input: {
  readonly thumbnails: ReadonlyArray<{ readonly id: string; readonly png: Buffer }>;
}): ContactSheet => {
  if (input.thumbnails.length > MAX_CONTACT_SHEET_THUMBNAILS)
    throw new Error("An asset contact sheet can contain at most 64 thumbnails.");
  const images = input.thumbnails;
  const columns = Math.max(1, Math.ceil(Math.sqrt(images.length)));
  const rows = Math.max(1, Math.ceil(images.length / columns));
  const cellWidth = CELL + PADDING * 2;
  const cellHeight = LABEL_LINE_HEIGHT + PADDING + CELL + PADDING;
  const width = columns * cellWidth + GAP;
  const height = rows * cellHeight + GAP;
  const sheet = new PNG({ width, height });
  fill(sheet, 0, 0, width, height);
  const cells: Array<ContactSheetCell> = [];
  images.forEach((entry, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cellX = GAP / 2 + column * cellWidth;
    const cellY = GAP / 2 + row * cellHeight;
    drawLabel(sheet, cellX + PADDING, cellY, entry.id, CELL);
    const thumbY = cellY + LABEL_LINE_HEIGHT + PADDING;
    blitFit(sheet, PNG.sync.read(entry.png), cellX + PADDING, thumbY);
    cells.push({ id: entry.id, x: cellX + PADDING, y: thumbY, width: CELL, height: CELL });
  });
  return { png: PNG.sync.write(sheet), width, height, cells };
};
