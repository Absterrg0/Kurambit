// @effect-diagnostics globalFetch:off -- Streams large checked artifacts directly to disk with an AbortSignal, like the toolchain downloader.
// @effect-diagnostics nodeBuiltinImport:off -- This service owns the Poly Haven HTTP boundary and staged download files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { GameOperationError } from "@t3tools/contracts";
import {
  GAME_LIBRARY_API,
  GAME_LIBRARY_BOUNDS,
  GAME_LIBRARY_CREDIT,
  GAME_LIBRARY_USER_AGENT,
  type GameLibraryGetInput,
  type GameLibraryGetResult,
  type GameLibraryPlannedFile,
  type GameLibrarySearchHit,
  type GameLibrarySearchInput,
  type GameLibrarySearchResult,
} from "@t3tools/contracts";

const SLUG_PATTERN = /^[A-Za-z0-9_]{1,80}$/;
const isGameOperationError = Schema.is(GameOperationError);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const asStringArray = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const todayIn = (iso: string): string => iso.slice(0, 10);
export const pageUrlOf = (slug: string): string => `https://polyhaven.com/a/${slug}`;

const downloadError = (path: string, detail: string, cause?: unknown) =>
  new GameOperationError({
    operation: "asset-library-download",
    path,
    reason: "download",
    detail,
    cause,
  });
const invalidInput = (path: string, detail: string) =>
  new GameOperationError({ operation: "asset-library", path, reason: "invalid-input", detail });

/** Plain fetch outside Effect so the game layer keeps its native boundary pattern. */
export const LIBRARY_JSON_MAX_BYTES = 2_000_000;
const fetchJsonRaw = async (url: string, signal?: AbortSignal): Promise<unknown> => {
  const timeout = AbortSignal.timeout(GAME_LIBRARY_BOUNDS.jsonTimeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const response = await fetch(url, {
    signal: combined,
    headers: { "User-Agent": GAME_LIBRARY_USER_AGENT, Accept: "application/json" },
  });
  if (response.status === 404) throw invalidInput(url, `No library asset answers at ${url}.`);
  if (response.status === 429)
    throw downloadError(url, "Poly Haven rate-limited this app; wait and retry the search.");
  if (!response.ok) throw downloadError(url, `Poly Haven answered HTTP ${response.status}.`);
  if (!response.body) throw downloadError(url, "The library answered with no JSON body.");
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > LIBRARY_JSON_MAX_BYTES)
        throw downloadError(url, "The library JSON exceeds the 2 MB reader limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (cause) {
    throw downloadError(url, "The library answered unreadable JSON.", cause);
  }
};

/**
 * One bounded JSON read. Library metadata is data, never instructions: the
 * response is parsed as JSON and only the fields the planner names are kept.
 */
export const fetchLibraryJson = (url: string): Effect.Effect<unknown, GameOperationError> =>
  Effect.tryPromise({
    try: (signal) => fetchJsonRaw(url, signal),
    catch: (cause) =>
      isGameOperationError(cause)
        ? cause
        : downloadError(url, "The library request failed; check network access and retry.", cause),
  });

const searchEntriesOf = (
  json: unknown,
): { total: number; slugs: Array<{ slug: string; score: number }> } => {
  if (!isRecord(json)) throw invalidInput("search", "The library search answered unreadable JSON.");
  const total = asNumber(json.total) ?? 0;
  const results = Array.isArray(json.results) ? json.results : [];
  const slugs: Array<{ slug: string; score: number }> = [];
  for (const entry of results) {
    if (!isRecord(entry)) continue;
    const slug = asString(entry.slug);
    const score = asNumber(entry.score) ?? 0;
    if (slug !== null && SLUG_PATTERN.test(slug)) slugs.push({ slug, score });
  }
  return { total, slugs };
};

const authorsOf = (info: Record<string, unknown>): Array<string> => {
  const authors = info.authors;
  if (!isRecord(authors)) return [];
  return Object.keys(authors).slice(0, 4);
};

