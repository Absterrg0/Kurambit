// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off -- A maintainer report reads saved grades and writes its own evidence folder.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  ProviderInstanceId,
  type ModelSelection,
} from "../../packages/contracts/src/index.ts";
import { composeSideBySidePng } from "../../apps/server/src/game/frameCompose.ts";
import { makeCodexTextGeneration } from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import * as TextGeneration from "../../apps/server/src/textGeneration/TextGeneration.ts";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { CODEX_GRADER_MODEL } from "../game-grade.ts";
import type { LoadedGameBenchmarkBrief } from "./artifacts.ts";
import type { CaptureManifest, LoadedFramePack } from "./capture.ts";

/**
 * A blind look/feel comparison between two lanes' finished builds.
 *
 * It is a ruler next to the obligations grader, not part of it: the obligations
 * grade asks whether listed claims are visible in one build, while this asks
 * which of two builds reads better as a game. Both lanes' grade frames are
 * already on disk, so the only work is composing them anonymously and asking
 * the frozen grader model. The result is never added to an obligations total;
 * `compare.json` stays its own document.
 */

/** Each side of one matched card; the build behind A swaps between orders. */
export type CompareSide = "A" | "B" | "tie";

/**
 * The comparison ruler's own semantics: this prompt, the matched cards, both
 * orders and the identical-pair control. Deliberately not GRADER_VERSION: a
 * comparison reads frames saved by some obligations grade, and its report
 * records each source grade's version separately. Bump when the ruler changes.
 */
export const COMPARE_VERSION = 1;

/** The four facets, in the order the prompt and report use them. */
export const COMPARE_FACETS = ["works", "look", "feel", "play"] as const;
export type CompareFacet = (typeof COMPARE_FACETS)[number];

export interface CompareAnswer {
  readonly works: CompareSide;
  readonly look: CompareSide;
  readonly feel: CompareSide;
  readonly play: CompareSide;
  readonly overall: CompareSide;
  readonly reason: string;
}

/** The two orders every brief is asked in; the second is the first reversed. */
export const COMPARE_ORDERS = ["harness-left", "raw-left"] as const;
export type CompareOrder = (typeof COMPARE_ORDERS)[number];

/** Which build a side names under one order. */
export type BuildChoice = "harness" | "raw" | "tie" | "invalid";

/** A facet's agreement across both orders; `split` means they disagreed. */
export type CompareFacetChoice = BuildChoice | "split";

export const sideOfBuild = (order: CompareOrder, build: "harness" | "raw"): CompareSide => {
  const left = order === "harness-left" ? "harness" : "raw";
  return build === left ? "A" : "B";
};

export const buildOfSide = (order: CompareOrder, side: CompareSide): BuildChoice => {
  if (side === "tie") return "tie";
  const left = order === "harness-left" ? "harness" : "raw";
  return side === "A" ? left : left === "harness" ? "raw" : "harness";
};

const asRecord = (raw: unknown): Record<string, unknown> =>
  typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

const sideOf = (raw: unknown): CompareSide | null => {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "a") return "A";
  if (normalized === "b") return "B";
  if (normalized === "tie") return "tie";
  return null;
};

/**
 * Reads one comparison reply. An unreadable overall answer is no answer at all;
 * a missing facet is a tie, because an absent preference is not a preference.
 */
export const decodeCompareAnswer = (raw: unknown): CompareAnswer | null => {
  const value = asRecord(raw);
  const overall = sideOf(value.overall);
  if (overall === null) return null;
  return {
    works: sideOf(value.works) ?? "tie",
    look: sideOf(value.look) ?? "tie",
    feel: sideOf(value.feel) ?? "tie",
    play: sideOf(value.play) ?? "tie",
    overall,
    reason: typeof value.reason === "string" ? value.reason.slice(0, 400) : "",
  };
};

/** The model call, as one image review with a fixed JSON shape. */
export type CompareReview = (request: {
  readonly prompt: string;
  readonly imagePaths: ReadonlyArray<string>;
}) => Promise<unknown>;

const CompareReply = Schema.Struct({
  works: Schema.String,
  look: Schema.String,
  feel: Schema.String,
  play: Schema.String,
  overall: Schema.String,
  reason: Schema.String,
});

/** The frozen grader's own model and effort, reused for the comparison. */
const REVIEWER: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: CODEX_GRADER_MODEL,
  options: [{ id: "reasoningEffort", value: "high" }],
};

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

/** The same product image-review path `game-grade.ts` uses, over this reply. */
export const makeCompareReviewer = (): CompareReview => {
  const textGenerationLayer = Layer.effect(
    TextGeneration.TextGeneration,
    Effect.gen(function* () {
      const textGeneration = yield* makeCodexTextGeneration(
        decodeCodexSettings({}),
        undefined,
        Effect.succeed([]),
      );
      return TextGeneration.TextGeneration.of(textGeneration);
    }),
  ).pipe(
    Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "game-compare-" })),
    Layer.provide(NodeServices.layer),
  );
  return (request) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration.TextGeneration;
        return yield* textGeneration.generateImageReview({
          cwd: process.cwd(),
          prompt: request.prompt,
          imagePaths: [...request.imagePaths],
          outputSchema: CompareReply,
          modelSelection: REVIEWER,
        });
      }).pipe(Effect.provide(textGenerationLayer)),
    );
};

