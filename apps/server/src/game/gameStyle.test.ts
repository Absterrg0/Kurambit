// @effect-diagnostics nodeBuiltinImport:off -- Writes STYLE.json files on disk to prove the reader refuses what is not a lock.
import { afterEach, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { GameStyle } from "@kurambit/contracts";
import { LIBRARY_CATALOG } from "./assetLibraryCatalog.ts";
import { lockPackRefusal, lockRigRefusal, lockSpriteInput, readGameStyle } from "./gameStyle.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});
const game = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "style-lock-"));
  roots.push(root);
  return root;
};
const pack = (id: string) => LIBRARY_CATALOG.find((p) => p.id === id)!;
const kaykit: GameStyle = {
  version: 1,
  family: "kaykit",
  mode: "smooth",
  view: "perspective",
  rig: "kaykit-1",
  packs: ["kaykit-adventurers", "kaykit-dungeon-remastered", "kenney-mini-characters"],
};

const failure = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? String(JSON.stringify(exit.cause)) : "succeeded";

it.effect("reads no lock as none, and refuses a link, a folder or a lock that is not one", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(game);
    expect(yield* readGameStyle(root)).toBeNull();

    const elsewhere = yield* Effect.promise(game);
    yield* Effect.promise(async () => {
      await NodeFSP.writeFile(NodePath.join(elsewhere, "STYLE.json"), JSON.stringify(kaykit));
      await NodeFSP.symlink(
        NodePath.join(elsewhere, "STYLE.json"),
        NodePath.join(root, "STYLE.json"),
      );
    });
    expect(failure(yield* Effect.exit(readGameStyle(root)))).toMatch(/symbolic link/);

    yield* Effect.promise(async () => {
      await NodeFSP.rm(NodePath.join(root, "STYLE.json"));
      await NodeFSP.mkdir(NodePath.join(root, "STYLE.json"));
    });
    expect(failure(yield* Effect.exit(readGameStyle(root)))).toMatch(/not a file/);

    const write = (value: unknown) =>
      Effect.promise(async () => {
        await NodeFSP.rm(NodePath.join(root, "STYLE.json"), { recursive: true, force: true });
        await NodeFSP.writeFile(NodePath.join(root, "STYLE.json"), JSON.stringify(value));
      });
    yield* write({ ...kaykit, mode: "pixel" });
    expect(failure(yield* Effect.exit(readGameStyle(root)))).toMatch(/tile/);
    yield* write({ ...kaykit, packs: ["kaykit-dungeon"] });
    expect(failure(yield* Effect.exit(readGameStyle(root)))).toMatch(/kaykit-dungeon-remastered/);
    yield* write({ ...kaykit, rig: "mixamo" });
    expect(failure(yield* Effect.exit(readGameStyle(root)))).toMatch(/no library rig/);
    yield* write(kaykit);
    expect(yield* readGameStyle(root)).toEqual(kaykit);
  }),
);

it("refuses packs outside the lock and characters on another rig, never props", () => {
  expect(lockPackRefusal(pack("kenney-pixel-platformer"), kaykit)).toMatch(
    /add "kenney-pixel-platformer" to STYLE.json's packs/,
  );
  expect(lockPackRefusal(pack("kaykit-adventurers"), kaykit)).toBeNull();
  expect(lockPackRefusal(pack("kenney-pixel-platformer"), null)).toBeNull();
  expect(lockPackRefusal(pack("rubberduck-100-sfx"), kaykit)).toMatch(/audio.packs/);
  // Listed, but its characters are on another rig: the add refuses them, though its props may come.
  expect(lockRigRefusal(pack("kenney-mini-characters"), kaykit)).toMatch(/kaykit-adventurers/);
  expect(lockRigRefusal(pack("kaykit-dungeon-remastered"), kaykit)).toBeNull();
});

it("fills sprite renders from a pixel lock and refuses a palette it does not hold", () => {
  const pixel: GameStyle = {
    version: 1,
    mode: "pixel",
    tile: 16,
    palette: "kenney-tiny-dungeon",
    outline: true,
    view: "top-down",
    packs: ["kenney-tiny-dungeon"],
  };
  const filled = lockSpriteInput({ output: "godot/assets/sprites/hero" }, pixel);
  expect(filled).toMatchObject({
    input: {
      pixelArt: { palette: "kenney-tiny-dungeon", outline: true },
      size: 32,
      views: ["front", "back", "left", "right"],
      elevation: 35,
    },
  });
  expect(
    lockSpriteInput({ output: "x", pixelArt: { palette: "kenney-1-bit-platformer" } }, pixel),
  ).toMatchObject({ refusal: expect.stringMatching(/palette to kenney-tiny-dungeon/) });
  expect(lockSpriteInput({ output: "x", pixelArt: {} }, kaykit)).toMatchObject({
    refusal: expect.stringMatching(/smooth/),
  });
});
