import { describe, expect, it } from "vite-plus/test";
import type { GameSummary } from "@kurambit/contracts";

import {
  formatGameEditedAt,
  gameInitial,
  gameSlug,
  gameTemplateAppearance,
  newestThreadByProject,
  sortGameSummaries,
  sortGameThreadsByActivity,
} from "./gameLibrary.logic";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const summary = (name: string, updatedAt: string): GameSummary => ({
  projectId: `project-${name}` as GameSummary["projectId"],
  root: `/games/${name}`,
  name,
  template: "blank",
  operation: null,
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

describe("formatGameEditedAt", () => {
  it("reads like a library card, not a timestamp", () => {
    expect(formatGameEditedAt("2026-10-20T11:59:40.000Z", NOW)).toBe("edited just now");
    expect(formatGameEditedAt("2026-10-20T11:55:00.000Z", NOW)).toBe("edited 5m ago");
    expect(formatGameEditedAt("2026-10-20T10:00:00.000Z", NOW)).toBe("edited 2h ago");
    expect(formatGameEditedAt("2026-10-17T12:00:00.000Z", NOW)).toBe("edited 3d ago");
    expect(formatGameEditedAt("2026-08-20T12:00:00.000Z", NOW)).toBe("edited 2mo ago");
    expect(formatGameEditedAt("2024-10-20T12:00:00.000Z", NOW)).toBe("edited 2y ago");
    expect(formatGameEditedAt("not-a-date", NOW)).toBe("edited recently");
  });

  it("does not count a clock skew as the future", () => {
    expect(formatGameEditedAt("2026-10-20T12:05:00.000Z", NOW)).toBe("edited just now");
  });
});

describe("gameTemplateAppearance", () => {
  it("names the blank starter", () => {
    expect(gameTemplateAppearance("blank").label).toBe("Blank");
    expect(gameTemplateAppearance(null).label).toBe("Blank");
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
