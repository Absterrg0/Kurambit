import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

/**
 * One promise the approved design makes to the player. `observe` names a
 * GameState autoload property so a later server-owned runner can check the
 * claim against the real game instead of trusting prose.
 */
export const GameAcceptanceCriterionKind = Schema.Literals([
  "mechanic",
  "content",
  "end",
  "control",
]);
export type GameAcceptanceCriterionKind = typeof GameAcceptanceCriterionKind.Type;
export const GameAcceptanceObservation = Schema.Struct({
  key: Schema.String,
  /** `==V`, `>=N`, `<=N` or `changes`. */
  expect: Schema.String,
});
export type GameAcceptanceObservation = typeof GameAcceptanceObservation.Type;
export const GameAcceptanceCriterion = Schema.Struct({
  id: Schema.String,
  kind: GameAcceptanceCriterionKind,
  text: Schema.String,
  observe: Schema.optionalKey(GameAcceptanceObservation),
});
export type GameAcceptanceCriterion = typeof GameAcceptanceCriterion.Type;

export const GAME_ACCEPTANCE_HEADING = "Acceptance";
const kindNames = "mechanic, content, end or control";
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const keyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const expectPattern = /^(?:==|>=|<=)-?\d+(?:\.\d+)?$|^changes$/;

export type AcceptanceParseResult =
  | { readonly ok: true; readonly criteria: readonly GameAcceptanceCriterion[] }
  | { readonly ok: false; readonly issues: readonly string[] };

const sectionBody = (design: string, heading: string): string | null => {
  const lines = design.split(/\r?\n/);
  let found = false;
  const body: string[] = [];
  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match !== null) {
      if (found) break;
      found = match[1] === heading;
      continue;
    }
    if (found) body.push(line);
  }
  return found ? body.join("\n") : null;
};

const criterionIssues = (value: unknown, index: number): string[] => {
  const where = `Acceptance criterion ${index + 1}`;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return [`${where} must be an object.`];
  const record = value as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof record.id !== "string" || !idPattern.test(record.id))
    issues.push(`${where} needs a lowercase slug id such as "light-all-lanterns".`);
  if (
    typeof record.kind !== "string" ||
    !(["mechanic", "content", "end", "control"] as const).includes(record.kind as never)
  )
    issues.push(`${where} has an unknown kind; use ${kindNames}.`);
  if (typeof record.text !== "string" || record.text.trim() === "")
    issues.push(`${where} needs a plain-language text.`);
  if (record.observe !== undefined) {
    const observe = record.observe;
    if (typeof observe !== "object" || observe === null || Array.isArray(observe))
      issues.push(`${where}'s observe must be an object with key and expect.`);
    else {
      const observation = observe as Record<string, unknown>;
      if (typeof observation.key !== "string" || !keyPattern.test(observation.key))
        issues.push(`${where}'s observe.key must name a GameState property.`);
      if (typeof observation.expect !== "string" || !expectPattern.test(observation.expect))
        issues.push(`${where}'s observe.expect must be ==V, >=N, <=N or changes.`);
    }
  }
  return issues;
};

/**
 * Reads the fenced `acceptance` block under `## Acceptance`. This is a pure
 * check: the same document text always yields the same verdict, so the server,
 * the e2e harness and tests cannot disagree about whether a design is bound.
 */
export function parseAcceptance(design: string): AcceptanceParseResult {
  const section = sectionBody(design, GAME_ACCEPTANCE_HEADING);
  if (section === null)
    return {
      ok: false,
      issues: [`DESIGN.md has no "## ${GAME_ACCEPTANCE_HEADING}" section.`],
    };
  const fenced = section.match(/```[ \t]*acceptance[ \t]*\r?\n([\s\S]*?)```/);
  if (fenced === null)
    return {
      ok: false,
      issues: [
        `DESIGN.md's "${GAME_ACCEPTANCE_HEADING}" section has no fenced \`\`\`acceptance block.`,
      ],
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced[1] ?? "");
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, issues: [`The acceptance block is not valid JSON: ${detail}`] };
  }
  if (!Array.isArray(parsed))
    return { ok: false, issues: ["The acceptance block must be a JSON array."] };
  if (parsed.length === 0)
    return { ok: false, issues: ["The acceptance block needs at least one criterion."] };
  const issues = parsed.flatMap(criterionIssues);
  if (issues.length > 0) return { ok: false, issues };
  const ids = new Set<string>();
  for (const criterion of parsed as GameAcceptanceCriterion[]) {
    if (ids.has(criterion.id))
      issues.push(`The acceptance block uses the id "${criterion.id}" more than once.`);
    ids.add(criterion.id);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, criteria: parsed as GameAcceptanceCriterion[] };
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const headingOf = (line: string) => line.match(/^##\s+(.+?)\s*$/)?.[1];
const sectionsOf = (design: string) => {
  const sections = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of design.split(/\r?\n/)) {
    const heading = headingOf(line);
    if (heading !== undefined) {
      current = heading;
      sections.set(heading, []);
      continue;
    }
    if (current !== undefined) sections.get(current)!.push(line);
  }
  return new Map([...sections].map(([heading, lines]) => [heading, lines.join("\n").trim()]));
};

