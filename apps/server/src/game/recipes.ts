// @effect-diagnostics nodeBuiltinImport:off -- Reads the recipes the game's agent picked from its own studio-skills.
// The recipes a game's agent picked (game.json `recipes`, at most RECIPES_PER_TURN), each read
// back as one line of numbers on a check: what the harness measured against the recipe's
// Checks, what it could not, and how many checks are the agent's own tests. A line reports;
// it never fails the check (style numbers bind only through STYLE.json's lock).
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import { parse as parseYaml } from "yaml";
import { insideGame } from "./gamePath.ts";

/** SkillsBench: two or three curated skills per task helped; four or more helped far less. */
const RECIPES_PER_TURN = 3;
const RECIPE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const LINE_MOST = 300;

/** One check of a recipe: a value the harness measures (fact or probe), the review's, or the agent's own test. */
interface RecipeCheck {
  readonly kind: "fact" | "probe" | "review" | "agent";
  /** The answer path the value is read at (fact, probe), or what the agent or the review checks. */
  readonly what: string;
  readonly label: string;
  /** "<= 0.3", ">= 20", "== 1"; absent: the value is only reported. */
  readonly want: string | null;
}

const KINDS = ["fact", "probe", "review", "agent"] as const;
const asCheck = (raw: unknown): RecipeCheck | null => {
  if (raw === null || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const kind = KINDS.find((each) => typeof entry[each] === "string");
  if (kind === undefined) return null;
  const what = String(entry[kind]);
  return {
    kind,
    what,
    label: typeof entry.label === "string" ? entry.label : what.split(".").at(-1)!,
    want:
      typeof entry.want === "string" || typeof entry.want === "number" ? String(entry.want) : null,
  };
};

/** The checks in a recipe's `## Checks` section, from its fenced YAML block. */
const recipeChecks = (text: string): ReadonlyArray<RecipeCheck> => {
  const section = text.split(/\n## Checks\n/)[1];
  const block = section?.match(/```ya?ml\n([\s\S]*?)```/)?.[1];
  if (block === undefined) return [];
  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.flatMap((each) => asCheck(each) ?? []) : [];
};

const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (inner, key) =>
        inner !== null && typeof inner === "object"
          ? (inner as Record<string, unknown>)[key]
          : undefined,
      value,
    );

const shown = (value: unknown) =>
  typeof value === "number"
    ? Number.isInteger(value)
      ? String(value)
      : value.toFixed(Math.abs(value) < 10 ? 2 : 1)
    : typeof value === "boolean"
      ? value
        ? "yes"
        : "no"
      : String(value);

const meets = (value: unknown, want: string): boolean | null => {
  const match = want.trim().match(/^(<=|>=|==|<|>)\s*(-?[\d.]+|true|false)$/);
  if (match === null) return null;
  const [, op, raw] = match;
  if (raw === "true" || raw === "false") return op === "==" ? value === (raw === "true") : null;
  if (typeof value !== "number") return null;
  const n = Number(raw);
  return op === "<="
    ? value <= n
    : op === ">="
      ? value >= n
      : op === "<"
        ? value < n
        : op === ">"
          ? value > n
          : value === n;
};

/**
 * One line for a recipe against a check's answer: each measured value with its aim and ✓ or ✗,
 * what was not measured, and the count left to the review or the agent's own tests.
 */
const recipeLine = (id: string, checks: ReadonlyArray<RecipeCheck>, answer: unknown): string => {
  const parts: Array<string> = [];
  const unmeasured: Array<string> = [];
  let review = 0;
  let agent = 0;
  for (const check of checks) {
    if (check.kind === "review") review += 1;
    else if (check.kind === "agent") agent += 1;
    else {
      const value = at(answer, check.what);
      // A reading that says why it was not measured is not a value.
      if (
        value === undefined ||
        value === null ||
        (typeof value === "object" && "notMeasured" in value)
      )
        unmeasured.push(check.label);
      else {
        const ok = check.want === null ? null : meets(value, check.want);
        parts.push(
          `${check.label} ${shown(value)}${check.want === null ? "" : ` (aim ${check.want}${ok === null ? "" : ok ? " ✓" : " ✗"})`}`,
        );
      }
    }
  }
  const measured = checks.length - review - agent - unmeasured.length;
  const line = [
    `recipe ${id} ${measured}/${checks.length - review - agent} measured`,
    ...parts,
    ...(unmeasured.length === 0 ? [] : [`not measured: ${unmeasured.join(", ")}`]),
    ...(review === 0 ? [] : [`${review} in the Blender review`]),
    ...(agent === 0 ? [] : [`${agent} by your own test`]),
  ].join(" · ");
  return line.length <= LINE_MOST ? line : `${line.slice(0, LINE_MOST - 1)}…`;
};

const counted = (raw: string | undefined, unit: string | undefined) =>
  raw === undefined
    ? undefined
    : Number(raw.replace(/,/g, "")) * (unit === "M" ? 1e6 : unit === "k" ? 1e3 : 1);

/** The performance line's numbers ("58 fps · … · 420 draw calls · 2.3M triangles"), as `perf.*`. */
const performanceNumbers = (line: unknown) => {
  if (typeof line !== "string") return {};
  const fps = line.match(/^(\d+) fps/)?.[1];
  const draws = line.match(/([\d,.]+)([kM]?) draw calls/);
  const triangles = line.match(/([\d,.]+)([kM]?) triangles/);
  return {
    fps: fps === undefined ? undefined : Number(fps),
    drawCalls: counted(draws?.[1], draws?.[2]),
    triangles: counted(triangles?.[1], triangles?.[2]),
  };
};

/** The first minute's report (`player.*`), when the check measured it. */
const playerReport = (answer: unknown) => {
  const player = (answer as { player?: { status?: string; report?: unknown } }).player;
  return player?.status === "measured" ? player.report : undefined;
};

/**
 * The lines for a game's picked recipes against a check's answer. A recipe the game does not
 * hold, or one past the per-turn limit, says so instead of being read.
 */
export const recipeLines = (root: string, picked: ReadonlyArray<string>, answer: unknown) =>
  Effect.promise(async () => {
    const lines: Array<string> = [];
    for (const id of picked.slice(0, RECIPES_PER_TURN)) {
      if (!RECIPE_ID.test(id)) {
        lines.push(
          `recipe ${id.slice(0, 48)}: not a recipe id (studio-skills/AGENTS.md lists them)`,
        );
        continue;
      }
      const text = await NodeFSP.readFile(
        insideGame(root, `studio-skills/recipes/${id}.md`),
        "utf8",
      ).catch(() => null);
      lines.push(
        text === null
          ? `recipe ${id}: no studio-skills/recipes/${id}.md (studio-skills/AGENTS.md lists them)`
          : recipeLine(id, recipeChecks(text), {
              ...(answer as object),
              perf: performanceNumbers((answer as { performance?: unknown }).performance),
              player: playerReport(answer),
            }),
      );
    }
    if (picked.length > RECIPES_PER_TURN)
      lines.push(
        `recipes past the first ${RECIPES_PER_TURN} are not read: ${picked.slice(RECIPES_PER_TURN).join(", ").slice(0, 120)}`,
      );
    return lines;
  });