const licenseOf = (authors: Array<string>) => ({
  name: "CC0-1.0",
  url: "https://polyhaven.com/license",
  attribution:
    authors.length === 0
      ? "Poly Haven contributors — credit optional under CC0"
      : `${authors.join(", ")} via Poly Haven — credit optional under CC0`,
});

/**
 * The shared asset summary from an /info response. Only display and planning
 * fields are kept; the raw document never reaches the game.
 */
const summarizeInfo = (slug: string, info: unknown) => {
  if (!isRecord(info))
    throw invalidInput(slug, `The library has no readable metadata for '${slug}'.`);
  const typeNum = asNumber(info.type);
  const kind = typeNum === 2 ? ("model" as const) : typeNum === 1 ? ("texture" as const) : null;
  if (kind === null) throw invalidInput(slug, `Library asset '${slug}' is not a model or texture.`);
  const name = asString(info.name) ?? slug;
  const description = (asString(info.description) ?? "").slice(0, 700) || name;
  const category =
    asString(info.category) ??
    (Array.isArray(info.categories) ? String(info.categories[0] ?? "") : "");
  const tags = asStringArray(info.tags).slice(0, 12);
  const authors = authorsOf(info);
  const thumbnailUrl = asString(info.thumbnail_url) ?? "";
  const dimensions = Array.isArray(info.dimensions)
    ? info.dimensions
        .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
        .slice(0, 3)
    : undefined;
  const polycount = asNumber(info.polycount) ?? undefined;
  const maxResolution = Array.isArray(info.max_resolution)
    ? info.max_resolution.filter((entry): entry is number => typeof entry === "number").slice(0, 2)
    : [];
  const downloadCount = asNumber(info.download_count) ?? undefined;
  return {
    kind,
    name,
    description,
    category,
    tags,
    authors,
    thumbnailUrl,
    dimensions,
    polycount,
    maxResolution,
    downloadCount,
  };
};

const fileEntryOf = (node: unknown): { url: string; size: number; md5: string } | null => {
  if (!isRecord(node)) return null;
  const url = asString(node.url);
  const size = asNumber(node.size);
  const md5 = asString(node.md5);
  if (url === null || size === null || md5 === null) return null;
  if (!url.startsWith("https://")) return null;
  if (!/^[a-f0-9]{32}$/.test(md5)) return null;
  if (!Number.isInteger(size) || !(size > 0)) return null;
  return { url, size, md5 };
};

const isSafePlannedPath = (path: unknown): path is string => {
  if (typeof path !== "string" || path.length === 0 || path.length > 200) return false;
  if (path.includes("\\") || path.startsWith("/") || path.includes("..")) return false;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
};

/**
 * Every pinned file names a distinct relative destination with an integral
 * byte count. Duplicates would overwrite each other on publish, unsafe paths
 * would escape the game, and fractional sizes never match a real download.
 */
const validatePlannedFiles = (slug: string, files: ReadonlyArray<GameLibraryPlannedFile>): void => {
  const seen = new Set<string>();
  for (const file of files) {
    if (!isSafePlannedPath(file.path))
      throw invalidInput(
        slug,
        `Library asset '${slug}' names an unsafe destination '${String(file.path)}'.`,
      );
    if (seen.has(file.path))
      throw invalidInput(
        slug,
        `Library asset '${slug}' names '${file.path}' twice; destinations must be distinct.`,
      );
    seen.add(file.path);
    if (!Number.isInteger(file.bytes) || !(file.bytes > 0))
      throw invalidInput(
        slug,
        `Library file '${file.path}' has an invalid byte count '${String(file.bytes)}'.`,
      );
    if (typeof file.url !== "string" || !file.url.startsWith("https://"))
      throw invalidInput(slug, `Library file '${file.path}' has an unreadable URL.`);
    if (typeof file.md5 !== "string" || !/^[a-f0-9]{32}$/.test(file.md5))
      throw invalidInput(slug, `Library file '${file.path}' has an unreadable checksum.`);
  }
};

const basenameOf = (url: string): string => {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? url);
  } catch {
    return url.split("/").pop() ?? url;
  }
};

