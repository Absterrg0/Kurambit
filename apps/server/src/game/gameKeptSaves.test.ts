// @effect-diagnostics nodeBuiltinImport:off -- Proves kept saves stay inside the game and never reach the user's real save locations.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { keptSavesDir } from "./gameKeptSaves.ts";

const scratch = () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kept-saves-"));

it("keeps one stable save location per engine inside the game's .studio/saves", async () => {
  const base = await scratch();
  try {
    const root = NodePath.join(base, "game");
    await NodeFSP.mkdir(root);
    const first = await keptSavesDir(root, "godot");
    expect(first).toBe(NodePath.join(root, ".studio/saves/godot"));
    expect(await keptSavesDir(root, "godot")).toBe(first);
    await expect(keptSavesDir(root, "../home")).rejects.toThrow();
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
});

it("refuses a linked .studio or saves folder that points outside the game, creating nothing there", async () => {
  const base = await scratch();
  try {
    const outside = NodePath.join(base, "real-saves");
    await NodeFSP.mkdir(outside);
    const linkedStudio = NodePath.join(base, "a");
    await NodeFSP.mkdir(linkedStudio);
    await NodeFSP.symlink(outside, NodePath.join(linkedStudio, ".studio"));
    await expect(keptSavesDir(linkedStudio, "godot")).rejects.toThrow(/outside the game/);
    const linkedSaves = NodePath.join(base, "b");
    await NodeFSP.mkdir(NodePath.join(linkedSaves, ".studio"), { recursive: true });
    await NodeFSP.symlink(outside, NodePath.join(linkedSaves, ".studio/saves"));
    await expect(keptSavesDir(linkedSaves, "unity")).rejects.toThrow(/outside the game/);
    expect(await NodeFSP.readdir(outside)).toEqual([]);
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
});
