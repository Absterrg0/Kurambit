import { describe, expect, it } from "vite-plus/test";

import {
  BUILD_B,
  BUILD_C,
  BUILD_D,
  FAKE_BUILDS_RESULT,
  FAKE_UNDONE_RESULT,
} from "./gameBuilds.fixtures";
import { isUndone, markLabels, markTone, stepMark, timelineMarks } from "./gameBuildTimeline.logic";

const build = (list: typeof FAKE_BUILDS_RESULT, id: string) => {
  const found = list.builds.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no build ${id}`);
  return found;
};

describe("the build timeline", () => {
  // A mark that reads as undone while it is the game, or the reverse, lies about the folder.
  it("dims only what a landed restore moved the folder away from", () => {
    // After Undo of turn 5, turn 4 is back: turn 5 is undone, turn 4 and older are not.
    expect(isUndone(build(FAKE_UNDONE_RESULT, BUILD_C), FAKE_UNDONE_RESULT)).toBe(true);
    expect(isUndone(build(FAKE_UNDONE_RESULT, BUILD_D), FAKE_UNDONE_RESULT)).toBe(false);
    expect(isUndone(build(FAKE_UNDONE_RESULT, BUILD_B), FAKE_UNDONE_RESULT)).toBe(false);
    // A restore still running, or one that failed, undid nothing.
    const undone = FAKE_UNDONE_RESULT.restore;
    if (undone === null) throw new Error("the fake has a restore");
    const pending = { ...FAKE_UNDONE_RESULT, restore: { ...undone, outcome: null } };
    expect(isUndone(build(pending, BUILD_C), pending)).toBe(false);
    // Turns after an older restore are new work, not undone.
    expect(isUndone(build(FAKE_BUILDS_RESULT, BUILD_C), FAKE_BUILDS_RESULT)).toBe(false);
  });

  it("names and tones a mark from what the list already says", () => {
    // A person's turns count by their place in the rail, so turns 4 and 5 read 1 and 2
    // after step 3 and the saved build; the step keeps its own number.
    const labels = markLabels(timelineMarks(FAKE_BUILDS_RESULT.builds, FAKE_BUILDS_RESULT.current));
    expect(labels.get(BUILD_D)).toBe("1");
    expect(labels.get(BUILD_C)).toBe("2");
    expect(labels.get(BUILD_B)).toBe("3");
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
});
