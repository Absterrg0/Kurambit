// @effect-diagnostics nodeBuiltinImport:off -- Source snapshots copy the game's native tree into the server's store.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { GameOperationError } from "@t3tools/contracts";
import { gameRecordFile } from "./gameRecord.ts";

/**
 * One game-owned file. `path` is relative to the game root with forward
 * slashes, and `sha256` is over the file's exact bytes. Size and mtime are
 * deliberately absent: the round decision must catch a same-size edit in the
 * same mtime tick, which the legacy size/mtime identity cannot.
 */
export interface GameSourceFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

/** The sorted content identity of a game's source tree. */
export interface GameSourceManifest {
  /** SHA-256 over the sorted manifest lines; equal bytes always give one id. */
  readonly sourceId: string;
  readonly files: readonly GameSourceFile[];
}

/** The manifest plus the immutable copy it describes. */
export interface StoredGameSnapshot {
  readonly manifest: GameSourceManifest;
  /** Absolute directory holding `manifest.json` and `files/`. */
  readonly directory: string;
}

export type GameSourceComparison =
  | { readonly kind: "current"; readonly sourceId: string }
  | {
      readonly kind: "changed";
      readonly sourceId: string;
      readonly modified: readonly string[];
      readonly added: readonly string[];
      readonly deleted: readonly string[];
    };

export type GameSnapshotRestore =
  | {
      readonly kind: "restored";
      readonly sourceId: string;
      readonly restored: readonly string[];
      readonly deleted: readonly string[];
    }
  | {
      /** The tree changed underneath the restore, so it stopped instead of writing. */
      readonly kind: "blocked";
      readonly sourceId: string;
      readonly detail: string;
    };

export interface GameSnapshotRestoreOptions {
  /** The identity the caller compared against; a mismatch writes nothing. */
  readonly expectSourceId?: string | undefined;
  /**
   * Test seam: runs after the entrance capture and before one path is verified
   * and mutated. Production leaves it out; tests use it to interleave an edit
   * between the tree read and a specific path's mutation.
   */
  readonly beforePath?:
    | ((operation: "delete" | "restore", path: string) => Promise<void>)
    | undefined;
}

/**
 * Bounds, not game-size limits. A tree past either bound cannot be identified,
 * so the operation fails instead of guessing that a truncated snapshot is the
 * whole game. Blender originals legitimately reach tens of megabytes; the byte
 * bound leaves room for a large art library while keeping a runaway copy from
 * filling the disk. The limit is enforced on the bytes actually streamed, so a
 * file that grows after a preliminary stat cannot slip past it.
 */
const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

/** Opening without following a link makes a swapped-in symlink fail closed. */
const READ_FLAGS = NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW;

const StoredManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sourceId: Schema.String,
  createdAt: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      size: Schema.Number,
      sha256: Schema.String,
    }),
  ),
});
const decodeStoredManifest = Schema.decodeUnknownSync(Schema.fromJsonString(StoredManifest));
type StoredManifest = typeof StoredManifest.Type;

const isGameOperationError = Schema.is(GameOperationError);
const failure = (
  operation: string,
  path: string,
  reason: "io" | "invalid-input" | "invalid-path",
  detail?: string,
  cause?: unknown,
) =>
  new GameOperationError({
    operation,
    path,
    reason,
    ...(detail === undefined ? {} : { detail }),
    ...(cause === undefined ? {} : { cause }),
  });
const attempt = <A>(operation: string, path: string, work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) =>
      isGameOperationError(cause) ? cause : failure(operation, path, "io", undefined, cause),
  });

/** A game-relative path is the only shape this store writes or deletes. */
const safeRelativePath = (value: string): string => {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw failure(
      "game snapshot",
      value,
      "invalid-path",
      "A snapshot path must stay inside the game.",
    );
  return value;
};

/**
 * Generated trees stay out of the snapshot: the repository metadata, every
 * engine import cache and every build are reproducible, and including them
 * would make one source tree look different on two machines. Blender writes
 * `.blend1` backups beside the originals; those are generated too.
 */
