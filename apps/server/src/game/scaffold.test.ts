import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GameCreateInput, NO_LOSE_STATE_TEXT, validateDesignDocument } from "@t3tools/contracts";

import { designSkeleton, initialGamePrompt } from "./scaffold.ts";

const createInput = Schema.decodeSync(GameCreateInput)({
  name: "Lantern Walk",
  parentDirectory: "/tmp/games",
  brief: "A calm lantern-lit walk with no way to win or lose.",
  modelSelection: { instanceId: "test", model: "test-model" },
});

const flat = (text: string) => text.replace(/\s+/g, " ");

it("teaches the supported no-lose criterion in the creation prompt and scaffold", () => {
  const prompt = initialGamePrompt(createInput);
  const skeleton = designSkeleton(createInput.name);
  const noLose = `\`lose\` criterion with the text "${NO_LOSE_STATE_TEXT}" and no observe`;
  for (const text of [prompt, skeleton]) {
    expect(flat(text)).toContain(noLose);
    expect(flat(text)).toContain("declares no lose state");
  }
  expect(flat(prompt)).toContain(
    `when the design's "Win & lose" section declares no lose state, a ${noLose}`,
  );
  expect(flat(prompt)).toContain(
    "except the declared no-lose-state criterion, which carries no observe",
  );
  expect(flat(prompt)).toContain("never invent an ending the game does not have");
  expect(flat(skeleton)).toContain(
    "Except for `presentation` claims and the declared no-lose-state criterion",
  );
  expect(flat(skeleton)).toContain(
    `{ "id": "no-lose", "kind": "lose", "text": "${NO_LOSE_STATE_TEXT}" }`,
  );
  expect(flat(skeleton)).toContain("Never invent an ending the game does not have");
});

it.effect("tells every starter template the same no-lose criterion", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const noLose = `\`lose\` criterion with the text "${NO_LOSE_STATE_TEXT}" and no observe`;
    // Both starter templates are read before DESIGN.md, so neither may require
    // an observed loss from a game that has none.
    for (const template of ["2d-platformer", "3d-explorer"] as const) {
      const templateText = yield* fs.readFileString(
        path.join(import.meta.dirname, "../../templates", template, "TEMPLATE.md"),
      );
      expect(flat(templateText)).toContain(
        `a game with no lose state declares that under "Win & lose" and writes a ${noLose} instead`,
      );
      expect(flat(templateText)).not.toContain("or `lose` observes the value");
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps the blank guidance open to an approved game with no player node", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const skeleton = designSkeleton(createInput.name);
    expect(flat(skeleton)).toContain("including movement or camera only when the game has them");
    expect(flat(skeleton)).toContain("A game with no player node marks play with a typed `state`");
    const blank = yield* fs.readFileString(
      path.join(import.meta.dirname, "../../templates/blank/TEMPLATE.md"),
    );
    expect(flat(blank)).toContain(
      "A game with no player node marks play with a typed `GameState.state`",
    );
    expect(flat(blank)).not.toContain("as you add a player and run values");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("accepts a no-player, no-movement design built from the blank guidance", () => {
  const skeleton = designSkeleton(createInput.name);
  const design = skeleton
    .replace(
      /## Controls\n\n[\s\S]*?(?=\n## Win & lose)/,
      `## Controls

The player clicks one of two reply cards or presses 1 or 2. There is no movement, no camera
control and no player node.`,
    )
    .replace(
      /## Win & lose\n\n[\s\S]*?(?=\n## Content)/,
      `## Win & lose

This game has no win state and no lose state: every reply raises the counter and the prompts
repeat forever.`,
    )
    .replace(
      /```acceptance[\s\S]*?```/,
      `\`\`\`acceptance
[
  { "id": "choose-a-reply", "kind": "control", "text": "Clicking a reply card speaks that reply", "observe": { "key": "replies", "expect": ">=1" } },
  { "id": "counter-climbs", "kind": "mechanic", "text": "Every reply raises the reply counter", "observe": { "key": "replies", "expect": ">=3" } },
  { "id": "no-lose", "kind": "lose", "text": "${NO_LOSE_STATE_TEXT}" }
]
\`\`\``,
    );
  const result = validateDesignDocument({ design, skeleton });
  expect(result.issues).toEqual([]);
  expect(result.acceptance.some((criterion) => criterion.kind === "win")).toBe(false);
});

it("accepts a no-loss design built from that guidance without inventing an ending", () => {
  const skeleton = designSkeleton(createInput.name);
  const design = skeleton
    .replace(
      /## Win & lose\n\n[\s\S]*?(?=\n## Content)/,
      `## Win & lose

This game has no win state and no lose state: the player walks the lantern path and stops when they choose.`,
    )
    .replace(
      /```acceptance[\s\S]*?```/,
      `\`\`\`acceptance
[
  { "id": "walk-and-jump", "kind": "control", "text": "A and D walk and Space jumps", "observe": { "key": "jumps", "expect": ">=1" } },
  { "id": "lantern-lights", "kind": "mechanic", "text": "Touching a lantern lights it", "observe": { "key": "collected", "expect": ">=1" } },
  { "id": "light-every-lantern", "kind": "content", "text": "The player lights all five lanterns", "observe": { "key": "collected", "expect": ">=5" } },
  { "id": "no-lose", "kind": "lose", "text": "${NO_LOSE_STATE_TEXT}" },
  { "id": "lantern-glow", "kind": "presentation", "text": "Lit lanterns cast a warm glow" }
]
\`\`\``,
    );
  const result = validateDesignDocument({ design, skeleton });
  expect(result.issues).toEqual([]);
  expect(result.acceptance.filter((criterion) => criterion.kind === "lose")).toEqual([
    { id: "no-lose", kind: "lose", text: NO_LOSE_STATE_TEXT },
  ]);
  expect(result.acceptance.some((criterion) => criterion.kind === "win")).toBe(false);
});
