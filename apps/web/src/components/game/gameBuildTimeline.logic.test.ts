import { describe, expect, it } from "vite-plus/test";

import { BUILD_B, BUILD_C, FAKE_BUILDS_RESULT } from "./gameBuilds.fixtures";
import { markTone, stageBuildId, stepMark } from "./gameBuildTimeline.logic";

const build = (list: typeof FAKE_BUILDS_RESULT, id: string) => {
  const found = list.builds.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no build ${id}`);
  return found;
};

describe("the build timeline", () => {
  it("tones a mark from what the list already says", () => {
    // One bad fact marks the build, whatever else is good.
    expect(markTone(build(FAKE_BUILDS_RESULT, BUILD_B))).toBe("bad");
    expect(markTone(build(FAKE_BUILDS_RESULT, BUILD_C))).toBe("neutral");
  });

  it("steps through marks oldest to newest, then to live", () => {
    const order = ["a", "b", "c"];
    // From the default (the newest build) one back, and one on to live.
    expect(stepMark(order, null, -1)).toBe("b");
    expect(stepMark(order, null, 1)).toBe("now");
    expect(stepMark(order, "now", -1)).toBe("c");
    expect(stepMark(order, "a", -1)).toBe("a");
    expect(stepMark(order, "b", 1)).toBe("c");
    expect(stepMark([], null, -1)).toBe("now");
  });

  // The strip's ring and the Inspector's "on the Stage" read this one answer.
  it("says what the Stage shows: a copy, the folder's build, or Now", () => {
    const list = { current: BUILD_C, folderEdited: false };
    expect(stageBuildId(list, BUILD_B)).toBe(BUILD_B);
    expect(stageBuildId(list, null)).toBe(BUILD_C);
    expect(stageBuildId({ ...list, folderEdited: true }, null)).toBeNull();
    expect(stageBuildId({ ...list, folderEdited: true }, BUILD_B)).toBe(BUILD_B);
  });
});
