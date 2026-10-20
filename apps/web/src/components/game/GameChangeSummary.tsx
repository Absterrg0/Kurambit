import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { RunId } from "@t3tools/contracts";

import type { TurnDiffFileChange } from "../../types";
import { cn } from "../../lib/utils";
import { ChangedFilesCard, type ChangedFileContextMenuHandler } from "../chat/ChangedFilesTree";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatGameChangeSummary, groupGameChanges } from "./gameChangeSummary";

/**
 * A game turn's changes in the language of the game: one quiet line, and the
 * file tree behind it for anyone who wants to look. The tree, its folder
 * expansion and "Open diff" are the existing card, not a second copy.
 */
export function GameChangeSummary({
  runId,
  files,
  resolvedTheme,
  allDirectoriesExpanded,
  onToggleAllDirectories,
  onOpenTurnDiff,
  onFileContextMenu,
}: {
  runId: RunId;
  files: ReadonlyArray<TurnDiffFileChange>;
  resolvedTheme: "light" | "dark";
  allDirectoriesExpanded: boolean;
  onToggleAllDirectories: () => void;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
  onFileContextMenu?: ChangedFileContextMenuHandler | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const groups = groupGameChanges(files);
  const fullSummary = formatGameChangeSummary(groups);
  // The row already follows an assistant turn, so the leading "Changed" only
  // costs width. The full sentence is still the button's accessible name.
  const summary = formatGameChangeSummary(groups, 3).replace(/^Changed /, "");
  return (
    <div className="mt-3" data-game-change-summary data-expanded={expanded ? "true" : "false"}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={fullSummary}
        onClick={() => setExpanded((value) => !value)}
        className="group flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-2xs transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:text-muted-foreground",
            expanded && "rotate-90",
          )}
        />
        <Tooltip>
          <TooltipTrigger
            render={<span className="min-w-0 truncate font-medium text-foreground/80" />}
          >
            {summary}
          </TooltipTrigger>
          <TooltipPopup side="top">{fullSummary}</TooltipPopup>
        </Tooltip>
      </button>
      {expanded ? (
        <ChangedFilesCard
          runId={runId}
          files={files}
          allDirectoriesExpanded={allDirectoriesExpanded}
          resolvedTheme={resolvedTheme}
          onToggleAllDirectories={onToggleAllDirectories}
          onOpenTurnDiff={onOpenTurnDiff}
          onFileContextMenu={onFileContextMenu}
        />
      ) : null}
    </div>
  );
}
