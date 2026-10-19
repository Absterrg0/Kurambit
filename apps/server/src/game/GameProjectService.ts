// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem, process, or loopback HTTP boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  CommandId,
  DEFAULT_GAME_TEMPLATE,
  ProjectId,
  ThreadId,
  GameManifest,
  GameOperationError,
  type GameAsset,
  type GameCreateInput,
  type GameOpenInput,
  type GameProjectResult,
} from "@t3tools/contracts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GameProcesses from "./GameProcesses.ts";
import { commandDetail } from "./commandDetail.ts";
import { parseGodotViewport, type GodotViewport } from "./godotViewport.ts";
import { isWebBuildStale } from "./webBuild.ts";
import { scaffoldFiles } from "./scaffold.ts";
import { copyTemplateIntoGame, resolveTemplatesDirectory } from "./templates.ts";

export const insideGame = (root: string, relative: string) => {
  const target = NodePath.resolve(root, relative);
  if (NodePath.isAbsolute(relative) || target === root || !target.startsWith(root + NodePath.sep))
    throw new GameOperationError({
      operation: "resolve-path",
      path: relative,
      reason: "invalid-path",
    });
  return target;
};
export class GameProjectService extends Context.Service<
  GameProjectService,
  {
    readonly create: (
      input: GameCreateInput,
    ) => Effect.Effect<typeof GameProjectResult.Type, GameOperationError>;
    readonly open: (
      input: typeof GameOpenInput.Type,
    ) => Effect.Effect<typeof GameProjectResult.Type, GameOperationError>;
    readonly resolve: (threadId: ThreadId) => Effect.Effect<string, GameOperationError>;
    readonly read: (root: string) => Effect.Effect<GameManifest, GameOperationError>;
    readonly upsertAsset: (
      root: string,
      asset: GameAsset,
    ) => Effect.Effect<void, GameOperationError>;
    readonly inventory: (root: string) => Effect.Effect<
      {
        manifest: GameManifest;
        assets: readonly (GameAsset & { usedBy: string[] })[];
        scenes: string[];
        viewport: GodotViewport;
        webBuildStale: boolean;
        builds: { target: string; path: string; updatedAt: string }[];
      },
      GameOperationError
    >;
  }
