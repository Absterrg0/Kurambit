// @effect-diagnostics nodeBuiltinImport:off -- Writes STYLE.json files on disk to prove the reader refuses what is not a lock.
import { afterEach, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { GameStyle } from "@kurambit/contracts";
import { LIBRARY_CATALOG } from "./assetLibraryCatalog.ts";
import {
  inLook,
  lockSpriteInput,
  ownRigRefusal,
  readGameStyle,
  characterRoute,
  lockCharacterRouteRefusal,
  modelChoice,
  styleBudgets,
  styleFromLock,
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

it("marks the packs of the recorded look, and never keeps one out", () => {
  expect(inLook(pack("kaykit-adventurers"), kaykit)).toBe(true);
  expect(inLook(pack("kenney-pixel-platformer"), kaykit)).toBe(false);
  expect(inLook(pack("kenney-pixel-platformer"), null)).toBe(false);
  const pixel = { ...kaykit, mode: "pixel" as const, tile: 16, palette: "kenney-tiny-dungeon" };
  expect(inLook(pack("kenney-tiny-dungeon"), pixel)).toBe(true);
});

it("lets a rig marked as its own in only on clips of its own", () => {
  // A creature rigged and animated here: its clips are its own, so library clips are never needed.
  expect(ownRigRefusal("Owl", { own: ["Idle", "Wake", "Peck"], library: [] })).toBeNull();
  // No clips at all: it could only borrow library clips, which fit the lock's rig alone.
  expect(ownRigRefusal("Owl", { own: [], library: [] })).toMatch(/carries no clips/);
  // A conformed character's library clips do not ride along on a mark, even beside its own.
  expect(ownRigRefusal("Hero", { own: ["Wave"], library: ["Idle_Loop"] })).toMatch(
    /library clips \(Idle_Loop\)/,
  );
});

it("fills what a sprite render leaves out from a pixel lock, and what it names wins", () => {
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
    lockSpriteInput({ output: "x", pixelArt: { palette: "kenney-1-bit-platformer" } }, pixel).input
      .pixelArt?.palette,
  ).toBe("kenney-1-bit-platformer");
  expect(lockSpriteInput({ output: "x", pixelArt: {} }, kaykit).input.pixelArt).toEqual({});
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

it("makes in Blender what the library lacks, never what the person's providers own", () => {
  // A game from before the library was opt-in keeps its library and its Blender fallback.
  expect(lockCharacterRouteRefusal("mpfb-body", modelChoice({}))).toBeNull();
  expect(
    lockCharacterRouteRefusal("unstamped-mesh", modelChoice({ characters: "library" })),
  ).toBeNull();
  expect(
    lockCharacterRouteRefusal("unstamped-mesh", { route: "generated", library: true }),
  ).toMatch(/with generated/);
  expect(lockCharacterRouteRefusal("generated-body", modelChoice({}))).toMatch(/Make models with/);
  expect(
    lockCharacterRouteRefusal("mpfb-body", modelChoice({ characters: "blender", library: false })),
  ).toBeNull();
  // Code with the library off builds its characters in code.
  expect(
    lockCharacterRouteRefusal(
      "unstamped-mesh",
      modelChoice({ characters: "code", library: false }),
    ),
  ).toMatch(/three\.js code/);
  expect(characterRoute({ characters: "library" })).toBe("code");
});

it("derives a lock from a family, and choosing again keeps what the person set", () => {
  const pack = (id: string) => LIBRARY_CATALOG.find((candidate) => candidate.id === id)!;
  const first = styleFromLock(
    { family: "kenney-lowpoly", view: "perspective" },
    pack("kenney-mini-dungeon"),
    null,
  );
  if (!("style" in first)) throw new Error(first.refusal);
  // The added pack's rig wins; the family's packs on other rigs stay out, so their clips never mix.
  expect(first.style.rig).toBe("kenney-mini");
  expect(first.style.packs).toContain("kenney-mini-characters");
  expect(first.style.packs).not.toContain("kenney-blocky-characters");
  expect(first.style.packs).toContain("kenney-ui-pack");
  const edited: GameStyle = {
    ...first.style,
    anchor: "art/key-art.png",
    palette: ["#112233", "#445566"],
    audio: { packs: ["kenney-rpg-audio"] },
  };
  const again = styleFromLock(
    { family: "kenney-pixel", view: "side" },
    pack("kenney-pixel-platformer"),
    edited,
  );
  if (!("style" in again)) throw new Error(again.refusal);
  expect(again.style).toMatchObject({
    family: "kenney-pixel",
    mode: "pixel",
    tile: 16,
    palette: "kenney-tiny-dungeon",
    anchor: "art/key-art.png",
    audio: { packs: ["kenney-rpg-audio"] },
  });
  expect(again.style.rig).toBeUndefined();
  expect(
    styleFromLock({ family: "kenney-interface", view: "side" }, pack("kenney-ui-pack"), null),
  ).toHaveProperty("refusal");
});
