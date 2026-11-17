// The Workbench's changelog says tuned values as "jump 9 → 12" from git's patch of the tune file:
// it must name the right thing and never report a value that did not change.
import { describe, expect, it } from "@effect/vitest";

import { tuneChanges, tuneFileWith } from "./gameTune.ts";

describe("tuneChanges", () => {
  it("reads a changed value under the thing the patch shows above it", () => {
    const patch = [
      "diff --git a/web/tune.json b/web/tune.json",
      "--- a/web/tune.json",
      "+++ b/web/tune.json",
      "@@ -1,8 +1,8 @@",
      " {",
      '   "Runner": {',
      '-    "speed": 7,',
      '+    "speed": 9.5,',
      '     "size": 0.8',
      "   },",
      '   "Embers": {',
      '-    "every": 0.7',
      '+    "every": 0.55',
      "   }",
      " }",
    ].join("\n");
    expect(tuneChanges(patch)).toEqual([
      { thing: "Runner", key: "speed", from: "7", to: "9.5" },
      { thing: "Embers", key: "every", from: "0.7", to: "0.55" },
    ]);
  });

  it("says a thing new to the file as set, and a line that only gained a comma as no change", () => {
    const patch = [
      "@@ -1 +1,8 @@",
      "-{}",
      "+{",
      '+  "Runner": {',
      '+    "speed": 9.5',
      "+  },",
      '+  "Embers": {',
      '-    "every": 0.55',
      '+    "every": 0.55,',
      '+    "fall": 8',
      "+  }",
      "+}",
    ].join("\n");
    expect(tuneChanges(patch)).toEqual([
      { thing: "Runner", key: "speed", from: null, to: "9.5" },
      { thing: "Embers", key: "fall", from: null, to: "8" },
    ]);
  });

  it("leaves the thing unnamed when the hunk starts below its line", () => {
    const patch = [
      "@@ -40,3 +40,3 @@",
      '     "gravity": 24,',
      '-    "jump": 9',
      '+    "jump": 12',
      "   },",
    ].join("\n");
    expect(tuneChanges(patch)).toEqual([{ thing: null, key: "jump", from: "9", to: "12" }]);
  });
});

// A name a person gives a part or a material is text in a game's own file: only a look's name keys
// take it, and taking it back leaves the file as the game had it.
describe("tuneFileWith names", () => {
  const file = "web/tune.json";
  it("keeps a look's names beside its values, and drops one taken back", () => {
    const named = tuneFileWith(file, { "look:Island › Cabin": { "2:roof/color": 1 } }, [
      {
        id: "look:Island › Cabin",
        values: [],
        names: [
          { key: "2:roof/name", name: "  Roof   tiles " },
          { key: "name", name: "Log cabin" },
        ],
      },
    ]);
    expect("file" in named && named.file).toEqual({
      "look:Island › Cabin": { "2:roof/color": 1, "2:roof/name": "Roof tiles", name: "Log cabin" },
    });
    const back = tuneFileWith(file, "file" in named ? named.file : null, [
      { id: "look:Island › Cabin", values: [], names: [{ key: "2:roof/name", name: null }] },
    ]);
    expect("file" in back && back.file).toEqual({
      "look:Island › Cabin": { "2:roof/color": 1, name: "Log cabin" },
    });
  });

  it("refuses a name outside a look, on a value's key, or a thing with nothing to keep", () => {
    const refused = (things: Parameters<typeof tuneFileWith>[2]) =>
      "refusal" in tuneFileWith(file, null, things);
    expect(refused([{ id: "Runner", values: [], names: [{ key: "name", name: "Bob" }] }])).toBe(
      true,
    );
    expect(
      refused([{ id: "look:Runner", values: [], names: [{ key: "2:roof/color", name: "Red" }] }]),
    ).toBe(true);
    expect(refused([{ id: "look:Runner", values: [] }])).toBe(true);
  });
});
