import { describe, expect, it } from "@effect/vitest";

import { playSpan, signalsOf } from "./videoSignals.ts";

// Real ffmpeg 8 `metadata=mode=print` output (trimmed) from a Godot run video.
const SITI = `frame:0    pts:0       pts_time:0
lavfi.siti.si=133.49
lavfi.siti.ti=0.00
frame:1    pts:1024    pts_time:0.0833333
lavfi.siti.si=133.52
lavfi.siti.ti=0.18
frame:2    pts:2048    pts_time:0.166667
lavfi.siti.si=133.74
lavfi.siti.ti=9.09
frame:3    pts:3072    pts_time:3.0
lavfi.siti.si=133.74
lavfi.siti.ti=0.06
`;
const FREEZE = `frame:26   pts:26624   pts_time:2.166667
lavfi.freezedetect.freeze_start=0.166667
frame:28   pts:28672   pts_time:2.333333
lavfi.freezedetect.freeze_duration=2.166667
lavfi.freezedetect.freeze_end=2.333333
`;

describe("signalsOf", () => {
  it("reads still stretches, motion without the first frame, detail and colour", () => {
    const red = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 255]);
    const signals = signalsOf(SITI, FREEZE, red);
    expect(signals.freezes).toEqual([{ at: 0.2, seconds: 2.2 }]);
    expect(signals.longestFreeze).toBe(2.2);
    expect(signals.motion).toBe(3.11);
    expect(signals.detail).toBe(133.62);
    expect(signals.dominantColour).toBe(0.75);
    expect(signals.seconds).toBe(3);
  });

  it("closes a still stretch that lasts to the end", () => {
    const open = `frame:30 pts:1 pts_time:2.5\nlavfi.freezedetect.freeze_start=0.5\n`;
    expect(signalsOf(SITI, open, new Uint8Array()).freezes).toEqual([{ at: 0.5, seconds: 2.5 }]);
  });
});

describe("playSpan", () => {
  it("maps game seconds to video seconds and refuses an empty span", () => {
    const frames = [
      [1, 0, 0],
      [2, 1.5, 1500],
      [3, 4, 4100],
      [4, 9, 9200],
    ] as const;
    expect(playSpan(frames, 1, 5)).toEqual({ start: 1.5, end: 4.1 });
    expect(playSpan(frames, 10, null)).toBeNull();
  });
});
