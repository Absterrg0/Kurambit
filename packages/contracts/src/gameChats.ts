import * as DateTime from "effect/DateTime";

import { isNestedUnderLiveParent, type OrchestrationV2AppThread } from "./orchestrationV2.ts";

type At = string | DateTime.Utc;

/** The fields of a thread a game's chats are told apart by; the web holds its times as text. */
export interface GameChatShell {
  readonly id: string;
  readonly lineage: OrchestrationV2AppThread["lineage"];
  readonly createdAt: At;
  readonly updatedAt: At;
  readonly archivedAt: At | null;
  readonly deletedAt: At | null;
}

const millis = (at: At) => (typeof at === "string" ? Date.parse(at) : DateTime.toEpochMillis(at));

/**
 * A game's main chat: its oldest live top-level chat. A game's create
 * launches exactly this thread with the brief; archiving it promotes the next.
 */
export function gameMainThread<T extends GameChatShell>(threads: readonly T[]): T | null {
  let main: T | null = null;
  for (const thread of threads) {
    if (thread.deletedAt !== null || thread.archivedAt !== null) continue;
    if (thread.lineage.relationshipToParent !== null) continue;
    if (main === null || millis(thread.createdAt) < millis(main.createdAt)) main = thread;
  }
  return main;
}

export interface GameChats<T> {
  /** The game's own chat; when the game has no top-level chat left, its newest other chat. */
  readonly main: T | null;
  /** Every other chat of the game, newest first. */
  readonly others: readonly T[];
}

/**
 * One game's live threads, by lineage alone: the one rule for which chat is the game's own, for
 * the sidebar and the server alike. A `role` thread is one an earlier Kurambit's production run
 * launched: it never lists as a chat. A subagent under a listed parent stays nested there.
 */
export function partitionGameChats<T extends GameChatShell>(
  threads: readonly T[],
  liveThreadIds: ReadonlySet<string>,
): GameChats<T> {
  const chats: T[] = [];
  for (const thread of threads) {
    if (thread.deletedAt !== null || thread.archivedAt !== null) continue;
    if (thread.lineage.relationshipToParent === "role") continue;
    if (!isNestedUnderLiveParent(thread, liveThreadIds)) chats.push(thread);
  }
  chats.sort((left, right) => millis(right.updatedAt) - millis(left.updatedAt));
  const main = gameMainThread(chats) ?? chats[0] ?? null;
  return { main, others: chats.filter((thread) => thread !== main) };
}
