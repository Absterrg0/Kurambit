// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- This backend owns the Unity editor boundary: CLI arguments (JSON-valued Pipeline parameters), build outputs and log parsing.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import {
  GameOperationError,
  UNITY_VIEWPORT,
  type GameActionResult,
  type GameCheckIssue,
  type GameProcessResult,
  manifestProject,
} from "@kurambit/contracts";
import type * as GameToolchain from "./GameToolchain.ts";
import * as GameUnity from "./GameUnity.ts";
import { insideGame } from "./GameProjectService.ts";
import { commandDetail } from "./commandDetail.ts";
import { consoleIssues, parseCSharpDiagnostics } from "./unityDiagnostics.ts";
import type { GameEngineBackend, GameEngineContext } from "./GameEngine.ts";
import * as GameProcesses from "./GameProcesses.ts";
import { UNITY_PROFILE } from "./unityProfile.ts";
import { HOST_OS } from "./processHost.ts";
import {
  completePlayer,
  isPlayerDirectory,
  UNITY_PLAY,
  unityPlayerDirectory,
} from "./unityPlayerCache.ts";

/** Frames the check lets each entry run in play mode before it reads the console. */
const CHECK_FRAMES = 120;
/** A game that advances no frame in this long froze; one that advances some is given up to SLOW_WAIT_S. */
const FROZEN_WAIT_S = 60;
const SLOW_WAIT_S = 180;
/**
 * A frame-count read runs on the editor's main thread, which a game stuck in
 * Start() or an endless Update() never gives back: past this, it froze.
 */
const MAIN_THREAD_ANSWER_MS = 30_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;

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

const toolFailed = (operation: string, path: string, detail: string) =>
  new GameOperationError({ operation, path, reason: "tool-failed", detail: detail.slice(0, 4000) });