const excludedDirectory = (parts: readonly string[]): boolean =>
  parts[0] === ".git" || parts[0] === "builds" || parts.includes(".godot");
const excludedFile = (name: string): boolean => name.endsWith(".blend1");

interface WalkedFile {
  readonly path: string;
  readonly absolute: string;
  /** Source permissions, so a restore does not silently drop an executable bit. */
  readonly mode: number;
}

/**
 * Walks the tree with `lstat` on each entry rather than trusting the Dirent
 * from `readdir`: the entry can be replaced between the two calls, and a
 * symlink must never be followed outside the game.
 */
const walk = async (
  root: string,
  operation: string,
  limits: { readonly maxEntries: number; readonly maxBytes: number },
): Promise<readonly WalkedFile[]> => {
  const walked: WalkedFile[] = [];
  let visited = 0;
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relativeDirectory = stack.pop()!;
    const absoluteDirectory = NodePath.join(root, relativeDirectory);
    let names: readonly string[];
    try {
      names = await NodeFSP.readdir(absoluteDirectory);
    } catch (cause) {
      throw failure(operation, absoluteDirectory, "io", undefined, cause);
    }
    for (const name of names) {
      visited += 1;
      if (visited > limits.maxEntries)
        throw failure(
          operation,
          root,
          "invalid-input",
          `The game has more than ${limits.maxEntries} files, past the snapshot bound.`,
        );
      const relative = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const absolute = NodePath.join(root, relative);
      let stat: NodeFS.Stats;
      try {
        stat = await NodeFSP.lstat(absolute);
      } catch (cause) {
        throw failure(operation, absolute, "io", undefined, cause);
      }
      // Following a link would snapshot bytes the engine may not have loaded and
      // could copy anything on the machine into the round store.
      if (stat.isSymbolicLink())
        throw failure(
          operation,
          absolute,
          "invalid-path",
          "The game contains a symlink; snapshots only cover real files inside it.",
        );
      if (stat.isDirectory()) {
        if (!excludedDirectory(relative.split("/"))) stack.push(relative);
        continue;
      }
      if (!stat.isFile())
        throw failure(
          operation,
          absolute,
          "invalid-path",
          "The game contains a file type a snapshot cannot copy.",
        );
      if (excludedFile(name)) continue;
      walked.push({ path: relative, absolute, mode: stat.mode & 0o777 });
    }
  }
  return walked.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
};

/**
 * Hashes the bytes that are actually read. `remaining` is the part of the
 * tree-wide byte budget still available, so a file that grew after the walk
 * cannot push the tree past the bound.
 */
const hashFileBounded = async (
  absolute: string,
  remaining: number,
  bound: number,
  operation: string,
  root: string,
): Promise<{ size: number; sha256: string }> => {
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(absolute, READ_FLAGS);
  } catch (cause) {
    throw failure(operation, absolute, "io", undefined, cause);
  }
  const hash = NodeCrypto.createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > remaining)
        throw failure(
          operation,
          root,
          "invalid-input",
          `The game is larger than the ${Math.round(bound / (1024 * 1024))} MB snapshot bound.`,
        );
      hash.update(chunk as Buffer);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { size, sha256: hash.digest("hex") };
};

/** The identity every decision uses: paths and bytes, sorted, never mtime. */
export const gameSourceId = (files: readonly GameSourceFile[]): string => {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of files) hash.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  return hash.digest("hex");
};

const compareFiles = (
  expected: readonly GameSourceFile[],
  current: readonly GameSourceFile[],
): { modified: string[]; added: string[]; deleted: string[] } => {
  const before = new Map(expected.map((file) => [file.path, file]));
  const after = new Map(current.map((file) => [file.path, file]));
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  for (const [path, file] of after) {
    const previous = before.get(path);
    if (previous === undefined) added.push(path);
    else if (previous.size !== file.size || previous.sha256 !== file.sha256) modified.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) deleted.push(path);
  return { modified, added, deleted };
};

