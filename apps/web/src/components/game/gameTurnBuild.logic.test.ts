import { describe, expect, it } from "vite-plus/test";

import { selectTurnBuild, type TurnBuildView } from "../../state/gameTurnBuild";
import {
  BUILD_B,
  BUILD_C,
  BUILD_D,
  BUILD_E,
  FAKE_BUILDS_RESULT,
  FAKE_UNDONE_RESULT,
} from "./gameBuilds.fixtures";
import { turnStripRestore } from "./gameTurnBuild.logic";

const TURN_4 = "run:thread:thread-main:ordinal:4";
const TURN_5 = "run:thread:thread-main:ordinal:5";

const view = (list = FAKE_BUILDS_RESULT, runId: string | null = TURN_5): TurnBuildView => {
  const selected = selectTurnBuild(list, runId);
  if (selected === null) throw new Error(`no turn build for ${runId}`);
  return selected;
};

// A wrong target puts the wrong build over the person's folder.
describe("a turn's strip", () => {
  it("finds a turn's build by the run that made it, and the game's latest turn", () => {
    expect(view(FAKE_BUILDS_RESULT, TURN_4).build.id).toBe(BUILD_D);
    expect(view(FAKE_BUILDS_RESULT, TURN_4).latest).toBe(false);
    expect(view(FAKE_BUILDS_RESULT, null).build.id).toBe(BUILD_C);
    expect(view().latest).toBe(true);
    // A turn the page does not hold keeps its plain link.
    expect(selectTurnBuild(FAKE_BUILDS_RESULT, "run:thread:thread-main:ordinal:1")).toBeNull();
    // A parked folder newer than the turn does not take Undo from it.
    expect(view(FAKE_UNDONE_RESULT, null).build.id).toBe(BUILD_C);
  });

  it("undoes the latest turn by restoring the build it was made from", () => {
    expect(turnStripRestore(view(), false)).toEqual({
      kind: "undo",
      target: BUILD_D,
      blocked: null,
    });
  });

  it("offers no Undo it cannot name exactly", () => {
    const latest = view();
    expect(turnStripRestore({ ...latest, build: { ...latest.build, base: null } }, false)).toBe(
      null,
    );
  });

  it("redoes only while the latest restore is that undo and the folder before it is kept", () => {
    expect(turnStripRestore(view(FAKE_UNDONE_RESULT), false)).toEqual({
      kind: "redo",
      target: BUILD_E,
      blocked: null,
    });
    const undone = FAKE_UNDONE_RESULT.restore;
    if (undone === null) throw new Error("the fake has a restore");
    // Anything changed since: the folder before is gone, and Undo is back.
    const changed = { ...FAKE_UNDONE_RESULT, restore: { ...undone, undo: null } };
    expect(turnStripRestore(view(changed), false)?.kind).toBe("undo");
    // Still restoring, or the restore failed: nothing was undone yet.
    const pending = { ...FAKE_UNDONE_RESULT, restore: { ...undone, outcome: null } };
    expect(turnStripRestore(view(pending), false)?.kind).toBe("undo");
    const failed = {
      ...FAKE_UNDONE_RESULT,
      restore: { ...undone, outcome: { restored: false, message: "busy" } },
    };
    expect(turnStripRestore(view(failed), false)?.kind).toBe("undo");
    // A restore of another build is not this turn's undo.
    const other = { ...FAKE_UNDONE_RESULT, restore: { ...undone, target: BUILD_B } };
    expect(turnStripRestore(view(other), false)?.kind).toBe("undo");
  });

  it("goes back to an older turn's own build, unless the folder already is it", () => {
    expect(turnStripRestore(view(FAKE_BUILDS_RESULT, TURN_4), false)).toEqual({
      kind: "go-back",
      target: BUILD_D,
      blocked: null,
    });
    expect(turnStripRestore(view(FAKE_UNDONE_RESULT, TURN_4), false)).toBeNull();
    const edited = { ...FAKE_UNDONE_RESULT, folderEdited: true as const };
    expect(turnStripRestore(view(edited, TURN_4), false)?.kind).toBe("go-back");
    const older = view(FAKE_BUILDS_RESULT, TURN_4);
    expect(turnStripRestore({ ...older, build: { ...older.build, available: false } }, false)).toBe(
      null,
    );
  });

  it("waits for the agent's turn to end and says the server's own reason first", () => {
    expect(turnStripRestore(view(), true)?.blocked).toBe(
      "Wait for the agent's turn to end to undo.",
    );
    const latest = view();
    const live = { ...latest, build: { ...latest.build, noRestore: "Stop the run first." } };
    expect(turnStripRestore(live, true)?.blocked).toBe("Stop the run first.");
  });
});
