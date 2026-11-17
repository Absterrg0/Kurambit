// The Workbench's changelog says tuned values as "jump 9 → 12" from git's patch of the tune file:
// it must name the right thing and never report a value that did not change.
import { describe, expect, it } from "@effect/vitest";

import { mergeTuneFiles, tuneChanges, tuneFileText, tuneFileWith } from "./gameTune.ts";

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

// Spike 3.2: a copy and the game each tuned a different value; git saw one conflicting line.
describe("mergeTuneFiles", () => {
  const file = (value: unknown) => JSON.stringify(value);
  it("keeps both sides' values when each changed a different one", () => {
    expect(
      mergeTuneFiles(file({}), file({ fish: { speed: 1.2 } }), file({ day: { length: 600 } })),
    ).toEqual({
      text: tuneFileText({ fish: { speed: 1.2 }, day: { length: 600 } }),
      conflicts: [],
    });
  });

  it("is a conflict only where both changed one value differently, keeping ours", () => {
    const merged = mergeTuneFiles(
      file({ fish: { speed: 1, size: 2 } }),
      file({ fish: { speed: 1.5, size: 2 } }),
      file({ fish: { speed: 0.5, size: 3 } }),
    );
    expect(merged?.conflicts).toEqual(["fish speed"]);
    expect(JSON.parse(merged!.text!)).toEqual({ fish: { speed: 1.5, size: 3 } });
  });

  it("takes a removal from the side that made it and adds a file one side created", () => {
    expect(
      JSON.parse(
        mergeTuneFiles(
          file({ fish: { speed: 1, size: 2 } }),
          file({ fish: { speed: 1 } }),
          file({ fish: { speed: 1, size: 2 }, moon: { glow: 0.8 } }),
        )!.text!,
      ),
    ).toEqual({ fish: { speed: 1 }, moon: { glow: 0.8 } });
    expect(mergeTuneFiles(null, null, file({ a: { b: 1 } }))?.text).toBe(
      tuneFileText({ a: { b: 1 } }),
    );
  });

  it("leaves a version that is not a tune file to git", () => {
    expect(mergeTuneFiles(file({}), "<<<<<<<", file({}))).toBeNull();
  });
});
