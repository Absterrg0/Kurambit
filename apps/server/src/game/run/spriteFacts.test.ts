// The art director trusts these numbers, so the measurement is checked on hand-made pixels.
import { describe, expect, it } from "@effect/vitest";
import { cutEdges, frameDifference, measure, type Rgba } from "./spriteFacts.ts";

// A clear canvas with one opaque rectangle (inclusive bounds) in a single colour.
const canvas = (
  width: number,
  height: number,
  rect: { x0: number; y0: number; x1: number; y1: number },
  rgb: [number, number, number] = [200, 100, 50],
): Rgba => {
  const data = new Uint8Array(width * height * 4);
  for (let y = rect.y0; y <= rect.y1; y++)
    for (let x = rect.x0; x <= rect.x1; x++) data.set([...rgb, 255], (y * width + x) * 4);
  return { width, height, data };
};

describe("measure", () => {
  it("finds the box, edge contact and a cut at the top", () => {
    const m = measure(canvas(32, 32, { x0: 10, y0: 0, x1: 19, y1: 15 }));
    expect(m.box).toEqual({ x0: 10, y0: 0, x1: 19, y1: 15 });
    expect(m.edges).toEqual({ top: 10, bottom: 0, left: 0, right: 0 });
    expect(m.colours).toBe(1);
    expect(cutEdges(m)).toEqual([{ side: "top", clear: 16 }]);
  });

  it("lists no cut for a trimmed sprite or one standing on the bottom edge", () => {
    expect(cutEdges(measure(canvas(16, 16, { x0: 0, y0: 0, x1: 15, y1: 15 })))).toEqual([]);
    expect(cutEdges(measure(canvas(32, 32, { x0: 8, y0: 10, x1: 23, y1: 31 })))).toEqual([]);
  });
});

describe("frameDifference", () => {
  it("is zero for equal frames and grows with a shift, unaffected by canvas padding", () => {
    const a = canvas(64, 64, { x0: 10, y0: 10, x1: 19, y1: 19 });
    expect(frameDifference(a, canvas(64, 64, { x0: 10, y0: 10, x1: 19, y1: 19 }))).toBe(0);
    const shifted = frameDifference(a, canvas(64, 64, { x0: 11, y0: 10, x1: 20, y1: 19 }))!;
    const padded = frameDifference(
      canvas(128, 128, { x0: 10, y0: 10, x1: 19, y1: 19 }),
      canvas(128, 128, { x0: 11, y0: 10, x1: 20, y1: 19 }),
    );
    expect(shifted).toBeGreaterThan(0);
    expect(padded).toBeCloseTo(shifted);
    expect(frameDifference(a, canvas(32, 32, { x0: 0, y0: 0, x1: 1, y1: 1 }))).toBeNull();
  });
});
