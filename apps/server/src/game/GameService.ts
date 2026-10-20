// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem, process, or loopback HTTP boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  GameOperationError,
  type GameCheckResult,
  type GameSceneInspectResult,
  type GameStatus,
  type GameAction,
  type GameActionResult,
  type GameBlenderInput,
  GameBlenderResult,
  GameWebPlaytestInput,
  GameWebPlaytestResult,
  type GameProcessResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GamePreview from "./GamePreview.ts";
import { insideGame } from "./GameProjectService.ts";
import { commandDetail } from "./commandDetail.ts";
import { isWebBuildStale, webBuildIndex } from "./webBuild.ts";
import { blenderWrapper } from "./blenderScript.ts";
import * as GameWebPlaytest from "./GameWebPlaytest.ts";
import {
  RawCheckResult,
  mergeCheckIssues,
  parseGodotIssues,
  limitIssues,
} from "./godotCheckOutput.ts";
import { GODOT_CHECK_SCRIPT } from "./godotCheckScript.ts";
import { GODOT_INSPECT_SCRIPT } from "./godotInspectScript.ts";
import { readLastPlaytest, writePlaytestEvidence } from "./playtestEvidence.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";

export class GameService extends Context.Service<
  GameService,
  {
    readonly cancelThread: (threadId: ThreadId) => Effect.Effect<void, GameOperationError>;
    readonly status: (threadId: ThreadId) => Effect.Effect<GameStatus, GameOperationError>;
    readonly action: (
      threadId: ThreadId,
      action: GameAction,
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    readonly blender: (
      threadId: ThreadId,
      input: typeof GameBlenderInput.Type,
    ) => Effect.Effect<typeof GameBlenderResult.Type, GameOperationError>;
    readonly import: (threadId: ThreadId) => Effect.Effect<GameActionResult, GameOperationError>;
    readonly test: (
      threadId: ThreadId,
      script: string,
      timeoutMs?: number,
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    readonly export: (
      threadId: ThreadId,
      target: "Web" | "Linux",
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    readonly webPlaytest: (
      threadId: ThreadId,
      input: GameWebPlaytestInput,
    ) => Effect.Effect<GameWebPlaytestResult, GameOperationError>;
    readonly check: (threadId: ThreadId) => Effect.Effect<GameCheckResult, GameOperationError>;
    readonly inspectScene: (
      threadId: ThreadId,
      scenePath: string,
    ) => Effect.Effect<GameSceneInspectResult, GameOperationError>;
  }
>()("t3/game/GameService") {}
const decodeBlenderMetadata = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      objects: Schema.Number,
      meshes: Schema.Number,
      materials: Schema.Number,
      dimensions: Schema.Array(Schema.Number),
      warnings: Schema.Array(Schema.String),
    }),
  ),
);
const RawSceneInspect = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.optionalKey(Schema.String),
    scenePath: Schema.optionalKey(Schema.String),
    nodes: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          path: Schema.String,
          name: Schema.String,
          type: Schema.String,
          script: Schema.optionalKey(Schema.String),
          groups: Schema.Array(Schema.String),
          position: Schema.optionalKey(Schema.Array(Schema.Number)),
          collisionLayer: Schema.optionalKey(Schema.Number),
          collisionMask: Schema.optionalKey(Schema.Number),
          children: Schema.Array(Schema.String),
        }),
      ),
    ),
    nodeCount: Schema.optionalKey(Schema.Number),
    truncated: Schema.optionalKey(Schema.Boolean),
  }),
);
const decodeSceneInspect = Schema.decodeUnknownSync(RawSceneInspect);
const decodeCheckResult = Schema.decodeUnknownSync(RawCheckResult);
const decodeText = <A>(decode: (text: string) => A, text: string | null): A | null => {
  if (text === null) return null;
  try {
    return decode(text);
  } catch {
    return null;
  }
};
const isGameOperationError = Schema.is(GameOperationError);
const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const processes = yield* GameProcesses.GameProcesses;
  const tools = yield* GameToolchain.GameToolchain;
  const preview = yield* GamePreview.GamePreview;
  const browser = yield* PreviewBrowser.PreviewBrowser;
  const operations = new Map<string, NonNullable<GameStatus["operation"]>>();
  const active = new Map<
    string,
    { cancelled: Deferred.Deferred<void>; done: Deferred.Deferred<void> }
  >();
  const cancel = Effect.fnUntraced(function* (root: string) {
    const operation = active.get(root);
    if (operation === undefined) return;
    yield* Deferred.succeed(operation.cancelled, undefined);
    // The race interrupts work and awaits its finalizers, including native child exit.
    yield* Deferred.await(operation.done);
  });
  const exclusive = <A>(root: string, name: string, work: Effect.Effect<A, GameOperationError>) =>
    Effect.gen(function* () {
      if (active.has(root))
        return yield* new GameOperationError({ operation: name, path: root, reason: "busy" });
      const cancelled = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const at = DateTime.formatIso(yield* DateTime.now);
      active.set(root, { cancelled, done });
      operations.set(root, { name, state: "running", message: `${name} is running.`, at });
      return yield* work.pipe(
        Effect.raceFirst(
          Deferred.await(cancelled).pipe(
            Effect.andThen(
              Effect.fail(
                new GameOperationError({
                  operation: name,
                  path: root,
                  reason: "command-failed",
                  detail: "Operation cancelled.",
                }),
              ),
            ),
          ),
        ),
        Effect.tap((result) =>
          Effect.sync(() => {
            const failed =
              typeof result === "object" &&
              result !== null &&
              "success" in result &&
              result.success === false;
            operations.set(root, {
              name,
              state: failed ? "failed" : "succeeded",
              message:
                typeof result === "object" && result !== null && "message" in result
                  ? String(result.message)
                  : `${name} completed.`,
              at,
            });
          }),
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            operations.set(root, { name, state: "failed", message: error.message, at });
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            operations.set(root, { name, state: "failed", message: `${name} was cancelled.`, at });
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            active.delete(root);
          }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
        ),
      );
    });
  const engine = Effect.fnUntraced(function* (root: string) {
    const manifest = yield* projects.read(root);
    const godot = yield* tools.executable("godot");
    return { godot, cwd: insideGame(root, manifest.godotProject) };
  });
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
  const importGame = Effect.fnUntraced(function* (root: string) {
    const { godot, cwd } = yield* engine(root);
    return response(
      yield* processes.run({
        root,
        executable: godot.path,
        args: ["--headless", "--path", cwd, "--editor", "--import"],
        operation: "godot-import",
        timeoutMs: 180_000,
      }),
    );
  });
  const exportGame = Effect.fnUntraced(function* (root: string, target: "Web" | "Linux") {
    const { godot, cwd } = yield* engine(root);
    const toolStatus = yield* tools.status;
    const engineStatus = toolStatus.tools.find((tool) => tool.tool === "godot");
    if (!engineStatus?.ready)
      return yield* new GameOperationError({
        operation: "Godot export",
        path: godot.templates ?? godot.path,
        reason: "templates-missing",
        detail: `Godot executable: ${godot.path} (${godot.version}).`,
      });
    const imported = yield* importGame(root);
    if (!imported.success) return imported;
    const output = NodePath.join(
      root,
      target === "Web" ? "builds/web/index.html" : "builds/linux/game.x86_64",
    );
    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdir(NodePath.dirname(output), { recursive: true }),
      catch: (cause) =>
        new GameOperationError({ operation: "export", path: output, reason: "io", cause }),
    });
    const result = response(
      yield* processes.run({
        root,
        executable: godot.path,
        args: ["--headless", "--path", cwd, "--export-release", target, output],
        operation: `export-${target.toLowerCase()}`,
        timeoutMs: 300_000,
      }),
      output,
    );
    if (!result.success) return result;
    yield* Effect.tryPromise({
      try: async () => {
        for (const file of target === "Web"
          ? [
              output,
              output.replace(/\.html$/, ".wasm"),
              output.replace(/\.html$/, ".js"),
              output.replace(/\.html$/, ".pck"),
            ]
          : [output]) {
          const stat = await NodeFSP.stat(file);
          if (!stat.isFile() || stat.size === 0) throw new Error(`Empty export: ${file}`);
        }
      },
      catch: (cause) =>
        new GameOperationError({
          operation: "export-output",
          path: output,
          reason: "command-failed",
          detail:
            `Expected nonempty export files were missing.\n${commandDetail(result.process!)}`.slice(
              -4096,
            ),
          cause,
        }),
    });
    return result;
  });
  const webPlaytest = Effect.fnUntraced(function* (root: string, input: GameWebPlaytestInput) {
    if (yield* isWebBuildStale(root, (yield* projects.read(root)).godotProject)) {
      const exported = yield* exportGame(root, "Web");
      if (!exported.success)
        return yield* new GameOperationError({
          operation: "Web playtest",
          path: NodePath.join(root, "builds/web"),
          reason: "command-failed",
          detail: exported.message,
        });
    }
    const url = yield* preview.open(root);
    const executable = yield* browser.executable.pipe(
      Effect.mapError(
        (cause) =>
          new GameOperationError({
            operation: "Web playtest",
            path: root,
            reason: "tool-missing",
            detail: `Game Studio's preview browser is not ready. ${cause.message} Once the install finishes, retry game_web_playtest.`,
          }),
      ),
    );
    const result = yield* GameWebPlaytest.playtest({
      executable,
      url,
      profileDirectory: NodePath.join(root, "builds/logs", `playtest-${NodeCrypto.randomUUID()}`),
      width: input.width ?? 960,
      height: input.height ?? 540,
      bootTimeoutMs: input.bootTimeoutMs ?? 90_000,
      steps: input.steps ?? [],
    });
    const evidence = yield* Effect.tryPromise({
      try: () =>
        writePlaytestEvidence({
          root,
          result,
          steps: input.steps ?? [],
        }),
      catch: (cause) =>
        new GameOperationError({
          operation: "Web playtest evidence",
          path: NodePath.join(root, "builds/playtests"),
          reason: "io",
          cause,
        }),
    });
    return { ...result, evidenceDirectory: evidence.directory };
  });
  /** Imports first: a fresh game has no .godot cache, so .tres files and class_names cannot resolve. */
  const checkGame = Effect.fnUntraced(function* (root: string) {
    const startedAt = yield* Clock.currentTimeMillis;
    const temporary = NodePath.join(root, "builds/logs", `godot-check-${NodeCrypto.randomUUID()}`);
    const scriptPath = NodePath.join(temporary, "check.gd");
    const resultPath = NodePath.join(temporary, "result.json");
    const { godot, cwd } = yield* engine(root);
    const imported = yield* importGame(root);
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
        root,
        executable: godot.path,
        args: ["--headless", "--path", cwd, "--script", scriptPath, "--", resultPath],
        operation: "godot-check",
        timeoutMs: 120_000,
      });
      const resultText = yield* Effect.promise(() =>
        NodeFSP.readFile(resultPath, "utf8").catch(() => null),
      );
      const reported = decodeText(decodeCheckResult, resultText);
      const importedOutput =
        imported.process === null ? "" : `${imported.process.stdout}\n${imported.process.stderr}`;
      const importedIssues = parseGodotIssues(importedOutput);
      const parsed = [...importedIssues, ...parseGodotIssues(`${run.stdout}\n${run.stderr}`)];
      const errors = mergeCheckIssues(reported?.errors ?? [], parsed);
      if (!imported.success && importedIssues.length === 0)
        errors.unshift({
          file: "godot/project.godot",
          message: `Import failed with exit code ${imported.process?.exitCode ?? -1}. ${imported.message}`,
        });
      if (reported === null)
        errors.unshift({
          file: "godot/project.godot",
          message:
            "The Godot check script did not report a result. The project may have crashed during startup.",
        });
      if (run.timedOut)
        errors.unshift({
          file: "godot/project.godot",
          message: "The Godot check timed out before finishing its 120 physics frames.",
        });
      if (run.exitCode !== 0 && errors.length === 0)
        errors.unshift({
          file: "godot/project.godot",
          message: `Godot exited with code ${run.exitCode}. ${commandDetail(run)}`,
        });
      return {
        ok: errors.length === 0 && reported !== null && !run.timedOut,
        errors: limitIssues(errors),
        warnings: limitIssues(reported?.warnings ?? []),
        durationMs: (yield* Clock.currentTimeMillis) - startedAt,
      };
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
      ),
    );
  });
  const inspectScene = Effect.fnUntraced(function* (root: string, scenePath: string) {
    const { godot, cwd } = yield* engine(root);
    const relative = scenePath.replace(/^res:\/\//, "");
    const resolved = yield* Effect.try({
      try: () => insideGame(cwd, relative),
      catch: (cause) =>
        isGameOperationError(cause)
          ? cause
          : new GameOperationError({
              operation: "inspect-scene",
              path: scenePath,
              reason: "invalid-path",
              cause,
            }),
    });
    if (!resolved.endsWith(".tscn"))
      return yield* new GameOperationError({
        operation: "inspect-scene",
        path: scenePath,
        reason: "invalid-path",
      });
    const temporary = NodePath.join(
      root,
      "builds/logs",
      `godot-inspect-${NodeCrypto.randomUUID()}`,
    );
    const scriptPath = NodePath.join(temporary, "inspect.gd");
    const resultPath = NodePath.join(temporary, "result.json");
    return yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(temporary, { recursive: true });
          await NodeFSP.writeFile(scriptPath, GODOT_INSPECT_SCRIPT);
        },
        catch: (cause) =>
          new GameOperationError({
            operation: "inspect-scene",
            path: temporary,
            reason: "io",
            cause,
          }),
      });
      const run = yield* processes.run({
        root,
        executable: godot.path,
        args: ["--headless", "--path", cwd, "--script", scriptPath, "--", resolved, resultPath],
        operation: "godot-inspect",
        timeoutMs: 60_000,
      });
      const resultText = yield* Effect.promise(() =>
        NodeFSP.readFile(resultPath, "utf8").catch(() => null),
      );
      const raw = decodeText(decodeSceneInspect, resultText);
      if (raw === null || raw.error !== undefined)
        return yield* new GameOperationError({
          operation: "inspect-scene",
          path: scenePath,
          reason: "command-failed",
          detail: (raw?.error ?? commandDetail(run)).slice(-4096),
        });
      return {
        scenePath: `res://${NodePath.relative(cwd, resolved).split(NodePath.sep).join("/")}`,
        nodes: raw.nodes ?? [],
        nodeCount: raw.nodeCount ?? raw.nodes?.length ?? 0,
        truncated: raw.truncated ?? false,
      };
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
      ),
    );
  });
  const withRoot = Effect.fnUntraced(function* <A>(
    threadId: ThreadId,
    name: string,
    work: (root: string) => Effect.Effect<A, GameOperationError>,
  ) {
    const root = yield* projects.resolve(threadId);
    return yield* exclusive(root, name, work(root));
  });
  /**
   * The design phase is the gate between planning and building: while DESIGN.md
   * is only a draft the game must not export, preview, run or playtest, and must
   * not mint Blender assets. Prompts ask the agent to wait, but a weak model can
   * ignore them and build an unreviewed game, so the stage state enforces it.
   */
  const refuseWhileDraft = (root: string, operation: string) =>
    Effect.gen(function* () {
      const manifest = yield* projects.read(root).pipe(Effect.orElseSucceed(() => null));
      if (manifest?.design?.status !== "draft") return;
      return yield* new GameOperationError({
        operation,
        path: NodePath.join(root, "game.json"),
        reason: "design-draft",
      });
    });
  return GameService.of({
    cancelThread: Effect.fn("GameService.cancelThread")(function* (threadId) {
      const root = yield* projects.resolve(threadId).pipe(
        Effect.catchTags({
          GameOperationError: (error) =>
            error.reason === "project-not-found" || error.reason === "invalid-project"
              ? Effect.succeed(null)
              : Effect.fail(error),
        }),
      );
      if (root !== null) yield* cancel(root);
    }),
    status: Effect.fn("GameService.status")(function* (threadId) {
      const root = yield* projects.resolve(threadId);
      const inventory = yield* projects.inventory(root);
      const lastPlaytest = yield* Effect.tryPromise({
        try: () => readLastPlaytest(root, inventory.builds),
        catch: () =>
          new GameOperationError({
            operation: "read-playtest",
            path: NodePath.join(root, "builds/playtests"),
            reason: "io",
          }),
      }).pipe(Effect.orElseSucceed(() => null));
      return {
        root,
        ...inventory,
        toolchain: yield* tools.status,
        processes: processes.list(root),
        previewUrl: preview.url(root),
        logsDirectory: NodePath.join(root, "builds/logs"),
        lastPlaytest,
        operation: operations.get(root) ?? null,
      };
    }),
    import: (threadId) => withRoot(threadId, "Import", importGame),
    export: (threadId, target) =>
      withRoot(threadId, `Export ${target}`, (root) =>
        Effect.andThen(refuseWhileDraft(root, "export"), exportGame(root, target)),
      ),
    webPlaytest: (threadId, input) =>
      withRoot(threadId, "Web playtest", (root) =>
        Effect.andThen(refuseWhileDraft(root, "web-playtest"), webPlaytest(root, input)),
      ),
    check: (threadId) => withRoot(threadId, "Godot check", checkGame),
    inspectScene: (threadId, scenePath) =>
      withRoot(threadId, "Inspect scene", (root) => inspectScene(root, scenePath)),
    test: (threadId, script, timeoutMs = 60_000) =>
      withRoot(threadId, "Test", (root) =>
        Effect.gen(function* () {
          const { godot, cwd } = yield* engine(root);
          const resolved = yield* Effect.try({
            try: () => insideGame(cwd, script.replace(/^res:\/\//, "")),
            catch: (cause) =>
              isGameOperationError(cause)
                ? cause
                : new GameOperationError({
                    operation: "test",
                    path: script,
                    reason: "invalid-path",
                    cause,
                  }),
          });
          if (!resolved.endsWith(".gd"))
            return yield* new GameOperationError({
              operation: "test",
              path: script,
              reason: "invalid-path",
            });
          return response(
            yield* processes.run({
              root,
              executable: godot.path,
              args: ["--headless", "--path", cwd, "--script", resolved],
              operation: "godot-test",
              timeoutMs: Math.max(1_000, Math.min(timeoutMs, 300_000)),
            }),
          );
        }),
      ),
    blender: (threadId, input) =>
      withRoot(threadId, "Blender asset", (root) =>
        Effect.gen(function* () {
          yield* refuseWhileDraft(root, "blender");
          const blender = yield* tools.executable("blender");
          const manifest = yield* projects.read(root);
          if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.id))
            return yield* new GameOperationError({
              operation: "blender",
              path: input.id,
              reason: "invalid-path",
            });
          const asset = {
            id: input.id,
            kind: "model" as const,
            source: `art/blender/${input.id}.blend`,
            script: `art/scripts/${input.id}.py`,
            export: `${manifest.godotProject}/assets/models/${input.id}.glb`,
            ...(input.thumbnail === false ? {} : { thumbnail: `art/previews/${input.id}.png` }),
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          };
          const temporary = NodePath.join(
            root,
            "builds/logs",
            `blender-${NodeCrypto.randomUUID()}`,
          );
          return yield* Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: async () => {
                await NodeFSP.mkdir(temporary, { recursive: true });
                for (const relative of [
                  asset.source,
                  asset.script,
                  asset.export,
                  ...(asset.thumbnail ? [asset.thumbnail] : []),
                ])
                  await NodeFSP.mkdir(NodePath.dirname(insideGame(root, relative)), {
                    recursive: true,
                  });
                await NodeFSP.writeFile(insideGame(root, asset.script), input.script);
                await NodeFSP.writeFile(
                  NodePath.join(temporary, "run.py"),
                  blenderWrapper({
                    reset: input.reset ?? false,
                    source: insideGame(root, asset.source),
                    script: insideGame(root, asset.script),
                    exported: insideGame(root, asset.export),
                    thumbnail: asset.thumbnail ? insideGame(root, asset.thumbnail) : null,
                    metadata: NodePath.join(temporary, "result.json"),
                  }),
                );
              },
              catch: (cause) =>
                new GameOperationError({
                  operation: "blender-prepare",
                  path: temporary,
                  reason: "io",
                  cause,
                }),
            });
            const result = yield* processes.run({
              root,
              executable: blender.path,
              args: [
                "--background",
                "--factory-startup",
                "--threads",
                "2",
                "--python-exit-code",
                "1",
                "--python",
                NodePath.join(temporary, "run.py"),
              ],
              operation: "blender-asset",
              timeoutMs: 300_000,
            });
            if (result.exitCode !== 0)
              return yield* new GameOperationError({
                operation: "blender-asset",
                path: result.logPath,
                reason: "command-failed",
                detail: commandDetail(result),
              });
            const output = yield* Effect.tryPromise({
              try: async () => {
                for (const relative of [
                  asset.source,
                  asset.export,
                  ...(asset.thumbnail ? [asset.thumbnail] : []),
                ])
                  if ((await NodeFSP.stat(insideGame(root, relative))).size === 0)
                    throw new Error("Empty asset");
                return {
                  ...decodeBlenderMetadata(
                    await NodeFSP.readFile(NodePath.join(temporary, "result.json"), "utf8"),
                  ),
                  asset,
                  process: result,
                };
              },
              catch: (cause) =>
                new GameOperationError({
                  operation: "blender-output",
                  path: temporary,
                  reason: "command-failed",
                  detail:
                    `Expected asset files or metadata were missing or invalid.\n${commandDetail(result)}`.slice(
                      -4096,
                    ),
                  cause,
                }),
            });
            yield* projects.upsertAsset(root, asset);
            return output;
          }).pipe(
            Effect.ensuring(
              Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
            ),
          );
        }),
      ),
    action: Effect.fn("GameService.action")(function* (threadId, action) {
      const root = yield* projects.resolve(threadId);
      if (action === "stop") {
        yield* cancel(root);
        yield* processes.stop(root);
        yield* preview.stop(root);
        return {
          success: true,
          message: "Stopped this game's processes and preview server.",
          path: null,
          url: null,
          process: null,
        };
      }
      return yield* exclusive(
        root,
        action,
        Effect.gen(function* () {
          if (action === "verify") {
            const status = yield* tools.verify;
            return {
              success: status.tools.every((tool) => tool.ready && tool.verified),
              message: status.tools.map((tool) => `${tool.tool}: ${tool.message}`).join("\n"),
              path: status.toolsDirectory,
              url: null,
              process: null,
            };
          }
          // Only the toolchain check stays open during a draft; every staging
          // action here moves the game toward a playable build.
          yield* refuseWhileDraft(root, action);
          if (action === "export-linux") return yield* exportGame(root, "Linux");
          if (action === "native") {
            if (processes.list(root).some((entry) => entry.operation === "native"))
              return yield* new GameOperationError({
                operation: "native",
                path: root,
                reason: "busy",
              });
            const { godot, cwd } = yield* engine(root);
            const imported = yield* importGame(root);
            if (!imported.success) return imported;
            const launched = yield* processes.start({
              root,
              executable: godot.path,
              args: ["--path", cwd],
              operation: "native",
              timeoutMs: 24 * 60 * 60_000,
            });
            return {
              success: true,
              message: `Native game started with PID ${launched.pid}. Output: ${launched.logPath}`,
              path: launched.logPath,
              url: null,
              process: null,
            };
          }
          // Play reuses a fresh web build; Rebuild forces a new export. Scenes
          // and scripts can be edited by any provider outside this service, so
          // the freshness check is the only thing that decides.
          const manifest = yield* projects.read(root);
          const needsExport =
            action === "rebuild" || (yield* isWebBuildStale(root, manifest.godotProject));
          if (needsExport) {
            const exported = yield* exportGame(root, "Web");
            if (!exported.success) return exported;
            const url = yield* preview.open(root);
            return { ...exported, message: "Web game is ready to play.", url };
          }
          const url = yield* preview.open(root);
          return {
            success: true,
            message: "Loaded the existing web build.",
            path: webBuildIndex(root),
            url,
            process: null,
          };
        }),
      );
    }),
  });
});
export const layer = Layer.effect(GameService, make);
