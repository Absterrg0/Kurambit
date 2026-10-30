// The contact sheet is pure PNG composition, so the test draws its own solid
// thumbnails and checks the grid math and the pixels, not a static snapshot.
import { expect, it } from "@effect/vitest";
import { PNG } from "pngjs";
import { composeContactSheet, MAX_CONTACT_SHEET_THUMBNAILS } from "./assetContactSheet.ts";

const solid = (width: number, height: number, color: readonly [number, number, number]) => {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      png.data[at] = color[0];
      png.data[at + 1] = color[1];
      png.data[at + 2] = color[2];
      png.data[at + 3] = 255;
    }
  return PNG.sync.write(png);
};

const pixel = (png: PNG, x: number, y: number): readonly [number, number, number] => {
  const at = (y * png.width + x) * 4;
  return [png.data[at]!, png.data[at + 1]!, png.data[at + 2]!];
};

it("lays one labelled cell per asset and keeps each thumbnail's pixels", () => {
  const sheet = composeContactSheet({
    thumbnails: [
      { id: "hero", png: solid(64, 64, [200, 30, 30]) },
      { id: "crate", png: solid(32, 96, [30, 200, 30]) },
      { id: "sword", png: solid(96, 32, [30, 30, 200]) },
    ],
  });
  expect(sheet.cells).toHaveLength(3);
  expect(sheet.cells.map((cell) => cell.id)).toEqual(["hero", "crate", "sword"]);
  expect(sheet.width).toBeGreaterThan(0);
  expect(sheet.height).toBeGreaterThan(0);
  expect(sheet.cells[2]?.x).toBe(sheet.cells[0]?.x);
  expect(sheet.cells[1]?.x).toBeGreaterThan(sheet.cells[0]?.x ?? 0);
  const decoded = PNG.sync.read(sheet.png);
  expect(decoded.width).toBe(sheet.width);
  expect(decoded.height).toBe(sheet.height);
  // Each cell's thumbnail centre keeps the source colour: the composition
  // scales but never blends.
  for (const [cell, color] of [
    [sheet.cells[0]!, [200, 30, 30]],
    [sheet.cells[1]!, [30, 200, 30]],
    [sheet.cells[2]!, [30, 30, 200]],
  ] as const) {
    const centreX = cell.x + Math.floor(cell.width / 2);
    const centreY = cell.y + Math.floor(cell.height / 2);
    expect(pixel(decoded, centreX, centreY)).toEqual(color);
  }
});

it("fits full Blender thumbnails inside their cells without overwriting neighbours", () => {
  const sheet = composeContactSheet({
    thumbnails: [
      { id: "hero", png: solid(256, 256, [200, 30, 30]) },
      { id: "crate", png: solid(256, 256, [30, 200, 30]) },
    ],
  });
  const png = PNG.sync.read(sheet.png);
  for (const [cell, color] of [
    [sheet.cells[0]!, [200, 30, 30]],
    [sheet.cells[1]!, [30, 200, 30]],
  ] as const) {
    expect(pixel(png, cell.x, cell.y)).toEqual(color);
    expect(pixel(png, cell.x + cell.width - 1, cell.y + cell.height - 1)).toEqual(color);
    expect(pixel(png, cell.x - 1, cell.y + cell.height / 2)).toEqual([16, 20, 24]);
  }
});

it("bounds contact sheet size before decoding an oversized collection", () => {
  expect(() =>
    composeContactSheet({
      thumbnails: Array.from({ length: MAX_CONTACT_SHEET_THUMBNAILS + 1 }, (_, index) => ({
        id: String(index),
        png: Buffer.alloc(0),
      })),
    }),
  ).toThrow("at most 64");
});

it("keeps long asset labels inside their own cell", () => {
  const sheet = composeContactSheet({
    thumbnails: [
      { id: "x".repeat(80), png: solid(32, 32, [200, 30, 30]) },
      { id: "crate", png: solid(32, 32, [30, 200, 30]) },
    ],
  });
  expect(pixel(PNG.sync.read(sheet.png), sheet.cells[1]!.x - 8, 4)).toEqual([16, 20, 24]);
});
