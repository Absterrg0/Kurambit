import { useState } from "react";

import { useDockedInspectorWidth, useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { Skeleton } from "../ui/skeleton";
import { GameStageLoading } from "./GameStage";
import { useGameWorkspaceCompact } from "./useGameWorkspaceCompact";

/**
 * The game screen before its thread is known (a cold load, between the splash and the first
 * snapshot): the loaded screen's own columns, with a Stage that says it is opening. The working
 * area is never blank beside the sidebar's placeholders, and nothing moves when the game arrives.
 */
export function GameOpening() {
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const compact = useGameWorkspaceCompact(row, true);
  const collapsed = useGameWorkspaceStore((state) => state.inspectorCollapsed);
  const inspectorWidth = useDockedInspectorWidth();
  return (
    <div
      ref={setRow}
      aria-busy="true"
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      <div data-game-centre="" className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <GameStageLoading />
        {/* The composer's place: its box, then the room its hint line and bottom edge take. */}
        <div
          aria-hidden="true"
          className="mx-auto w-full max-w-(--game-stage-column) shrink-0 px-3 pb-14"
        >
          <Skeleton shape="card" className="h-20 w-full" />
        </div>
      </div>
      {compact || collapsed ? null : (
        // The Inspector's place, in the shape its own first read has.
        <div
          aria-hidden="true"
          className="flex shrink-0 flex-col gap-5 p-4 pt-(--workspace-topbar-height)"
          style={{ width: inspectorWidth }}
        >
          <div className="flex items-center gap-3 pt-4">
            <Skeleton shape="card" className="h-12 w-20" />
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
          <Skeleton shape="card" className="h-40 w-full" />
        </div>
      )}
    </div>
  );
}
