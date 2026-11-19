import { ThreadId } from "@kurambit/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildChatList, chatAfterSettle, chatNote, type ChatListChat } from "./chatList.logic";

const game = (projectId: string, name: string) => ({ environmentId: "env", projectId, name });
const chat = (
  id: string,
  projectId: string,
  at: string,
  overrides: Partial<ChatListChat> = {},
): ChatListChat =>
  ({
    id: ThreadId.make(id),
    environmentId: "env",
    projectId,
    title: id,
    createdAt: at,
    updatedAt: at,
    latestUserMessageAt: at,
    archivedAt: null,
    deletedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    settledOverride: null,
    settledAt: null,
    latestRun: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    worktreePath: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    runtime: null,
    ...overrides,
  }) as ChatListChat;

describe("buildChatList", () => {
  const pond = game("pond", "Moonlit Pond");
  const duel = game("duel", "Shadow Duel");

  it("lists every chat as its own row, by latest activity, whichever game it works on", () => {
    const list = buildChatList({
      games: [pond, duel],
      threads: [
        chat("pond-first", "pond", "2026-11-01T10:00:00Z"),
        chat("duel-first", "duel", "2026-11-02T10:00:00Z"),
        chat("pond-second", "pond", "2026-11-03T10:00:00Z"),
        // A project that is no game has no rows here.
        chat("code", "other", "2026-11-04T10:00:00Z"),
      ],
    });
    expect(list.active.map((row) => `${row.game.name}: ${row.chat.id}`)).toEqual([
      "Moonlit Pond: pond-second",
      "Shadow Duel: duel-first",
      "Moonlit Pond: pond-first",
    ]);
    // Both rows of a game read its builds through the one chat the game opens to.
    expect(list.active.map((row) => row.opens.id)).toEqual([
      "pond-second",
      "duel-first",
      "pond-second",
    ]);
  });

  it("puts pinned chats first, and settled and archived ones on their shelves", () => {
    const list = buildChatList({
      games: [pond, duel],
      threads: [
        chat("at-work", "pond", "2026-11-05T10:00:00Z"),
        chat("pinned", "pond", "2026-11-01T10:00:00Z", { pinnedAt: "2026-11-02T10:00:00Z" }),
        chat("done", "pond", "2026-11-03T10:00:00Z", {
          settledOverride: "settled",
          settledAt: "2026-11-04T10:00:00Z",
        }),
        chat("put-away", "duel", "2026-11-01T10:00:00Z", { archivedAt: "2026-11-02T10:00:00Z" }),
        chat("deleted", "duel", "2026-11-06T10:00:00Z", { deletedAt: "2026-11-06T11:00:00Z" }),
      ],
    });
    expect(list.pinned.map((row) => row.chat.id)).toEqual(["pinned"]);
    expect(list.active.map((row) => row.chat.id)).toEqual(["at-work"]);
    expect(list.settled.map((row) => row.chat.id)).toEqual(["done"]);
    // A game whose every chat is archived has no row but the shelf's.
    expect(list.archived.map((row) => row.chat.id)).toEqual(["put-away"]);
  });
});

describe("chatAfterSettle", () => {
  const [a, b, c] = ["a", "b", "c"].map((id) => ({ id: ThreadId.make(id) }));
  it("moves on to the next chat at work, wrapping to the top", () => {
    expect(chatAfterSettle([a!, b!, c!], a!)?.id).toBe("b");
    expect(chatAfterSettle([a!, b!, c!], c!)?.id).toBe("a");
    expect(chatAfterSettle([a!], a!)).toBe(null);
  });
});

describe("chatNote", () => {
  it("says a chat works in a copy, or which chat its unstarted turn waits for", () => {
    const busy = chat("busy", "pond", "2026-11-01T10:00:00Z", {
      title: "Widen the pond",
      runtime: { status: "running" } as never,
    });
    // Its last turn ended before the person's latest message, and nothing has started since.
    const waits = chat("waits", "pond", "2026-11-01T11:00:00Z", {
      latestRun: {
        requestedAt: "2026-11-01T09:00:00Z",
        startedAt: "2026-11-01T09:00:01Z",
        completedAt: "2026-11-01T09:05:00Z",
      } as never,
      runtime: { status: "completed" } as never,
    });
    const answered = {
      ...waits,
      id: ThreadId.make("answered"),
      latestUserMessageAt: "2026-11-01T09:00:00Z",
    };
    const copy = chat("copy", "pond", "2026-11-01T12:00:00Z", { worktreePath: "/copies/1" });
    const all = [busy, waits, answered, copy];
    expect(chatNote(waits, all)).toEqual({ kind: "waits", for: "Widen the pond" });
    expect(chatNote(copy, all)).toEqual({ kind: "copy" });
    expect(chatNote(busy, all)).toBe(null);
    expect(chatNote(answered, all)).toBe(null);
    // With no chat at work in the game, an unstarted message is about to start: no note.
    expect(chatNote(waits, [waits, copy])).toBe(null);
  });
});
