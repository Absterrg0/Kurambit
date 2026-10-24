// @effect-diagnostics nodeBuiltinImport:off -- The benchmark reads frozen brief files and writes its own summaries.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  GameVisualJudgement,
  LegacyGameQualificationRead,
} from "../../packages/contracts/src/legacyGameVisual.ts";
import {
  GameAcceptanceCriterionKind,
  GameLastPlaytest,
  GameRepairLoopStatus,
  GameReviewBudget,
  GameReviewDecision,
  GameReviewRoundStatus,
  GameReviewStatus,
  GameTemplateId,
  type GameAcceptanceCriterion,
  type GameObservedValue,
  type GameProductionStatus,
  type GameScenarioCriterionMeasurement,
  type GameScenarioCriterionResult,
} from "../../packages/contracts/src/index.ts";
import { candidateBuildId } from "../../apps/server/src/game/webBuild.ts";

/**
 * One promise a benchmark brief makes, frozen before an agent builds anything.
 * `key`/`expect` use the design vocabulary the server already grades; a promise
 * that vocabulary cannot express carries `unsupported` and is still reported.
 */
export const GameBenchmarkObligation = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)),
  kind: GameAcceptanceCriterionKind,
  description: Schema.String.check(Schema.isMinLength(1)),
  /** GameState property named by the brief, e.g. `moves`. */
  key: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/))),
  /** `==V`, `>=N`, `<=N` or `changes`, the only expect forms a design can bind. */
  expect: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^(?:==|>=|<=)-?\d+(?:\.\d+)?$|^changes$/)),
  ),
  unsupported: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
});
export type GameBenchmarkObligation = typeof GameBenchmarkObligation.Type;

export const GameBenchmarkBrief = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)),
  title: Schema.String.check(Schema.isMinLength(1)),
  template: GameTemplateId,
  /** The text a player would type into Create; never a template id. */
  brief: Schema.String.check(Schema.isMinLength(1)),
  artDirection: Schema.String.check(Schema.isMinLength(1)),
  obligations: Schema.Array(GameBenchmarkObligation),
});
export type GameBenchmarkBrief = typeof GameBenchmarkBrief.Type;
export type LoadedGameBenchmarkBrief = GameBenchmarkBrief & {
  readonly path: string;
  readonly checksum: string;
};

const decodeBrief = Schema.decodeUnknownSync(GameBenchmarkBrief);

/**
 * Decodes a fixture and enforces the rules the schema alone cannot. A promise
 * with both an observation and `unsupported` is ambiguous about what the ruler
 * counts, so it is rejected instead of being guessed at.
 */
export function decodeGameBenchmarkBrief(value: unknown): GameBenchmarkBrief {
  const brief = decodeBrief(value);
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const obligation of brief.obligations) {
    if (seen.has(obligation.id)) issues.push(`Obligation id "${obligation.id}" is repeated.`);
    seen.add(obligation.id);
    const observed = obligation.key !== undefined || obligation.expect !== undefined;
    if (obligation.unsupported !== undefined && observed)
      issues.push(
        `Obligation "${obligation.id}" is marked unsupported and also names key/expect; pick one.`,
      );
    if (
      obligation.unsupported === undefined &&
      (obligation.key === undefined || obligation.expect === undefined)
    )
      issues.push(
        `Obligation "${obligation.id}" needs both key and expect, or an unsupported reason.`,
      );
  }
  if (brief.obligations.length === 0) issues.push("A brief needs at least one obligation.");
  if (!brief.obligations.some((obligation) => obligation.unsupported === undefined))
    issues.push("A brief needs at least one obligation the proof vocabulary can express.");
  if (issues.length > 0) throw new Error(`Brief fixture is invalid:\n${issues.join("\n")}`);
  return brief;
}

export const checksumOfBytes = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** `briefs/<id>.json` is the fixture identity: the filename must be the id. */
export async function loadGameBenchmarkBrief(path: string): Promise<LoadedGameBenchmarkBrief> {
  const bytes = await NodeFSP.readFile(path);
  const brief = decodeGameBenchmarkBrief(JSON.parse(bytes.toString("utf8")) as unknown);
  const named = NodePath.basename(path, ".json");
  if (named !== brief.id)
    throw new Error(`${path}: fixture id "${brief.id}" does not match its filename "${named}".`);
  return { ...brief, path, checksum: checksumOfBytes(bytes) };
}

