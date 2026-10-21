// @effect-diagnostics nodeBuiltinImport:off -- The judge reads persisted evidence frames and writes its typed result beside them.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  GameOperationError,
  GameVisualDimensionScore,
  GameVisualJudgement,
  GameVisualRepairRequest,
  GameVisualReview,
  GAME_VISUAL_DIMENSIONS,
  ProviderInstanceId,
  evaluateVisualReview,
  type GameAcceptanceCriterion,
  type ModelSelection,
} from "@t3tools/contracts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { readDesignDocument } from "./GameDesignApproval.ts";
import { readPlaytestEvidence } from "./playtestEvidence.ts";
import { selectVisualFrames } from "./visualFrames.ts";
import { VISUAL_CANARY_ANSWER, canaryPng } from "./visualCanary.ts";
import { gameRecordFile } from "./gameRecord.ts";

/**
 * The reviewer the roadmap fixed: the same Codex Sol instance and high
 * reasoning used for review work. One constant, not a setting — a cheaper or
 * friendlier reviewer would reintroduce the self-grading this stage exists to
 * remove.
 */
const REVIEWER: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const REVIEWER_LABEL = `${REVIEWER.instanceId}/${REVIEWER.model}`;

/** One initial judgement and one after the single bounded repair turn. */
const MAX_JUDGEMENTS_PER_DESIGN = 2;

const VISUAL_DIRECTORY = "visual-review.json";
/** The untrusted model answer kept beside a failed review, bounded. */
const VISUAL_RAW_DIRECTORY = "visual-review.raw.json";
const RAW_REPLY_LIMIT = 64 * 1024;
const ART_DIRECTION_HEADING = "Art direction";

/** What the judge needs from the caller: the identities the result is bound to. */
export interface GameVisualJudgeInput {
  readonly sourceId: string;
  readonly buildId: string;
  readonly designHash: string | null;
  /** Game-relative `builds/playtests/<run>` folder that holds the frames. */
  readonly evidenceDirectory: string;
  readonly acceptance: readonly GameAcceptanceCriterion[];
}

export type GameVisualJudgeRun =
  | { readonly status: "judged"; readonly judgement: GameVisualJudgement }
  /** The approved design revision already spent its two judgements. */
  | { readonly status: "exhausted" };

export class GameVisualJudge extends Context.Service<
  GameVisualJudge,
  {
    /**
     * Reviews the frames of one qualifying playtest. The judgement is written
     * next to that evidence, and a failed/unavailable verdict is never a pass.
     */
    readonly run: (
      root: string,
      input: GameVisualJudgeInput,
    ) => Effect.Effect<GameVisualJudgeRun, GameOperationError>;
    /**
     * Judgements left for this approved design revision. Callers check this
     * before opening a visual attempt so an exhausted budget cannot erase the
     * last verdict by starting a stage it will refuse.
     */
    readonly remaining: (
      root: string,
      designHash: string | null,
    ) => Effect.Effect<number, GameOperationError>;
  }
>()("t3/game/GameVisualJudge") {}

/** The model's loose envelope; the strict review is decoded by the server. */
const RawDimension = Schema.Struct({
  dimension: Schema.String,
  score: Schema.Union([Schema.Number, Schema.String]),
  /** Required: the structured-output API cannot carry optional keys. */
  note: Schema.String,
});
const RawRepair = Schema.Struct({ frame: Schema.String, fix: Schema.String });
const RawReview = Schema.Struct({
  dimensions: Schema.Array(RawDimension),
  repairRequests: Schema.Array(RawRepair),
});
const decodeRawReview = Schema.decodeUnknownSync(RawReview);
const decodeReview = Schema.decodeUnknownSync(GameVisualReview);

/** Lowercase, punctuation-free spelling of a dimension name. */
const dimensionKey = (value: string) => value.toLowerCase().replace(/[^a-z]/g, "");
const DIMENSION_NAMES = new Map(
  GAME_VISUAL_DIMENSIONS.map((dimension) => [dimensionKey(dimension), dimension]),
);
const DIMENSION_ALIASES = new Map([
  ["cameraandframing", "cameraFraming"],
  ["cameraframing", "cameraFraming"],
  ["valueseparation", "valueSeparation"],
]);

