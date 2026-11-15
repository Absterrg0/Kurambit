// @effect-diagnostics nodeBuiltinImport:off -- Reads a picture from the game folder to show beside the review's.
// The picture a game's look answers to, shown beside the agent's own review pictures (the model
// sheet, the check's views) so it compares what it made against the target rather than judging
// it alone: a path the agent names, else STYLE.json's anchor (the person's picked key art), else
// art/reference.png, which the agent saves when the person attaches one.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import { PNG } from "pngjs";
import { insideGame } from "./gamePath.ts";
import { downscale } from "./spriteRender.ts";
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
