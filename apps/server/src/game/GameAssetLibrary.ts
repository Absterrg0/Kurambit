// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- This service owns the library cache and copies files into game folders; index.json is its own cache file, rebuilt when it does not match the pin.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import { isPathInside } from "./gameNativeUserDir.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { toolsDirectory } from "./GameToolchain.ts";
import { laneAssets } from "./run/roles.ts";

/** Beside the pinned tools, shared by every game on this machine. */
const libraryDirectory = () => NodePath.join(NodePath.dirname(toolsDirectory()), "asset-library");

const LABEL_FONT_PACK = "kenney-fonts";
const LABEL_FONT = "kenvector_future.ttf";
const MAX_ADD_FILES = 3000;
const MAX_ADD_BYTES = 300 * 1024 * 1024;

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
  if (file.seconds !== undefined) parts.push(`${file.seconds} s`);
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
const libraryDirFor = (lane: string, pack: string) =>
  `${laneAssets(lane)}/${lane === "unity" ? "Library" : "library"}/${pack}`;

const make = Effect.gen(function* () {
  const processes = yield* GameProcesses.GameProcesses;
  const projects = yield* GameProjectService.GameProjectService;
  const directory = libraryDirectory();
  const fetchLock = yield* Semaphore.make(1);
  const indexes = new Map<string, LibraryIndex>();

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

  const packDir = (pack: LibraryPack) =>
    NodePath.join(directory, "packs", `${pack.id}-${pack.sha256.slice(0, 12)}`);

  /** Downloads, verifies, unpacks and indexes a pack once; later calls read the saved index. */
  const ensure = (pack: LibraryPack) =>
    Effect.gen(function* () {
      const memo = indexes.get(pack.id);
      if (memo !== undefined) return memo;
      const dir = packDir(pack);
      const indexPath = NodePath.join(dir, "index.json");
      const saved = yield* Effect.promise(() =>
        NodeFSP.readFile(indexPath, "utf8").then(
          (text) => JSON.parse(text) as LibraryIndex,
          () => null,
        ),
      );
      if (saved?.version === 1 && saved.sha256 === pack.sha256 && Array.isArray(saved.files)) {
        indexes.set(pack.id, saved);
        return saved;
      }
      const archives = NodePath.join(directory, "archives");
      const scratch = NodePath.join(directory, "tmp");
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
        const part = NodePath.join(scratch, `${pack.id}-${NodeCrypto.randomUUID()}.part`);
        yield* Effect.tryPromise({
          try: (signal) => downloadPinned(pack, part, signal),
          catch: (cause) =>
            fail(
              "Library fetch",
              pack.download,
              "download",
              `Could not download ${pack.id} (${megabytes(pack.bytes)}) from its source.`,
              cause,
            ),
        }).pipe(Effect.tapError(() => Effect.promise(() => NodeFSP.rm(part, { force: true }))));
        const fetched = yield* Effect.tryPromise({
          try: () => fileSha256(part),
          catch: io("Library fetch", part),
        });
        const problem = pinProblem(pack, fetched);
        if (problem !== null) {
          yield* Effect.promise(() => NodeFSP.rm(part, { force: true }));
          return yield* fail(
            "Library fetch",
            pack.download,
            "source-changed",
            `${pack.id}: ${problem}`,
          );
        }
        yield* Effect.tryPromise({
          try: () => NodeFSP.rename(part, archive),
          catch: io("Library fetch", archive),
        });
      }
      const staging = NodePath.join(scratch, `${pack.id}-${NodeCrypto.randomUUID()}`);
      const files = NodePath.join(staging, "files");
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(files, { recursive: true }),
        catch: io("Library unpack", staging),
      });
      const index = yield* unpackArchive(archive, files, UNPACK_LIMITS).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: async () => {
              const built = await indexPack(pack, files);
              await NodeFSP.writeFile(NodePath.join(staging, "index.json"), JSON.stringify(built));
              await NodeFSP.rm(dir, { recursive: true, force: true });
              await NodeFSP.mkdir(NodePath.dirname(dir), { recursive: true });
              await NodeFSP.rename(staging, dir);
              return built;
            },
            catch: io("Library index", staging),
          }),
        ),
        Effect.tapError(() =>
          Effect.promise(() => NodeFSP.rm(staging, { recursive: true, force: true })),
        ),
      );
      indexes.set(pack.id, index);
      return index;
    }).pipe(fetchLock.withPermits(1));

  const cachedIds = Effect.promise(() =>
    NodeFSP.readdir(NodePath.join(directory, "packs")).catch(() => [] as string[]),
  ).pipe(Effect.map((names) => new Set(names)));

  interface Tile {
    readonly label: string;
    readonly image?: string;
    readonly font?: string;
    readonly small: boolean;
  }

  const labelFont = Effect.gen(function* () {
    const pack = LIBRARY_CATALOG.find((candidate) => candidate.id === LABEL_FONT_PACK);
    if (pack === undefined) return undefined;
    const path = NodePath.join(packDir(pack), "files", LABEL_FONT);
    const fetched = yield* ensure(pack).pipe(Effect.option);
    return Option.isSome(fetched) && plainPath(path) && (yield* exists(path)) ? path : undefined;
  });

  /** Tiles the images into one labelled PNG with ffmpeg; undefined when nothing has a picture. */
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
      const font = yield* labelFont;
      const size = big ? 480 : 128;
      const label = big ? 22 : 18;
      const columns = Math.min(drawn.length, big ? 2 : 6);
      const args: string[] = ["-hide_banner", "-loglevel", "error", "-y"];
      const graph: string[] = [];
      let input = 0;
      drawn.forEach((tile, i) => {
        const cell = `color=c=0x2b2b33:s=${size}x${size + label}:d=1`;
        const text =
          font === undefined
            ? ""
            : `,drawtext=fontfile=${font}:text='${tile.label.replace(/[^A-Za-z0-9 ._-]/g, "")}':fontsize=${big ? 14 : 10}:fontcolor=0xe8e8e8:x=4:y=${size + 4}`;
        if (tile.image !== undefined) {
          args.push("-i", tile.image);
          const inner = size - 8;
          graph.push(
            `[${input}:v]scale=w=${inner}:h=${inner}:force_original_aspect_ratio=decrease:flags=${tile.small ? "neighbor" : "bicubic"}[s${i}]`,
            `${cell}[b${i}]`,
            `[b${i}][s${i}]overlay=x=(W-w)/2:y=(${size}-h)/2:format=auto${text}[c${i}]`,
          );
          input += 1;
        } else {
          graph.push(
            `${cell},drawtext=fontfile=${tile.font}:text='Abc 12':fontsize=${Math.round(size / 8)}:fontcolor=white:x=(w-tw)/2:y=(${size}-th)/2${text}[c${i}]`,
          );
        }
      });
      const width = size;
      const height = size + label;
      if (drawn.length === 1) graph.push(`[c0]null[out]`);
      else
        graph.push(
          `${drawn.map((_, i) => `[c${i}]`).join("")}xstack=inputs=${drawn.length}:layout=${drawn
            .map((_, i) => `${(i % columns) * width}_${Math.floor(i / columns) * height}`)
            .join("|")}:fill=0x1b1b20[out]`,
        );
      const sheets = NodePath.join(root, "builds/library");
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(sheets, { recursive: true }),
        catch: io("Library contact sheet", sheets),
      });
      const relative = `builds/library/${name}.png`;
      const output = NodePath.join(root, relative);
      const result = yield* processes.run({
        root,
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
        screenshot: {
          mimeType: "image/png" as const,
          data: png.toString("base64"),
          width: columns * width,
          height: rows * height,
        },
      };
    });

  const searchPacks = (engine: LibraryEngine, input: GameAssetsSearchInput) =>
    Effect.gen(function* () {
      const words = queryWords(input.query);
      const cached = yield* cachedIds;
      const kind = input.kind;
      const wanted = kind === undefined ? undefined : KIND_MEDIA[kind];
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
      const shown = ranked.slice(0, input.limit ?? 8);
      const lines = shown.map(
        ({ pack, usable }) =>
          `- ${pack.id}: ${pack.title} by ${pack.author}. ${pack.description} Style: ${pack.style}. Kinds: ${pack.kinds.join(", ")}. Loads here: ${usable.join(", ")}. ${megabytes(pack.bytes)}${cached.has(`${pack.id}-${pack.sha256.slice(0, 12)}`) ? ", fetched" : ""}.`,
      );
      const text = [
        shown.length === 0
          ? "No library pack matches. Try fewer or broader words, or another kind."
          : `${ranked.length} of ${LIBRARY_CATALOG.length} CC0 library packs match${ranked.length > shown.length ? `; the best ${shown.length}` : ""}:`,
        ...lines,
        ...(hidden > 0
          ? [`${hidden} more matching packs hold no format this ${engine} game loads.`]
          : []),
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
          for (const file of index.files) {
            if (!loadableIn(engine, file.format) || file.media === "data") continue;
            const formats = folders.get(dirOf(file.path)) ?? new Map<string, number>();
            formats.set(file.format, (formats.get(file.format) ?? 0) + 1);
            folders.set(dirOf(file.path), formats);
          }
          const folderLines = [...folders.entries()]
            .slice(0, 30)
            .map(
              ([folder, formats]) =>
                `- ${folder}/ ${[...formats.entries()].map(([format, count]) => `${count} ${format}`).join(", ")}`,
            );
          const sheet = yield* contactSheet(
            root,
            `${pack.id}-overview`,
            index.previews.slice(0, 2).map((path) => ({
              label: nameOf(path),
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
                : `Contact sheet ${sheet.relative}: the pack's own overview pictures (${index.previews.slice(0, 2).join(", ")}).`,
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
      const scored = index.files.flatMap((file) => {
        if (file.media === "data" || !loadableIn(engine, file.format)) return [];
        if (wanted !== undefined && file.media !== wanted) return [];
        const score = matchScore(words, file.path);
        return words.length > 0 && score === 0 ? [] : [{ file, score }];
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
      const shown = ranked.slice(0, input.limit ?? 12);
      // Packs often number their files (tile_0042.png), so a missed word still deserves the pictures.
      if (shown.length === 0)
        return yield* overview(
          `No file name here matches that${input.kind === undefined ? "" : ` as ${input.kind}`} for a ${engine} game; names in this pack may be numbered, so here is its overview instead.`,
        );
      const tiles: Tile[] = shown.map(({ file }, i) => {
        const label = `${i + 1} ${stemOf(file.path).slice(0, 15)}`;
        if (file.media === "font") {
          const path = NodePath.join(filesDir, file.path);
          return plainPath(path) ? { label, font: path, small: false } : { label, small: false };
        }
        const picture =
          file.media === "image" && file.format !== "svg"
            ? file.path
            : file.media === "model"
              ? file.preview
              : undefined;
        if (picture === undefined) return { label, small: false };
        const info = index.files.find((other) => other.path === picture);
        return {
          label,
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
        tiles.push({
          label: "pack preview",
          image: NodePath.join(filesDir, packPicture),
          small: false,
        });
      const pictured = tiles
        .slice(0, shown.length)
        .filter((tile) => tile.image !== undefined || tile.font !== undefined).length;
      const sheet = yield* contactSheet(
        root,
        `${pack.id}-${NodeCrypto.createHash("sha256")
          .update(`${input.query ?? ""}|${input.kind ?? ""}|${input.limit ?? ""}`)
          .digest("hex")
          .slice(0, 8)}`,
        tiles,
        // Only the pack's picture: draw it large enough to judge the style.
        pictured === 0,
      );
      const audio = shown.every(({ file }) => file.media === "audio");
      const lines = shown.map(({ file }, i) => `${i + 1}. ${file.path} (${describe(file)})`);
      return {
        text: [
          head,
          `${ranked.length} files match${ranked.length > shown.length ? `; the first ${shown.length}` : ""}:`,
          ...lines,
          sheet === undefined
            ? audio
              ? "Audio has no picture; pick by name and length."
              : "No picture: these files ship no preview image."
            : pictured === 0
              ? `These files have no picture of their own; contact sheet ${sheet.relative} shows the pack's own preview (${packPicture}). Look at it before adding.`
              : `Contact sheet ${sheet.relative} shows ${pictured} of them, labelled by number${pictured < shown.length ? "; the rest have no picture of their own" : ""}${packPicture === undefined ? "" : `, then the pack's own preview (${packPicture})`}. Look at it before adding.`,
          "Add files or a whole folder with game_assets_add.",
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
      const filesDir = NodePath.join(packDir(pack), "files");
      const skipped: string[] = [];
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
        const inside = index.files.filter(
          (file) => file.path.startsWith(`${path}/`) && loadableIn(engine, file.format),
        );
        if (inside.length === 0) {
          skipped.push(`${raw}: no such file or folder with files this ${engine} game loads`);
          continue;
        }
        folders.add(path);
        for (const file of inside) take(file);
      }
      // The pack's own licence note travels with its files.
      for (const file of index.files)
        if (file.media === "data" && !file.path.includes("/") && /licen[cs]e/i.test(file.path))
          chosen.set(file.path, file);
      const total = [...chosen.values()].reduce((sum, file) => sum + file.bytes, 0);
      if (chosen.size > MAX_ADD_FILES || total > MAX_ADD_BYTES)
        return yield* fail(
          "Library add",
          pack.id,
          "invalid-input",
          `That selection is ${chosen.size} files and ${megabytes(total)}; one add takes at most ${MAX_ADD_FILES} files and ${megabytes(MAX_ADD_BYTES)}. Add fewer folders.`,
        );

      const lane = manifest.godotProject;
      const directoryRel = libraryDirFor(lane, pack.id);
      const realRoot = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(root),
        catch: io("Library add", root),
      });
      const added: string[] = [];
      let already = 0;
      const targets = new Set<string>();
      for (const file of chosen.values()) {
        const relative = `${directoryRel}/${safePath(file.path)}`;
        if (targets.has(relative)) {
          skipped.push(`${file.path}: its game-safe name collides with another file in this add`);
          continue;
        }
        targets.add(relative);
        const destination = NodePath.join(root, relative);
        const outcome = yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
            // A symlinked folder on the way must not carry the copy out of the game.
            if (!isPathInside(await NodeFSP.realpath(NodePath.dirname(destination)), realRoot))
              return "outside" as const;
            const present = await NodeFSP.lstat(destination).catch(() => null);
            const source = NodePath.join(filesDir, file.path);
            if (present !== null) {
              if (!present.isFile()) return "occupied" as const;
              const [mine, theirs] = await Promise.all([
                fileSha256(source),
                fileSha256(destination),
              ]);
              return mine.sha256 === theirs.sha256 ? ("same" as const) : ("occupied" as const);
            }
            await NodeFSP.copyFile(source, destination, NodeFSP.constants.COPYFILE_EXCL);
            return "copied" as const;
          },
          catch: io("Library add", destination),
        });
        if (outcome === "outside")
          return yield* fail(
            "Library add",
            relative,
            "invalid-path",
            "The library folder resolves outside the game.",
          );
        if (outcome === "occupied")
          skipped.push(`${relative}: a different file is already there; it was not overwritten`);
        else if (outcome === "same") already += 1;
        else added.push(relative);
      }

      // Provenance: one line per file, or one glob per folder and format for a whole-folder add.
      const assetsPath = NodePath.join(root, "ASSETS.md");
      const current = yield* Effect.promise(() =>
        NodeFSP.readFile(assetsPath, "utf8").catch(() => ""),
      );
      const credit = `library pack ${pack.id} (${pack.source}), CC0 1.0`;
      const grouped = new Map<string, string[]>();
      const single: string[] = [];
      for (const relative of added) {
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
          try: () => NodeFSP.appendFile(assetsPath, `${prefix}${header}${lines.join("\n")}\n`),
          catch: io("Library add", assetsPath),
        });
      }
      const loadPath =
        lane === "godot"
          ? `res://${directoryRel.slice("godot/".length)}/…`
          : lane === "web"
            ? `./${directoryRel.slice("web/".length)}/…`
            : `Assets/${directoryRel.slice("unity/Assets/".length)}/…`;
      const text = [
        `Added ${added.length} file${added.length === 1 ? "" : "s"} from ${pack.id} under ${directoryRel}${already > 0 ? ` (${already} already there, unchanged)` : ""}. The game loads them as ${loadPath}.`,
        ...(added.length > 0 && added.length <= 20 ? added.map((path) => `- ${path}`) : []),
        ...(skipped.length > 0
          ? ["Skipped:", ...skipped.slice(0, 20).map((line) => `- ${line}`)]
          : []),
        ...(skipped.length > 20 ? [`… and ${skipped.length - 20} more skipped.`] : []),
        lines.length > 0
          ? "ASSETS.md now credits them; add what each depicts and where the game loads it."
          : "ASSETS.md already credits them.",
        "Run game_import, then game_check.",
      ].join("\n");
      return { text, directory: directoryRel, added: added.length };
    });

  return GameAssetLibrary.of({ search, add });
});

export const layer = Layer.effect(GameAssetLibrary, make);
