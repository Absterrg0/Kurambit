import { SearchIcon, SquarePenIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ArrivalDot } from "../game/ArrivalDot";
import { Kbd } from "../ui/kbd";
import { Text } from "../ui/text";
import { SIDEBAR_ROW } from "./SidebarChatRows";

export interface SidebarThreadHeaderProps {
  onNewGame: () => void;
  newGameShortcutLabel: string | null;
  /** Opens the command palette, which finds games, chats and what was said. */
  onSearch: () => void;
  searchShortcutLabel: string | null;
}

/** The sidebar's places: start a game, and find anything. */
export function SidebarThreadHeader({
  onNewGame,
  newGameShortcutLabel,
  onSearch,
  searchShortcutLabel,
}: SidebarThreadHeaderProps) {
  return (
    <div className="flex flex-col gap-px">
      <SidebarHeaderRow
        icon={<SquarePenIcon />}
        label="New game"
        shortcut={newGameShortcutLabel}
        onClick={onNewGame}
      />
      <SidebarHeaderRow
        icon={<SearchIcon />}
        label="Search"
        shortcut={searchShortcutLabel}
        onClick={onSearch}
      />
    </div>
  );
}

function SidebarHeaderRow({
  icon,
  label,
  shortcut,
  active = false,
  news = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  shortcut: string | null;
  active?: boolean;
  /** Just arrived and not opened yet. */
  news?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-active={active}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={SIDEBAR_ROW}
    >
      {/* The icon sits where a game's picture does, so the column reads as one list. */}
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <Text variant="label" tone={active ? "default" : "muted"} truncate>
        {label}
      </Text>
      <ArrivalDot on={news} />
      {/* The shortcut is a reminder for the row in hand; at rest it only crowds the column. */}
      {shortcut === null ? null : (
        <span className="ms-auto opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100">
          <Kbd>{shortcut}</Kbd>
        </span>
      )}
    </button>
  );
}
