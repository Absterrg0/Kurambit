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

const recordPath = (stateDir: string, root: string) => {
  const normalised = NodePath.resolve(root);
  const digest = NodeCrypto.createHash("sha256").update(normalised).digest("hex").slice(0, 32);
  return NodePath.join(stateDir, "game-design", `${digest}.json`);
};

export const readDesignApprovalRecord = async (
  file: string,
): Promise<DesignApprovalRecord | null> => {
  try {
    return decodeStoredRecord(await NodeFSP.readFile(file, "utf8"));
  } catch {
    // A record that cannot be read proves nothing; it must never become a pass.
    return null;
  }
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

/**
 * The approval lifecycle. A game with no record is a draft while it still has a
 * DESIGN.md to review; only a game that never had one (pre-design or
 * skip-planning) is legacy. A creator or agent editing game.json to "approved"
 * therefore cannot pass a plan-first game.
 */
const deriveDesignState = (input: {
  readonly record: DesignApprovalRecord | null;
  readonly currentHash: string | null;
  readonly manifestDesign: GameManifest["design"];
  readonly documentExists: boolean;
}): GameDesignState => {
  if (input.record !== null)
    return input.currentHash !== null && input.currentHash === input.record.designHash
      ? "approved"
      : "changed";
  if (input.manifestDesign === undefined) return "legacy";
  if (input.manifestDesign.status === "draft") return "draft";
  return input.documentExists ? "draft" : "legacy";
};

const designRead = async (
  stateDir: string,
  root: string,
  manifest: GameManifest,
): Promise<GameDesignRead> => {
  const record = await readDesignApprovalRecord(recordPath(stateDir, root));
  const design = await readDesignDocument(root);
  const currentHash = design === null ? null : designDocumentHash(design);
  const exists = design === null ? await designDocumentExists(root) : true;
  const state = deriveDesignState({
    record,
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
    readonly read: (root: string) => Effect.Effect<DesignApprovalRecord | null>;
    /** The server-owned lifecycle plus what still blocks approval. */
    readonly status: (root: string, manifest: GameManifest) => Effect.Effect<GameDesignRead>;
    /**
     * Serializes one design operation per game. Approval has to cover read,
     * validate, write and dispatch as one unit, not just the manifest write, or
     * two creators can each dispatch a build turn.
     */
    readonly exclusive: <A, E, R>(
      root: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
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
        Effect.promise(() => readDesignApprovalRecord(recordPath(options.stateDir, root))),
      status: (root, manifest) =>
        Effect.promise(() => designRead(options.stateDir, root, manifest)),
      exclusive: (root, effect) =>
        Effect.gen(function* () {
          const key = NodePath.resolve(root);
          let lock = locks.get(key);
          if (lock === undefined) {
            // Creating the lock is synchronous, so two callers cannot both
            // install a different semaphore for the same game.
            lock = Semaphore.makeUnsafe(1);
            locks.set(key, lock);
          }
          return yield* lock.withPermits(1)(effect);
        }),
      write: (root, record) => {
        const file = recordPath(options.stateDir, root);
        return Effect.tryPromise({
          try: () => writeRecord(file, record),
          catch: (cause) =>
            new GameOperationError({
              operation: "approve-design",
              path: file,
              reason: "io",
              cause,
            }),
        });
      },
      removeOwned: (root, approvalId) => {
        const file = recordPath(options.stateDir, root);
        return Effect.tryPromise({
          try: async () => {
            const current = await readDesignApprovalRecord(file);
            if (current === null || current.approvalId !== approvalId) return;
            await NodeFSP.rm(file, { force: true });
          },
          catch: (cause) =>
            new GameOperationError({
              operation: "approve-design",
              path: file,
              reason: "io",
              cause,
            }),
        });
      },
    }),
  );
};

/** Exposed for tests and diagnostics; the hash keeps game names off the state path. */
export const approvalRecordFile = (stateDir: string, root: string) => recordPath(stateDir, root);
