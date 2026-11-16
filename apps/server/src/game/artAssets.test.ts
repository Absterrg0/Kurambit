// @effect-diagnostics nodeBuiltinImport:off -- The thumbnail write is checked against a real folder.
// The Art tab reads where a file came from out of the lines the art tools and agents write, and
// keeps thumbnails inside the game: a wrong route or licence misleads, and a write that leaves the
// game is a data-safety bug.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import {
  assetLines,
  creditOfLine,
  routeOfLine,
  saveArtThumbnail,
  sheetOfLine,
} from "./artAssets.ts";

describe("ASSETS.md lines", () => {
  it("reads the library add's credit, without the description an agent appends", () => {
    const lines = assetLines(
      "# ASSETS\n\n- `web/assets/library/kit/hero.glb` — library pack kenney-kit (OpenGameArt), CC0 1.0. The hero.\n- `web/assets/library/kit/*.png` — library pack kenney-kit (OpenGameArt), CC BY 4.0, credit: Kenney\n",
    );
    const hero = lines.get("web/assets/library/kit/hero.glb")!;
    expect(routeOfLine(hero)).toBe("library");
    expect(creditOfLine(hero)).toBe("CC0 1.0");
    expect(creditOfLine(lines.get("web/assets/library/kit/*.png")!)).toBe(
      "CC BY 4.0, credit: Kenney",
    );
  });

  it("tells the routes apart by the words their tools write", () => {
    expect(routeOfLine("rendered by game_blender from art/blender/live.blend")).toBe("blender");
    expect(routeOfLine("generated with meshy from a prompt")).toBe("generated");
    expect(routeOfLine("drawn by a script in this game (procedural stripes). Licence: CC0")).toBe(
      "code",
    );
    expect(routeOfLine("a picture the person dropped in")).toBeNull();
  });

  it("reads a sprite sheet's grid from the sprite render's line", () => {
    expect(
      sheetOfLine("sheet of the strips above, 8 columns (frames) x 4 rows (N, E, S, W) of 64x64"),
    ).toEqual({
      columns: 8,
      rows: 4,
    });
    expect(sheetOfLine("a single sprite")).toBeNull();
  });
});

describe("saveArtThumbnail", () => {
  const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString("base64")}`;
  const SHA = "a".repeat(64);

  it("keeps a PNG by its content hash under the ignored builds folder", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "art-thumb-"));
    const kept = await saveArtThumbnail(root, SHA, PNG);
    expect(kept).toBe(`builds/thumbnails/${SHA}.png`);
    expect((await NodeFSP.stat(NodePath.join(root, kept))).isFile()).toBe(true);
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("refuses what is not a PNG, a name that is not a hash, and a folder that leaves the game", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "art-thumb-"));
    const outside = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "art-outside-"));
    await expect(saveArtThumbnail(root, SHA, "data:image/png;base64,aGVsbG8=")).rejects.toThrow();
    await expect(saveArtThumbnail(root, "../../escape", PNG)).rejects.toThrow();
    await NodeFSP.mkdir(NodePath.join(root, "builds"));
    await NodeFSP.symlink(outside, NodePath.join(root, "builds", "thumbnails"));
    await expect(saveArtThumbnail(root, SHA, PNG)).rejects.toThrow();
    expect(await NodeFSP.readdir(outside)).toEqual([]);
    await NodeFSP.rm(root, { recursive: true, force: true });
    await NodeFSP.rm(outside, { recursive: true, force: true });
  });
});
