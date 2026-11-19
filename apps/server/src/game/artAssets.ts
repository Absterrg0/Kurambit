// @effect-diagnostics nodeBuiltinImport:off -- Reads a game's asset files, their sidecars and ASSETS.md from disk.
// The Workbench's Art tab: every file the game's assets folder holds that a person would open as
// art (models, textures and sprites, sounds, fonts), with where its own records say it came from.
// Nothing here judges a file; it reads the sidecar, ASSETS.md and the generation records the art
// tools already write.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { LRUCache } from "lru-cache";
import {
  GAME_ART_THUMBNAIL_DIR,
  GAME_MODEL_SIDECAR_SUFFIX,
  GameModelSidecar,
  type GameArtAsset,
  type GameArtAssetKind,
  type GameArtAssetRoute,
  type GameArtAssetsResult,
  type GameEngineId,
} from "@kurambit/contracts";
import { creditedLibraryFiles, gltfTriangles } from "./assetFacts.ts";
import { reviewedNotExported } from "./blenderPipeline.ts";
import { gamePaths } from "./engineProfile.ts";
import { fileSha256 } from "./fileHash.ts";
import { GENERATED_DIR } from "./generatedSource.ts";
import { readGltfJson } from "./gltfJson.ts";
import { walkFiles } from "./walkFiles.ts";
import { listHeroSheets } from "./heroSheets.ts";

const MAX_ASSETS = 1_000;
const MAX_WALK = 20_000;
const MAX_RECORDS = 500;
const MAX_GLTF_JSON = 8 * 1024 * 1024;
/** Thumbnails the Art tab drew, by content, in the game's ignored builds folder. */
const ART_THUMBNAIL_DIR = GAME_ART_THUMBNAIL_DIR;
/** The game's one Blender scene, which every Blender-made model is exported from. */
const BLEND_SOURCE = "art/blender/live.blend";

const KINDS: ReadonlyArray<readonly [RegExp, GameArtAssetKind]> = [
  [/\.(glb|gltf)$/i, "model"],
  [/\.(png|jpe?g|webp|gif|avif|ktx2)$/i, "texture"],
  [/\.(ogg|oga|mp3|wav|m4a|aac|flac|opus|weba)$/i, "audio"],
  [/\.(ttf|otf|woff2?)$/i, "font"],
];
const kindOf = (path: string) => KINDS.find(([pattern]) => pattern.test(path))?.[1] ?? null;

/** A file's hash, kept while its size and time stay: a list read again hashes nothing new. */
const hashes = new LRUCache<string, string>({ max: 20_000 });
const sha256Of = async (path: string, size: number, mtimeMs: number) => {
  const key = `${path}\0${size}\0${mtimeMs}`;
  const known = hashes.get(key);
  if (known !== undefined) return known;
  const { sha256 } = await fileSha256(path);
  hashes.set(key, sha256);
  return sha256;
};

/**
 * ASSETS.md's lines by the path or `dir/*.ext` glob they start with (`- \`path\` — what`), as the
 * art tools and agents write them.
 */
export const assetLines = (text: string): ReadonlyMap<string, string> => {
  const lines = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*[-*]\s+`([^`]+)`\s*(?:[—–:-]+\s*)?(.*)$/.exec(line);
    if (match !== null) lines.set(match[1]!.trim(), match[2]!.trim());
  }
  return lines;
};
const lineFor = (lines: ReadonlyMap<string, string>, path: string) =>
  lines.get(path) ??
  lines.get(`${NodePath.posix.dirname(path)}/*${NodePath.posix.extname(path)}`) ??
  null;

/** The route a line of ASSETS.md describes, in the words the tools and agents write. */
export const routeOfLine = (line: string): Exclude<GameArtAssetRoute, "unrecorded"> | null => {
  if (/\blibrary pack\b/i.test(line)) return "library";
  if (/\b(generat\w*|meshy|tripo|gpt-image|openai|replicate|elevenlabs|ai[- ]made)\b/i.test(line))
    return "generated";
  if (/\b(blender|game_blender)\b|\.blend\b/i.test(line)) return "blender";
  if (/\b(code|procedural\w*|synthes\w*|script\w*|canvas|hand[- ]written)\b/i.test(line))
    return "code";
  return null;
};

