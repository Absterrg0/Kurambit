// @effect-diagnostics nodeBuiltinImport:off -- Reads a picture from the game folder to show beside the review's.
// The picture a game's look answers to, shown beside the agent's own review pictures (the model
// sheet, the check's views) so it compares what it made against the target rather than judging
// it alone: a path the agent names, else STYLE.json's anchor (the person's picked key art), else
// art/reference.png, which the agent saves when the person attaches one.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import { PNG } from "pngjs";
import { insideGame } from "./gamePath.ts";
import { downscale } from "./rgba.ts";
import { readGameStyle } from "./gameStyle.ts";

const PNG_SIGNATURE = "89504e470d0a1a0a";
/** Read at most this large; anything larger is no reference a person meant to attach. */
const MAX_REFERENCE_BYTES = 40 * 1024 * 1024;
/** The long side a model is shown at (Anthropic's limit before it resizes images itself). */
const MAX_SIDE = 1568;
/** Under every provider's per-image limit (Anthropic's is 5 MB), base64 and all. */
const MAX_SHOWN_BYTES = 3_500_000;

export interface GameReference {
  /** Game-relative. */
  readonly path: string;
  readonly image: {
    readonly mimeType: "image/png";
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
}

const readPng = async (root: string, relative: string): Promise<GameReference | null> => {
  let file: string;
  try {
    file = insideGame(root, relative);
  } catch {
    return null;
  }
  const bytes = await NodeFSP.readFile(file).catch(() => null);
  if (bytes === null || bytes.length > MAX_REFERENCE_BYTES || bytes.length < 24) return null;
  if (bytes.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) return null;
  let shown: Buffer = bytes;
  let width = bytes.readUInt32BE(16);
  let height = bytes.readUInt32BE(20);
  // Shrunk to the size a model sees anyway, so a full-resolution screenshot never makes the
  // provider refuse the turn's request.
  if (Math.max(width, height) > MAX_SIDE) {
    let image: PNG;
    try {
      image = PNG.sync.read(bytes);
    } catch {
      return null;
    }
    const k = Math.ceil(Math.max(width, height) / MAX_SIDE);
    const small = downscale(
      { width: image.width, height: image.height, data: image.data },
      k,
      "area",
    );
    const out = new PNG({ width: small.width, height: small.height });
    out.data = Buffer.from(small.data);
    shown = PNG.sync.write(out);
    width = small.width;
    height = small.height;
  }
  if (Math.ceil(shown.length / 3) * 4 > MAX_SHOWN_BYTES) return null;
  return {
    path: relative,
    image: { mimeType: "image/png", data: shown.toString("base64"), width, height },
  };
};

/** The game's reference picture, or null when it has none (only PNGs are shown). */
export const gameReference = (root: string, named?: string) =>
  Effect.gen(function* () {
    const style = yield* readGameStyle(root).pipe(Effect.orElseSucceed(() => null));
    const candidates = [named, style?.anchor, "art/reference.png"].filter(
      (path): path is string => path !== undefined,
    );
    for (const path of candidates) {
      const found = yield* Effect.promise(() => readPng(root, path));
      if (found !== null) return found;
    }
    return null;
  });

/**
 * Each picture's box in the like-for-like view. Stacked, the two fill about one megapixel, which
 * a provider shows without shrinking, so the game's frame and the reference read at one size.
 */
const PANEL_WIDTH = 960;
const PANEL_HEIGHT = 540;
const GAP = 8;
const BACKDROP = [24, 24, 28] as const;

/** `source` resampled into the panel at `top`, as large as fits without cropping, centred. */
const drawFitted = (
  out: Uint8Array,
  source: { readonly width: number; readonly height: number; readonly data: Uint8Array },
  top: number,
) => {
  const scale = Math.min(PANEL_WIDTH / source.width, PANEL_HEIGHT / source.height);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const left = Math.floor((PANEL_WIDTH - width) / 2);
  const down = top + Math.floor((PANEL_HEIGHT - height) / 2);
  // A box average over each output pixel's footprint (at least one source pixel), so a large
  // picture shrinks without aliasing and a small one grows without holes.
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y / scale);
    const y1 = Math.min(source.height, Math.max(y0 + 1, Math.floor((y + 1) / scale)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x / scale);
      const x1 = Math.min(source.width, Math.max(x0 + 1, Math.floor((x + 1) / scale)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * source.width + sx) * 4;
          r += source.data[i]!;
          g += source.data[i + 1]!;
          b += source.data[i + 2]!;
          n += 1;
        }
      const o = ((down + y) * PANEL_WIDTH + left + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
};

/**
 * The game's frame above its reference picture, each fitted to the same box: one image the
 * agent matches camera and composition from, like for like. Null when either does not read.
 */
export const besideReference = (frame: Buffer, reference: GameReference) => {
  let game: PNG;
  let target: PNG;
  try {
    game = PNG.sync.read(frame);
    target = PNG.sync.read(Buffer.from(reference.image.data, "base64"));
  } catch {
    return null;
  }
  const height = PANEL_HEIGHT * 2 + GAP;
  const out = new PNG({ width: PANEL_WIDTH, height });
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = BACKDROP[0];
    out.data[i + 1] = BACKDROP[1];
    out.data[i + 2] = BACKDROP[2];
    out.data[i + 3] = 255;
  }
  drawFitted(out.data, game, 0);
  drawFitted(out.data, target, PANEL_HEIGHT + GAP);
  const bytes = PNG.sync.write(out);
  if (Math.ceil(bytes.length / 3) * 4 > MAX_SHOWN_BYTES) return null;
  return {
    mimeType: "image/png" as const,
    data: bytes.toString("base64"),
    width: PANEL_WIDTH,
    height,
  };
};
