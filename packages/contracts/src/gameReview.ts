import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { RunId, ThreadId } from "./baseSchemas.ts";
import {
  GamePlaytestStep,
  GamePlaytestState,
  GamePlaytestInputPair,
  GamePlaytestScreenshot,
  GameViewport,
  GameProductionStatus,
  GameProduction,
} from "./game.ts";
import { ModelSelection } from "./modelSelection.ts";
import type { GameAcceptanceCriterion } from "./gameDesign.ts";

// Prose length must not discard a model's otherwise valid decision.
const reviewText = (cap: number) =>
  Schema.String.pipe(
    Schema.decodeTo(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(cap)), {
      decode: SchemaGetter.transform((text) =>
        text.length > cap ? `${text.slice(0, cap - " [truncated]".length)} [truncated]` : text,
      ),
      encode: SchemaGetter.passthrough(),
    }),
  );

/**
 * The review loop's judgement vocabulary. A defect is something the critic saw
 * in a frame, at one of three severities; a preservation item is behaviour the
 * creator already has and a repair must not take away. Both are frozen into the
 * round that produced them, so a later edit of the game cannot rewrite its own
 * review.
 */
export const GAME_REVIEW_SEVERITIES = ["blocker", "visible", "nit"] as const;
export const GameReviewSeverity = Schema.Literals(GAME_REVIEW_SEVERITIES);
export type GameReviewSeverity = typeof GameReviewSeverity.Type;

export const GameReviewDefect = Schema.Struct({
  severity: GameReviewSeverity,
  /** One observed fault, in the critic's words. */
  what: reviewText(400),
  /** A frame id from the evidence manifest, never a caption the critic invented. */
  frameId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  /** A concrete change with a yes/no completion test. */
  fix: reviewText(400),
  /**
   * A catalog recipe the critic fetched that explains the mechanism behind the
   * fix. The server validates it against the shipped catalog, so a repair can
   * fetch the exact reference instead of guessing.
   */
  recipeId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
});
export type GameReviewDefect = typeof GameReviewDefect.Type;

export const GameReviewDoNotRegress = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  what: reviewText(400),
  frameId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  /**
   * An existing factual check associated with this behaviour, when one exists.
   * Ballots still judge preservation separately for each build.
   */
  checkId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
});
export type GameReviewDoNotRegress = typeof GameReviewDoNotRegress.Type;

/**
 * One frame from an experiment the critic cited, frozen with the round so the
 * route can be replayed on both builds after the repair.
 */
export const GameReviewExperimentFrame = Schema.Struct({
  frameId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  stepIndex: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Elapsed within the step for a cited interval observation. */
  observationMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type GameReviewExperimentFrame = typeof GameReviewExperimentFrame.Type;

/**
 * A critic experiment route, not its outcome: the exact inputs and capture
 * cadence are replayed on the incumbent and the candidate for the ballots.
 */
export const GameReviewExperimentRoute = Schema.Struct({
  /** The critic's call id, e.g. try-1. */
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  /** The build the critic actually played when it recorded the route. */
  buildId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  steps: Schema.Array(GamePlaytestStep),
  /**
   * Uncaptured prelude replayed from fresh boot before steps, when the critic
   * used one. Absent on legacy routes; replay runs all of setup+steps fresh
   * with the same capture boundary so citations never alias frame indices.
   */
  setupSteps: Schema.optionalKey(Schema.Array(GamePlaytestStep)),
  captureEveryMs: Schema.Number,
  viewport: Schema.NullOr(GameViewport),
  /** Only the frames the critic cited; the route replays all of its steps. */
  frames: Schema.Array(GameReviewExperimentFrame),
});
export type GameReviewExperimentRoute = typeof GameReviewExperimentRoute.Type;

/** The four pairwise facets a ballot must answer for each comparison. */
export const GAME_REVIEW_FACETS = ["works", "look", "feel", "play"] as const;
export const GameReviewFacet = Schema.Literals(GAME_REVIEW_FACETS);
export type GameReviewFacet = typeof GameReviewFacet.Type;

export const GAME_REVIEW_CHOICES = ["A", "B", "tie"] as const;
export const GameReviewChoice = Schema.Literals(GAME_REVIEW_CHOICES);
export type GameReviewChoice = typeof GameReviewChoice.Type;

/**
 * The control pair's labels: C and D are the same captured frames shown twice.
 * A ballot that prefers one of them has failed a position check, so the answer
 * vocabulary names the control sides rather than reusing A/B.
 */
export const GAME_REVIEW_CONTROL_CHOICES = ["C", "D", "tie"] as const;
export const GameReviewControlChoice = Schema.Literals(GAME_REVIEW_CONTROL_CHOICES);
export type GameReviewControlChoice = typeof GameReviewControlChoice.Type;

/** Stored control answers from before the C/D vocabulary may still say A or B. */
const storedControlChoice = Schema.Literals(["A", "B", "C", "D", "tie"]);

export const GAME_REVIEW_PRESERVATION_VERDICTS = ["preserved", "lost", "unknown"] as const;
export const GameReviewPreservationVerdict = Schema.Literals(GAME_REVIEW_PRESERVATION_VERDICTS);
export type GameReviewPreservationVerdict = typeof GameReviewPreservationVerdict.Type;

/** Every facet is required; an omitted facet is an incomplete ballot. */
export const GameReviewFacetVerdicts = Schema.Struct({
  works: GameReviewChoice,
  look: GameReviewChoice,
  feel: GameReviewChoice,
  play: GameReviewChoice,
});
export type GameReviewFacetVerdicts = typeof GameReviewFacetVerdicts.Type;

export const GameReviewControlVerdicts = Schema.Struct({
  works: GameReviewControlChoice,
  look: GameReviewControlChoice,
  feel: GameReviewControlChoice,
  play: GameReviewControlChoice,
});
export type GameReviewControlVerdicts = typeof GameReviewControlVerdicts.Type;

/** What storage keeps: new C/D answers and legacy A/B ones read the same way. */
const GameReviewStoredControlVerdicts = Schema.Struct({
  works: storedControlChoice,
  look: storedControlChoice,
  feel: storedControlChoice,
  play: storedControlChoice,
});

/**
 * One preservation item judged on both sides of a ballot. `frameIds` are the
 * manifest frames the verdict cites, so a bare claim cannot pass as evidence.
 */
export const GameReviewPreservationEntry = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  A: GameReviewPreservationVerdict,
  B: GameReviewPreservationVerdict,
  frameIds: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
});
export type GameReviewPreservationEntry = typeof GameReviewPreservationEntry.Type;

