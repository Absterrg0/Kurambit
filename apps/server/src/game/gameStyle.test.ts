// @effect-diagnostics nodeBuiltinImport:off -- Writes STYLE.json files on disk to prove the reader refuses what is not a lock.
import { afterEach, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { GameStyle } from "@kurambit/contracts";
import { LIBRARY_CATALOG, LIBRARY_RIG_JOINTS, STANDARD_RIG } from "./assetLibraryCatalog.ts";
import {
  lockArmatureRefusal,
  lockImportRefusal,
  lockPackRefusal,
  lockRigRefusal,
  lockSpriteInput,
  mayBeCharacter,
  readGameStyle,
  characterRoute,
  lockCharacterRouteRefusal,
  styleBudgets,
  styleHash,
} from "./gameStyle.ts";

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
    yield* write({ ...kaykit, mode: "pixel", tile: 16, palette: ["#000000", "#ffffff"] });
    expect(failure(yield* Effect.exit(readGameStyle(root)))).toMatch(
      /pixel mode reads its palette from a pack id or a PNG/,
    );
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
  // Sound is locked only once the lock lists audio.packs.
  expect(lockPackRefusal(pack("rubberduck-100-sfx"), kaykit)).toBeNull();
  const withSound = { ...kaykit, audio: { packs: ["kenney-rpg-audio"] } };
  expect(lockPackRefusal(pack("rubberduck-100-sfx"), withSound)).toMatch(/audio.packs/);
  // A pixel lock's palette pack is part of the look without being listed.
  const pixel = { ...kaykit, mode: "pixel" as const, tile: 16, palette: "kenney-tiny-dungeon" };
  expect(lockPackRefusal(pack("kenney-tiny-dungeon"), pixel)).toBeNull();
  // A listed pack brings its characters on its own rig; an unlisted one on another rig does not.
  expect(lockRigRefusal(pack("kenney-mini-characters"), kaykit)).toBeNull();
  expect(lockRigRefusal(pack("quaternius-universal-base-characters"), kaykit)).toMatch(
    /kaykit-adventurers/,
  );
  expect(lockRigRefusal(pack("kaykit-dungeon-remastered"), kaykit)).toBeNull();
  // A model whose clips cannot be read is a possible character; only a model known to have none is a prop.
  const model = { path: "a", bytes: 1, media: "model" as const };
  expect(mayBeCharacter({ ...model, format: "fbx" })).toBe(true);
  expect(mayBeCharacter({ ...model, format: "glb", clipsUnread: true })).toBe(true);
  expect(mayBeCharacter({ ...model, format: "glb", clipCount: 3 })).toBe(true);
  expect(mayBeCharacter({ ...model, format: "glb" })).toBe(false);
  expect(mayBeCharacter({ ...model, format: "obj" })).toBe(false);
});

it("refuses imports the lock does not list, and armatures off its rig", () => {
  expect(lockImportRefusal("polyhaven", kaykit)).toMatch(/imports/);
  expect(lockImportRefusal("polyhaven", { ...kaykit, imports: ["polyhaven"] })).toBeNull();
  expect(lockImportRefusal("sketchfab", null)).toBeNull();
  const kaykitBones = [...LIBRARY_RIG_JOINTS["kaykit-1"]!, "extra_prop_bone"];
  expect(lockArmatureRefusal({ Rig: kaykitBones }, kaykit)).toBeNull();
  expect(lockArmatureRefusal({ Hero: ["root", "spine", "arm"] }, kaykit)).toMatch(
    /not on STYLE.json's rig kaykit-1/,
  );
  const { rig: _, ...noRig } = kaykit;
  expect(lockArmatureRefusal({ Hero: ["root"] }, noRig)).toMatch(/names no rig/);
  expect(lockArmatureRefusal({}, noRig)).toBeNull();
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

it.effect("reads an old rig id through its alias and refuses a retired one with the edit", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(game);
    const standard: GameStyle = {
      ...kaykit,
      family: "quaternius-universal",
      rig: "quaternius-ual2",
      packs: ["quaternius-universal-animation-library-2"],
    };
    const write = (value: unknown) =>
      Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "STYLE.json"), JSON.stringify(value)),
      );
    yield* write(standard);
    expect(yield* readGameStyle(root)).toEqual(standard);
    const bones = [...LIBRARY_RIG_JOINTS[STANDARD_RIG]!, "tail_01"];
    expect(lockArmatureRefusal({ cat: bones }, standard)).toBeNull();
    expect(lockArmatureRefusal({ cat: ["root"] }, standard)).toMatch(/rig standard-humanoid/);
    expect(lockRigRefusal(pack("quaternius-universal-base-characters"), standard)).toBeNull();

    yield* write({ ...standard, rig: "quaternius-ual1" });
    expect(failure(yield* Effect.exit(readGameStyle(root)))).toMatch(
      /Set STYLE.json's rig to standard-humanoid/,
    );
  }),
);

it("hashes a lock by its content, not its key order, and fills budgets from defaults", () => {
  const reordered = Object.fromEntries(Object.entries(kaykit).toReversed()) as GameStyle;
  expect(styleHash(reordered)).toBe(styleHash(kaykit));
  expect(styleHash(kaykit)).toMatch(/^[0-9a-f]{64}$/);
  expect(styleHash({ ...kaykit, view: "side" })).not.toBe(styleHash(kaykit));
  expect(styleHash(null)).toBe("none");
  expect(styleBudgets(null)).toEqual({ character: 20_000, prop: 8_000, texture: 1024 });
  expect(styleBudgets({ ...kaykit, budget: { prop: 500 } })).toEqual({
    character: 20_000,
    prop: 500,
    texture: 1024,
  });
});

it("refuses Blender-made characters off the Blender route, naming the setting", () => {
  expect(lockCharacterRouteRefusal("mpfb-body", characterRoute({}))).toMatch(/with library/);
  expect(lockCharacterRouteRefusal("unstamped-mesh", "generated")).toMatch(/with generated/);
  expect(lockCharacterRouteRefusal("unstamped-mesh", "library")).toMatch(/Make characters with/);
  expect(
    lockCharacterRouteRefusal("mpfb-body", characterRoute({ characters: "blender" })),
  ).toBeNull();
});
