#!/usr/bin/env node
/**
 * Pixel-art generator for the 2d-platformer starter template.
 *
 * The template ships no downloaded assets: every PNG under `assets/` is drawn here,
 * deterministically, so the whole look can be re-tuned by editing this file and
 * running `node tools/generate_art.mjs`. `tools/build_resources.gd` then turns the
 * PNGs into the TileSet and the SpriteFrames resources and rebuilds the level scenes.
 *
 * Art rules the drawings follow, so new tiles match the shipped ones:
 *   - 16x16 tiles on a 16px grid; sprites are 16x16 (the door 32x32, the flag 16x32).
 *   - light comes from the top-left: a bright rim on the top/left, shade on the
 *     bottom/right, and a 1px ink outline around anything that must read as an object.
 *   - transitions between materials are dithered, not blended, and every speckle
 *     sits at least 1px away from a tile edge so tiles repeat without seams.
 *
 * Everything is drawn with a seeded RNG, so a change here is a change to the game's
 * whole look, never a surprise on the next run.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const outputRoot = path.join(projectRoot, "assets");

// --------------------------------------------------------------------------- PNG

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

const encodePng = (image) => {
  const stride = image.width * 4 + 1;
  const raw = Buffer.alloc(stride * image.height);
  for (let y = 0; y < image.height; y++) {
    raw[y * stride] = 0;
    image.pixels.copy(raw, y * stride + 1, y * image.width * 4, (y + 1) * image.width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

// ------------------------------------------------------------------------ canvas

class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.pixels = Buffer.alloc(width * height * 4);
  }

  /** Draws one pixel; out-of-bounds writes are dropped so recipes need no clipping. */
  pixel(x, y, colour) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const [r, g, b, a = 255] = colour;
    const at = (py * this.width + px) * 4;
    if (a >= 255) {
      this.pixels[at] = r;
      this.pixels[at + 1] = g;
      this.pixels[at + 2] = b;
      this.pixels[at + 3] = 255;
      return;
    }
    const src = a / 255;
    const dst = this.pixels[at + 3] / 255;
    const out = src + dst * (1 - src);
    if (out <= 0) return;
    this.pixels[at] = Math.round((r * src + this.pixels[at] * dst * (1 - src)) / out);
    this.pixels[at + 1] = Math.round((g * src + this.pixels[at + 1] * dst * (1 - src)) / out);
    this.pixels[at + 2] = Math.round((b * src + this.pixels[at + 2] * dst * (1 - src)) / out);
    this.pixels[at + 3] = Math.round(out * 255);
  }

  /** Wraps horizontally, so background layers tile without a visible seam. */
  pixelWrapped(x, y, colour) {
    const wrapped = ((Math.round(x) % this.width) + this.width) % this.width;
    this.pixel(wrapped, y, colour);
  }

  rect(x, y, width, height, colour) {
    for (let row = 0; row < height; row++)
      for (let column = 0; column < width; column++) this.pixel(x + column, y + row, colour);
  }

  outline(x, y, width, height, colour) {
    for (let column = 0; column < width; column++) {
      this.pixel(x + column, y, colour);
      this.pixel(x + column, y + height - 1, colour);
    }
    for (let row = 0; row < height; row++) {
      this.pixel(x, y + row, colour);
      this.pixel(x + width - 1, y + row, colour);
    }
  }

  disc(centreX, centreY, radius, colour) {
    for (let y = Math.floor(centreY - radius); y <= Math.ceil(centreY + radius); y++)
      for (let x = Math.floor(centreX - radius); x <= Math.ceil(centreX + radius); x++) {
        const dx = x - centreX;
        const dy = y - centreY;
        if (dx * dx + dy * dy <= radius * radius) this.pixel(x, y, colour);
      }
  }

  ellipse(centreX, centreY, radiusX, radiusY, colour) {
    for (let y = Math.floor(centreY - radiusY); y <= Math.ceil(centreY + radiusY); y++)
      for (let x = Math.floor(centreX - radiusX); x <= Math.ceil(centreX + radiusX); x++) {
        const dx = (x - centreX) / radiusX;
        const dy = (y - centreY) / radiusY;
        if (dx * dx + dy * dy <= 1) this.pixel(x, y, colour);
      }
  }

  /** Draws a small pixel-art matrix: rows of characters, `legend` maps them to colours. */
  matrix(originX, originY, rows, legend) {
    for (let y = 0; y < rows.length; y++) {
      if (rows[y].length !== rows[0].length)
        throw new Error(`ragged pixel matrix row ${y}: ${rows[y]}`);
      for (let x = 0; x < rows[y].length; x++) {
        const key = rows[y][x];
        if (key === "." || key === " ") continue;
        const colour = legend[key];
        if (!colour) throw new Error(`no colour for '${key}'`);
        this.pixel(originX + x, originY + y, colour);
      }
    }
  }
}

/** Nearest-neighbour scale, for the preview sheet only. */
const scaled = (image, factor) => {
  const out = new Canvas(image.width * factor, image.height * factor);
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const at = (Math.floor(y / factor) * image.width + Math.floor(x / factor)) * 4;
      out.pixel(x, y, [
        image.pixels[at],
        image.pixels[at + 1],
        image.pixels[at + 2],
        image.pixels[at + 3],
      ]);
    }
  return out;
};

const paste = (target, source, x, y) => {
  for (let row = 0; row < source.height; row++)
    for (let column = 0; column < source.width; column++) {
      const at = (row * source.width + column) * 4;
      const alpha = source.pixels[at + 3];
      if (alpha === 0) continue;
      target.pixel(x + column, y + row, [
        source.pixels[at],
        source.pixels[at + 1],
        source.pixels[at + 2],
        alpha,
      ]);
    }
};

// ---------------------------------------------------------------------- palette

const hex = (value) => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
  255,
];

/** Mixes `colour` toward black (negative) or white (positive) by `amount` (0..1). */
const shift = (colour, amount) => {
  const target = amount >= 0 ? 255 : 0;
  const mix = Math.abs(amount);
  return [
    Math.round(colour[0] + (target - colour[0]) * mix),
    Math.round(colour[1] + (target - colour[1]) * mix),
    Math.round(colour[2] + (target - colour[2]) * mix),
    colour[3],
  ];
};

const withAlpha = (colour, alpha) => [colour[0], colour[1], colour[2], alpha];

/**
 * Dusk palette, arranged as value layers. Background bands stay darker and less
 * saturated than the playfield; grass and the first soil row are the mid values; the
 * player, hazards, coins and the goal carry the brightest, most saturated colours.
 * Those roles are mirrored in `assets/palette.tres` (written at the bottom of this
 * file) so runtime effects and these drawings cannot drift apart.
 */
