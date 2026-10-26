import { useLayoutEffect, useState, useSyncExternalStore } from "react";

import { isGameWorkspaceCompact, useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { observeResize } from "../../lib/observeResize";
import type { GameWorkspacePane } from "./gameWorkspaceLayout";

interface CompactWorkspaceStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => boolean;
  readonly observe: (element: HTMLElement | null, enabled: boolean) => void;
  readonly stop: () => void;
}

/**
 * One hook instance's view of the workspace row. The measurement lives outside
 * React so a resize is an external-store update rather than an effect that
 * cascades a second render.
 */
function createCompactWorkspaceStore(): CompactWorkspaceStore {
  const listeners = new Set<() => void>();
  let compact = false;
  let stopObserving: (() => void) | null = null;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const measure = (width: number) => {
    if (width <= 0) return;
    // The store ignores this while compact, so a temporary narrow layout never
    // rewrites the creator's remembered dock width.
    useGameWorkspaceStore.getState().fitChatWidth(width);
    const next = isGameWorkspaceCompact(width);
    if (next === compact) return;
    compact = next;
    notify();
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => compact,
    stop: () => {
      stopObserving?.();
      stopObserving = null;
    },
    observe: (element, enabled) => {
      stopObserving?.();
      stopObserving = null;
      if (!enabled || element === null) {
        if (compact) {
          compact = false;
          notify();
        }
        return;
      }
      measure(element.clientWidth);
      stopObserving = observeResize(element, (entries) => {
        const width = entries[0]?.contentRect.width;
        if (width !== undefined) measure(width);
      });
    },
  };
}

/**
 * Tracks whether the workbench can hold the stage and the docked chat at once.
 * It measures the workspace row after the sidebar, so a narrow window does not
 * dock two unusable columns just because the window itself is wide.
 */
export function useGameWorkspaceCompact(
  workspaceElement: HTMLElement | null,
  enabled: boolean,
): boolean {
  const [store] = useState(createCompactWorkspaceStore);
  useLayoutEffect(() => {
    store.observe(workspaceElement, enabled);
    return () => store.stop();
  }, [enabled, store, workspaceElement]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => false);
}

/**
 * The pane a compact workbench shows. Entering compact always lands on the
 * stage; leaving compact drops the temporary choice so the docked layout shows
 * the creator's saved chat preference again.
 */
export function useCompactGamePane(compact: boolean) {
  const [state, setState] = useState<{ compact: boolean; pane: GameWorkspacePane }>({
    compact,
    pane: "game",
  });
  if (state.compact !== compact) {
    setState({ compact, pane: "game" });
  }
  const pane = compact ? state.pane : "game";
  const setPane = (next: GameWorkspacePane) => setState({ compact, pane: next });
  return [pane, setPane] as const;
}
