// The Workbench's changelog says tuned values as "jump 9 → 12" from git's patch of the tune file:
// it must name the right thing and never report a value that did not change.
import { describe, expect, it } from "@effect/vitest";

import { tuneChanges } from "./gameTune.ts";

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
