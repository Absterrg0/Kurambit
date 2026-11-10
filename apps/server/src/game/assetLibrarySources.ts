// The library's per-asset sources: Poly Haven and ambientCG from the index files a maintainer
// writes with scripts/library-index.ts (shipped, so search works offline and no install crawls
// a one-person API), and Poly Pizza searched live with the person's own key. Each asset is a
// library entry of its own (a LibraryPack with a group), so fetch, add and credit treat it like
// a pack; a STYLE.json lists the source's id, never each asset.
import type { GameLibraryKind } from "@kurambit/contracts";
import { LIBRARY_CATALOG } from "./assetLibraryCatalog.ts";
import {
  entryLicenceProblem,
  filesDigest,
  shippableLicence,
  type LibraryPack,
  type LibraryPackFile,
} from "./assetLibraryFiles.ts";
import polyHavenIndex from "./library/polyhaven.json" with { type: "json" };
import ambientCgIndex from "./library/ambientcg.json" with { type: "json" };

export interface LibrarySource {
  /** What a STYLE.json's packs lists to take its assets. */
  readonly id: "polyhaven" | "ambientcg" | "polypizza";
  readonly title: string;
  readonly site: string;
  readonly family: string;
  /** One line on where its bytes come from and on what terms. */
  readonly terms: string;
}

export const LIBRARY_SOURCES: ReadonlyArray<LibrarySource> = [
  {
    id: "polyhaven",
    title: "Poly Haven",
    site: "https://polyhaven.com",
    family: "photo-pbr",
    terms:
      "CC0; files from Poly Haven's own servers, each pinned by Poly Haven's MD5 and size (polyhaven.com)",
  },
  {
    id: "ambientcg",
    title: "ambientCG",
    site: "https://ambientcg.com",
    family: "photo-pbr",
    terms: "CC0; 1K zips from ambientCG's own server, pinned by size (ambientCG publishes no hash)",
  },
  {
    id: "polypizza",
    title: "Poly Pizza",
    site: "https://poly.pizza",
    family: "polypizza",
    terms:
      "CC0 or CC BY per model, searched live with the person's own Poly Pizza API key (Settings → Game tools); CC BY models are credited in the game",
  },
];

/** A model larger than this is a film-grade scan, not a game asset; it is not listed. */
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const extension = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

interface PolyHavenRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly authors: string;
  readonly tags: string;
  readonly tris?: number;
  readonly size?: ReadonlyArray<number>;
  readonly files: ReadonlyArray<ReadonlyArray<string | number>>;
}

const POLYHAVEN_KIND: Record<string, GameLibraryKind> = {
  model: "model",
  texture: "texture",
  hdri: "hdri",
};

const polyHavenEntry = (base: string, row: PolyHavenRow): LibraryPack | null => {
  const kind = POLYHAVEN_KIND[row.type];
  if (kind === undefined) return null;
  const files: LibraryPackFile[] = row.files.map(([path, url, bytes, md5]) => ({
    path: String(path),
    url: `${base}${String(url)}`,
    bytes: Number(bytes),
    md5: String(md5),
  }));
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (files.length === 0 || bytes > MAX_ENTRY_BYTES) return null;
  const size =
    row.size === undefined ? "" : `, about ${row.size.map((m) => m.toFixed(2)).join(" x ")} m`;
  return {
    id: `polyhaven-${slug(row.id)}`,
    title: row.name,
    author: row.authors === "" ? "Poly Haven" : `${row.authors} (Poly Haven)`,
    source: `https://polyhaven.com/a/${row.id}`,
    download: files[0]!.url,
    sha256: filesDigest(files),
    bytes,
    licence: "CC0-1.0",
    licenceEvidence: "https://polyhaven.com/license",
    files,
    kinds: [kind],
    formats: [...new Set(files.map((file) => extension(file.path)))].toSorted(),
    style:
      kind === "hdri"
        ? "photographed sky and light, HDR"
        : kind === "texture"
          ? "photo-scanned PBR, tileable 1K"
          : "photo-real PBR model, 1K textures",
    tags: `${row.type} ${row.tags}`,
    description:
      kind === "hdri"
        ? `A 1K HDR sky that lights a scene (${row.tags.split(" ").slice(0, 4).join(", ")}).`
        : kind === "texture"
          ? "Tileable 1K PBR material: colour, normal (OpenGL), ambient occlusion, roughness and metal packed as one ARM map, and height."
          : `${row.name}: a photo-real model${row.tris === undefined ? "" : ` of ${row.tris} triangles`}${size}, glTF with 1K textures.`,
    family: "photo-pbr",
    group: "polyhaven",
    preview: `https://cdn.polyhaven.com/asset_img/thumbs/${encodeURIComponent(row.id)}.png?width=256&height=256`,
  };
};

interface AmbientCgRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly tags: string;
  readonly bytes: number;
  readonly file: string;
}

