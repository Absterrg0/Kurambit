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

/** A .glb's JSON chunk from bytes already in memory (a download), or null when it is not one. */
export const glbJson = (bytes: Uint8Array): unknown => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    buffer.length < 20 ||
    buffer.toString("latin1", 0, 4) !== "glTF" ||
    buffer.toString("latin1", 16, 20) !== "JSON"
  )
    return null;
  const length = buffer.readUInt32LE(12);
  if (20 + length > buffer.length) return null;
  try {
    return JSON.parse(buffer.toString("utf8", 20, 20 + length));
  } catch {
    return null;
  }
};

/**
 * The longest animation's length in seconds, from its samplers' input accessors' max (the glTF
 * spec requires min and max on them); null when the document has no animation.
 */
export const longestAnimationSeconds = (doc: unknown): number | null => {
  const gltf = doc as {
    readonly accessors?: ReadonlyArray<{ readonly max?: ReadonlyArray<number> }>;
    readonly animations?: ReadonlyArray<{
      readonly samplers?: ReadonlyArray<{ readonly input?: number }>;
    }>;
  } | null;
  let longest: number | null = null;
  for (const animation of gltf?.animations ?? [])
    for (const sampler of animation.samplers ?? []) {
      const end = gltf?.accessors?.[sampler.input ?? -1]?.max?.[0];
      if (typeof end === "number" && Number.isFinite(end) && end >= 0)
        longest = Math.max(longest ?? 0, end);
    }
  return longest;
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

/**
 * A glTF document's triangle count (each mesh once, however many nodes use it; triangle-list
 * primitives, by their index count or else their vertex count) and its image count; null when
 * it holds no mesh. What a provider did to a mesh it was sent is read by these two.
 */
export const gltfMeshSize = (
  doc: unknown,
): { readonly triangles: number; readonly images: number } | null => {
  const gltf = doc as {
    readonly accessors?: ReadonlyArray<{ readonly count?: number }>;
    readonly images?: ReadonlyArray<unknown>;
    readonly meshes?: ReadonlyArray<{
      readonly primitives?: ReadonlyArray<{
        readonly mode?: number;
        readonly indices?: number;
        readonly attributes?: { readonly POSITION?: number };
      }>;
    }>;
  } | null;
  if (gltf === null || typeof gltf !== "object" || (gltf.meshes ?? []).length === 0) return null;
  let triangles = 0;
  for (const mesh of gltf.meshes ?? [])
    for (const primitive of mesh.primitives ?? []) {
      if ((primitive.mode ?? 4) !== 4) continue;
      const accessor = primitive.indices ?? primitive.attributes?.POSITION;
      const count = accessor === undefined ? undefined : gltf.accessors?.[accessor]?.count;
      if (typeof count === "number") triangles += Math.floor(count / 3);
    }
  return { triangles, images: (gltf.images ?? []).length };
};
