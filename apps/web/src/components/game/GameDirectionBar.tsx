import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { CrosshairIcon, Gamepad2Icon, PanelRightIcon, XIcon } from "lucide-react";
import type { RunId, ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

import {
  clampGameColumnWidth,
  clampGameInspectorWidth,
  useDockedInspectorWidth,
  useGameWorkspaceStore,
} from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { clearStageSelection, useThreadStageBridge } from "./gameStageBridge";

import { useTurnUndo } from "./useBuildActions";
import { useTurnLanding } from "./useTurnLanding";

/**
 * The game has no build yet while its first turn runs or its build is saved: the Stage shows
 * the making card, with the agent's words.
 */
export function useGameMakingFirstBuild(
  threadRef: ScopedThreadRef | null,
  working: boolean,
): boolean {
  const landing = useTurnLanding(threadRef, working);
  const list = useEnvironmentQuery(
    threadRef === null
      ? null
      : gameEnvironment.builds({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
  ).data;
  return threadRef !== null && (working || landing) && list !== null && list.builds.length === 0;
}

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
 * A column's left edge, for a column on the workspace's right: drag or arrow keys to resize
 * it. `clamp` fits a width to the workspace row it lives in.
 */
function ColumnEdgeResize({
  label,
  width,
  setWidth,
  clamp,
}: {
  label: string;
  width: number;
  setWidth: (width: number) => void;
  clamp: (width: number, workspace: number) => number;
}) {
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
    setWidth(clamp(from.width - (event.clientX - from.x), from.workspace));
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
      aria-label={label}
      aria-valuenow={width}
      tabIndex={0}
      data-dragging={dragging ? "true" : "false"}
      className={cn(
        "absolute inset-y-0 left-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize touch-none select-none",
        "hover:bg-primary/40 focus-visible:bg-primary/40 data-[dragging=true]:bg-primary/60",
      )}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(event) => {
        const workspace = workspaceOf(event.currentTarget);
        if (event.key === "ArrowLeft") setWidth(clamp(width + 24, workspace));
        else if (event.key === "ArrowRight") setWidth(clamp(width - 24, workspace));
        else return;
        event.preventDefault();
      }}
    />
  );
}

/** The builds panel's edge. */
export function GameInspectorResize() {
  const width = useDockedInspectorWidth();
  const setWidth = useGameWorkspaceStore((state) => state.setInspectorWidth);
  return (
    <ColumnEdgeResize
      label="Resize builds"
      width={width}
      setWidth={setWidth}
      clamp={clampGameInspectorWidth}
    />
  );
}

/** The game's column's edge, when it plays beside the chat. */
export function GameColumnResize() {
  const width = useGameWorkspaceStore((state) => state.gameColumnWidth);
  const setWidth = useGameWorkspaceStore((state) => state.setGameColumnWidth);
  return (
    <ColumnEdgeResize
      label="Resize the game"
      width={width}
      setWidth={setWidth}
      clamp={clampGameColumnWidth}
    />
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
 * The chat's header when the game plays in its own column: the game's name, and the ways back
 * to the game and to its builds when either is folded away.
 */
export function GameChatHeader({
  title,
  gameHidden,
}: {
  threadRef: ScopedThreadRef;
  title: string;
  gameHidden: boolean;
}) {
  const setGameView = useGameWorkspaceStore((state) => state.setGameView);
  const buildsHidden = useGameWorkspaceStore((state) => state.inspectorCollapsed);
  const setBuildsHidden = useGameWorkspaceStore((state) => state.setInspectorCollapsed);
  return (
    <div className="flex h-full min-w-0 flex-1 items-center gap-1.5">
      <Text variant="label" tone="strong" truncate render={<h1 className="min-w-0" />}>
        {title}
      </Text>
      <span className="min-w-2 flex-1" />
      {gameHidden ? (
        <Button size="sm" variant="ghost" onClick={() => setGameView("split")}>
          <Gamepad2Icon aria-hidden="true" />
          Show the game
        </Button>
      ) : null}
      {buildsHidden ? (
        <Button size="sm" variant="ghost" onClick={() => setBuildsHidden(false)}>
          <PanelRightIcon aria-hidden="true" />
          Builds
        </Button>
      ) : null}
    </div>
  );
}
