// The exported bytes are interrogated with the upstream glTF SDK instead of a
// handwritten parser, so a malformed file fails here rather than in the game.
import { NodeIO, getBounds } from "@gltf-transform/core";

export interface GlbBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly size: readonly [number, number, number];
}

export interface GlbInspection {
  readonly meshes: number;
  readonly primitives: number;
  readonly triangles: number;
  readonly materials: number;
  readonly untexturedMaterials: number;
  readonly textures: number;
  readonly animations: number;
  readonly skins: number;
  readonly nodes: number;
  readonly bounds: GlbBounds | null;
  readonly warnings: ReadonlyArray<string>;
}

const HEAVY_TRIANGLES = 100_000;

const trianglesOf = (primitive: {
  getIndices: () => { getCount: () => number } | null;
  getAttribute: (name: string) => { getCount: () => number } | null;
}): number => {
  const indices = primitive.getIndices();
  if (indices !== null) return Math.floor(indices.getCount() / 3);
  const position = primitive.getAttribute("POSITION");
  if (position === null) return 0;
  return Math.floor(position.getCount() / 3);
};

/**
 * Reads the exported GLB with the glTF-Transform SDK. A file the SDK cannot
 * parse is malformed and rejects, so the caller keeps the last good asset.
 * Counts are arithmetic over accessors, never per-vertex loops.
 */
export const inspectGlb = async (bytes: Uint8Array): Promise<GlbInspection> => {
  const document = await new NodeIO().readBinary(bytes);
  const root = document.getRoot();
  const meshes = root.listMeshes();
  let primitives = 0;
  let triangles = 0;
  for (const mesh of meshes) {
    for (const primitive of mesh.listPrimitives()) {
      primitives += 1;
      triangles += trianglesOf(primitive);
    }
  }
  const materials = root.listMaterials();
  let textured = 0;
  for (const material of materials) {
    const channels = [
      material.getBaseColorTexture(),
      material.getMetallicRoughnessTexture(),
      material.getNormalTexture(),
      material.getOcclusionTexture(),
      material.getEmissiveTexture(),
    ];
    if (channels.some((channel) => channel !== null)) textured += 1;
  }
  const scenes = root.listScenes();
  let bounds: GlbBounds | null = null;
  // The SDK transforms mesh vertices but does not evaluate skin joints or
  // inverse bind matrices. Those bounds can be wrong by orders of magnitude.
  if (scenes.length > 0 && root.listSkins().length === 0) {
    try {
      const box = getBounds(scenes[0]!);
      bounds = {
        min: [box.min[0]!, box.min[1]!, box.min[2]!],
        max: [box.max[0]!, box.max[1]!, box.max[2]!],
        size: [box.max[0]! - box.min[0]!, box.max[1]! - box.min[1]!, box.max[2]! - box.min[2]!],
      };
    } catch {
      bounds = null;
    }
  }
  const warnings: Array<string> = [];
  if (root.listSkins().length > 0)
    warnings.push("Skinned bounds require engine evaluation; static GLB bounds are unavailable.");
  if (meshes.length === 0) warnings.push("The exported GLB holds no meshes.");
  if (materials.length === 0) warnings.push("The exported GLB holds no materials.");
  if (triangles > HEAVY_TRIANGLES)
    warnings.push(
      `The export has ${triangles} triangles, past the ${HEAVY_TRIANGLES} web guideline; simplify the asset before shipping it.`,
    );
  return {
    meshes: meshes.length,
    primitives,
    triangles,
    materials: materials.length,
    untexturedMaterials: materials.length - textured,
    textures: root.listTextures().length,
    animations: root.listAnimations().length,
    skins: root.listSkins().length,
    nodes: root.listNodes().length,
    bounds,
    warnings,
  };
};
