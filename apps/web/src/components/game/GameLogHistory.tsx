import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";

/**
 * A game's Log before its chat has any turns. The Log is the agent's turns; the game's builds
 * are the strip's, so the Log points there rather than listing them a second time.
 */
export function GameLogHistory() {
  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <Empty variant="well">
        <EmptyHeader>
          <EmptyTitle>No turns in this Log yet</EmptyTitle>
          <EmptyDescription>
            Tell your game what to change and your agent's work shows here, turn by turn. The game's
            builds are on the strip under the Stage.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
