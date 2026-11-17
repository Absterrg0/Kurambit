import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@kurambit/contracts";

import { buildGameTree, visibleChats, type GameTreeChat } from "./gameTree.logic";

const game = (projectId: string, name: string, updatedAt = "2026-11-01T00:00:00Z") => ({
  environmentId: "env",
  projectId,
  name,
  updatedAt,
});
const chat = (
  id: string,
  projectId: string,
  at: string,
  more: Partial<Pick<GameTreeChat, "archivedAt" | "pinnedAt" | "pinOrderKey">> = {},
) =>
  ({
    id: ThreadId.make(id),
    environmentId: "env",
    projectId,
    title: id,
    createdAt: at,
    updatedAt: at,
    latestUserMessageAt: at,
    archivedAt: more.archivedAt ?? null,
    deletedAt: null,
    pinnedAt: more.pinnedAt ?? null,
    pinOrderKey: more.pinOrderKey ?? null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    runtime: null,
  }) as unknown as GameTreeChat;

describe("the Games tree", () => {
  const games = [game("a", "Alpha"), game("b", "Bravo"), game("c", "Charlie"), game("d", "Delta")];
  const threads = [
    chat("a1", "a", "2026-11-10T10:00:00Z"),
    chat("b1", "b", "2026-11-12T10:00:00Z"),
    chat("c1", "c", "2026-11-11T10:00:00Z", {
      pinnedAt: "2026-11-11T10:00:00Z",
      pinOrderKey: "m",
    }),
    chat("d1", "d", "2026-11-13T10:00:00Z", { archivedAt: "2026-11-14T10:00:00Z" }),
  ];

  it("puts pinned games first, the rest by latest activity, and archived games apart", () => {
    const tree = buildGameTree({ games, threads, sort: "recent" });
    expect(tree.live.map((node) => node.game.name)).toEqual(["Charlie", "Bravo", "Alpha"]);
    expect(tree.archived.map((node) => node.game.name)).toEqual(["Delta"]);
    expect(tree.archived[0]?.main?.id).toBe("d1");
  });

  it("sorts the unpinned games by name when asked, pinned still first", () => {
    const tree = buildGameTree({ games, threads, sort: "name" });
    expect(tree.live.map((node) => node.game.name)).toEqual(["Charlie", "Alpha", "Bravo"]);
  });

  it("keeps a game with no chat at all among the live ones", () => {
    const tree = buildGameTree({ games: [game("e", "Echo")], threads: [], sort: "recent" });
    expect(tree.live.map((node) => node.game.name)).toEqual(["Echo"]);
    expect(tree.live[0]?.main).toBeNull();
  });

  it("lists five chats, then the open one when it is further down", () => {
    const chats = ["1", "2", "3", "4", "5", "6", "7"].map((id) => ({ id }));
    expect(visibleChats(chats, false, null)).toEqual({ shown: chats.slice(0, 5), hidden: 2 });
    expect(visibleChats(chats, false, "7").shown.map((each) => each.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "7",
    ]);
    expect(visibleChats(chats, true, null).hidden).toBe(0);
  });
});
