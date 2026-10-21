import { describe, expect, it } from "@effect/vitest";
import type { GameAsset, GameLastPlaytest, GameSummary } from "@t3tools/contracts";

import {
  gameCoverCandidates,
  gameCoverFrame,
  latestGameActivity,
  sortGameSummaries,
} from "./gameSummary.ts";

const asset = (id: string, thumbnail?: string): GameAsset => ({
  id,
  kind: "model",
  source: `art/blender/${id}.blend`,
  script: `art/scripts/${id}.py`,
  export: `godot/assets/models/${id}.glb`,
  ...(thumbnail ? { thumbnail } : {}),
  updatedAt: "2026-10-19T00:00:00.000Z",
});

const playtest = (
  frames: readonly string[],
  overrides: Partial<GameLastPlaytest> = {},
): GameLastPlaytest => ({
  at: "2026-10-20T00:00:00.000Z",
  directory: "builds/playtests/run",
  success: true,
  responded: true,
  changedPercent: 12,
  consoleErrorCount: 0,
  frames: frames.map((path, index) => ({ label: `frame-${index}`, path })),
  stale: false,
  ...overrides,
});

const labelled = (
  frames: readonly { readonly label: string; readonly path: string }[],
  overrides: Partial<GameLastPlaytest> = {},
): GameLastPlaytest =>
  playtest(
    frames.map((frame) => frame.path),
    { ...overrides, frames },
  );

describe("gameCoverFrame", () => {
  it("covers a game with the observed-play frame the evidence picked", () => {
    expect(
      gameCoverFrame(
        labelled(
          [
            { label: "booted", path: "builds/playtests/run/01-booted.png" },
            { label: "menu", path: "builds/playtests/run/02-menu.png" },
          ],
          // The reader chose this one from per-frame probe state, captions aside.
          { coverFrame: { label: "menu", path: "builds/playtests/run/02-menu.png" } },
        ),
      )?.path,
    ).toBe("builds/playtests/run/02-menu.png");
  });

  it("falls back to the after-steps frame when no frame proved gameplay", () => {
    expect(
      gameCoverFrame(
        labelled([
          { label: "booted", path: "builds/playtests/run/01-booted.png" },
          { label: "menu", path: "builds/playtests/run/02-menu.png" },
          { label: "after-steps", path: "builds/playtests/run/03-after-steps.png" },
        ]),
        { coverFrame: null },
      )?.path,
    ).toBe("builds/playtests/run/03-after-steps.png");
  });

  it("a menu caption on an unproven run grants nothing", () => {
    // No coverFrame and no after-steps frame: the arbitrary screenshot stays a
    // screenshot, so there is no playtest cover at all.
    expect(
      gameCoverFrame(labelled([{ label: "menu", path: "menu.png" }], { coverFrame: null })),
    ).toBeNull();
  });

  it("never covers a game with the boot frame of a failed or unresponded run", () => {
    expect(gameCoverFrame(labelled([{ label: "booted", path: "boot.png" }]))).toBeNull();
    expect(
      gameCoverFrame(labelled([{ label: "booted", path: "boot.png" }], { success: false })),
    ).toBeNull();
    expect(
      gameCoverFrame(labelled([{ label: "booted", path: "boot.png" }], { responded: false })),
    ).toBeNull();
  });
});

describe("gameCoverCandidates", () => {
  it("prefers the observed-play frame, then asset thumbnails in manifest order", () => {
    expect(
      gameCoverCandidates({
        lastPlaytest: labelled(
          [
            { label: "booted", path: "builds/playtests/new/01-booted.png" },
            { label: "playing", path: "builds/playtests/new/02-playing.png" },
          ],
          {
            coverFrame: { label: "playing", path: "builds/playtests/new/02-playing.png" },
          },
        ),
        assets: [asset("rock", "art/previews/rock.png"), asset("tree")],
      }),
    ).toEqual(["builds/playtests/new/02-playing.png", "art/previews/rock.png"]);
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
      designState: null,
      operation: null,
      qualification: { state: "unqualified", asOf: null },
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
