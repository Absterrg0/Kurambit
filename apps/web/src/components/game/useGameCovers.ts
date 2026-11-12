import type { EnvironmentThreadShell } from "@kurambit/client-runtime/state/models";
import { isNestedUnderLiveParent } from "@kurambit/contracts";

import { useThreadShells } from "../../state/entities";
import {
  gameMainThread,
  partitionGameChats,
  resolveGameSidebarStatus,
  type SidebarThreadStatus,
} from "../Sidebar.logic";
import { sortGameThreadsByActivity } from "./gameLibrary.logic";
import { useGameLibrary, type GameLibraryEntry } from "./useGameLibrary";

/** A game with the chat it opens on and its chats' most urgent state. */
export type GameCover = {
  readonly game: GameLibraryEntry;
  readonly main: EnvironmentThreadShell | null;
  readonly chats: SidebarThreadStatus | null;
};

const activityOf = (cover: GameCover) =>
  [cover.game.updatedAt, cover.main?.updatedAt ?? ""].toSorted().at(-1) ?? "";

/**
 * The library's games, latest work first, each with the main chat it opens on: what Home's
 * cards and Settings → Games show, so both read the same picture and status.
 */
export function useGameCovers() {
  const { games, isLoading, error } = useGameLibrary();
  const threads = useThreadShells();
  const liveThreadIds = new Set<string>(
    threads.filter((thread) => thread.deletedAt === null).map((thread) => thread.id),
  );
  const threadsByProject = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    if (thread.deletedAt !== null || thread.archivedAt !== null) continue;
    if (isNestedUnderLiveParent(thread, liveThreadIds)) continue;
    const list = threadsByProject.get(thread.projectId);
    if (list === undefined) threadsByProject.set(thread.projectId, [thread]);
    else list.push(thread);
  }
  const covers = games
    .map((game) => {
      const list = threadsByProject.get(game.projectId) ?? [];
      const chats = partitionGameChats(list, liveThreadIds);
      // A game opens on its main chat, as its sidebar row does.
      const main = chats.main ?? gameMainThread(list) ?? sortGameThreadsByActivity(list)[0] ?? null;
      return {
        game,
        main,
        chats: list.length === 0 ? null : resolveGameSidebarStatus(chats),
      } satisfies GameCover;
    })
    // Latest work first, by the game's own chat rather than its project row, so
    // home continues the game a turn last touched.
    .toSorted((a, b) => activityOf(b).localeCompare(activityOf(a)));
  return { covers, isLoading, error };
}
