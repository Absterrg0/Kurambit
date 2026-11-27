// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem, process, or loopback HTTP boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Struct from "effect/Struct";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  type ChatAttachment,
  ChatAttachmentId,
  CommandId,
  type MessageId,
  ProjectId,
  ThreadId,
  GameManifest,
  GAME_CHARACTER_ROUTE_UNAVAILABLE,
  gameModelChoice,
  GameOperationError,
  gameTemplateForEngine,
  type GameCharacterRoute,
  type GameCreateInput,
  type GameSetCharacterRouteResult,
  type GameListResult,
  type GameOpenInput,
  type GameProjectResult,
  type GameSummary,
  type GameViewport,
} from "@kurambit/contracts";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import { truncate } from "@kurambit/shared/String";
import { writeFileStringAtomically } from "@kurambit/shared/atomicWrite";
import { namedAfterGame, nameInBrief, titleFromFirstMessage } from "./gameChatTitle.ts";
import * as GameOperations from "./GameOperations.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { stepLine } from "./run/runView.ts";
import { stepNumber } from "../orchestration-v2/gameRun/decide.ts";
import { latestGameActivity, sortGameSummaries } from "./gameSummary.ts";
import { engineProfile } from "./engineProfile.ts";
import { findKeyArt } from "./keyArt.ts";
import { readPublished } from "./publishedRecord.ts";
import { realGameRoot } from "./gameRecord.ts";
import { gameRelative } from "./gamePath.ts";
import { ensureScaffold, refreshSkills } from "./runSetup.ts";
import { createEngine, firstTurnMessage, scaffoldFiles } from "./scaffold.ts";
import { copyTemplateIntoGame } from "./templates.ts";
import * as GamePreview from "./GamePreview.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GameTemplates from "./GameTemplates.ts";
import * as IdAllocator from "@kurambit/provider-core/server/IdAllocator";
import * as ServerConfig from "../config.ts";
import {
  attachmentRelativePath,
  chatAttachmentStableKey,
  createDeterministicAttachmentId,
} from "../attachmentStore.ts";

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

/**
 * The first of `folder`, `folder-2`, … under `parent` that holds no game, so a second game from
 * the same brief (a retry after a failed first turn) is a new game beside the first. A name
 * Kurambit chose from the brief follows its folder ("Name 2"); a typed name stays as typed.
 */
export const freeGameFolder = async (
  parent: string,
  folder: string,
  name: string,
  renumber: boolean,
) => {
  for (let n = 1; ; n++) {
    const root = NodePath.join(parent, n === 1 ? folder : `${folder}-${n}`);
    const taken = await NodeFSP.lstat(root).then(
      () => true,
      () => false,
    );
    // Past 100 the last one is returned taken, and the create says the folder exists.
    if (!taken || n === 100 || (await halfMadeCreate(root)))
      return { root, name: n === 1 || !renumber ? name : `${name} ${n}` };
  }
};

