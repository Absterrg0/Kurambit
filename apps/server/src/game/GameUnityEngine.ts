// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- This backend owns the Unity editor boundary: CLI arguments (JSON-valued Pipeline parameters), build outputs and log parsing.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import {
  UNITY_PINNED_VERSION,
  UNITY_VIEWPORT,
  type GameActionResult,
  type GameCheckIssue,
  type GameProcessResult,
} from "@kurambit/contracts";
import type * as GameToolchain from "./GameToolchain.ts";
import type * as GameUnity from "./GameUnity.ts";
import { insideGame } from "./GameProjectService.ts";
import { commandDetail } from "./commandDetail.ts";
import { consoleIssues, parseCSharpDiagnostics } from "./unityDiagnostics.ts";
import type { GameEngineBackend } from "./GameEngine.ts";

/** Frames the check lets the main scene run in play mode before it reads the console. */
const CHECK_FRAMES = 120;

const unityTarget = (target: string) =>
  target === "Windows" ? "StandaloneWindows64" : "StandaloneLinux64";

const asResult = (
  run: GameProcessResult,
  success: boolean,
  message: string,
  outputPath: string | null = null,
): GameActionResult => ({
  success,
  message: success ? message : `${message} See ${run.logPath}\n${commandDetail(run)}`,
  path: outputPath,
  url: null,
  process: run,
});

/**
 * The Unity backend. Every editor operation goes through the game's one live
 * editor (GameUnity), because Unity refuses a second editor on an open
 * project: import refreshes and recompiles there, check recompiles then
 * plays the main scene for a few frames, export builds a player there.
 */
export const makeUnityBackend = (
  live: GameUnity.GameUnity["Service"],
  tools: GameToolchain.GameToolchain["Service"],
): GameEngineBackend => {
  const recompile = (root: string, projectName: string) =>
    Effect.gen(function* () {
      const result = yield* live.cli(root, ["recompile", "--timeout", "600"], {
        operation: "unity-recompile",
        timeoutMs: 660_000,
      });
      const text = `${result.process.stdout}\n${result.process.stderr}\n${JSON.stringify(result.data ?? null)}`;
      const parsed = parseCSharpDiagnostics(text.replaceAll("\\n", "\n"), projectName);
      return { result, ...parsed };
    });

  const importProject: GameEngineBackend["importProject"] = (ctx) =>
    Effect.gen(function* () {
      yield* live.cli(ctx.root, ["command", "asset", "refresh"], {
        operation: "unity-refresh",
        timeoutMs: 600_000,
      });
      const compiled = yield* recompile(ctx.root, ctx.projectName);
      const success = compiled.result.ok && compiled.errors.length === 0;
      return {
        result: asResult(
          compiled.result.process,
          success,
          success
            ? "Refreshed assets and compiled scripts in the live Unity editor."
            : `The Unity scripts did not compile: ${compiled.errors
                .slice(0, 8)
                .map((issue) => `${issue.file}:${issue.line ?? 0} ${issue.message}`)
                .join("\n")}`,
        ),
        issues: compiled.errors,
      };
    });

  const runCheck: GameEngineBackend["runCheck"] = (ctx, input) =>
    Effect.gen(function* () {
      const compiled = yield* recompile(ctx.root, ctx.projectName);
      const entries: string[] = [];
      const errors: GameCheckIssue[] = [...compiled.errors];
      const warnings: GameCheckIssue[] = [...compiled.warnings];
      let run = compiled.result.process;
      if (compiled.result.ok && compiled.errors.length === 0) {
        const command = (args: ReadonlyArray<string>, operation: string, timeoutMs = 120_000) =>
          live.cli(ctx.root, ["command", ...args], { operation, timeoutMs });
        yield* command(["console", "clear"], "unity-console-clear");
        yield* command(["editor", "set_auto_tick"], "unity-auto-tick");
        if (input.gameplayScene !== "")
          yield* command(
            ["scene", "open", "--", "--path", input.gameplayScene],
            "unity-scene-open",
          );
        const started = yield* command(["editor.playmode", "start"], "unity-play");
        if (!started.ok)
          errors.push({
            file: `${ctx.projectName}/${input.gameplayScene || "Assets"}`,
            message: `Play mode did not start: ${started.errorMessage ?? "no answer"}.`,
          });
        else {
          entries.push("main");
          yield* live.cli(ctx.root, ["status", "--until-ready", "--timeout", "120"], {
            operation: "unity-play-ready",
            timeoutMs: 150_000,
          });
          const waited = yield* command(
            [
              "job",
              "wait",
              "--",
              "--condition",
              JSON.stringify({
                member: "UnityEngine.Time.frameCount",
                op: "greaterThan",
                value: CHECK_FRAMES,
              }),
              "--timeout",
              "60",
            ],
            "unity-play-frames",
            90_000,
          );
          if (!waited.ok)
            warnings.push({
              file: ctx.projectName,
              message: `Play mode did not reach ${CHECK_FRAMES} frames within 60 s (${waited.errorMessage ?? "no answer"}); runtime errors after that were not exercised.`,
            });
          const consoleRead = yield* command(
            ["console", "get", "--", "--level", "error", "--tail", "50"],
            "unity-console",
          );
          run = consoleRead.process;
          errors.push(...consoleIssues(consoleRead.data, ctx.projectName));
          yield* command(["editor.playmode", "stop"], "unity-stop");
        }
      }
      return {
        reported: { entries, errors, warnings },
        issues: [],
        run: { ...run, exitCode: errors.length === 0 ? 0 : 1 },
      };
    });

  const runExportRelease: GameEngineBackend["runExportRelease"] = (ctx, input) =>
    Effect.gen(function* () {
      const result = yield* live.cli(
        ctx.root,
        [
          "command",
          "build",
          "run",
          "--",
          "--target",
          unityTarget(input.preset),
          "--output",
          input.outputPath,
        ],
        { operation: input.operation, timeoutMs: 1_800_000 },
      );
      const present = yield* Effect.promise(() =>
        NodeFSP.stat(input.outputPath).then(
          (stat) => stat.isFile() && stat.size > 0,
          () => false,
        ),
      );
      return asResult(
        result.process,
        result.ok && present,
        result.ok && present
          ? `Unity ${input.preset} player built.`
          : `The Unity ${input.preset} build failed: ${result.errorMessage ?? "no player was written"}.`,
        input.outputPath,
      );
    });

  return {
    id: "unity",
    displayName: "Unity",
    exportTargets: ["Linux", "Windows"],
    resolveProject: (root, manifest) =>
      Effect.gen(function* () {
        const unity = yield* tools.unity;
        return {
          binary: { path: unity.editor, version: UNITY_PINNED_VERSION, templates: null },
          projectName: manifest.godotProject,
          projectDir: insideGame(root, manifest.godotProject),
        };
      }),
    projectSettingsFile: "ProjectSettings/ProjectSettings.asset",
    projectDirectory: (manifest) => manifest.godotProject,
    projectSettings: () => ({ viewport: { ...UNITY_VIEWPORT } }),
    parseDiagnostics: (output) => parseCSharpDiagnostics(output, "unity").errors,
    importProject,
    runCheck,
    runExportRelease,
  };
};

export const unityPlayerDirectory = (root: string, sourceId: string) =>
  NodePath.join(root, "builds/logs", `unity-play-${sourceId.slice(0, 16)}`);
