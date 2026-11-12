import { AuthPreviewOperateScope } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import {
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
  useRouterState,
} from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { ThreadRouteView } from "../components/ThreadRouteView";
import { GamesHome } from "../components/game/GamesHome";
import { AppNotFound } from "../components/AppNotFound";
import { isSettingsPage } from "../components/sidebar/mainAppLocation";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useLegacySidebarEnabled } from "../hooks/useSettings";
import { isPreviewAvailableFor } from "../browser/previewRuntime";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentScope } from "../state/session";
import { useNewGame } from "../components/game/gameEntryStore";
import { dispatchPreviewAction } from "../components/preview/previewActionBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isEditableFocused } from "../lib/editableFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { undoLatestThreadAction } from "../hooks/showThreadUndoNotice";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import type { ThreadRouteTarget } from "../threadRoutes";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const canOperatePreview = useEnvironmentScope(
    routeThreadRef?.environmentId ?? null,
    AuthPreviewOperateScope,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const newGame = useNewGame();
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  // The `previewOpen` shortcut-context flag here uses the store-only value;
  // the URL-aware arbitration lives inside ChatView's `onTogglePreview`,
  // which we invoke via the action bus to avoid duplicating the rule.
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });

      if (isCommandPaletteOpen()) {
        return;
      }

      if (command === "thread.undo") {
        if (event.repeat || isModelPickerOpen()) return;
        if (undoLatestThreadAction()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (event.key === "Escape" && selectedThreadKeysSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "chat.newWithoutProject") {
        const environmentId = scratchEnvironmentId(
          activeThread?.environmentId ?? activeDraftThread?.environmentId ?? primaryEnvironmentId,
        );
        if (environmentId === null) return;
        event.preventDefault();
        event.stopPropagation();
        void startScratchThread(environmentId);
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        // A game starts in Home's brief box; the legacy sidebar keeps T3's new chat.
        if (!legacySidebarEnabled) {
          newGame();
          return;
        }
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "preview.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!routeThreadRef || (!canOperatePreview && !previewOpen)) return;
        if (!isPreviewAvailableFor(routeThreadRef.environmentId)) {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Preview is desktop-only",
              description: "Open Kurambit in the desktop app to use the in-app preview.",
            }),
          );
          return;
        }
        dispatchPreviewAction("toggle-panel");
        return;
      }

      if (
        command === "preview.refresh" ||
        command === "preview.focusUrl" ||
        command === "preview.zoomIn" ||
        command === "preview.zoomOut" ||
        command === "preview.resetZoom"
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (!canOperatePreview) return;
        const action =
          command === "preview.refresh"
            ? "refresh"
            : command === "preview.focusUrl"
              ? "focus-url"
              : command === "preview.zoomIn"
                ? "zoom-in"
                : command === "preview.zoomOut"
                  ? "zoom-out"
                  : "reset-zoom";
        dispatchPreviewAction(action);
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    canOperatePreview,
    handleNewThread,
    keybindings,
    defaultProjectRef,
    previewOpen,
    newGame,
    primaryEnvironmentId,
    routeThreadRef,
    scratchEnvironmentId,
    selectedThreadKeysSize,
    startScratchThread,
    legacySidebarEnabled,
    terminalOpen,
  ]);

  return null;
}

type MainView = { kind: "home" } | { kind: "thread"; target: ThreadRouteTarget };

const HOME_VIEW: MainView = { kind: "home" };

function mainViewKey(view: MainView | null): string | null {
  if (view === null) return null;
  if (view.kind === "home") return "home";
  return view.target.kind === "server"
    ? `thread:${scopedThreadKey(view.target.threadRef)}`
    : `draft:${view.target.draftId}`;
}

function ChatRouteLayout() {
  // Home and both thread routes render here, not in their own leaf components, so the
  // draft-to-thread promotion keeps one ChatView mounted across the swap, and Settings
  // can open over whichever of them was showing without unmounting it.
  const threadTarget = useThreadRouteTarget();
  const pathname = useLocation({ select: (location) => location.pathname });
  const settingsOpen = isSettingsPage(pathname);
  // An address that only begins like a thread's (/a/b/c) matches the thread route's two
  // params and then misses: the not-found page shows, not a blank thread.
  const notFound = useRouterState({
    select: (state) =>
      state.matches.some((match) => match.status === "notFound" || match.globalNotFound === true),
  });
  const routeView: MainView | null =
    settingsOpen || notFound
      ? null
      : threadTarget
        ? { kind: "thread", target: threadTarget }
        : pathname === "/"
          ? HOME_VIEW
          : null;
  // The view Settings opens over: the last one shown, so a game keeps playing behind it.
  // A settings link opened cold has none, and Home stands in.
  const [lastView, setLastView] = useState<MainView | null>(routeView);
  if (!settingsOpen && mainViewKey(routeView) !== mainViewKey(lastView)) {
    setLastView(routeView);
  }
  const view = settingsOpen ? (lastView ?? HOME_VIEW) : routeView;
  return (
    <>
      {settingsOpen ? null : <ChatRouteGlobalShortcuts />}
      {!settingsOpen && view?.kind === "thread" && view.target.kind === "server" ? (
        <ThreadLinkPrompt threadRef={view.target.threadRef} />
      ) : null}
      {view?.kind === "thread" ? (
        <ThreadRouteView target={view.target} behindSettings={settingsOpen} />
      ) : view?.kind === "home" ? (
        <GamesHome />
      ) : null}
      {view === null || settingsOpen ? <Outlet /> : null}
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
  // Inside the pane, not over the bare window, for any address under the app's layout.
  notFoundComponent: AppNotFound,
});
