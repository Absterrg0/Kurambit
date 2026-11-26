import { describe, expect, it } from "vite-plus/test";
import { GameBuildId, type GameBuild, type GameBuildsResult } from "@kurambit/contracts";

import { selectTurnBuild, type TurnBuildView } from "../../state/gameTurnBuild";
import {
  BUILD_B,
  BUILD_C,
  BUILD_D,
  BUILD_E,
  FAKE_BUILDS_RESULT,
  FAKE_UNDONE_RESULT,
} from "./gameBuilds.fixtures";
import { turnBuildIsFolder, turnStripRestore } from "./gameTurnBuild.logic";

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
    // Not known to be edited: still the folder's build, so no restore that changes nothing.
    const unknown = { ...FAKE_UNDONE_RESULT, folderEdited: "unknown" as const };
    expect(turnStripRestore(view(unknown, TURN_4), false)).toBeNull();
    expect(turnBuildIsFolder(view(unknown, TURN_4))).toBe(true);
    expect(turnBuildIsFolder(view(edited, TURN_4))).toBe(false);
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

// History's Undo on one build lands as a build of its own; undoing that undo is its Redo.
describe("a build undone alone", () => {
  const UNDO = GameBuildId.make("1".repeat(40));
  const REDO = GameBuildId.make("2".repeat(40));
  const AGAIN = GameBuildId.make("3".repeat(40));
  const undoOf = (id: GameBuildId, undid: GameBuildId, number: number): GameBuild => ({
    ...FAKE_BUILDS_RESULT.builds[0]!,
    id,
    number,
    name: `Build ${number}`,
    source: { _tag: "saved", label: "Undid", edit: "undo" },
    undid,
    base: null,
  });
  const after = (...undos: ReadonlyArray<GameBuild>): GameBuildsResult => ({
    ...FAKE_BUILDS_RESULT,
    builds: [...undos, ...FAKE_BUILDS_RESULT.builds],
    current: undos[0]!.id,
  });
  const undone = after(undoOf(UNDO, BUILD_C, 6));
  const TURN_5_NAME = FAKE_BUILDS_RESULT.builds[0]!.name;

  it("offers Redo on the undone turn and on the undo while it is the latest, both undoing the undo", () => {
    const redo = { kind: "redo", target: UNDO, blocked: null, via: "undo" };
    expect(turnStripRestore(view(undone, TURN_5), false)).toEqual(redo);
    expect(view(undone, TURN_5).redo).toEqual({ undo: UNDO, name: TURN_5_NAME });
    expect(turnStripRestore(view(undone, null), false)).toEqual(redo);
    // The latest's Redo names the build it brings back, not the undo.
    expect(view(undone, null).redo?.name).toBe(TURN_5_NAME);
  });

  it("is no longer undone once its undo was undone, and is again when that Redo is undone", () => {
    const redone = after(undoOf(REDO, UNDO, 7), undoOf(UNDO, BUILD_C, 6));
    expect(view(redone, TURN_5).redo).toBeNull();
    // The Redo is the latest: its own Undo is a plain one, not another Redo.
    expect(view(redone, null).redo).toBeNull();
    expect(turnStripRestore(view(redone, TURN_5), false)?.kind).not.toBe("redo");
    const again = after(undoOf(AGAIN, REDO, 8), undoOf(REDO, UNDO, 7), undoOf(UNDO, BUILD_C, 6));
    expect(view(again, TURN_5).redo).toEqual({ undo: UNDO, name: TURN_5_NAME });
  });
});