export async function loadGameBenchmarkBriefs(
  directory: string,
): Promise<ReadonlyArray<LoadedGameBenchmarkBrief>> {
  const names = (await NodeFSP.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const briefs: LoadedGameBenchmarkBrief[] = [];
  for (const name of names)
    briefs.push(await loadGameBenchmarkBrief(NodePath.join(directory, name)));
  return briefs;
}

export interface ParsedExpectation {
  readonly op: "==" | ">=" | "<=" | "changes";
  readonly value: number;
}

export function parseExpectation(text: string): ParsedExpectation | null {
  if (text === "changes") return { op: "changes", value: 0 };
  const match = text.match(/^(==|>=|<=)(-?\d+(?:\.\d+)?)$/);
  if (match === null) return null;
  return { op: match[1] as ParsedExpectation["op"], value: Number(match[2]) };
}

/**
 * Whether one design expectation is at least as strong as the frozen one. A
 * stronger observation proves the promise; a weaker one (`>=1` against a
 * frozen `>=3`) does not.
 */
export function expectationCovers(frozen: ParsedExpectation, observed: ParsedExpectation): boolean {
  if (observed.op === "changes") return frozen.op === "changes";
  // Any threshold that starts false and becomes true after play moved a value.
  if (frozen.op === "changes") return true;
  if (observed.op === "==") {
    if (frozen.op === "==") return observed.value === frozen.value;
    if (frozen.op === ">=") return observed.value >= frozen.value;
    return observed.value <= frozen.value;
  }
  if (observed.op === ">=") return frozen.op === ">=" && observed.value >= frozen.value;
  return frozen.op === "<=" && observed.value <= frozen.value;
}

export const GameBenchmarkObligationStatus = Schema.Literals([
  "proven",
  "failed",
  "missing",
  "unsupported",
]);
export type GameBenchmarkObligationStatus = typeof GameBenchmarkObligationStatus.Type;

export const GameBenchmarkObligationRead = Schema.Struct({
  id: Schema.String,
  kind: GameAcceptanceCriterionKind,
  description: Schema.String,
  key: Schema.NullOr(Schema.String),
  expect: Schema.NullOr(Schema.String),
  status: GameBenchmarkObligationStatus,
  detail: Schema.String,
  /** Approved design criteria that carry this obligation. */
  criteria: Schema.Array(Schema.String),
});
export type GameBenchmarkObligationRead = typeof GameBenchmarkObligationRead.Type;

/**
 * Typed samples prove a promise when the caller knows the results describe the
 * current game. The e2e harness passes `measurementEligible: false` when the
 * state stage is stale or unknown; the declared-threshold fallback still grades
 * that historical record.
 */
export interface ObligationEvidence {
  /** Omitted means the results are taken as current evidence. */
  readonly measurementEligible?: boolean;
}

const measuredNumber = (value: GameObservedValue): number | null =>
  typeof value === "boolean"
    ? value
      ? 1
      : 0
    : typeof value === "number" && Number.isFinite(value)
      ? value
      : null;

const satisfiesMeasurement = (
  expectation: ParsedExpectation,
  value: GameObservedValue,
): boolean => {
  const number = measuredNumber(value);
  if (number === null) return false;
  if (expectation.op === "==") return Math.abs(number - expectation.value) < 1e-9;
  if (expectation.op === ">=") return number >= expectation.value;
  return number <= expectation.value;
};

/**
 * A frozen threshold is proven only when the gameplay baseline missed it and
 * the run's last sample satisfies it. The last sample is recorded after the
 * baseline frame, so this is a transition the player caused, not a boot value.
 */
const samplesProve = (
  measurement: GameScenarioCriterionMeasurement,
  expectation: ParsedExpectation,
): boolean =>
  expectation.op !== "changes" &&
  measurement.baseline !== null &&
  measurement.last !== null &&
  measuredNumber(measurement.baseline) !== null &&
  !satisfiesMeasurement(expectation, measurement.baseline) &&
  satisfiesMeasurement(expectation, measurement.last);

const sampleText = (value: GameObservedValue | null): string => {
  if (value === null) return "missing";
  return typeof value === "string" ? JSON.stringify(value.slice(0, 40)) : String(value);
};

/**
 * Grades each frozen promise against the approved design and the state stage's
 * per-criterion results. `proven` requires either a design criterion with a
 * matching key and a strong enough expectation whose state result passed, or a
 * passing criterion whose typed samples themselves cross the frozen threshold.
 * The second path exists because a design may commit to a weaker bound than the
 * benchmark promises; the run's real samples still decide.
 */
export function readObligations(
  obligations: ReadonlyArray<GameBenchmarkObligation>,
  acceptance: ReadonlyArray<GameAcceptanceCriterion>,
  results: ReadonlyArray<
    Pick<GameScenarioCriterionResult, "id" | "status" | "observed" | "measurement">
  >,
  evidence: ObligationEvidence = {},
): ReadonlyArray<GameBenchmarkObligationRead> {
  return obligations.map((obligation) => {
    const base = {
      id: obligation.id,
      kind: obligation.kind,
      description: obligation.description,
      key: obligation.key ?? null,
      expect: obligation.expect ?? null,
    };
    if (obligation.unsupported !== undefined)
      return {
        ...base,
        status: "unsupported" as const,
        detail: obligation.unsupported,
        criteria: [],
      };
    const frozen = parseExpectation(obligation.expect!);
    const sameKey = acceptance.filter(
      (criterion) => criterion.observe !== undefined && criterion.observe.key === obligation.key,
    );
    const sameKeyIds = new Set(sameKey.map((criterion) => criterion.id));
    const criteria = sameKey.filter((criterion) => {
      const observed = parseExpectation(criterion.observe!.expect);
      return frozen !== null && observed !== null && expectationCovers(frozen, observed);
    });
    const ids = criteria.map((criterion) => criterion.id);
    const graded = results.filter((result) => ids.includes(result.id));
    const proven = graded.find((result) => result.status === "passed");
    if (proven !== undefined)
      return {
        ...base,
        status: "proven" as const,
        detail: `${proven.id} passed the state stage.`,
        criteria: ids,
      };
    const typed =
      evidence.measurementEligible !== false
        ? results.flatMap((result) =>
            result.status === "passed" &&
            result.measurement !== undefined &&
            result.measurement.key === obligation.key &&
            sameKeyIds.has(result.id)
              ? [{ id: result.id, measurement: result.measurement }]
              : [],
          )
        : [];
    const measured = typed.find(
      (entry) => frozen !== null && samplesProve(entry.measurement, frozen),
    );
    if (measured !== undefined) {
      const { scenario, baseline, last } = measured.measurement;
      return {
        ...base,
        status: "proven" as const,
        detail: `${measured.id} passed; ${scenario} measured GameState.${obligation.key} ${sampleText(baseline)} → ${sampleText(last)}, which proves ${obligation.expect}.`,
        criteria: [...ids, measured.id],
      };
    }
    if (ids.length === 0) {
      const nearMiss = typed[0];
      if (nearMiss !== undefined) {
        const { scenario, baseline, last } = nearMiss.measurement;
        return {
          ...base,
          status: "missing" as const,
          detail: `${nearMiss.id} passed, but ${scenario} measured GameState.${obligation.key} ${sampleText(baseline)} → ${sampleText(last)}, which does not prove ${obligation.expect}.`,
          criteria: [],
        };
      }
      return {
        ...base,
        status: "missing" as const,
        detail: `The approved design has no criterion observing GameState.${obligation.key} ${obligation.expect}.`,
        criteria: [],
      };
    }
    const failed = graded[0];
    return {
      ...base,
      status: "failed" as const,
      detail:
        failed === undefined
          ? `No state run graded ${ids.join(", ")}.`
          : `${failed.id}: ${failed.observed}`,
      criteria: ids,
    };
  });
}

/** Everything the harness learned before it stopped, as a run writes it out. */
export const GameE2eTurnRead = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["completed", "failed"]),
  durationMs: Schema.Number,
});
export type GameE2eTurnRead = typeof GameE2eTurnRead.Type;