/** At most this many matched indices per comparison; each card is two frames. */
export const MAX_COMPARE_FRAMES = 6;

export interface SavedFrame {
  readonly path: string;
  readonly label: string;
}

export interface SavedBuild {
  /** `<brief>/grade`, or null when the lane saved no grade for this brief. */
  readonly gradeDirectory: string | null;
  readonly grader: { readonly provider: string; readonly model: string } | null;
  readonly graderVersion: number | null;
  readonly frames: ReadonlyArray<SavedFrame>;
}

const exists = (path: string) =>
  NodeFSP.access(path)
    .then(() => true)
    .catch(() => false);

/**
 * The newest `<dir>/<brief>` or `<dir>/<commit>/<brief>` that holds a grade, so
 * a results root can be passed without naming the harness commit.
 */
export const findBenchmarkBriefDirectory = async (
  root: string,
  briefId: string,
): Promise<string | null> => {
  const direct = NodePath.join(root, briefId);
  if (await exists(NodePath.join(direct, "grade/grade.json"))) return direct;
  const entries = await NodeFSP.readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => NodePath.join(root, entry.name, briefId))
    .sort()
    .toReversed();
  for (const candidate of nested)
    if (await exists(NodePath.join(candidate, "grade/grade.json"))) return candidate;
  return null;
};

/**
 * The frames a grade voted on, with the same labels the grade itself rendered.
 * The grade document lists the chosen shots; every other screenshot of the run
 * stays on disk but is not the evidence the obligations were read from.
 */
export const readSavedBuild = async (briefDirectory: string): Promise<SavedBuild> => {
  const gradeDirectory = NodePath.join(briefDirectory, "grade");
  const text = await NodeFSP.readFile(NodePath.join(gradeDirectory, "grade.json"), "utf8").catch(
    () => null,
  );
  if (text === null) return { gradeDirectory: null, grader: null, graderVersion: null, frames: [] };
  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(text) as unknown);
  } catch {
    return { gradeDirectory: null, grader: null, graderVersion: null, frames: [] };
  }
  const storedGrader = asRecord(parsed.grader);
  const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const actionByStep = new Map<number, { actions: string[]; note: string }>();
  for (const action of actions) {
    const entry = asRecord(action);
    if (typeof entry.step !== "number") continue;
    actionByStep.set(entry.step, {
      actions: Array.isArray(entry.actions)
        ? entry.actions.filter((value): value is string => typeof value === "string")
        : [],
      note: typeof entry.note === "string" ? entry.note : "",
    });
  }
  const frames: SavedFrame[] = [];
  for (const relative of Array.isArray(parsed.frames) ? parsed.frames : []) {
    if (typeof relative !== "string") continue;
    const path = NodePath.resolve(gradeDirectory, relative);
    if (!(await exists(path))) continue;
    const base = NodePath.basename(path);
    if (base === "boot.png") {
      frames.push({ path, label: "boot, no input" });
      continue;
    }
    const match = /^step-(\d+)\.png$/.exec(base);
    const action = match === null ? undefined : actionByStep.get(Number(match[1]));
    frames.push({
      path,
      label:
        match === null
          ? base
          : `after step ${Number(match[1])}: ${(action?.actions ?? []).join(", ")}${
              action === undefined || action.note === "" ? "" : ` — ${action.note}`
            }`,
    });
  }
  return {
    gradeDirectory,
    grader:
      typeof storedGrader.provider === "string" && typeof storedGrader.model === "string"
        ? { provider: storedGrader.provider, model: storedGrader.model }
        : null,
    graderVersion: typeof parsed.graderVersion === "number" ? parsed.graderVersion : null,
    frames,
  };
};

/** Indices both lanes saved, evenly spread when they hold more than the budget. */
export const matchedIndices = (
  leftCount: number,
  rightCount: number,
  limit: number = MAX_COMPARE_FRAMES,
): ReadonlyArray<number> => {
  const count = Math.min(leftCount, rightCount);
  if (count <= 0) return [];
  if (count <= limit) return Array.from({ length: count }, (_, index) => index);
  return Array.from(
    new Set(
      Array.from({ length: limit }, (_, slot) =>
        Math.round((slot * (count - 1)) / Math.max(1, limit - 1)),
      ),
    ),
  );
};

const promptFor = (input: {
  readonly brief: LoadedGameBenchmarkBrief;
  readonly cards: ReadonlyArray<{ readonly left: string; readonly right: string }>;
}): string =>
  `You are an independent judge comparing two anonymous builds of the same game. You did not build either one, and neither position nor the order of the cards says anything about the other.

## The game was asked to be
${input.brief.brief}

## Art direction
${input.brief.artDirection}

## The evidence
Each attached card holds the same frame index of both builds side by side: the left panel is A and the right panel is B. The labels above each panel say what the run had just done when that capture was taken.
${input.cards.map((card, index) => `P${index + 1}: A: ${card.left} | B: ${card.right}`).join("\n")}

Judge what a player would see, not what either build promised:
- works: it boots, takes input, and its core action is visible.
- look: readable, coherent presentation at the captured size.
- feel: motion and feedback read clearly.
- play: the action on screen looks meaningful.
Then pick the build you would rather play overall: A, B or tie.

Answer with the requested JSON only: {"works":"A or B or tie","look":"A or B or tie","feel":"A or B or tie","play":"A or B or tie","overall":"A or B or tie","reason":"one short sentence naming the deciding evidence"}`;

