// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Reads a build copy's GLB headers and sidecars from disk.
// The static assets tier of a build's facts: every GLB under the engine's assets folder,
// outside library/, read from its JSON and its sidecar. Never plays and never runs Blender
// (D9). Numbers, not verdicts: Keep going does not watch this tier.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  GAME_MODEL_SIDECAR_SUFFIX,
  type GameAssetFacts,
  type GameEngineId,
  type GameModelFact,
  GameModelSidecar,
} from "@kurambit/contracts";
import { readImageDimensions } from "@kurambit/shared/imageDimensions";
import { LIBRARY_RIG_JOINTS, STANDARD_RIG } from "./assetLibraryCatalog.ts";
import { DRIFT_METRES, isLoopClip } from "./blenderPipeline.ts";
import { gamePaths } from "./engineProfile.ts";
import { fileSha256 } from "./fileHash.ts";
import { readGltfJson } from "./gltfJson.ts";
import { walkFiles } from "./walkFiles.ts";

const MAX_MODELS = 24;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 1024 * 1024;
const MODEL = /\.(glb|gltf)$/i;
/** Enough of an image's bytes to read its size from its header. */
const IMAGE_HEAD_BYTES = 64 * 1024;
const LOCOMOTION = /walk|run|jog|sprint/i;

interface Doc {
  readonly nodes?: ReadonlyArray<{ readonly name?: string }>;
  readonly meshes?: ReadonlyArray<{
    readonly primitives?: ReadonlyArray<{
      readonly attributes?: { readonly POSITION?: number };
      readonly indices?: number;
      readonly mode?: number;
    }>;
  }>;
  readonly accessors?: ReadonlyArray<{ readonly count?: number }>;
  readonly skins?: ReadonlyArray<{ readonly joints?: ReadonlyArray<number> }>;
  readonly animations?: ReadonlyArray<unknown>;
  readonly images?: ReadonlyArray<{ readonly uri?: string; readonly bufferView?: number }>;
  readonly bufferViews?: ReadonlyArray<{
    readonly buffer?: number;
    readonly byteOffset?: number;
    readonly byteLength?: number;
  }>;
}

const decodeSidecar = Schema.decodeUnknownResult(Schema.fromJsonString(GameModelSidecar));

/** Where a GLB's BIN chunk starts, from its JSON chunk's length; null when it has none. */
const binStart = async (handle: NodeFSP.FileHandle) => {
  const head = Buffer.alloc(20);
  if ((await handle.read(head, 0, 20, 0)).bytesRead < 20) return null;
  const at = 20 + head.readUInt32LE(12);
  const chunk = Buffer.alloc(8);
  if ((await handle.read(chunk, 0, 8, at)).bytesRead < 8) return null;
  return chunk.toString("latin1", 4, 8) === "BIN\0" ? at + 8 : null;
};