const palette = {
  skyTop: hex("#12132b"),
  skyHigh: hex("#241f47"),
  skyMid: hex("#46284f"),
  skyLow: hex("#7b3c4d"),
  skyGlow: hex("#d26a45"),
  star: hex("#d9d4e8"),

  ridgeFar: hex("#2c2549"),
  ridgeFarLit: hex("#3f335f"),
  ridgeMid: hex("#211c3c"),
  ridgeMidLit: hex("#30274f"),
  vegNear: hex("#121022"),
  vegNearLit: hex("#1e1934"),

  moonHi: hex("#fff6da"),
  moon: hex("#f2dfb0"),
  moonDark: hex("#d3bd91"),
  moonGlow: hex("#f6dfae"),

  grassHi: hex("#a7dc74"),
  grass: hex("#5f9a4a"),
  grassDark: hex("#3d7236"),
  grassDeep: hex("#295126"),

  dirtHi: hex("#7c5338"),
  dirt: hex("#5c3a26"),
  dirtDark: hex("#42291b"),
  dirtDeep: hex("#2e1d13"),
  bedrock: hex("#241811"),
  pebble: hex("#8b6749"),

  stoneHi: hex("#99a3c6"),
  stone: hex("#667092"),
  stoneDark: hex("#454d6d"),
  stoneDeep: hex("#2c314c"),
  ink: hex("#191228"),

  woodHi: hex("#e0a869"),
  wood: hex("#ab7241"),
  woodDark: hex("#794c27"),
  woodDeep: hex("#4b2d16"),

  scarfHi: hex("#ffc27a"),
  scarf: hex("#f2763c"),
  scarfDark: hex("#c04b23"),
  tunicHi: hex("#8ff7ea"),
  tunic: hex("#45cfc2"),
  tunicDark: hex("#2a8a83"),
  skin: hex("#ffd3a3"),
  skinDark: hex("#dda878"),
  hairHi: hex("#7a6aa6"),
  hair: hex("#332c4d"),
  boot: hex("#3b3358"),
  bootHi: hex("#5d5288"),

  hazardHi: hex("#ffd17a"),
  hazard: hex("#ff5b3a"),
  hazardDark: hex("#c22a20"),
  hazardDeep: hex("#6e1512"),

  slimeHi: hex("#ff9bc0"),
  slime: hex("#e0568f"),
  slimeDark: hex("#b23a72"),
  slimeDeep: hex("#7d2450"),

  goldHi: hex("#fff3b0"),
  gold: hex("#ffd24a"),
  goldMid: hex("#e0a12c"),
  goldDark: hex("#a86a17"),

  portalHi: hex("#c8fbff"),
  portal: hex("#63d8f0"),
  portalMid: hex("#2f9dc9"),
  portalDark: hex("#1b5f8c"),
  portalDeep: hex("#123a5e"),

  flagLit: hex("#7defa2"),
  flagLitDark: hex("#33ab63"),
  flagIdle: hex("#a3abc7"),
  flagIdleDark: hex("#6f7791"),
  metalHi: hex("#e6ecff"),
  metal: hex("#b2bbd8"),
  metalDark: hex("#78809f"),
  metalDeep: hex("#464d6b"),
};

// ----------------------------------------------------------------- deterministic

/** Small seeded RNG (numerical recipes LCG) so every run redraws the same pixels. */
const rng = (seed) => {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
};

// ------------------------------------------------------------------------ tiles

const TILE = 16;
const TILE_COLUMNS = 8;
const TILE_ROWS = 3;

/** Atlas coordinates of every tile, mirrored by `tools/build_resources.gd`. */
const TILES = {
  grassA: [0, 0],
  grassB: [1, 0],
  grassLeft: [2, 0],
  grassRight: [3, 0],
  dirtA: [4, 0],
  dirtB: [5, 0],
  dirtLeft: [6, 0],
  dirtRight: [7, 0],
  stoneTop: [0, 1],
  stoneFill: [1, 1],
  plankLeft: [2, 1],
  plankMid: [3, 1],
  plankRight: [4, 1],
  spikes: [5, 1],
  tuft: [6, 1],
  flower: [7, 1],
  pebble: [0, 2],
  bush: [1, 2],
  rock: [2, 2],
  mushroom: [3, 2],
  soilA: [4, 2],
  soilB: [5, 2],
  bedrock: [6, 2],
};

/** The grass surface, drawn once per tile: three grass rows over dithered soil. */
const drawGrassBand = (tile, variant) => {
  const random = rng(variant === 0 ? 0x51ed : 0x77a1);
  // Rim light along the very top, broken up by tufts so long ledges do not read as a line.
  for (let x = 0; x < TILE; x++) {
    const tuft = random() < 0.22;
    tile.pixel(x, 0, tuft ? palette.grass : palette.grassHi);
    tile.pixel(x, 1, random() < 0.3 ? palette.grassHi : palette.grass);
    tile.pixel(x, 2, palette.grass);
    tile.pixel(x, 3, random() < 0.25 ? palette.grassDark : palette.grass);
  }
  for (let x = 0; x < TILE; x++) {
    // Dither row: grass dissolving into soil.
    tile.pixel(x, 4, (x + variant) % 2 === 0 ? palette.grassDeep : palette.dirtHi);
    tile.pixel(x, 5, palette.dirtHi);
  }
};

const drawSoil = (tile, variant) => {
  const random = rng(variant === 0 ? 0x2bad : 0x9f31);
  tile.rect(0, 6, TILE, 9, palette.dirt);
  for (let x = 0; x < TILE; x++) tile.pixel(x, 15, palette.dirtDark);
  // Speckles stay 2px clear of every edge, so the tile repeats with no visible grid.
  // Only a handful per tile: a dense speckle field reads as noise and pulls the eye
  // down, away from the playfield.
  for (let index = 0; index < 3; index++) {
    const x = 2 + Math.floor(random() * 12);
    const y = 7 + Math.floor(random() * 6);
    tile.pixel(x, y, palette.dirtDark);
    if (random() < 0.25) tile.pixel(x, y + 1, palette.dirtDeep);
  }
  tile.pixel(4 + Math.floor(random() * 8), 10 + Math.floor(random() * 3), palette.pebble);
};

/**
 * Subsoil rows: the second row under the grass keeps a little structure, and the
 * bedrock below it is almost solid colour. A player never reads individual stones
 * down there, so the low frequency is what stops the ground from dominating the
 * frame; depth is carried by the value step, not by detail.
 */
const drawSubsoil = (tile, variant) => {
  const random = rng(variant === 0 ? 0x51c3 : 0x8e27);
  tile.rect(0, 0, TILE, TILE, palette.dirtDark);
  for (let x = 0; x < TILE; x++) tile.pixel(x, 0, shift(palette.dirtDark, 0.05));
  for (let index = 0; index < 6; index++)
    tile.pixel(1 + Math.floor(random() * 14), 2 + Math.floor(random() * 13), palette.dirtDeep);
  tile.pixel(5 + Math.floor(random() * 6), 4 + Math.floor(random() * 8), palette.dirt);
};

const drawBedrock = (tile) => {
  const random = rng(0x1f4c);
  tile.rect(0, 0, TILE, TILE, palette.bedrock);
  for (let index = 0; index < 5; index++)
    tile.pixel(1 + Math.floor(random() * 14), 1 + Math.floor(random() * 14), palette.dirtDeep);
  tile.pixel(7, 13, withAlpha(palette.pebble, 70));
};

/** Darkens one vertical edge of a terrain tile: the silhouette of the block. */
const drawRim = (tile, side) => {
  const x = side === "left" ? 0 : TILE - 1;
  const inner = side === "left" ? 1 : TILE - 2;
  for (let y = 4; y < TILE; y++) {
    tile.pixel(x, y, palette.dirtDeep);
    tile.pixel(inner, y, y === 4 ? palette.grassDeep : palette.dirtDark);
  }
  // Corner: the grass band turns down over the edge instead of stopping flat.
  tile.pixel(x, 0, palette.grassDark);
  tile.pixel(x, 1, palette.grassDark);
  tile.pixel(x, 2, palette.grassDark);
  tile.pixel(x, 3, palette.grassDeep);
  tile.pixel(inner, 3, palette.grassDark);
};

