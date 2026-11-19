import type { EnvironmentThreadShell } from "@kurambit/client-runtime/state/models";
import { gameOpenChat, isGameChat, type EnvironmentId } from "@kurambit/contracts";

import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { useThreadShells } from "../../state/entities";
import { resolveGameSidebarStatus, type SidebarThreadStatus } from "../Sidebar.logic";
import { useGameLibrary, type GameLibraryEntry } from "./useGameLibrary";

/** A game with the chat it opens to and its chats' most urgent state. */
export type GameCover = {
  readonly game: GameLibraryEntry;
  readonly opens: EnvironmentThreadShell | null;
  readonly chats: SidebarThreadStatus | null;
  /** Put away: it has no chat left but archived ones. It is on the sidebar's Archived shelf. */
  readonly archived: boolean;
};

const NO_ENVIRONMENTS: ReadonlyArray<EnvironmentId> = [];

const activityOf = (cover: GameCover) =>
  [cover.game.updatedAt, cover.opens?.updatedAt ?? ""].toSorted().at(-1) ?? "";

/**
 * The library's games, latest work first, each with the chat it opens to (gameOpenChat): what
 * Home's cards and Settings → Games show, so both read the same picture and status.
 */
export function useGameCovers() {
  const { games, isLoading, error, environmentId } = useGameLibrary();
  const threads = useThreadShells();
  // Archived chats are not among the live shells; T3's archived snapshot names their games.
  const archivedProjects = new Set(
    useArchivedThreadSnapshots(
      environmentId === null ? NO_ENVIRONMENTS : [environmentId],
    ).snapshots.flatMap(({ snapshot }) => snapshot.threads.map((thread) => thread.projectId)),
  );
  const liveThreadIds = new Set<string>(
    threads.filter((thread) => thread.deletedAt === null).map((thread) => thread.id),
  );
  const threadsByProject = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || !isGameChat(thread, liveThreadIds)) continue;
    const list = threadsByProject.get(thread.projectId);
    if (list === undefined) threadsByProject.set(thread.projectId, [thread]);
    else list.push(thread);
  }
  const covers = games
    .map((game) => {
      const list = threadsByProject.get(game.projectId) ?? [];
      return {
        game,
        opens: gameOpenChat(list, liveThreadIds),
        chats: list.length === 0 ? null : resolveGameSidebarStatus(list),
        archived: list.length === 0 && archivedProjects.has(game.projectId),
      } satisfies GameCover;
    })
    // Latest work first, by the game's chats rather than its project row, so
    // home continues the game a turn last touched.
    .toSorted((a, b) => activityOf(b).localeCompare(activityOf(a)));
  return { covers, isLoading, error };
}
