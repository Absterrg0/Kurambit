import { useSyncExternalStore } from "react";

import { type WorkbenchTab, useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { observeResize } from "../../lib/observeResize";

/**
 * A game's Workbench is a side panel of its own beside the game's column, not a tab of T3's right
 * panel, so the right panel stays free for a diff or a file opened from it. One open state and
 * one section for every game, like the game screen's other layout preferences.
 */

/** Opens the Workbench, on `tab` when given, else the section it last showed. */
export const showWorkbench = (tab?: WorkbenchTab) => {
  const store = useGameWorkspaceStore.getState();
  if (tab !== undefined) store.setWorkbenchTab(tab);
  store.setWorkbenchOpen(true);
};

/** Opens the Workbench on `tab`, or closes it when it already shows that section: one key per section. */
export const toggleWorkbenchTab = (tab: WorkbenchTab) => {
  const store = useGameWorkspaceStore.getState();
  if (store.workbenchOpen && store.workbenchTab === tab) store.setWorkbenchOpen(false);
  else showWorkbench(tab);
};

export const toggleWorkbench = () => {
  const store = useGameWorkspaceStore.getState();
  store.setWorkbenchOpen(!store.workbenchOpen);
};

export const useWorkbenchShown = () => useGameWorkspaceStore((state) => state.workbenchOpen);

/** The game's column keeps at least this much beside two side panels while they can give way. */
const GAME_COLUMN_MIN = 480;
/** A side panel never gives way below T3's own panel minimum. */
const SIDE_PANEL_MIN = 360;

/**
 * PURE. The Workbench's and the right panel's widths on a row of `row` px when both are open: as
 * set while they fit beside the game's column, else each gives way in proportion, never below its
 * minimum, so opening a diff from Checks never crushes the game. The widths set stay stored.
 */
export const fitSidePanels = (
  row: number,
  workbench: number,
  right: number,
): { readonly workbench: number; readonly right: number } => {
  const room = row - GAME_COLUMN_MIN;
  const over = workbench + right - room;
  if (over <= 0) return { workbench, right };
  const give = (width: number) =>
    Math.max(SIDE_PANEL_MIN, Math.floor(width - (over * width) / (workbench + right)));
  return { workbench: give(workbench), right: give(right) };
};

/** The row's width as it changes; null without a row. */
export function useRowWidth(row: HTMLElement | null): number | null {
  return useSyncExternalStore(
    (changed) => (row === null ? () => {} : observeResize(row, changed)),
    () => (row === null ? null : row.clientWidth),
    () => null,
  );
}

/** Below this, a game's column is too narrow to play in beside two side panels. */
const GAME_COLUMN_ROOM = 560;

/**
 * PURE. Opening the right panel (a diff from Checks) beside the Workbench would leave the game's
 * column under the room it needs: the Workbench closes then. Reopening it closes nothing.
 */
export const diffCrowdsGame = (row: number, workbench: number, right: number) =>
  row - workbench - right < GAME_COLUMN_ROOM;