const drawStone = (tile, top) => {
  tile.rect(0, 0, TILE, TILE, palette.stone);
  if (top) {
    for (let x = 0; x < TILE; x++) {
      tile.pixel(x, 0, palette.stoneHi);
      tile.pixel(x, 1, x % 4 === 3 ? palette.stone : palette.stoneHi);
    }
  } else {
    // Buried blocks keep a thin lit edge so stacked stone reads as blocks, not a slab.
    for (let x = 0; x < TILE; x++) tile.pixel(x, 0, palette.stoneHi);
  }
  for (let x = 0; x < TILE; x++) tile.pixel(x, 7, palette.stoneDark);
  for (let x = 0; x < TILE; x++) tile.pixel(x, 8, palette.stoneDeep);
  for (let x = 0; x < TILE; x++) tile.pixel(x, 15, palette.stoneDeep);
  // Staggered joints: the upper course breaks at the middle, the lower course at the edge.
  for (let y = 1; y < 7; y++) tile.pixel(8, y, top && y < 3 ? palette.stone : palette.stoneDeep);
  for (let y = 9; y < 15; y++) tile.pixel(15, y, palette.stoneDeep);
  const random = rng(top ? 0x4c1a : 0x1177);
  for (let index = 0; index < 4; index++)
    tile.pixel(
      2 + Math.floor(random() * 12),
      9 + Math.floor(random() * 5),
      random() < 0.5 ? palette.stoneDark : palette.stoneHi,
    );
};

const drawPlank = (tile, cap) => {
  const left = cap === "left";
  const right = cap === "right";
  for (let x = 0; x < TILE; x++) {
    tile.pixel(x, 0, palette.woodHi);
    tile.pixel(x, 1, palette.wood);
    tile.pixel(x, 2, x % 5 === 3 ? palette.woodDark : palette.wood);
    tile.pixel(x, 3, palette.woodDark);
    tile.pixel(x, 4, palette.woodDeep);
    tile.pixel(x, 5, palette.ink);
  }
  // Grain, kept away from the caps so runs of planks line up.
  tile.pixel(5, 1, palette.woodHi);
  tile.pixel(11, 2, palette.woodHi);
  // Nails.
  tile.pixel(left ? 2 : 1, 2, palette.metalDark);
  tile.pixel(right ? 13 : 14, 2, palette.metalDark);
  if (!left && !right) return;
  const edge = left ? 0 : TILE - 1;
  const inner = left ? 1 : TILE - 2;
  for (let y = 0; y < 5; y++) tile.pixel(edge, y, palette.ink);
  tile.pixel(inner, 0, palette.woodHi);
  tile.pixel(inner, 1, palette.wood);
  tile.pixel(inner, 2, palette.woodDark);
  tile.pixel(inner, 3, palette.woodDeep);
  tile.pixel(inner, 4, palette.ink);
  tile.pixel(edge, 5, palette.ink);
};

const SPIKE = [".hm.", ".hm.", "hmmd", "hmmd", "hmmd", "hmmd", "kkkk"];

/**
 * Spikes are the template's hazard, so they get the one reserved warning hue and the
 * brightest rim in the level. The base plate stays dark: the contrast is between the
 * hot blades and the ground, which is what makes a run of spikes read at a glance
 * instead of looking like a metal grate.
 */
const drawSpikes = (tile) => {
  const legend = {
    h: palette.hazardHi,
    m: palette.hazard,
    d: palette.hazardDark,
    k: palette.ink,
  };
  for (const offset of [0, 4, 8, 12]) tile.matrix(offset, 3, SPIKE, legend);
  // Floor plate the spikes are bolted to: a shadowed channel with a warning lip.
  for (let x = 0; x < TILE; x++) {
    tile.pixel(x, 10, palette.hazardDeep);
    tile.pixel(x, 11, palette.hazardDark);
    tile.pixel(x, 12, palette.hazardDeep);
    tile.pixel(x, 13, palette.ink);
    tile.pixel(x, 14, palette.ink);
    tile.pixel(x, 15, palette.ink);
  }
  for (let x = 2; x < TILE; x += 5) {
    tile.pixel(x, 10, palette.hazard);
    tile.pixel(x, 11, palette.hazardHi);
    tile.pixel(x, 12, palette.hazard);
    tile.pixel(x, 13, palette.hazardDeep);
  }
};

const drawTuft = (tile, variant) => {
  // Four blades of different heights, lit on the left, so a row of tufts still reads as grass.
  const blades = variant === 0 ? [2, 6, 9, 13] : [1, 5, 10, 12];
  const random = rng(variant === 0 ? 0x33aa : 0x91cc);
  for (const baseX of blades) {
    const height = 4 + Math.floor(random() * 4);
    for (let step = 0; step < height; step++) {
      const x = baseX + (step >= height - 2 ? 1 : 0);
      tile.pixel(x, 14 - step, step > height - 3 ? palette.grassHi : palette.grass);
    }
    tile.pixel(baseX, 15, palette.grassDark);
  }
  for (let x = 0; x < TILE; x++) tile.pixel(x, 15, x % 3 === 0 ? palette.grass : palette.grassDeep);
};

const drawFlower = (tile, variant) => {
  const petal = variant === 0 ? palette.scarf : palette.slime;
  const petalHi = variant === 0 ? palette.scarfHi : palette.slimeHi;
  const petalDark = variant === 0 ? palette.scarfDark : palette.slimeDeep;
  // Six-pixel bloom: a petal ring, a lit top-left quadrant and a gold centre.
  tile.ellipse(7.5, 8.5, 3.4, 3.4, petal);
  tile.ellipse(7.5, 8, 3.4, 2.6, petalHi);
  tile.ellipse(9, 10, 2.2, 1.8, petalDark);
  tile.rect(6, 7, 4, 3, palette.gold);
  tile.pixel(6, 7, palette.goldHi);
  tile.pixel(9, 9, palette.goldMid);
  // Stem and two leaves, standing on the soil line.
  for (let y = 12; y < 15; y++) tile.pixel(7, y, palette.grassDark);
  tile.pixel(6, 13, palette.grass);
  tile.pixel(8, 13, palette.grass);
  for (let x = 4; x < 12; x++) tile.pixel(x, 15, palette.grassDeep);
  tile.pixel(5, 15, palette.grassDark);
};

const drawPebble = (tile) => {
  // One stone with a lit face and an ink base, plus a smaller one beside it.
  const legend = { S: palette.stoneHi, s: palette.stone, d: palette.stoneDark, k: palette.ink };
  tile.matrix(
    1,
    10,
    [
      "...SSSS....SS...",
      "..SSssssk..Ssk..",
      ".SSsssssdk.Ssdk.",
      ".kssssssdk.kkdk.",
      "..kkkkkkk...kk..",
    ],
    legend,
  );
};

const drawBush = (tile) => {
  // Deliberately darker than the terrain: decoration must not out-shout the ground.
  const legend = {
    g: palette.grassDark,
    h: palette.grass,
    d: palette.grassDeep,
    e: palette.grassDeep,
  };
  tile.matrix(
    0,
    3,
    [
      "........hh......",
      "......hgggh.....",
      "....hggggggdh...",
      "..hgghggggggggd.",
      ".hgghhggggggggd.",
      "hgggggggggggggd.",
      "dggggggggggggde.",
      "ddggggggggggdde.",
      "eddgddgggddddee.",
      "eeedddddddddeee.",
      "eeeeeedeeeeeeeee",
      "eeeeeeeeeeeeeeee",
    ],
    legend,
  );
};

