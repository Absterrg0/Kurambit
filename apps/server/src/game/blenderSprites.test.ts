import { describe, expect, it } from "@effect/vitest";
import { spriteOutputIssue } from "./blenderSprites.ts";

describe("spriteOutputIssue", () => {
  it("keeps Unity sprites under Assets/, the only folder Unity imports", () => {
    expect(spriteOutputIssue("unity", "unity", "unity/Assets/Art/Sprites/hero_walk")).toBeNull();
    const miscased = spriteOutputIssue("unity", "unity", "unity/assets/sprites/hero_walk");
    expect(miscased).toContain("use unity/Assets/sprites/hero_walk");
    expect(spriteOutputIssue("unity", "unity", "unity/Library/hero")).toContain("nothing outside");
    expect(spriteOutputIssue("unity", "unity", "unity/Temp/hero")).not.toBeNull();
  });

  it("keeps the other lanes under their engine folder", () => {
    expect(spriteOutputIssue("godot", "godot", "godot/assets/sprites/hero_walk")).toBeNull();
    expect(spriteOutputIssue("three", "web", "web/assets/sprites/hero_walk")).toBeNull();
    expect(spriteOutputIssue("godot", "godot", "web/assets/hero")).toContain("under godot/");
    expect(spriteOutputIssue("godot", "godot", "godot/../escape")).not.toBeNull();
  });
});
