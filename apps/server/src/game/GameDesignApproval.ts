// @effect-diagnostics nodeBuiltinImport:off -- Approval records live on the native filesystem outside the game workspace.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  DEFAULT_GAME_TEST_SUITE,
  diffAcceptance,
  GameAcceptanceCriterion,
  GameOperationError,
  StoredGameAcceptanceCriterion,
  normalizeAcceptance,
  type GameDesignRead,
  type GameDesignState,
  type GamePendingRevision,
  GameVerificationPolicy,
  type GameManifest,
  type GameVerificationPolicyRead,
} from "@t3tools/contracts";
import { validateDesignDocument } from "@t3tools/contracts";
import { designSkeleton } from "./scaffold.ts";
import {
  gameRecordFile,
  gameRecordLocation,
  migrateGameRecord,
  readRecordText,
  type GameRecordLocation,
} from "./gameRecord.ts";

/**
 * What the creator approved: a specific DESIGN.md revision and the acceptance
 * that revision binds. It lives under the server's state directory, so an
 * agent editing game.json or DESIGN.md cannot mint an approval.
 */
export interface DesignApprovalRecord {
  readonly schemaVersion: 1;
  readonly game: string;
  readonly approvalId: string;
  readonly designHash: string;
  readonly approvedAt: string;
  readonly acceptance: readonly GameAcceptanceCriterion[];
  /**
   * The one build turn this approval owns. The ids are chosen and persisted
   * before dispatch, so a crash or a post-commit reply failure can reconcile the
   * orchestration receipt instead of sending a second message. `pending` means
   * "may or may not have been accepted"; `dispatched` means the command path
   * accepted it.
   */
  readonly buildDispatch?: {
    readonly commandId: string;
    readonly messageId: string;
    readonly threadId: string;
    readonly state: "pending" | "dispatched";
  };
}
/**
 * What the server promised at creation: a plan-first game owes a reviewable
 * DESIGN.md, a skip-planning game explicitly skips it. Written once, outside the
 * workspace, so deleting DESIGN.md or editing game.json cannot turn a plan-first
 * game into a legacy one.
 */
export type GameDesignIntent = "required" | "skipped";
/**
 * The full creation record. `probe` and `verification` are both here because an
 * agent can edit game.json, and the server's promise must outlive that edit.
 */
const StoredIntent = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    game: Schema.String,
    intent: Schema.Literals(["required", "skipped"]),
    probe: Schema.optionalKey(Schema.Boolean),
    verification: Schema.optionalKey(GameVerificationPolicy),
  }),
);
const decodeStoredIntent = Schema.decodeUnknownSync(StoredIntent);
type StoredIntentRecord = typeof StoredIntent.Type;

/**
 * A stable identity for the exam, so a policy change invalidates evidence
 * recorded under the old one. Derived rather than stored: rewriting the same
 * policy keeps the same revision.
 */
const verificationPolicyRevision = (policy: GameVerificationPolicy): string =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([policy.testSuite, policy.gameplayScene, policy.probe]))
    .digest("hex")
    .slice(0, 16);

/**
 * The policy a game with no server-owned one adopts, from the manifest it was
 * created with and from what the game tree itself shows. The creation probe
 * obligation wins over both, so a template game cannot drop it by editing
 * game.json after creation. This runs once.
 */
const deriveVerificationPolicy = (
  manifest: GameManifest,
  probeIntent: boolean | null,
  observedProbe: boolean,
): GameVerificationPolicy => ({
  testSuite: manifest.testSuite ?? DEFAULT_GAME_TEST_SUITE,
  gameplayScene: manifest.gameplayScene ?? null,
  probe: probeIntent ?? (observedProbe || manifest.probe === true),
});

/**
 * Whether the game tree actually carries an instrumented probe: the task-26c
 * script at the manifest's godot project root, or an autoload wired to it.
 * Pre-27 template games were created before the obligation was recorded, so the
 * tree is the honest witness and adoption is one-way: once the persisted policy
 * exists later, deleting the probe only breaks the playtest.
 */