/**
 * The builder's two milestones measured from its producing turn's start: the
 * first playable it published and the last submit it stood behind. They are
 * separate because the gap between them is the production phase; a turn's wall
 * time cannot show it (the turn also waits for review afterwards).
 */
export const GameE2eProductionRead = Schema.Struct({
  firstPlayableAt: Schema.NullOr(Schema.String),
  firstPlayableMs: Schema.NullOr(Schema.Number),
  lastSubmitAt: Schema.NullOr(Schema.String),
  lastSubmitMs: Schema.NullOr(Schema.Number),
  /** Accepted submits in the producing turn; refusals are not counted. */
  submissions: Schema.Number,
  budgetMs: Schema.Number,
});
export type GameE2eProductionRead = typeof GameE2eProductionRead.Type;

const since = (iso: string | null, turnStartedAtMs: number): number | null => {
  if (iso === null) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.max(0, at - turnStartedAtMs);
};

/** Reads the server's production record; a missing timestamp stays missing. */
export const readProductionTiming = (input: {
  readonly production: GameProductionStatus;
  readonly turnStartedAtMs: number;
}): GameE2eProductionRead => ({
  firstPlayableAt: input.production.firstPlayableAt,
  firstPlayableMs: since(input.production.firstPlayableAt, input.turnStartedAtMs),
  lastSubmitAt: input.production.turnLastSubmitAt,
  lastSubmitMs: since(input.production.turnLastSubmitAt, input.turnStartedAtMs),
  submissions: input.production.submissions,
  budgetMs: input.production.budgetMs,
});

