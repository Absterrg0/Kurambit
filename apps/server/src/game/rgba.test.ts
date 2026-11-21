// @effect-diagnostics nodeBuiltinImport:off -- Builds PNG bytes by hand.
import * as NodeZlib from "node:zlib";
import { describe, expect, it } from "@effect/vitest";
import { contactSheet, decodePng, encodePng, quantize, type Rgba } from "./rgba.ts";

const image = (pixels: ReadonlyArray<readonly [number, number, number, number]>): Rgba => ({
  width: pixels.length,
  height: 1,
  data: Uint8Array.from(pixels.flat()),
});

describe("quantize", () => {
  it("snaps every frame to the most used source colours and leaves clear pixels clear", () => {
    const a = image([
      [250, 10, 10, 255],
      [240, 20, 20, 255],
      [10, 10, 240, 255],
      [0, 0, 0, 0],
    ]);
    const b = image([
      [245, 5, 5, 255],
      [20, 200, 20, 255],
      [5, 5, 250, 255],
      [0, 0, 0, 0],
    ]);
    const used = quantize([a, b], [0xff0000, 0x00ff00, 0x0000ff, 0xffffff], 2);
    expect(used.toSorted()).toEqual([0x0000ff, 0xff0000].toSorted());
    expect(Array.from(a.data.slice(0, 4))).toEqual([255, 0, 0, 255]);
    // Green lost the vote, so it takes its nearest kept colour, the same in every frame.
    expect(Array.from(b.data.slice(4, 8))).not.toEqual([0, 255, 0, 255]);
    expect(Array.from(a.data.slice(12, 16))).toEqual([0, 0, 0, 0]);
  });
});

describe("contactSheet", () => {
  it("wraps 64 frames of 64 px into balanced rows within the width", () => {
    const frame: Rgba = { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4) };
    const { image } = contactSheet([Array.from({ length: 64 }, () => frame)], [-1]);
    expect(image.width).toBeLessThanOrEqual(1280);
    // 64 frames: 6 rows of 11 at 1x.
    expect(image.height).toBe(6 + 6 * (64 + 6));
  });
});

describe("encodePng", () => {
  it("round-trips through the decoder and gives the same bytes twice", async () => {
    const img: Rgba = { width: 3, height: 3, data: new Uint8Array(36) };
    img.data.set([200, 100, 50, 255], 16);
    const png = encodePng(img);
    expect(encodePng(img).equals(png)).toBe(true);
    const back = await decodePng(png);
    expect("skip" in back).toBe(false);
    expect([...(back as Rgba).data]).toEqual([...img.data]);
    expect(Array.from(img.data.slice(16, 20))).toEqual([200, 100, 50, 255]);
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
