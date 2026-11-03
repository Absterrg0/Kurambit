// The art director trusts these numbers, so the measurement is checked on hand-made pixels.
// @effect-diagnostics nodeBuiltinImport:off -- Builds PNG bytes by hand.
import * as NodeZlib from "node:zlib";
import { describe, expect, it } from "@effect/vitest";
import { cutEdges, decodePng, frameDifference, measure, type Rgba } from "./spriteFacts.ts";

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

const chunk = (name: string, body: Buffer, crc?: number) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(name, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc ?? NodeZlib.crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
};
const png = (type: number, depth: number, rows: Buffer, extra: Buffer[] = [], idatCrc?: number) => {
  const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, depth, type, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...extra,
    chunk("IDAT", NodeZlib.deflateSync(rows), idatCrc),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

describe("decodePng", () => {
  // Invented numbers would send the art director after defects that are not there.
  it("decodes a valid file and rejects invalid ones instead of guessing", async () => {
    const rgba = Buffer.from([0, 1, 2, 3, 255, 4, 5, 6, 255]);
    expect(await decodePng(png(6, 8, rgba))).toMatchObject({ width: 2, height: 1 });
    const unreadable = { skip: "unreadable PNG" };
    expect(await decodePng(png(6, 8, Buffer.from([5, ...rgba.subarray(1)])))).toEqual(unreadable);
    expect(await decodePng(png(6, 8, rgba, [], 1))).toEqual(unreadable);
    expect(await decodePng(png(2, 4, Buffer.from([0, 0x12, 0x34, 0x56])))).toEqual(unreadable);
    expect(await decodePng(png(3, 8, Buffer.from([0, 0, 0])))).toEqual(unreadable);
    const plte = chunk("PLTE", Buffer.from([10, 20, 30]));
    expect(await decodePng(png(3, 8, Buffer.from([0, 0, 0]), [plte]))).toMatchObject({ width: 2 });
    expect(await decodePng(png(3, 8, Buffer.from([0, 0, 1]), [plte]))).toEqual(unreadable);
  });
});