/** The licence or credit a line names: its "Licence: …" clause, else a known licence's name. */
export const creditOfLine = (line: string): string | null => {
  const library = /\blibrary pack [^,]+,\s*(.+)$/i.exec(line);
  // The add writes "licence, credit: …"; words after a full stop are someone's description.
  if (library !== null) return library[1]!.split(/\.\s/)[0]!.trim().replace(/\.$/, "");
  const said = /\blicen[cs]e:?\s+([^.;]+)/i.exec(line);
  if (said !== null) return said[1]!.trim();
  const known =
    /\b(CC0[ -]?1?\.?0?|CC[ -]BY(?:[ -]SA)?[ -]?\d\.\d|MIT|Apache-2\.0|OFL(?:[ -]1\.1)?)\b/i.exec(
      line,
    );
  return known === null ? null : known[1]!;
};

/** A sprite sheet's grid as the sprite render's line says it: "8 columns (frames) x 4 rows". */
export const sheetOfLine = (line: string) => {
  const match = /(\d+)\s+columns?\b[^x]*x\s*(\d+)\s+rows?/i.exec(line);
  if (match === null) return null;
  const columns = Number(match[1]);
  const rows = Number(match[2]);
  return columns >= 1 && columns <= 256 && rows >= 1 && rows <= 256 ? { columns, rows } : null;
};

const decodeSidecar = Schema.decodeUnknownOption(Schema.fromJsonString(GameModelSidecar));
const GenerationRecord = Schema.Struct({ id: Schema.String, files: Schema.Array(Schema.String) });
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(GenerationRecord));

const slash = (path: string) => path.split(NodePath.sep).join("/");
const exists = (path: string) =>
  NodeFSP.stat(path).then(
    (stat) => stat.isFile(),
    () => false,
  );

