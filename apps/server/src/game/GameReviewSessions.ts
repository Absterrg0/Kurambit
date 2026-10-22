// @effect-diagnostics nodeBuiltinImport:off -- Evidence directories and session records live on the native filesystem outside the game.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CommandId,
  GAME_REVIEW_ANSWER_MAX_BYTES,
  GameOperationError,
  GameReviewBallotAnswer,
  GameReviewCriticAnswer,
  type GameReviewDefect,
  type GameReviewDoNotRegress,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2Run,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  ProviderOptionSelections,
  type RunId,
  type RuntimeMode,
  type ThreadId,
  ThreadId as ThreadIdSchema,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import { gameRecordFile, realGameRoot } from "./gameRecord.ts";
import { builderFixPrompt, criticPrompt, pairwisePrompt } from "./gameReviewPrompts.ts";

/**
 * Which models a review can run on. The catalog is the provider registry
 * reduced to the one question a review session asks: is this exact instance and
 * model live right now? An unavailable answer is final; the session service
 * never substitutes another model.
 */
export class GameReviewProviderCatalog extends Context.Service<
  GameReviewProviderCatalog,
  {
    readonly available: (selection: ModelSelection) => Effect.Effect<boolean>;
  }
>()("t3/game/GameReviewSessions/GameReviewProviderCatalog") {}

export interface GameReviewFrameInput {
  /** The source frame's id, kept outside the child's directory. */
  readonly id: string;
  /** What the child sees, e.g. "A: boot". Never a build id or artifact path. */
  readonly label: string;
  /** PNG bytes to copy into the evidence directory. */
  readonly sourcePath: string;
}

export interface GameReviewCheckInput {
  readonly id: string;
  readonly status: "passed" | "failed" | "unmeasured";
  readonly detail?: string;
}

export interface GameReviewEvidenceInput {
  readonly frames: ReadonlyArray<GameReviewFrameInput>;
  readonly checks: ReadonlyArray<GameReviewCheckInput>;
}

export interface GameReviewRepairInput {
  /** Human-readable spend, e.g. "2 repairs and 14 minutes left". */
  readonly remainingBudget: string;
  readonly defects: ReadonlyArray<GameReviewDefect>;
  readonly doNotRegress: ReadonlyArray<GameReviewDoNotRegress>;
}

export type GameReviewTaskRole = "critic" | "ballot" | "repair";

export interface GameReviewSessionStartInput {
  readonly threadId: ThreadId;
  readonly loopId: string;
  readonly roundId: string;
  readonly role: GameReviewTaskRole;
  /** Ballot order within the round; critic and repair use 0. */
  readonly order?: number;
  readonly evidence?: GameReviewEvidenceInput;
  readonly repair?: GameReviewRepairInput;
  /** Preservation items a ballot must judge; the critic's answer is their source. */
  readonly items?: ReadonlyArray<{ readonly id: string; readonly what: string }>;
  /**
   * Review-role override chosen from the provider catalog. Ignored for repair,
   * and ignored after the round has frozen its review selection.
   */
  readonly selection?: ModelSelection;
  /** The originating builder run; defaults to the thread's latest completed run. */
  readonly runId?: RunId;
  readonly nodeId?: NodeId;
}

export type GameReviewSessionStartResult =
  | {
      readonly kind: "started";
      readonly commandId: string;
      readonly childThreadId: ThreadId;
      readonly taskId: NodeId | null;
      readonly evidenceHash: string | null;
      /** True when a receipt/record already existed and nothing was dispatched. */
      readonly reconciled: boolean;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface GameReviewSessionAnswerInput {
  readonly threadId: ThreadId;
  readonly loopId: string;
  readonly roundId: string;
  readonly role: GameReviewTaskRole;
  readonly order?: number;
}

export type GameReviewSessionAnswerResult =
  | { readonly kind: "critic"; readonly answer: GameReviewCriticAnswer; readonly raw: string }
  | { readonly kind: "ballot"; readonly answer: GameReviewBallotAnswer; readonly raw: string }
  /** The child has not produced a terminal answer yet. */
  | { readonly kind: "pending" }
  | { readonly kind: "invalid"; readonly reason: string; readonly raw: string | null };

interface SessionKey {
  readonly loopId: string;
  readonly roundId: string;
  readonly role: GameReviewTaskRole;
  readonly order: number;
}

const FRAME_FILE = (index: number) => `frames/frame-${String(index + 1).padStart(2, "0")}.png`;
const EVIDENCE_MANIFEST = "evidence.json";
const BRIEF_FILE = "BRIEF.md";
const MAX_FRAMES = 12;
const MAX_CHECKS = 64;

const ReviewFrameRecord = Schema.Struct({
  /** The manifest id the child cites: f1, f2, ... */
  id: Schema.String,
  file: Schema.String,
  sourceId: Schema.String,
  label: Schema.String,
});
const ReviewCheckRecord = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["passed", "failed", "unmeasured"]),
  detail: Schema.optionalKey(Schema.String),
});
const ReviewEvidenceRecord = Schema.Struct({
  frames: Schema.Array(ReviewFrameRecord),
  checks: Schema.Array(ReviewCheckRecord),
});
type ReviewEvidenceRecordType = typeof ReviewEvidenceRecord.Type;

const ReviewSelectionRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  instanceId: Schema.String,
  model: Schema.String,
  options: Schema.optionalKey(ProviderOptionSelections),
});
type ReviewSelectionRecordType = typeof ReviewSelectionRecord.Type;

const ReviewSessionRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  loopId: Schema.String,
  roundId: Schema.String,
  role: Schema.Literals(["critic", "ballot", "repair"]),
  order: Schema.Number,
  commandId: Schema.String,
  childThreadId: Schema.String,
  taskId: Schema.NullOr(Schema.String),
  selection: ReviewSelectionRecord,
  evidenceDirectory: Schema.NullOr(Schema.String),
  evidenceHash: Schema.NullOr(Schema.String),
  evidence: Schema.NullOr(ReviewEvidenceRecord),
  itemIds: Schema.Array(Schema.String),
  startedAt: Schema.String,
});
type ReviewSessionRecordType = typeof ReviewSessionRecord.Type;

const decodeSessionRecord = Schema.decodeUnknownSync(ReviewSessionRecord);
const decodeSelectionRecord = Schema.decodeUnknownSync(ReviewSelectionRecord);

const isGameOperationError = Schema.is(GameOperationError);

const failure = (
  operation: string,
  path: string,
  reason: GameOperationError["reason"],
  detail?: string,
  cause?: unknown,
) =>
  new GameOperationError({
    operation,
    path,
    reason,
    ...(detail === undefined ? {} : { detail }),
    ...(cause === undefined ? {} : { cause }),
  });

const attempt = <A>(operation: string, path: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      isGameOperationError(cause) ? cause : failure(operation, path, "io", undefined, cause),
  });

/** Ids are encoded so a colon inside a caller's id cannot forge another order. */
const encodePart = (value: string) => encodeURIComponent(value);

/**
 * The command id is the idempotency key. It names the loop, round, role and
 * order, so a restart that replays the same logical session can never create a
 * second child or a second model call.
 */
export const gameReviewCommandId = (input: {
  readonly loopId: string;
  readonly roundId: string;
  readonly role: GameReviewTaskRole;
  readonly order: number;
}) =>
  CommandId.make(
    `game-round-task:${encodePart(input.loopId)}:${encodePart(input.roundId)}:${input.role}:${input.order}`,
  );