export const GameReviewFundamental = Schema.Struct({
  verdict: Schema.Literals(["yes", "no", "cannot-tell"]),
  frameIds: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16))).check(
    Schema.isMaxLength(8),
  ),
  note: reviewText(400),
});
export const GameReviewFundamentals = Schema.Struct({
  boots: GameReviewFundamental,
  respondsToInput: GameReviewFundamental,
  coreActionVisible: GameReviewFundamental,
  stateReadable: GameReviewFundamental,
});
export type GameReviewFundamentals = typeof GameReviewFundamentals.Type;

/**
 * One approved acceptance promise the critic judged. The id binds to the
 * frozen DESIGN_REQUIREMENTS the round started with; the verdict reuses the
 * fundamentals' vocabulary so cannot-tell stays neutral and is never read as
 * fulfilled. Frame citations are validated like any other evidence.
 */
export const GameReviewRequirementChallenge = Schema.Struct({
  /** Frames of the separate ordinary-play counterexample experiment. */
  frameIds: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
  /** Which missing trigger/condition the counterexample tested, in one line. */
  note: reviewText(400),
});
export type GameReviewRequirementChallenge = typeof GameReviewRequirementChallenge.Type;

export const GameReviewRequirementAssessment = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  verdict: Schema.Literals(["yes", "no", "cannot-tell"]),
  frameIds: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16))).check(
    Schema.isMaxLength(8),
  ),
  note: reviewText(400),
  /** Separate counterexample for a frozen win/lose yes; absent on old records. */
  challenge: Schema.optionalKey(GameReviewRequirementChallenge),
});
export type GameReviewRequirementAssessment = typeof GameReviewRequirementAssessment.Type;

/**
 * A server-applied downgrade of one requirement assessment. The critic's
 * verdict stood unsupported on the last answer attempt, so the server
 * recorded cannot-tell with the evidence rule's reason instead of losing the
 * whole review. The id names the downgraded requirement; the reason is the
 * refused evidence rule. Never written by the critic.
 */
export const GameReviewRequirementDowngrade = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  reason: reviewText(2000),
});
export type GameReviewRequirementDowngrade = typeof GameReviewRequirementDowngrade.Type;

/**
 * End-state evidence policy: a frozen win/lose yes must show its own
 * measured transition and a separate measured counterexample. Version 1
 * checks only the named predicate. Version 2 also requires a fully
 * non-terminal before and challenge across all frozen predicates, and
 * forbids reaching the opposite kind after. Opt-in: records without it
 * skip the check and stay compatible.
 */
export const END_STATE_EVIDENCE_POLICY_VERSION = 2;

/** Frozen win/lose promise the end-state check reads, never mutable DESIGN. */
export const GameReviewEndStateRequirement = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  kind: Schema.Literals(["win", "lose"]),
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  expect: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
export type GameReviewEndStateRequirement = typeof GameReviewEndStateRequirement.Type;

/** Bounded measured scalars carried with a frozen evidence frame. */
export const GameReviewMeasuredObservations = Schema.Record(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  Schema.Union([Schema.Finite, Schema.Boolean]),
);
export type GameReviewMeasuredObservations = typeof GameReviewMeasuredObservations.Type;

/** Largest observation set one frozen frame carries; approved keys only. */
export const END_STATE_OBSERVATION_MAX_KEYS = 12;

/**
 * Eligible frozen promises: win/lose kinds with a numeric observe the player
 * reaches (==, >=, <=). Presentation, observe-less and no-lose declarations
 * never join; a win/lose that observes `changes` is not an end state and is
 * excluded the same way. Pure so the session freeze and the parser share one
 * definition without heavy services.
 */
export const endStateEligibleRequirements = (
  acceptance: ReadonlyArray<GameAcceptanceCriterion>,
): ReadonlyArray<GameReviewEndStateRequirement> => {
  const eligible: GameReviewEndStateRequirement[] = [];
  for (const criterion of acceptance) {
    if (criterion.kind !== "win" && criterion.kind !== "lose") continue;
    const observe = criterion.observe;
    if (observe === undefined) continue;
    // A no-lose declaration carries no observe, so it never reaches here.
    if (observe.key.trim() === "" || observe.expect === "changes") continue;
    if (!/^(==|>=|<=)-?\d+(?:\.\d+)?$/.test(observe.expect)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(observe.key)) continue;
    eligible.push({
      id: criterion.id,
      kind: criterion.kind,
      key: observe.key,
      expect: observe.expect,
    });
  }
  return eligible;
};

