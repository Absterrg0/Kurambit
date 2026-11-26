import type { GameBuildId } from "@kurambit/contracts";

import type { TurnBuildView } from "../../state/gameTurnBuild";

/**
 * PURE. Whether the folder holds this build, so Play shows the Stage's own
 * game instead of a copy and Go back is not offered. Only a known edit since
 * makes it another game: going back to the folder's own build restores nothing,
 * and its "already there" record would take the undo's Redo away.
 */
export const turnBuildIsFolder = (view: TurnBuildView): boolean =>
  view.current === view.build.id && view.folderEdited !== true;

/**
 * What a turn's strip offers for the folder: Undo on the game's latest
 * turn build restores the build it was made from; after that, Redo restores
 * the folder from before the undo; an older turn goes back to its own build.
 * A build whose change was undone alone offers Redo, as that undo does while it is the latest.
 */
export interface TurnStripRestore {
  readonly kind: "undo" | "redo" | "go-back";
  /** The build the restore puts in the folder. */
  readonly target: GameBuildId;
  /** Why it cannot be pressed now, or null. The server decides either way. */
  readonly blocked: string | null;
  /**
   * "undo": the Redo of a change undone alone, which undoes `target`, that undo build (the
   * server's Redo, which also takes the undo out of the game's decisions). Absent: a restore.
   */
  readonly via?: "undo";
}

/**
 * PURE. The one restore a turn's strip offers, or null. Each is exactly one
 * build the server already names, never one the client guesses: a turn with
 * no known base has no Undo, and Redo shows only while the latest restore is
 * that undo and the list still has the folder from before it.
 */
export const turnStripRestore = (
  view: TurnBuildView,
  turnRunning: boolean,
): TurnStripRestore | null => {
  const { build, restore } = view;
  const blocked = (what: string) =>
    build.noRestore ?? (turnRunning ? `Wait for the agent's turn to end to ${what}.` : null);
  if (view.redo !== null)
    return { kind: "redo", target: view.redo.undo, blocked: blocked("redo"), via: "undo" };
  if (view.latest) {
    if (build.base === null) return null;
    if (
      restore !== null &&
      restore.target === build.base &&
      restore.outcome?.restored === true &&
      restore.undo !== null &&
      // A build made since (tuning kept after an undo) moved the folder on: its undo is Undo.
      (view.current === null || view.current === restore.target)
    )
      return { kind: "redo", target: restore.undo, blocked: blocked("redo") };
    return { kind: "undo", target: build.base, blocked: blocked("undo") };
  }
  // The folder already is this build: going back to it changes nothing.
  if (!build.available || turnBuildIsFolder(view)) return null;
  return { kind: "go-back", target: build.id, blocked: blocked("go back") };
};
