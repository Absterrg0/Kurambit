import { describe, expect, it } from "@effect/vitest";
import { mergeCheckIssues, parseGodotIssues, limitIssues } from "./godotCheckOutput.ts";

describe("parseGodotIssues", () => {
  it("pairs a parse error with the Godot file and line", () => {
    const output = [
      '\u001b[91mSCRIPT ERROR: Parse Error: Identifier "this" not declared in the current scope.\u001b[0m',
      "          at: GDScript::reload (res://scripts/broken.gd:4)",
      "          GDScript backtrace (most recent call first):",
      "              [0] _collect_files (/home/user/check.gd:39)",
    ].join("\n");
    expect(parseGodotIssues(output)).toEqual([
      {
        file: "res://scripts/broken.gd",
        line: 4,
        message: 'Parse Error: Identifier "this" not declared in the current scope.',
      },
    ]);
  });

  it("keeps a script load failure's quoted path even without a source line", () => {
    const output = [
      'ERROR: Failed to load script "res://scripts/broken.gd" with error "Parse error".',
      "   at: load (modules/gdscript/gdscript_resource_format.cpp:46)",
    ].join("\n");
    expect(parseGodotIssues(output)).toEqual([
      {
        file: "res://scripts/broken.gd",
        message: 'Failed to load script "res://scripts/broken.gd" with error "Parse error".',
      },
    ]);
  });

  it("reports push_error without inventing a file and ignores engine cleanup noise", () => {
    const output = [
      "USER ERROR: The player has no camera",
      "   at: push_error (core/variant/variant_utility.cpp:1155)",
      "WARNING: 4 ObjectDB instances were leaked at exit",
      "ERROR: ObjectDB instances leaked",
    ].join("\n");
    expect(parseGodotIssues(output)).toEqual([{ file: "", message: "The player has no camera" }]);
  });

  it("deduplicates repeated errors and bounds the list", () => {
    const repeated = Array.from({ length: 150 }, (_, index) => [
      `SCRIPT ERROR: Parse Error: failure ${index % 3}`,
      "          at: GDScript::reload (res://scripts/broken.gd:3)",
    ]).join("\n");
    const issues = parseGodotIssues(repeated);
    expect(issues).toHaveLength(3);
  });
});

describe("mergeCheckIssues", () => {
  it("prefers the located error and drops the checker's locationless duplicate", () => {
    expect(
      mergeCheckIssues(
        [
          { file: "res://scripts/broken.gd", message: "Script does not compile." },
          { file: "res://scripts/other.gd", message: "Failed to load script." },
        ],
        [
          {
            file: "res://scripts/broken.gd",
            line: 4,
            message: "Parse Error: Identifier not found.",
          },
        ],
      ),
    ).toEqual([
      { file: "res://scripts/broken.gd", line: 4, message: "Parse Error: Identifier not found." },
      { file: "res://scripts/other.gd", message: "Failed to load script." },
    ]);
  });
});

describe("limitIssues", () => {
  it("caps message length", () => {
    const [issue] = limitIssues([{ file: "res://a.gd", message: "x".repeat(700) }]);
    expect(issue?.message).toHaveLength(500);
  });
});
