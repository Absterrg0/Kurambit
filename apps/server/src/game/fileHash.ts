// @effect-diagnostics nodeBuiltinImport:off -- Streams a file on the native filesystem through SHA-256.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

/** SHA-256 and byte count of a file, streamed so a large build never sits whole in memory. */
export const fileSha256 = async (path: string) => {
  const hash = NodeCrypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of NodeFS.createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).byteLength;
  }
  return { sha256: hash.digest("hex"), bytes };
};
