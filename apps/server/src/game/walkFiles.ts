// @effect-diagnostics nodeBuiltinImport:off -- Lists a folder's files on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * The regular files below `dir`, depth first, each folder's entries in name
 * order. A link is never followed or listed, and a folder that cannot be read
 * is skipped. `enter` picks the folders the walk goes into, `match` the files
 * it keeps; it stops after `limit` kept files and below `maxDepth` folders.
 */
export const walkFiles = async (
  dir: string,
  options: {
    readonly enter?: (full: string, name: string) => boolean;
    readonly match?: (name: string) => boolean;
    readonly maxDepth?: number;
    readonly limit?: number;
  } = {},
): Promise<string[]> => {
  const found: string[] = [];
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const visit = async (at: string, depth: number): Promise<void> => {
    const entries = await NodeFSP.readdir(at, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= limit) return;
      const full = NodePath.join(at, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && (options.enter?.(full, entry.name) ?? true))
          await visit(full, depth + 1);
      } else if (entry.isFile() && (options.match?.(entry.name) ?? true)) found.push(full);
    }
  };
  await visit(dir, 0);
  return found;
};
