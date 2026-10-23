// @effect-diagnostics nodeBuiltinImport:off -- Evidence directories and session records live on the native filesystem outside the game.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CommandId,
  GAME_TRY_INPUT_BOUNDS,
  tryInputIssues,
  type GameTryInput,
  type GameWebPlaytestResult,
  GAME_REVIEW_ANSWER_MAX_BYTES,
  GameOperationError,
  GameReviewBallotAnswer,
  GameReviewBallotInput,
  type GameReviewReportResult,
  GameReviewCriticAnswer,
  GameReviewCheck,
  type GameReviewExperimentRoute,
  GamePlaytestInputPair,
  GamePlaytestStep,
  GameViewport,
  type GameReviewDefect,
  type GameReviewDoNotRegress,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2StoredEvent,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  ProviderOptionSelections,
  RunId,
  type RuntimeMode,
  type ThreadId,
  ThreadId as ThreadIdSchema,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as GameService from "./GameService.ts";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import { gameRecordFile, realGameRoot } from "./gameRecord.ts";
import {
  type GameReviewPromptDefect,
  builderFixPrompt,
  criticPrompt,
  pairwisePrompt,
} from "./gameReviewPrompts.ts";
import { playedViewport } from "./playtestEvidence.ts";

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
  readonly inputPair?: GamePlaytestInputPair;
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
  readonly measurements?: GameReviewCheck["measurements"];
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
  /** Why the previous attempt was rejected, so the next repair does not repeat it. */
  readonly previousRejection?: string | undefined;
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
  readonly defects?: ReadonlyArray<GameReviewPromptDefect>;
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
      /** The child run this session is bound to, once its dispatch is known. */
      readonly runId: RunId | null;
      readonly evidenceHash: string | null;
      /** True when a receipt/record already existed and nothing was dispatched. */
      readonly reconciled: boolean;
    }
  /** The round cannot use this child; nothing was started and nothing will be. */
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface GameReviewSessionAnswerInput {
  readonly threadId: ThreadId;
  readonly loopId: string;
  readonly roundId: string;
  readonly role: GameReviewTaskRole;
  readonly order?: number;
}

export type GameReviewChildRunStatus =
  /** No session record (or no dispatched run) exists for this key. */
  | { readonly kind: "missing" }
  | { readonly kind: "pending"; readonly runId: RunId | null }
  | {
      readonly kind: "terminal";
      readonly runId: RunId | null;
      readonly status: "completed" | "failed" | "cancelled" | "interrupted" | "rolled_back";
    };

export interface GameReviewExperimentInput {
  readonly threadId: ThreadId;
  readonly loopId: string;
  readonly roundId: string;
  /** Frames the critic cited; non-experiment frame ids are ignored. */
  readonly frameIds: ReadonlyArray<string>;
}

export type GameReviewSessionAnswerResult =
  | { readonly kind: "critic"; readonly answer: GameReviewCriticAnswer; readonly raw: string }
  | { readonly kind: "ballot"; readonly answer: GameReviewBallotAnswer; readonly raw: string }
  /** The child has not produced a terminal answer yet. */
  | { readonly kind: "pending" }
  | {
      readonly kind: "invalid";
      readonly reason: string;
      readonly raw: string | null;
      /** True when raw was cut to the stored-output limit. */
      readonly truncated?: boolean;
    };

interface SessionKey {
  readonly loopId: string;
  readonly roundId: string;
  readonly role: GameReviewTaskRole;
  readonly order: number;
}

const FRAME_FILE = (index: number) => `frames/frame-${String(index + 1).padStart(2, "0")}.png`;
const EVIDENCE_MANIFEST = "evidence.json";
const BRIEF_FILE = "BRIEF.md";
// Four slots, each with up to 45 cited pairs and six frozen-route frames.
const MAX_FRAMES = 384;
const MAX_CHECKS = 64;

const ReviewFrameRecord = Schema.Struct({
  inputPair: Schema.optionalKey(GamePlaytestInputPair),
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
  measurements: GameReviewCheck.fields.measurements,
});
const ReviewEvidenceRecord = Schema.Struct({
  frames: Schema.Array(ReviewFrameRecord),
  checks: Schema.Array(ReviewCheckRecord),
});
type ReviewEvidenceRecordType = typeof ReviewEvidenceRecord.Type;

/**
 * The server-written record of one active experiment. Only the route and the
 * frames it produced are read back; the result measurements stay the child's.
 */
const StoredExperiment = Schema.Struct({
  buildId: Schema.String,
  steps: Schema.Array(GamePlaytestStep),
  captureEveryMs: Schema.Number,
  baseViewport: Schema.optionalKey(GameViewport),
  /** The whole-number multiple the run played at, so the route replays there. */
  captureScale: Schema.optionalKey(Schema.Number),
  screenshots: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      inputPair: Schema.optionalKey(GamePlaytestInputPair),
    }),
  ),
});
const decodeStoredExperiment = Schema.decodeUnknownEffect(StoredExperiment);

const ReviewSelectionRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  instanceId: Schema.String,
  model: Schema.String,
  options: Schema.optionalKey(ProviderOptionSelections),
});
type ReviewSelectionRecordType = typeof ReviewSelectionRecord.Type;

/**
 * A round freezes two selections, not one: who reviews (the first review
 * child's choice or override) and who repairs (the builder run's own model).
 * Changing the composer after critique cannot change either.
 */
const RoundSelectionRecord = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  review: Schema.optionalKey(ReviewSelectionRecord),
  builder: ReviewSelectionRecord,
  originatingRunId: Schema.optionalKey(Schema.String),
  originatingNodeId: Schema.optionalKey(Schema.String),
});
type RoundSelectionRecordType = typeof RoundSelectionRecord.Type;

interface FrozenRoundSelection {
  readonly review: ModelSelection | null;
  readonly builder: ModelSelection | null;
}

const ReviewDispatchRecord = Schema.Struct({
  /**
   * pending is written before the command is sent. confirmed means the
   * orchestrator accepted it, rejected means it refused. A crash can leave
   * pending behind, never a missing record.
   */
  state: Schema.Literals(["pending", "confirmed", "rejected"]),
  detail: Schema.optionalKey(Schema.String),
});
/** Everything a pending record needs to send the same command on retry. */
const ReviewCommandRecord = Schema.Struct({
  task: Schema.String,
  title: Schema.String,
  modelSelection: ReviewSelectionRecord,
  runtimeMode: Schema.String,
  interactionMode: Schema.String,
  originatingRunId: Schema.String,
  originatingNodeId: Schema.String,
});
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
  defectIds: Schema.optionalKey(Schema.Array(Schema.String)),
  playBuildId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  playViewport: Schema.optionalKey(Schema.NullOr(GameViewport)),
  startedAt: Schema.String,
  /** Present from this version on; absent records predate the pending write. */
  dispatch: Schema.optionalKey(ReviewDispatchRecord),
  command: Schema.optionalKey(ReviewCommandRecord),
  /** The child run this session dispatched. Later runs never replace it. */
  runId: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
