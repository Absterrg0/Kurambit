// @effect-diagnostics nodeBuiltinImport:off -- The benchmark reads frozen brief files and writes its own summaries.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  GameAcceptanceCriterionKind,
  GameLastPlaytest,
  GameQualificationRead,
  GameTemplateId,
  type GameAcceptanceCriterion,
  type GameScenarioCriterionResult,
} from "../../packages/contracts/src/index.ts";

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
 * Grades each frozen promise against the approved design and the state stage's
 * per-criterion results. `proven` requires a design criterion with a matching
 * key and a strong enough expectation whose state result passed.
 */
export function readObligations(
  obligations: ReadonlyArray<GameBenchmarkObligation>,
  acceptance: ReadonlyArray<GameAcceptanceCriterion>,
  results: ReadonlyArray<Pick<GameScenarioCriterionResult, "id" | "status" | "observed">>,
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
    const criteria = acceptance.filter((criterion) => {
      if (criterion.observe === undefined || criterion.observe.key !== obligation.key) return false;
      const observed = parseExpectation(criterion.observe.expect);
      return frozen !== null && observed !== null && expectationCovers(frozen, observed);
    });
    const ids = criteria.map((criterion) => criterion.id);
    if (ids.length === 0)
      return {
        ...base,
        status: "missing" as const,
        detail: `The approved design has no criterion observing GameState.${obligation.key} ${obligation.expect}.`,
        criteria: [],
      };
    const graded = results.filter((result) => ids.includes(result.id));
    const proven = graded.find((result) => result.status === "passed");
    if (proven !== undefined)
      return {
        ...base,
        status: "proven" as const,
        detail: `${proven.id} passed the state stage.`,
        criteria: ids,
      };
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

export const GameE2eRunSummary = Schema.Struct({
  schemaVersion: Schema.Literal(1),
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
  qualification: Schema.NullOr(GameQualificationRead),
  lastPlaytest: Schema.NullOr(GameLastPlaytest),
  obligations: Schema.Array(GameBenchmarkObligationRead),
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
