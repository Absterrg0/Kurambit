// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem boundary of releases, the Web build Play serves and their packages.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  GameOperationError,
  gameOperationFault,
  type GameActionResult,
  type GameStatus,
  type GameWebPackage,
  type GameWindowsPackage,
  type ThreadId,
} from "@kurambit/contracts";
import { ArchivePublishError, publishStaged, sweepPublished } from "./archivePublication.ts";
import { commandDetail } from "./commandDetail.ts";
import * as GameEngine from "./GameEngine.ts";
import type { GameExportTarget } from "./engineProfile.ts";
import { makeAtomicWriter } from "./gameFiles.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { inGame, insideGame } from "./gamePath.ts";
import {
  comparedSource,
  makeSourceIdentity,
  type SourceIdentity,
  sourceIdentityError,
} from "./sourceTree.ts";
import {
  CANDIDATE_BUILDS_DIRECTORY,
  WEB_BUILD_DIRECTORY,
  candidateBuildDirectory,
  hashWebBuild,
  readWebBuild,
  webBuildStatIdentity,
  webBuildProblemText,
} from "./webBuild.ts";
import { packageWebRelease, WebPackageError, WEB_PACKAGES_DIRECTORY } from "./webPackage.ts";
import { packageWindowsRelease, WindowsPackageError } from "./windowsPackage.ts";

/** Short confirmation the creator reads after an export lands. */
const WEB_READY_MESSAGE = "Web game is ready to play. Open it with Play.";

/** The build Play serves, written at each Web export. */
const SelectedWebBuild = Schema.Struct({
  buildId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  directory: Schema.String.check(Schema.isMinLength(1)),
  sourceId: Schema.NullOr(Schema.String),
  entry: Schema.String.check(Schema.isMinLength(1)),
  /** The build selected before this one, kept so a window opened on it keeps playing. */
  previous: Schema.optionalKey(Schema.String),
});
export interface SelectedWebBuild extends Schema.Schema.Type<typeof SelectedWebBuild> {}
/** The selection record's codec, for readers outside this service (the run's finish). */
const decodeSelectedBuild = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.NullOr(SelectedWebBuild)),
);
const encodeSelectedBuild = Schema.encodeSync(Schema.fromJsonString(SelectedWebBuild));

const SELECTED_BUILD_FILE = "builds/web-selected.json";

/**
 * Every builds path an export or a package writes, moves or deletes in. `builds` or any
 * folder in it may be a link an agent planted, and a release staged, published, pruned or
 * swept through one would land outside the game, so all are checked before the first write.
 */
const buildPathsInGame = (root: string) =>
  Effect.forEach(
    [
      CANDIDATE_BUILDS_DIRECTORY,
      WEB_BUILD_DIRECTORY,
      "builds/linux",
      "builds/windows",
      WEB_PACKAGES_DIRECTORY,
      SELECTED_BUILD_FILE,
    ],
    (relative) => inGame(root, relative),
    { discard: true },
  );

/** One release a game has, as the status and the Export… dialog show it. */
export type GameRelease = GameStatus["builds"][number];

/** The game's release folder for a native target. */
const releaseDirectory = (target: GameExportTarget) => `builds/${target.toLowerCase()}`;

/** Staging names a crash may leave behind, by folder; each is swept before the next export. */
const STAGING = /^\.release-|^\.staging-|\.partial$|^\.game-[0-9a-f-]{36}\.(?:exe|pck)$/;
/** Leftovers of earlier publication code: Unity's `<dest>.old-*` and `.dest-*`, the old Windows backups. */
const LEGACY_LEFTOVER =
  /^(?:linux|windows)\.old-[0-9a-f-]{36}$|^\.(?:linux|windows)-[0-9a-f-]{36}$|^game\.(?:exe|pck)\.[0-9a-f-]{36}\.backup$/;
const io = (operation: string, path: string) => (cause: unknown) =>
  new GameOperationError({ operation, path, reason: "io", cause });

/**
 * Stages one release beside its destination, has the engine write and check
 * it, proves the sources did not move under it, then publishes it. The one
 * path every release takes (an export, a Web build, a player a game keeps by
 * source identity), so staging, the source comparison and publication are
 * written once. Callers hold the game's operation lock (and the live editor,
 * where the engine has one, for the import before it).
 */
