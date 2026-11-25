import type { CSSProperties, ReactNode } from "react";
import {
  ArchiveRestoreIcon,
  CircleCheckIcon,
  CircleIcon,
  ClockIcon,
  CopyIcon,
  PinIcon,
  TriangleAlertIcon,
  Undo2Icon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { DiffStatLabel, hasNonZeroStat } from "../chat/DiffStatLabel";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Spinner } from "../ui/spinner";
import { StatusDot } from "../ui/status-dot";
import { Text } from "../ui/text";
import type { ChatMark, ChatNote } from "./chatList.logic";

/** A one-line row of the sidebar's own places: New game, Search, Library, "Show 12 more". */
const SIDEBAR_ROW =
  "group/row relative flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[active=true]:surface-sidebar-row-selected";

/**
 * What a chat is doing, as the icon that leads its row: waiting on the person, at work, a build
 * that does not start, settled, or a quiet ring when it is simply there.
 */
function RowLead({ mark, broken, resting }: { mark: ChatMark; broken: boolean; resting: boolean }) {
  if (mark === "waiting")
    return (
      <span aria-label="Waiting on you" className="flex size-4 items-center justify-center">
        <StatusDot tone="warning" size="md" />
      </span>
    );
  if (mark === "working") return <Spinner size="sm" tone="muted" aria-label="Working" />;
  if (broken)
    return (
      <TriangleAlertIcon
        aria-label="Its build does not start"
        className="size-3.5 text-destructive"
      />
    );
  if (resting)
    return <CircleCheckIcon aria-label="Settled" className="size-3.5 text-dim-foreground" />;
  return <CircleIcon aria-hidden="true" className="size-3 text-dim-foreground" />;
}

/** What a row offers on hover: settle a chat at work, bring a settled or archived one back. */
export type ChatRowAction = "settle" | "unsettle" | "unarchive";
// `room` keeps the action's width on the first line while it shows, so the game's name gives way
// to it instead of running under it.
const ROW_ACTIONS = {
  settle: {
    label: "Settle",
    icon: <CircleCheckIcon aria-hidden="true" />,
    room: "group-hover/chat:min-w-14 group-has-[:focus-visible]/chat:min-w-14",
  },
  unsettle: {
    label: "Un-settle",
    icon: <Undo2Icon aria-hidden="true" />,
    room: "group-hover/chat:min-w-18 group-has-[:focus-visible]/chat:min-w-18",
  },
  unarchive: {
    label: "Unarchive",
    icon: <ArchiveRestoreIcon aria-hidden="true" />,
    room: "group-hover/chat:min-w-19 group-has-[:focus-visible]/chat:min-w-19",
  },
} as const;

function RowNote({ note }: { note: Exclude<ChatNote, null> }) {
  return (
    <Text
      variant="meta"
      tone="muted"
      data-chat-note={note.kind}
      render={<span className="mt-0.5 flex min-w-0 items-center gap-1.5 [&_svg]:size-3" />}
    >
      {note.kind === "copy" ? <CopyIcon aria-hidden="true" /> : <ClockIcon aria-hidden="true" />}
      <span className="min-w-0 truncate">
        {note.kind === "copy" ? "In a copy" : `Waits for ${note.for}`}
      </span>
    </Text>
  );
}

/**
 * A chat, as T3's thread card: its game's picture and name over its title, with when it last
 * moved. Every chat reads the same, whichever made the game. On hover the time gives way to the
 * one thing to do with it; a third line appears only when it has something to say.
 */
