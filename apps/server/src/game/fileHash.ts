// @effect-diagnostics nodeBuiltinImport:off -- Streams a file on the native filesystem through SHA-256.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

/**
 * SHA-256 and byte count of a file, streamed so a large build never sits whole
 * in memory: the one file hasher. `noFollow` refuses a link at the path (where
 * O_NOFOLLOW exists), and an abort destroys the stream so the read does not
 * outlive its caller.
 */
export const fileSha256 = async (
  path: string,
  options: { readonly signal?: AbortSignal | undefined; readonly noFollow?: boolean } = {},
) => {
  const { signal } = options;
  const flags =
    options.noFollow === true
      ? NodeFSP.constants.O_RDONLY | (NodeFSP.constants.O_NOFOLLOW ?? 0)
      : NodeFSP.constants.O_RDONLY;
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(path, flags);
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
