import * as Effect from "effect/Effect";
import { pack } from "gltfpack";

/**
 * gltfpack (meshoptimizer's own packer, MIT, WebAssembly): quantized geometry and clips
 * (KHR_mesh_quantization), meshopt-compressed when the game decodes it (EXT_meshopt_compression),
 * optionally simplified.
 * Images pass through as they are; its WebAssembly build encodes none, so the export's WebP comes
 * from Blender. Named nodes, materials and extras are kept, since games find bones and parts by
 * name, and clips keep their own sampling.
 */
export const packGlb = Effect.fn("glbPack.pack")(function* <E>(
  input: Uint8Array,
  options: { readonly meshopt: boolean; readonly simplify?: { readonly ratio: number } },
  makeError: (detail: string, cause: unknown) => E,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      let output: Uint8Array | null = null;
      // gltfpack sees only these two names: it reads the input and writes the output, nothing else.
      await pack(
        [
          "-i",
          "in.glb",
          "-o",
          "out.glb",
          "-kn",
          "-km",
          "-ke",
          "-af",
          "0",
          ...(options.meshopt ? ["-cc"] : []),
          ...(options.simplify === undefined ? [] : ["-si", options.simplify.ratio.toFixed(4)]),
        ],
        {
          read: (path: string) => {
            if (path !== "in.glb") throw new Error(`gltfpack asked for ${path}`);
            return input;
          },
          write: (path: string, data: Uint8Array) => {
            if (path === "out.glb") output = data.slice();
          },
        },
      );
      if (output === null) throw new Error("gltfpack wrote no model");
      return output as Uint8Array;
    },
    catch: (cause) =>
      makeError(cause instanceof Error ? cause.message.slice(0, 500) : String(cause), cause),
  });
});
