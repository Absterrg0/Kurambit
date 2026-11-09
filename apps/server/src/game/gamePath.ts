// @effect-diagnostics nodeBuiltinImport:off -- Resolves game paths on the native filesystem, where links live.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { GameOperationError } from "@kurambit/contracts";
import { isPathWithinRoot, realPathForContainment } from "@kurambit/shared/pathContainment";

const refusal = (relative: string, reason: "invalid-path" | "symlink", detail?: string) =>
  new GameOperationError({
    operation: "resolve-path",
    path: relative,
    reason,
    ...(detail === undefined ? {} : { detail }),
  });

/**
 * The absolute path `relative` names in the game at `root`, judged by its text
 * alone: relative, and below the root. Enough to validate a record that names
 * game paths (game.json); anything that opens the path uses `insideGame`.
 */
export const gameRelative = (
  root: string,
  relative: string,
  options: { readonly root?: "allowed" } = {},
): string => {
  const base = NodePath.resolve(root);
  const target = NodePath.resolve(base, relative);
  if (
    NodePath.isAbsolute(relative) ||
    (target === base ? options.root !== "allowed" : !target.startsWith(base + NodePath.sep))
  )
    throw refusal(relative, "invalid-path");
  return target;
};

/**
 * The absolute path of `relative` in the game at `root`, or a refusal. A game
 * folder is a repository agents write into and people bring from anywhere, so
 * any folder or file in it may be a link or junction (`assets -> /home/me`,
 * `builds -> C:\Users\me`). Checking the text is not enough: the path must also
 * stay in the game where the platform really opens it, or every read, write,
 * copy and delete through it acts on the person's files or Kurambit's own
 * state. A path that does not exist yet (an export target, a new asset) is
 * judged by its deepest existing folder. The root itself is the person's
 * chosen folder and may be a link; it is a valid answer only when asked for.
 */
export const insideGame = (
  root: string,
  relative: string,
  options: { readonly root?: "allowed" } = {},
): string => {
  const target = gameRelative(root, relative, options);
  const base = NodePath.resolve(root);
  const realRoot = realPathForContainment(base);
  // Joined as written, not normalized: `link/../file` opens the link's parent, not the game's.
  const real = realPathForContainment(`${base}${NodePath.sep}${relative}`);
  if (
    realRoot === undefined ||
    real === undefined ||
    !isPathWithinRoot(real, realRoot) ||
    (real === realRoot && options.root !== "allowed")
  )
    // The game's own files lead out (a link, a junction, a name Windows rewrites), not the request.
    throw refusal(
      relative,
      "symlink",
      `${relative} leads outside the game folder${real === undefined ? "" : ` (to ${real})`}; a game operation never follows a link out of the game.`,
    );
  return target;
};

/** `insideGame` as an Effect whose refusal is the typed error. */
export const inGame = (
  root: string,
  relative: string,
  options?: { readonly root?: "allowed" },
): Effect.Effect<string, GameOperationError> =>
  // insideGame throws nothing but its refusal.
  Effect.try({
    try: () => insideGame(root, relative, options),
    catch: (cause) => cause as GameOperationError,
  });

/** `insideGame` as a yes or no, for walks that skip what leaves the game rather than fail. */
export const staysInsideGame = (root: string, relative: string): boolean => {
  try {
    insideGame(root, relative, { root: "allowed" });
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether `path`, met in a copy of `tree`, may be copied: anything but a link,
 * or a link whose real target stays inside `tree`. A link out of it is skipped,
 * so a copy never brings what it points at, and never carries a link that a
 * later read of the copy would follow out.
 */
export const copyableEntry = async (path: string, tree: string): Promise<boolean> => {
  const stat = await NodeFSP.lstat(path).catch(() => null);
  if (stat === null || !stat.isSymbolicLink()) return true;
  return staysInsideGame(tree, NodePath.relative(tree, path));
};
