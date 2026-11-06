// The asset, model and image facts read ASSETS.md through one reader; it must
// read every line form the library's add and the sprite render write.
import { describe, expect, it } from "@effect/vitest";
import { listedIn } from "./assetsDoc.ts";

describe("ASSETS.md", () => {
  it("reads a path, a folder's glob and a span of frames as listing each file", () => {
    const doc = [
      "- `web/assets/hero.png` — the hero",
      "- `web/assets/library/kenney-mini-dungeon/Models/GLB-format/*.glb` — CC0, Kenney",
      "- `web/assets/sprites/slime_walk_0.png … web/assets/sprites/slime_walk_7.png` — rendered",
    ].join("\n");
    const files = [
      "assets/hero.png",
      "assets/library/kenney-mini-dungeon/Models/GLB-format/chest.glb",
      "assets/library/kenney-mini-dungeon/Models/GLB-format/wall.glb",
      "assets/sprites/slime_walk_3.png",
      "assets/sprites/other.png",
    ];
    const { inList, missing } = listedIn(doc, files, "web");
    expect([...inList].sort()).toEqual(
      files.filter((f) => f !== "assets/sprites/other.png").sort(),
    );
    expect([...missing]).toEqual([]);
  });
});
