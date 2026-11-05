import { describe, expect, it } from "vite-plus/test";
import type { GameSummary } from "@kurambit/contracts";

import {
  gameInitial,
  gameSlug,
  gameTemplateAppearance,
  newestThreadByProject,
  sortGameSummaries,
  sortGameThreadsByActivity,
} from "./gameLibrary.logic";

const summary = (name: string, updatedAt: string): GameSummary => ({
  projectId: `project-${name}` as GameSummary["projectId"],
  root: `/games/${name}`,
  name,
  template: "blank",
  operation: null,
  run: null,
  keyArt: null,
  updatedAt,
});

describe("gameSlug", () => {
  it("matches the folder the server creates", () => {
    expect(gameSlug("The Sunlit Isle")).toBe("the-sunlit-isle");
    expect(gameSlug("  Lava & Lasers!  ")).toBe("lava-lasers");
    expect(gameSlug("!!!")).toBe("");
  });
});

describe("gameInitial", () => {
  it("uses the first letters of a name and never renders nothing", () => {
    expect(gameInitial("The Sunlit Isle")).toBe("TS");
    expect(gameInitial("Hollow")).toBe("H");
    expect(gameInitial("   ")).toBe("G");
  });
});

describe("gameTemplateAppearance", () => {
  it("names the engine each starter uses", () => {
    expect(gameTemplateAppearance("blank").label).toBe("Godot");
    expect(gameTemplateAppearance(null).label).toBe("Godot");
    expect(gameTemplateAppearance("blank-three").label).toBe("three.js");
    expect(gameTemplateAppearance("blank-unity").label).toBe("Unity");
  });
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

describe("newestThreadByProject", () => {
  it("picks the most recently active session for each game", () => {
    const newest = newestThreadByProject([
      { projectId: "a", id: "old", updatedAt: "2026-10-18T00:00:00.000Z" },
      { projectId: "a", id: "new", updatedAt: "2026-10-20T00:00:00.000Z" },
      { projectId: "b", id: "only", updatedAt: "2026-10-19T00:00:00.000Z" },
    ]);
    expect(newest.get("a")?.id).toBe("new");
    expect(newest.get("b")?.id).toBe("only");
  });
});

describe("sortGameThreadsByActivity", () => {
  it("orders a game's sessions newest first", () => {
    expect(
      sortGameThreadsByActivity([
        { id: "older", updatedAt: "2026-10-18T00:00:00.000Z" },
        { id: "newer", updatedAt: "2026-10-20T00:00:00.000Z" },
      ]).map((thread) => thread.id),
    ).toEqual(["newer", "older"]);
  });
});