/**
 * Whether one measured scalar satisfies an approved ==, >= or <= expect.
 * Booleans read as 1/0 so `won ==1` matches a boolean win. `changes` never
 * satisfies a single sample; strings and missing values never satisfy.
 */
export const satisfiesEndStateExpect = (
  expect: string,
  raw: number | boolean | null | undefined,
): boolean => {
  if (raw === null || raw === undefined) return false;
  const value = typeof raw === "boolean" ? (raw ? 1 : 0) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const match = expect.match(/^(==|>=|<=)(-?\d+(?:\.\d+)?)$/);
  if (match === null) return false;
  const target = Number(match[2]);
  if (match[1] === "==") return Math.abs(value - target) < 1e-9;
  if (match[1] === ">=") return value >= target;
  return value <= target;
};

/**
 * Keeps only approved numeric/boolean scalars, bounded to the frozen keys.
 * Strings, missing values and unapproved keys are dropped, never invented.
 */
export const pickEndStateObservations = (
  gameState:
    | Readonly<Record<string, number | boolean | string | null | undefined>>
    | null
    | undefined,
  allowedKeys: ReadonlySet<string> | ReadonlyArray<string>,
): Record<string, number | boolean> => {
  if (gameState === null || gameState === undefined) return {};
  const allowed = allowedKeys instanceof Set ? allowedKeys : new Set(allowedKeys);
  const picked: Record<string, number | boolean> = {};
  for (const key of allowed) {
    if (Object.keys(picked).length >= END_STATE_OBSERVATION_MAX_KEYS) break;
    const raw = gameState[key];
    if (typeof raw === "boolean") picked[key] = raw;
    else if (typeof raw === "number" && Number.isFinite(raw)) picked[key] = raw;
  }
  return picked;
};

/**
 * Absolute quality rubric. Each review freezes its version and task text. Seven creator-relative
 * diagnostic dimensions, deliberately not a genre checklist: art consistency
 * (the game's own look holds across frames), animation (motion reads across
 * frames), audio (heard effect; screenshots alone can never judge it),
 * readability (legible and accurate state feedback), progression (goals, challenge or content change),
 * agency (choices have visible consequences), playability (a player can act).
 * Every dimension answers yes, no or cannot-tell; unknown stays neutral and
 * is never averaged into a score.
 */
export const GAME_REVIEW_QUALITY_RUBRIC_VERSION = 2;
export const GAME_REVIEW_QUALITY_DIMENSIONS = [
  "artConsistency",
  "animation",
  "audio",
  "readability",
  "progression",
  "agency",
  "playability",
] as const;
export const GameReviewQualityDimension = Schema.Literals(GAME_REVIEW_QUALITY_DIMENSIONS);
export type GameReviewQualityDimension = typeof GameReviewQualityDimension.Type;

/** One dimension's judgment: a concrete subject, bounded frame evidence, a reason. */
export const GameReviewQualityVerdict = Schema.Struct({
  verdict: Schema.Literals(["yes", "no", "cannot-tell"]),
  frameIds: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16))).check(
    Schema.isMaxLength(8),
  ),
  note: reviewText(400),
});
export type GameReviewQualityVerdict = typeof GameReviewQualityVerdict.Type;

export const GameReviewQuality = Schema.Struct({
  artConsistency: GameReviewQualityVerdict,
  animation: GameReviewQualityVerdict,
  audio: GameReviewQualityVerdict,
  readability: GameReviewQualityVerdict.annotate({
    description:
      "State, goals and action feedback must be legible, understandable and accurate. Contradictory messages and observed consequences are a defect even when the text is legible.",
  }),
  progression: GameReviewQualityVerdict.annotate({
    description:
      "Visible changes in goals, challenge or accessible content. A coin/score counter alone cannot establish progression or pacing; short pickup-only evidence is cannot-tell.",
  }),
  agency: GameReviewQualityVerdict,
  playability: GameReviewQualityVerdict,
});
export type GameReviewQuality = typeof GameReviewQuality.Type;

/** Exact coverage of one quality assessment: assessed dimensions out of the frozen rubric. */
export const GameReviewQualityCoverage = Schema.Struct({
  rubricVersion: Schema.Int,
  assessed: Schema.Int,
  total: Schema.Int,
  unknowns: Schema.Int,
});
export type GameReviewQualityCoverage = typeof GameReviewQualityCoverage.Type;

