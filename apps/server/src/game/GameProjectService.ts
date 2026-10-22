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
  gameTestSuite,
  diffAcceptance,
  type GamePendingRevision,
  removedCriteriaWithoutRemovedLine,
  type GameAsset,
  type GameCreateInput,
  type GameDesign,
  type GameDesignApprovalResult,
  type GameListResult,
  type GameOpenInput,
  type GameProjectResult,
  type GameRevisionDiscardResult,
  type GameRevisionRequestResult,
  type GameSummary,
  type GameVerificationPolicy,
  type GameVerificationPolicyRead,
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
import { realGameRoot } from "./gameRecord.ts";
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
/**
 * A Godot resource path for the verification policy. Only `res://` paths are
 * accepted: the exam must name a file inside the game's project, not an
 * arbitrary script on the machine.
 */
const engineResourcePath = (value: string, suffix: ".gd" | ".tscn"): string | null => {
  if (!value.startsWith("res://") || value.includes("\\")) return null;
  const relative = value.slice("res://".length);
  if (
    relative.length === 0 ||
    relative.startsWith("/") ||
    relative.split("/").includes("..") ||
    !relative.endsWith(suffix)
  )
    return null;
  return `res://${relative}`;
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
    /**
     * The creator's explicit change to this game's exam. It is the only way to
     * move the canonical suite, gameplay scene or probe obligation; the RPC
     * exposes it, agent tools do not. Existing evidence recorded under the old
     * policy no longer counts.
     */
    readonly updateVerificationPolicy: (
      threadId: ThreadId,
      policy: GameVerificationPolicy,
    ) => Effect.Effect<GameVerificationPolicyRead, GameOperationError>;
    /**
     * Records the creator's change request as a pending revision and sends the
     * agent one turn that rewrites DESIGN.md. The record is written before the
     * turn is sent, so a crash never leaves a built change without its request.
     */
    readonly requestChange: (
      threadId: ThreadId,
      text: string,
    ) => Effect.Effect<typeof GameRevisionRequestResult.Type, GameOperationError>;
    /**
     * Approves the revision a pending change request led to. Same hash rules
     * as approveDesign, plus: a criterion the request removes must be
     * acknowledged under a `Removed:` line. Approval dispatches the change's
     * own build turn and resolves the request.
     */
    readonly approveRevision: (
      threadId: ThreadId,
      expectedDesignHash: string,
    ) => Effect.Effect<GameDesignApprovalResult, GameOperationError>;
    /** Discards the open change request; the design keeps its approved scope. */
    readonly discardRevision: (
      threadId: ThreadId,
    ) => Effect.Effect<GameRevisionDiscardResult, GameOperationError>;
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
    const lexicalRoot = NodePath.resolve(root);
    const canonicalRoot = yield* resolveCanonicalRoot(lexicalRoot, "register-game");
    const manifest = yield* read(canonicalRoot);
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
    if (options?.resume === true) {
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
        ...(message ? { initialMessage: { text: message, attachments: [] } } : {}),
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
      const requestedRoot = NodePath.resolve(parent.replace(/^~(?=\/|$)/, NodeOS.homedir()), slug);
      // Start through the requested path, then settle on the real root before
      // writing any server-owned record. A symlinked parent must not mint keys
      // that the rest of the app cannot match.
      let root = requestedRoot;
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
        root = yield* resolveCanonicalRoot(root, "create-game");
        // The creation-time design promise lives outside the workspace. Without
        // it, deleting DESIGN.md or editing game.json could pass a plan-first
        // game as legacy. The same record owns the exam the game qualifies
        // against, so a later manifest edit cannot redefine acceptance.
        const creationManifest = scaffoldManifest(input);
        yield* approvals.recordIntent(
          root,
          input.planFirst === false ? "skipped" : input.reviewDesign === true ? "required" : "auto",
          creationManifest.probe === true,
          {
            testSuite: gameTestSuite(creationManifest),
            gameplayScene: creationManifest.gameplayScene ?? null,
            probe: creationManifest.probe === true,
          },
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
    const root = yield* resolveCanonicalRoot(
      NodePath.resolve(thread.worktreePath ?? project.value.workspaceRoot),
      "resolve-project",
    );
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
    "The design is approved. Build it by following AGENTS.md's steps. The approved revision binds you: implement every acceptance criterion, and never remove or weaken one silently. If scope has to change, update DESIGN.md and tell me it needs re-approval on the Design tab; staging stays locked until I approve the new revision. Finish with the game_preview URL.";
  /** The one turn a change request sends: rewrite the contract, then stop. */
  const changeRequestMessage = (text: string) =>
    `Change requested: ${text}\n\nFirst update DESIGN.md: describe the change and add or adjust acceptance criteria that prove it. Keep every existing criterion unless the change removes that feature; if it does, say so under a "Removed:" line naming the criterion id (for example "- Removed: owl-menu-hint"), and end the turn for review. Do not build until approved.`;
  /** The turn an approved revision dispatches: implement it, then the same bar. */
  const implementChangeMessage =
    "The change request is approved. Implement the approved revision now on the current sources by following AGENTS.md's steps, then report the results and the game_preview URL.";
  /**
   * Sends the approval's one build turn, reconciling the persisted attempt
   * first. The command id is the orchestration idempotency key, so after a crash
   * the retry asks the receipt store whether that exact command already
   * committed instead of creating a second message.
   */
  const dispatchBuild = (
    projectId: ProjectId,
    root: string,
    record: GameDesignApproval.DesignApprovalRecord,
    options?: { readonly fresh?: boolean; readonly text?: string },
  ) =>
    Effect.gen(function* () {
      const dispatch = record.buildDispatch;
      if (dispatch === undefined || dispatch.state === "dispatched") return;
      const commandId = CommandId.make(dispatch.commandId);
      // A record written by this very call has provably never been sent. Any
      // older pending record may already have committed before a crash.
      const accepted =
        options?.fresh === true
          ? false
          : yield* threads.hasReceipt(commandId).pipe(
              Effect.mapError(
                (cause) =>
                  new GameOperationError({
                    operation: "approve-design",
                    path: root,
                    reason: "thread-dispatch",
                    cause,
                  }),
              ),
            );
      if (!accepted)
        yield* threads
          .sendToThread({
            projectId,
            commandId,
            threadId: ThreadId.make(dispatch.threadId),
            messageId: MessageId.make(dispatch.messageId),
            text: options?.text ?? buildAfterApproval,
            attachments: [],
            mode: "auto",
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(
            // sendToThread commits the dispatch and only then reads its reply
            // projection. That later failure still means the build turn exists,
            // so it counts as accepted rather than being sent again.
            Effect.catchTags({
              ThreadManagementDurableRunProjectionError: () => Effect.void,
            }),
            Effect.mapError(
              (cause) =>
                new GameOperationError({
                  operation: "approve-design",
                  path: root,
                  reason: "thread-dispatch",
                  cause,
                }),
            ),
          );
      const current = yield* approvals.read(root);
      if (current === null || current.approvalId !== record.approvalId) return;
      const pending = current.buildDispatch;
      if (pending === undefined || pending.state === "dispatched") return;
      yield* approvals.write(root, {
        ...current,
        buildDispatch: { ...pending, state: "dispatched" },
      });
    });
  const approveDesign = Effect.fn("GameProjectService.approveDesign")(function* (
    threadId: ThreadId,
    expectedDesignHash: string,
  ) {
    const target = yield* resolveTarget(threadId);
    const root = target.root;
    const designPath = NodePath.join(root, "DESIGN.md");
    const fail = (
      reason:
        | "design-missing"
        | "design-invalid"
        | "design-hash-mismatch"
        | "design-legacy"
        | "design-revision-pending",
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
        // While a change request is open, the Design tab resolves it through
        // approveRevision; a plain approval would skip the removal
        // acknowledgement and the revision's own build-dispatch rules.
        if ((yield* approvals.readRevision(root)) !== null)
          return yield* fail(
            "design-revision-pending",
            "A change request is pending on the Design tab. Approve the change or discard the request there before approving the design directly.",
          );
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
          // Retrying the same approval is a read, not another build turn. A
          // pending dispatch is reconciled: the record was written, but the
          // process may have died before or after the command committed.
          yield* updateManifest(root, "approve-design", (current) => ({
            ...current,
            design: { status: "approved", approvedAt: existing.approvedAt },
          }));
          yield* dispatchBuild(target.projectId, root, existing);
          return {
            approvedAt: existing.approvedAt,
            approvalId: existing.approvalId,
            designHash,
          };
        }
        const approvedAt = DateTime.formatIso(yield* DateTime.now);
        const approvalId = NodeCrypto.randomUUID();
        // A first approval releases the build turn. Re-approving changed scope
        // does not start another one, unless the previous approval's turn was
        // never dispatched: then the same durable attempt carries over.
        const pendingBuild =
          existing === null
            ? undefined
            : existing.buildDispatch?.state === "pending"
              ? existing.buildDispatch
              : null;
        const carriesPendingBuild = pendingBuild !== undefined && pendingBuild !== null;
        const dispatch =
          existing === null || carriesPendingBuild
            ? {
                commandId: pendingBuild?.commandId ?? NodeCrypto.randomUUID(),
                messageId: pendingBuild?.messageId ?? NodeCrypto.randomUUID(),
                threadId: pendingBuild?.threadId ?? threadId,
                state: "pending" as const,
              }
            : undefined;
        const record: GameDesignApproval.DesignApprovalRecord = {
          schemaVersion: 1,
          game: root,
          approvalId,
          designHash,
          approvedAt,
          acceptance: validation.acceptance,
          ...(dispatch === undefined ? {} : { buildDispatch: dispatch }),
        };
        yield* approvals.write(root, record);
        // The record and mirror are the creator's decision and stay if dispatch
        // fails. Only a failed display-mirror write, before any dispatch, rolls
        // this attempt back.
        yield* updateManifest(root, "approve-design", (current) => ({
          ...current,
          design: { status: "approved", approvedAt },
        })).pipe(
          Effect.catchTags({
            GameOperationError: (error) =>
              (existing === null
                ? approvals.removeOwned(root, approvalId)
                : approvals.write(root, existing)
              ).pipe(Effect.andThen(Effect.fail(error))),
          }),
        );
        yield* dispatchBuild(target.projectId, root, record, { fresh: true });
        return { approvedAt, approvalId, designHash };
      }),
    );
  });
  const requestChange = Effect.fn("GameProjectService.requestChange")(function* (
    threadId: ThreadId,
    text: string,
  ) {
    const target = yield* resolveTarget(threadId);
    const root = target.root;
    return yield* approvals.exclusive(
      root,
      Effect.gen(function* () {
        const intent = yield* approvals.readIntent(root);
        if (intent === "skipped")
          return yield* new GameOperationError({
            operation: "request-change",
            path: NodePath.join(root, "DESIGN.md"),
            reason: "design-legacy",
            detail: "This game has no approved design for a change request to amend.",
          });
        if (intent === "auto")
          return yield* new GameOperationError({
            operation: "request-change",
            path: NodePath.join(root, "DESIGN.md"),
            reason: "design-legacy",
            detail:
              "This game records each design revision as the agent writes it; ask for changes in chat.",
          });
        if (intent === null)
          return yield* new GameOperationError({
            operation: "request-change",
            path: NodePath.join(root, "DESIGN.md"),
            reason: "design-legacy",
            detail:
              "This game was created before the design step, so there is no design to change.",
          });
        if ((yield* approvals.readRevision(root)) !== null)
          return yield* new GameOperationError({
            operation: "request-change",
            path: NodePath.join(root, "DESIGN.md"),
            reason: "design-revision-pending",
            detail:
              "A change request is already pending; approve the change or discard the request on the Design tab before asking for another.",
          });
        const approved = yield* approvals.read(root);
        if (approved === null)
          return yield* new GameOperationError({
            operation: "request-change",
            path: NodePath.join(root, "DESIGN.md"),
            reason: "design-draft",
            detail:
              "The design has not been approved yet, so there is no revision to change; ask for changes in chat.",
          });
        const revision: GamePendingRevision = {
          id: NodeCrypto.randomUUID(),
          text,
          requestedAt: DateTime.formatIso(yield* DateTime.now),
          baseHash: approved.designHash,
        };
        // Record first, notify second: a crash then leaves a pending request
        // the creator can resolve or discard, never a built change without one.
        yield* approvals.writeRevision(root, revision);
        yield* threads
          .sendToThread({
            projectId: target.projectId,
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId,
            messageId: MessageId.make(NodeCrypto.randomUUID()),
            text: changeRequestMessage(text),
            attachments: [],
            mode: "auto",
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(
            Effect.catchTags({ ThreadManagementDurableRunProjectionError: () => Effect.void }),
            Effect.mapError(
              (cause) =>
                new GameOperationError({
                  operation: "request-change",
                  path: root,
                  reason: "thread-dispatch",
                  cause,
                }),
            ),
          );
        return { revisionId: revision.id, requestedAt: revision.requestedAt };
      }),
    );
  });
  const approveRevision = Effect.fn("GameProjectService.approveRevision")(function* (
    threadId: ThreadId,
    expectedDesignHash: string,
  ) {
    const target = yield* resolveTarget(threadId);
    const root = target.root;
    const designPath = NodePath.join(root, "DESIGN.md");
    const fail = (
      reason: "design-missing" | "design-invalid" | "design-hash-mismatch" | "revision-missing",
      detail?: string,
    ) =>
      new GameOperationError({
        operation: "approve-revision",
        path: designPath,
        reason,
        ...(detail === undefined ? {} : { detail: detail.slice(0, 4096) }),
      });
    return yield* approvals.exclusive(
      root,
      Effect.gen(function* () {
        const pending = yield* approvals.readRevision(root);
        if (pending === null)
          return yield* fail(
            "revision-missing",
            "There is no pending change request for this game.",
          );
        const existing = yield* approvals.read(root);
        if (existing === null)
          return yield* fail(
            "design-missing",
            "The approved design this change revises is gone, so the request cannot be approved.",
          );
        const design = yield* Effect.promise(() => GameDesignApproval.readDesignDocument(root));
        if (design === null) return yield* fail("design-missing");
        const designHash = GameDesignApproval.designDocumentHash(design);
        if (designHash !== expectedDesignHash)
          return yield* fail(
            "design-hash-mismatch",
            "The design changed after it was shown. Review the current DESIGN.md and approve again.",
          );
        const manifest = yield* read(root);
        const validation = validateDesignDocument({
          design,
          skeleton: designSkeleton(manifest.name),
        });
        if (validation.issues.length > 0)
          return yield* fail("design-invalid", validation.issues.join("\n"));
        // A revision may retire a feature, but only by owning it in the
        // document; otherwise the promise would vanish without a decision.
        const silentRemovals = removedCriteriaWithoutRemovedLine(
          diffAcceptance(existing.acceptance, validation.acceptance),
          design,
        );
        if (silentRemovals.length > 0)
          return yield* fail(
            "design-invalid",
            `The revision removes ${silentRemovals.map((criterion) => `"${criterion.id}"`).join(", ")} without acknowledging it in DESIGN.md. Restore the criteria, or add a "Removed:" line naming each id (for example "- Removed: ${silentRemovals[0]!.id}").`,
          );
        if (existing.designHash === designHash) {
          // The revision's document already binds: retrying reconciles the
          // previous dispatch instead of minting a second approval.
          yield* updateManifest(root, "approve-revision", (current) => ({
            ...current,
            design: { status: "approved", approvedAt: existing.approvedAt },
          }));
          yield* dispatchBuild(target.projectId, root, existing, { text: implementChangeMessage });
          yield* approvals.removeRevision(root);
          return {
            approvedAt: existing.approvedAt,
            approvalId: existing.approvalId,
            designHash,
          };
        }
        const approvedAt = DateTime.formatIso(yield* DateTime.now);
        const approvalId = NodeCrypto.randomUUID();
        // The same durable-dispatch rules as approveDesign: a previous
        // approval whose turn was never sent carries its attempt over, so a
        // retry reconciles the receipt instead of sending twice.
        const pendingBuild =
          existing.buildDispatch?.state === "pending" ? existing.buildDispatch : null;
        const dispatch = {
          commandId: pendingBuild?.commandId ?? NodeCrypto.randomUUID(),
          messageId: pendingBuild?.messageId ?? NodeCrypto.randomUUID(),
          threadId: pendingBuild?.threadId ?? threadId,
          state: "pending" as const,
        };
        const record: GameDesignApproval.DesignApprovalRecord = {
          schemaVersion: 1,
          game: root,
          approvalId,
          designHash,
          approvedAt,
          acceptance: validation.acceptance,
          buildDispatch: dispatch,
        };
        yield* approvals.write(root, record);
        yield* updateManifest(root, "approve-revision", (current) => ({
          ...current,
          design: { status: "approved", approvedAt },
        })).pipe(
          Effect.catchTags({
            GameOperationError: (error) =>
              approvals.write(root, existing).pipe(Effect.andThen(Effect.fail(error))),
          }),
        );
        yield* dispatchBuild(target.projectId, root, record, {
          fresh: true,
          text: implementChangeMessage,
        });
        yield* approvals.removeRevision(root);
        return { approvedAt, approvalId, designHash };
      }),
    );
  });
  const discardRevision = Effect.fn("GameProjectService.discardRevision")(function* (
    threadId: ThreadId,
  ) {
    const target = yield* resolveTarget(threadId);
    return yield* approvals.exclusive(
      target.root,
      Effect.gen(function* () {
        if ((yield* approvals.readRevision(target.root)) === null)
          return yield* new GameOperationError({
            operation: "discard-revision",
            path: NodePath.join(target.root, "DESIGN.md"),
            reason: "revision-missing",
            detail: "There is no pending change request for this game.",
          });
        yield* approvals.removeRevision(target.root);
        return {};
      }),
    );
  });
  const updateVerificationPolicy = Effect.fn("GameProjectService.updateVerificationPolicy")(
    function* (threadId: ThreadId, policy: GameVerificationPolicy) {
      const target = yield* resolveTarget(threadId);
      const root = target.root;
      const testSuite = engineResourcePath(policy.testSuite, ".gd");
      const gameplayScene =
        policy.gameplayScene === null ? null : engineResourcePath(policy.gameplayScene, ".tscn");
      if (testSuite === null || (policy.gameplayScene !== null && gameplayScene === null))
        return yield* new GameOperationError({
          operation: "update-verification-policy",
          path: policy.testSuite,
          reason: "invalid-path",
          detail:
            "The test suite must be a res:// .gd path and the gameplay scene a res:// .tscn path inside the game project.",
        });
      const manifest = yield* read(root);
      return yield* approvals.exclusive(
        root,
        Effect.gen(function* () {
          // A pre-policy game adopts from its manifest first, so there is always
          // a record to change rather than a silent second source of truth.
          yield* approvals.readPolicy(root, manifest);
          const updated = yield* approvals.updatePolicy(root, {
            testSuite,
            gameplayScene,
            probe: policy.probe,
          });
          // game.json is a display mirror only; the record above already holds
          // the exam, so a failed mirror write is reported but not authoritative.
          yield* updateManifest(root, "update-verification-policy", (current) => {
            const { gameplayScene: _previous, ...rest } = current;
            return {
              ...rest,
              testSuite,
              ...(gameplayScene === null ? {} : { gameplayScene }),
              probe: policy.probe,
            };
          });
          return updated;
        }),
      );
    },
  );
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
            const root = yield* Effect.tryPromise(() => realGameRoot(project.workspaceRoot)).pipe(
              Effect.orElseSucceed(() => NodePath.resolve(project.workspaceRoot)),
            );
            const manifest = yield* read(root).pipe(Effect.option);
            if (Option.isNone(manifest)) return null;
            const latestThread = newestThreadByProject.get(project.id) ?? null;
            // The cheap verdict: the server's records, never a source walk. The
            // Stage still does the exact check when it opens this game.
            const design = yield* approvals.status(root, manifest.value);
            const policy = yield* approvals.readPolicy(root, manifest.value);
            const progress = yield* qualification.summary(
              root,
              design.state === "approved" ? design.approvedHash : null,
              { policyRevision: policy.revision, probeRequired: policy.policy.probe },
            );
            const currentOperation = operations.current(root);
            const lastPlaytest = yield* Effect.promise(() =>
              readLastPlaytest(root, [], design.state === "approved" ? design.acceptance : null),
            );
            const coverImagePath = yield* Effect.promise(async () => {
              for (const candidate of gameCoverCandidates({
                lastPlaytest,
                assets: manifest.value.assets,
              })) {
                try {
                  if ((await NodeFSP.stat(insideGame(root, candidate))).isFile()) return candidate;
                } catch {
                  /* A missing cover is not an error; try the next candidate. */
                }
              }
              return null;
            });
            const summary: GameSummary = {
              projectId: project.id,
              root,
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
          }).pipe(
            // One corrupt record must not take the whole library down; the game
            // still opens for a status read that reports the real error.
            Effect.catch((error) =>
              Effect.logWarning("Skipped a game whose server records could not be read.", {
                projectId: project.id,
                operation: error.operation,
                reason: error.reason,
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
      register(
        NodePath.resolve(input.path.replace(/^~(?=\/|$)/, NodeOS.homedir())),
        input,
        undefined,
        { resume: true },
      ),
    resolve,
    read,
    approveDesign,
    requestChange,
    approveRevision,
    discardRevision,
    updateVerificationPolicy,
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
