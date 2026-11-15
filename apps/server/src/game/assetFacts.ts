// @effect-diagnostics nodeBuiltinImport:off -- Reads a game's ASSETS.md and library folder from disk.
// Small readers of a game's model and asset files: a glTF's triangle count, and the library
// files ASSETS.md credits.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { walkFiles } from "./walkFiles.ts";

interface Doc {
  readonly meshes?: ReadonlyArray<{
    readonly primitives?: ReadonlyArray<{
      readonly attributes?: { readonly POSITION?: number };
      readonly indices?: number;
      readonly mode?: number;
    }>;
  }>;
  readonly accessors?: ReadonlyArray<{ readonly count?: number }>;
}

const triangles = (doc: Doc) => {
  let count = 0;
  for (const mesh of doc.meshes ?? [])
    for (const primitive of mesh.primitives ?? []) {
      if ((primitive.mode ?? 4) !== 4) continue;
      const accessor = doc.accessors?.[primitive.indices ?? primitive.attributes?.POSITION ?? -1];
      count += Math.floor((accessor?.count ?? 0) / 3);
    }
  return count;
};

/** The triangles a model's glTF JSON draws (a GLB's JSON chunk), compressed or not. */
export const gltfTriangles = (json: unknown) =>
  typeof json === "object" && json !== null ? triangles(json as Doc) : 0;

/**
 * Library files ASSETS.md credits, game-relative, as the library's add writes them: each file
 * by its path, or a folder's files by one `dir/*.ext` glob. Counted, never measured one by one.
 */
export const creditedLibraryFiles = async (
  copyRoot: string,
  library: string,
): Promise<ReadonlySet<string>> => {
  const text = await NodeFSP.readFile(NodePath.join(copyRoot, "ASSETS.md"), "utf8").catch(() => "");
  if (text === "") return new Set();
  const files = await walkFiles(library, { limit: 20_000 });
  return new Set(
    files.flatMap((full) => {
      const relative = NodePath.relative(copyRoot, full).split(NodePath.sep).join("/");
      const glob = `${NodePath.posix.dirname(relative)}/*${NodePath.posix.extname(relative)}`;
      return text.includes(`\`${relative}\``) || text.includes(`\`${glob}\``) ? [relative] : [];
    }),
  );
};
