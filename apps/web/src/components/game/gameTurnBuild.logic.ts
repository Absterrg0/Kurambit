import type { GameBuildId } from "@kurambit/contracts";

import type { TurnBuildView } from "../../state/gameTurnBuild";

/** PURE. Whether the folder holds this build, so Play shows the Stage's own game instead of a copy. */
export const turnBuildIsFolder = (view: TurnBuildView): boolean =>
  view.current === view.build.id && view.folderEdited === false;

/**
 * What a turn's strip offers for the folder (B4): Undo on the game's latest
 * turn build restores the build it was made from; after that, Redo restores
 * the folder from before the undo; an older turn goes back to its own build.
 */
export interface TurnStripRestore {
  readonly kind: "undo" | "redo" | "go-back";
  /** The build the restore puts in the folder. */
  readonly target: GameBuildId;
  /** Why it cannot be pressed now, or null. The server decides either way. */
  readonly blocked: string | null;
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
  if (view.latest) {
    if (build.base === null) return null;
    if (
      restore !== null &&
      restore.target === build.base &&
      restore.outcome?.restored === true &&
      restore.undo !== null
    )
      return { kind: "redo", target: restore.undo, blocked: blocked("redo") };
    return { kind: "undo", target: build.base, blocked: blocked("undo") };
  }
  // The folder already is this build: going back to it changes nothing.
  if (!build.available || turnBuildIsFolder(view)) return null;
  return { kind: "go-back", target: build.id, blocked: blocked("go back") };
};