/**
 * Maps a permissive reply onto the canonical rubric. Unknown extra entries
 * (models like to add a "limits" note) are dropped; the result is still
 * decoded against the strict schema, so a missing required dimension, a score
 * outside 0–4 or a caption-named repair request can never become a pass.
 */
const normalizeDimension = (value: string): string | null => {
  const key = dimensionKey(value);
  for (const [alias, dimension] of DIMENSION_ALIASES) if (key.startsWith(alias)) return dimension;
  for (const [name, dimension] of DIMENSION_NAMES) if (key.startsWith(name)) return dimension;
  return null;
};
const normalizeReview = (raw: typeof RawReview.Type): unknown => ({
  dimensions: raw.dimensions.flatMap((entry) => {
    const dimension = normalizeDimension(entry.dimension);
    if (dimension === null) return [];
    return [
      {
        dimension,
        score: typeof entry.score === "number" ? entry.score : entry.score.toLowerCase().trim(),
        note: entry.note,
      },
    ];
  }),
  // The bounded repair turn keeps the first three requests even when a verbose
  // model returns more; the persisted judgement never carries a fourth.
  repairRequests: raw.repairRequests.slice(0, 3),
});

const RawCanary = Schema.Struct({
  digit: Schema.String,
  backgroundColor: Schema.String,
});
const decodeRawCanary = Schema.decodeUnknownSync(RawCanary);

/** The two-judgement budget for one approved design revision. */
const StoredBudget = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    game: Schema.String,
    designHash: Schema.NullOr(Schema.String),
    judgements: Schema.Number,
  }),
);
const decodeStoredBudget = Schema.decodeUnknownSync(StoredBudget);
const encodeStoredBudget = Schema.encodeSync(StoredBudget);
const encodeJudgement = Schema.encodeSync(Schema.fromJsonString(GameVisualJudgement));
const encodeRawValue = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeRawReply = (value: unknown): string => encodeRawValue(value).slice(0, RAW_REPLY_LIMIT);

/** The `## Art direction` section of DESIGN.md, or null when the design omits it. */
const readArtDirection = (design: string | null): string | null => {
  if (design === null) return null;
  const lines = design.split(/\r?\n/);
  const body: string[] = [];
  let found = false;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading !== null) {
      if (found) break;
      found = heading[1] === ART_DIRECTION_HEADING;
      continue;
    }
    if (found) body.push(line);
  }
  const text = body.join("\n").trim();
  return text.length === 0 ? null : text.slice(0, 6_000);
};

const DIMENSION_ANCHORS = `Readability (player, hazards, goal) — 4: the player, every hazard and the goal are unmistakable in the frames that should show them. 3: all three read at a glance, at most one needs a second look. 2: one of the three is easy to lose against the background, or is never framed. 1: the player or a hazard is guesswork. 0: the player or a hazard cannot be found at all.

Value separation — 4: every layer is separated by value and hue, background darkest and goal/pickups brightest. 3: clear separation with one weak pair. 2: the playfield and background, or a hazard and the ground, share a value range. 1: most of the frame is one value band. 0: no usable separation.

Camera and framing — 4: the player, the next action and the goal are framed well in every gameplay frame. 3: readable framing with one missed opportunity. 2: the player is tiny or aimlessly off-centre, or the goal is never framed. 1: the camera hides the action. 0: the frames cannot show the camera at all.

Style consistency — 4: one coherent look across the frames. 3: coherent, with one element that does not belong. 2: mixed styles or a placeholder-looking element. 1: the pieces fight each other. 0: no coherent style.

Feedback — 4: every visible action is clearly acknowledged by HUD, effect or world state. 3: the core actions are acknowledged. 2: some actions show no feedback. 1: almost nothing acknowledges the player. 0: the frames look static and unresponsive.

Design compliance — 4: the design's palette roles and goal landmark read exactly as described. 3: they read, with one deviation. 2: a palette role or the landmark is missing or weak. 1: the look contradicts the design. 0: no frame shows the design's art direction.`;

