// @effect-diagnostics nodeBuiltinImport:off -- The install boundary owns native hashing, atomic renames and the game's filesystem paths.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  GameOperationError,
  type GameArtGetInput,
  type GameArtGetResult,
  type GameArtImportResult,
  type GameArtKit,
  type GameArtKitFile,
  type GameArtKitSummary,
  GameArtKit as GameArtKitSchema,
  type GameArtSearchInput,
  type GameArtSearchResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { insideGame } from "./GameProjectService.ts";
import { gameArtKitCatalog } from "./artKitCatalog.ts";

const listOrNone = (values: ReadonlyArray<string>): string =>
  values.length === 0 ? "none" : values.join(", ");
const isGameArtKit = Schema.is(GameArtKitSchema);
const isGameOperationError = Schema.is(GameOperationError);

export class GameArtUnknownIdError extends Schema.TaggedError<GameArtUnknownIdError>()(
  "GameArtUnknownIdError",
  {
    id: Schema.String,
    availableIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `No art kit with id '${this.id}'. Available ids: ${listOrNone(this.availableIds)}.`;
  }
}

/**
 * The optional shipped art catalog and its one write. Search and get read only
 * the injected catalog and never touch a game. Install copies exactly the
 * catalog's declared files; it has no archive extraction, download, dependency
 * or marketplace behavior.
 */
export class GameArtKits extends Context.Service<
  GameArtKits,
  {
    readonly search: (input: GameArtSearchInput) => Effect.Effect<GameArtSearchResult>;
    readonly get: (
      input: GameArtGetInput,
    ) => Effect.Effect<GameArtGetResult, GameArtUnknownIdError>;
    readonly install: (input: {
      readonly root: string;
      readonly godotProject: string;
      readonly id: string;
    }) => Effect.Effect<GameArtImportResult, GameOperationError>;
  }
>()("t3/game/GameArtKits") {}

const fold = (value: string): string => value.trim().toLowerCase();
const hash = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const toPosix = (value: string): string => value.replaceAll("\\", "/");

const isErrno = (cause: unknown, ...codes: ReadonlyArray<string>): boolean => {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  return code !== undefined && codes.includes(code);
};
const conflict = (path: string, detail: string) =>
  new GameOperationError({
    operation: "import-art-kit",
    path,
    reason: "art-kit-conflict",
    detail,
  });
const ioFailure = (path: string, cause: unknown) =>
  new GameOperationError({ operation: "import-art-kit", path, reason: "io", cause });

/** Only a genuinely missing entry means "import it"; other failures stay visible. */
const lstatOrMissing = async (path: string) => {
  try {
    return await NodeFSP.lstat(path);
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return null;
    throw cause;
  }
};
const readExistingOrNull = async (path: string) => {
  try {
    return await NodeFSP.readFile(path);
  } catch (cause) {
    if (isErrno(cause, "ENOENT", "EISDIR", "ENOTDIR")) return null;
    throw cause;
  }
};
const notRealDirectory = (root: string, path: string, symlink: boolean) =>
  conflict(
    path,
    `${NodePath.relative(root, path)} is ${symlink ? "a symbolic link" : "not a directory"}, so writing through it could leave the game. Nothing was written; move it aside or restore a real directory.`,
  );

/**
 * The install may create missing folders, but every existing component below
 * the game root must be a real directory. `mkdir` would otherwise follow a
 * symlinked `assets` or `kits` and copy the kit outside the game.
 */