>()("t3/game/GameProjectService") {}
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(GameManifest));
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(GameManifest));
const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const processes = yield* GameProcesses.GameProcesses;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = (root: string) =>
    Effect.tryPromise({
      try: async () => {
        const manifest = decodeManifest(
          await NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8"),
        );
        insideGame(root, manifest.godotProject);
        for (const asset of manifest.assets)
          for (const relative of [
            asset.source,
            asset.script,
            asset.export,
            ...(asset.thumbnail ? [asset.thumbnail] : []),
          ])
            insideGame(root, relative);
        return manifest;
      },
      catch: (cause) =>
        new GameOperationError({
          operation: "read-game",
          path: NodePath.join(root, "game.json"),
          reason: "invalid-project",
          cause,
        }),
    });
  const register = Effect.fnUntraced(function* (
    root: string,
    input: Pick<GameCreateInput, "modelSelection" | "runtimeMode">,
    message?: string,
  ) {
    const manifest = yield* read(root);
    const project = yield* projects.getByWorkspaceRoot(root).pipe(
      Effect.flatMap((existing) =>
        Option.isSome(existing)
          ? Effect.succeed(existing.value)
          : projects
              .bootstrap({
                commandId: CommandId.make(NodeCrypto.randomUUID()),
                projectId: ProjectId.make(NodeCrypto.randomUUID()),
                title: manifest.name,
                workspaceRoot: root,
              })
              .pipe(Effect.map((result) => result.project)),
      ),
      Effect.mapError(
        (cause) =>
          new GameOperationError({ operation: "register-game", path: root, reason: "io", cause }),
      ),
    );
    const result = yield* launches
      .launch({
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        projectId: project.id,
        title: manifest.name,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode ?? "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        ...(message ? { initialMessage: { text: message, attachments: [] } } : {}),
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new GameOperationError({
              operation: "launch-game-thread",
              path: root,
              reason: "io",
              cause,
            }),
        ),
      );
    return { projectId: project.id, threadId: result.threadId, root };
  });
  const create: GameProjectService["Service"]["create"] = Effect.fn("GameProjectService.create")(
    function* (input) {
      const name = input.name.trim();
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      if (!slug)
        return yield* new GameOperationError({
          operation: "create-game",
          path: input.name,
          reason: "invalid-path",
        });
      const parent = input.parentDirectory.trim() || NodePath.join(NodeOS.homedir(), "Games");
      const root = NodePath.resolve(parent.replace(/^~(?=\/|$)/, NodeOS.homedir()), slug);
      const template = input.template ?? DEFAULT_GAME_TEMPLATE;
      let created = false;
      const removeCreatedRoot = Effect.promise(async () => {
        if (!created) return;
        await NodeFSP.rm(root, { recursive: true, force: true }).catch(() => {});
      });
      return yield* Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(NodePath.dirname(root), { recursive: true });
            await NodeFSP.mkdir(root); // Never adopt or overwrite an existing directory during creation.
            created = true;
            for (const relative of [
              "art/blender",
              "art/scripts",
              "art/previews",
              "godot/assets/models",
              "godot/scripts",
              "godot/tests",
              "builds/web",
              "builds/linux",
            ])
              await NodeFSP.mkdir(NodePath.join(root, relative), { recursive: true });
            for (const [relative, contents] of Object.entries(scaffoldFiles(input))) {
              const file = NodePath.join(root, relative);
              await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
              await NodeFSP.writeFile(file, contents, { flag: "wx" });
            }
          },
          catch: (cause) =>
            new GameOperationError({ operation: "scaffold-game", path: root, reason: "io", cause }),
        });
        const templatesDirectory = yield* resolveTemplatesDirectory().pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        yield* copyTemplateIntoGame({
          templatesDirectory,
          templateId: template,
          gameRoot: root,
          gameName: name,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        for (const args of [
          ["init"],
          ["add", "."],
          [
            "-c",
            "user.name=Game Studio",
            "-c",
            "user.email=studio@localhost",
            "commit",
            "-m",
            "chore: create game project",
          ],
        ]) {
          const result = yield* processes.run({
            root,
            executable: "git",
            args,
            operation: "git-init",
            timeoutMs: 30_000,
          });
          if (result.exitCode !== 0)
            return yield* new GameOperationError({
              operation: "git-init",
              path: result.logPath,
              reason: "command-failed",
              detail: commandDetail(result),
            });
        }
        return yield* register(
          root,
          input,
          `${input.brief}${input.artDirection ? `\n\nArt direction:\n${input.artDirection}` : ""}\n\nRead AGENTS.md. Build a playable game, run a headless gameplay test, and finish with a working web preview using the Game Studio tools.`,
        );
      }).pipe(
        // A create that fails or is interrupted must not leave a half-made folder
        // behind; never remove a directory this call did not create.
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : removeCreatedRoot)),
      );
    },
  );
  const resolve = Effect.fn("GameProjectService.resolve")(function* (threadId: ThreadId) {
    const thread = yield* threads.getThreadShell(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new GameOperationError({
            operation: "resolve-thread",
            path: threadId,
            reason: "project-not-found",
            cause,
          }),
      ),
    );
    if (!thread || thread.deletedAt !== null)
      return yield* new GameOperationError({
        operation: "resolve-thread",
        path: threadId,
        reason: "project-not-found",
      });
    const project = yield* projects.getById(thread.projectId).pipe(
      Effect.mapError(
        (cause) =>
          new GameOperationError({
            operation: "resolve-project",
            path: thread.projectId,
            reason: "project-not-found",
            cause,
          }),
      ),
    );
    if (Option.isNone(project))
      return yield* new GameOperationError({
        operation: "resolve-project",
        path: thread.projectId,
        reason: "project-not-found",
      });
    const root = NodePath.resolve(thread.worktreePath ?? project.value.workspaceRoot);
    yield* read(root);
    return root;
  });
  const assetWrites = new Map<string, Promise<void>>();
  return GameProjectService.of({
    create,
    open: (input) =>
      register(NodePath.resolve(input.path.replace(/^~(?=\/|$)/, NodeOS.homedir())), input),
    resolve,
    read,
    upsertAsset: (root, asset) =>
      Effect.tryPromise({
        try: async () => {
          const previous = assetWrites.get(root) ?? Promise.resolve();
          const write = previous
            .catch(() => {})
            .then(async () => {
              const manifest = decodeManifest(
                await NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8"),
              );
              const assets = manifest.assets.filter((entry) => entry.id !== asset.id).concat(asset);
              const temporary = NodePath.join(root, `.game-${NodeCrypto.randomUUID()}.json`);
              try {
                await NodeFSP.writeFile(temporary, encodeManifest({ ...manifest, assets }) + "\n");
                await NodeFSP.rename(temporary, NodePath.join(root, "game.json"));
              } finally {
                await NodeFSP.rm(temporary, { force: true });
              }
            });
          assetWrites.set(root, write);
          try {
            await write;
          } finally {
            if (assetWrites.get(root) === write) assetWrites.delete(root);
          }
        },
        catch: (cause) =>
          new GameOperationError({ operation: "save-asset", path: root, reason: "io", cause }),
      }),
    inventory: Effect.fn("GameProjectService.inventory")(function* (root) {
      const manifest = yield* read(root);
      const webBuildStale = yield* isWebBuildStale(root, manifest.godotProject);
      return yield* Effect.tryPromise({
        try: async () => {
          const engineRoot = insideGame(root, manifest.godotProject);
          const projectGodot = await NodeFSP.readFile(
            NodePath.join(engineRoot, "project.godot"),
            "utf8",
          ).catch(() => "");
          const viewport = parseGodotViewport(projectGodot);
          const scenes: string[] = [];
          const sourceFiles: string[] = [];
          const walk = async (directory: string) => {
            for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
              if (entry.isDirectory() && !entry.name.startsWith("."))
                await walk(NodePath.join(directory, entry.name));
              else if (
                entry.isFile() &&
                (entry.name.endsWith(".tscn") || entry.name.endsWith(".gd"))
              ) {
                const relative = NodePath.relative(root, NodePath.join(directory, entry.name));
                sourceFiles.push(relative);
                if (entry.name.endsWith(".tscn")) scenes.push(relative);
              }
            }
          };
          await walk(engineRoot);
          const sources = await Promise.all(
            sourceFiles.map(async (file) => ({
              file,
              source: await NodeFSP.readFile(insideGame(root, file), "utf8"),
            })),
          );
          const assets = manifest.assets.map((asset) => ({
            ...asset,
            usedBy: sources
              .filter(({ source }) =>
                source.includes(
                  `"res://${NodePath.relative(manifest.godotProject, asset.export).split(NodePath.sep).join("/")}"`,
                ),
              )
              .map(({ file }) => file),
          }));
          const builds: { target: string; path: string; updatedAt: string }[] = [];
          for (const [target, relative] of [
            ["Web", "builds/web/index.html"],
            ["Linux", "builds/linux/game.x86_64"],
          ]) {
            try {
              const stat = await NodeFSP.stat(NodePath.join(root, relative!));
              builds.push({
                target: target!,
                path: relative!,
                updatedAt: stat.mtime.toISOString(),
              });
            } catch {
              /* A game need not have been built yet. */
            }
          }
          return { manifest, assets, scenes, builds, viewport, webBuildStale };
        },
        catch: (cause) =>
          new GameOperationError({ operation: "inventory", path: root, reason: "io", cause }),
      });
    }),
  });
});
export const layer = Layer.effect(GameProjectService, make);