type ReviewSessionRecordType = typeof ReviewSessionRecord.Type;

const ReviewCallerRecord = Schema.Struct({
  root: Schema.String,
  loopId: Schema.String,
  roundId: Schema.String,
  role: Schema.Literals(["critic", "ballot"]),
  order: Schema.Number,
});
const ReviewToolRecord = Schema.Struct({
  runId: Schema.String,
  evidenceHash: Schema.NullOr(Schema.String),
  attempts: Schema.Number,
  raw: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
const encodeReviewAnswer = Schema.encodeSync(
  Schema.fromJsonString(Schema.Union([GameReviewCriticAnswer, GameReviewBallotAnswer])),
);
const decodeCallerRecord = Schema.decodeUnknownSync(ReviewCallerRecord);
const decodeToolRecord = Schema.decodeUnknownSync(ReviewToolRecord);

export interface GameReviewToolCaller {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

const decodeSessionRecord = Schema.decodeUnknownSync(ReviewSessionRecord);
const decodeSelectionRecord = Schema.decodeUnknownSync(ReviewSelectionRecord);
const isRoundSelectionRecord = Schema.is(RoundSelectionRecord);

/** Reads v2 rounds and the v1 review-only file a previous build wrote. */
const decodeRoundSelection = (value: unknown): FrozenRoundSelection =>
  isRoundSelectionRecord(value)
    ? {
        review: value.review === undefined ? null : toSelection(value.review),
        builder: toSelection(value.builder),
      }
    : { review: toSelection(decodeSelectionRecord(value)), builder: null };

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

const EXPERIMENT_FRAME_ID = /^try(\d+)f\d+$/u;
const DURING_FRAME_STEP = /^step (\d+) during:/u;

/** The step an interval frame belongs to, when its pair metadata has no index. */
const experimentStepIndex = (frame: {
  readonly inputPair?: { readonly stepIndex: number } | undefined;
  readonly label: string;
}): number | null => {
  if (frame.inputPair !== undefined) return frame.inputPair.stepIndex;
  const match = DURING_FRAME_STEP.exec(frame.label);
  return match === null ? null : Number(match[1]) - 1;
};

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
      ...(check.measurements === undefined ? {} : { measurements: check.measurements }),
    }))
    .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const frames = input.frames.map((frame, index) => ({
    id: `f${index + 1}`,
    file: FRAME_FILE(index),
    sourceId: frame.id,
    label: frame.label,
    ...(frame.inputPair === undefined ? {} : { inputPair: frame.inputPair }),
  }));
  for (const [index, frame] of input.frames.entries()) {
    await NodeFSP.copyFile(frame.sourcePath, NodePath.join(input.directory, FRAME_FILE(index)));
  }
  const evidence: ReviewEvidenceRecordType = { frames, checks };
  await NodeFSP.writeFile(
    NodePath.join(input.directory, EVIDENCE_MANIFEST),
    `${JSON.stringify(
      {
        frames: frames.map((frame) => ({
          id: frame.id,
          file: frame.file,
          label: frame.label,
          ...(frame.inputPair === undefined ? {} : { inputPair: frame.inputPair }),
        })),
        checks,
      },
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
 * JSON.parse silently keeps the last of two identical object members, so
 * `{"defects":[...],"defects":[]}` would erase reported defects. The input is
 * already known to be valid JSON; this walk only tracks object member names,
 * unescapes them the same way JSON.parse does, and reports the first repeat.
 */
const duplicateJsonMember = (text: string): string | null => {
  // One flat pass with an explicit stack: a recursive walk exhausts the call
  // stack on deeply nested arrays that still fit the byte limit.
  const containers: Array<Set<string> | "array"> = [];
  let expectingName = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "{") {
      containers.push(new Set());
      expectingName = true;
    } else if (char === "[") {
      containers.push("array");
      expectingName = false;
    } else if (char === "}" || char === "]") {
      containers.pop();
      expectingName = false;
    } else if (char === ",") {
      expectingName = containers.at(-1) instanceof Set;
    } else if (char === ":") {
      expectingName = false;
    } else if (char === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
      const names = containers.at(-1);
      if (expectingName && names instanceof Set) {
        const name = JSON.parse(text.slice(start, index + 1)) as string;
        if (names.has(name)) return name;
        names.add(name);
        expectingName = false;
      }
    }
  }
  return null;
};

/**
 * One JSON object, no prose, at most 16 KiB. Excess keys are errors, not
 * ignored fields: an answer that carries extra data is not the schema the loop
 * asked for. Duplicate members are errors at every depth for the same reason:
 * the answer must not be able to argue both sides of one key.
 */
const parseAnswerText = (text: string): { kind: "parsed"; value: unknown } | AnswerParseFailure => {
  if (Buffer.byteLength(text, "utf8") > GAME_REVIEW_ANSWER_MAX_BYTES)
    return { kind: "invalid", reason: "The answer is larger than 16 KiB." };
  const trimmed = text.trim().replace(/^```json\s*\n([\s\S]*?)\n```$/u, "$1");
  if (trimmed.length === 0) return { kind: "invalid", reason: "The answer is empty." };
  let value: unknown;
  let duplicate: string | null;
  try {
    value = JSON.parse(trimmed) as unknown;
    duplicate = duplicateJsonMember(trimmed);
  } catch {
    return { kind: "invalid", reason: "The answer is not one JSON object." };
  }
  if (duplicate !== null)
    return { kind: "invalid", reason: `The answer repeats the JSON member "${duplicate}".` };
  return { kind: "parsed", value };
};

/**
 * Invalid output is still returned for the audit trail, but it must not let a
 * child store an arbitrarily large answer. Cut on a UTF-8 byte boundary and
 * drop a split trailing character, then say that it was cut.
 */
const boundRawAnswer = (text: string): { readonly raw: string; readonly truncated: boolean } => {
  if (Buffer.byteLength(text, "utf8") <= GAME_REVIEW_ANSWER_MAX_BYTES)
    return { raw: text, truncated: false };
  const prefix = Buffer.from(text, "utf8")
    .subarray(0, GAME_REVIEW_ANSWER_MAX_BYTES)
    .toString("utf8")
    .replace(/\uFFFD+$/u, "");
  return { raw: prefix, truncated: true };
};

const decodeStrict = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  label: string,
  exactError = false,
): ParsedAnswer<S["Type"]> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { kind: "invalid", reason: `The ${label} answer is not a JSON object.` };
  try {
    return {
      kind: "valid",
      answer: Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value),
    };
  } catch (cause) {
    const message = String(cause instanceof Error ? cause.message : cause);
    const first = exactError ? message : message.split("\n")[0]!;
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
  for (const [name, judgment] of Object.entries(answer.fundamentals)) {
    if (judgment.verdict === "no" && judgment.frameIds.length === 0)
      return { kind: "invalid", reason: `The critic's ${name}=no needs a frame citation.` };
    for (const frameId of judgment.frameIds)
      if (!known.frameIds.has(frameId))
        return {
          kind: "invalid",
          reason: `The critic cited frame ${frameId}, which is not in its manifest.`,
        };
  }
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
  readonly defectIds?: ReadonlyArray<string>;
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
  const defectIds = known.defectIds ?? [];
  const judged = new Set<string>();
  for (const entry of answer.defects) {
    if (!defectIds.includes(entry.id) || judged.has(entry.id))
      return {
        kind: "invalid",
        reason: `The ballot judged unknown or repeated defect ${entry.id}.`,
      };
    judged.add(entry.id);
  }
  if (judged.size !== defectIds.length)
    return {
      kind: "invalid",
      reason: `The ballot did not judge defects: ${defectIds.filter((id) => !judged.has(id)).join(", ")}.`,
    };
  for (const entry of [
    ...answer.defects.flatMap((defect) => [defect.A, defect.B]),
    ...answer.regressions.A,
    ...answer.regressions.B,
  ]) {
    for (const frameId of entry.frameIds)
      if (!known.frameIds.has(frameId))
        return {
          kind: "invalid",
          reason: `The ballot cited frame ${frameId}, which is not in its manifest.`,
        };
  }
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
    readonly inputCalls: (
      threadId: ThreadId,
      runId: RunId,
    ) => Effect.Effect<number, GameOperationError>;
    readonly tryInput: (
      caller: GameReviewToolCaller,
      input: GameTryInput,
    ) => Effect.Effect<GameWebPlaytestResult, GameOperationError>;
    readonly start: (
      input: GameReviewSessionStartInput,
    ) => Effect.Effect<GameReviewSessionStartResult, GameOperationError>;
    /** Only the active run of a server-owned review child can see its answer tool. */
    readonly toolRole: (
      caller: GameReviewToolCaller,
    ) => Effect.Effect<"critic" | "ballot" | null, GameOperationError>;
    readonly report: (
      caller: GameReviewToolCaller,
      role: "critic" | "ballot",
      value: unknown,
    ) => Effect.Effect<GameReviewReportResult, GameOperationError>;
    /** Reads and strictly validates the child's terminal answer. */
    readonly answer: (
      input: GameReviewSessionAnswerInput,
    ) => Effect.Effect<GameReviewSessionAnswerResult, GameOperationError>;
    /**
     * Freezes the routes behind the critic's cited experiment frames. Only
     * routes whose frames the critic cited are returned, with the frozen
     * viewport it played, so the loop can replay them on both builds.
     */
    readonly experiments: (
      input: GameReviewExperimentInput,
    ) => Effect.Effect<ReadonlyArray<GameReviewExperimentRoute>, GameOperationError>;
    /**
     * The bound child run's status. A repair has no audited answer, so the loop
     * needs this to know when the writable child stopped writing.
     */
    readonly runStatus: (
      input: GameReviewSessionAnswerInput,
    ) => Effect.Effect<GameReviewChildRunStatus, GameOperationError>;
    /** The evidence directory one review child runs in, when it has one. */
    readonly evidenceDirectory: (input: {
      readonly threadId: ThreadId;
      readonly loopId: string;
      readonly roundId: string;
      readonly role: GameReviewTaskRole;
      readonly order?: number;
    }) => Effect.Effect<string | null, GameOperationError>;
    /** Hashes the evidence directory now; null for a repair session. */
    readonly describe: (
      input: GameReviewSessionAnswerInput,
    ) => Effect.Effect<
      typeof import("@t3tools/contracts").GameReviewEvidenceRef.Type | null,
      GameOperationError
    >;
    readonly evidenceHash: (
      input: GameReviewSessionAnswerInput,
    ) => Effect.Effect<string | null, GameOperationError>;
    /**
     * Every child a loop recorded, including one whose dispatch was never
     * confirmed: the record is written before the command can create
     * anything, so this is the durable answer to what may still be writing.
     */
    readonly recordedChildren: (input: {
      readonly root: string;
      readonly loopId: string;
    }) => Effect.Effect<ReadonlyArray<GameReviewRecordedChild>, GameOperationError>;
  }
