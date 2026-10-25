// @effect-diagnostics nodeBuiltinImport:off -- The test reads the real shipped bytes and installs into a temporary game.
import { expect, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as GameArtKits from "./GameArtKits.ts";
import { gameArtKitCatalog } from "./artKitCatalog.ts";

const sha256 = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const withTemporaryDirectory = <A, E, R>(run: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-art-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      return yield* run(directory);
    }),
  );

const withTemporaryGame = <A, E, R>(
  run: (input: { readonly root: string }) => Effect.Effect<A, E, R>,
) =>
  withTemporaryDirectory((base) =>
    Effect.gen(function* () {
      const root = NodePath.join(base, "game");
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "godot"), { recursive: true }));
      return yield* run({ root });
    }),
  );

it.live("each shipped kit's bytes, atlas and sheet sizes and license match its catalog", () =>
  Effect.gen(function* () {
    const directory = yield* GameArtKits.resolveArtKitsDirectory(import.meta.dirname);
    for (const kit of gameArtKitCatalog) {
      for (const file of kit.files) {
        const bytes = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(directory, kit.id, file.path)),
        );
        expect(bytes.byteLength).toBe(file.bytes);
        expect(sha256(bytes)).toBe(file.sha256);
      }
      const atlas = kit.files.find((file) => file.role === "atlas")!;
      const image = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(directory, kit.id, atlas.path)),
      );
      expect(image.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(image.readUInt32BE(16)).toBe(atlas.width);
      expect(image.readUInt32BE(20)).toBe(atlas.height);
      expect(kit.atlas.imageWidth).toBe(atlas.width);
      expect(kit.atlas.imageHeight).toBe(atlas.height);
      expect(atlas.width).toBe(
        kit.atlas.columns * kit.atlas.tileWidth +
          (kit.atlas.columns - 1) * kit.atlas.spacing +
          2 * kit.atlas.margin,
      );
      for (const sheet of kit.additionalSheets) {
        const sheetFile = kit.files.find((file) => file.path === sheet.image)!;
        expect(sheetFile.role).toBe("sheet");
        const sheetImage = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(directory, kit.id, sheet.image)),
        );
        expect(sheetImage.subarray(1, 4).toString("ascii")).toBe("PNG");
        expect(sheetImage.readUInt32BE(16)).toBe(sheet.imageWidth);
        expect(sheetImage.readUInt32BE(20)).toBe(sheet.imageHeight);
        expect(sheetFile.width).toBe(sheet.imageWidth);
        expect(sheetFile.height).toBe(sheet.imageHeight);
      }
      const license = yield* Effect.promise(() =>
        NodeFSP.readFile(
          NodePath.join(directory, kit.id, kit.files.find((file) => file.role === "license")!.path),
          "utf8",
        ),
      );
      expect(license).toContain("Creative Commons Zero, CC0");
      expect(license).toContain("kenney.nl");
      expect(license).toContain(kit.name.replace("Kenney ", ""));
      expect(kit.license.url).toContain("creativecommons.org/publicdomain/zero/1.0");
      expect(kit.source.url).toContain("kenney.nl/assets/");
      expect(kit.source.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  }),
);

it.effect("search matches an exact style or a literal word and never guesses", () => {
  const kits = GameArtKits.make(gameArtKitCatalog);
  return Effect.gen(function* () {
    const pixel = yield* kits.search({ style: "pixel-art" });
    expect(pixel.kits.map((kit) => kit.id)).toEqual([
      "kenney-pixel-platformer",
      "kenney-tiny-dungeon",
    ]);
    const dungeon = (yield* kits.search({ text: "dungeon" })).kits[0]!;
    expect(dungeon.contents.length).toBeGreaterThan(0);
    expect(dungeon.atlas.tileWidth).toBe(16);
    expect(dungeon.atlas.imageWidth).toBe(192);
    expect(dungeon.atlas.imageHeight).toBe(176);
    expect(dungeon.license.name).toBe("CC0-1.0");
    expect(dungeon.source.archiveUrl).toContain("kenney_tiny-dungeon.zip");
    expect(dungeon.usage).toContain("row-major");

    const platformer = (yield* kits.search({ style: "platformer" })).kits;
    expect(platformer.map((kit) => kit.id)).toEqual(["kenney-pixel-platformer"]);
    expect(platformer[0]?.additionalSheets.map((sheet) => sheet.name)).toEqual(["characters"]);
    expect(platformer[0]?.additionalSheets[0]?.use).toContain("Rect2(col*24, row*24, 24, 24)");
    expect((yield* kits.search({ text: "stone" })).kits.map((kit) => kit.id)).toEqual([
      "kenney-tiny-dungeon",
    ]);
    expect((yield* kits.search({ text: "platformer" })).kits.map((kit) => kit.id)).toEqual([
      "kenney-pixel-platformer",
    ]);
    expect((yield* kits.search({ text: "animation" })).kits.map((kit) => kit.id)).toEqual([
      "kenney-pixel-platformer",
    ]);
    expect((yield* kits.search({ text: "top-down" })).kits.map((kit) => kit.id)).toEqual([
      "kenney-tiny-dungeon",
    ]);

    expect((yield* kits.search({ style: "photorealistic" })).kits).toEqual([]);
    expect((yield* kits.search({ text: "kenney" })).kits).toHaveLength(2);
    expect((yield* kits.search({ text: "racing" })).kits).toEqual([]);
    expect((yield* kits.search({ style: "pixel-art", text: "dungeon" })).kits).toHaveLength(1);
    expect((yield* kits.search({ style: "pixel-art", text: "racing" })).kits).toEqual([]);
    expect((yield* kits.search({})).kits).toHaveLength(gameArtKitCatalog.length);
  });
});

