import { Skeleton } from "../ui/skeleton";
import { GameStageLoading } from "./GameStage";

/**
 * The game screen before its thread is known (a cold load, between the splash and the first
 * snapshot): the loaded column's own shape, the game opening on top and the composer's place at
 * the foot of the chat, so the working area is never blank and nothing moves when it arrives.
 */
export function GameOpening() {
  return (
    <div
      aria-busy="true"
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      <div data-game-centre="" className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <GameStageLoading />
        <div
          aria-hidden="true"
          className="chat-composer-lane flex min-h-0 flex-1 flex-col justify-end pb-5"
        >
          <Skeleton shape="card" className="mx-auto h-24 w-full max-w-(--chat-content-max-width)" />
        </div>
      </div>
    </div>
  );
}