const drawRock = (tile) => {
  const legend = {
    S: palette.stoneHi,
    s: palette.stone,
    d: palette.stoneDark,
    e: palette.stoneDeep,
    k: palette.ink,
  };
  tile.matrix(
    1,
    4,
    [
      ".....kkkkkk.....",
      "...kkSSSSSSkk...",
      "..kSSSSsssssdk..",
      ".kSSSssssssssdk.",
      "kSSsssssssssssdk",
      "kSsssssssssssddk",
      "kdsssssssssddddk",
      ".kdeedddddeeddk.",
      "..kkkkkkkkkkkk..",
    ],
    legend,
  );
  // Moss on the crown: the rock belongs to this level, not to a tile sheet.
  tile.matrix(4, 3, ["..hhhh", ".hgggg", "hggggg"], { h: palette.grassHi, g: palette.grass });
};

const drawMushroom = (tile) => {
  const legend = {
    k: palette.ink,
    c: palette.portal,
    C: palette.portalHi,
    p: palette.portalMid,
    s: palette.skin,
  };
  tile.matrix(
    3,
    6,
    [
      "...kkkkkk...",
      ".kkCCCCCkk..",
      "kCCCCCCCCCk.",
      "kCpCCCCpCCk.",
      "kpCCCCCCpCk.",
      ".kppCCpppk..",
      "...kssssk...",
      "...kssssk...",
      "...kkkkkk...",
    ],
    legend,
  );
  // A faint glow puddle under the cap sells the dusk mood.
  tile.pixel(2, 15, withAlpha(palette.portal, 60));
  tile.pixel(11, 15, withAlpha(palette.portal, 60));
  tile.rect(4, 15, 6, 1, withAlpha(palette.portalMid, 80));
};

const buildTiles = () => {
  const atlas = new Canvas(TILE * TILE_COLUMNS, TILE * TILE_ROWS);
  const place = (at, draw) => {
    const tile = new Canvas(TILE, TILE);
    draw(tile);
    paste(atlas, tile, at[0] * TILE, at[1] * TILE);
  };
  place(TILES.grassA, (tile) => {
    drawGrassBand(tile, 0);
    drawSoil(tile, 0);
  });
  place(TILES.grassB, (tile) => {
    drawGrassBand(tile, 1);
    drawSoil(tile, 1);
  });
  place(TILES.grassLeft, (tile) => {
    drawGrassBand(tile, 0);
    drawSoil(tile, 0);
    drawRim(tile, "left");
  });
  place(TILES.grassRight, (tile) => {
    drawGrassBand(tile, 1);
    drawSoil(tile, 1);
    drawRim(tile, "right");
  });
  place(TILES.dirtA, (tile) => {
    tile.rect(0, 0, TILE, TILE, palette.dirt);
    drawSoil(tile, 0);
  });
  place(TILES.dirtB, (tile) => {
    tile.rect(0, 0, TILE, TILE, palette.dirt);
    drawSoil(tile, 1);
  });
  place(TILES.dirtLeft, (tile) => {
    tile.rect(0, 0, TILE, TILE, palette.dirt);
    drawSoil(tile, 0);
    drawRim(tile, "left");
  });
  place(TILES.dirtRight, (tile) => {
    tile.rect(0, 0, TILE, TILE, palette.dirt);
    drawSoil(tile, 1);
    drawRim(tile, "right");
  });
  place(TILES.stoneTop, (tile) => drawStone(tile, true));
  place(TILES.stoneFill, (tile) => drawStone(tile, false));
  place(TILES.plankLeft, (tile) => drawPlank(tile, "left"));
  place(TILES.plankMid, (tile) => drawPlank(tile, "mid"));
  place(TILES.plankRight, (tile) => drawPlank(tile, "right"));
  place(TILES.spikes, (tile) => drawSpikes(tile));
  place(TILES.soilA, (tile) => drawSubsoil(tile, 0));
  place(TILES.soilB, (tile) => drawSubsoil(tile, 1));
  place(TILES.bedrock, (tile) => drawBedrock(tile));
  place(TILES.tuft, (tile) => drawTuft(tile, 0));
  place(TILES.flower, (tile) => drawFlower(tile, 0));
  place(TILES.pebble, (tile) => drawPebble(tile));
  place(TILES.bush, (tile) => drawBush(tile));
  place(TILES.rock, (tile) => drawRock(tile));
  place(TILES.mushroom, (tile) => drawMushroom(tile));
  return atlas;
};

// ---------------------------------------------------------------------- sprites

const FRAME = 16;

/**
 * The hero, drawn part by part so every frame shares one set of proportions. The
 * sixteen rows are spent as: 6 head, 2 scarf, 4 torso, 4 legs — the classic small
 * platformer build, which keeps the head readable at 16px.
 */
const hero = (canvas, originX, originY, pose) => {
  const {
    bob = 0,
    legs = [0, 0],
    legLift = [0, 0],
    arms = [0, 0],
    lean = 0,
    scarf = [[0, 0]],
    eyes = 0,
  } = pose;
  const x = originX;
  const y = originY + bob;
  const ink = palette.ink;
  const torsoX = x + 4 + lean;
  const headY = y;

  // Contact shadow, so the sprite is planted on the ground rather than floating.
  canvas.rect(x + 4, originY + 15, 9, 1, withAlpha(ink, 70));

  // Scarf tail behind the shoulders: it streams out when the hero is moving.
  for (const [tailX, tailY] of scarf) {
    canvas.rect(torsoX - 2 + tailX, y + 7 + tailY, 4, 2, palette.scarfDark);
    canvas.rect(torsoX - 2 + tailX, y + 7 + tailY, 3, 1, palette.scarf);
    canvas.pixel(torsoX - 1 + tailX, y + 8 + tailY, ink);
  }

  // Legs, drawn before the torso so the tunic hem covers their tops.
  for (let index = 0; index < 2; index++) {
    const legX = torsoX + (index === 0 ? 1 : 4) + legs[index];
    const legY = y + 12 - legLift[index];
    const height = 4 + legLift[index];
    canvas.rect(legX, legY, 3, height, palette.boot);
    canvas.pixel(legX, legY, palette.bootHi);
    canvas.pixel(legX, legY + 1, palette.bootHi);
    canvas.pixel(legX, legY + height - 1, ink);
    canvas.pixel(legX + 2, legY + height - 1, ink);
  }

  // Arms, behind and in front of the torso.
  canvas.rect(torsoX - 1, y + 8 + arms[0], 2, 4, palette.tunicDark);
  canvas.pixel(torsoX - 1, y + 11 + arms[0], ink);
  canvas.rect(torsoX + 7, y + 8 + arms[1], 2, 4, palette.tunic);
  canvas.pixel(torsoX + 7, y + 8 + arms[1], palette.tunicHi);
  canvas.pixel(torsoX + 7, y + 11 + arms[1], ink);

  // Torso.
  canvas.rect(torsoX, y + 8, 8, 4, palette.tunic);
  canvas.outline(torsoX, y + 8, 8, 4, ink);
  canvas.rect(torsoX + 1, y + 9, 3, 2, palette.tunicHi);
  canvas.rect(torsoX + 5, y + 9, 2, 3, palette.tunicDark);

  // Scarf band across the shoulders, with a lit edge on top.
  canvas.rect(torsoX, y + 6, 8, 2, palette.scarf);
  canvas.rect(torsoX + 1, y + 6, 6, 1, palette.scarfHi);
  canvas.outline(torsoX, y + 6, 8, 2, palette.scarfDark);
  canvas.pixel(torsoX + 1, y + 7, palette.scarfDark);

  // Head: ink silhouette, hair cap, face with two eyes. The extra hair-top highlight
  // and lit left column are the rim light that keeps the hero readable against both
  // the dark background and the brown ground.
  canvas.rect(torsoX + 1, headY + 1, 6, 5, palette.skin);
  canvas.rect(torsoX + 1, headY + 1, 6, 2, palette.hair);
  canvas.pixel(torsoX + 2, headY + 1, palette.hairHi);
  canvas.pixel(torsoX + 5, headY + 1, palette.hairHi);
  canvas.pixel(torsoX + 6, headY + 0, palette.hairHi);
  canvas.pixel(torsoX + 3, headY + 2, palette.hair);
  canvas.rect(torsoX, headY + 1, 1, 5, ink);
  canvas.rect(torsoX + 7, headY + 1, 1, 5, ink);
  canvas.rect(torsoX + 1, headY, 6, 1, ink);
  canvas.rect(torsoX + 1, headY + 6, 6, 1, ink);
  canvas.pixel(torsoX + 2 + eyes, headY + 4, ink);
  canvas.pixel(torsoX + 5 + eyes, headY + 4, ink);
  canvas.pixel(torsoX + 4, headY + 5, palette.skinDark);
  canvas.pixel(torsoX + 1, headY + 3, palette.skin);
  canvas.pixel(torsoX + 1, headY + 4, palette.skin);
};