const ensureRealDirectoryChain = async (root: string, relative: string) => {
  let current = root;
  for (const part of relative.split(NodePath.sep)) {
    if (part === "") continue;
    current = NodePath.join(current, part);
    let info: Awaited<ReturnType<typeof NodeFSP.lstat>> | null;
    try {
      info = await lstatOrMissing(current);
    } catch (cause) {
      throw ioFailure(current, cause);
    }
    if (info === null) {
      try {
        await NodeFSP.mkdir(current);
        info = await NodeFSP.lstat(current);
      } catch (cause) {
        throw ioFailure(current, cause);
      }
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw notRealDirectory(root, current, info.isSymbolicLink());
  }
};

/** The packed and checked-in layouts the running server can see. */
export const resolveArtKitsDirectory = Effect.fn("GameArtKits.resolveDirectory")(function* (
  moduleDirectory: string,
) {
  const bundled = NodePath.join(moduleDirectory, "art-kits");
  // In the dev tree this module lives in src/game, with the kits at
  // apps/server/assets/art-kits; the packed server has dist/art-kits.
  const checkout = NodePath.join(moduleDirectory, "../../assets/art-kits");
  for (const candidate of [bundled, checkout]) {
    const present = yield* Effect.promise(() =>
      NodeFSP.stat(candidate).then(
        (info) => info.isDirectory(),
        () => false,
      ),
    );
    if (present) return candidate;
  }
  return yield* new GameOperationError({
    operation: "resolve-art-kits",
    path: bundled,
    reason: "art-kits-missing",
  });
});

const summaryOf = (kit: GameArtKit): GameArtKitSummary => ({
  id: kit.id,
  version: kit.version,
  name: kit.name,
  summary: kit.summary,
  styles: kit.styles,
  contents: kit.contents,
  license: kit.license,
  source: kit.source,
  atlas: kit.atlas,
  usage: kit.usage,
});

const matchesText = (kit: GameArtKit, text: string): boolean => {
  const values = [
    kit.id,
    kit.name,
    kit.summary,
    kit.usage,
    ...kit.styles,
    ...kit.contents,
    kit.license.name,
    kit.license.attribution,
    kit.source.title,
    kit.source.url,
  ];
  return values.some((value) => fold(value).includes(text));
};

const sameFile = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));

/**
 * A catalog mistake must fail at load, not copy an incomplete kit into a game.
 */
const validateCatalog = (catalog: ReadonlyArray<GameArtKit>) => {
  const ids = new Set<string>();
  for (const kit of catalog) {
    const label = kit.id;
    if (!isGameArtKit(kit)) {
      throw new Error(`Art kit '${label}' does not match the catalog schema.`);
    }
    if (ids.has(kit.id)) throw new Error(`Art kit '${kit.id}' is declared twice.`);
    ids.add(kit.id);
    const paths = new Set<string>();
    for (const file of kit.files) {
      if (paths.has(file.path)) {
        throw new Error(`Art kit '${kit.id}' declares '${file.path}' twice.`);
      }
      paths.add(file.path);
    }
    const atlases = kit.files.filter((file) => file.role === "atlas");
    if (atlases.length !== 1 || atlases[0]?.path !== kit.atlas.image) {
      throw new Error(`Art kit '${kit.id}' must declare exactly one matching atlas file.`);
    }
    if (!kit.files.some((file) => file.role === "license")) {
      throw new Error(`Art kit '${kit.id}' must ship its license.`);
    }
    const atlas = atlases[0]!;
    if (atlas.width === undefined || atlas.height === undefined) {
      throw new Error(`Art kit '${kit.id}' must declare the atlas image size.`);
    }
    if (kit.atlas.imageWidth !== atlas.width || kit.atlas.imageHeight !== atlas.height) {
      throw new Error(
        `Art kit '${kit.id}' declares image dimensions its atlas file disagrees with.`,
      );
    }
    const expectedWidth =
      kit.atlas.columns * kit.atlas.tileWidth +
      (kit.atlas.columns - 1) * kit.atlas.spacing +
      2 * kit.atlas.margin;
    const expectedHeight =
      kit.atlas.rows * kit.atlas.tileHeight +
      (kit.atlas.rows - 1) * kit.atlas.spacing +
      2 * kit.atlas.margin;
    if (atlas.width !== expectedWidth || atlas.height !== expectedHeight) {
      throw new Error(`Art kit '${kit.id}' declares an atlas layout its image cannot fit.`);
    }
    if (kit.atlas.tileCount !== kit.atlas.columns * kit.atlas.rows) {
      throw new Error(`Art kit '${kit.id}' declares a tile count its grid cannot hold.`);
    }
  }
};