/**
 * The Unity backend. Every editor operation goes through the game's one live
 * editor (GameUnity), because Unity refuses a second editor on an open
 * project: import refreshes and recompiles there, check recompiles then
 * plays the entries for a few frames, a release builds a player there.
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
      // A compile reloads the domain; the next command must wait for it. A
      // recompile that never answered left the editor stuck, so no more is asked of it.
      if (!result.process.timedOut)
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
      const reported = issues(data.errors);
      const errors = reported.length > 0 ? reported : fallback.errors;
      const answer = GameUnity.answerOf(result);
      // A recompile that failed without naming one compiler error cannot be
      // told apart from the editor's own failure, so it is not the scripts'.
      if (answer.kind !== "answered" && errors.length === 0)
        return yield* toolFailed(
          "unity-recompile",
          root,
          `The live Unity editor ${answer.kind === "silent" ? `did not answer the recompile${answer.timedOut ? " in time" : ""}` : `refused the recompile (${answer.message})`} and named no compile error.\n${commandDetail(result.process)}`,
        );
      return { result, errors, warnings: issues(data.warnings) };
    });

  const importProject: GameEngineBackend["importProject"] = (ctx) =>
    Effect.gen(function* () {
      // There is no Pipeline refresh command; AssetDatabase.Refresh imports
      // files written outside the editor (scripts, GLB, PNG, audio).
      const refreshed = yield* command(
        ctx.root,
        ["script", "eval", "UnityEditor.AssetDatabase.Refresh(); return true;"],
        "unity-refresh",
        600_000,
      );
      if (GameUnity.answerOf(refreshed).kind === "silent")
        return yield* toolFailed(
          "unity-refresh",
          ctx.root,
          `The live Unity editor did not answer the asset refresh.\n${commandDetail(refreshed.process)}`,
        );
      const compiled = yield* recompile(ctx.root, ctx.projectName);
      const success = compiled.errors.length === 0;
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

  /** The scenes the player boots: the first enabled build scene, as the editor reads its build settings. */
  const firstBuildScene = (root: string) =>
    Effect.gen(function* () {
      const read = yield* command(
        root,
        [
          "script",
          "eval",
          'foreach (var scene in UnityEditor.EditorBuildSettings.scenes) if (scene.enabled) return scene.path; return "";',
        ],
        "unity-build-scenes",
        MAIN_THREAD_ANSWER_MS,
      );
      const answer = GameUnity.answerOf(read);
      if (answer.kind !== "answered")
        return yield* toolFailed(
          "unity-build-scenes",
          root,
          `The live Unity editor did not say which scene the player boots.\n${commandDetail(read.process)}`,
        );
      const path = answer.result?.["result"];
      return typeof path === "string" && path !== "" ? path : null;
    });

  /**
   * Plays one entry and reads what the game did. A game that never lets play
   * mode run is measured (an error); a Pipeline that does not answer what the
   * check must read is not (tool-failed). Returns whether the editor is still
   * usable, so a frozen one is closed instead of reused.
   */
  const playEntry = (
    ctx: GameEngineContext,
    scene: string,
    label: string,
    out: {
      readonly entries: string[];
      readonly errors: GameCheckIssue[];
      readonly warnings: GameCheckIssue[];
    },
  ) =>
    Effect.gen(function* () {
      const file = `${ctx.projectName}/${scene}`;
      const froze = (detail: string) =>
        Effect.gen(function* () {
          out.errors.push({ file, message: detail });
          yield* live.wedged(ctx.root, "the game froze the editor's main thread");
          return "wedged" as const;
        });
      const opened = GameUnity.answerOf(
        yield* command(ctx.root, ["scene", "open", "--", "--path", scene], "unity-scene-open"),
      );
      if (opened.kind === "refused") {
        out.errors.push({ file, message: `The ${label} scene did not open: ${opened.message}.` });
        return "usable" as const;
      }
      if (opened.kind === "silent")
        return yield* toolFailed(
          "unity-scene-open",
          file,
          `The live Unity editor did not answer opening ${scene}.`,
        );
      for (const [args, operation] of [
        [["editor", "set_auto_tick"], "unity-auto-tick"],
        [["console", "clear"], "unity-console-clear"],
      ] as const)
        if (GameUnity.answerOf(yield* command(ctx.root, args, operation)).kind === "silent")
          return yield* toolFailed(
            operation,
            file,
            "The live Unity editor did not answer before play mode.",
          );
      const started = yield* command(ctx.root, ["editor.playmode", "start"], "unity-play");
      const start = GameUnity.answerOf(started);
      if (start.kind === "silent")
        return start.timedOut
          ? yield* froze(
              `Entering play mode never returned in 120 s: Awake, OnEnable or Start of ${scene} never finished (an endless loop or a blocking wait).`,
            )
          : yield* toolFailed(
              "unity-play",
              file,
              "The live Unity editor did not answer the play mode start.",
            );
      if (start.kind === "refused") {
        out.errors.push({ file, message: `Play mode did not start: ${start.message}.` });
        return "usable" as const;
      }
      out.entries.push(label);
      const ready = yield* live.cli(ctx.root, ["status", "--until-ready", "--timeout", "120"], {
        operation: "unity-play-ready",
        timeoutMs: 150_000,
      });
      if (ready.process.timedOut)
        return yield* froze(
          `The editor never became ready after play mode started in ${scene}: the game froze its main thread.`,
        );
      const frame = Effect.gen(function* () {
        const read = GameUnity.answerOf(
          yield* command(
            ctx.root,
            ["script", "eval", "return UnityEngine.Time.frameCount;"],
            "unity-frame",
            MAIN_THREAD_ANSWER_MS,
          ),
        );
        // Silence on the main thread is the game's freeze; a refusal or an
        // unreadable answer is the Pipeline's, which says nothing about the game.
        if (read.kind === "silent") return null;
        const value = read.kind === "answered" ? Number(read.result?.["result"]) : Number.NaN;
        if (!Number.isFinite(value))
          return yield* toolFailed(
            "unity-frame",
            file,
            `The live Unity editor did not report the frame count (${read.kind === "refused" ? read.message : "no number"}).`,
          );
        return value;
      });
      const waitFrames = (target: number, seconds: number) =>
        command(
          ctx.root,
          [
            "job",
            "wait",
            "--",
            "--condition",
            JSON.stringify({
              member: "UnityEngine.Time.frameCount",
              op: "greaterThan",
              value: target,
            }),
            "--timeout",
            String(seconds),
          ],
          "unity-play-frames",
          (seconds + 30) * 1000,
        );
      const startedAt = yield* Clock.currentTimeMillis;
      const first = yield* frame;
      if (first === null)
        return yield* froze(
          `The game froze: the editor's main thread stopped answering once play mode started in ${scene}.`,
        );
      // A wait the editor never answered found its main thread stuck: the game froze.
      if ((yield* waitFrames(first + CHECK_FRAMES, FROZEN_WAIT_S)).process.timedOut)
        return yield* froze(
          `The game froze: the editor stopped answering while play ran in ${scene}.`,
        );
      let after = yield* frame;
      if (after === null)
        return yield* froze(
          `The game froze: the editor's main thread stopped answering within ${FROZEN_WAIT_S} s of play in ${scene}.`,
        );
      if (after - first <= 0)
        return yield* froze(
          `Play mode advanced 0 of ${CHECK_FRAMES} frames in ${FROZEN_WAIT_S} s in ${scene}: the game froze.`,
        );
      // Slow is not frozen: a heavy scene on software rendering gets more time.
      if (after - first < CHECK_FRAMES) {
        if ((yield* waitFrames(first + CHECK_FRAMES, SLOW_WAIT_S - FROZEN_WAIT_S)).process.timedOut)
          return yield* froze(
            `The game froze: the editor stopped answering while play ran in ${scene}.`,
          );
        const later = yield* frame;
        if (later === null)
          return yield* froze(
            `The game froze: the editor's main thread stopped answering during play in ${scene}.`,
          );
        after = later;
      }
      const advanced = after - first;
      if (advanced < CHECK_FRAMES) {
        const seconds = Math.max(1, ((yield* Clock.currentTimeMillis) - startedAt) / 1000);
        out.warnings.push({
          file,
          message: `Play mode advanced ${advanced} of ${CHECK_FRAMES} frames in ${Math.round(seconds)} s in ${scene} (about ${(advanced / seconds).toFixed(1)} fps): the game runs far below speed here, and runtime errors after that were not exercised.`,
        });
      }
      // The console answers from a background thread, so it reads even past a stall.
      const consoleRead = yield* command(
        ctx.root,
        ["console", "get", "--", "--level", "error", "--tail", "50"],
        "unity-console",
      );
      const consoleAnswer = GameUnity.answerOf(consoleRead);
      const logged =
        consoleAnswer.kind === "answered" ? consoleAnswer.result?.["entries"] : undefined;
      if (!Array.isArray(logged))
        return yield* toolFailed(
          "unity-console",
          file,
          `The live Unity editor's console did not answer, so the check cannot say the game ran cleanly.\n${commandDetail(consoleRead.process)}`,
        );
      // The Pipeline logs its own failed commands as console errors; they are not the game's.
      out.errors.push(
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
      return "usable" as const;
    }).pipe(
      Effect.tap((state) =>
        state === "usable"
          ? // Play mode is left even when a read fails; a stop that does not answer wedges the editor.
            command(ctx.root, ["editor.playmode", "stop"], "unity-stop", 60_000).pipe(
              Effect.flatMap((stopped) =>
                GameUnity.answerOf(stopped).kind === "silent"
                  ? live.wedged(ctx.root, "play mode would not stop")
                  : Effect.void,
              ),
              Effect.ignore,
            )
          : Effect.void,
      ),
    );

  const runCheck: GameEngineBackend["runCheck"] = (ctx, input) =>
    Effect.gen(function* () {
      const compiled = yield* recompile(ctx.root, ctx.projectName);
      const out = {
        entries: [] as string[],
        errors: [...compiled.errors] as GameCheckIssue[],
        warnings: [...compiled.warnings] as GameCheckIssue[],
      };
      if (compiled.errors.length === 0) {
        // The scene the player boots first (the shell's menu), then the gameplay
        // scene when it differs, as Godot and three.js run both entries.
        const main = yield* firstBuildScene(ctx.root);
        const gameplay = input.gameplayScene === "" ? null : input.gameplayScene;
        if (main === null)
          out.warnings.push({
            file: `${ctx.projectName}/ProjectSettings/EditorBuildSettings.asset`,
            message:
              "No scene is enabled in the build settings, so the player boots nothing; the check ran only the gameplay scene.",
          });
        const entries = [
          ...(main === null ? [] : [[main, "main"] as const]),
          ...(gameplay === null || gameplay === main ? [] : [[gameplay, "gameplay"] as const]),
        ];
        for (const [scene, label] of entries)
          if ((yield* playEntry(ctx, scene, label, out)) === "wedged") break;
      }
      // The process is the last CLI call's own; the issues above carry the verdict.
      return {
        reported: { entries: out.entries, errors: out.errors, warnings: out.warnings },
        issues: [],
        run: compiled.result.process,
      };
    }).pipe(live.hold(ctx.root));

  /**
   * The live editor builds the player (`build run` queues it and returns a
   * build id); `build status` is read until that build leaves the Pipeline's
   * `queued` and `building` states (it reports idle | queued | building |
   * completed, retained until the next build).
   */
  const buildPlayer = (
    ctx: GameEngineContext,
    input: { readonly target: string; readonly outputPath: string; readonly operation: string },
  ) =>
    Effect.gen(function* () {
      const queued = yield* command(
        ctx.root,
        [
          "build",
          "run",
          "--",
          "--target",
          unityTarget(input.target),
          "--outputPath",
          input.outputPath,
          "--confirm",
          "true",
        ],
        input.operation,
      );
      const queuedAnswer = GameUnity.answerOf(queued);
      const queuedResult = queuedAnswer.kind === "answered" ? queuedAnswer.result : null;
      if (queuedResult?.["status"] !== "queued")
        return yield* toolFailed(
          input.operation,
          input.outputPath,
          `The Unity ${input.target} build did not start: ${String(queuedResult?.["message"] ?? (queuedAnswer.kind === "refused" ? queuedAnswer.message : "no answer"))}.\n${commandDetail(queued.process)}`,
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
          // A poll may go unanswered while the build holds the editor's main
          // thread: it says nothing, never that the editor is stuck.
          last = yield* live.cli(ctx.root, ["command", "build", "status"], {
            operation: `${input.operation}-status`,
            timeoutMs: 120_000,
            unansweredIsNews: false,
          });
          const answer = GameUnity.answerOf(last);
          const status = answer.kind === "answered" ? answer.result?.["status"] : undefined;
          // An unanswered poll says nothing. Every state but these two is final,
          // except an idle editor that has not picked the build up yet: that
          // gets a minute before the wait gives up on it.
          if (status === "queued" || status === "building") seen = true;
          else if (typeof status === "string")
            finished = status !== "idle" || seen || (idleUnseen += 1) >= 4;
        }
        const lastAnswer = GameUnity.answerOf(last);
        const report = (lastAnswer.kind === "answered" ? lastAnswer.result : null) ?? {};
        if (!finished) {
          // Unity has no build cancel here; the editor would keep writing into
          // a staging folder the caller is about to delete, so it is closed.
          yield* live.stop(ctx.root);
          return yield* toolFailed(
            input.operation,
            input.outputPath,
            `The Unity ${input.target} build did not finish within ${BUILD_TIMEOUT_MS / 60_000} minutes (last status: ${String(report["status"] ?? "none")}); the live editor was closed to stop it, and the next Unity call reopens it.`,
          );
        }
        if (!ours(report))
          return yield* toolFailed(
            input.operation,
            input.outputPath,
            `The Unity ${input.target} build ended without its own report (status ${String(report["status"] ?? "none")}, build ${String(report["buildId"] ?? "none")}, expected ${String(buildId ?? input.outputPath)}).`,
          );
        const present = yield* Effect.promise(() =>
          NodeFSP.stat(input.outputPath).then(
            (stat) => stat.isFile() && stat.size > 0,
            () => false,
          ),
        );
        // Unity still reports "Succeeded" when scene objects lost their
        // scripts, and that player runs a game whose behaviour is gone (it
        // boots, nothing moves). Every sample and bot would play it, so it
        // is a failed build, named in Unity's own words.
        const detached = Array.isArray(report["warnings"])
          ? report["warnings"]
              .map((entry) => String((entry as Record<string, unknown> | null)?.["message"] ?? ""))
              .filter((message) => message.includes("is missing or no valid script is attached"))
          : [];
        const succeeded =
          report["status"] === "completed" &&
          report["result"] === "Succeeded" &&
          present &&
          detached.length === 0;
        return asResult(
          last.process,
          succeeded,
          succeeded
            ? `Unity ${input.target} player built.`
            : detached.length > 0 && report["result"] === "Succeeded"
              ? `The Unity ${input.target} build lost scripts on ${detached.length} scene object(s), so the player would not run them; fix the scripts or their references and rebuild:\n${[...new Set(detached)].slice(0, 6).join("\n")}`
              : `The Unity ${input.target} build failed (${String(report["result"] ?? report["status"] ?? "no status")}): ${buildErrors(report["errors"]).slice(0, 1500)}`,
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
   * engine runtime library). It builds into the core's staging folder and is
   * checked for those three before the core compares the sources and
   * publishes it. The caller imports first, in the same editor hold.
   */
  const release: GameEngineBackend["release"] = (ctx, input) =>
    Effect.gen(function* () {
      if (input.target === "Web")
        return yield* new GameOperationError({
          operation: input.operation,
          path: ctx.root,
          reason: "invalid-input",
          detail: "Unity games make no Web release.",
        });
      const executable = input.target === "Windows" ? "game.exe" : "game.x86_64";
      const runtime = input.target === "Windows" ? "UnityPlayer.dll" : "UnityPlayer.so";
      const result = yield* buildPlayer(ctx, {
        target: input.target,
        outputPath: NodePath.join(input.staging, executable),
        operation: input.operation,
      });
      if (!result.success) return { result, artifact: null, notes: [] };
      // Unity names this debug-symbol folder itself: it is never shipped.
      const debugSymbols = NodePath.join(
        input.staging,
        "game_BackUpThisFolder_ButDontShipItWithYourGame",
      );
      yield* Effect.tryPromise({
        try: () => NodeFSP.rm(debugSymbols, { recursive: true, force: true }),
        catch: (cause) =>
          new GameOperationError({
            operation: input.operation,
            path: debugSymbols,
            reason: "io",
            cause,
          }),
      });
      const missing = yield* Effect.promise(async () => {
        const absent: string[] = [];
        for (const [name, kind] of [
          [executable, "file"],
          ["game_Data", "directory"],
          [runtime, "file"],
        ] as const) {
          const stat = await NodeFSP.stat(NodePath.join(input.staging, name)).catch(() => null);
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
              `The Unity ${input.target} build is missing ${missing.join(", ")}; nothing was replaced.\n${result.message}`.slice(
                -4096,
              ),
          },
          artifact: null,
          notes: [],
        };
      return {
        result,
        artifact: executable,
        notes: [
          input.target === "Windows"
            ? "Unity Windows x86_64 build ready at builds/windows/game.exe with game_Data/, UnityPlayer.dll and MonoBleedingEdge/ beside it; ship the whole folder. This machine did not run it on Windows."
            : "Unity Linux x86_64 build ready at builds/linux/game.x86_64 with game_Data/ and UnityPlayer.so beside it; ship the whole folder.",
        ],
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
        const projectDir = insideGame(root, manifestProject(manifest));
        const unity = yield* tools.unity(projectDir);
        return {
          binary: { path: unity.editor, version: unity.version, templates: null },
          projectName: manifestProject(manifest),
          projectDir,
        };
      }),
    // The toolchain picks a Unity editor by the project's own version.
    toolStatus: (root, manifest) =>
      Effect.map(
        tools.status({ unityProject: insideGame(root, manifestProject(manifest)) }),
        (status) => status.tools.find((tool) => tool.tool === "unity") ?? null,
      ),
    viewport: () => Effect.succeed({ ...UNITY_VIEWPORT }),
    projectSettingsFile: "ProjectSettings/ProjectSettings.asset",
    projectDirectory: (manifest) => manifestProject(manifest),
    projectSettings: () => ({ viewport: { ...UNITY_VIEWPORT } }),
    importProject,
    runCheck,
    // Players build in the live editor: no export templates and no preset.
    exportReady: () => Effect.void,
    exportPreset: (_ctx, target) => Effect.succeed({ name: target, added: false }),
    release,
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
        live.hold(ctx.root)(
          Effect.tryPromise({
            try: () => NodeFSP.writeFile(warmMarker(ctx), "warm\n"),
            catch: (cause) =>
              new GameOperationError({
                operation: "unity-warm",
                path: warmMarker(ctx),
                reason: "io",
                cause,
              }),
          }),
        ),
    },
    // The prepared player of the current sources plays; the editor is not needed again.
    playProcess: (input) =>
      Effect.gen(function* () {
        if (input.player === null)
          return yield* new GameOperationError({
            operation: "Play session",
            path: input.projectDir,
            reason: "invalid-input",
            detail: "A Unity session plays a prepared player, and none was given.",
          });
        if (HOST_OS === "darwin")
          return yield* new GameOperationError({
            operation: "Play session",
            path: input.projectDir,
            reason: "unsupported-platform",
            detail:
              "Kurambit does not play Unity games on macOS yet: it builds and plays Linux and Windows players only. The Unity editor tools still work here.",
          });
        // A Windows player keeps PlayerPrefs in the registry and saves under the
        // LocalLow known folder, neither of which HOME moves: a session could
        // read earlier sessions and write the user's real prefs and saves.
        if (HOST_OS === "win32")
          return yield* new GameOperationError({
            operation: "Play session",
            path: input.projectDir,
            reason: "unsupported-platform",
            detail:
              "Kurambit does not play Unity games on Windows yet: a session cannot be kept apart from the user's own Unity prefs and saves there. The Unity editor tools still work here.",
          });
        if (input.window === null)
          return yield* new GameOperationError({
            operation: "Play session",
            path: input.projectDir,
            reason: "tool-missing",
            detail:
              "A Unity session needs a window for its player, and this machine has no private display; install the system Xvfb package.",
          });
        const home = NodePath.join(input.saves ?? input.traceDir, "home");
        yield* Effect.tryPromise({
          try: () => NodeFSP.mkdir(home, { recursive: true }),
          catch: (cause) =>
            new GameOperationError({ operation: "Play session", path: home, reason: "io", cause }),
        });
        return {
          executable: input.player,
          args: [
            "-kurambitExplore",
            input.requestPath,
            "-screen-fullscreen",
            "0",
            "-screen-width",
            String(input.viewport.width),
            "-screen-height",
            String(input.viewport.height),
            ...(input.window === "offscreen"
              ? // The user's desktop and GPU: a borderless window the probe
                // moves off every monitor without activating it.
                ["-popupwindow", "-kurambitOffscreen"]
              : // Xvfb offers software OpenGL only.
                ["-force-glcore"]),
            "-logFile",
            NodePath.join(input.traceDir, "player.log"),
          ],
          // The player keeps its prefs under the session's scratch HOME (a kept
          // session's stable one), never the user's ~/.config/unity3d.
          env: {
            ...GameProcesses.engineChildEnv(),
            HOME: home,
            XDG_CONFIG_HOME: NodePath.join(home, ".config"),
            LIBGL_ALWAYS_SOFTWARE: "1",
            LP_NUM_THREADS: "2",
          },
          request: {},
          scratch: input.saves === null ? [home] : [],
          inputNote: "Keys and mouse go in through the Input System. ",
        };
      }),
    player: {
      playTarget: UNITY_PLAY.target,
      executable: UNITY_PLAY.executable,
      cacheDir: unityPlayerDirectory,
      isCacheDir: isPlayerDirectory,
      complete: (directory) => Effect.promise(() => completePlayer(directory)),
    },
  };
};
