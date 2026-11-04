// @effect-diagnostics nodeBuiltinImport:off -- This backend owns the native Godot process boundary: scripts, args, output parsing.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  GameOperationError,
  type GameActionResult,
  type GameProcessResult,
} from "@kurambit/contracts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameToolchain from "./GameToolchain.ts";
import { insideGame } from "./GameProjectService.ts";
import { commandDetail } from "./commandDetail.ts";
import { GODOT_CHECK_SCRIPT } from "./godotCheckScript.ts";
import { GODOT_PLAY_RUNNER } from "./godotPlayRunner.ts";
import { prepareNativeUserIsolation, userDirConfigIssues } from "./gameNativeUserDir.ts";
import { RawCheckResult, parseGodotIssues } from "./godotCheckOutput.ts";
import { parseGodotViewport } from "./godotViewport.ts";
import type { GameEngineBackend } from "./GameEngine.ts";
import { GODOT_PROFILE } from "./godotProfile.ts";
import { planWindowsPreset } from "./windowsPreset.ts";

const decodeCheckResult = Schema.decodeUnknownSync(RawCheckResult);

const response = (
  process: GameProcessResult,
  outputPath: string | null = null,
): GameActionResult => {
  const errors = (process.stdout + "\n" + process.stderr)
    .split("\n")
    .filter((line) => /(?:SCRIPT ERROR|ERROR:|Parse Error)/.test(line));
  const success = process.exitCode === 0 && !process.timedOut && errors.length === 0;
  return {
    success,
    message: success
      ? "Completed successfully."
      : `Command failed${process.timedOut ? " after its timeout" : ` with exit code ${process.exitCode}`}. ${errors.slice(0, 8).join("\n")} See ${process.logPath}\n${commandDetail(process)}`,
    path: outputPath,
    url: null,
    process,
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
): GameEngineBackend => {
  const importProject: GameEngineBackend["importProject"] = (ctx) =>
    Effect.gen(function* () {
      const run = yield* processes.run({
        root: ctx.root,
        executable: ctx.binary.path,
        args: ["--headless", "--path", ctx.projectDir, "--editor", "--import"],
        operation: "godot-import",
        timeoutMs: 180_000,
        env: GameProcesses.engineChildEnv(),
        envMode: "replace",
      });
      return {
        result: response(run),
        issues: parseGodotIssues(`${run.stdout}\n${run.stderr}`),
      };
    });
  /**
   * The play runner runs the real main scene from current sources (no
   * export) under a server-owned script in ignored builds/logs. The child
   * sees the allowlisted engine base plus software GL and a per-run XDG trio,
   * so the project's scripts cannot read server secrets and user:// stays in
   * the isolation the runner checks. HOME stays the real one (Godot resolves
   * editor config under it). Without a private display it runs headless.
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
          return prepareNativeUserIsolation(input.traceDir);
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
      const size = `${input.viewport.width}x${input.viewport.height}`;
      const runner = ["--path", input.projectDir, "--script", scriptPath, "--", input.requestPath];
      return {
        executable: binary.path,
        args: input.display
          ? [
              "--display-driver",
              "x11",
              "--rendering-method",
              "gl_compatibility",
              "--audio-driver",
              "Dummy",
              "--resolution",
              size,
              ...runner,
            ]
          : ["--headless", "--audio-driver", "Dummy", "--resolution", size, ...runner],
        env,
        cwd: input.projectDir,
        request: { expectedUserDataPrefix: isolation.dataDir },
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
          projectName: manifest.godotProject,
          projectDir: insideGame(root, manifest.godotProject),
        };
      }),
    projectSettingsFile: "project.godot",
    projectDirectory: (manifest) => manifest.godotProject,
    projectSettings: (projectFileText: string) => ({
      viewport: parseGodotViewport(projectFileText),
    }),
    parseDiagnostics: (output: string) => parseGodotIssues(output),
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
          yield* Effect.tryPromise({
            try: async () => {
              await NodeFSP.mkdir(temporary, { recursive: true });
              await NodeFSP.writeFile(scriptPath, GODOT_CHECK_SCRIPT);
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
            env: GameProcesses.engineChildEnv(),
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
    runExportRelease: (ctx, input) =>
      Effect.gen(function* () {
        const run = yield* processes.run({
          root: ctx.root,
          executable: ctx.binary.path,
          args: [
            "--headless",
            "--path",
            ctx.projectDir,
            "--export-release",
            input.preset,
            input.outputPath,
          ],
          operation: input.operation,
          timeoutMs: 300_000,
          env: GameProcesses.engineChildEnv(),
          envMode: "replace",
        });
        return response(run, input.outputPath);
      }),
    playProcess,
    editor: null,
    player: null,
  };
};

/**
 * Ensures the project has a usable Windows Desktop preset. Its text is
 * written atomically because a half-written preset would break every later
 * export; a preset the creator already wrote is never rewritten.
 */
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
    if (plan.text !== null) {
      const text = plan.text;
      const temporary = `${presetsPath}.${NodeCrypto.randomUUID()}.tmp`;
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.writeFile(temporary, text, "utf8");
          await NodeFSP.rename(temporary, presetsPath);
        },
        catch: (cause) =>
          new GameOperationError({
            operation: "export-windows",
            path: presetsPath,
            reason: "io",
            detail:
              "The Windows export preset could not be added; existing presets were left as they were.",
            cause,
          }),
      }).pipe(Effect.ensuring(Effect.promise(() => NodeFSP.rm(temporary, { force: true }))));
    }
    return plan;
  });

const decodeText = <A>(decode: (input: unknown) => A, text: string | null): A | null => {
  if (text === null) return null;
  try {
    return decode(text);
  } catch {
    return null;
  }
};
