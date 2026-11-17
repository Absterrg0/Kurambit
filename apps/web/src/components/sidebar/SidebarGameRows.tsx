import type { ReactNode } from "react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronRightIcon,
  CopyIcon,
  EllipsisIcon,
  FolderOpenIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SquarePenIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { StatusDot } from "../ui/status-dot";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { GameTreeMark } from "./gameTree.logic";

/** A game's menu, the same for its ⋯ and a right-click. */
export type GameAction =
  | "new-chat"
  | "rename"
  | "open-folder"
  | "pin"
  | "unpin"
  | "archive"
  | "unarchive"
  | "delete";

export interface GameActionItem {
  readonly id: GameAction;
  readonly label: string;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly separatorBefore?: boolean;
}

const ACTION_ICONS: Record<GameAction, ReactNode> = {
  "new-chat": <SquarePenIcon />,
  rename: <PencilIcon />,
  "open-folder": <FolderOpenIcon />,
  pin: <PinIcon />,
  unpin: <PinOffIcon />,
  archive: <ArchiveIcon />,
  unarchive: <ArchiveRestoreIcon />,
  delete: <Trash2Icon />,
};
/** The right-click menu's icon names for the same actions (contextMenuFallback's set). */
export const NATIVE_ACTION_ICONS: Record<GameAction, string> = {
  "new-chat": "message-square-plus",
  rename: "pencil",
  "open-folder": "folder",
  pin: "pin",
  unpin: "pin-off",
  archive: "archive",
  unarchive: "archive",
  delete: "trash",
};

/** One row of the tree: 28 px, 12 px from the sidebar's edge, a ring only for the keyboard. */
export const SIDEBAR_TREE_ROW =
  "group/row relative flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[active=true]:surface-sidebar-row-selected";

/** What a game or chat is doing, in one mark at the row's end; nothing when idle. */
function TreeMark({ mark, broken }: { mark: GameTreeMark; broken?: boolean }) {
  if (mark === "waiting")
    return (
      <span className="flex size-4 items-center justify-center" aria-label="Waiting on you">
        <StatusDot tone="warning" size="md" />
      </span>
    );
  if (mark === "working") return <Spinner size="sm" tone="muted" aria-label="Working" />;
  if (broken === true)
    return (
      <TriangleAlertIcon
        aria-label="Its build does not start"
        className="size-3.5 shrink-0 text-destructive"
      />
    );
  return null;
}

function GameMenuItems({
  items,
  onAction,
}: {
  items: ReadonlyArray<GameActionItem>;
  onAction: (action: GameAction) => void;
}) {
  return items.map((item) => (
    <MenuItemWithSeparator key={item.id} item={item} onAction={onAction} />
  ));
}

function MenuItemWithSeparator({
  item,
  onAction,
}: {
  item: GameActionItem;
  onAction: (action: GameAction) => void;
}) {
  return (
    <>
      {item.separatorBefore === true ? <MenuSeparator /> : null}
      <MenuItem
        disabled={item.disabled}
        variant={item.destructive === true ? "destructive" : "default"}
        onClick={() => onAction(item.id)}
      >
        {ACTION_ICONS[item.id]}
        {item.label}
      </MenuItem>
    </>
  );
}