export const gameReviewQualityCoverage = (
  quality: GameReviewQuality | undefined,
  rubricVersion: number = GAME_REVIEW_QUALITY_RUBRIC_VERSION,
): GameReviewQualityCoverage => {
  if (quality === undefined)
    return {
      rubricVersion,
      assessed: 0,
      total: GAME_REVIEW_QUALITY_DIMENSIONS.length,
      unknowns: GAME_REVIEW_QUALITY_DIMENSIONS.length,
    };
  const unknowns = GAME_REVIEW_QUALITY_DIMENSIONS.filter(
    (dimension) => quality[dimension].verdict === "cannot-tell",
  ).length;
  return {
    rubricVersion,
    assessed: GAME_REVIEW_QUALITY_DIMENSIONS.length,
    total: GAME_REVIEW_QUALITY_DIMENSIONS.length,
    unknowns,
  };
};
export const GameReviewCriticAnswer = Schema.Struct({
  fundamentals: GameReviewFundamentals,
  defects: Schema.Array(GameReviewDefect).check(Schema.isMaxLength(5)),
  doNotRegress: Schema.Array(GameReviewDoNotRegress).check(Schema.isMaxLength(8)),
  /**
   * One entry per frozen requirement when a bound design exists. Absent on
   * legacy games and on answers written before requirements existed, which
   * stay readable and are never treated as a decision about the design.
   */
  requirements: Schema.optionalKey(
    Schema.Array(GameReviewRequirementAssessment).check(Schema.isMaxLength(12)),
  ),
  /**
   * Server-applied downgrades on the last answer attempt: which requirement
   * ids the server turned to cannot-tell and why. Absent on legacy answers
   * and on answers the critic wrote without server help, which stay readable
   * and are never treated as downgraded.
   */
  downgradedRequirements: Schema.optionalKey(
    Schema.Array(GameReviewRequirementDowngrade).check(Schema.isMaxLength(12)),
  ),
  /** Server-derived: the frozen design packet omitted or shortened promises. */
  requirementsIncomplete: Schema.optionalKey(Schema.Boolean),
  /**
   * Absolute quality across the frozen rubric, one verdict per dimension.
   * Absent on legacy answers written before the rubric existed: those stay
   * readable and count as unknown, never as met. New sessions require
   * exact-once coverage of every dimension.
   */
  quality: Schema.optionalKey(GameReviewQuality),
});
export type GameReviewCriticAnswer = typeof GameReviewCriticAnswer.Type;

const GameReviewFixJudgment = Schema.Struct({
  fixed: Schema.Literals(["yes", "no", "cannot-tell"]),
  frameIds: GameReviewPreservationEntry.fields.frameIds,
});
const GameReviewDefectJudgment = Schema.Struct({
  id: GameReviewPreservationEntry.fields.id,
  A: GameReviewFixJudgment,
  B: GameReviewFixJudgment,
});
const GameReviewRegression = Schema.Struct({
  what: reviewText(600),
  frameIds: GameReviewPreservationEntry.fields.frameIds,
});

/**
 * The overall choice decides quality; facets explain tradeoffs. Preservation
 * is assessed per build, with identical-build controls and cited evidence.
 */
export const GameReviewBallotAnswer = Schema.Struct({
  overall: GameReviewChoice,
  overallReason: reviewText(600),
  main: GameReviewFacetVerdicts,
  defects: Schema.Array(GameReviewDefectJudgment).check(Schema.isMaxLength(5)),
  regressions: Schema.Struct({
    A: Schema.Array(GameReviewRegression).check(Schema.isMaxLength(8)),
    B: Schema.Array(GameReviewRegression).check(Schema.isMaxLength(8)),
  }),
  preservation: Schema.Array(GameReviewPreservationEntry),
  control: GameReviewStoredControlVerdicts,
  reason: reviewText(2_000),
});
export type GameReviewBallotAnswer = typeof GameReviewBallotAnswer.Type;

/** The ballot tool exposes the four choices directly; storage keeps `main`. */
export const GameReviewBallotInput = Schema.Struct({
  overall: GameReviewBallotAnswer.fields.overall,
  overallReason: GameReviewBallotAnswer.fields.overallReason,
  ...GameReviewFacetVerdicts.fields,
  defects: GameReviewBallotAnswer.fields.defects,
  regressions: GameReviewBallotAnswer.fields.regressions,
  preservation: GameReviewBallotAnswer.fields.preservation,
  control: GameReviewControlVerdicts,
  reason: GameReviewBallotAnswer.fields.reason,
});
export type GameReviewBallotInput = typeof GameReviewBallotInput.Type;

export const GameReviewReportResult = Schema.Struct({
  accepted: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  attemptsRemaining: Schema.Number,
  ended: Schema.Boolean,
  /** Exact absolute-quality coverage of the accepted answer, when one was accepted. */
  qualityCoverage: Schema.optionalKey(GameReviewQualityCoverage),
});
export type GameReviewReportResult = typeof GameReviewReportResult.Type;

/** One model answer is at most this many bytes of text, before parsing. */
export const GAME_REVIEW_ANSWER_MAX_BYTES = 16 * 1024;

/**
 * A review child can ask for a native-resolution crop of one evidence frame
 * it already has, instead of judging a small effect from a full-frame view.
 * The crop and its pixel stats are read-only measurements: the evidence tree
 * is never extended, citations still name the original frame, and no number
 * the tool returns is a quality claim.
 */
export const GAME_REVIEW_DETAIL_BOUNDS = {
  /** Smallest and largest crop edge, in frame pixels. */
  minRegion: 8,
  maxRegion: 480,
  /** Integer upscale applied equally to both halves of a before/after pair. */
  minScale: 1,
  maxScale: 4,
  /** Detail views per child run; each is one cropped PNG in the tool result. */
  maxCalls: 6,
  /** Largest cropped PNG the tool returns, in bytes. */
  maxOutputBytes: 1_000_000,
  /** Largest evidence PNG the tool will decode, in bytes. */
  maxFrameBytes: 12 * 1024 * 1024,
  /** Largest evidence dimension the tool will decode, in pixels. */
  maxFrameDimension: 4096,
} as const;

