import * as NodeZlib from "node:zlib";

/**
 * A tiny, self-describing test image for the vision canary: one large digit on
 * a solid background. Catalog presence does not prove a provider can actually
 * receive a PNG, so this is checked once per server process before any game is
 * judged.
 */
const WIDTH = 120;
const HEIGHT = 120;
const BACKGROUND = [255, 0, 255] as const;
const FOREGROUND = [255, 255, 0] as const;
const SCALE = 12;
const ORIGIN_X = 30;
const ORIGIN_Y = 18;
const DIGIT = ["11111", "00001", "00010", "00100", "00100", "00100", "00100"] as const;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++)
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

/** The expected answer the model must give for [canaryPng]. */
export const VISUAL_CANARY_ANSWER = { digit: "7", backgroundColor: "magenta" } as const;

export function canaryPng(): Buffer {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const digitX = Math.floor((x - ORIGIN_X) / SCALE);
      const digitY = Math.floor((y - ORIGIN_Y) / SCALE);
      const lit =
        digitX >= 0 && digitX < 5 && digitY >= 0 && digitY < 7 && DIGIT[digitY]![digitX] === "1";
      const colour = lit ? FOREGROUND : BACKGROUND;
      const offset = (y * WIDTH + x) * 3;
      pixels[offset] = colour[0];
      pixels[offset + 1] = colour[1];
      pixels[offset + 2] = colour[2];
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const scanlines = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    scanlines[y * (WIDTH * 3 + 1)] = 0; // filter: none
    pixels.copy(scanlines, y * (WIDTH * 3 + 1) + 1, y * WIDTH * 3, (y + 1) * WIDTH * 3);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
