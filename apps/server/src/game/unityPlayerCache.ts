// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- This helper reads, copies and touches Unity player folders on the native filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { copyTree } from "./gameFiles.ts";
import { HOST_OS } from "./processHost.ts";

export const unityPlayerDirectory = (root: string, sourceId: string) =>
  NodePath.join(root, "builds/logs", `unity-play-${sourceId.slice(0, 16)}`);

/** Whether a builds/logs entry is a cached player folder. */
export const isPlayerDirectory = (name: string) => name.startsWith("unity-play-");

export type Checkout =
  | { readonly kind: "own" }
  | { readonly kind: "linked"; readonly main: string }
  | { readonly kind: "other"; readonly detail: string };

/**
 * The file a production run's plain copy of a build carries, naming the game
 * folder it was copied from (every copy of that game names the same one).
 */
export const COPY_OF = ".kurambit-copy-of";

/**
 * Whose checkout a game folder is. A production run's plain copy of a build
 * (blind samples play these) names its game folder in COPY_OF; a linked
 * worktree names its main checkout, the folder above the common git dir. Any
 * other folder whose .git is a file (a submodule, a separate git dir) has no
 * game folder to share an import with.
 */
export const checkoutOf = (
  root: string,
  gitDirs: (cwd: string) => Effect.Effect<readonly [common: string, gitDir: string] | null>,
): Effect.Effect<Checkout> =>
  Effect.gen(function* () {
    const dotGit = yield* Effect.promise(() =>
      NodeFSP.stat(NodePath.join(root, ".git")).catch(() => null),
    );
    if (dotGit === null) {
      const main = yield* Effect.promise(async () => {
        const named = (
          await NodeFSP.readFile(NodePath.join(root, COPY_OF), "utf8").catch(() => "")
        ).trim();
        return named.length > 0 ? await NodeFSP.realpath(named).catch(() => null) : null;
      });
      return main === null ? ({ kind: "own" } as const) : ({ kind: "linked", main } as const);
    }
    if (!dotGit.isFile()) return { kind: "own" } as const;
    const dirs = yield* gitDirs(root);
    if (dirs === null)
      return { kind: "other", detail: "git could not read its .git file" } as const;
    const [common, gitDir] = dirs;
    return NodePath.basename(common) === ".git" &&
      NodePath.dirname(gitDir) === NodePath.join(common, "worktrees")
      ? ({ kind: "linked", main: NodePath.dirname(common) } as const)
      : ({ kind: "other", detail: `its git dir is ${gitDir}` } as const);
  });

/** `checkoutOf` over T3's own git driver (its environment, timeouts and interruption). */
export const makeCheckoutOf = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitDirs = (cwd: string) =>
    git
      .execute({
        operation: "game-checkout",
        cwd,
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"],
        allowNonZeroExit: true,
        timeoutMs: 15_000,
      })
      .pipe(
        Effect.map((result) => {
          const [common, gitDir] = result.stdout.trim().split("\n");
          return result.exitCode === 0 && common !== undefined && gitDir !== undefined
            ? ([common, gitDir] as const)
            : null;
        }),
        Effect.orElseSucceed(() => null),
      );
  return (root: string) => checkoutOf(root, gitDirs);
});

/**
 * The player a session plays on this machine: Unity builds it for the host
 * OS. macOS has none yet (a player there is an app bundle named by the
 * product), so a Unity session on macOS is refused before any build.
 */
export const UNITY_PLAY =
  HOST_OS === "win32"
    ? ({ target: "Windows", executable: "game.exe", runtime: "UnityPlayer.dll" } as const)
    : ({ target: "Linux", executable: "game.x86_64", runtime: "UnityPlayer.so" } as const);

/** What buildUnityPlayer checks before it moves this machine's player into place. */
export const completePlayer = async (directory: string): Promise<boolean> => {
  for (const [name, kind] of [
    [UNITY_PLAY.executable, "file"],
    ["game_Data", "directory"],
    [UNITY_PLAY.runtime, "file"],
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
    await copyTree(source, staging, AbortSignal.timeout(5 * 60_000));
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