export const releaseTo = <P>(
  backend: GameEngine.GameEngineBackend,
  ctx: GameEngine.GameEngineContext,
  input: {
    readonly target: GameExportTarget;
    readonly preset: string;
    readonly operation: string;
    /** The folder the staging folder is made in: the destination's own parent. */
    readonly stagingParent: string;
    /** The engine folder's content identity now (makeSourceIdentity). */
    readonly identify: Effect.Effect<SourceIdentity>;
    /** Publishes the checked staging folder for the sources it was built from. */
    readonly publish: (
      staging: string,
      artifact: string,
      sourceId: string,
    ) => Effect.Effect<P, GameOperationError>;
  },
): Effect.Effect<
  | {
      readonly kind: "published";
      readonly result: GameActionResult;
      readonly published: P;
      readonly sourceId: string;
      readonly notes: ReadonlyArray<string>;
    }
  /** The engine made no usable release of these sources: the game's own failure. */
  | { readonly kind: "failed"; readonly result: GameActionResult },
  GameOperationError
> => {
  const { root, projectName } = ctx;
  const snapshot = input.identify;
  const staging = NodePath.join(
    input.stagingParent,
    `.release-${input.target.toLowerCase()}-${NodeCrypto.randomUUID()}`,
  );
  return Effect.gen(function* () {
    // An unidentifiable tree is refused before the engine runs: the result
    // could never be attached to the sources. A build's own cause (a link,
    // too many files) becomes the export's result through runExport.
    const before = yield* snapshot;
    if (before.kind === "unknown")
      return yield* sourceIdentityError(input.operation, root, projectName, before);
    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdir(staging, { recursive: true }),
      catch: io(input.operation, staging),
    });
    const release = yield* backend.release(ctx, {
      target: input.target,
      preset: input.preset,
      staging,
      operation: input.operation,
    });
    if (!release.result.success || release.artifact === null)
      return { kind: "failed", result: release.result } as const;
    // Prove the game folder did not change while the release ran: an edit
    // during it means the build no longer describes the sources.
    const after = yield* snapshot;
    if (after.kind === "unknown")
      return yield* sourceIdentityError(input.operation, root, projectName, after);
    const comparison = comparedSource(before, after, input.operation);
    if (comparison.kind !== "current")
      return yield* sourceIdentityError(input.operation, root, projectName, {
        kind: "changed",
        detail: comparison.detail,
      });
    const published = yield* input.publish(staging, release.artifact, comparison.sourceId);
    return {
      kind: "published",
      result: release.result,
      published,
      sourceId: comparison.sourceId,
      notes: release.notes,
    } as const;
  }).pipe(
    Effect.ensuring(
      // Nothing is left once published; a release that failed leaves no staging.
      Effect.promise(() =>
        NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined),
      ),
    ),
  );
};

/** Publishes a checked staging folder over a release folder, as a game operation's error. */
export const publishFolder = (operation: string, staging: string, destination: string) =>
  Effect.tryPromise({
    try: () => publishStaged([{ staged: staging, final: destination }]),
    catch: (cause) =>
      new GameOperationError({
        operation,
        path: destination,
        reason: "io",
        detail:
          cause instanceof ArchivePublishError
            ? cause.message
            : "The checked release could not be moved into place.",
        cause,
      }),
  });

/**
 * Release exports, the Web build Play serves, and the packages made from
 * them. The engine's driver writes and checks each release; this service
 * stages, compares, publishes, selects and prunes. Callers hold the game's
 * operation lock.
 */
