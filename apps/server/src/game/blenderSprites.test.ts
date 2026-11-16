import { describe, expect, it } from "@effect/vitest";
import { spriteOutputIssue } from "./blenderSprites.ts";

describe("spriteOutputIssue", () => {
  it("keeps sprites under the game's engine folder", () => {
    expect(spriteOutputIssue("three", "web", "web/assets/sprites/hero_walk")).toBeNull();
    expect(spriteOutputIssue("three", "web", "assets/hero")).toContain("under web/");
    expect(spriteOutputIssue("three", "web", "web/../escape")).not.toBeNull();
  });
});
