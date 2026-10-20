// @effect-diagnostics nodeBuiltinImport:off -- This helper reads the game's source tree on the native filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * A walked-entry bound, not a game-size limit. A tree larger than this cannot be
 * identified, so callers must treat the result as unknown (and therefore stale)
 * rather than guessing that it did not change.
 */
export const DEFAULT_MAX_SOURCE_ENTRIES = 10_000;

export type SourceSnapshot =
  | { readonly kind: "known"; readonly sourceId: string; readonly entries: number }
  | { readonly kind: "unknown"; readonly reason: "entry-limit" | "io" };

/**
 * Identifies the game's Godot sources by path, size and mtime. Additions,
 * deletions and edits all change the hash. Godot's scratch directory is
 * excluded because importing and exporting rewrite it on their own.
 */
export const snapshotSource = async (
  root: string,
  godotProject: string,
  options: { readonly maxEntries?: number | undefined } = {},
): Promise<SourceSnapshot> => {
  const limit = options.maxEntries ?? DEFAULT_MAX_SOURCE_ENTRIES;
  const engineRoot = NodePath.join(root, godotProject);
  const lines: string[] = [];
  let visited = 0;
  try {
    const stack = [engineRoot];
    while (stack.length > 0) {
      const directory = stack.pop()!;
      for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
        visited += 1;
        if (visited > limit) return { kind: "unknown", reason: "entry-limit" };
        const path = NodePath.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== ".godot") stack.push(path);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = await NodeFSP.stat(path);
        const relative = NodePath.relative(engineRoot, path).split(NodePath.sep).join("/");
        lines.push(`${relative}\0${stat.size}\0${stat.mtimeMs}\n`);
      }
    }
  } catch {
    return { kind: "unknown", reason: "io" };
  }
  lines.sort();
  const hash = NodeCrypto.createHash("sha256");
  for (const line of lines) hash.update(line);
  return { kind: "known", sourceId: hash.digest("hex"), entries: lines.length };
};
