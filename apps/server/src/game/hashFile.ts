// @effect-diagnostics nodeBuiltinImport:off -- Streams a file's bytes from the native filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

/**
 * SHA-256 and byte count of a file, streamed so a large build never sits whole
 * in memory: the game layer's one file hasher (Web builds, library packs).
 * `noFollow` refuses a link at the path (O_NOFOLLOW, where it exists), so a
 * link swapped in fails closed; an abort stops the read.
 */
export const hashFile = async (
  path: string,
  options: { readonly signal?: AbortSignal | undefined; readonly noFollow?: boolean } = {},
): Promise<{ readonly sha256: string; readonly bytes: number }> => {
  const { signal } = options;
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(
      path,
      options.noFollow === true
        ? NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW
        : NodeFS.constants.O_RDONLY,
    );
  } catch (cause) {
    if (signal?.aborted) signal.throwIfAborted();
    throw cause;
  }
  const hash = NodeCrypto.createHash("sha256");
  let bytes = 0;
  try {
    signal?.throwIfAborted();
    const stream = handle.createReadStream({ autoClose: false, ...(signal ? { signal } : {}) });
    try {
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        hash.update(chunk as Buffer);
        bytes += (chunk as Buffer).byteLength;
      }
    } finally {
      stream.destroy();
    }
    signal?.throwIfAborted();
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { sha256: hash.digest("hex"), bytes };
};
