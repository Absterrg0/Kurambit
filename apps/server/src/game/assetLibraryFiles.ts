// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off preferSchemaOverJson:off -- Streams pinned archives to disk with an AbortSignal and a stall timer like the toolchain downloader, unpacks them, and reads glTF JSON headers of any shape.
// The pinned CC0 library's file boundary: pins, safe unpacking and cheap facts about the files.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as Effect from "effect/Effect";
import { GameOperationError, type GameLibraryKind } from "@kurambit/contracts";
import { openZipArchive } from "../zipArchive.ts";
import { isPathInside } from "./gameNativeUserDir.ts";
import { readImageDimensions } from "@kurambit/shared/imageDimensions";

export interface LibraryPack {
  readonly id: string;
  readonly title: string;
  readonly author: string;
  readonly source: string;
  readonly download: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly licence: "CC0-1.0";
  readonly licenceEvidence: string;
  readonly kinds: ReadonlyArray<GameLibraryKind>;
  readonly formats: ReadonlyArray<string>;
  readonly style: string;
  readonly tags: string;
  readonly description: string;
}

export type LibraryMedia = "image" | "model" | "audio" | "font" | "data";

export interface LibraryFile {
  /** Pack-relative, forward slashes, as the archive names it. */
  readonly path: string;
  readonly bytes: number;
  readonly media: LibraryMedia;
  readonly format: string;
  readonly width?: number;
  readonly height?: number;
  readonly seconds?: number;
  /** glTF animation clip names, cut to a few. */
  readonly clips?: ReadonlyArray<string>;
  readonly clipCount?: number;
  /** Pack-relative files a model loads from beside itself (glTF images and buffers, OBJ materials). */
  readonly deps?: ReadonlyArray<string>;
  /** True when the glTF JSON header is too large to read, so clips and deps are unknown. */
  readonly clipsUnread?: boolean;
  /** The pack's own picture of this model. */
  readonly preview?: string;
  /** Set on an image that is a picture of this model (stem), not art made for a game. */
  readonly previewOf?: string;
}

/** Bump when indexPack learns a new fact, so saved indexes are rebuilt from the cached archive. */
export const INDEX_VERSION = 2;

export interface LibraryIndex {
  readonly version: typeof INDEX_VERSION;
  readonly pack: string;
  readonly sha256: string;
  readonly files: ReadonlyArray<LibraryFile>;
  /** The pack's own overview images (Preview.png, Sample.png). */
  readonly previews: ReadonlyArray<string>;
}

export type LibraryEngine = "godot" | "three" | "unity";

const MEDIA: Record<string, LibraryMedia> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  svg: "image",
  glb: "model",
  gltf: "model",
  fbx: "model",
  obj: "model",
  dae: "model",
  blend: "model",
  ogg: "audio",
  wav: "audio",
  mp3: "audio",
  ttf: "font",
  otf: "font",
  txt: "data",
  xml: "data",
  json: "data",
  tmx: "data",
  tsx: "data",
  mtl: "data",
  bin: "data",
};

// What each engine's project loads as shipped. .blend needs a Blender path at import, and
// the three.js template vendors only GLTFLoader, so neither is offered there.
const LOADABLE: Record<LibraryEngine, ReadonlySet<string>> = {
  godot: new Set(
    "png jpg jpeg webp svg glb gltf fbx obj dae ogg wav mp3 ttf otf txt xml json tmx tsx mtl bin".split(
      " ",
    ),
  ),
  three: new Set(
    "png jpg jpeg webp svg glb gltf ogg wav mp3 ttf otf txt xml json tmx tsx bin".split(" "),
  ),
  unity: new Set(
    "png jpg jpeg glb gltf fbx obj ogg wav mp3 ttf otf txt xml json mtl bin".split(" "),
  ),
};

/** Model formats in the order an engine prefers them; Kenney ships every model in several. */
const MODEL_RANK: Record<LibraryEngine, ReadonlyArray<string>> = {
  godot: ["glb", "gltf", "fbx", "obj", "dae"],
  three: ["glb", "gltf"],
  unity: ["glb", "fbx", "gltf", "obj"],
};

const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};
export const mediaOf = (path: string): LibraryMedia | undefined => MEDIA[extensionOf(path)];
export const loadableIn = (engine: LibraryEngine, format: string) => LOADABLE[engine].has(format);
export const modelRank = (engine: LibraryEngine, format: string) => {
  const rank = MODEL_RANK[engine].indexOf(format);
  return rank === -1 ? MODEL_RANK[engine].length : rank;
};

