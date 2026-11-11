import { SearchIcon, SquarePenIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Kbd } from "../ui/kbd";
import { SidebarMenuButton } from "../ui/sidebar";
import { Text } from "../ui/text";

export interface SidebarThreadHeaderProps {
  onNewGame: () => void;
  newGameShortcutLabel: string | null;
  /** Opens the command palette, which finds games, chats and what was said in them. */
  onSearch: () => void;
  searchShortcutLabel: string | null;
}

/** The sidebar's two quiet rows: one way to start a game, one way to find anything. */
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
        muted
        onClick={onSearch}
      />
      <Text variant="meta" tone="dim" render={<h2 className="px-2 pt-4 pb-1" />}>
        Games
      </Text>
    </div>
  );
}

function SidebarHeaderRow({
  icon,
  label,
  shortcut,
  muted = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  shortcut: string | null;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <SidebarMenuButton type="button" onClick={onClick}>
      {icon}
      <Text variant="label" tone={muted ? "muted" : "default"} truncate>
        {label}
      </Text>
      {shortcut === null ? null : <Kbd className="ms-auto">{shortcut}</Kbd>}
    </SidebarMenuButton>
  );
}
