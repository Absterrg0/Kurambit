import { expect, it } from "vite-plus/test";

import { builderFixPrompt, criticPrompt, pairwisePrompt } from "./gameReviewPrompts.ts";
import { parseBallotAnswer } from "./GameReviewSessions.ts";
import { GameReviewBallotInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const files = [{ path: "frames/frame-01.png", label: "f1: A: boot" }];
const decodeBallotInput = Schema.decodeUnknownSync(GameReviewBallotInput, {
  onExcessProperty: "error",
});

it("the ballot prompt example is valid for both the tool and terminal answer", () => {
  const prompt = pairwisePrompt({ files, items: [] });
  const raw = prompt.split("\n").find((line) => line.startsWith('{"overall"'))!;
  expect(decodeBallotInput(JSON.parse(raw))).toBeDefined();
  expect(
    parseBallotAnswer(raw, {
      frameIds: new Set(["f1", "f2"]),
      itemIds: ["item-id"],
      defectIds: ["defect-1"],
    }).kind,
  ).toBe("valid");
});

it("the ballot is told the control pair is one capture under C and D", () => {
  const prompt = pairwisePrompt({ files, items: [] });
  expect(prompt).toContain("C and D are the same captured frames shown twice");
  expect(prompt).toContain("answer them C, D or tie");
});

it("the critic with approved requirements must report unmet promises as defects", () => {
  const plain = criticPrompt(files);
  expect(plain).not.toContain("DESIGN_REQUIREMENTS");
  const designed = criticPrompt(files, { hasDesignRequirements: true });
  expect(designed).toContain("DESIGN_REQUIREMENTS lists the approved acceptance promises");
  expect(designed).toContain("report an unmet one as a defect with frames");
  expect(designed).toContain("never as met");
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

it("the ballot weighs design tradeoffs only when requirements exist", () => {
  const plain = pairwisePrompt({ files, items: [] });
  expect(plain).toContain("Weigh the brief's tradeoffs;");
  expect(plain).not.toContain("DESIGN_REQUIREMENTS");
  const designed = pairwisePrompt({ files, items: [], hasDesignRequirements: true });
  expect(designed).toContain("Weigh the brief and DESIGN_REQUIREMENTS tradeoffs;");
});

it("the repair prompt carries bounded design promises only when approved", () => {
  const legacy = builderFixPrompt({
    remainingBudget: "2 repairs and 20 minutes left",
    brief: "A dialogue game about a night radio shift.",
    defects: [],
    doNotRegress: [],
  });
  expect(legacy).not.toContain("DESIGN (approved acceptance;");
  const designed = builderFixPrompt({
    remainingBudget: "2 repairs and 20 minutes left",
    brief: "A dialogue game about a night radio shift.",
    defects: [],
    doNotRegress: [],
    designRequirements:
      "Approved acceptance promises (judge observable ones from frames; use game_try_input when unsure):\n- [presentation] warm-glow: Lit lanterns cast a warm glow\n",
  });
  expect(designed).toContain("DESIGN (approved acceptance;");
  expect(designed).toContain("warm-glow");
  expect(designed.indexOf("DESIGN (approved acceptance;")).toBeGreaterThan(
    designed.indexOf("BRIEF:"),
  );
  expect(designed.indexOf("DEFECTS:")).toBeGreaterThan(
    designed.indexOf("DESIGN (approved acceptance;"),
  );
});

it("reviewers are told to crop small effects instead of guessing from the wide view", () => {
  const critic = criticPrompt(files);
  expect(critic).toContain("game_review_detail");
  expect(critic).toContain("cite the original frame");
  const ballot = pairwisePrompt({ files, items: [] });
  expect(ballot).toContain("game_review_detail");
  expect(ballot).toContain("cite the card's frame");
});

it("the repair prompt carries the previous rejection and its concrete failed check", () => {
  const prompt = builderFixPrompt({
    remainingBudget: "2 repairs and 20 minutes left",
    brief: "A dialogue game about a night radio shift.",
    defects: [],
    doNotRegress: [],
    previousRejection:
      "mechanical-veto: check-failed: playtest passed on the incumbent and fails on the challenger.\nfailed check playtest: The playtest did not qualify.",
  });
  expect(prompt).toContain("PREVIOUS ATTEMPT (rejected; do not repeat):");
  expect(prompt).toContain("failed check playtest: The playtest did not qualify.");
});

it("the critic is told a matched transition is minimum evidence, not proof of the trigger", () => {
  const plain = criticPrompt(files);
  expect(plain).not.toContain("minimum evidence only");
  const designed = criticPrompt(files, { hasDesignRequirements: true });
  expect(designed).toContain("matched before/after transition is minimum evidence only");
  expect(designed).toContain("must actually show the named condition/effect");
  expect(designed).toContain("finished state never proves its trigger");
  expect(designed).toContain("use cannot-tell when unavailable");
});

it("the critic treats native layout hints as leads, never as Web proof", () => {
  const prompt = criticPrompt(files);
  expect(prompt).toContain("NATIVE_DIAGNOSTICS.md");
  expect(prompt).toContain("never cite it as proof of a Web defect");
});

it("the critic compares world positions with target bounds without claiming proof of yes", () => {
  const prompt = criticPrompt(files);
  expect(prompt).toContain("NATIVE_WORLD.json");
  expect(prompt).toContain("never cite as proof");
  expect(prompt).toContain("compare the player position with the target bounds");
  expect(prompt).toContain("cannot be yes");
  expect(prompt).toContain("otherwise cannot-tell");
});

it("the designed critic is told to make one focused play attempt for a booted cannot-tell", () => {
  const plain = criticPrompt(files);
  expect(plain).not.toContain("one focused game_try_input attempt");
  const designed = criticPrompt(files, { hasDesignRequirements: true });
  expect(designed).toContain("one focused game_try_input attempt");
  expect(designed).toContain("use setupSteps to reach the later question");
  expect(designed).toContain("report what you actually observed");
  expect(designed).toContain("keep cannot-tell when the attempt cannot show the claim");
});

it("the designed critic is told a frozen win/lose yes needs measured scalars plus a counterexample", () => {
  const plain = criticPrompt(files);
  expect(plain).not.toContain("separate ordinary-play counterexample");
  const designed = criticPrompt(files, { hasDesignRequirements: true });
  expect(designed).toContain("recorded after scalar to satisfy the approved key/expect");
  expect(designed).toContain("non-terminal before");
  expect(designed).toContain("separate ordinary-play counterexample experiment");
  expect(designed).toContain("missing values mean cannot-tell");
});