/** Null when the bytes are the pinned ones; otherwise what differs, for the error detail. */
export const pinProblem = (
  pack: Pick<LibraryPack, "sha256" | "bytes">,
  actual: { readonly sha256: string; readonly bytes: number },
) =>
  actual.sha256 === pack.sha256 && actual.bytes === pack.bytes
    ? null
    : `Pinned sha256 ${pack.sha256} (${pack.bytes} bytes); got ${actual.sha256} (${actual.bytes} bytes).`;

/**
 * Streams one pinned archive to `destination`. Never keeps more bytes than the pin
 * names, so a changed source cannot fill the disk; the caller checks the hash.
 * Gives up when no bytes arrive for `stallMs`, so a hung source frees its pack's lock.
 * Module-level so Effect's fetch diagnostic never sees it; reached only through Effect.tryPromise.
 */
export async function downloadPinned(
  pack: Pick<LibraryPack, "download" | "bytes">,
  destination: string,
  signal: AbortSignal,
  stallMs = 60_000,
) {
  const stall = new AbortController();
  const stalled = () =>
    stall.abort(new Error(`The download stalled: no bytes arrived for ${stallMs / 1000} s.`));
  let timer = setTimeout(stalled, stallMs);
  const requestSignal = AbortSignal.any([signal, stall.signal, AbortSignal.timeout(20 * 60_000)]);
  try {
    const response = await fetch(pack.download, {
      signal: requestSignal,
      redirect: "follow",
      headers: { "user-agent": "Kurambit asset library" },
    });
    if (!response.ok || !response.body) throw new Error(`Download request: ${response.status}`);
    if (!response.url.startsWith("https://")) throw new Error("Download left HTTPS.");
    let received = 0;
    const cap = new NodeStream.Transform({
      transform(chunk: Buffer, _encoding, callback) {
        clearTimeout(timer);
        timer = setTimeout(stalled, stallMs);
        received += chunk.byteLength;
        if (received > pack.bytes) callback(new Error("Download is larger than its pin."));
        else callback(null, chunk);
      },
    });
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.fromWeb(response.body),
      cap,
      NodeFS.createWriteStream(destination, { flags: "wx" }),
      { signal: requestSignal },
    );
  } catch (error) {
    throw stall.signal.aborted ? stall.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}

export interface UnpackLimits {
  readonly entries: number;
  readonly bytes: number;
  readonly entryBytes: number;
}
/** The largest pinned pack holds about 3,600 entries and unpacks to about 230 MB. */
export const UNPACK_LIMITS: UnpackLimits = {
  entries: 10_000,
  bytes: 512 * 1024 * 1024,
  entryBytes: 256 * 1024 * 1024,
};

interface EntryFacts {
  readonly fileName: string;
  readonly externalFileAttributes: number;
  readonly generalPurposeBitFlag: number;
  readonly compressionMethod: number;
}

/** Why an archive member may not be unpacked, or null. Pure. */
export const entryProblem = (entry: EntryFacts): string | null => {
  const name = entry.fileName;
  if (name.length === 0 || name.length > 400) return "an empty or overlong name";
  if (name.includes("\0") || name.includes("\\")) return "a name with a NUL or backslash";
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "an absolute path";
  const segments = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === ""))
    return "a path that climbs out or has empty parts";
  const type = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (type === 0o120000) return "a symbolic link";
  if (type !== 0 && type !== 0o100000 && type !== 0o040000)
    return "a device, socket or other special file";
  if ((entry.generalPurposeBitFlag & 1) !== 0) return "an encrypted member";
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
    return "an unsupported compression method";
  return null;
};

/**
 * Unpacks a verified archive into an empty `target`. Refuses the whole archive on the
 * first unsafe member: an absolute or climbing path, a link or special file, more entries
 * or bytes than `limits`, or a member that inflates past the size it declares.
 */
