// @effect-diagnostics nodeBuiltinImport:off -- This backend owns the native Godot process boundary: scripts, args, output parsing.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  GameOperationError,
  type GameActionResult,
  type GameCheckIssue,
  type GameProcessResult,
  manifestProject,
} from "@kurambit/contracts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameToolchain from "./GameToolchain.ts";
import { insideGame } from "./GameProjectService.ts";
import { commandDetail } from "./commandDetail.ts";
import { GODOT_CHECK_SCRIPT } from "./godotCheckScript.ts";
import { GODOT_PLAY_RUNNER } from "./godotPlayRunner.ts";
import {
  nativeUserIsolationAt,
  prepareNativeUserIsolation,
  userDirConfigIssues,
} from "./gameNativeUserDir.ts";
import { RawCheckResult, parseGodotIssues } from "./godotCheckOutput.ts";
import { parseGodotViewport } from "./godotViewport.ts";
import type { GameEngineBackend, GameEngineContext } from "./GameEngine.ts";
import { GODOT_PROFILE } from "./godotProfile.ts";
import { planWindowsPreset } from "./windowsPreset.ts";
import { inspectWindowsBuildFiles } from "./windowsExport.ts";
import { OFFSCREEN_POSITION } from "./windowHost.ts";
import { HOST_OS } from "./processHost.ts";

/** The CFBundleIdentifier of the macOS app bundle an executable lives in; null outside one. */
const macBundleId = async (executable: string): Promise<string | null> => {
  const at = executable.lastIndexOf(".app/Contents/MacOS/");
  if (at < 0) return null;
  const plist = await NodeFSP.readFile(
    `${executable.slice(0, at)}.app/Contents/Info.plist`,
    "utf8",
  ).catch(() => "");
  return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
};

const decodeCheckResult = Schema.decodeUnknownSync(RawCheckResult);

/**
 * Godot's one error reading, shared by import, export and the check: an
 * engine error line as `parseGodotIssues` reads it (exit chatter such as
 * leaked ObjectDB instances is not the game's failure), a non-zero exit or a
 * timeout. A game's own printed text containing "ERROR:" is not an error line.
 */
const response = (
  process: GameProcessResult,
  outputPath: string | null = null,
): { readonly result: GameActionResult; readonly issues: ReadonlyArray<GameCheckIssue> } => {
  const issues = parseGodotIssues(`${process.stdout}\n${process.stderr}`);
  const success = process.exitCode === 0 && !process.timedOut && issues.length === 0;
  return {
    result: {
      success,
      message: success
        ? "Completed successfully."
        : `Command failed${process.timedOut ? " after its timeout" : ` with exit code ${process.exitCode}`}. ${issues
            .slice(0, 8)
            .map((issue) => `${issue.file === "" ? "" : `${issue.file}: `}${issue.message}`)
            .join("\n")} See ${process.logPath}\n${commandDetail(process)}`,
      path: outputPath,
      url: null,
      process,
    },
    issues,
  };
};

/**
 * The Godot backend: every Godot process invocation this server makes for the
 * production import/check/export slice, plus the project-settings and output
 * parsing those invocations need. Source binding and stage order stay in
 * GameService; this module never reads game.json and never writes records.
 */
