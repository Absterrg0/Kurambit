import { expect, it } from "@effect/vitest";
import { CREATOR_SESSION_SECTION, withEveryTurn } from "./scaffold.ts";

// An AGENTS.md as a three.js game made before the turn loop has it.
const OLD = `# Kurambit project\n\nBuild BRIEF.md's game with three.js.\n\n${CREATOR_SESSION_SECTION}\n\n## Studio skills (read the ones this turn needs)\n\nCraft advice lives in ./studio-skills.\n`;

it("adds the turn loop's section to an older three.js game once, before the creator section", () => {
  const once = withEveryTurn(OLD, "three");
  expect(once.indexOf("## Every turn")).toBeGreaterThan(0);
  expect(once.indexOf("## Every turn")).toBeLessThan(once.indexOf(CREATOR_SESSION_SECTION));
  expect(once.indexOf("## Studio skills")).toBeGreaterThan(once.indexOf(CREATOR_SESSION_SECTION));
  expect(withEveryTurn(once, "three")).toBe(once);
});

it("leaves an engine outside the turn loop as it was", () => {
  expect(withEveryTurn(OLD, "godot")).toBe(OLD);
  expect(withEveryTurn(OLD, "unity")).toBe(OLD);
});
