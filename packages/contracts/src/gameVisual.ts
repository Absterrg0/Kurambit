import * as Schema from "effect/Schema";

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

/** The model's own answer. The server computes pass/fail from these scores. */
export const GameVisualReview = Schema.Struct({
  dimensions: Schema.Array(GameVisualDimensionScore),
  /** At most three, so a failed review stays a bounded repair turn. */
  repairRequests: Schema.Array(GameVisualRepairRequest).check(Schema.isMaxLength(3)),
});
export type GameVisualReview = typeof GameVisualReview.Type;

/** Why a frame was selected; only these roles carry gameplay evidence. */
export const GameVisualFrameRole = Schema.Literals([
  "early",
  "interaction",
  "hazard",
  "later",
  "finish",
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

/** Every applicable dimension must reach this bar; no averaging. */
export const GAME_VISUAL_PASS_SCORE = 3;

/**
 * The whole-review verdict. Missing hazard or finish evidence can never pass:
 * an unreadable hazard the frames never showed is exactly the failure this
 * stage exists to catch. A design that declares "No lose state" has no hazard
 * to show, so `hazardRequired: false` drops only that requirement.
 */
export function evaluateVisualReview(input: {
  readonly review: GameVisualReview;
  readonly frames: readonly GameVisualFrame[];
  /** Defaults to true: a design with an observed lose criterion owes a hazard frame. */
  readonly hazardRequired?: boolean;
}): { readonly passed: boolean; readonly detail: string } {
  const byDimension = new Map<GameVisualDimension, GameVisualScore>();
  for (const score of input.review.dimensions) byDimension.set(score.dimension, score.score);
  const absent = GAME_VISUAL_DIMENSIONS.filter((dimension) => !byDimension.has(dimension));
  if (absent.length > 0)
    return { passed: false, detail: `The judge did not score: ${absent.join(", ")}.` };
  const low = GAME_VISUAL_DIMENSIONS.flatMap((dimension) => {
    const score = byDimension.get(dimension);
    if (score === "missing") return [`${dimension} has no evidence in the supplied frames`];
    return typeof score === "number" && score < GAME_VISUAL_PASS_SCORE
      ? [`${dimension} scored ${score} (needs ${GAME_VISUAL_PASS_SCORE})`]
      : [];
  });
  const hazard = input.frames.some((frame) => frame.role === "hazard");
  const finish = input.frames.some((frame) => frame.role === "finish");
  if (!hazard && input.hazardRequired !== false) low.push("no hazard frame was available to judge");
  if (!finish) low.push("no finish frame was available to judge");
  return low.length === 0
    ? {
        passed: true,
        detail: "Every dimension reached the bar, with all required evidence.",
      }
    : { passed: false, detail: low.join("; ") };
}
