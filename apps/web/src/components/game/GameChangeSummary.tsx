import { useState } from "react";
import { ChevronRightIcon, FileDiffIcon } from "lucide-react";
import type { RunId } from "@t3tools/contracts";

import type { TurnDiffFileChange } from "../../types";
import { cn } from "../../lib/utils";
import { ChangedFilesCard, type ChangedFileContextMenuHandler } from "../chat/ChangedFilesTree";
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
  const summary = formatGameChangeSummary(groupGameChanges(files));
  return (
    <div className="mt-3" data-game-change-summary data-expanded={expanded ? "true" : "false"}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:text-muted-foreground",
            expanded && "rotate-90",
          )}
        />
        <FileDiffIcon className="size-3.5 shrink-0 text-muted-foreground/80" aria-hidden="true" />
        <span className="min-w-0 truncate font-medium text-foreground/80">{summary}</span>
        <span className="ml-auto shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          {expanded ? "Hide files" : "Files"}
        </span>
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
