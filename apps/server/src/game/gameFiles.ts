// @effect-diagnostics nodeBuiltinImport:off -- The game layer's own file writes and tree copies on the native filesystem.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { GameOperationError } from "@kurambit/contracts";
import { writeFileStringAtomically } from "@kurambit/shared/atomicWrite";
import { copyableEntry } from "./gamePath.ts";

/**
 * The shared atomic write for files the server keeps in a game folder (records,
 * the selected build, settings it rewrites), as a game operation's error. Made
 * once per service so its methods need nothing from the environment. A link an
 * agent planted at the target is replaced, never written through, so no write
 * leaves the game folder.
 */
export const makeAtomicWriter = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return (
    filePath: string,
    contents: string,
    operation: string,
  ): Effect.Effect<void, GameOperationError> =>
    writeFileStringAtomically({ filePath, contents, followLink: false }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) => new GameOperationError({ operation, path: filePath, reason: "io", cause }),
      ),
    );
});

/**
 * Copies a tree as cheaply as the filesystem allows: a reflink on Linux
 * (btrfs, XFS), an APFS clone on macOS (libuv's FICLONE; unverified there), a
 * plain copy elsewhere (Windows). Times are kept. An abort stops it between
 * files, because the filter rejects; `fs.cp` cannot be stopped mid-file.
 * Links are copied as links, and only those that stay inside `source`: a game
 * tree is agent-written, and a link out of it would carry the copy (a build,
 * a player, a sample) to whatever it points at. `skip` leaves out more.
 */
export const copyTree = (
  source: string,
  target: string,
  signal?: AbortSignal,
  skip?: (from: string) => boolean,
): Promise<void> =>
  NodeFSP.cp(source, target, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    mode: NodeFSP.constants.COPYFILE_FICLONE,
    filter: async (from) => {
      signal?.throwIfAborted();
      return skip?.(from) !== true && (await copyableEntry(from, source));
    },
  });
