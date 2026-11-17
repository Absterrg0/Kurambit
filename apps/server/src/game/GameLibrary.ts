// @effect-diagnostics nodeBuiltinImport:off -- Reads every game's art files and the home's library folder, and copies one into a game.
// The Library: every asset the person has, in one place. Each game's art is the Art tab's own
// listing (artAssets.ts, its hashes cached by content), joined by content so a file in three
// games is one item. Models saved from a game live in the home's library folder as a GLB with
// its picture and a sidecar naming where it came from. Packs are the pinned open library's,
// and looks are each game's STYLE.json. Adding an item copies it into a game, credited in
// ASSETS.md, as a build Undo takes back.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  GAME_STYLE_FILE,
  GameOperationError,
  GameStyle,
  isAvailableEngine,
  manifestProject,
  type GameArtAsset,
  type GameLibraryAddInput,
  type GameLibraryAddResult,
  type GameLibraryItem,
  type GameLibraryListResult,
  type GameLibrarySaveInput,
  type GameLibrarySaveResult,
  type GameLibraryUse,
  type ProjectId,
  type ThreadId,
} from "@kurambit/contracts";
import * as ServerConfig from "../config.ts";
import { assetLines, listArtAssets } from "./artAssets.ts";
import { gltfTriangles } from "./assetFacts.ts";
import { LIBRARY_CATALOG } from "./assetLibraryCatalog.ts";
import { LIBRARY_LICENCES } from "./assetLibraryFiles.ts";
import { cachedPackFolder } from "./GameAssetLibrary.ts";
import * as GameBuilds from "./GameBuilds.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { gamePaths } from "./engineProfile.ts";
import { fileSha256 } from "./fileHash.ts";
import { readGltfJson } from "./gltfJson.ts";

export class GameLibrary extends Context.Service<
  GameLibrary,
  {
    readonly list: Effect.Effect<GameLibraryListResult, GameOperationError>;
    /** Copies an item into the chat's game, credited, as a build; a look replaces its STYLE.json. */
    readonly add: (
      input: GameLibraryAddInput,
    ) => Effect.Effect<GameLibraryAddResult, GameOperationError>;
    readonly save: (
      input: GameLibrarySaveInput,
    ) => Effect.Effect<GameLibrarySaveResult, GameOperationError>;
    /** Removes a saved model from the library; the games it was added to keep their copies. */
    readonly remove: (id: string) => Effect.Effect<void, GameOperationError>;
  }
>()("kurambit/game/GameLibrary") {}

const MAX_SAVED = 500;
const MAX_GLTF_JSON = 8 * 1024 * 1024;

/** A saved model's record beside its GLB. */
const SavedSidecar = Schema.Struct({
  name: Schema.String,
  game: Schema.String,
  projectId: Schema.String,
  part: Schema.String,
  savedAt: Schema.String,
});
const decodeSidecar = Schema.decodeUnknownOption(Schema.fromJsonString(SavedSidecar));
const decodeStyle = Schema.decodeUnknownOption(Schema.fromJsonString(GameStyle));

const slash = (path: string) => path.split(NodePath.sep).join("/");
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const stem = (path: string) => baseName(path).replace(/\.[^.]+$/, "");
const exists = (path: string) =>
  NodeFSP.stat(path).then(
    () => true,
    () => false,
  );
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "model";

/** The game-relative folder a kind of file goes in when it has no folder of its own to keep. */
const KIND_FOLDER: Record<GameArtAsset["kind"], string> = {
  model: "models",
  texture: "textures",
  audio: "sfx",
  font: "fonts",
};

interface Game {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly root: string;
  readonly assets: string;
}

