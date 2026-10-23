// Historical decoding only. Live review contracts live in gameReview.ts.
import * as Schema from "effect/Schema";
import { GameQualificationRead, GameQualificationStageRead } from "./game.ts";

/**
 * The visual rubric. Every dimension is scored 0–4 against anchors in the
 * judge's prompt, and `missing` means no supplied frame shows evidence for it
 * at all — evidence the judge could not see is not a zero, because a zero
 * would read as "present and broken" and hide the difference from the agent.
 */
export const GAME_VISUAL_DIMENSIONS = [
  "readability",
  "valueSeparation",
  "cameraFraming",
  "styleConsistency",
  "feedback",
  "designCompliance",
] as const;
export const GameVisualDimension = Schema.Literals(GAME_VISUAL_DIMENSIONS);
export type GameVisualDimension = typeof GameVisualDimension.Type;

export const GameVisualScore = Schema.Union([
  Schema.Literal("missing"),
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
]);
export type GameVisualScore = typeof GameVisualScore.Type;

export const GameVisualDimensionScore = Schema.Struct({
  dimension: GameVisualDimension,
  score: GameVisualScore,
  /** One sentence naming what in the frames supports the score. */
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
});
export type GameVisualDimensionScore = typeof GameVisualDimensionScore.Type;

/**
 * One concrete fix, tied to a frame the judge was actually given. The frame id
 * is the label from the prompt (F1…F6), never a caption the judge invented.
 */
export const GameVisualRepairRequest = Schema.Struct({
  frame: Schema.String.check(Schema.isMaxLength(16)),
  fix: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
});
export type GameVisualRepairRequest = typeof GameVisualRepairRequest.Type;

/**
 * Why a frame was selected. Only the gameplay roles carry evidence of play;
 * `result` is the screen the run ended on (an approved win or lose claim was
 * met there), which the judge may read for feedback but never for the look of
 * the game itself.
 */
export const GameVisualFrameRole = Schema.Literals([
  "early",
  "interaction",
  "hazard",
  "later",
  "finish",
  "result",
]);
export type GameVisualFrameRole = typeof GameVisualFrameRole.Type;

export const GameVisualFrame = Schema.Struct({
  /** The id used in the prompt and in repair requests. */
  id: Schema.String,
  /** The evidence caption, carried only as a caption. */
  label: Schema.String,
  /** Game-relative PNG path. */
  path: Schema.String,
  role: GameVisualFrameRole,
  /** What the persisted probe state showed at this frame, when it showed anything. */
  evidence: Schema.optionalKey(Schema.String),
});
export type GameVisualFrame = typeof GameVisualFrame.Type;

/**
 * One independent visual judgement of one playtest evidence folder, bound to
 * the same source/build/design identities as the rest of qualification.
 * `unavailable` is the canary/provider failure: the visual stage never reads
 * it as passed.
 */
export const GameVisualJudgement = Schema.Struct({
  status: Schema.Literals(["passed", "failed", "unavailable"]),
  judgedAt: Schema.String,
  /** `instance/model` that answered, so a judgement is auditable. */
  model: Schema.String,
  sourceId: Schema.String,
  buildId: Schema.String,
  /** Null for a legacy game with no approved design revision. */
  designHash: Schema.NullOr(Schema.String),
  evidenceDirectory: Schema.String,
  frames: Schema.Array(GameVisualFrame),
  dimensions: Schema.Array(GameVisualDimensionScore),
  repairRequests: Schema.Array(GameVisualRepairRequest),
  /** Judgements left for this approved design revision after this one. */
  roundsLeft: Schema.Number,
  /** Why the judgement is unavailable, or the pass/fail rule that decided it. */
  detail: Schema.optionalKey(Schema.String),
});
export type GameVisualJudgement = typeof GameVisualJudgement.Type;

/** Historical benchmark rows retain the exact judgement they originally recorded. */
export const LegacyGameVisualStageRead = Schema.Struct({
  ...GameQualificationStageRead.fields,
  stage: Schema.Literal("visual"),
  visual: Schema.optionalKey(GameVisualJudgement),
});
export const LegacyGameQualificationRead = Schema.Struct({
  ...GameQualificationRead.fields,
  stages: Schema.Array(Schema.Union([GameQualificationStageRead, LegacyGameVisualStageRead])),
});
export type LegacyGameQualificationRead = typeof LegacyGameQualificationRead.Type;
export type LegacyGameQualificationStageRead = LegacyGameQualificationRead["stages"][number];