const HERO_POSES = {
  idleA: {
    bob: 0,
    legs: [0, 0],
    legLift: [0, 0],
    arms: [0, 0],
    scarf: [
      [0, 0],
      [-1, 1],
    ],
  },
  idleB: {
    bob: 1,
    legs: [0, 0],
    legLift: [0, 0],
    arms: [1, 1],
    scarf: [
      [0, 0],
      [-1, 2],
    ],
  },
  // Run cycle: contact, passing, contact (mirrored), passing (mirrored).
  runA: {
    bob: 0,
    legs: [-2, 1],
    legLift: [0, 1],
    arms: [2, -1],
    scarf: [
      [0, 0],
      [-1, 1],
      [-2, 2],
    ],
  },
  runB: {
    bob: 1,
    legs: [1, -1],
    legLift: [0, 0],
    arms: [0, 0],
    scarf: [
      [0, 1],
      [-1, 2],
    ],
  },
  runC: {
    bob: 0,
    legs: [1, -2],
    legLift: [1, 0],
    arms: [-1, 2],
    scarf: [
      [0, 0],
      [-1, 1],
      [-2, 2],
    ],
  },
  runD: {
    bob: 1,
    legs: [-1, 1],
    legLift: [0, 0],
    arms: [0, 0],
    scarf: [
      [0, 1],
      [-1, 2],
    ],
  },
  jump: {
    bob: -1,
    legs: [-1, 1],
    legLift: [2, 1],
    arms: [-1, -1],
    scarf: [
      [0, -1],
      [-1, 0],
      [-2, 1],
    ],
    eyes: 0,
  },
  fall: {
    bob: 0,
    legs: [-2, 2],
    legLift: [1, 1],
    arms: [2, 2],
    scarf: [
      [0, -2],
      [-1, -1],
    ],
  },
};

const buildPlayer = () => {
  const sheet = new Canvas(FRAME * 4, FRAME * 2);
  const order = ["idleA", "idleB", "runA", "runB", "runC", "runD", "jump", "fall"];
  order.forEach((name, index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    const frame = new Canvas(FRAME, FRAME);
    hero(frame, 0, 0, HERO_POSES[name]);
    paste(sheet, frame, column * FRAME, row * FRAME);
  });
  return sheet;
};

/** One slime frame: ink silhouette, lit top-left, shaded belly, two eyes, a mouth. */
const slimeFrame = (frame, width, height, squash) => {
  const top = 16 - height;
  const left = Math.round((16 - width) / 2);
  const centreX = left + (width - 1) / 2;
  frame.rect(left + 2, 15, width - 4, 1, withAlpha(palette.ink, 90));
  frame.ellipse(centreX, top + height / 2 - 0.5, width / 2, height / 2, palette.ink);
  frame.ellipse(centreX, top + height / 2 - 0.5, width / 2 - 1, height / 2 - 1, palette.slime);
  for (let y = top + 1; y < top + height - 1; y++)
    for (let x = left + 1; x < left + width - 1; x++) {
      const inside =
        ((x - centreX) / (width / 2 - 1)) ** 2 +
          ((y - (top + height / 2 - 0.5)) / (height / 2 - 1)) ** 2 <=
        1;
      if (!inside) continue;
      const depth = y - top;
      if (depth <= 1) frame.pixel(x, y, palette.slimeHi);
      else if (depth < height - 4) frame.pixel(x, y, palette.slime);
      else frame.pixel(x, y, palette.slimeDark);
    }
  // Specular blob, top-left of the crown.
  frame.pixel(left + 3, top + 2, palette.slimeHi);
  frame.pixel(left + 4, top + 2, palette.slimeHi);
  frame.pixel(left + 3, top + 3, palette.slimeHi);
  const eyeY = top + height - 6 + squash;
  for (const eyeX of [left + 4, left + width - 7]) {
    frame.rect(eyeX, eyeY, 2, 3, palette.ink);
    frame.pixel(eyeX, eyeY, palette.portalHi);
  }
  frame.rect(left + Math.round(width / 2) - 1, eyeY + 4, 3, 1, palette.slimeDeep);
};

const buildSlime = () => {
  const sheet = new Canvas(FRAME * 2, FRAME);
  [
    { width: 14, height: 11, squash: 0 },
    { width: 15, height: 8, squash: 1 },
  ].forEach((shape, index) => {
    const frame = new Canvas(FRAME, FRAME);
    slimeFrame(frame, shape.width, shape.height, shape.squash);
    paste(sheet, frame, index * FRAME, 0);
  });
  return sheet;
};

/**
 * Coin spin: a disc that narrows to two thirds of its width and back, with a glint that
 * travels across the face.
 *
 * It deliberately never turns fully edge-on. A coin that squashes to a 2px sliver is a
 * vertical line on screen for a tenth of a second at a time, and every coin in the level
 * flips together, so a screenshot catches a whole row of lines instead of a row of coins.
 * Keeping the silhouette wide (and letting `coin.gd` start each coin on its own frame)
 * means a coin always reads as a coin.
 */
const buildCoin = () => {
  const widths = [12, 11, 9, 8, 9, 11];
  const sheet = new Canvas(FRAME * widths.length, FRAME);
  widths.forEach((width, index) => {
    const frame = new Canvas(FRAME, FRAME);
    const height = 12;
    const top = Math.round((FRAME - height) / 2);
    const left = Math.round((FRAME - width) / 2);
    const centreX = left + width / 2 - 0.5;
    const centreY = top + height / 2 - 0.5;
    const ring = (inset, lift, colour) =>
      frame.ellipse(
        centreX,
        centreY - lift,
        Math.max(width / 2 - inset, 0.4),
        Math.max(height / 2 - inset, 0.4),
        colour,
      );
    ring(0, 0, palette.gold);
    ring(1.4, 0, palette.goldMid);
    ring(2.6, 1, palette.gold);
    ring(3.4, 1, palette.goldHi);
    // Rim light on the left, shade on the right.
    for (let y = top + 2; y < top + height - 2; y++) {
      frame.pixel(left + 1, y, palette.goldHi);
      frame.pixel(left + width - 2, y, palette.goldDark);
    }
    for (let x = left + 1; x < left + width - 1; x++) {
      frame.pixel(x, top, palette.goldHi);
      frame.pixel(x, top + height - 1, palette.goldDark);
    }
    // The glint sweeps left to right and back as the disc narrows, so the coin still
    // reads as turning even though its outline never collapses.
    const travel = Math.round((Math.abs(index - (widths.length - 1) / 2) / widths.length) * width);
    const glintX = Math.min(left + 2 + travel, left + width - 3);
    frame.pixel(glintX, top + 3, palette.goldHi);
    frame.pixel(glintX, top + 4, palette.goldHi);
    frame.pixel(glintX + 1, top + 3, palette.goldHi);
    paste(sheet, frame, index * FRAME, 0);
  });
  return sheet;
};

