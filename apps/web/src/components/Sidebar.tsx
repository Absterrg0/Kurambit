import { useAtomValue } from "@effect/atom-react";
import {
  DndContext,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@kurambit/client-runtime/environment";
import { pinOrderKeyBetween } from "@kurambit/client-runtime/state/thread-sort";
import { presentThreadShell, threadRuntimeCanArchive } from "@kurambit/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@kurambit/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type GameBuildsResult,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { EllipsisIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { isElectron } from "../env";
import { useClientSettings } from "../hooks/useSettings";
import { useStableCallback } from "../hooks/useStableCallback";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import { useThreadActions } from "../hooks/useThreadActions";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import {
  resolveShortcutCommand,
  simplestShortcutLabelForCommand,
  shortcutLabelForCommand,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { readLocalApi } from "../localApi";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { isTerminalFocused } from "../lib/terminalFocus";
import { gameEnvironment } from "../state/game";
import { allReachableShellsLiveAtom, shellEnvironment } from "../state/shell";
import { useServerConfigs, useThreadShells } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuerySelector } from "../state/query";
import { primaryServerKeybindingsAtom } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams, resolveActiveThreadRouteRef } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { useUiStateStore } from "../uiStateStore";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "../lib/archivedThreadsState";
import { cn } from "../lib/utils";
import { ThreadContextDragGhost } from "./chat/ThreadContextDragGhost";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag,
} from "./chat/threadContextDrag";
import { useNewGame } from "./game/gameEntryStore";
import { useLastGameChat } from "./library/lastGameChat";
import { doesNotStart } from "./game/gameBuilds.logic";
import { GameLibraryPicture } from "./game/GameLibraryStatus";
import { GameNameInput, useGameName, useGameRenameStore, useRenameGame } from "./game/GameName";
import { useGameLibrary, type GameLibraryEntry } from "./game/useGameLibrary";
import { useNewChat } from "./game/useNewGameChat";
import { useCopyPlace } from "./game/useGameCopies";
import { useSidebarRowSubscriptionLease } from "./Sidebar.logic";
import { SidebarDragLifecycle, SidebarPointerSensor } from "./Sidebar.pointer";
import {
  buildGameTree,
  chatMark,
  visibleChats,
  type GameTreeMark,
  type GameTreeNode,
  type GameTreeSort,
} from "./sidebar/gameTree.logic";
import {
  NATIVE_ACTION_ICONS,
  SidebarChatRow,
  SidebarGameRow,
  SidebarQuietRow,
  type GameAction,
  type GameActionItem,
} from "./sidebar/SidebarGameRows";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { SidebarThreadHeader } from "./sidebar/SidebarThreadHeader";
import { Button } from "./ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { SidebarContent, SidebarGroup, useSidebar } from "./ui/sidebar";
import { Skeleton } from "./ui/skeleton";
import { Text } from "./ui/text";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

type Node = GameTreeNode<GameLibraryEntry, SidebarThreadSummary>;

const SORT_KEY = "kurambit:sidebar:games-sort";
const GameTreeSortSchema = Schema.Literals(["recent", "name"]);
const SHOW_ARCHIVED_KEY = "kurambit:sidebar:show-archived";
const ARCHIVED_OPEN_KEY = "kurambit:sidebar:archived-expanded";
/** A game's own expansion, apart from T3's project rows. */
const expansionKey = (gameKey: string) => `game:${gameKey}`;
const DRAG_DISTANCE = 6;
const NO_THREADS: ReadonlyArray<SidebarThreadSummary> = [];
const NO_ENVIRONMENTS: ReadonlyArray<EnvironmentId> = [];

const toastFailure = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );

/** "3m", "2d", "now": a row has no room for "ago". */
function ChatTime({ at }: { at: string }) {
  const nowMinute = useNowMinute();
  const label = formatRelativeTimeLabel(at, Date.parse(`${nowMinute}:00.000Z`));
  return label === "just now" ? "now" : label.endsWith(" ago") ? label.slice(0, -4) : label;
}

