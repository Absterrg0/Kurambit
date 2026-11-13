import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { CrosshairIcon, XIcon } from "lucide-react";
import type { RunId, ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

import { clampGameDockHeight, useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { clearStageSelection, useThreadStageBridge } from "./gameStageBridge";

import { useTurnUndo } from "./useBuildActions";

/** The latest turn's build was undone: its reply and its Next no longer describe the game. */
export function useLatestTurnUndone(threadRef: ScopedThreadRef | null, runId: RunId | null) {
  return useTurnUndo(threadRef, runId).action?.kind === "redo";
}

/**
 * The thing pointed at on the frozen Stage, attached to the next message: the
 * frame, what the thing is and its values go with it. The × stops pointing.
 */
export function GamePointedChip({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thing = useThreadStageBridge(
    scopedThreadKey(threadRef),
    (state) => state.selected?.thing ?? null,
    null,
  );
  if (thing === null) return null;
  return (
    <div className="flex min-w-0 items-center gap-2 px-4 pb-1.5" data-game-pointed="">
      <span className="flex h-6 min-w-0 items-center gap-1.5 rounded-md bg-primary/15 ps-2 pe-0.5 text-strong-foreground">
        <CrosshairIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <Text variant="meta" tone="inherit" truncate>
          {thing.name}
        </Text>
        <Button
          size="icon-micro"
          variant="ghost"
          aria-label={`Stop pointing at the ${thing.name.toLowerCase()}`}
          onClick={clearStageSelection}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </span>
      <Text variant="caption" tone="muted" truncate>
        Goes with your next message, with this frame and its values
      </Text>
    </div>
  );
}

/**
 * The line between the game and the dock under it: drag it, or use the arrow keys, to give the
 * dock more or less of the column.
 */
export function GameDockResize() {
  const height = useGameWorkspaceStore((state) => state.dockHeight);
  const setHeight = useGameWorkspaceStore((state) => state.setDockHeight);
  const [dragging, setDragging] = useState(false);
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const column = event.currentTarget.parentElement?.getBoundingClientRect();
    if (column === undefined) return;
    setHeight(clampGameDockHeight(column.bottom - event.clientY, column.height));
  };
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the dock"
      aria-valuenow={height}
      tabIndex={0}
      data-dragging={dragging ? "true" : "false"}
      className={cn(
        "relative z-20 -my-1 h-2 shrink-0 cursor-row-resize touch-none select-none outline-none",
        "after:absolute after:inset-x-0 after:top-1/2 after:h-px after:bg-border",
        "hover:after:bg-primary/60 focus-visible:after:bg-primary/60 data-[dragging=true]:after:bg-primary",
      )}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") setHeight(height + 24);
        else if (event.key === "ArrowDown") setHeight(height - 24);
        else return;
        event.preventDefault();
      }}
    />
  );
}
