import {
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "@kurambit/client-runtime/state/thread-sort";
import { gameOpenChat, isGameChat } from "@kurambit/contracts";

import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";

/** The fields of a thread shell the list reads. */
export type ChatListChat = Pick<
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
  | "worktreePath"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "runtime"
>;

export interface ChatListGame {
  readonly environmentId: string;
  readonly projectId: string;
  readonly name: string;
}

/** One row: a chat and the game it works on. */
export interface ChatListRow<G extends ChatListGame, C extends ChatListChat> {
  readonly chat: C;
  readonly game: G;
  /**
   * The chat the game opens to (gameOpenChat), else this one: every row of a game reads the
   * game's builds through it, so they share one read.
   */
  readonly opens: C;
}

export interface ChatList<G extends ChatListGame, C extends ChatListChat> {
  readonly pinned: ReadonlyArray<ChatListRow<G, C>>;
  /** Chats at work, the one the person last wrote in first. */
  readonly active: ReadonlyArray<ChatListRow<G, C>>;
  /** Chats called done, the last settled first. */
  readonly settled: ReadonlyArray<ChatListRow<G, C>>;
  readonly archived: ReadonlyArray<ChatListRow<G, C>>;
}

/** A chat's mark: an agent at work, or a question for the person. */
export type ChatMark = "working" | "waiting" | null;

const gameKeyOf = (game: Pick<ChatListGame, "environmentId" | "projectId">) =>
  `${game.environmentId}:${game.projectId}`;

/** When a chat last moved: the person's latest message, else its last change. */
export const chatActivityAt = (chat: Pick<ChatListChat, "latestUserMessageAt" | "updatedAt">) =>
  chat.latestUserMessageAt ?? chat.updatedAt;

/** A chat is settled when the person, or auto-settle after days of quiet, called its work done. */
export const isSettledChat = (chat: Pick<ChatListChat, "settledOverride">) =>
  chat.settledOverride === "settled";

/** A chat's mark from T3's thread status: approvals and questions wait on the person. */
export const chatMark = (chat: ChatListChat): ChatMark => {
  const status = resolveSidebarThreadStatus(chat);
  if (status === "approval" || status === "input") return "waiting";
  return status === "working" ? "working" : null;
};

/**
 * What a row's third line says, when it has something to say: the chat works in a copy of the
 * game, or its turn waits for another chat to finish in the game.
 */
export type ChatNote =
  | { readonly kind: "copy" }
  | { readonly kind: "waits"; readonly for: string }
  | null;

const AT_WORK: ReadonlySet<string> = new Set(["preparing", "starting", "running", "waiting"]);
const atWork = (chat: Pick<ChatListChat, "runtime">) =>
  chat.runtime !== null && AT_WORK.has(chat.runtime.status);

/**
 * The person's latest message has not started a turn: it is newer than everything the chat's
 * last turn did, and the chat is not at work. A shell says a waiting turn no other way.
 */
const hasUnstartedMessage = (chat: Pick<ChatListChat, "latestUserMessageAt" | "latestRun">) => {
  const sent =
    chat.latestUserMessageAt === null ? Number.NaN : Date.parse(chat.latestUserMessageAt);
  if (Number.isNaN(sent)) return false;
  const run = chat.latestRun;
  return [run?.requestedAt, run?.startedAt, run?.completedAt].every(
    (at) => at == null || Date.parse(at) < sent,
  );
};

export function chatNote<C extends ChatListChat>(chat: C, siblings: ReadonlyArray<C>): ChatNote {
  if (chat.worktreePath !== null) return { kind: "copy" };
  if (atWork(chat) || !hasUnstartedMessage(chat)) return null;
  // One writer at a time in the game's folder: a turn that has not started while another chat
  // is at work there waits for that chat.
  const busy = siblings.find(
    (other) => other.id !== chat.id && other.worktreePath === null && atWork(other),
  );
  return busy === undefined ? null : { kind: "waits", for: busy.title };
}

/**
 * PURE. The sidebar's list: every chat of every game as one row, all equal. Pinned chats first
 * in their pinned order, then the chats at work by latest activity, then the settled and the
 * archived ones apart. A game with no chat at work has no row among the first two.
 */
export function buildChatList<G extends ChatListGame, C extends ChatListChat>(input: {
  readonly games: ReadonlyArray<G>;
  readonly threads: ReadonlyArray<C>;
}): ChatList<G, C> {
  const gameByKey = new Map(input.games.map((game) => [gameKeyOf(game), game] as const));
  const liveIds = new Set(
    input.threads.filter((thread) => thread.deletedAt === null).map((thread) => thread.id),
  );
  const chatsByGame = new Map<string, C[]>();
  for (const thread of input.threads) {
    const key = gameKeyOf(thread);
    if (!gameByKey.has(key) || !isGameChat(thread, liveIds)) continue;
    const list = chatsByGame.get(key);
    if (list === undefined) chatsByGame.set(key, [thread]);
    else list.push(thread);
  }
  const rows: ChatListRow<G, C>[] = [];
  for (const [key, chats] of chatsByGame) {
    const game = gameByKey.get(key)!;
    const opens = gameOpenChat(chats, liveIds);
    for (const chat of chats) rows.push({ chat, game, opens: opens ?? chat });
  }
  const rowOf = new Map(rows.map((row) => [row.chat, row] as const));
  const live = rows.filter((row) => row.chat.archivedAt === null);
  const pinned = live.filter((row) => row.chat.pinnedAt != null && !isSettledChat(row.chat));
  const byNewest =
    (at: (chat: C) => string) => (left: ChatListRow<G, C>, right: ChatListRow<G, C>) =>
      Date.parse(at(right.chat)) - Date.parse(at(left.chat)) ||
      left.chat.id.localeCompare(right.chat.id);
  return {
    pinned: sortPinnedThreadsByOrderKey(pinned.map((row) => row.chat)).map((chat) =>
      rowOf.get(chat)!,
    ),
    active: live
      .filter((row) => row.chat.pinnedAt == null && !isSettledChat(row.chat))
      .toSorted(byNewest(chatActivityAt)),
    settled: sortSettledThreads(
      live.filter((row) => isSettledChat(row.chat)).map((row) => row.chat),
    ).map((chat) => rowOf.get(chat)!),
    archived: rows
      .filter((row) => row.chat.archivedAt !== null)
      .toSorted(byNewest((chat) => chat.archivedAt ?? chat.updatedAt)),
  };
}

/** How many rows a shelf lists before "Show more". */
export const SHELF_PAGE = 12;

/**
 * PURE. The chat to open once the one on screen is settled: the next row at work after it,
 * wrapping to the top, as T3 moves on. Null when it was the last one at work.
 */
export function chatAfterSettle<C extends Pick<ChatListChat, "id">>(
  atWork: ReadonlyArray<C>,
  settled: Pick<ChatListChat, "id">,
): C | null {
  const at = atWork.findIndex((chat) => chat.id === settled.id);
  if (at < 0) return atWork[0] ?? null;
  return [...atWork.slice(at + 1), ...atWork.slice(0, at)][0] ?? null;
}
