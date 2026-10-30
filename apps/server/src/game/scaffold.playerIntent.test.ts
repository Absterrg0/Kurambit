import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { GameCreateInput } from "@t3tools/contracts";

import { designSkeleton, initialGamePrompt, scaffoldFiles } from "./scaffold.ts";

const decodeCreateInput = Schema.decodeSync(GameCreateInput);

const inputFor = (brief: string, planFirst: boolean) =>
  planFirst
    ? decodeCreateInput({
        name: "Intent Probe",
        parentDirectory: "/tmp/games",
        brief,
        modelSelection: { instanceId: "test", model: "test-model" },
      })
    : decodeCreateInput({
        name: "Intent Probe",
        parentDirectory: "/tmp/games",
        brief,
        planFirst: false,
        modelSelection: { instanceId: "test", model: "test-model" },
      });

const words = (text: string): number => text.split(/\s+/).filter((word) => word.length > 0).length;

const brief =
  "Make a small rooftop platformer where jumping forgives me when I press slightly early or late. Keep the character easy to control. No double jump and no automatic jumping.";

it("keeps the generated AGENTS.md within its word budget on every starter", () => {
  for (const template of ["2d-platformer", "3d-explorer", "2d-screen", "blank"] as const) {
    for (const planFirst of [true, false] as const) {
      const input = decodeCreateInput({
        name: "Intent Probe",
        parentDirectory: "/tmp/games",
        brief,
        template,
        modelSelection: { instanceId: "test", model: "test-model" },
        ...(planFirst ? {} : { planFirst: false }),
      });
      const agents = scaffoldFiles(input)["AGENTS.md"]!;
      expect(words(agents), `${template} planFirst:${planFirst}`).toBeLessThanOrEqual(350);
    }
  }
});

it("adds no new design headings or approval gates", () => {
  const skeleton = designSkeleton("Intent Probe");
  const headings = skeleton
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
  expect(headings).toEqual([
    "Pitch",
    "Core loop",
    "Controls",
    "Win & lose",
    "Content",
    "Acceptance",
    "Art direction",
    "Audio",
    "Scope",
    "Milestones",
  ]);
  expect(skeleton).not.toContain("## Build plan");
  expect(skeleton).not.toContain("approval");
});

it("reasons from the player experience and demands negative controls", () => {
  const skeleton = designSkeleton("Intent Probe");
  const flat = skeleton.replace(/\s+/g, " ");
  expect(flat).toContain("Reason from the requested feeling to as many fitting choices");
  expect(flat).not.toContain("at most one or two");
  expect(flat).not.toContain("zero new subsystems is valid");
  expect(flat).toContain("the wording and exclusions are ground truth");
  expect(flat).toContain("selected fits may become acceptance promises");
  expect(flat).toContain("retrieved ideas stay optional");
  expect(flat).toContain("A new named counter alone is not physical proof");
  expect(flat).toContain("expired-window negative");
  expect(flat).toContain("suggestions never add systems");
  // The frozen acceptance commitments survive the edit.
  expect(flat).toContain('`lose` criterion with `"noLoseState": true` and no observe');
  expect(flat).toContain("Never invent an ending the game does not have");
});

it("keeps the brief verbatim and bounds suggestions on both planning paths", () => {
  const reviewed = initialGamePrompt(inputFor(brief, true));
  expect(reviewed).toContain(brief);
  expect(reviewed).toContain("Recipe suggestions are proposals, never extra requirements");
  expect(reviewed).toContain("as many fitting choices as the brief needs");
  expect(reviewed).not.toContain("zero new subsystems is valid");
  expect(reviewed).toContain("selected fits may become explicit acceptance promises");
  expect(reviewed).toContain("retrieved ideas stay optional");

  const direct = initialGamePrompt(inputFor(brief, false));
  expect(direct).toContain(brief);
  expect(direct).toContain("propose techniques as hypotheses never as extra requirements");
  expect(direct).toContain("expired-window");
  expect(direct).toContain("as many fitting choices as the brief needs");
  expect(direct).not.toContain("zero new subsystems is valid");
});

it("leaves recipe count to the brief and adapts verification fixtures in generated AGENTS.md", () => {
  const agents = scaffoldFiles(inputFor(brief, true))["AGENTS.md"]!;
  const flat = agents.replace(/\s+/g, " ");
  expect(flat).toContain("Use as many recipes as the brief needs, or none");
  expect(flat).not.toContain("At most one or two fitting choices");
  expect(flat).not.toContain("zero new subsystems is valid");
  expect(flat).toContain("Passing game_verify means the game works, not that it is good");
  expect(flat).toContain("End when the budget expires or the brief is realised.");
  expect(flat).toContain("promote only selected fits to acceptance");
  expect(flat).toContain("adapt harness and routes to DESIGN.md keeping meaningful coverage");
  expect(flat).not.toContain("Suggestions never add requirements");
});