interface Card {
  readonly path: string;
  readonly left: string;
  readonly right: string;
}

const composeCard = async (input: {
  readonly path: string;
  readonly leftPath: string;
  readonly rightPath: string;
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly caption: string;
}): Promise<void> => {
  const card = composeSideBySidePng({
    left: await NodeFSP.readFile(input.leftPath),
    right: await NodeFSP.readFile(input.rightPath),
    leftLabel: input.leftLabel,
    rightLabel: input.rightLabel,
    caption: input.caption,
  });
  await NodeFSP.mkdir(NodePath.dirname(input.path), { recursive: true });
  await NodeFSP.writeFile(input.path, card.png);
};

/** One composed card per matched index, with A on the left under this order. */
const composeOrderCards = async (input: {
  readonly directory: string;
  readonly left: SavedBuild;
  readonly right: SavedBuild;
  readonly indices: ReadonlyArray<number>;
}): Promise<ReadonlyArray<Card>> => {
  const cards: Card[] = [];
  for (const [position, index] of input.indices.entries()) {
    const leftFrame = input.left.frames[index]!;
    const rightFrame = input.right.frames[index]!;
    const path = NodePath.join(
      input.directory,
      `card-${String(position + 1).padStart(2, "0")}.png`,
    );
    await composeCard({
      path,
      leftPath: leftFrame.path,
      rightPath: rightFrame.path,
      leftLabel: "A",
      rightLabel: "B",
      caption: `frame ${index + 1}`,
    });
    cards.push({ path, left: leftFrame.label, right: rightFrame.label });
  }
  return cards;
};

/**
 * The identical-pair control: both panels are the harness capture of the same
 * index, so any named winner is a hallucination and voids the comparison. One
 * card per matched index keeps the control the same shape as the real vote.
 */
const composeControlCards = async (input: {
  readonly directory: string;
  readonly source: SavedBuild;
  readonly indices: ReadonlyArray<number>;
}): Promise<ReadonlyArray<Card>> => {
  const cards: Card[] = [];
  for (const [position, index] of input.indices.entries()) {
    const frame = input.source.frames[index]!;
    const path = NodePath.join(
      input.directory,
      `card-${String(position + 1).padStart(2, "0")}.png`,
    );
    await composeCard({
      path,
      leftPath: frame.path,
      rightPath: frame.path,
      leftLabel: "A",
      rightLabel: "B",
      caption: `frame ${index + 1}`,
    });
    cards.push({ path, left: frame.label, right: frame.label });
  }
  return cards;
};

export interface CompareOrderResult {
  readonly order: CompareOrder;
  /** Null when the model's reply could not be read at all. */
  readonly answer: CompareAnswer | null;
  readonly facets: Readonly<Record<CompareFacet, BuildChoice>>;
  readonly overall: BuildChoice;
  readonly reason: string;
}

export type CompareVerdict = "harness" | "raw" | "tie" | "split" | "invalid" | "void";

export interface BriefComparison {
  readonly briefId: string;
  readonly title: string;
  readonly frameCount: number;
  readonly harness: {
    readonly gradeDirectory: string | null;
    readonly grader: { readonly provider: string; readonly model: string } | null;
    readonly graderVersion: number | null;
    readonly frames: number;
  };
  readonly raw: BriefComparison["harness"];
  readonly orders: ReadonlyArray<CompareOrderResult>;
  readonly control: {
    readonly answer: CompareAnswer | null;
    readonly passed: boolean;
  };
  readonly facets: Readonly<Record<CompareFacet, CompareFacetChoice>>;
  readonly verdict: CompareVerdict;
  readonly reasons: ReadonlyArray<string>;
  /** Why the brief has no verdict, when it has none. */
  readonly note: string | null;
}

const orderResult = (input: {
  readonly order: CompareOrder;
  readonly raw: unknown;
  readonly error: string | null;
}): CompareOrderResult => {
  const answer = input.error === null ? decodeCompareAnswer(input.raw) : null;
  const facets = Object.fromEntries(
    COMPARE_FACETS.map((facet) => [
      facet,
      answer === null ? "invalid" : buildOfSide(input.order, answer[facet]),
    ]),
  ) as Record<CompareFacet, BuildChoice>;
  return {
    order: input.order,
    answer,
    facets,
    overall: answer === null ? "invalid" : buildOfSide(input.order, answer.overall),
    reason: answer?.reason ?? input.error ?? "The model returned no readable comparison.",
  };
};

/**
 * Reads the two opposite-order answers and the control into one verdict. A
 * control that names a winner voids the brief; two readable orders that name
 * the same build agree; anything else is a split, never an averaged score.
 */