/**
 * The default small model plan: one glTF at the requested resolution plus the
 * exact includes the files API pins for it. Sizes are checked before any
 * download, so a large asset fails here instead of after gigabytes.
 */
export const planModelFiles = (
  slug: string,
  files: unknown,
  resolution: "1k" | "2k",
): {
  format: string;
  files: Array<GameLibraryPlannedFile>;
  availableResolutions: Array<string>;
  availableFormats: Array<string>;
} => {
  if (!isRecord(files))
    throw invalidInput(slug, `The library has no readable files for '${slug}'.`);
  const gltf = isRecord(files.gltf) ? (files.gltf[resolution] as unknown) : null;
  const gltfNode = isRecord(gltf) ? (gltf.gltf as unknown) : null;
  const entry = fileEntryOf(gltfNode);
  if (entry === null)
    throw invalidInput(
      slug,
      `Library model '${slug}' has no glTF at ${resolution}. Available: ${Object.keys(isRecord(files.gltf) ? files.gltf : {}).join(", ") || "none"}.`,
    );
  const include = isRecord(gltfNode) && isRecord(gltfNode.include) ? gltfNode.include : {};
  const planned: Array<GameLibraryPlannedFile> = [
    { path: basenameOf(entry.url), url: entry.url, bytes: entry.size, md5: entry.md5 },
  ];
  for (const [relative, node] of Object.entries(include)) {
    const file = fileEntryOf(node);
    if (file === null)
      throw invalidInput(
        slug,
        `Library model '${slug}' names an unreadable dependency '${relative}'.`,
      );
    if (!isSafePlannedPath(relative.replaceAll("\\", "/")))
      throw invalidInput(slug, `Library model '${slug}' names an unsafe dependency '${relative}'.`);
    planned.push({
      path: relative.replaceAll("\\", "/"),
      url: file.url,
      bytes: file.size,
      md5: file.md5,
    });
  }
  if (planned.length > GAME_LIBRARY_BOUNDS.maxFilesPerImport)
    throw invalidInput(
      slug,
      `Library model '${slug}' needs ${planned.length} files; the bounded import takes at most ${GAME_LIBRARY_BOUNDS.maxFilesPerImport}.`,
    );
  validatePlannedFiles(slug, planned);
  return {
    format: "gltf",
    files: planned,
    availableResolutions: isRecord(files.gltf) ? Object.keys(files.gltf) : [],
    availableFormats: Object.keys(files).filter((key) =>
      ["gltf", "blend", "fbx", "usd"].includes(key),
    ),
  };
};

const MATERIAL_MAPS = ["Diffuse", "nor_gl", "Rough"] as const;

/**
 * The default small PBR plan: albedo plus OpenGL normal plus roughness at the
 * requested resolution, all JPEG. Albedo is colour data; normal and roughness
 * are non-colour data the engine must not treat as sRGB.
 */
export const planMaterialFiles = (
  slug: string,
  files: unknown,
  resolution: "1k" | "2k",
): {
  format: string;
  files: Array<GameLibraryPlannedFile>;
  availableResolutions: Array<string>;
  availableFormats: Array<string>;
} => {
  if (!isRecord(files))
    throw invalidInput(slug, `The library has no readable files for '${slug}'.`);
  const planned: Array<GameLibraryPlannedFile> = [];
  const resolutions = new Set<string>();
  for (const map of MATERIAL_MAPS) {
    const group = isRecord(files[map]) ? (files[map] as Record<string, unknown>) : null;
    if (group !== null) for (const key of Object.keys(group)) resolutions.add(key);
    const res = group?.[resolution] as unknown;
    // JPEG exclusively: a PNG or EXR under the same map is a different
    // encoding, never a silent substitute for the 1k JPEG plan.
    const node = isRecord(res) ? ((res as Record<string, unknown>).jpg as unknown) : null;
    const file = fileEntryOf(node);
    if (file === null) {
      const encodings = isRecord(res) ? Object.keys(res).join(", ") : "none";
      throw invalidInput(
        slug,
        `Library texture '${slug}' has no ${map} map at ${resolution} (JPEG). Available maps: ${Object.keys(files).slice(0, 12).join(", ")}. Encodings at ${resolution}: ${encodings}.`,
      );
    }
    planned.push({ path: basenameOf(file.url), url: file.url, bytes: file.size, md5: file.md5 });
  }
  validatePlannedFiles(slug, planned);
  return {
    format: "jpg",
    files: planned,
    availableResolutions: [...resolutions],
    availableFormats: ["jpg"],
  };
};

