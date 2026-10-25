import type { GameArtKit } from "@t3tools/contracts";

/**
 * The optional shipped art kits. This is a closed catalog: search and get serve
 * exactly these entries, and import copies exactly the files listed here.
 *
 * The entries describe art in engine-neutral terms. The Godot adapter belongs
 * at the install boundary (`GameArtKits.install`), not in this data.
 */
export const gameArtKitCatalog: ReadonlyArray<GameArtKit> = [
  {
    id: "kenney-tiny-dungeon",
    version: 1,
    name: "Kenney Tiny Dungeon",
    summary:
      "A compact 16×16 pixel-art dungeon atlas: terrain, doors, stairs, furniture, characters, weapons, potions and UI pieces.",
    styles: ["pixel-art", "top-down", "dungeon", "fantasy", "roguelike", "16x16"],
    contents: [
      "Stone floors, walls, doors, stairs and ladders",
      "Chests, barrels, crates, tables, shelves, fences and bars",
      "Front-facing hero, skeleton, slime, bat and other character sprites",
      "Swords, axes, hammers, staffs, potions and torches",
      "Window, panel and slot pieces for a simple UI",
    ],
    usage:
      "One image atlas: 12 columns × 11 rows, row-major from the top-left, 16×16 cells with no margin or spacing. Some objects occupy several adjacent cells, so read the image or use region coordinates rather than assuming every cell is a standalone tile. Scale by whole numbers to keep pixels crisp.",
    license: {
      name: "CC0-1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      attribution: "Kenney (www.kenney.nl) — credit optional under CC0",
    },
    source: {
      title: "Kenney Tiny Dungeon 1.0",
      url: "https://kenney.nl/assets/tiny-dungeon",
      archiveUrl:
        "https://kenney.nl/media/pages/assets/tiny-dungeon/f8422efb44-1674742415/kenney_tiny-dungeon.zip",
      archiveSha256: "c109438ab06f65fd80f9b2686a4cf9c7c11dc64444b47333ec71d602f8bb5fc7",
      retrievedAt: "2026-10-24",
    },
    atlas: {
      image: "tilemap_packed.png",
      imageWidth: 192,
      imageHeight: 176,
      tileWidth: 16,
      tileHeight: 16,
      columns: 12,
      rows: 11,
      tileCount: 132,
      margin: 0,
      spacing: 0,
    },
    additionalSheets: [],
    files: [
      {
        path: "tilemap_packed.png",
        role: "atlas",
        bytes: 5294,
        sha256: "d24e60a41e4ac7a745c0304dfde121143688557f40215f23221c29cfe683825f",
        width: 192,
        height: 176,
      },
      {
        path: "License.txt",
        role: "license",
        bytes: 570,
        sha256: "9f574a2f1f636a3db8a0665ba90212f34e2b5e61ecb533d77c05237766374111",
      },
      {
        path: "PROVENANCE.md",
        role: "provenance",
        bytes: 745,
        sha256: "6602d20c6817879c8365996f8b8691cc5430244c8bab072b3a040bdc7c6f72b6",
      },
    ],
  },
  {
    id: "kenney-pixel-platformer",
    version: 1,
    name: "Kenney Pixel Platformer",
    summary:
      "A compact side-view platformer kit: 18×18 terrain, platforms, props and pickups on one atlas, plus a separate 24×24 character atlas with explorers, enemies and simple animation frames. Grass, dirt, stone and snow share one sheet, so recolor it for each game.",
    styles: ["pixel-art", "platformer", "side-view", "2d", "terrain", "characters", "animation"],
    contents: [
      "18×18 grass, dirt, stone and snow terrain with edges and fills",
      "Wooden platforms, rope bridges, ladders, fences and signs",
      "Coins, keys, hearts, gems, crates, trees, cacti, clouds and digits",
      "24×24 explorers, astronaut, box and flying enemies, robot and bat",
      "Two- and three-frame character variants for simple animation",
    ],
    usage:
      "Tiles: 20×9 cells of 18×18 px, no margin/spacing, row-major. Cell (col,row) is Rect2(col*18, row*18, 18, 18). Grass surface row 0 cols 0–3 (0 and 3 are edges), dirt fill cols 4–5; wooden platform row 2 cols 0–3; sign row 4 col 4; coin row 7 col 11; cloud row 7 cols 13–16. Draw at a whole-number scale with nearest filtering, and tint or recolor the sheet per game. Godot 4: var cell := AtlasTexture.new(); cell.atlas = load(IMAGE); cell.region = Rect2(col*18, row*18, 18, 18); sprite.texture = cell; sprite.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST.",
    license: {
      name: "CC0-1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      attribution: "Kenney (www.kenney.nl) — credit optional under CC0",
    },
    source: {
      title: "Kenney Pixel Platformer 1.2",
      url: "https://kenney.nl/assets/pixel-platformer",
      archiveUrl:
        "https://kenney.nl/media/pages/assets/pixel-platformer/33bb4921eb-1696667883/kenney_pixel-platformer.zip",
      archiveSha256: "d01a196dbe3cc964e00d83ba3b987df62f332dc9260c9f941b4fbcc9047130f4",
      retrievedAt: "2026-10-25",
    },
    atlas: {
      image: "tilemap_packed.png",
      imageWidth: 360,
      imageHeight: 162,
      tileWidth: 18,
      tileHeight: 18,
      columns: 20,
      rows: 9,
      tileCount: 180,
      margin: 0,
      spacing: 0,
    },
    additionalSheets: [
      {
        name: "characters",
        image: "tilemap-characters_packed.png",
        use: "Characters: 9×3 cells of 24×24 px, no margin/spacing, row-major. Cell (col,row) is Rect2(col*24, row*24, 24, 24). Explorers: green row 0 cols 0–1, blue 2–3, pink 4–5, yellow 6–7. Astronaut row 1 cols 0–1; box enemy row 1 cols 2–3; gold alien row 1 cols 4–5; flying enemy row 1 cols 6–8; robot row 2 cols 0–2; bat row 2 cols 6–8. The green pair reads as a two-frame step; bat and flying enemy have three frames. Use one, two or three frames at a low fps. Godot 4: cell.region = Rect2(col*24, row*24, 24, 24); sprite.flip_h handles facing; keep nearest filtering.",
        imageWidth: 216,
        imageHeight: 72,
        tileWidth: 24,
        tileHeight: 24,
        columns: 9,
        rows: 3,
        tileCount: 27,
        margin: 0,
        spacing: 0,
      },
    ],
    files: [
      {
        path: "tilemap_packed.png",
        role: "atlas",
        bytes: 5913,
        sha256: "a3bbff36594baa36c803a67e9152a20a80f2faeb3c22ca84ac06e0a70f56553d",
        width: 360,
        height: 162,
      },
      {
        path: "tilemap-characters_packed.png",
        role: "sheet",
        bytes: 1990,
        sha256: "22622d54dfc9d85346c9b75b999c8604e6eb336e42c4708bcf8b21094d8a2dad",
        width: 216,
        height: 72,
      },
      {
        path: "License.txt",
        role: "license",
        bytes: 710,
        sha256: "79ab2b701fe8047758bec141b4613084de4b96581279cbfd3d927414430e3dc1",
      },
      {
        path: "PROVENANCE.md",
        role: "provenance",
        bytes: 1310,
        sha256: "bb510fbd74e42a6380edddd6aa977a973e4a5c1632179fad83f3af1c726cef7c",
      },
    ],
  },
];
