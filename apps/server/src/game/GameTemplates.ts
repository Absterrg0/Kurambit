// @effect-diagnostics nodeBuiltinImport:off - Archive bytes, hashing and the atomic rename are plain Node file work.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { GameOperationError } from "@kurambit/contracts";
import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { unpackArchive, type UnpackLimits } from "./assetLibraryFiles.ts";

/**
 * Kurambit's starter templates, studio skills, bot kit and label font, as
 * plain files. The packed server carries them as one archive beside its
 * bundle and extracts it into the Kurambit home on first use: engines, tools
 * and the copies into games then read ordinary files on every platform, and
 * nothing has to read inside an Electron asar (whose directories support
 * neither access() nor cp(), and which other processes cannot open at all).
 * The dev tree reads apps/server/templates directly.
 */
export class GameTemplates extends Context.Service<
  GameTemplates,
  {
    /** The templates folder; the first call extracts the bundled archive. */
    readonly directory: Effect.Effect<string, GameOperationError>;
  }
>()("kurambit/game/GameTemplates") {}

const TEMPLATES_ARCHIVE = "templates.zip";

/** The archive holds about 200 small files; anything far past that is not ours. */
const TEMPLATE_LIMITS: UnpackLimits = {
  entries: 2_000,
  bytes: 64 * 1024 * 1024,
  entryBytes: 32 * 1024 * 1024,
};

/**
 * One folder per app version and archive content, so an update (or a rebuilt
 * archive under the same version) extracts afresh instead of reusing old files.
 */
const extractedTemplatesDirectory = (baseDir: string, version: string, digest: string) =>
  NodePath.join(
    baseDir,
    "templates",
    `${version.replace(/[^A-Za-z0-9._-]/g, "_")}-${digest.slice(0, 12)}`,
  );

const failure = (path: string, detail: string, cause?: unknown) =>
  new GameOperationError({
    operation: "extract-templates",
    path,
    reason: "io",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const exists = (path: string) =>
  NodeFSP.stat(path).then(
    () => true,
    () => false,
  );

/**
 * Extracts `archive` into the home's templates folder for this version and
 * returns it. The archive is unpacked into a private staging folder and renamed
 * into place, so a folder that exists is complete: a crash mid-extract leaves
 * only staging behind, and a racing server that renamed first wins. Folders of
 * other versions are removed once this one is in place.
 */
export const extractTemplates = (input: {
  readonly archive: string;
  readonly baseDir: string;
  readonly version: string;
}) =>
  Effect.gen(function* () {
    const root = NodePath.join(input.baseDir, "templates");
    // Read through fs so an archive inside an asar works; yauzl then opens a real file.
    const bytes = yield* Effect.tryPromise({
      try: () => NodeFSP.readFile(input.archive),
      catch: (cause) => failure(input.archive, "The bundled templates could not be read.", cause),
    });
    const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    const target = extractedTemplatesDirectory(input.baseDir, input.version, digest);
    if (yield* Effect.promise(() => exists(target))) return target;
    const staging = NodePath.join(root, `.extract-${NodeCrypto.randomUUID()}`);
    const stagingArchive = `${staging}.zip`;
    const cleanup = Effect.promise(() =>
      Promise.all([
        NodeFSP.rm(staging, { recursive: true, force: true }),
        NodeFSP.rm(stagingArchive, { force: true }),
      ]).catch(() => undefined),
    );
    yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(staging, { recursive: true });
          await NodeFSP.writeFile(stagingArchive, bytes);
        },
        catch: (cause) => failure(root, "The templates folder could not be written.", cause),
      });
      yield* unpackArchive(stagingArchive, staging, TEMPLATE_LIMITS);
      yield* Effect.tryPromise({
        try: () => NodeFSP.rename(staging, target),
        catch: (cause) =>
          failure(target, "The extracted templates could not be put in place.", cause),
      }).pipe(
        // Another server extracted the same archive first: its folder is complete.
        Effect.catch((error) =>
          Effect.promise(() => exists(target)).pipe(
            Effect.flatMap((present) => (present ? Effect.void : Effect.fail(error))),
          ),
        ),
      );
    }).pipe(Effect.ensuring(cleanup));
    yield* Effect.promise(async () => {
      const entries = await NodeFSP.readdir(root).catch(() => [] as string[]);
      await Promise.all(
        entries
          .filter((name) => !name.startsWith(".") && NodePath.join(root, name) !== target)
          .map((name) =>
            NodeFSP.rm(NodePath.join(root, name), { recursive: true, force: true }).catch(
              () => undefined,
            ),
          ),
      );
    });
    return target;
  });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const bundled = NodePath.join(import.meta.dirname, TEMPLATES_ARCHIVE);
  const monorepo = NodePath.join(import.meta.dirname, "../../templates");
  const resolve = Effect.gen(function* () {
    if (yield* Effect.promise(() => exists(bundled)))
      return yield* extractTemplates({
        archive: bundled,
        baseDir: config.baseDir,
        version: packageJson.version,
      });
    if (yield* Effect.promise(() => exists(NodePath.join(monorepo, "bot-kit")))) return monorepo;
    return yield* new GameOperationError({
      operation: "resolve-templates",
      path: bundled,
      reason: "starter-templates-missing",
    });
  });
  // One extraction at a time; a success is kept, a failure is tried again next call.
  const lock = yield* Semaphore.make(1);
  let resolved: string | undefined;
  const directory = Effect.suspend(() =>
    resolved !== undefined
      ? Effect.succeed(resolved)
      : lock.withPermits(1)(
          Effect.suspend(() =>
            resolved !== undefined
              ? Effect.succeed(resolved)
              : resolve.pipe(
                  Effect.tap((found) =>
                    Effect.sync(() => {
                      resolved = found;
                    }),
                  ),
                ),
          ),
        ),
  );
  return GameTemplates.of({ directory });
});

export const layer = Layer.effect(GameTemplates, make);

/** Templates at a fixed folder, for tests. */
export const layerAt = (directory: string) =>
  Layer.succeed(GameTemplates, GameTemplates.of({ directory: Effect.succeed(directory) }));