export const summarizeComparison = (input: {
  readonly orders: ReadonlyArray<CompareOrderResult>;
  readonly control: { readonly answer: CompareAnswer | null; readonly passed: boolean };
}): { readonly verdict: CompareVerdict; readonly reasons: ReadonlyArray<string> } => {
  const reasons = input.orders.map(
    (order) =>
      `${order.order}: ${
        order.overall === "invalid"
          ? "no readable answer"
          : order.overall === "tie"
            ? "tie"
            : `${order.overall} wins overall`
      } — ${order.reason}`,
  );
  if (!input.control.passed)
    return {
      verdict: "void",
      reasons: [
        ...reasons,
        input.control.answer === null
          ? "control: the identical pair could not answer, so this comparison is void."
          : `control: the identical pair named a winner (${input.control.answer.overall}), so this comparison is void.`,
      ],
    };
  const choices = input.orders.map((order) => order.overall);
  if (choices.some((choice) => choice === "invalid")) return { verdict: "invalid", reasons };
  const [first, second] = choices;
  if (first !== undefined && first === second) return { verdict: first, reasons };
  return { verdict: "split", reasons };
};

export interface ComparisonReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly role: "look-feel-comparison";
  /** Not an obligations row: no sum here feeds results.json or results.md. */
  readonly grader: { readonly provider: "codex"; readonly model: string };
  /** The comparison ruler, separate from the source grades' `graderVersion`. */
  readonly comparisonVersion: number;
  readonly harnessDir: string;
  readonly rawDir: string;
  readonly briefs: ReadonlyArray<BriefComparison>;
}

const emptyGrade: BriefComparison["harness"] = {
  gradeDirectory: null,
  grader: null,
  graderVersion: null,
  frames: 0,
};

const buildSummary = (build: SavedBuild | null): BriefComparison["harness"] =>
  build === null
    ? emptyGrade
    : {
        gradeDirectory: build.gradeDirectory,
        grader: build.grader,
        graderVersion: build.graderVersion,
        frames: build.frames.length,
      };

export interface RunComparisonInput {
  readonly harnessDir: string;
  readonly rawDir: string;
  readonly out: string;
  readonly briefs: ReadonlyArray<LoadedGameBenchmarkBrief>;
  readonly review: CompareReview;
  /** Progress lines; the CLI prints them, tests stay quiet. */
  readonly log?: (line: string) => void;
}

