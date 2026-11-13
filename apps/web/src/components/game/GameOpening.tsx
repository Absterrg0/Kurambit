import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { Skeleton } from "../ui/skeleton";
import { GameStageLoading } from "./GameStage";

/**
 * The game screen before its thread is known (a cold load, between the splash and the first
 * snapshot): the loaded screen's own columns, with a Stage that says it is opening. The working
 * area is never blank beside the sidebar's placeholders, and nothing moves when the game arrives.
 */
export function GameOpening() {
  const dockHeight = useGameWorkspaceStore((state) => state.dockHeight);
  const dockCollapsed = useGameWorkspaceStore((state) => state.dockCollapsed);
  return (
    <div
      aria-busy="true"
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      <div data-game-centre="" className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <GameStageLoading />
        {/* The dock's bar, then its room with the composer at its foot, at the loaded height. */}
        <div
          aria-hidden="true"
          className="flex h-10 shrink-0 items-center border-t border-border px-2"
        >
          <Skeleton className="h-7 w-64" />
        </div>
        {dockCollapsed ? null : (
          <div
            aria-hidden="true"
            className="flex shrink-0 flex-col justify-end px-3 pb-14"
            style={{ height: dockHeight }}
          >
            <Skeleton
              shape="card"
              className="mx-auto h-20 w-full max-w-(--chat-content-max-width)"
            />
          </div>
        )}
      </div>
    </div>
  );
}
