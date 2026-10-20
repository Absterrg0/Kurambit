import { describe, expect, it } from "vite-plus/test";
import type { GameSummary } from "@t3tools/contracts";

import { gameProgress } from "./gameProgress";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const summary = (overrides: Partial<GameSummary> = {}): GameSummary => ({
  projectId: "project-game" as GameSummary["projectId"],
  root: "/games/game",
  name: "Game",
  template: "3d-explorer",
  designState: "approved",
  operation: null,
  qualification: { state: "unqualified", asOf: null },
  updatedAt: "2026-10-20T11:00:00.000Z",
  coverImagePath: null,
  ...overrides,
});

describe("gameProgress", () => {
  it("says building while a game operation runs, naming it", () => {
    const progress = gameProgress(
      summary({ operation: { name: "Godot check", state: "running" } }),
      NOW,
    );
    expect(progress.kind).toBe("building");
    expect(progress.label).toBe("Building");
    expect(progress.detail).toContain("Godot check");
  });

  it("does not call a finished operation building", () => {
    expect(
      gameProgress(summary({ operation: { name: "Godot check", state: "succeeded" } }), NOW).kind,
    ).toBe("unqualified");
    expect(
      gameProgress(summary({ operation: { name: "Export Web", state: "failed" } }), NOW).kind,
    ).toBe("unqualified");
  });

  it("shows the design phase before any qualification claim", () => {
    expect(gameProgress(summary({ designState: "draft" }), NOW).label).toBe("Design draft");
    expect(gameProgress(summary({ designState: "changed" }), NOW).kind).toBe("design-changed");
  });

  it("shows the record's qualified time instead of a bare Ready", () => {
    const progress = gameProgress(
      summary({ qualification: { state: "qualified", asOf: "2026-10-20T10:00:00.000Z" } }),
      NOW,
    );
    expect(progress.kind).toBe("qualified");
    expect(progress.label).toBe("Qualified as of 2h ago");
  });

  it("calls a game with no record unqualified rather than ready", () => {
    expect(gameProgress(summary({ designState: null }), NOW)).toMatchObject({
      kind: "unqualified",
      label: "Unqualified",
    });
  });

  it("lets a running operation outrank a draft design", () => {
    expect(
      gameProgress(
        summary({ designState: "draft", operation: { name: "Godot check", state: "running" } }),
        NOW,
      ).kind,
    ).toBe("building");
  });
});
