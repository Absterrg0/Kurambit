// @effect-diagnostics nodeBuiltinImport:off -- yauzl and yazl speak Node streams; this file adapts them into Effect.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as Effect from "effect/Effect";
import * as Yauzl from "yauzl";
import * as Yazl from "yazl";

/**
 * Close the scope to close the archive.
 */
export const openZipArchive = Effect.fn("zipArchive.open")(function* <E>(
  archivePath: string,
  makeError: (detail: string, cause: unknown) => E,
) {
  const opened = yield* Effect.acquireRelease(
    Effect.callback<
      {
        readonly zip: Yauzl.ZipFile;
        readonly error: () => E | undefined;
        readonly close: Effect.Effect<void>;
      },
      E
    >((resume) => {
      Yauzl.open(
        archivePath,
        { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true },
        (error, zip) => {
          if (error || !zip) {
            resume(Effect.fail(makeError("Could not open the verified archive.", error)));
            return;
          }
          let closed = false;
          let archiveError: E | undefined;
          zip.on("close", () => {
            closed = true;
          });
          zip.on("error", (cause: unknown) => {
            archiveError = makeError("The archive could not be read.", cause);
          });
          resume(
            Effect.succeed({
              zip,
              error: () => archiveError,
              close: Effect.callback<void>((finish) => {
                if (closed) {
                  finish(Effect.void);
                  return;
                }
                const onClose = () => {
                  zip.removeListener("error", onError);
                  finish(Effect.void);
                };
                const onError = (cause: unknown) => {
                  zip.removeListener("close", onClose);
                  finish(Effect.die(makeError("Could not close the archive.", cause)));
                };
                zip.once("close", onClose);
                zip.once("error", onError);
                zip.close();
              }),
            }),
          );
        },
      );
    }),
    (opened) => opened.close,
  );

  const next = Effect.callback<Yauzl.Entry | null, E>((resume) => {
    const existingError = opened.error();
    if (existingError) {
      resume(Effect.fail(existingError));
      return;
    }
    const cleanup = () => {
      opened.zip.removeListener("entry", onEntry);
      opened.zip.removeListener("end", onEnd);
      opened.zip.removeListener("error", onError);
    };
    const onEntry = (entry: Yauzl.Entry) => {
      cleanup();
      resume(Effect.succeed(entry));
    };
    const onEnd = () => {
      cleanup();
      resume(Effect.succeed(null));
    };
    const onError = (cause: unknown) => {
      cleanup();
      resume(Effect.fail(makeError("The archive could not be read.", cause)));
    };
    opened.zip.once("entry", onEntry);
    opened.zip.once("end", onEnd);
    opened.zip.once("error", onError);
    opened.zip.readEntry();
    return Effect.sync(cleanup);
  });

  const streamEntry = (entry: Yauzl.Entry) =>
    Effect.acquireRelease(
      Effect.callback<NodeStream.Readable, E>((resume) => {
        opened.zip.openReadStream(entry, (cause, readable) => {
          resume(
            cause || !readable
              ? Effect.fail(makeError("Could not read an archive member.", cause))
              : Effect.succeed(readable),
          );
        });
      }),
      (readable) =>
        Effect.sync(() => {
          readable.destroy();
        }),
    );
  return { entryCount: opened.zip.entryCount, next, streamEntry };
});

export interface ZipSource {
  /** Path inside the archive. */
  readonly name: string;
  readonly size: number;
  readonly mtime: Date;
  /** When set, bytes that no longer hash to it fail the archive instead of being stored. */
  readonly sha256?: string | undefined;
  /**
   * Called when the writer reaches this entry; the stream must close its
   * source when it ends or is destroyed, so thousands of entries hold one
   * descriptor at a time.
   */
  readonly open: () => Promise<NodeStream.Readable>;
}

export interface ZipWriteFailure {
  /** The entry being stored, or null when the archive itself failed. */
  readonly source: ZipSource | null;
  /** The source's bytes were not the size or SHA-256 it was added with. */
  readonly changed: boolean;
  readonly cause: unknown;
}

/**
 * Stores (never deflates: engine artifacts are already compressed) each
 * source into a new archive at `archivePath`, which must not exist. A
 * failure or interruption leaves a partial file for the caller to remove.
 */
export const writeZipArchive = Effect.fn("zipArchive.write")(function* <E>(
  archivePath: string,
  sources: readonly ZipSource[],
  makeError: (failure: ZipWriteFailure) => E,
) {
  const zip = new Yazl.ZipFile();
  const output = zip.outputStream as NodeStream.PassThrough;
  const live = new Set<NodeStream.Readable>();
  const files: { readonly name: string; readonly bytes: number; readonly sha256: string }[] = [];
  let failure: ZipWriteFailure | null = null;
  const stop = (next: ZipWriteFailure) => {
    failure ??= next;
    for (const stream of live) stream.destroy();
    output.destroy(new Error("The archive was abandoned."));
  };
  zip.on("error", (cause: unknown) => stop({ source: null, changed: false, cause }));

  for (const source of sources) {
    zip.addReadStreamLazy(
      source.name,
      { size: source.size, mtime: source.mtime, compress: false },
      (callback) => {
        source.open().then(
          (readable) => {
            const hash = NodeCrypto.createHash("sha256");
            let bytes = 0;
            const check = new NodeStream.Transform({
              transform(chunk: Buffer, _encoding, next) {
                hash.update(chunk);
                bytes += chunk.byteLength;
                next(null, chunk);
              },
              flush(next) {
                live.delete(readable);
                live.delete(check);
                const sha256 = hash.digest("hex");
                if (
                  bytes !== source.size ||
                  (source.sha256 !== undefined && sha256 !== source.sha256)
                )
                  return stop({ source, changed: true, cause: null });
                files.push({ name: source.name, bytes, sha256 });
                next();
              },
            });
            live.add(readable).add(check);
            readable.on("error", (cause) => stop({ source, changed: false, cause }));
            check.on("error", (cause) => stop({ source, changed: false, cause }));
            if (failure !== null) return stop(failure);
            callback(null, readable.pipe(check));
          },
          (cause: unknown) => stop({ source, changed: false, cause }),
        );
      },
    );
  }
  zip.end();

  const archiveHash = NodeCrypto.createHash("sha256");
  let archiveBytes = 0;
  const tally = new NodeStream.Transform({
    transform(chunk: Buffer, _encoding, next) {
      archiveHash.update(chunk);
      archiveBytes += chunk.byteLength;
      next(null, chunk);
    },
  });
  yield* Effect.tryPromise({
    try: (signal) =>
      NodeStreamPromises.pipeline(
        output,
        tally,
        NodeFS.createWriteStream(archivePath, { flags: "wx", mode: 0o600, flush: true }),
        { signal },
      ),
    catch: (cause) => makeError(failure ?? { source: null, changed: false, cause }),
  }).pipe(
    Effect.onExit(() =>
      Effect.sync(() => {
        for (const stream of live) stream.destroy();
      }),
    ),
  );
  return { bytes: archiveBytes, sha256: archiveHash.digest("hex"), files };
});