export const compareBrief = async (input: {
  readonly brief: LoadedGameBenchmarkBrief;
  readonly harness: SavedBuild;
  readonly raw: SavedBuild;
  readonly cardsRoot: string;
  readonly review: CompareReview;
}): Promise<BriefComparison> => {
  const indices = matchedIndices(input.harness.frames.length, input.raw.frames.length);
  if (indices.length === 0)
    return {
      briefId: input.brief.id,
      title: input.brief.title,
      frameCount: 0,
      harness: buildSummary(input.harness),
      raw: buildSummary(input.raw),
      orders: [],
      control: { answer: null, passed: false },
      facets: { works: "invalid", look: "invalid", feel: "invalid", play: "invalid" },
      verdict: "invalid",
      reasons: [],
      note: `No graded frames to compare: harness ${input.harness.frames.length}, raw ${input.raw.frames.length}.`,
    };

  const orders: CompareOrderResult[] = [];
  for (const order of COMPARE_ORDERS) {
    const left: SavedBuild = order === "harness-left" ? input.harness : input.raw;
    const right: SavedBuild = order === "harness-left" ? input.raw : input.harness;
    const cards = await composeOrderCards({
      directory: NodePath.join(input.cardsRoot, order),
      left,
      right,
      indices,
    });
    let raw: unknown = null;
    let error: string | null = null;
    try {
      raw = await input.review({
        prompt: promptFor({ brief: input.brief, cards }),
        imagePaths: cards.map((card) => card.path),
      });
    } catch (cause) {
      error =
        `The model call failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(
          0,
          400,
        );
    }
    orders.push(orderResult({ order, raw, error }));
  }

  const controlCards = await composeControlCards({
    directory: NodePath.join(input.cardsRoot, "control"),
    source: input.harness,
    indices,
  });
  let controlAnswer: CompareAnswer | null = null;
  let controlError: string | null = null;
  try {
    controlAnswer = decodeCompareAnswer(
      await input.review({
        prompt: promptFor({ brief: input.brief, cards: controlCards }),
        imagePaths: controlCards.map((card) => card.path),
      }),
    );
  } catch (cause) {
    controlError =
      `The control call failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(
        0,
        400,
      );
  }
  // A control that could not answer is not a pass: it voids the brief too.
  const control = {
    answer: controlAnswer,
    passed: controlAnswer !== null && controlAnswer.overall === "tie",
  };
  const summarized = summarizeComparison({ orders, control });
  const facetsOf = (facet: CompareFacet): CompareFacetChoice => {
    const choices = orders.map((order) => order.facets[facet]);
    if (choices.some((choice) => choice === "invalid")) return "invalid";
    const [first, second] = choices;
    return first !== undefined && first === second ? first : "split";
  };
  return {
    briefId: input.brief.id,
    title: input.brief.title,
    frameCount: indices.length,
    harness: buildSummary(input.harness),
    raw: buildSummary(input.raw),
    orders,
    control,
    facets: {
      works: facetsOf("works"),
      look: facetsOf("look"),
      feel: facetsOf("feel"),
      play: facetsOf("play"),
    },
    verdict: summarized.verdict,
    reasons:
      controlError === null
        ? summarized.reasons
        : [...summarized.reasons, `control: ${controlError}`],
    note: null,
  };
};

export const renderComparisonMarkdown = (report: ComparisonReport): string => {
  // Measured briefs first: a lane that never built a brief must not lead the
  // report with a verdict that says nothing.
  const ordered = [...report.briefs].sort((left, right) =>
    left.frameCount === 0 && right.frameCount > 0
      ? 1
      : left.frameCount > 0 && right.frameCount === 0
        ? -1
        : 0,
  );
  const lines = [
    "# Blind look/feel comparison",
    "",
    `Harness \`${report.harnessDir}\` vs raw \`${report.rawDir}\`, measured by the frozen grader`,
    `\`${report.grader.provider}/${report.grader.model}\` with comparison ruler v${report.comparisonVersion} at`,
    `${report.generatedAt}. Two opposite-order votes and an identical-pair control per brief.`,
    "",
    "This is a ruler beside the obligations grade. Nothing here is summed with either lane's",
    "obligation count, and no winner is averaged: a brief has an agreed winner only when both",
    "orders name the same build and the control tied. Source grades keep their own",
    "`graderVersion` below; this comparison neither regrades nor relabels them.",
    "",
    "| Brief | Cards | Verdict | works | look | feel | play | Control |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const brief of ordered) {
    const control =
      brief.frameCount === 0
        ? "—"
        : brief.control.passed
          ? "tie (pass)"
          : brief.control.answer === null
            ? "no answer (void)"
            : "named a winner (void)";
    lines.push(
      `| ${brief.briefId} | ${brief.frameCount} | ${brief.verdict} | ${brief.facets.works} | ${brief.facets.look} | ${brief.facets.feel} | ${brief.facets.play} | ${control} |`,
    );
  }
  for (const brief of ordered) {
    lines.push("", `## ${brief.title} (\`${brief.briefId}\`)`, "");
    lines.push(
      `Verdict: **${brief.verdict}**. Harness grade by ${brief.harness.grader?.provider ?? "unknown"}/${brief.harness.grader?.model ?? "unknown"} v${brief.harness.graderVersion ?? "?"} (${brief.harness.frames} frames); raw grade by ${brief.raw.grader?.provider ?? "unknown"}/${brief.raw.grader?.model ?? "unknown"} v${brief.raw.graderVersion ?? "?"} (${brief.raw.frames} frames).`,
      "",
    );
    if (brief.note !== null) lines.push(brief.note, "");
    for (const reason of brief.reasons) lines.push(`- ${reason}`);
  }
  lines.push("");
  return lines.join("\n");
};

/**
 * Compares every brief's saved grade frames in both orders plus the control.
 * Writes `<out>/comparison.json`, `<out>/comparison.md` and the composed cards.
 */
export const runComparison = async (
  input: RunComparisonInput,
): Promise<{ readonly report: ComparisonReport; readonly markdownPath: string }> => {
  const log = input.log ?? (() => undefined);
  const briefs: BriefComparison[] = [];
  for (const brief of input.briefs) {
    const harnessDirectory = await findBenchmarkBriefDirectory(input.harnessDir, brief.id);
    const rawDirectory = await findBenchmarkBriefDirectory(input.rawDir, brief.id);
    const harness = harnessDirectory === null ? null : await readSavedBuild(harnessDirectory);
    const raw = rawDirectory === null ? null : await readSavedBuild(rawDirectory);
    if (
      harness === null ||
      raw === null ||
      harness.frames.length === 0 ||
      raw.frames.length === 0
    ) {
      log(`[${brief.id}] no graded frames to compare`);
      briefs.push({
        briefId: brief.id,
        title: brief.title,
        frameCount: 0,
        harness: buildSummary(harness),
        raw: buildSummary(raw),
        orders: [],
        control: { answer: null, passed: false },
        facets: { works: "invalid", look: "invalid", feel: "invalid", play: "invalid" },
        verdict: "invalid",
        reasons: [],
        note: `No graded frames to compare: harness ${harness?.frames.length ?? 0}, raw ${raw?.frames.length ?? 0}.`,
      });
      continue;
    }
    log(`[${brief.id}] comparing…`);
    const comparison = await compareBrief({
      brief,
      harness,
      raw,
      cardsRoot: NodePath.join(input.out, "cards", brief.id),
      review: input.review,
    });
    briefs.push(comparison);
    log(`[${brief.id}] ${comparison.verdict}`);
  }
  const report: ComparisonReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    role: "look-feel-comparison",
    grader: { provider: "codex", model: CODEX_GRADER_MODEL },
    comparisonVersion: COMPARE_VERSION,
    harnessDir: NodePath.resolve(input.harnessDir),
    rawDir: NodePath.resolve(input.rawDir),
    briefs,
  };
  await NodeFSP.mkdir(input.out, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(input.out, "comparison.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const markdownPath = NodePath.join(input.out, "comparison.md");
  await NodeFSP.writeFile(markdownPath, renderComparisonMarkdown(report));
  return { report, markdownPath };
};

/**
 * A captured revision comparison reads two explicit frame packs instead of two
 * saved grade folders. It uses the same frozen prompt, matched cards, two
 * orders and identical-pair control as `compareBrief`, but asks the control
 * first: a control that cannot answer or names a winner stops the run before
 * either order call. It never infers an answer for a call it did not make.
 */

export type RevisionChoice = "first" | "second" | "tie" | "invalid";
export type RevisionFacetChoice = RevisionChoice | "split";
export type RevisionVerdict = "first" | "second" | "tie" | "split" | "invalid" | "void";

export interface RevisionArmSummary {
  readonly label: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly captureVersion: number;
  readonly capturedAt: string;
  readonly brief: CaptureManifest["brief"];
  readonly artifact: CaptureManifest["artifact"];
  readonly route: {
    readonly label: string;
    readonly sha256: string;
    readonly viewport: CaptureManifest["route"]["viewport"];
    readonly steps: number;
  };
  readonly capture: {
    readonly booted: boolean;
    readonly bootMs: number | null;
    readonly responded: boolean;
    readonly changedPercent: number;
    readonly executedInputSteps: number;
    readonly consoleErrors: number;
    readonly qualifies: boolean | null;
    readonly comparisonReady: boolean;
  };
  readonly frames: ReadonlyArray<CaptureManifest["frames"][number]>;
}

export interface RevisionOrderResult {
  readonly order: CompareOrder;
  readonly answer: CompareAnswer | null;
  readonly facets: Readonly<Record<CompareFacet, RevisionChoice>>;
  readonly overall: RevisionChoice;
  readonly reason: string;
}

export interface RevisionComparison {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly role: "revision-frame-comparison";
  readonly grader: { readonly provider: "codex"; readonly model: string };
  /** The look/feel ruler version; capture packs carry their own captureVersion. */
  readonly comparisonVersion: number;
  readonly brief: {
    readonly id: string;
    readonly title: string;
    readonly checksum: string;
  };
  readonly frameCount: number;
  readonly first: RevisionArmSummary;
  readonly second: RevisionArmSummary;
  readonly orders: ReadonlyArray<RevisionOrderResult>;
  readonly control: {
    readonly answer: CompareAnswer | null;
    readonly passed: boolean;
    readonly attempted: boolean;
    readonly error: string | null;
  };
  readonly facets: Readonly<Record<CompareFacet, RevisionFacetChoice>>;
  readonly verdict: RevisionVerdict;
  readonly reasons: ReadonlyArray<string>;
  /** Actual model calls, in the order they were made. Skipped calls are absent. */
  readonly attempted: ReadonlyArray<"control" | CompareOrder>;
  readonly note: string | null;
}

const revisionChoiceOf = (choice: BuildChoice): RevisionChoice =>
  choice === "harness" ? "first" : choice === "raw" ? "second" : choice;

const revisionVerdictOf = (verdict: CompareVerdict): RevisionVerdict =>
  verdict === "harness" ? "first" : verdict === "raw" ? "second" : verdict;

const packBuild = (pack: LoadedFramePack): SavedBuild => ({
  gradeDirectory: null,
  grader: null,
  graderVersion: null,
  frames: pack.frames.map((frame) => ({ path: frame.path, label: frame.label })),
});

const armLabel = (pack: LoadedFramePack): string =>
  pack.manifest.artifact.buildId === null
    ? `artifact ${pack.manifest.artifact.sha256.slice(0, 12)}`
    : `build ${pack.manifest.artifact.buildId.slice(0, 12)}`;

const armSummary = (pack: LoadedFramePack): RevisionArmSummary => ({
  label: armLabel(pack),
  manifestPath: pack.manifestPath,
  manifestSha256: pack.manifestSha256,
  captureVersion: pack.manifest.captureVersion,
  capturedAt: pack.manifest.capturedAt,
  brief: pack.manifest.brief,
  artifact: pack.manifest.artifact,
  route: {
    label: pack.manifest.route.label,
    sha256: pack.manifest.route.sha256,
    viewport: pack.manifest.route.viewport,
    steps: pack.manifest.route.steps.length,
  },
  capture: {
    booted: pack.manifest.capture.booted,
    bootMs: pack.manifest.capture.bootMs,
    responded: pack.manifest.capture.responded,
    changedPercent: pack.manifest.capture.changedPercent,
    executedInputSteps: pack.manifest.capture.executedInputSteps,
    consoleErrors: pack.manifest.capture.consoleErrors,
    qualifies: pack.manifest.capture.qualifies,
    comparisonReady: pack.manifest.capture.comparisonReady,
  },
  frames: pack.manifest.frames,
});

const assertComparablePacks = (input: {
  readonly brief: LoadedGameBenchmarkBrief;
  readonly first: LoadedFramePack;
  readonly second: LoadedFramePack;
}): void => {
  for (const [side, pack] of [
    ["first", input.first],
    ["second", input.second],
  ] as const) {
    if (
      pack.manifest.brief.id !== input.brief.id ||
      pack.manifest.brief.checksum !== input.brief.checksum
    )
      throw new Error(
        `The ${side} pack was captured for brief ${pack.manifest.brief.id} at checksum ${pack.manifest.brief.checksum}, not ${input.brief.id} at ${input.brief.checksum}; refusing to compare.`,
      );
    if (!pack.manifest.capture.comparisonReady)
      throw new Error(
        `The ${side} pack is not comparison-ready: booted=${pack.manifest.capture.booted}, executedInputSteps=${pack.manifest.capture.executedInputSteps}, frames=${pack.manifest.frames.length}.`,
      );
    for (const frame of pack.manifest.frames)
      if (
        frame.width !== pack.manifest.route.viewport.width ||
        frame.height !== pack.manifest.route.viewport.height
      )
        throw new Error(
          `The ${side} pack frame ${frame.id} is ${frame.width}x${frame.height}, but its route recorded a ${pack.manifest.route.viewport.width}x${pack.manifest.route.viewport.height} viewport; refusing to compare unlike captures.`,
        );
  }
  if (input.first.manifest.captureVersion !== input.second.manifest.captureVersion)
    throw new Error(
      `Capture versions differ (${input.first.manifest.captureVersion} vs ${input.second.manifest.captureVersion}); refusing to compare unlike packs.`,
    );
  if (input.first.manifest.route.sha256 !== input.second.manifest.route.sha256)
    throw new Error(
      `Capture routes differ (${input.first.manifest.route.sha256} vs ${input.second.manifest.route.sha256}); refusing to compare unlike inputs.`,
    );
  const firstViewport = input.first.manifest.route.viewport;
  const secondViewport = input.second.manifest.route.viewport;
  if (
    firstViewport.width !== secondViewport.width ||
    firstViewport.height !== secondViewport.height
  )
    throw new Error(
      `Capture viewports differ (${firstViewport.width}x${firstViewport.height} vs ${secondViewport.width}x${secondViewport.height}); refusing to compare unlike captures.`,
    );
};

const revisionOrderResult = (input: {
  readonly order: CompareOrder;
  readonly raw: unknown;
  readonly error: string | null;
}): RevisionOrderResult => {
  const result = orderResult(input);
  return {
    order: result.order,
    answer: result.answer,
    facets: Object.fromEntries(
      COMPARE_FACETS.map((facet) => [facet, revisionChoiceOf(result.facets[facet])]),
    ) as Record<CompareFacet, RevisionChoice>,
    overall: revisionChoiceOf(result.overall),
    reason: result.reason,
  };
};

const revisionOrderName = (order: CompareOrder): string =>
  order === "harness-left" ? "first-left" : "second-left";

const controlReason = (control: RevisionComparison["control"]): string => {
  if (control.error !== null) return `control: ${control.error}`;
  if (control.answer === null)
    return "control: the identical pair could not answer, so this comparison is void.";
  return `control: the identical pair named a winner (${control.answer.overall}), so this comparison is void.`;
};

export async function compareFramePacks(input: {
  readonly brief: LoadedGameBenchmarkBrief;
  readonly first: LoadedFramePack;
  readonly second: LoadedFramePack;
  readonly cardsRoot: string;
  readonly review: CompareReview;
}): Promise<RevisionComparison> {
  assertComparablePacks(input);
  const firstBuild = packBuild(input.first);
  const secondBuild = packBuild(input.second);
  const indices = matchedIndices(firstBuild.frames.length, secondBuild.frames.length);
  const attempted: Array<"control" | CompareOrder> = [];
  const base = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    role: "revision-frame-comparison" as const,
    grader: { provider: "codex" as const, model: CODEX_GRADER_MODEL },
    comparisonVersion: COMPARE_VERSION,
    brief: {
      id: input.brief.id,
      title: input.brief.title,
      checksum: input.brief.checksum,
    },
    frameCount: indices.length,
    first: armSummary(input.first),
    second: armSummary(input.second),
  };

  if (indices.length === 0)
    return {
      ...base,
      orders: [],
      control: { answer: null, passed: false, attempted: false, error: null },
      facets: { works: "invalid", look: "invalid", feel: "invalid", play: "invalid" },
      verdict: "invalid",
      reasons: [],
      attempted,
      note: `No captured frames to compare: first ${firstBuild.frames.length}, second ${secondBuild.frames.length}.`,
    };

  // The control is the cheapest call and the only one that can invalidate the
  // whole ruler. Asking it first means a bad control costs one call, not three.
  const controlCards = await composeControlCards({
    directory: NodePath.join(input.cardsRoot, "control"),
    source: firstBuild,
    indices,
  });
  attempted.push("control");
  let controlAnswer: CompareAnswer | null = null;
  let controlError: string | null = null;
  try {
    controlAnswer = decodeCompareAnswer(
      await input.review({
        prompt: promptFor({ brief: input.brief, cards: controlCards }),
        imagePaths: controlCards.map((card) => card.path),
      }),
    );
  } catch (cause) {
    controlError =
      `The control call failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(
        0,
        400,
      );
  }
  const control = {
    answer: controlAnswer,
    passed: controlAnswer !== null && controlAnswer.overall === "tie",
    attempted: true,
    error: controlError,
  };
  if (!control.passed)
    return {
      ...base,
      orders: [],
      control,
      facets: { works: "invalid", look: "invalid", feel: "invalid", play: "invalid" },
      verdict: "void",
      reasons: [controlReason(control)],
      attempted,
      note: "The identical-pair control did not pass, so neither order was requested and no verdict is possible.",
    };

  const legacyOrders: CompareOrderResult[] = [];
  const orders: RevisionOrderResult[] = [];
  for (const order of COMPARE_ORDERS) {
    const left: SavedBuild = order === "harness-left" ? firstBuild : secondBuild;
    const right: SavedBuild = order === "harness-left" ? secondBuild : firstBuild;
    const cards = await composeOrderCards({
      directory: NodePath.join(input.cardsRoot, order),
      left,
      right,
      indices,
    });
    attempted.push(order);
    let raw: unknown = null;
    let error: string | null = null;
    try {
      raw = await input.review({
        prompt: promptFor({ brief: input.brief, cards }),
        imagePaths: cards.map((card) => card.path),
      });
    } catch (cause) {
      error =
        `The model call failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(
          0,
          400,
        );
    }
    legacyOrders.push(orderResult({ order, raw, error }));
    orders.push(revisionOrderResult({ order, raw, error }));
  }

  const summarized = summarizeComparison({ orders: legacyOrders, control });
  const facetsOf = (facet: CompareFacet): RevisionFacetChoice => {
    const choices = orders.map((order) => order.facets[facet]);
    if (choices.some((choice) => choice === "invalid")) return "invalid";
    const [first, second] = choices;
    return first !== undefined && first === second ? first : "split";
  };
  const reasons = orders.map((order) => {
    const outcome =
      order.overall === "invalid"
        ? "no readable answer"
        : order.overall === "tie"
          ? "tie"
          : `${order.overall === "first" ? "first" : "second"} wins overall`;
    return `${revisionOrderName(order.order)}: ${outcome} — ${order.reason}`;
  });
  return {
    ...base,
    orders,
    control,
    facets: {
      works: facetsOf("works"),
      look: facetsOf("look"),
      feel: facetsOf("feel"),
      play: facetsOf("play"),
    },
    verdict: revisionVerdictOf(summarized.verdict),
    reasons,
    attempted,
    note: null,
  };
}

