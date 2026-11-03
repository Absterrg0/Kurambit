import type { GameCheckIssue } from "@kurambit/contracts";

const CSHARP_DIAGNOSTIC =
  /(?:^|[\s"])((?:Assets|Packages)\/[^\s("]+\.cs)\((\d+),\d+\):\s*(error|warning)\s+(CS\d{4}):\s*(.+)$/;

/**
 * C# compiler lines as Unity prints them in its log and in the CLI's
 * recompile report: `Assets/Scripts/Foo.cs(12,5): error CS1002: ; expected`.
 * Paths are made game-relative under the engine directory.
 */
export const parseCSharpDiagnostics = (
  text: string,
  projectName: string,
): { readonly errors: GameCheckIssue[]; readonly warnings: GameCheckIssue[] } => {
  const errors: GameCheckIssue[] = [];
  const warnings: GameCheckIssue[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const match = CSHARP_DIAGNOSTIC.exec(line.trim());
    if (match === null) continue;
    const [, file = "", lineNumber = "0", level, code, message = ""] = match;
    const key = `${file}:${lineNumber}:${code}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const issue = {
      file: `${projectName}/${file}`,
      line: Number(lineNumber),
      // A line quoted inside the CLI's JSON report ends with `",`.
      message: `${code}: ${message.trim().replace(/",?$/, "")}`.slice(0, 500),
    };
    (level === "error" ? errors : warnings).push(issue);
  }
  return { errors: errors.slice(0, 100), warnings: warnings.slice(0, 100) };
};

/**
 * Runtime console entries from the Pipeline `console get` result: an
 * exception or error with the first project frame of its stack as file:line.
 */
export const consoleIssues = (data: unknown, projectName: string): GameCheckIssue[] => {
  const entries: unknown[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record["message"] === "string" || typeof record["condition"] === "string") {
      entries.push(record);
      return;
    }
    for (const item of Object.values(record)) visit(item, depth + 1);
  };
  visit(data, 0);
  const issues: GameCheckIssue[] = [];
  for (const entry of entries) {
    const record = entry as Record<string, unknown>;
    const message = String(record["message"] ?? record["condition"] ?? "").trim();
    if (message === "") continue;
    const stack = String(record["stackTrace"] ?? record["stack"] ?? record["stacktrace"] ?? "");
    const frame = /\(at ((?:Assets|Packages)\/[^:()]+):(\d+)\)/.exec(`${message}\n${stack}`);
    issues.push({
      file: frame?.[1] === undefined ? projectName : `${projectName}/${frame[1]}`,
      ...(frame?.[2] === undefined ? {} : { line: Number(frame[2]) }),
      message: message.split("\n")[0]!.slice(0, 500),
    });
  }
  return issues.slice(0, 50);
};
