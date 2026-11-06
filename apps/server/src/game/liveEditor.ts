// @effect-diagnostics nodeBuiltinImport:off -- The live editors' records and source guards on the native filesystem.
// What the live editors (GameBlender, GameUnity) share about a session's life:
// its launch record kept in the game folder and under the server's state dir
// (so a crashed server's editor is reaped at the next start even when no one
// reopens its game), whether it is still usable, and the source files it
// holds in memory, which it must never save over once they changed on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type { GameOperationError } from "@kurambit/contracts";
import * as ServerConfig from "../config.ts";
import { makeAtomicWriter } from "./gameFiles.ts";
import { readRecord } from "./liveProcess.ts";

/**
 * Why a live session must not be reused, once something showed it cannot
 * serve another call: its MCP child exited, a call timed out on a frozen
 * main thread, the game froze it. Set once; the session is closed when its
 * last holder lets go, and the next call opens a fresh one.
 */
export interface LiveHealth {
  broken: string | null;
}

export const breakSession = (health: LiveHealth, why: string): void => {
  if (health.broken === null) health.broken = why;
};

/** A file's on-disk identity: a change by anyone but the session moves it. */
const identityOf = (path: string): Promise<string | null> =>
  NodeFSP.stat(path, { bigint: true }).then(
    (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`,
    () => null,
  );

/**
 * The source files a live editor holds in memory and saves without reading
 * the disk first (Blender's live.blend, Unity's open scene). When one changed
 * on disk since the session last opened or saved it (a file restore, the
 * user's own git), the session is stale: saving would write the old scene
 * over the restored one.
 */
export class HeldSources {
  readonly #identities = new Map<string, string | null>();
  /** Records the files as the session now holds them (after an open or a save). */
  async hold(paths: ReadonlyArray<string>): Promise<void> {
    for (const path of paths) this.#identities.set(path, await identityOf(path));
  }
  /** The first held file whose disk copy is no longer the one the session holds, or null. */
  async changed(): Promise<string | null> {
    for (const [path, identity] of this.#identities)
      if ((await identityOf(path)) !== identity) return path;
    return null;
  }
}

/**
 * A kind of live editor's launch records: the game folder's copy (read only
 * while it names its own game, since agents can write it) and the server's
 * own copy under the state dir, both written atomically as each pid appears.
 */
export const makeLiveRecords = <R extends object>(
  kind: string,
  gameFile: (root: string) => string,
) =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const writeAtomic = yield* makeAtomicWriter;
    const directory = NodePath.join(stateDir, kind);
    const serverRecordOf = (root: string) =>
      NodePath.join(
        directory,
        `${NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 24)}.json`,
      );
    const remember = (root: string, record: R): Effect.Effect<void, GameOperationError> => {
      const text = JSON.stringify(record);
      return Effect.andThen(
        writeAtomic(gameFile(root), text, kind),
        writeAtomic(serverRecordOf(root), text, kind),
      );
    };
    /** Every record a previous server left, reaped then removed; a record that does not read reaps nothing. */
    const reapAll = (reap: (record: Partial<R>) => Promise<void>): Effect.Effect<void> =>
      Effect.promise(async () => {
        for (const name of await NodeFSP.readdir(directory).catch(() => [] as string[])) {
          if (!name.endsWith(".json")) continue;
          const file = NodePath.join(directory, name);
          const record = await readRecord<R>(file);
          if (record !== null) await reap(record).catch(() => undefined);
          await NodeFSP.rm(file, { force: true }).catch(() => undefined);
        }
      });
    return { directory, serverRecordOf, remember, reapAll };
  });
