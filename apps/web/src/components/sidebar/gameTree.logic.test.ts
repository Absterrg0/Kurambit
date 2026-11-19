import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@kurambit/contracts";

import { buildGameTree, chatAfterSettle, settledShelf, type GameTreeChat } from "./gameTree.logic";

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
  more: Partial<
    Pick<GameTreeChat, "archivedAt" | "pinnedAt" | "pinOrderKey" | "settledOverride" | "settledAt">
  > = {},
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
    settledOverride: more.settledOverride ?? null,
    settledAt: more.settledAt ?? null,
    latestRun: null,
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

  it("keeps a game's own chat as its row, its open chats under it and its settled ones apart", () => {
    const tree = buildGameTree({
      games: [game("a", "Alpha"), game("b", "Bravo")],
      threads: [
        chat("a-own", "a", "2026-11-01T10:00:00Z"),
        chat("a-hat", "a", "2026-11-05T10:00:00Z"),
        chat("a-done", "a", "2026-11-03T10:00:00Z", {
          settledOverride: "settled",
          settledAt: "2026-11-04T10:00:00Z",
        }),
        // Auto-settle may mark a game's own chat; the game's row stays where it is.
        chat("b-own", "b", "2026-11-02T10:00:00Z", {
          settledOverride: "settled",
          settledAt: "2026-11-06T10:00:00Z",
        }),
        chat("b-done", "b", "2026-11-03T10:00:00Z", {
          settledOverride: "settled",
          settledAt: "2026-11-07T10:00:00Z",
        }),
      ],
      sort: "name",
    });
    const [alpha, bravo] = tree.live;
    expect(alpha?.main?.id).toBe("a-own");
    expect(alpha?.open.map((each) => each.id)).toEqual(["a-hat"]);
    expect(alpha?.settled.map((each) => each.id)).toEqual(["a-done"]);
    expect(bravo?.main?.id).toBe("b-own");
    expect(bravo?.open).toEqual([]);
    // One shelf for every game, the last settled first.
    expect(settledShelf(tree.live).map((each) => each.chat.id)).toEqual(["b-done", "a-done"]);
    // Settling the chat on screen leaves the person in its game.
    expect(chatAfterSettle(alpha!, { id: alpha!.open[0]!.id })?.id).toBe("a-own");
  });
});
