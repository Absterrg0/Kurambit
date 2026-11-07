import { expect, it } from "@effect/vitest";
import { KEEP_GOING_SECTION, STAGE_ERA_HEADING, withEveryTurn, withKeepGoing } from "./scaffold.ts";

// An AGENTS.md as a three.js game made before the turn loop has it.
const STAGE_ERA = `${STAGE_ERA_HEADING}\n\nA production run may be working on this game; game_run_status says whether one is live.\n`;
const OLD = `# Kurambit project\n\nBuild BRIEF.md's game with three.js.\n\n${STAGE_ERA}\n## Studio skills (read the ones this turn needs)\n\nCraft advice lives in ./studio-skills.\n`;

it("adds the turn loop's section to an older three.js game once, before the run's section", () => {
  const once = withEveryTurn(OLD, "three");
  expect(once.indexOf("## Every turn")).toBeGreaterThan(0);
  expect(once.indexOf("## Every turn")).toBeLessThan(once.indexOf(STAGE_ERA_HEADING));
  expect(withEveryTurn(once, "three")).toBe(once);
});

it("replaces the production run's section with keep going's, once, keeping what follows", () => {
  const once = withKeepGoing(OLD, "three");
  expect(once).not.toContain("game_run_status");
  expect(once).toContain(KEEP_GOING_SECTION);
  expect(once.indexOf("## Studio skills")).toBeGreaterThan(once.indexOf(KEEP_GOING_SECTION));
  expect(withKeepGoing(once, "three")).toBe(once);
});

it("leaves an engine outside the turn loop without either section", () => {
  expect(withEveryTurn(OLD, "godot")).toBe(OLD);
  const godot = withKeepGoing(OLD, "godot");
  expect(godot).not.toContain(STAGE_ERA_HEADING);
  expect(godot).not.toContain("## Keep going");
  expect(godot).toContain("## Studio skills");
});