export interface DesignValidation {
  readonly issues: readonly string[];
  /** The parsed criteria when the document is valid; empty otherwise. */
  readonly acceptance: readonly GameAcceptanceCriterion[];
}

/**
 * Everything a design needs before a creator may approve it: the scaffold is
 * gone, every section carries real decisions, and the acceptance block binds
 * the promise. The skeleton is passed in so a game validates against the
 * version it was created with.
 */
export function validateDesignDocument(input: {
  readonly design: string | null;
  readonly skeleton: string;
}): DesignValidation {
  const { design, skeleton } = input;
  if (design === null || design.trim() === "")
    return { issues: ["DESIGN.md is missing or empty."], acceptance: [] };
  const issues: string[] = [];
  const headings = skeleton
    .split(/\r?\n/)
    .map(headingOf)
    .filter((heading): heading is string => heading !== undefined);
  if (headings.length < 5) issues.push("The design skeleton has no section headings.");
  const sections = sectionsOf(design);
  for (const heading of headings) {
    if (!sections.has(heading)) {
      issues.push(`DESIGN.md is missing the "${heading}" section.`);
      continue;
    }
    if (normalize(sections.get(heading)!).length < 40)
      issues.push(`DESIGN.md's "${heading}" section is still empty or a hint.`);
  }
  const normalizedDesign = normalize(design);
  if (normalizedDesign.length < 1_200)
    issues.push(
      `DESIGN.md is too thin for a one-page design (${normalizedDesign.length} characters).`,
    );
  for (const paragraph of skeleton.split(/\n\s*\n/).map(normalize)) {
    if (paragraph === "" || paragraph.startsWith("#")) continue;
    if (/^(?:-|\d+\.)\s/.test(paragraph)) continue;
    if (normalizedDesign.includes(paragraph))
      issues.push(`DESIGN.md still contains the skeleton hint "${paragraph.slice(0, 70)}..."`);
  }
  for (const line of skeleton.split(/\r?\n/)) {
    const hint = line.match(/^(?:-|\d+\.)\s+\*\*[^*]+\*\*\s+—\s+(.+)$/)?.[1];
    if (hint !== undefined && normalizedDesign.includes(normalize(hint)))
      issues.push(
        `DESIGN.md still contains the skeleton hint "${normalize(hint).slice(0, 70)}..."`,
      );
  }
  const parsed = parseAcceptance(design);
  if (!parsed.ok) issues.push(...parsed.issues);
  else {
    if (!parsed.criteria.some((criterion) => criterion.kind === "end"))
      issues.push("The acceptance block needs at least one `end` criterion (how the game is won).");
    if (!parsed.criteria.some((criterion) => criterion.kind === "mechanic"))
      issues.push(
        "The acceptance block needs at least one `mechanic` criterion (the core thing the player does).",
      );
  }
  return {
    issues: issues.slice(0, 20),
    acceptance: parsed.ok && issues.length === 0 ? parsed.criteria : [],
  };
}

/** The design lifecycle the server reads from its own approval record. */
export const GameDesignState = Schema.Literals(["draft", "approved", "changed", "legacy"]);
export type GameDesignState = typeof GameDesignState.Type;
export const GameDesignRead = Schema.Struct({
  state: GameDesignState,
  /** The hash the creator approved, or null when no revision was approved. */
  approvedHash: Schema.NullOr(Schema.String),
  /** The hash of DESIGN.md on disk right now. */
  currentHash: Schema.NullOr(Schema.String),
  approvedAt: Schema.NullOr(Schema.String),
  /** The acceptance bound to the approved revision. */
  acceptance: Schema.Array(GameAcceptanceCriterion),
  /** What has to change before this design can be approved. */
  issues: Schema.Array(Schema.String),
});
export type GameDesignRead = typeof GameDesignRead.Type;
export const GameDesignApproveInput = Schema.Struct({
  threadId: ThreadId,
  /** The design hash the creator reviewed; the server rejects anything else. */
  expectedDesignHash: Schema.String,
});
export type GameDesignApproveInput = typeof GameDesignApproveInput.Type;
export const GameDesignApprovalResult = Schema.Struct({
  approvedAt: Schema.String,
  approvalId: Schema.String,
  designHash: Schema.String,
});
export type GameDesignApprovalResult = typeof GameDesignApprovalResult.Type;
