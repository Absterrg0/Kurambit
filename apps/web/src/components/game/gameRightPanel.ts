import type { ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

import { useGameWorkspaceStore, type WorkbenchTab } from "../../gameWorkspaceStore";
import { useRightPanelStore } from "../../rightPanelStore";

/**
 * A game's Workbench is one tab of T3's right panel, with tabs of its own (Run, Tune, Checks,
 * History, Decisions). The game, its chat and its controls stay in the column.
 */
const workbenchShown = (ref: ScopedThreadRef) => {
  const state = useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)];
  return state?.isOpen === true && state.activeSurfaceId === "workbench";
};

/** Opens the Workbench, on `tab` when given, else the tab it last showed. */
export const showWorkbench = (ref: ScopedThreadRef, tab?: WorkbenchTab) => {
  if (tab !== undefined) useGameWorkspaceStore.getState().setWorkbenchTab(tab);
  useRightPanelStore.getState().open(ref, "workbench");
};

/** The Workbench, or the panel closed when the Workbench is what it shows. */
export const toggleWorkbench = (ref: ScopedThreadRef) => {
  if (workbenchShown(ref)) useRightPanelStore.getState().close(ref);
  else showWorkbench(ref);
};

export const useWorkbenchShown = (ref: ScopedThreadRef) =>
  useRightPanelStore((state) => {
    const thread = state.byThreadKey[scopedThreadKey(ref)];
    return thread?.isOpen === true && thread.activeSurfaceId === "workbench";
  });
