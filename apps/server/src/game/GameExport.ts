// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem boundary of exports and their packages.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  GameOperationError,
  type GameActionResult,
  type GameWebPackage,
  type GameWindowsPackage,
} from "@kurambit/contracts";
import { commandDetail } from "./commandDetail.ts";
import * as GameEngine from "./GameEngine.ts";
import type { GameExportTarget } from "./engineProfile.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { comparedSource, snapshotBuildSource } from "./sourceSnapshot.ts";
import {
  CANDIDATE_BUILDS_DIRECTORY,
  WEB_BUILD_DIRECTORY,
  candidateBuildDirectory,
  describeWebArtifacts,
  hashWebBuild,
  hashWebBuildDirectory,
} from "./webBuild.ts";
import { inspectWindowsBuild, type WindowsBuildInspection } from "./windowsExport.ts";
import { publishWindowsBuild } from "./windowsPublication.ts";
import { packageWebRelease, WebPackageError } from "./webPackage.ts";
import {
  packageWindowsRelease,
  retireWindowsArchive,
  WindowsPackageError,
  windowsPackageArchivePath,
} from "./windowsPackage.ts";

/** Short confirmation the creator reads after an export lands. */
const WEB_READY_MESSAGE = "Web game is ready to play. Open it with Play.";

/** The build Play serves, written at each Web export. */
const SelectedWebBuild = Schema.Struct({
  buildId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  directory: Schema.String.check(Schema.isMinLength(1)),
  sourceId: Schema.NullOr(Schema.String),
  entry: Schema.String.check(Schema.isMinLength(1)),
});
interface SelectedWebBuild extends Schema.Schema.Type<typeof SelectedWebBuild> {}
const decodeSelectedBuild = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.NullOr(SelectedWebBuild)),
);
const encodeSelectedBuild = Schema.encodeSync(Schema.fromJsonString(SelectedWebBuild));

/**
 * Release exports, the Web build Play serves, and the packages made from
 * them. The engine's backend makes each release; this service stages,
 * checks, hashes and publishes it. Callers hold the game's operation lock.
 */