it.effect("get returns the declared files and an unknown id names the catalog", () => {
  const kits = GameArtKits.make(gameArtKitCatalog);
  return Effect.gen(function* () {
    const result = yield* kits.get({ id: "kenney-tiny-dungeon" });
    expect(result.kit.files.map((file) => file.path)).toEqual([
      "tilemap_packed.png",
      "License.txt",
      "PROVENANCE.md",
    ]);
    expect(result.kit.atlas.tileCount).toBe(132);
    expect(result.kit.additionalSheets).toEqual([]);

    const platformer = yield* kits.get({ id: "kenney-pixel-platformer" });
    expect(platformer.kit.files.map((file) => file.role)).toEqual([
      "atlas",
      "sheet",
      "license",
      "provenance",
    ]);
    expect(platformer.kit.atlas.tileCount).toBe(180);
    expect(platformer.kit.additionalSheets[0]?.tileCount).toBe(27);
    expect(platformer.kit.usage).toContain("Rect2(col*18, row*18, 18, 18)");
    expect(platformer.kit.usage).toContain("left/middle/right");
    expect(platformer.kit.license.attribution).toContain("Kenney");

    const error = yield* kits.get({ id: "not-a-kit" }).pipe(Effect.flip);
    expect(error.message).toContain("kenney-tiny-dungeon");
    expect(error.message).toContain("kenney-pixel-platformer");
  });
});

it("rejects a catalog whose atlas grid does not fit its declared image", () => {
  const kit = gameArtKitCatalog.find((entry) => entry.id === "kenney-tiny-dungeon")!;
  expect(() => GameArtKits.make([{ ...kit, atlas: { ...kit.atlas, columns: 13 } }])).toThrow();
});

it("rejects a catalog sheet whose grid does not fit its image or file", () => {
  const kit = gameArtKitCatalog.find((entry) => entry.id === "kenney-pixel-platformer")!;
  expect(() =>
    GameArtKits.make([
      {
        ...kit,
        additionalSheets: [{ ...kit.additionalSheets[0]!, columns: 10 }],
      },
    ]),
  ).toThrow(/sheet 'characters'/);
  expect(() =>
    GameArtKits.make([
      {
        ...kit,
        additionalSheets: [{ ...kit.additionalSheets[0]!, image: "tilemap_packed.png" }],
      },
    ]),
  ).toThrow();
});

it("rejects a catalog file path that could escape the kit directory", () => {
  const kit = gameArtKitCatalog.find((entry) => entry.id === "kenney-tiny-dungeon")!;
  expect(() =>
    GameArtKits.make([
      {
        ...kit,
        files: kit.files.map((file) =>
          file.role === "atlas" ? { ...file, path: "../escape.png" } : file,
        ),
      },
    ]),
  ).toThrow();
});

