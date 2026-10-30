import { expect, it } from "vite-plus/test";
import { PNG } from "pngjs";

import {
  composeCaption,
  composePairPng,
  composeSideBySidePng,
  cropPng,
  deltaStats,
  drawLabel,
  meanColor,
  scalePngNearest,
} from "./frameCompose.ts";

const solid = (width: number, height: number, color: readonly [number, number, number]): Buffer => {
  const png = new PNG({ width, height });
  for (let at = 0; at < png.data.length; at += 4) {
    png.data[at] = color[0];
    png.data[at + 1] = color[1];
    png.data[at + 2] = color[2];
    png.data[at + 3] = 255;
  }
  return PNG.sync.write(png);
};

const pixel = (png: PNG, x: number, y: number) => [
  png.data[(png.width * y + x) * 4],
  png.data[(png.width * y + x) * 4 + 1],
  png.data[(png.width * y + x) * 4 + 2],
  png.data[(png.width * y + x) * 4 + 3],
];

const drawnInk = (png: PNG, top: number): number => {
  let ink = 0;
  for (let at = 0; at < png.width * top * 4; at += 4) {
    if (png.data[at] !== 16 || png.data[at + 1] !== 20 || png.data[at + 2] !== 24) ink += 1;
  }
  return ink;
};

it("composes a labelled before/after card that keeps both captures' pixels", () => {
  const before = solid(160, 90, [200, 20, 20]);
  const after = solid(160, 90, [20, 20, 200]);
  const card = composePairPng({ before, after, caption: "held ArrowRight 1000ms" });
  expect(card.width).toBe(160 + 8 + 160);
  const png = PNG.sync.read(card.png);
  const imageTop = card.height - 90;
  expect(card.height).toBeGreaterThan(90);
  // The exact before and after pixels sit side by side under the header.
  expect(pixel(png, 0, imageTop)).toEqual([200, 20, 20, 255]);
  expect(pixel(png, 159, imageTop)).toEqual([200, 20, 20, 255]);
  expect(pixel(png, 168, imageTop)).toEqual([20, 20, 200, 255]);
  expect(pixel(png, card.width - 1, card.height - 1)).toEqual([20, 20, 200, 255]);
  // BEFORE, AFTER and the input are drawn above the captures.
  expect(drawnInk(png, imageTop)).toBeGreaterThan(100);
  // Same captures and caption always produce the same card.
  expect(
    composePairPng({ before, after, caption: "held ArrowRight 1000ms" }).png.equals(card.png),
  ).toBe(true);
  // A different input draws different labels, so the card is not the same file.
  expect(composePairPng({ before, after, caption: "pressed Space" }).png.equals(card.png)).toBe(
    false,
  );
});

it("captions only use glyphs the card can draw", () => {
  expect(composeCaption("held ArrowRight 1000ms")).toBe("HELD ARROWRIGHT 1000MS");
  expect(composeCaption("drag {from,to} → 500ms")).toBe("DRAG FROM,TO 500MS");
  expect(composeCaption("click (700,120) left")).toBe("CLICK (700,120) LEFT");
});

it("draws readable upright labels within each glyph's width", () => {
  const png = PNG.sync.read(solid(40, 40, [16, 20, 24]));
  drawLabel(png, 8, 8, "H");
  expect(pixel(png, 8, 27)).toEqual([238, 242, 245, 255]);
  expect(pixel(png, 19, 27)).toEqual([238, 242, 245, 255]);
  expect(pixel(png, 20, 8)).toEqual([16, 20, 24, 255]);
});

it("labels both panels of a side-by-side card without touching their pixels", () => {
  const left = solid(120, 60, [200, 20, 20]);
  const right = solid(120, 60, [20, 20, 200]);
  const card = composeSideBySidePng({
    left,
    right,
    leftLabel: "A",
    rightLabel: "B",
    caption: "frame 1 of 6",
  });
  expect(card.width).toBe(120 + 8 + 120);
  const png = PNG.sync.read(card.png);
  const imageTop = card.height - 60;
  expect(pixel(png, 1, imageTop)).toEqual([200, 20, 20, 255]);
  expect(pixel(png, 1 + 128, imageTop)).toEqual([20, 20, 200, 255]);
  // A/B are drawn above their panels: swapping the labels changes the header.
  const swapped = composeSideBySidePng({
    left,
    right,
    leftLabel: "B",
    rightLabel: "A",
    caption: "frame 1 of 6",
  });
  expect(swapped.png.equals(card.png)).toBe(false);
  expect(swapped.height).toBe(card.height);
});

it("crops the exact pixels of a detail region and rejects regions outside the frame", () => {
  const png = PNG.sync.read(solid(64, 48, [101, 113, 175]));
  const cropped = cropPng(png, { x: 8, y: 6, width: 16, height: 12 });
  expect(cropped.width).toBe(16);
  expect(cropped.height).toBe(12);
  expect(pixel(cropped, 0, 0)).toEqual([101, 113, 175, 255]);
  expect(pixel(cropped, 15, 11)).toEqual([101, 113, 175, 255]);
  expect(() => cropPng(png, { x: 60, y: 6, width: 16, height: 12 })).toThrow(/outside/);
  expect(() => cropPng(png, { x: 8, y: 40, width: 16, height: 12 })).toThrow(/outside/);
  expect(() => cropPng(png, { x: 8, y: 6, width: 0, height: 12 })).toThrow(/outside/);
});

it("upscales a crop with nearest neighbour so each source pixel becomes a block", () => {
  const png = PNG.sync.read(solid(64, 48, [184, 136, 72]));
  const scaled = scalePngNearest(cropPng(png, { x: 0, y: 0, width: 8, height: 6 }), 3);
  expect(scaled.width).toBe(24);
  expect(scaled.height).toBe(18);
  expect(pixel(scaled, 0, 0)).toEqual([184, 136, 72, 255]);
  expect(pixel(scaled, 2, 2)).toEqual([184, 136, 72, 255]);
  expect(pixel(scaled, 23, 17)).toEqual([184, 136, 72, 255]);
  expect(() => scalePngNearest(png, 0)).toThrow(/positive integer/);
});

it("measures mean colour and pixel deltas instead of judging them", () => {
  const flat = PNG.sync.read(solid(32, 32, [101, 113, 175]));
  expect(meanColor(flat)).toEqual([101, 113, 175]);
  const warm = PNG.sync.read(solid(32, 32, [184, 136, 72]));
  const identical = deltaStats(flat, PNG.sync.read(solid(32, 32, [101, 113, 175])));
  expect(identical.meanAbs).toEqual([0, 0, 0]);
  expect(identical.changedPercent).toBe(0);
  const delta = deltaStats(flat, warm);
  expect(delta.meanAbs).toEqual([83, 23, 103]);
  expect(delta.changedPercent).toBe(100);
  expect(() => deltaStats(flat, PNG.sync.read(solid(16, 16, [101, 113, 175])))).toThrow(
    /Cannot compare/,
  );
});