const gitInitError = (root: string) => (cause: unknown) =>
  new GameOperationError({
    operation: "git-init",
    path: root,
    reason: "tool-failed",
    detail: "git could not create the game's repository and its first commit.",
    cause,
  });

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
     * chat's too, so a keep-going run stopped by the deletion still tells the game's clients.
     */
    readonly resolve: (
      threadId: ThreadId,
      options?: { readonly deleted?: "allowed" },
    ) => Effect.Effect<string, GameOperationError>;
    /**
     * The game a thread belongs to, at its own folder: the project's root even when the thread
     * works in a copy. Decisions, the folder's writer and Bring in are the game's, never a copy's.
     */
    readonly home: (
      threadId: ThreadId,
    ) => Effect.Effect<
      { readonly root: string; readonly projectId: ProjectId },
      GameOperationError
    >;
    readonly read: (root: string) => Effect.Effect<GameManifest, GameOperationError>;
    /**
     * `work` on the thread's game folder as the game's one operation
     * (GameOperations.exclusive), owned by the thread unless `owner` names
     * another; `waitUntil` (epoch ms) queues behind another operation until
     * then instead of failing busy.
     */
    readonly exclusive: <A, E>(
      threadId: ThreadId,
      name: string,
      work: (root: string) => Effect.Effect<A, E>,
      options?: { readonly owner?: string | undefined; readonly waitUntil?: number | undefined },
    ) => Effect.Effect<A, E | GameOperationError>;
    /**
     * The person's choice of how this game's models are made and whether the library is on,
     * written into game.json; an omitted part stays as it is. The client's control reaches it
     * through GameRunControl.setModelChoice; keep going reaches it to put a step's change back.
     */
    readonly setCharacterRoute: (
      threadId: ThreadId,
      choice: { readonly route?: GameCharacterRoute; readonly library?: boolean },
    ) => Effect.Effect<GameSetCharacterRouteResult, GameOperationError>;
    /**
     * The name a person gave the game (its project's title) where its files carry the name it
     * had: game.json, which a copy of the folder elsewhere and Publish read, and the page's and
     * the brief's title where they still read the old name. Text the agent wrote stays its own.
     * Not the folder: its path is the game's identity. A folder that is no game is left alone.
     */
    readonly named: (workspaceRoot: string, name: string) => Effect.Effect<void>;
    /**
     * A game's worktrees (a copy, a delegated child's, a handoff's) are seated on its folder's
     * files, never on HEAD, which in a game is the empty scaffold: T3's `worktreeSeed`.
     */
    readonly seatWorktreesOnFiles: (projectId: ProjectId) => Effect.Effect<void>;
    /**
     * Chats Kurambit once titled with their game's name take a title from their own first
     * message (titleFromFirstMessage), by the command a rename uses. Run at startup: a retitled
     * chat no longer matches, so every start and a start after a crash halfway do only what is
     * left. Gives how many it retitled.
     */
    readonly retitleChatsNamedAfterGames: () => Effect.Effect<number>;
    /** Between turns: the game's studio skills brought up to this server. */
    readonly refreshGuidance: (root: string) => Effect.Effect<void, GameOperationError>;
    /** The manifest and the resolution the game plays at. */
    readonly inventory: (
      root: string,
    ) => Effect.Effect<{ manifest: GameManifest; viewport: GameViewport }, GameOperationError>;
  }
>()("kurambit/game/GameProjectService") {}
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(GameManifest));
/** game.json as a plain object, so a write that sets one key keeps every other as it was. */
const decodeManifestObject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** A new game's first message: the ids it is sent under, when they were minted here, and its attachments. */
interface FirstMessage {
  readonly threadId?: ThreadId;
  readonly messageId?: MessageId;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}
const NO_IDS: FirstMessage = { attachments: [] };

/** Where a new game keeps the picture the person attached on Home; gameReference.ts reads it. */
const GAME_REFERENCE_FILE = "art/reference.png";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The attached picture's bytes, refused with why when they are not a PNG. */
const referencePng = (reference: NonNullable<GameCreateInput["reference"]>) =>
  Effect.gen(function* () {
    const bytes = Buffer.from(
      reference.dataUrl.slice(reference.dataUrl.indexOf(",") + 1),
      "base64",
    );
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
      return yield* new GameOperationError({
        operation: "create-game",
        path: GAME_REFERENCE_FILE,
        reason: "invalid-input",
        detail: "The attached picture is not a PNG.",
      });
    return { name: reference.name, bytes };
  });

