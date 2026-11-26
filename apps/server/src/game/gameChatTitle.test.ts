import { assert, describe, it } from "@effect/vitest";
import { FIRST_TURN_LEADS } from "@kurambit/shared/gameFirstTurn";

import { nameInBrief, titleFromFirstMessage } from "./gameChatTitle.ts";

const gameNames = ["Stillwater", "Can You Please"];
const from = (title: string, firstMessage: string | null) =>
  titleFromFirstMessage({ title, gameNames, firstMessage });

describe("titleFromFirstMessage", () => {
  it("titles a chat named after its game from the brief, without the harness's lead", () => {
    assert.strictEqual(
      from(
        "Can You Please",
        `Can you please create a really cozy looking fish simulator. Make it chill.\n\n${FIRST_TURN_LEADS.steps}\n\n## The first turn\n\nGoal: …`,
      ),
      "Can you please create a really cozy looking fish s...",
    );
  });

  it("reads a context chip as its label and takes the first line the person wrote", () => {
    assert.strictEqual(
      from(
        " Stillwater ",
        "\n  Make [Fisher](kurambit-context://v1/preview-annotation/preview-annotation_art-asset-thing-Fisher-f8fda6a08e9a7dcb)   taller\nand add a hat",
      ),
      "Make Fisher taller",
    );
  });

  it("keeps a title the person or the model gave, and a chat nobody wrote in", () => {
    assert.isNull(from("Longer dusk", "Slow the sun"));
    assert.isNull(from("Stillwater", null));
  });

  it("does not run again on its own result, nor when the message says only the game's name", () => {
    assert.strictEqual(from("Stillwater", "Slow the sun"), "Slow the sun");
    assert.isNull(from("Slow the sun", "Slow the sun"));
    assert.isNull(from("Stillwater", "Stillwater\n\n"));
  });
});

describe("nameInBrief", () => {
  it("reads the name a brief gives its game, and no other", () => {
    assert.strictEqual(
      nameInBrief("A calm 3D puzzle game called Prism Isles (light-beam puzzle) where you…"),
      "Prism Isles",
    );
    assert.strictEqual(nameInBrief("A twin-stick game called Hive Breaker, bees."), "Hive Breaker");
    assert.strictEqual(
      nameInBrief('It\'s called "the long dark of Ys". Make it.'),
      "the long dark of Ys",
    );
    assert.strictEqual(nameInBrief("A game named Tower of the Moon."), "Tower of the Moon");
    assert.strictEqual(nameInBrief("A platformer where a fox called Rusty runs."), null);
    assert.strictEqual(nameInBrief("A cozy fishing game on a lake."), null);
  });
});