export const GameReviewDetailInput = Schema.Struct({
  /** A frame id from the child's evidence manifest, never a path. */
  frameId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  /** Crop origin in frame pixels; the manifest's width/height are the frame size. */
  x: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  y: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  width: Schema.Int.check(
    Schema.isBetween({
      minimum: GAME_REVIEW_DETAIL_BOUNDS.minRegion,
      maximum: GAME_REVIEW_DETAIL_BOUNDS.maxRegion,
    }),
  ),
  height: Schema.Int.check(
    Schema.isBetween({
      minimum: GAME_REVIEW_DETAIL_BOUNDS.minRegion,
      maximum: GAME_REVIEW_DETAIL_BOUNDS.maxRegion,
    }),
  ),
  /** Integer upscale so a small region stays readable; defaults to 2. */
  scale: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({
        minimum: GAME_REVIEW_DETAIL_BOUNDS.minScale,
        maximum: GAME_REVIEW_DETAIL_BOUNDS.maxScale,
      }),
    ),
  ),
});
export type GameReviewDetailInput = typeof GameReviewDetailInput.Type;

const GameReviewDetailMean = Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]);

/**
 * One scaled crop (a before/after card counts as one image), with the source
 * frame and region it came from so the verdict can cite the original frame.
 * Means and deltas are measurements only; the child still judges the effect.
 */
export const GameReviewDetailResult = Schema.Struct({
  screenshots: Schema.Array(GamePlaytestScreenshot).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2),
  ),
  detail: Schema.Struct({
    frameId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16)),
    x: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    y: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    scale: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    /** The decoded source pixels the region was cut from. */
    sourceWidth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    sourceHeight: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    /** True when the same region was cut from both halves of a pair card. */
    pair: Schema.Boolean,
    regions: Schema.Array(
      Schema.Struct({
        name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16)),
        mean: GameReviewDetailMean,
        pixels: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
    delta: Schema.optionalKey(
      Schema.Struct({
        meanAbs: GameReviewDetailMean,
        changedPercent: Schema.Number,
      }),
    ),
  }),
});
export type GameReviewDetailResult = typeof GameReviewDetailResult.Type;

/**
 * The loop's spend. The default is three repairs or forty-five elapsed minutes,
 * whichever runs out first, and includes the checks and reviews those repairs
 * caused. Zero repairs is a valid budget: it ends without opening a review round.
 */
export const GameReviewBudget = Schema.Struct({
  repairs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(3)),
  elapsedMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type GameReviewBudget = typeof GameReviewBudget.Type;

export const DEFAULT_GAME_REVIEW_BUDGET: GameReviewBudget = {
  repairs: 3,
  elapsedMs: 45 * 60_000,
};

/** Builds are engine- and target-tagged so an artifact is never played as another kind. */
export const GameReviewTarget = Schema.Literals(["Web", "Linux"]);
export type GameReviewTarget = typeof GameReviewTarget.Type;

/**
 * The immutable bytes a round selected or rejected. `buildId` is the SHA-256
 * of the artifact's sorted path/content hashes; `directory` is the
 * build-addressed directory under the game's builds/ tree, never a mutable
 * staging path.
 */
export const GameReviewArtifact = Schema.Struct({
  buildId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  /** Game-relative directory, e.g. builds/candidates/<buildId>. */
  directory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
  /** The source manifest identity the export started from, when known. */
  sourceId: Schema.NullOr(Schema.String),
  engine: Schema.Literal("godot"),
  target: GameReviewTarget,
  /** Game-relative entry file inside `directory`. */
  entry: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  /** Response headers the artifact needs served, when it needs any. */
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type GameReviewArtifact = typeof GameReviewArtifact.Type;

/** The build Play and preview serve. Switching it is the only promotion. */
export const GameSelectedBuild = Schema.Struct({
  ...GameReviewArtifact.fields,
  promotedAt: Schema.String,
  /** The round that won the build its place, or null for a direct publish. */
  roundId: Schema.NullOr(Schema.String),
});
export type GameSelectedBuild = typeof GameSelectedBuild.Type;

/**
 * Server-owned execution facts and raw observations frozen from a playtest.
 * Only factual checks can veto promotion; measurements belong to the critic.
 */
export const GameReviewCheck = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  status: Schema.Literals(["passed", "failed", "unmeasured"]),
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000))),
  /** Raw observations for the critic, never regression gates. */
  measurements: Schema.optionalKey(
    Schema.Struct({
      steps: Schema.Array(GamePlaytestStep),
      changedPercent: Schema.Number,
      state: Schema.NullOr(GamePlaytestState),
      designObservations: Schema.Array(Schema.String),
    }),
  ),
});
export type GameReviewCheck = typeof GameReviewCheck.Type;

/**
 * The builder's own declaration that it stands behind one exact export, with a
 * one-line note on what the game is (repair children name what they believe
 * they fixed). It is recorded only after the server's factual checks pass, so
 * the review starts on a build someone named and the code vouched for, never
 * on a playable state inferred from whatever was last written.
 */
export const GameSubmission = Schema.Struct({
  /** The turn whose tool call declared it. */
  runId: RunId,
  /** The build-addressed export the builder stands behind. */
  buildId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  note: reviewText(500),
  submittedAt: Schema.String,
});
export type GameSubmission = typeof GameSubmission.Type;

