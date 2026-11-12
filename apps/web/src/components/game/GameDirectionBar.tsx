import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronRightIcon, CrosshairIcon, XIcon } from "lucide-react";
import type { ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

import { clampGameInspectorWidth, useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import type { GameAgentNote } from "./gameAgentNote.logic";
import { GameElapsed } from "./GameElapsed";
import { clearStageSelection, useThreadStageBridge } from "./gameStageBridge";

/**
 * The agent's latest words above the box where the person directs the game:
 * live while it works, the opening of its reply once it is done. The whole
 * conversation is a click away in the Log.
 */
export function GameDirectionNote({
  note,
  onOpenLog,
}: {
  note: GameAgentNote | null;
  onOpenLog: () => void;
}) {
  if (note === null) return null;
  return (
    <div className="flex items-start gap-2.5 px-4 pt-2 pb-1.5" data-game-agent-note="">
      <span
        aria-hidden="true"
        className="mt-1.5 size-1.5 shrink-0 rounded-full bg-live data-[idle=true]:bg-dim-foreground"
        data-idle={note.live ? "false" : "true"}
      />
      <Text
        variant="body"
        tone={note.live ? "strong" : "default"}
        render={<p className="line-clamp-2 min-w-0 flex-1" aria-live="polite" />}
      >
        {note.text}
        {note.live && note.since !== null ? (
          <Text variant="meta" tone="muted" numeric>
            <GameElapsed since={note.since} prefix="  " />
          </Text>
        ) : null}
      </Text>
      <Button size="xs" variant="ghost" onClick={onOpenLog} className="shrink-0">
        Log
        <ChevronRightIcon aria-hidden="true" />
      </Button>
    </div>
  );
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

/** The Inspector's edge: drag or arrow keys to resize it. */
export function GameInspectorResize() {
  const width = useGameWorkspaceStore((state) => state.inspectorWidth);
  const setWidth = useGameWorkspaceStore((state) => state.setInspectorWidth);
  const drag = useRef<{ x: number; width: number; workspace: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const workspaceOf = (node: HTMLElement) =>
    node.parentElement?.parentElement?.clientWidth ?? window.innerWidth;
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width, workspace: workspaceOf(event.currentTarget) };
    setDragging(true);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (from === null) return;
    setWidth(clampGameInspectorWidth(from.width - (event.clientX - from.x), from.workspace));
  };
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the Inspector"
      aria-valuenow={width}
      tabIndex={0}
      data-dragging={dragging ? "true" : "false"}
      className={cn(
        "absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none select-none",
        "hover:bg-primary/40 focus-visible:bg-primary/40 data-[dragging=true]:bg-primary/60",
      )}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(event) => {
        const workspace = workspaceOf(event.currentTarget);
        if (event.key === "ArrowLeft") setWidth(clampGameInspectorWidth(width + 24, workspace));
        else if (event.key === "ArrowRight")
          setWidth(clampGameInspectorWidth(width - 24, workspace));
        else return;
        event.preventDefault();
      }}
    />
  );
}
