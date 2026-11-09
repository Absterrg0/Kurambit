import {
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  StoredOrchestrationShellSnapshot,
  StoredOrchestrationThreadSnapshot,
  decodeOrDiscardOrchestrationCache,
  Persistence,
  makeStoredShellSnapshotEncoder,
} from "@kurambit/client-runtime/platform";
import { ConnectionTransientError } from "@kurambit/client-runtime/connection";
import { EnvironmentId, ServerConfig, ThreadId, VcsListRefsResult } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { projectFaviconCache } from "../assets/projectFaviconCache";

const DATABASE_NAME = "kurambit:connection-runtime";
const DATABASE_VERSION = 4;
const SHELL_STORE_NAME = "shell";
const THREAD_STORE_NAME = "thread";
const SERVER_CONFIG_STORE_NAME = "server-config";
const VCS_REFS_STORE_NAME = "vcs-refs";
const StoredShellSnapshot = StoredOrchestrationShellSnapshot;
const StoredShellSnapshotJson = Schema.fromJsonString(StoredShellSnapshot);
const StoredThreadSnapshot = StoredOrchestrationThreadSnapshot;
const StoredThreadSnapshotJson = Schema.fromJsonString(StoredThreadSnapshot);
const StoredServerConfig = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  config: ServerConfig,
});
const StoredServerConfigJson = Schema.fromJsonString(StoredServerConfig);
const StoredVcsRefs = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  cwd: Schema.String,
  refs: VcsListRefsResult,
});
const StoredVcsRefsJson = Schema.fromJsonString(StoredVcsRefs);
const decodeStoredShellSnapshot = Schema.decodeUnknownEffect(StoredShellSnapshotJson);
const decodeStoredThreadSnapshot = Schema.decodeUnknownEffect(StoredThreadSnapshotJson);
const encodeStoredThreadSnapshot = Schema.encodeEffect(StoredThreadSnapshotJson);
const decodeStoredServerConfig = Schema.decodeUnknownEffect(StoredServerConfigJson);
const encodeStoredServerConfig = Schema.encodeEffect(StoredServerConfigJson);
const decodeStoredVcsRefs = Schema.decodeUnknownEffect(StoredVcsRefsJson);
const encodeStoredVcsRefs = Schema.encodeEffect(StoredVcsRefsJson);

function databaseError(operation: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not ${operation} the local connection cache: ${String(cause)}`,
  });
}

function persistenceError(
  operation:
    | "load-shell"
    | "save-shell"
    | "load-thread"
    | "save-thread"
    | "remove-thread"
    | "load-server-config"
    | "save-server-config"
    | "load-vcs-refs"
    | "save-vcs-refs"
    | "remove-vcs-refs"
    | "clear-vcs-refs"
    | "clear-environment",
  cause: unknown,
) {
  return new Persistence.ConnectionPersistenceError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}: ${String(cause)}`,
  });
}

const openDatabase = Effect.fn("web.connectionStorage.openDatabase")(function* () {
  return yield* Effect.callback<IDBDatabase, ConnectionTransientError>((resume) => {
    if (typeof indexedDB === "undefined") {
      resume(
        Effect.fail(databaseError("open", "IndexedDB is unavailable in this browser context.")),
      );
      return;
    }
    try {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(SHELL_STORE_NAME)) {
          request.result.createObjectStore(SHELL_STORE_NAME);
        }
        if (!request.result.objectStoreNames.contains(THREAD_STORE_NAME)) {
          request.result.createObjectStore(THREAD_STORE_NAME);
        }
        if (!request.result.objectStoreNames.contains(SERVER_CONFIG_STORE_NAME)) {
          request.result.createObjectStore(SERVER_CONFIG_STORE_NAME);
        }
        if (!request.result.objectStoreNames.contains(VCS_REFS_STORE_NAME)) {
          request.result.createObjectStore(VCS_REFS_STORE_NAME);
        }
      });
      request.addEventListener("error", () => {
        resume(Effect.fail(databaseError("open", request.error ?? "Unknown IndexedDB error")));
      });
      request.addEventListener("success", () => {
        resume(Effect.succeed(request.result));
      });
    } catch (cause) {
      resume(Effect.fail(databaseError("open", cause)));
    }
  });
});

interface DatabaseHandle {
  readonly get: Effect.Effect<IDBDatabase, ConnectionTransientError>;
  readonly invalidate: (database: IDBDatabase) => Effect.Effect<void>;
}

