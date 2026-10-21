// @effect-diagnostics nodeBuiltinImport:off -- This helper reads the game's source tree on the native filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * A walked-entry bound, not a game-size limit. A tree larger than this cannot be
 * identified, so callers must treat the result as unknown (and therefore stale)
 * rather than guessing that it did not change.
 */
const DEFAULT_MAX_SOURCE_ENTRIES = 10_000;

export type SourceSnapshot =
  | { readonly kind: "known"; readonly sourceId: string; readonly entries: number }
  | {
      readonly kind: "unknown";
      readonly reason: "entry-limit" | "io" | "symlink";
      /** The path that made the tree unknowable, when one names it. */
      readonly detail?: string;
    };

/**
 * Identifies the game's Godot sources by path, size and mtime. Additions,
 * deletions and edits all change the hash. Godot's scratch directory is
 * excluded because importing and exporting rewrite it on their own.
 *
 * Symlinks fail closed: following a linked script would let its content change
 * without changing the identity of the tree Godot loaded. Size and mtime are
 * deliberately not content hashes; a same-size edit inside one mtime tick is
 * the remaining gap, and the engine reads the file directly in that case.
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
        const relative = NodePath.relative(engineRoot, path).split(NodePath.sep).join("/");
        if (entry.isSymbolicLink())
          return { kind: "unknown", reason: "symlink", detail: `godot/${relative}` };
        if (entry.isDirectory()) {
          if (entry.name !== ".godot") stack.push(path);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = await NodeFSP.stat(path);
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

export type SourceComparison =
  | { readonly kind: "current"; readonly sourceId: string }
  | { readonly kind: "changed"; readonly detail: string }
  | { readonly kind: "unknown"; readonly detail: string };

const describeUnknown = (snapshot: Extract<SourceSnapshot, { kind: "unknown" }>): string =>
  snapshot.reason === "symlink"
    ? `a symlink is not followed (${snapshot.detail ?? "unknown path"})`
    : snapshot.reason === "entry-limit"
      ? "the source tree is past the scan bound"
      : "the source tree could not be read";

/**
 * The one rule every executing stage shares: an operation only covers sources
 * it saw before and after itself, and only when both reads are known and equal.
 * A mixed or unreadable input cannot be called current, so the caller records
 * `unknown` and says why instead of attaching the result to sources it may not
 * have executed.
 */
export const comparedSource = (
  before: SourceSnapshot,
  after: SourceSnapshot,
  operation: string,
): SourceComparison => {
  if (before.kind === "unknown")
    return {
      kind: "unknown",
      detail: `The game sources could not be identified before the ${operation} ran (${describeUnknown(before)}); the result is not current.`,
    };
  if (after.kind === "unknown")
    return {
      kind: "unknown",
      detail: `The game sources could not be identified after the ${operation} ran (${describeUnknown(after)}); the result is not current.`,
    };
  if (before.sourceId !== after.sourceId)
    return {
      kind: "changed",
      detail: `The game sources changed while the ${operation} ran; the result is not current.`,
    };
  return { kind: "current", sourceId: after.sourceId };
};
