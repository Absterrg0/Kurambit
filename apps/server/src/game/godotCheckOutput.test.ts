// Evidence honesty: Godot's one error reading, shared by import, export and
// the check. Exit chatter is not the game's failure; an engine error is.
import { describe, expect, it } from "@effect/vitest";
import { parseGodotIssues } from "./godotCheckOutput.ts";

describe("parseGodotIssues", () => {
  it("reads exit chatter as clean", () => {
    expect(
      parseGodotIssues(
        [
          "WARNING: ObjectDB instances leaked at exit (run with --verbose for details).",
          "ERROR: 1 resources still in use at exit (run with --verbose for details).",
          "ERROR: 3 RID allocations of type 'P12GodotBody3D' were leaked at exit.",
          "Printed by the game: my ERROR: counter is 0",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
  it("reads an engine error with its location", () => {
    expect(
      parseGodotIssues(
        [
          "SCRIPT ERROR: Invalid call. Nonexistent function 'jump'.",
          "   at: _ready (res://player.gd:12)",
        ].join("\n"),
      ),
    ).toEqual([
      { file: "res://player.gd", line: 12, message: "Invalid call. Nonexistent function 'jump'." },
    ]);
  });
});
