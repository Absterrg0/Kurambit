import { PlusIcon, SearchIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { Tooltip, TooltipLabel, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadHeaderProps {
  onNewGame: () => void;
  newGameShortcutLabel: string | null;
  /** Opens the command palette, which finds games, chats and what was said. */
  onSearch: () => void;
  searchShortcutLabel: string | null;
}

/** The chats' section header, with its two ways in inline: find anything, start a game. */
export function SidebarThreadHeader({
  onNewGame,
  newGameShortcutLabel,
  onSearch,
  searchShortcutLabel,
}: SidebarThreadHeaderProps) {
  return (
    <div className="flex h-8 items-center gap-0.5 ps-2.5 pe-1">
      <Text variant="label" render={<h2 className="min-w-0 flex-1 truncate" />}>
        Chats
      </Text>
      <HeaderAction label="Search" shortcut={searchShortcutLabel} onClick={onSearch}>
        <SearchIcon />
      </HeaderAction>
      <HeaderAction label="New game" shortcut={newGameShortcutLabel} onClick={onNewGame}>
        <PlusIcon />
      </HeaderAction>
    </div>
  );
}

function HeaderAction({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  shortcut: string | null;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="icon-xs" variant="ghost-muted" aria-label={label} onClick={onClick} />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <TooltipLabel shortcut={shortcut}>{label}</TooltipLabel>
      </TooltipPopup>
    </Tooltip>
  );
}
