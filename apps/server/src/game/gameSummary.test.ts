import { describe, expect, it } from "@effect/vitest";
import type { GameAsset, GameLastPlaytest, GameSummary } from "@t3tools/contracts";

import { gameCoverCandidates, latestGameActivity, sortGameSummaries } from "./gameSummary.ts";

const asset = (id: string, thumbnail?: string): GameAsset => ({
  id,
  kind: "model",
  source: `art/blender/${id}.blend`,
  script: `art/scripts/${id}.py`,
  export: `godot/assets/models/${id}.glb`,
  ...(thumbnail ? { thumbnail } : {}),
  updatedAt: "2026-10-19T00:00:00.000Z",
});

const playtest = (frames: readonly string[]): GameLastPlaytest => ({
  at: "2026-10-20T00:00:00.000Z",
  directory: "builds/playtests/run",
  success: true,
  responded: true,
  changedPercent: 12,
  consoleErrorCount: 0,
  frames: frames.map((path, index) => ({ label: `frame-${index}`, path })),
  stale: false,
});

describe("gameCoverCandidates", () => {
  it("prefers the newest playtest frame, then asset thumbnails in manifest order", () => {
    expect(
      gameCoverCandidates({
        lastPlaytest: playtest([
          "builds/playtests/new/01-boot.png",
          "builds/playtests/new/02-step.png",
        ]),
        assets: [asset("rock", "art/previews/rock.png"), asset("tree")],
      }),
    ).toEqual(["builds/playtests/new/01-boot.png", "art/previews/rock.png"]);
  });

  it("falls back to the first asset thumbnail when there is no playtest frame", () => {
    expect(
      gameCoverCandidates({
        lastPlaytest: null,
        assets: [asset("rock"), asset("tree", "art/previews/tree.png")],
      }),
    ).toEqual(["art/previews/tree.png"]);
  });

  it("has no cover when nothing has been rendered", () => {
    expect(gameCoverCandidates({ lastPlaytest: playtest([]), assets: [asset("rock")] })).toEqual(
      [],
    );
  });
});

describe("sortGameSummaries", () => {
  it("sorts by activity, newest first, and breaks ties by name", () => {
    const summary = (name: string, updatedAt: string): GameSummary => ({
      projectId: `project-${name}` as GameSummary["projectId"],
      root: `/games/${name}`,
      name,
      template: "3d-explorer",
      designStatus: null,
      updatedAt,
      coverImagePath: null,
    });
    expect(
      sortGameSummaries([
        summary("Older", "2026-10-18T00:00:00.000Z"),
        summary("Zebra", "2026-10-20T00:00:00.000Z"),
        summary("Alpha", "2026-10-20T00:00:00.000Z"),
      ]).map((game) => game.name),
    ).toEqual(["Alpha", "Zebra", "Older"]);
  });
});

describe("latestGameActivity", () => {
  it("keeps whichever of the project and its latest thread moved last", () => {
    expect(latestGameActivity("2026-10-18T00:00:00.000Z", "2026-10-20T00:00:00.000Z")).toBe(
      "2026-10-20T00:00:00.000Z",
    );
    expect(latestGameActivity("2026-10-20T00:00:00.000Z", null)).toBe("2026-10-20T00:00:00.000Z");
  });
});
