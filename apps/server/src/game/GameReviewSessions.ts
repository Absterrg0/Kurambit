// @effect-diagnostics nodeBuiltinImport:off -- Evidence directories and session records live on the native filesystem outside the game.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CommandId,
  END_STATE_EVIDENCE_POLICY_VERSION,
  END_STATE_OBSERVATION_MAX_KEYS,
  endStateEligibleRequirements,
  type GameReviewEndStateRequirement,
  GAME_TRY_INPUT_BOUNDS,
  tryInputIssues,
  type GameReviewDetailInput,
  type GameReviewDetailResult,
  GAME_REVIEW_DETAIL_BOUNDS,
  type GameTryInput,
  type GameWebPlaytestResult,
  GAME_REVIEW_ANSWER_MAX_BYTES,
  GameOperationError,
  GameReviewBallotAnswer,
  GameReviewBallotInput,
  type GameReviewReportResult,
  GameReviewCriticAnswer,
  GAME_REVIEW_QUALITY_DIMENSIONS,
  GAME_REVIEW_QUALITY_RUBRIC_VERSION,
  gameReviewQualityCoverage,
  GameReviewCheck,
  type GameReviewExperimentRoute,
  GamePlaytestInputPair,
  GamePlaytestStep,
  GameViewport,
  pickEndStateObservations,
  satisfiesEndStateExpect,
  type GameAcceptanceCriterion,
  type GameReviewDefect,
  type GameReviewDoNotRegress,
  type GameReviewRequirementAssessment,
  type GameReviewRequirementDowngrade,
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
import { PNG } from "pngjs";
import {
  composeSideBySidePng,
  cropPng,
  deltaStats,
  meanColor,
  scalePngNearest,
} from "./frameCompose.ts";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import { gameRecordFile, realGameRoot } from "./gameRecord.ts";
import { gameRecipeIds } from "./recipeCatalog.ts";
import {
  type GameReviewPromptDefect,
  builderFixPrompt,
  criticPrompt,
  pairwisePrompt,
} from "./gameReviewPrompts.ts";
import { playedViewport, playtestIntervalObservation } from "./playtestEvidence.ts";
import { composePairFiles } from "./frameCompose.ts";

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
  /** The capture window the source pixels came from, when the run knew it. */
  readonly width?: number;
  readonly height?: number;
  /**
   * Bounded measured GameState scalars nearest this frame. The session
   * filters them to the frozen approved keys; unapproved keys never reach
   * the frozen record.
   */
  readonly observations?: Record<string, number | boolean>;
  /**
   * When set, the writer composes both captures into one labelled side-by-side
   * card and keeps the two originals beside it; `sourcePath` is the before one.
   */
  readonly pair?: {
    readonly beforePath: string;
    readonly afterPath: string;
    readonly caption: string;
  };
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
  /**
   * Optional frozen audio measurement the critic may judge audio from. When
   * absent the critic's audio stays cannot-tell: screenshots alone prove
   * nothing about sound. The binding names the exact measured file, its
   * source identity, and whether it is native-mixer or exported-Web audio.
   */
  readonly audioEvidence?:
    | {
        readonly path: string;
        readonly kind: "asset" | "native-clip";
        readonly sourceId: string | null;
        readonly scope: string;
        readonly frameId?: string | undefined;
      }
    | undefined;
  /**
   * Optional same-source native layout hints the critic may use to decide
   * where to look with game_try_input on Web frames. Hints are never proof
   * of a Web defect, never a repair defect, and never a quality pass: the
   * critic still judges the frozen Web frames and its own experiments.
   */
  readonly nativeDiagnostics?:
    | {
        readonly sourceId: string;
        readonly evidenceDirectory: string;
        readonly text: string;
      }
    | undefined;
  /**
   * Optional same-source native world measurements the critic may use to
   * decide where to look with game_try_input on Web frames. Portable
   * world-space numbers only, never proof of a Web defect, never a repair
   * defect, and never a quality pass. Absent, stale, missing or truncated
   * stays honest unknown.
   */
  readonly nativeWorld?:
    | {
        readonly sourceId: string;
        readonly evidenceDirectory: string;
        readonly text: string;
      }
    | undefined;
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
  | {
      readonly kind: "critic";
      readonly answer: GameReviewCriticAnswer;
      readonly raw: string;
      readonly qualityRubricVersion?: number;
    }
  | { readonly kind: "ballot"; readonly answer: GameReviewBallotAnswer; readonly raw: string }
  /** The child has not produced a terminal answer yet. */
  | { readonly kind: "pending" }
  | {
      readonly kind: "invalid";
      readonly reason: string;
      readonly raw: string | null;
      /** True when raw was cut to the stored-output limit. */
      readonly truncated?: boolean;
      /** True when the tool record shows three attempts with no valid answer. */
      readonly exhausted?: boolean;
    };

interface SessionKey {
  readonly loopId: string;
  readonly roundId: string;
  readonly role: GameReviewTaskRole;
  readonly order: number;
}

const FRAME_FILE = (index: number) => `frames/frame-${String(index + 1).padStart(2, "0")}.png`;
const PAIR_SOURCE_FILE = (index: number, phase: "before" | "after") =>
  `frames/source/frame-${String(index + 1).padStart(2, "0")}-${phase}.png`;
const EVIDENCE_MANIFEST = "evidence.json";
const BRIEF_FILE = "BRIEF.md";
/** Bounded approved acceptance, so reviewers and repairers see the same promises. */
const DESIGN_REQUIREMENTS_FILE = "DESIGN_REQUIREMENTS.md";
/** Frozen audio binding the critic may judge audio from; absent means cannot-tell. */
const AUDIO_EVIDENCE_FILE = "AUDIO_EVIDENCE.json";
/** Same-source native layout hints: where to look on Web frames, never Web proof. */
const NATIVE_DIAGNOSTICS_FILE = "NATIVE_DIAGNOSTICS.md";
/** Critic-file budget for the native hints; the formatter already bounds them. */
const MAX_NATIVE_DIAGNOSTICS_CHARS = 3_000;
/** Same-source native world measurements: world-space numbers, never Web proof. */
const NATIVE_WORLD_FILE = "NATIVE_WORLD.json";
/** Critic-file budget for the native world; the formatter already bounds it. */
const MAX_NATIVE_WORLD_CHARS = 32_768;
/** Structured copy of the same promises, so no reader parses the Markdown. */
const DESIGN_REQUIREMENTS_JSON = "DESIGN_REQUIREMENTS.json";
const END_STATE_REQUIREMENTS_FILE = "END_STATE_REQUIREMENTS.json";
const MAX_DESIGN_REQUIREMENT_CRITERIA = 12;
const MAX_DESIGN_REQUIREMENT_TEXT = 400;
/** Total markdown budget: full normal acceptance fits, genuine overflow is marked. */
const MAX_DESIGN_REQUIREMENTS_CHARS = 4_000;
// Four slots, each with up to 45 cited pairs, their observations and six frozen-route frames.
const MAX_FRAMES = 564;
const MAX_CHECKS = 64;

const ReviewFrameRecord = Schema.Struct({
  inputPair: Schema.optionalKey(GamePlaytestInputPair),
  /** The manifest id the child cites: f1, f2, ... */
  id: Schema.String,
  file: Schema.String,
  sourceId: Schema.String,
  label: Schema.String,
  /** The capture window, so one evidence folder can carry more than one size. */
  width: Schema.optionalKey(Schema.Number),
  height: Schema.optionalKey(Schema.Number),
  /** Bounded approved numeric/boolean scalars measured nearest this frame. */
  observations: Schema.optionalKey(
    Schema.Record(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
      Schema.Union([Schema.Finite, Schema.Boolean]),
    ),
  ),
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
  /** Uncaptured prelude, when the critic used one; absent on legacy records. */
  setupSteps: Schema.optionalKey(Schema.Array(GamePlaytestStep)),
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
  /** Frozen requirement ids the critic must assess; absent on legacy records. */
  requirementIds: Schema.optionalKey(Schema.Array(Schema.String)),
  incompleteRequirementIds: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Frozen markdown the round started with; reused for repair and ballots. */
  designRequirements: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Whether frozen audio evidence was attached; audio stays cannot-tell without it. */
  hasAudioEvidence: Schema.optionalKey(Schema.Boolean),
  /** Whether same-source native layout hints were attached; hints are never verdicts. */
  hasNativeDiagnostics: Schema.optionalKey(Schema.Boolean),
  /** Whether same-source native world measurements were attached; never verdicts. */
  hasNativeWorld: Schema.optionalKey(Schema.Boolean),
  /** The frozen quality rubric version this session answers against; absent on legacy records. */
  qualityRubricVersion: Schema.optionalKey(Schema.Number),
  /** Structured copy of the frozen markdown; reused without parsing markdown. */
  designRequirementsJson: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** True when the frozen markdown marks incomplete coverage. */
  designTruncated: Schema.optionalKey(Schema.Boolean),
  /**
   * Frozen temporal-evidence policy version; absent on legacy records and on
   * games without an approved design, which stay compatible and skip the
   * before/after witness check. Version 1 requires an approved stateful
   * (control/mechanic/content/win/lose with observe) yes to cite a matching
   * ordinary-input before/after pair, never a static final frame alone.
   */
  temporalPolicyVersion: Schema.optionalKey(Schema.Number),
  /** Eligible requirement ids the temporal policy applies to, frozen with the round. */
  temporalRequirementIds: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Frozen coverage-attempt policy version; absent on legacy records and on
   * games without an approved design, which stay compatible and skip the
   * one-attempt work rule. Reuses the frozen temporalRequirementIds
   * eligibility, never keyword rules.
   */
  coverageAttemptPolicyVersion: Schema.optionalKey(Schema.Number),
  /**
   * Frozen end-state evidence policy version; absent on legacy records and
   * on games without an approved design, which stay compatible and skip the
   * measured-transition plus counterexample check. Version 1 requires a
   * frozen win/lose yes to show its own measured after-satisfying
   * transition with a non-terminal before, plus a separate ordinary-play
   * counterexample experiment where the same predicate stays unsatisfied.
   * Version 2 requires fully non-terminal before/challenge across all
   * frozen predicates and no opposite-kind after (same-kind simultaneous
   * completion stays allowed).
   */
  endStatePolicyVersion: Schema.optionalKey(Schema.Number),
  /** Frozen win/lose promises with their approved key/expect, never mutable DESIGN. */
  endStateRequirements: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        kind: Schema.Literals(["win", "lose"]),
        key: Schema.String,
        expect: Schema.String,
      }),
    ),
  ),
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

export interface BoundDesignRequirements {
  /** The markdown the child reads. */
  readonly markdown: string;
  /** The same promises as structured data, never parsed from the markdown. */
  readonly requirements: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly text: string;
    readonly incomplete?: boolean;
  }>;
  /** True when text was cut or criteria omitted; the markdown names the gap. */
  readonly truncated: boolean;
  /** How many approved criteria did not fit the bound. */
  readonly omitted: number;
}

/**
 * Bounded approved acceptance for review children: id, kind and player-facing
 * text only, never observe keys or agent instructions. Null when no approved
 * design binds (legacy, skipped or draft), so those games review exactly as
 * before. The approved record binds, not the editable BRIEF.md: prose edits
 * never change the exam, and an unapproved revision never reaches a reviewer.
 *
 * Full normal text is preserved within the total budget; genuine overflow is
 * explicitly marked as incomplete coverage instead of silently dropping a
 * clause, a criterion, or marking it met.
 */