it.live("install copies only the declared files and returns real resource paths", () =>
  withTemporaryGame(({ root }) =>
    Effect.gen(function* () {
      const service = GameArtKits.make(gameArtKitCatalog);
      const result = yield* service.install({
        root,
        godotProject: "godot",
        id: "kenney-tiny-dungeon",
      });
      expect(result.alreadyPresent).toBe(false);
      expect(result.destination).toBe("godot/assets/art/kits/kenney-tiny-dungeon");
      expect(result.atlas).toEqual({
        imageResPath: "res://assets/art/kits/kenney-tiny-dungeon/tilemap_packed.png",
        imageWidth: 192,
        imageHeight: 176,
        tileWidth: 16,
        tileHeight: 16,
        columns: 12,
        rows: 11,
        tileCount: 132,
        margin: 0,
        spacing: 0,
      });
      expect(result.files.map((file) => file.resPath)).toEqual([
        "res://assets/art/kits/kenney-tiny-dungeon/tilemap_packed.png",
        "res://assets/art/kits/kenney-tiny-dungeon/License.txt",
        "res://assets/art/kits/kenney-tiny-dungeon/PROVENANCE.md",
      ]);
      const entries = yield* Effect.promise(() =>
        NodeFSP.readdir(NodePath.join(root, result.destination), { recursive: true }),
      );
      expect(entries.sort()).toEqual(["License.txt", "PROVENANCE.md", "tilemap_packed.png"]);
      const installed = yield* Effect.promise(() =>
        NodeFSP.readFile(
          NodePath.join(root, "godot/assets/art/kits/kenney-tiny-dungeon/tilemap_packed.png"),
        ),
      );
      const repositoryKit = yield* GameArtKits.resolveArtKitsDirectory(import.meta.dirname);
      const expected = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(repositoryKit, "kenney-tiny-dungeon/tilemap_packed.png")),
      );
      expect(installed.equals(expected)).toBe(true);
    }),
  ),
);

it.live("a platformer import copies both sheets and returns their real resource paths", () =>
  withTemporaryGame(({ root }) =>
    Effect.gen(function* () {
      const service = GameArtKits.make(gameArtKitCatalog);
      const result = yield* service.install({
        root,
        godotProject: "godot",
        id: "kenney-pixel-platformer",
      });
      expect(result.alreadyPresent).toBe(false);
      expect(result.destination).toBe("godot/assets/art/kits/kenney-pixel-platformer");
      expect(result.files.map((file) => file.role)).toEqual([
        "atlas",
        "sheet",
        "license",
        "provenance",
      ]);
      expect(result.atlas).toEqual({
        imageResPath: "res://assets/art/kits/kenney-pixel-platformer/tilemap_packed.png",
        imageWidth: 360,
        imageHeight: 162,
        tileWidth: 18,
        tileHeight: 18,
        columns: 20,
        rows: 9,
        tileCount: 180,
        margin: 0,
        spacing: 0,
      });
      expect(result.additionalSheets).toEqual([
        expect.objectContaining({
          name: "characters",
          imageResPath:
            "res://assets/art/kits/kenney-pixel-platformer/tilemap-characters_packed.png",
          imageWidth: 216,
          imageHeight: 72,
          tileWidth: 24,
          tileHeight: 24,
          columns: 9,
          rows: 3,
          tileCount: 27,
          margin: 0,
          spacing: 0,
        }),
      ]);
      const entries = yield* Effect.promise(() =>
        NodeFSP.readdir(NodePath.join(root, result.destination), { recursive: true }),
      );
      expect(entries.sort()).toEqual([
        "License.txt",
        "PROVENANCE.md",
        "tilemap-characters_packed.png",
        "tilemap_packed.png",
      ]);
      const installedSheet = yield* Effect.promise(() =>
        NodeFSP.readFile(
          NodePath.join(
            root,
            "godot/assets/art/kits/kenney-pixel-platformer/tilemap-characters_packed.png",
          ),
        ),
      );
      expect(installedSheet).toHaveLength(1990);
    }),
  ),
);

it.live("a repeated import preserves files and user additions without writing", () =>
  withTemporaryGame(({ root }) =>
    Effect.gen(function* () {
      const service = GameArtKits.make(gameArtKitCatalog);
      const first = yield* service.install({
        root,
        godotProject: "godot",
        id: "kenney-tiny-dungeon",
      });
      const directory = NodePath.join(root, first.destination);
      const atlas = NodePath.join(directory, "tilemap_packed.png");
      const userFile = NodePath.join(directory, "notes.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(userFile, "mine\n"));
      const before = yield* Effect.promise(() => NodeFSP.stat(atlas));

      const second = yield* service.install({
        root,
        godotProject: "godot",
        id: "kenney-tiny-dungeon",
      });
      const after = yield* Effect.promise(() => NodeFSP.stat(atlas));
      expect(second.alreadyPresent).toBe(true);
      expect(second.files).toEqual(first.files);
      expect(second.message).toContain("already imported unchanged");
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(yield* Effect.promise(() => NodeFSP.readFile(userFile, "utf8"))).toBe("mine\n");
    }),
  ),
);

it.live("a conflicting user file is refused before any kit file is written", () =>
  withTemporaryGame(({ root }) =>
    Effect.gen(function* () {
      const service = GameArtKits.make(gameArtKitCatalog);
      const destination = NodePath.join(root, "godot/assets/art/kits/kenney-tiny-dungeon");
      yield* Effect.promise(() => NodeFSP.mkdir(destination, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(destination, "tilemap_packed.png"), "user edit"),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(destination, "notes.txt"), "keep"),
      );
      const error = yield* service
        .install({ root, godotProject: "godot", id: "kenney-tiny-dungeon" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("GameOperationError");
      expect(error.reason).toBe("art-kit-conflict");
      expect(error.detail).toContain("tilemap_packed.png");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(destination, "tilemap_packed.png"), "utf8"),
        ),
      ).toBe("user edit");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(destination, "notes.txt"), "utf8"),
        ),
      ).toBe("keep");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.stat(NodePath.join(destination, "License.txt")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.stat(NodePath.join(destination, "PROVENANCE.md")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
    }),
  ),
);