const buildJudgePrompt = (input: {
  readonly artDirection: string | null;
  readonly acceptance: readonly GameAcceptanceCriterion[];
  readonly frames: ReturnType<typeof selectVisualFrames>;
  readonly gameState: string | null;
}): string => {
  const presentation = input.acceptance.filter((criterion) => criterion.kind === "presentation");
  const frameLines = input.frames.map((frame) => {
    const evidence = frame.evidence === undefined ? "" : ` Probe: ${frame.evidence}.`;
    return `${frame.id} (${frame.role}; caption "${frame.label}"): ${frame.path}.${evidence}`;
  });
  return `You are an independent visual judge for a finished game build. You did not build it and must not trust its captions, its build notes or the order the screenshots were taken in. Judge only what the attached frames show.

## Approved art direction

${input.artDirection ?? "The design has no Art direction section; judge style consistency and readability only, and mark design compliance missing."}

## Approved presentation criteria

${presentation.length === 0 ? "None were approved." : presentation.map((criterion) => `- ${criterion.id}: ${criterion.text}`).join("\n")}

## Frames

${frameLines.join("\n")}

Frame roles: early = first observed gameplay; interaction = an approved criterion progressed there; hazard = an approved lose claim was met there; later = later gameplay; finish = the run's final frame. Only these frames are evidence. A caption such as "double-jump" or "moon-pearl" is a label, not a promise that the frame shows it.

${input.gameState === null ? "" : `The run's own summary: ${input.gameState}\n`}
## Rubric

Score every dimension 0–4 using these anchors, or "missing" when none of the supplied frames shows evidence for it. "missing" is not a zero: a zero means the frames show the thing and it fails; missing means you could not see it.

${DIMENSION_ANCHORS}

## Rules

- Do not raise a score because a caption or the frame order claims a state; only pixels count.
- A still frame cannot judge variable jump height, invulnerability duration, timing or audio. Do not score those; if a dimension depends on them, score only the visual part the frames can show.
- Return at most three repair requests. Each names one supplied frame id (F1…Fn) and one concrete fix through the palette roles, the shared kit or the camera — never "make it better", never a redesign of the game.
- If every applicable dimension is at least 3, return no repair requests.
- Answer with the requested JSON only.`;
};

/** A bounded description of a failed reply, for the stage detail. */
const describeReviewFailure = (issues: readonly string[]): string =>
  `The visual judge's reply was not a usable review: ${issues.join("; ")}`.slice(0, 400);

type VisualCanaryResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Proves the provider actually receives a PNG and can answer about it. Run
 * once per server process before any game is judged; a synthetic image with a
 * known answer is the only way to tell a working vision path from a catalog
 * entry that cannot carry an image.
 */
export const runVisualCanary = (
  textGeneration: TextGeneration.TextGeneration["Service"],
): Effect.Effect<VisualCanaryResult> =>
  Effect.gen(function* () {
    const directory = yield* Effect.tryPromise({
      try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-visual-canary-")),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));
    if (directory === null) return { ok: false as const, reason: "no temp directory" };
    const file = NodePath.join(directory, "canary.png");
    const answer = yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => NodeFSP.writeFile(file, canaryPng()),
        catch: () => null,
      }).pipe(Effect.orElseSucceed(() => null));
      return yield* textGeneration
        .generateImageReview({
          cwd: directory,
          prompt:
            "The attached PNG contains one large digit on a solid background. Report the digit as a single character and the background as its plain colour name.",
          imagePaths: [file],
          outputSchema: RawCanary,
          modelSelection: REVIEWER,
        })
        .pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((error) =>
            Effect.logWarning("The visual canary could not answer.", {
              operation: error.operation,
            }).pipe(Effect.as({ ok: false as const, value: null })),
          ),
        );
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      ),
    );
    if (!answer.ok) return { ok: false as const, reason: "the provider call failed" };
    try {
      const parsed = decodeRawCanary(answer.value);
      const digit = parsed.digit.trim();
      const background = parsed.backgroundColor.toLowerCase().replace(/[^a-z0-9]/g, "");
      const colourOk =
        background.includes(VISUAL_CANARY_ANSWER.backgroundColor) ||
        background.includes("ff00ff") ||
        background === "f0f";
      return digit === VISUAL_CANARY_ANSWER.digit && colourOk
        ? { ok: true as const }
        : {
            ok: false as const,
            reason: `it answered "${digit}" on "${parsed.backgroundColor}"`,
          };
    } catch {
      return { ok: false as const, reason: "it did not answer with a digit and a colour" };
    }
  });