export const unpackArchive = (archivePath: string, target: string, limits: UnpackLimits) =>
  Effect.scoped(
    Effect.gen(function* () {
      const unsafe = (detail: string, cause?: unknown) =>
        new GameOperationError({
          operation: "Library unpack",
          path: archivePath,
          reason: "unsafe-archive",
          detail,
          ...(cause === undefined ? {} : { cause }),
        });
      const io = (cause: unknown) =>
        new GameOperationError({ operation: "Library unpack", path: target, reason: "io", cause });
      // yauzl refuses absolute and climbing names itself; those reach us as an unreadable archive.
      const archive = yield* openZipArchive(archivePath, (_detail, cause) =>
        unsafe("The archive is malformed or names an unsafe path.", cause),
      );
      if (archive.entryCount > limits.entries)
        return yield* unsafe(
          `The archive has ${archive.entryCount} entries; the limit is ${limits.entries}.`,
        );
      let total = 0;
      const seen = new Set<string>();
      for (;;) {
        const entry = yield* archive.next;
        if (entry === null) break;
        const shown = JSON.stringify(entry.fileName.slice(0, 120));
        const problem = entryProblem(entry);
        if (problem !== null) return yield* unsafe(`Member ${shown} is ${problem}.`);
        const destination = NodePath.join(target, entry.fileName);
        if (!isPathInside(destination, target) || destination === NodePath.resolve(target))
          return yield* unsafe(`Member ${shown} resolves outside the pack.`);
        if (!entry.fileName.endsWith("/")) {
          const key = NodePath.relative(target, destination);
          if (seen.has(key)) return yield* unsafe(`Member ${shown} is a duplicate entry.`);
          seen.add(key);
        }
        if (entry.fileName.endsWith("/")) {
          yield* Effect.tryPromise({
            try: () => NodeFSP.mkdir(destination, { recursive: true }),
            catch: io,
          });
          continue;
        }
        total += entry.uncompressedSize;
        if (entry.uncompressedSize > limits.entryBytes || total > limits.bytes)
          return yield* unsafe(
            `The archive unpacks past ${Math.round(limits.bytes / 1048576)} MB in all or ${Math.round(limits.entryBytes / 1048576)} MB per file.`,
          );
        yield* Effect.tryPromise({
          try: () => NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true }),
          catch: io,
        });
        const declared = entry.uncompressedSize;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const readable = yield* archive.streamEntry(entry);
            let written = 0;
            const cap = new NodeStream.Transform({
              transform(chunk: Buffer, _encoding, callback) {
                written += chunk.byteLength;
                if (written > declared)
                  callback(new Error("Member inflates past its declared size."));
                else callback(null, chunk);
              },
            });
            yield* Effect.tryPromise({
              try: () =>
                NodeStreamPromises.pipeline(
                  readable,
                  cap,
                  NodeFS.createWriteStream(destination, { flags: "wx", mode: 0o644 }),
                ),
              catch: (cause) =>
                unsafe(`Member ${shown} could not be unpacked within its size.`, cause),
            });
          }),
        );
      }
    }),
  );

const readHead = async (path: string, bytes: number, position = 0) => {
  const handle = await NodeFSP.open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

const wavSeconds = (head: Buffer) => {
  if (head.length < 12 || head.toString("latin1", 0, 4) !== "RIFF") return undefined;
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= head.length) {
    const id = head.toString("latin1", offset, offset + 4);
    const size = head.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 16 <= head.length) byteRate = head.readUInt32LE(offset + 16);
    if (id === "data") return byteRate > 0 ? size / byteRate : undefined;
    offset += 8 + size + (size % 2);
  }
  return undefined;
};

/** Vorbis or Opus: the last page's granule position over the stream's sample rate. */
const oggSeconds = (head: Buffer, tail: Buffer) => {
  const vorbis = head.indexOf("\x01vorbis", 0, "latin1");
  const opus = head.indexOf("OpusHead", 0, "latin1");
  const rate =
    vorbis >= 0 && vorbis + 16 <= head.length
      ? head.readUInt32LE(vorbis + 12)
      : opus >= 0
        ? 48_000
        : 0;
  const skip =
    opus >= 0 && vorbis < 0 && opus + 12 <= head.length ? head.readUInt16LE(opus + 10) : 0;
  const last = tail.lastIndexOf("OggS", tail.length - 1, "latin1");
  if (rate <= 0 || last < 0 || last + 14 > tail.length) return undefined;
  const granule = Number(tail.readBigInt64LE(last + 6));
  return granule > 0 ? (granule - skip) / rate : undefined;
};

const GLB_HEADER_BYTES = 4 * 1024 * 1024;
const GLTF_FILE_BYTES = 64 * 1024 * 1024;