export class GameExport extends Context.Service<
  GameExport,
  {
    /**
     * Exports the thread's game for `target`, as the game's operation.
     * success ⇒ `path` is the absolute published artifact; a build's own failure is success:false.
     */
    readonly export: (
      threadId: ThreadId,
      target: GameExportTarget,
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    /** Builds and publishes the current sources, then serves that build. */
    readonly publishWeb: (root: string) => Effect.Effect<GameActionResult, GameOperationError>;
    /**
     * Serves the selected Web build, which only reads the folder. Null when
     * none was ever selected, so Play must export one first.
     */
    readonly serve: (root: string) => Effect.Effect<GameActionResult | null, GameOperationError>;
    /** The Web build Play serves, as its export recorded it; null only when no record exists. */
    readonly selected: (root: string) => Effect.Effect<SelectedWebBuild | null, GameOperationError>;
    /** The releases the game has now, by its engine's targets: stat-only, no lock. */
    readonly releases: (
      root: string,
    ) => Effect.Effect<ReadonlyArray<GameRelease>, GameOperationError>;
    /** The targets this game's engine releases, read from its profile without any lock. */
    readonly exportTargets: (
      root: string,
    ) => Effect.Effect<
      { readonly targets: ReadonlyArray<GameExportTarget>; readonly displayName: string },
      GameOperationError
    >;
    /**
     * Packages the already exported Windows release as a ZIP. It never exports;
     * a missing or unusable release is an error and leaves earlier files alone.
     */
    readonly packageWindows: (
      threadId: ThreadId,
    ) => Effect.Effect<GameWindowsPackage, GameOperationError>;
    /**
     * Packages the exact immutable Web build Play currently serves as a
     * static-host ZIP. It never exports and never chooses another build.
     */
    readonly packageWeb: (threadId: ThreadId) => Effect.Effect<GameWebPackage, GameOperationError>;
    /** Serves the Web export Play's selection names, for a browser; it never exports. */
    readonly webExportUrl: (threadId: ThreadId) => Effect.Effect<string, GameOperationError>;
  }
>()("kurambit/game/GameExport") {}

const make = Effect.gen(function* () {
  const engines = yield* GameEngine.GameEngine;
  const preview = yield* GamePreview.GamePreview;
  const projects = yield* GameProjectService.GameProjectService;
  const identify = yield* makeSourceIdentity;
  const writeAtomic = yield* makeAtomicWriter;

  const readSelectedBuild = (
    root: string,
  ): Effect.Effect<SelectedWebBuild | null, GameOperationError> => {
    const file = NodePath.join(root, SELECTED_BUILD_FILE);
    return Effect.tryPromise({
      try: async () => {
        let text: string;
        try {
          text = await NodeFSP.readFile(file, "utf8");
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { text: null };
          throw cause;
        }
        return { text };
      },
      catch: io("Read the selected Web build", file),
    }).pipe(
      Effect.flatMap(({ text }) =>
        text === null
          ? Effect.succeed(null)
          : Effect.try({
              // The record is a game file an agent can write: a build it names outside the
              // game is no build Kurambit made, and Play and packaging would read from there.
              try: () => {
                const selected = decodeSelectedBuild(text);
                if (selected !== null)
                  for (const directory of [selected.directory, selected.previous ?? []].flat())
                    insideGame(root, directory);
                return selected;
              },
              catch: (cause) =>
                new GameOperationError({
                  operation: "Read the selected Web build",
                  path: file,
                  reason: "invalid-project",
                  detail: `${SELECTED_BUILD_FILE} is not a selection record Kurambit wrote; Rebuild to export the current sources and select them.`,
                  cause,
                }),
            }),
      ),
    );
  };

  const exists = (path: string) =>
    Effect.promise(() =>
      NodeFSP.stat(path).then(
        (stat) => stat,
        () => null,
      ),
    );

  /** What a crash or a cut-short release left in the game's builds; runs under the export's lock. */
  const sweepLeftovers = (root: string) =>
    Effect.promise(async () => {
      const builds = NodePath.join(root, "builds");
      const leftover = (name: string) => STAGING.test(name) || LEGACY_LEFTOVER.test(name);
      for (const directory of [
        builds,
        NodePath.join(root, CANDIDATE_BUILDS_DIRECTORY),
        NodePath.join(root, "builds/linux"),
        NodePath.join(root, "builds/windows"),
        NodePath.join(root, WEB_PACKAGES_DIRECTORY),
      ])
        await sweepPublished(directory, leftover);
    });

  /**
   * Keeps the selected Web build and the one selected before it, so a window
   * opened on that one keeps playing; every other candidate goes, with its
   * preview server. Runs under the export's lock, so nothing selects meanwhile.
   */
  const pruneCandidates = (root: string, keep: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      yield* preview.retain(root, keep);
      yield* Effect.promise(async () => {
        const candidates = NodePath.join(root, CANDIDATE_BUILDS_DIRECTORY);
        for (const name of await NodeFSP.readdir(candidates).catch(() => [] as string[]))
          if (/^[0-9a-f]{64}$/.test(name) && !keep.includes(candidateBuildDirectory(name)))
            // A folder another process still holds open (Windows) goes next time.
            await NodeFSP.rm(NodePath.join(candidates, name), {
              recursive: true,
              force: true,
            }).catch(() => undefined);
      });
    });

  /** A checked staging folder becomes the content-addressed candidate it hashes to, then Play's selection. */
  const publishCandidate = (root: string, project: string, staging: string, sourceId: string) =>
    Effect.gen(function* () {
      const hashed = yield* Effect.promise(() => readWebBuild(staging));
      if ("problem" in hashed)
        return { ok: false, message: webBuildProblemText(hashed.problem, project) } as const;
      const directory = candidateBuildDirectory(hashed.buildId);
      const final = NodePath.join(root, directory);
      if ((yield* exists(final)) === null)
        yield* Effect.tryPromise({
          try: () => NodeFSP.rename(staging, final),
          catch: io("export-web", final),
        });
      else {
        // The hash is the folder's name, so an existing one is the same build
        // unless it was damaged: then it is replaced, never served.
        const there = yield* Effect.promise(() => readWebBuild(final));
        if (!("problem" in there) && there.buildId === hashed.buildId)
          yield* Effect.promise(() => NodeFSP.rm(staging, { recursive: true, force: true }));
        else yield* publishFolder("export-web", staging, final);
      }
      const prior = yield* readSelectedBuild(root).pipe(Effect.orElseSucceed(() => null));
      const previous =
        prior !== null && prior.directory !== directory ? prior.directory : prior?.previous;
      const selected: SelectedWebBuild = {
        buildId: hashed.buildId,
        directory,
        sourceId,
        entry: "index.html",
        ...(previous === undefined ? {} : { previous }),
      };
      yield* writeAtomic(
        NodePath.join(root, SELECTED_BUILD_FILE),
        `${encodeSelectedBuild(selected)}\n`,
        "export-web",
      );
      yield* pruneCandidates(root, previous === undefined ? [directory] : [directory, previous]);
      return { ok: true, path: NodePath.join(final, "index.html") } as const;
    });

  const runExport = Effect.fnUntraced(function* (root: string, target: GameExportTarget) {
    const { backend, ctx } = yield* engines.context(root);
    const { profile } = backend;
    if (!profile.exportTargets.includes(target))
      return yield* new GameOperationError({
        operation: `${profile.displayName} export`,
        path: root,
        reason: "invalid-input",
        detail: `${profile.displayName} games export ${profile.exportTargets.join(", ")} only; ${target} is refused for this engine.`,
      });
    yield* buildPathsInGame(root);
    yield* sweepLeftovers(root);
    const operation = `export-${target.toLowerCase()}`;
    const work = Effect.gen(function* () {
      yield* backend.exportReady(ctx.binary, target);
      // Import first: Godot's import writes engine-generated sidecars (*.import,
      // *.uid and .godot/) inside the project. The source identity is taken after
      // that import, so the release never sees them change under it.
      const imported = (yield* backend.importProject(ctx)).result;
      if (!imported.success) return imported;
      // The preset is part of the exported sources, so it is settled before the
      // source identity is taken.
      const preset = yield* backend.exportPreset(ctx, target);
      const presetNote = preset.added ? [`A standard ${target} export preset was added.`] : [];
      if (target === "Web") {
        // Web builds stage under the candidate root, never in the served tree,
        // so a partial or failed export cannot change what Play loads.
        const candidates = NodePath.join(root, CANDIDATE_BUILDS_DIRECTORY);
        yield* Effect.tryPromise({
          try: () => NodeFSP.mkdir(candidates, { recursive: true }),
          catch: io(operation, candidates),
        });
        const released = yield* releaseTo(backend, ctx, {
          target,
          preset: preset.name,
          operation,
          stagingParent: candidates,
          identify: identify(root, ctx.projectName, backend.profile.derivedInput),
          publish: (staging, _artifact, sourceId) =>
            publishCandidate(root, ctx.projectName, staging, sourceId),
        });
        if (released.kind === "failed") return released.result;
        if (!released.published.ok)
          return {
            ...released.result,
            success: false,
            path: null,
            message: released.published.message,
          };
        return { ...released.result, path: released.published.path, message: WEB_READY_MESSAGE };
      }
      const destination = NodePath.join(root, releaseDirectory(target));
      const released = yield* releaseTo(backend, ctx, {
        target,
        preset: preset.name,
        operation,
        stagingParent: NodePath.dirname(destination),
        identify: identify(root, ctx.projectName, backend.profile.derivedInput),
        publish: (staging, artifact) =>
          Effect.map(publishFolder(operation, staging, destination), (published) => ({
            path: NodePath.join(destination, artifact),
            notes: published.notes,
          })),
      });
      if (released.kind === "failed") return released.result;
      return {
        ...released.result,
        path: released.published.path,
        message: [...released.notes, ...presetNote, ...released.published.notes].join(" "),
      };
    });
    // One hold for import and release where the engine has a live editor:
    // another game cannot take the editor between them. A failure the game's
    // own files cause (an editor that will not open the project for its
    // compile errors) is the export's result, never an error about the export.
    return yield* (backend.editor === null ? work : backend.editor.hold(root)(work)).pipe(
      Effect.catchTags({
        GameOperationError: (error) =>
          gameOperationFault(error.reason) === "build"
            ? Effect.succeed<GameActionResult>({
                success: false,
                message: `${error.operation}: ${error.detail ?? error.reason}`.slice(0, 4096),
                path: null,
                url: null,
                process: null,
              })
            : Effect.fail(error),
      }),
    );
  });

  /**
   * The build Play should show: the selected one while its immutable directory
   * still hashes to its recorded id, otherwise a pre-change builds/web game, or
   * null when the game has never been built.
   */
  /**
   * A selection record that does not decode is no usable selection: Play and
   * status say so and offer Rebuild, which writes a fresh one. Only
   * `selected()`'s own callers get the typed refusal.
   */
  const usableSelection = (root: string) =>
    readSelectedBuild(root).pipe(
      Effect.catchTags({
        GameOperationError: (error) =>
          error.reason === "invalid-project"
            ? Effect.succeed("damaged" as const)
            : Effect.fail(error),
      }),
    );

  // Play re-proves a build's bytes before serving it, but only reads them when
  // a file's stat identity moved since the last proof: an unchanged build of
  // thousands of files is not hashed on every Play.
  const proven = new Map<string, { readonly identity: string; readonly buildId: string }>();
  const servedIntact = (root: string, selected: SelectedWebBuild) =>
    Effect.promise(async () => {
      const directory = NodePath.join(root, selected.directory);
      const identity = await webBuildStatIdentity(directory);
      if (identity === null) return false;
      const known = proven.get(directory);
      if (known !== undefined && known.identity === identity)
        return known.buildId === selected.buildId;
      const hashed = await hashWebBuild(root, selected.directory);
      if (hashed === null) return false;
      if (proven.size > 64) proven.clear();
      proven.set(directory, { identity, buildId: hashed.buildId });
      return hashed.buildId === selected.buildId;
    });

  const selectedPreview = (root: string) =>
    Effect.gen(function* () {
      const read = yield* usableSelection(root);
      // A broken selected record must rebuild, not silently serve something else.
      if (read === "damaged") return null;
      const selected = read;
      if (selected !== null) {
        if (yield* servedIntact(root, selected))
          return {
            directory: selected.directory,
            selected,
            url: yield* preview.select(root, selected.directory),
          };
        return null;
      }
      // Only a game with no selection may fall back to a pre-change build.
      if ((yield* exists(NodePath.join(root, WEB_BUILD_DIRECTORY, "index.html"))) !== null)
        return {
          directory: WEB_BUILD_DIRECTORY,
          selected: null,
          url: yield* preview.select(root, WEB_BUILD_DIRECTORY),
        };
      return null;
    });

  const publishWeb = (root: string) =>
    Effect.gen(function* () {
      const exported = yield* runExport(root, "Web");
      if (!exported.success) return exported;
      const served = yield* selectedPreview(root);
      return served === null
        ? exported
        : { ...exported, message: WEB_READY_MESSAGE, url: served.url };
    });

  const profileOf = (root: string) =>
    Effect.flatMap(projects.read(root), (manifest) =>
      Effect.map(engines.backendFor(manifest.engine.name), (backend) => backend.profile),
    );

  const releases = Effect.fn("GameExport.releases")(function* (root: string) {
    const profile = yield* profileOf(root);
    const found: GameRelease[] = [];
    const iso = (date: Date) => DateTime.formatIso(DateTime.fromDateUnsafe(date));
    for (const release of profile.releases) {
      const shape = { packageable: release.packageable, ships: release.ships };
      if (release.artifact !== null) {
        const stat = yield* exists(NodePath.join(root, release.artifact));
        if (stat !== null && stat.isFile() && stat.size > 0)
          found.push({
            target: release.target,
            path: release.artifact,
            updatedAt: iso(stat.mtime),
            ...shape,
          });
        continue;
      }
      // Web: the selection Play serves, dated by when it was selected; with
      // none, a build from before selections existed.
      const selected = yield* readSelectedBuild(root).pipe(Effect.orElseSucceed(() => null));
      const recorded = yield* exists(NodePath.join(root, SELECTED_BUILD_FILE));
      if (selected !== null && recorded !== null) {
        found.push({
          target: release.target,
          path: `${selected.directory}/${selected.entry}`,
          updatedAt: iso(recorded.mtime),
          ...shape,
        });
        continue;
      }
      const legacy = yield* exists(NodePath.join(root, WEB_BUILD_DIRECTORY, "index.html"));
      if (legacy !== null)
        found.push({
          target: release.target,
          path: `${WEB_BUILD_DIRECTORY}/index.html`,
          updatedAt: iso(legacy.mtime),
          ...shape,
        });
    }
    return found;
  });

  /** A package refusal for a release this engine does not package, worded from its profile. */
  const unpackaged = (root: string, target: GameExportTarget, operation: string) =>
    Effect.gen(function* () {
      const profile = yield* profileOf(root);
      const release = profile.releases.find((each) => each.target === target);
      if (release?.packageable === true) return;
      return yield* new GameOperationError({
        operation,
        path: NodePath.join(
          root,
          target === "Web" ? WEB_BUILD_DIRECTORY : releaseDirectory(target),
        ),
        reason: "invalid-input",
        detail:
          release === undefined
            ? `${profile.displayName} games make no ${target} release, so there is nothing to package.`
            : `A ${profile.displayName} ${target} release is the whole ${releaseDirectory(target)} folder; Kurambit does not package it. Ship that folder as it is.`,
      });
    });

  return GameExport.of({
    export: (threadId, target) =>
      projects.exclusive(threadId, `Export ${target}`, (root) => runExport(root, target)),
    publishWeb,
    serve: (root) =>
      Effect.gen(function* () {
        const selected = yield* usableSelection(root);
        const served = yield* selectedPreview(root);
        if (served !== null)
          return {
            success: true,
            message: "Loaded the selected web build.",
            path: NodePath.join(root, served.directory, "index.html"),
            url: served.url,
            process: null,
          };
        if (selected !== null)
          return {
            success: false,
            message:
              selected === "damaged"
                ? "The record of the build Play serves is damaged. Rebuild to export the current sources and select them."
                : "The selected build is unavailable: its served files are missing or changed. Rebuild to export the current sources.",
            path: null,
            url: null,
            process: null,
          };
        return null;
      }),
    selected: readSelectedBuild,
    releases,
    exportTargets: (root) =>
      Effect.map(profileOf(root), (profile) => ({
        targets: profile.exportTargets,
        displayName: profile.displayName,
      })),
    packageWindows: (threadId) =>
      projects.exclusive(threadId, "Package Windows build", (root) =>
        Effect.gen(function* () {
          // Packaging reads files only, so it never resolves the engine's executable.
          yield* unpackaged(root, "Windows", "Package Windows build");
          yield* buildPathsInGame(root);
          const packaged = yield* Effect.tryPromise({
            try: (signal) => packageWindowsRelease({ root, signal }),
            catch: (cause) =>
              cause instanceof WindowsPackageError
                ? new GameOperationError({
                    operation: "Package Windows build",
                    path: cause.path,
                    reason:
                      cause.kind === "missing" ||
                      cause.kind === "invalid" ||
                      cause.kind === "changed"
                        ? "invalid-input"
                        : "io",
                    detail: cause.message,
                    cause,
                  })
                : new GameOperationError({
                    operation: "Package Windows build",
                    path: NodePath.join(root, "builds/windows/game.exe"),
                    reason: "io",
                    detail:
                      cause instanceof Error
                        ? cause.message
                        : "The Windows package could not be created.",
                    cause,
                  }),
          });
          const relative = NodePath.relative(root, packaged.archivePath)
            .split(NodePath.sep)
            .join("/");
          return {
            archivePath: packaged.archivePath,
            fileName: packaged.fileName,
            bytes: packaged.bytes,
            sha256: packaged.sha256,
            files: packaged.files.map((file) => ({
              name: file.name,
              bytes: file.bytes,
              sha256: file.sha256,
            })),
            embeddedPck: packaged.embeddedPck,
            executableBytes: packaged.executableBytes,
            pckBytes: packaged.pckBytes,
            pckFileCount: packaged.pckFileCount,
            notes: [
              ...packaged.notes,
              `The ZIP contains the existing checked release files (${packaged.files.map((file) => file.name).join(" and ")}), not a new export. This machine did not run it on Windows.`,
            ],
            message: `Windows package ready at ${relative} (${Math.round(packaged.bytes / (1024 * 1024))} MB).`,
          };
        }),
      ),
    webExportUrl: (threadId) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        const served = yield* selectedPreview(root);
        if (served === null)
          return yield* new GameOperationError({
            operation: "Open Web export",
            path: NodePath.join(root, WEB_BUILD_DIRECTORY),
            reason: "invalid-input",
            detail: "There is no finished Web export to open. Export Web first.",
          });
        return served.url;
      }),
    packageWeb: (threadId) =>
      projects.exclusive(threadId, "Package Web build", (root) =>
        Effect.gen(function* () {
          yield* unpackaged(root, "Web", "Package Web build");
          yield* buildPathsInGame(root);
          const selected = yield* readSelectedBuild(root);
          if (selected === null)
            return yield* new GameOperationError({
              operation: "Package Web build",
              path: NodePath.join(root, WEB_BUILD_DIRECTORY),
              reason: "invalid-input",
              detail:
                "No Web export is selected, so there is no build to package. Export Web first (Export… in the Stage's More menu); packaging never exports and never packages a draft, legacy or unselected build.",
            });
          // Packaging is a byte operation on the selected artifact. Comparing
          // editable sources would walk and hash up to a gigabyte of art for a
          // note, and a download must not pay that cost, so the wording below
          // never claims the sources are current.
          const packaged = yield* Effect.tryPromise({
            try: (signal) => packageWebRelease({ root, selected, signal }),
            catch: (cause) =>
              cause instanceof WebPackageError
                ? new GameOperationError({
                    operation: "Package Web build",
                    path: cause.path,
                    reason:
                      cause.kind === "missing" ||
                      cause.kind === "invalid" ||
                      cause.kind === "changed"
                        ? "invalid-input"
                        : "io",
                    detail: cause.message,
                    cause,
                  })
                : new GameOperationError({
                    operation: "Package Web build",
                    path: NodePath.join(root, WEB_PACKAGES_DIRECTORY),
                    reason: "io",
                    detail:
                      cause instanceof Error
                        ? cause.message
                        : "The Web package could not be created.",
                    cause,
                  }),
          });
          const relative = NodePath.relative(root, packaged.archivePath)
            .split(NodePath.sep)
            .join("/");
          const build = selected.buildId.slice(0, 12);
          const sourceNote = `The ZIP is the selected Web build Play serves (${build}); it contains those fixed bytes only, and later source edits are not included. Packaging does not compare them.`;
          return {
            archivePath: packaged.archivePath,
            fileName: packaged.fileName,
            buildId: packaged.buildId,
            bytes: packaged.bytes,
            sha256: packaged.sha256,
            files: packaged.files,
            entry: packaged.entry,
            sourceEntry: packaged.sourceEntry,
            notes: [
              ...packaged.notes,
              sourceNote,
              "Serve the extracted files from an ordinary static HTTP host; opening index.html through file:// is not a supported play path because WebAssembly needs HTTP.",
            ],
            message: `Web package ready at ${relative} (${Math.round(packaged.bytes / (1024 * 1024))} MB) for selected build ${build}.`,
          };
        }),
      ),
  });
});

export const layer = Layer.effect(GameExport, make);
