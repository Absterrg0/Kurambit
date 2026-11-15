// @effect-diagnostics nodeBuiltinImport:off -- Reads a picture from the game folder to show beside the review's.
// The picture a game's look answers to, shown beside the agent's own review pictures (the model
// sheet, the check's views) so it compares what it made against the target rather than judging
// it alone: a path the agent names, else STYLE.json's anchor (the person's picked key art), else
// art/reference.png, which the agent saves when the person attaches one.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import { insideGame } from "./gamePath.ts";
import { readGameStyle } from "./gameStyle.ts";

const PNG_SIGNATURE = "89504e470d0a1a0a";
/** A reference is shown, never processed: one this large is not worth a turn's context. */
const MAX_REFERENCE_BYTES = 6 * 1024 * 1024;

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
  return {
    path: relative,
    image: {
      mimeType: "image/png",
      data: bytes.toString("base64"),
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    },
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