const readCatalogFile = (source: string, file: GameArtKitFile) =>
  Effect.gen(function* () {
    const bytes = yield* Effect.tryPromise({
      try: () => NodeFSP.readFile(source),
      catch: (cause) =>
        new GameOperationError({
          operation: "read-art-kit",
          path: source,
          reason: "io",
          cause,
        }),
    });
    if (bytes.byteLength !== file.bytes || hash(bytes) !== file.sha256)
      return yield* new GameOperationError({
        operation: "read-art-kit",
        path: source,
        reason: "art-kit-corrupt",
        detail: `The shipped ${file.path} does not match its catalog entry (${bytes.byteLength} bytes).`,
      });
    return bytes;
  });

const installedResult = (input: {
  readonly kit: GameArtKit;
  readonly destination: string;
  readonly kitRelative: string;
  readonly alreadyPresent: boolean;
}): GameArtImportResult => {
  return {
    kit: summaryOf(input.kit),
    destination: input.destination,
    files: input.kit.files.map((file) => ({
      path: `${input.destination}/${file.path}`,
      resPath: `res://${input.kitRelative}/${file.path}`,
      role: file.role,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
    atlas: {
      imageResPath: `res://${input.kitRelative}/${input.kit.atlas.image}`,
      imageWidth: input.kit.atlas.imageWidth,
      imageHeight: input.kit.atlas.imageHeight,
      tileWidth: input.kit.atlas.tileWidth,
      tileHeight: input.kit.atlas.tileHeight,
      columns: input.kit.atlas.columns,
      rows: input.kit.atlas.rows,
      tileCount: input.kit.atlas.tileCount,
      margin: input.kit.atlas.margin,
      spacing: input.kit.atlas.spacing,
    },
    alreadyPresent: input.alreadyPresent,
    message: input.alreadyPresent
      ? `${input.kit.name} is already imported unchanged at ${input.destination}; no files were written. Run game_godot_import if needed.`
      : `Imported ${input.kit.name} into ${input.destination}. Run game_godot_import before using it.`,
  };
};

export const make = (catalog: ReadonlyArray<GameArtKit>): GameArtKits["Service"] => {
  validateCatalog(catalog);
  const entries = [...catalog].sort((left, right) => (left.id < right.id ? -1 : 1));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const availableIds = entries.map((entry) => entry.id);

  const search: GameArtKits["Service"]["search"] = (input) =>
    Effect.sync(() => {
      const style = input.style === undefined ? "" : fold(input.style);
      const text = input.text === undefined ? "" : fold(input.text);
      const kits = entries
        .filter((kit) => {
          if (style !== "" && !kit.styles.some((tag) => fold(tag) === style)) return false;
          if (text !== "" && !matchesText(kit, text)) return false;
          return true;
        })
        .map(summaryOf);
      return { kits };
    });

  const get: GameArtKits["Service"]["get"] = Effect.fn("GameArtKits.get")(function* (input) {
    const kit = byId.get(input.id);
    if (kit === undefined) {
      return yield* new GameArtUnknownIdError({ id: input.id, availableIds });
    }
    return { kit };
  });

  const install: GameArtKits["Service"]["install"] = Effect.fn("GameArtKits.install")(
    function* (input) {
      const kit = byId.get(input.id);
      if (kit === undefined) {
        return yield* new GameOperationError({
          operation: "import-art-kit",
          path: input.id,
          reason: "unknown-art-kit",
          detail: `Available ids: ${listOrNone(availableIds)}.`,
        });
      }
      const sourceDirectory = yield* resolveArtKitsDirectory(import.meta.dirname);
      const sourceKit = NodePath.join(sourceDirectory, kit.id);
      // Read and verify every shipped byte before looking at the game, so a
      // broken package cannot leave a partial kit behind.
      const sourceFiles: Array<{ file: GameArtKitFile; bytes: Uint8Array }> = [];
      for (const file of kit.files) {
        sourceFiles.push({
          file,
          bytes: yield* readCatalogFile(NodePath.join(sourceKit, file.path), file),
        });
      }

      const godotRoot = yield* Effect.try({
        try: () => insideGame(input.root, input.godotProject),
        catch: (cause) =>
          isGameOperationError(cause)
            ? cause
            : new GameOperationError({
                operation: "import-art-kit",
                path: input.godotProject,
                reason: "invalid-path",
                cause,
              }),
      });
      const gameRoot = NodePath.resolve(input.root);
      const kitRelative = toPosix(NodePath.join("assets", "art", "kits", kit.id));
      const destinationRelative = toPosix(NodePath.join(input.godotProject, kitRelative));
      const destination = insideGame(godotRoot, kitRelative);
      const parent = NodePath.dirname(destination);

      // The game root is the caller's chosen boundary. Everything below it is
      // re-checked, because a symlinked `assets` or `kits` folder would send
      // this copy outside the game even though the lexical path looks inside.
      yield* Effect.tryPromise({
        try: () => ensureRealDirectoryChain(gameRoot, NodePath.relative(gameRoot, parent)),
        catch: (cause) => (isGameOperationError(cause) ? cause : ioFailure(parent, cause)),
      });

      const existing = yield* Effect.tryPromise({
        try: () => lstatOrMissing(destination),
        catch: (cause) => ioFailure(destination, cause),
      });
      if (existing !== null) {
        if (existing.isSymbolicLink() || !existing.isDirectory()) {
          return yield* existing.isSymbolicLink()
            ? notRealDirectory(gameRoot, destination, true)
            : conflict(
                destination,
                "The kit destination exists but is not a directory. Nothing was written.",
              );
        }
        const mismatches: string[] = [];
        for (const { file, bytes } of sourceFiles) {
          const filePath = NodePath.join(destination, file.path);
          const current = yield* Effect.tryPromise({
            try: () => readExistingOrNull(filePath),
            catch: (cause) => ioFailure(filePath, cause),
          });
          if (current === null || !sameFile(current, bytes)) mismatches.push(file.path);
        }
        if (mismatches.length > 0) {
          return yield* conflict(
            destination,
            `Existing files differ or are missing: ${mismatches.join(", ")}. Nothing was written.`,
          );
        }
        return installedResult({
          kit,
          destination: destinationRelative,
          kitRelative,
          alreadyPresent: true,
        });
      }
      const staging = yield* Effect.tryPromise({
        try: () => NodeFSP.mkdtemp(NodePath.join(parent, `.${kit.id}-`)),
        catch: (cause) =>
          new GameOperationError({
            operation: "import-art-kit",
            path: parent,
            reason: "io",
            cause,
          }),
      });
      yield* Effect.gen(function* () {
        for (const { file, bytes } of sourceFiles) {
          yield* Effect.tryPromise({
            try: () => NodeFSP.writeFile(NodePath.join(staging, file.path), bytes, { flag: "wx" }),
            catch: (cause) =>
              new GameOperationError({
                operation: "import-art-kit",
                path: NodePath.join(staging, file.path),
                reason: "io",
                cause,
              }),
          });
        }
        // The kit directory appears whole or not at all. Re-check the parent
        // and destination at the rename boundary; this is not a defense
        // against a hostile process racing the checks.
        yield* Effect.tryPromise({
          try: async () => {
            const currentParent = await NodeFSP.lstat(parent);
            if (currentParent.isSymbolicLink() || !currentParent.isDirectory())
              throw notRealDirectory(gameRoot, parent, currentParent.isSymbolicLink());
            if ((await lstatOrMissing(destination)) !== null)
              throw conflict(
                destination,
                "The kit destination appeared while the kit was being written. Nothing was replaced.",
              );
            await NodeFSP.rename(staging, destination);
          },
          catch: (cause) => (isGameOperationError(cause) ? cause : ioFailure(destination, cause)),
        });
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(staging, { recursive: true, force: true })),
        ),
      );

      return installedResult({
        kit,
        destination: destinationRelative,
        kitRelative,
        alreadyPresent: false,
      });
    },
  );

  return GameArtKits.of({ search, get, install });
};

export const layer = Layer.succeed(GameArtKits, make(gameArtKitCatalog));