>()("t3/game/GameReviewSessions") {}

export interface GameReviewRecordedChild {
  readonly role: GameReviewTaskRole;
  readonly childThreadId: ThreadId;
  readonly runId: RunId | null;
}

const threadFailure = (operation: string, path: string, cause: unknown) =>
  failure(operation, path, "thread-dispatch", String(cause), cause);

export const layer = (options: { readonly stateDir: string }) => {
  const make = Effect.gen(function* () {
    const projects = yield* GameProjectService.GameProjectService;
    const rounds = yield* GameRoundStore.GameRoundStore;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const catalog = yield* GameReviewProviderCatalog;
    const callerLocks = new Map<ThreadId, Semaphore.Semaphore>();
    // Playing must not stall MCP authentication for unrelated game sessions.
    const callerLock = (caller: GameReviewToolCaller) => {
      let lock = callerLocks.get(caller.threadId);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        callerLocks.set(caller.threadId, lock);
      }
      return lock;
    };
    const game = yield* Effect.serviceOption(GameService.GameService);

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

    const callerFile = (childThreadId: string) =>
      NodePath.join(options.stateDir, "game-review-callers", `${encodePart(childThreadId)}.json`);

    const toolFile = (root: string, key: SessionKey) =>
      recordFile(root, key).pipe(
        Effect.map((file) => NodePath.join(NodePath.dirname(file), "tool-answer.json")),
      );

    const readToolRecord = Effect.fnUntraced(function* (file: string) {
      const value = yield* attempt("read game review tool answer", file, () => readJson(file));
      if (value === null) return null;
      return yield* Effect.try({
        try: () => decodeToolRecord(value),
        catch: (cause) => failure("read game review tool answer", file, "io", undefined, cause),
      });
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
      if (record.role !== "repair") {
        const lookup = callerFile(record.childThreadId);
        yield* attempt("index game review caller", lookup, () =>
          writeJsonAtomic(lookup, { root, ...key }),
        );
      }
    });

    const readRoundSelection = Effect.fnUntraced(function* (root: string, roundId: string) {
      const file = yield* roundSelectionFile(root, roundId);
      const value = yield* attempt("read game review selection", file, () => readJson(file));
      if (value === null) return null;
      return yield* Effect.try({
        try: () => decodeRoundSelection(value),
        catch: (cause) =>
          failure(
            "read game review selection",
            file,
            "io",
            "The frozen round selection is unreadable.",
            cause,
          ),
      });
    });

    const writeRoundSelection = Effect.fnUntraced(function* (
      root: string,
      roundId: string,
      selection: {
        readonly review?: ModelSelection;
        readonly builder: ModelSelection;
        readonly originatingRunId?: string;
        readonly originatingNodeId?: string;
      },
    ) {
      const file = yield* roundSelectionFile(root, roundId);
      const record: RoundSelectionRecordType = {
        schemaVersion: 2,
        ...(selection.review === undefined ? {} : { review: selectionRecord(selection.review) }),
        builder: selectionRecord(selection.builder),
        ...(selection.originatingRunId === undefined
          ? {}
          : { originatingRunId: selection.originatingRunId }),
        ...(selection.originatingNodeId === undefined
          ? {}
          : { originatingNodeId: selection.originatingNodeId }),
      };
      yield* attempt("write game review selection", file, () => writeJsonAtomic(file, record));
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

    const startedResult = (
      record: ReviewSessionRecordType,
      reconciled: boolean,
    ): GameReviewSessionStartResult => ({
      kind: "started",
      commandId: record.commandId,
      childThreadId: ThreadIdSchema.make(record.childThreadId),
      taskId: record.taskId === null ? null : (record.taskId as NodeId),
      runId: record.runId == null ? null : RunId.make(record.runId),
      // The hash recorded when the evidence was written. Re-hashing on a
      // restart could bless a later change as the original audit fact.
      evidenceHash: record.evidenceHash,
      reconciled,
    });

    /** The child run this record dispatched, never merely its newest run. */
    const boundRunId = (record: ReviewSessionRecordType) =>
      Effect.gen(function* () {
        const messageId = IdAllocator.derive.delegatedTaskMessage({
          commandId: CommandId.make(record.commandId),
        });
        const records = yield* threads.getThreadRecords(ThreadIdSchema.make(record.childThreadId), [
          "runs",
        ]);
        return records.runs.find((run) => run.userMessageId === messageId)?.id ?? null;
      }).pipe(
        Effect.mapError((cause) => threadFailure("start game review", record.childThreadId, cause)),
        Effect.orElseSucceed(() => null),
      );

    /** The run the just-committed child dispatch created, from its own events. */
    const childRunIdFromDispatch = (
      result: { readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent> },
      childThreadId: ThreadId,
    ) => {
      for (const stored of result.storedEvents) {
        const event = stored.event;
        if (event.type !== "run.created" || event.threadId !== childThreadId) continue;
        return event.payload.id;
      }
      return null;
    };

    /** Re-sends exactly the command the pending record persisted. */
    const commandFromRecord = (record: ReviewSessionRecordType, threadId: ThreadId) => {
      const command = record.command!;
      return {
        type: "game-round.task.request",
        createdBy: "system",
        creationSource: "server",
        commandId: CommandId.make(record.commandId),
        originatingThreadId: threadId,
        originatingRunId: RunId.make(command.originatingRunId),
        originatingNodeId: command.originatingNodeId as NodeId,
        loopId: record.loopId,
        roundId: record.roundId,
        role: record.role,
        order: record.order,
        task: command.task,
        title: command.title,
        modelSelection: toSelection(command.modelSelection),
        runtimeMode: command.runtimeMode as RuntimeMode,
        interactionMode: command.interactionMode as ProviderInteractionMode,
        evidenceDirectory: record.evidenceDirectory,
      } as const;
    };

    /**
     * Resolves a record left by an earlier call. A confirmed record needs no
     * dispatch. A pending one asks the receipt store what the orchestrator
     * committed: accepted finishes the record, rejected is a failed start and
     * no receipt means the command never committed, so it is safe to send it
     * again with the same idempotency key.
     */
    const reconcile = (
      root: string,
      key: SessionKey,
      commandId: CommandId,
      record: ReviewSessionRecordType,
      threadId: ThreadId,
    ) =>
      Effect.gen(function* () {
        const state = record.dispatch?.state ?? "confirmed";
        if (state === "rejected")
          return {
            kind: "failed",
            reason: record.dispatch?.detail ?? "The review dispatch was rejected.",
          } satisfies GameReviewSessionStartResult;
        if (state === "confirmed") return startedResult(record, true);

        const receipt = yield* threads
          .getCommandReceiptStatus(commandId)
          .pipe(Effect.mapError((cause) => threadFailure("start game review", root, cause)));
        if (receipt === "rejected") {
          const detail = "The orchestration layer rejected this review dispatch.";
          yield* writeRecord(root, key, {
            ...record,
            dispatch: { state: "rejected", detail },
          });
          return { kind: "failed", reason: detail } satisfies GameReviewSessionStartResult;
        }
        if (receipt === "accepted") {
          // The command committed but the process died before confirming its
          // record. The child exists with every audit field already written, so
          // this is a start to finish, not a command to send again.
          const runId = record.runId ?? (yield* boundRunId(record));
          if (runId === null)
            return {
              kind: "failed",
              reason: "The committed review child has no dispatched run.",
            } satisfies GameReviewSessionStartResult;
          const confirmed: ReviewSessionRecordType = {
            ...record,
            runId,
            dispatch: { state: "confirmed" },
          };
          yield* writeRecord(root, key, confirmed);
          return startedResult(confirmed, true);
        }

        const command = record.command;
        if (command === undefined)
          return {
            kind: "failed",
            reason: "The pending review record is missing the command it must send.",
          } satisfies GameReviewSessionStartResult;
        if (record.evidenceDirectory !== null) {
          // The child has not read anything yet, but the audit hash must still
          // describe the evidence it will see.
          const now = yield* attempt("hash game review evidence", record.evidenceDirectory, () =>
            hashEvidenceDirectory(record.evidenceDirectory!),
          ).pipe(Effect.orElseSucceed(() => null));
          if (now !== record.evidenceHash) {
            const detail = "The evidence no longer matches the pending review record.";
            yield* writeRecord(root, key, {
              ...record,
              dispatch: { state: "rejected", detail },
            });
            return { kind: "failed", reason: detail } satisfies GameReviewSessionStartResult;
          }
        }
        const dispatched = yield* threads
          .dispatch(commandFromRecord(record, threadId))
          .pipe(Effect.mapError((cause) => threadFailure("start game review", root, cause)));
        const runId =
          childRunIdFromDispatch(dispatched, ThreadIdSchema.make(record.childThreadId)) ??
          (yield* boundRunId(record));
        const confirmed: ReviewSessionRecordType = {
          ...record,
          runId,
          dispatch: { state: "confirmed" },
        };
        yield* writeRecord(root, key, confirmed);
        return startedResult(confirmed, false);
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
        const live = yield* liveRound(root, input.roundId);

        // The record is written before the command is sent, so the crash
        // window between a committed dispatch and its audit metadata no longer
        // exists. A record that is already there is authoritative.
        const existing = yield* readRecord(root, key);
        if (existing !== null)
          return yield* reconcile(root, key, commandId, existing, input.threadId);
        const orphanReceipt = yield* threads
          .getCommandReceiptStatus(commandId)
          .pipe(Effect.mapError((cause) => threadFailure("start game review", root, cause)));
        if (orphanReceipt !== null)
          return {
            kind: "failed",
            reason:
              "The review dispatch committed without its audit record; refusing to report a start.",
          } satisfies GameReviewSessionStartResult;

        const manifest = yield* projects.read(root);
        const origin = yield* resolveOrigin(input.threadId, {
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
        });
        const frozen = yield* readRoundSelection(root, input.roundId);
        // The run's own selection is the model and options the builder used,
        // not whatever the composer shows after it finished. A round opened by
        // the loop folds both selections into its record; the session file is
        // only the pre-loop fallback.
        const builderSelection: ModelSelection =
          live.builderSelection ??
          frozen?.builder ??
          origin.run.modelSelection ??
          origin.thread.modelSelection;
        const selection =
          input.role === "repair"
            ? // Repairs keep the frozen builder selection; a review override
              // never changes who repairs.
              builderSelection
            : (live.reviewSelection ?? frozen?.review ?? input.selection ?? builderSelection);
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
              ? pairwisePrompt({ files, items: input.items ?? [], defects: input.defects ?? [] })
              : builderFixPrompt({
                  remainingBudget: input.repair?.remainingBudget ?? "the remaining round budget",
                  brief,
                  defects: input.repair?.defects ?? [],
                  doNotRegress: input.repair?.doNotRegress ?? [],
                  ...(input.repair?.previousRejection === undefined
                    ? {}
                    : { previousRejection: input.repair.previousRejection }),
                });
        const title =
          input.role === "critic"
            ? "Game review: critic"
            : input.role === "ballot"
              ? "Game review: ballot"
              : "Game review: repair";

        // Freeze both selections before dispatch: every later child of this
        // round must match, whatever the thread or caller does meanwhile.
        const frozenReview =
          live.reviewSelection ??
          frozen?.review ??
          (input.role === "repair" ? undefined : selection);
        if (
          live.builderSelection === undefined &&
          live.reviewSelection === undefined &&
          (frozen === null ||
            frozen.builder === null ||
            (input.role !== "repair" && frozen.review === null))
        )
          yield* writeRoundSelection(root, input.roundId, {
            ...(frozenReview === undefined ? {} : { review: frozenReview }),
            builder: builderSelection,
            originatingRunId: origin.run.id,
            originatingNodeId: origin.nodeId,
          });

        const childThreadId = IdAllocator.derive.delegatedTaskThread({ commandId });
        const taskId = IdAllocator.derive.delegatedTaskNode({ commandId });
        const playBuildId = input.role === "critic" ? live.incumbentBuildId : null;
        const playBinding = playBuildId === null ? null : yield* rounds.exported(root, playBuildId);
        const record: ReviewSessionRecordType = {
          playBuildId,
          playViewport: playedViewport(
            playBinding?.playtest?.viewport,
            playBinding?.playtest?.captureScale,
          ),
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
          defectIds: (input.defects ?? []).map((defect) => defect.id),
          startedAt: DateTime.formatIso(yield* DateTime.now),
          dispatch: { state: "pending" },
          command: {
            task,
            title,
            modelSelection: selectionRecord(selection),
            runtimeMode: origin.thread.runtimeMode as RuntimeMode,
            interactionMode: origin.thread.interactionMode as ProviderInteractionMode,
            originatingRunId: origin.run.id,
            originatingNodeId: origin.nodeId,
          },
        };
        // Persist every audit fact before the command can create anything: a
        // restart must be able to answer from this file alone.
        yield* writeRecord(root, key, record);

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
          title,
          modelSelection: selection,
          runtimeMode: origin.thread.runtimeMode as RuntimeMode,
          interactionMode: origin.thread.interactionMode as ProviderInteractionMode,
          evidenceDirectory,
        } as const;
        const dispatched = yield* threads
          .dispatch(command)
          .pipe(Effect.mapError((cause) => threadFailure("start game review", root, cause)));
        const runId =
          childRunIdFromDispatch(dispatched, childThreadId) ?? (yield* boundRunId(record));
        const confirmed: ReviewSessionRecordType = {
          ...record,
          runId,
          dispatch: { state: "confirmed" },
        };
        yield* writeRecord(root, key, confirmed);
        return startedResult(confirmed, false);
      });

    type ChildAnswerRead =
      | { readonly kind: "pending" }
      | { readonly kind: "invalid"; readonly reason: string; readonly raw: string | null }
      | { readonly kind: "text"; readonly text: string };

    /**
     * Reads the bound run's terminal answer. Nothing here touches evidence:
     * the caller verifies evidence only after this read, so a child cannot
     * change a frame and finish between the hash and the accepted answer.
     */
    const readChildAnswerText = (
      record: ReviewSessionRecordType,
      tool: typeof ReviewToolRecord.Type | null,
    ): Effect.Effect<ChildAnswerRead, GameOperationError> =>
      Effect.gen(function* () {
        const childThreadId = ThreadIdSchema.make(record.childThreadId);
        const records = yield* threads
          .getThreadRecords(childThreadId, ["runs", "messages"], { messageRoles: ["assistant"] })
          .pipe(
            Effect.mapError((cause) =>
              threadFailure("read game review answer", record.childThreadId, cause),
            ),
          );
        // The run that this session dispatched, never whichever run happens to
        // be newest: a follow-up cannot replace or hide the original result.
        const dispatchedMessageId =
          record.runId === undefined || record.runId === null
            ? IdAllocator.derive.delegatedTaskMessage({
                commandId: CommandId.make(record.commandId),
              })
            : null;
        const run =
          record.runId === undefined || record.runId === null
            ? records.runs.find((candidate) => candidate.userMessageId === dispatchedMessageId)
            : records.runs.find((candidate) => candidate.id === record.runId);
        if (run === undefined)
          return {
            kind: "invalid",
            reason: "The review child's dispatched run is not in its history.",
            raw: null,
          };
        const terminal =
          run.status === "completed" ||
          run.status === "failed" ||
          run.status === "cancelled" ||
          run.status === "interrupted" ||
          run.status === "rolled_back";
        if (tool !== null && (tool.runId !== run.id || tool.evidenceHash !== record.evidenceHash))
          return {
            kind: "invalid",
            reason: "The tool answer belongs to another run or evidence hash.",
            raw: null,
          };
        if (!terminal) return { kind: "pending" };
        if (tool !== null) {
          if (tool.raw !== null) return { kind: "text", text: tool.raw };
          return {
            kind: "invalid",
            reason:
              tool.error ??
              "The provider had the review tool but ended without calling it successfully.",
            raw: null,
          };
        }
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
        return { kind: "text", text: answer.text };
      });

    const matchingCaller = Effect.fnUntraced(function* (caller: GameReviewToolCaller) {
      const lookup = callerFile(caller.threadId);
      const value = yield* attempt("read game review caller", lookup, () => readJson(lookup));
      if (value === null) return null;
      const key = yield* Effect.try({
        try: () => decodeCallerRecord(value),
        catch: (cause) => failure("read game review caller", lookup, "io", undefined, cause),
      });
      const record = yield* readRecord(key.root, key);
      if (
        record === null ||
        record.childThreadId !== caller.threadId ||
        record.selection.instanceId !== caller.providerInstanceId ||
        record.dispatch?.state === "rejected"
      )
        return null;
      const round = (yield* rounds.read(key.root)).rounds.find((round) => round.id === key.roundId);
      if (round?.status !== "running") return null;
      const records = yield* threads
        .getThreadRecords(caller.threadId, ["runs"])
        .pipe(
          Effect.mapError((cause) =>
            threadFailure("read game review caller", caller.threadId, cause),
          ),
        );
      const dispatchedMessageId = IdAllocator.derive.delegatedTaskMessage({
        commandId: CommandId.make(record.commandId),
      });
      const bound =
        record.runId ?? records.runs.find((run) => run.userMessageId === dispatchedMessageId)?.id;
      const active = records.runs.findLast(
        (run) =>
          run.status !== "completed" &&
          run.status !== "failed" &&
          run.status !== "cancelled" &&
          run.status !== "interrupted" &&
          run.status !== "rolled_back",
      );
      if (bound === undefined || active?.id !== bound) return null;
      return { key, record, runId: active.id };
    });

    const inputBudgetFile = (threadId: ThreadId, runId: RunId) =>
      NodePath.join(
        options.stateDir,
        "game-input-calls",
        encodePart(threadId),
        `${encodePart(runId)}.json`,
      );
    const inputCalls: GameReviewSessions["Service"]["inputCalls"] = (threadId, runId) => {
      const file = inputBudgetFile(threadId, runId);
      return attempt("read game input budget", file, () => readJson(file)).pipe(
        Effect.flatMap((value) =>
          value === null
            ? Effect.succeed(0)
            : Schema.decodeUnknownEffect(
                Schema.Int.check(
                  Schema.isBetween({ minimum: 0, maximum: GAME_TRY_INPUT_BOUNDS.maxCalls }),
                ),
              )(value).pipe(
                Effect.mapError((cause) =>
                  failure("read game input budget", file, "io", undefined, cause),
                ),
              ),
        ),
      );
    };

    const tryInput: GameReviewSessions["Service"]["tryInput"] = (caller, input) =>
      callerLock(caller).withPermits(1)(
        Effect.gen(function* () {
          const invalid = (detail: string) =>
            failure("game_try_input", caller.threadId, "invalid-input", detail);
          const issues = tryInputIssues(input);
          if (issues.length > 0) return yield* invalid(issues.join("\n"));
          const indexed = yield* attempt("read game review caller", caller.threadId, () =>
            readJson(callerFile(caller.threadId)),
          );
          const match = yield* matchingCaller(caller);
          if (indexed !== null && (match === null || match.key.role !== "critic"))
            return yield* invalid(
              "game_try_input is unavailable to ballots and inactive review sessions; ballots compare frozen evidence only.",
            );
          if (Option.isNone(game))
            return yield* invalid("The headless game playtest service is unavailable.");
          const records = yield* threads
            .getThreadRecords(caller.threadId, ["runs"])
            .pipe(
              Effect.mapError((cause) =>
                threadFailure("read game input caller", caller.threadId, cause),
              ),
            );
          const run = records.runs.findLast(
            (run) =>
              run.status === "running" ||
              run.status === "starting" ||
              run.status === "waiting" ||
              run.status === "queued",
          );
          if (run === undefined || run.providerInstanceId !== caller.providerInstanceId)
            return yield* invalid("game_try_input requires the caller's active provider run.");
          const root = match?.key.root ?? (yield* projects.resolve(caller.threadId));
          const round =
            match === null
              ? null
              : (yield* rounds.read(root)).rounds.find((round) => round.id === match.key.roundId);
          const targetThreadId = round?.threadId ?? caller.threadId;
          const buildId =
            match === null
              ? (input.buildId ??
                // The served preview id is a 24-character identity; only the
                // export stage's build id names the exported artifact bytes.
                (yield* game.value.status(targetThreadId)).qualification.stages.find(
                  (stage) => stage.stage === "export",
                )?.buildId ??
                undefined)
              : (match.record.playBuildId ?? round?.incumbentBuildId ?? undefined);
          if (
            match !== null &&
            (buildId === undefined || (input.buildId !== undefined && input.buildId !== buildId))
          )
            return yield* invalid("The critic can only play the frozen build under review.");
          const priorTool =
            match === null ? null : yield* readToolRecord(yield* toolFile(root, match.key));
          if (
            match !== null &&
            priorTool !== null &&
            (priorTool.runId !== run.id || priorTool.evidenceHash !== match.record.evidenceHash)
          )
            return yield* invalid("The recorded answer belongs to another run or evidence hash.");
          if (priorTool !== null && (priorTool.raw !== null || priorTool.attempts >= 3))
            return yield* invalid("The review session has ended.");
          if (
            match !== null &&
            (yield* attempt("hash game review evidence", root, () =>
              hashEvidenceDirectory(match.record.evidenceDirectory!),
            )) !== match.record.evidenceHash
          )
            return yield* invalid(
              "The evidence changed after this child started; active input is refused.",
            );
          const budgetFile = inputBudgetFile(caller.threadId, run.id);
          const calls = yield* inputCalls(caller.threadId, run.id);
          if (calls >= GAME_TRY_INPUT_BOUNDS.maxCalls)
            return yield* invalid(
              `game_try_input exhausted its ${GAME_TRY_INPUT_BOUNDS.maxCalls} calls for this session.`,
            );
          // Reserve before launching: failures and restarts cannot reset the session's cost.
          yield* attempt("reserve game input call", budgetFile, () =>
            writeJsonAtomic(budgetFile, calls + 1),
          );
          if (buildId === undefined)
            return yield* invalid(
              "No exported build is available. Export the game before trying input.",
            );
          const bound = yield* rounds.exported(root, buildId);
          if (bound === null)
            return yield* invalid(`Build ${buildId} has no recorded source binding.`);
          const viewport =
            match?.record.playViewport ??
            playedViewport(bound.playtest?.viewport, bound.playtest?.captureScale);
          const playInput = {
            steps: input.steps,
            captureEveryMs: input.captureEveryMs ?? 1000,
            captureAllSteps: true,
            ...(viewport == null ? {} : { width: viewport.width, height: viewport.height }),
          };
          const result = yield* game.value
            .webPlaytestBuild(
              targetThreadId,
              buildId,
              playInput,
              NodePath.join(options.stateDir, "game-input-experiments", NodeCrypto.randomUUID()),
            )
            .pipe(
              Effect.timeoutOrElse({
                duration: GAME_TRY_INPUT_BOUNDS.maxRunMs,
                orElse: () =>
                  Effect.fail(
                    invalid(
                      `game_try_input exceeded its ${GAME_TRY_INPUT_BOUNDS.maxRunMs} ms run deadline.`,
                    ),
                  ),
              }),
            );
          if (result.screenshots.length > GAME_TRY_INPUT_BOUNDS.maxFrames)
            return yield* invalid(
              `game_try_input produced ${result.screenshots.length} frames; limit is ${GAME_TRY_INPUT_BOUNDS.maxFrames}.`,
            );
          if (match === null) return result;
          const directory = match.record.evidenceDirectory!;
          if (
            (yield* attempt("hash game review evidence", directory, () =>
              hashEvidenceDirectory(directory),
            )) !== match.record.evidenceHash
          )
            return yield* invalid(
              "The evidence changed during active input; its frames cannot be recorded.",
            );
          const evidence = match.record.evidence!;
          const frames = result.screenshots.map((frame, index) => ({
            id: `try${calls + 1}f${index + 1}`,
            file: `frames/try-${calls + 1}-${index + 1}.png`,
            sourceId: `try-${calls + 1}-${index + 1}`,
            label: frame.label,
            ...(frame.inputPair === undefined ? {} : { inputPair: frame.inputPair }),
          }));
          const nextEvidence = { ...evidence, frames: [...evidence.frames, ...frames] };
          yield* attempt("record active critic evidence", directory, async () => {
            for (const [index, frame] of result.screenshots.entries())
              await NodeFSP.writeFile(
                NodePath.join(directory, frames[index]!.file),
                Buffer.from(frame.data, "base64"),
              );
            await writeJsonAtomic(NodePath.join(directory, `try-${calls + 1}.json`), {
              buildId,
              steps: input.steps,
              captureEveryMs: playInput.captureEveryMs,
              ...result,
              screenshots: frames,
            });
            await writeJsonAtomic(NodePath.join(directory, EVIDENCE_MANIFEST), {
              ...nextEvidence,
              frames: nextEvidence.frames.map(({ sourceId: _sourceId, ...frame }) => frame),
            });
          });
          const hash = yield* attempt("hash active critic evidence", directory, () =>
            hashEvidenceDirectory(directory),
          );
          yield* writeRecord(root, match.key, {
            ...match.record,
            evidence: nextEvidence,
            evidenceHash: hash,
          });
          if (priorTool !== null)
            yield* attempt("bind active critic answer", directory, () =>
              writeJsonAtomic(
                // The answer continues to validate the complete, server-extended evidence tree.
                NodePath.join(NodePath.dirname(directory), "tool-answer.json"),
                { ...priorTool, evidenceHash: hash },
              ),
            );
          return {
            ...result,
            screenshots: result.screenshots.map((frame, index) => ({
              ...frame,
              frameId: frames[index]!.id,
            })),
          };
        }),
      );

    const toolRole: GameReviewSessions["Service"]["toolRole"] = (caller) =>
      callerLock(caller).withPermits(1)(
        Effect.gen(function* () {
          const match = yield* matchingCaller(caller);
          if (match === null) return null;
          const file = yield* toolFile(match.key.root, match.key);
          const previous = yield* readToolRecord(file);
          if (previous !== null) {
            if (
              previous.runId !== match.runId ||
              previous.evidenceHash !== match.record.evidenceHash ||
              previous.raw !== null ||
              previous.attempts >= 3
            )
              return null;
          } else {
            // A successful MCP connection proves this provider can use the tool;
            // printed JSON is a fallback only for sessions that never got tools.
            yield* attempt("offer game review tool", file, () =>
              writeJsonAtomic(file, {
                runId: match.runId,
                evidenceHash: match.record.evidenceHash,
                attempts: 0,
                raw: null,
                error: null,
              }),
            );
          }
          return match.key.role;
        }),
      );

    const report: GameReviewSessions["Service"]["report"] = (caller, role, value) =>
      callerLock(caller).withPermits(1)(
        Effect.gen(function* () {
          const match = yield* matchingCaller(caller);
          const refused = (error: string): GameReviewReportResult => ({
            accepted: false,
            error,
            attemptsRemaining: 0,
            ended: true,
          });
          if (match === null || match.key.role !== role)
            return refused(
              "This tool is only available to its matching active internal review child run.",
            );
          const { key, record, runId } = match;
          const file = yield* toolFile(key.root, key);
          const previous = yield* readToolRecord(file);
          if (
            previous !== null &&
            (previous.runId !== runId || previous.evidenceHash !== record.evidenceHash)
          )
            return refused("The recorded answer belongs to another run or evidence hash.");
          if (previous?.raw !== null && previous?.raw !== undefined)
            return refused("The first valid answer is already recorded; this session has ended.");
          if ((previous?.attempts ?? 0) >= 3)
            return refused("The review session exhausted its three answer attempts.");
          const hash =
            record.evidenceDirectory === null
              ? null
              : yield* attempt("hash game review evidence", record.evidenceDirectory, () =>
                  hashEvidenceDirectory(record.evidenceDirectory!),
                ).pipe(Effect.orElseSucceed(() => null));
          if (hash === null || hash !== record.evidenceHash)
            return refused(
              "The evidence changed after this child started; its answer cannot be trusted.",
            );
          const known = {
            frameIds: new Set(record.evidence?.frames.map((frame) => frame.id)),
            checkIds: new Set(record.evidence?.checks.map((check) => check.id)),
            itemIds: record.itemIds,
            defectIds: record.defectIds ?? [],
          };
          const parsed = (() => {
            if (role === "critic") {
              const decoded = decodeStrict(GameReviewCriticAnswer, value, role, true);
              return decoded.kind === "invalid"
                ? decoded
                : parseCriticAnswer(JSON.stringify(decoded.answer), known);
            }
            const decoded = decodeStrict(GameReviewBallotInput, value, role, true);
            if (decoded.kind === "invalid") return decoded;
            const { works, look, feel, play, ...rest } = decoded.answer;
            return parseBallotAnswer(
              JSON.stringify({ main: { works, look, feel, play }, ...rest }),
              known,
            );
          })();
          const raw = parsed.kind === "valid" ? encodeReviewAnswer(parsed.answer) : null;
          const accepted = parsed.kind === "valid";
          const attempts = (previous?.attempts ?? 0) + 1;
          const error = parsed.kind === "invalid" ? parsed.reason : null;
          yield* attempt("record game review tool answer", file, () =>
            writeJsonAtomic(file, {
              runId,
              evidenceHash: record.evidenceHash,
              attempts,
              raw: accepted ? raw : null,
              error,
            }),
          );
          const ended = accepted || attempts === 3;
          if (ended)
            yield* threads
              .dispatch({
                type: "run.interrupt",
                commandId: CommandId.make(`${record.commandId}:answer-ended`),
                threadId: caller.threadId,
                runId,
                reason: accepted
                  ? "The review answer was recorded."
                  : "The review exhausted three answer attempts.",
              })
              .pipe(
                Effect.mapError((cause) =>
                  threadFailure("end game review session", caller.threadId, cause),
                ),
              );
          return { accepted, error, attemptsRemaining: accepted ? 0 : 3 - attempts, ended };
        }),
      );

    const runStatus: GameReviewSessions["Service"]["runStatus"] = (input) =>
      Effect.gen(function* () {
        const order = input.order ?? 0;
        const root = yield* projects.resolve(input.threadId);
        const record = yield* readRecord(root, {
          loopId: input.loopId,
          roundId: input.roundId,
          role: input.role,
          order,
        });
        if (record === null) return { kind: "missing" } as const;
        const childThreadId = ThreadIdSchema.make(record.childThreadId);
        const records = yield* threads
          .getThreadRecords(childThreadId, ["runs"])
          .pipe(
            Effect.mapError((cause) =>
              threadFailure("read game review status", record.childThreadId, cause),
            ),
          );
        const messageId = IdAllocator.derive.delegatedTaskMessage({
          commandId: CommandId.make(record.commandId),
        });
        const run =
          record.runId === undefined || record.runId === null
            ? records.runs.find((candidate) => candidate.userMessageId === messageId)
            : records.runs.find((candidate) => candidate.id === record.runId);
        if (run === undefined) return { kind: "pending", runId: null } as const;
        const terminalStatus =
          run.status === "completed" ||
          run.status === "failed" ||
          run.status === "cancelled" ||
          run.status === "interrupted" ||
          run.status === "rolled_back"
            ? run.status
            : null;
        return terminalStatus === null
          ? ({ kind: "pending", runId: run.id } as const)
          : ({ kind: "terminal", runId: run.id, status: terminalStatus } as const);
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
        // Read the bound terminal answer first. Only then hash the evidence:
        // a child that changes a frame and finishes in between is caught,
        // because the accepted answer and the hash describe the same final
        // tree.
        const tool = yield* readToolRecord(yield* toolFile(root, { ...input, order }));
        const read = yield* readChildAnswerText(record, tool);
        if (read.kind === "pending") return { kind: "pending" };
        if (read.kind === "invalid") return read;
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
        const known = {
          frameIds: new Set(evidence.frames.map((frame) => frame.id)),
          checkIds: new Set(evidence.checks.map((check) => check.id)),
          itemIds: record.itemIds,
          defectIds: record.defectIds ?? [],
        };
        const parsed =
          record.role === "critic"
            ? parseCriticAnswer(read.text, known)
            : parseBallotAnswer(read.text, known);
        if (parsed.kind === "invalid") {
          const bounded = boundRawAnswer(read.text);
          return {
            kind: "invalid",
            reason: parsed.reason,
            raw: bounded.raw,
            truncated: bounded.truncated,
          };
        }
        return record.role === "critic"
          ? { kind: "critic", answer: parsed.answer as GameReviewCriticAnswer, raw: read.text }
          : { kind: "ballot", answer: parsed.answer as GameReviewBallotAnswer, raw: read.text };
      });

    const experiments: GameReviewSessions["Service"]["experiments"] = (input) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(input.threadId);
        const record = yield* readRecord(root, {
          loopId: input.loopId,
          roundId: input.roundId,
          role: "critic",
          order: 0,
        });
        if (record === null || record.evidenceDirectory === null || record.evidenceHash === null)
          return [];
        const hash = yield* attempt("hash game review evidence", record.evidenceDirectory, () =>
          hashEvidenceDirectory(record.evidenceDirectory!),
        ).pipe(Effect.orElseSucceed(() => null));
        if (hash !== record.evidenceHash)
          return yield* failure(
            "game review experiments",
            record.evidenceDirectory,
            "invalid-input",
            "The evidence changed after this child started; its cited experiments cannot be replayed.",
          );
        const byExperiment = new Map<number, Set<string>>();
        for (const frameId of new Set(input.frameIds)) {
          const match = EXPERIMENT_FRAME_ID.exec(frameId);
          if (match === null) continue;
          const call = Number(match[1]);
          const ids = byExperiment.get(call) ?? new Set<string>();
          ids.add(frameId);
          byExperiment.set(call, ids);
        }
        const routes: GameReviewExperimentRoute[] = [];
        for (const [call, frameIds] of [...byExperiment].toSorted(
          ([left], [right]) => left - right,
        )) {
          const file = NodePath.join(record.evidenceDirectory, `try-${call}.json`);
          const value = yield* attempt("read game review experiment", file, () => readJson(file));
          if (value === null) continue;
          const stored = yield* decodeStoredExperiment(value).pipe(
            Effect.mapError((cause) =>
              failure("read game review experiment", file, "io", undefined, cause),
            ),
          );
          const frames = stored.screenshots
            .filter((frame) => frameIds.has(frame.id))
            .map((frame) => ({
              frameId: frame.id,
              label: frame.label,
              stepIndex: experimentStepIndex(frame),
            }));
          if (frames.length === 0) continue;
          routes.push({
            id: `try-${call}`,
            buildId: stored.buildId,
            steps: stored.steps,
            captureEveryMs: stored.captureEveryMs,
            viewport:
              playedViewport(stored.baseViewport, stored.captureScale) ??
              record.playViewport ??
              null,
            frames,
          });
        }
        return routes;
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

    const recordedChildren: GameReviewSessions["Service"]["recordedChildren"] = (input) =>
      Effect.gen(function* () {
        const directory = NodePath.join(yield* reviewRoot(input.root), encodePart(input.loopId));
        const files = yield* attempt("list game review sessions", directory, async () => {
          const list = async (path: string) =>
            NodeFSP.readdir(path).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT" || error.code === "ENOTDIR") return [] as string[];
              throw error;
            });
          const found: string[] = [];
          for (const round of await list(directory))
            for (const session of await list(NodePath.join(directory, round)))
              found.push(NodePath.join(directory, round, session, "session.json"));
          return found;
        });
        const children: GameReviewRecordedChild[] = [];
        for (const file of files) {
          const value = yield* attempt("read game review session", file, () =>
            readJson(file).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOTDIR") return null;
              throw error;
            }),
          );
          if (value === null) continue;
          const record = yield* Effect.try({
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
          children.push({
            role: record.role,
            childThreadId: ThreadIdSchema.make(record.childThreadId),
            runId: record.runId == null ? null : RunId.make(record.runId),
          });
        }
        return children;
      });

    const describe: GameReviewSessions["Service"]["describe"] = (input) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(input.threadId);
        const record = yield* readRecord(root, { ...input, order: input.order ?? 0 });
        if (
          record?.evidenceDirectory == null ||
          record.evidence === null ||
          record.role === "repair"
        )
          return null;
        return {
          role: record.role,
          order: record.order,
          directory: record.evidenceDirectory,
          childThreadId: ThreadIdSchema.make(record.childThreadId),
          runId: record.runId ?? null,
          taskId: record.taskId,
          hash: record.evidenceHash,
          frames: record.evidence.frames.map((frame) => ({
            id: frame.id,
            label: frame.label,
            ...(frame.inputPair === undefined ? {} : { inputPair: frame.inputPair }),
            path: NodePath.join(record.evidenceDirectory!, frame.file),
          })),
        };
      });
    return GameReviewSessions.of({
      describe,
      inputCalls,
      tryInput,
      start,
      toolRole,
      report,
      answer,
      experiments,
      runStatus,
      evidenceDirectory,
      evidenceHash,
      recordedChildren,
    });
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
