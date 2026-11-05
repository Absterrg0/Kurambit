// @effect-diagnostics nodeBuiltinImport:off -- A static scan of the game's model files for a prompt.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { laneAssets, laneLibrary } from "../engineProfile.ts";
import { readGltfJson } from "../gltfJson.ts";

// Measured facts on the game's glTF models, read from their JSON alone (no
// buffers): size, triangles, skeleton, clips and referenced files. The art
// director judges with them; numbers, not verdicts.

const MAX_MODELS = 24;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MODEL = /\.(glb|gltf)$/i;

type Mat = number[];
interface Node {
  readonly children?: number[];
  readonly mesh?: number;
  readonly skin?: number;
  readonly matrix?: number[];
  readonly translation?: number[];
  readonly rotation?: number[];
  readonly scale?: number[];
}
interface Doc {
  readonly scene?: number;
  readonly scenes?: Array<{ readonly nodes?: number[] }>;
  readonly nodes?: Node[];
  readonly meshes?: Array<{
    readonly primitives?: Array<{
      readonly attributes?: { readonly POSITION?: number };
      readonly indices?: number;
      readonly mode?: number;
    }>;
  }>;
  readonly accessors?: Array<{
    readonly count?: number;
    readonly min?: number[];
    readonly max?: number[];
  }>;
  readonly skins?: Array<{ readonly joints?: number[] }>;
  readonly animations?: Array<{ readonly name?: string }>;
  readonly images?: Array<{ readonly uri?: string }>;
  readonly buffers?: Array<{ readonly uri?: string }>;
}

const multiply = (a: Mat, b: Mat): Mat => {
  const out = Array.from({ length: 16 }, () => 0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) out[col * 4 + row]! += a[k * 4 + row]! * b[col * 4 + k]!;
  return out;
};

const local = (node: Node): Mat => {
  if (node.matrix?.length === 16) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y! * y! + z! * z!)) * sx!,
    2 * (x! * y! + z! * w!) * sx!,
    2 * (x! * z! - y! * w!) * sx!,
    0,
    2 * (x! * y! - z! * w!) * sy!,
    (1 - 2 * (x! * x! + z! * z!)) * sy!,
    2 * (y! * z! + x! * w!) * sy!,
    0,
    2 * (x! * z! + y! * w!) * sz!,
    2 * (y! * z! - x! * w!) * sz!,
    (1 - 2 * (x! * x! + y! * y!)) * sz!,
    0,
    tx!,
    ty!,
    tz!,
    1,
  ];
};

const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const readJson = async (path: string): Promise<Doc | null> => {
  const read = await readGltfJson(path, MAX_JSON_BYTES);
  return read.kind === "json" && typeof read.json === "object" && read.json !== null
    ? (read.json as Doc)
    : null;
};

const round = (n: number) => (n >= 10 ? Math.round(n) : Math.round(n * 100) / 100);
const thousands = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : `${n}`);

