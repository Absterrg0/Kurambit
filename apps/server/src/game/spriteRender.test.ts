import { describe, expect, it } from "@effect/vitest";
import { decodePng, type Rgba } from "./run/spriteFacts.ts";
import { encodePng, frameCameras, outline, quantize } from "./spriteRender.ts";

const side = {
  name: "right",
  x0: -1,
  x1: 1,
  y0: 0,
  y1: 3,
  d0: -0.5,
  d1: 0.5,
};
const basis = { right: [0, -1, 0], up: [0, 0, 1], forward: [1, 0, 0] };

describe("frameCameras", () => {
  it("fits the tallest extent inside the inset and stands the lowest point on the bottom inset", () => {
    const framing = frameCameras(
      { frames: [0], action: null, objects: [], views: [side], basis: [basis] },
      64,
      64,
      2,
      ["feet"],
    )!;
    // 3 units tall over 60 px of room.
    expect(framing.unitsPerPixel).toBeCloseTo(3 / 60);
    expect(framing.orthoScale).toBeCloseTo((3 / 60) * 64);
    expect(framing.anchors[0]).toEqual({ x: 32, y: 62, kind: "feet" });
    const m = framing.cameras[0]!.matrix;
    // The camera's centre sits half a canvas above the ground line: y0 + (32 - 2) px.
    expect(m[2]![3]).toBeCloseTo(30 * (3 / 60));
    // It looks along +X (its local Z is -forward) from in front of the nearest depth.
    expect(m[0]![2]).toBeCloseTo(-1);
    expect(m[0]![3]).toBeLessThan(side.d0);
  });

  it("refuses a margin that leaves no room", () => {
    expect(
      frameCameras(
        { frames: [0], action: null, objects: [], views: [side], basis: [basis] },
        8,
        8,
        4,
        ["feet"],
      ),
    ).toBeNull();
  });
});

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

describe("encodePng", () => {
  it("round-trips through the facts decoder and gives the same bytes twice", async () => {
    const img: Rgba = { width: 3, height: 3, data: new Uint8Array(36) };
    img.data.set([200, 100, 50, 255], 16);
    outline(img, 0x102030);
    const png = encodePng(img);
    expect(encodePng(img).equals(png)).toBe(true);
    const back = await decodePng(png);
    expect("skip" in back).toBe(false);
    expect([...(back as Rgba).data]).toEqual([...img.data]);
    expect(Array.from(img.data.slice(4, 8))).toEqual([0x10, 0x20, 0x30, 255]);
    expect(Array.from(img.data.slice(0, 4))).toEqual([0, 0, 0, 0]);
  });
});