const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const builds = yield* GameBuilds.GameBuilds;
  const config = yield* ServerConfig.ServerConfig;
  const savedDir = NodePath.join(config.baseDir, "library", "models");

  const failed = (operation: string, path: string, detail: string, cause?: unknown) =>
    new GameOperationError({
      operation,
      path,
      reason: cause === undefined ? "invalid-input" : "io",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const onDisk = <A>(operation: string, path: string, work: () => Promise<A>) =>
    Effect.tryPromise({
      try: work,
      catch: (cause) =>
        failed(
          operation,
          path,
          (cause instanceof Error ? cause.message : String(cause)).slice(0, 4000),
          cause,
        ),
    });

  /** Every game with an engine this server runs, with its assets folder. */
  const games = Effect.gen(function* () {
    const listed = yield* projects.list();
    const found: Game[] = [];
    for (const game of listed) {
      const manifest = yield* projects.read(game.root).pipe(Effect.option);
      if (Option.isNone(manifest)) continue;
      const engine = manifest.value.engine.name;
      if (!isAvailableEngine(engine)) continue;
      found.push({
        projectId: game.projectId,
        name: game.name,
        root: game.root,
        assets: gamePaths(engine, manifestProject(manifest.value)).assets,
      });
    }
    return found;
  });

  const artOf = (game: Game) =>
    projects.read(game.root).pipe(
      Effect.flatMap((manifest) => {
        const engine = manifest.engine.name;
        return isAvailableEngine(engine)
          ? onDisk("List the game's art", game.root, () =>
              listArtAssets(game.root, engine, manifestProject(manifest)),
            )
          : Effect.succeed({ assets: [] as ReadonlyArray<GameArtAsset>, more: 0 });
      }),
      // One unreadable game leaves the rest of the Library standing.
      Effect.orElseSucceed(() => ({ assets: [] as ReadonlyArray<GameArtAsset>, more: 0 })),
    );

  const savedModels = onDisk("Read the library", savedDir, async () => {
    const names = await NodeFSP.readdir(savedDir).catch(() => [] as string[]);
    const models: Array<{
      readonly id: string;
      readonly glb: string;
      readonly bytes: number;
      readonly sha256: string;
      readonly triangles: number | undefined;
      readonly picture: boolean;
      readonly sidecar: typeof SavedSidecar.Type;
    }> = [];
    for (const name of names.filter((each) => each.endsWith(".glb")).slice(0, MAX_SAVED)) {
      const id = name.slice(0, -4);
      const glb = NodePath.join(savedDir, name);
      const sidecar = Option.getOrNull(
        decodeSidecar(
          await NodeFSP.readFile(NodePath.join(savedDir, `${id}.json`), "utf8").catch(() => ""),
        ),
      );
      const stat = await NodeFSP.stat(glb).catch(() => null);
      if (sidecar === null || stat === null || !stat.isFile()) continue;
      const json = await readGltfJson(glb, MAX_GLTF_JSON);
      models.push({
        id,
        glb,
        bytes: stat.size,
        sha256: (await fileSha256(glb)).sha256,
        triangles: json.kind === "json" ? gltfTriangles(json.json) : undefined,
        picture: await exists(NodePath.join(savedDir, `${id}.png`)),
        sidecar,
      });
    }
    return models;
  });

  const packs = onDisk("Read the library", "packs", async () => {
    const items: GameLibraryItem[] = [];
    for (const pack of LIBRARY_CATALOG) {
      const folder = cachedPackFolder(pack);
      const files = NodePath.join(folder, "files");
      const installed = await exists(files);
      const index = installed
        ? await NodeFSP.readFile(NodePath.join(folder, "index.json"), "utf8").then(
            (text) => JSON.parse(text) as { readonly previews?: ReadonlyArray<string> },
            () => null,
          )
        : null;
      const preview = index?.previews?.find((path) => /\.(?:png|jpe?g|webp)$/i.test(path));
      const licence = LIBRARY_LICENCES[pack.licence].name;
      items.push({
        id: `pack:${pack.id}`,
        source: "pack",
        kind: "pack",
        name: pack.title,
        bytes: pack.bytes,
        credit: pack.credit === undefined ? licence : `${licence}, ${pack.credit}`,
        ...(preview === undefined ? {} : { picture: { root: files, path: preview } }),
        usedIn: [],
        pack: {
          author: pack.author,
          licence,
          source: pack.source,
          description: pack.description,
          installed,
          kinds: [...pack.kinds],
        },
      });
    }
    return items;
  });

  const list: GameLibrary["Service"]["list"] = Effect.gen(function* () {
    const all = yield* games;
    const byContent = new Map<
      string,
      { readonly asset: GameArtAsset; readonly game: Game; readonly uses: GameLibraryUse[] }
    >();
    const looks: GameLibraryItem[] = [];
    for (const game of all) {
      const art = yield* artOf(game);
      for (const asset of art.assets) {
        const use = { projectId: game.projectId, game: game.name, path: asset.path };
        const known = byContent.get(asset.sha256);
        if (known === undefined) byContent.set(asset.sha256, { asset, game, uses: [use] });
        else if (!known.uses.some((each) => each.projectId === game.projectId))
          known.uses.push(use);
      }
      const style = Option.getOrNull(
        decodeStyle(
          yield* onDisk("Read the look", game.root, () =>
            NodeFSP.readFile(NodePath.join(game.root, GAME_STYLE_FILE), "utf8").catch(() => ""),
          ),
        ),
      );
      if (style !== null)
        looks.push({
          id: `look:${game.projectId}`,
          source: "look",
          kind: "look",
          name: game.name,
          usedIn: [{ projectId: game.projectId, game: game.name, path: GAME_STYLE_FILE }],
          look: {
            palette: Array.isArray(style.palette) ? [...style.palette] : [],
            ...(style.family === undefined ? {} : { family: style.family }),
            mode: style.mode,
          },
        });
    }
    const saved = yield* savedModels;
    const savedItems: GameLibraryItem[] = saved.map((model) => {
      // A saved model added to games is the same bytes there: it lists once, as the saved one.
      const copies = byContent.get(model.sha256);
      byContent.delete(model.sha256);
      return {
        id: `saved:${model.id}`,
        source: "saved",
        kind: "model",
        name: model.sidecar.name,
        bytes: model.bytes,
        ...(model.triangles === undefined ? {} : { triangles: model.triangles }),
        file: { root: savedDir, path: `${model.id}.glb` },
        ...(model.picture ? { picture: { root: savedDir, path: `${model.id}.png` } } : {}),
        usedIn: copies?.uses ?? [],
        from: model.sidecar.game,
        part: model.sidecar.part,
        savedAt: model.sidecar.savedAt,
      };
    });
    const yours: GameLibraryItem[] = [...byContent.values()].map(({ asset, game, uses }) => ({
      id: `asset:${asset.sha256}`,
      source: "yours",
      kind: asset.kind,
      name: stem(asset.path),
      bytes: asset.bytes,
      ...(asset.triangles === undefined ? {} : { triangles: asset.triangles }),
      ...(asset.credit === undefined ? {} : { credit: asset.credit }),
      file: { root: game.root, path: asset.path },
      ...(asset.thumbnail === undefined
        ? {}
        : { picture: { root: game.root, path: asset.thumbnail } }),
      usedIn: uses,
    }));
    return { items: [...savedItems, ...yours, ...looks, ...(yield* packs)] };
  });

  /** A free game-relative path for `wanted`: itself, or with -2, -3… before its extension. */
  const freePath = (root: string, wanted: string) =>
    onDisk("Add from the Library", root, async () => {
      const dot = wanted.lastIndexOf(".");
      const head = dot > wanted.lastIndexOf("/") ? wanted.slice(0, dot) : wanted;
      const tail = wanted.slice(head.length);
      for (let n = 1; n < 100; n += 1) {
        const candidate = n === 1 ? wanted : `${head}-${n}${tail}`;
        if (!(await exists(NodePath.join(root, candidate)))) return candidate;
      }
      throw new Error(`${wanted} and its numbered copies are all taken`);
    });

  /** A line for ASSETS.md, under the file's own path, in the words the Art tab reads. */
  const credit = (root: string, path: string, words: string) =>
    onDisk("Add from the Library", root, async () => {
      const file = NodePath.join(root, "ASSETS.md");
      const before = await NodeFSP.readFile(file, "utf8").catch(() => "# Assets\n");
      if (assetLines(before).has(path)) return;
      const text = `${before.endsWith("\n") ? before : `${before}\n`}- \`${path}\` — ${words}\n`;
      await NodeFSP.writeFile(`${file}.library.tmp`, text);
      await NodeFSP.rename(`${file}.library.tmp`, file);
    });

  const copyIn = (from: string, root: string, to: string) =>
    onDisk("Add from the Library", root, async () => {
      const target = NodePath.join(root, to);
      const realRoot = await NodeFSP.realpath(root);
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      const folder = await NodeFSP.realpath(NodePath.dirname(target));
      if (folder !== realRoot && !folder.startsWith(realRoot + NodePath.sep))
        throw new Error("the destination leaves the game");
      await NodeFSP.copyFile(from, target);
    });

  const add: GameLibrary["Service"]["add"] = (input) =>
    Effect.gen(function* () {
      const [source, key] = [
        input.id.slice(0, input.id.indexOf(":")),
        input.id.slice(input.id.indexOf(":") + 1),
      ];
      const root = yield* projects.resolve(input.threadId);
      const target = (yield* games).find((game) => game.root === root);
      if (target === undefined)
        return yield* failed("Add from the Library", root, "That chat's game is not listed.");
      const everything = (yield* list).items;
      const item = everything.find((each) => each.id === input.id);
      if (item === undefined || source === "pack")
        return yield* failed(
          "Add from the Library",
          input.id,
          "No Library item has that id; game_assets op mine lists them.",
        );
      // Where it goes, what it is copied from, and the words its credit line says.
      const plan = yield* Effect.gen(function* () {
        if (source === "look") {
          const from = (yield* games).find((game) => game.projectId === key);
          if (from === undefined)
            return yield* failed("Add from the Library", key, "That look's game is gone.");
          return {
            from: NodePath.join(from.root, GAME_STYLE_FILE),
            to: GAME_STYLE_FILE,
            words: null,
            message: `The game now has ${from.name}'s look (${GAME_STYLE_FILE}).`,
          };
        }
        if (item.file === undefined)
          return yield* failed("Add from the Library", input.id, "That item has no file to add.");
        if (item.usedIn.some((use) => use.projectId === target.projectId)) {
          const already = item.usedIn.find((use) => use.projectId === target.projectId)!;
          return {
            from: null,
            to: already.path,
            words: null,
            message: "It is in the game already.",
          };
        }
        const kind = item.kind as GameArtAsset["kind"];
        const origin = item.usedIn[0];
        const sourceGame =
          origin === undefined
            ? undefined
            : (yield* games).find((game) => game.projectId === origin.projectId);
        const relative =
          source === "asset" && sourceGame !== undefined && origin !== undefined
            ? origin.path.startsWith(`${sourceGame.assets}/`)
              ? origin.path.slice(sourceGame.assets.length + 1)
              : `${KIND_FOLDER[kind]}/${baseName(origin.path)}`
            : `${KIND_FOLDER[kind]}/${slug(item.name)}.glb`;
        const to = yield* freePath(root, `${target.assets}/${relative}`);
        const lines =
          source === "asset" && sourceGame !== undefined && origin !== undefined
            ? assetLines(
                yield* onDisk("Add from the Library", sourceGame.root, () =>
                  NodeFSP.readFile(NodePath.join(sourceGame.root, "ASSETS.md"), "utf8").catch(
                    () => "",
                  ),
                ),
              )
            : new Map<string, string>();
        const said = origin === undefined ? undefined : lines.get(origin.path);
        const words =
          source === "saved"
            ? `made in code in ${item.from ?? "another game"} (${item.part ?? item.name}), from the Library`
            : (said ??
              `from the Library, as ${sourceGame?.name ?? "another game"} has it${item.credit === undefined ? "" : `; licence: ${item.credit}`}`);
        return {
          from: NodePath.join(item.file.root, item.file.path),
          to,
          words,
          message: `Added ${item.name} to the game as ${to}.`,
        };
      });
      if (plan.from === null) return { path: plan.to, message: plan.message };
      const from = plan.from;
      yield* builds.keepEdit(input.threadId, {
        operation: "Add from the Library",
        edit: "library",
        commandId: input.commandId,
        write: (gameRoot) =>
          Effect.gen(function* () {
            yield* copyIn(from, gameRoot, plan.to);
            if (plan.words !== null) yield* credit(gameRoot, plan.to, plan.words);
          }),
      });
      return { path: plan.to, message: `${plan.message} Undo takes it back out.` };
    });

  const save: GameLibrary["Service"]["save"] = (input) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(input.threadId);
      const game = (yield* games).find((each) => each.root === root);
      const id = `${slug(input.name)}-${NodeCrypto.randomBytes(3).toString("hex")}`;
      const glb = Buffer.from(input.glb.slice(input.glb.indexOf(",") + 1), "base64");
      const savedAt = DateTime.formatIso(yield* DateTime.now);
      if (glb.length < 12 || glb.toString("latin1", 0, 4) !== "glTF")
        return yield* failed("Save to the Library", input.part, "That is not a GLB.");
      yield* onDisk("Save to the Library", savedDir, async () => {
        await NodeFSP.mkdir(savedDir, { recursive: true });
        const write = async (name: string, data: Buffer | string) => {
          const path = NodePath.join(savedDir, name);
          await NodeFSP.writeFile(`${path}.tmp`, data);
          await NodeFSP.rename(`${path}.tmp`, path);
        };
        if (input.png !== undefined)
          await write(
            `${id}.png`,
            Buffer.from(input.png.slice(input.png.indexOf(",") + 1), "base64"),
          );
        // The sidecar before the GLB: a listing names a model only once both are there.
        await write(
          `${id}.json`,
          `${JSON.stringify(
            {
              name: input.name,
              game: game?.name ?? baseName(slash(root)),
              projectId: game?.projectId ?? "",
              part: input.part,
              savedAt,
            },
            null,
            2,
          )}\n`,
        );
        await write(`${id}.glb`, glb);
      });
      return { id: `saved:${id}`, message: `${input.name} is in the Library.` };
    });

  const remove: GameLibrary["Service"]["remove"] = (id) =>
    Effect.gen(function* () {
      const name = id.startsWith("saved:") ? id.slice("saved:".length) : null;
      if (name === null || !/^[a-z0-9-]+$/.test(name))
        return yield* failed("Remove from the Library", id, "Only a saved model can be removed.");
      yield* onDisk("Remove from the Library", savedDir, async () => {
        for (const extension of [".glb", ".json", ".png"])
          await NodeFSP.rm(NodePath.join(savedDir, `${name}${extension}`), { force: true });
      });
    });

  return GameLibrary.of({ list, add, save, remove });
});

export const layer = Layer.effect(GameLibrary, make);

/** The Library as an agent reads it: one line per item it can add, with its id. */
export const libraryText = (items: ReadonlyArray<GameLibraryItem>) => {
  const addable = items.filter((item) => item.source !== "pack");
  if (addable.length === 0) return "The person's Library is empty.";
  const lines = addable.slice(0, 80).map((item) => {
    const where =
      item.source === "saved"
        ? `saved from ${item.from ?? "a game"}`
        : item.usedIn.map((use) => use.game).join(", ");
    return `${item.id} — ${item.kind} "${item.name}" (${where})`;
  });
  const more = addable.length - lines.length;
  return `${lines.join("\n")}${more > 0 ? `\n…and ${more} more.` : ""}\nAdd one with op mine_add and its id.`;
};
