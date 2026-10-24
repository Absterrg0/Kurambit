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
];
