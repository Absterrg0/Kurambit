// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem, process, or loopback HTTP boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  CommandId,
  ProjectId,
  ThreadId,
  GameManifest,
  GameOperationError,
  gameTemplateForEngine,
  type GameCreateInput,
  type GameListResult,
  type GameOpenInput,
  type GameProjectResult,
  type GameSummary,
  manifestProject,
} from "@kurambit/contracts";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import { GameCaller, type GameCallerValue } from "./GameCaller.ts";
import * as GameOperations from "./GameOperations.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { toState } from "../orchestration-v2/gameRun/decide.ts";
import { isGameRunOperationOwner } from "../orchestration-v2/gameRun/ids.ts";
import { gameRunHold } from "../orchestration-v2/CommandPolicy.ts";
import { currentStep } from "./run/runView.ts";
import { latestGameActivity, sortGameSummaries } from "./gameSummary.ts";
import { engineProfile } from "./engineProfile.ts";
import { findKeyArt } from "./keyArt.ts";
import { parseGodotViewport, type GodotViewport } from "./godotViewport.ts";
import { realGameRoot } from "./gameRecord.ts";
import { ensureScaffold, ensureTurnSections } from "./runSetup.ts";
import { createEngine, firstTurnMessage, scaffoldFiles } from "./scaffold.ts";
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
/**
 * The folder a new game gets: its name in lower-case ASCII words. Accents fold
 * to their letters; a name with no Latin letters at all (ゲーム, Игра) gets
 * `game-<hex>`, since the name itself stays the game's title.
 */
export const gameFolderName = (name: string, hex: string): string =>
  name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || `game-${hex}`;

/** Written first into a game being created, under the ignored builds/; removed once it is committed. */
const CREATE_MARKER = "builds/.kurambit-creating";

/** A folder a create of ours left half-made: empty, or still holding the marker. */
export const halfMadeCreate = async (root: string): Promise<boolean> => {
  const entries = await NodeFSP.readdir(root).catch(() => null);
  if (entries === null) return false;
  if (entries.length === 0) return true;
  return NodeFSP.lstat(NodePath.join(root, CREATE_MARKER)).then(
    (stat) => stat.isFile(),
    () => false,
  );
};

const gitInitError = (root: string) => (cause: unknown) =>
  new GameOperationError({
    operation: "git-init",
    path: root,
    reason: "tool-failed",
    detail: "git could not create the game's repository and its first commit.",
    cause,
  });

const HELD: Record<"live" | "finishing" | "restoring", string> = {
  live: "A production run is working on this game; this would change the folder its builds and checks read.",
  finishing: "The production run is finishing: it is exporting the game's best build.",
  restoring: "A round of the production run is being restored into this game's folder.",
};
const ROLE_HELD =
  "This chat is one of the production run's roles; only the run's own agent works here while the run is live. Stop the run to work in it yourself.";

/**
 * Whether a write is admitted while a production run holds the game: null to
 * admit, else why not. The one rule, for the service and its test fake. A
 * role's thread (game folder or copy) is written only by its own agent while
 * the run is live; a person looking at it is not that agent. Any other thread
 * is refused only on the run's own game folder.
 */
export const admitDecision = (facts: {
  readonly hold: "live" | "finishing" | "restoring" | null;
  readonly role: boolean | "unknown";
  readonly onRunFolder: boolean;
  readonly caller: GameCallerValue;
}): string | null => {
  if (facts.hold === null) return null;
  if (facts.role === true)
    return facts.hold === "live" && facts.caller.kind === "agent" && facts.caller.runRole
      ? null
      : facts.hold === "live"
        ? ROLE_HELD
        : HELD[facts.hold];
  if (facts.role === "unknown" || facts.onRunFolder) return HELD[facts.hold];
  return null;
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
    /**
     * The games library, in one batched read. The sidebar uses this instead of
     * asking for game status per project.
     */
    readonly list: () => Effect.Effect<GameListResult, GameOperationError>;
    /**
     * The game folder a thread works in. `deleted: "allowed"` resolves a deleted
     * chat's too, for a run's finish and restore, which outlive the chat.
     */
    readonly resolve: (
      threadId: ThreadId,
      options?: { readonly deleted?: "allowed" },
    ) => Effect.Effect<string, GameOperationError>;
    /**
     * How a production run holds this thread's game now: "live", or while its
     * ending's exports ("finishing") or a restore ("restoring") still work the
     * folder; null when no run does.
     */
    readonly runHold: (
      threadId: ThreadId,
    ) => Effect.Effect<"live" | "finishing" | "restoring" | null>;
    /**
     * Refuses an operation that writes the game while a production run holds
     * it, unless the run itself or a role's own agent (GameCaller) asks: the
     * run's builds, checks and exports read the folder as its own, and a
     * creator's Rebuild or edit beside them would make a check fail for a
     * cause that is not the build. `root` names the folder in the refusal.
     */
    readonly admitWrite: (
      threadId: ThreadId,
      root: string,
      operation: string,
      owner: string,
    ) => Effect.Effect<void, GameOperationError>;
    readonly read: (root: string) => Effect.Effect<GameManifest, GameOperationError>;
    /** The manifest and the resolution the game plays at. */
    readonly inventory: (
      root: string,
    ) => Effect.Effect<{ manifest: GameManifest; viewport: GodotViewport }, GameOperationError>;
  }