/** glTF JSON from a .glb header or a .gltf file, if it parses. */
const gltfJson = (buffer: Buffer, binary: boolean): unknown => {
  try {
    if (!binary) return JSON.parse(buffer.toString("utf8"));
    if (buffer.length < 20 || buffer.toString("latin1", 0, 4) !== "glTF") return undefined;
    const length = buffer.readUInt32LE(12);
    if (buffer.toString("latin1", 16, 20) !== "JSON" || 20 + length > buffer.length)
      return undefined;
    return JSON.parse(buffer.toString("utf8", 20, 20 + length));
  } catch {
    return undefined;
  }
};

const relativeUris = (items: unknown): string[] =>
  Array.isArray(items)
    ? items.flatMap((item) => {
        const uri = (item as { uri?: unknown } | null)?.uri;
        return typeof uri === "string" && !uri.startsWith("data:") && !/^[a-z]+:/i.test(uri)
          ? [decodeURIComponent(uri)]
          : [];
      })
    : [];

const gltfFacts = (json: unknown) => {
  const doc = (json ?? {}) as { animations?: unknown; images?: unknown; buffers?: unknown };
  const clips = Array.isArray(doc.animations)
    ? doc.animations.flatMap((clip) => {
        const name = (clip as { name?: unknown } | null)?.name;
        return typeof name === "string" ? [name.slice(0, 40)] : [];
      })
    : [];
  return { clips, uris: [...relativeUris(doc.images), ...relativeUris(doc.buffers)] };
};

/** Pack-relative path of a file a model names beside itself, or undefined when it climbs out. */
const besides = (model: string, reference: string) => {
  const joined = NodePath.posix.normalize(
    NodePath.posix.join(NodePath.posix.dirname(model), reference),
  );
  return joined.startsWith("../") || joined.startsWith("/") ? undefined : joined;
};

const PREVIEW_DIR = /(?:^|\/)previews?\//i;
const OVERVIEW = /^(?:preview|sample)/i;

const stem = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (dot <= 0 ? name : name.slice(0, dot)).toLowerCase();
};

const TEXTURE_DIR = /(?:^|\/)textures?\//i;

/**
 * Which images are pictures of a model, and each model's best one. Kenney kits name renders
 * after the model: Previews/tree.png, Side/tree.png or Isometric/tree_NE.png. An image a model
 * loads, or one under Textures/, is never a picture. Pure.
 */
export const modelPictures = (
  files: ReadonlyArray<Pick<LibraryFile, "path" | "media" | "deps">>,
) => {
  const models = new Set(
    files.filter((file) => file.media === "model").map((file) => stem(file.path)),
  );
  const loaded = new Set(files.flatMap((file) => file.deps ?? []));
  const ofImage = new Map<string, string>();
  const byModel = new Map<string, string>();
  const rank = (path: string, model: string) =>
    PREVIEW_DIR.test(path) ? 0 : stem(path) === model ? 1 : 2;
  for (const file of files) {
    if (file.media !== "image" || loaded.has(file.path) || TEXTURE_DIR.test(file.path)) continue;
    const name = stem(file.path);
    // The longest model name the image is named after, so tree_oak_NE goes to tree_oak, not tree.
    let model = models.has(name) ? name : undefined;
    for (
      let cut = name.lastIndexOf("_");
      model === undefined && cut > 0;
      cut = name.lastIndexOf("_", cut - 1)
    )
      if (models.has(name.slice(0, cut))) model = name.slice(0, cut);
    if (model === undefined) continue;
    ofImage.set(file.path, model);
    const prior = byModel.get(model);
    if (
      prior === undefined ||
      rank(file.path, model) < rank(prior, model) ||
      (rank(file.path, model) === rank(prior, model) && file.path < prior)
    )
      byModel.set(model, file.path);
  }
  return { ofImage, byModel };
};

