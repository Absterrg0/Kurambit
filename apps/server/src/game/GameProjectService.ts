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
  DEFAULT_GAME_TEMPLATE,
  MessageId,
  ProjectId,
  ThreadId,
  GameManifest,
  GameOperationError,
  type GameAsset,
  type GameCreateInput,
  type GameDesign,
  type GameDesignApprovalResult,
  type GameListResult,
  type GameOpenInput,
  type GameProjectResult,
  type GameSummary,
} from "@t3tools/contracts";
import * as GameOperations from "./GameOperations.ts";
import * as GameQualification from "./GameQualification.ts";
import { validateDesignDocument } from "@t3tools/contracts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import { commandDetail } from "./commandDetail.ts";
import { gameCoverCandidates, latestGameActivity, sortGameSummaries } from "./gameSummary.ts";
import { parseGodotViewport, type GodotViewport } from "./godotViewport.ts";
import { readLastPlaytest } from "./playtestEvidence.ts";
import { designSkeleton, initialGamePrompt, scaffoldFiles, scaffoldManifest } from "./scaffold.ts";
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
    /**
     * The games library, in one batched read. The sidebar uses this instead of
     * asking for game status per project.
     */
    readonly list: () => Effect.Effect<GameListResult, GameOperationError>;
    readonly resolve: (threadId: ThreadId) => Effect.Effect<string, GameOperationError>;
    readonly read: (root: string) => Effect.Effect<GameManifest, GameOperationError>;
    /**
     * The creator's approval of one specific DESIGN.md revision. It validates
     * the document, records the revision and its acceptance outside the game,
     * and starts the first build turn; re-approval of changed scope never
     * dispatches another turn.
     */
    readonly approveDesign: (
      threadId: ThreadId,
      expectedDesignHash: string,
    ) => Effect.Effect<GameDesignApprovalResult, GameOperationError>;
    readonly upsertAsset: (
      root: string,
      asset: GameAsset,
    ) => Effect.Effect<void, GameOperationError>;
    /**
     * Expensive reads (asset usage, scenes, viewport, builds). `sourceId` is the
     * qualification snapshot the caller already computed; the result is cached
     * until that snapshot changes, so a status refresh does not walk the tree
     * again.
     */
    readonly inventory: (
      root: string,
      sourceId?: string | null,
    ) => Effect.Effect<
      {
        manifest: GameManifest;
        design: GameDesign | null;
        designPath: string | null;
        briefPath: string | null;
        assets: readonly (GameAsset & { usedBy: string[] })[];
        scenes: string[];
        viewport: GodotViewport;
        builds: { target: string; path: string; updatedAt: string }[];
      },
      GameOperationError
    >;
  }