/** Checkpoint flag: a pole the hero can spot across the level, lit once touched. */
const buildCheckpoint = () => {
  const sheet = new Canvas(FRAME * 2, 32);
  const flag = (frame, body, dark, hi) => {
    frame.rect(5, 4, 2, 24, palette.metalDark);
    frame.rect(5, 4, 1, 24, palette.metalHi);
    frame.rect(4, 28, 5, 4, palette.ink);
    frame.rect(4, 28, 4, 2, palette.stoneDark);
    frame.rect(4, 28, 4, 1, palette.stone);
    // Pennant: full height along the pole, tapering to a point at the right.
    for (let row = 0; row < 8; row++) {
      const width = 8 - Math.round(Math.abs(row - 3.5) * 2);
      for (let column = 0; column < width; column++) {
        const x = 7 + column;
        const y = 5 + row;
        frame.pixel(x, y, column === 0 ? hi : body);
        if (row === 0 || row === 7 || column === width - 1) frame.pixel(x, y, dark);
      }
    }
    frame.pixel(9, 6, hi);
    frame.pixel(10, 6, hi);
    frame.pixel(9, 7, hi);
  };
  const idle = new Canvas(FRAME, 32);
  flag(idle, palette.flagIdle, palette.flagIdleDark, palette.metalHi);
  const lit = new Canvas(FRAME, 32);
  flag(lit, palette.flagLit, palette.flagLitDark, palette.portalHi);
  paste(sheet, idle, 0, 0);
  paste(sheet, lit, FRAME, 0);
  return sheet;
};

/**
 * Goal door: a stone arch, two tiles wide and three tall, with a glowing passage and
 * a lantern on the keystone. The lantern is the landmark: it rises above the floor
 * tiles and reads as a lit destination from a screen away, so the goal is not just a
 * door-sized rectangle in the same value band as the brickwork.
 */
const buildDoor = () => {
  const canvas = new Canvas(32, 48);
  // Silhouette, stone frame, then the bevelled corners that read as an arch.
  canvas.rect(1, 3, 30, 45, palette.ink);
  canvas.rect(2, 4, 28, 44, palette.stoneDark);
  canvas.rect(3, 5, 26, 43, palette.stone);
  canvas.rect(3, 5, 26, 2, palette.stoneHi);
  for (const [x, y] of [
    [2, 4],
    [3, 4],
    [2, 5],
    [29, 4],
    [28, 4],
    [29, 5],
    [1, 46],
    [30, 46],
  ])
    canvas.pixel(x, y, palette.ink);
  // Keystone and the lantern that makes the door a landmark.
  canvas.rect(14, 1, 4, 5, palette.ink);
  canvas.rect(15, 2, 2, 4, palette.stoneHi);
  for (let x = 11; x < 21; x++) canvas.pixel(x, 0, withAlpha(palette.moonGlow, 70));
  canvas.rect(13, 0, 6, 1, palette.metalDark);
  canvas.rect(14, 1, 4, 4, palette.ink);
  canvas.rect(15, 2, 2, 2, palette.goldHi);
  canvas.pixel(15, 4, palette.gold);
  canvas.pixel(16, 4, palette.gold);
  // Stone courses down the jambs.
  for (let y = 11; y < 46; y += 7) {
    canvas.rect(3, y, 4, 1, palette.stoneDark);
    canvas.rect(25, y, 4, 1, palette.stoneDark);
  }
  // The passage: dark at the top, daylight spilling out at the doorstep.
  canvas.rect(7, 8, 18, 38, palette.ink);
  for (let y = 9; y < 45; y++)
    for (let x = 8; x < 24; x++) {
      const depth = (y - 9) / 36;
      const colour =
        depth < 0.2
          ? palette.portalDeep
          : depth < 0.45
            ? palette.portalDark
            : depth < 0.72
              ? palette.portalMid
              : palette.portal;
      canvas.pixel(x, y, colour);
    }
  for (let x = 10; x < 23; x += 5) canvas.rect(x, 9, 1, 35, withAlpha(palette.portalDark, 90));
  for (const [x, y] of [
    [11, 12],
    [19, 19],
    [14, 27],
    [21, 33],
    [12, 39],
  ])
    canvas.pixel(x, y, palette.portalHi);
  // Warm light spilling onto the threshold, so the door reads as the goal.
  for (let x = 8; x < 24; x++) canvas.pixel(x, 46, palette.portal);
  for (let x = 9; x < 23; x++) canvas.pixel(x, 47, palette.portalMid);
  // Step across the threshold.
  canvas.rect(5, 44, 22, 4, palette.ink);
  canvas.rect(6, 44, 20, 1, palette.stoneHi);
  canvas.rect(6, 45, 20, 3, palette.stoneDark);
  return canvas;
};

/** Trail sign: a weathered board pointing right, with a lantern so it glows at dusk. */
const buildSignpost = () => {
  const canvas = new Canvas(16, 32);
  // Post.
  canvas.rect(8, 10, 3, 22, palette.ink);
  canvas.rect(9, 10, 1, 21, palette.woodDark);
  canvas.rect(10, 10, 1, 21, palette.woodDeep);
  // Board with a bright arrow, cut to a point on the right.
  canvas.rect(1, 4, 13, 8, palette.ink);
  canvas.rect(2, 5, 11, 6, palette.wood);
  canvas.rect(2, 5, 11, 1, palette.woodHi);
  canvas.rect(2, 10, 11, 1, palette.woodDark);
  canvas.pixel(13, 6, palette.ink);
  canvas.pixel(13, 9, palette.ink);
  for (let x = 4; x < 11; x++) canvas.pixel(x, 7, palette.moonHi);
  canvas.pixel(10, 6, palette.moonHi);
  canvas.pixel(10, 8, palette.moonHi);
  canvas.pixel(11, 7, palette.moonHi);
  // Lantern hanging off the post.
  canvas.rect(11, 14, 4, 5, palette.ink);
  canvas.rect(12, 15, 2, 3, palette.goldHi);
  canvas.pixel(12, 16, palette.gold);
  canvas.pixel(9, 13, palette.metalDark);
  canvas.pixel(8, 13, palette.metalDark);
  return canvas;
};

/** Soft additive glow, used behind the hero, coins, the signpost and the goal. */
const buildGlow = () => {
  const canvas = new Canvas(64, 64);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const distance = Math.hypot(x - 31.5, y - 31.5) / 31.5;
      if (distance >= 1) continue;
      const falloff = (1 - distance) ** 2.2;
      canvas.pixel(x, y, [255, 240, 206, Math.round(150 * falloff)]);
    }
  return canvas;
};

