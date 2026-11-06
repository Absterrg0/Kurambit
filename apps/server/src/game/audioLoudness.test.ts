import { expect, it } from "@effect/vitest";
import { parseEbur128 } from "./audioLoudness.ts";

const summary = (integrated: string, peak: string) =>
  `[Parsed_ebur128_0 @ 0x1] t: 1.2 M: -20.0 S: -21.0 I: -18.0 LUFS\n[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         ${integrated} LUFS\n    Threshold: -27.2 LUFS\n\n  True peak:\n    Peak:       ${peak} dBFS\n`;

it("reads the closing summary, and never reports a gate floor or silence as a level", () => {
  expect(parseEbur128(summary("-11.8", "0.6"))).toEqual({
    integratedLufs: -11.8,
    truePeakDbtp: 0.6,
  });
  // ffmpeg prints -70 when a clip is too short to gate: that is no measurement.
  expect(parseEbur128(summary("-70.0", "-4.0"))).toEqual({
    integratedLufs: null,
    truePeakDbtp: -4,
  });
  expect(parseEbur128(summary("-70.0", "-inf"))).toEqual({
    integratedLufs: null,
    truePeakDbtp: null,
  });
  expect(parseEbur128("Invalid data found when processing input")).toBeNull();
});
