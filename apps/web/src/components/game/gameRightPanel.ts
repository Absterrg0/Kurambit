import type { ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

import { useRightPanelStore } from "../../rightPanelStore";

/** A game's builds and, beside the chat, the game itself are tabs of T3's right panel. */
const shownTab = (ref: ScopedThreadRef) => {
  const state = useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)];
  return state?.isOpen === true ? state.activeSurfaceId : null;
};

export const showGameBuilds = (ref: ScopedThreadRef) =>
  useRightPanelStore.getState().open(ref, "builds");

/** Builds, or the panel closed when builds are what it shows. */
export const toggleGameBuilds = (ref: ScopedThreadRef) => {
  if (shownTab(ref) === "builds") useRightPanelStore.getState().close(ref);
  else showGameBuilds(ref);
};

export const showGameInPanel = (ref: ScopedThreadRef) =>
  useRightPanelStore.getState().open(ref, "game");

export const useGameBuildsShown = (ref: ScopedThreadRef) =>
  useRightPanelStore((state) => {
    const thread = state.byThreadKey[scopedThreadKey(ref)];
    return thread?.isOpen === true && thread.activeSurfaceId === "builds";
  });

export const useGameShownInPanel = (ref: ScopedThreadRef) =>
  useRightPanelStore((state) => {
    const thread = state.byThreadKey[scopedThreadKey(ref)];
    return thread?.isOpen === true && thread.activeSurfaceId === "game";
  });