const makeDatabaseHandle = Effect.fn("web.connectionStorage.makeDatabaseHandle")(function* () {
  const lock = yield* Semaphore.make(1);
  let current: IDBDatabase | null = null;
  const forget = (database: IDBDatabase) => {
    if (current === database) current = null;
  };
  const get = Effect.suspend(() =>
    current !== null
      ? Effect.succeed(current)
      : lock.withPermits(1)(
          Effect.gen(function* () {
            if (current !== null) return current;
            const opened = yield* openDatabase();
            current = opened;
            opened.addEventListener("close", () => forget(opened));
            // Another tab upgrading the schema waits on this connection.
            opened.addEventListener("versionchange", () => {
              forget(opened);
              opened.close();
            });
            return opened;
          }),
        ),
  );
  const close = lock.withPermits(1)(
    Effect.sync(() => {
      current?.close();
      current = null;
    }),
  );
  const handle: DatabaseHandle = {
    get,
    invalidate: (database) => Effect.sync(() => forget(database)),
  };
  return { handle, close };
});

/**
 * A connection the browser already closed throws InvalidStateError even when no
 * close event reached this tab, so drop it and retry once on a fresh one
 * instead of failing every later operation.
 */
function withDatabase<A>(
  database: DatabaseHandle,
  use: (opened: IDBDatabase) => Effect.Effect<A, ConnectionTransientError>,
) {
  const closedConnection = Symbol("closedConnection");
  const attempt = Effect.flatMap(database.get, (opened) =>
    use(opened).pipe(
      Effect.catchIf(
        (error) => error.detail.includes("InvalidStateError"),
        (error) =>
          database
            .invalidate(opened)
            .pipe(Effect.andThen(Effect.fail({ [closedConnection]: error } as const))),
      ),
    ),
  );
  return attempt.pipe(
    Effect.catchIf(
      (error): error is { readonly [closedConnection]: ConnectionTransientError } =>
        closedConnection in error,
      () => Effect.flatMap(database.get, use),
    ),
  );
}

function readDatabaseValueOnConnection(database: IDBDatabase, storeName: string, key: IDBValidKey) {
  return Effect.callback<unknown, ConnectionTransientError>((resume) => {
    try {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
      request.addEventListener("error", () => {
        resume(Effect.fail(databaseError("read", request.error ?? "Unknown IndexedDB read error")));
      });
      request.addEventListener("success", () => {
        resume(Effect.succeed(request.result));
      });
    } catch (cause) {
      resume(Effect.fail(databaseError("read", cause)));
    }
  }).pipe(Effect.withSpan("web.connectionStorage.readDatabaseValue"));
}

function writeDatabaseValueOnConnection(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  value: unknown,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    try {
      const transaction = database.transaction(storeName, "readwrite");
      // Every failed write fires "abort". A failed commit, such as
      // QuotaExceededError, fires only "abort" and no "error".
      transaction.addEventListener("abort", () => {
        resume(
          Effect.fail(databaseError("write", transaction.error ?? "Unknown IndexedDB write error")),
        );
      });
      transaction.addEventListener("complete", () => {
        resume(Effect.void);
      });
      transaction.objectStore(storeName).put(value, key);
    } catch (cause) {
      resume(Effect.fail(databaseError("write", cause)));
    }
  }).pipe(Effect.withSpan("web.connectionStorage.writeDatabaseValue"));
}

function removeDatabaseValueOnConnection(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    try {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.addEventListener("abort", () => {
        resume(
          Effect.fail(
            databaseError("remove", transaction.error ?? "Unknown IndexedDB remove error"),
          ),
        );
      });
      transaction.addEventListener("complete", () => {
        resume(Effect.void);
      });
      transaction.objectStore(storeName).delete(key);
    } catch (cause) {
      resume(Effect.fail(databaseError("remove", cause)));
    }
  }).pipe(Effect.withSpan("web.connectionStorage.removeDatabaseValue"));
}

function removeDatabaseValuesInRangeOnConnection(
  database: IDBDatabase,
  storeName: string,
  range: IDBKeyRange,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    try {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.addEventListener("abort", () => {
        resume(
          Effect.fail(
            databaseError("remove", transaction.error ?? "Unknown IndexedDB cursor error"),
          ),
        );
      });
      transaction.addEventListener("complete", () => {
        resume(Effect.void);
      });
      const request = transaction.objectStore(storeName).openCursor(range);
      request.addEventListener("error", () => {
        resume(
          Effect.fail(databaseError("remove", request.error ?? "Unknown IndexedDB cursor error")),
        );
      });
      request.addEventListener("success", () => {
        const cursor = request.result;
        if (cursor === null) {
          return;
        }
        try {
          cursor.delete();
          cursor.continue();
        } catch (cause) {
          resume(Effect.fail(databaseError("remove", cause)));
        }
      });
    } catch (cause) {
      resume(Effect.fail(databaseError("remove", cause)));
    }
  }).pipe(Effect.withSpan("web.connectionStorage.removeDatabaseValuesInRange"));
}

