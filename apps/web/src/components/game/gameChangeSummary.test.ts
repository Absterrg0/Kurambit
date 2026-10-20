import { describe, expect, it } from "vite-plus/test";

import type { TurnDiffFileChange } from "../../types";
import { formatGameChangeSummary, gameChangeKind, groupGameChanges } from "./gameChangeSummary";

const file = (path: string, additions = 1, deletions = 0): TurnDiffFileChange => ({
  path,
  kind: "modified",
  additions,
  deletions,
});

describe("gameChangeKind", () => {
  it("maps game file extensions to what they mean in the game", () => {
    expect(gameChangeKind("godot/scenes/main.tscn")).toBe("scenes");
    expect(gameChangeKind("godot/scripts/player.gd")).toBe("scripts");
    expect(gameChangeKind("art/scripts/island.py")).toBe("scripts");
    expect(gameChangeKind("godot/assets/models/rock.glb")).toBe("models");
    expect(gameChangeKind("art/blender/rock.blend")).toBe("models");
    expect(gameChangeKind("godot/assets/audio/pickup.ogg")).toBe("art");
    expect(gameChangeKind("art/previews/island.png")).toBe("art");
    expect(gameChangeKind("DESIGN.md")).toBe("design");
    expect(gameChangeKind("godot/project.godot")).toBe("other");
    expect(gameChangeKind("LICENSE")).toBe("other");
  });

  it("ignores case and treats a dotted directory name as a path, not an extension", () => {
    expect(gameChangeKind("Godot/Scenes/Main.TSCN")).toBe("scenes");
    expect(gameChangeKind("art.v2/blender/rock")).toBe("other");
  });
});

describe("groupGameChanges", () => {
  it("groups by game meaning, counts files, and keeps the story order", () => {
    const groups = groupGameChanges([
      file("DESIGN.md", 10, 2),
      file("godot/scripts/player.gd", 40, 3),
      file("godot/scenes/main.tscn", 2, 1),
      file("godot/scenes/menu.tscn", 1, 0),
      file("godot/scripts/hud.gd", 5, 0),
      file("godot/assets/models/rock.glb"),
      file("godot/project.godot", 1, 1),
    ]);

    expect(groups.map((group) => [group.kind, group.count])).toEqual([
      ["scenes", 2],
      ["scripts", 2],
      ["models", 1],
      ["design", 1],
      ["other", 1],
    ]);
    expect(groups[0]).toMatchObject({ additions: 3, deletions: 1 });
  });

  it("returns no groups for no files", () => {
    expect(groupGameChanges([])).toEqual([]);
  });
});

describe("formatGameChangeSummary", () => {
  it("reads like a sentence about the game", () => {
    expect(
      formatGameChangeSummary(
        groupGameChanges([
          file("godot/scenes/main.tscn"),
          file("godot/scenes/menu.tscn"),
          file("godot/scripts/player.gd"),
          file("godot/scripts/hud.gd"),
          file("godot/scripts/input.gd"),
          file("godot/assets/models/rock.glb"),
        ]),
      ),
    ).toBe("Changed 2 scenes · 3 scripts · 1 model");
  });

  it("pluralizes every group it can and skips groups with no files", () => {
    expect(formatGameChangeSummary([])).toBe("No changes");
    expect(
      formatGameChangeSummary(groupGameChanges([file("art/previews/rock.png"), file("notes.txt")])),
    ).toBe("Changed 1 art · 1 doc");
  });
});
