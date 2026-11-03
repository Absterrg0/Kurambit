import { describe, expect, it } from "@effect/vitest";
import { decodePng, type Rgba } from "./run/spriteFacts.ts";
import {
  contactSheet,
  encodePng,
  frameCameras,
  outline,
  quantize,
  travel,
} from "./spriteRender.ts";

const side = {
  name: "right",
  x0: -1,
  x1: 1,
  y0: 0,
  y1: 3,
  d0: -0.5,
  d1: 0.5,
  perFrame: [[-1, 1, 0, 3]],
  origin: null,
};
const basis = { right: [0, -1, 0], up: [0, 0, 1], forward: [1, 0, 0] };

describe("frameCameras", () => {
  it("fits the tallest extent inside the inset and stands the lowest point on the bottom inset", () => {
    const framing = frameCameras(
      {
        frames: [0],
        fps: 24,
        action: null,
        objects: [],
        anchorObject: null,
        views: [side],
        basis: [basis],
      },
      64,
      64,
      2,
      ["feet"],
    )!;
    // 3 units tall over 60 px of room.
    expect(framing.pixelsPerUnit).toBe(20);
    expect(framing.unitsPerPixel).toBeCloseTo(3 / 60);
    expect(framing.orthoScale).toBeCloseTo((3 / 60) * 64);
    expect(framing.anchors[0]).toEqual({ x: 32, y: 62, kind: "feet", onOrigin: false });
    const m = framing.cameras[0]!.matrix;
    // The camera's centre sits half a canvas above the ground line: y0 + (32 - 2) px.
    expect(m[2]![3]).toBeCloseTo(30 * (3 / 60));
    // It looks along +X (its local Z is -forward) from in front of the nearest depth.
    expect(m[0]![2]).toBeCloseTo(-1);
    expect(m[0]![3]).toBeLessThan(side.d0);
  });

  it("centres the root's origin, not the silhouette, and reports the canvas a fixed scale needs", () => {
    // An attack reaching 1.5 units forward from a body centred on its origin at x=0.
    const reach = { ...side, x1: 2.5, origin: [0, 0] };
    const fit = {
      frames: [0],
      fps: 24,
      action: null,
      objects: [],
      anchorObject: "hero",
      views: [reach],
      basis: [basis],
    };
    const framing = frameCameras(fit, 64, 64, 2, ["feet"], 20)!;
    // The camera stays on the origin, so the body does not shift, and 2 x 2.5 units at 20 px need 104 px.
    expect(framing.cameras[0]!.matrix[1]![3]).toBeCloseTo(0);
    expect(framing.need).toEqual({ width: 104, height: 64 });
  });

  it("finds root motion, and not a stride or a lunge", () => {
    const fit = (perFrame: number[][]) => ({
      frames: [0, 1, 2],
      fps: 24,
      action: null,
      objects: [],
      anchorObject: null,
      views: [{ ...side, perFrame }],
      basis: [basis],
    });
    const stride = [
      [-1, 1, 0, 3],
      [-0.5, 0.5, 0, 3],
      [-1.2, 0.9, 0, 3],
    ];
    expect(travel(fit(stride), ["feet"])).toBeNull();
    const lunge = [
      [-1, 1, 0, 3],
      [0.5, 2.5, 0, 3],
      [-1, 1.1, 0, 3],
    ];
    expect(travel(fit(lunge), ["feet"])).toBeNull();
    const slide = [
      [-1, 1, 0, 3],
      [0, 2, 0, 3],
      [1.5, 3.5, 0, 3],
    ];
    expect(travel(fit(slide), ["feet"])?.distance).toBeCloseTo(2.5);
  });

  it("refuses a margin that leaves no room", () => {
    expect(
      frameCameras(
        {
          frames: [0],
          fps: 24,
          action: null,
          objects: [],
          anchorObject: null,
          views: [side],
          basis: [basis],
        },
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