export const boundDesignRequirements = (
  acceptance: readonly GameAcceptanceCriterion[],
): BoundDesignRequirements | null => {
  const usable = acceptance.filter(
    (criterion) => criterion.id.trim() !== "" && criterion.text.trim() !== "",
  );
  if (usable.length === 0) return null;
  const kept = usable.slice(0, MAX_DESIGN_REQUIREMENT_CRITERIA);
  const omitted = usable.length - kept.length;
  const header =
    "Approved acceptance promises (judge observable ones from frames; use game_try_input when unsure):\n";
  const notice = `Coverage incomplete: ${omitted} criteria omitted; assess every shortened promise as cannot-tell, never as met.\n`;
  const prefixes = kept.map((criterion) => `- [${criterion.kind}] ${criterion.id}: `);
  // Reserve the notice and every id before allocating text: cutting the final
  // markdown could hide a required id or the warning itself.
  const available =
    MAX_DESIGN_REQUIREMENTS_CHARS -
    header.length -
    notice.length -
    prefixes.reduce((sum, prefix) => sum + prefix.length, 0) -
    kept.length * 15;
  const textLimit = Math.max(
    0,
    Math.min(MAX_DESIGN_REQUIREMENT_TEXT, Math.floor(available / kept.length)),
  );
  const requirements = kept.map((criterion) => {
    const flat = criterion.text.replace(/\s+/g, " ").trim();
    const incomplete = flat.length > textLimit;
    return {
      id: criterion.id,
      kind: criterion.kind,
      text: incomplete ? `${flat.slice(0, Math.max(0, textLimit - 1))}…` : flat,
      incomplete,
    };
  });
  const truncated = omitted > 0 || requirements.some((criterion) => criterion.incomplete);
  const lines = requirements.map(
    (criterion, index) =>
      `${prefixes[index]}${criterion.text}${criterion.incomplete ? " [truncated]" : ""}`,
  );
  const markdown = header + (truncated ? notice : "") + lines.join("\n") + "\n";
  return { markdown, requirements, truncated, omitted };
};

export const renderDesignRequirements = (
  acceptance: readonly GameAcceptanceCriterion[],
): string | null => boundDesignRequirements(acceptance)?.markdown ?? null;

/** Structured copy of the frozen bound, encoded outside any Effect. */
export const encodeDesignRequirementsJson = (bound: BoundDesignRequirements): string =>
  `{"requirements":${JSON.stringify(bound.requirements)},"truncated":${bound.truncated ? "true" : "false"},"omitted":${bound.omitted}}`;

/**
 * Temporal-evidence policy version frozen with new sessions. Version 1 is the
 * only version: an approved stateful requirement with observe cannot be yes
 * from a static final frame alone.
 */
export const TEMPORAL_EVIDENCE_POLICY_VERSION = 1;

/**
 * Coverage-attempt policy version frozen with new sessions. Version 1 is the
 * only version: before an otherwise no-defect critic review can end while an
 * eligible stateful (control/mechanic/content/win/lose with observe)
 * requirement stays cannot-tell and the build boots, the critic owes at least
 * one bounded game_try_input attempt. One attempt satisfies every unknown;
 * a failed bounded attempt may still abstain, and cannot-tell stays neutral.
 */
export const COVERAGE_ATTEMPT_POLICY_VERSION = 1;

/** Re-exported for session tests: frozen win/lose eligibility without heavy services. */
export { endStateEligibleRequirements };

/** Requirement kinds the temporal policy can apply to; presentation never does. */
const TEMPORAL_ELIGIBLE_KINDS = new Set(["control", "mechanic", "content", "win", "lose"]);

/**
 * Eligible ids from the actual approved criteria: stateful kinds with an
 * observe binding. Presentation and observe-less promises are never eligible;
 * a no-lose declaration has no observe and is excluded the same way. Pure so
 * both the session freeze and the parser share one definition.
 */
export const temporalEligibleRequirementIds = (
  acceptance: ReadonlyArray<GameAcceptanceCriterion>,
): ReadonlyArray<string> =>
  acceptance
    .filter(
      (criterion) => TEMPORAL_ELIGIBLE_KINDS.has(criterion.kind) && criterion.observe !== undefined,
    )
    .map((criterion) => criterion.id);

const isOrdinaryReviewInput = (input: GamePlaytestStep): boolean =>
  !("waitMs" in input) && !("screenshot" in input);

const reviewFrameExperiment = (frameId: string): string => {
  const match = EXPERIMENT_FRAME_ID.exec(frameId);
  return match === null ? "base" : `try-${match[1]}`;
};

export interface TemporalEvidenceFrame {
  readonly id: string;
  readonly inputPair?: {
    readonly stepIndex: number;
    readonly phase: "before" | "after";
    readonly input: GamePlaytestStep;
  };
  readonly width?: number;
  readonly height?: number;
  /** Bounded approved numeric/boolean scalars measured nearest this frame. */
  readonly observations?: Record<string, number | boolean>;
}

/**
 * Whether the cited ids contain one matching ordinary-input before/after
 * witness from the frozen evidence. Matching means the same experiment
 * provenance (no cross-experiment or base/try mixing), the same step index,
 * the same input signature and bytes (no holdMs aliasing), one before phase
 * and one after phase on two distinct frames, both ordinary inputs (waits and
 * screenshots never count), and the same capture size when both record one.
 * Duplicated ids, two befores, two afters, unrelated steps, or source-less
 * frames never satisfy. A pair is minimum structural evidence only: it does
 * not prove the named condition/effect by itself.
 */
export const hasMatchingOrdinaryInputPair = (
  citedIds: ReadonlyArray<string>,
  evidenceFrames: ReadonlyArray<TemporalEvidenceFrame>,
): boolean => {
  const byId = new Map(evidenceFrames.map((frame) => [frame.id, frame]));
  const distinct = [...new Set(citedIds)];
  for (let leftIndex = 0; leftIndex < distinct.length; leftIndex++) {
    const left = byId.get(distinct[leftIndex]!);
    if (left?.inputPair === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < distinct.length; rightIndex++) {
      const right = byId.get(distinct[rightIndex]!);
      if (right?.inputPair === undefined) continue;
      const leftPair = left.inputPair;
      const rightPair = right.inputPair;
      if (leftPair.phase === rightPair.phase) continue;
      if (leftPair.stepIndex !== rightPair.stepIndex) continue;
      if (reviewFrameExperiment(left.id) !== reviewFrameExperiment(right.id)) continue;
      if (!isOrdinaryReviewInput(leftPair.input) || !isOrdinaryReviewInput(rightPair.input))
        continue;
      if (JSON.stringify(leftPair.input) !== JSON.stringify(rightPair.input)) continue;
      if (left.width !== undefined && right.width !== undefined && left.width !== right.width)
        continue;
      if (left.height !== undefined && right.height !== undefined && left.height !== right.height)
        continue;
      return true;
    }
  }
  return false;
};

/**
 * Eligible cannot-tell ids behind the coverage-attempt work rule. Pure so
 * the report-tool and terminal-answer paths share one definition: only
 * frozen temporal-eligible (stateful with observe) promises count, never
 * presentation or audio-only unknowns.
 */
export const coverageAttemptUnknownIds = (
  answer: GameReviewCriticAnswer,
  eligibleIds: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (answer.requirements === undefined) return [];
  const eligible = new Set(eligibleIds);
  return answer.requirements
    .filter((entry) => entry.verdict === "cannot-tell" && eligible.has(entry.id))
    .map((entry) => entry.id);
};

/**
 * All structurally matching ordinary-input pairs within the cited ids.
 * Returns before/after frame pairs in phase order. Pure so the positive and
 * the challenge use the same structural definition as the temporal witness.
 */
const matchingOrdinaryInputPairs = (
  citedIds: ReadonlyArray<string>,
  evidenceFrames: ReadonlyArray<TemporalEvidenceFrame>,
): ReadonlyArray<{
  readonly before: TemporalEvidenceFrame;
  readonly after: TemporalEvidenceFrame;
}> => {
  const byId = new Map(evidenceFrames.map((frame) => [frame.id, frame]));
  const distinct = [...new Set(citedIds)];
  const pairs: Array<{
    readonly before: TemporalEvidenceFrame;
    readonly after: TemporalEvidenceFrame;
  }> = [];
  for (let leftIndex = 0; leftIndex < distinct.length; leftIndex++) {
    const left = byId.get(distinct[leftIndex]!);
    if (left?.inputPair === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < distinct.length; rightIndex++) {
      const right = byId.get(distinct[rightIndex]!);
      if (right?.inputPair === undefined) continue;
      const leftPair = left.inputPair;
      const rightPair = right.inputPair;
      if (leftPair.phase === rightPair.phase) continue;
      if (leftPair.stepIndex !== rightPair.stepIndex) continue;
      if (reviewFrameExperiment(left.id) !== reviewFrameExperiment(right.id)) continue;
      if (!isOrdinaryReviewInput(leftPair.input) || !isOrdinaryReviewInput(rightPair.input))
        continue;
      if (JSON.stringify(leftPair.input) !== JSON.stringify(rightPair.input)) continue;
      if (left.width !== undefined && right.width !== undefined && left.width !== right.width)
        continue;
      if (left.height !== undefined && right.height !== undefined && left.height !== right.height)
        continue;
      pairs.push(
        leftPair.phase === "before"
          ? { before: left, after: right }
          : { before: right, after: left },
      );
    }
  }
  return pairs;
};

const observedScalar = (
  frame: TemporalEvidenceFrame,
  key: string,
): number | boolean | undefined => {
  const raw = frame.observations?.[key];
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return undefined;
};

/**
 * The shared end-state guard: both the tool report and the terminal answer
 * validate through here. For every frozen win/lose yes it requires a matched
 * ordinary-input transition whose after scalar satisfies the frozen
 * key/expect with a non-terminal before, plus a separate ordinary-play
 * counterexample experiment whose paired after stays unsatisfied. Missing
 * scalars, wrong counters, static final frames, text-only claims, same-pair
 * or same-experiment challenges, and challenges that themselves reach the end
 * state all fail, so the critic must use cannot-tell when the evidence cannot
 * show the trigger. Version 2 (frozen as endStatePolicyVersion) additionally
 * requires the positive before and every challenge before/after to be fully
 * non-terminal across all frozen predicates, and forbids the positive after
 * from satisfying any opposite-kind (win vs lose) predicate; same-kind
 * predicates may describe the same ending and stay allowed after. Missing any
 * relevant scalar fails closed to cannot-tell. Returns the first refusal
 * reason, or null when valid.
 * Opt-in: absent frozen end-state requirements skip the check entirely.
 * Legacy version 1 records keep the own-predicate-only rule.
 */
/**
 * Shared wording for the temporal witness refusal, so the report path and the
 * last-attempt downgrade emit the same reason. A finished state never proves
 * its trigger; the model must use cannot-tell when the witness is unavailable.
 */
const temporalRefusalReason = (entryId: string): string =>
  `Requirement ${entryId}=yes needs a matching ordinary-input before/after witness from the frozen evidence; a finished state never proves its trigger, use cannot-tell when unavailable.`;

/** Shared wording for omitted or partially assessed requirements. */
const missingRequirementsReason = (ids: ReadonlyArray<string>): string =>
  `The critic did not assess requirements: ${ids.join(", ")}.`;

/**
 * One frozen win/lose yes against its own evidence, without the attempt-count
 * suffix. Returns the base evidence reason with which side of the rule failed,
 * or null when this entry passes. The report path appends the suffix; the
 * last-attempt downgrade reuses the base reason as the cannot-tell note.
 */