export const totalBytesOf = (files: ReadonlyArray<{ readonly bytes: number }>): number =>
  files.reduce((sum, file) => sum + file.bytes, 0);

export const checkBudgets = (slug: string, files: ReadonlyArray<GameLibraryPlannedFile>): void => {
  validatePlannedFiles(slug, files);
  const total = totalBytesOf(files);
  if (total > GAME_LIBRARY_BOUNDS.maxTotalBytes)
    throw invalidInput(
      slug,
      `Library asset '${slug}' needs ${(total / 1_000_000).toFixed(1)} MB; the bounded import takes at most ${(GAME_LIBRARY_BOUNDS.maxTotalBytes / 1_000_000).toFixed(0)} MB. Pick the 1k resolution.`,
    );
  for (const file of files)
    if (file.bytes > GAME_LIBRARY_BOUNDS.maxFileBytes)
      throw invalidInput(
        slug,
        `Library file '${file.path}' is ${(file.bytes / 1_000_000).toFixed(1)} MB; one file may be at most ${(GAME_LIBRARY_BOUNDS.maxFileBytes / 1_000_000).toFixed(0)} MB. Pick the 1k resolution.`,
      );
};

const md5OfFile = async (path: string): Promise<string> => {
  const hash = NodeCrypto.createHash("md5");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

/** Plain streaming download outside Effect so the game layer keeps its native boundary pattern. */
const downloadOneRaw = async (
  staging: string,
  file: GameLibraryPlannedFile,
  signal: AbortSignal,
): Promise<void> => {
  const destination = NodePath.join(staging, file.path);
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  const timeout = AbortSignal.timeout(GAME_LIBRARY_BOUNDS.downloadTimeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  const response = await fetch(file.url, {
    signal: combined,
    headers: { "User-Agent": GAME_LIBRARY_USER_AGENT, "accept-encoding": "identity" },
  });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  let received = 0;
  const bounded = new NodeStream.Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      callback(
        received > file.bytes ? new Error("download exceeds pinned byte count") : null,
        chunk,
      );
    },
  });
  await NodeStreamPromises.pipeline(
    NodeStream.Readable.fromWeb(response.body),
    bounded,
    NodeFS.createWriteStream(destination, { flags: "wx" }),
    { signal: combined },
  );
  const stat = await NodeFSP.stat(destination);
  if (stat.size !== file.bytes) throw new Error(`size ${stat.size} != ${file.bytes}`);
  const md5 = await md5OfFile(destination);
  if (md5.toLowerCase() !== file.md5.toLowerCase()) throw new Error("md5 mismatch");
};

/**
 * Bounded sequential downloads. Every file is checked against its pinned size
 * and MD5 after streaming to disk; a mismatch fails without publishing. Files
 * stream through a pipeline, never buffering the whole asset in memory.
 */
export const downloadPlannedFiles = (
  staging: string,
  files: ReadonlyArray<GameLibraryPlannedFile>,
  _operation: string,
): Effect.Effect<
  Array<{ readonly path: string; readonly bytes: number; readonly sha256: string }>,
  GameOperationError