export const gameTreeOwesProbe = async (root: string, godotProject: string): Promise<boolean> => {
  const projectDirectory = NodePath.join(root, godotProject);
  try {
    await NodeFSP.access(NodePath.join(projectDirectory, "scripts", "studio_probe.gd"));
    return true;
  } catch {
    // Absent script files are expected for non-instrumented games.
  }
  try {
    const project = await NodeFSP.readFile(
      NodePath.join(projectDirectory, "project.godot"),
      "utf8",
    );
    return /^[ \t]*StudioProbe[ \t]*=/m.test(project);
  } catch {
    return false;
  }
};

/**
 * The intent a pre-record game had, expressed without changing its design
 * state: a truly legacy shape stays skipped, anything that owed a document
 * stays required.
 */
const adoptedIntent = (manifest: GameManifest, documentExists: boolean): GameDesignIntent =>
  manifest.design === undefined || (manifest.design.status === "approved" && !documentExists)
    ? "skipped"
    : "required";
const StoredRecord = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    game: Schema.String,
    approvalId: Schema.String,
    designHash: Schema.String,
    approvedAt: Schema.String,
    // Persisted approvals may still use the old `end` kind; normalizeAcceptance
    // below maps it to `win` so the runtime only sees current kinds.
    acceptance: Schema.Array(StoredGameAcceptanceCriterion),
    buildDispatch: Schema.optionalKey(
      Schema.Struct({
        commandId: Schema.String,
        messageId: Schema.String,
        threadId: Schema.String,
        state: Schema.Literals(["pending", "dispatched"]),
      }),
    ),
  }),
);
const decodeStoredRecord = Schema.decodeUnknownSync(StoredRecord);
/**
 * One creator change request while it stays open. `GamePendingRevision` is the
 * wire shape; the stored file adds the same envelope the approval record
 * carries so the record names its game and can evolve without breaking reads.
 */
const StoredPendingRevision = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    game: Schema.String,
    id: Schema.String,
    text: Schema.String,
    requestedAt: Schema.String,
    baseHash: Schema.String,
  }),
);
const decodeStoredRevision = Schema.decodeUnknownSync(StoredPendingRevision);

export const designDocumentHash = (design: string) =>
  NodeCrypto.createHash("sha256").update(design).digest("hex");

/** Reads DESIGN.md as text; null means missing or unreadable, never "empty". */
export const readDesignDocument = async (root: string): Promise<string | null> => {
  try {
    return await NodeFSP.readFile(NodePath.join(root, "DESIGN.md"), "utf8");
  } catch {
    return null;
  }
};

/**
 * The largest document the Design tab shows. One page is far below this; the
 * bound exists so a status read cannot ship an unbounded file to the client.
 */