/** One line of facts for one model file. */
export const describeModel = async (path: string, label: string): Promise<string> => {
  const doc = await readJson(path);
  if (doc === null) return `${label}: not a readable glTF file`;
  const nodes = doc.nodes ?? [];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  const seen = new Set<number>();
  const visit = (index: number, parent: Mat) => {
    // A node reached twice (a cycle in a broken file) is measured once.
    if (seen.has(index)) return;
    seen.add(index);
    const node = nodes[index];
    if (node === undefined) return;
    const world = multiply(parent, local(node));
    for (const primitive of doc.meshes?.[node.mesh ?? -1]?.primitives ?? []) {
      if ((primitive.mode ?? 4) !== 4) continue;
      const position = doc.accessors?.[primitive.attributes?.POSITION ?? -1];
      const indices = doc.accessors?.[primitive.indices ?? -1];
      triangles += Math.floor(((indices ?? position)?.count ?? 0) / 3);
      if (position?.min?.length !== 3 || position.max?.length !== 3) continue;
      for (let corner = 0; corner < 8; corner++) {
        const p = [0, 1, 2].map((axis) =>
          corner & (1 << axis) ? position.max![axis]! : position.min![axis]!,
        );
        for (let axis = 0; axis < 3; axis++) {
          const v =
            world[axis]! * p[0]! +
            world[4 + axis]! * p[1]! +
            world[8 + axis]! * p[2]! +
            world[12 + axis]!;
          lo[axis] = Math.min(lo[axis]!, v);
          hi[axis] = Math.max(hi[axis]!, v);
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  const roots = doc.scenes?.[doc.scene ?? 0]?.nodes ?? nodes.map((_, index) => index);
  for (const root of roots) visit(root, IDENTITY);

  const parts: string[] = [];
  if (Number.isFinite(lo[0]))
    parts.push(
      `${round(hi[1]! - lo[1]!)} tall, ${round(hi[0]! - lo[0]!)} wide, ${round(hi[2]! - lo[2]!)} deep, base at y ${round(lo[1]!)}`,
    );
  parts.push(`${thousands(triangles)} triangles`);
  const joints = Math.max(0, ...(doc.skins ?? []).map((skin) => skin.joints?.length ?? 0));
  parts.push(joints > 0 ? `skeleton of ${joints} bones` : "no skeleton");
  const clips = (doc.animations ?? []).map(
    (clip, index) => clip.name?.slice(0, 32) || `clip ${index}`,
  );
  parts.push(
    clips.length === 0
      ? "no animation clips"
      : `${clips.length} clips (${clips.slice(0, 10).join(", ")}${clips.length > 10 ? ", ..." : ""})`,
  );
  const missing: string[] = [];
  for (const item of [...(doc.images ?? []), ...(doc.buffers ?? [])]) {
    const uri = item.uri;
    if (typeof uri !== "string" || uri.startsWith("data:") || /^[a-z]+:/i.test(uri)) continue;
    const target = NodePath.resolve(NodePath.dirname(path), decodeURIComponent(uri));
    if (
      !(await NodeFSP.access(target).then(
        () => true,
        () => false,
      ))
    )
      missing.push(uri);
  }
  if (missing.length > 0)
    parts.push(`references ${missing.join(", ")}, not found beside it (it renders without them)`);
  return `${label}: ${parts.join(", ")}`;
};

export interface ModelFacts {
  /** One line per model, bounded for a prompt; "" when the game has none. */
  readonly full: string;
  /** Only models that reference missing files, for roles that judge the whole game. */
  readonly notable: string;
}

/**
 * Facts on the models the game owns under the lane's asset dir, plus library
 * models ASSETS.md names (the game uses those).
 */
export const modelFacts = async (root: string, lane: string): Promise<ModelFacts> => {
  const assets = NodePath.join(root, laneAssets(lane));
  const library = NodePath.join(root, laneLibrary(lane));
  const assetsDoc = await NodeFSP.readFile(NodePath.join(root, "ASSETS.md"), "utf8").catch(
    () => "",
  );
  const found: string[] = [];
  const visit = async (at: string) => {
    for (const entry of await NodeFSP.readdir(at, { withFileTypes: true }).catch(() => [])) {
      const full = NodePath.join(at, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await visit(full);
      } else if (entry.isFile() && MODEL.test(entry.name)) {
        const inLibrary = full.startsWith(library + NodePath.sep);
        const rel = NodePath.relative(root, full).split(NodePath.sep).join("/");
        if (!inLibrary || assetsDoc.includes(rel) || assetsDoc.includes(NodePath.basename(full)))
          found.push(full);
      }
    }
  };
  await visit(assets);
  found.sort();
  const lines: string[] = [];
  for (const full of found.slice(0, MAX_MODELS))
    lines.push(
      await describeModel(full, NodePath.relative(assets, full).split(NodePath.sep).join("/")),
    );
  if (found.length > MAX_MODELS)
    lines.push(`(${found.length - MAX_MODELS} more models not measured)`);
  return {
    full: lines.join("\n"),
    notable: lines.filter((line) => line.includes("not found beside it")).join("; "),
  };
};
