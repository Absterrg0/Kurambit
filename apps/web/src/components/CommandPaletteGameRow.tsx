import type { SidebarThreadStatus } from "./Sidebar.logic";
import type { SidebarThreadSummary } from "../types";
import { GamePicture } from "./game/GameBuildStill";
import { GameLibraryStatusText, useGameLibraryLine } from "./game/GameLibraryStatus";
import type { GameLibraryEntry } from "./game/useGameLibrary";

interface PaletteGameRowProps {
  readonly game: GameLibraryEntry;
  readonly opens: Pick<SidebarThreadSummary, "id" | "latestRun" | "runtime">;
  readonly chats: SidebarThreadStatus;
}

// A Recent row in the palette is the game as the sidebar shows it: its latest build's
// still and its one status line, read from the same hook so the times agree.
export function PaletteGameIcon({ game, opens, chats }: PaletteGameRowProps) {
  const { build } = useGameLibraryLine({ game, opens, chats, read: true });
  return (
    <GamePicture
      environmentId={game.environmentId}
      root={game.root}
      path={build?.still ?? null}
      gameName={game.name}
      className="size-5 shrink-0 rounded-sm"
    />
  );
}

export function PaletteGameStatus({ game, opens, chats }: PaletteGameRowProps) {
  const { status } = useGameLibraryLine({ game, opens, chats, read: true });
  return <GameLibraryStatusText status={status} />;
}