/** Every art file of the game's assets folder, with what its records say of it. */
export const listArtAssets = async (
  root: string,
  engine: GameEngineId,
  project: string,
): Promise<GameArtAssetsResult> => {
  const paths = gamePaths(engine, project);
  const libraryDir = NodePath.join(root, paths.library);
  const library = `${slash(paths.library)}/`;
  const credited = await creditedLibraryFiles(root, libraryDir);
  const lines = assetLines(
    await NodeFSP.readFile(NodePath.join(root, "ASSETS.md"), "utf8").catch(() => ""),
  );
  const found = (
    await walkFiles(NodePath.join(root, paths.assets), {
      enter: (_full, name) => !name.startsWith("."),
      match: (name) => !name.startsWith(".") && kindOf(name) !== null,
      limit: MAX_WALK,
    })
  )
    .map((full) => slash(NodePath.relative(root, full)))
    // A pack brings its buffers and loose textures along: only what ASSETS.md credits is the game's.
    .filter((path) => !path.startsWith(library) || credited.has(path))
    .toSorted();
  const listed = found.slice(0, MAX_ASSETS);
  const served = project === "" ? "" : `${project}/`;

  // Generation records under art/generated/, joined to listed files by their delivered bytes.
  const records = await walkFiles(NodePath.join(root, GENERATED_DIR), {
    match: (name) => name.endsWith(".generation.json"),
    maxDepth: 2,
    limit: MAX_RECORDS,
  });
  const delivered = new Map<string, string[]>();
  for (const record of records) {
    const decoded = decodeRecord(await NodeFSP.readFile(record, "utf8").catch(() => ""));
    if (Option.isNone(decoded)) continue;
    for (const file of decoded.value.files) {
      const normal = NodePath.posix.normalize(file);
      if (!normal.startsWith(`${GENERATED_DIR}/`)) continue;
      const full = NodePath.join(root, normal);
      const stat = await NodeFSP.stat(full).catch(() => null);
      if (stat === null || !stat.isFile()) continue;
      const sha = await sha256Of(full, stat.size, stat.mtimeMs);
      delivered.set(sha, [...(delivered.get(sha) ?? []), decoded.value.id]);
    }
  }

  const assets: GameArtAsset[] = [];
  for (const path of listed) {
    const kind = kindOf(path)!;
    const full = NodePath.join(root, path);
    const stat = await NodeFSP.stat(full).catch(() => null);
    if (stat === null || !stat.isFile()) continue;
    const sha256 = await sha256Of(full, stat.size, stat.mtimeMs);
    const line = lineFor(lines, path);
    const sidecarPath = /\.glb$/i.test(path)
      ? path.replace(/\.glb$/i, GAME_MODEL_SIDECAR_SUFFIX)
      : null;
    const sidecar =
      sidecarPath === null
        ? null
        : Option.getOrNull(
            decodeSidecar(
              await NodeFSP.readFile(NodePath.join(root, sidecarPath), "utf8").catch(() => ""),
            ),
          );
    let triangles: number | undefined;
    if (kind === "model") {
      if (sidecar !== null) triangles = sidecar.triangles;
      else {
        const json = await readGltfJson(full, MAX_GLTF_JSON);
        if (json.kind === "json") triangles = gltfTriangles(json.json);
      }
    }
    const fromParts = sidecar?.source.parts ?? [];
    const generations = [
      ...new Set([
        ...fromParts.flatMap((part) => (part.generation === undefined ? [] : [part.generation])),
        ...(delivered.get(sha256) ?? []),
      ]),
    ];
    const pack =
      /\blibrary pack ([a-z0-9][a-z0-9._-]*)/i.exec(line ?? "")?.[1] ??
      (sidecar?.source.route === "library"
        ? fromParts.find((part) => part.from !== "made")?.from
        : undefined);
    const route: GameArtAssetRoute =
      sidecar?.source.route ??
      (line === null ? null : routeOfLine(line)) ??
      (generations.length > 0 ? "generated" : path.startsWith(library) ? "library" : "unrecorded");
    const licences = [...new Set(fromParts.map((part) => part.licence).filter((l) => l !== ""))];
    const credit =
      licences.length > 0 ? licences.join(", ") : line === null ? null : creditOfLine(line);
    const sheet = kind === "texture" && line !== null ? sheetOfLine(line) : null;
    const thumbnail = `${ART_THUMBNAIL_DIR}/${sha256}.png`;
    assets.push({
      path,
      url: path.startsWith(served) ? path.slice(served.length) : path,
      kind,
      bytes: stat.size,
      sha256,
      route,
      ...(triangles === undefined ? {} : { triangles }),
      ...(credit === null ? {} : { credit }),
      ...(line === null || line === "" ? {} : { note: line.slice(0, 400) }),
      ...(sidecar === null || sidecarPath === null ? {} : { sidecar: sidecarPath }),
      ...(generations.length === 0 ? {} : { generations }),
      ...(pack === undefined || route !== "library" ? {} : { pack }),
      ...(sheet === null ? {} : { sheet }),
      ...(kind === "model" && (await exists(NodePath.join(root, thumbnail))) ? { thumbnail } : {}),
    });
  }
  const blend = (await exists(NodePath.join(root, BLEND_SOURCE))) ? BLEND_SOURCE : null;
  const heroSheets = await listHeroSheets(root);
  // Reviewed in Blender and not in the game yet: listed where its export will land.
  const stems = new Set(
    found.flatMap((path) => (/\.glb$/i.test(path) ? [NodePath.posix.basename(path, ".glb")] : [])),
  );
  const making = (await reviewedNotExported(root, (subject) => stems.has(subject))).map(
    ({ subject, sheet }) => ({ path: `${slash(paths.blender)}/${subject}.glb`, sheet }),
  );
  return {
    assets,
    more: Math.max(0, found.length - listed.length),
    ...(blend === null ? {} : { blend }),
    ...(heroSheets.length === 0 ? {} : { heroSheets }),
    ...(making.length === 0 ? {} : { making }),
  };
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Keeps a thumbnail the Art tab drew for these bytes. Written beside the build evidence, which the
 * game's .gitignore leaves out, so it is never part of a build; a link where it goes is refused.
 */
export const saveArtThumbnail = async (
  root: string,
  sha256: string,
  png: string,
): Promise<string> => {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("not a content hash");
  const bytes = Buffer.from(png.slice(png.indexOf(",") + 1), "base64");
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    throw new Error("not a PNG");
  const folder = NodePath.join(root, ART_THUMBNAIL_DIR);
  await NodeFSP.mkdir(folder, { recursive: true });
  const real = await NodeFSP.realpath(folder);
  const realRoot = await NodeFSP.realpath(root);
  if (!real.startsWith(realRoot + NodePath.sep))
    throw new Error("the thumbnail folder leaves the game");
  const target = NodePath.join(real, `${sha256}.png`);
  // Written aside and moved in, so a list read meanwhile never names half a picture.
  const scratch = `${target}.${process.pid}.tmp`;
  await NodeFSP.writeFile(scratch, bytes);
  await NodeFSP.rename(scratch, target);
  return `${ART_THUMBNAIL_DIR}/${sha256}.png`;
};