const endStateEntryRefusal = (
  entry: GameReviewRequirementAssessment,
  requirement: GameReviewEndStateRequirement,
  input: {
    readonly frameIds: ReadonlySet<string>;
    readonly frames: ReadonlyArray<TemporalEvidenceFrame>;
    readonly frozen: ReadonlyArray<GameReviewEndStateRequirement>;
    readonly isV2: boolean;
  },
): { readonly reason: string; readonly positive: boolean } | null => {
  const { frameIds, frames, frozen, isV2 } = input;
  const positive = (reason: string) => ({ reason, positive: true as const });
  const negative = (reason: string) => ({ reason, positive: false as const });
  // Positive: one matched transition with measured after-satisfying and
  // non-terminal before. No arbitrary pair, wrong counter, missing scalar
  // or static final frame passes. V2 additionally requires every frozen
  // predicate measured-unsatisfied before, and no opposite-kind predicate
  // satisfied after (same-kind simultaneous completion stays allowed).
  const positivePairs = matchingOrdinaryInputPairs(entry.frameIds, frames);
  const measuredPositive = positivePairs.some((pair) => {
    const before = observedScalar(pair.before, requirement.key);
    const after = observedScalar(pair.after, requirement.key);
    if (before === undefined || after === undefined) return false;
    // A win/lose that already held before proves nothing about this input.
    if (satisfiesEndStateExpect(requirement.expect, before)) return false;
    if (!satisfiesEndStateExpect(requirement.expect, after)) return false;
    if (!isV2) return true;
    for (const other of frozen) {
      const beforeOther = observedScalar(pair.before, other.key);
      if (beforeOther === undefined) return false;
      if (satisfiesEndStateExpect(other.expect, beforeOther)) return false;
    }
    for (const other of frozen) {
      if (other.kind === requirement.kind) continue;
      const afterOther = observedScalar(pair.after, other.key);
      if (afterOther === undefined) return false;
      if (satisfiesEndStateExpect(other.expect, afterOther)) return false;
    }
    return true;
  });
  if (!measuredPositive) {
    if (!isV2)
      return positive(
        `Requirement ${entry.id}=yes needs a matched ordinary-input transition whose recorded ${requirement.key} after satisfies ${requirement.expect} with a non-terminal before; a finished state never proves its trigger, use cannot-tell when unavailable.`,
      );
    return positive(
      `Requirement ${entry.id}=yes needs a matched ordinary-input transition whose recorded ${requirement.key} after satisfies ${requirement.expect} from a fully non-terminal before across all frozen predicates, with no opposite-kind end state after; a finished or cross-terminal state never proves its trigger, use cannot-tell when unavailable.`,
    );
  }
  // Challenge: a separate ordinary-play counterpart with its own paired
  // frames where the same predicate stays unsatisfied (v1), or every
  // frozen predicate stays unsatisfied (v2). Negative outcomes
  // alone prove the predicate stayed down, not which English condition was
  // tested; the prompt orders the critic to target the named condition.
  const challenge = entry.challenge;
  if (challenge === undefined)
    return negative(
      `Requirement ${entry.id}=yes needs a separate ordinary-play counterexample experiment where ${requirement.key} stays ${requirement.expect}-unsatisfied, with which missing trigger was tested; a challenge that itself reaches that end state cannot prove the trigger necessary.`,
    );
  for (const frameId of challenge.frameIds)
    if (!frameIds.has(frameId))
      return negative(`The critic cited challenge frame ${frameId}, which is not in its manifest.`);
  const overlap = entry.frameIds.some((frameId) => challenge.frameIds.includes(frameId));
  if (overlap || challenge.frameIds.length === 0)
    return negative(
      `Requirement ${entry.id} challenge cannot reuse the positive pair; cite a separate ordinary-play counterexample experiment.`,
    );
  const positiveExperiments = new Set(entry.frameIds.map(reviewFrameExperiment));
  const challengeExperiments = new Set(challenge.frameIds.map(reviewFrameExperiment));
  const shared = [...positiveExperiments].some((experiment) =>
    challengeExperiments.has(experiment),
  );
  if (shared)
    return negative(
      `Requirement ${entry.id} challenge cannot reuse the positive experiment; cite a separate ordinary-play counterexample experiment.`,
    );
  const challengePairs = matchingOrdinaryInputPairs(challenge.frameIds, frames);
  if (challengePairs.length === 0)
    return negative(
      `Requirement ${entry.id} challenge needs its own matched ordinary-input pair from the frozen evidence; waits, screenshots and source-less frames never count.`,
    );
  if (!isV2) {
    let measuredUnsatisfied = false;
    for (const pair of challengePairs) {
      const before = observedScalar(pair.before, requirement.key);
      const after = observedScalar(pair.after, requirement.key);
      // Missing values justify cannot-tell, never a fabricated challenge.
      if (before === undefined || after === undefined)
        return negative(
          `Requirement ${entry.id} challenge has no recorded ${requirement.key} measurement; use cannot-tell when the evidence cannot show the trigger.`,
        );
      if (satisfiesEndStateExpect(requirement.expect, before))
        return negative(
          `Requirement ${entry.id} challenge starts in the end state; resetting a finished run does not test whether its trigger was necessary.`,
        );
      if (satisfiesEndStateExpect(requirement.expect, after))
        return negative(
          `Requirement ${entry.id} challenge itself reaches that end state and cannot prove the trigger necessary.`,
        );
      measuredUnsatisfied = true;
    }
    if (!measuredUnsatisfied)
      return negative(
        `Requirement ${entry.id} challenge needs a measured ordinary-play pair where ${requirement.key} stays unsatisfied.`,
      );
    return null;
  }
  for (const pair of challengePairs) {
    for (const phase of [pair.before, pair.after] as const) {
      for (const other of frozen) {
        const value = observedScalar(phase, other.key);
        if (value === undefined)
          return negative(
            `Requirement ${entry.id} challenge has no recorded ${other.key} measurement; use cannot-tell when the evidence cannot show the trigger.`,
          );
        if (satisfiesEndStateExpect(other.expect, value))
          return negative(
            phase === pair.before
              ? `Requirement ${entry.id} challenge starts in the end state (${other.id} already terminal); resetting a finished run does not test whether its trigger was necessary.`
              : `Requirement ${entry.id} challenge itself reaches that end state (${other.id} terminal) and cannot prove the trigger necessary.`,
          );
      }
    }
  }
  return null;
};

export const endStateRefusalReason = (
  answer: GameReviewCriticAnswer,
  known: {
    readonly frameIds: ReadonlySet<string>;
    readonly endStateRequirements?: ReadonlyArray<GameReviewEndStateRequirement>;
    readonly evidenceFrames?: ReadonlyArray<TemporalEvidenceFrame>;
    readonly endStatePolicyVersion?: number;
    /** Attempts left after this refusal; undefined on the terminal-answer path. */
    readonly attemptsRemaining?: number;
  },
): string | null => {
  const frozen = known.endStateRequirements;
  if (frozen === undefined) return null;
  if (answer.requirements === undefined) return null;
  // Positive refusals need a transition that reaches the end state;
  // challenge refusals need a separate experiment with the trigger
  // deliberately missing. The count rides with the refusal so the model
  // can still act before the budget runs out.
  const buildNext = (positive: boolean): string => {
    const remaining = known.attemptsRemaining;
    if (remaining === 0) return " This review session has ended.";
    const count =
      remaining === undefined
        ? ""
        : remaining === 1
          ? " 1 attempt remains."
          : ` ${remaining} attempts remain.`;
    const action = positive
      ? " Next: run game_try_input to record or cite a matched ordinary-input transition that reaches the end state and cite those frames, or set that requirement to cannot-tell."
      : " Next: run game_try_input to record a separate ordinary-play experiment with the trigger deliberately missing and cite those frames, or set that requirement to cannot-tell.";
    return `${action}${count} game_try_input stays available between refused attempts.`;
  };
  const refusePositive = (reason: string): string => `${reason}${buildNext(true)}`;
  const refuse = (reason: string): string => `${reason}${buildNext(false)}`;
  const frames = known.evidenceFrames ?? [];
  const byId = new Map(frozen.map((requirement) => [requirement.id, requirement]));
  const policyVersion = known.endStatePolicyVersion ?? 1;
  const isV2 = policyVersion >= 2;
  for (const entry of answer.requirements) {
    const requirement = byId.get(entry.id);
    if (requirement === undefined || entry.verdict !== "yes") continue;
    const hit = endStateEntryRefusal(entry, requirement, {
      frameIds: known.frameIds,
      frames,
      frozen,
      isV2,
    });
    if (hit !== null) return hit.positive ? refusePositive(hit.reason) : refuse(hit.reason);
  }
  return null;
};

/** An already actionable report ends the loop without owing a play attempt. */
const isActionableCriticAnswer = (answer: GameReviewCriticAnswer): boolean => {
  if (answer.defects.length > 0) return true;
  if (Object.values(answer.fundamentals).some((judgment) => judgment.verdict === "no")) return true;
  if ((answer.requirements ?? []).some((entry) => entry.verdict === "no")) return true;
  if (
    answer.quality !== undefined &&
    Object.values(answer.quality).some((verdict) => verdict.verdict === "no")
  )
    return true;
  return false;
};

/**
 * Actionable refusal for the work rule: names the exact unknown ids and
 * orders one focused physical attempt while keeping cannot-tell neutral when
 * the attempt cannot show the claim.
 */
export const coverageAttemptRefusal = (unknownIds: ReadonlyArray<string>): string =>
  `Requirements ${unknownIds.join(", ")} are cannot-tell on eligible stateful promises while the build boots. Do one focused game_try_input play attempt (use setupSteps to reach the question from a fresh boot, then report what you actually observed); keep cannot-tell if the attempt cannot show the claim.`;

/**
 * Byte-safe bound for critic markdown: never splits a UTF-8 sequence, so the
 * sealed file stays readable text even when upstream is longer.
 */
const boundNativeDiagnosticsText = (text: string): string => {
  if (Buffer.byteLength(text, "utf8") <= MAX_NATIVE_DIAGNOSTICS_CHARS) return text;
  return Buffer.from(text, "utf8")
    .subarray(0, MAX_NATIVE_DIAGNOSTICS_CHARS)
    .toString("utf8")
    .replace(/�+$/u, "");
};

/**
 * Bounded native world for the sealed evidence directory. Arbitrary upstream
 * JSON must never be sliced into malformed JSON: oversized or unparsable
 * payloads are honestly omitted (null), never truncated mid-value. Valid
 * bounded JSON passes through verbatim so byte-exact callers keep their file.
 */
const boundNativeWorldText = (text: string): string | null => {
  if (Buffer.byteLength(text, "utf8") > MAX_NATIVE_WORLD_CHARS) return null;
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  return text;
};

/**
 * Writes the only content a review child may see: the brief, the anonymous
 * frames with manifest ids, and the normalized checks. Source, AGENTS.md,
 * notes and build ids are never copied. Returns the stored manifest and hash.
 * When approved design requirements exist they are written as one more bounded
 * file; legacy games without an approved design get none.
 */
