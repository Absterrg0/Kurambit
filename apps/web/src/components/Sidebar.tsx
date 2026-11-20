import { useAtomValue } from "@effect/atom-react";
import {
  DndContext,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@kurambit/client-runtime/environment";
import { presentThreadShell } from "@kurambit/client-runtime/state/models";
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
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { isElectron } from "../env";
import { useStableCallback } from "../hooks/useStableCallback";
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
import { registerSettleAndAdvance } from "../settleAndAdvance";
import { isTerminalFocused } from "../lib/terminalFocus";
import { gameEnvironment } from "../state/game";
import { allReachableShellsLiveAtom } from "../state/shell";
import {
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsSettlement,
  useThreadShells,
} from "../state/entities";
import { useEnvironmentQuerySelector } from "../state/query";
import { primaryServerKeybindingsAtom } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams, resolveActiveThreadRouteRef } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { useComposerDraftStore } from "../composerDraftStore";
import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
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
import { chatTitle } from "./game/gameLibrary.logic";
import { GameNameInput, useGameName } from "./game/GameName";
import { useGameActions } from "./game/useGameActions";
import { useGameLibrary, type GameLibraryEntry } from "./game/useGameLibrary";
import { useCopyPlace } from "./game/useGameCopies";
import { useSidebarRowSubscriptionLease } from "./Sidebar.logic";
import { SidebarDragLifecycle, SidebarPointerSensor } from "./Sidebar.pointer";
import {
  buildChatList,
  chatActivityAt,
  chatAfterSettle,
  chatMark,
  chatNote,
  isSettledChat,
  SHELF_PAGE,
  type ChatListRow,
} from "./sidebar/chatList.logic";
import {
  SidebarChatRow,
  SidebarQuietRow,
  SidebarShelfHeader,
  type ChatRowAction,
} from "./sidebar/SidebarChatRows";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { SidebarThreadHeader } from "./sidebar/SidebarThreadHeader";
import { SidebarContent, SidebarGroup, useSidebar } from "./ui/sidebar";
import { Skeleton } from "./ui/skeleton";
import { Text } from "./ui/text";
import { stackedThreadToast, toastManager } from "./ui/toast";

type Row = ChatListRow<GameLibraryEntry, SidebarThreadSummary>;
/** Where a row sits: among the chats at work, or on one of the two shelves under them. */
type Place = "list" | "settled" | "archived";

const ARCHIVED_OPEN_KEY = "kurambit:sidebar:archived-expanded";
const SETTLED_OPEN_KEY = "kurambit:sidebar:settled-expanded";
/** The Settled shelf's header, as a place to drop a chat; a chat's own id while it is dragged. */
const SETTLED_DROP_ID = "shelf:settled";
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
 * What a game's latest builds say: its current build does not start, and which chat's turn made
 * it. Read from the same first page of builds the row's picture reads.
 */
const buildStateOf = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result)) return NO_BUILD_STATE;
  const { builds, current } = result.value;
  const latest = builds.find((build) => build.id === current) ?? builds[0];
  if (latest === undefined || !doesNotStart(latest.facts)) return NO_BUILD_STATE;
  const source = latest.source;
  return { broken: true, brokenBy: "threadId" in source ? String(source.threadId) : "" };
};
const NO_BUILD_STATE = { broken: false, brokenBy: "" };

