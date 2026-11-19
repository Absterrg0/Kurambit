import { sortSettledThreads } from "@kurambit/client-runtime/state/thread-sort";
import { partitionGameChats } from "@kurambit/contracts";

import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus, sortPinnedThreadsForSidebar } from "../Sidebar.logic";

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
  | "settledOverride"
  | "settledAt"
  | "latestRun"
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
  /**
   * The game's own chat, the one it was made in: the game's row is this chat, so it is never
   * listed under it by the same name. Else its newest chat.
   */
  readonly main: C | null;
  /** Every live chat of the game; for an archived game, its archived chats. */
  readonly chats: ReadonlyArray<C>;
  /** Its other chats still at work, newest first: the rows under the game. */
  readonly open: ReadonlyArray<C>;
  /** Its other chats that are settled (done), the last settled first: the Settled shelf's rows. */
  readonly settled: ReadonlyArray<C>;
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

/**
 * A chat is settled when the person, or auto-settle after days of quiet, called its work done.
 * Only a game's other chats settle: its own chat is the game's row, which archiving puts away.
 */
export const isSettledChat = (chat: Pick<GameTreeChat, "settledOverride">) =>
  chat.settledOverride === "settled";

/** A chat's mark from T3's thread status: approval and questions wait on the person. */
export const chatMark = (chat: GameTreeChat, picking: boolean): GameTreeMark => {
  const status = resolveSidebarThreadStatus(chat);
  if (status === "approval" || status === "input" || picking) return "waiting";
  return status === "working" ? "working" : null;
};

/**
 * PURE. The Games tree: each game with its open chats under it and its settled ones apart, pinned
 * games first in their pinned order, then the rest by latest activity (or name). A game whose
 * every chat is archived is archived; a game with no chat at all stays with the live ones.
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
    const others = isArchived ? [] : shown.filter((chat) => chat !== main);
    const newest = shown[0];
    const node: GameTreeNode<G, C> = {
      key,
      game,
      main,
      chats: shown,
      open: others.filter((chat) => !isSettledChat(chat)),
      settled: sortSettledThreads(others.filter(isSettledChat)),
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

/** One row of the Settled shelf: a settled chat and the game it worked on. */
export interface SettledChat<G extends GameTreeGame, C extends GameTreeChat> {
  readonly chat: C;
  readonly node: GameTreeNode<G, C>;
}

/** PURE. Every live game's settled chats as one shelf, the last settled first. */
export function settledShelf<G extends GameTreeGame, C extends GameTreeChat>(
  live: ReadonlyArray<GameTreeNode<G, C>>,
): ReadonlyArray<SettledChat<G, C>> {
  const nodeOf = new Map(live.flatMap((node) => node.settled.map((chat) => [chat, node] as const)));
  return sortSettledThreads([...nodeOf.keys()]).map((chat) => ({ chat, node: nodeOf.get(chat)! }));
}

/** How many settled chats the shelf lists before "Show more". */
export const SETTLED_SHELF_PAGE = 12;

/**
 * PURE. The chat to open once `chat` is settled while it is the one on screen: the game's own
 * chat, so the person stays in the game they were working on.
 */
export function chatAfterSettle<G extends GameTreeGame, C extends GameTreeChat>(
  node: GameTreeNode<G, C>,
  chat: Pick<C, "id">,
): C | null {
  return node.main !== null && node.main.id !== chat.id ? node.main : null;
}
