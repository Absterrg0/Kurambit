import * as Schema from "effect/Schema";
import type { GameCheckIssue } from "@kurambit/contracts";

/**
 * The checker script reports what it can see from inside Godot (unloadable
 * files, lint findings). Godot prints parse and runtime errors on stderr with
 * the file and line, so the caller merges both sources. This module is pure so
 * the noisy formats can be tested without launching an engine.
 */
const RawIssue = Schema.Struct({ file: Schema.String, message: Schema.String });
export const RawCheckResult = Schema.fromJsonString(
  Schema.Struct({
    mainScene: Schema.String,
    gameplayScene: Schema.optionalKey(Schema.String),
    /**
     * Which entries the checker ran. Optional so a checker written by an older
     * server still decodes; GameService treats a missing list as no entry run.
     */
    entries: Schema.optionalKey(Schema.Array(Schema.String)),
    errors: Schema.Array(RawIssue),
    warnings: Schema.Array(RawIssue),
  }),
);

const MAX_ISSUES = 100;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const ERROR_LINE = /^(SCRIPT ERROR|USER ERROR|ERROR):\s*(.*)$/;
const LOCATION = /^\s+at: .+\((.+):(\d+)\)\s*$/;
const SCRIPT_LOAD_FAILURE = /^Failed to load script "(res:\/\/[^"]+)"/;

const trimFile = (file: string) =>
  file.startsWith("res://") ? file : file.startsWith("user://") ? file : "";

const locationAfter = (lines: readonly string[], index: number) => {
  for (let next = index + 1; next < Math.min(index + 4, lines.length); next++) {
    const match = LOCATION.exec(lines[next] ?? "");
    if (match === null) break;
    const file = trimFile(match[1] ?? "");
    if (file !== "") return { file, line: Number(match[2]) };
  }
  return null;
};

export const parseGodotIssues = (output: string): GameCheckIssue[] => {
  const lines = output.replace(ANSI, "").split(/\r?\n/);
  const issues: GameCheckIssue[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of lines.entries()) {
    const match = ERROR_LINE.exec(raw.trimEnd());
    if (match === null) continue;
    const message = (match[2] ?? "").trim();
    if (message === "") continue;
    // Godot's own cleanup chatter is not the game's failure.
    if (/ObjectDB instances? leaked/.test(message)) continue;
    if (/^\d+ resources? still in use at exit \(run with --verbose for details\)\.$/.test(message))
      continue;
    const quoted = SCRIPT_LOAD_FAILURE.exec(message);
    const location = locationAfter(lines, index);
    const file = location?.file ?? (quoted?.[1] ? quoted[1] : "");
    const issue: GameCheckIssue = {
      file,
      ...(location?.line ? { line: location.line } : {}),
      message,
    };
    const key = `${issue.file}:${issue.line ?? ""}:${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(issue);
    if (issues.length >= MAX_ISSUES) break;
  }
  return issues;
};

/**
 * The checker's JSON has no line numbers (Godot does not expose them to
 * GDScript), while stderr does. Prefer the located version and drop the
 * locationless duplicate it makes redundant.
 */
export const mergeCheckIssues = (
  reported: readonly GameCheckIssue[],
  parsed: readonly GameCheckIssue[],
): GameCheckIssue[] => {
  const locatedFiles = new Set(
    parsed.filter((issue) => issue.line !== undefined).map((issue) => issue.file),
  );
  const result: GameCheckIssue[] = [];
  const seen = new Set<string>();
  const add = (issue: GameCheckIssue) => {
    const key = `${issue.file}:${issue.line ?? ""}:${issue.message}`;
    if (seen.has(key) || result.length >= MAX_ISSUES) return;
    seen.add(key);
    result.push(issue);
  };
  for (const issue of parsed) add(issue);
  for (const issue of reported) {
    if (issue.line === undefined && locatedFiles.has(issue.file)) continue;
    add(issue);
  }
  return result;
};

export const limitIssues = (issues: readonly GameCheckIssue[]): GameCheckIssue[] =>
  issues.slice(0, MAX_ISSUES).map((issue) => ({
    file: issue.file,
    ...(issue.line === undefined ? {} : { line: issue.line }),
    message: issue.message.slice(0, 500),
  }));
