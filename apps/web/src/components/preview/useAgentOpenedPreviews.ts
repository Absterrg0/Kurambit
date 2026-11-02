import type { ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { useEffect, useRef } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import type { ThreadPreviewState } from "../../previewStateStore";
import { useRightPanelStore, type RightPanelSurface } from "../../rightPanelStore";

const selectAutoShowFloatingPreview = (settings: { browserAutoShowFloatingPreview: boolean }) =>
  settings.browserAutoShowFloatingPreview;

/**
 * Shows browsers and devices an agent or another client opened for the thread,
 * and closes a floating device once its session ends.
 */
export function useAgentOpenedPreviews(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly previewState: ThreadPreviewState;
  // Whether the environment hosts browser tabs for this client.
  readonly serverBrowserAvailable: boolean;
  readonly panelSurfaces: ReadonlyArray<RightPanelSurface>;
}) {
  const { threadRef, previewState, serverBrowserAvailable, panelSurfaces } = input;
  const autoShowFloatingPreview = useClientSettings(selectAutoShowFloatingPreview);
  // Baseline loaded tabs so reloads never reopen previews the user dismissed.
  const previousServerPreviewTabs = useRef(new Map<string, Map<string, string | undefined>>());
  useEffect(() => {
    if (!threadRef || !serverBrowserAvailable || !previewState.listLoaded) return;
    const threadKey = scopedThreadKey(threadRef);
    const serverSessions = Object.values(previewState.sessions).filter(
      (session) => session.runtime === "server",
    );
    const previous = previousServerPreviewTabs.current.get(threadKey);
    previousServerPreviewTabs.current.set(
      threadKey,
      new Map(serverSessions.map((session) => [session.tabId, session.revealRequest?.id])),
    );
    if (!previous) return;
    for (const session of serverSessions) {
      const requested = session.revealRequest;
      const fresh = requested
        ? previous.get(session.tabId) !== requested.id
        : !previous.has(session.tabId);
      if (!fresh || session.reveal !== true) continue;
      if (!autoShowFloatingPreview && requested?.force !== true) continue;
      const surface = panelSurfaces.find(
        (surface) => surface.kind === "preview" && surface.resourceId === session.tabId,
      );
      if (surface && requested?.force === true) {
        useRightPanelStore.getState().activateSurface(threadRef, surface.id);
      } else if (!surface) {
        usePreviewMiniPlayerStore
          .getState()
          .open(threadRef, browserMiniPlayerSource(session.tabId));
      }
    }
  }, [
    serverBrowserAvailable,
    previewState.listLoaded,
    previewState.sessions,
    threadRef,
    autoShowFloatingPreview,
    panelSurfaces,
  ]);
}
