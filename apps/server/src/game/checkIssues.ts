import type { GameCheckIssue } from "@kurambit/contracts";

const MAX_ISSUES = 100;

/**
 * An engine's own report may name a file without a line that its process
 * output locates. Prefer the located version and drop the locationless
 * duplicate it makes redundant.
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