const walk = async (directory: string, prefix = ""): Promise<string[]> => {
  const entries = await NodeFSP.readdir(NodePath.join(directory, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await walk(directory, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
};

/** Facts about every usable file in an unpacked pack. Reads headers only, except glTF JSON. */
export const indexPack = async (
  pack: Pick<LibraryPack, "id" | "sha256">,
  directory: string,
): Promise<LibraryIndex> => {
  const paths = await walk(directory);
  const present = new Set(paths);
  const files: LibraryFile[] = [];
  for (const path of paths) {
    const media = mediaOf(path);
    if (media === undefined) continue;
    const format = extensionOf(path);
    const absolute = NodePath.join(directory, path);
    const { size } = await NodeFSP.stat(absolute);
    let file: LibraryFile = { path, bytes: size, media, format };
    if (format === "png") file = { ...file, ...readImageDimensions(await readHead(absolute, 24)) };
    if (format === "wav") {
      const seconds = wavSeconds(await readHead(absolute, 65_536));
      if (seconds !== undefined) file = { ...file, seconds: Math.round(seconds * 100) / 100 };
    }
    if (format === "ogg") {
      const seconds = oggSeconds(
        await readHead(absolute, 4096),
        await readHead(absolute, 65_536, Math.max(0, size - 65_536)),
      );
      if (seconds !== undefined) file = { ...file, seconds: Math.round(seconds * 100) / 100 };
    }
    const glbHead = format === "glb" ? await readHead(absolute, 20) : undefined;
    const jsonBytes =
      glbHead === undefined
        ? size
        : glbHead.length === 20 && glbHead.toString("latin1", 0, 4) === "glTF"
          ? 20 + glbHead.readUInt32LE(12)
          : 0;
    if (
      (format === "glb" && jsonBytes > GLB_HEADER_BYTES) ||
      (format === "gltf" && size > GLTF_FILE_BYTES)
    )
      file = { ...file, clipsUnread: true };
    else if (format === "glb" || format === "gltf") {
      const head =
        format === "glb" ? await readHead(absolute, jsonBytes) : await NodeFSP.readFile(absolute);
      const facts = gltfFacts(gltfJson(head, format === "glb"));
      const deps = facts.uris.flatMap((uri) => {
        const dep = besides(path, uri);
        return dep !== undefined && present.has(dep) ? [dep] : [];
      });
      file = {
        ...file,
        ...(facts.clips.length > 0
          ? { clips: facts.clips.slice(0, 8), clipCount: facts.clips.length }
          : {}),
        ...(deps.length > 0 ? { deps } : {}),
      };
    }
    if (format === "obj") {
      const text = (await readHead(absolute, 65_536)).toString("utf8");
      const materials = [...text.matchAll(/^mtllib\s+(.+?)\s*$/gm)].flatMap((m) => {
        const dep = besides(path, m[1] ?? "");
        return dep !== undefined && present.has(dep) ? [dep] : [];
      });
      const maps: string[] = [];
      for (const material of materials) {
        const mtl = await NodeFSP.readFile(NodePath.join(directory, material), "utf8");
        for (const m of mtl.matchAll(/^\s*map_\w+\s+(?:-\S+\s+\S+\s+)*(.+?)\s*$/gm)) {
          const dep = besides(material, m[1] ?? "");
          if (dep !== undefined && present.has(dep)) maps.push(dep);
        }
      }
      if (materials.length > 0) file = { ...file, deps: [...new Set([...materials, ...maps])] };
    }
    if (format === "fbx") {
      // FBX names its textures by path; Kenney and Quaternius keep them in a sibling Textures/.
      const prefix = `${NodePath.posix.dirname(path)}/Textures/`.replace(/^\.\//, "");
      const textures = paths.filter(
        (other) => other.startsWith(prefix) && mediaOf(other) === "image",
      );
      if (textures.length > 0) file = { ...file, deps: textures };
    }
    files.push(file);
  }
  const pictures = modelPictures(files);
  const withPictures = files.map((file) => {
    const preview = file.media === "model" ? pictures.byModel.get(stem(file.path)) : undefined;
    const previewOf = pictures.ofImage.get(file.path);
    return {
      ...file,
      ...(preview === undefined ? {} : { preview }),
      ...(previewOf === undefined ? {} : { previewOf }),
    };
  });
  const previews = paths
    .filter(
      (path) => mediaOf(path) === "image" && OVERVIEW.test(path.slice(path.lastIndexOf("/") + 1)),
    )
    .filter((path) => !PREVIEW_DIR.test(path))
    .toSorted((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, 4);
  return {
    version: INDEX_VERSION,
    pack: pack.id,
    sha256: pack.sha256,
    files: withPictures,
    previews,
  };
};

/** One game-safe path segment: ASSETS.md and engines read paths without spaces or brackets. */
const safeSegment = (segment: string) =>
  segment
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/-+\./g, ".")
    .replace(/^[-.]+|-+$/g, "") || "file";

export const safePath = (path: string) => path.split("/").map(safeSegment).join("/");

export const queryWords = (query: string | undefined) =>
  (query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2);

/** How many query words appear in the text, as substrings, so "tile" finds "tiles". */
export const matchScore = (words: ReadonlyArray<string>, text: string) => {
  const lower = text.toLowerCase();
  return words.filter((word) => lower.includes(word)).length;
};