const ambientCgEntry = (row: AmbientCgRow): LibraryPack | null => {
  const hdri = row.type === "hdri";
  if (row.bytes > MAX_ENTRY_BYTES) return null;
  return {
    id: `ambientcg-${slug(row.id)}`,
    title: row.name,
    author: "ambientCG",
    source: `https://ambientcg.com/view?id=${row.id}`,
    download: `https://ambientcg.com/get?file=${row.file}`,
    bytes: row.bytes,
    licence: "CC0-1.0",
    licenceEvidence: "https://docs.ambientcg.com/license/",
    kinds: [hdri ? "hdri" : "texture"],
    formats: hdri ? ["exr", "jpg"] : ["jpg", "png"],
    style: hdri
      ? "photographed sky and light, HDR with a tone-mapped JPG"
      : row.type === "material"
        ? "photo-scanned PBR, tileable 1K"
        : `photo-scanned ${row.type}, 1K`,
    tags: `${row.type} ${row.tags}`,
    description: hdri
      ? "A 1K sky that lights a scene: an EXR, and a tone-mapped JPG any engine loads as a background."
      : row.type === "material"
        ? "Tileable 1K PBR material: colour, normal, roughness, AO and displacement maps."
        : row.type === "decal"
          ? "A 1K decal with alpha to lay over a surface."
          : "A 1K atlas of cut-out pieces (leaves, grass, debris) with alpha.",
    family: "photo-pbr",
    group: "ambientcg",
    preview: `https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/256-PNG/${encodeURIComponent(row.id)}.png`,
  };
};

const curatedIds = new Set(LIBRARY_CATALOG.map((pack) => pack.id));

/** Entries whose licence passes and whose id is unique; the first of a clashing id wins. */
const admitted = (entries: ReadonlyArray<LibraryPack | null>) => {
  const seen = new Set<string>();
  return entries.filter((entry): entry is LibraryPack => {
    if (entry === null || curatedIds.has(entry.id) || seen.has(entry.id)) return false;
    if (entryLicenceProblem(entry) !== null) return false;
    seen.add(entry.id);
    return true;
  });
};

/** Every indexed asset of the per-asset sources, in index order. */
export const LIBRARY_ASSETS: ReadonlyArray<LibraryPack> = admitted([
  ...(polyHavenIndex.assets as ReadonlyArray<PolyHavenRow>).map((row) =>
    polyHavenEntry(polyHavenIndex.base, row),
  ),
  ...(ambientCgIndex.assets as ReadonlyArray<AmbientCgRow>).map(ambientCgEntry),
]);

/** When each shipped index was crawled, for the search's own line about it. */
export const INDEXED_ON = {
  polyhaven: polyHavenIndex.fetched,
  ambientcg: ambientCgIndex.fetched,
} as const;

// Poly Pizza ids are case-sensitive base-62; a library id is lower case, so an upper-case
// letter is written as "-" and the letter: reversible because the ids hold no "-".
const POLY_PIZZA_PREFIX = "polypizza-";
export const polyPizzaEntryId = (modelId: string) =>
  `${POLY_PIZZA_PREFIX}${modelId.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
export const polyPizzaModelId = (entryId: string) =>
  entryId.startsWith(POLY_PIZZA_PREFIX) && /^[a-z0-9-]+$/.test(entryId)
    ? entryId
        .slice(POLY_PIZZA_PREFIX.length)
        .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
    : null;

/** Poly Pizza serves at most this much per model; it publishes no size or hash, so it is a ceiling. */
const POLY_PIZZA_MAX_BYTES = 64 * 1024 * 1024;

/** One model record as Poly Pizza's API v1.1 returns it (poly.pizza/apispec/v1.1.yaml). */
export interface PolyPizzaModel {
  readonly ID: string;
  readonly Title: string;
  readonly Attribution?: string;
  readonly Thumbnail?: string;
  readonly Download?: string;
  readonly "Tri Count"?: number;
  readonly Creator?: { readonly Username?: string };
  readonly Category?: string;
  readonly Tags?: ReadonlyArray<string>;
  readonly Licence?: string;
  readonly Animated?: boolean;
}

/**
 * A Poly Pizza model as a library entry, or null when its licence is not one a sold game may
 * ship under, it has no GLB, or a CC BY model comes without the credit line it asks for.
 */
export const polyPizzaEntry = (model: PolyPizzaModel): LibraryPack | null => {
  const licence = shippableLicence(model.Licence ?? "");
  const download = model.Download ?? "";
  if (licence === null || !/^https:\/\/static\.poly\.pizza\/[^?#]+\.glb$/.test(download))
    return null;
  if (!/^[A-Za-z0-9]{4,40}$/.test(model.ID)) return null;
  const creator = model.Creator?.Username ?? "unknown";
  const file = `${slug(model.Title) || "model"}.glb`;
  const files: LibraryPackFile[] = [
    { path: file, url: download, bytes: POLY_PIZZA_MAX_BYTES, capped: true },
  ];
  const entry: LibraryPack = {
    id: polyPizzaEntryId(model.ID),
    title: model.Title,
    author: `${creator} (Poly Pizza)`,
    source: `https://poly.pizza/m/${model.ID}`,
    download,
    sha256: filesDigest(files),
    bytes: POLY_PIZZA_MAX_BYTES,
    licence,
    licenceEvidence: `https://poly.pizza/m/${model.ID}`,
    ...(model.Attribution === undefined || model.Attribution.trim() === ""
      ? {}
      : { credit: model.Attribution.trim() }),
    files,
    kinds: model.Animated === true ? ["model", "character"] : ["model"],
    formats: ["glb"],
    style: `low-poly by ${creator}`,
    tags: `${model.Category ?? ""} ${(model.Tags ?? []).join(" ")} ${creator}`.toLowerCase(),
    description: `${model.Title} by ${creator}${model["Tri Count"] === undefined ? "" : `, ${model["Tri Count"]} triangles`}${model.Animated === true ? ", animated with clips of its own" : ""}.`,
    family: "polypizza",
    group: "polypizza",
    ...(model.Animated === true ? { animated: 1 } : {}),
    ...(model.Thumbnail !== undefined && model.Thumbnail.startsWith("https://static.poly.pizza/")
      ? { preview: model.Thumbnail }
      : {}),
  };
  return entryLicenceProblem(entry) === null ? entry : null;
};