function readDatabaseValue(database: DatabaseHandle, storeName: string, key: IDBValidKey) {
  return withDatabase(database, (opened) => readDatabaseValueOnConnection(opened, storeName, key));
}

function writeDatabaseValue(
  database: DatabaseHandle,
  storeName: string,
  key: IDBValidKey,
  value: unknown,
) {
  return withDatabase(database, (opened) =>
    writeDatabaseValueOnConnection(opened, storeName, key, value),
  );
}

function removeDatabaseValue(database: DatabaseHandle, storeName: string, key: IDBValidKey) {
  return withDatabase(database, (opened) =>
    removeDatabaseValueOnConnection(opened, storeName, key),
  );
}

function removeDatabaseValuesInRange(
  database: DatabaseHandle,
  storeName: string,
  range: IDBKeyRange,
) {
  return withDatabase(database, (opened) =>
    removeDatabaseValuesInRangeOnConnection(opened, storeName, range),
  );
}

function threadCacheKey(environmentId: EnvironmentId, threadId: ThreadId) {
  return `${environmentId}:${threadId}`;
}

function vcsRefsCacheKey(environmentId: EnvironmentId, cwd: string) {
  return `${environmentId}:${cwd}`;
}

// A posted message resumes in a fresh task, so input and rendering get a turn between
// encoding chunks. A zero-delay timer would not do: browsers clamp nested timers to
// 4 ms and throttle them to once a second or less in a background tab.
const yieldToBrowserTask = Effect.callback<void>((resume) => {
  const { port1, port2 } = new MessageChannel();
  port1.addEventListener(
    "message",
    () => {
      port1.close();
      resume(Effect.void);
    },
    { once: true },
  );
  port1.start();
  port2.postMessage(null);
  // A closed port delivers nothing, so interruption needs no listener bookkeeping.
  return Effect.sync(() => port1.close());
});

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const { handle: database } = yield* Effect.acquireRelease(
      makeDatabaseHandle(),
      (owned) => owned.close,
    );
    // Remembers each thread row's encoding, so a save only encodes rows that changed.
    const encodeStoredShellSnapshot = makeStoredShellSnapshotEncoder({
      yieldToHost: yieldToBrowserTask,
    });

    const cacheStore = Persistence.EnvironmentCacheStore.of({
      loadShell: (environmentId) =>
        readDatabaseValue(database, SHELL_STORE_NAME, environmentId).pipe(
          Effect.tap(() => Effect.promise(() => projectFaviconCache.hydrate())),
          Effect.flatMap((raw) => {
            if (typeof raw !== "string") {
              return Effect.succeedNone;
            }
            return decodeOrDiscardOrchestrationCache(
              decodeStoredShellSnapshot(raw).pipe(
                Effect.mapError((cause) => persistenceError("load-shell", cause)),
                Effect.map((stored) =>
                  stored.environmentId === environmentId
                    ? Option.some(stored.snapshot)
                    : Option.none(),
                ),
              ),
              removeDatabaseValue(database, SHELL_STORE_NAME, environmentId),
            );
          }),
          Effect.mapError((cause) => persistenceError("load-shell", cause)),
        ),
      saveShell: (environmentId, snapshot) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStoredShellSnapshot({
            schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
            environmentId,
            snapshot,
          }).pipe(Effect.mapError((cause) => persistenceError("save-shell", cause)));
          yield* writeDatabaseValue(database, SHELL_STORE_NAME, environmentId, encoded);
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("save-shell", cause),
          ),
        ),
      loadServerConfig: (environmentId) =>
        readDatabaseValue(database, SERVER_CONFIG_STORE_NAME, environmentId).pipe(
          Effect.flatMap((raw) => {
            if (typeof raw !== "string") {
              return Effect.succeedNone;
            }
            return decodeStoredServerConfig(raw).pipe(
              Effect.mapError((cause) => persistenceError("load-server-config", cause)),
              Effect.map((stored) =>
                stored.environmentId === environmentId ? Option.some(stored.config) : Option.none(),
              ),
            );
          }),
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("load-server-config", cause),
          ),
        ),
      saveServerConfig: (environmentId, config) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStoredServerConfig({
            schemaVersion: 1,
            environmentId,
            config,
          }).pipe(Effect.mapError((cause) => persistenceError("save-server-config", cause)));
          yield* writeDatabaseValue(database, SERVER_CONFIG_STORE_NAME, environmentId, encoded);
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("save-server-config", cause),
          ),
        ),
      loadThread: (environmentId, threadId) =>
        readDatabaseValue(
          database,
          THREAD_STORE_NAME,
          threadCacheKey(environmentId, threadId),
        ).pipe(
          Effect.flatMap((raw) => {
            if (typeof raw !== "string") {
              return Effect.succeedNone;
            }
            return decodeOrDiscardOrchestrationCache(
              decodeStoredThreadSnapshot(raw).pipe(
                Effect.mapError((cause) => persistenceError("load-thread", cause)),
                Effect.map((stored) =>
                  stored.environmentId === environmentId && stored.threadId === threadId
                    ? Option.some(stored.snapshot)
                    : Option.none(),
                ),
              ),
              removeDatabaseValue(
                database,
                THREAD_STORE_NAME,
                threadCacheKey(environmentId, threadId),
              ),
            );
          }),
          Effect.mapError((cause) => persistenceError("load-thread", cause)),
        ),
      saveThread: (environmentId, snapshot) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStoredThreadSnapshot({
            schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
            environmentId,
            threadId: snapshot.projection.thread.id,
            snapshot,
          }).pipe(Effect.mapError((cause) => persistenceError("save-thread", cause)));
          yield* writeDatabaseValue(
            database,
            THREAD_STORE_NAME,
            threadCacheKey(environmentId, snapshot.projection.thread.id),
            encoded,
          );
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("save-thread", cause),
          ),
        ),
      loadVcsRefs: (environmentId, cwd) =>
        readDatabaseValue(database, VCS_REFS_STORE_NAME, vcsRefsCacheKey(environmentId, cwd)).pipe(
          Effect.flatMap((raw) => {
            if (typeof raw !== "string") {
              return Effect.succeedNone;
            }
            return decodeStoredVcsRefs(raw).pipe(
              Effect.mapError((cause) => persistenceError("load-vcs-refs", cause)),
              Effect.map((stored) =>
                stored.environmentId === environmentId && stored.cwd === cwd
                  ? Option.some(stored.refs)
                  : Option.none(),
              ),
            );
          }),
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("load-vcs-refs", cause),
          ),
        ),
      saveVcsRefs: (environmentId, cwd, refs) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStoredVcsRefs({
            schemaVersion: 1,
            environmentId,
            cwd,
            refs,
          }).pipe(Effect.mapError((cause) => persistenceError("save-vcs-refs", cause)));
          yield* writeDatabaseValue(
            database,
            VCS_REFS_STORE_NAME,
            vcsRefsCacheKey(environmentId, cwd),
            encoded,
          );
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("save-vcs-refs", cause),
          ),
        ),
      removeVcsRefs: (environmentId, cwd) =>
        removeDatabaseValue(
          database,
          VCS_REFS_STORE_NAME,
          vcsRefsCacheKey(environmentId, cwd),
        ).pipe(Effect.mapError((cause) => persistenceError("remove-vcs-refs", cause))),
      clearVcsRefs: (environmentId) =>
        removeDatabaseValuesInRange(
          database,
          VCS_REFS_STORE_NAME,
          IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
        ).pipe(Effect.mapError((cause) => persistenceError("clear-vcs-refs", cause))),
      removeThread: (environmentId, threadId) =>
        removeDatabaseValue(
          database,
          THREAD_STORE_NAME,
          threadCacheKey(environmentId, threadId),
        ).pipe(Effect.mapError((cause) => persistenceError("remove-thread", cause))),
      clear: (environmentId) =>
        Effect.all(
          [
            Effect.promise(() => projectFaviconCache.clearEnvironment(environmentId)),
            removeDatabaseValue(database, SHELL_STORE_NAME, environmentId),
            removeDatabaseValuesInRange(
              database,
              THREAD_STORE_NAME,
              IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
            ),
            removeDatabaseValue(database, SERVER_CONFIG_STORE_NAME, environmentId),
            removeDatabaseValuesInRange(
              database,
              VCS_REFS_STORE_NAME,
              IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.mapError((cause) => persistenceError("clear-environment", cause))),
    });

    return Context.make(Persistence.EnvironmentCacheStore, cacheStore);
  }),
);
