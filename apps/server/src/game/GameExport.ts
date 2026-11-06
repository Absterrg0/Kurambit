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
  type GameActionResult,
  type GameStatus,
  type GameWebPackage,
  type GameWindowsPackage,
} from "@kurambit/contracts";
import { ArchivePublishError, publishStaged, sweepPublished } from "./archivePublication.ts";
import { commandDetail } from "./commandDetail.ts";
import * as GameEngine from "./GameEngine.ts";
import type { GameExportTarget } from "./engineProfile.ts";
import { makeAtomicWriter } from "./gameFiles.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { comparedSource, snapshotBuildSource } from "./sourceSnapshot.ts";
import {
  CANDIDATE_BUILDS_DIRECTORY,
  WEB_BUILD_DIRECTORY,
  candidateBuildDirectory,
  hashWebBuild,
  readWebBuild,
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
export const decodeSelectedBuild = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.NullOr(SelectedWebBuild)),
);
const encodeSelectedBuild = Schema.encodeSync(Schema.fromJsonString(SelectedWebBuild));

const SELECTED_BUILD_FILE = "builds/web-selected.json";

/** One release a game has, as the status and the Builds panel show it. */
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
  | { readonly kind: "failed"; readonly result: GameActionResult },
  GameOperationError
> => {
  const { root, projectName } = ctx;
  const snapshot = Effect.promise((signal) =>
    snapshotBuildSource(root, projectName, { signal, rules: backend.profile.buildInputs }),
  );
  const staging = NodePath.join(
    input.stagingParent,
    `.release-${input.target.toLowerCase()}-${NodeCrypto.randomUUID()}`,
  );
  const notCurrent = (detail: string, process: GameActionResult["process"]) =>
    ({
      kind: "failed",
      result: {
        success: false,
        message: (process === null ? detail : `${detail}\n${commandDetail(process)}`).slice(-4096),
        path: null,
        url: null,
        process,
      },
    }) as const;
  return Effect.gen(function* () {
    // An unidentifiable tree is refused before the engine runs: the result
    // could never be attached to the sources (too many files, a link).
    const before = yield* snapshot;
    if (before.kind === "unknown") {
      const refused = comparedSource(before, before, input.operation);
      return notCurrent(refused.kind === "current" ? "" : refused.detail, null);
    }
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
    const comparison = comparedSource(before, yield* snapshot, input.operation);
    if (comparison.kind !== "current") return notCurrent(comparison.detail, release.result.process);
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
    /** success ⇒ `path` is the absolute published artifact; a build's own failure is success:false. */
    readonly export: (
      root: string,
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
      root: string,
    ) => Effect.Effect<GameWindowsPackage, GameOperationError>;
    /**
     * Packages the exact immutable Web build Play currently serves as a
     * static-host ZIP. It never exports and never chooses another build.
     */
    readonly packageWeb: (root: string) => Effect.Effect<GameWebPackage, GameOperationError>;
  }
>()("kurambit/game/GameExport") {}

const make = Effect.gen(function* () {
  const engines = yield* GameEngine.GameEngine;
  const preview = yield* GamePreview.GamePreview;
  const projects = yield* GameProjectService.GameProjectService;
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
              try: () => decodeSelectedBuild(text),
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
    yield* sweepLeftovers(root);
    const operation = `export-${target.toLowerCase()}`;
    const work = Effect.gen(function* () {
      yield* backend.exportReady(ctx.binary, target);
      // Import first: Godot's import writes engine-generated sidecars (*.import,
      // *.uid and .godot/) inside the project. The source identity is taken after
      // that import and never counts those files, so a fresh tree imports
      // cleanly and a snapshot never carries engine output.
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
    // another game cannot take the editor between them.
    return yield* backend.editor === null ? work : backend.editor.hold(root)(work);
  });

  /**
   * The build Play should show: the selected one while its immutable directory
   * still hashes to its recorded id, otherwise a pre-change builds/web game, or
   * null when the game has never been built.
   */
  const selectedPreview = (root: string) =>
    Effect.gen(function* () {
      const selected = yield* readSelectedBuild(root);
      if (selected !== null) {
        const hashed = yield* Effect.promise(() => hashWebBuild(root, selected.directory));
        if (hashed !== null && hashed.buildId === selected.buildId)
          return {
            directory: selected.directory,
            selected,
            url: yield* preview.select(root, selected.directory),
          };
        // A broken selected record must rebuild, not silently serve something else.
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
    export: runExport,
    publishWeb,
    serve: (root) =>
      Effect.gen(function* () {
        const selected = yield* readSelectedBuild(root);
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
              "The selected build is unavailable: its served files are missing or changed. Rebuild to export the current sources.",
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
    packageWindows: (root) =>
      Effect.gen(function* () {
        // Packaging reads files only, so it never resolves the engine's executable.
        yield* unpackaged(root, "Windows", "Package Windows build");
        const packaged = yield* Effect.tryPromise({
          try: (signal) => packageWindowsRelease({ root, signal }),
          catch: (cause) =>
            cause instanceof WindowsPackageError
              ? new GameOperationError({
                  operation: "Package Windows build",
                  path: cause.path,
                  reason:
                    cause.kind === "missing" || cause.kind === "invalid" || cause.kind === "changed"
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
    packageWeb: (root) =>
      Effect.gen(function* () {
        yield* unpackaged(root, "Web", "Package Web build");
        const selected = yield* readSelectedBuild(root);
        if (selected === null)
          return yield* new GameOperationError({
            operation: "Package Web build",
            path: NodePath.join(root, WEB_BUILD_DIRECTORY),
            reason: "invalid-input",
            detail:
              "No Web build is selected for Play, so there is no build to package. Build & play the game first; packaging never exports and never packages a draft, legacy or unselected build.",
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
                    cause.kind === "missing" || cause.kind === "invalid" || cause.kind === "changed"
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
  });
});

export const layer = Layer.effect(GameExport, make);
