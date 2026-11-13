import type { ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

import { useRightPanelStore } from "../../rightPanelStore";

/**
 * A game's inspectors are tabs of T3's right panel: Tune (live values), Look (its style) and Build
 * (a build's checks, changes and recordings). The game, its chat and its builds stay in the column.
 */
type GameTab = "tune" | "look" | "build";

const shownTab = (ref: ScopedThreadRef) => {
  const state = useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)];
  return state?.isOpen === true ? state.activeSurfaceId : null;
};

export const showGameTab = (ref: ScopedThreadRef, tab: GameTab) =>
  useRightPanelStore.getState().open(ref, tab);

/** The tab, or the panel closed when that tab is what it shows. */
export const toggleGameTab = (ref: ScopedThreadRef, tab: GameTab) => {
  if (shownTab(ref) === tab) useRightPanelStore.getState().close(ref);
  else showGameTab(ref, tab);
};

export const useGameTabShown = (ref: ScopedThreadRef, tab: GameTab) =>
  useRightPanelStore((state) => {
    const thread = state.byThreadKey[scopedThreadKey(ref)];
    return thread?.isOpen === true && thread.activeSurfaceId === tab;
  });