const writeEvidenceDirectory = async (input: {
  readonly directory: string;
  readonly brief: string;
  readonly frames: ReadonlyArray<GameReviewFrameInput>;
  readonly checks: ReadonlyArray<GameReviewCheckInput>;
  readonly designRequirements?: string | null;
  readonly designRequirementsJson?: string | null;
  readonly endStateRequirements?: ReadonlyArray<GameReviewEndStateRequirement>;
  /**
   * Frozen audio binding the critic may judge audio from, written verbatim.
   * The binding names the exact measured file, source and native-vs-Web
   * scope; without it the critic's audio stays cannot-tell.
   */
  readonly audioEvidence?:
    | {
        readonly path: string;
        readonly kind: "asset" | "native-clip";
        readonly sourceId: string | null;
        readonly scope: string;
        readonly frameId?: string | undefined;
      }
    | null
    | undefined;
  /**
   * Same-source native layout hints, written verbatim as a bounded markdown
   * file. The binding names the recorded source identity and the scenario
   * evidence directory the hints were read from.
   */
  readonly nativeDiagnostics?:
    | {
        readonly sourceId: string;
        readonly evidenceDirectory: string;
        readonly text: string;
      }
    | null
    | undefined;
  /**
   * Same-source native world measurements, written verbatim as a bounded
   * JSON file with world-space numbers only and no code. The binding names
   * the recorded source identity and the scenario evidence directory.
   */
  readonly nativeWorld?:
    | {
        readonly sourceId: string;
        readonly evidenceDirectory: string;
        readonly text: string;
      }
    | null
    | undefined;
}): Promise<{
  evidence: ReviewEvidenceRecordType;
  hash: string;
  wroteNativeDiagnostics: boolean;
  wroteNativeWorld: boolean;
}> => {
  await NodeFSP.rm(input.directory, { recursive: true, force: true });
  await NodeFSP.mkdir(NodePath.join(input.directory, "frames"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(input.directory, BRIEF_FILE), `${input.brief.trimEnd()}\n`);
  if (input.designRequirements !== undefined && input.designRequirements !== null) {
    await NodeFSP.writeFile(
      NodePath.join(input.directory, DESIGN_REQUIREMENTS_FILE),
      input.designRequirements.endsWith("\n")
        ? input.designRequirements
        : `${input.designRequirements}\n`,
    );
    if (input.designRequirementsJson !== undefined && input.designRequirementsJson !== null)
      await NodeFSP.writeFile(
        NodePath.join(input.directory, DESIGN_REQUIREMENTS_JSON),
        input.designRequirementsJson.endsWith("\n")
          ? input.designRequirementsJson
          : `${input.designRequirementsJson}\n`,
      );
  }
  if (input.audioEvidence !== undefined && input.audioEvidence !== null) {
    // The binding is evidence metadata, not media bytes: no inline audio
    // blocks ride with it, and the scope names what the measurement covers.
    await NodeFSP.writeFile(
      NodePath.join(input.directory, AUDIO_EVIDENCE_FILE),
      `${JSON.stringify(input.audioEvidence, null, 2)}\n`,
    );
  }
  if (input.endStateRequirements !== undefined && input.endStateRequirements.length > 0) {
    await NodeFSP.writeFile(
      NodePath.join(input.directory, END_STATE_REQUIREMENTS_FILE),
      `${JSON.stringify(
        {
          policyVersion: END_STATE_EVIDENCE_POLICY_VERSION,
          requirements: input.endStateRequirements.slice(0, MAX_DESIGN_REQUIREMENT_CRITERIA),
          challengeShape: {
            frameIds: ["before-frame-id", "after-frame-id"],
            note: "Name the deliberately missing trigger and the observed outcome.",
          },
        },
        null,
        2,
      )}\n`,
    );
  }
  let wroteNativeDiagnostics = false;
  if (input.nativeDiagnostics !== undefined && input.nativeDiagnostics !== null) {
    // Hints are evidence metadata, not verdicts: the critic still judges the
    // frozen Web frames and its own experiments. The file is re-bounded on
    // write so a longer upstream text can never bloat the sealed directory.
    // Byte-safe: never splits a UTF-8 sequence.
    const text = boundNativeDiagnosticsText(input.nativeDiagnostics.text);
    await NodeFSP.writeFile(
      NodePath.join(input.directory, NATIVE_DIAGNOSTICS_FILE),
      text.endsWith("\n") ? text : `${text}\n`,
    );
    wroteNativeDiagnostics = true;
  }
  let wroteNativeWorld = false;
  if (input.nativeWorld !== undefined && input.nativeWorld !== null) {
    // Measurements are evidence metadata, not verdicts: world-space numbers
    // only, no code. Arbitrary upstream JSON is never sliced into malformed
    // JSON: oversized or unparsable payloads are honestly omitted, so a valid
    // review never breaks only because optional diagnostics are unreadable.
    const bounded = boundNativeWorldText(input.nativeWorld.text);
    if (bounded !== null) {
      await NodeFSP.writeFile(
        NodePath.join(input.directory, NATIVE_WORLD_FILE),
        bounded.endsWith("\n") ? bounded : `${bounded}\n`,
      );
      wroteNativeWorld = true;
    }
  }
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
    ...(frame.width === undefined ? {} : { width: frame.width }),
    ...(frame.height === undefined ? {} : { height: frame.height }),
    // Measured scalars ride the manifest, never the pixels: only approved
    // keys filtered by the caller, bounded here so a frame stays metadata.
    ...(() => {
      const raw = frame.observations;
      if (raw === undefined) return {};
      const bounded: Record<string, number | boolean> = {};
      for (const key of Object.keys(raw).toSorted()) {
        if (Object.keys(bounded).length >= END_STATE_OBSERVATION_MAX_KEYS) break;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        const value = raw[key];
        if (typeof value === "boolean") bounded[key] = value;
        else if (typeof value === "number" && Number.isFinite(value)) bounded[key] = value;
      }
      return Object.keys(bounded).length === 0 ? {} : { observations: bounded };
    })(),
  }));
  for (const [index, frame] of input.frames.entries()) {
    if (frame.pair === undefined) {
      await NodeFSP.copyFile(frame.sourcePath, NodePath.join(input.directory, FRAME_FILE(index)));
      continue;
    }
    // A composed card is the ballot's view; the two exact captures stay in the
    // evidence directory so a cited original is never lost.
    await NodeFSP.mkdir(NodePath.join(input.directory, "frames/source"), { recursive: true });
    for (const [phase, path] of [
      ["before", frame.pair.beforePath],
      ["after", frame.pair.afterPath],
    ] as const)
      await NodeFSP.copyFile(path, NodePath.join(input.directory, PAIR_SOURCE_FILE(index, phase)));
    const composed = await composePairFiles({
      beforePath: frame.pair.beforePath,
      afterPath: frame.pair.afterPath,
      caption: frame.pair.caption,
    });
    await NodeFSP.writeFile(NodePath.join(input.directory, FRAME_FILE(index)), composed);
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
          ...(frame.width === undefined ? {} : { width: frame.width }),
          ...(frame.height === undefined ? {} : { height: frame.height }),
          ...(frame.observations === undefined ? {} : { observations: frame.observations }),
        })),
        checks,
      },
      null,
      2,
    )}\n`,
  );
  return {
    evidence,
    hash: await hashEvidenceDirectory(input.directory),
    wroteNativeDiagnostics,
    wroteNativeWorld,
  };
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

/**
 * The tool receives a structured payload, not text. Kept as bounded JSON so
 * a later diagnosis can see what the model actually sent on a refused
 * attempt, capped per attempt like any stored answer.
 */
const boundAttemptPayload = (
  value: unknown,
): { readonly raw: string; readonly truncated: boolean } => {
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return boundRawAnswer(text);
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
  /** The shipped recipe catalog; a defect may name one it fetched. */
  readonly recipeIds: ReadonlySet<string>;
  /**
   * Frozen requirement ids the critic must assess exactly once. Undefined on
   * legacy games and older records, which stay compatible and never demand
   * the field.
   */
  readonly requirementIds?: ReadonlyArray<string>;
  readonly incompleteRequirementIds?: ReadonlyArray<string>;
  readonly requirementsIncomplete?: boolean;
  /**
   * Exact-once quality coverage the critic owes. True on sessions opened
   * after the quality rubric froze; legacy records stay readable with
   * quality absent and unknown, never met.
   */
  readonly requireQuality?: boolean;
  /** True when frozen audio evidence is attached; otherwise audio stays cannot-tell. */
  readonly hasAudioEvidence?: boolean;
  /**
   * Frozen temporal-evidence policy: eligible requirement ids that need a
   * matching ordinary-input before/after witness for yes. Undefined on legacy
   * records and games without an approved design, which stay compatible and
   * skip the check. When defined, evidenceFrames must also be defined.
   */
  readonly temporalRequirementIds?: ReadonlyArray<string>;
  /** Frozen evidence frames with their input pairs, including try_input appends. */
  readonly evidenceFrames?: ReadonlyArray<TemporalEvidenceFrame>;
  /**
   * Frozen end-state policy: win/lose promises with approved key/expect that
   * need a measured after-satisfying transition plus a separate measured
   * counterexample. Undefined on legacy records, which stay compatible.
   * Version 1 checks only the named predicate; version 2 requires fully
   * non-terminal before/challenge and no opposite-kind after.
   */
  readonly endStateRequirements?: ReadonlyArray<GameReviewEndStateRequirement>;
  /** Frozen end-state policy version; absent means version 1 when requirements exist. */
  readonly endStatePolicyVersion?: number;
  /** Attempts left after this refusal; undefined on the terminal-answer path. */
  readonly attemptsRemaining?: number;
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
    if (defect.recipeId !== undefined && !known.recipeIds.has(defect.recipeId))
      return {
        kind: "invalid",
        reason: `The critic cited recipe ${defect.recipeId}, which is not in the catalog. Call game_recipe_search first, or omit recipeId.`,
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
  if (known.requirementIds !== undefined) {
    const expected = known.requirementIds;
    const assessed = answer.requirements;
    if (assessed === undefined)
      return {
        kind: "invalid",
        reason: missingRequirementsReason(expected),
      };
    const seen = new Set<string>();
    for (const entry of assessed) {
      if (!expected.includes(entry.id) || seen.has(entry.id))
        return {
          kind: "invalid",
          reason: `The critic assessed unknown or repeated requirement ${entry.id}.`,
        };
      seen.add(entry.id);
      if (entry.verdict !== "cannot-tell" && entry.frameIds.length === 0)
        return {
          kind: "invalid",
          reason: `The critic's requirement ${entry.id}=${entry.verdict} needs a frame citation.`,
        };
      if (known.incompleteRequirementIds?.includes(entry.id) && entry.verdict !== "cannot-tell")
        return {
          kind: "invalid",
          reason: `Requirement ${entry.id} is incomplete in this packet; assess it as cannot-tell.`,
        };
      for (const frameId of entry.frameIds)
        if (!known.frameIds.has(frameId))
          return {
            kind: "invalid",
            reason: `The critic cited frame ${frameId}, which is not in its manifest.`,
          };
      for (const frameId of entry.challenge?.frameIds ?? [])
        if (!known.frameIds.has(frameId))
          return {
            kind: "invalid",
            reason: `The critic cited challenge frame ${frameId}, which is not in its manifest.`,
          };
    }
    const missing = expected.filter((id) => !seen.has(id));
    if (missing.length > 0)
      return {
        kind: "invalid",
        reason: missingRequirementsReason(missing),
      };
    // Temporal evidence: an eligible stateful yes needs a matching
    // ordinary-input before/after witness from the frozen evidence, never a
    // static final frame alone. A pair is minimum structure only; it must
    // still show the named condition/effect. Opt-in: legacy records without
    // a frozen temporal policy skip this and stay compatible.
    if (known.temporalRequirementIds !== undefined) {
      const eligible = new Set(known.temporalRequirementIds);
      const frames = known.evidenceFrames ?? [];
      for (const entry of assessed) {
        if (entry.verdict !== "yes" || !eligible.has(entry.id)) continue;
        if (!hasMatchingOrdinaryInputPair(entry.frameIds, frames))
          return {
            kind: "invalid",
            reason: temporalRefusalReason(entry.id),
          };
      }
    }
    // End-state evidence: a frozen win/lose yes needs its own measured
    // after-satisfying transition with a non-terminal before, plus a
    // separate measured counterexample that stays unsatisfied. V2 requires
    // fully non-terminal before/challenge and no opposite-kind after.
    // Opt-in: records without the frozen policy stay compatible.
    if (known.endStateRequirements !== undefined) {
      const refusal = endStateRefusalReason(answer, {
        frameIds: known.frameIds,
        endStateRequirements: known.endStateRequirements,
        ...(known.evidenceFrames === undefined ? {} : { evidenceFrames: known.evidenceFrames }),
        ...(known.endStatePolicyVersion === undefined
          ? {}
          : { endStatePolicyVersion: known.endStatePolicyVersion }),
        ...(known.attemptsRemaining === undefined
          ? {}
          : { attemptsRemaining: known.attemptsRemaining }),
      });
      if (refusal !== null) return { kind: "invalid", reason: refusal };
    }
  } else if (answer.requirements !== undefined) {
    for (const entry of answer.requirements)
      for (const frameId of entry.frameIds)
        if (!known.frameIds.has(frameId))
          return {
            kind: "invalid",
            reason: `The critic cited frame ${frameId}, which is not in its manifest.`,
          };
  }
  // Absolute quality: exact-once coverage of the frozen rubric on new
  // sessions; legacy answers without it stay readable and unknown.
  const quality = answer.quality;
  if (known.requireQuality === true && quality === undefined)
    return {
      kind: "invalid",
      reason: `The critic did not assess quality: ${GAME_REVIEW_QUALITY_DIMENSIONS.join(", ")}.`,
    };
  if (quality !== undefined) {
    if (known.requireQuality !== true)
      return {
        kind: "invalid",
        reason: "The critic assessed quality on evidence frozen before the rubric; omit it.",
      };
    for (const dimension of GAME_REVIEW_QUALITY_DIMENSIONS) {
      const verdict = quality[dimension];
      for (const frameId of verdict.frameIds)
        if (!known.frameIds.has(frameId))
          return {
            kind: "invalid",
            reason: `The critic cited frame ${frameId}, which is not in its manifest.`,
          };
      // Evidence rules stronger than a proxy: audio judges a heard effect,
      // so screenshots alone prove nothing; animation needs two frames,
      // never one pose; agency needs two frames, never menu labels alone.
      if (dimension === "audio") {
        if (verdict.verdict !== "cannot-tell" && known.hasAudioEvidence !== true)
          return {
            kind: "invalid",
            reason:
              "The critic judged audio without attached audio evidence; assess cannot-tell with a missing-evidence reason.",
          };
        if (
          verdict.verdict !== "cannot-tell" &&
          known.hasAudioEvidence === true &&
          verdict.frameIds.length === 0
        )
          return {
            kind: "invalid",
            reason:
              "The critic judged audio from attached evidence without citing the evidence frame; cite it.",
          };
      } else if (verdict.verdict !== "cannot-tell" && verdict.frameIds.length === 0)
        return {
          kind: "invalid",
          reason: `The critic's quality ${dimension}=${verdict.verdict} needs a frame citation.`,
        };
      if (
        dimension === "animation" &&
        verdict.verdict === "yes" &&
        new Set(verdict.frameIds).size < 2
      )
        return {
          kind: "invalid",
          reason:
            "The critic judged animation=yes from fewer than two frames; one pose cannot show motion.",
        };
      if (dimension === "agency" && verdict.verdict === "yes" && new Set(verdict.frameIds).size < 2)
        return {
          kind: "invalid",
          reason:
            "The critic judged agency=yes from fewer than two frames; menu labels alone cannot show consequences.",
        };
    }
  }
  return {
    kind: "valid",
    answer: {
      ...answer,
      ...(known.requirementsIncomplete === true ? { requirementsIncomplete: true } : {}),
    },
  };
};