export const renderRevisionComparisonMarkdown = (report: RevisionComparison): string => {
  const verdict =
    report.verdict === "first"
      ? report.first.label
      : report.verdict === "second"
        ? report.second.label
        : report.verdict;
  const lines = [
    "# Captured revision comparison",
    "",
    `\`${report.first.label}\` vs \`${report.second.label}\`, measured by the frozen grader`,
    `\`${report.grader.provider}/${report.grader.model}\` with comparison ruler v${report.comparisonVersion} at`,
    `${report.generatedAt}. Two opposite-order votes and an identical-pair control per pair.`,
    "",
    "This is the same blind look/feel ruler used beside the obligations grade, fed by explicit",
    "capture packs instead of saved grades. Each pack booted one exact exported artifact and",
    "replayed one explicit ordinary-input route. This is not an obligations grade, not Play",
    "acceptance, and not a substitute for mechanical checks or final independent grading.",
    "",
    "| Pack | Frames | Artifact sha256 | Route | Viewport | Booted | Input steps | Console errors |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    `| ${report.first.label} | ${report.first.frames.length} | ${report.first.artifact.sha256.slice(0, 12)}… | ${report.first.route.label} (${report.first.route.sha256.slice(0, 12)}…) | ${report.first.route.viewport.width}x${report.first.route.viewport.height} | ${report.first.capture.booted} | ${report.first.capture.executedInputSteps} | ${report.first.capture.consoleErrors} |`,
    `| ${report.second.label} | ${report.second.frames.length} | ${report.second.artifact.sha256.slice(0, 12)}… | ${report.second.route.label} (${report.second.route.sha256.slice(0, 12)}…) | ${report.second.route.viewport.width}x${report.second.route.viewport.height} | ${report.second.capture.booted} | ${report.second.capture.executedInputSteps} | ${report.second.capture.consoleErrors} |`,
    "",
    `Verdict: **${verdict}**.`,
    "",
    `Calls attempted: ${report.attempted.length === 0 ? "none" : report.attempted.join(", ")}.`,
    "",
  ];
  if (report.note !== null) lines.push(report.note, "");
  for (const reason of report.reasons) lines.push(`- ${reason}`);
  lines.push(
    "",
    "The two order ids keep the frozen comparison protocol's names; in this path",
    "`harness-left` means the first pack on the left and `raw-left` the second.",
    "Skipped calls have no answer: a failed control stops before either order, and a",
    "missing order can never produce an agreed winner.",
    "",
  );
  return lines.join("\n");
};