export default function Sidebar() {
  const gameLibrary = useGameLibrary();
  const shellsLive = useAtomValue(allReachableShellsLiveAtom);
  const threads = useThreadShells();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const routeTarget = useThreadRouteTarget();
  const routeDraft = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = resolveActiveThreadRouteRef(routeTarget, routeDraft);
  const routeThreadKey = routeThreadRef === null ? null : scopedThreadKey(routeThreadRef);
  const libraryOpen = useLocation({ select: (location) => location.pathname === "/library" });
  const [archivedOpen, setArchivedOpen] = useLocalStorage(ARCHIVED_OPEN_KEY, false, Schema.Boolean);
  const [settledOpen, setSettledOpen] = useLocalStorage(SETTLED_OPEN_KEY, false, Schema.Boolean);
  const [settledShown, setSettledShown] = useState(SHELF_PAGE);
  const [archivedShown, setArchivedShown] = useState(SHELF_PAGE);
  const newGame = useNewGame();
  const gameActions = useGameActions();
  const {
    pinThread,
    confirmAndUnpinThread,
    settleThread,
    unsettleThread,
    unarchiveThread,
    confirmAndDeleteThread,
  } = useThreadActions();
  const renameChat = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [renamingChat, setRenamingChat] = useState<string | null>(null);

  // Archived chats are not in the live shells; T3's archived snapshot names them, so a game that
  // was put away is on the Archived shelf instead of nowhere.
  const archivedSnapshots = useArchivedThreadSnapshots(
    gameLibrary.environmentId === null ? NO_ENVIRONMENTS : [gameLibrary.environmentId],
  ).snapshots;
  const archivedThreads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
    snapshot.threads.map((thread) => presentThreadShell(environmentId, thread)),
  );
  const list = buildChatList({
    games: gameLibrary.games,
    threads: gameLibrary.games.length === 0 ? NO_THREADS : [...threads, ...archivedThreads],
  });
  const keyOf = (chat: Pick<SidebarThreadSummary, "environmentId" | "id">) =>
    scopedThreadKey(scopeThreadRef(chat.environmentId, chat.id));
  // The rows at work, top to bottom: what the keys walk and what settling moves on through.
  const atWork = [...list.pinned, ...list.active];
  const rowByKey = new Map(
    [...atWork, ...list.settled, ...list.archived].map((row) => [keyOf(row.chat), row] as const),
  );
  const currentRow = routeThreadKey === null ? null : (rowByKey.get(routeThreadKey) ?? null);
  // A shelf opens on the chat on screen, so the selected row is never folded away.
  const shelfOpen = settledOpen || (currentRow !== null && list.settled.includes(currentRow));
  const archiveOpen = archivedOpen || (currentRow !== null && list.archived.includes(currentRow));

  // The Library knows the game the person was last on.
  const rememberChat = useLastGameChat((state) => state.set);
  const currentProjectId = currentRow?.game.projectId ?? null;
  useEffect(() => {
    const ref = routeThreadKey === null ? null : parseScopedThreadKey(routeThreadKey);
    if (ref !== null && currentProjectId !== null) rememberChat(ref, currentProjectId);
  }, [routeThreadKey, currentProjectId, rememberChat]);

  // The chat on screen is always in view in the list, however it was opened.
  const listRef = useRef<HTMLUListElement | null>(null);
  const onScreenListed = currentRow !== null;
  useEffect(() => {
    if (routeThreadKey === null || !onScreenListed) return;
    listRef.current
      ?.querySelector('[data-sidebar-row][data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [routeThreadKey, onScreenListed]);

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

  // ─── Settle: a chat whose work is done leaves the list for the Settled shelf, T3's settle with
  // its Undo notice. Settled while on screen, the person moves on to the next chat at work.
  const settleChat = useStableCallback((ref: ScopedThreadRef) => {
    const chatKey = scopedThreadKey(ref);
    const onScreen = routeThreadKey === chatKey;
    const next = chatAfterSettle(
      atWork.map((row) => row.chat),
      { id: ref.threadId },
    );
    void settleThread(ref).then((result) => {
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result))
          toastFailure("Could not settle the chat", squashAtomCommandFailure(result));
        return;
      }
      if (!onScreen) return;
      if (next !== null) openChat(next);
      // The last chat at work: Home, where every game is.
      else void navigate({ to: "/" });
    });
  });
  useEffect(() => registerSettleAndAdvance(settleChat), [settleChat]);
  const said = (title: string) => (result: { readonly _tag: string }) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result as never))
      toastFailure(title, squashAtomCommandFailure(result as never));
  };
  const unsettleChat = (ref: ScopedThreadRef) =>
    void unsettleThread(ref).then(said("Could not un-settle the chat"));
  const unarchiveChat = (ref: ScopedThreadRef) =>
    void unarchiveThread(ref).then(said("Could not unarchive the chat"));

  const showChatMenu = async (row: Row, place: Place, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const { chat, game } = row;
    const ref = scopeThreadRef(chat.environmentId, chat.id);
    const operate = readEnvironmentScope(chat.environmentId, AuthOrchestrationOperateScope);
    const pinned = chat.pinnedAt != null;
    type Item = "rename" | "pin" | "unpin" | "settle" | "unsettle" | "unarchive" | "delete";
    type GameItem = "new-chat" | "new-chat-in-copy";
    const item = (id: Item | GameItem, label: string, icon: string) => ({
      id,
      label,
      icon,
      disabled: !operate,
    });
    const clicked = await settlePromise(() =>
      api.contextMenu.show<Item | GameItem>(
        [
          item("rename", "Rename chat", "pencil"),
          ...(place !== "list" || !readEnvironmentSupportsPinning(chat.environmentId)
            ? []
            : [pinned ? item("unpin", "Unpin", "pin-off") : item("pin", "Pin", "pin")]),
          ...(place === "archived"
            ? [item("unarchive", "Unarchive", "archive")]
            : !readEnvironmentSupportsSettlement(chat.environmentId)
              ? []
              : [
                  place === "settled"
                    ? item("unsettle", "Un-settle", "circle-check")
                    : item("settle", "Settle", "circle-check"),
                ]),
          { ...item("delete", "Delete chat…", "trash"), destructive: true },
          // Last, the row's game: a new chat for it. Its other actions are on its own screen.
          ...(place === "archived"
            ? []
            : [
                {
                  ...item("new-chat", `New chat in ${game.name}`, "message-square-plus"),
                  separatorBefore: true,
                },
                ...(gameActions.offersCopy
                  ? [item("new-chat-in-copy", "New chat in a copy", "copy")]
                  : []),
              ]),
        ],
        position,
      ),
    );
    if (clicked._tag === "Failure" || clicked.value === null) return;
    switch (clicked.value) {
      case "rename":
        return setRenamingChat(scopedThreadKey(ref));
      case "pin":
        return void pinThread(ref).then(said("Could not pin the chat"));
      case "unpin":
        return void confirmAndUnpinThread(ref).then(said("Could not unpin the chat"));
      case "settle":
        return settleChat(ref);
      case "unsettle":
        return unsettleChat(ref);
      case "unarchive":
        return unarchiveChat(ref);
      case "delete":
        return void confirmAndDeleteThread(ref).then(said("Could not delete the chat"));
      case "new-chat":
      case "new-chat-in-copy":
        closeMobile();
        return gameActions.newChat(game, { inCopy: clicked.value === "new-chat-in-copy" });
    }
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

  // ─── Drag: a chat dropped on the Settled shelf is settled, and a settled one dropped back among
  // the chats is at work again; dragged out of the list, a chat goes to the composer as context,
  // as T3's rows do. The list's order is by activity, so nothing is reordered by hand.
  const dragKey = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const outsideList = (point: { x: number; y: number }) => {
    const bounds = listRef.current?.getBoundingClientRect();
    return bounds !== undefined && (point.x < bounds.left || point.x > bounds.right);
  };
  const draggedRow = () => (dragKey.current === null ? null : rowByKey.get(dragKey.current));
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
        const row = draggedRow();
        moveThreadContextDrag(point, {
          title: row == null ? "Chat" : chatTitle(row.chat, row.game.name),
          count: 1,
        });
        return true;
      },
      onDrop: (point: { x: number; y: number }) => {
        if (!outsideList(point)) return false;
        const row = draggedRow();
        dropThreadContext(
          point,
          row == null ? [] : [scopeThreadRef(row.chat.environmentId, row.chat.id)],
        );
        return true;
      },
    }),
  );
  const onDragStart = (event: DragStartEvent) => {
    dragKey.current = String(event.active.id);
    setDragging(String(event.active.id));
  };
  const onDragEnd = (event: DragEndEvent) => {
    const row = rowByKey.get(String(event.active.id));
    if (row === undefined || event.over === null || row.chat.archivedAt !== null) return;
    const ref = scopeThreadRef(row.chat.environmentId, row.chat.id);
    const onShelf = event.over.id === SETTLED_DROP_ID;
    if (!isSettledChat(row.chat) && onShelf) settleChat(ref);
    else if (isSettledChat(row.chat) && !onShelf) unsettleChat(ref);
  };

  // ─── Keyboard: up and down move through the rows, Enter opens the one in hand.
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-sidebar-row]") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    rows[
      event.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0)
    ]?.focus();
  };

  // Next and previous chat, and jump to the Nth: the keys T3's sidebar has.
  const settledRows = shelfOpen ? list.settled.slice(0, settledShown) : [];
  const archivedRows = archiveOpen ? list.archived.slice(0, archivedShown) : [];
  const visibleChatKeys = [...atWork, ...settledRows, ...archivedRows].map((row) =>
    keyOf(row.chat),
  );
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
    const direction = threadTraversalDirectionFromCommand(command);
    const jump = threadJumpIndexFromCommand(command ?? "");
    let target: Pick<SidebarThreadSummary, "environmentId" | "id"> | undefined;
    if (direction !== null) {
      const at = routeThreadKey === null ? -1 : visibleChatKeys.indexOf(routeThreadKey);
      const next =
        at < 0
          ? visibleChatKeys[0]
          : visibleChatKeys[
              (at + (direction === "next" ? 1 : -1) + visibleChatKeys.length) %
                visibleChatKeys.length
            ];
      target = next === undefined ? undefined : rowByKey.get(next)?.chat;
    } else if (jump !== null) target = atWork[jump]?.chat;
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
  const empty = atWork.length + list.settled.length + list.archived.length === 0;
  // The chats at work in each game, for the row that says which one it waits for.
  const atWorkByGame = new Map<string, SidebarThreadSummary[]>();
  for (const { chat, game } of atWork) {
    const chats = atWorkByGame.get(game.projectId);
    if (chats === undefined) atWorkByGame.set(game.projectId, [chat]);
    else chats.push(chat);
  }
  const renderRow = (row: Row, place: Place) => {
    const { chat } = row;
    const chatKey = keyOf(chat);
    const ref = scopeThreadRef(chat.environmentId, chat.id);
    const operate = readEnvironmentScope(chat.environmentId, AuthOrchestrationOperateScope);
    const action: ChatRowAction | null = !operate
      ? null
      : place === "archived"
        ? "unarchive"
        : !readEnvironmentSupportsSettlement(chat.environmentId)
          ? null
          : place === "settled"
            ? "unsettle"
            : "settle";
    return (
      <DraggableChat
        key={chatKey}
        id={chatKey}
        disabled={place === "archived"}
        dragging={dragging === chatKey}
      >
        {(rowProps, overShelf) => (
          <ChatRow
            row={row}
            place={place}
            siblings={atWorkByGame.get(row.game.projectId) ?? NO_THREADS}
            active={routeThreadKey === chatKey}
            action={action}
            // Carried over where a drop changes it: the row says what the drop does.
            dropping={
              dragging !== chatKey
                ? null
                : overShelf === null
                  ? "carried"
                  : place === "list" && overShelf
                    ? "settle"
                    : place === "settled" && !overShelf
                      ? "unsettle"
                      : "carried"
            }
            renaming={renamingChat === chatKey}
            onRename={(title) => void commitChatRename(chat, title)}
            onRenameDone={() => setRenamingChat(null)}
            onAction={() =>
              place === "archived"
                ? unarchiveChat(ref)
                : place === "settled"
                  ? unsettleChat(ref)
                  : settleChat(ref)
            }
            onOpen={() => openChat(chat)}
            onContextMenu={(position) => void showChatMenu(row, place, position)}
            rowProps={rowProps}
          />
        )}
      </DraggableChat>
    );
  };
  const draggingSettles = dragging !== null && atWork.some((row) => keyOf(row.chat) === dragging);

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
              // On a game's screen the key starts a chat in that game, so it is no hint here.
              newGameShortcutLabel={
                currentRow === null
                  ? simplestShortcutLabelForCommand(keybindings, "chat.new")
                  : null
              }
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
          <DndContext
            sensors={sensors}
            modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          >
            <SidebarDragLifecycle onUnmount={() => setDragging(null)} />
            <ul
              ref={listRef}
              aria-label="Chats"
              onKeyDown={onListKeyDown}
              className="mt-1 flex flex-col"
            >
              {atWork.map((row) => renderRow(row, "list"))}
              {list.settled.length > 0 || draggingSettles ? (
                <li className="mt-1 list-none">
                  <SettledShelfHeader
                    count={list.settled.length}
                    expanded={shelfOpen}
                    dragging={draggingSettles}
                    onToggle={() => setSettledOpen(!shelfOpen)}
                  />
                  {shelfOpen ? (
                    <ul className="flex flex-col">
                      {settledRows.map((row) => renderRow(row, "settled"))}
                      {list.settled.length > settledShown ? (
                        <li className="list-none">
                          <SidebarQuietRow
                            label={`Show ${Math.min(SHELF_PAGE, list.settled.length - settledShown)} more`}
                            onClick={() => setSettledShown(settledShown + SHELF_PAGE)}
                          />
                        </li>
                      ) : null}
                    </ul>
                  ) : null}
                </li>
              ) : null}
              {list.archived.length > 0 ? (
                <li className="list-none">
                  <SidebarShelfHeader
                    label="Archived"
                    count={list.archived.length}
                    expanded={archiveOpen}
                    onToggle={() => setArchivedOpen(!archiveOpen)}
                  />
                  {archiveOpen ? (
                    <ul className="flex flex-col">
                      {archivedRows.map((row) => renderRow(row, "archived"))}
                      {list.archived.length > archivedShown ? (
                        <li className="list-none">
                          <SidebarQuietRow
                            label={`Show ${Math.min(SHELF_PAGE, list.archived.length - archivedShown)} more`}
                            onClick={() => setArchivedShown(archivedShown + SHELF_PAGE)}
                          />
                        </li>
                      ) : null}
                    </ul>
                  ) : null}
                </li>
              ) : null}
            </ul>
          </DndContext>
          {empty ? (
            loading ? (
              // Rows at their final size, so the list does not jump when the chats arrive.
              <div role="status" aria-label="Loading chats" className="flex flex-col">
                {[0, 1, 2].map((row) => (
                  <div key={row} className="flex flex-col gap-2 px-2.5 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <Skeleton shape="card" className="size-4 shrink-0" />
                      <Skeleton className="h-3 w-20" />
                    </div>
                    <Skeleton className="h-3.5 w-36" />
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

/** A chat that can be carried: onto the Settled shelf, back among the chats, or to the composer. */
function DraggableChat({
  id,
  disabled,
  dragging,
  children,
}: {
  id: string;
  disabled: boolean;
  dragging: boolean;
  children: (rowProps: Record<string, unknown>, overShelf: boolean | null) => React.ReactNode;
}) {
  const { setNodeRef, listeners, transform, over } = useDraggable({ id, disabled });
  return (
    <li
      ref={setNodeRef}
      // Lifted while dragged: its own surface, so it never reads through the rows it passes.
      className={cn(
        "list-none",
        dragging && "relative z-10 rounded-md bg-sidebar shadow-lg ring-1 ring-border",
      )}
      style={{ transform: CSS.Translate.toString(transform) }}
    >
      {children({ ...listeners }, dragging && over !== null ? over.id === SETTLED_DROP_ID : null)}
    </li>
  );
}

/** The Settled shelf's header: a chat dropped on it is settled. */
function SettledShelfHeader({
  count,
  expanded,
  dragging,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  /** A chat at work is being carried: the header is where it can land. */
  dragging: boolean;
  onToggle: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: SETTLED_DROP_ID });
  return (
    <div ref={setNodeRef}>
      <SidebarShelfHeader
        label="Settled"
        count={count}
        expanded={expanded}
        target={dragging && isOver}
        onToggle={onToggle}
      />
    </div>
  );
}

/**
 * One chat's row with what it reads: its game's name and picture, its own state, a Try waiting on
 * a pick in it, and whether it is the row that says the game's build does not start.
 */
function ChatRow({
  row,
  place,
  siblings,
  active,
  action,
  dropping,
  renaming,
  onRename,
  onRenameDone,
  onAction,
  onOpen,
  onContextMenu,
  rowProps,
}: {
  row: Row;
  place: Place;
  /** The game's chats at work, this one among them. */
  siblings: ReadonlyArray<SidebarThreadSummary>;
  active: boolean;
  action: ChatRowAction | null;
  dropping: "settle" | "unsettle" | "carried" | null;
  renaming: boolean;
  onRename: (title: string) => void;
  onRenameDone: () => void;
  onAction: () => void;
  onOpen: () => void;
  onContextMenu: (position: { x: number; y: number }) => void;
  rowProps: Record<string, unknown>;
}) {
  const { chat, game, opens } = row;
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(active);
  const name = useGameName(game.environmentId, game.projectId, game.name);
  const builds = useEnvironmentQuerySelector(
    !leaseLiveStatus || place !== "list"
      ? null
      : gameEnvironment.builds({
          environmentId: game.environmentId,
          input: { threadId: opens.id },
        }),
    buildStateOf,
  );
  // A chat in a copy whose work did not come in waits on the person, as a question does.
  const copyPlace = useCopyPlace(
    chat.worktreePath === null || place !== "list"
      ? null
      : { environmentId: chat.environmentId, threadId: chat.id },
  );
  const copyWaits = copyPlace?.state._tag === "conflicts" || copyPlace?.state._tag === "held";
  const ownMark = place === "list" ? chatMark(chat) : null;
  // Keep going and a build being made are the game's work: the chat the game opens to shows it.
  const gameAtWork =
    place === "list" &&
    chat.id === opens.id &&
    (game.run !== null || game.operation?.state === "running");
  const mark = ownMark ?? (copyWaits ? "waiting" : gameAtWork ? "working" : null);
  // The chat whose turn made the build says it does not start; when that chat has no row at
  // work, the chat the game opens to does.
  const broken =
    builds?.broken === true &&
    (builds.brokenBy === chat.id ||
      (chat.id === opens.id && !siblings.some((other) => other.id === builds.brokenBy)));
  const title = chatTitle(chat, name);
  return (
    <div ref={rowRef}>
      <SidebarChatRow
        picture={
          <GameLibraryPicture
            game={game}
            opens={opens}
            chats={null}
            gameName={name}
            read={leaseLiveStatus}
            className="size-4"
            icon
          />
        }
        game={name}
        title={title}
        time={
          <ChatTime
            at={
              place === "settled"
                ? (chat.settledAt ?? chat.updatedAt)
                : place === "archived"
                  ? (chat.archivedAt ?? chat.updatedAt)
                  : chatActivityAt(chat)
            }
          />
        }
        active={active}
        pinned={place === "list" && chat.pinnedAt != null}
        resting={place !== "list"}
        mark={mark}
        broken={broken}
        note={place === "list" ? chatNote(chat, siblings) : null}
        action={action}
        dropping={dropping}
        renaming={
          renaming ? (
            <GameNameInput name={title} onRename={onRename} onDone={onRenameDone} className="h-6" />
          ) : null
        }
        onAction={onAction}
        onOpen={onOpen}
        onContextMenu={onContextMenu}
        rowProps={rowProps}
      />
    </div>
  );
}