export function SidebarChatRow({
  picture,
  pigment,
  game,
  detail = null,
  diff = null,
  title,
  time,
  active,
  pinned = false,
  resting = false,
  mark,
  broken = false,
  note = null,
  action = null,
  dropping = null,
  renaming = null,
  onAction,
  onOpen,
  onContextMenu,
  rowProps,
}: {
  picture: ReactNode;
  /** The game's pigment: the open chat's row takes a soft tint and a thin edge in it. */
  pigment: string;
  game: string;
  /** Quiet facts after the game's name: the newest build this chat made. */
  detail?: string | null;
  /** Lines its latest file-changing turn added and removed. */
  diff?: { readonly additions: number; readonly deletions: number } | null;
  title: string;
  time: ReactNode;
  /** The chat on screen. */
  active: boolean;
  pinned?: boolean;
  /** On a shelf: its work is done or put away, so it reads quieter until it is the one open. */
  resting?: boolean;
  mark: ChatMark;
  /** The game's build does not start, and this is the row that says so. */
  broken?: boolean;
  note?: ChatNote;
  action?: ChatRowAction | null;
  /** While it is carried: what dropping it here does, or "carried" where a drop changes nothing. */
  dropping?: Exclude<ChatRowAction, "unarchive"> | "carried" | null;
  /** The title's input while the chat is renamed: the row is then no button. */
  renaming?: ReactNode;
  onAction?: () => void;
  onOpen: () => void;
  onContextMenu: (position: { x: number; y: number }) => void;
  rowProps?: Record<string, unknown>;
}) {
  // Line 1 is the chat: its title, its state, and when it last moved (or, under a pointer or
  // the keyboard, its one action). Line 2 is quiet meta: its game's tile and name.
  const body = (
    <>
      <span className="flex h-5 min-w-0 items-center gap-1.5">
        {renaming ?? (
          <Text
            variant="label"
            tone={resting && !active ? "muted" : "default"}
            truncate
            render={<span className="flex-1" />}
          >
            {title}
          </Text>
        )}
        <span
          className={cn(
            "flex h-5 shrink-0 items-center justify-end",
            action !== null &&
              dropping === null &&
              renaming === null &&
              cn(
                "group-hover/chat:invisible group-has-[:focus-visible]/chat:invisible",
                ROW_ACTIONS[action].room,
              ),
          )}
        >
          {dropping === "carried" ? null : dropping !== null ? (
            <Text
              variant="caption"
              tone="inherit"
              data-chat-drop={dropping}
              render={<span className="flex items-center gap-1 text-primary [&_svg]:size-3" />}
            >
              {ROW_ACTIONS[dropping].icon}
              {ROW_ACTIONS[dropping].label}
            </Text>
          ) : (
            <Text variant="meta" tone="dim" numeric>
              {time}
            </Text>
          )}
        </span>
      </span>
      <span className="mt-0.5 flex h-4 min-w-0 items-center gap-1.5">
        <span className="relative size-3.5 shrink-0">{picture}</span>
        {pinned ? (
          <PinIcon aria-label="Pinned" className="size-3 shrink-0 text-dim-foreground" />
        ) : null}
        <Text variant="meta" tone="muted" truncate>
          {game}
        </Text>
        {detail === null ? null : (
          <Text variant="meta" tone="dim" numeric render={<span className="shrink-0" />}>
            · {detail}
          </Text>
        )}
        {diff === null || !hasNonZeroStat(diff) ? null : (
          <Text variant="meta" tone="dim" render={<span className="ms-auto shrink-0" />}>
            <DiffStatLabel additions={diff.additions} deletions={diff.deletions} layout="inline" />
          </Text>
        )}
      </span>
      {note === null ? null : <RowNote note={note} />}
    </>
  );
  const lines = (
    <>
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">
        <RowLead mark={mark} broken={broken} resting={resting} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">{body}</span>
    </>
  );
  const surface =
    "relative flex w-full min-w-0 items-start gap-2 rounded-md ps-2 pe-2.5 py-1.5 text-left outline-none";
  return (
    <div className="group/chat relative py-0.5">
      {renaming === null ? (
        <button
          type="button"
          data-sidebar-row="chat"
          data-active={active}
          aria-current={active ? "page" : undefined}
          className={cn(
            surface,
            "cursor-pointer select-none transition-[background-color,box-shadow] not-data-[active=true]:hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            "data-[active=true]:surface-sidebar-row-pigment",
          )}
          style={{ "--row-pigment": pigment } as CSSProperties}
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
          {lines}
        </button>
      ) : (
        <div className={cn(surface, "bg-sidebar-row-hover")}>{lines}</div>
      )}
      {action === null || dropping !== null || renaming !== null ? null : (
        // Over the time's place on the first line, never inside the row's own button.
        <span className="invisible absolute end-1.5 top-2 flex h-5 items-center group-hover/chat:visible group-has-[:focus-visible]/chat:visible">
          <Button
            size="micro"
            variant="ghost-muted"
            aria-label={`${ROW_ACTIONS[action].label} ${title}`}
            data-chat-action={action}
            onClick={(event) => {
              event.stopPropagation();
              onAction?.();
            }}
          >
            {ROW_ACTIONS[action].icon}
            {ROW_ACTIONS[action].label}
          </Button>
        </span>
      )}
    </div>
  );
}

/**
 * A shelf under the chats at work: "Settled 4", "Archived 2". T3's section header: its label, a
 * rule, a count and a chevron; while a chat is dragged over it, it takes the accent to say the
 * drop lands here.
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
      data-sidebar-row="shelf"
      data-shelf={label.toLowerCase()}
      onClick={onToggle}
      accessory={count === 0 ? null : <span className="font-normal tabular-nums">{count}</span>}
    >
      {label}
    </CollapsibleSectionHeader>
  );
}

/** A group of the chats at work, by what they need: "Needs you 1", "Working 2", "Recent 5". */
export function SidebarGroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <h3 className="flex h-7 items-center gap-1.5 px-2.5" data-sidebar-group={label.toLowerCase()}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="caption" tone="dim" numeric>
        {count}
      </Text>
    </h3>
  );
}

/** A quiet row under a shelf: "Show 12 more". */
export function SidebarQuietRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-sidebar-row="more"
      className={cn(SIDEBAR_ROW, "ps-2.5")}
      onClick={onClick}
    >
      <Text variant="meta" tone="muted" truncate>
        {label}
      </Text>
    </button>
  );
}
