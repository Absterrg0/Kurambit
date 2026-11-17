import { describe, expect, it } from "@effect/vitest";
import { parseMergeTreeOutput } from "./mergeTreeOutput.ts";

// Printed by git 2.43 for one base, a side that rewrote m.js, b.wav and ASSETS.md and a side
// that rewrote the same three differently (then deleted m.js instead).
const CONFLICTS =
  "4930b14546f3ba641d8103a30f57b3a5f943c835\u0000100644 7f3b95d297183eca8f6cf38ceaa253bee8c2d7cd 1\tASSETS.md\u0000100644 1ef3d196dd91daf546c21b445d385791f921a440 2\tASSETS.md\u0000100644 c9c26201fee9cfd8435e0b8886c64c03a1b2db4d 3\tASSETS.md\u0000100644 9133f79cb84542363a5b1c8f9e60f99a96fa7259 1\tb.wav\u0000100644 98db0c3ec219c5cba2070a9195d5fc5db7cba108 2\tb.wav\u0000100644 830d0aca68c739eda906c8edaf3fbd6bf89bcec7 3\tb.wav\u0000100644 de980441c3ab03a8c07dda1ad27b8a11f39deb1e 1\tm.js\u0000100644 85cb8e339c490a5a91accdd9f5040d3198e0424c 2\tm.js\u0000100644 8948000eed9762246d3afb8bdcbdb95984fe3f46 3\tm.js\u0000\u00001\u0000ASSETS.md\u0000Auto-merging\u0000Auto-merging ASSETS.md\n\u00001\u0000ASSETS.md\u0000CONFLICT (contents)\u0000CONFLICT (content): Merge conflict in ASSETS.md\n\u00001\u0000b.wav\u0000CONFLICT (binary)\u0000warning: Cannot merge binary files: b.wav (210d435e7197e86fd7ca757221cc389f4d5e08e8 vs. b718068135ee578e311910b507daca5af7a820ee)\n\u00001\u0000b.wav\u0000Auto-merging\u0000Auto-merging b.wav\n\u00001\u0000b.wav\u0000CONFLICT (contents)\u0000CONFLICT (content): Merge conflict in b.wav\n\u00001\u0000m.js\u0000Auto-merging\u0000Auto-merging m.js\n\u00001\u0000m.js\u0000CONFLICT (contents)\u0000CONFLICT (content): Merge conflict in m.js\n\u0000";
const DELETED =
  "0516ed627c65d2c8ef44ad2272e2e133c2743c9a\u0000100644 9133f79cb84542363a5b1c8f9e60f99a96fa7259 1\tb.wav\u0000100644 98db0c3ec219c5cba2070a9195d5fc5db7cba108 2\tb.wav\u0000100644 830d0aca68c739eda906c8edaf3fbd6bf89bcec7 3\tb.wav\u0000100644 de980441c3ab03a8c07dda1ad27b8a11f39deb1e 1\tm.js\u0000100644 8948000eed9762246d3afb8bdcbdb95984fe3f46 3\tm.js\u0000\u00001\u0000b.wav\u0000CONFLICT (binary)\u0000warning: Cannot merge binary files: b.wav (cc93 vs. b718)\n\u00001\u0000m.js\u0000CONFLICT (modify/delete)\u0000CONFLICT (modify/delete): m.js deleted in cc93 and modified in b718.  Version b718 of m.js left in tree.\n\u0000";

describe("parseMergeTreeOutput", () => {
  it("reads a clean merge as its tree and no conflicts", () => {
    expect(
      parseMergeTreeOutput(
        "27ade8c6f0e3a9a1b4c2d5e6f708192a3b4c5d6e\u0000\u00001\u0000web/fish.js\u0000Auto-merging\u0000Auto-merging web/fish.js\n\u0000",
      ),
    ).toEqual({ tree: "27ade8c6f0e3a9a1b4c2d5e6f708192a3b4c5d6e", conflicts: [] });
  });

  it("names each conflicted path once with its three stages, binary only where git said so", () => {
    const read = parseMergeTreeOutput(CONFLICTS);
    expect(read.tree).toBe("4930b14546f3ba641d8103a30f57b3a5f943c835");
    expect(read.conflicts.map((each) => [each.path, each.binary])).toEqual([
      ["ASSETS.md", false],
      ["b.wav", true],
      ["m.js", false],
    ]);
    expect(read.conflicts[1]).toMatchObject({
      base: { oid: "9133f79cb84542363a5b1c8f9e60f99a96fa7259" },
      ours: { oid: "98db0c3ec219c5cba2070a9195d5fc5db7cba108" },
      theirs: { mode: "100644", oid: "830d0aca68c739eda906c8edaf3fbd6bf89bcec7" },
    });
  });

  it("gives a side that deleted the file no stage", () => {
    const read = parseMergeTreeOutput(DELETED);
    expect(read.conflicts.find((each) => each.path === "m.js")).toEqual({
      path: "m.js",
      binary: false,
      base: { mode: "100644", oid: "de980441c3ab03a8c07dda1ad27b8a11f39deb1e" },
      ours: null,
      theirs: { mode: "100644", oid: "8948000eed9762246d3afb8bdcbdb95984fe3f46" },
    });
  });

  it("refuses output with no tree rather than reading it as a clean merge", () => {
    expect(() => parseMergeTreeOutput("fatal: bad revision\n")).toThrow();
  });
});
