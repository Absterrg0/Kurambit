// @effect-diagnostics nodeBuiltinImport:off -- Parser fixtures are inline strings and temp dirs.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  audioMeasureArgs,
  audioProbeArgs,
  detectPhaseCancellation,
  isNativeClipPath,
  parseAudioProbeJson,
  parseChannelStats,
  parseSilenceTotal,
  parseVolumeDetect,
  parseVolumeDetects,
  readNativeClipSourceId,
  resolveAudioPath,
} from "./gameAudioInspect.ts";

// Representative FFmpeg records for generated fixtures (a 440 Hz
// stereo tone, digital silence, a hard-clipped tone and an opposite-phase
// stereo pair). Fixtures of the parser, not of quality: they prove the
// numbers are read, never that the audio is good.
const TONE_MEASURE = `[Parsed_volumedetect_0 @ 0x7f9a04003e40] n_samples: 176400
[Parsed_volumedetect_0 @ 0x7f9a04003e40] mean_volume: -24.1 dB
[Parsed_volumedetect_0 @ 0x7f9a04003e40] max_volume: -21.1 dB
[Parsed_volumedetect_0 @ 0x7f9a04003e40] histogram_21db: 50960
[Parsed_astats_0 @ 0x7fc5b8003e40] Channel: 1
[Parsed_astats_0 @ 0x7fc5b8003e40] Peak level dB: -21.072762
[Parsed_astats_0 @ 0x7fc5b8003e40] RMS level dB: -24.084172
[Parsed_astats_0 @ 0x7fc5b8003e40] Channel: 2
[Parsed_astats_0 @ 0x7fc5b8003e40] Peak level dB: -21.072762
[Parsed_astats_0 @ 0x7fc5b8003e40] RMS level dB: -24.084172
[Parsed_volumedetect_2 @ 0x7f0c8808c540] n_samples: 88200
[Parsed_volumedetect_2 @ 0x7f0c8808c540] mean_volume: -24.1 dB
[Parsed_volumedetect_2 @ 0x7f0c8808c540] max_volume: -21.1 dB
[Parsed_volumedetect_2 @ 0x7f0c8808c540] histogram_21db: 25480
`;

const SILENCE_MEASURE = `[Parsed_silencedetect_0 @ 0x7f7840003f80] silence_start: 0
[Parsed_silencedetect_0 @ 0x7f7840003f80] silence_end: 2 | silence_duration: 2
[Parsed_volumedetect_1 @ 0x7f7840004200] n_samples: 176400
[Parsed_volumedetect_1 @ 0x7f7840004200] mean_volume: -91.0 dB
[Parsed_volumedetect_1 @ 0x7f7840004200] max_volume: -91.0 dB
[Parsed_volumedetect_1 @ 0x7f7840004200] histogram_91db: 176400
`;

const CLIP_MEASURE = `[Parsed_volumedetect_0 @ 0x55635c771d00] n_samples: 88200
[Parsed_volumedetect_0 @ 0x55635c771d00] mean_volume: -0.7 dB
[Parsed_volumedetect_0 @ 0x55635c771d00] max_volume: 0.0 dB
[Parsed_volumedetect_0 @ 0x55635c771d00] histogram_0db: 70000
`;

const CANCEL_MEASURE = `[Parsed_volumedetect_0 @ 0x7f696c003f80] n_samples: 88200
[Parsed_volumedetect_0 @ 0x7f696c003f80] mean_volume: -21.1 dB
[Parsed_volumedetect_0 @ 0x7f696c003f80] max_volume: -18.1 dB
[Parsed_volumedetect_2 @ 0x7f696c08c540] n_samples: 44100
[Parsed_volumedetect_2 @ 0x7f696c08c540] mean_volume: -91.0 dB
[Parsed_volumedetect_2 @ 0x7f696c08c540] max_volume: -91.0 dB
`;

it("reads ffprobe audio metadata and refuses anything else", () => {
  const probe = parseAudioProbeJson(
    JSON.stringify({
      streams: [{ codec_name: "vorbis", sample_rate: "44100", channels: 2, duration: "2.5" }],
    }),
  );
  expect(probe).toEqual({ codec: "vorbis", sampleRate: 44100, channels: 2, durationSeconds: 2.5 });
  expect(parseAudioProbeJson(JSON.stringify({ streams: [] }))).toBeNull();
  expect(parseAudioProbeJson("not json")).toBeNull();
  expect(parseAudioProbeJson(JSON.stringify({ streams: [{ codec_name: "vorbis" }] }))).toBeNull();
});

it("measures a tone's level without calling it good", () => {
  const volume = parseVolumeDetect(TONE_MEASURE);
  expect(volume.meanDb).toBeCloseTo(-24.1, 1);
  expect(volume.maxDb).toBeCloseTo(-21.1, 1);
  expect(volume.nearClippingSamples).toBeNull();
  const channels = parseChannelStats(TONE_MEASURE);
  expect(channels).toHaveLength(2);
  expect(channels[0]?.rmsDb).toBeCloseTo(-24.08, 1);
  // Identical channels mixed stay loud: no cancellation on a normal tone.
  const blocks = parseVolumeDetects(TONE_MEASURE);
  expect(blocks).toHaveLength(2);
  expect(
    detectPhaseCancellation({
      meanDb: blocks[0]?.meanDb ?? null,
      mixMeanDb: blocks.at(-1)?.meanDb ?? null,
      channels,
    }),
  ).toBe(false);
});