export const DESIGN_DOCUMENT_LIMIT = 64 * 1024;
interface DesignSnapshot {
  readonly document: string | null;
  readonly truncated: boolean;
}
const readDesignSnapshot = async (root: string): Promise<DesignSnapshot> => {
  let handle: NodeFSP.FileHandle | null = null;
  try {
    handle = await NodeFSP.open(NodePath.join(root, "DESIGN.md"), "r");
    // Read one byte past the limit so a single short read cannot make a large
    // file look complete; a regular file may return fewer bytes than asked.
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= DESIGN_DOCUMENT_LIMIT) {
      const chunk = Buffer.alloc(DESIGN_DOCUMENT_LIMIT + 1 - total);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    return {
      document: Buffer.concat(chunks)
        .subarray(0, Math.min(total, DESIGN_DOCUMENT_LIMIT))
        .toString("utf8"),
      truncated: total > DESIGN_DOCUMENT_LIMIT,
    };
  } catch {
    return { document: null, truncated: false };
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export const designDocumentExists = async (root: string) => {
  try {
    return (await NodeFSP.stat(NodePath.join(root, "DESIGN.md"))).isFile();
  } catch {
    return false;
  }
};

const recordPath = (stateDir: string, root: string) =>
  gameRecordFile(stateDir, "game-design", root, ".json");
const intentPath = (stateDir: string, root: string) =>
  gameRecordFile(stateDir, "game-design", root, ".intent.json");
const revisionPath = (stateDir: string, root: string) =>
  gameRecordFile(stateDir, "game-design", root, ".revision.json");

/**
 * The record's real location. Records written before roots were canonical live
 * under the lexical key; migrate one before the read so an alias and the real
 * root share one record from then on.
 */
const prepareLocation = async (
  stateDir: string,
  root: string,
  extension: ".json" | ".intent.json" | ".revision.json",
): Promise<GameRecordLocation> => {
  const location = await gameRecordLocation(stateDir, "game-design", root, extension);
  await migrateGameRecord(location);
  return location;
};
const located = (
  stateDir: string,
  root: string,
  extension: ".json" | ".intent.json" | ".revision.json",
  operation: string,
) =>
  Effect.tryPromise({
    try: () => prepareLocation(stateDir, root, extension),
    catch: (cause) => new GameOperationError({ operation, path: root, reason: "io", cause }),
  });

export const readDesignApprovalRecord = async (
  file: string,
): Promise<DesignApprovalRecord | null> => {
  const text = await readRecordText(file);
  // A missing record proves nothing; a record that exists but cannot be decoded
  // throws, so the caller can refuse rather than downgrade the game.
  if (text === null) return null;
  const stored = decodeStoredRecord(text);
  return { ...stored, acceptance: normalizeAcceptance(stored.acceptance) };
};

/** The full server-owned creation record; null only when absent. */
const readStoredIntent = async (file: string): Promise<StoredIntentRecord | null> => {
  const text = await readRecordText(file);
  return text === null ? null : decodeStoredIntent(text);
};

export const readDesignIntent = async (file: string): Promise<GameDesignIntent | null> =>
  (await readStoredIntent(file))?.intent ?? null;

/** Whether the game was created from a template that ships the StudioProbe. */
const readProbeIntent = async (file: string): Promise<boolean | null> =>
  (await readStoredIntent(file))?.probe ?? null;

const writeRecord = async (file: string, record: DesignApprovalRecord) => {
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  try {
    await NodeFSP.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    await NodeFSP.rename(temporary, file);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
};

const writeIntentRecord = async (file: string, record: StoredIntentRecord) => {
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  try {
    await NodeFSP.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    await NodeFSP.rename(temporary, file);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
};

const writeIntent = async (
  file: string,
  game: string,
  intent: GameDesignIntent,
  probe: boolean | undefined,
  verification: GameVerificationPolicy | undefined,
) => {
  await writeIntentRecord(file, {
    schemaVersion: 1,
    game,
    intent,
    ...(probe === undefined ? {} : { probe }),
    ...(verification === undefined ? {} : { verification }),
  });
};

/**
 * The approval lifecycle. A game with no record is a draft while it still has a
 * DESIGN.md to review; only a game with no server records at all (created before
 * the intent record existed) is legacy. A creator or agent editing game.json to
 * "approved" therefore cannot pass a plan-first game.
 */
const deriveDesignState = (input: {
  readonly record: DesignApprovalRecord | null;
  readonly intent: GameDesignIntent | null;
  readonly currentHash: string | null;
  readonly manifestDesign: GameManifest["design"];
  readonly documentExists: boolean;
  /** An open change request keeps the design under review until it resolves. */
  readonly pendingRevision: GamePendingRevision | null;
}): GameDesignState => {
  if (input.pendingRevision !== null && input.record !== null) return "revision-pending";
  if (input.record !== null)
    return input.currentHash !== null && input.currentHash === input.record.designHash
      ? "approved"
      : "changed";
  if (input.intent === "skipped") return "legacy";
  if (input.intent === "required") return "draft";
  if (input.manifestDesign === undefined) return "legacy";
  if (input.manifestDesign.status === "draft") return "draft";
  return input.documentExists ? "draft" : "legacy";
};

const designRead = async (
  stateDir: string,
  root: string,
  manifest: GameManifest,
): Promise<GameDesignRead> => {
  const [approvalLocation, intentLocation, revisionLocation] = await Promise.all([
    prepareLocation(stateDir, root, ".json"),
    prepareLocation(stateDir, root, ".intent.json"),
    prepareLocation(stateDir, root, ".revision.json"),
  ]);
  const record = await readDesignApprovalRecord(approvalLocation.file);
  const intent = await readDesignIntent(intentLocation.file);
  const pendingRevision = await readPendingRevision(revisionLocation.file);
  // One read is the snapshot: the text, its hash and the parsed acceptance all
  // come from these bytes, so the Design tab cannot show one revision and
  // approve another.
  const snapshot = await readDesignSnapshot(root);
  const design = snapshot.document;
  const currentHash = design === null || snapshot.truncated ? null : designDocumentHash(design);
  const exists = design === null ? await designDocumentExists(root) : true;
  const state = deriveDesignState({
    record,
    intent,
    currentHash,
    manifestDesign: manifest.design,
    documentExists: exists,
    pendingRevision,
  });
  const validation = snapshot.truncated
    ? {
        issues: [
          `DESIGN.md is larger than ${DESIGN_DOCUMENT_LIMIT / 1024} KB, so the Design tab cannot show all of it; shorten it before approving.`,
        ],
        acceptance: [],
      }
    : state === "approved" || state === "legacy"
      ? { issues: [], acceptance: [] }
      : validateDesignDocument({
          design,
          skeleton: designSkeleton(manifest.name),
        });
  // Show the criteria the document currently carries so the creator can review
  // them before approving. When an edit leaves the document invalid, fall back
  // to the last approved set rather than hiding what was agreed.
  const currentAcceptance = validation.acceptance;
  // The revision review shows one diff, computed from the same document bytes
  // the hash covers, against the approved set this record binds.
  const revisionDiff =
    pendingRevision !== null &&
    record !== null &&
    !snapshot.truncated &&
    design !== null &&
    currentAcceptance.length > 0
      ? diffAcceptance(record.acceptance, currentAcceptance)
      : null;
  return {
    state,
    document: design,
    documentTruncated: snapshot.truncated,
    approvedHash: record?.designHash ?? null,
    currentHash,
    approvedAt: record?.approvedAt ?? null,
    acceptance: [
      ...(currentAcceptance.length > 0 ? currentAcceptance : (record?.acceptance ?? [])),
    ],
    issues: [...validation.issues],
    pendingRevision,
    revisionDiff,
  };
};

/** The open change request for this game; null when none is pending. */
const readPendingRevision = async (file: string): Promise<GamePendingRevision | null> => {
  const text = await readRecordText(file);
  if (text === null) return null;
  const stored = decodeStoredRevision(text);
  return {
    id: stored.id,
    text: stored.text,
    requestedAt: stored.requestedAt,
    baseHash: stored.baseHash,
  };
};

const writePendingRevision = async (file: string, game: string, revision: GamePendingRevision) => {
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  try {
    await NodeFSP.writeFile(
      temporary,
      `${JSON.stringify({ schemaVersion: 1, game, ...revision }, null, 2)}\n`,
    );
    await NodeFSP.rename(temporary, file);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
};

export class GameDesignApproval extends Context.Service<
  GameDesignApproval,
  {
    readonly read: (root: string) => Effect.Effect<DesignApprovalRecord | null, GameOperationError>;
    /** The creation-time promise: required to design, or explicitly skipped. */
    readonly readIntent: (
      root: string,
    ) => Effect.Effect<GameDesignIntent | null, GameOperationError>;
    readonly recordIntent: (
      root: string,
      intent: GameDesignIntent,
      probe?: boolean,
      verification?: GameVerificationPolicy,
    ) => Effect.Effect<void, GameOperationError>;
    /** Removes the intent this creation attempt wrote; never another game's record. */
    readonly removeIntent: (root: string) => Effect.Effect<void, GameOperationError>;
    /** The creation-time probe obligation, or null for games with no record. */
    readonly readProbe: (root: string) => Effect.Effect<boolean | null, GameOperationError>;
    /**
     * The exam this game qualifies against. A game without a server-owned policy
     * adopts one from its manifest here, once, and the adoption is persisted and
     * logged so a later manifest edit cannot change it.
     */
    readonly readPolicy: (
      root: string,
      manifest: GameManifest,
    ) => Effect.Effect<GameVerificationPolicyRead, GameOperationError>;
    /** Changes the exam; only an explicit creator action may call this. */
    readonly updatePolicy: (
      root: string,
      policy: GameVerificationPolicy,
    ) => Effect.Effect<GameVerificationPolicyRead, GameOperationError>;
    /** The server-owned lifecycle plus what still blocks approval. */
    readonly status: (
      root: string,
      manifest: GameManifest,
    ) => Effect.Effect<GameDesignRead, GameOperationError>;
    /**
     * Serializes one design operation per game. Approval has to cover read,
     * validate, write and dispatch as one unit, not just the manifest write, or
     * two creators can each dispatch a build turn.
     */
    readonly exclusive: <A, E, R>(
      root: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | GameOperationError, R>;
    readonly write: (
      root: string,
      record: DesignApprovalRecord,
    ) => Effect.Effect<void, GameOperationError>;
    /** Removes a record only when it is still the attempt that wrote it. */
    readonly removeOwned: (
      root: string,
      approvalId: string,
    ) => Effect.Effect<void, GameOperationError>;
    /** The creator's open change request for this game, or null. */
    readonly readRevision: (
      root: string,
    ) => Effect.Effect<GamePendingRevision | null, GameOperationError>;
    /** Records the request before the agent turn that acts on it is notified. */
    readonly writeRevision: (
      root: string,
      revision: GamePendingRevision,
    ) => Effect.Effect<void, GameOperationError>;
    /** Resolves (approves or discards) the open change request. */
    readonly removeRevision: (root: string) => Effect.Effect<void, GameOperationError>;
  }
>()("t3/game/GameDesignApproval") {}

export const layer = (options: { readonly stateDir: string }) => {
  const locks = new Map<string, Semaphore.Semaphore>();
  const policyLocks = new Map<string, Semaphore.Semaphore>();
  const semaphoreFor = (map: Map<string, Semaphore.Semaphore>, key: string) => {
    let lock = map.get(key);
    if (lock === undefined) {
      // Creating the lock is synchronous, so two callers cannot both install a
      // different semaphore for the same game.
      lock = Semaphore.makeUnsafe(1);
      map.set(key, lock);
    }
    return lock;
  };
  return Layer.succeed(
    GameDesignApproval,
    GameDesignApproval.of({
      read: (root) =>
        Effect.gen(function* () {
          const location = yield* located(options.stateDir, root, ".json", "read-design");
          return yield* Effect.tryPromise({
            try: () => readDesignApprovalRecord(location.file),
            catch: (cause) =>
              new GameOperationError({
                operation: "read-design",
                path: location.file,
                reason: "io",
                cause,
              }),
          });
        }),
      readIntent: (root) =>
        Effect.gen(function* () {
          const location = yield* located(options.stateDir, root, ".intent.json", "read-design");
          return yield* Effect.tryPromise({
            try: () => readDesignIntent(location.file),
            catch: (cause) =>
              new GameOperationError({
                operation: "read-design",
                path: location.file,
                reason: "io",
                cause,
              }),
          });
        }),
      readProbe: (root) =>
        Effect.gen(function* () {
          const location = yield* located(options.stateDir, root, ".intent.json", "read-design");
          return yield* Effect.tryPromise({
            try: () => readProbeIntent(location.file),
            catch: (cause) =>
              new GameOperationError({
                operation: "read-design",
                path: location.file,
                reason: "io",
                cause,
              }),
          });
        }),
      readPolicy: (root, manifest) =>
        Effect.gen(function* () {
          const location = yield* located(
            options.stateDir,
            root,
            ".intent.json",
            "read-verification-policy",
          );
          return yield* semaphoreFor(policyLocks, location.canonicalRoot).withPermits(1)(
            Effect.gen(function* () {
              const record = yield* Effect.tryPromise({
                try: () => readStoredIntent(location.file),
                catch: (cause) =>
                  new GameOperationError({
                    operation: "read-verification-policy",
                    path: location.file,
                    reason: "io",
                    cause,
                  }),
              });
              if (record?.verification !== undefined)
                return {
                  policy: record.verification,
                  revision: verificationPolicyRevision(record.verification),
                };
              const observedProbe = yield* Effect.tryPromise({
                try: () => gameTreeOwesProbe(root, manifest.godotProject),
                catch: (cause) =>
                  new GameOperationError({
                    operation: "adopt-verification-policy",
                    path: NodePath.join(root, manifest.godotProject),
                    reason: "io",
                    cause,
                  }),
              });
              const policy = deriveVerificationPolicy(
                manifest,
                record?.probe ?? null,
                observedProbe,
              );
              const documentExists = yield* Effect.promise(() => designDocumentExists(root));
              yield* Effect.tryPromise({
                try: () =>
                  writeIntentRecord(location.file, {
                    schemaVersion: 1,
                    game: location.canonicalRoot,
                    intent: record?.intent ?? adoptedIntent(manifest, documentExists),
                    probe: policy.probe,
                    verification: policy,
                  }),
                catch: (cause) =>
                  new GameOperationError({
                    operation: "adopt-verification-policy",
                    path: location.file,
                    reason: "io",
                    cause,
                  }),
              });
              yield* Effect.logInfo(
                "Adopted the game's verification policy from its creation record, manifest and probe obligation; later manifest edits cannot change it.",
                { file: location.file },
              );
              return { policy, revision: verificationPolicyRevision(policy) };
            }),
          );
        }),
      updatePolicy: (root, policy) =>
        Effect.gen(function* () {
          const location = yield* located(
            options.stateDir,
            root,
            ".intent.json",
            "update-verification-policy",
          );
          return yield* semaphoreFor(policyLocks, location.canonicalRoot).withPermits(1)(
            Effect.gen(function* () {
              const record = yield* Effect.tryPromise({
                try: () => readStoredIntent(location.file),
                catch: (cause) =>
                  new GameOperationError({
                    operation: "update-verification-policy",
                    path: location.file,
                    reason: "io",
                    cause,
                  }),
              });
              if (record === null)
                return yield* new GameOperationError({
                  operation: "update-verification-policy",
                  path: location.file,
                  reason: "invalid-project",
                  detail: "The game has no creation record to carry a verification policy.",
                });
              yield* Effect.tryPromise({
                try: () =>
                  writeIntentRecord(location.file, {
                    ...record,
                    game: location.canonicalRoot,
                    probe: policy.probe,
                    verification: policy,
                  }),
                catch: (cause) =>
                  new GameOperationError({
                    operation: "update-verification-policy",
                    path: location.file,
                    reason: "io",
                    cause,
                  }),
              });
              return { policy, revision: verificationPolicyRevision(policy) };
            }),
          );
        }),
      recordIntent: (root, intent, probe, verification) =>
        Effect.gen(function* () {
          const location = yield* located(options.stateDir, root, ".intent.json", "create-game");
          yield* Effect.tryPromise({
            try: () =>
              writeIntent(location.file, location.canonicalRoot, intent, probe, verification),
            catch: (cause) =>
              new GameOperationError({
                operation: "create-game",
                path: location.file,
                reason: "io",
                cause,
              }),
          });
        }),
      removeIntent: (root) =>
        Effect.gen(function* () {
          const location = yield* located(options.stateDir, root, ".intent.json", "create-game");
          yield* Effect.tryPromise({
            try: () => NodeFSP.rm(location.file, { force: true }),
            catch: (cause) =>
              new GameOperationError({
                operation: "create-game",
                path: location.file,
                reason: "io",
                cause,
              }),
          });
        }),
      status: (root, manifest) =>
        Effect.tryPromise({
          try: () => designRead(options.stateDir, root, manifest),
          catch: (cause) =>
            new GameOperationError({
              operation: "read-design",
              path: root,
              reason: "io",
              cause,
            }),
        }),
      exclusive: (root, effect) =>
        Effect.gen(function* () {
          // The lock is keyed by the real root, so a directory-symlink alias and
          // the real path serialize against each other.
          const location = yield* located(options.stateDir, root, ".json", "approve-design");
          return yield* semaphoreFor(locks, location.canonicalRoot).withPermits(1)(effect);
        }),
      write: (root, record) =>
        Effect.gen(function* () {
          const location = yield* located(options.stateDir, root, ".json", "approve-design");
          yield* Effect.tryPromise({
            try: () => writeRecord(location.file, { ...record, game: location.canonicalRoot }),
            catch: (cause) =>
              new GameOperationError({
                operation: "approve-design",
                path: location.file,
                reason: "io",
                cause,
              }),
          });
        }),
      removeOwned: (root, approvalId) =>
        Effect.gen(function* () {
          const location = yield* located(options.stateDir, root, ".json", "approve-design");
          yield* Effect.tryPromise({
            try: async () => {
              const current = await readDesignApprovalRecord(location.file);
              if (current === null || current.approvalId !== approvalId) return;
              await NodeFSP.rm(location.file, { force: true });
            },
            catch: (cause) =>
              new GameOperationError({
                operation: "approve-design",
                path: location.file,
                reason: "io",
                cause,
              }),
          });
        }),
      readRevision: (root) =>
        Effect.gen(function* () {
          const location = yield* located(options.stateDir, root, ".revision.json", "read-design");
          return yield* Effect.tryPromise({
            try: () => readPendingRevision(location.file),
            catch: (cause) =>
              new GameOperationError({
                operation: "read-design",
                path: location.file,
                reason: "io",
                cause,
              }),
          });
        }),
      writeRevision: (root, revision) =>
        Effect.gen(function* () {
          const location = yield* located(
            options.stateDir,
            root,
            ".revision.json",
            "request-change",
          );
          yield* Effect.tryPromise({
            try: () => writePendingRevision(location.file, location.canonicalRoot, revision),
            catch: (cause) =>
              new GameOperationError({
                operation: "request-change",
                path: location.file,
                reason: "io",
                cause,
              }),
          });
        }),
      removeRevision: (root) =>
        Effect.gen(function* () {
          const location = yield* located(
            options.stateDir,
            root,
            ".revision.json",
            "request-change",
          );
          yield* Effect.tryPromise({
            try: () => NodeFSP.rm(location.file, { force: true }),
            catch: (cause) =>
              new GameOperationError({
                operation: "request-change",
                path: location.file,
                reason: "io",
                cause,
              }),
          });
        }),
    }),
  );
};

/**
 * Exposed for tests and diagnostics; the hash keeps game names off the state
 * path. A symlinked root must go through the service, which resolves realpath.
 */
export const approvalRecordFile = (stateDir: string, root: string) => recordPath(stateDir, root);
export const designIntentFile = (stateDir: string, root: string) => intentPath(stateDir, root);
/** Exposed for tests and diagnostics; same routing rules as the approval record. */
export const pendingRevisionFile = (stateDir: string, root: string) => revisionPath(stateDir, root);