/** One repair round as the run summary reports it, without ballots or evidence. */
export const GameE2eRepairLoopRoundRead = Schema.Struct({
  id: Schema.String,
  status: GameReviewRoundStatus,
  decision: Schema.NullOr(GameReviewDecision),
  reason: Schema.NullOr(Schema.String),
  candidateBuildId: Schema.NullOr(Schema.String),
  candidateDirectory: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
});
export type GameE2eRepairLoopRoundRead = typeof GameE2eRepairLoopRoundRead.Type;

/**
 * The review loop a builder turn started, as the harness observed it. The
 * benchmark reads this instead of inferring review from qualification: a loop
 * can stop without promoting and still leave a playable build.
 */
export const GameE2eRepairLoopRead = Schema.Struct({
  id: Schema.String,
  status: GameRepairLoopStatus,
  decision: Schema.NullOr(GameReviewDecision),
  reason: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  repairsUsed: Schema.Number,
  budget: GameReviewBudget,
  rounds: Schema.Array(GameE2eRepairLoopRoundRead),
  /** The build Play shows after the loop ended; completion is asserted on it. */
  selectedBuildId: Schema.NullOr(Schema.String),
  waitedMs: Schema.Number,
  /** The loop outlived its budget plus the shutdown margin. */
  timedOut: Schema.Boolean,
});
export type GameE2eRepairLoopRead = typeof GameE2eRepairLoopRead.Type;

export const GameE2eRunSummary = Schema.Struct({
  // V1 aggregates keep their historical score gate; V2 reports review separately.
  schemaVersion: Schema.Literals([1, 2]),
  review: Schema.optionalKey(Schema.NullOr(GameReviewStatus)),
  harnessCommit: Schema.String,
  startedAt: Schema.String,
  durationMs: Schema.Number,
  /** Where the run stopped: create, design, build, qualified, preview, native, revise, done. */
  phase: Schema.String,
  /** The harness's own timeout fired; the process still wrote this summary. */
  timedOut: Schema.Boolean,
  fixture: Schema.NullOr(Schema.Struct({ id: Schema.String, checksum: Schema.String })),
  game: Schema.NullOr(
    Schema.Struct({ name: Schema.String, root: Schema.String, threadId: Schema.String }),
  ),
  turns: Schema.Array(GameE2eTurnRead),
  /** The producing turn's first playable and final submit, from its start. */
  production: Schema.optionalKey(Schema.NullOr(GameE2eProductionRead)),
  /** The review loop the build turn started, once it reached a terminal state. */
  loop: Schema.optionalKey(Schema.NullOr(GameE2eRepairLoopRead)),
  qualification: Schema.NullOr(LegacyGameQualificationRead),
  lastPlaytest: Schema.NullOr(GameLastPlaytest),
  obligations: Schema.Array(GameBenchmarkObligationRead),
  /**
   * Every visual judgement the run's game earned, oldest first. The repair
   * round runs inside the build turn and leaves one review per playtest
   * evidence folder, so the qualification record's last judgement is not the
   * whole story.
   */
  visualJudgements: Schema.optionalKey(Schema.Array(GameVisualJudgement)),
  error: Schema.NullOr(Schema.String),
});
export type GameE2eRunSummary = typeof GameE2eRunSummary.Type;

const encodeSummary = Schema.encodeSync(Schema.fromJsonString(GameE2eRunSummary));
const decodeSummary = Schema.decodeUnknownSync(Schema.fromJsonString(GameE2eRunSummary));

export const encodeRunSummary = (summary: GameE2eRunSummary): string =>
  `${encodeSummary(summary)}\n`;