>()("kurambit/game/GameProjectService") {}
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(GameManifest));

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const operations = yield* GameOperations.GameOperations;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const vcs = yield* VcsDriverRegistry.VcsDriverRegistry;
  const createLocks = yield* KeyedLock.make<string>();
  // The game's run as its records hold it: a card says what a live run is doing.
  const liveRun = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const run = yield* projections.getProjectGameRun(projectId);
      if (run === null || run.status === "ended") return null;
      const records = yield* projections.getGameRunRecords(run.threadId, { steps: "in-flight" });
      const held =
        records.gameRunSteps.find((s) => s.runId === run.id && s.seq === run.inFlight) ?? null;
      return {
        step: currentStep(toState(run, records.gameRunRounds, held)),
        startedAt: run.startedAt,
      } satisfies GameSummary["run"];
    }).pipe(Effect.orElseSucceed(() => null));
  const path = yield* Path.Path;
  /**
   * Every record, lock and cache is keyed by this path, so registration and
   * resolution settle on one real root instead of a lexical alias.
   */
  const resolveCanonicalRoot = (root: string, operation: string) =>
    Effect.tryPromise({
      try: () => realGameRoot(root),
      catch: (cause) =>
        new GameOperationError({ operation, path: root, reason: "invalid-project", cause }),
    });
  const read = (root: string) =>
    Effect.tryPromise({
      try: async () => {
        const manifest = decodeManifest(
          await NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8"),
        );
        insideGame(root, manifestProject(manifest));
        for (const asset of manifest.assets)
          for (const relative of [
            asset.source,
            asset.script,
            asset.export,
            ...(asset.thumbnail ? [asset.thumbnail] : []),
          ])
            insideGame(root, relative);
        for (const family of manifest.families ?? [])
          for (const target of family.paths) {
            if (target.startsWith("res://")) {
              const rest = target.slice("res://".length);
              if (
                rest.length === 0 ||
                rest.includes("\\") ||
                rest.split("/").includes("..") ||
                target.length > 500
              )
                throw new GameOperationError({
                  operation: "resolve-path",
                  path: target,
                  reason: "invalid-path",
                });
              insideGame(root, `${manifestProject(manifest)}/${rest}`);
            } else {
              insideGame(root, target);
            }
          }
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
    options: { readonly resume?: boolean; readonly firstTurn?: boolean } = {},
  ) {
    const lexicalRoot = NodePath.resolve(root);
    const canonicalRoot = yield* resolveCanonicalRoot(lexicalRoot, "register-game");
    const manifest = yield* read(canonicalRoot);
    if (options.resume === true)
      yield* ensureTurnSections(canonicalRoot, manifest.engine.name).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    const project = yield* projects.getByWorkspaceRoot(canonicalRoot).pipe(
      // A project registered before this canonical rule may still store the
      // alias; reuse that row rather than creating a second one for one game.
      Effect.flatMap((existing) =>
        Option.isSome(existing) || lexicalRoot === canonicalRoot
          ? Effect.succeed(existing)
          : projects.getByWorkspaceRoot(lexicalRoot),
      ),
      Effect.flatMap((existing) =>
        Option.isSome(existing)
          ? Effect.succeed(existing.value)
          : projects
              .bootstrap({
                commandId: CommandId.make(NodeCrypto.randomUUID()),
                projectId: ProjectId.make(NodeCrypto.randomUUID()),
                title: manifest.name,
                workspaceRoot: canonicalRoot,
              })
              .pipe(Effect.map((result) => result.project)),
      ),
      Effect.mapError(
        (cause) =>
          new GameOperationError({
            operation: "register-game",
            path: canonicalRoot,
            reason: "io",
            cause,
          }),
      ),
    );
    // Opening a folder is "continue this game", not "start another chat": the
    // project's newest session already has the history and the context.
    if (options.resume === true) {
      const existingThreads = yield* threads
        .listProjectThreads({ projectId: project.id, includeSubagents: false })
        .pipe(
          Effect.mapError(
            (cause) =>
              new GameOperationError({
                operation: "list-game-threads",
                path: canonicalRoot,
                reason: "io",
                cause,
              }),
          ),
        );
      const latest = existingThreads.find(
        (thread) => thread.deletedAt === null && thread.archivedAt === null,
      );
      if (latest !== undefined)
        return { projectId: project.id, threadId: latest.id, root: canonicalRoot };
    }
    const result = yield* launches
      .launch({
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        projectId: project.id,
        title: manifest.name,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode ?? "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        // A new game's chat opens with its brief, sent atomically with the thread.
        ...(options.firstTurn === true
          ? { initialMessage: { text: firstTurnMessage(manifest), attachments: [] } }
          : {}),
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new GameOperationError({
              operation: "launch-game-thread",
              path: canonicalRoot,
              reason: "io",
              cause,
            }),
        ),
      );
    return { projectId: project.id, threadId: result.threadId, root: canonicalRoot };
  });
  const create: GameProjectService["Service"]["create"] = Effect.fn("GameProjectService.create")(
    function* (input) {
      const name = input.name.trim();
      if (name === "")
        return yield* new GameOperationError({
          operation: "create-game",
          path: input.name,
          reason: "invalid-path",
          detail: "A game needs a name.",
        });
      const parent = input.parentDirectory.trim() || NodePath.join(NodeOS.homedir(), "Games");
      const requestedRoot = NodePath.resolve(
        parent.replace(/^~(?=\/|$)/, NodeOS.homedir()),
        gameFolderName(
          name,
          // From the name itself, so a retry or a second click names the same folder.
          NodeCrypto.createHash("sha256").update(name.normalize("NFC")).digest("hex").slice(0, 6),
        ),
      );
      // One create per folder at a time in this server, so a second click
      // cannot take the first's half-made folder for a leftover.
      return yield* createLocks.withLock(requestedRoot, createAt(input, name, requestedRoot));
    },
  );
  const createAt = (input: GameCreateInput, name: string, requestedRoot: string) =>
    Effect.gen(function* () {
      // Start through the requested path, then settle on the real root before
      // writing any server-owned record. A symlinked parent must not mint keys
      // that the rest of the app cannot match.
      let root = requestedRoot;
      let created = false;
      const rollback = Effect.promise(async () => {
        if (!created) return;
        // Records of an existing game are never touched: creation never
        // adopts an existing directory.
        await NodeFSP.rm(root, { recursive: true, force: true }).catch(() => {});
      });
      return yield* Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(NodePath.dirname(root), { recursive: true });
            // Never adopt or overwrite an existing directory, except a create of
            // ours that a crash cut short: it is empty, or still holds the marker.
            const claimed = await NodeFSP.mkdir(root).then(
              () => true,
              async (cause: NodeJS.ErrnoException) => {
                if (cause.code !== "EEXIST" || !(await halfMadeCreate(root))) throw cause;
                await NodeFSP.rm(root, { recursive: true, force: true });
                await NodeFSP.mkdir(root);
                return true;
              },
            );
            created = claimed;
            await NodeFSP.mkdir(NodePath.join(root, "builds"), { recursive: true });
            await NodeFSP.writeFile(NodePath.join(root, CREATE_MARKER), "", { flag: "wx" });
            for (const relative of [
              "art/blender",
              "art/scripts",
              "art/previews",
              ...engineProfile(createEngine(input)).scaffold.directories,
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
            (cause as NodeJS.ErrnoException | undefined)?.code === "EEXIST" && !created
              ? new GameOperationError({
                  operation: "create-game",
                  path: root,
                  reason: "invalid-path",
                  detail: `A folder already exists at ${root}. Open it with Open game, or choose another name.`,
                  cause,
                })
              : new GameOperationError({
                  operation: "scaffold-game",
                  path: root,
                  reason: "io",
                  cause,
                }),
        });
        const templatesDirectory = yield* resolveTemplatesDirectory().pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        yield* copyTemplateIntoGame({
          templatesDirectory,
          templateId: gameTemplateForEngine(createEngine(input)),
          gameRoot: root,
          gameName: name,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        root = yield* resolveCanonicalRoot(root, "create-game");
        // The skills and the bot kit ride in the first commit, so no turn's
        // build counts them as its change.
        yield* ensureScaffold(root, createEngine(input), true).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        // The first commit is Kurambit's own, through git's plumbing: the
        // user's signing config and hooks never apply to it. The marker sits
        // under the ignored builds/, so it never rides in that commit.
        const git = yield* vcs.get("git").pipe(Effect.mapError(gitInitError(root)));
        yield* git
          .initRepository({ cwd: root, initialCommit: { message: "chore: create game project" } })
          .pipe(Effect.mapError(gitInitError(root)));
        yield* Effect.tryPromise({
          try: () => NodeFSP.rm(NodePath.join(root, CREATE_MARKER)),
          catch: (cause) =>
            new GameOperationError({ operation: "create-game", path: root, reason: "io", cause }),
        });
        // No run starts: the chat's first turn makes the first playable build.
        return yield* register(root, input, { firstTurn: true });
      }).pipe(
        // A create that fails or is interrupted must not leave a half-made folder behind.
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : rollback)),
      );
    });
  const resolve = Effect.fn("GameProjectService.resolve")(function* (
    threadId: ThreadId,
    options: { readonly deleted?: "allowed" } = {},
  ) {
    const unresolved = (cause: unknown) =>
      new GameOperationError({
        operation: "resolve-thread",
        path: threadId,
        reason: "project-not-found",
        cause,
      });
    // A deleted thread has no shell; its record still names its project and checkout.
    const thread =
      options.deleted === "allowed"
        ? yield* threads.getThreadRecords(threadId, []).pipe(
            Effect.map(({ thread: record }) => record),
            Effect.mapError(unresolved),
          )
        : yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unresolved));
    if (!thread || (thread.deletedAt !== null && options.deleted !== "allowed"))
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
    const root = yield* resolveCanonicalRoot(
      NodePath.resolve(thread.worktreePath ?? project.value.workspaceRoot),
      "resolve-project",
    );
    yield* read(root);
    return root;
  });

  const projectRun = (threadId: ThreadId) =>
    threads
      .getThreadShell(threadId)
      .pipe(
        Effect.flatMap((shell) =>
          shell === null ? Effect.succeed(null) : projections.getProjectGameRun(shell.projectId),
        ),
      );
  const holdOf = gameRunHold;
  const runHold: GameProjectService["Service"]["runHold"] = (threadId) =>
    projectRun(threadId).pipe(
      Effect.map(holdOf),
      // Unknown is held: a read that fails never lets a Stop game reach the run's work.
      Effect.orElseSucceed(() => "live" as const),
    );

  const admitWrite: GameProjectService["Service"]["admitWrite"] = (
    threadId,
    root,
    operation,
    owner,
  ) =>
    Effect.gen(function* () {
      if (isGameRunOperationOwner(owner)) return;
      // Unknown is held, as for Stop game.
      const run = yield* projectRun(threadId).pipe(Effect.option);
      const hold = Option.isSome(run) ? holdOf(run.value) : "live";
      if (hold === null) return;
      const gameRoot =
        Option.isSome(run) && run.value !== null
          ? yield* resolve(run.value.threadId, { deleted: "allowed" }).pipe(Effect.option)
          : Option.none();
      const refusal = admitDecision({
        hold,
        // An unreadable record is never taken for a role's, and never admitted as one.
        role: yield* threads.getThreadRecords(threadId, []).pipe(
          Effect.map(({ thread }) => thread.launchedBy === "game_run"),
          Effect.orElseSucceed(() => "unknown" as const),
        ),
        onRunFolder: Option.isNone(gameRoot) || gameRoot.value === root,
        caller: yield* GameCaller,
      });
      if (refusal !== null)
        return yield* new GameOperationError({
          operation,
          path: root,
          reason: "busy",
          runReason: "run-live",
          detail: refusal,
        });
    });

  return GameProjectService.of({
    runHold,
    admitWrite,
    create,
    list: Effect.fn("GameProjectService.list")(function* () {
      const [projectSnapshot, threadSnapshot] = yield* Effect.all(
        [
          projects.snapshot.pipe(
            Effect.mapError(
              (cause) =>
                new GameOperationError({
                  operation: "list-games",
                  path: "projects",
                  reason: "io",
                  cause,
                }),
            ),
          ),
          threads.getShellSnapshot().pipe(
            Effect.mapError(
              (cause) =>
                new GameOperationError({
                  operation: "list-games",
                  path: "threads",
                  reason: "io",
                  cause,
                }),
            ),
          ),
        ],
        { concurrency: 2 },
      );
      const newestThreadByProject = new Map<string, (typeof threadSnapshot.threads)[number]>();
      for (const thread of threadSnapshot.threads) {
        if (thread.deletedAt !== null) continue;
        const current = newestThreadByProject.get(thread.projectId);
        if (
          current === undefined ||
          DateTime.toEpochMillis(thread.updatedAt) > DateTime.toEpochMillis(current.updatedAt)
        )
          newestThreadByProject.set(thread.projectId, thread);
      }
      const summaries = yield* Effect.forEach(
        projectSnapshot.projects,
        (project) =>
          Effect.gen(function* () {
            const root = yield* Effect.tryPromise(() => realGameRoot(project.workspaceRoot)).pipe(
              Effect.orElseSucceed(() => NodePath.resolve(project.workspaceRoot)),
            );
            const manifest = yield* read(root).pipe(Effect.option);
            if (Option.isNone(manifest)) return null;
            const latestThread = newestThreadByProject.get(project.id) ?? null;
            const currentOperation = operations.current(root);
            const keyArt = yield* Effect.promise(() =>
              findKeyArt(
                root,
                manifestProject(manifest.value),
                "title",
                manifest.value.engine.name,
              ),
            );
            const summary: GameSummary = {
              projectId: project.id,
              root,
              name: manifest.value.name,
              template: manifest.value.template ?? null,
              operation:
                currentOperation === null
                  ? null
                  : { name: currentOperation.name, state: currentOperation.state },
              run: yield* liveRun(project.id),
              keyArt,
              updatedAt: latestGameActivity(
                project.updatedAt,
                latestThread === null ? null : DateTime.formatIso(latestThread.updatedAt),
              ),
            };
            return summary;
          }).pipe(
            // One corrupt record must not take the whole library down; the game
            // still opens for a status read that reports the real error.
            Effect.catchCause((cause) =>
              Effect.logWarning("Skipped a game whose records could not be read.", {
                projectId: project.id,
                cause,
              }).pipe(Effect.as(null)),
            ),
          ),
        { concurrency: 4 },
      );
      // A project row can outlive a move or a failed registration; the library
      // shows one row per game root, choosing the row with the newest activity.
      const seenRoots = new Set<string>();
      return sortGameSummaries(
        summaries.filter((game): game is GameSummary => game !== null),
      ).filter((game) => {
        if (seenRoots.has(game.root)) return false;
        seenRoots.add(game.root);
        return true;
      });
    }),
    open: (input) =>
      register(NodePath.resolve(input.path.replace(/^~(?=\/|$)/, NodeOS.homedir())), input, {
        resume: true,
      }),
    resolve,
    read,
    inventory: Effect.fn("GameProjectService.inventory")(function* (root) {
      const manifest = yield* read(root);
      // An engine with a fixed resolution (three.js, Unity) plays at it; Godot's is in project.godot.
      const expensive = yield* Effect.tryPromise({
        try: async () => {
          const fixed = engineProfile(manifest.engine.name).viewport;
          if (fixed !== null) return { viewport: { ...fixed } };
          const engineRoot = insideGame(root, manifestProject(manifest));
          const projectGodot = await NodeFSP.readFile(
            NodePath.join(engineRoot, "project.godot"),
            "utf8",
          ).catch(() => "");
          return { viewport: parseGodotViewport(projectGodot) };
        },
        catch: (cause) =>
          new GameOperationError({ operation: "inventory", path: root, reason: "io", cause }),
      });
      return { manifest, viewport: expensive.viewport };
    }),
  });
});
export const layer = Layer.effect(GameProjectService, make);
