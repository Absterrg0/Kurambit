// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- This service owns the library cache and copies files into game folders; index.json is its own cache file, rebuilt when it does not match the pin.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import {
  GameOperationError,
  type GameAssetsAddInput,
  type GameAssetsAddResult,
  type GameAssetsSearchInput,
  type GameAssetsSearchResult,
  type GameLibraryKind,
} from "@kurambit/contracts";
import { LIBRARY_CATALOG } from "./assetLibraryCatalog.ts";
import {
  INDEX_VERSION,
  UNPACK_LIMITS,
  downloadPinned,
  fileSha256,
  indexPack,
  loadableIn,
  matchScore,
  mediaOf,
  modelRank,
  pinProblem,
  queryWords,
  safePath,
  unpackArchive,
  type LibraryEngine,
  type LibraryFile,
  type LibraryIndex,
  type LibraryMedia,
  type LibraryPack,
} from "./assetLibraryFiles.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { toolsDirectory } from "./GameToolchain.ts";
import { laneLibrary } from "./engineProfile.ts";
import { templateDirectoryCandidates } from "./templates.ts";

/** Beside the pinned tools, shared by every game on this machine. */
const libraryDirectory = () => NodePath.join(NodePath.dirname(toolsDirectory()), "asset-library");

/** Vendored beside the starter templates (see its THIRD-PARTY-NOTICES.md), so sheets never wait on a pack. */
export const LABEL_FONT = "label-font.ttf";
export const labelFontDirectory = () => {
  const candidates = templateDirectoryCandidates(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    NodePath.join,
  ).map((templates) => NodePath.join(templates, "asset-library"));
  return Effect.promise(async () => {
    for (const candidate of candidates)
      if (
        await NodeFSP.access(NodePath.join(candidate, LABEL_FONT)).then(
          () => true,
          () => false,
        )
      )
        return candidate;
    return undefined;
  });
};
const MAX_ADD_FILES = 3000;
const MAX_ADD_BYTES = 300 * 1024 * 1024;
/** Far more than a game loads well; a bigger model add is almost always a folder of every format. */
const MAX_MODEL_ADD_BYTES = 100 * 1024 * 1024;
const PAGE = 12;

const KIND_MEDIA: Record<GameLibraryKind, LibraryMedia> = {
  sprite: "image",
  tile: "image",
  ui: "image",
  icon: "image",
  texture: "image",
  character: "model",
  model: "model",
  animation: "model",
  font: "font",
  sfx: "audio",
  music: "audio",
};

export class GameAssetLibrary extends Context.Service<
  GameAssetLibrary,
  {
    readonly search: (
      root: string,
      input: GameAssetsSearchInput,
    ) => Effect.Effect<GameAssetsSearchResult, GameOperationError>;
    readonly add: (
      root: string,
      input: GameAssetsAddInput,
    ) => Effect.Effect<GameAssetsAddResult, GameOperationError>;
  }
>()("kurambit/game/GameAssetLibrary") {}