export class GameExport extends Context.Service<
  GameExport,
  {
    readonly export: (
      root: string,
      target: GameExportTarget,
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    /** Builds and publishes the current sources, then serves that build. */
    readonly publishWeb: (root: string) => Effect.Effect<GameActionResult, GameOperationError>;
    /** Serves the selected Web build, building one only when none was ever selected. */
    readonly play: (root: string) => Effect.Effect<GameActionResult, GameOperationError>;
    /** The Web build Play serves, as its export recorded it. */
    readonly selected: (root: string) => Effect.Effect<SelectedWebBuild | null>;
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
  const snapshot = (root: string, project: string) =>
    Effect.promise((signal) => snapshotBuildSource(root, project, { signal }));
  const SELECTED_BUILD_FILE = "builds/web-selected.json";
  const readSelectedBuild = (root: string): Effect.Effect<SelectedWebBuild | null> =>
    Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(root, SELECTED_BUILD_FILE), "utf8")
        .then((text) => decodeSelectedBuild(text))
        .catch(() => null),
    );
  const writeSelectedBuild = (
    root: string,
    selected: SelectedWebBuild,
  ): Effect.Effect<void, GameOperationError> =>
    Effect.tryPromise({
      try: () =>
        NodeFSP.writeFile(
          NodePath.join(root, SELECTED_BUILD_FILE),
          `${encodeSelectedBuild(selected)}\n`,
        ),
      catch: (cause) =>
        new GameOperationError({
          operation: "export",
          path: NodePath.join(root, SELECTED_BUILD_FILE),
          reason: "io",
          cause,
        }),
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
    // A player folder is the engine's own build; Web is never a player target.
    if (backend.player !== null && target !== "Web")
      return yield* backend.player.export(ctx, target);
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
    // Web exports stage in a hidden directory under the candidate root, never in
    // the served tree. A partial or failed export therefore cannot change what
    // Play loads; only a complete, hashed artifact is moved into place.
    const staging =
      target === "Web"
        ? NodePath.join(root, CANDIDATE_BUILDS_DIRECTORY, `.staging-${NodeCrypto.randomUUID()}`)
        : null;
    const windowsOutput =
      target === "Windows" ? NodePath.join(root, "builds/windows/game.exe") : null;
    // A failed Windows export must leave the previous game.exe usable, so the
    // engine writes beside it and the artifact is moved into place only after
    // its PE and pack check out.
    const windowsStaging =
      windowsOutput === null
        ? null
        : NodePath.join(NodePath.dirname(windowsOutput), `.game-${NodeCrypto.randomUUID()}.exe`);
    const output =
      staging !== null
        ? NodePath.join(staging, "index.html")
        : (windowsOutput ?? NodePath.join(root, "builds/linux/game.x86_64"));
    const exportOutput = windowsStaging ?? output;
    const cleanedUp = Effect.ensuring(
      Effect.promise(async () => {
        if (staging !== null) await NodeFSP.rm(staging, { recursive: true, force: true });
        if (windowsStaging !== null) {
          await NodeFSP.rm(windowsStaging, { force: true });
          await NodeFSP.rm(windowsStaging.replace(/\.exe$/, ".pck"), { force: true });
        }
      }),
    );
    return yield* Effect.gen(function* () {
      const before = yield* snapshot(root, ctx.projectName);
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(NodePath.dirname(exportOutput), { recursive: true }),
        catch: (cause) =>
          new GameOperationError({ operation: "export", path: exportOutput, reason: "io", cause }),
      });
      const exportResult = yield* backend.runExportRelease(ctx, {
        preset: preset.name,
        outputPath: exportOutput,
        operation: `export-${target.toLowerCase()}`,
      });
      // The engine writes beside the previous build; the reported path is the
      // published artifact the inspection below moves into place.
      const result =
        windowsOutput !== null ? { ...exportResult, path: windowsOutput } : exportResult;
      if (!result.success) return result;
      const expectedFiles =
        target === "Web"
          ? (profile.web?.exported ?? []).map((name) => NodePath.join(staging!, name))
          : [exportOutput];
      yield* Effect.tryPromise({
        try: async () => {
          for (const file of expectedFiles) {
            const stat = await NodeFSP.stat(file);
            if (!stat.isFile() || stat.size === 0) throw new Error(`Empty export: ${file}`);
          }
        },
        catch: (cause) =>
          new GameOperationError({
            operation: "export-output",
            path: exportOutput,
            reason: "command-failed",
            detail:
              `Expected nonempty export files were missing.\n${commandDetail(result.process!)}`.slice(
                -4096,
              ),
            cause,
          }),
      });
      let windowsMessage: string | null = null;
      let checkedWindows: {
        readonly inspection: WindowsBuildInspection;
        readonly stagedPck: string;
      } | null = null;
      if (windowsOutput !== null && windowsStaging !== null) {
        const stagedPck = windowsStaging.replace(/\.exe$/, ".pck");
        const inspection = yield* Effect.tryPromise({
          try: async () => {
            const executable = await NodeFSP.readFile(windowsStaging);
            const pck = await NodeFSP.readFile(stagedPck).catch(() => null);
            return await inspectWindowsBuild({ executable, pck });
          },
          catch: (cause) =>
            new GameOperationError({
              operation: "export-windows",
              path: windowsStaging,
              reason: "command-failed",
              detail: "The exported Windows executable could not be read back.",
              cause,
            }),
        });
        if (inspection.issues.length > 0)
          return {
            ...result,
            success: false,
            message:
              `The Windows export did not produce a usable x86_64 executable with the game's pack: ${inspection.issues.join(" ")}\n${commandDetail(result.process!)}`.slice(
                -4096,
              ),
          };
        checkedWindows = { inspection, stagedPck };
      }
      // Hash the staged artifact before it becomes visible. The hash is the
      // directory name, so an immutable build can never be overwritten later
      // with different bytes under the same identity.
      const hashed =
        staging === null ? null : yield* Effect.promise(() => hashWebBuildDirectory(staging));
      if (target === "Web" && hashed === null)
        return {
          ...result,
          success: false,
          message: "The exported web build directory could not be read back.",
        };
      // Prove the game folder did not change while the export ran: an edit
      // during the export means the build no longer describes the sources.
      const comparison = comparedSource(before, yield* snapshot(root, ctx.projectName), "export");
      if (comparison.kind !== "current") {
        const detail = comparison.detail;
        return {
          ...result,
          success: false,
          message: `${detail}\n${commandDetail(result.process!)}`.slice(-4096),
        };
      }
      // The checked artifact stays staged until the source comparison accepts
      // it. Only then may it replace a build the creator already had.
      if (windowsOutput !== null && windowsStaging !== null && checkedWindows !== null) {
        const { inspection, stagedPck } = checkedWindows;
        const publication = yield* Effect.tryPromise({
          try: async () => {
            const retirement = await retireWindowsArchive({
              archive: windowsPackageArchivePath(root),
            });
            try {
              const published = await publishWindowsBuild({
                stagedExecutable: windowsStaging,
                stagedPck: inspection.embeddedPck ? null : stagedPck,
                executable: windowsOutput,
                pck: windowsOutput.replace(/\.exe$/, ".pck"),
              });
              const retirementNotes = retirement === null ? [] : await retirement.discard();
              return { ...published, notes: [...published.notes, ...retirementNotes] };
            } catch (cause) {
              if (retirement !== null) await retirement.restore();
              throw cause;
            }
          },
          catch: (cause) =>
            new GameOperationError({
              operation: "export-windows",
              path: windowsOutput,
              reason: "io",
              detail:
                cause instanceof Error
                  ? cause.message
                  : "The checked Windows build could not be moved into builds/windows.",
              cause,
            }),
        });
        windowsMessage =
          (inspection.embeddedPck
            ? `Windows x86_64 build ready at builds/windows/game.exe with its game data embedded (${Math.round(inspection.executableBytes / (1024 * 1024))} MB).`
            : `Windows x86_64 build ready at builds/windows/game.exe with builds/windows/game.pck beside it (${Math.round(inspection.executableBytes / (1024 * 1024))} MB). Keep both files together.`) +
          (preset.added ? " A standard Windows export preset was added." : "") +
          (publication.notes.length === 0 ? "" : ` ${publication.notes.join(" ")}`) +
          " This machine did not run it on Windows.";
      }
      const directory = hashed === null ? null : candidateBuildDirectory(hashed.buildId);
      if (hashed !== null && directory !== null) {
        const final = NodePath.join(root, directory);
        const existing = yield* Effect.promise(() =>
          NodeFSP.stat(NodePath.join(final, "index.html")).then(
            () => true,
            () => false,
          ),
        );
        const staged = staging!;
        const same =
          existing &&
          (yield* Effect.promise(() => hashWebBuildDirectory(final)))?.buildId === hashed.buildId;
        if (same) yield* Effect.promise(() => NodeFSP.rm(staged, { recursive: true, force: true }));
        else {
          // A directory under our own hash that does not hash to it is
          // corruption; replace it rather than serve bytes the id did not name.
          if (existing)
            yield* Effect.promise(() => NodeFSP.rm(final, { recursive: true, force: true }));
          yield* Effect.promise(() => NodeFSP.rename(staged, final));
        }
      }
      // The record names every served file, not just index.html: a deleted or
      // replaced .pck must force a rebuild before anyone plays it.
      const artifacts =
        directory === null
          ? null
          : yield* Effect.promise(() => describeWebArtifacts(root, directory));
      if (target === "Web" && (artifacts === null || hashed === null || directory === null))
        return {
          ...result,
          success: false,
          message: "The exported web build directory could not be read back.",
        };
      if (hashed !== null && directory !== null) {
        const after = yield* snapshot(root, ctx.projectName);
        const selected: SelectedWebBuild = {
          buildId: hashed.buildId,
          directory,
          sourceId: after !== null && after.kind === "known" ? after.sourceId : null,
          entry: "index.html",
        };
        yield* writeSelectedBuild(root, selected);
        return {
          ...result,
          path: NodePath.join(root, directory, "index.html"),
          message: WEB_READY_MESSAGE,
        };
      }
      return windowsMessage === null
        ? result
        : { ...result, path: windowsOutput ?? result.path, message: windowsMessage };
    }).pipe(cleanedUp);
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
      }
      // Only a game with no selection may fall back to a pre-change build; a
      // broken selected record must rebuild, not silently serve something else.
      if (selected !== null) return null;
      const legacy = yield* Effect.promise(() =>
        NodeFSP.stat(NodePath.join(root, WEB_BUILD_DIRECTORY, "index.html")).then(
          () => true,
          () => false,
        ),
      );
      if (legacy)
        return {
          directory: WEB_BUILD_DIRECTORY,
          selected: null,
          url: yield* preview.select(root, WEB_BUILD_DIRECTORY),
        };
      return null;
    });
  /** Builds and publishes the current sources, then serves that build. */
  const publishWeb = (root: string) =>
    Effect.gen(function* () {
      const exported = yield* runExport(root, "Web");
      if (!exported.success) return exported;
      const served = yield* selectedPreview(root);
      return served === null
        ? exported
        : {
            ...exported,
            message: WEB_READY_MESSAGE,
            url: served.url,
          };
    });
  return GameExport.of({
    export: runExport,
    publishWeb,
    play: (root) =>
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
              "The selected build is unavailable: its served files are missing or empty. Rebuild to export the current sources.",
            path: null,
            url: null,
            process: null,
          };
        return yield* publishWeb(root);
      }),
    selected: readSelectedBuild,
    packageWindows: (root) =>
      Effect.gen(function* () {
        // Packaging reads files only, so it never resolves the engine's executable.
        const backend = yield* engines.backendFor((yield* projects.read(root)).engine.name);
        if (backend.player !== null)
          return yield* new GameOperationError({
            operation: "Package Windows build",
            path: NodePath.join(root, "builds/windows"),
            reason: "invalid-input",
            detail: `Windows packaging reads a Godot executable and pack. A ${backend.profile.displayName} Windows build is the whole builds/windows folder; zip that folder to ship it.`,
          });
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
                  path: NodePath.join(root, "builds/web-packages"),
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