export const GameSubmitInput = Schema.Struct({
  /**
   * The export to stand behind; omitted means this game's latest export. The
   * server refuses a build whose engine inputs no longer match the current
   * folder (check `sources-current`), because the repair edits the folder the
   * current sources live in. Any retained export built from the current engine
   * inputs stays eligible; design and notes edits never block.
   */
  buildId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
  /** One line: what the game is, or which defects a repair fixed. */
  note: Schema.String.check(Schema.isPattern(/^[^\r\n]+$/)).pipe(Schema.decodeTo(reviewText(500))),
});
export type GameSubmitInput = typeof GameSubmitInput.Type;

/**
 * The submit tool's answer. A refusal is a value, not a thrown error: the agent
 * must read exactly which fact failed and fix the game, then submit again.
 */
export const GameSubmitResult = Schema.Struct({
  accepted: Schema.Boolean,
  message: Schema.String,
  buildId: Schema.NullOr(Schema.String),
  submission: Schema.NullOr(GameSubmission),
  /** Every fact the server checked, passed or not. */
  checks: Schema.Array(GameReviewCheck),
  /** True when this accepted submit was the game's first playable. */
  firstPlayable: Schema.optionalKey(Schema.Boolean),
  /** The production clock, so a refusal still shows the budget it is working in. */
  production: Schema.optionalKey(GameProductionStatus),
});
export type GameSubmitResult = typeof GameSubmitResult.Type;

/** Which artifact an anonymous ballot slot held. */
export const GameRepairBallotSide = Schema.Literals(["incumbent", "challenger"]);
export type GameRepairBallotSide = typeof GameRepairBallotSide.Type;

/**
 * One pairwise session's anonymous mapping. It is persisted before the child
 * starts, so a ballot's A/B (and C/D control) labels can always be translated
 * back to builds, and a restarted server cannot re-shuffle a ballot it already
 * asked about.
 */
export const GameReviewBallotPlan = Schema.Struct({
  /** 0 or 1; the two sessions see opposite A/B and independently shuffled C/D. */
  order: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  main: Schema.Struct({
    A: GameRepairBallotSide,
    B: GameRepairBallotSide,
  }),
  /** Both slots are the same build; only a position-biased answer prefers one. */
  control: Schema.Struct({
    C: GameRepairBallotSide,
    D: GameRepairBallotSide,
  }),
  /** The evidence directory hash at dispatch, when one exists. */
  evidenceHash: Schema.NullOr(Schema.String),
});
export type GameReviewBallotPlan = typeof GameReviewBallotPlan.Type;

/** The validated ballots (or why one was unusable) the decision was made on. */
export const GameReviewBallotRecord = Schema.Struct({
  order: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  outcome: Schema.Literals(["valid", "invalid"]),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  // Old history has facets without an overall judgment. Never invent a decision on read.
  answer: Schema.optionalKey(
    Schema.Struct({
      ...GameReviewBallotAnswer.fields,
      defects: Schema.optionalKey(GameReviewBallotAnswer.fields.defects),
      regressions: Schema.optionalKey(GameReviewBallotAnswer.fields.regressions),
      overall: Schema.optionalKey(GameReviewChoice),
      overallReason: Schema.optionalKey(GameReviewBallotAnswer.fields.overallReason),
    }),
  ),
  raw: Schema.optionalKey(Schema.String),
});
export type GameReviewBallotRecord = typeof GameReviewBallotRecord.Type;

/**
 * One repair loop's durable state. It is created once, when the builder run
 * that produced the current playable export ends, and owns the immutable
 * origin, both frozen selections and the spend. Everything a round learns
 * (checks, critic answer, candidate, ballots) lives in the round store; the
 * loop keeps only what outlives a round: where it came from, what it may spend
 * and how it ended.
 */
export const GAME_REPAIR_LOOP_STATUSES = ["running", "interrupted", "stopped"] as const;
export const GameRepairLoopStatus = Schema.Literals(GAME_REPAIR_LOOP_STATUSES);
export type GameRepairLoopStatus = typeof GameRepairLoopStatus.Type;

/**
 * The exact play inputs every candidate of this loop is checked with. They are
 * read from the builder's own playtest once, when the loop opens, so a repair
 * child's demonstration can never substitute an easier route for the one the
 * incumbent is judged on.
 */
export const GameReviewFrozenInputs = Schema.Struct({
  /** The ordinary-input route the builder played. */
  steps: Schema.Array(GamePlaytestStep),
  /** The viewport the route was recorded at, when the evidence had one. */
  viewport: Schema.NullOr(GameViewport),
  /**
   * The seed the route was recorded with. Godot playtests record none, so it
   * is "unknown"; that is honest and never blocks promotion. Loops written
   * before this field was recorded read null.
   */
  seed: Schema.NullOr(Schema.Union([Schema.Number, Schema.Literal("unknown")])),
});
export type GameReviewFrozenInputs = typeof GameReviewFrozenInputs.Type;

/**
 * What this loop spent. `measured` only when every child it started reported
 * provider-turn usage; a child that did not makes the whole loop `unknown`
 * rather than under-reporting as zero.
 */
