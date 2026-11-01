// @effect-diagnostics nodeBuiltinImport:off -- The benchmark reads frozen brief files and writes its own summaries.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

/**
 * Marker prefix for a run whose build qualified and booted but whose review
 * loop lacks complete judgment evidence. game-e2e writes it; the aggregate
 * matches this marker, never prose, to label the run review-incomplete.
 */
// The benchmark's frozen vocabulary; the server no longer binds acceptance.
const GameBenchmarkObligationKind = Schema.Literals([
  "control",
  "mechanic",
  "content",
  "win",
  "lose",
  "presentation",
]);

const GameTemplateId = Schema.Literals(["blank"]);
type GameTemplateId = typeof GameTemplateId.Type;

/**
 * One promise a benchmark brief makes, frozen before an agent builds anything.
 * `key`/`expect` use the design vocabulary the server already grades; a promise
 * that vocabulary cannot express carries `unsupported` and is still reported.
 */
export const GameBenchmarkObligation = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)),
  kind: GameBenchmarkObligationKind,
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