/**
 * What a game's latest builds say: its current build does not start, and which chats have a
 * Try-several-ways waiting for the person to keep one. Read from the same first page of builds
 * the row's picture reads.
 */
const buildStateOf = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result)) return NO_BUILD_STATE;
  const { builds, current } = result.value;
  const latest = builds.find((build) => build.id === current) ?? builds[0];
  const tries = new Map<string, { chat: string; kept: boolean }>();
  for (const build of builds) {
    if (build.source._tag !== "version") continue;
    const before = tries.get(build.source.runId);
    tries.set(build.source.runId, {
      chat: build.source.threadId,
      kept: (before?.kept ?? false) || build.source.kept,
    });
  }
  const picking = [...tries.values()].filter((each) => !each.kept).map((each) => each.chat);
  const broken = latest !== undefined && doesNotStart(latest.facts);
  return picking.length === 0 && !broken ? NO_BUILD_STATE : { broken, picking: picking.join("\n") };
};
const NO_BUILD_STATE = { broken: false, picking: "" };

export default function Sidebar() {
  const gameLibrary = useGameLibrary();
  const shellsLive = useAtomValue(allReachableShellsLiveAtom);
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const routeTarget = useThreadRouteTarget();
  const routeDraft = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = resolveActiveThreadRouteRef(routeTarget, routeDraft);
  const routeThreadKey = routeThreadRef === null ? null : scopedThreadKey(routeThreadRef);
  const libraryOpen = useLocation({ select: (location) => location.pathname === "/library" });
  const [sort, setSort] = useLocalStorage<GameTreeSort, GameTreeSort>(
    SORT_KEY,
    "recent",
    GameTreeSortSchema,
  );
  const [showArchived, setShowArchived] = useLocalStorage(SHOW_ARCHIVED_KEY, true, Schema.Boolean);
  const [archivedOpen, setArchivedOpen] = useLocalStorage(ARCHIVED_OPEN_KEY, false, Schema.Boolean);
  const expandedById = useUiStateStore((state) => state.projectExpandedById);
  const setExpanded = useUiStateStore((state) => state.setProjectExpanded);
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set());
  const newGame = useNewGame();
  const newThreadContext = useHandleNewThread();
  const newChat = useNewChat(newThreadContext.handleNewThread);
  const {
    pinThread,
    unpinThread,
    reorderPinnedThread,
    archiveThread: archiveChat,
    deleteThread,
  } = useThreadActions();
  const archive = useOrchestrationCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchive = useOrchestrationCommand(threadEnvironment.unarchive, { reportFailure: false });
  const removeProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const renameChat = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: true });
  const [renamingChat, setRenamingChat] = useState<string | null>(null);

  // Archived chats are not in the live shells; T3's archived snapshot names them, so a game
  // whose every chat is archived sits under Archived instead of reading as a game with none.
  const archivedSnapshots = useArchivedThreadSnapshots(
    gameLibrary.environmentId === null ? NO_ENVIRONMENTS : [gameLibrary.environmentId],
  ).snapshots;
  const archivedThreads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
    snapshot.threads.map((thread) => presentThreadShell(environmentId, thread)),
  );
  const tree = buildGameTree({
    games: gameLibrary.games,
    threads: gameLibrary.games.length === 0 ? NO_THREADS : [...threads, ...archivedThreads],
    sort,
  });
  const nodeOfThread = new Map<string, Node>();
  for (const node of [...tree.live, ...tree.archived])
    for (const chat of node.chats)
      nodeOfThread.set(scopedThreadKey(scopeThreadRef(chat.environmentId, chat.id)), node);
  const currentNode = routeThreadKey === null ? null : (nodeOfThread.get(routeThreadKey) ?? null);
  const currentGameKey = currentNode?.key ?? null;
  // The open game is unfolded unless the person folded it; the others keep what they were left.
  const isExpanded = (node: Node) =>
    !node.archived &&
    node.chats.length > 0 &&
    (expandedById[expansionKey(node.key)] ?? node.key === currentGameKey);

  // The Library knows the game the person was last on.
  const rememberChat = useLastGameChat((state) => state.set);
  const currentProjectId = currentNode?.game.projectId ?? null;
  useEffect(() => {
    const ref = routeThreadKey === null ? null : parseScopedThreadKey(routeThreadKey);
    if (ref !== null && currentProjectId !== null) rememberChat(ref, currentProjectId);
  }, [routeThreadKey, currentProjectId, rememberChat]);

  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const openChat = (chat: Pick<SidebarThreadSummary, "environmentId" | "id">) => {
    closeMobile();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(chat.environmentId, chat.id)),
    });
  };
  const startChat = (game: GameLibraryEntry) => {
    closeMobile();
    void newChat(scopeProjectRef(game.environmentId, game.projectId));
  };
  const openGame = (node: Node) => {
    if (node.main === null) return startChat(node.game);
    openChat(node.main);
  };

  const canOperate = (node: Node) =>
    readEnvironmentScope(node.game.environmentId, AuthOrchestrationOperateScope);
  const menuOf = (node: Node): ReadonlyArray<GameActionItem> => {
    const operate = canOperate(node);
    const folder =
      serverConfigs.get(node.game.environmentId)?.availableEditors.includes("file-manager") ===
      true;
    const running = node.chats.some((chat) => !threadRuntimeCanArchive(chat.runtime));
    const pinning =
      serverConfigs.get(node.game.environmentId)?.environment.capabilities.threadPinning === true;
    return [
      ...(node.archived
        ? []
        : [{ id: "new-chat" as const, label: "New chat", disabled: !operate }]),
      { id: "rename" as const, label: "Rename", disabled: !operate },
      ...(folder ? [{ id: "open-folder" as const, label: "Open folder" }] : []),
      ...(node.archived || node.main === null || !pinning
        ? []
        : [
            node.pinned
              ? { id: "unpin" as const, label: "Unpin", disabled: !operate }
              : { id: "pin" as const, label: "Pin", disabled: !operate },
          ]),
      node.archived
        ? { id: "unarchive" as const, label: "Unarchive", disabled: !operate }
        : {
            id: "archive" as const,
            label: "Archive",
            disabled: !operate || running || node.chats.length === 0,
          },
      { id: "delete" as const, label: "Delete…", destructive: true, separatorBefore: true },
    ];
  };

  const runGameAction = async (node: Node, action: GameAction) => {
    const { game } = node;
    const mainRef =
      node.main === null ? null : scopeThreadRef(node.main.environmentId, node.main.id);
    switch (action) {
      case "new-chat":
        return startChat(game);
      case "rename":
        return useGameRenameStore.getState().start(game.projectId);
      case "open-folder":
        return void openInEditor({
          environmentId: game.environmentId,
          input: { cwd: game.root, editor: "file-manager" },
        });
      case "pin":
      case "unpin": {
        if (mainRef === null) return;
        const result = await (action === "pin" ? pinThread(mainRef) : unpinThread(mainRef));
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
          toastFailure(
            action === "pin" ? "Could not pin the game" : "Could not unpin the game",
            squashAtomCommandFailure(result),
          );
        return;
      }
      case "archive":
      case "unarchive": {
        const command = action === "archive" ? archive : unarchive;
        for (const chat of node.chats) {
          const result = await command({
            environmentId: chat.environmentId,
            input: { threadId: chat.id },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            toastFailure(
              action === "archive" ? "Could not archive the game" : "Could not bring the game back",
              squashAtomCommandFailure(result),
            );
            return;
          }
        }
        refreshArchivedThreadsForEnvironment(game.environmentId);
        if (action === "archive" && currentGameKey === node.key) void navigate({ to: "/" });
        return;
      }
      case "delete": {
        const api = readLocalApi();
        if (!api) return;
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete ${game.name} from Kurambit?`,
              `Its ${node.chats.length === 1 ? "chat goes" : `${node.chats.length} chats go`} with it. The game's folder stays on disk: ${game.root}`,
            ].join("\n"),
            { variant: "destructive" },
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
        const result = await removeProject({
          environmentId: game.environmentId,
          input: { projectId: game.projectId, force: true },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          toastFailure(`Could not delete ${game.name}`, squashAtomCommandFailure(result));
          return;
        }
        gameLibrary.refresh();
        if (currentGameKey === node.key) void navigate({ to: "/" });
        return;
      }
    }
  };
  const showGameMenu = async (node: Node, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const items = menuOf(node);
    const clicked = await settlePromise(() =>
      api.contextMenu.show(
        items.map((item) => ({ ...item, icon: NATIVE_ACTION_ICONS[item.id] })),
        position,
      ),
    );
    if (clicked._tag === "Success" && clicked.value !== null)
      void runGameAction(node, clicked.value);
  };
  const showChatMenu = async (chat: SidebarThreadSummary, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const ref = scopeThreadRef(chat.environmentId, chat.id);
    const operate = readEnvironmentScope(chat.environmentId, AuthOrchestrationOperateScope);
    const clicked = await settlePromise(() =>
      api.contextMenu.show(
        [
          { id: "rename" as const, label: "Rename", icon: "pencil", disabled: !operate },
          {
            id: "archive" as const,
            label: chat.archivedAt === null ? "Archive" : "Unarchive",
            icon: "archive",
            disabled: !operate || !threadRuntimeCanArchive(chat.runtime),
          },
          {
            id: "delete" as const,
            label: "Delete",
            icon: "trash",
            destructive: true,
            separatorBefore: true,
            disabled: !operate,
          },
        ],
        position,
      ),
    );
    if (clicked._tag === "Failure" || clicked.value === null) return;
    if (clicked.value === "rename") return setRenamingChat(scopedThreadKey(ref));
    if (clicked.value === "archive") {
      const result =
        chat.archivedAt === null
          ? await archiveChat(ref)
          : await unarchive({ environmentId: chat.environmentId, input: { threadId: chat.id } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
        toastFailure("Could not archive the chat", squashAtomCommandFailure(result));
      return;
    }
    if (confirmThreadDelete) {
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(`Delete “${chat.title}”?\nIts conversation goes with it.`, {
          variant: "destructive",
        }),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;
    }
    const result = await deleteThread(ref);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      toastFailure("Could not delete the chat", squashAtomCommandFailure(result));
  };
  const commitChatRename = async (chat: SidebarThreadSummary, title: string) => {
    setRenamingChat(null);
    if (title === chat.title) return;
    const result = await renameChat({
      environmentId: chat.environmentId,
      input: { threadId: chat.id, title },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      toastFailure("Could not rename the chat", squashAtomCommandFailure(result));
  };

  // ─── Drag: a game moves among the pinned ones, onto them, or off them; dragged out of the
  // list, its chat goes to the composer as context, as T3's rows do.
  const listRef = useRef<HTMLUListElement | null>(null);
  const dragKey = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const outsideList = (point: { x: number; y: number }) => {
    const bounds = listRef.current?.getBoundingClientRect();
    return bounds !== undefined && (point.x < bounds.left || point.x > bounds.right);
  };
  const draggedChats = (): ReadonlyArray<ScopedThreadRef> => {
    const node = tree.live.find((each) => each.key === dragKey.current);
    return node?.main == null ? [] : [scopeThreadRef(node.main.environmentId, node.main.id)];
  };
  const sensors = useSensors(
    useSensor(SidebarPointerSensor, {
      distance: DRAG_DISTANCE,
      onAttach: () => {},
      onFinish: () => {
        dragKey.current = null;
        endThreadContextDrag();
        setDragging(null);
      },
      onMove: (point: { x: number; y: number }) => {
        if (!outsideList(point)) {
          endThreadContextDrag();
          return false;
        }
        const node = tree.live.find((each) => each.key === dragKey.current);
        moveThreadContextDrag(point, { title: node?.game.name ?? "Game", count: 1 });
        return true;
      },
      onDrop: (point: { x: number; y: number }) => {
        if (!outsideList(point)) return false;
        dropThreadContext(point, draggedChats());
        return true;
      },
    }),
  );
  const onDragStart = (event: DragStartEvent) => {
    dragKey.current = String(event.active.id);
    setDragging(String(event.active.id));
  };
  const onDragEnd = (event: DragEndEvent) => {
    const order = tree.live.map((node) => node.key);
    const from = order.indexOf(String(event.active.id));
    const to = event.over === null ? -1 : order.indexOf(String(event.over.id));
    const node = tree.live[from];
    if (node === undefined || to < 0 || from === to || node.main === null) return;
    const ref = scopeThreadRef(node.main.environmentId, node.main.id);
    const pinnedCount = tree.live.filter((each) => each.pinned).length;
    const moved = arrayMove([...tree.live], from, to);
    // Below the pinned games the order is by activity: a pinned game dropped there is unpinned.
    if (to >= pinnedCount) {
      if (node.pinned)
        void unpinThread(ref).then((result) => {
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
            toastFailure("Could not unpin the game", squashAtomCommandFailure(result));
        });
      return;
    }
    const before = moved[to - 1]?.main?.pinOrderKey ?? null;
    const next = moved[to + 1];
    const after = next !== undefined && next.pinned ? (next.main?.pinOrderKey ?? null) : null;
    const orderKey = pinOrderKeyBetween(before, after);
    if (orderKey === null) return;
    void (node.pinned ? reorderPinnedThread(ref, orderKey) : pinThread(ref, { orderKey })).then(
      (result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
          toastFailure("Could not move the game", squashAtomCommandFailure(result));
      },
    );
  };

  // ─── Keyboard: arrows move between rows, Enter opens, Left and Right fold, as T3's tree does.
  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "ArrowLeft") return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-tree-row]") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    if (event.key === "ArrowLeft") {
      // A chat's Left goes up to its game.
      if (rows[at]?.dataset.treeRow !== "chat") return;
      for (let index = at - 1; index >= 0; index -= 1)
        if (rows[index]?.dataset.treeRow === "game") {
          event.preventDefault();
          rows[index]?.focus();
          return;
        }
      return;
    }
    event.preventDefault();
    rows[
      event.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0)
    ]?.focus();
  };

  // Next and previous chat, and jump to the Nth game: the keys T3's sidebar had.
  const visibleChatKeys = tree.live.flatMap((node) =>
    (isExpanded(node) ? node.chats : node.main === null ? [] : [node.main]).map((chat) =>
      scopedThreadKey(scopeThreadRef(chat.environmentId, chat.id)),
    ),
  );
  const chatByKey = new Map(
    tree.live.flatMap((node) =>
      node.chats.map(
        (chat) => [scopedThreadKey(scopeThreadRef(chat.environmentId, chat.id)), chat] as const,
      ),
    ),
  );
  const jumpTargets = tree.live.flatMap((node) => (node.main === null ? [] : [node.main]));
  const onShortcut = useStableCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen())
      return;
    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: {
        terminalFocus: isTerminalFocused(),
        terminalOpen: false,
        modelPickerOpen: isModelPickerOpen(),
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    });
    const keys = { visibleChatKeys, chatByKey, jumpTargets, routeThreadKey };
    const direction = threadTraversalDirectionFromCommand(command);
    const jump = threadJumpIndexFromCommand(command ?? "");
    let target: Pick<SidebarThreadSummary, "environmentId" | "id"> | undefined;
    if (direction !== null) {
      const at =
        keys.routeThreadKey === null ? -1 : keys.visibleChatKeys.indexOf(keys.routeThreadKey);
      const next =
        at < 0
          ? keys.visibleChatKeys[0]
          : keys.visibleChatKeys[
              (at + (direction === "next" ? 1 : -1) + keys.visibleChatKeys.length) %
                keys.visibleChatKeys.length
            ];
      target = next === undefined ? undefined : keys.chatByKey.get(next);
    } else if (jump !== null) target = keys.jumpTargets[jump];
    if (target === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(target.environmentId, target.id)),
    });
  });
  useEffect(() => {
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [onShortcut]);

  const loading = gameLibrary.isLoading || !shellsLive;
  const empty = tree.live.length + tree.archived.length === 0;
  const renderChats = (node: Node) => {
    const { shown, hidden } = visibleChats(
      node.chats,
      showAll.has(node.key),
      routeThreadRef?.threadId ?? null,
    );
    return (
      <ul role="group" className="flex flex-col gap-px">
        {shown.map((chat) => {
          const chatKey = scopedThreadKey(scopeThreadRef(chat.environmentId, chat.id));
          return (
            <li key={chatKey} className="list-none">
              {renamingChat === chatKey ? (
                <div className="flex h-7 items-center ps-7 pe-1">
                  <GameNameInput
                    name={chat.title}
                    onRename={(title) => void commitChatRename(chat, title)}
                    onDone={() => setRenamingChat(null)}
                    className="h-6"
                  />
                </div>
              ) : (
                <GameChatRow
                  node={node}
                  chat={chat}
                  active={routeThreadKey === chatKey}
                  onOpen={() => openChat(chat)}
                  onContextMenu={(position) => void showChatMenu(chat, position)}
                />
              )}
            </li>
          );
        })}
        {hidden > 0 ? (
          <li className="list-none">
            <SidebarQuietRow
              indent
              label={`Show ${hidden} more`}
              onClick={() => setShowAll((before) => new Set(before).add(node.key))}
            />
          </li>
        ) : null}
      </ul>
    );
  };

  return (
    <>
      <ThreadContextDragGhost />
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <SidebarThreadHeader
              onNewGame={() => {
                closeMobile();
                newGame();
              }}
              newGameShortcutLabel={simplestShortcutLabelForCommand(keybindings, "chat.new")}
              onSearch={() => {
                closeMobile();
                openCommandPalette();
              }}
              searchShortcutLabel={shortcutLabelForCommand(keybindings, "commandPalette.toggle")}
              libraryOpen={libraryOpen}
              onLibrary={() => {
                closeMobile();
                void navigate({ to: "/library" });
              }}
            />
          </SidebarGroup>
        }
      >
        <SidebarGroup className="flex-1" role="presentation">
          <TooltipProvider delay={150} closeDelay={0} timeout={400}>
            <div className="mt-1 flex h-7 items-center gap-0.5 ps-1 pe-1">
              <Text variant="meta" tone="muted" render={<h2 className="min-w-0 flex-1" />}>
                Games
              </Text>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="New game"
                      onClick={() => {
                        closeMobile();
                        newGame();
                      }}
                    />
                  }
                >
                  <PlusIcon aria-hidden="true" />
                </TooltipTrigger>
                <TooltipPopup side="top">New game</TooltipPopup>
              </Tooltip>
              <Menu>
                <MenuTrigger
                  render={<Button size="icon-xs" variant="ghost" aria-label="Sort and show" />}
                >
                  <EllipsisIcon aria-hidden="true" />
                </MenuTrigger>
                <MenuPopup align="end" side="bottom">
                  <MenuGroup>
                    <MenuGroupLabel>Sort by</MenuGroupLabel>
                    <MenuRadioGroup
                      value={sort}
                      onValueChange={(value) => setSort(value === "name" ? "name" : "recent")}
                    >
                      <MenuRadioItem value="recent">Recent</MenuRadioItem>
                      <MenuRadioItem value="name">Name</MenuRadioItem>
                    </MenuRadioGroup>
                  </MenuGroup>
                  <MenuSeparator />
                  <MenuCheckboxItem
                    checked={showArchived}
                    onCheckedChange={(checked) => setShowArchived(checked)}
                  >
                    Show archived
                  </MenuCheckboxItem>
                </MenuPopup>
              </Menu>
            </div>
            <DndContext
              sensors={sensors}
              modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            >
              <SidebarDragLifecycle onUnmount={() => setDragging(null)} />
              <SortableContext
                items={tree.live.map((node) => node.key)}
                strategy={verticalListSortingStrategy}
              >
                <ul
                  ref={listRef}
                  role="tree"
                  aria-label="Games"
                  onKeyDown={onTreeKeyDown}
                  className="flex flex-col gap-px"
                >
                  {tree.live.map((node) => (
                    <SortableGame key={node.key} id={node.key} dragging={dragging === node.key}>
                      {(rowProps) => (
                        <>
                          <GameRow
                            node={node}
                            active={currentGameKey === node.key}
                            expanded={isExpanded(node)}
                            menu={menuOf(node)}
                            rowProps={rowProps}
                            onOpen={() => openGame(node)}
                            onToggle={() => setExpanded(expansionKey(node.key), !isExpanded(node))}
                            onNewChat={() => startChat(node.game)}
                            onAction={(action) => void runGameAction(node, action)}
                            onContextMenu={(position) => void showGameMenu(node, position)}
                          />
                          {isExpanded(node) ? renderChats(node) : null}
                        </>
                      )}
                    </SortableGame>
                  ))}
                  {showArchived && tree.archived.length > 0 ? (
                    <li className="mt-2 list-none">
                      <SidebarQuietRow
                        label="Archived"
                        count={tree.archived.length}
                        expanded={archivedOpen}
                        onClick={() => setArchivedOpen((open) => !open)}
                      />
                      {archivedOpen ? (
                        <ul role="group" className="flex flex-col gap-px">
                          {tree.archived.map((node) => (
                            <li key={node.key} className="list-none">
                              <GameRow
                                node={node}
                                active={currentGameKey === node.key}
                                expanded={false}
                                menu={menuOf(node)}
                                onOpen={() => openGame(node)}
                                onToggle={() => {}}
                                onNewChat={null}
                                onAction={(action) => void runGameAction(node, action)}
                                onContextMenu={(position) => void showGameMenu(node, position)}
                              />
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ) : null}
                </ul>
              </SortableContext>
            </DndContext>
          </TooltipProvider>
          {empty ? (
            loading ? (
              // Rows at their final size, so the list does not jump when the games arrive.
              <div role="status" aria-label="Loading games" className="flex flex-col gap-px">
                {[0, 1, 2].map((row) => (
                  <div key={row} className="flex h-7 items-center gap-2 px-1">
                    <Skeleton shape="card" className="size-5 shrink-0" />
                    <Skeleton className="h-3 w-28" />
                  </div>
                ))}
              </div>
            ) : (
              <Text variant="meta" tone="dim" render={<p className="px-1 py-6 text-center" />}>
                No games yet
              </Text>
            )
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

/** A game's block in the tree: the row and its chats move together when dragged. */
function SortableGame({
  id,
  dragging,
  children,
}: {
  id: string;
  dragging: boolean;
  children: (rowProps: Record<string, unknown>) => React.ReactNode;
}) {
  const { setNodeRef, listeners, transform, transition } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      role="treeitem"
      aria-selected={false}
      // Lifted while dragged: its own surface, so it never reads through the rows it passes.
      className={cn(
        "list-none",
        dragging && "relative z-10 rounded-md bg-sidebar shadow-lg ring-1 ring-border",
      )}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      {children({ ...listeners })}
    </li>
  );
}

function GameRow({
  node,
  active,
  expanded,
  menu,
  rowProps,
  onOpen,
  onToggle,
  onNewChat,
  onAction,
  onContextMenu,
}: {
  node: Node;
  active: boolean;
  expanded: boolean;
  menu: ReadonlyArray<GameActionItem>;
  rowProps?: Record<string, unknown>;
  onOpen: () => void;
  onToggle: () => void;
  onNewChat: (() => void) | null;
  onAction: (action: GameAction) => void;
  onContextMenu: (position: { x: number; y: number }) => void;
}) {
  const { game, main } = node;
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(active);
  const name = useGameName(game.environmentId, game.projectId, game.name);
  const renaming = useGameRenameStore((state) => state.renaming === game.projectId);
  const rename = useRenameGame(game.environmentId);
  const builds = useEnvironmentQuerySelector(
    main === null || !leaseLiveStatus || node.archived
      ? null
      : gameEnvironment.builds({
          environmentId: game.environmentId,
          input: { threadId: main.id },
        }),
    buildStateOf,
  );
  const picking = new Set((builds?.picking ?? "").split("\n").filter((id) => id !== ""));
  const marks = new Set(node.chats.map((chat) => chatMark(chat, picking.has(chat.id))));
  const working = marks.has("working") || game.run !== null || game.operation?.state === "running";
  const mark: GameTreeMark = node.archived
    ? null
    : marks.has("waiting")
      ? "waiting"
      : working
        ? "working"
        : null;
  if (renaming)
    return (
      <div className="flex h-7 items-center gap-2 px-1">
        <span className="size-5 shrink-0" />
        <GameNameInput
          name={name}
          onRename={(next) => void rename(game.projectId, next)}
          onDone={() => useGameRenameStore.getState().stop()}
          className="h-6"
        />
      </div>
    );
  return (
    <div ref={rowRef}>
      <SidebarGameRow
        picture={
          <GameLibraryPicture
            game={game}
            main={main}
            chats={null}
            gameName={name}
            read={leaseLiveStatus}
            className="size-5"
          />
        }
        name={name}
        active={active}
        expanded={expanded}
        expandable={!node.archived && node.chats.length > 0}
        mark={mark}
        broken={builds?.broken === true}
        muted={node.archived}
        menu={menu}
        newChatLabel={`New chat in ${name}`}
        onOpen={onOpen}
        onToggle={onToggle}
        onNewChat={onNewChat}
        onAction={onAction}
        onContextMenu={onContextMenu}
        {...(rowProps === undefined ? {} : { rowProps })}
      />
    </div>
  );
}

/** A chat row: its mark is its own state, and a Try waiting on a pick in it. */
function GameChatRow({
  node,
  chat,
  active,
  onOpen,
  onContextMenu,
}: {
  node: Node;
  chat: SidebarThreadSummary;
  active: boolean;
  onOpen: () => void;
  onContextMenu: (position: { x: number; y: number }) => void;
}) {
  const picking = useEnvironmentQuerySelector(
    node.main === null || node.archived
      ? null
      : gameEnvironment.builds({
          environmentId: node.game.environmentId,
          input: { threadId: node.main.id },
        }),
    buildStateOf,
  );
  // A chat in a copy whose work did not come in waits on the person, as a question does.
  const copyPlace = useCopyPlace(
    chat.worktreePath === null ? null : { environmentId: chat.environmentId, threadId: chat.id },
  );
  const copyWaits = copyPlace?.state._tag === "conflicts" || copyPlace?.state._tag === "held";
  const ownMark = chatMark(chat, new Set((picking?.picking ?? "").split("\n")).has(chat.id));
  const mark = ownMark === null && copyWaits ? "waiting" : ownMark;
  return (
    <SidebarChatRow
      title={chat.title}
      time={<ChatTime at={chat.latestUserMessageAt ?? chat.updatedAt} />}
      active={active}
      copy={chat.worktreePath !== null}
      mark={mark}
      onOpen={onOpen}
      onContextMenu={onContextMenu}
    />
  );
}