export const GameReviewUsage = Schema.Struct({
  status: Schema.Literals(["measured", "unknown"]),
  providerTurns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  usedTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  inputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /**
   * Recipe tool calls made by this session. Absent on records written before
   * the count existed, which is unknown, not zero.
   */
  recipeCalls: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type GameReviewUsage = typeof GameReviewUsage.Type;

export const EMPTY_GAME_REVIEW_USAGE: GameReviewUsage = {
  status: "unknown",
  providerTurns: 0,
  usedTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

export const GameReviewChildUsage = Schema.Struct({
  role: Schema.Literals(["critic", "repair", "ballot"]),
  order: Schema.Int,
  childThreadId: ThreadId,
  runId: Schema.NullOr(RunId),
  tryInputCalls: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  usage: GameReviewUsage,
});
export type GameReviewChildUsage = typeof GameReviewChildUsage.Type;

export const GameReviewUsageByRole = Schema.Struct({
  critic: GameReviewUsage,
  repair: GameReviewUsage,
  ballot: GameReviewUsage,
  /** Subset of child usage with at least one try_input call, not an added cost. */
  "try_input-heavy": GameReviewUsage,
});

/** One captured frame a review child is shown, stored outside the game. */
export const GameRepairFrame = Schema.Struct({
  inputPair: Schema.optionalKey(GamePlaytestInputPair),
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  /** Absolute path in server state; never inside the game. */
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  /** The capture window these pixels came from, when the run recorded it. */
  width: Schema.optionalKey(Schema.Number),
  height: Schema.optionalKey(Schema.Number),
  /** True for the differently shaped window capture; never dropped by a budget. */
  window: Schema.optionalKey(Schema.Boolean),
  /** Bounded approved numeric/boolean scalars measured with this frame. */
  observations: Schema.optionalKey(GameReviewMeasuredObservations),
});
export type GameRepairFrame = typeof GameRepairFrame.Type;

export const GameRepairLoop = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  id: Schema.String,
  /** Canonical game root; the record is keyed by its digest. */
  root: Schema.String,
  threadId: ThreadId,
  originatingRunId: RunId,
  originatingNodeId: Schema.String,
  /** The build the originating run exported; the loop repairs these bytes. */
  exportBuildId: Schema.String,
  /**
   * What the builder said this game is, when it submitted before the turn ended.
   * It is the origin note the review status shows, frozen with the loop.
   */
  submissionNote: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  status: GameRepairLoopStatus,
  /** Attempted repairs, counted when a repair starts. */
  repairsUsed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  budget: GameReviewBudget,
  builderSelection: ModelSelection,
  reviewSelection: ModelSelection,
  inputs: GameReviewFrozenInputs,
  /**
   * The admission generation at creation. A user action bumps it, so a loop
   * that lost its game never dispatches or promotes afterwards.
   */
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  startedAt: Schema.String,
  updatedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  promotedRounds: Schema.Array(Schema.String),
  decision: Schema.NullOr(Schema.Literals(["promote", "stop", "interrupt"])),
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2000))),
  usage: GameReviewUsage,
  /**
   * Recipe tool calls the originating build turn made before this loop opened.
   * Absent on loops written before the count existed.
   */
  buildRecipeCalls: Schema.optionalKey(
    Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
});
export type GameRepairLoop = typeof GameRepairLoop.Type;

export const GAME_REVIEW_ROUND_STATUSES = [
  "running",
  "promoted",
  "rejected",
  "stopped",
  "interrupted",
] as const;
export const GameReviewRoundStatus = Schema.Literals(GAME_REVIEW_ROUND_STATUSES);
export type GameReviewRoundStatus = typeof GameReviewRoundStatus.Type;

export const GameReviewDecision = Schema.Literals(["promote", "reject", "stop", "interrupt"]);
export type GameReviewDecision = typeof GameReviewDecision.Type;

/**
 * One repair round's durable record. A round is opened before the repair child
 * writes, and names the snapshot that restore falls back to. The review loop
 * session extends this record with frozen checks, ballots and model selection;
 * the lifecycle here is what makes a worse build impossible to keep.
 */
