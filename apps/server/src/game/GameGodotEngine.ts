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
import type * as GameToolchain from "./GameToolchain.ts";
import { insideGame } from "./GameProjectService.ts";
import { commandDetail } from "./commandDetail.ts";
import { GODOT_CHECK_SCRIPT } from "./godotCheckScript.ts";
import { RawCheckResult, parseGodotIssues } from "./godotCheckOutput.ts";
import { parseGodotViewport } from "./godotViewport.ts";
import type { GameEngineBackend } from "./GameEngine.ts";

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
  return {
    id: "godot",
    displayName: "Godot",
    exportTargets: ["Web", "Linux", "Windows"],
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