it("reads silence as silence with its duration", () => {
  expect(parseSilenceTotal(SILENCE_MEASURE)).toBe(2);
  expect(parseVolumeDetect(SILENCE_MEASURE).meanDb).toBe(-91);
  expect(parseSilenceTotal(TONE_MEASURE)).toBeNull();
});

it("counts samples at 0 dBFS on a clipped tone", () => {
  const volume = parseVolumeDetect(CLIP_MEASURE);
  expect(volume.maxDb).toBe(0);
  expect(volume.nearClippingSamples).toBe(70_000);
});

it("reads opposite-phase collapse as cancellation, never as silence", () => {
  const blocks = parseVolumeDetects(CANCEL_MEASURE);
  expect(blocks).toHaveLength(2);
  expect(blocks[0]?.meanDb).toBeCloseTo(-21.1, 1);
  expect(blocks.at(-1)?.meanDb).toBe(-91);
  expect(
    detectPhaseCancellation({
      meanDb: blocks[0]?.meanDb ?? null,
      mixMeanDb: blocks.at(-1)?.meanDb ?? null,
      channels: [
        { peakDb: -18.1, rmsDb: -21.1 },
        { peakDb: -18.1, rmsDb: -21.1 },
      ],
    }),
  ).toBe(true);
});

it("never calls a mono file or an unmeasured mix cancelled", () => {
  expect(
    detectPhaseCancellation({
      meanDb: -20,
      mixMeanDb: -91,
      channels: [{ peakDb: -18, rmsDb: -20 }],
    }),
  ).toBe(false);
  expect(
    detectPhaseCancellation({
      meanDb: -20,
      mixMeanDb: null,
      channels: [
        { peakDb: -18, rmsDb: -20 },
        { peakDb: -18, rmsDb: -20 },
      ],
    }),
  ).toBeNull();
});

it("bounds the decode to the segment before reading anything", () => {
  expect(audioMeasureArgs("in.wav", 12)).toEqual([
    "-nostdin",
    "-threads",
    "1",
    "-filter_threads",
    "1",
    "-v",
    "info",
    "-i",
    "in.wav",
    "-t",
    "12",
    "-af",
    "silencedetect=noise=-50dB:d=0.5,volumedetect,astats,pan=mono|c0=0.5*c0+0.5*c1,volumedetect",
    "-f",
    "null",
    "-",
  ]);
  expect(audioProbeArgs("in.wav")).toContain("a:0");
});

it("only resolves game-relative paths that stay inside the game", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "audio-path-"));
  try {
    await NodeFSP.mkdir(NodePath.join(root, "godot/assets"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, "godot/assets/theme.ogg"), "OggS-fake");
    const resolved = await resolveAudioPath(root, "godot/assets/theme.ogg");
    expect(resolved).toBe(await NodeFSP.realpath(NodePath.join(root, "godot/assets/theme.ogg")));
    await expect(resolveAudioPath(root, "../escape.ogg")).rejects.toThrow();
    await expect(resolveAudioPath(root, "/absolute.ogg")).rejects.toThrow();
    await expect(resolveAudioPath(root, "godot/../escape.ogg")).rejects.toThrow();
    await expect(resolveAudioPath(root, "missing.ogg")).rejects.toThrow();
    // A symlink pointing outside the game is refused even though the text path is inside.
    const outside = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "audio-out-"));
    try {
      await NodeFSP.writeFile(NodePath.join(outside, "evil.ogg"), "OggS-fake");
      await NodeFSP.symlink(
        NodePath.join(outside, "evil.ogg"),
        NodePath.join(root, "godot/assets/link.ogg"),
      );
      await expect(resolveAudioPath(root, "godot/assets/link.ogg")).rejects.toThrow(
        /resolves outside/,
      );
    } finally {
      await NodeFSP.rm(outside, { recursive: true, force: true });
    }
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("names native-clip audio by its evidence directory", () => {
  expect(isNativeClipPath("builds/native-capture/abc/clip.mp4")).toBe(true);
  expect(isNativeClipPath("godot/assets/theme.ogg")).toBe(false);
  expect(isNativeClipPath("builds/native-capture")).toBe(true);
});

it("reads the native clip's source binding when capture.json exists", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "audio-clip-"));
  try {
    await NodeFSP.writeFile(
      NodePath.join(directory, "capture.json"),
      JSON.stringify({ sourceId: "abc123" }),
    );
    expect(await readNativeClipSourceId(directory)).toBe("abc123");
    await NodeFSP.rm(NodePath.join(directory, "capture.json"));
    expect(await readNativeClipSourceId(directory)).toBeNull();
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("orders volumedetect filters by graph position even when FFmpeg flushes in reverse", () => {
  const logs =
    "[Parsed_volumedetect_4 @ ptr] mean_volume: -91.0 dB\n[Parsed_volumedetect_4 @ ptr] max_volume: -91.0 dB\n[Parsed_volumedetect_1 @ ptr] mean_volume: -21.1 dB\n[Parsed_volumedetect_1 @ ptr] max_volume: -18.1 dB\n";
  expect(parseVolumeDetects(logs).map((v) => v.meanDb)).toEqual([-21.1, -91]);
});
it("does not return partial silence totals when a trailing interval is unclosed", () => {
  expect(
    parseSilenceTotal("silence_start: 0\nsilence_end: 1 | silence_duration: 1\nsilence_start: 2"),
  ).toBeNull();
});
