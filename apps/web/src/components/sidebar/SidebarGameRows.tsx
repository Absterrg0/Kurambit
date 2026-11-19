import type { ReactNode } from "react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CircleCheckIcon,
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
  Undo2Icon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
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
  selected,
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
  onNewChatInCopy = null,
  onAction,
  onContextMenu,
  rowProps,
}: {
  picture: ReactNode;
  name: ReactNode;
  /** A chat of this game is on screen. */
  active: boolean;
  /** This row is the one on screen: the game's own chat, or the folded game of the open chat. */
  selected: boolean;
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
  /** Once copies have arrived, + offers a new chat in the game or in a copy. */
  onNewChatInCopy?: (() => void) | null;
  onAction: (action: GameAction) => void;
  onContextMenu: (position: { x: number; y: number }) => void;
  rowProps?: Record<string, unknown>;
}) {
  return (
    <div className="group/game relative">
      <button
        type="button"
        data-tree-row="game"
        data-active={selected}
        aria-current={selected ? "page" : undefined}
        aria-expanded={expandable ? expanded : undefined}
        className={cn(SIDEBAR_TREE_ROW, "pe-1")}
        onClick={(event) => {
          if (event.detail > 1) return;
          // The game's row opens the game's own chat; a click on it while it is the one on
          // screen folds its other chats.
          if (selected && expandable) onToggle();
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
        {onNewChat === null ? null : onNewChatInCopy !== null ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="New chat"
                  onClick={(event) => event.stopPropagation()}
                />
              }
            >
              <PlusIcon aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="start" side="bottom">
              <MenuItem onClick={onNewChat}>
                <SquarePenIcon />
                New chat in the game
              </MenuItem>
              <MenuItem onClick={onNewChatInCopy}>
                <CopyIcon />
                New chat in a copy
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : (
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

/** What a chat row offers on hover: settle one at work, bring a settled one back. */
export type ChatRowAction = "settle" | "unsettle";
const CHAT_ROW_ACTIONS = {
  settle: { label: "Settle", icon: <CircleCheckIcon aria-hidden="true" /> },
  unsettle: { label: "Un-settle", icon: <Undo2Icon aria-hidden="true" /> },
} as const;

/**
 * A chat: its title, when it last moved, and its mark. Under its game it is indented; in the
 * Settled shelf, where games mix, it leads with its game's picture. On hover its time gives way
 * to the one thing to do with it.
 */
export function SidebarChatRow({
  title,
  time,
  active,
  copy = false,
  mark,
  picture = null,
  game = null,
  action = null,
  dropping = null,
  onAction,
  onOpen,
  onContextMenu,
  rowProps,
}: {
  title: ReactNode;
  time: ReactNode;
  active: boolean;
  /** The chat works in a copy of the game. */
  copy?: boolean;
  mark: GameTreeMark;
  /** Its game's picture, where the row is not under its game. */
  picture?: ReactNode;
  /** Its game's name, said on its picture where the row is not under its game. */
  game?: string | null;
  action?: ChatRowAction | null;
  /** While it is carried: what dropping it here does, or "carried" where a drop changes nothing. */
  dropping?: ChatRowAction | "carried" | null;
  onAction?: () => void;
  onOpen: () => void;
  onContextMenu: (position: { x: number; y: number }) => void;
  rowProps?: Record<string, unknown>;
}) {
  return (
    <div className="group/chat relative">
      <button
        type="button"
        data-tree-row="chat"
        data-active={active}
        aria-current={active ? "page" : undefined}
        className={cn(SIDEBAR_TREE_ROW, picture === null ? "ps-8 pe-2" : "pe-2")}
        onClick={(event) => {
          if (event.detail > 1) return;
          onOpen();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu({ x: event.clientX, y: event.clientY });
        }}
        {...rowProps}
      >
        {picture === null ? null : (
          <Tooltip>
            <TooltipTrigger render={<span className="relative size-5 shrink-0" />}>
              {picture}
            </TooltipTrigger>
            {game === null ? null : <TooltipPopup side="top">{game}</TooltipPopup>}
          </Tooltip>
        )}
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
        {/* The state, until a pointer or the keyboard is on the row: then its action. */}
        <span
          className={cn(
            "flex h-5 shrink-0 items-center justify-end",
            action !== null &&
              dropping === null &&
              "group-hover/chat:invisible group-focus-within/chat:invisible",
          )}
        >
          {dropping === "carried" ? null : dropping !== null ? (
            <Text
              variant="caption"
              tone="inherit"
              data-chat-drop={dropping}
              render={<span className="flex items-center gap-1 text-primary [&_svg]:size-3.5" />}
            >
              {CHAT_ROW_ACTIONS[dropping].icon}
              {CHAT_ROW_ACTIONS[dropping].label}
            </Text>
          ) : mark === null ? (
            <Text variant="caption" tone="dim" numeric>
              {time}
            </Text>
          ) : (
            <span className="flex size-4 items-center justify-center">
              <TreeMark mark={mark} />
            </span>
          )}
        </span>
      </button>
      {action === null || dropping !== null ? null : (
        <span className="invisible absolute inset-y-0 end-1 flex items-center group-hover/chat:visible group-focus-within/chat:visible">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`${CHAT_ROW_ACTIONS[action].label} ${typeof title === "string" ? title : "chat"}`}
                  data-chat-action={action}
                  onClick={(event) => {
                    event.stopPropagation();
                    onAction?.();
                  }}
                />
              }
            >
              {CHAT_ROW_ACTIONS[action].icon}
            </TooltipTrigger>
            <TooltipPopup side="top">{CHAT_ROW_ACTIONS[action].label}</TooltipPopup>
          </Tooltip>
        </span>
      )}
    </div>
  );
}

/**
 * A shelf under the games: "Settled 4", "Archived 2". T3's section header: its label, a rule and
 * a chevron; while a chat is dragged over it, it takes the accent to say the drop lands here.
 */
export function SidebarShelfHeader({
  label,
  count,
  expanded,
  target = false,
  onToggle,
}: {
  label: string;
  count: number;
  expanded: boolean;
  /** A dragged chat is over it. */
  target?: boolean;
  onToggle: () => void;
}) {
  return (
    <CollapsibleSectionHeader
      expanded={expanded}
      tone={target ? "accent" : "muted"}
      data-tree-row="shelf"
      data-shelf={label.toLowerCase()}
      onClick={onToggle}
    >
      {label}
      {count === 0 ? null : <span className="ms-1.5 tabular-nums opacity-70">{count}</span>}
    </CollapsibleSectionHeader>
  );
}

/** A quiet row in the tree: "Show 12 more". */
export function SidebarQuietRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-tree-row="more"
      className={cn(SIDEBAR_TREE_ROW, "ps-8")}
      onClick={onClick}
    >
      <Text variant="meta" tone="muted" truncate>
        {label}
      </Text>
    </button>
  );
}