const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 1048576 ? 2 : 1)} MB`;
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const stemOf = (path: string) =>
  nameOf(path)
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
/** Only plain path characters reach ffmpeg's filtergraph, so nothing there needs escaping. */
const plainPath = (path: string) => /^[A-Za-z0-9/._-]+$/.test(path);

const describe = (file: LibraryFile) => {
  const parts = [file.format];
  if (file.width !== undefined) parts.push(`${file.width}x${file.height}`);
  if (file.previewOf !== undefined) parts.push(`a picture of the ${file.previewOf} model`);
  if (file.seconds !== undefined) parts.push(`${file.seconds} s`);
  if (file.clipsUnread === true) parts.push("clip list not read (glTF header over 4 MB)");
  if (file.clipCount !== undefined)
    parts.push(
      `${file.clipCount} clips: ${file.clips?.join(", ")}${file.clipCount > (file.clips?.length ?? 0) ? ", …" : ""}`,
    );
  if (file.media === "model" && file.preview === undefined) parts.push("no preview");
  return parts.join(", ");
};

const engineOf = (name: string): LibraryEngine =>
  name === "three" ? "three" : name === "unity" ? "unity" : "godot";

/** Game-relative directory a pack's files land in, under the lane's own asset dir. */
const libraryDirFor = (lane: string, pack: string) => `${laneLibrary(lane)}/${pack}`;

/** Scratch names carry the pid of the server that made them, so a sweep spares a live server's fetch. */
const SCRATCH_NAME =
  /^(?:(\d+)-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.part)?$/;
const scratchPid = (name: string): number | null | undefined => {
  for (const pack of LIBRARY_CATALOG) {
    if (!name.startsWith(`${pack.id}-`)) continue;
    const match = SCRATCH_NAME.exec(name.slice(pack.id.length + 1));
    if (match !== null) return match[1] === undefined ? null : Number(match[1]);
  }
  return undefined;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const reasonText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const readSaved = (pack: LibraryPack, dir: string) =>
  NodeFSP.readFile(NodePath.join(dir, "index.json"), "utf8").then(
    (text) => {
      const saved = JSON.parse(text) as LibraryIndex;
      return saved.version === INDEX_VERSION &&
        saved.sha256 === pack.sha256 &&
        Array.isArray(saved.files)
        ? saved
        : null;
    },
    () => null,
  );

// The index version is part of the folder name: servers of different versions
// share this cache, and each must only ever replace a folder of its own version.
const packKey = (pack: LibraryPack) => `${pack.id}-${pack.sha256.slice(0, 12)}-i${INDEX_VERSION}`;

/** Moves a finished staging folder into place; another server sharing the cache may have placed it first. */
const place = async (pack: LibraryPack, staging: string, dir: string, built: LibraryIndex) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await NodeFSP.rename(staging, dir);
      return built;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "ENOTEMPTY" && code !== "EEXIST") || attempt > 0) throw error;
      const theirs = await readSaved(pack, dir);
      if (theirs !== null) return theirs;
      // A folder without a current index is a stale or broken copy of ours.
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  }
};

type DirOutcome =
  | { readonly kind: "dir"; readonly path: string }
  | { readonly kind: "link" | "file"; readonly at: string };

const make = Effect.gen(function* () {
  const processes = yield* GameProcesses.GameProcesses;
  const projects = yield* GameProjectService.GameProjectService;
  const directory = libraryDirectory();
  const scratch = NodePath.join(directory, "tmp");
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockOf = (id: string) => {
    const known = locks.get(id);
    if (known !== undefined) return known;
    const made = Semaphore.makeUnsafe(1);
    locks.set(id, made);
    return made;
  };
  const indexes = new Map<string, LibraryIndex>();
  const fontDirectory = yield* labelFontDirectory();
  if (fontDirectory === undefined)
    yield* Effect.logWarning(
      "asset library: the label font is missing; contact sheets go unnumbered",
    );

  // A fetch cut short by a crash or a stopped server leaves its scratch behind, and nothing reads it again.
  yield* Effect.promise(async () => {
    for (const name of await NodeFSP.readdir(scratch).catch(() => [] as string[])) {
      const pid = scratchPid(name);
      if (pid === undefined || (pid !== null && pid !== process.pid && alive(pid))) continue;
      await NodeFSP.rm(NodePath.join(scratch, name), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  });

  const fail = (
    operation: string,
    path: string,
    reason: GameOperationError["reason"],
    detail?: string,
    cause?: unknown,
  ) =>
    new GameOperationError({
      operation,
      path,
      reason,
      ...(detail === undefined ? {} : { detail }),
      ...(cause === undefined ? {} : { cause }),
    });
  const io = (operation: string, path: string) => (cause: unknown) =>
    fail(operation, path, "io", undefined, cause);
  const exists = (path: string) =>
    Effect.promise(() =>
      NodeFSP.access(path).then(
        () => true,
        () => false,
      ),
    );

  const packOf = (id: string) => {
    const pack = LIBRARY_CATALOG.find((candidate) => candidate.id === id);
    return pack === undefined
      ? Effect.fail(
          fail(
            "Library",
            id,
            "invalid-input",
            "No library pack has that id. Search without pack to list the packs.",
          ),
        )
      : Effect.succeed(pack);
  };

  const packDir = (pack: LibraryPack) => NodePath.join(directory, "packs", packKey(pack));

  /** Downloads, verifies, unpacks and indexes a pack; runs under that pack's own lock. */
  const fetchPack = (pack: LibraryPack) =>
    Effect.gen(function* () {
      const dir = packDir(pack);
      const memo = indexes.get(pack.id);
      // Another call may have finished this pack while this one waited for the lock.
      if (memo !== undefined && (yield* exists(NodePath.join(dir, "files")))) return memo;
      const saved = yield* Effect.promise(() => readSaved(pack, dir));
      if (saved !== null && (yield* exists(NodePath.join(dir, "files")))) {
        indexes.set(pack.id, saved);
        return saved;
      }
      const archives = NodePath.join(directory, "archives");
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(archives, { recursive: true });
          await NodeFSP.mkdir(scratch, { recursive: true });
        },
        catch: io("Library fetch", directory),
      });
      const archive = NodePath.join(archives, `${pack.id}-${pack.sha256.slice(0, 12)}.zip`);
      if (yield* exists(archive)) {
        const cached = yield* Effect.tryPromise({
          try: () => fileSha256(archive),
          catch: io("Library fetch", archive),
        });
        if (pinProblem(pack, cached) !== null) {
          // Our own copy changed on disk; the pin still names the source's bytes, so fetch them again.
          yield* Effect.logWarning("asset library: cached archive failed its pin; fetching again", {
            pack: pack.id,
          });
          yield* Effect.promise(() => NodeFSP.rm(archive, { force: true }));
        }
      }
      if (!(yield* exists(archive))) {
        const part = NodePath.join(
          scratch,
          `${pack.id}-${process.pid}-${NodeCrypto.randomUUID()}.part`,
        );
        yield* Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: (signal) => downloadPinned(pack, part, signal),
            catch: (cause) =>
              fail(
                "Library fetch",
                pack.download,
                "download",
                `Could not download ${pack.id} (${megabytes(pack.bytes)}) from its source: ${reasonText(cause)}`,
                cause,
              ),
          });
          const fetched = yield* Effect.tryPromise({
            try: () => fileSha256(part),
            catch: io("Library fetch", part),
          });
          const problem = pinProblem(pack, fetched);
          if (problem !== null)
            return yield* fail(
              "Library fetch",
              pack.download,
              "source-changed",
              `${pack.id}: ${problem}`,
            );
          // Renaming over a copy another server just finished is fine: the pin makes them identical.
          yield* Effect.tryPromise({
            try: () => NodeFSP.rename(part, archive),
            catch: io("Library fetch", archive),
          });
        }).pipe(Effect.ensuring(Effect.promise(() => NodeFSP.rm(part, { force: true }))));
      }
      const staging = NodePath.join(
        scratch,
        `${pack.id}-${process.pid}-${NodeCrypto.randomUUID()}`,
      );
      const files = NodePath.join(staging, "files");
      const index = yield* Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => NodeFSP.mkdir(files, { recursive: true }),
          catch: io("Library unpack", staging),
        });
        yield* unpackArchive(archive, files, UNPACK_LIMITS);
        return yield* Effect.tryPromise({
          try: async () => {
            const built = await indexPack(pack, files);
            await NodeFSP.writeFile(NodePath.join(staging, "index.json"), JSON.stringify(built));
            await NodeFSP.mkdir(NodePath.dirname(dir), { recursive: true });
            return await place(pack, staging, dir, built);
          },
          catch: io("Library index", staging),
        });
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(staging, { recursive: true, force: true })),
        ),
      );
      indexes.set(pack.id, index);
      return index;
    });

  /** A known pack answers without any lock; a fetch holds only its own pack's lock. */
  const ensure = (pack: LibraryPack) =>
    Effect.gen(function* () {
      const memo = indexes.get(pack.id);
      if (memo !== undefined) {
        if (yield* exists(NodePath.join(packDir(pack), "files"))) return memo;
        // The cache was cleared while the server ran: fetch again instead of failing until restart.
        indexes.delete(pack.id);
      }
      return yield* fetchPack(pack).pipe(lockOf(pack.id).withPermits(1));
    });

  /**
   * Makes `relative` under the game one real folder at a time and refuses a symbolic link
   * or a file on the way, so nothing is created or written outside the game.
   */
  const realDir = (realRoot: string, relative: string, operation: string) =>
    Effect.gen(function* () {
      const outcome = yield* Effect.tryPromise({
        try: async (): Promise<DirOutcome> => {
          let current = realRoot;
          let walked = "";
          for (const segment of relative.split("/")) {
            walked = walked === "" ? segment : `${walked}/${segment}`;
            current = NodePath.join(current, segment);
            let stat = await NodeFSP.lstat(current).catch(() => null);
            if (stat === null) {
              await NodeFSP.mkdir(current).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "EEXIST") throw error;
              });
              stat = await NodeFSP.lstat(current);
            }
            if (stat.isSymbolicLink()) return { kind: "link", at: walked };
            if (!stat.isDirectory()) return { kind: "file", at: walked };
          }
          return { kind: "dir", path: current };
        },
        catch: io(operation, relative),
      });
      if (outcome.kind === "dir") return outcome.path;
      return yield* outcome.kind === "link"
        ? fail(
            operation,
            outcome.at,
            "symlink",
            `${outcome.at} is a symbolic link; nothing was written through it.`,
          )
        : fail(operation, outcome.at, "invalid-path", `${outcome.at} is a file, not a folder.`);
    });

  const realRootOf = (root: string, operation: string) =>
    Effect.tryPromise({ try: () => NodeFSP.realpath(root), catch: io(operation, root) });

  const cachedIds = Effect.promise(() =>
    NodeFSP.readdir(NodePath.join(directory, "packs")).catch(() => [] as string[]),
  ).pipe(Effect.map((names) => new Set(names)));

  interface Tile {
    /** Drawn large in the cell's corner; the same number as the file's line in the text. */
    readonly number?: number;
    readonly image?: string;
    readonly font?: string;
    readonly small: boolean;
  }

  /** Tiles the images into one numbered PNG with ffmpeg; undefined when nothing has a picture. */
  const contactSheet = (root: string, name: string, tiles: ReadonlyArray<Tile>, big: boolean) =>
    Effect.gen(function* () {
      const drawn = tiles.filter((tile) => tile.image !== undefined || tile.font !== undefined);
      if (drawn.length === 0) return undefined;
      const ffmpeg = yield* Effect.promise(() =>
        GameProcesses.findExecutable("ffmpeg", {
          pathEnv: process.env.PATH,
          override: process.env.KURAMBIT_FFMPEG,
        }),
      );
      if (ffmpeg === null)
        return yield* fail(
          "Library contact sheet",
          "ffmpeg",
          "tool-missing",
          "ffmpeg draws the contact sheet.",
        );
      const size = big ? 480 : 128;
      const columns = Math.min(drawn.length, big ? 2 : 6);
      const args: string[] = ["-hide_banner", "-loglevel", "error", "-y"];
      const graph: string[] = [];
      let input = 0;
      drawn.forEach((tile, i) => {
        const cell = `color=c=0x2b2b33:s=${size}x${size}:d=1`;
        // ffmpeg runs in the font's folder, so the filtergraph names it without escaping a path.
        const number =
          tile.number === undefined || fontDirectory === undefined
            ? ""
            : `,drawtext=fontfile=${LABEL_FONT}:text=${tile.number}:fontsize=${big ? 44 : 26}:fontcolor=white:box=1:boxcolor=0x000000@0.65:boxborderw=4:x=5:y=5`;
        if (tile.image !== undefined) {
          args.push("-i", tile.image);
          const inner = size - 8;
          graph.push(
            `[${input}:v]scale=w=${inner}:h=${inner}:force_original_aspect_ratio=decrease:flags=${tile.small ? "neighbor" : "bicubic"}[s${i}]`,
            `${cell}[b${i}]`,
            `[b${i}][s${i}]overlay=x=(W-w)/2:y=(H-h)/2:format=auto${number}[c${i}]`,
          );
          input += 1;
        } else {
          graph.push(
            `${cell},drawtext=fontfile=${tile.font}:text='Abc 12':fontsize=${Math.round(size / 6)}:fontcolor=white:x=(w-tw)/2:y=(h-th)/2${number}[c${i}]`,
          );
        }
      });
      if (drawn.length === 1) graph.push(`[c0]null[out]`);
      else
        graph.push(
          `${drawn.map((_, i) => `[c${i}]`).join("")}xstack=inputs=${drawn.length}:layout=${drawn
            .map((_, i) => `${(i % columns) * size}_${Math.floor(i / columns) * size}`)
            .join("|")}:fill=0x1b1b20[out]`,
        );
      const realRoot = yield* realRootOf(root, "Library contact sheet");
      const sheets = yield* realDir(realRoot, "builds/library", "Library contact sheet");
      const relative = `builds/library/${name}.png`;
      const output = NodePath.join(sheets, `${name}.png`);
      // ffmpeg -y would write through a link planted at the sheet's own name.
      const present = yield* Effect.promise(() => NodeFSP.lstat(output).catch(() => null));
      if (present !== null && !present.isFile())
        return yield* present.isSymbolicLink()
          ? fail(
              "Library contact sheet",
              relative,
              "symlink",
              `${relative} is a symbolic link; the sheet was not written through it.`,
            )
          : fail("Library contact sheet", relative, "invalid-path", `${relative} is not a file.`);
      const result = yield* processes.run({
        root,
        ...(fontDirectory === undefined ? {} : { cwd: fontDirectory }),
        executable: ffmpeg,
        args: [
          ...args,
          "-filter_complex",
          graph.join(";"),
          "-map",
          "[out]",
          "-frames:v",
          "1",
          output,
        ],
        operation: "library-contact-sheet",
        timeoutMs: 60_000,
        envMode: "replace",
        env: GameProcesses.engineChildEnv(),
      });
      if (result.exitCode !== 0)
        return yield* fail(
          "Library contact sheet",
          output,
          "command-failed",
          result.stderr.slice(0, 1000),
        );
      const png = yield* Effect.tryPromise({
        try: () => NodeFSP.readFile(output),
        catch: io("Library contact sheet", output),
      });
      const rows = Math.ceil(drawn.length / columns);
      return {
        relative,
        numbered: fontDirectory !== undefined,
        screenshot: {
          mimeType: "image/png" as const,
          data: png.toString("base64"),
          width: columns * size,
          height: rows * size,
        },
      };
    });

  const searchPacks = (engine: LibraryEngine, input: GameAssetsSearchInput) =>
    Effect.gen(function* () {
      const words = queryWords(input.query);
      const cached = yield* cachedIds;
      const kind = input.kind;
      const wanted = kind === undefined ? undefined : KIND_MEDIA[kind];
      const fetched = (pack: LibraryPack) => (cached.has(packKey(pack)) ? ", fetched" : "");
      let hidden = 0;
      const ranked = LIBRARY_CATALOG.flatMap((pack, order) => {
        if (kind !== undefined && !pack.kinds.includes(kind)) return [];
        const score =
          2 * matchScore(words, `${pack.id} ${pack.title} ${pack.tags} ${pack.kinds.join(" ")}`) +
          matchScore(words, `${pack.style} ${pack.description}`);
        if (words.length > 0 && score === 0) return [];
        const usable = pack.formats.filter(
          (format) =>
            loadableIn(engine, format) &&
            (wanted === undefined
              ? mediaOf(`x.${format}`) !== "data"
              : mediaOf(`x.${format}`) === wanted),
        );
        if (usable.length === 0) {
          hidden += 1;
          return [];
        }
        return [{ pack, score, order, usable }];
      }).toSorted((a, b) => b.score - a.score || a.order - b.order);
      const hiddenLine =
        hidden > 0 ? [`${hidden} more packs hold no format this ${engine} game loads.`] : [];
      // Browsing: every pack on one short line each, so a style can be chosen from the whole library.
      if (words.length === 0 && kind === undefined)
        return {
          text: [
            `The library's ${ranked.length} CC0 packs this ${engine} game loads (id: style; kinds):`,
            ...ranked.map(
              ({ pack }) => `- ${pack.id}: ${pack.style}; ${pack.kinds.join(", ")}${fetched(pack)}`,
            ),
            ...hiddenLine,
            "Search with words or a kind for each pack's details, or pass pack to look inside one. Every pack is CC0 1.0. Keep one style per game.",
          ].join("\n"),
        };
      const shown = ranked.slice(0, input.limit ?? 8);
      const lines = shown.map(
        ({ pack, usable }) =>
          `- ${pack.id}: ${pack.title} by ${pack.author}. ${pack.description} Style: ${pack.style}. Kinds: ${pack.kinds.join(", ")}. Loads here: ${usable.join(", ")}. ${megabytes(pack.bytes)}${fetched(pack)}.`,
      );
      const text = [
        shown.length === 0
          ? "No library pack matches. Try fewer or broader words, or another kind."
          : `${ranked.length} of ${LIBRARY_CATALOG.length} CC0 library packs match${ranked.length > shown.length ? `; the best ${shown.length}` : ""}:`,
        ...lines,
        ...hiddenLine,
        "Every pack is CC0 1.0 (public domain, no attribution needed). Pass pack to look inside one: it is fetched once, and its files come with a contact sheet to look at. Keep one style per game.",
      ].join("\n");
      return { text };
    });

  const searchFiles = (
    root: string,
    engine: LibraryEngine,
    pack: LibraryPack,
    input: GameAssetsSearchInput,
  ) =>
    Effect.gen(function* () {
      const index = yield* ensure(pack);
      const filesDir = NodePath.join(packDir(pack), "files");
      const words = queryWords(input.query);
      const head = `${pack.id}: ${pack.title} by ${pack.author}, CC0 1.0 (${pack.source}). Style: ${pack.style}.`;
      // Overview: the pack's own pictures and its folders, for choosing what to look at or add whole.
      const overview = (note?: string) =>
        Effect.gen(function* () {
          const folders = new Map<string, Map<string, number>>();
          const pictureOnly = new Map<string, boolean>();
          for (const file of index.files) {
            if (!loadableIn(engine, file.format) || file.media === "data") continue;
            const folder = dirOf(file.path);
            const formats = folders.get(folder) ?? new Map<string, number>();
            formats.set(file.format, (formats.get(file.format) ?? 0) + 1);
            folders.set(folder, formats);
            pictureOnly.set(
              folder,
              (pictureOnly.get(folder) ?? true) && file.previewOf !== undefined,
            );
          }
          const folderLines = [...folders.entries()]
            .slice(0, 30)
            .map(
              ([folder, formats]) =>
                `- ${folder}/ ${[...formats.entries()].map(([format, count]) => `${count} ${format}`).join(", ")}${pictureOnly.get(folder) === true ? " (pictures of the models, to look at; a 3D game adds the models)" : ""}`,
            );
          const pictures = index.previews.slice(0, 2);
          const sheet = yield* contactSheet(
            root,
            `${pack.id}-overview`,
            pictures.map((path, i) => ({
              number: i + 1,
              image: NodePath.join(filesDir, path),
              small: false,
            })),
            true,
          );
          return {
            text: [
              head,
              ...(note === undefined ? [] : [note]),
              sheet === undefined
                ? "The pack ships no overview picture."
                : `Contact sheet ${sheet.relative}: the pack's own overview pictures (${pictures.map((path, i) => `${i + 1} ${path}`).join(", ")}).`,
              `Folders with files this ${engine} game loads:`,
              ...folderLines,
              ...(folders.size > 30 ? [`… and ${folders.size - 30} more folders.`] : []),
              "Search this pack with a query or kind to see files, or add a whole folder with game_assets_add.",
            ].join("\n"),
            ...(sheet === undefined ? {} : { sheet: sheet.relative, screenshot: sheet.screenshot }),
          };
        });
      if (words.length === 0 && input.kind === undefined) return yield* overview();
      const wanted = input.kind === undefined ? undefined : KIND_MEDIA[input.kind];
      let pictures = 0;
      const scored = index.files.flatMap((file) => {
        if (file.media === "data" || !loadableIn(engine, file.format)) return [];
        if (wanted !== undefined && file.media !== wanted) return [];
        const score = matchScore(words, file.path);
        if (words.length > 0 && score === 0) return [];
        // A render of a model is how that model is shown, not a sprite to add, unless images were asked for.
        if (wanted === undefined && file.previewOf !== undefined) {
          pictures += 1;
          return [];
        }
        return [{ file, score }];
      });
      // Kenney ships each model in several formats: show the one this engine prefers.
      const best = new Map<string, { file: LibraryFile; score: number }>();
      const rest: Array<{ file: LibraryFile; score: number }> = [];
      for (const hit of scored) {
        if (hit.file.media !== "model") {
          rest.push(hit);
          continue;
        }
        const key = stemOf(hit.file.path);
        const prior = best.get(key);
        if (
          prior === undefined ||
          modelRank(engine, hit.file.format) < modelRank(engine, prior.file.format)
        )
          best.set(key, hit);
      }
      const ranked = [...rest, ...best.values()].toSorted(
        (a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path),
      );
      const offset = input.offset ?? 0;
      const shown = ranked.slice(offset, offset + (input.limit ?? PAGE));
      if (shown.length === 0 && ranked.length > 0)
        return {
          text: `${head}\n${ranked.length} files match, so offset ${offset} is past the end. Pass a smaller offset.`,
        };
      // Packs often number their files (tile_0042.png), so a missed word still deserves the pictures.
      if (shown.length === 0)
        return yield* overview(
          `No file name here matches that${input.kind === undefined ? "" : ` as ${input.kind}`} for a ${engine} game; names in this pack may be numbered, so here is its overview instead.`,
        );
      const tiles: Tile[] = shown.map(({ file }, i) => {
        const number = offset + i + 1;
        if (file.media === "font") {
          const path = NodePath.join(filesDir, file.path);
          return plainPath(path) ? { number, font: path, small: false } : { number, small: false };
        }
        const picture =
          file.media === "image" && file.format !== "svg"
            ? file.path
            : file.media === "model"
              ? file.preview
              : undefined;
        if (picture === undefined) return { number, small: false };
        const info = index.files.find((other) => other.path === picture);
        return {
          number,
          image: NodePath.join(filesDir, picture),
          small: info?.width !== undefined && Math.max(info.width, info.height ?? 0) <= 64,
        };
      });
      // Models without their own picture still get the pack's overview, so the style can be judged.
      const unpictured = shown.some(
        ({ file }) => file.media === "model" && file.preview === undefined,
      );
      const packPicture = unpictured ? index.previews[0] : undefined;
      if (packPicture !== undefined)
        tiles.push({ image: NodePath.join(filesDir, packPicture), small: false });
      const pictured = tiles
        .slice(0, shown.length)
        .filter((tile) => tile.image !== undefined || tile.font !== undefined).length;
      const sheet = yield* contactSheet(
        root,
        `${pack.id}-${NodeCrypto.createHash("sha256")
          .update(`${input.query ?? ""}|${input.kind ?? ""}|${input.limit ?? ""}|${offset}`)
          .digest("hex")
          .slice(0, 8)}`,
        tiles,
        // Only the pack's picture: draw it large enough to judge the style.
        pictured === 0,
      );
      const audio = shown.every(({ file }) => file.media === "audio");
      const lines = shown.map(
        ({ file }, i) => `${offset + i + 1}. ${file.path} (${describe(file)})`,
      );
      const end = offset + shown.length;
      const numbering =
        sheet?.numbered === true
          ? "numbered like the list"
          : "in list order, left to right, unnumbered";
      return {
        text: [
          head,
          ranked.length > shown.length
            ? `${ranked.length} files match; showing ${offset + 1}–${end} of ${ranked.length}${end < ranked.length ? ` (pass offset ${end} for more)` : ""}:`
            : `${ranked.length} files match:`,
          ...lines,
          ...(pictures > 0
            ? [
                `${pictures} pictures of the models are not listed as files; pass kind sprite to list them as images.`,
              ]
            : []),
          sheet === undefined
            ? audio
              ? "Audio has no picture; pick by name and length."
              : "No picture: these files ship no preview image."
            : pictured === 0
              ? `These files have no picture of their own; contact sheet ${sheet.relative} shows the pack's own preview (${packPicture}). Look at it before adding.`
              : `Contact sheet ${sheet.relative} shows ${pictured} of them, ${numbering}${pictured < shown.length ? "; the rest have no picture of their own" : ""}${packPicture === undefined ? "" : `, then, unnumbered, the pack's own preview (${packPicture})`}. Look at it before adding.`,
          "Add files or a whole folder with game_assets_add, by the exact paths above.",
        ].join("\n"),
        ...(sheet === undefined ? {} : { sheet: sheet.relative, screenshot: sheet.screenshot }),
      };
    });

  const search = (root: string, input: GameAssetsSearchInput) =>
    Effect.gen(function* () {
      const manifest = yield* projects.read(root);
      const engine = engineOf(manifest.engine.name);
      if (input.pack === undefined) return yield* searchPacks(engine, input);
      return yield* searchFiles(root, engine, yield* packOf(input.pack), input);
    });

  const add = (root: string, input: GameAssetsAddInput) =>
    Effect.gen(function* () {
      const manifest = yield* projects.read(root);
      const engine = engineOf(manifest.engine.name);
      const pack = yield* packOf(input.pack);
      const index = yield* ensure(pack);
      const byPath = new Map(index.files.map((file) => [file.path, file]));
      const folderNames = new Set<string>();
      for (const file of index.files)
        for (let folder = dirOf(file.path); folder !== "."; folder = dirOf(folder))
          folderNames.add(folder);
      const byLower = new Map<string, string[]>();
      for (const path of [...byPath.keys(), ...folderNames])
        byLower.set(path.toLowerCase(), [...(byLower.get(path.toLowerCase()) ?? []), path]);
      const loadedByModels = new Set(index.files.flatMap((file) => file.deps ?? []));
      const filesDir = NodePath.join(packDir(pack), "files");
      const skipped: string[] = [];
      const notes: string[] = [];
      const chosen = new Map<string, LibraryFile>();
      /** Copied as a group into one folder, so ASSETS.md can name them with one glob. */
      const folders = new Set<string>();
      const take = (file: LibraryFile) => {
        if (!loadableIn(engine, file.format)) {
          skipped.push(`${file.path}: ${file.format} does not load in this ${engine} game`);
          return;
        }
        chosen.set(file.path, file);
        for (const dep of file.deps ?? []) {
          const depFile = byPath.get(dep);
          if (depFile !== undefined && loadableIn(engine, depFile.format)) chosen.set(dep, depFile);
        }
      };
      /** Every file the named folders hold, picked from together once all paths are read. */
      const folderFiles = new Map<string, LibraryFile>();
      const takeFolder = (raw: string, folder: string) => {
        const inside = index.files.filter(
          (file) => file.path.startsWith(`${folder}/`) && loadableIn(engine, file.format),
        );
        if (inside.length === 0) {
          skipped.push(`${raw}: no files in that folder load in this ${engine} game`);
          return;
        }
        folders.add(folder);
        for (const file of inside) folderFiles.set(file.path, file);
      };
      for (const raw of input.paths) {
        const path = raw.trim().replace(/^\.\//, "").replace(/\/+$/, "");
        if (path === "" || path === ".") {
          skipped.push(`${raw}: name a file or folder inside the pack`);
          continue;
        }
        const exact = byPath.get(path);
        if (exact !== undefined) {
          take(exact);
          continue;
        }
        if (folderNames.has(path)) {
          takeFolder(raw, path);
          continue;
        }
        // Names get retyped from a sheet or a list; a single match ignoring case is the one meant.
        const loose = byLower.get(path.toLowerCase()) ?? [];
        const match = loose[0];
        if (loose.length === 1 && match !== undefined) {
          notes.push(`${raw} is ${match} (matched ignoring case).`);
          const file = byPath.get(match);
          if (file !== undefined) take(file);
          else takeFolder(raw, match);
          continue;
        }
        skipped.push(
          loose.length > 1
            ? `${raw}: matches ${loose.join(", ")} ignoring case; name one exactly`
            : `${raw}: no such file or folder in ${pack.id}`,
        );
      }
      // One format per model across the folders, the one search shows; textures come with the models that load them.
      const bestFormat = new Map<string, LibraryFile["format"]>();
      for (const file of folderFiles.values()) {
        if (file.media !== "model") continue;
        const prior = bestFormat.get(stemOf(file.path));
        if (prior === undefined || modelRank(engine, file.format) < modelRank(engine, prior))
          bestFormat.set(stemOf(file.path), file.format);
      }
      let models = 0;
      let otherFormats = 0;
      for (const file of folderFiles.values()) {
        if (file.media === "model") {
          if (bestFormat.get(stemOf(file.path)) === file.format) {
            take(file);
            models += 1;
          } else otherFormats += 1;
        } else if (bestFormat.size === 0 || !loadedByModels.has(file.path)) take(file);
      }
      if (otherFormats > 0)
        notes.push(
          `${models} models, one format each (${[...new Set(bestFormat.values())].join(", ")}); ${otherFormats} copies in other formats left out.`,
        );
      // A licence note travels with the files it covers: the pack's own, or one kept in their folder.
      const picked = [...chosen.values()];
      if (picked.length > 0)
        for (const file of index.files) {
          const folder = dirOf(file.path);
          if (
            file.media === "data" &&
            /licen[cs]e/i.test(nameOf(file.path)) &&
            (folder === "." || picked.some((other) => other.path.startsWith(`${folder}/`)))
          )
            chosen.set(file.path, file);
        }
      const total = [...chosen.values()].reduce((sum, file) => sum + file.bytes, 0);
      if (chosen.size > MAX_ADD_FILES || total > MAX_ADD_BYTES)
        return yield* fail(
          "Library add",
          pack.id,
          "invalid-input",
          `That selection is ${chosen.size} files and ${megabytes(total)}; one add takes at most ${MAX_ADD_FILES} files and ${megabytes(MAX_ADD_BYTES)}. Add fewer folders.`,
        );
      if (picked.some((file) => file.media === "model") && total > MAX_MODEL_ADD_BYTES)
        return yield* fail(
          "Library add",
          pack.id,
          "invalid-input",
          `That selection holds models and comes to ${megabytes(total)} with what they load; one add of models takes at most ${megabytes(MAX_MODEL_ADD_BYTES)}, already more than a game loads well. Add the models the game uses by path, or a smaller folder.`,
        );

      const lane = manifest.godotProject;
      const directoryRel = libraryDirFor(lane, pack.id);
      const realRoot = yield* realRootOf(root, "Library add");
      // Checked before any copy, so a refusal leaves the game as it was.
      const assetsPath = NodePath.join(realRoot, "ASSETS.md");
      const assetsStat = yield* Effect.promise(() => NodeFSP.lstat(assetsPath).catch(() => null));
      if (assetsStat !== null && !assetsStat.isFile())
        return yield* assetsStat.isSymbolicLink()
          ? fail(
              "Library add",
              "ASSETS.md",
              "symlink",
              "ASSETS.md is a symbolic link; the library writes credits only into a real ASSETS.md in the game.",
            )
          : fail("Library add", "ASSETS.md", "invalid-path", "ASSETS.md is not a file.");
      const added: string[] = [];
      const present: string[] = [];
      const targets = new Set<string>();
      const dirs = new Map<string, string>();
      for (const file of chosen.values()) {
        const relative = `${directoryRel}/${safePath(file.path)}`;
        if (targets.has(relative)) {
          skipped.push(`${file.path}: its game-safe name collides with another file in this add`);
          continue;
        }
        targets.add(relative);
        const parentRel = dirOf(relative);
        const parent = dirs.get(parentRel) ?? (yield* realDir(realRoot, parentRel, "Library add"));
        dirs.set(parentRel, parent);
        const destination = NodePath.join(parent, nameOf(relative));
        const outcome = yield* Effect.tryPromise({
          try: async () => {
            const there = await NodeFSP.lstat(destination).catch(() => null);
            const source = NodePath.join(filesDir, file.path);
            if (there !== null) {
              if (there.isSymbolicLink()) return "link" as const;
              if (!there.isFile()) return "occupied" as const;
              const [mine, theirs] = await Promise.all([
                fileSha256(source),
                fileSha256(destination),
              ]);
              return mine.sha256 === theirs.sha256 ? ("same" as const) : ("occupied" as const);
            }
            await NodeFSP.copyFile(source, destination, NodeFSP.constants.COPYFILE_EXCL);
            return "copied" as const;
          },
          catch: io("Library add", relative),
        });
        if (outcome === "link")
          skipped.push(`${relative}: a symbolic link is there; it was not followed or replaced`);
        else if (outcome === "occupied")
          skipped.push(`${relative}: a different file is already there; it was not overwritten`);
        else if (outcome === "same") present.push(relative);
        else added.push(relative);
      }

      // Provenance for every file now in place, new or already there, so a rewritten ASSETS.md gets its lines back.
      const current =
        assetsStat === null
          ? ""
          : yield* Effect.tryPromise({
              try: () => NodeFSP.readFile(assetsPath, "utf8"),
              catch: io("Library add", "ASSETS.md"),
            });
      const credit = `library pack ${pack.id} (${pack.source}), CC0 1.0`;
      const grouped = new Map<string, string[]>();
      const single: string[] = [];
      for (const relative of [...added, ...present]) {
        // Licence notes travel with the files but are not assets to map.
        if (mediaOf(relative) === "data") continue;
        const original = relative.slice(directoryRel.length + 1);
        const fromFolder = [...folders].some((folder) =>
          original.startsWith(`${safePath(folder)}/`),
        );
        if (!fromFolder) {
          single.push(relative);
          continue;
        }
        const key = `${dirOf(relative)}/*.${relative.slice(relative.lastIndexOf(".") + 1)}`;
        grouped.set(key, [...(grouped.get(key) ?? []), relative]);
      }
      for (const [glob, members] of grouped)
        if (members.length < 4) single.push(...members);
        else single.push(glob);
      const lines = single
        .filter((path) => !current.includes(`\`${path}\``))
        .toSorted()
        .map((path) => `- \`${path}\` — ${credit}`);
      if (lines.length > 0) {
        const header = current.includes(`## Library: ${pack.title} (${pack.id})`)
          ? ""
          : `\n## Library: ${pack.title} (${pack.id})\n\n${pack.title} by ${pack.author}, ${pack.source}. CC0 1.0 (public domain): ${pack.licenceEvidence}. Pinned download sha256 ${pack.sha256}.\n\n`;
        const prefix = current.length === 0 ? "# ASSETS\n" : current.endsWith("\n") ? "" : "\n";
        yield* Effect.tryPromise({
          try: async () => {
            // O_NOFOLLOW: a link planted after the check above is refused, not written through.
            const handle = await NodeFSP.open(
              assetsPath,
              NodeFSP.constants.O_WRONLY |
                NodeFSP.constants.O_APPEND |
                NodeFSP.constants.O_CREAT |
                (NodeFSP.constants.O_NOFOLLOW ?? 0),
              0o644,
            );
            try {
              await handle.appendFile(`${prefix}${header}${lines.join("\n")}\n`);
            } finally {
              await handle.close();
            }
          },
          catch: io("Library add", "ASSETS.md"),
        });
      }
      const loadPath =
        lane === "godot"
          ? `res://${directoryRel.slice("godot/".length)}/…`
          : lane === "web"
            ? `./${directoryRel.slice("web/".length)}/…`
            : `Assets/${directoryRel.slice("unity/Assets/".length)}/…`;
      const credited = single.length;
      const assetsLine =
        lines.length > 0
          ? `${assetsStat === null ? "There was no ASSETS.md; it now exists and credits" : "ASSETS.md now credits"} them (add what each depicts and where the game loads it):`
          : credited > 0
            ? "ASSETS.md already credits them."
            : assetsStat === null
              ? "No ASSETS.md, and nothing here to credit."
              : "Nothing here to credit in ASSETS.md.";
      const text = [
        `Added ${added.length} file${added.length === 1 ? "" : "s"} from ${pack.id} under ${directoryRel}${present.length > 0 ? ` (${present.length} already there, unchanged)` : ""}. The game loads them as ${loadPath}.`,
        ...(added.length > 0 && added.length <= 20 ? added.map((path) => `- ${path}`) : []),
        ...notes,
        ...(skipped.length > 0
          ? ["Skipped:", ...skipped.slice(0, 20).map((line) => `- ${line}`)]
          : []),
        ...(skipped.length > 20 ? [`… and ${skipped.length - 20} more skipped.`] : []),
        assetsLine,
        ...lines.slice(0, 12),
        ...(lines.length > 12 ? [`… and ${lines.length - 12} more lines.`] : []),
        "Run game_import, then game_check.",
      ].join("\n");
      return { text, directory: directoryRel, added: added.length };
    });

  return GameAssetLibrary.of({ search, add });
});

export const layer = Layer.effect(GameAssetLibrary, make);
