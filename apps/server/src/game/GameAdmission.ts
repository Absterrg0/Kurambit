// @effect-diagnostics nodeBuiltinImport:off -- The admission record and its lock are server state keyed by the game root.
// @effect-diagnostics preferSchemaOverJson:off -- The record is written with the schema encoder below.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { GameOperationError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { gameRecordLocation, readRecordText } from "./gameRecord.ts";

/**
 * The persisted count of user actions admitted to a game. A loop captures the
 * generation it started under and rechecks it before every dispatch and before
 * promotion; a later action therefore cannot be outrun by a loop that was
 * still deciding when the action began.
 */
const AdmissionRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** When the last action was admitted, ISO; null before the first. */
  admittedAt: Schema.NullOr(Schema.String),
});
const decodeAdmission = Schema.decodeUnknownSync(Schema.fromJsonString(AdmissionRecord));

export interface GameAdmissionStamp {
  readonly generation: number;
  readonly admittedAt: string | null;
}

/**
 * One live loop, registered while it owns a game. Admission calls `interrupt`
 * under the same gate the loop starts under, so stopping a loop and creating
 * one can never interleave; `owns` lets a loop's own child act without
 * interrupting the loop that is waiting for it.
 */
export interface GameAdmissionEntry {
  readonly interrupt: (reason: string) => Effect.Effect<void, GameOperationError>;
  readonly owns: (threadId: ThreadId) => Effect.Effect<boolean>;
}

export class GameAdmission extends Context.Service<
  GameAdmission,
  {
    /** Serializes every entry point for one game root. */
    readonly withGate: <A, E, R>(
      root: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly stamp: (root: string) => Effect.Effect<GameAdmissionStamp, GameOperationError>;
    /**
     * A user action takes the game: the generation advances first, then the
     * registered loop is interrupted and joined. The action must not proceed
     * when the join fails.
     */
    readonly admit: (input: {
      readonly root: string;
      readonly reason: string;
      readonly threadId?: ThreadId | undefined;
    }) => Effect.Effect<void, GameOperationError>;
    /** Called by the loop under `withGate`; the entry is live until unregistered. */
    readonly register: (root: string, entry: GameAdmissionEntry) => Effect.Effect<void>;
    readonly unregister: (root: string, entry: GameAdmissionEntry) => Effect.Effect<void>;
  }
>()("t3/game/GameAdmission") {}

export const layer = (options: { readonly stateDir: string }) =>
  Layer.effect(
    GameAdmission,
    Effect.gen(function* () {
      const locks = new Map<string, Semaphore.Semaphore>();
      const entries = new Map<string, GameAdmissionEntry>();

      const lockFor = (root: string) => {
        const key = NodePath.resolve(root);
        const existing = locks.get(key);
        if (existing !== undefined) return existing;
        const created = Semaphore.makeUnsafe(1);
        locks.set(key, created);
        return created;
      };

      const fileFor = (root: string) =>
        Effect.tryPromise({
          try: () => gameRecordLocation(options.stateDir, "game-admission", root),
          catch: (cause) =>
            new GameOperationError({
              operation: "read game admission",
              path: root,
              reason: "io",
              cause,
            }),
        });

      const stamp: GameAdmission["Service"]["stamp"] = (root) =>
        Effect.gen(function* () {
          const found = yield* fileFor(root);
          const text = yield* Effect.tryPromise({
            try: () => readRecordText(found.file),
            catch: (cause) =>
              new GameOperationError({
                operation: "read game admission",
                path: found.file,
                reason: "io",
                cause,
              }),
          });
          if (text === null) return { generation: 0, admittedAt: null };
          // A corrupt counter must not read as "nobody acted"; that would let a
          // stale loop promote over the user. Fail the admission read instead.
          return yield* Effect.try({
            try: () => decodeAdmission(text),
            catch: (cause) =>
              new GameOperationError({
                operation: "read game admission",
                path: found.file,
                reason: "io",
                detail: "The game admission record is unreadable.",
                cause,
              }),
          }).pipe(
            Effect.map((record) => ({
              generation: record.generation,
              admittedAt: record.admittedAt,
            })),
          );
        });

      const bump: GameAdmission["Service"]["admit"] = ({ root, reason, threadId }) =>
        Effect.gen(function* () {
          // Only a real game folder takes part: an ordinary T3 project must not
          // grow an admission record just because its thread received a turn.
          const key = NodePath.resolve(root);
          const isGame = yield* Effect.tryPromise({
            try: async () => {
              await NodeFSP.stat(NodePath.join(key, "game.json"));
              return true;
            },
            catch: () => false,
          }).pipe(Effect.orElseSucceed(() => false));
          // An ordinary project has nothing to supersede. A root that still has
          // a registered loop must always be stopped, even if its manifest was
          // removed while the review ran.
          if (!isGame && !entries.has(key)) return;
          yield* lockFor(root).withPermits(1)(
            Effect.gen(function* () {
              const found = yield* fileFor(root);
              const current = yield* stamp(root);
              const record = {
                schemaVersion: 1 as const,
                generation: current.generation + 1,
                admittedAt: DateTime.formatIso(DateTime.nowUnsafe()),
              };
              yield* Effect.tryPromise({
                try: async () => {
                  await NodeFSP.mkdir(NodePath.dirname(found.file), { recursive: true });
                  const temporary = `${found.file}.${NodeCrypto.randomUUID()}.tmp`;
                  try {
                    await NodeFSP.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
                    await NodeFSP.rename(temporary, found.file);
                  } finally {
                    await NodeFSP.rm(temporary, { force: true });
                  }
                },
                catch: (cause) =>
                  new GameOperationError({
                    operation: "write game admission",
                    path: found.file,
                    reason: "io",
                    cause,
                  }),
              });
              const entry = entries.get(NodePath.resolve(root));
              if (entry === undefined) return;
              if (threadId !== undefined && (yield* entry.owns(threadId))) {
                // A loop's own child doing something inside its round is not a
                // user action; interrupting the loop would kill its caller.
                return;
              }
              yield* entry.interrupt(reason).pipe(
                Effect.mapError(
                  (cause) =>
                    new GameOperationError({
                      operation: "supersede game review",
                      path: found.file,
                      reason: cause.reason,
                      ...(cause.detail === null || cause.detail === undefined
                        ? {}
                        : { detail: cause.detail }),
                      cause,
                    }),
                ),
              );
            }),
          );
        });

      return GameAdmission.of({
        withGate: (root, effect) => lockFor(root).withPermits(1)(effect),
        stamp,
        admit: bump,
        register: (root, entry) =>
          Effect.sync(() => {
            entries.set(NodePath.resolve(root), entry);
          }),
        unregister: (root, entry) =>
          Effect.sync(() => {
            const key = NodePath.resolve(root);
            if (entries.get(key) === entry) entries.delete(key);
          }),
      });
    }),
  );
