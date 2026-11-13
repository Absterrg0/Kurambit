import type { ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

import { useRightPanelStore } from "../../rightPanelStore";

/**
 * A game's inspector, Tune and Look, is tabs of T3's right panel. Its builds, checks and chat stay
 * in the game's own column, where they are always in view.
 */
type GameTab = "tune" | "look";

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
