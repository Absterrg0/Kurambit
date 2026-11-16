import { type WorkbenchTab, useGameWorkspaceStore } from "../../gameWorkspaceStore";

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

export const toggleWorkbench = () => {
  const store = useGameWorkspaceStore.getState();
  store.setWorkbenchOpen(!store.workbenchOpen);
};

export const useWorkbenchShown = () => useGameWorkspaceStore((state) => state.workbenchOpen);
