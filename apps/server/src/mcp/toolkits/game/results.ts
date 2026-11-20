// How a game tool answers an agent: text first and short. Line 1 is the verdict with its numbers,
// then the findings with repeats folded, then a `next:` line the server writes from the state,
// then the op's details as JSON under a byte cap that names what it cut. A refusal is
// `{refused, next}` in at most REFUSAL_MOST characters, naming the real cause. T3's preview tools
// are the model: a bounded snapshot that says what it omitted, and errors that say what to do.
import * as Schema from "effect/Schema";
import { GameOperationError } from "@kurambit/contracts";

/** What an agent reads when a game op is refused. */
export const GameToolRefusal = Schema.Struct({ refused: Schema.String, next: Schema.String });
export type GameToolRefusal = typeof GameToolRefusal.Type;

export const REFUSAL_MOST = 300;
/** Bytes of text an op answers with, images aside: TOOLS.md's targets, ≤2 KB unless named. */
const DEFAULT_CAP = 2_048;
const CAPS: Readonly<Record<string, number>> = {
  "game_check.final": 4_096,
  "game_play.bot": 4_096,
  "game_play.eval": 16_384,
  "game_play.model_sheet": 1_536,
};
export const resultCap = (tool: string, op: string) => CAPS[`${tool}.${op}`] ?? DEFAULT_CAP;
/** Findings shown under the verdict; the rest are counted. */
const FINDINGS_SHOWN = 8;

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const cut = (text: string, most: number) =>
  text.length <= most ? text : `${text.slice(0, Math.max(0, most - 1)).trimEnd()}…`;
