// @effect-diagnostics nodeBuiltinImport:off -- the sheet is a file in the game folder, checked where it lies.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { GameOperationError } from "@kurambit/contracts";

/** Where games made before generated art was removed keep what it delivered. */
const GENERATED_DIR = "art/generated";
const IMAGE = /\.(png|jpe?g|webp)$/i;

/** What a texture painted from a sheet credits. */
export interface SheetSource {
  readonly file: string;
  readonly path: string;
  readonly stamp: {
    readonly from: string;
    readonly licence: string;
    readonly ai: boolean;
    readonly credits: number | null;
  };
}

/**
 * A turnaround sheet by its game path: the person's own image. One under art/generated/ was made
 * by a generative model, so it is credited as AI-made, never as the person's.
 */
export const sheetSource = (
  realRoot: string,
  relative: string,
  operation: string,
): Effect.Effect<SheetSource, GameOperationError> =>
  Effect.gen(function* () {
    const refuse = (detail: string) =>
      Effect.fail(
        new GameOperationError({ operation, path: relative, reason: "invalid-input", detail }),
      );
    const normal = NodePath.posix.normalize(relative.replaceAll("\\", "/"));
    if (NodePath.posix.isAbsolute(normal) || normal.startsWith("../") || !IMAGE.test(normal))
      return yield* refuse(
        `${relative} is not a sheet in this game: give the game path of a .png, .jpg or .webp image.`,
      );
    const absolute = NodePath.join(realRoot, normal);
    const real = yield* Effect.promise(() => NodeFSP.realpath(absolute).catch(() => null));
    if (real === null || real !== absolute)
      return yield* refuse(
        `${relative} is not a file in this game${real === null ? "" : " (it is a link)"}.`,
      );
    const generated = normal.startsWith(`${GENERATED_DIR}/`);
    return {
      file: real,
      path: normal,
      stamp: {
        from: generated ? "generated" : "made",
        licence: (generated
          ? `an AI-generated image ${normal}`
          : `the person's own image ${normal}`
        ).slice(0, 200),
        ai: generated,
        credits: null,
      },
    };
  });