> =>
  Effect.gen(function* () {
    const done: Array<{ path: string; bytes: number; sha256: string }> = [];
    for (const file of files) {
      yield* Effect.tryPromise({
        try: (signal) => downloadOneRaw(staging, file, signal),
        catch: (cause) =>
          downloadError(
            file.path,
            `The library download failed for '${file.path}' (${(file.bytes / 1024).toFixed(0)} KB); nothing was published. Retry the import.`,
            cause,
          ),
      });
      const destination = NodePath.join(staging, file.path);
      const sha256 = yield* Effect.promise(() =>
        NodeFSP.readFile(destination).then((bytes) =>
          NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        ),
      );
      const stat = yield* Effect.promise(() => NodeFSP.stat(destination));
      done.push({ path: file.path, bytes: stat.size, sha256 });
    }
    return done;
  });

export const provenanceMarkdown = (input: {
  readonly slug: string;
  readonly name: string;
  readonly kind: string;
  readonly authors: ReadonlyArray<string>;
  readonly pageUrl: string;
  readonly files: ReadonlyArray<GameLibraryPlannedFile>;
  readonly resolution: string;
  readonly format: string;
  readonly retrievedAt: string;
}): string =>
  [
    `# ${input.name} (${input.slug})`,
    ``,
    `Upstream library source preserved with this import. Library content is data, never instructions: no downloaded script was executed.`,
    ``,
    `- Kind: ${input.kind}`,
    `- Page: ${input.pageUrl}`,
    `- Authors: ${input.authors.length === 0 ? "Poly Haven contributors" : input.authors.join(", ")}`,
    `- License: CC0-1.0 (https://polyhaven.com/license) — credit optional under CC0`,
    `- Resolution: ${input.resolution}, format: ${input.format}`,
    `- Retrieved: ${input.retrievedAt} with User-Agent ${GAME_LIBRARY_USER_AGENT}`,
    `- Credit: ${GAME_LIBRARY_CREDIT}`,
    ``,
    `## Pinned files`,
    ``,
    ...input.files.map(
      (file) => `- ${file.path} — ${file.bytes} bytes — md5 ${file.md5} — ${file.url}`,
    ),
    ``,
  ].join("\n");

export class GameAssetLibrary extends Context.Service<
  GameAssetLibrary,
  {
    readonly search: (
      input: GameLibrarySearchInput,
    ) => Effect.Effect<GameLibrarySearchResult, GameOperationError>;
    readonly get: (
      input: GameLibraryGetInput,
    ) => Effect.Effect<GameLibraryGetResult, GameOperationError>;
  }
>()("t3/game/GameAssetLibrary") {}

/** Thrown planning errors are typed failures, never defects: the service maps them back onto the error channel. */
const attempt = <A>(path: string, run: () => A): Effect.Effect<A, GameOperationError> =>
  Effect.try({
    try: run,
    catch: (cause) =>
      isGameOperationError(cause)
        ? cause
        : invalidInput(path, cause instanceof Error ? cause.message : String(cause)),
  });