/** A game: its picture, its name, its state; on hover, New chat and its menu. */
export function SidebarGameRow({
  picture,
  name,
  active,
  expanded,
  expandable,
  mark,
  broken,
  muted = false,
  menu,
  newChatLabel,
  onOpen,
  onToggle,
  onNewChat,
  onAction,
  onContextMenu,
  rowProps,
}: {
  picture: ReactNode;
  name: ReactNode;
  active: boolean;
  expanded: boolean;
  expandable: boolean;
  mark: GameTreeMark;
  broken: boolean;
  muted?: boolean;
  menu: ReadonlyArray<GameActionItem>;
  newChatLabel: string | null;
  onOpen: () => void;
  onToggle: () => void;
  onNewChat: (() => void) | null;
  onAction: (action: GameAction) => void;
  onContextMenu: (position: { x: number; y: number }) => void;
  rowProps?: Record<string, unknown>;
}) {
  return (
    <div className="group/game relative">
      <button
        type="button"
        data-tree-row="game"
        // The open chat is the highlighted row; the game carries it only while folded.
        data-active={active && !expanded}
        aria-expanded={expandable ? expanded : undefined}
        className={cn(SIDEBAR_TREE_ROW, "pe-1")}
        onClick={(event) => {
          if (event.detail > 1) return;
          // Opening a game that is not open also unfolds it; a click on the open one folds it.
          if (active && expandable) onToggle();
          else onOpen();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" && expandable && !expanded) {
            event.preventDefault();
            event.stopPropagation();
            onToggle();
          }
          if (event.key === "ArrowLeft" && expandable && expanded) {
            event.preventDefault();
            event.stopPropagation();
            onToggle();
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu({ x: event.clientX, y: event.clientY });
        }}
        {...rowProps}
      >
        <span className="relative size-5 shrink-0">{picture}</span>
        <Text
          variant="label"
          tone={muted ? "muted" : active ? "strong" : "default"}
          truncate
          render={<span className="min-w-0 flex-1" />}
        >
          {name}
        </Text>
        {/* The state, until a pointer or the keyboard is on the row: then its two actions. */}
        <span className="flex h-5 shrink-0 items-center justify-end group-hover/game:invisible group-focus-within/game:invisible">
          <TreeMark mark={mark} broken={broken} />
        </span>
      </button>
      <span className="invisible absolute inset-y-0 end-1 flex items-center gap-0.5 group-hover/game:visible group-focus-within/game:visible has-[[data-popup-open]]:visible">
        {onNewChat === null ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="New chat"
                  onClick={(event) => {
                    event.stopPropagation();
                    onNewChat();
                  }}
                />
              }
            >
              <PlusIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup side="top">{newChatLabel ?? "New chat"}</TooltipPopup>
          </Tooltip>
        )}
        <Menu>
          <MenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label="Game actions" />}>
            <EllipsisIcon aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="start" side="bottom">
            <GameMenuItems items={menu} onAction={onAction} />
          </MenuPopup>
        </Menu>
      </span>
    </div>
  );
}

/** A chat under its game: its title, when it last moved, and its mark. */
export function SidebarChatRow({
  title,
  time,
  active,
  copy = false,
  mark,
  onOpen,
  onContextMenu,
  onPointerDown,
}: {
  title: ReactNode;
  time: ReactNode;
  active: boolean;
  /** The chat works in a copy of the game. */
  copy?: boolean;
  mark: GameTreeMark;
  onOpen: () => void;
  onContextMenu: (position: { x: number; y: number }) => void;
  onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      data-tree-row="chat"
      data-active={active}
      aria-current={active ? "page" : undefined}
      className={cn(SIDEBAR_TREE_ROW, "ps-8 pe-2")}
      onClick={(event) => {
        if (event.detail > 1) return;
        onOpen();
      }}
      onPointerDown={onPointerDown}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <Text
        variant="label"
        tone={active ? "default" : "muted"}
        truncate
        render={<span className="min-w-0 flex-1" />}
      >
        {title}
      </Text>
      {copy ? (
        <CopyIcon
          aria-label="Works in a copy"
          data-copy-glyph=""
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      ) : null}
      {mark === null ? (
        <Text variant="caption" tone="dim" numeric render={<span className="shrink-0" />}>
          {time}
        </Text>
      ) : (
        <span className="flex size-4 shrink-0 items-center justify-center">
          <TreeMark mark={mark} />
        </span>
      )}
    </button>
  );
}

/** A quiet row in the tree: "Show 3 more", "Archived (2)". */
export function SidebarQuietRow({
  label,
  count,
  expanded,
  indent = false,
  onClick,
}: {
  label: string;
  count?: number;
  expanded?: boolean;
  indent?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-tree-row="more"
      aria-expanded={expanded}
      className={cn(SIDEBAR_TREE_ROW, indent ? "ps-8" : "ps-1")}
      onClick={onClick}
    >
      {expanded === undefined ? null : (
        <span className="flex size-5 shrink-0 items-center justify-center">
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 text-dim-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
        </span>
      )}
      <Text variant="meta" tone="muted" truncate>
        {label}
      </Text>
      {count === undefined ? null : (
        <Text variant="caption" tone="dim" numeric>
          {count}
        </Text>
      )}
    </button>
  );
}
