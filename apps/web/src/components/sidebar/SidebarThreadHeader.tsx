import { LibraryBigIcon, SearchIcon, SquarePenIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Kbd } from "../ui/kbd";
import { SidebarMenuButton } from "../ui/sidebar";
import { Text } from "../ui/text";

export interface SidebarThreadHeaderProps {
  onNewGame: () => void;
  newGameShortcutLabel: string | null;
  /** Opens the command palette, which finds games, chats, Library assets and what was said. */
  onSearch: () => void;
  searchShortcutLabel: string | null;
  libraryOpen: boolean;
  onLibrary: () => void;
}

/** The sidebar's places: start a game, find anything, and every asset you have. */
export function SidebarThreadHeader({
  onNewGame,
  newGameShortcutLabel,
  onSearch,
  searchShortcutLabel,
  libraryOpen,
  onLibrary,
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
      <SidebarHeaderRow
        icon={<LibraryBigIcon />}
        label="Library"
        shortcut={null}
        active={libraryOpen}
        onClick={onLibrary}
      />
    </div>
  );
}

function SidebarHeaderRow({
  icon,
  label,
  shortcut,
  active = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  shortcut: string | null;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <SidebarMenuButton
      type="button"
      isActive={active}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className="group/header-row h-7 px-1"
    >
      {icon}
      <Text variant="label" tone={active ? "default" : "muted"} truncate>
        {label}
      </Text>
      {/* The shortcut is a reminder for the row in hand; at rest it only crowds the column. */}
      {shortcut === null ? null : (
        <span className="ms-auto opacity-0 transition-opacity group-hover/header-row:opacity-100 group-focus-visible/header-row:opacity-100">
          <Kbd>{shortcut}</Kbd>
        </span>
      )}
    </SidebarMenuButton>
  );
}
