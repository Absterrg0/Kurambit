// @effect-diagnostics nodeBuiltinImport:off -- Proves saving media copies only generated files, only into saved/, and never overwrites.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { deleteSaved, listSaved, saveMedia } from "./gameSavedMedia.ts";

// Before any file's own time, so no temp copy a test writes looks stale.
const NOW = 0;

const withGame = async (test: (root: string, base: string) => Promise<void>) => {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "saved-media-"));
  try {
    const root = NodePath.join(base, "game");
    await NodeFSP.mkdir(NodePath.join(root, "builds/logs/game-bot-1"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, "builds/logs/game-bot-1/run.mp4"), "video-1");
    await test(root, base);
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
};

it("copies a generated video under a dated name and never overwrites a saved one", () =>
  withGame(async (root) => {
    const source = "builds/logs/game-bot-1/run.mp4";
    const first = await saveMedia(root, source, "round 2 bot run", "2026-11-05", NOW);
    expect(first.name).toBe("2026-11-05 round 2 bot run.mp4");
    // A Save button finds its file by what it was saved from, after a remount too.
    expect((await listSaved(root, NOW)).find((m) => m.name === first.name)).toMatchObject({
      source,
      label: "round 2 bot run",
    });
    await NodeFSP.writeFile(NodePath.join(root, source), "video-2");
    const second = await saveMedia(root, source, "round 2 bot run", "2026-11-05", NOW);
    expect(second.name).toBe("2026-11-05 round 2 bot run (2).mp4");
    expect(await NodeFSP.readFile(first.path, "utf8")).toBe("video-1");
    expect(await NodeFSP.readFile(NodePath.join(root, source), "utf8")).toBe("video-2");
    // Ignored inside saved/ itself, so a game with an older .gitignore keeps videos out of checkpoints.
    expect(await NodeFSP.readFile(NodePath.join(root, "saved/.gitignore"), "utf8")).toBe("*\n");
    await NodeFSP.rm(NodePath.join(root, "saved/.gitignore"));
    await saveMedia(root, source, "again", "2026-11-05", NOW);
    expect(await NodeFSP.readFile(NodePath.join(root, "saved/.gitignore"), "utf8")).toBe("*\n");
    expect((await listSaved(root, NOW)).map((m) => m.name).toSorted()).toEqual(
      [first.name, second.name, "2026-11-05 again.mp4"].toSorted(),
    );
  }));

it("refuses sources outside the game's generated media, through links too", () =>
  withGame(async (root, base) => {
    await NodeFSP.writeFile(NodePath.join(base, "secret.png"), "x");
    await NodeFSP.writeFile(NodePath.join(root, "art.png"), "x");
    await NodeFSP.symlink(
      NodePath.join(base, "secret.png"),
      NodePath.join(root, "builds/logs/game-bot-1/leak.png"),
    );
    for (const source of [
      "art.png",
      "../secret.png",
      NodePath.join(base, "secret.png"),
      "builds/logs/game-bot-1/leak.png",
    ])
      await expect(saveMedia(root, source, undefined, "2026-11-05", NOW)).rejects.toThrow();
    expect(await listSaved(root, NOW)).toEqual([]);
  }));

it("never writes through a linked saved/ and deletes only files directly in it", () =>
  withGame(async (root, base) => {
    const outside = NodePath.join(base, "elsewhere");
    await NodeFSP.mkdir(outside);
    await NodeFSP.writeFile(NodePath.join(outside, "keep.mp4"), "x");
    await NodeFSP.symlink(outside, NodePath.join(root, "saved"));
    await expect(
      saveMedia(root, "builds/logs/game-bot-1/run.mp4", undefined, "2026-11-05", NOW),
    ).rejects.toThrow(/link/);
    await expect(deleteSaved(root, "keep.mp4", NOW)).rejects.toThrow();
    expect(await NodeFSP.readdir(outside)).toEqual(["keep.mp4"]);
    await NodeFSP.rm(NodePath.join(root, "saved"));

    const saved = await saveMedia(
      root,
      "builds/logs/game-bot-1/run.mp4",
      "clip",
      "2026-11-05",
      NOW,
    );
    for (const name of ["../game.json", "..", ".gitignore", "sub/x.mp4"])
      await expect(deleteSaved(root, name, NOW)).rejects.toThrow();
    await deleteSaved(root, saved.name, NOW);
    expect(await listSaved(root, NOW)).toEqual([]);
    expect((await NodeFSP.readdir(NodePath.join(root, "saved"))).toSorted()).toEqual([
      ".gitignore",
    ]);

    // A temp copy a killed save left goes once it is an hour old; a live save's stays.
    const old = NodePath.join(root, "saved/.saving-old.mp4");
    await NodeFSP.writeFile(old, "x");
    await NodeFSP.writeFile(NodePath.join(root, "saved/.saving-live.mp4"), "x");
    // The clock the service passes in: the live copy was just written.
    const now = (await NodeFSP.stat(NodePath.join(root, "saved/.saving-live.mp4"))).mtimeMs;
    const twoHoursBefore = (now - 2 * 60 * 60 * 1000) / 1000;
    await NodeFSP.utimes(old, twoHoursBefore, twoHoursBefore);
    await listSaved(root, now);
    expect((await NodeFSP.readdir(NodePath.join(root, "saved"))).toSorted()).toEqual([
      ".gitignore",
      ".saving-live.mp4",
    ]);
  }));