export const GameReviewRound = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  status: GameReviewRoundStatus,
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  /** The stored pre-repair snapshot whose source identity is the fallback. */
  incumbentSnapshotId: Schema.String,
  /** The source identity Play's selected build was exported from. */
  incumbentSourceId: Schema.String,
  incumbentBuildId: Schema.NullOr(Schema.String),
  /**
   * The source identity the server read after the repair child stopped
   * writing. A folder that no longer matches it was changed by someone else,
   * so restoring would discard a user edit.
   */
  postRepairSourceId: Schema.NullOr(Schema.String),
  /**
   * When a repair child was dispatched for this round. A review that stops
   * before dispatch (zero defects, an invalid critic) never touched the folder,
   * so there is nothing to restore.
   */
  repairStartedAt: Schema.optionalKey(Schema.String),
  /** The source rollback completed, so this round no longer offers Restore. */
  restoredAt: Schema.optionalKey(Schema.String),
  /**
   * The version an explicit restore preserved before rewriting the folder, so
   * the user can return to the state they had when they asked for the restore.
   */
  preRestoreSnapshotId: Schema.optionalKey(Schema.String),
  candidate: Schema.NullOr(GameReviewArtifact),
  /** The loop this round belongs to, when a loop opened it. */
  loopId: Schema.optionalKey(Schema.String),
  /**
   * The model selections frozen when the round opened. The review session
   * reads these instead of the thread's current composer, so changing the
   * model after the builder finished cannot change who reviews or repairs.
   */
  builderSelection: Schema.optionalKey(ModelSelection),
  reviewSelection: Schema.optionalKey(ModelSelection),
  childUsage: Schema.optionalKey(Schema.Array(GameReviewChildUsage)),
  usageByRole: Schema.optionalKey(GameReviewUsageByRole),
  fundamentals: Schema.optionalKey(GameReviewFundamentals),
  requirements: Schema.optionalKey(Schema.Array(GameReviewRequirementAssessment)),
  requirementsIncomplete: Schema.optionalKey(Schema.Boolean),
  /**
   * Server-applied downgrades frozen with the round, so history and reports
   * show which verdicts the server (not the critic) turned to cannot-tell.
   * Absent on legacy rounds, which read as never downgraded.
   */
  downgradedRequirements: Schema.optionalKey(Schema.Array(GameReviewRequirementDowngrade)),
  /**
   * Absolute quality frozen with the round: the rubric version the critic
   * answered against plus its per-dimension verdicts. Absent on legacy
   * rounds, which read as unknown, never as met; a mid-round rubric edit
   * cannot rewrite a frozen assessment.
   */
  quality: Schema.optionalKey(GameReviewQuality),
  qualityRubricVersion: Schema.optionalKey(Schema.Int),
  qualityCoverage: Schema.optionalKey(GameReviewQualityCoverage),
  defects: Schema.optionalKey(Schema.Array(GameReviewDefect)),
  doNotRegress: Schema.optionalKey(Schema.Array(GameReviewDoNotRegress)),
  /** The frozen check run the round was reviewed against. */
  checks: Schema.optionalKey(Schema.Array(GameReviewCheck)),
  /**
   * Routes of the experiments the critic cited, replayed on both builds so a
   * behaviour discovered outside the original check route is judged.
   */
  experiments: Schema.optionalKey(Schema.Array(GameReviewExperimentRoute)),
  /** The challenger's check run and the mechanical veto reason, when it ran. */
  candidateChecks: Schema.optionalKey(Schema.Array(GameReviewCheck)),
  mechanicalVeto: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  /**
   * The repair child's own `game_submit` note: which defects it believes it
   * fixed. It is testimony for the history; the ballots and checks still decide.
   */
  submissionNote: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  /** Anonymous mappings persisted before either ballot was dispatched. */
  ballots: Schema.optionalKey(Schema.Array(GameReviewBallotPlan)),
  /** The ballots' validated answers (or invalidity) at decision time. */
  ballotAnswers: Schema.optionalKey(Schema.Array(GameReviewBallotRecord)),
  budget: GameReviewBudget,
  decision: Schema.optionalKey(GameReviewDecision),
  /** The exact reason, never a score. */
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
});
export type GameReviewRound = typeof GameReviewRound.Type;

/** What a game's record says about selection and its round history. */

export const GameReviewState = Schema.Struct({
  selected: Schema.NullOr(GameSelectedBuild),
  rounds: Schema.Array(GameReviewRound),
  /** Builders' and repair children's submissions, newest last. */
  submissions: Schema.optionalKey(Schema.Array(GameSubmission)),
  /** The build's first playable and the producing turn's declarations. */
  production: Schema.optionalKey(Schema.NullOr(GameProduction)),
});
export type GameReviewState = typeof GameReviewState.Type;

export const GameReviewHistoryInput = Schema.Struct({
  threadId: ThreadId,
  before: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
});
export type GameReviewHistoryInput = typeof GameReviewHistoryInput.Type;
export const GameReviewEvidenceRef = Schema.Struct({
  role: Schema.Literals(["critic", "ballot"]),
  order: Schema.Number,
  directory: Schema.String,
  childThreadId: ThreadId,
  runId: Schema.NullOr(Schema.String),
  taskId: Schema.NullOr(Schema.String),
  hash: Schema.NullOr(Schema.String),
  frames: Schema.Array(GameRepairFrame),
});
export const GameReviewHistory = Schema.Struct({
  rounds: Schema.Array(
    Schema.Struct({ round: GameReviewRound, evidence: Schema.Array(GameReviewEvidenceRef) }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});
export type GameReviewHistory = typeof GameReviewHistory.Type;
export const GameSubmissionFacts = Schema.Struct({
  buildId: Schema.NullOr(Schema.String),
  directory: Schema.NullOr(Schema.String),
  checks: Schema.Array(GameReviewCheck),
  passed: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
});
export type GameSubmissionFacts = typeof GameSubmissionFacts.Type;

export const GameReviewStatus = Schema.Struct({
  loop: Schema.NullOr(GameRepairLoop),
  phase: Schema.String,
  held: Schema.Boolean,
  repairsLeft: Schema.Number,
  timeLeftMs: Schema.Number,
  budget: GameReviewBudget,
  restoreOffered: Schema.Boolean,
  /** The builder's production record: first playable, its submits and budget. */
  production: Schema.optionalKey(GameProductionStatus),
  /** Only computed when requested: hashes and checks Play's selected artifact. */
  selectedBuildFacts: Schema.optionalKey(Schema.NullOr(GameSubmissionFacts)),
  /**
   * Absolute-quality coverage of the newest round with a frozen assessment.
   * Absent when no round assessed quality yet; unknown dimensions stay
   * neutral and are never a score.
   */
  qualityCoverage: Schema.optionalKey(GameReviewQualityCoverage),
});
export type GameReviewStatus = typeof GameReviewStatus.Type;
export const GameReviewRestoreResult = Schema.Struct({
  kind: Schema.Literals(["restored", "blocked", "busy"]),
  message: Schema.String,
});

export type GameReviewRestoreResult = typeof GameReviewRestoreResult.Type;