export interface DowngradedCriticAnswer {
  readonly answer: GameReviewCriticAnswer;
  readonly downgrades: ReadonlyArray<GameReviewRequirementDowngrade>;
}

/**
 * Last-answer rescue for a critic answer that decodes against the schema but
 * fails only on requirement assessments. Unsupported or missing assessments
 * become honest cannot-tell entries with the evidence rule's reason, plus a
 * server-applied list of which ids were downgraded and why so history and
 * reports show it was the server, not the critic. Everything else in the
 * answer stays exactly as the critic wrote it. Anything else invalid
 * (undecodable JSON, unknown ids, unknown frame ids, a requirement `no`
 * without frames, and similar) returns null so the refusal stands. A
 * requirement `no` is never changed, and the guards themselves are untouched:
 * a downgraded `yes` never counts as a `yes`. Legacy records without frozen
 * requirements return null.
 */
export const downgradeUnsupportedRequirements = (
  answer: GameReviewCriticAnswer,
  known: CriticAnswerKnownIds,
): DowngradedCriticAnswer | null => {
  if (known.requirementIds === undefined) return null;
  const expected = known.requirementIds;
  const downgrades: Array<GameReviewRequirementDowngrade> = [];
  const assessed = answer.requirements;
  let kept: Array<GameReviewRequirementAssessment>;
  if (assessed !== undefined) {
    kept = [];
    const seen = new Set<string>();
    for (const entry of assessed) {
      if (!expected.includes(entry.id) || seen.has(entry.id)) return null;
      seen.add(entry.id);
      // A requirement `no` is never changed; the re-validation below still
      // rejects one that cites no frames.
      if (entry.verdict === "no") {
        kept.push(entry);
        continue;
      }
      if (entry.verdict !== "cannot-tell" && entry.frameIds.length === 0) return null;
      if (known.incompleteRequirementIds?.includes(entry.id) && entry.verdict !== "cannot-tell")
        return null;
      for (const frameId of entry.frameIds) if (!known.frameIds.has(frameId)) return null;
      for (const frameId of entry.challenge?.frameIds ?? [])
        if (!known.frameIds.has(frameId)) return null;
      kept.push(entry);
    }
    const missing = expected.filter((id) => !seen.has(id));
    if (missing.length > 0) {
      const reason = missingRequirementsReason(missing);
      for (const id of missing) {
        kept.push({ id, verdict: "cannot-tell", frameIds: [], note: reason });
        downgrades.push({ id, reason });
      }
    }
  } else {
    const reason = missingRequirementsReason(expected);
    kept = expected.map((id) => ({
      id,
      verdict: "cannot-tell" as const,
      frameIds: [],
      note: reason,
    }));
    for (const id of expected) downgrades.push({ id, reason });
  }
  if (known.temporalRequirementIds !== undefined) {
    const eligible = new Set(known.temporalRequirementIds);
    const frames = known.evidenceFrames ?? [];
    kept = kept.map((entry) => {
      if (entry.verdict !== "yes" || !eligible.has(entry.id)) return entry;
      if (hasMatchingOrdinaryInputPair(entry.frameIds, frames)) return entry;
      const reason = temporalRefusalReason(entry.id);
      downgrades.push({ id: entry.id, reason });
      return { ...entry, verdict: "cannot-tell" as const, note: reason };
    });
  }
  if (known.endStateRequirements !== undefined) {
    const byId = new Map(
      known.endStateRequirements.map((requirement) => [requirement.id, requirement]),
    );
    const frames = known.evidenceFrames ?? [];
    const isV2 = (known.endStatePolicyVersion ?? 1) >= 2;
    const next: Array<GameReviewRequirementAssessment> = [];
    for (const entry of kept) {
      const requirement = byId.get(entry.id);
      if (requirement === undefined || entry.verdict !== "yes") {
        next.push(entry);
        continue;
      }
      const hit = endStateEntryRefusal(entry, requirement, {
        frameIds: known.frameIds,
        frames,
        frozen: known.endStateRequirements,
        isV2,
      });
      if (hit === null) {
        next.push(entry);
        continue;
      }
      downgrades.push({ id: entry.id, reason: hit.reason });
      next.push({ ...entry, verdict: "cannot-tell" as const, note: hit.reason });
    }
    kept = next;
  }
  if (downgrades.length === 0) return null;
  const candidate = {
    ...answer,
    requirements: kept,
    downgradedRequirements: [...(answer.downgradedRequirements ?? []), ...downgrades],
  };
  // The candidate must pass the same validation untouched; any other problem
  // (fundamentals, defects, quality, a `no` without frames) keeps the refusal.
  const reparsed = parseCriticAnswer(JSON.stringify(candidate), known);
  if (reparsed.kind === "invalid") return null;
  return { answer: reparsed.answer, downgrades };
};

export interface BallotAnswerKnownIds {
  readonly frameIds: ReadonlySet<string>;
  readonly itemIds: ReadonlyArray<string>;
  readonly defectIds?: ReadonlyArray<string>;
}

const decodeBallotToolPayload = (
  value: unknown,
  exactError = false,
): ParsedAnswer<GameReviewBallotAnswer> => {
  const decoded = decodeStrict(GameReviewBallotInput, value, "ballot", exactError);
  if (decoded.kind === "invalid") return decoded;
  const { works, look, feel, play, ...rest } = decoded.answer;
  return { kind: "valid", answer: { main: { works, look, feel, play }, ...rest } };
};

// Older persisted sessions wrap facets in main; new terminal answers use the
// advertised tool payload. Both go through identical evidence validation.
const decodeBallotPayload = (value: unknown): ParsedAnswer<GameReviewBallotAnswer> =>
  typeof value === "object" && value !== null && Object.hasOwn(value, "main")
    ? decodeStrict(GameReviewBallotAnswer, value, "ballot")
    : decodeBallotToolPayload(value);

