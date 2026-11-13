import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { CrosshairIcon, Gamepad2Icon, ListChecksIcon, XIcon } from "lucide-react";
import type { RunId, ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { clearStageSelection, useThreadStageBridge } from "./gameStageBridge";
import {
  showGameBuilds,
  showGameInPanel,
  useGameBuildsShown,
  useGameShownInPanel,
} from "./gameRightPanel";

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
 * The line between the game and the chat under it: drag it, or use the arrow keys, to give
 * the game more or less of the column.
 */
export function GameStageResize() {
  const share = useGameWorkspaceStore((state) => state.gameStageShare);
  const setShare = useGameWorkspaceStore((state) => state.setGameStageShare);
  const [dragging, setDragging] = useState(false);
  const columnOf = (node: HTMLElement) => node.parentElement?.getBoundingClientRect() ?? null;
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const column = columnOf(event.currentTarget);
    if (column === null || column.height === 0) return;
    setShare((event.clientY - column.top) / column.height);
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
      aria-label="Resize the game"
      aria-valuenow={Math.round(share * 100)}
      tabIndex={0}
      data-dragging={dragging ? "true" : "false"}
      className={cn(
        "relative z-20 -my-1 h-2 shrink-0 cursor-row-resize touch-none select-none",
        "after:absolute after:inset-x-0 after:top-1/2 after:h-px after:bg-border",
        "hover:after:h-0.5 hover:after:bg-primary/50 focus-visible:after:h-0.5 focus-visible:after:bg-primary/50 data-[dragging=true]:after:h-0.5 data-[dragging=true]:after:bg-primary/70",
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
        if (event.key === "ArrowUp") setShare(share - 0.04);
        else if (event.key === "ArrowDown") setShare(share + 0.04);
        else return;
        event.preventDefault();
      }}
    />
  );
}

/**
 * The chat's header when the game plays beside it, as a tab of the right panel: the chat's
 * name, and the ways back to the game and its builds when the panel shows neither.
 */
export function GameChatHeader({
  threadRef,
  title,
}: {
  threadRef: ScopedThreadRef;
  title: string;
}) {
  const gameShown = useGameShownInPanel(threadRef);
  const buildsShown = useGameBuildsShown(threadRef);
  return (
    <div className="flex h-full min-w-0 flex-1 items-center gap-1.5">
      <Text variant="label" tone="strong" truncate render={<h1 className="min-w-0" />}>
        {title}
      </Text>
      <span className="min-w-2 flex-1" />
      {gameShown ? null : (
        <Button size="sm" variant="ghost" onClick={() => showGameInPanel(threadRef)}>
          <Gamepad2Icon aria-hidden="true" />
          Game
        </Button>
      )}
      {buildsShown ? null : (
        <Button size="sm" variant="ghost" onClick={() => showGameBuilds(threadRef)}>
          <ListChecksIcon aria-hidden="true" />
          Builds
        </Button>
      )}
    </div>
  );
}
