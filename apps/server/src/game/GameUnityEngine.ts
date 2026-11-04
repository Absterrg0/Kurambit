// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- This backend owns the Unity editor boundary: CLI arguments (JSON-valued Pipeline parameters), build outputs and log parsing.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import {
  GameOperationError,
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
import type { GameEngineBackend, GameEngineContext } from "./GameEngine.ts";
import * as GameProcesses from "./GameProcesses.ts";
import { comparedSource, snapshotBuildSource } from "./sourceSnapshot.ts";
import { UNITY_PROFILE } from "./unityProfile.ts";

/** Frames the check lets the main scene run in play mode before it reads the console. */
const CHECK_FRAMES = 120;
const BUILD_TIMEOUT_MS = 30 * 60_000;
/** The Linux player's file inside a player folder. */
const PLAYER_EXECUTABLE = "game.x86_64";

const unityTarget = (target: string) =>
  target === "Windows" ? "StandaloneWindows64" : "StandaloneLinux64";

/** A `unity command` envelope's command result. */
const resultOf = (result: GameUnity.UnityCliResult): Record<string, unknown> | null => {
  const data = result.data as { readonly result?: unknown } | null;
  return data !== null && typeof data.result === "object" && data.result !== null
    ? (data.result as Record<string, unknown>)
    : null;
};

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