/** The largest side of the model's images: embedded ones from their header bytes, others beside it. */
const maxTextureSide = async (path: string, doc: Doc) => {
  let largest = 0;
  const handle = await NodeFSP.open(path, "r").catch(() => null);
  try {
    const bin = handle === null || !/\.glb$/i.test(path) ? null : await binStart(handle);
    for (const image of doc.images ?? []) {
      let head: Buffer | null = null;
      if (image.bufferView !== undefined && bin !== null && handle !== null) {
        const view = doc.bufferViews?.[image.bufferView];
        if (view !== undefined && (view.buffer ?? 0) === 0) {
          head = Buffer.alloc(Math.min(view.byteLength ?? 0, IMAGE_HEAD_BYTES));
          await handle.read(head, 0, head.length, bin + (view.byteOffset ?? 0));
        }
      } else if (typeof image.uri === "string" && !/^[a-z]+:/i.test(image.uri)) {
        // Only a plain file beside the model, inside its folder.
        const beside = NodePath.resolve(NodePath.dirname(path), image.uri);
        if (beside.startsWith(NodePath.dirname(path) + NodePath.sep)) {
          const file = await NodeFSP.open(beside, "r").catch(() => null);
          if (file !== null) {
            head = Buffer.alloc(IMAGE_HEAD_BYTES);
            const { bytesRead } = await file.read(head, 0, head.length, 0);
            head = head.subarray(0, bytesRead);
            await file.close();
          }
        }
      }
      const size = head === null ? null : readImageDimensions(head);
      if (size !== null) largest = Math.max(largest, size.width, size.height);
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return largest;
};

/** The rig whose every joint the skins hold, standard first; null unskinned or on no known rig. */
const skeletonOf = (doc: Doc): string | null => {
  const names = new Set(
    (doc.skins ?? []).flatMap((skin) =>
      (skin.joints ?? []).flatMap((joint) => doc.nodes?.[joint]?.name ?? []),
    ),
  );
  if (names.size === 0) return null;
  const rigs = Object.keys(LIBRARY_RIG_JOINTS).toSorted(
    (a, b) => Number(b === STANDARD_RIG) - Number(a === STANDARD_RIG),
  );
  return rigs.find((rig) => LIBRARY_RIG_JOINTS[rig]!.every((joint) => names.has(joint))) ?? null;
};

const triangles = (doc: Doc) => {
  let count = 0;
  for (const mesh of doc.meshes ?? [])
    for (const primitive of mesh.primitives ?? []) {
      if ((primitive.mode ?? 4) !== 4) continue;
      const accessor = doc.accessors?.[primitive.indices ?? primitive.attributes?.POSITION ?? -1];
      count += Math.floor((accessor?.count ?? 0) / 3);
    }
  return count;
};

/**
 * The export's measurement, valid only while the GLB's bytes are the ones its sidecar names.
 * A sidecar is a file in the game, so an agent could forge one; the hash stops staleness, the
 * real failure, and a deliberate forgery is outside what this guards. Its `model` is compared
 * with the GLB's own name and never opened, so a sidecar cannot make anything else be read.
 */
const pipelineOf = async (path: string, relative: string): Promise<GameModelFact["pipeline"]> => {
  const notMeasured = (why: string) => ({ status: "not-measured" as const, why, retry: false });
  const sidecarPath = path.replace(/\.glb$/i, GAME_MODEL_SIDECAR_SUFFIX);
  const stat = await NodeFSP.lstat(sidecarPath).catch(() => null);
  if (stat === null || !/\.glb$/i.test(path))
    return notMeasured("no sidecar: not exported through the pipeline");
  if (!stat.isFile() || stat.size > MAX_SIDECAR_BYTES)
    return notMeasured("the sidecar is not valid: it is not a plain file of a sidecar's size");
  const text = await NodeFSP.readFile(sidecarPath, "utf8").catch(() => null);
  if (text === null) return notMeasured("the sidecar is not valid: it could not be read");
  const decoded = decodeSidecar(text);
  if (Result.isFailure(decoded))
    return notMeasured(
      `the sidecar is not valid: ${decoded.failure.message.split("\n")[0]!.slice(0, 200)}`,
    );
  const sidecar = decoded.success;
  if (sidecar.model !== NodePath.basename(path))
    return notMeasured(`the sidecar is not valid: it names ${sidecar.model}, not this model`);
  const hashed = await fileSha256(path).catch(() => null);
  if (hashed === null || hashed.sha256 !== sidecar.sha256 || hashed.bytes !== sidecar.bytes)
    return notMeasured("the GLB changed after its export: export it again");
  return {
    status: "measured",
    sidecar: relative.replace(/\.glb$/i, GAME_MODEL_SIDECAR_SUFFIX),
    kind: sidecar.kind,
    height: sidecar.height,
    reviewedAt: sidecar.measured.reviewedAt,
    groundSpeeds: sidecar.clips
      .filter((clip) => clip.groundSpeed !== null || LOCOMOTION.test(clip.name))
      .slice(0, 16)
      .map((clip) => ({ clip: clip.name, speed: clip.groundSpeed })),
    seamsBroken: sidecar.clips
      .filter((clip) => isLoopClip(clip) && !clip.loops)
      .slice(0, 16)
      .map((clip) => clip.name),
    drifting: sidecar.clips
      .filter((clip) => !/_rm$/i.test(clip.name) && Math.abs(clip.rootDrift) > DRIFT_METRES)
      .slice(0, 16)
      .map((clip) => clip.name),
    source: sidecar.source,
  };
};

const modelFact = async (copyRoot: string, path: string): Promise<GameModelFact> => {
  const relative = NodePath.relative(copyRoot, path).split(NodePath.sep).join("/");
  const bytes = (await NodeFSP.stat(path).catch(() => null))?.size ?? 0;
  const read = await readGltfJson(path, MAX_JSON_BYTES);
  if (read.kind !== "json" || typeof read.json !== "object" || read.json === null)
    return {
      path: relative,
      triangles: 0,
      bytes,
      maxTextureSide: 0,
      skeleton: null,
      clips: 0,
      pipeline: {
        status: "not-measured",
        why:
          read.kind === "too-large"
            ? "its glTF JSON is too large to read"
            : "it is not a readable glTF file",
        retry: false,
      },
    };
  const doc = read.json as Doc;
  return {
    path: relative,
    triangles: triangles(doc),
    bytes,
    maxTextureSide: await maxTextureSide(path, doc),
    skeleton: skeletonOf(doc),
    clips: doc.animations?.length ?? 0,
    pipeline: await pipelineOf(path, relative),
  };
};

/**
 * Library files ASSETS.md credits, game-relative, as the library's add writes them: each file
 * by its path, or a folder's files by one `dir/*.ext` glob. Counted, never measured one by one.
 */
export const creditedLibraryFiles = async (
  copyRoot: string,
  library: string,
): Promise<ReadonlySet<string>> => {
  const text = await NodeFSP.readFile(NodePath.join(copyRoot, "ASSETS.md"), "utf8").catch(() => "");
  if (text === "") return new Set();
  const files = await walkFiles(library, { limit: 20_000 });
  return new Set(
    files.flatMap((full) => {
      const relative = NodePath.relative(copyRoot, full).split(NodePath.sep).join("/");
      const glob = `${NodePath.posix.dirname(relative)}/*${NodePath.posix.extname(relative)}`;
      return text.includes(`\`${relative}\``) || text.includes(`\`${glob}\``) ? [relative] : [];
    }),
  );
};

export const measureAssets = (
  copyRoot: string,
  engine: GameEngineId,
  project: string,
): Effect.Effect<GameAssetFacts> =>
  Effect.promise(async () => {
    const paths = gamePaths(engine, project);
    const library = NodePath.join(copyRoot, paths.library);
    const found = (
      await walkFiles(NodePath.join(copyRoot, paths.assets), {
        enter: (full, name) => !name.startsWith(".") && full !== library,
        match: (name) => MODEL.test(name),
      })
    ).toSorted();
    const models: GameModelFact[] = [];
    for (const path of found.slice(0, MAX_MODELS)) models.push(await modelFact(copyRoot, path));
    return {
      models,
      more: Math.max(0, found.length - MAX_MODELS),
      libraryFiles: (await creditedLibraryFiles(copyRoot, library)).size,
    };
  });
