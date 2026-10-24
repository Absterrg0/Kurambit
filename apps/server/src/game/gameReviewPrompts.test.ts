import { expect, it } from "vitest";

import { builderFixPrompt, criticPrompt, pairwisePrompt } from "./gameReviewPrompts.ts";

const files = [{ path: "frames/frame-01.png", label: "f1: A: boot" }];

it("the ballot is told the control pair is one capture under C and D", () => {
  const prompt = pairwisePrompt({ files, items: [] });
  expect(prompt).toContain("C and D are the same captured frames shown twice");
  expect(prompt).toContain("answer them C, D or tie");
});

it("the critic is asked to name the exact recipe behind a defect", () => {
  const prompt = criticPrompt(files);
  expect(prompt).toContain("game_recipe_search");
  expect(prompt).toContain('"recipeId":"feel.buffer"');
  expect(prompt).toContain("set that defect's recipeId to its exact id");
});

it("the repair prompt turns a cited recipe id into a fetch instruction", () => {
  const prompt = builderFixPrompt({
    remainingBudget: "2 repairs and 20 minutes left",
    brief: "A dialogue game about a night radio shift.",
    defects: [
      {
        severity: "visible",
        what: "The jump ignores a press made just before landing.",
        frameId: "f2",
        fix: "Buffer the jump input; yes/no: a press before landing still jumps.",
        recipeId: "feel.buffer",
      },
      {
        severity: "nit",
        what: "The HUD is dim against the sky.",
        frameId: "f3",
        fix: "Raise HUD contrast.",
      },
    ],
    doNotRegress: [],
  });
  expect(prompt).toContain("(recipe feel.buffer; fetch with game_recipe_get)");
  // The bare defect has no recipe sentence of its own.
  const second = prompt.split("\n").find((line) => line.includes("The HUD is dim"));
  expect(second).toBeDefined();
  expect(second).not.toContain("game_recipe_get");
});