/** A build report's errors as `file: message` lines, the compiler's own words. */
const buildErrors = (errors: unknown): string =>
  Array.isArray(errors) && errors.length > 0
    ? errors
        .map((entry) => {
          const e = (entry ?? {}) as Record<string, unknown>;
          const file = typeof e["file"] === "string" && e["file"] !== "" ? `${e["file"]}: ` : "";
          return `${file}${String(e["message"] ?? JSON.stringify(entry))}`;
        })
        .join("\n")
    : "no errors reported";

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
  const command = (
    root: string,
    args: ReadonlyArray<string>,
    operation: string,
    timeoutMs = 120_000,
  ) => live.cli(root, ["command", ...args], { operation, timeoutMs });

  /** `unity recompile` reports compiler errors as structured entries with file and line. */
  const recompile = (root: string, projectName: string) =>
    Effect.gen(function* () {
      const result = yield* live.cli(root, ["recompile", "--timeout", "600"], {
        operation: "unity-recompile",
        timeoutMs: 660_000,
      });
      // A successful compile reloads the domain; the next command must wait for it.
      yield* live.cli(root, ["status", "--until-ready", "--timeout", "180"], {
        operation: "unity-ready",
        timeoutMs: 200_000,
      });
      const data = (result.data ?? {}) as {
        readonly errors?: ReadonlyArray<unknown>;
        readonly warnings?: ReadonlyArray<unknown>;
      };
      const issues = (entries: ReadonlyArray<unknown> | undefined) =>
        (entries ?? []).flatMap((entry): GameCheckIssue[] => {
          const record = (entry ?? {}) as Record<string, unknown>;
          if (typeof record["message"] !== "string") return [];
          return [
            {
              file:
                typeof record["file"] === "string"
                  ? `${projectName}/${record["file"]}`
                  : projectName,
              ...(typeof record["line"] === "number" ? { line: record["line"] } : {}),
              message:
                `${typeof record["code"] === "string" ? `${record["code"]}: ` : ""}${record["message"]}`.slice(
                  0,
                  500,
                ),
            },
          ];
        });
      // Older envelopes or a crash only leave compiler lines in the output.
      const fallback = parseCSharpDiagnostics(
        `${result.process.stdout}\n${result.process.stderr}`,
        projectName,
      );
      const errors = issues(data.errors);
      return {
        result,
        errors: errors.length > 0 ? errors : fallback.errors,
        warnings: issues(data.warnings),
      };
    });

  const importProject: GameEngineBackend["importProject"] = (ctx) =>
    Effect.gen(function* () {
      // There is no Pipeline refresh command; AssetDatabase.Refresh imports
      // files written outside the editor (scripts, GLB, PNG, audio).
      yield* command(
        ctx.root,
        ["script", "eval", "UnityEditor.AssetDatabase.Refresh(); return true;"],
        "unity-refresh",
        600_000,
      );
      const compiled = yield* recompile(ctx.root, ctx.projectName);
      const success = compiled.result.ok && compiled.errors.length === 0;
      return {
        result: asResult(
          compiled.result.process,
          success,
          success
            ? "Refreshed assets and compiled scripts in the live Unity editor."
            : `The Unity scripts did not compile:\n${compiled.errors
                .slice(0, 8)
                .map((issue) => `${issue.file}:${issue.line ?? 0} ${issue.message}`)
                .join("\n")}`,
        ),
        issues: compiled.errors,
      };
    }).pipe(live.hold(ctx.root));

  const runCheck: GameEngineBackend["runCheck"] = (ctx, input) =>
    Effect.gen(function* () {
      const compiled = yield* recompile(ctx.root, ctx.projectName);
      const entries: string[] = [];
      const errors: GameCheckIssue[] = [...compiled.errors];
      const warnings: GameCheckIssue[] = [...compiled.warnings];
      let run = compiled.result.process;
      if (compiled.result.ok && compiled.errors.length === 0) {
        const scene = input.gameplayScene === "" ? "Assets/Scenes/Main.unity" : input.gameplayScene;
        const opened = yield* command(
          ctx.root,
          ["scene", "open", "--", "--path", scene],
          "unity-scene-open",
        );
        if (!opened.ok)
          errors.push({
            file: `${ctx.projectName}/${scene}`,
            message: `The main scene did not open: ${opened.errorMessage ?? "no answer"}.`,
          });
        yield* command(ctx.root, ["editor", "set_auto_tick"], "unity-auto-tick");
        yield* command(ctx.root, ["console", "clear"], "unity-console-clear");
        const started = opened.ok
          ? yield* command(ctx.root, ["editor.playmode", "start"], "unity-play")
          : null;
        if (started !== null && !started.ok)
          errors.push({
            file: `${ctx.projectName}/${scene}`,
            message: `Play mode did not start: ${started.errorMessage ?? "no answer"}.`,
          });
        if (started?.ok === true) {
          entries.push("main");
          // Play mode is left even when a read fails or the check is cancelled.
          run = yield* Effect.gen(function* () {
            yield* live.cli(ctx.root, ["status", "--until-ready", "--timeout", "120"], {
              operation: "unity-play-ready",
              timeoutMs: 150_000,
            });
            const frame = yield* command(
              ctx.root,
              ["script", "eval", "return UnityEngine.Time.frameCount;"],
              "unity-frame",
            );
            const first = Number(resultOf(frame)?.["result"] ?? 0);
            const waited = yield* command(
              ctx.root,
              [
                "job",
                "wait",
                "--",
                "--condition",
                JSON.stringify({
                  member: "UnityEngine.Time.frameCount",
                  op: "greaterThan",
                  value: first + CHECK_FRAMES,
                }),
                "--timeout",
                "60",
              ],
              "unity-play-frames",
              90_000,
            );
            void waited;
            const after = yield* command(
              ctx.root,
              ["script", "eval", "return UnityEngine.Time.frameCount;"],
              "unity-frame",
            );
            const advanced = Number(resultOf(after)?.["result"] ?? 0) - first;
            if (!(advanced >= CHECK_FRAMES))
              warnings.push({
                file: ctx.projectName,
                message: `Play mode advanced ${Number.isFinite(advanced) ? advanced : 0} of ${CHECK_FRAMES} frames within 60 s; runtime errors after that were not exercised.`,
              });
            const consoleRead = yield* command(
              ctx.root,
              ["console", "get", "--", "--level", "error", "--tail", "50"],
              "unity-console",
            );
            // The Pipeline logs its own failed commands as console errors; they are not the game's.
            const logged = (resultOf(consoleRead)?.["entries"] ?? []) as ReadonlyArray<unknown>;
            errors.push(
              ...consoleIssues(
                logged.filter(
                  (entry) =>
                    !String((entry as Record<string, unknown>)?.["message"] ?? "").startsWith(
                      "Command '",
                    ),
                ),
                ctx.projectName,
              ),
            );
            return consoleRead.process;
          }).pipe(
            Effect.ensuring(
              command(ctx.root, ["editor.playmode", "stop"], "unity-stop").pipe(Effect.ignore),
            ),
          );
        }
      }
      // The process is the last CLI call's own; the issues above carry the verdict.
      return { reported: { entries, errors, warnings }, issues: [], run };
    }).pipe(live.hold(ctx.root));

  /**
   * The live editor builds the player (`build run` queues it and returns a
   * build id); `build status` is read until that build leaves the Pipeline's
   * `queued` and `building` states (it reports idle | queued | building |
   * completed, retained until the next build).
   */
  const runExportRelease: GameEngineBackend["runExportRelease"] = (ctx, input) =>
    Effect.gen(function* () {
      const queued = yield* command(
        ctx.root,
        [
          "build",
          "run",
          "--",
          "--target",
          unityTarget(input.preset),
          "--outputPath",
          input.outputPath,
          "--confirm",
          "true",
        ],
        input.operation,
      );
      const queuedResult = resultOf(queued);
      if (!queued.ok || queuedResult?.["status"] !== "queued")
        return asResult(
          queued.process,
          false,
          `The Unity ${input.preset} build did not start: ${String(queuedResult?.["message"] ?? queued.errorMessage ?? queuedResult?.["status"] ?? "no answer")}.`,
          input.outputPath,
        );
      const buildId = queuedResult["buildId"];
      // A report is this build's only by its id (or, without one, its output
      // path); a status left by an earlier build never ends this wait as done.
      const ours = (report: Record<string, unknown>) =>
        typeof buildId === "string"
          ? report["buildId"] === buildId
          : typeof report["outputPath"] === "string" &&
            NodePath.resolve(report["outputPath"]) === NodePath.resolve(input.outputPath);
      let last = queued;
      let finished = false;
      let seen = false;
      let idleUnseen = 0;
      return yield* Effect.gen(function* () {
        for (let waited = 0; waited < BUILD_TIMEOUT_MS && !finished; waited += 15_000) {
          yield* Effect.sleep("15 seconds");
          last = yield* command(ctx.root, ["build", "status"], `${input.operation}-status`);
          const status = resultOf(last)?.["status"];
          // An unanswered poll says nothing. Every state but these two is final,
          // except an idle editor that has not picked the build up yet: that
          // gets a minute before the wait gives up on it.
          if (status === "queued" || status === "building") seen = true;
          else if (typeof status === "string")
            finished = status !== "idle" || seen || (idleUnseen += 1) >= 4;
        }
        if (!finished) {
          // Unity has no build cancel here; the editor would keep writing into
          // a staging folder the caller is about to delete, so it is closed.
          yield* live.stop(ctx.root);
          return asResult(
            last.process,
            false,
            `The Unity ${input.preset} build did not finish within ${BUILD_TIMEOUT_MS / 60_000} minutes (last status: ${String(resultOf(last)?.["status"] ?? "none")}); the live editor was closed to stop it, and the next Unity call reopens it.`,
            input.outputPath,
          );
        }
        const report = resultOf(last) ?? {};
        const present = yield* Effect.promise(() =>
          NodeFSP.stat(input.outputPath).then(
            (stat) => stat.isFile() && stat.size > 0,
            () => false,
          ),
        );
        const succeeded =
          report["status"] === "completed" &&
          ours(report) &&
          report["result"] === "Succeeded" &&
          present;
        return asResult(
          last.process,
          succeeded,
          succeeded
            ? `Unity ${input.preset} player built.`
            : !ours(report)
              ? `The Unity ${input.preset} build ended without its own report (status ${String(report["status"] ?? "none")}, build ${String(report["buildId"] ?? "none")}, expected ${String(buildId ?? input.outputPath)}).`
              : `The Unity ${input.preset} build failed (${String(report["result"] ?? report["status"] ?? "no status")}): ${buildErrors(report["errors"]).slice(0, 1500)}`,
          input.outputPath,
        );
      }).pipe(
        // A cancelled caller deletes the staging folder and releases the
        // editor; a build still writing into it is stopped with the editor.
        Effect.onInterrupt(() => live.stop(ctx.root)),
      );
    }).pipe(live.hold(ctx.root));

  /**
   * A Unity player is a folder (the executable, its `game_Data/` and the
   * engine runtime library), so it builds into a staging folder and replaces
   * the destination only once its files check out and the sources did not
   * change during the build. The caller imports first.
   */
  const buildPlayer: NonNullable<GameEngineBackend["player"]>["build"] = (ctx, input) =>
    Effect.gen(function* () {
      const { root, projectName } = ctx;
      const { target, destination, operation } = input;
      const snapshot = Effect.promise((signal) =>
        snapshotBuildSource(root, projectName, { signal }),
      );
      const executable = target === "Windows" ? "game.exe" : PLAYER_EXECUTABLE;
      const staging = NodePath.join(
        NodePath.dirname(destination),
        `.${NodePath.basename(destination)}-${NodeCrypto.randomUUID()}`,
      );
      return yield* Effect.gen(function* () {
        const before = yield* snapshot;
        // An interrupted build leaves its staging folder; only this build's own name prefix is cleared.
        yield* Effect.promise(async () => {
          const parent = NodePath.dirname(destination);
          const prefix = `.${NodePath.basename(destination)}-`;
          for (const name of await NodeFSP.readdir(parent).catch(() => [] as string[]))
            if (name.startsWith(prefix))
              await NodeFSP.rm(NodePath.join(parent, name), { recursive: true, force: true });
        });
        yield* Effect.tryPromise({
          try: () => NodeFSP.mkdir(staging, { recursive: true }),
          catch: (cause) =>
            new GameOperationError({ operation, path: staging, reason: "io", cause }),
        });
        const result = yield* runExportRelease(ctx, {
          preset: target,
          outputPath: NodePath.join(staging, executable),
          operation,
        });
        if (!result.success) return { result, sourceId: null };
        // Unity names this debug-symbol folder itself: it is never shipped.
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(staging, "game_BackUpThisFolder_ButDontShipItWithYourGame"), {
            recursive: true,
            force: true,
          }),
        );
        const runtime = target === "Windows" ? "UnityPlayer.dll" : "UnityPlayer.so";
        const missing = yield* Effect.promise(async () => {
          const absent: string[] = [];
          for (const [name, kind] of [
            [executable, "file"],
            ["game_Data", "directory"],
            [runtime, "file"],
          ] as const) {
            const stat = await NodeFSP.stat(NodePath.join(staging, name)).catch(() => null);
            if (
              stat === null ||
              (kind === "file" ? !stat.isFile() || stat.size === 0 : !stat.isDirectory())
            )
              absent.push(name);
          }
          return absent;
        });
        if (missing.length > 0)
          return {
            result: {
              ...result,
              success: false,
              message:
                `The Unity ${target} build is missing ${missing.join(", ")}; nothing was replaced.\n${result.message}`.slice(
                  -4096,
                ),
            },
            sourceId: null,
          };
        const comparison = comparedSource(before, yield* snapshot, "export");
        if (comparison.kind !== "current")
          return {
            result: { ...result, success: false, message: comparison.detail },
            sourceId: null,
          };
        yield* Effect.tryPromise({
          try: async () => {
            const old = `${destination}.old-${NodeCrypto.randomUUID()}`;
            const existing = await NodeFSP.stat(destination).catch(() => null);
            if (existing !== null) await NodeFSP.rename(destination, old);
            try {
              await NodeFSP.rename(staging, destination);
            } catch (cause) {
              // The previous build goes back rather than leaving no build at all.
              if (existing !== null) await NodeFSP.rename(old, destination).catch(() => undefined);
              throw cause;
            }
            await NodeFSP.rm(old, { recursive: true, force: true });
          },
          catch: (cause) =>
            new GameOperationError({
              operation,
              path: destination,
              reason: "io",
              detail: "The checked Unity build could not be moved into place.",
              cause,
            }),
        });
        return {
          result: { ...result, path: NodePath.join(destination, executable) },
          sourceId: comparison.sourceId,
        };
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(staging, { recursive: true, force: true })),
        ),
      );
    });

  const exportPlayer: NonNullable<GameEngineBackend["player"]>["export"] = (ctx, target) =>
    Effect.gen(function* () {
      const directory = target === "Windows" ? "builds/windows" : "builds/linux";
      // One hold for import and build: another game cannot take the editor between them.
      const built = yield* live.hold(ctx.root)(
        Effect.gen(function* () {
          const imported = (yield* importProject(ctx)).result;
          if (!imported.success) return { result: imported, sourceId: null };
          return yield* buildPlayer(ctx, {
            target,
            destination: NodePath.join(ctx.root, directory),
            operation: `export-${target.toLowerCase()}`,
          });
        }),
      );
      if (!built.result.success) return built.result;
      return {
        ...built.result,
        message:
          target === "Windows"
            ? "Unity Windows x86_64 build ready at builds/windows/game.exe with game_Data/, UnityPlayer.dll and MonoBleedingEdge/ beside it; ship the whole folder. This machine did not run it on Windows."
            : "Unity Linux x86_64 build ready at builds/linux/game.x86_64 with game_Data/ and UnityPlayer.so beside it; ship the whole folder.",
      };
    });

  // Unity creates Library/ as soon as it starts importing, so a warm-up cut
  // short (stop, restart, memory) leaves one behind. Only a finished open
  // writes this marker (Library/ is gitignored), so a partial one is redone.
  const warmMarker = (ctx: GameEngineContext) =>
    NodePath.join(ctx.projectDir, "Library", "kurambit-warm");

  return {
    profile: UNITY_PROFILE,
    resolveProject: (root, manifest) =>
      Effect.gen(function* () {
        const projectDir = insideGame(root, manifest.godotProject);
        const unity = yield* tools.unity(projectDir);
        return {
          binary: { path: unity.editor, version: unity.version, templates: null },
          projectName: manifest.godotProject,
          projectDir,
        };
      }),
    projectSettingsFile: "ProjectSettings/ProjectSettings.asset",
    projectDirectory: (manifest) => manifest.godotProject,
    projectSettings: () => ({ viewport: { ...UNITY_VIEWPORT } }),
    parseDiagnostics: (output) => parseCSharpDiagnostics(output, "unity").errors,
    importProject,
    runCheck,
    // Players build in the live editor (player.export): no export templates and no preset.
    exportReady: () => Effect.void,
    exportPreset: (_ctx, target) => Effect.succeed({ name: target, added: false }),
    runExportRelease,
    editor: {
      hold: live.hold,
      close: live.stop,
      warm: (ctx) =>
        Effect.promise(() =>
          NodeFSP.access(warmMarker(ctx)).then(
            () => true,
            () => false,
          ),
        ),
      open: (ctx) =>
        live.hold(ctx.root)(Effect.promise(() => NodeFSP.writeFile(warmMarker(ctx), "warm\n"))),
    },
    player: {
      build: buildPlayer,
      export: exportPlayer,
      executable: PLAYER_EXECUTABLE,
      session: ({ player, requestPath, traceDir, home, viewport }) => ({
        args: [
          player,
          "-kurambitExplore",
          requestPath,
          "-screen-fullscreen",
          "0",
          "-screen-width",
          String(viewport.width),
          "-screen-height",
          String(viewport.height),
          "-force-glcore",
          "-logFile",
          NodePath.join(traceDir, "player.log"),
        ],
        // The player keeps its prefs and log under the session's scratch HOME,
        // never the user's ~/.config/unity3d.
        env: {
          ...GameProcesses.engineChildEnv(),
          HOME: home,
          XDG_CONFIG_HOME: NodePath.join(home, ".config"),
          LIBGL_ALWAYS_SOFTWARE: "1",
          LP_NUM_THREADS: "2",
        },
        inputNote: "Keys and mouse go in through the Input System. ",
      }),
    },
  };
};
