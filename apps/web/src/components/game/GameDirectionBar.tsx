import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronRightIcon, CrosshairIcon, Redo2Icon, Undo2Icon, XIcon } from "lucide-react";
import type { RunId, ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

import {
  clampGameInspectorWidth,
  useDockedInspectorWidth,
  useGameWorkspaceStore,
} from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import type { GameAgentNote } from "./gameAgentNote.logic";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { buildName, buildPhrase } from "./gameBuilds.logic";
import { clearStageSelection, useThreadStageBridge } from "./gameStageBridge";

import { useTurnUndo } from "./useBuildActions";
import { useTurnLanding } from "./useTurnLanding";

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
        // One line, so the room above the composer is one height; the whole reply is in the Log.
        render={<p className="min-w-0 flex-1 truncate" aria-live="polite" />}
      >
        {note.text}
      </Text>
      <Button size="xs" variant="ghost" onClick={onOpenLog} className="shrink-0">
        Log
        <ChevronRightIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

/**
 * The note once the latest turn's build has been undone: the agent's reply describes a game
 * that is no longer on the Stage, so this says what happened instead, with the way back.
 */
export function GameUndoneNote({
  threadRef,
  runId,
}: {
  threadRef: ScopedThreadRef;
  runId: RunId | null;
}) {
  const undo = useTurnUndo(threadRef, runId);
  const list = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  ).data;
  const view = undo.view;
  if (view === null || undo.action?.kind !== "redo") return null;
  const base = list?.builds.find((build) => build.id === view.build.base) ?? null;
  const name = buildName(view.build);
  return (
    <div className="flex items-start gap-2.5 px-4 pt-2 pb-1.5" data-game-agent-note="undone">
      <Undo2Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Text
        variant="body"
        tone="default"
        render={<p className="min-w-0 flex-1" aria-live="polite" />}
      >
        {base === null
          ? `${name} undone: the game is back to how it was before it.`
          : `${name} undone: the game is back to ${buildPhrase(buildName(base))}.`}
      </Text>
      <Button
        size="xs"
        variant="ghost"
        className="shrink-0"
        disabled={undo.action.blocked !== null || !undo.canRestore || undo.pending}
        onClick={() => void undo.send()}
      >
        <Redo2Icon aria-hidden="true" />
        {undo.restoring ? "Redoing…" : "Redo"}
      </Button>
    </div>
  );
}

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

/** The Inspector's edge: drag or arrow keys to resize it. */
export function GameInspectorResize() {
  const width = useDockedInspectorWidth();
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