/** SHA-256 over the evidence tree's sorted paths and exact bytes. */
export const hashEvidenceDirectory = async (directory: string): Promise<string> => {
  const files: string[] = [];
  const stack = [""];
  while (stack.length > 0) {
    const relative = stack.pop()!;
    for (const entry of await NodeFSP.readdir(NodePath.join(directory, relative), {
      withFileTypes: true,
    })) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) files.push(child);
      // A symlink or special file is not evidence; refusing it keeps the hash
      // honest about what the child can actually read.
      else throw new Error(`Evidence contains a non-file entry: ${child}`);
    }
  }
  const hash = NodeCrypto.createHash("sha256");
  for (const file of files.sort()) {
    hash.update(file);
    hash.update("\0");
    hash.update(await NodeFSP.readFile(NodePath.join(directory, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const briefFromManifest = (brief: string, artDirection: string): string =>
  [brief.trim(), artDirection.trim() === "" ? "" : `Art direction: ${artDirection.trim()}`]
    .filter((part) => part !== "")
    .join("\n\n");

/**
 * Writes the only content a review child may see: the brief, the anonymous
 * frames with manifest ids, and the normalized checks. Source, AGENTS.md,
 * notes and build ids are never copied. Returns the stored manifest and hash.
 */
const writeEvidenceDirectory = async (input: {
  readonly directory: string;
  readonly brief: string;
  readonly frames: ReadonlyArray<GameReviewFrameInput>;
  readonly checks: ReadonlyArray<GameReviewCheckInput>;
}): Promise<{ evidence: ReviewEvidenceRecordType; hash: string }> => {
  await NodeFSP.rm(input.directory, { recursive: true, force: true });
  await NodeFSP.mkdir(NodePath.join(input.directory, "frames"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(input.directory, BRIEF_FILE), `${input.brief.trimEnd()}\n`);
  const checks = input.checks
    .map((check) => ({
      id: check.id,
      status: check.status,
      ...(check.detail === undefined ? {} : { detail: check.detail }),
    }))
    .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const frames = input.frames.map((frame, index) => ({
    id: `f${index + 1}`,
    file: FRAME_FILE(index),
    sourceId: frame.id,
    label: frame.label,
  }));
  for (const [index, frame] of input.frames.entries()) {
    await NodeFSP.copyFile(frame.sourcePath, NodePath.join(input.directory, FRAME_FILE(index)));
  }
  const evidence: ReviewEvidenceRecordType = { frames, checks };
  await NodeFSP.writeFile(
    NodePath.join(input.directory, EVIDENCE_MANIFEST),
    `${JSON.stringify(
      { frames: frames.map((frame) => ({ id: frame.id, file: frame.file })), checks },
      null,
      2,
    )}\n`,
  );
  return { evidence, hash: await hashEvidenceDirectory(input.directory) };
};

const writeJsonAtomic = async (file: string, value: unknown): Promise<void> => {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${NodeCrypto.randomUUID()}`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await NodeFSP.rename(temporary, file);
};

const readJson = async (file: string): Promise<unknown | null> => {
  let text: string;
  try {
    text = await NodeFSP.readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
  return JSON.parse(text) as unknown;
};

interface AnswerParseFailure {
  readonly kind: "invalid";
  readonly reason: string;
}
interface AnswerParseSuccess<A> {
  readonly kind: "valid";
  readonly answer: A;
}
export type ParsedAnswer<A> = AnswerParseSuccess<A> | AnswerParseFailure;

/**
 * One JSON object, no prose, at most 16 KiB. Excess keys are errors, not
 * ignored fields: an answer that carries extra data is not the schema the loop
 * asked for.
 */
const parseAnswerText = (text: string): { kind: "parsed"; value: unknown } | AnswerParseFailure => {
  if (Buffer.byteLength(text, "utf8") > GAME_REVIEW_ANSWER_MAX_BYTES)
    return { kind: "invalid", reason: "The answer is larger than 16 KiB." };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "invalid", reason: "The answer is empty." };
  try {
    return { kind: "parsed", value: JSON.parse(trimmed) as unknown };
  } catch {
    return { kind: "invalid", reason: "The answer is not one JSON object." };
  }
};

const decodeStrict = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  label: string,
): ParsedAnswer<S["Type"]> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { kind: "invalid", reason: `The ${label} answer is not a JSON object.` };
  try {
    return {
      kind: "valid",
      answer: Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value),
    };
  } catch (cause) {
    const first = String(cause instanceof Error ? cause.message : cause).split("\n")[0]!;
    return { kind: "invalid", reason: `The ${label} answer does not match its schema: ${first}` };
  }
};

export interface CriticAnswerKnownIds {
  readonly frameIds: ReadonlySet<string>;
  readonly checkIds: ReadonlySet<string>;
}

/** Strict critic parsing: one object, known frame/check ids only, bounded lists. */
export const parseCriticAnswer = (
  text: string,
  known: CriticAnswerKnownIds,
): ParsedAnswer<GameReviewCriticAnswer> => {
  const parsed = parseAnswerText(text);
  if (parsed.kind === "invalid") return parsed;
  const decoded = decodeStrict(GameReviewCriticAnswer, parsed.value, "critic");
  if (decoded.kind === "invalid") return decoded;
  const answer = decoded.answer;
  const seenIds = new Set<string>();
  for (const defect of answer.defects) {
    if (!known.frameIds.has(defect.frameId))
      return {
        kind: "invalid",
        reason: `The critic cited frame ${defect.frameId}, which is not in its manifest.`,
      };
  }
  for (const item of answer.doNotRegress) {
    if (!known.frameIds.has(item.frameId))
      return {
        kind: "invalid",
        reason: `The critic cited frame ${item.frameId}, which is not in its manifest.`,
      };
    if (item.checkId !== undefined && !known.checkIds.has(item.checkId))
      return {
        kind: "invalid",
        reason: `The critic cited check ${item.checkId}, which was not measured.`,
      };
    if (seenIds.has(item.id))
      return { kind: "invalid", reason: `The critic reused preservation id ${item.id}.` };
    seenIds.add(item.id);
  }
  return { kind: "valid", answer };
};

export interface BallotAnswerKnownIds {
  readonly frameIds: ReadonlySet<string>;
  readonly itemIds: ReadonlyArray<string>;
}

/** Strict ballot parsing: complete item coverage, known frames, no extras. */
export const parseBallotAnswer = (
  text: string,
  known: BallotAnswerKnownIds,
): ParsedAnswer<GameReviewBallotAnswer> => {
  const parsed = parseAnswerText(text);
  if (parsed.kind === "invalid") return parsed;
  const decoded = decodeStrict(GameReviewBallotAnswer, parsed.value, "ballot");
  if (decoded.kind === "invalid") return decoded;
  const answer = decoded.answer;
  const expected = new Set(known.itemIds);
  const seen = new Set<string>();
  for (const entry of answer.preservation) {
    if (!expected.has(entry.id))
      return {
        kind: "invalid",
        reason: `The ballot judged unknown preservation item ${entry.id}.`,
      };
    if (seen.has(entry.id))
      return { kind: "invalid", reason: `The ballot judged item ${entry.id} twice.` };
    seen.add(entry.id);
    for (const frameId of entry.frameIds) {
      if (!known.frameIds.has(frameId))
        return {
          kind: "invalid",
          reason: `The ballot cited frame ${frameId}, which is not in its manifest.`,
        };
    }
  }
  const missing = known.itemIds.filter((id) => !seen.has(id));
  if (missing.length > 0)
    return {
      kind: "invalid",
      reason: `The ballot did not judge preservation items: ${missing.join(", ")}.`,
    };
  return { kind: "valid", answer };
};

const selectionRecord = (selection: ModelSelection): ReviewSelectionRecordType => ({
  schemaVersion: 1,
  instanceId: selection.instanceId,
  model: selection.model,
  ...(selection.options === undefined ? {} : { options: selection.options }),
});

const toSelection = (record: ReviewSelectionRecordType): ModelSelection => ({
  instanceId: record.instanceId as ProviderInstanceId,
  model: record.model,
  ...(record.options === undefined ? {} : { options: record.options }),
});

export class GameReviewSessions extends Context.Service<
  GameReviewSessions,
  {
    /**
     * Creates (or reconciles) one review child. The child is fresh: no parent
     * messages, summaries or provider conversation are copied. Critic and
     * ballot children run in their evidence directory; a repair child runs in
     * the game folder and is the only writable role.
     */
    readonly start: (
      input: GameReviewSessionStartInput,
    ) => Effect.Effect<GameReviewSessionStartResult, GameOperationError>;
    /** Reads and strictly validates the child's terminal answer. */
    readonly answer: (
      input: GameReviewSessionAnswerInput,
    ) => Effect.Effect<GameReviewSessionAnswerResult, GameOperationError>;
    /** The evidence directory one review child runs in, when it has one. */
    readonly evidenceDirectory: (input: {
      readonly threadId: ThreadId;
      readonly loopId: string;
      readonly roundId: string;
      readonly role: GameReviewTaskRole;
      readonly order?: number;
    }) => Effect.Effect<string | null, GameOperationError>;
    /** Hashes the evidence directory now; null for a repair session. */
    readonly evidenceHash: (
      input: GameReviewSessionAnswerInput,
    ) => Effect.Effect<string | null, GameOperationError>;
  }
>()("t3/game/GameReviewSessions") {}

const threadFailure = (operation: string, path: string, cause: unknown) =>
  failure(operation, path, "thread-dispatch", String(cause), cause);

export const layer = (options: { readonly stateDir: string }) => {
  const make = Effect.gen(function* () {
    const projects = yield* GameProjectService.GameProjectService;
    const rounds = yield* GameRoundStore.GameRoundStore;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const catalog = yield* GameReviewProviderCatalog;

    const reviewRoot = Effect.fnUntraced(function* (root: string) {
      const canonical = yield* attempt("game review", root, () => realGameRoot(root));
      return gameRecordFile(options.stateDir, "game-review-sessions", canonical, "");
    });

    const recordFile = Effect.fnUntraced(function* (root: string, key: SessionKey) {
      const directory = yield* reviewRoot(root);
      return NodePath.join(
        directory,
        encodePart(key.loopId),
        encodePart(key.roundId),
        `${key.role}-${key.order}`,
        "session.json",
      );
    });

    const roundSelectionFile = Effect.fnUntraced(function* (root: string, roundId: string) {
      return NodePath.join(yield* reviewRoot(root), "rounds", `${encodePart(roundId)}.json`);
    });

    const readRecord = Effect.fnUntraced(function* (root: string, key: SessionKey) {
      const file = yield* recordFile(root, key);
      const value = yield* attempt("read game review session", file, () => readJson(file));
      if (value === null) return null;
      return yield* Effect.try({
        try: () => decodeSessionRecord(value),
        catch: (cause) =>
          failure(
            "read game review session",
            file,
            "io",
            "The session record is unreadable.",
            cause,
          ),
      });
    });

    const writeRecord = Effect.fnUntraced(function* (
      root: string,
      key: SessionKey,
      record: ReviewSessionRecordType,
    ) {
      const file = yield* recordFile(root, key);
      yield* attempt("write game review session", file, () => writeJsonAtomic(file, record));
    });

    const readRoundSelection = Effect.fnUntraced(function* (root: string, roundId: string) {
      const file = yield* roundSelectionFile(root, roundId);
      const value = yield* attempt("read game review selection", file, () => readJson(file));
      if (value === null) return null;
      return yield* Effect.try({
        try: () => toSelection(decodeSelectionRecord(value)),
        catch: (cause) =>
          failure(
            "read game review selection",
            file,
            "io",
            "The frozen review selection is unreadable.",
            cause,
          ),
      });
    });

    const writeRoundSelection = Effect.fnUntraced(function* (
      root: string,
      roundId: string,
      selection: ModelSelection,
    ) {
      const file = yield* roundSelectionFile(root, roundId);
      yield* attempt("write game review selection", file, () =>
        writeJsonAtomic(file, selectionRecord(selection)),
      );
    });

    /**
     * The thread's own facts plus the run the round reviews: the newest
     * completed run with a root node. One read serves both, so a child cannot
     * be built from a selection the origin read disagrees with.
     */
    const resolveOrigin = Effect.fnUntraced(function* (
      threadId: ThreadId,
      explicit?: { readonly runId?: RunId; readonly nodeId?: NodeId },
    ) {
      const records = yield* threads
        .getThreadRecords(threadId, ["runs"])
        .pipe(Effect.mapError((cause) => threadFailure("resolve-origin", threadId, cause)));
      if (records.thread.deletedAt !== null)
        return yield* failure("resolve-thread", threadId, "project-not-found");
      const completed = records.runs
        .filter((run) => run.status === "completed" && run.rootNodeId !== null)
        .toSorted((left, right) => right.ordinal - left.ordinal);
      const run =
        explicit?.runId === undefined
          ? completed[0]
          : completed.find((candidate) => candidate.id === explicit.runId);
      if (run === undefined || run.rootNodeId === null)
        return yield* failure(
          "resolve-origin",
          threadId,
          "invalid-input",
          "A review needs a completed builder run in this thread.",
        );
      const nodeId = explicit?.nodeId ?? run.rootNodeId;
      if (nodeId !== run.rootNodeId)
        return yield* failure(
          "resolve-origin",
          threadId,
          "invalid-input",
          "The originating node must be the completed run's root node.",
        );
      return { thread: records.thread, run, nodeId };
    });

    const liveRound = Effect.fnUntraced(function* (root: string, roundId: string) {
      const state = yield* rounds.read(root);
      const round = state.rounds.find((entry) => entry.id === roundId);
      if (round === undefined)
        return yield* failure(
          "start game review",
          root,
          "invalid-input",
          "That round is not recorded.",
        );
      if (round.status !== "running")
        return yield* failure(
          "start game review",
          root,
          "invalid-input",
          "That review round is no longer running.",
        );
      return round;
    });

    /**
     * Reconciles a committed session without dispatching. The record is the
     * primary source; a crash between dispatch and the record write leaves the
     * child thread id derivable from the same command id the Orchestrator used.
     */
    const reconcile = Effect.fnUntraced(function* (
      root: string,
      key: SessionKey,
      commandId: CommandId,
      existing: ReviewSessionRecordType | null,
    ) {
      const childThreadId =
        existing === null
          ? IdAllocator.derive.delegatedTaskThread({ commandId })
          : ThreadIdSchema.make(existing.childThreadId);
      const taskId =
        existing === null
          ? IdAllocator.derive.delegatedTaskNode({ commandId })
          : existing.taskId === null
            ? null
            : (existing.taskId as NodeId);
      const evidenceDirectory = existing?.evidenceDirectory ?? null;
      const evidenceHash =
        evidenceDirectory === null
          ? null
          : yield* attempt("hash game review evidence", evidenceDirectory, () =>
              hashEvidenceDirectory(evidenceDirectory),
            ).pipe(Effect.orElseSucceed(() => null));
      return {
        kind: "started",
        commandId,
        childThreadId,
        taskId,
        evidenceHash,
        reconciled: true,
      } satisfies GameReviewSessionStartResult;
    });

    const start: GameReviewSessions["Service"]["start"] = (input) =>
      Effect.gen(function* () {
        const order = input.order ?? 0;
        if (!Number.isInteger(order) || order < 0 || order > 1)
          return yield* failure(
            "start game review",
            input.loopId,
            "invalid-input",
            "A review order is 0 or 1.",
          );
        const key: SessionKey = {
          loopId: input.loopId,
          roundId: input.roundId,
          role: input.role,
          order,
        };
        const commandId = gameReviewCommandId(key);
        const root = yield* projects.resolve(input.threadId);
        yield* liveRound(root, input.roundId);

        // Reconcile first: a committed session must never dispatch again, even
        // after a restart, so no second model call can start. The record is the
        // normal path; a receipt without a record is the narrow crash window
        // between dispatch and the record write.
        const existing = yield* readRecord(root, key);
        if (existing !== null) return yield* reconcile(root, key, commandId, existing);
        if (yield* threads.hasReceipt(commandId))
          return yield* reconcile(root, key, commandId, null);

        const manifest = yield* projects.read(root);
        const origin = yield* resolveOrigin(input.threadId, {
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
        });
        const builderSelection: ModelSelection = origin.thread.modelSelection;
        const frozen = yield* readRoundSelection(root, input.roundId);
        const selection =
          input.role === "repair"
            ? // Repairs keep the builder's selection; a review override never
              // changes who repairs.
              builderSelection
            : (frozen ?? input.selection ?? builderSelection);
        if (!(yield* catalog.available(selection)))
          return {
            kind: "unavailable",
            reason: `The review model ${selection.instanceId}/${selection.model} is not available.`,
          } satisfies GameReviewSessionStartResult;

        const briefFile = yield* attempt("read game brief", root, () =>
          NodeFSP.readFile(NodePath.join(root, "BRIEF.md"), "utf8"),
        ).pipe(Effect.orElseSucceed(() => ""));
        const brief =
          briefFile.trim() === ""
            ? briefFromManifest(manifest.brief, manifest.artDirection)
            : briefFile;

        let evidence: ReviewEvidenceRecordType | null = null;
        let evidenceDirectory: string | null = null;
        let evidenceHash: string | null = null;
        if (input.role !== "repair") {
          if (input.evidence === undefined)
            return yield* failure(
              "start game review",
              root,
              "invalid-input",
              "A critic or ballot needs frames and checks.",
            );
          if (input.evidence.frames.length > MAX_FRAMES)
            return yield* failure(
              "start game review",
              root,
              "invalid-input",
              `At most ${MAX_FRAMES} frames are evidence.`,
            );
          if (input.evidence.checks.length > MAX_CHECKS)
            return yield* failure(
              "start game review",
              root,
              "invalid-input",
              `At most ${MAX_CHECKS} checks are evidence.`,
            );
          const recordPath = yield* recordFile(root, key);
          evidenceDirectory = NodePath.join(NodePath.dirname(recordPath), "evidence");
          const written = yield* attempt("write game review evidence", evidenceDirectory, () =>
            writeEvidenceDirectory({
              directory: evidenceDirectory!,
              brief,
              frames: input.evidence!.frames,
              checks: input.evidence!.checks,
            }),
          );
          evidence = written.evidence;
          evidenceHash = written.hash;
        }

        const files = [
          { path: BRIEF_FILE, label: "brief and art direction" },
          ...(evidence?.frames.map((frame) => ({
            path: frame.file,
            label: `${frame.id}: ${frame.label}`,
          })) ?? []),
          ...(evidence === null ? [] : [{ path: EVIDENCE_MANIFEST, label: "normalized checks" }]),
        ];
        const task =
          input.role === "critic"
            ? criticPrompt(files)
            : input.role === "ballot"
              ? pairwisePrompt({ files, items: input.items ?? [] })
              : builderFixPrompt({
                  remainingBudget: input.repair?.remainingBudget ?? "the remaining round budget",
                  brief,
                  defects: input.repair?.defects ?? [],
                  doNotRegress: input.repair?.doNotRegress ?? [],
                });

        // Freeze the round's review selection before dispatch: every later
        // review child of this round must match, whatever the thread or caller
        // does meanwhile.
        if (input.role !== "repair" && frozen === null)
          yield* writeRoundSelection(root, input.roundId, selection);

        const command = {
          type: "game-round.task.request",
          createdBy: "system",
          creationSource: "server",
          commandId,
          originatingThreadId: input.threadId,
          originatingRunId: origin.run.id,
          originatingNodeId: origin.nodeId,
          loopId: input.loopId,
          roundId: input.roundId,
          role: input.role,
          order,
          task,
          title:
            input.role === "critic"
              ? "Game review: critic"
              : input.role === "ballot"
                ? "Game review: ballot"
                : "Game review: repair",
          modelSelection: selection,
          runtimeMode: origin.thread.runtimeMode as RuntimeMode,
          interactionMode: origin.thread.interactionMode as ProviderInteractionMode,
          evidenceDirectory,
        } as const;
        yield* threads
          .dispatch(command)
          .pipe(Effect.mapError((cause) => threadFailure("start game review", root, cause)));
        // The Orchestrator derives the child ids from this command id; the same
        // derivation here is what lets a restart find the child without a
        // second dispatch. The delegation test pins the two derivations together.
        const childThreadId = IdAllocator.derive.delegatedTaskThread({ commandId });
        const taskId = IdAllocator.derive.delegatedTaskNode({ commandId });
        const record: ReviewSessionRecordType = {
          schemaVersion: 1,
          loopId: input.loopId,
          roundId: input.roundId,
          role: input.role,
          order,
          commandId,
          childThreadId,
          taskId,
          selection: selectionRecord(selection),
          evidenceDirectory,
          evidenceHash,
          evidence,
          itemIds: (input.items ?? []).map((item) => item.id),
          startedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* writeRecord(root, key, record);
        return {
          kind: "started",
          commandId,
          childThreadId: ThreadIdSchema.make(record.childThreadId),
          taskId: record.taskId === null ? null : (record.taskId as NodeId),
          evidenceHash,
          reconciled: false,
        } satisfies GameReviewSessionStartResult;
      });

    const readChildAnswer = (
      record: ReviewSessionRecordType,
      known: CriticAnswerKnownIds & { readonly itemIds: ReadonlyArray<string> },
    ): Effect.Effect<GameReviewSessionAnswerResult, GameOperationError> =>
      Effect.gen(function* () {
        const childThreadId = ThreadIdSchema.make(record.childThreadId);
        const records = yield* threads
          .getThreadRecords(childThreadId, ["runs", "messages"], { messageRoles: ["assistant"] })
          .pipe(
            Effect.mapError((cause) =>
              threadFailure("read game review answer", record.childThreadId, cause),
            ),
          );
        const run = records.runs.reduce<OrchestrationV2Run | undefined>(
          (newest, candidate) =>
            newest === undefined || candidate.ordinal > newest.ordinal ? candidate : newest,
          undefined,
        );
        if (run === undefined)
          return { kind: "invalid", reason: "The review child never ran.", raw: null };
        const terminal =
          run.status === "completed" ||
          run.status === "failed" ||
          run.status === "cancelled" ||
          run.status === "interrupted" ||
          run.status === "rolled_back";
        if (!terminal) return { kind: "pending" };
        if (run.status !== "completed")
          return {
            kind: "invalid",
            reason: `The review child ended ${run.status} without a usable answer.`,
            raw: null,
          };
        const answer = records.messages.findLast(
          (message) => message.runId === run.id && message.role === "assistant",
        );
        if (answer === undefined)
          return {
            kind: "invalid",
            reason: "The review child finished without an assistant answer.",
            raw: null,
          };
        const parsed =
          record.role === "critic"
            ? parseCriticAnswer(answer.text, known)
            : parseBallotAnswer(answer.text, known);
        if (parsed.kind === "invalid")
          return { kind: "invalid", reason: parsed.reason, raw: answer.text };
        return record.role === "critic"
          ? { kind: "critic", answer: parsed.answer as GameReviewCriticAnswer, raw: answer.text }
          : { kind: "ballot", answer: parsed.answer as GameReviewBallotAnswer, raw: answer.text };
      });

    const answer: GameReviewSessions["Service"]["answer"] = (input) =>
      Effect.gen(function* () {
        const order = input.order ?? 0;
        const root = yield* projects.resolve(input.threadId);
        const record = yield* readRecord(root, {
          loopId: input.loopId,
          roundId: input.roundId,
          role: input.role,
          order,
        });
        if (record === null)
          return {
            kind: "invalid",
            reason: "No review session matches that round and role.",
            raw: null,
          } satisfies GameReviewSessionAnswerResult;
        if (record.role === "repair")
          return {
            kind: "invalid",
            reason: "A repair child reports in the game folder; it has no audit answer.",
            raw: null,
          } satisfies GameReviewSessionAnswerResult;
        if (record.evidenceDirectory !== null && record.evidenceHash !== null) {
          const now = yield* attempt("hash game review evidence", record.evidenceDirectory, () =>
            hashEvidenceDirectory(record.evidenceDirectory!),
          ).pipe(Effect.orElseSucceed(() => null));
          if (now !== record.evidenceHash)
            return {
              kind: "invalid",
              reason:
                "The evidence changed after this child started; its answer cannot be trusted.",
              raw: null,
            } satisfies GameReviewSessionAnswerResult;
        }
        const evidence = record.evidence ?? { frames: [], checks: [] };
        return yield* readChildAnswer(record, {
          frameIds: new Set(evidence.frames.map((frame) => frame.id)),
          checkIds: new Set(evidence.checks.map((check) => check.id)),
          itemIds: record.itemIds,
        });
      });

    const evidenceDirectory: GameReviewSessions["Service"]["evidenceDirectory"] = (input) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(input.threadId);
        const record = yield* readRecord(root, {
          loopId: input.loopId,
          roundId: input.roundId,
          role: input.role,
          order: input.order ?? 0,
        });
        return record?.evidenceDirectory ?? null;
      });

    const evidenceHash: GameReviewSessions["Service"]["evidenceHash"] = (input) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(input.threadId);
        const record = yield* readRecord(root, {
          loopId: input.loopId,
          roundId: input.roundId,
          role: input.role,
          order: input.order ?? 0,
        });
        if (record?.evidenceDirectory == null) return null;
        return yield* attempt("hash game review evidence", record.evidenceDirectory, () =>
          hashEvidenceDirectory(record.evidenceDirectory!),
        );
      });

    return GameReviewSessions.of({ start, answer, evidenceDirectory, evidenceHash });
  });
  return Layer.effect(GameReviewSessions, make);
};

/**
 * The server wiring's catalog: a review may run only when the exact configured
 * instance is enabled, ready and authenticated and still offers the model.
 * Anything else means unavailable review, never a substitution.
 */
export const providerCatalogLayer = Layer.effect(
  GameReviewProviderCatalog,
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry.ProviderRegistry;
    return GameReviewProviderCatalog.of({
      available: (selection) =>
        registry.getProviders.pipe(
          Effect.map((providers) => {
            const provider = providers.find(
              (candidate) => candidate.instanceId === selection.instanceId,
            );
            if (provider === undefined || !provider.enabled) return false;
            if (provider.status === "disabled" || provider.status === "error") return false;
            if (provider.auth.status === "unauthenticated") return false;
            return provider.models.some((model) => model.slug === selection.model);
          }),
          Effect.orElseSucceed(() => false),
        ),
    });
  }),
);