const buildDust = () => {
  const canvas = new Canvas(12, 12);
  canvas.disc(6, 6, 5, withAlpha(palette.skin, 40));
  canvas.disc(6, 6, 3.6, withAlpha(palette.skin, 90));
  canvas.disc(5, 6, 2.4, withAlpha(hex("#fff6e2"), 200));
  canvas.pixel(3, 3, withAlpha(hex("#fff6e2"), 150));
  canvas.pixel(9, 4, withAlpha(hex("#fff6e2"), 120));
  canvas.pixel(4, 9, withAlpha(hex("#fff6e2"), 110));
  canvas.pixel(9, 8, withAlpha(hex("#fff6e2"), 90));
  return canvas;
};

/**
 * HUD icons: a heart for a life, a coin for the counter. Both are drawn at the size the
 * HUD shows them, so the panel never has to scale pixel art by a fraction.
 */
const HEART = [
  "..kkk.kkk..",
  ".khhhkhhhk.",
  "khhhhHhhhHk",
  "khhhhhhhhhk",
  ".khhhhhhhk.",
  "..khhhhhk..",
  "...khhhk...",
  "....khk....",
  ".....k.....",
];

const buildHeart = (body, hi, dark) => {
  const canvas = new Canvas(12, 12);
  canvas.matrix(1, 2, HEART, { k: dark, h: body, H: hi });
  return canvas;
};

const buildCoinIcon = () => {
  const coin = new Canvas(16, 16);
  coin.ellipse(7.5, 7.5, 6, 6, palette.gold);
  coin.ellipse(7.5, 7.5, 4.4, 4.4, palette.goldMid);
  coin.ellipse(7.5, 6.6, 3.2, 3.2, palette.gold);
  for (let y = 3; y < 12; y++) coin.pixel(2, y, palette.goldHi);
  for (let y = 3; y < 12; y++) coin.pixel(13, y, palette.goldDark);
  for (let x = 3; x < 12; x++) coin.pixel(x, 1, palette.goldHi);
  coin.pixel(6, 6, palette.goldHi);
  return coin;
};

// ---------------------------------------------------------------- backgrounds

const SKY_WIDTH = 1280;

/** Smooth, seamless silhouette height: integer periods over the layer width. */
const ridgeHeight = (x, width, waves) => {
  let height = 0;
  for (const [period, amplitude, phase] of waves)
    height += amplitude * Math.sin(TAU_ALL(x / period, phase));
  return height;
};

const TAU_ALL = (turns, phase) => (turns + phase) * Math.PI * 2;

/** A localised peak, so one band can hold several mountains of different shapes. */
const peak = (x, centre, width, height) => height * Math.exp(-(((x - centre) / width) ** 2));

/**
 * Far ridge with the moon. Two thirds of the band is a low, hazy horizon and the rest
 * is two different mountain masses, so the layer no longer repeats as one identical
 * silhouette. The moon is drawn with a stepped halo and a shaded lower-right limb: a
 * hard white disc reads as a placeholder.
 */
const buildRidgeFar = () => {
  const height = 224;
  const canvas = new Canvas(SKY_WIDTH, height);
  const topAt = (x) =>
    118 +
    ridgeHeight(x, SKY_WIDTH, [
      [640, 18, 0.0],
      [256, 8, 0.35],
      [128, 3, 0.7],
    ]) -
    peak(x, 300, 82, 62) -
    peak(x, 398, 44, 38) -
    peak(x, 455, 70, 24) -
    peak(x, 900, 90, 46) -
    peak(x, 1020, 54, 30);
  for (let x = 0; x < SKY_WIDTH; x++) {
    const top = topAt(x);
    for (let y = Math.round(top); y < height; y++) {
      const deep = y > top + 30;
      canvas.pixel(x, y, deep ? palette.ridgeFar : shift(palette.ridgeFar, 0.05));
    }
    canvas.pixel(x, Math.round(top), palette.ridgeFarLit);
    if (Math.round(top) + 1 < height) canvas.pixel(x, Math.round(top) + 1, palette.ridgeFarLit);
    // A darker seam a little below the crest reads as a fold, not a flat cutout.
    if (Math.round(top) + 14 < height)
      canvas.pixel(x, Math.round(top) + 14, shift(palette.ridgeFar, -0.03));
  }
  // Moon: a wide stepped halo over the sky, then a disc whose lower-right limb is
  // shaded. The halo is what the eye reads as light; a bare white disc reads as a
  // placeholder pasted on the sky.
  const moonX = 430;
  const moonY = 44;
  for (let ring = 34; ring > 21; ring--)
    canvas.disc(moonX, moonY, ring, withAlpha(palette.moonGlow, 7));
  for (let ring = 21; ring > 16; ring--)
    canvas.disc(moonX, moonY, ring, withAlpha(palette.moonGlow, 18));
  canvas.disc(moonX, moonY, 16, palette.moonGlow);
  canvas.disc(moonX, moonY, 14, palette.moon);
  // Shaded limb: a one-pixel inset crescent on the lower-right, not a second disc.
  for (let step = 0; step < 12; step++) {
    const angle = (step / 12) * (Math.PI / 2);
    canvas.pixel(
      moonX + Math.round(Math.cos(angle) * 13),
      moonY + Math.round(Math.sin(angle) * 13),
      palette.moonDark,
    );
    canvas.pixel(
      moonX + Math.round(Math.cos(angle) * 12),
      moonY + Math.round(Math.sin(angle) * 12),
      palette.moonDark,
    );
  }
  for (const [x, y] of [
    [-7, -4],
    [-6, -4],
    [-3, 5],
    [2, -7],
    [5, 1],
    [8, 6],
  ])
    canvas.pixel(moonX + x, moonY + y, palette.moonDark);
  canvas.pixel(moonX - 10, moonY - 9, palette.moonHi);
  canvas.pixel(moonX - 9, moonY - 9, palette.moonHi);
  canvas.pixel(moonX - 8, moonY - 9, palette.moonHi);
  // Stars, dimmer near the moon so its glow has somewhere to sit.
  const random = rng(0x51f0);
  for (let index = 0; index < 150; index++) {
    const x = Math.floor(random() * SKY_WIDTH);
    const y = 8 + Math.floor(random() * 80);
    const distance = Math.hypot(x - moonX, y - moonY);
    if (distance < 40) continue;
    canvas.pixel(x, y, withAlpha(palette.star, 120 + Math.floor(random() * 110)));
  }
  return canvas;
};

const buildRidgeMid = () => {
  const height = 224;
  const canvas = new Canvas(SKY_WIDTH, height);
  const crest = [
    [426.66, 22, 0.15],
    [213.33, 9, 0.6],
    [128, 4, 0.2],
  ];
  const topAt = (x) =>
    138 + ridgeHeight(x, SKY_WIDTH, crest) - peak(x, 700, 120, 26) - peak(x, 1160, 70, 20);
  for (let x = 0; x < SKY_WIDTH; x++) {
    const top = topAt(x);
    for (let y = Math.round(top); y < height; y++) canvas.pixel(x, y, palette.ridgeMidLit);
    canvas.pixel(x, Math.round(top), shift(palette.ridgeMidLit, 0.08));
  }
  // Canopies along the crest. They are darker than the hill behind them, which is what
  // makes a silhouette read as trees instead of as another bump in the ridge.
  const random = rng(0x2c14);
  for (let index = 0; index < 70; index++) {
    const baseX = random() * SKY_WIDTH;
    const groundY = Math.round(topAt(baseX)) + 3;
    if (random() < 0.4) {
      const trunkHeight = 14 + Math.floor(random() * 16);
      for (let step = 0; step < trunkHeight; step++) {
        const halfWidth = Math.max(1, Math.round((trunkHeight - step) * 0.5));
        for (let dx = -halfWidth; dx <= halfWidth; dx++)
          canvas.pixelWrapped(baseX + dx, groundY - step, palette.ridgeMid);
        canvas.pixelWrapped(baseX, groundY - step, shift(palette.ridgeMid, 0.06));
      }
      continue;
    }
    const radius = 5 + random() * 5;
    canvas.ellipse(baseX, groundY - radius * 0.6, radius, radius * 0.85, palette.ridgeMid);
    for (let dx = -radius; dx <= radius; dx++) {
      const top =
        groundY - radius * 0.6 - radius * 0.85 * Math.sqrt(Math.max(0, 1 - (dx / radius) ** 2));
      canvas.pixelWrapped(baseX + dx, top, shift(palette.ridgeMid, 0.05));
    }
  }
  return canvas;
};

