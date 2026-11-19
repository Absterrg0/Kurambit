import * as DateTime from "effect/DateTime";

import { isNestedUnderLiveParent, type OrchestrationV2AppThread } from "./orchestrationV2.ts";

type At = string | DateTime.Utc;

/** The fields of a thread a game's chats are listed by; the web holds its times as text. */
export interface GameChatShell {
  readonly id: string;
  readonly lineage: OrchestrationV2AppThread["lineage"];
  readonly updatedAt: At;
  readonly latestUserMessageAt?: At | null;
  readonly archivedAt: At | null;
  readonly deletedAt: At | null;
  readonly settledOverride: "settled" | "active" | null;
}

const millis = (at: At) => (typeof at === "string" ? Date.parse(at) : DateTime.toEpochMillis(at));

/** When a chat last moved: the person's latest message, else its last change. */
const activityOf = (chat: GameChatShell) => millis(chat.latestUserMessageAt ?? chat.updatedAt);

/**
 * Whether a thread lists as a chat: every chat is equal, whichever made the game. A `role` thread
 * is one an earlier Kurambit's production run launched: it never lists. A subagent under a listed
 * parent stays nested there.
 */
export const isGameChat = (
  thread: Pick<GameChatShell, "lineage" | "deletedAt">,
  liveThreadIds: ReadonlySet<string>,
): boolean =>
  thread.deletedAt === null &&
  thread.lineage.relationshipToParent !== "role" &&
  !isNestedUnderLiveParent(thread, liveThreadIds);

/**
 * The chat a game opens to, from Home, the palette and its picture: its most recently active chat
 * still at work, else its most recently active settled one. Null when it has no chat left.
 */
export function gameOpenChat<T extends GameChatShell>(
  threads: readonly T[],
  liveThreadIds: ReadonlySet<string>,
): T | null {
  let open: T | null = null;
  for (const thread of threads) {
    if (thread.archivedAt !== null || !isGameChat(thread, liveThreadIds)) continue;
    if (open === null) {
      open = thread;
      continue;
    }
    const settled = thread.settledOverride === "settled";
    const openSettled = open.settledOverride === "settled";
    if (settled === openSettled ? activityOf(thread) > activityOf(open) : openSettled)
      open = thread;
  }
  return open;
}