/** Strict ballot parsing: complete item coverage, known frames, no extras. */
export const parseBallotAnswer = (
  text: string,
  known: BallotAnswerKnownIds,
): ParsedAnswer<GameReviewBallotAnswer> => {
  const parsed = parseAnswerText(text);
  if (parsed.kind === "invalid") return parsed;
  const decoded = decodeBallotPayload(parsed.value);
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
    /**
     * Counts one recipe catalog call against the calling thread. Recipe tools
     * stay read-only over the game; this is usage evidence for the loop, so a
     * measurement can say whether a role asked for know-how.
     */
    readonly noteRecipeCall: (threadId: ThreadId) => Effect.Effect<void>;
    /** Recipe calls recorded for a thread; null when the count could not be read. */
    readonly recipeCalls: (threadId: ThreadId) => Effect.Effect<number | null>;
    readonly tryInput: (
      caller: GameReviewToolCaller,
      input: GameTryInput,
    ) => Effect.Effect<GameWebPlaytestResult, GameOperationError>;
    /**
     * A read-only scaled crop of one evidence frame the caller already has.
     * Critic and ballot children may both use it; it never extends the
     * evidence, never changes the hash, and citations still name the source
     * frame. Numbers returned are measurements, never quality claims.
     */
    readonly inspectDetail: (
      caller: GameReviewToolCaller,
      input: GameReviewDetailInput,
    ) => Effect.Effect<GameReviewDetailResult, GameOperationError>;
    /** Detail views spent by one child run; null when the count is unreadable. */
    readonly detailCalls: (threadId: ThreadId, runId: RunId) => Effect.Effect<number | null>;
    readonly start: (
      input: GameReviewSessionStartInput,
    ) => Effect.Effect<GameReviewSessionStartResult, GameOperationError>;
    /** Only the active run of a server-owned review child can see its answer tool. */
    readonly toolRole: (
      caller: GameReviewToolCaller,
    ) => Effect.Effect<"critic" | "ballot" | null, GameOperationError>;
    /**
     * Whether this thread is a dispatched repair child. Its catalog keeps every
     * build tool but omits review management. Read separately from `toolRole`
     * so a repair never looks like an auditable critic or ballot.
     */
    readonly repairChild: (caller: GameReviewToolCaller) => Effect.Effect<boolean>;
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
    const designApproval = yield* Effect.serviceOption(GameDesignApproval.GameDesignApproval);
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
    // Repair children are not answer callers, so they get their own marker
    // instead of the caller index that grants critic and ballot tools.
    const repairCallerFile = (childThreadId: string) =>
      NodePath.join(
        options.stateDir,
        "game-review-repair-callers",
        `${encodePart(childThreadId)}.json`,
      );

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
      if (record.role === "repair") {
        const lookup = repairCallerFile(record.childThreadId);
        yield* attempt("index game review repair caller", lookup, () =>
          writeJsonAtomic(lookup, { root, ...key }),
        );
      } else {
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
        // The approved record binds, not the editable brief or DESIGN.md text:
        // prose edits never change the exam, unapproved revisions never reach a
        // reviewer, and legacy games without a record review exactly as before.
        // The critic's frozen requirements are authoritative for the whole
        // round: repair and ballots reuse them instead of re-reading an
        // approval that may have changed since the critic started.
        const readFrozenCritic = Effect.gen(function* () {
          if (input.role === "critic") return null;
          const file = yield* recordFile(root, {
            loopId: input.loopId,
            roundId: input.roundId,
            role: "critic",
            order: 0,
          });
          const value = yield* attempt("read game review session", file, () => readJson(file));
          if (value === null) return null;
          return yield* Effect.try({
            try: () => decodeSessionRecord(value),
            catch: (cause) =>
              failure(
                "read game review session",
                file,
                "io",
                "The frozen critic record cannot be decoded.",
                cause,
              ),
          });
        });
        const frozenCritic = yield* readFrozenCritic;
        const hasFrozen =
          frozenCritic !== null &&
          (frozenCritic.requirementIds !== undefined ||
            frozenCritic.designRequirements !== undefined ||
            frozenCritic.designRequirementsJson !== undefined);
        const freshSnapshotAcceptance: ReadonlyArray<GameAcceptanceCriterion> | null = hasFrozen
          ? null
          : yield* Option.match(designApproval, {
              onNone: () => Effect.succeed(null),
              onSome: (approval) =>
                approval
                  .snapshot(root, manifest)
                  .pipe(
                    Effect.map((snapshot) =>
                      snapshot.record === null ? null : snapshot.record.acceptance,
                    ),
                  ),
            });
        const freshBound: BoundDesignRequirements | null =
          freshSnapshotAcceptance === null
            ? null
            : boundDesignRequirements(freshSnapshotAcceptance);
        const freshJson: string | null =
          freshBound === null ? null : encodeDesignRequirementsJson(freshBound);
        // The critic's frozen markdown and JSON are authoritative for the
        // whole round: repair and ballots reuse them verbatim so a changed
        // approval cannot rewrite the round mid-review.
        const designRequirements: string | null = hasFrozen
          ? (frozenCritic!.designRequirements ?? null)
          : (freshBound?.markdown ?? null);
        const designRequirementsJson: string | null = hasFrozen
          ? (frozenCritic!.designRequirementsJson ?? null)
          : freshJson;
        const requirementIds: ReadonlyArray<string> | undefined = hasFrozen
          ? (frozenCritic!.requirementIds ?? [])
          : freshBound === null
            ? undefined
            : freshBound.requirements.map((criterion) => criterion.id);
        const designTruncated: boolean | undefined = hasFrozen
          ? (frozenCritic!.designTruncated ?? false)
          : freshBound === null
            ? undefined
            : (freshBound.truncated ?? false);
        const incompleteRequirementIds = hasFrozen
          ? (frozenCritic!.incompleteRequirementIds ?? [])
          : (freshBound?.requirements
              .filter((criterion) => criterion.incomplete)
              .map((criterion) => criterion.id) ?? []);
        // Temporal policy freezes with the same snapshot: eligible stateful
        // ids come from the actual approved criteria, so a midround approval
        // edit cannot change the exam. Legacy records without the policy stay
        // compatible and skip the before/after witness check.
        const temporalPolicyVersion: number | undefined = hasFrozen
          ? frozenCritic!.temporalPolicyVersion
          : freshSnapshotAcceptance === null
            ? undefined
            : TEMPORAL_EVIDENCE_POLICY_VERSION;
        const temporalRequirementIds: ReadonlyArray<string> | undefined = hasFrozen
          ? frozenCritic!.temporalRequirementIds
          : freshSnapshotAcceptance === null
            ? undefined
            : [...temporalEligibleRequirementIds(freshSnapshotAcceptance)];
        // Coverage-attempt work rule freezes with the same snapshot: new
        // frozen critic sessions carry it, legacy records without it stay
        // compatible, and a midround approval edit cannot change obligations.
        const coverageAttemptPolicyVersion: number | undefined = hasFrozen
          ? frozenCritic!.coverageAttemptPolicyVersion
          : freshSnapshotAcceptance === null
            ? undefined
            : COVERAGE_ATTEMPT_POLICY_VERSION;
        // End-state policy freezes keys/expectations/kinds/version from the
        // actual approved acceptance at start: mutable DESIGN cannot rewrite
        // the exam. Legacy records and games without approval stay
        // compatible and skip the measured-plus-counterexample check.
        const endStatePolicyVersion: number | undefined = hasFrozen
          ? frozenCritic!.endStatePolicyVersion
          : freshSnapshotAcceptance === null
            ? undefined
            : END_STATE_EVIDENCE_POLICY_VERSION;
        const endStateRequirements: ReadonlyArray<GameReviewEndStateRequirement> | undefined =
          hasFrozen
            ? frozenCritic!.endStateRequirements
            : freshSnapshotAcceptance === null
              ? undefined
              : [...endStateEligibleRequirements(freshSnapshotAcceptance)];
        const endStateKeys = new Set((endStateRequirements ?? []).map((entry) => entry.key));
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
        let wroteNativeDiagnostics = false;
        let wroteNativeWorld = false;
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
          // Filter measured scalars to the frozen approved keys before they
          // reach the sealed directory: unapproved counters never ride along,
          // missing values stay missing and justify cannot-tell downstream.
          const filteredFrames = (
            input.evidence!.frames as ReadonlyArray<GameReviewFrameInput>
          ).map((frame) => {
            if (frame.observations === undefined || endStateRequirements === undefined)
              return frame.observations === undefined
                ? frame
                : {
                    ...frame,
                    observations: pickEndStateObservations(frame.observations, endStateKeys),
                  };
            const filtered = pickEndStateObservations(frame.observations, endStateKeys);
            return Object.keys(filtered).length === 0
              ? (() => {
                  const { observations: _dropped, ...rest } = frame;
                  return rest;
                })()
              : { ...frame, observations: filtered };
          });
          const written = yield* attempt("write game review evidence", evidenceDirectory, () =>
            writeEvidenceDirectory({
              directory: evidenceDirectory!,
              brief,
              frames: filteredFrames,
              checks: input.evidence!.checks,
              ...(designRequirements === null ? {} : { designRequirements }),
              ...(designRequirementsJson === null ? {} : { designRequirementsJson }),
              ...(endStateRequirements === undefined ? {} : { endStateRequirements }),
              ...(input.evidence!.audioEvidence === undefined
                ? {}
                : { audioEvidence: input.evidence!.audioEvidence }),
              ...(input.evidence!.nativeDiagnostics === undefined
                ? {}
                : { nativeDiagnostics: input.evidence!.nativeDiagnostics }),
              ...(input.evidence!.nativeWorld === undefined
                ? {}
                : { nativeWorld: input.evidence!.nativeWorld }),
            }),
          );
          evidence = written.evidence;
          evidenceHash = written.hash;
          wroteNativeDiagnostics = written.wroteNativeDiagnostics;
          wroteNativeWorld = written.wroteNativeWorld;
        }

        const files = [
          { path: BRIEF_FILE, label: "brief and art direction" },
          ...(designRequirements === null
            ? []
            : [
                { path: DESIGN_REQUIREMENTS_FILE, label: "approved design requirements" },
                {
                  path: DESIGN_REQUIREMENTS_JSON,
                  label: "approved design requirements (structured)",
                },
              ]),
          ...(evidence?.frames.map((frame) => ({
            path: frame.file,
            label: `${frame.id}: ${frame.label}`,
          })) ?? []),
          ...(evidence === null ||
          endStateRequirements === undefined ||
          endStateRequirements.length === 0
            ? []
            : [
                {
                  path: END_STATE_REQUIREMENTS_FILE,
                  label: "frozen outcome predicates and counterexample evidence format",
                },
              ]),
          ...(evidence === null ? [] : [{ path: EVIDENCE_MANIFEST, label: "normalized checks" }]),
          // Frozen audio binding, when the session attached one: the critic
          // may judge audio only from this file's named file and scope.
          ...(evidence === null || input.evidence?.audioEvidence === undefined
            ? []
            : [{ path: AUDIO_EVIDENCE_FILE, label: "frozen audio measurement binding" }]),
          // Same-source native layout hints, when the check bound them: the
          // critic may use them to decide where to look with game_try_input
          // on Web frames, never as proof of a Web defect. Listed only when
          // the file was actually written, so the prompt never names a
          // missing file.
          ...(evidence === null || !wroteNativeDiagnostics
            ? []
            : [
                {
                  path: NATIVE_DIAGNOSTICS_FILE,
                  label:
                    "same-source headless layout hints; verify on Web frames, never cite as proof",
                },
              ]),
          // Same-source native world measurements, when the check bound them:
          // portable world-space numbers at probe frames; verify on Web
          // frames, never cite as proof. Absent or truncated stays unknown.
          // Listed only when the file was actually written: an oversized or
          // unparsable upstream payload is honestly omitted, never a broken
          // file, and a valid review never breaks for optional diagnostics.
          ...(evidence === null || !wroteNativeWorld
            ? []
            : [
                {
                  path: NATIVE_WORLD_FILE,
                  label:
                    "same-source headless world measurements; verify on Web frames, never cite as proof",
                },
              ]),
        ];
        const task =
          input.role === "critic"
            ? criticPrompt(
                files,
                designRequirements === null ? {} : { hasDesignRequirements: true },
              )
            : input.role === "ballot"
              ? pairwisePrompt({
                  files,
                  items: input.items ?? [],
                  defects: input.defects ?? [],
                  ...(designRequirements === null ? {} : { hasDesignRequirements: true as const }),
                })
              : builderFixPrompt({
                  remainingBudget: input.repair?.remainingBudget ?? "the remaining round budget",
                  brief,
                  defects: input.repair?.defects ?? [],
                  doNotRegress: input.repair?.doNotRegress ?? [],
                  ...(input.repair?.previousRejection === undefined
                    ? {}
                    : { previousRejection: input.repair.previousRejection }),
                  ...(designRequirements === null ? {} : { designRequirements }),
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
          ...(requirementIds === undefined ? {} : { requirementIds: [...requirementIds] }),
          ...(requirementIds === undefined ? {} : { incompleteRequirementIds }),
          ...(designRequirements === null ? {} : { designRequirements }),
          ...(designRequirementsJson === null ? {} : { designRequirementsJson }),
          ...(designTruncated === undefined ? {} : { designTruncated }),
          ...(temporalPolicyVersion === undefined ? {} : { temporalPolicyVersion }),
          ...(temporalRequirementIds === undefined
            ? {}
            : { temporalRequirementIds: [...temporalRequirementIds] }),
          ...(coverageAttemptPolicyVersion === undefined ? {} : { coverageAttemptPolicyVersion }),
          ...(endStatePolicyVersion === undefined ? {} : { endStatePolicyVersion }),
          ...(endStateRequirements === undefined
            ? {}
            : { endStateRequirements: [...endStateRequirements] }),
          // The quality rubric freezes with the round: a later rubric edit
          // cannot rewrite this session's exam. Only critic sessions answer
          // quality; ballot and repair sessions never carry the version.
          ...(input.role === "critic"
            ? { qualityRubricVersion: GAME_REVIEW_QUALITY_RUBRIC_VERSION }
            : {}),
          ...(input.role === "critic" && input.evidence?.audioEvidence !== undefined
            ? { hasAudioEvidence: true }
            : {}),
          ...(input.role === "critic" && wroteNativeDiagnostics
            ? { hasNativeDiagnostics: true }
            : {}),
          ...(input.role === "critic" && wroteNativeWorld ? { hasNativeWorld: true } : {}),
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
      | {
          readonly kind: "invalid";
          readonly reason: string;
          readonly raw: string | null;
          readonly exhausted?: boolean;
        }
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
          // A terminal answer cannot evade feedback or the attempt limit.
          // Merely offering a tool does not invalidate a first structured answer.
          if (tool.attempts > 0 || tool.error !== null)
            return {
              kind: "invalid",
              reason: tool.error ?? "The review tool ended without a valid answer.",
              raw: null,
              ...(tool.attempts >= 3 ? { exhausted: true as const } : {}),
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

    // One line per call: appends cannot lose a concurrent call the way a
    // read-modify-write counter can, and a short file is cheap to count.
    const recipeCallsFile = (threadId: ThreadId) =>
      NodePath.join(options.stateDir, "game-recipe-calls", `${encodePart(threadId)}.jsonl`);
    const noteRecipeCall: GameReviewSessions["Service"]["noteRecipeCall"] = (threadId) =>
      Effect.gen(function* () {
        const file = recipeCallsFile(threadId);
        yield* attempt("record recipe call", file, async () => {
          await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
          await NodeFSP.appendFile(file, `${DateTime.formatIso(DateTime.nowUnsafe())}\n`);
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("recording a recipe call failed", { threadId, cause }),
        ),
        Effect.asVoid,
      );
    const recipeCalls: GameReviewSessions["Service"]["recipeCalls"] = (threadId) => {
      const file = recipeCallsFile(threadId);
      return attempt("read recipe calls", file, async () => {
        const text = await NodeFSP.readFile(file, "utf8").then(
          (value) => value,
          (cause: unknown) => {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw cause;
          },
        );
        return text === null ? 0 : text.split("\n").filter((line) => line.trim() !== "").length;
      }).pipe(Effect.orElseSucceed(() => null));
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
          const setupSteps = [...(input.setupSteps ?? [])];
          const observedSteps = [...input.steps];
          const fullSteps = [...setupSteps, ...observedSteps];
          const captureFromStep = setupSteps.length;
          const viewport =
            match?.record.playViewport ??
            playedViewport(bound.playtest?.viewport, bound.playtest?.captureScale);
          const playInput = {
            steps: fullSteps,
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
              undefined,
              ...(captureFromStep === 0 ? [] : ([{ captureFromStep }] as const)),
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
          // Filter live probe scalars to the frozen approved keys before they
          // reach the sealed directory. Only a successfully recorded frame
          // can later serve as an observed challenge; a preflight-invalid or
          // reserved-failed call never reaches here, so it fabricates nothing.
          const frozenEndState = match.record.endStateRequirements;
          const frozenKeys =
            frozenEndState === undefined ? null : new Set(frozenEndState.map((entry) => entry.key));
          const frames = result.screenshots.map((frame, index) => {
            const base = {
              id: `try${calls + 1}f${index + 1}`,
              file: `frames/try-${calls + 1}-${index + 1}.png`,
              sourceId: `try-${calls + 1}-${index + 1}`,
              label: frame.label,
              ...(frame.inputPair === undefined ? {} : { inputPair: frame.inputPair }),
              width: frame.width,
              height: frame.height,
            };
            if (frozenKeys === null || frame.probe?.gameState === undefined) return base;
            const filtered = pickEndStateObservations(frame.probe.gameState, frozenKeys);
            return Object.keys(filtered).length === 0 ? base : { ...base, observations: filtered };
          });
          const nextEvidence = { ...evidence, frames: [...evidence.frames, ...frames] };
          yield* attempt("record active critic evidence", directory, async () => {
            for (const [index, frame] of result.screenshots.entries())
              await NodeFSP.writeFile(
                NodePath.join(directory, frames[index]!.file),
                Buffer.from(frame.data, "base64"),
              );
            await writeJsonAtomic(NodePath.join(directory, `try-${calls + 1}.json`), {
              buildId,
              steps: observedSteps,
              ...(setupSteps.length === 0 ? {} : { setupSteps }),
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
            evidenceDirectory: ".",
            screenshots: result.screenshots.map((frame, index) => ({
              ...frame,
              frameId: frames[index]!.id,
              // Evidence-relative: the critic reads its own session directory,
              // and the frameId stays the citable evidence identity.
              path: frames[index]!.file,
            })),
          };
        }),
      );

    const detailCallsFile = (threadId: ThreadId, runId: RunId) =>
      NodePath.join(
        options.stateDir,
        "game-detail-calls",
        encodePart(threadId),
        `${encodePart(runId)}.json`,
      );
    const detailCalls: GameReviewSessions["Service"]["detailCalls"] = (threadId, runId) => {
      const file = detailCallsFile(threadId, runId);
      return attempt("read game detail budget", file, () => readJson(file)).pipe(
        Effect.flatMap((value) =>
          value === null
            ? Effect.succeed(0)
            : Schema.decodeUnknownEffect(
                Schema.Int.check(
                  Schema.isBetween({
                    minimum: 0,
                    maximum: GAME_REVIEW_DETAIL_BOUNDS.maxCalls,
                  }),
                ),
              )(value).pipe(
                Effect.mapError((cause) =>
                  failure("read game detail budget", file, "io", undefined, cause),
                ),
              ),
        ),
        Effect.orElseSucceed(() => null),
      );
    };

    /**
     * One read-only detail view. The region is cut from the exact evidence
     * bytes at native resolution, scaled by the same integer on both halves
     * of a pair, and returned with mean-colour measurements only. Nothing is
     * written to the evidence tree, so the hash the answer validates against
     * cannot move under the child.
     */
    const inspectDetail: GameReviewSessions["Service"]["inspectDetail"] = (caller, input) =>
      callerLock(caller).withPermits(1)(
        Effect.gen(function* () {
          const invalid = (detail: string) =>
            failure("game_review_detail", caller.threadId, "invalid-input", detail);
          const match = yield* matchingCaller(caller);
          if (match === null || (match.key.role !== "critic" && match.key.role !== "ballot"))
            return yield* invalid(
              "game_review_detail is only available to the active critic or ballot session; it reads that session's frozen evidence.",
            );
          const priorTool = yield* readToolRecord(yield* toolFile(match.key.root, match.key));
          if (
            priorTool !== null &&
            (priorTool.runId !== match.runId ||
              priorTool.evidenceHash !== match.record.evidenceHash)
          )
            return yield* invalid("The recorded answer belongs to another run or evidence hash.");
          if (priorTool !== null && (priorTool.raw !== null || priorTool.attempts >= 3))
            return yield* invalid("The review session has ended.");
          if (
            (yield* attempt("hash game review evidence", match.key.root, () =>
              hashEvidenceDirectory(match.record.evidenceDirectory!),
            )) !== match.record.evidenceHash
          )
            return yield* invalid(
              "The evidence changed after this child started; detail views are refused.",
            );
          const frames = match.record.evidence?.frames ?? [];
          const index = frames.findIndex((frame) => frame.id === input.frameId);
          if (index === -1)
            return yield* invalid(
              `Unknown frame ${input.frameId}; use a frame id from the evidence manifest.`,
            );
          const calls = (yield* detailCalls(caller.threadId, match.runId)) ?? 0;
          if (calls >= GAME_REVIEW_DETAIL_BOUNDS.maxCalls)
            return yield* invalid(
              `game_review_detail exhausted its ${GAME_REVIEW_DETAIL_BOUNDS.maxCalls} calls for this session.`,
            );
          const scale = input.scale ?? 2;
          const region = { x: input.x, y: input.y, width: input.width, height: input.height };
          const directory = match.record.evidenceDirectory!;
          const decode = (path: string) =>
            Effect.gen(function* () {
              const bytes = yield* attempt("read game review frame", path, () =>
                NodeFSP.readFile(path),
              );
              if (bytes.length > GAME_REVIEW_DETAIL_BOUNDS.maxFrameBytes)
                return yield* invalid(
                  `The frame is larger than ${GAME_REVIEW_DETAIL_BOUNDS.maxFrameBytes} bytes; detail views are refused.`,
                );
              // pngjs allocates decoded pixels before returning dimensions.
              if (bytes.length >= 24 && bytes.toString("hex", 0, 8) === "89504e470d0a1a0a") {
                const width = bytes.readUInt32BE(16);
                const height = bytes.readUInt32BE(20);
                if (
                  width > GAME_REVIEW_DETAIL_BOUNDS.maxFrameDimension ||
                  height > GAME_REVIEW_DETAIL_BOUNDS.maxFrameDimension
                )
                  return yield* invalid(
                    `The ${width}x${height} frame is outside the supported detail size.`,
                  );
              }
              // A malformed frame is a broken frozen record, so a decode
              // failure propagates as io instead of an input error.
              const png = yield* attempt("decode game review frame", path, async () =>
                PNG.sync.read(bytes),
              );
              if (
                png.width <= 0 ||
                png.height <= 0 ||
                png.width > GAME_REVIEW_DETAIL_BOUNDS.maxFrameDimension ||
                png.height > GAME_REVIEW_DETAIL_BOUNDS.maxFrameDimension
              )
                return yield* invalid(
                  `The ${png.width}x${png.height} frame is outside the supported detail size.`,
                );
              return png;
            });
          // A ballot card keeps its two exact captures beside it; cutting the
          // same region from those sources keeps both halves at native
          // resolution and the region consistent across the pair.
          const pairExists = yield* attempt(
            "read game review frame sources",
            directory,
            async () => {
              try {
                await NodeFSP.access(NodePath.join(directory, PAIR_SOURCE_FILE(index, "before")));
                await NodeFSP.access(NodePath.join(directory, PAIR_SOURCE_FILE(index, "after")));
                return true;
              } catch {
                return false;
              }
            },
          );
          const fits = (png: PNG, half: string) =>
            region.x + region.width > png.width || region.y + region.height > png.height
              ? invalid(
                  `Region ${region.width}x${region.height} at ${region.x},${region.y} extends past the ${png.width}x${png.height}${half} of frame ${input.frameId}; move or shrink it.`,
                )
              : Effect.succeed(null);
          const finish = (bytes: Buffer) => {
            if (bytes.length > GAME_REVIEW_DETAIL_BOUNDS.maxOutputBytes)
              return invalid(
                `The detail is ${bytes.length} bytes; limit is ${GAME_REVIEW_DETAIL_BOUNDS.maxOutputBytes}. Shrink the region or the scale.`,
              );
            return Effect.succeed(bytes);
          };
          if (pairExists) {
            const before = yield* decode(
              NodePath.join(directory, PAIR_SOURCE_FILE(index, "before")),
            );
            const after = yield* decode(NodePath.join(directory, PAIR_SOURCE_FILE(index, "after")));
            yield* fits(before, " before half");
            yield* fits(after, " after half");
            const beforeCrop = cropPng(before, region);
            const afterCrop = cropPng(after, region);
            const delta = deltaStats(beforeCrop, afterCrop);
            const card = composeSideBySidePng({
              left: PNG.sync.write(scalePngNearest(beforeCrop, scale)),
              right: PNG.sync.write(scalePngNearest(afterCrop, scale)),
              leftLabel: "BEFORE",
              rightLabel: "AFTER",
              caption: `${input.frameId} DETAIL ${region.width}X${region.height} AT ${region.x},${region.y} S${scale}`,
            });
            const bytes = yield* finish(card.png);
            yield* attempt("reserve game detail call", directory, () =>
              writeJsonAtomic(detailCallsFile(caller.threadId, match.runId), calls + 1),
            );
            return {
              screenshots: [
                {
                  label: `detail ${input.frameId} ${region.width}x${region.height} s${scale}`,
                  mimeType: "image/png",
                  data: bytes.toString("base64"),
                  width: card.width,
                  height: card.height,
                },
              ],
              detail: {
                frameId: input.frameId,
                ...region,
                scale,
                sourceWidth: before.width,
                sourceHeight: before.height,
                pair: true,
                regions: [
                  {
                    name: "before",
                    mean: meanColor(beforeCrop),
                    pixels: region.width * region.height,
                  },
                  {
                    name: "after",
                    mean: meanColor(afterCrop),
                    pixels: region.width * region.height,
                  },
                ],
                delta: { meanAbs: delta.meanAbs, changedPercent: delta.changedPercent },
              },
            } satisfies GameReviewDetailResult;
          }
          const png = yield* decode(NodePath.join(directory, frames[index]!.file));
          yield* fits(png, "");
          const crop = cropPng(png, region);
          const bytes = yield* finish(PNG.sync.write(scalePngNearest(crop, scale)));
          yield* attempt("reserve game detail call", directory, () =>
            writeJsonAtomic(detailCallsFile(caller.threadId, match.runId), calls + 1),
          );
          return {
            screenshots: [
              {
                label: `detail ${input.frameId} ${region.width}x${region.height} s${scale}`,
                mimeType: "image/png",
                data: bytes.toString("base64"),
                width: crop.width * scale,
                height: crop.height * scale,
              },
            ],
            detail: {
              frameId: input.frameId,
              ...region,
              scale,
              sourceWidth: png.width,
              sourceHeight: png.height,
              pair: false,
              regions: [
                { name: "frame", mean: meanColor(crop), pixels: region.width * region.height },
              ],
            },
          } satisfies GameReviewDetailResult;
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
            // Track offered tools separately from actual submission attempts.
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

    const repairChild: GameReviewSessions["Service"]["repairChild"] = (caller) =>
      attempt("read game review repair caller", repairCallerFile(caller.threadId), () =>
        readJson(repairCallerFile(caller.threadId)),
      ).pipe(
        Effect.map((record) => record !== null),
        // Fail open: an unreadable marker must not hide build tools.
        Effect.orElseSucceed(() => false),
      );

    const coverageAttemptError = Effect.fnUntraced(function* (
      record: ReviewSessionRecordType,
      answer: GameReviewCriticAnswer,
      runId: string | null,
    ) {
      if (
        record.role !== "critic" ||
        record.coverageAttemptPolicyVersion === undefined ||
        answer.fundamentals.boots.verdict !== "yes" ||
        isActionableCriticAnswer(answer)
      )
        return null;
      const unknownIds = coverageAttemptUnknownIds(answer, record.temporalRequirementIds ?? []);
      if (unknownIds.length === 0) return null;
      if ((record.evidence?.frames ?? []).some((frame) => EXPERIMENT_FRAME_ID.test(frame.id)))
        return null;
      // Reservations are made only after preflight. A failed launched attempt
      // still spent the bounded budget; it never proves a promise.
      const calls =
        runId === null
          ? 0
          : yield* inputCalls(ThreadIdSchema.make(record.childThreadId), RunId.make(runId)).pipe(
              Effect.orElseSucceed(() => 0),
            );
      return calls > 0 ? null : coverageAttemptRefusal(unknownIds);
    });

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
          // The refusal the model reads must name the way out and the budget
          // left, so the count is known before validation runs.
          const upcomingAttempts = (previous?.attempts ?? 0) + 1;
          const remainingAfter = 3 - upcomingAttempts;
          const known = {
            frameIds: new Set(record.evidence?.frames.map((frame) => frame.id)),
            checkIds: new Set(record.evidence?.checks.map((check) => check.id)),
            recipeIds: gameRecipeIds,
            requirementsIncomplete: record.designTruncated === true,
            incompleteRequirementIds: record.incompleteRequirementIds ?? [],
            itemIds: record.itemIds,
            defectIds: record.defectIds ?? [],
            ...(record.requirementIds === undefined
              ? {}
              : { requirementIds: [...record.requirementIds] }),
            // Frozen with the session: legacy records predate the rubric and
            // stay readable with quality absent and unknown.
            ...(record.qualityRubricVersion === undefined ? {} : { requireQuality: true as const }),
            ...(record.hasAudioEvidence === true ? { hasAudioEvidence: true as const } : {}),
            // Frozen temporal policy, including try_input appends: legacy
            // records without it skip the before/after witness check.
            ...(record.temporalPolicyVersion === undefined
              ? {}
              : {
                  temporalRequirementIds: [...(record.temporalRequirementIds ?? [])],
                  evidenceFrames: (record.evidence?.frames ?? []).map((frame) => ({
                    id: frame.id,
                    ...(frame.inputPair === undefined ? {} : { inputPair: frame.inputPair }),
                    ...(frame.width === undefined ? {} : { width: frame.width }),
                    ...(frame.height === undefined ? {} : { height: frame.height }),
                    ...(frame.observations === undefined
                      ? {}
                      : { observations: frame.observations }),
                  })),
                }),
            // Frozen end-state policy, including try_input appends: legacy
            // records without it stay compatible and skip the measured
            // transition plus counterexample check. Version 1 keeps the
            // own-predicate rule; version 2 enforces cross-terminal.
            ...(record.endStatePolicyVersion === undefined
              ? {}
              : {
                  endStateRequirements: [...(record.endStateRequirements ?? [])],
                  endStatePolicyVersion: record.endStatePolicyVersion,
                  // Temporal and end-state share the same frozen frames; when
                  // only the end-state policy is present its frames ride here.
                  ...(record.temporalPolicyVersion !== undefined
                    ? {}
                    : {
                        evidenceFrames: (record.evidence?.frames ?? []).map((frame) => ({
                          id: frame.id,
                          ...(frame.inputPair === undefined ? {} : { inputPair: frame.inputPair }),
                          ...(frame.width === undefined ? {} : { width: frame.width }),
                          ...(frame.height === undefined ? {} : { height: frame.height }),
                          ...(frame.observations === undefined
                            ? {}
                            : { observations: frame.observations }),
                        })),
                      }),
                }),
            attemptsRemaining: remainingAfter,
          };
          const parsed = (() => {
            if (role === "critic") {
              const decoded = decodeStrict(GameReviewCriticAnswer, value, role, true);
              return decoded.kind === "invalid"
                ? decoded
                : parseCriticAnswer(JSON.stringify(decoded.answer), known);
            }
            const decoded = decodeBallotToolPayload(value, true);
            if (decoded.kind === "invalid") return decoded;
            return parseBallotAnswer(JSON.stringify(decoded.answer), known);
          })();
          // On the last tool attempt only, a critic answer that decodes
          // against the schema but fails solely on requirement assessments is
          // accepted after making the unsupported assessments honest
          // cannot-tell. Attempts 1 and 2 keep refusing exactly as before.
          let downgraded: DowngradedCriticAnswer | null = null;
          if (parsed.kind === "invalid" && role === "critic" && upcomingAttempts >= 3) {
            const decoded = decodeStrict(GameReviewCriticAnswer, value, role, true);
            downgraded =
              decoded.kind === "invalid"
                ? null
                : downgradeUnsupportedRequirements(decoded.answer, known);
          }
          const effective =
            downgraded !== null ? { kind: "valid" as const, answer: downgraded.answer } : parsed;
          const coverageError =
            effective.kind === "valid" && role === "critic"
              ? yield* coverageAttemptError(
                  record,
                  effective.answer as GameReviewCriticAnswer,
                  runId,
                )
              : null;
          const raw =
            effective.kind === "valid" && coverageError === null
              ? encodeReviewAnswer(effective.answer)
              : null;
          const accepted = effective.kind === "valid" && coverageError === null;
          const attempts = upcomingAttempts;
          // The last-attempt way out must ride with every refusal, not only
          // end-state ones, so a model that cannot support a promise still
          // has a legal move. End-state refusals already name the count.
          let error: string | null =
            effective.kind === "invalid" && parsed.kind === "invalid"
              ? parsed.reason
              : coverageError;
          if (
            !accepted &&
            remainingAfter === 1 &&
            error !== null &&
            !error.includes("1 attempt remains") &&
            !error.includes("last attempt")
          ) {
            error = `${error} This is the last attempt; set any requirement it cannot support to cannot-tell.`;
          }
          yield* attempt("record game review tool answer", file, () =>
            writeJsonAtomic(file, {
              runId,
              evidenceHash: record.evidenceHash,
              attempts,
              raw: accepted ? raw : null,
              error,
            }),
          );
          // Every refused payload stays readable beside the tool record, so a
          // later diagnosis can see what the model actually sent. These files
          // live next to tool-answer.json, never inside the evidence
          // directory, so they cannot change the evidence hash or anything
          // the critic reads.
          if (!accepted || parsed.kind === "invalid") {
            const payload = boundAttemptPayload(value);
            yield* attempt("record game review tool attempt", file, () =>
              writeJsonAtomic(
                NodePath.join(NodePath.dirname(file), `tool-attempt-${attempts}.json`),
                {
                  runId,
                  evidenceHash: record.evidenceHash,
                  attempt: attempts,
                  accepted,
                  serverDowngraded: downgraded !== null,
                  payload: payload.raw,
                  truncated: payload.truncated,
                  validationError: parsed.kind === "invalid" ? parsed.reason : null,
                  error,
                },
              ),
            );
          }
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
          // Exact quality coverage of the accepted answer, so the history and
          // status can report it without re-reading the raw text.
          const qualityCoverage =
            accepted && role === "critic" && effective.kind === "valid"
              ? gameReviewQualityCoverage(
                  (effective.answer as GameReviewCriticAnswer).quality,
                  record.qualityRubricVersion,
                )
              : undefined;
          return {
            accepted,
            error,
            attemptsRemaining: accepted ? 0 : 3 - attempts,
            ended,
            ...(qualityCoverage === undefined ? {} : { qualityCoverage }),
          };
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
          recipeIds: gameRecipeIds,
          requirementsIncomplete: record.designTruncated === true,
          incompleteRequirementIds: record.incompleteRequirementIds ?? [],
          itemIds: record.itemIds,
          defectIds: record.defectIds ?? [],
          ...(record.requirementIds === undefined
            ? {}
            : { requirementIds: [...record.requirementIds] }),
          // Frozen with the session: legacy records predate the rubric and
          // stay readable with quality absent and unknown.
          ...(record.qualityRubricVersion === undefined ? {} : { requireQuality: true as const }),
          ...(record.hasAudioEvidence === true ? { hasAudioEvidence: true as const } : {}),
          // Same frozen temporal policy as the tool path, including try_input
          // appends; legacy records without it stay compatible.
          ...(record.temporalPolicyVersion === undefined
            ? {}
            : {
                temporalRequirementIds: [...(record.temporalRequirementIds ?? [])],
                evidenceFrames: evidence.frames.map((frame) => ({
                  id: frame.id,
                  ...(frame.inputPair === undefined ? {} : { inputPair: frame.inputPair }),
                  ...(frame.width === undefined ? {} : { width: frame.width }),
                  ...(frame.height === undefined ? {} : { height: frame.height }),
                  ...(frame.observations === undefined ? {} : { observations: frame.observations }),
                })),
              }),
          // Same frozen end-state policy as the tool path; legacy records
          // without it stay compatible. Version carries so v1 records keep
          // the old rule and v2 records enforce cross-terminal.
          ...(record.endStatePolicyVersion === undefined
            ? {}
            : {
                endStateRequirements: [...(record.endStateRequirements ?? [])],
                endStatePolicyVersion: record.endStatePolicyVersion,
                ...(record.temporalPolicyVersion !== undefined
                  ? {}
                  : {
                      evidenceFrames: evidence.frames.map((frame) => ({
                        id: frame.id,
                        ...(frame.inputPair === undefined ? {} : { inputPair: frame.inputPair }),
                        ...(frame.width === undefined ? {} : { width: frame.width }),
                        ...(frame.height === undefined ? {} : { height: frame.height }),
                        ...(frame.observations === undefined
                          ? {}
                          : { observations: frame.observations }),
                      })),
                    }),
              }),
        };
        const parsed =
          record.role === "critic"
            ? parseCriticAnswer(read.text, known)
            : parseBallotAnswer(read.text, known);
        // The terminal text is the last answer: like the last tool attempt,
        // a schema-decodable critic answer that fails only on requirement
        // assessments is accepted after making those assessments honest.
        let downgradedTerminal: DowngradedCriticAnswer | null = null;
        if (parsed.kind === "invalid" && record.role === "critic") {
          const textParsed = parseAnswerText(read.text);
          if (textParsed.kind !== "invalid") {
            const decoded = decodeStrict(GameReviewCriticAnswer, textParsed.value, "critic");
            downgradedTerminal =
              decoded.kind === "invalid"
                ? null
                : downgradeUnsupportedRequirements(decoded.answer, known);
          }
        }
        const effectiveTerminal =
          downgradedTerminal !== null
            ? { kind: "valid" as const, answer: downgradedTerminal.answer }
            : parsed;
        if (effectiveTerminal.kind === "invalid") {
          const bounded = boundRawAnswer(read.text);
          return {
            kind: "invalid",
            reason: parsed.kind === "invalid" ? parsed.reason : "The answer is invalid.",
            raw: bounded.raw,
            truncated: bounded.truncated,
          };
        }
        if (record.role === "critic") {
          const coverageError = yield* coverageAttemptError(
            record,
            effectiveTerminal.answer as GameReviewCriticAnswer,
            record.runId ?? tool?.runId ?? null,
          );
          if (coverageError !== null) {
            const bounded = boundRawAnswer(read.text);
            return {
              kind: "invalid",
              reason: coverageError,
              raw: bounded.raw,
              truncated: bounded.truncated,
            };
          }
        }
        return record.role === "critic"
          ? {
              kind: "critic",
              answer: effectiveTerminal.answer as GameReviewCriticAnswer,
              // The recorded raw matches the returned answer: the server's
              // encoded downgrade when the terminal text needed rescuing.
              raw:
                downgradedTerminal !== null
                  ? encodeReviewAnswer(downgradedTerminal.answer)
                  : read.text,
              ...(record.qualityRubricVersion === undefined
                ? {}
                : { qualityRubricVersion: record.qualityRubricVersion }),
            }
          : {
              kind: "ballot",
              answer: effectiveTerminal.answer as GameReviewBallotAnswer,
              raw: read.text,
            };
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
            .map((frame) => {
              const observation = playtestIntervalObservation(frame.label);
              return {
                frameId: frame.id,
                label: frame.label,
                stepIndex: frame.inputPair?.stepIndex ?? observation?.stepIndex ?? null,
                ...(observation === null ? {} : { observationMs: observation.elapsedMs }),
              };
            });
          if (frames.length === 0) continue;
          routes.push({
            id: `try-${call}`,
            buildId: stored.buildId,
            steps: stored.steps,
            ...(stored.setupSteps === undefined ? {} : { setupSteps: stored.setupSteps }),
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
      detailCalls,
      noteRecipeCall,
      recipeCalls,
      tryInput,
      inspectDetail,
      start,
      toolRole,
      repairChild,
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
