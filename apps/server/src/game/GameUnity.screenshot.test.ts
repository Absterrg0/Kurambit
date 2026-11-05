// The Game view goes to the model labelled image/png; a provider refuses a turn
// whose image bytes are another format.
import { expect, it } from "@effect/vitest";
import { screenshotOf } from "./GameUnity.ts";

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 2, 0, 0, 0, 1, 0, 8, 6, 0, 0, 0]),
]);
const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03, 0x01, 0x22, 0x00,
]);
const image = (bytes: Buffer) => ({
  content: [{ type: "image", data: bytes.toString("base64") }],
});

it("attaches a PNG with its size and refuses an image of another format", () => {
  expect(screenshotOf(image(png)).screenshot).toMatchObject({
    mimeType: "image/png",
    width: 512,
    height: 256,
  });
  const refused = screenshotOf(image(jpeg));
  expect(refused.screenshot).toBeUndefined();
  expect(refused.text).toContain("not a PNG");
});
