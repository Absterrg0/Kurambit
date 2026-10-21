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
  GameAcceptanceCriterion,
  GameOperationError,
  type GameDesignRead,
  type GameDesignState,
  type GameManifest,
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
}
/**
 * What the server promised at creation: a plan-first game owes a reviewable
 * DESIGN.md, a skip-planning game explicitly skips it. Written once, outside the
 * workspace, so deleting DESIGN.md or editing game.json cannot turn a plan-first
 * game into a legacy one.
 */
export type GameDesignIntent = "required" | "skipped";
interface DesignIntentRecord {
  readonly schemaVersion: 1;
  readonly game: string;
  readonly intent: GameDesignIntent;
  /**
   * The starter template shipped the StudioProbe, so this game owes a state
   * probe. It lives here rather than only in game.json because an agent can edit
   * that file, and deleting the probe must not silently weaken the playtest.
   */
  readonly probe?: boolean;
}
const StoredIntent = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    game: Schema.String,
    intent: Schema.Literals(["required", "skipped"]),
    probe: Schema.optionalKey(Schema.Boolean),
  }),
);
const decodeStoredIntent = Schema.decodeUnknownSync(StoredIntent);
const StoredRecord = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    game: Schema.String,
    approvalId: Schema.String,
    designHash: Schema.String,
    approvedAt: Schema.String,
    acceptance: Schema.Array(GameAcceptanceCriterion),
  }),
);
const decodeStoredRecord = Schema.decodeUnknownSync(StoredRecord);

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

/**
 * The record's real location. Records written before roots were canonical live
 * under the lexical key; migrate one before the read so an alias and the real
 * root share one record from then on.
 */
const prepareLocation = async (
  stateDir: string,
  root: string,
  extension: ".json" | ".intent.json",
): Promise<GameRecordLocation> => {
  const location = await gameRecordLocation(stateDir, "game-design", root, extension);
  await migrateGameRecord(location);
  return location;
};
const located = (
  stateDir: string,
  root: string,
  extension: ".json" | ".intent.json",
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
  return text === null ? null : decodeStoredRecord(text);
};

export const readDesignIntent = async (file: string): Promise<GameDesignIntent | null> => {
  const text = await readRecordText(file);
  return text === null ? null : decodeStoredIntent(text).intent;
};

/** Whether the game was created from a template that ships the StudioProbe. */
export const readProbeIntent = async (file: string): Promise<boolean | null> => {
  const text = await readRecordText(file);
  return text === null ? null : (decodeStoredIntent(text).probe ?? null);
};

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

const writeIntent = async (
  file: string,
  game: string,
  intent: GameDesignIntent,
  probe: boolean | undefined,
) => {
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  try {
    const record: DesignIntentRecord = {
      schemaVersion: 1,
      game,
      intent,
      ...(probe === undefined ? {} : { probe }),
    };
    await NodeFSP.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    await NodeFSP.rename(temporary, file);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
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
}): GameDesignState => {
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
  const [approvalLocation, intentLocation] = await Promise.all([
    prepareLocation(stateDir, root, ".json"),
    prepareLocation(stateDir, root, ".intent.json"),
  ]);
  const record = await readDesignApprovalRecord(approvalLocation.file);
  const intent = await readDesignIntent(intentLocation.file);
  const design = await readDesignDocument(root);
  const currentHash = design === null ? null : designDocumentHash(design);
  const exists = design === null ? await designDocumentExists(root) : true;
  const state = deriveDesignState({
    record,
    intent,
    currentHash,
    manifestDesign: manifest.design,
    documentExists: exists,
  });
  const validation =
    state === "approved" || state === "legacy"
      ? { issues: [], acceptance: [] }
      : validateDesignDocument({
          design,
          skeleton: designSkeleton(manifest.name),
        });
  // Show the criteria the document currently carries so the creator can review
  // them before approving. When an edit leaves the document invalid, fall back
  // to the last approved set rather than hiding what was agreed.
  const currentAcceptance = validation.acceptance;
  return {
    state,
    approvedHash: record?.designHash ?? null,
    currentHash,
    approvedAt: record?.approvedAt ?? null,
    acceptance: [
      ...(currentAcceptance.length > 0 ? currentAcceptance : (record?.acceptance ?? [])),
    ],
    issues: [...validation.issues],
  };
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
    ) => Effect.Effect<void, GameOperationError>;
    /** Removes the intent this creation attempt wrote; never another game's record. */
    readonly removeIntent: (root: string) => Effect.Effect<void, GameOperationError>;
    /** The creation-time probe obligation, or null for games with no record. */
    readonly readProbe: (root: string) => Effect.Effect<boolean | null, GameOperationError>;
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
  }
>()("t3/game/GameDesignApproval") {}

export const layer = (options: { readonly stateDir: string }) => {
  const locks = new Map<string, Semaphore.Semaphore>();
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
      recordIntent: (root, intent, probe) =>
        Effect.gen(function* () {
          const location = yield* located(options.stateDir, root, ".intent.json", "create-game");
          yield* Effect.tryPromise({
            try: () => writeIntent(location.file, location.canonicalRoot, intent, probe),
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
          const key = location.canonicalRoot;
          let lock = locks.get(key);
          if (lock === undefined) {
            // Creating the lock is synchronous, so two callers cannot both
            // install a different semaphore for the same game.
            lock = Semaphore.makeUnsafe(1);
            locks.set(key, lock);
          }
          return yield* lock.withPermits(1)(effect);
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
    }),
  );
};

/**
 * Exposed for tests and diagnostics; the hash keeps game names off the state
 * path. A symlinked root must go through the service, which resolves realpath.
 */
export const approvalRecordFile = (stateDir: string, root: string) => recordPath(stateDir, root);
export const designIntentFile = (stateDir: string, root: string) => intentPath(stateDir, root);
