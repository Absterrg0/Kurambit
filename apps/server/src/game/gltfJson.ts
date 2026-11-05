// @effect-diagnostics nodeBuiltinImport:off -- Reads a model file's glTF JSON from disk.
import * as NodeFSP from "node:fs/promises";

export type GltfJson =
  | { readonly kind: "json"; readonly json: unknown }
  | { readonly kind: "too-large" }
  | { readonly kind: "unreadable" };

const UNREADABLE: GltfJson = { kind: "unreadable" };

/**
 * A .gltf file's JSON, or a .glb's JSON chunk alone: its buffers are never
 * read, so a 100 MB model costs its header. Past `maxBytes` of JSON it is
 * "too-large"; not glTF, truncated or not JSON, "unreadable".
 */
export const readGltfJson = async (path: string, maxBytes: number): Promise<GltfJson> => {
  const handle = await NodeFSP.open(path, "r").catch(() => null);
  if (handle === null) return UNREADABLE;
  try {
    if (!/\.glb$/i.test(path)) {
      if ((await handle.stat()).size > maxBytes) return { kind: "too-large" };
      return { kind: "json", json: JSON.parse((await handle.readFile()).toString("utf8")) };
    }
    const head = Buffer.alloc(20);
    const { bytesRead } = await handle.read(head, 0, 20, 0);
    if (
      bytesRead < 20 ||
      head.toString("latin1", 0, 4) !== "glTF" ||
      head.toString("latin1", 16, 20) !== "JSON"
    )
      return UNREADABLE;
    const length = head.readUInt32LE(12);
    if (length > maxBytes) return { kind: "too-large" };
    const json = Buffer.alloc(length);
    if ((await handle.read(json, 0, length, 20)).bytesRead < length) return UNREADABLE;
    return { kind: "json", json: JSON.parse(json.toString("utf8")) };
  } catch {
    return UNREADABLE;
  } finally {
    await handle.close().catch(() => undefined);
  }
};
