import { describe, expect, it } from "vite-plus/test";
import type { GameSummary } from "@kurambit/contracts";

import { draftGameName, sortGameSummaries, chatTitle } from "./gameLibrary.logic";

const summary = (name: string, updatedAt: string): GameSummary => ({
  projectId: `project-${name}` as GameSummary["projectId"],
  root: `/games/${name}`,
  name,
  template: "blank-three",
  operation: null,
  run: null,
  keyArt: null,
  buildCount: 0,
  latestBuildAt: null,
  published: null,
  updatedAt,
});

describe("sortGameSummaries", () => {
  it("puts the newest activity first and breaks ties by name", () => {
    expect(
      sortGameSummaries([
        summary("Older", "2026-10-18T00:00:00.000Z"),
        summary("Zebra", "2026-10-20T00:00:00.000Z"),
        summary("Alpha", "2026-10-20T00:00:00.000Z"),
      ]).map((game) => game.name),
    ).toEqual(["Alpha", "Zebra", "Older"]);
  });
});

describe("chatTitle", () => {
  it("never says a chat's title is its game's name", () => {
    const at = "2026-11-19T10:00:00.000Z";
    expect(chatTitle({ title: "Widen the pond", latestUserMessageAt: at }, "Moonlit Pond")).toBe(
      "Widen the pond",
    );
    // A chat Kurambit once titled with the game's name: new while empty, else the first chat.
    expect(chatTitle({ title: "Moonlit Pond", latestUserMessageAt: null }, "Moonlit Pond")).toBe(
      "New chat",
    );
    expect(chatTitle({ title: " Moonlit Pond ", latestUserMessageAt: at }, "Moonlit Pond")).toBe(
      "First chat",
    );
  });
});

describe("draftGameName", () => {
  it("names a game by what it is and where it happens", () => {
    expect(
      draftGameName(
        "A cozy fishing game on a floating island at dusk, with a day-night cycle and a rival fisher",
      ),
    ).toBe("Cozy Fishing Island");
    expect(draftGameName("A top-down roguelike in a flooded cathedral")).toBe(
      "Top-Down Roguelike Cathedral",
    );
  });

  it("keeps a short brief's own words and drops framing", () => {
    expect(draftGameName("Make me a puzzle platformer where shadows are solid")).toBe(
      "Puzzle Platformer",
    );
    expect(draftGameName("Snake")).toBe("Snake");
    expect(
      draftGameName("Can you please create a really cozy looking fish simulator. Make it chill."),
    ).toBe("Cozy Looking Fish");
    expect(draftGameName("I'd like to make a racing game on the moon")).toBe("Racing Moon");
    expect(
      draftGameName("A cozy game which will be fishing related where a fisherman will basically"),
    ).toBe("Cozy Fishing");
  });

  it("has nothing to say for a brief without words", () => {
    expect(draftGameName("   ")).toBe("");
    expect(draftGameName("!!!")).toBe("");
  });
});