const make = (stateDir: string) =>
  Effect.gen(function* () {
    const textGeneration = yield* TextGeneration.TextGeneration;
    const budgetWrites = new Map<string, Promise<void>>();
    const serialized = (key: string, work: () => Promise<void>) => {
      const previous = budgetWrites.get(key) ?? Promise.resolve();
      const next = previous.then(work, work);
      budgetWrites.set(
        key,
        next.catch(() => undefined),
      );
      return next;
    };

    const budgetPath = (root: string) => gameRecordFile(stateDir, "game-visual", root, ".json");
    const readBudget = async (root: string, designHash: string | null): Promise<number> => {
      try {
        const record = decodeStoredBudget(await NodeFSP.readFile(budgetPath(root), "utf8"));
        return record.designHash === designHash ? record.judgements : 0;
      } catch {
        return 0;
      }
    };
    const writeBudget = (root: string, designHash: string | null, judgements: number) =>
      Effect.tryPromise({
        try: () =>
          serialized(root, async () => {
            const file = budgetPath(root);
            await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
            const temporary = `${file}.${process.pid}.tmp`;
            await NodeFSP.writeFile(
              temporary,
              encodeStoredBudget({
                schemaVersion: 1,
                game: root,
                designHash,
                judgements,
              }),
            );
            await NodeFSP.rename(temporary, file);
          }),
        catch: (cause) =>
          new GameOperationError({ operation: "visual-judge", path: root, reason: "io", cause }),
      });

    /**
     * The canary runs once per server process. Caching the value (not the error)
     * keeps a transient provider failure from poisoning every later judgement
     * and keeps a passing check from paying for another image.
     */
    const canary = yield* Effect.cached(runVisualCanary(textGeneration));

    const run: GameVisualJudge["Service"]["run"] = (root, input) =>
      Effect.gen(function* () {
        const evidence = yield* Effect.tryPromise({
          try: () => readPlaytestEvidence(root, input.evidenceDirectory),
          catch: (cause) =>
            new GameOperationError({
              operation: "visual-judge",
              path: NodePath.join(root, input.evidenceDirectory),
              reason: "io",
              cause,
            }),
        });
        const frames =
          evidence === null
            ? []
            : selectVisualFrames({
                frames: evidence.frames,
                state: evidence.state,
                acceptance: input.acceptance,
                evidenceDirectory: input.evidenceDirectory,
              });
        const design = yield* Effect.promise(() => readDesignDocument(root));
        // The budget belongs to the real game, so a directory-symlink alias
        // cannot start a second pair of judgements.
        const budgetRoot = yield* Effect.promise(() => NodeFSP.realpath(root).catch(() => root));
        const judgedAt = DateTime.formatIso(yield* DateTime.now);
        const unavailable = (detail: string, roundsLeft: number): GameVisualJudgement => ({
          status: "unavailable",
          judgedAt,
          model: REVIEWER_LABEL,
          sourceId: input.sourceId,
          buildId: input.buildId,
          designHash: input.designHash,
          evidenceDirectory: input.evidenceDirectory,
          frames,
          dimensions: [],
          repairRequests: [],
          roundsLeft,
          detail,
        });

        if (frames.length === 0)
          return {
            status: "judged" as const,
            judgement: unavailable(
              "No playtest frames are available to judge.",
              MAX_JUDGEMENTS_PER_DESIGN -
                (yield* Effect.promise(() => readBudget(budgetRoot, input.designHash))),
            ),
          };
        const checked = yield* canary;
        if (!checked.ok)
          return {
            status: "judged" as const,
            judgement: unavailable(
              `The visual judge is unavailable: image delivery failed (${checked.reason}). Retry the playtest before trusting a visual pass.`,
              MAX_JUDGEMENTS_PER_DESIGN -
                (yield* Effect.promise(() => readBudget(budgetRoot, input.designHash))),
            ),
          };

        const used = yield* Effect.promise(() => readBudget(budgetRoot, input.designHash));
        if (used >= MAX_JUDGEMENTS_PER_DESIGN) return { status: "exhausted" as const };
        yield* writeBudget(budgetRoot, input.designHash, used + 1);
        const roundsLeft = Math.max(0, MAX_JUDGEMENTS_PER_DESIGN - (used + 1));

        const state = evidence?.state ?? null;
        const gameState =
          state === null || state.changes.length === 0
            ? null
            : `${state.changes
                .slice(0, 6)
                .map((change) => `${change.key} ${String(change.before)}→${String(change.after)}`)
                .join(", ")}; player moved ${Math.round(state.playerMoved)} units.`;

        const raw = yield* textGeneration
          .generateImageReview({
            cwd: root,
            prompt: buildJudgePrompt({
              artDirection: readArtDirection(design),
              acceptance: input.acceptance,
              frames,
              gameState,
            }),
            imagePaths: frames.map((frame) => NodePath.join(root, frame.path)),
            outputSchema: RawReview,
            modelSelection: REVIEWER,
          })
          .pipe(
            Effect.map((value) => ({ ok: true as const, value })),
            Effect.catch((error) =>
              Effect.logWarning("The visual judge could not answer.", {
                operation: error.operation,
              }).pipe(Effect.as({ ok: false as const, value: null })),
            ),
          );
        if (!raw.ok) {
          // A provider failure is not a judgement: give the round back so a
          // transient Codex failure does not cost the one repair attempt.
          yield* writeBudget(budgetRoot, input.designHash, used).pipe(
            Effect.catch(() => Effect.void),
          );
          return {
            status: "judged" as const,
            judgement: unavailable(
              "The visual judge is unavailable: the provider call failed. Retry the playtest before trusting a visual pass.",
              Math.max(0, MAX_JUDGEMENTS_PER_DESIGN - used),
            ),
          };
        }

        let review: GameVisualReview;
        try {
          review = decodeReview(normalizeReview(decodeRawReview(raw.value)));
        } catch (cause) {
          const issue = cause instanceof Error ? cause.message : "unknown decode failure";
          const judgement: GameVisualJudgement = {
            ...unavailable(describeReviewFailure([issue.slice(0, 200)]), roundsLeft),
            status: "failed",
          };
          yield* Effect.tryPromise({
            try: () =>
              NodeFSP.writeFile(
                NodePath.join(root, input.evidenceDirectory, VISUAL_RAW_DIRECTORY),
                encodeRawReply(raw.value),
              ).catch(() => undefined),
            catch: () => undefined,
          }).pipe(Effect.orElseSucceed(() => undefined));
          return { status: "judged" as const, judgement };
        }
        const frameIds = new Set(frames.map((frame) => frame.id));
        const repairRequests: GameVisualRepairRequest[] = review.repairRequests
          .filter((request) => frameIds.has(request.frame))
          .slice(0, 3);
        const dimensions: GameVisualDimensionScore[] = [...review.dimensions];
        const verdict = evaluateVisualReview({ review, frames });
        const judgement: GameVisualJudgement = {
          status: verdict.passed ? "passed" : "failed",
          judgedAt,
          model: REVIEWER_LABEL,
          sourceId: input.sourceId,
          buildId: input.buildId,
          designHash: input.designHash,
          evidenceDirectory: input.evidenceDirectory,
          frames,
          dimensions,
          repairRequests,
          roundsLeft,
          detail: verdict.detail,
        };
        yield* Effect.tryPromise({
          try: () =>
            NodeFSP.writeFile(
              NodePath.join(root, input.evidenceDirectory, VISUAL_DIRECTORY),
              encodeJudgement(judgement),
            ),
          catch: (cause) =>
            new GameOperationError({
              operation: "visual-judge",
              path: NodePath.join(root, input.evidenceDirectory),
              reason: "io",
              cause,
            }),
        });
        return { status: "judged" as const, judgement };
      });

    const remaining: GameVisualJudge["Service"]["remaining"] = (root, designHash) =>
      Effect.gen(function* () {
        const budgetRoot = yield* Effect.promise(() => NodeFSP.realpath(root).catch(() => root));
        const used = yield* Effect.promise(() => readBudget(budgetRoot, designHash));
        return Math.max(0, MAX_JUDGEMENTS_PER_DESIGN - used);
      });

    return GameVisualJudge.of({ run, remaining });
  });

export const layer = (options: { readonly stateDir: string }) =>
  Layer.effect(GameVisualJudge, make(options.stateDir));