const sentences = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z`"(])/)
    .filter((each) => each !== "");

/**
 * Findings with repeats folded: lines that differ only in their numbers ("Player out of world at
 * (3, -0, 2000)", "(3, -0, 2001)", …) become the first one with ×N.
 */
export const foldFindings = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const groups = new Map<string, { first: string; count: number }>();
  for (const line of lines) {
    const shape = line.replace(/-?\d+(?:\.\d+)?/g, "#");
    const group = groups.get(shape);
    if (group === undefined) groups.set(shape, { first: line, count: 1 });
    else group.count += 1;
  }
  return [...groups.values()].map(({ first, count }) =>
    count === 1 ? first : `${first} ×${count}`,
  );
};

type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };
/** Pictures ride as image content, not text: never cut, never counted. */
const PICTURES = new Set(["screenshot", "screenshots"]);

/** The largest thing in `value` that can shrink: a long string or a list of two or more. */
const largest = (
  value: Json,
  path: string,
): { readonly path: string; readonly size: number; readonly node: Json } | null => {
  let best: { path: string; size: number; node: Json } | null = null;
  const consider = (node: Json, at: string) => {
    const size = bytes(JSON.stringify(node));
    if (
      (typeof node === "string" && node.length > 48) ||
      (Array.isArray(node) && node.length > 1)
    ) {
      if (best === null || size > best.size) best = { path: at, size, node };
    }
    if (node !== null && typeof node === "object") {
      const entries = Array.isArray(node)
        ? node.map((each, index) => [String(index), each] as const)
        : Object.entries(node).filter(([key]) => !PICTURES.has(key));
      for (const [key, child] of entries) consider(child, at === "" ? key : `${at}.${key}`);
    }
  };
  consider(value, path);
  return best;
};

const replaceAt = (value: Json, path: ReadonlyArray<string>, next: Json): Json => {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  if (Array.isArray(value))
    return value.map((each, index) =>
      String(index) === head ? replaceAt(each, rest, next) : each,
    );
  if (value !== null && typeof value === "object")
    return { ...value, [head!]: replaceAt((value as Record<string, Json>)[head!]!, rest, next) };
  return value;
};

const textSize = (value: Json) =>
  bytes(JSON.stringify(value, (key, each: unknown) => (PICTURES.has(key) ? undefined : each)));

/**
 * `details` within `budget` bytes of JSON: the largest list is halved or the longest string cut
 * until it fits, and `omitted` names each cut.
 */
export const capDetails = (details: Record<string, Json>, budget: number) => {
  let value: Json = details;
  const omitted = new Map<string, string>();
  for (let round = 0; round < 200 && textSize(value) > budget; round += 1) {
    const found = largest(value, "");
    if (found === null) break;
    const path = found.path.split(".");
    const general = found.path.replace(/\.\d+(?=\.|$)/g, "[]");
    if (Array.isArray(found.node)) {
      const keep = Math.floor(found.node.length / 2);
      value = replaceAt(value, path, found.node.slice(0, keep));
      omitted.set(general, `${general}: ${found.node.length - keep} more not shown`);
    } else if (typeof found.node === "string") {
      value = replaceAt(value, path, cut(found.node, Math.floor(found.node.length / 2)));
      omitted.set(general, `${general}: cut`);
    }
  }
  return omitted.size === 0
    ? (value as Record<string, Json>)
    : { ...(value as Record<string, Json>), omitted: [...omitted.values()] };
};

/** An op's verdict: its first line, the findings under it, and the one call or edit that follows. */
export interface Verdict {
  readonly line: string;
  readonly findings?: ReadonlyArray<string>;
  readonly next: string;
  /** Detail fields the line and findings already say ("qa.problems"): said once, not twice. */
  readonly said?: ReadonlyArray<string>;
}

const without = (value: Json, path: ReadonlyArray<string>): Json => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const [head = "", ...rest] = path;
  if (!(head in value)) return value;
  const { [head]: inner, ...others } = value as Record<string, Json>;
  return rest.length === 0 ? others : { ...others, [head]: without(inner!, rest) };
};

/** The text an agent reads first, and the capped details after it. */
export const present = (
  tool: string,
  op: string,
  verdict: Verdict,
  details: Record<string, unknown>,
): Readonly<Record<string, unknown>> & { readonly summary: string } => {
  const findings = foldFindings(verdict.findings ?? []);
  const summary = [
    `${tool} ${op}: ${verdict.line}`,
    ...findings.slice(0, FINDINGS_SHOWN).map((finding) => `- ${cut(finding, 300)}`),
    ...(findings.length > FINDINGS_SHOWN
      ? [`- and ${findings.length - FINDINGS_SHOWN} more (in the details)`]
      : []),
    `next: ${verdict.next}`,
  ].join("\n");
  const json = (verdict.said ?? []).reduce<Json>(
    (value, path) => without(value, path.split(".")),
    JSON.parse(JSON.stringify(details)) as Json,
  ) as Record<string, Json>;
  return {
    summary,
    ...capDetails(json, Math.max(256, resultCap(tool, op) - bytes(summary))),
  };
};

/** The text an agent reads of a game tool's answer: the summary, then the details. */
export const resultText = (metadata: Record<string, unknown>) => {
  const { summary, ...details } = metadata;
  return typeof summary === "string"
    ? `${summary}\n${JSON.stringify(details)}`
    : JSON.stringify(metadata);
};

const isGameOperationError = Schema.is(GameOperationError);

/** What to do after a refusal for a reason whose detail does not say. */
const NEXT_BY_REASON: Partial<Record<GameOperationError["reason"], string>> = {
  busy: "wait for the game's other operation to end, then call again.",
  "low-memory": "close open play sessions (game_play op close), then call again.",
  "setup-missing": "tell the person what to set up; do not retry.",
  "tool-missing": "tell the person; Settings → Game tools sets it up.",
  "license-missing": "tell the person; do not retry.",
  cancelled: "call again only if the work still matters.",
  "tool-failed": "call again once; if it fails again, tell the person.",
  "engine-parked": "tell the person this version of Kurambit does not play this engine.",
  "project-not-found": "this chat works in no game; game tools need one.",
  "source-changed": "call again: the game changed while this ran.",
};

/**
 * A refusal in at most REFUSAL_MOST characters: the detail's first sentence is the cause (never
 * the error's generic preamble), the rest of it, when it says what to do, is `next`.
 */
export const refusal = (cause: unknown): GameToolRefusal => {
  const error = isGameOperationError(cause) ? cause : null;
  const text =
    error?.detail ??
    (cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "it failed");
  const [first = "It failed.", ...rest] = sentences(text);
  const told = rest.join(" ");
  const next =
    told !== ""
      ? told
      : ((error === null ? undefined : NEXT_BY_REASON[error.reason]) ??
        "fix what the reason names, then call again.");
  const room = REFUSAL_MOST - bytes('{"refused":"","next":""}');
  const refused = cut(first, Math.max(120, room - Math.min(next.length, room / 2)));
  let then = cut(next, room - refused.length);
  // Escapes and multi-byte characters count too: trim `next` until the whole fits.
  while (bytes(JSON.stringify({ refused, next: then })) > REFUSAL_MOST && then.length > 1)
    then = cut(then, then.length - 8);
  return { refused, next: then };
};