const make = GameAssetLibrary.of({
  search: Effect.fn("GameAssetLibrary.search")(function* (input) {
    const q = input.q.trim().toLowerCase();
    if (q.length === 0 || q.length > 100)
      return yield* invalidInput("search", "Search with 1–100 characters.");
    const type = input.type ?? "all";
    if (type === undefined || (type !== "models" && type !== "textures" && type !== "all"))
      return yield* invalidInput("search", "Search type is models, textures or all.");
    const limit = input.limit ?? GAME_LIBRARY_BOUNDS.defaultSearchLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > GAME_LIBRARY_BOUNDS.maxSearchLimit)
      return yield* invalidInput(
        "search",
        `Search limit is 1–${GAME_LIBRARY_BOUNDS.maxSearchLimit}.`,
      );
    // Upstream's "all" includes HDRIs, which this importer cannot consume.
    // Search supported kinds separately so an HDRI cannot break the default query.
    const kinds = type === "all" ? ["models", "textures"] : [type];
    let total = 0;
    const slugs: Array<{ slug: string; score: number }> = [];
    for (const kind of kinds) {
      const listing = yield* fetchLibraryJson(
        `${GAME_LIBRARY_API}/search?q=${encodeURIComponent(q)}&t=${kind}&limit=${limit}`,
      );
      const entries = yield* attempt("search", () => searchEntriesOf(listing));
      total += entries.total;
      slugs.push(...entries.slugs);
    }
    slugs.sort((a, b) => b.score - a.score);
    const hits: Array<GameLibrarySearchHit> = [];
    for (const entry of slugs.slice(0, limit)) {
      const info = (yield* fetchLibraryJson(`${GAME_LIBRARY_API}/info/${entry.slug}`)) as unknown;
      const summary = yield* attempt(entry.slug, () => summarizeInfo(entry.slug, info));
      hits.push({
        slug: entry.slug,
        score: entry.score,
        name: summary.name,
        kind: summary.kind,
        category: summary.category,
        tags: summary.tags,
        thumbnailUrl: summary.thumbnailUrl,
        authors: summary.authors,
      });
    }
    return {
      query: q,
      type: type as GameLibrarySearchResult["type"],
      total,
      hits,
      credit: GAME_LIBRARY_CREDIT,
    };
  }),
  get: Effect.fn("GameAssetLibrary.get")(function* (input) {
    if (!SLUG_PATTERN.test(input.id))
      return yield* invalidInput(input.id, `Library id '${input.id}' is not a Poly Haven slug.`);
    const info = (yield* fetchLibraryJson(`${GAME_LIBRARY_API}/info/${input.id}`)) as unknown;
    const summary = yield* attempt(input.id, () => summarizeInfo(input.id, info));
    const filesJson = (yield* fetchLibraryJson(`${GAME_LIBRARY_API}/files/${input.id}`)) as unknown;
    const resolution = GAME_LIBRARY_BOUNDS.defaultResolution as "1k";
    const plan = yield* attempt(input.id, () =>
      summary.kind === "model"
        ? planModelFiles(input.id, filesJson, resolution)
        : planMaterialFiles(input.id, filesJson, resolution),
    );
    yield* attempt(input.id, () => checkBudgets(input.id, plan.files));
    const total = totalBytesOf(plan.files);
    const pageUrl = pageUrlOf(input.id);
    const license = licenseOf(summary.authors);
    const primary = plan.files[0]!;
    const retrievedAt = todayIn(DateTime.formatIso(yield* DateTime.now));
    return {
      asset: {
        id: input.id,
        name: summary.name,
        type: summary.kind,
        description: summary.description,
        category: summary.category,
        tags: summary.tags,
        authors: summary.authors,
        license,
        source: {
          title: `${summary.name} (${input.id}) via Poly Haven`,
          url: pageUrl,
          archiveUrl: primary.url,
          retrievedAt,
        },
        pageUrl,
        thumbnailUrl: summary.thumbnailUrl,
        ...(summary.dimensions === undefined ? {} : { dimensionsMm: summary.dimensions }),
        ...(summary.polycount === undefined ? {} : { polycount: summary.polycount }),
        maxResolution: summary.maxResolution,
        ...(summary.downloadCount === undefined ? {} : { downloadCount: summary.downloadCount }),
      },
      defaultResolution: resolution,
      defaultFormat: plan.format,
      files: plan.files,
      totalBytes: total,
      availableResolutions: plan.availableResolutions,
      availableFormats: plan.availableFormats,
      credit: GAME_LIBRARY_CREDIT,
      message:
        summary.kind === "model"
          ? `${summary.name} is a ${summary.polycount ?? "authored"}-triangle CC0 ${summary.category}. The 1k glTF plan is ${(total / 1024).toFixed(0)} KB across ${plan.files.length} pinned files. Photogrammetry detail does not automatically match a low-poly brief — check the triangle count and metre scale before importing. ${GAME_LIBRARY_CREDIT}.`
          : `${summary.name} is a CC0 PBR ${summary.category} covering ${summary.dimensions?.join("×") ?? "authored"} mm. The 1k JPEG plan is ${(total / 1024).toFixed(0)} KB (albedo colour plus OpenGL normal and roughness as non-colour data). The shared art profile is a convention warning, never a repaint of real PBR maps. ${GAME_LIBRARY_CREDIT}.`,
    };
  }),
});

export const layer = Layer.succeed(GameAssetLibrary, make);