>()("t3/game/GameProjectService") {}
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(GameManifest));
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(GameManifest));
const make = Effect.gen(function* () {
  const inventoryCache = new Map<
    string,
    {
      readonly sourceId: string;
      readonly manifestSignature: string;
      readonly value: {
        readonly assets: readonly (GameAsset & { usedBy: string[] })[];
        readonly scenes: string[];
        readonly viewport: GodotViewport;
      };
    }
  >();
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const processes = yield* GameProcesses.GameProcesses;
  const approvals = yield* GameDesignApproval.GameDesignApproval;
  const qualification = yield* GameQualification.GameQualification;
  const operations = yield* GameOperations.GameOperations;
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
  // Manifest writes are serialized per game: an asset revision and a design
  // approval can land close together, and neither may drop the other's change.
  const manifestWrites = new Map<string, Promise<void>>();
  const updateManifest = (
    root: string,
    operation: string,
    update: (manifest: GameManifest) => GameManifest,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const previous = manifestWrites.get(root) ?? Promise.resolve();
        const write = previous
          .catch(() => {})
          .then(async () => {
            const manifest = decodeManifest(
              await NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8"),
            );
            const temporary = NodePath.join(root, `.game-${NodeCrypto.randomUUID()}.json`);
            try {
              await NodeFSP.writeFile(temporary, encodeManifest(update(manifest)) + "\n");
              await NodeFSP.rename(temporary, NodePath.join(root, "game.json"));
            } finally {
              await NodeFSP.rm(temporary, { force: true });
            }
          });
        manifestWrites.set(root, write);
        try {
          await write;
        } finally {
          if (manifestWrites.get(root) === write) manifestWrites.delete(root);
        }
      },
      catch: (cause) => new GameOperationError({ operation, path: root, reason: "io", cause }),
    });
  const register = Effect.fnUntraced(function* (
    root: string,
    input: Pick<GameCreateInput, "modelSelection" | "runtimeMode">,
    message?: string,
    options?: { readonly resume?: boolean },
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
    // Opening a folder is "continue this game", not "start another chat": the
    // project's newest session already has the history and the context.
    if (options?.resume === true) {
      const existingThreads = yield* threads
        .listProjectThreads({ projectId: project.id, includeSubagents: false })
        .pipe(
          Effect.mapError(
            (cause) =>
              new GameOperationError({
                operation: "list-game-threads",
                path: root,
                reason: "io",
                cause,
              }),
          ),
        );
      const latest = existingThreads.find(
        (thread) => thread.deletedAt === null && thread.archivedAt === null,
      );
      if (latest !== undefined) return { projectId: project.id, threadId: latest.id, root };
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
      let intentRecorded = false;
      const removeCreatedRoot = Effect.promise(async () => {
        if (!created) return;
        await NodeFSP.rm(root, { recursive: true, force: true }).catch(() => {});
      });
      const rollback = Effect.gen(function* () {
        yield* removeCreatedRoot;
        // The intent was written by this attempt and names a root this attempt
        // created, so it is ours to remove. Records of an existing game are
        // never touched: creation never adopts an existing directory.
        if (intentRecorded)
          yield* approvals.removeIntent(root).pipe(Effect.catch(() => Effect.void));
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
        // The creation-time design promise lives outside the workspace. Without
        // it, deleting DESIGN.md or editing game.json could pass a plan-first
        // game as legacy.
        yield* approvals.recordIntent(
          root,
          input.planFirst === false ? "skipped" : "required",
          scaffoldManifest(input).probe === true,
        );
        intentRecorded = true;
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
        return yield* register(root, input, initialGamePrompt(input));
      }).pipe(
        // A create that fails or is interrupted must not leave a half-made folder
        // or its own intent record behind.
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : rollback)),
      );
    },
  );
  const resolveTarget = Effect.fn("GameProjectService.resolveTarget")(function* (
    threadId: ThreadId,
  ) {
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
    return { root, projectId: thread.projectId };
  });
  const resolve = Effect.fn("GameProjectService.resolve")(function* (threadId: ThreadId) {
    return (yield* resolveTarget(threadId)).root;
  });
  // Name the qualification loop every build turn must run. A blunt model otherwise
  // treats "the usual checks" as license to drive the godot CLI by hand — which skips
  // the recorded verdicts the Game panel and the harness depend on.
  const buildAfterApproval =
    "The design is approved. Build milestone 1 from DESIGN.md, then continue through the remaining milestones one at a time. The approved revision binds you: implement every acceptance criterion, and never remove or weaken one silently. If scope has to change, update DESIGN.md and tell me it needs re-approval on the Design tab; staging stays locked until I approve the new revision. Do the engine work with the Game Studio tools; a build-turn report is only evidence the tools wrote: call game_status first, game_godot_import after every engine change, game_godot_check until it reports ok with zero errors, your godot/tests smoke test with game_godot_test until it passes, write godot/tests/scenarios routes that play every level to the win with normal input and run game_scenarios_run until every observable criterion and an end criterion pass (the assertions come from the approved design, not from you), the web build with game_export, and game_web_playtest with steps over the core loop until it reports success and responded=true (a fresh evidence folder every round). Do not drive the godot binary, exporters, or tests from the shell — raw runs are not recorded as build evidence. Finish AGENTS.md's Definition of done, then report results and the game_preview URL.";
  const approveDesign = Effect.fn("GameProjectService.approveDesign")(function* (
    threadId: ThreadId,
    expectedDesignHash: string,
  ) {
    const target = yield* resolveTarget(threadId);
    const root = target.root;
    const designPath = NodePath.join(root, "DESIGN.md");
    const fail = (
      reason: "design-missing" | "design-invalid" | "design-hash-mismatch" | "design-legacy",
      detail?: string,
    ) =>
      new GameOperationError({
        operation: "approve-design",
        path: designPath,
        reason,
        ...(detail === undefined ? {} : { detail: detail.slice(0, 4096) }),
      });
    return yield* approvals.exclusive(
      root,
      Effect.gen(function* () {
        // Read inside the lock: a concurrent approval or an agent's edit may
        // have changed the revision since the caller started.
        const manifest = yield* read(root);
        const intent = yield* approvals.readIntent(root);
        if (intent === "skipped")
          return yield* fail(
            "design-legacy",
            "This game was planned without a design document, so it has no design to approve.",
          );
        if (manifest.design === undefined && intent === null)
          return yield* fail(
            "design-legacy",
            "This game was created before the design step, so it has no design to approve.",
          );
        // A skip-planning game from before the intent record has an approved
        // mirror but never had a document; only that old shape reads as legacy.
        if (
          intent === null &&
          manifest.design?.status === "approved" &&
          !(yield* Effect.promise(() => GameDesignApproval.designDocumentExists(root)))
        )
          return yield* fail(
            "design-legacy",
            "This game was planned without a design document, so it has no design to approve.",
          );
        const design = yield* Effect.promise(() => GameDesignApproval.readDesignDocument(root));
        if (design === null) return yield* fail("design-missing");
        const designHash = GameDesignApproval.designDocumentHash(design);
        if (designHash !== expectedDesignHash)
          return yield* fail(
            "design-hash-mismatch",
            "The design changed after it was shown. Review the current DESIGN.md and approve again.",
          );
        const validation = validateDesignDocument({
          design,
          skeleton: designSkeleton(manifest.name),
        });
        if (validation.issues.length > 0)
          return yield* fail("design-invalid", validation.issues.join("\n"));
        const existing = yield* approvals.read(root);
        if (existing !== null && existing.designHash === designHash) {
          // Retrying the same approval is a read, not another build turn.
          yield* updateManifest(root, "approve-design", (current) => ({
            ...current,
            design: { status: "approved", approvedAt: existing.approvedAt },
          }));
          return {
            approvedAt: existing.approvedAt,
            approvalId: existing.approvalId,
            designHash,
          };
        }
        const approvedAt = DateTime.formatIso(yield* DateTime.now);
        const approvalId = NodeCrypto.randomUUID();
        const previousDesign = manifest.design;
        const record: GameDesignApproval.DesignApprovalRecord = {
          schemaVersion: 1,
          game: root,
          approvalId,
          designHash,
          approvedAt,
          acceptance: validation.acceptance,
        };
        yield* approvals.write(root, record);
        const rollBack = approvals.removeOwned(root, approvalId).pipe(
          Effect.andThen(
            updateManifest(root, "approve-design", (current) => {
              const { design: _written, ...withoutDesign } = current;
              return previousDesign === undefined
                ? withoutDesign
                : { ...withoutDesign, design: previousDesign };
            }),
          ),
        );
        yield* Effect.gen(function* () {
          yield* updateManifest(root, "approve-design", (current) => ({
            ...current,
            design: { status: "approved", approvedAt },
          })).pipe(
            // The mirror is only display state; if it cannot be written, put the
            // record back so the approval stays all-or-nothing.
            Effect.catchTags({
              GameOperationError: (error) =>
                (existing === null
                  ? approvals.removeOwned(root, approvalId)
                  : approvals.write(root, existing)
                ).pipe(Effect.andThen(Effect.fail(error))),
            }),
          );
          // Only the first approval releases a build turn. Re-approving changed
          // scope updates the contract in place; the turn that requested the
          // change continues.
          if (existing === null)
            yield* threads
              .sendToThread({
                projectId: target.projectId,
                commandId: CommandId.make(NodeCrypto.randomUUID()),
                threadId,
                messageId: MessageId.make(NodeCrypto.randomUUID()),
                text: buildAfterApproval,
                attachments: [],
                mode: "auto",
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new GameOperationError({
                      operation: "approve-design",
                      path: root,
                      reason: "thread-dispatch",
                      cause,
                    }),
                ),
                // Roll back only this attempt: never another approval's record
                // and never a mirror the approval did not own.
                Effect.catchTags({
                  GameOperationError: (error) => rollBack.pipe(Effect.andThen(Effect.fail(error))),
                }),
              );
        }).pipe(
          // A cancelled request must not leave a record with no build turn, or
          // the retry would look idempotent and never dispatch.
          Effect.onInterrupt(() => rollBack),
        );
        return { approvedAt, approvalId, designHash };
      }),
    );
  });
  return GameProjectService.of({
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
            const manifest = yield* read(project.workspaceRoot).pipe(Effect.option);
            if (Option.isNone(manifest)) return null;
            const latestThread = newestThreadByProject.get(project.id) ?? null;
            // The cheap verdict: the server's records, never a source walk. The
            // Stage still does the exact check when it opens this game.
            const design = yield* approvals.status(project.workspaceRoot, manifest.value);
            const progress = yield* qualification.summary(
              project.workspaceRoot,
              design.state === "approved" ? design.approvedHash : null,
            );
            const currentOperation = operations.current(project.workspaceRoot);
            const lastPlaytest = yield* Effect.promise(() =>
              readLastPlaytest(project.workspaceRoot, []),
            );
            const coverImagePath = yield* Effect.promise(async () => {
              for (const candidate of gameCoverCandidates({
                lastPlaytest,
                assets: manifest.value.assets,
              })) {
                try {
                  if ((await NodeFSP.stat(insideGame(project.workspaceRoot, candidate))).isFile())
                    return candidate;
                } catch {
                  /* A missing cover is not an error; try the next candidate. */
                }
              }
              return null;
            });
            const summary: GameSummary = {
              projectId: project.id,
              root: project.workspaceRoot,
              name: manifest.value.name,
              template: manifest.value.template ?? null,
              designState: design.state,
              operation:
                currentOperation === null
                  ? null
                  : { name: currentOperation.name, state: currentOperation.state },
              qualification: progress,
              updatedAt: latestGameActivity(
                project.updatedAt,
                latestThread === null ? null : DateTime.formatIso(latestThread.updatedAt),
              ),
              coverImagePath,
            };
            return summary;
          }),
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
      register(
        NodePath.resolve(input.path.replace(/^~(?=\/|$)/, NodeOS.homedir())),
        input,
        undefined,
        { resume: true },
      ),
    resolve,
    read,
    approveDesign,
    upsertAsset: (root, asset) =>
      updateManifest(root, "save-asset", (manifest) => ({
        ...manifest,
        assets: manifest.assets.filter((entry) => entry.id !== asset.id).concat(asset),
      })),
    inventory: Effect.fn("GameProjectService.inventory")(function* (root, sourceId) {
      const manifest = yield* read(root);
      // The expensive reads depend on the engine root and the manifest's asset
      // paths only; a cheap textual signature detects a manifest edit without
      // walking or re-reading the tree.
      const manifestSignature = [
        manifest.godotProject,
        ...manifest.assets.map((asset) => `${asset.id}\0${asset.export}`),
      ].join("\0");
      const cached = inventoryCache.get(root);
      const reusable =
        sourceId != null &&
        cached !== undefined &&
        cached.sourceId === sourceId &&
        cached.manifestSignature === manifestSignature;
      const expensive =
        reusable && cached !== undefined
          ? cached.value
          : yield* Effect.tryPromise({
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
                      const relative = NodePath.relative(
                        root,
                        NodePath.join(directory, entry.name),
                      );
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
                return { assets, scenes, viewport };
              },
              catch: (cause) =>
                new GameOperationError({ operation: "inventory", path: root, reason: "io", cause }),
            });
      if (sourceId != null)
        inventoryCache.set(root, { sourceId, manifestSignature, value: expensive });
      // Stat-only reads stay outside the cache: a rebuild with unchanged sources
      // still has to move its build time, and a deleted manifest file must vanish.
      const present = (relative: string) =>
        NodeFSP.stat(NodePath.join(root, relative)).then(
          (stat) => stat.isFile(),
          () => false,
        );
      const [designPath, briefPath, builds] = yield* Effect.promise(async () => {
        const designPresent = await present("DESIGN.md");
        const briefPresent = await present("BRIEF.md");
        const found: { target: string; path: string; updatedAt: string }[] = [];
        for (const [target, relative] of [
          ["Web", "builds/web/index.html"],
          ["Linux", "builds/linux/game.x86_64"],
        ] as const) {
          try {
            const stat = await NodeFSP.stat(NodePath.join(root, relative));
            found.push({ target, path: relative, updatedAt: stat.mtime.toISOString() });
          } catch {
            /* A game need not have been built yet. */
          }
        }
        return [
          designPresent ? "DESIGN.md" : null,
          briefPresent ? "BRIEF.md" : null,
          found,
        ] as const;
      });
      return {
        manifest,
        design: manifest.design ?? null,
        designPath,
        briefPath,
        assets: expensive.assets,
        scenes: expensive.scenes,
        builds,
        viewport: expensive.viewport,
      };
    }),
  });
});
export const layer = Layer.effect(GameProjectService, make);