const make = Effect.gen(function* () {
  const preview = yield* GamePreview.GamePreview;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const operations = yield* GameOperations.GameOperations;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const vcs = yield* VcsDriverRegistry.VcsDriverRegistry;
  const templates = yield* GameTemplates.GameTemplates;
  const createLocks = yield* KeyedLock.make<string>();
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const config = yield* ServerConfig.ServerConfig;
  /**
   * The game's name from its brief, written by the text-generation model T3 titles threads with:
   * the title a player sees. The game waits for it, because the name goes into its folder,
   * game.json, BRIEF.md and the page's title, which the agent reads from its first second: a name
   * that arrived later would leave the drafted one in all of them. A slow or failing model leaves
   * the drafted name, so a new game never fails over its name. A brief that names its game keeps
   * that name, without asking the model.
   */
  const nameFromBrief = (brief: string, drafted: string) =>
    Effect.gen(function* () {
      const named = nameInBrief(brief);
      if (named !== null) return named;
      const settings = yield* serverSettings.getSettings;
      const generated = yield* textGeneration.generateGameName({
        cwd: NodeOS.homedir(),
        brief,
        modelSelection: settings.textGenerationModelSelection,
      });
      return generated.name.trim() || drafted;
    }).pipe(
      Effect.withSpan("GameProjectService.nameFromBrief"),
      Effect.timeout("12 seconds"),
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logWarning("Game name generation failed; the drafted name stands", { cause }),
          drafted,
        ),
      ),
    );
  // A card says what a live run is doing. A paused or ended run reads nothing
  // here, so the row never masks "Needs attention"; the chat's banner says paused.
  const liveRun = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const run = yield* projections.getProjectGameRun(projectId);
      if (run === null || run.status === "ended") return null;
      const records = yield* projections.getGameRunRecords(run.threadId, { steps: "in-flight" });
      const n = stepNumber(records.gameRunRounds, records.gameLastStep);
      return { step: stepLine(n), startedAt: run.startedAt } satisfies GameSummary["run"];
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
        // The record is checked by its text; what opens a path checks where it really leads
        // (insideGame), so a link in the game refuses that operation, not the whole game.
        gameRelative(root, manifest.project);
        for (const asset of manifest.assets)
          for (const relative of [
            asset.source,
            asset.script,
            asset.export,
            ...(asset.thumbnail ? [asset.thumbnail] : []),
          ])
            gameRelative(root, relative);
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
              gameRelative(root, `${manifest.project}/${rest}`);
            } else {
              gameRelative(root, target);
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
  /**
   * The ids and attachments of a new game's first message. The person's picture rides on it as a
   * chat attachment, stored where the composer's are, under ids minted for that thread and
   * message; when it cannot be stored the message goes without it, as the game already holds it.
   */
  const firstMessage = (
    projectId: ProjectId,
    reference: { readonly name: string; readonly bytes: Buffer } | undefined,
  ) =>
    Effect.gen(function* () {
      if (reference === undefined) return NO_IDS;
      const threadId = yield* ids.allocate.thread({ projectId });
      const messageId = yield* ids.allocate.message({ threadId, ordinal: 1 });
      const rawId = createDeterministicAttachmentId(
        threadId,
        chatAttachmentStableKey(messageId, 0, reference.bytes),
      );
      if (rawId === null) return { threadId, messageId, attachments: [] } as FirstMessage;
      const attachment = {
        type: "image" as const,
        id: ChatAttachmentId.make(rawId),
        name: reference.name,
        mimeType: "image/png",
        sizeBytes: reference.bytes.byteLength,
      };
      const stored = yield* Effect.tryPromise(async () => {
        const file = NodePath.join(config.attachmentsDir, attachmentRelativePath(attachment)!);
        await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
        await NodeFSP.writeFile(file, reference.bytes);
      }).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.as(
            Effect.logWarning("The first message goes without its picture.", { cause }),
            false,
          ),
        ),
      );
      return {
        threadId,
        messageId,
        attachments: stored ? [attachment] : [],
      } as FirstMessage;
    }).pipe(
      Effect.catchTags({
        IdAllocatorV2AllocationError: (cause) =>
          Effect.as(
            Effect.logWarning("The first message goes without its picture.", { cause }),
            NO_IDS,
          ),
      }),
    );
  /** game.json with `change` made to it; every key the change leaves stays as it was read. */
  const writeManifest = (
    root: string,
    operation: string,
    change: (raw: Record<string, unknown>) => Record<string, unknown>,
  ) =>
    Effect.gen(function* () {
      const file = NodePath.join(root, "game.json");
      const failed = (reason: "io" | "invalid-project") => (cause: unknown) =>
        new GameOperationError({ operation, path: file, reason, cause });
      const text = yield* Effect.tryPromise({
        try: () => NodeFSP.readFile(file, "utf8"),
        catch: failed("io"),
      });
      const raw = yield* decodeManifestObject(text).pipe(
        Effect.mapError(failed("invalid-project")),
      );
      yield* writeFileStringAtomically({
        filePath: file,
        // @effect-diagnostics-next-line preferSchemaOverJson:off -- game.json keeps the indented form people read and diff.
        contents: `${JSON.stringify(change(raw), null, 2)}\n`,
        followLink: false,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(failed("io")),
      );
    });
  /** The file's first `from`, the scaffold's mention of the old name, as `to`; else untouched. */
  const renameIn = (root: string, file: string, from: string, to: string) =>
    Effect.tryPromise(() => NodeFSP.readFile(NodePath.join(root, file), "utf8")).pipe(
      Effect.map((text) => (text.includes(from) ? text.replace(from, () => to) : null)),
      Effect.flatMap((text) =>
        text === null
          ? Effect.void
          : // A name is no change the running game plays: its Stage must not reload or offer it.
            preview.quietWrite(root, file, text).pipe(
              Effect.andThen(
                writeFileStringAtomically({
                  filePath: NodePath.join(root, file),
                  contents: text,
                  followLink: false,
                }),
              ),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            ),
      ),
    );
  const named = (workspaceRoot: string, name: string) =>
    Effect.gen(function* () {
      const game = yield* Effect.tryPromise(() => realGameRoot(workspaceRoot)).pipe(
        Effect.flatMap((root) => Effect.map(read(root), (manifest) => ({ root, manifest }))),
        Effect.option,
      );
      if (Option.isNone(game) || game.value.manifest.name === name) return;
      const { root, manifest } = game.value;
      const old = manifest.name;
      yield* writeManifest(root, "rename-game", (raw) => ({ ...raw, name }));
      // The scaffold writes the name as it is; a new one is escaped, so it cannot end the title.
      const html = name.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
      yield* renameIn(
        root,
        NodePath.join(manifest.project, "index.html"),
        `<title>${old}</title>`,
        `<title>${html}</title>`,
      );
      yield* renameIn(root, "BRIEF.md", `# ${old}\n`, `# ${name}\n`);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The game's files keep their old name.", { workspaceRoot, cause }),
      ),
    );
  const register = Effect.fnUntraced(function* (
    root: string,
    input: Pick<GameCreateInput, "modelSelection" | "runtimeMode">,
    options: {
      readonly resume?: boolean;
      /** A new, empty chat: the game's empty one when it has one, else a fresh one. */
      readonly newChat?: boolean;
      readonly firstTurn?: boolean;
      /** The person's picture, already saved as art/reference.png; the first message carries it. */
      readonly reference?: { readonly name: string; readonly bytes: Buffer };
    } = {},
  ) {
    const lexicalRoot = NodePath.resolve(root);
    const canonicalRoot = yield* resolveCanonicalRoot(lexicalRoot, "register-game");
    const manifest = yield* read(canonicalRoot);
    // An existing game, resumed or in a new chat, reads this server's skills from its first turn.
    if (options.firstTurn !== true)
      yield* refreshSkills(canonicalRoot, manifest.engine.name, yield* templates.directory).pipe(
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
    yield* seatWorktreesOnFiles(project.id);
    // Opening a folder is "continue this game", not "start another chat": the
    // project's newest session already has the history and the context. A new chat reuses an
    // empty one, so New chat pressed twice opens one chat, as T3's draft does.
    if (options.resume === true || options.newChat === true) {
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
        (thread) =>
          thread.deletedAt === null &&
          thread.archivedAt === null &&
          (options.newChat !== true ||
            (thread.latestRunId === null && thread.latestVisibleMessage === null)),
      );
      if (latest !== undefined)
        return { projectId: project.id, threadId: latest.id, root: canonicalRoot };
    }
    const first =
      options.firstTurn === true ? yield* firstMessage(project.id, options.reference) : null;
    const result = yield* launches
      .launch({
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        projectId: project.id,
        ...(first?.threadId === undefined ? {} : { threadId: first.threadId }),
        // A chat is never titled with its game's name: every row already says the game. The
        // chat a game is made in is titled from its brief, as T3 titles a thread from its first
        // message (the brief's opening until the model's title lands); an empty one is a new chat.
        ...(first === null
          ? { title: "New chat" }
          : {
              title: truncate(manifest.brief.trim().split("\n")[0] ?? "") || "New chat",
              generateTitle: true,
            }),
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode ?? "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        // A new game's chat opens with its brief, sent atomically with the thread.
        ...(first === null
          ? {}
          : {
              initialMessage: {
                ...(first.messageId === undefined ? {} : { messageId: first.messageId }),
                text: firstTurnMessage(manifest, { reference: options.reference !== undefined }),
                attachments: first.attachments,
              },
            }),
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
      const drafted = input.name.trim();
      if (drafted === "")
        return yield* new GameOperationError({
          operation: "create-game",
          path: input.name,
          reason: "invalid-path",
          detail: "A game needs a name.",
        });
      const unavailable =
        input.characters === undefined
          ? undefined
          : GAME_CHARACTER_ROUTE_UNAVAILABLE[input.characters];
      if (unavailable !== undefined)
        return yield* new GameOperationError({
          operation: "create-game",
          path: input.name,
          reason: "invalid-input",
          detail: `Make characters with ${input.characters}: ${unavailable}`,
        });
      const name =
        input.nameFromBrief === true ? yield* nameFromBrief(input.brief, drafted) : drafted;
      const parent = input.parentDirectory.trim() || NodePath.join(NodeOS.homedir(), "Games");
      const free = yield* Effect.promise(() =>
        freeGameFolder(
          NodePath.resolve(parent.replace(/^~(?=\/|$)/, NodeOS.homedir())),
          gameFolderName(
            name,
            // From the name itself, so one name always starts at the same folder.
            NodeCrypto.createHash("sha256").update(name.normalize("NFC")).digest("hex").slice(0, 6),
          ),
          name,
          input.nameFromBrief === true,
        ),
      );
      // One create per folder at a time in this server, so a second click
      // cannot take the first's half-made folder for a leftover.
      // The scaffold (game.json, the page's title) and the project take the name the game got.
      return yield* createLocks.withLock(
        free.root,
        createAt({ ...input, name: free.name }, free.name, free.root),
      );
    },
  );
  const createAt = (input: GameCreateInput, name: string, requestedRoot: string) =>
    Effect.gen(function* () {
      const reference =
        input.reference === undefined ? undefined : yield* referencePng(input.reference);
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
            ])
              await NodeFSP.mkdir(NodePath.join(root, relative), { recursive: true });
            for (const [relative, contents] of Object.entries(scaffoldFiles(input))) {
              const file = NodePath.join(root, relative);
              await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
              await NodeFSP.writeFile(file, contents, { flag: "wx" });
            }
            // In the first commit, so no turn's build counts it as its change.
            if (reference !== undefined)
              await NodeFSP.writeFile(NodePath.join(root, GAME_REFERENCE_FILE), reference.bytes, {
                flag: "wx",
              });
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
        }).pipe(Effect.withSpan("GameProjectService.create.scaffold"));
        const templatesDirectory = yield* templates.directory;
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
        yield* ensureScaffold(templatesDirectory, root, createEngine(input), true).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.withSpan("GameProjectService.create.skills"),
        );
        // The first commit is Kurambit's own, through git's plumbing: the
        // user's signing config and hooks never apply to it. The marker sits
        // under the ignored builds/, so it never rides in that commit.
        const git = yield* vcs.get("git").pipe(Effect.mapError(gitInitError(root)));
        yield* git
          .initRepository({ cwd: root, initialCommit: { message: "chore: create game project" } })
          .pipe(
            Effect.mapError(gitInitError(root)),
            Effect.withSpan("GameProjectService.create.gitInit"),
          );
        yield* Effect.tryPromise({
          try: () => NodeFSP.rm(NodePath.join(root, CREATE_MARKER)),
          catch: (cause) =>
            new GameOperationError({ operation: "create-game", path: root, reason: "io", cause }),
        });
        // No run starts: the chat's first turn makes the first playable build.
        // A game removed from Kurambit leaves its serve and watch on the folder's path; this game
        // is new there, so it starts with none of them.
        yield* preview.forget(root);
        return yield* register(root, input, {
          firstTurn: true,
          ...(reference === undefined ? {} : { reference }),
        }).pipe(Effect.withSpan("GameProjectService.create.register"));
      }).pipe(
        // A create that fails or is interrupted must not leave a half-made folder behind.
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : rollback)),
      );
    });
  const place = Effect.fn("GameProjectService.place")(function* (
    threadId: ThreadId,
    options: { readonly deleted?: "allowed"; readonly home?: boolean } = {},
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
      NodePath.resolve(
        options.home === true
          ? project.value.workspaceRoot
          : (thread.worktreePath ?? project.value.workspaceRoot),
      ),
      "resolve-project",
    );
    yield* read(root);
    return { root, projectId: project.value.id };
  });

  const seatWorktreesOnFiles = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const overrides = settings.projectSettingsOverrides[projectId];
      if (overrides?.worktreeSeed === "working-tree") return;
      yield* serverSettings.updateSettings({
        projectSettingsOverrides: {
          [projectId]: { ...overrides, worktreeSeed: "working-tree" },
        },
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A game's worktrees could not be seated on its files.", {
          projectId,
          cause,
        }),
      ),
    );

  const resolve = (threadId: ThreadId, options: { readonly deleted?: "allowed" } = {}) =>
    Effect.map(place(threadId, options), (placed) => placed.root);
  const home = (threadId: ThreadId) => place(threadId, { home: true });
  const retitleChatsNamedAfterGames = Effect.fn("GameProjectService.retitleChatsNamedAfterGames")(
    function* () {
      const [projectSnapshot, active, archived] = yield* Effect.all([
        projects.snapshot,
        threads.getShellSnapshot(),
        threads.getShellSnapshot({ location: "archive" }),
      ]);
      const chats = [...active.threads, ...archived.threads].filter(
        (chat) => chat.deletedAt === null && chat.latestUserMessageAt !== null,
      );
      let retitled = 0;
      for (const project of projectSnapshot.projects) {
        const mine = chats.filter((chat) => chat.projectId === project.id);
        if (mine.length === 0) continue;
        const manifest = yield* Effect.tryPromise(() => realGameRoot(project.workspaceRoot)).pipe(
          Effect.flatMap(read),
          Effect.option,
        );
        if (Option.isNone(manifest)) continue;
        const gameNames = [project.title, manifest.value.name];
        for (const chat of mine) {
          // Only a chat that matches reads its messages: every other start costs two listings.
          if (!namedAfterGame(chat.title, gameNames)) continue;
          const records = yield* threads.getThreadRecords(chat.id, ["messages"], {
            messageRoles: ["user"],
          });
          const first = records.messages
            .filter((message) => !message.streaming)
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
            )[0];
          const title = titleFromFirstMessage({
            title: chat.title,
            gameNames,
            firstMessage: first?.text ?? null,
          });
          if (title === null) continue;
          yield* threads.dispatch({
            type: "thread.metadata.update",
            // One per chat for good: a person who names a chat after its game keeps that name.
            commandId: CommandId.make(`game-chat-title:${chat.id}`),
            threadId: chat.id,
            title,
          });
          retitled += 1;
        }
      }
      return retitled;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not retitle chats named after their games.", { cause }).pipe(
        Effect.as(0),
      ),
    ),
  );

  return GameProjectService.of({
    create,
    home,
    retitleChatsNamedAfterGames,
    seatWorktreesOnFiles,
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
              findKeyArt(root, manifest.value.project, manifest.value.engine.name),
            );
            // The library card's facts: how many builds the game has had and when the last one
            // landed (the tally's highest number counts every numbered build, copies included),
            // and where it is published.
            const tally = yield* projections
              .getGameBuildTally(project.id)
              .pipe(Effect.orElseSucceed(() => ({ number: 0, parks: 0 })));
            const latestBuild = yield* projections
              .listGameBuilds(project.id, { root, limit: 1 })
              .pipe(Effect.orElseSucceed(() => []));
            const published = yield* readPublished(root);
            const summary: GameSummary = {
              projectId: project.id,
              root,
              // The project's title is the name the person sees and renames; game.json follows it.
              name: project.title,
              template: manifest.value.template ?? null,
              operation:
                currentOperation === null
                  ? null
                  : { name: currentOperation.name, state: currentOperation.state },
              run: yield* liveRun(project.id),
              keyArt,
              buildCount: tally.number,
              latestBuildAt: latestBuild[0]?.at ?? null,
              published,
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
      register(
        NodePath.resolve(input.path.replace(/^~(?=\/|$)/, NodeOS.homedir())),
        input,
        input.newChat === true ? { newChat: true } : { resume: true },
      ),
    resolve,
    read,
    named,
    exclusive: (threadId, name, work, options) =>
      Effect.flatMap(resolve(threadId), (root) =>
        operations.exclusive(
          root,
          name,
          work(root),
          options?.owner ?? String(threadId),
          options?.waitUntil === undefined ? undefined : { waitUntil: options.waitUntil },
        ),
      ),
    setCharacterRoute: Effect.fn("GameProjectService.setCharacterRoute")(
      function* (threadId, choice) {
        const root = yield* resolve(threadId);
        const unavailable =
          choice.route === undefined ? undefined : GAME_CHARACTER_ROUTE_UNAVAILABLE[choice.route];
        if (unavailable !== undefined)
          return yield* new GameOperationError({
            operation: "set-characters",
            path: NodePath.join(root, "game.json"),
            reason: "invalid-input",
            detail: `${choice.route}: ${unavailable}`,
          });
        // A valid manifest first; the write keeps every key it holds, only the choice changes, and
        // both parts are written as read so an old game's "library" route becomes what it means.
        const current = gameModelChoice(yield* read(root));
        const route = choice.route ?? current.route;
        const library = choice.library ?? current.library;
        // The code route is no key (see scaffold.ts): older installs still open the game.
        yield* writeManifest(root, "set-characters", (raw) =>
          route === "code"
            ? { ...Struct.omit(raw, ["characters"]), library }
            : { ...raw, characters: route, library },
        );
        // Every client's status signal rereads on an operation push.
        yield* operations.changed(
          root,
          "characters",
          `Make models with ${route}, library ${library ? "on" : "off"}`,
        );
        return { route, library };
      },
    ),
    refreshGuidance: (root) =>
      Effect.gen(function* () {
        const manifest = yield* read(root);
        yield* refreshSkills(root, manifest.engine.name, yield* templates.directory).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
      }),
    inventory: Effect.fn("GameProjectService.inventory")(function* (root) {
      const manifest = yield* read(root);
      return { manifest, viewport: { ...engineProfile(manifest.engine.name).viewport } };
    }),
  });
});
export const layer = Layer.effect(GameProjectService, make).pipe(Layer.provide(IdAllocator.layer));
