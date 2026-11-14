// A create must never delete a folder that is not a half-made create of ours.
// @effect-diagnostics nodeBuiltinImport:off -- The create's leftovers are real folders on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { freeGameFolder, gameFolderName, halfMadeCreate } from "./GameProjectService.ts";

describe("game create", () => {
  it("reclaims only its own half-made folder", async () => {
    const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kurambit-create-"));
    try {
      const empty = NodePath.join(parent, "empty");
      NodeFS.mkdirSync(empty);
      assert.isTrue(await halfMadeCreate(empty));
      const marked = NodePath.join(parent, "marked");
      NodeFS.mkdirSync(NodePath.join(marked, "builds"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(marked, "builds/.kurambit-creating"), "");
      NodeFS.writeFileSync(NodePath.join(marked, "game.json"), "{}");
      assert.isTrue(await halfMadeCreate(marked));
      const someone = NodePath.join(parent, "someone");
      NodeFS.mkdirSync(NodePath.join(someone, "builds"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(someone, "notes.txt"), "mine");
      assert.isFalse(await halfMadeCreate(someone));
      assert.isFalse(await halfMadeCreate(NodePath.join(parent, "missing")));
    } finally {
      NodeFS.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("takes the next free folder, never one that holds a game or someone's files", async () => {
    const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kurambit-create-"));
    try {
      const taken = (folder: string) => {
        NodeFS.mkdirSync(NodePath.join(parent, folder));
        NodeFS.writeFileSync(NodePath.join(parent, folder, "game.json"), "{}");
      };
      assert.deepStrictEqual(await freeGameFolder(parent, "boat", "Boat", true), {
        root: NodePath.join(parent, "boat"),
        name: "Boat",
      });
      taken("boat");
      taken("boat-2");
      NodeFS.mkdirSync(NodePath.join(parent, "boat-3"));
      assert.deepStrictEqual(await freeGameFolder(parent, "boat", "Boat", true), {
        root: NodePath.join(parent, "boat-3"),
        name: "Boat 3",
      });
      assert.deepStrictEqual(await freeGameFolder(parent, "boat", "Boat", false), {
        root: NodePath.join(parent, "boat-3"),
        name: "Boat",
      });
    } finally {
      NodeFS.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("names a folder for any name", () => {
    assert.strictEqual(gameFolderName("Café Racer!", "abc123"), "cafe-racer");
    assert.strictEqual(gameFolderName("ゲーム", "abc123"), "game-abc123");
  });
});