const buildVegNear = () => {
  const height = 128;
  const canvas = new Canvas(SKY_WIDTH, height);
  const random = rng(0x7a3d);
  // Rolling ground band the bushes sit on.
  for (let x = 0; x < SKY_WIDTH; x++) {
    const top =
      74 +
      ridgeHeight(x, SKY_WIDTH, [
        [320, 7, 0.2],
        [160, 3, 0.5],
      ]);
    for (let y = Math.round(top); y < height; y++) canvas.pixel(x, y, palette.vegNear);
    canvas.pixel(x, Math.round(top), palette.vegNearLit);
  }
  for (let index = 0; index < 48; index++) {
    const x = random() * SKY_WIDTH;
    const y = 46 + random() * 30;
    const radius = 7 + random() * 8;
    canvas.ellipse(x, y + radius * 0.8, radius, radius * 0.8, palette.vegNear);
    for (let dx = -radius; dx <= radius; dx++) {
      const top = y + radius * 0.8 - radius * 0.8 * Math.sqrt(Math.max(0, 1 - (dx / radius) ** 2));
      canvas.pixelWrapped(x + dx, top, palette.vegNearLit);
      canvas.pixelWrapped(x + dx, top + 1, shift(palette.vegNearLit, -0.02));
    }
  }
  // Tall blades break the horizon line so the layer does not read as a solid bar.
  for (let index = 0; index < 150; index++) {
    const x = random() * SKY_WIDTH;
    const bladeHeight = 5 + Math.floor(random() * 10);
    for (let step = 0; step < bladeHeight; step++)
      canvas.pixelWrapped(x + Math.floor(step / 3), 74 - step, palette.vegNearLit);
  }
  return canvas;
};

// -------------------------------------------------------------------- writing

const write = (relativePath, image) => {
  const file = path.join(outputRoot, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, encodePng(image));
  console.log(`  ${relativePath} (${image.width}x${image.height})`);
};

/**
 * Writes the functional palette roles as a Resource the game reads at runtime. The
 * PNGs above and these colours come from the same `palette` object, so restyling the
 * game means changing one place; runtime effects (glows, the depth fade) take their
 * colours from here instead of repeating literals in a script.
 */
const writePalette = () => {
  const colour = (value) => {
    const [r, g, b] = value;
    return `Color(${(r / 255).toFixed(3)}, ${(g / 255).toFixed(3)}, ${(b / 255).toFixed(3)}, 1)`;
  };
  const roles = [
    ["background_deep", palette.skyTop],
    ["background_far", palette.ridgeFar],
    ["playfield", palette.grass],
    ["playfield_deep", palette.dirtDeep],
    ["player", palette.tunicHi],
    ["player_accent", palette.scarf],
    ["hazard", palette.hazard],
    ["pickup", palette.gold],
    ["goal", palette.portal],
    ["ui_accent", palette.stoneHi],
    ["ink", palette.ink],
    ["glow", palette.moonGlow],
  ];
  const lines = [
    '[gd_resource type="Resource" script_class="GamePalette" load_steps=2 format=3]',
    "",
    '[ext_resource type="Script" path="res://scripts/palette.gd" id="1_palette"]',
    "",
    "[resource]",
    'script = ExtResource("1_palette")',
    ...roles.map(([name, value]) => `${name} = ${colour(value)}`),
    "",
  ];
  const file = path.join(projectRoot, "assets/palette.tres");
  writeFileSync(file, lines.join("\n"));
  console.log("  assets/palette.tres");
};

const buildPreviewSheet = (images) => {
  const factor = Number(process.env.PREVIEW_SCALE ?? 3);
  const gap = 8;
  const width = Math.max(700, factor * 96);
  const height = factor >= 6 ? 1400 : 520;
  const sheet = new Canvas(width, height);
  sheet.rect(0, 0, width, height, hex("#20222e"));
  let cursorY = gap;
  let cursorX = gap;
  let rowHeight = 0;
  for (const [name, image] of images) {
    const scale = name.startsWith("bg_") ? 1 : factor;
    const drawn = scaled(image, scale);
    if (cursorX + drawn.width + gap > width) {
      cursorX = gap;
      cursorY += rowHeight + gap;
      rowHeight = 0;
    }
    paste(sheet, drawn, cursorX, cursorY);
    cursorX += drawn.width + gap;
    rowHeight = Math.max(rowHeight, drawn.height);
  }
  return sheet;
};

const main = () => {
  console.log("generating pixel art");
  const tiles = buildTiles();
  const player = buildPlayer();
  const slime = buildSlime();
  const coin = buildCoin();
  const checkpoint = buildCheckpoint();
  const door = buildDoor();
  const signpost = buildSignpost();
  const glow = buildGlow();
  const dust = buildDust();
  const heartFull = buildHeart(palette.slime, palette.slimeHi, palette.slimeDeep);
  const heartEmpty = buildHeart(
    withAlpha(palette.slime, 60),
    withAlpha(palette.slimeHi, 70),
    withAlpha(palette.slimeDeep, 130),
  );
  const coinIcon = buildCoinIcon();
  const ridgeFar = buildRidgeFar();
  const ridgeMid = buildRidgeMid();
  const vegNear = buildVegNear();

  write("tiles/tiles.png", tiles);
  write("sprites/player.png", player);
  write("sprites/slime.png", slime);
  write("sprites/coin.png", coin);
  write("sprites/checkpoint.png", checkpoint);
  write("sprites/door.png", door);
  write("sprites/signpost.png", signpost);
  write("sprites/glow.png", glow);
  write("sprites/dust.png", dust);
  write("sprites/heart_full.png", heartFull);
  write("sprites/heart_empty.png", heartEmpty);
  write("sprites/coin_icon.png", coinIcon);
  write("backgrounds/ridge_far.png", ridgeFar);
  write("backgrounds/ridge_mid.png", ridgeMid);
  write("backgrounds/veg_near.png", vegNear);
  writePalette();

  const sheet = buildPreviewSheet([
    ["tiles", tiles],
    ["player", player],
    ["slime", slime],
    ["coin", coin],
    ["checkpoint", checkpoint],
    ["door", door],
    ["dust", dust],
    ["heart_full", heartFull],
    ["coin_icon", coinIcon],
    ["bg_ridge_far", ridgeFar],
    ["bg_ridge_mid", ridgeMid],
    ["bg_veg_near", vegNear],
  ]);
  const sheetPath = path.join(here, "preview_sheet.png");
  writeFileSync(sheetPath, encodePng(sheet));
  console.log(`  tools/preview_sheet.png (${sheet.width}x${sheet.height})`);
};

main();
