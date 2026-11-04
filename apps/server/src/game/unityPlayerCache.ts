// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- This helper reads, copies and touches Unity player folders on the native filesystem.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export const unityPlayerDirectory = (root: string, sourceId: string) =>
  NodePath.join(root, "builds/logs", `unity-play-${sourceId.slice(0, 16)}`);

/** Whether a builds/logs entry is a cached player folder. */
export const isPlayerDirectory = (name: string) => name.startsWith("unity-play-");

export type Checkout =
  | { readonly kind: "own" }
  | { readonly kind: "linked"; readonly main: string }
  | { readonly kind: "other"; readonly detail: string };

/**
 * Whose checkout a game folder is, read from git itself. A linked worktree
 * (the production run plays blind samples in these) names its main checkout,
 * the folder above the common git dir. Any other folder whose .git is a file
 * (a submodule, a separate git dir) has no game folder to share an import with.
 */
export const checkoutOf = async (root: string): Promise<Checkout> => {
  const dotGit = await NodeFSP.stat(NodePath.join(root, ".git")).catch(() => null);
  if (dotGit === null || !dotGit.isFile()) return { kind: "own" };
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const listed = await execFile(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"],
    { cwd: root, env, timeout: 15_000 },
  ).catch((cause: unknown) => cause);
  const [common, gitDir] =
    typeof listed === "object" && listed !== null && "stdout" in listed
      ? String(listed.stdout).trim().split("\n")
      : [];
  if (common === undefined || gitDir === undefined)
    return { kind: "other", detail: "git could not read its .git file" };
  return NodePath.basename(common) === ".git" &&
    NodePath.dirname(gitDir) === NodePath.join(common, "worktrees")
    ? { kind: "linked", main: NodePath.dirname(common) }
    : { kind: "other", detail: `its git dir is ${gitDir}` };
};

/** What buildUnityPlayer checks before it moves a Linux player into place. */
export const completePlayer = async (directory: string): Promise<boolean> => {
  for (const [name, kind] of [
    ["game.x86_64", "file"],
    ["game_Data", "directory"],
    ["UnityPlayer.so", "file"],
  ] as const) {
    const stat = await NodeFSP.stat(NodePath.join(directory, name)).catch(() => null);
    if (
      stat === null ||
      (kind === "file" ? !stat.isFile() || stat.size === 0 : !stat.isDirectory())
    )
      return false;
  }
  return true;
};

/**
 * Marks a player as just played: a game keeps its most recent players by the
 * folder's mtime, so one that samples keep playing outlives newer builds.
 */
export const touchPlayer = async (directory: string): Promise<void> => {
  const now = new Date();
  await NodeFSP.utimes(directory, now, now).catch(() => undefined);
};

/** Every entry below `directory` by relative path, with its kind and size. */
const listing = async (directory: string): Promise<string> => {
  const lines: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const item of await NodeFSP.readdir(NodePath.join(directory, relative), {
      withFileTypes: true,
    })) {
      const path = NodePath.join(relative, item.name);
      if (item.isDirectory()) {
        lines.push(`d ${path}`);
        await walk(path);
      } else {
        const stat = await NodeFSP.lstat(NodePath.join(directory, path));
        lines.push(`${item.isSymbolicLink() ? "l" : "f"} ${path} ${stat.size}`);
      }
    }
  };
  await walk("");
  return lines.sort().join("\n");
};

/**
 * A blind sample's worktree plays the same sources its main checkout already
 * built a player for (the player cache is keyed by the sources' content, never
 * a commit), so it takes a copy-on-write copy of that player instead of opening
 * an editor to build its own inside the sample's play time. A copy rather than
 * running the main's folder in place: the main checkout's own builds may prune
 * that folder while the sample plays, and removing the worktree must remove
 * only its own copy. The main's folder is only read, beyond touching its
 * time so the main's prune keeps a player samples play. The copy lands whole or
 * not at all, and is kept only if it lists the same files at the same sizes as
 * the main's player still does afterwards, so a prune racing the copy builds
 * as before. Answers null when it copied, or why not.
 */
export const reuseMainPlayer = async (
  main: string,
  root: string,
  sourceId: string,
): Promise<string | null> => {
  const source = unityPlayerDirectory(main, sourceId);
  const target = unityPlayerDirectory(root, sourceId);
  if (NodePath.resolve(source) === NodePath.resolve(target)) return "it is the main checkout";
  if (!(await completePlayer(source)))
    return "the main checkout has no player of these exact sources";
  const staging = NodePath.join(
    NodePath.dirname(target),
    `.${NodePath.basename(target)}-${NodeCrypto.randomUUID()}`,
  );
  try {
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await execFile("cp", ["-a", "--reflink=auto", "--", source, staging], {
      timeout: 5 * 60_000,
    });
    const [copied, still] = await Promise.all([listing(staging), listing(source)]);
    if (copied !== still || !(await completePlayer(staging)))
      return "the main checkout's player changed while it was copied";
    await NodeFSP.rename(staging, target).catch(async (cause: unknown) => {
      // Another start of this worktree landed the same player first.
      if (!(await completePlayer(target))) throw cause;
    });
    await touchPlayer(source);
    return null;
  } catch (cause) {
    return `copying the main checkout's player failed (${cause instanceof Error ? cause.message : String(cause)})`;
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
};