export class GameSnapshots extends Context.Service<
  GameSnapshots,
  {
    /** Hashes the current game-owned tree without writing anything. */
    readonly capture: (root: string) => Effect.Effect<GameSourceManifest, GameOperationError>;
    /** Hashes and copies the tree into the immutable snapshot store. */
    readonly store: (root: string) => Effect.Effect<StoredGameSnapshot, GameOperationError>;
    /** Reads a snapshot this store wrote. */
    readonly read: (
      root: string,
      sourceId: string,
    ) => Effect.Effect<StoredGameSnapshot, GameOperationError>;
    /** What changed between the expected manifest and the tree now. */
    readonly compare: (
      root: string,
      expected: GameSourceManifest,
    ) => Effect.Effect<GameSourceComparison, GameOperationError>;
    /**
     * Restores the snapshot's files (re-creating deleted ones and removing
     * added ones). Every path is re-verified immediately before it is written
     * or deleted; the first mismatch stops the restore with `blocked`.
     */
    readonly restore: (
      root: string,
      snapshot: GameSourceManifest,
      options?: GameSnapshotRestoreOptions,
    ) => Effect.Effect<GameSnapshotRestore, GameOperationError>;
  }
>()("t3/game/GameSnapshots") {}

export const layer = (options: {
  readonly stateDir: string;
  /** Tests use small bounds to prove the fail-closed paths. */
  readonly maxEntries?: number | undefined;
  readonly maxBytes?: number | undefined;
  /** Test seam for interleaving an edit between the tree read and one mutation. */
  readonly beforePath?: GameSnapshotRestoreOptions["beforePath"];
}) => {
  const limits = {
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
  };
  const rootDirectory = async (root: string): Promise<string> => {
    const canonical = await NodeFSP.realpath(NodePath.resolve(root));
    return gameRecordFile(options.stateDir, "game-snapshots", canonical, "");
  };
  const snapshotDirectory = async (root: string, sourceId: string): Promise<string> =>
    NodePath.join(await rootDirectory(root), safeRelativePath(sourceId));

  const capture = async (root: string): Promise<GameSourceManifest> => {
    const walked = await walk(root, "game snapshot", limits);
    const files: GameSourceFile[] = [];
    let bytes = 0;
    for (const file of walked) {
      const hashed = await hashFileBounded(
        file.absolute,
        limits.maxBytes - bytes,
        limits.maxBytes,
        "game snapshot",
        root,
      );
      bytes += hashed.size;
      files.push({ path: file.path, ...hashed });
    }
    return { sourceId: gameSourceId(files), files };
  };

  const store = async (root: string): Promise<StoredGameSnapshot> => {
    const walked = await walk(root, "game snapshot", limits);
    const parent = await rootDirectory(root);
    const temporary = NodePath.join(parent, `.staging-${NodeCrypto.randomUUID()}`);
    const files: GameSourceFile[] = [];
    let bytes = 0;
    try {
      await NodeFSP.mkdir(NodePath.join(temporary, "files"), { recursive: true });
      for (const file of walked) {
        const relative = safeRelativePath(file.path);
        const target = NodePath.join(temporary, "files", relative);
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        // Hash the bytes written, not a separate read: a source change between
        // reading and copying cannot leave the copy and its manifest disagreeing.
        const hash = NodeCrypto.createHash("sha256");
        let size = 0;
        const meter = new NodeStream.Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (bytes + size > limits.maxBytes) {
              callback(
                new Error(
                  `The game is larger than the ${Math.round(limits.maxBytes / (1024 * 1024))} MB snapshot bound.`,
                ),
              );
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        let handle: NodeFSP.FileHandle;
        try {
          handle = await NodeFSP.open(file.absolute, READ_FLAGS);
        } catch (cause) {
          throw failure("game snapshot", file.absolute, "io", undefined, cause);
        }
        try {
          await NodeStreamPromises.pipeline(
            handle.createReadStream({ autoClose: false }),
            meter,
            NodeFS.createWriteStream(target, { flags: "wx", mode: 0o600 }),
          );
        } catch (cause) {
          if (isGameOperationError(cause)) throw cause;
          if (size + bytes > limits.maxBytes)
            throw failure(
              "game snapshot",
              root,
              "invalid-input",
              `The game is larger than the ${Math.round(limits.maxBytes / (1024 * 1024))} MB snapshot bound.`,
              cause,
            );
          throw failure("game snapshot", file.absolute, "io", undefined, cause);
        } finally {
          await handle.close().catch(() => undefined);
        }
        bytes += size;
        await NodeFSP.chmod(target, file.mode);
        files.push({ path: relative, size, sha256: hash.digest("hex") });
      }
      files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
      const manifest: GameSourceManifest = { sourceId: gameSourceId(files), files };
      const stored: StoredManifest = {
        schemaVersion: 1,
        sourceId: manifest.sourceId,
        createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
        files: [...files],
      };
      await NodeFSP.writeFile(
        NodePath.join(temporary, "manifest.json"),
        `${JSON.stringify(stored, null, 2)}\n`,
      );
      const final = NodePath.join(parent, manifest.sourceId);
      await NodeFSP.mkdir(parent, { recursive: true });
      const existing = await NodeFSP.readFile(NodePath.join(final, "manifest.json"), "utf8").then(
        (text) => decodeStoredManifest(text).sourceId,
        () => null,
      );
      if (existing === manifest.sourceId) {
        await NodeFSP.rm(temporary, { recursive: true, force: true });
        return { manifest, directory: final };
      }
      if (existing !== null) await NodeFSP.rm(final, { recursive: true, force: true });
      await NodeFSP.rename(temporary, final);
      return { manifest, directory: final };
    } catch (cause) {
      await NodeFSP.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw isGameOperationError(cause)
        ? cause
        : failure("game snapshot", root, "io", undefined, cause);
    }
  };

  const read = async (root: string, sourceId: string): Promise<StoredGameSnapshot> => {
    const directory = await snapshotDirectory(root, sourceId);
    let stored: StoredManifest;
    try {
      stored = decodeStoredManifest(
        await NodeFSP.readFile(NodePath.join(directory, "manifest.json"), "utf8"),
      );
    } catch (cause) {
      throw failure(
        "read game snapshot",
        directory,
        "io",
        "The previous version this round would restore is missing or unreadable.",
        cause,
      );
    }
    if (stored.sourceId !== sourceId)
      throw failure(
        "read game snapshot",
        directory,
        "io",
        "The stored snapshot does not describe the source identity it is filed under.",
      );
    return { manifest: { sourceId: stored.sourceId, files: stored.files }, directory };
  };

  const lstatOrNull = async (path: string): Promise<NodeFS.Stats | null> => {
    try {
      return await NodeFSP.lstat(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }
  };

  /**
   * Verifies that a path still has the bytes the entrance capture saw and is a
   * real file, right before its mutation. Returns a blocked detail otherwise.
   */
  const verifyUnchanged = async (
    root: string,
    relative: string,
    expected: GameSourceFile,
  ): Promise<string | null> => {
    const target = NodePath.join(root, safeRelativePath(relative));
    const stat = await lstatOrNull(target);
    if (stat === null) return `${relative} disappeared after the game folder was read.`;
    if (stat.isSymbolicLink())
      return `${relative} became a symlink after the game folder was read; nothing was restored.`;
    if (!stat.isFile()) return `${relative} is no longer a regular file; nothing was restored.`;
    const hashed = await hashFileBounded(
      target,
      limits.maxBytes,
      limits.maxBytes,
      "restore game snapshot",
      root,
    );
    if (hashed.size !== expected.size || hashed.sha256 !== expected.sha256)
      return `${relative} changed after the game folder was read; nothing was restored.`;
    return null;
  };

  /**
   * Verifies every existing parent is a real directory, creating only the ones
   * that are missing. A parent replaced with a symlink must never redirect a
   * write outside the game.
   */
  const ensureParents = async (root: string, relative: string): Promise<string | null> => {
    const parts = safeRelativePath(relative).split("/");
    parts.pop();
    let current = root;
    for (const part of parts) {
      current = NodePath.join(current, part);
      const stat = await lstatOrNull(current);
      if (stat === null) {
        await NodeFSP.mkdir(current);
        const created = await NodeFSP.lstat(current);
        if (!created.isDirectory() || created.isSymbolicLink())
          return `${NodePath.relative(root, current)} is not a real directory; nothing was restored.`;
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory())
        return `${NodePath.relative(root, current)} is not a real directory; nothing was restored.`;
    }
    return null;
  };

  /**
   * A deletion must not follow a parent swapped for a symlink either: unlinking
   * through it would remove a file outside the game. Missing parents mean the
   * path already moved, which is also a mismatch.
   */
  const verifyParents = async (root: string, relative: string): Promise<string | null> => {
    const parts = safeRelativePath(relative).split("/");
    parts.pop();
    let current = root;
    for (const part of parts) {
      current = NodePath.join(current, part);
      const stat = await lstatOrNull(current);
      if (stat === null)
        return `${NodePath.relative(root, current)} disappeared after the game folder was read.`;
      if (stat.isSymbolicLink() || !stat.isDirectory())
        return `${NodePath.relative(root, current)} is not a real directory; nothing was restored.`;
    }
    return null;
  };

  /** Every component of `directory`, including itself, must be a real directory. */
  const verifyDirectoryChain = async (root: string, directory: string): Promise<string | null> => {
    let current = root;
    for (const part of safeRelativePath(directory).split("/")) {
      current = NodePath.join(current, part);
      const stat = await lstatOrNull(current);
      if (stat === null) return null;
      if (stat.isSymbolicLink() || !stat.isDirectory())
        return `${NodePath.relative(root, current)} is not a real directory; nothing was restored.`;
    }
    return null;
  };

  const ancestry = (relative: string): readonly string[] => {
    const parts = relative.split("/");
    parts.pop();
    const directories: string[] = [];
    while (parts.length > 0) {
      directories.push(parts.join("/"));
      parts.pop();
    }
    return directories;
  };

  const restore = async (
    root: string,
    snapshot: GameSourceManifest,
    restoreOptions?: GameSnapshotRestoreOptions,
  ): Promise<GameSnapshotRestore> => {
    // Work on the real root so a lexical alias cannot point a verified parent
    // at one tree while the write lands in another.
    const canonical = await NodeFSP.realpath(NodePath.resolve(root));
    const current = await capture(canonical);
    if (
      restoreOptions?.expectSourceId !== undefined &&
      current.sourceId !== restoreOptions.expectSourceId
    )
      return {
        kind: "blocked",
        sourceId: current.sourceId,
        detail:
          "The game folder changed after the repair finished, so the previous version was not restored.",
      };
    const stored = await read(canonical, snapshot.sourceId);
    const before = new Map(snapshot.files.map((file) => [file.path, file]));
    const after = new Map(current.files.map((file) => [file.path, file]));
    const deleted: string[] = [];
    const repairDirectories = new Set<string>();
    for (const path of after.keys()) {
      if (before.has(path)) continue;
      await restoreOptions?.beforePath?.("delete", path);
      const parentMismatch = await verifyParents(canonical, path);
      if (parentMismatch !== null)
        return { kind: "blocked", sourceId: current.sourceId, detail: parentMismatch };
      const mismatch = await verifyUnchanged(canonical, path, after.get(path)!);
      if (mismatch !== null)
        return { kind: "blocked", sourceId: current.sourceId, detail: mismatch };
      const target = NodePath.join(canonical, safeRelativePath(path));
      try {
        await NodeFSP.rm(target, { force: true });
      } catch (cause) {
        throw failure("restore game snapshot", target, "io", undefined, cause);
      }
      deleted.push(path);
      for (const directory of ancestry(path)) repairDirectories.add(directory);
    }
    // A repair that turned a file into a directory leaves the directory behind
    // after its files are deleted; a restore of the file needs it gone.
    for (const directory of [...repairDirectories].sort(
      (left, right) => right.split("/").length - left.split("/").length,
    )) {
      if (excludedDirectory(directory.split("/"))) continue;
      const chainMismatch = await verifyDirectoryChain(canonical, directory);
      if (chainMismatch !== null)
        return { kind: "blocked", sourceId: current.sourceId, detail: chainMismatch };
      const absolute = NodePath.join(canonical, safeRelativePath(directory));
      const stat = await lstatOrNull(absolute);
      if (stat === null) continue;
      if (!stat.isDirectory()) continue;
      const entries = await NodeFSP.readdir(absolute);
      if (entries.length === 0) await NodeFSP.rmdir(absolute);
    }
    const restored: string[] = [];
    for (const file of snapshot.files) {
      const relative = safeRelativePath(file.path);
      const existing = after.get(relative);
      if (existing?.sha256 === file.sha256 && existing.size === file.size) continue;
      await restoreOptions?.beforePath?.("restore", relative);
      const target = NodePath.join(canonical, relative);
      const state = await lstatOrNull(target);
      if (state !== null) {
        if (state.isSymbolicLink())
          return {
            kind: "blocked",
            sourceId: current.sourceId,
            detail: `${relative} became a symlink after the game folder was read; nothing was restored.`,
          };
        if (state.isDirectory()) {
          const entries = await NodeFSP.readdir(target);
          if (entries.length > 0)
            return {
              kind: "blocked",
              sourceId: current.sourceId,
              detail: `${relative} is a directory holding files the snapshot does not; nothing was restored.`,
            };
          await NodeFSP.rmdir(target);
        } else if (state.isFile()) {
          const hashed = await hashFileBounded(
            target,
            limits.maxBytes,
            limits.maxBytes,
            "restore game snapshot",
            canonical,
          );
          if (
            existing === undefined ||
            hashed.size !== existing.size ||
            hashed.sha256 !== existing.sha256
          )
            return {
              kind: "blocked",
              sourceId: current.sourceId,
              detail: `${relative} changed after the game folder was read; nothing was restored.`,
            };
        } else
          return {
            kind: "blocked",
            sourceId: current.sourceId,
            detail: `${relative} is not a file the snapshot can replace; nothing was restored.`,
          };
      } else if (existing !== undefined)
        return {
          kind: "blocked",
          sourceId: current.sourceId,
          detail: `${relative} disappeared after the game folder was read; nothing was restored.`,
        };
      const parentMismatch = await ensureParents(canonical, relative);
      if (parentMismatch !== null)
        return { kind: "blocked", sourceId: current.sourceId, detail: parentMismatch };
      const source = NodePath.join(stored.directory, "files", relative);
      const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
      try {
        await NodeFSP.copyFile(source, temporary);
        const mode = await NodeFSP.stat(source).then(
          (stat) => stat.mode & 0o777,
          () => null,
        );
        if (mode !== null) await NodeFSP.chmod(temporary, mode);
        await NodeFSP.rename(temporary, target);
      } finally {
        await NodeFSP.rm(temporary, { force: true });
      }
      restored.push(relative);
    }
    const verified = await capture(canonical);
    if (verified.sourceId !== snapshot.sourceId)
      return {
        kind: "blocked",
        sourceId: verified.sourceId,
        detail:
          "The restored folder does not match the snapshot that was written; a concurrent edit changed it again.",
      };
    return { kind: "restored", sourceId: verified.sourceId, restored, deleted };
  };

  return Layer.succeed(
    GameSnapshots,
    GameSnapshots.of({
      capture: (root) => attempt("game snapshot", root, () => capture(root)),
      store: (root) => attempt("game snapshot", root, () => store(root)),
      read: (root, sourceId) => attempt("read game snapshot", root, () => read(root, sourceId)),
      compare: (root, expected) =>
        attempt("compare game snapshot", root, async () => {
          const current = await capture(root);
          const difference = compareFiles(expected.files, current.files);
          return difference.modified.length === 0 &&
            difference.added.length === 0 &&
            difference.deleted.length === 0
            ? { kind: "current" as const, sourceId: current.sourceId }
            : { kind: "changed" as const, sourceId: current.sourceId, ...difference };
        }),
      restore: (root, snapshot, restoreOptions) =>
        attempt("restore game snapshot", root, () =>
          restore(root, snapshot, {
            ...restoreOptions,
            beforePath: restoreOptions?.beforePath ?? options.beforePath,
          }),
        ),
    }),
  );
};