export const makeGodotBackend = (
  processes: GameProcesses.GameProcesses["Service"],
  tools: GameToolchain.GameToolchain["Service"],
  writeAtomic: (
    path: string,
    contents: string,
    operation: string,
  ) => Effect.Effect<void, GameOperationError>,
): GameEngineBackend => {
  const ensureWindowsPreset = (presetsPath: string) =>
    Effect.gen(function* () {
      const existing = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await NodeFSP.readFile(presetsPath, "utf8");
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw cause;
          }
        },
        catch: (cause) =>
          new GameOperationError({
            operation: "export-windows",
            path: presetsPath,
            reason: "io",
            cause,
          }),
      });
      const plan = planWindowsPreset(existing);
      if (!plan.ok)
        return yield* new GameOperationError({
          operation: "export-windows",
          path: presetsPath,
          reason: "invalid-input",
          detail: plan.detail,
        });
      // Atomic: a half-written preset would break every later export; a
      // preset the creator already wrote is never rewritten.
      if (plan.text !== null) yield* writeAtomic(presetsPath, plan.text, "export-windows");
      return plan;
    });
  const runExport = (
    ctx: GameEngineContext,
    preset: string,
    outputPath: string,
    operation: string,
  ) =>
    processes.run({
      root: ctx.root,
      executable: ctx.binary.path,
      args: ["--headless", "--path", ctx.projectDir, "--export-release", preset, outputPath],
      operation,
      timeoutMs: 300_000,
      env: GameProcesses.engineChildEnv(),
      envMode: "replace",
    });
  /** The non-empty files a release must have written, or the first one missing. */
  const missingFile = (files: ReadonlyArray<string>) =>
    Effect.promise(async () => {
      for (const file of files) {
        const stat = await NodeFSP.stat(file).catch(() => null);
        if (stat === null || !stat.isFile() || stat.size === 0) return file;
      }
      return null;
    });
  const release: GameEngineBackend["release"] = (ctx, input) =>
    Effect.gen(function* () {
      const { staging, target } = input;
      const artifact =
        target === "Web" ? "index.html" : target === "Windows" ? "game.exe" : "game.x86_64";
      const output = NodePath.join(staging, artifact);
      const run = yield* runExport(ctx, input.preset, output, input.operation);
      const exported = response(run, output);
      if (!exported.result.success) return { result: exported.result, artifact: null, notes: [] };
      const expected =
        target === "Web"
          ? (GODOT_PROFILE.web?.exported ?? []).map((name) => NodePath.join(staging, name))
          : [output];
      const missing = yield* missingFile(expected);
      if (missing !== null)
        return {
          result: {
            ...exported.result,
            success: false,
            message:
              `The ${target} export reported success but ${NodePath.basename(missing)} is missing or empty.\n${commandDetail(run)}`.slice(
                -4096,
              ),
          },
          artifact: null,
          notes: [],
        };
      if (target !== "Windows")
        return {
          result: exported.result,
          artifact,
          notes:
            target === "Linux"
              ? [
                  "Linux x86_64 build ready at builds/linux/game.x86_64 (keep game.pck beside it if the preset writes one).",
                ]
              : [],
        };
      // The PE and pack are read through file handles, never into memory: an
      // embedded pack makes the executable as large as the game.
      const inspection = yield* Effect.tryPromise({
        try: () =>
          inspectWindowsBuildFiles({
            executable: output,
            pck: NodePath.join(staging, "game.pck"),
          }),
        catch: (cause) =>
          new GameOperationError({
            operation: input.operation,
            path: output,
            reason: "io",
            detail: "The exported Windows executable could not be read back.",
            cause,
          }),
      });
      if (inspection.issues.length > 0)
        return {
          result: {
            ...exported.result,
            success: false,
            message:
              `The Windows export did not produce a usable x86_64 executable with the game's pack: ${inspection.issues.join(" ")}\n${commandDetail(run)}`.slice(
                -4096,
              ),
          },
          artifact: null,
          notes: [],
        };
      const megabytes = Math.round(inspection.executableBytes / (1024 * 1024));
      return {
        result: exported.result,
        artifact,
        notes: [
          inspection.embeddedPck
            ? `Windows x86_64 build ready at builds/windows/game.exe with its game data embedded (${megabytes} MB).`
            : `Windows x86_64 build ready at builds/windows/game.exe with builds/windows/game.pck beside it (${megabytes} MB). Keep both files together.`,
          "This machine did not run it on Windows.",
        ],
      };
    });
  const importProject: GameEngineBackend["importProject"] = (ctx) =>
    Effect.gen(function* () {
      // The editor's import runs the project's tool scripts and keeps logs under
      // user://: both go to scratch, never the user's real Godot data. The
      // folder holds nothing the import result needs, so it goes afterwards.
      const scratch = NodePath.join(
        ctx.root,
        "builds/logs",
        `godot-import-${NodeCrypto.randomUUID()}`,
      );
      const isolation = yield* Effect.tryPromise({
        try: () => prepareNativeUserIsolation(scratch),
        catch: (cause) =>
          new GameOperationError({ operation: "godot-import", path: scratch, reason: "io", cause }),
      });
      const run = yield* processes
        .run({
          root: ctx.root,
          executable: ctx.binary.path,
          args: ["--headless", "--path", ctx.projectDir, "--editor", "--import"],
          operation: "godot-import",
          timeoutMs: 180_000,
          env: GameProcesses.engineChildEnv(isolation.env),
          envMode: "replace",
        })
        .pipe(
          Effect.ensuring(
            Effect.promise(() =>
              NodeFSP.rm(scratch, { recursive: true, force: true }).catch(() => undefined),
            ),
          ),
        );
      return response(run);
    });
  /**
   * The play runner runs the real main scene from current sources (no
   * export) under a server-owned script in ignored builds/logs. The child
   * sees the allowlisted engine base plus software GL and a per-run XDG trio
   * (a kept session's stable one instead), so the project's scripts cannot
   * read server secrets and user:// stays in the isolation the runner checks
   * (see gameNativeUserDir for each OS). Without a window host it runs headless.
   */
  const playProcess: NonNullable<GameEngineBackend["playProcess"]> = (input) =>
    Effect.gen(function* () {
      const binary = yield* tools.executable("godot");
      const settings = NodePath.join(input.projectDir, "project.godot");
      const projectText = yield* Effect.promise(() =>
        NodeFSP.readFile(settings, "utf8").catch(() => ""),
      );
      const dirIssues = userDirConfigIssues(projectText);
      if (dirIssues.length > 0)
        return yield* new GameOperationError({
          operation: "Play session",
          path: settings,
          reason: "invalid-input",
          detail: dirIssues.join(" "),
        });
      const scriptPath = NodePath.join(input.scriptDir, "play.gd");
      const isolation = yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(input.scriptDir, { recursive: true });
          await NodeFSP.writeFile(scriptPath, GODOT_PLAY_RUNNER);
          return input.saves === null
            ? prepareNativeUserIsolation(input.traceDir)
            : nativeUserIsolationAt(input.saves);
        },
        catch: (cause) =>
          new GameOperationError({
            operation: "Play session",
            path: input.scriptDir,
            reason: "io",
            cause,
          }),
      });
      const env: NodeJS.ProcessEnv = {
        ...GameProcesses.engineChildEnv(),
        LIBGL_ALWAYS_SOFTWARE: "1",
        LP_NUM_THREADS: "2",
        ...isolation.env,
      };
      for (const name of GameProcesses.DISPLAY_VARIABLES) delete env[name];
      // Godot launched outside LaunchServices on macOS re-activates itself
      // through the Dock to get its window registered, which takes focus from
      // the user; with its bundle id in the environment it skips that.
      if (input.window === "offscreen" && HOST_OS === "darwin") {
        const bundleId = yield* Effect.promise(() => macBundleId(binary.path));
        if (bundleId !== null) env.__CFBundleIdentifier = bundleId;
      }
      const size = `${input.viewport.width}x${input.viewport.height}`;
      const runner = ["--path", input.projectDir, "--script", scriptPath, "--", input.requestPath];
      const window =
        input.window === "private-display"
          ? // Xvfb offers software GL only, which the Compatibility renderer runs on.
            ["--display-driver", "x11", "--rendering-method", "gl_compatibility"]
          : input.window === "offscreen"
            ? // The user's desktop and GPU: the project's own renderer, in a
              // window far off every monitor. Never minimized: a minimized
              // Godot window stops drawing.
              ["--windowed", "--position", `${OFFSCREEN_POSITION.x},${OFFSCREEN_POSITION.y}`]
            : ["--headless"];
      return {
        executable: binary.path,
        args: [...window, "--audio-driver", "Dummy", "--resolution", size, ...runner],
        env,
        cwd: input.projectDir,
        // Godot reports user:// with forward slashes on every OS.
        request: { expectedUserDataPrefix: isolation.dataDir.replaceAll("\\", "/") },
        scratch: [input.scriptDir],
        inputNote: "",
      };
    });
  return {
    profile: GODOT_PROFILE,
    resolveProject: (root, manifest) =>
      Effect.gen(function* () {
        const binary = yield* tools.executable("godot");
        return {
          binary,
          projectName: manifestProject(manifest),
          projectDir: insideGame(root, manifestProject(manifest)),
        };
      }),
    toolStatus: () =>
      Effect.map(
        tools.status(),
        (status) => status.tools.find((tool) => tool.tool === "godot") ?? null,
      ),
    viewport: (projectDir) =>
      Effect.tryPromise({
        try: () =>
          NodeFSP.readFile(NodePath.join(projectDir, "project.godot"), "utf8").catch(
            (cause: NodeJS.ErrnoException) => {
              // A project with no settings yet plays at Godot's own default.
              if (cause.code === "ENOENT") return "";
              throw cause;
            },
          ),
        catch: (cause) =>
          new GameOperationError({
            operation: "Read the project settings",
            path: NodePath.join(projectDir, "project.godot"),
            reason: "io",
            cause,
          }),
      }).pipe(Effect.map(parseGodotViewport)),
    projectSettingsFile: "project.godot",
    importProject,
    runCheck: (ctx, input) =>
      Effect.gen(function* () {
        const temporary = NodePath.join(
          ctx.root,
          "builds/logs",
          `godot-check-${NodeCrypto.randomUUID()}`,
        );
        const scriptPath = NodePath.join(temporary, "check.gd");
        const resultPath = NodePath.join(temporary, "result.json");
        return yield* Effect.gen(function* () {
          // The check runs the gameplay scene, and a game that saves on start
          // would write the user's real user:// otherwise; this one is scratch.
          const isolation = yield* Effect.tryPromise({
            try: async () => {
              await NodeFSP.mkdir(temporary, { recursive: true });
              await NodeFSP.writeFile(scriptPath, GODOT_CHECK_SCRIPT);
              return prepareNativeUserIsolation(temporary);
            },
            catch: (cause) =>
              new GameOperationError({
                operation: "godot-check",
                path: temporary,
                reason: "io",
                cause,
              }),
          });
          const run = yield* processes.run({
            root: ctx.root,
            executable: ctx.binary.path,
            args: [
              "--headless",
              "--path",
              ctx.projectDir,
              "--script",
              scriptPath,
              "--",
              resultPath,
              input.gameplayScene,
            ],
            operation: "godot-check",
            timeoutMs: 120_000,
            env: GameProcesses.engineChildEnv(isolation.env),
            envMode: "replace",
          });
          // Read before the scratch directory is removed below.
          const resultText = yield* Effect.promise(() =>
            NodeFSP.readFile(resultPath, "utf8").catch(() => null),
          );
          const reported = decodeText(decodeCheckResult, resultText);
          return {
            reported:
              reported === null
                ? null
                : {
                    entries: reported.entries ?? [],
                    errors: reported.errors ?? [],
                    warnings: reported.warnings ?? [],
                  },
            issues: parseGodotIssues(`${run.stdout}\n${run.stderr}`),
            run,
          };
        }).pipe(
          Effect.ensuring(
            Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
          ),
        );
      }),
    exportReady: (godot, target) =>
      Effect.gen(function* () {
        const templates = godot.templates;
        if (
          templates === null ||
          !(yield* Effect.promise(() => GameToolchain.hasBaseExportTemplates(templates)))
        )
          return yield* new GameOperationError({
            operation: "Godot export",
            path: godot.templates ?? godot.path,
            reason: "templates-missing",
            detail: `Godot executable: ${godot.path} (${godot.version}).`,
          });
        if (
          target === "Windows" &&
          !(yield* Effect.promise(() => GameToolchain.hasWindowsExportTemplates(templates)))
        )
          return yield* new GameOperationError({
            operation: "Godot Windows export",
            path: godot.templates ?? godot.path,
            reason: "templates-missing",
            detail: `Windows x86_64 export templates for Godot ${godot.version} are missing from ${godot.templates ?? "the template directory"}. Ask the user to add them in the Godot editor (Editor > Manage Export Templates) or from the export templates .tpz on https://godotengine.org/download; Web and Linux exports keep working meanwhile. Godot executable: ${godot.path}.`,
          });
      }),
    exportPreset: (ctx, target) =>
      target === "Windows"
        ? ensureWindowsPreset(NodePath.join(ctx.projectDir, "export_presets.cfg")).pipe(
            Effect.map((plan) => ({ name: plan.name, added: plan.text !== null })),
          )
        : Effect.succeed({ name: target, added: false }),
    release,
    playProcess,
    editor: null,
    player: null,
  };
};

const decodeText = <A>(decode: (input: unknown) => A, text: string | null): A | null => {
  if (text === null) return null;
  try {
    return decode(text);
  } catch {
    return null;
  }
};
