import type { SidebarThreadSummary } from "../../types";
import {
  partitionGameChats,
  resolveSidebarThreadStatus,
  sortPinnedThreadsForSidebar,
} from "../Sidebar.logic";

/** The fields of a thread shell the tree reads. */
export type GameTreeChat = Pick<
  SidebarThreadSummary,
  | "id"
  | "environmentId"
  | "projectId"
  | "title"
  | "createdAt"
  | "updatedAt"
  | "latestUserMessageAt"
  | "archivedAt"
  | "deletedAt"
  | "pinnedAt"
  | "pinOrderKey"
  | "lineage"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "runtime"
>;

export interface GameTreeGame {
  readonly environmentId: string;
  readonly projectId: string;
  readonly name: string;
  readonly updatedAt: string;
}

/** A chat's mark: an agent at work, or a question for the person. */
export type GameTreeMark = "working" | "waiting" | null;

export interface GameTreeNode<G extends GameTreeGame, C extends GameTreeChat> {
  readonly key: string;
  readonly game: G;
  /** The chat a click on the game opens: its main chat, else its newest. */
  readonly main: C | null;
  /** Live chats, newest first; for an archived game, its archived chats. */
  readonly chats: ReadonlyArray<C>;
  readonly pinned: boolean;
  readonly archived: boolean;
  /** When anything last happened in it: its newest chat, else the game folder. */
  readonly activeAt: string;
}

export type GameTreeSort = "recent" | "name";

const gameKeyOf = (game: Pick<GameTreeGame, "environmentId" | "projectId">) =>
  `${game.environmentId}:${game.projectId}`;

const activityOf = (chat: GameTreeChat) => chat.latestUserMessageAt ?? chat.updatedAt;
const newestFirst = (left: GameTreeChat, right: GameTreeChat) =>
  Date.parse(activityOf(right)) - Date.parse(activityOf(left));

/** A chat's mark from T3's thread status: approval and questions wait on the person. */
export const chatMark = (chat: GameTreeChat, picking: boolean): GameTreeMark => {
  const status = resolveSidebarThreadStatus(chat);
  if (status === "approval" || status === "input" || picking) return "waiting";
  return status === "working" ? "working" : null;
};

/**
 * PURE. The Games tree: each game with its chats, pinned games first in their pinned order, then
 * the rest by latest activity (or name). A game whose every chat is archived is archived; a game
 * with no chat at all stays with the live ones.
 */
export function buildGameTree<G extends GameTreeGame, C extends GameTreeChat>(input: {
  readonly games: ReadonlyArray<G>;
  readonly threads: ReadonlyArray<C>;
  readonly sort: GameTreeSort;
}): {
  readonly live: ReadonlyArray<GameTreeNode<G, C>>;
  readonly archived: ReadonlyArray<GameTreeNode<G, C>>;
} {
  const liveIds = new Set(
    input.threads.filter((thread) => thread.deletedAt === null).map((thread) => thread.id),
  );
  const byGame = new Map<string, C[]>();
  for (const thread of input.threads) {
    if (thread.deletedAt !== null) continue;
    const key = gameKeyOf(thread);
    const list = byGame.get(key);
    if (list === undefined) byGame.set(key, [thread]);
    else list.push(thread);
  }
  const live: GameTreeNode<G, C>[] = [];
  const archived: GameTreeNode<G, C>[] = [];
  for (const game of input.games) {
    const key = gameKeyOf(game);
    const all = byGame.get(key) ?? [];
    const chats = partitionGameChats(all, liveIds);
    const listed = chats.main === null ? chats.others : [chats.main, ...chats.others];
    const archivedChats = all
      .filter(
        (thread) => thread.archivedAt !== null && thread.lineage.relationshipToParent !== "role",
      )
      .toSorted(newestFirst);
    const isArchived = listed.length === 0 && archivedChats.length > 0;
    const shown = (isArchived ? archivedChats : listed).toSorted(newestFirst);
    const main = isArchived ? (archivedChats[0] ?? null) : chats.main;
    const newest = shown[0];
    const node: GameTreeNode<G, C> = {
      key,
      game,
      main,
      chats: shown,
      pinned: !isArchived && main?.pinnedAt != null,
      archived: isArchived,
      activeAt:
        newest === undefined
          ? game.updatedAt
          : [activityOf(newest), game.updatedAt].toSorted().at(-1)!,
    };
    (isArchived ? archived : live).push(node);
  }
  const byName = (left: GameTreeNode<G, C>, right: GameTreeNode<G, C>) =>
    left.game.name.localeCompare(right.game.name, undefined, { sensitivity: "base" });
  const byRecent = (left: GameTreeNode<G, C>, right: GameTreeNode<G, C>) =>
    Date.parse(right.activeAt) - Date.parse(left.activeAt);
  const pinnedMains = sortPinnedThreadsForSidebar(
    live.flatMap((node) => (node.pinned && node.main !== null ? [node.main] : [])),
  );
  const pinned = pinnedMains.flatMap((main) => live.filter((node) => node.main === main));
  const rest = live
    .filter((node) => !node.pinned)
    .toSorted(input.sort === "name" ? byName : byRecent);
  return { live: [...pinned, ...rest], archived: archived.toSorted(byRecent) };
}

/** How many chats a game shows before "Show N more". */
const GAME_TREE_CHAT_LIMIT = 5;

/**
 * PURE. The chats an expanded game lists: the first five, or all of them once asked, and the open
 * chat always, so the highlighted row is never hidden behind "Show more".
 */
export function visibleChats<C extends { readonly id: string }>(
  chats: ReadonlyArray<C>,
  showAll: boolean,
  openChatId: string | null,
): { readonly shown: ReadonlyArray<C>; readonly hidden: number } {
  if (showAll || chats.length <= GAME_TREE_CHAT_LIMIT) return { shown: chats, hidden: 0 };
  const shown = chats.slice(0, GAME_TREE_CHAT_LIMIT);
  const open = chats.findIndex((chat) => chat.id === openChatId);
  if (open >= GAME_TREE_CHAT_LIMIT) shown.push(chats[open]!);
  return { shown, hidden: chats.length - shown.length };
}
