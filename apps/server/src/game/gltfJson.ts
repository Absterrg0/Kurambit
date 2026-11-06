// @effect-diagnostics nodeBuiltinImport:off -- Reads a model file's glTF JSON from disk.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

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

interface AccessorDoc {
  readonly accessors?: ReadonlyArray<{
    readonly bufferView?: number;
    readonly byteOffset?: number;
    readonly componentType?: number;
    readonly count?: number;
    readonly type?: string;
    readonly sparse?: unknown;
  }>;
  readonly bufferViews?: ReadonlyArray<{
    readonly buffer?: number;
    readonly byteOffset?: number;
    readonly byteStride?: number;
  }>;
  readonly buffers?: ReadonlyArray<{ readonly uri?: string }>;
}

const FLOAT = 5126;
const MAT4_BYTES = 64;
const MAX_ACCESSOR_BYTES = 16 * 1024;

/**
 * One FLOAT MAT4 accessor's matrices (a skin's inverse bind matrices), read
 * from the GLB's BIN chunk, a buffer file beside the model or a data: URI,
 * never the whole model. At most `maxMatrices`; anything this bounded read
 * does not cover (sparse, another component type, a missing buffer) is the
 * reason it was not read, never a guess.
 */
export const readMat4Accessor = async (
  path: string,
  doc: AccessorDoc,
  index: number,
  maxMatrices: number,
): Promise<ReadonlyArray<ReadonlyArray<number>> | { readonly notRead: string }> => {
  const accessor = doc.accessors?.[index];
  if (accessor === undefined) return { notRead: "its inverse bind matrices are not in the file" };
  if (accessor.sparse !== undefined || accessor.componentType !== FLOAT || accessor.type !== "MAT4")
    return { notRead: "its inverse bind matrices are not plain float matrices" };
  const count = accessor.count ?? 0;
  if (count > maxMatrices) return { notRead: `its skeleton has more than ${maxMatrices} joints` };
  const view = doc.bufferViews?.[accessor.bufferView ?? -1];
  if (view === undefined) return { notRead: "its inverse bind matrices have no buffer view" };
  // The stride comes from the file: one a float matrix cannot have is refused
  // before anything is allocated, and the read never passes 16 KB.
  const stride = view.byteStride ?? MAT4_BYTES;
  if (!Number.isInteger(stride) || stride % 4 !== 0 || stride < MAT4_BYTES || stride > 252)
    return { notRead: "its inverse bind matrices have an impossible stride" };
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  if (!Number.isInteger(start) || start < 0)
    return { notRead: "its inverse bind matrices have an impossible offset" };
  const length = count === 0 ? 0 : stride * (count - 1) + MAT4_BYTES;
  if (length > MAX_ACCESSOR_BYTES)
    return { notRead: "its inverse bind matrices are larger than this read takes" };
  const bytes = await readBufferRange(path, doc, view.buffer ?? 0, start, length);
  if (typeof bytes === "string") return { notRead: bytes };
  const matrices: number[][] = [];
  for (let i = 0; i < count; i++)
    matrices.push(Array.from({ length: 16 }, (_, k) => bytes.readFloatLE(i * stride + k * 4)));
  return matrices;
};

/** `length` bytes of buffer `index` from `start`, or why they could not be read. */
const readBufferRange = async (
  path: string,
  doc: AccessorDoc,
  index: number,
  start: number,
  length: number,
): Promise<Buffer | string> => {
  const uri = doc.buffers?.[index]?.uri;
  try {
    if (uri === undefined) {
      if (!/\.glb$/i.test(path) || index !== 0) return "its buffer is missing";
      const handle = await NodeFSP.open(path, "r");
      try {
        const head = Buffer.alloc(8);
        await handle.read(head, 0, 8, 12);
        const bin = 20 + head.readUInt32LE(0);
        const chunk = Buffer.alloc(8);
        if ((await handle.read(chunk, 0, 8, bin)).bytesRead < 8)
          return "its binary chunk is missing";
        if (chunk.toString("latin1", 4, 8) !== "BIN\0") return "its binary chunk is missing";
        if (start + length > chunk.readUInt32LE(0))
          return "its buffer is shorter than its accessor";
        const out = Buffer.alloc(length);
        if ((await handle.read(out, 0, length, bin + 8 + start)).bytesRead < length)
          return "its buffer is truncated";
        return out;
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
    const data = /^data:[^,]*;base64,(.*)$/s.exec(uri);
    if (data !== null) {
      const all = Buffer.from(data[1] ?? "", "base64");
      return start + length > all.length
        ? "its buffer is shorter than its accessor"
        : all.subarray(start, start + length);
    }
    if (/^[a-z][\w+.-]*:/i.test(uri)) return "its buffer is not a file beside it";
    let name: string;
    try {
      name = decodeURIComponent(uri);
    } catch {
      name = uri;
    }
    const handle = await NodeFSP.open(NodePath.resolve(NodePath.dirname(path), name), "r");
    try {
      const out = Buffer.alloc(length);
      if ((await handle.read(out, 0, length, start)).bytesRead < length)
        return "its buffer is shorter than its accessor";
      return out;
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return "its buffer could not be read";
  }
};
