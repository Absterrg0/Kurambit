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
      /** The tree changed after the caller's expected manifest, so nothing was written. */
      readonly kind: "blocked";
      readonly sourceId: string;
      readonly detail: string;
    };

/**
 * Bounds, not game-size limits. A tree past either bound cannot be identified,
 * so the operation fails instead of guessing that a truncated snapshot is the
 * whole game. Blender originals legitimately reach tens of megabytes; the byte
 * bound leaves room for a large art library while keeping a runaway copy from
 * filling the disk.
 */
const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

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

const isWholeFile = (stat: NodeFS.Stats) => stat.isFile();

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

const walk = async (
  root: string,
  operation: string,
  limits: { readonly maxEntries: number; readonly maxBytes: number },
): Promise<readonly WalkedFile[]> => {
  const walked: WalkedFile[] = [];
  let visited = 0;
  let bytes = 0;
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relativeDirectory = stack.pop()!;
    const entries = await NodeFSP.readdir(NodePath.join(root, relativeDirectory), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      visited += 1;
      if (visited > limits.maxEntries)
        throw failure(
          operation,
          root,
          "invalid-input",
          `The game has more than ${limits.maxEntries} files, past the snapshot bound.`,
        );
      const relative = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const absolute = NodePath.join(root, relative);
      // Following a link would snapshot bytes the engine may not have loaded and
      // could copy anything on the machine into the round store.
      if (entry.isSymbolicLink())
        throw failure(
          operation,
          absolute,
          "invalid-path",
          "The game contains a symlink; snapshots only cover real files inside it.",
        );
      if (entry.isDirectory()) {
        if (!excludedDirectory(relative.split("/"))) stack.push(relative);
        continue;
      }
      const stat = await NodeFSP.stat(absolute);
      if (!isWholeFile(stat))
        throw failure(
          operation,
          absolute,
          "invalid-path",
          "The game contains a file type a snapshot cannot copy.",
        );
      if (excludedFile(entry.name)) continue;
      bytes += stat.size;
      if (bytes > limits.maxBytes)
        throw failure(
          operation,
          root,
          "invalid-input",
          `The game is larger than the ${Math.round(limits.maxBytes / (1024 * 1024))} MB snapshot bound.`,
        );
      walked.push({ path: relative, absolute, mode: stat.mode & 0o777 });
    }
  }
  return walked.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
};

const hashFile = async (absolute: string): Promise<{ size: number; sha256: string }> => {
  const hash = NodeCrypto.createHash("sha256");
  let size = 0;
  for await (const chunk of NodeFS.createReadStream(absolute)) {
    size += chunk.length;
    hash.update(chunk as Buffer);
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
     * added ones). When `expectSourceId` does not match the tree now, nothing is
     * written: the caller asked to restore a folder that changed underneath it.
     */
    readonly restore: (
      root: string,
      snapshot: GameSourceManifest,
      options?: { readonly expectSourceId?: string | undefined },
    ) => Effect.Effect<GameSnapshotRestore, GameOperationError>;
  }
>()("t3/game/GameSnapshots") {}

export const layer = (options: {
  readonly stateDir: string;
  /** Tests use small bounds to prove the fail-closed paths. */
  readonly maxEntries?: number | undefined;
  readonly maxBytes?: number | undefined;
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
    for (const file of walked) files.push({ path: file.path, ...(await hashFile(file.absolute)) });
    return { sourceId: gameSourceId(files), files };
  };

  const store = async (root: string): Promise<StoredGameSnapshot> => {
    const walked = await walk(root, "game snapshot", limits);
    const parent = await rootDirectory(root);
    const temporary = NodePath.join(parent, `.staging-${NodeCrypto.randomUUID()}`);
    const files: GameSourceFile[] = [];
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
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await NodeStreamPromises.pipeline(
          NodeFS.createReadStream(file.absolute),
          meter,
          NodeFS.createWriteStream(target, { flags: "wx", mode: 0o600 }),
        );
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
      throw cause;
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

  const restore = async (
    root: string,
    snapshot: GameSourceManifest,
    expectedSourceId?: string,
  ): Promise<GameSnapshotRestore> => {
    const current = await capture(root);
    if (expectedSourceId !== undefined && current.sourceId !== expectedSourceId)
      return {
        kind: "blocked",
        sourceId: current.sourceId,
        detail:
          "The game folder changed after the repair finished, so the previous version was not restored.",
      };
    const stored = await read(root, snapshot.sourceId);
    const before = new Map(snapshot.files.map((file) => [file.path, file]));
    const after = new Map(current.files.map((file) => [file.path, file]));
    const deleted: string[] = [];
    for (const path of after.keys()) {
      if (before.has(path)) continue;
      await NodeFSP.rm(NodePath.join(root, safeRelativePath(path)), { force: true });
      deleted.push(path);
    }
    const restored: string[] = [];
    for (const file of snapshot.files) {
      const relative = safeRelativePath(file.path);
      const target = NodePath.join(root, relative);
      const existing = after.get(relative);
      if (existing?.sha256 === file.sha256 && existing.size === file.size) continue;
      const source = NodePath.join(stored.directory, "files", relative);
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
      try {
        await NodeFSP.copyFile(source, temporary);
        await NodeFSP.rename(temporary, target);
      } finally {
        await NodeFSP.rm(temporary, { force: true });
      }
      const mode = await NodeFSP.stat(source).then(
        (stat) => stat.mode & 0o777,
        () => null,
      );
      if (mode !== null) await NodeFSP.chmod(target, mode);
      restored.push(relative);
    }
    const verified = await capture(root);
    if (verified.sourceId !== snapshot.sourceId)
      throw failure(
        "restore game snapshot",
        root,
        "io",
        "The restored folder does not match the snapshot that was written.",
      );
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
          restore(root, snapshot, restoreOptions?.expectSourceId),
        ),
    }),
  );
};