it.live.skipIf(!symlinksSupported)(
  "refuses a symlinked ancestor and writes nothing outside the game",
  () =>
    withTemporaryGame(({ root }) =>
      Effect.gen(function* () {
        const outside = NodePath.join(NodePath.dirname(root), "outside");
        const linked = NodePath.join(root, "godot/assets");
        yield* Effect.promise(() => NodeFSP.mkdir(outside));
        yield* Effect.promise(() => NodeFSP.symlink(outside, linked, "dir"));
        const service = GameArtKits.make(gameArtKitCatalog);
        const error = yield* service
          .install({ root, godotProject: "godot", id: "kenney-tiny-dungeon" })
          .pipe(Effect.flip);
        expect(error._tag).toBe("GameOperationError");
        expect(error.reason).toBe("art-kit-conflict");
        expect(error.path).toBe(linked);
        expect(error.detail).toContain("symbolic link");
        expect(yield* Effect.promise(() => NodeFSP.readdir(outside))).toEqual([]);
        expect((yield* Effect.promise(() => NodeFSP.lstat(linked))).isSymbolicLink()).toBe(true);
      }),
    ),
);

it.live.skipIf(!symlinksSupported)(
  "refuses a symlinked kit destination without reading or damaging its target",
  () =>
    withTemporaryGame(({ root }) =>
      Effect.gen(function* () {
        const outside = NodePath.join(NodePath.dirname(root), "outside");
        const destination = NodePath.join(root, "godot/assets/art/kits/kenney-tiny-dungeon");
        const outsideFile = NodePath.join(outside, "tilemap_packed.png");
        yield* Effect.promise(() =>
          NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true }),
        );
        yield* Effect.promise(() => NodeFSP.mkdir(outside));
        yield* Effect.promise(() => NodeFSP.writeFile(outsideFile, "outside"));
        yield* Effect.promise(() => NodeFSP.symlink(outside, destination, "dir"));
        const service = GameArtKits.make(gameArtKitCatalog);
        const error = yield* service
          .install({ root, godotProject: "godot", id: "kenney-tiny-dungeon" })
          .pipe(Effect.flip);
        expect(error._tag).toBe("GameOperationError");
        expect(error.reason).toBe("art-kit-conflict");
        expect(error.path).toBe(destination);
        expect(error.detail).toContain("symbolic link");
        expect(yield* Effect.promise(() => NodeFSP.readdir(outside))).toEqual([
          "tilemap_packed.png",
        ]);
        expect(yield* Effect.promise(() => NodeFSP.readFile(outsideFile, "utf8"))).toBe("outside");
        expect((yield* Effect.promise(() => NodeFSP.lstat(destination))).isSymbolicLink()).toBe(
          true,
        );
      }),
    ),
);

it.live("resolves the packaged layout beside the bundle and the dev layout in the checkout", () =>
  withTemporaryDirectory((base) =>
    Effect.gen(function* () {
      const packaged = NodePath.join(base, "dist");
      const packagedKits = NodePath.join(packaged, "art-kits");
      yield* Effect.promise(() => NodeFSP.mkdir(packagedKits, { recursive: true }));
      expect(yield* GameArtKits.resolveArtKitsDirectory(packaged)).toBe(packagedKits);

      const source = NodePath.join(base, "src/game");
      const checkoutKits = NodePath.join(base, "assets/art-kits");
      yield* Effect.promise(() => NodeFSP.mkdir(checkoutKits, { recursive: true }));
      expect(yield* GameArtKits.resolveArtKitsDirectory(source)).toBe(checkoutKits);

      const missing = yield* GameArtKits.resolveArtKitsDirectory(
        NodePath.join(base, "missing"),
      ).pipe(Effect.flip);
      expect(missing.reason).toBe("art-kits-missing");
    }),
  ),
);