/** An unreadable or missing file is `null`; the caller reports a crash, never a verdict. */
export const decodeRunSummary = (text: string): GameE2eRunSummary | null => {
  try {
    return decodeSummary(text);
  } catch {
    return null;
  }
};

/** The immutable web export a schema-2 run says Play served. */
export interface SelectedWebArtifact {
  readonly buildId: string;
  /** Game-relative directory, exactly as the run recorded it. */
  readonly directory: string;
  /** The absolute directory to serve read-only. */
  readonly absoluteDirectory: string;
}

/**
 * Resolves the artifact a schema-2 run selected. The benchmark must grade the
 * bytes Play served, not a fresh export of the sources: an export can differ
 * from the accepted candidate even when the sources look the same. A schema-2
 * run that names no usable artifact is an error, never a workspace fallback;
 * schema 1 predates selection and returns `null` so its historical grading is
 * unchanged.
 */
export async function resolveSelectedArtifact(
  summary: GameE2eRunSummary,
  root: string,
): Promise<SelectedWebArtifact | null> {
  if (summary.schemaVersion !== 2) return null;
  const facts = summary.review?.selectedBuildFacts ?? null;
  if (facts === null || facts.buildId === null || facts.directory === null)
    throw new Error("The schema-2 run recorded no selected artifact (buildId/directory).");
  const buildId = facts.buildId;
  // The product only publishes candidates at builds/candidates/<buildId>. A
  // different path is not the artifact the selection names, and a relative
  // path is how traversal would enter; both are refused before any serving.
  const claimed = candidateBuildId(facts.directory);
  if (claimed === null || claimed !== buildId)
    throw new Error(
      `The selected-build facts record ${facts.directory} for build ${buildId}; expected builds/candidates/${buildId}.`,
    );
  const selected = summary.loop?.selectedBuildId ?? null;
  if (selected !== null && selected !== buildId)
    throw new Error(`The selected-build facts describe ${buildId}, but Play serves ${selected}.`);
  const gameRoot = NodePath.resolve(root);
  const absoluteDirectory = NodePath.resolve(gameRoot, facts.directory);
  if (absoluteDirectory !== gameRoot && !absoluteDirectory.startsWith(`${gameRoot}${NodePath.sep}`))
    throw new Error(`The selected artifact resolves outside the game root: ${absoluteDirectory}.`);
  const index = NodePath.join(absoluteDirectory, "index.html");
  const stat = await NodeFSP.stat(index).catch(() => null);
  if (stat === null || !stat.isFile() || stat.size === 0)
    throw new Error(
      `The selected artifact is missing a nonempty index.html: ${absoluteDirectory}.`,
    );
  return { buildId, directory: facts.directory, absoluteDirectory };
}

const decodeJudgement = Schema.decodeUnknownSync(Schema.fromJsonString(GameVisualJudgement));

/**
 * Every visual judgement under the run's game, oldest first. A judgement is
 * written into the playtest evidence folder it judged; a repair round inside
 * the build turn adds another folder and another review.
 */
export async function readVisualJudgements(
  root: string | undefined,
): Promise<ReadonlyArray<GameVisualJudgement>> {
  if (root === undefined) return [];
  const directory = NodePath.join(root, "builds", "playtests");
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => []);
  const judgements: GameVisualJudgement[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const text = await NodeFSP.readFile(
      NodePath.join(directory, entry.name, "visual-review.json"),
      "utf8",
    ).catch(() => null);
    if (text === null) continue;
    try {
      judgements.push(decodeJudgement(text));
    } catch {
      // An unreadable evidence copy is not a verdict; the record still has the last one.
    }
  }
  return judgements.sort((left, right) => left.judgedAt.localeCompare(right.judgedAt));
}

/**
 * The summed per-dimension score change from the first judgement to the last.
 * Dimensions either review scored `missing` cannot be compared, so they are
 * left out; `null` means the run judged fewer than twice.
 */
export function visualRepairDelta(judgements: ReadonlyArray<GameVisualJudgement>): number | null {
  const first = judgements[0];
  const last = judgements[judgements.length - 1];
  if (judgements.length < 2 || first === undefined || last === undefined) return null;
  const before = new Map(first.dimensions.map((score) => [score.dimension, score.score]));
  let delta: number | null = null;
  for (const score of last.dimensions) {
    const previous = before.get(score.dimension);
    if (typeof previous !== "number" || typeof score.score !== "number") continue;
    delta = (delta ?? 0) + score.score - previous;
  }
  return delta;
}
