// @effect-diagnostics nodeBuiltinImport:off -- Audio paths resolve against the game root on the native filesystem.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { GAME_AUDIO_INSPECT_BOUNDS } from "@t3tools/contracts";

/** ffprobe arguments: audio-stream metadata as JSON, nothing else. */
export const audioProbeArgs = (filePath: string): readonly string[] => [
  "-v",
  "error",
  "-threads",
  "1",
  "-select_streams",
  "a:0",
  "-show_entries",
  "stream=codec_name,sample_rate,channels,duration",
  "-of",
  "json",
  filePath,
];

/**
 * Single FFmpeg measurement pass: silence intervals, overall level,
 * per-channel stats and one explicit mono mix, streamed to null. `-t`
 * decodes at most the bounded segment, so an overlong stream never becomes
 * an unbounded decode; the PCM stays in the filter graph and only the parsed
 * numbers leave it. The mono mix is measured explicitly because the overall
 * level averages channels: a mix that cancels across opposite-phase channels
 * must read as cancellation, never as silence.
 */
export const audioMeasureArgs = (
  filePath: string,
  segmentSeconds: number,
  channels = 2,
): readonly string[] => [
  "-nostdin",
  "-threads",
  "1",
  "-filter_threads",
  "1",
  "-v",
  "info",
  "-i",
  filePath,
  "-t",
  String(segmentSeconds),
  "-af",
  `silencedetect=noise=-50dB:d=0.5,volumedetect,astats,${channels === 1 ? "pan=mono|c0=c0" : "pan=mono|c0=0.5*c0+0.5*c1"},volumedetect`,
  "-f",
  "null",
  "-",
];

export interface AudioProbe {
  readonly codec: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationSeconds: number;
}

/** Lenient audio-stream reader: anything unparseable is null, never a guess. */
export const parseAudioProbeJson = (text: string): AudioProbe | null => {
  try {
    const parsed = JSON.parse(text) as {
      readonly streams?: readonly {
        readonly codec_name?: unknown;
        readonly sample_rate?: unknown;
        readonly channels?: unknown;
        readonly duration?: unknown;
      }[];
    };
    const stream = parsed.streams?.[0];
    if (!stream) return null;
    const sampleRate =
      typeof stream.sample_rate === "number"
        ? stream.sample_rate
        : Number.parseInt(String(stream.sample_rate ?? ""), 10);
    const channels =
      typeof stream.channels === "number"
        ? stream.channels
        : Number.parseInt(String(stream.channels ?? ""), 10);
    const duration =
      typeof stream.duration === "number"
        ? stream.duration
        : Number.parseFloat(String(stream.duration ?? ""));
    if (
      typeof stream.codec_name !== "string" ||
      stream.codec_name.length === 0 ||
      !Number.isInteger(sampleRate) ||
      sampleRate <= 0 ||
      !Number.isInteger(channels) ||
      channels <= 0 ||
      !Number.isFinite(duration) ||
      duration <= 0
    )
      return null;
    return { codec: stream.codec_name, sampleRate, channels, durationSeconds: duration };
  } catch {
    return null;
  }
};

export interface VolumeMeasurement {
  readonly meanDb: number | null;
  readonly maxDb: number | null;
  /** Samples within 1 dB of full scale, or null when FFmpeg reported no histogram. */
  readonly nearClippingSamples: number | null;
}

const decibel = (text: string): number | null => {
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Parses volumedetect blocks in filter-index order, independent of log order: the first block is the overall
 * level, the last block is the explicit mono mix. A block with only
 * `n_samples: 0` (empty decode) contributes nothing. Absence of any block is
 * an empty array, never zero.
 */
export const parseVolumeDetects = (stderr: string): VolumeMeasurement[] => {
  const blocks = new Map<
    string,
    { meanDb: number | null; maxDb: number | null; nearClippingSamples: number | null }
  >();
  const order: string[] = [];
  for (const line of stderr.split("\n")) {
    const tag = line.match(/Parsed_volumedetect_(\d+)/);
    if (!tag) continue;
    const key = tag[1]!;
    let block = blocks.get(key);
    if (block === undefined) {
      block = { meanDb: null, maxDb: null, nearClippingSamples: null };
      blocks.set(key, block);
      order.push(key);
    }
    const mean = line.match(/mean_volume:\s*(-inf|[-+\d.eE]+)\s*dB/);
    if (mean) block.meanDb = mean[1] === "-inf" ? Number.NEGATIVE_INFINITY : decibel(mean[1]!);
    const max = line.match(/max_volume:\s*(-inf|[-+\d.eE]+)\s*dB/);
    if (max) block.maxDb = max[1] === "-inf" ? Number.NEGATIVE_INFINITY : decibel(max[1]!);
    const histogram = line.match(/histogram_0db:\s*(\d+)/);
    if (histogram) block.nearClippingSamples = Number.parseInt(histogram[1]!, 10);
  }
  return order
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => blocks.get(key)!)
    .filter((block) => block.meanDb !== null);
};

/** The overall level: the first volumedetect block, or nulls when unmeasured. */
export const parseVolumeDetect = (stderr: string): VolumeMeasurement => {
  const blocks = parseVolumeDetects(stderr);
  return blocks[0] ?? { meanDb: null, maxDb: null, nearClippingSamples: null };
};

/**
 * Sums silence_duration across silencedetect intervals. An unterminated
 * trailing silence_start with no end is unknown, never zero: the segment may
 * have ended mid-silence.
 */
export const parseSilenceTotal = (stderr: string): number | null => {
  let total = 0;
  let found = false;
  let open = false;
  for (const line of stderr.split("\n")) {
    if (/silence_start:/.test(line)) open = true;
    if (/silence_end:/.test(line)) open = false;
    const match = line.match(/silence_duration:\s*([\d.eE+-]+)/);
    if (match) {
      const parsed = Number.parseFloat(match[1]!);
      if (Number.isFinite(parsed) && parsed >= 0) {
        total += parsed;
        found = true;
      }
    }
  }
  return open ? null : found ? total : null;
};

export interface ChannelStats {
  readonly peakDb: number | null;
  readonly rmsDb: number | null;
}

/**
 * Per-channel stats from astats, in channel order. Channels are preserved
 * separately on purpose: a mix that cancels across opposite-phase channels
 * must read as cancellation, never as silence.
 */
export const parseChannelStats = (stderr: string): ChannelStats[] => {
  const channels: ChannelStats[] = [];
  let current: { peakDb: number | null; rmsDb: number | null } | null = null;
  for (const line of stderr.split("\n")) {
    if (/Channel:\s*\d+/.test(line)) {
      if (current !== null) channels.push(current);
      current = { peakDb: null, rmsDb: null };
      continue;
    }
    if (/\] Overall\s*$/.test(line)) {
      if (current !== null) channels.push(current);
      current = null;
      continue;
    }
    if (current === null) continue;
    const peak = line.match(/Peak level dB:\s*(-inf|[-+\d.eE]+)/);
    if (peak) current.peakDb = peak[1] === "-inf" ? Number.NEGATIVE_INFINITY : decibel(peak[1]!);
    const rms = line.match(/RMS level dB:\s*(-inf|[-+\d.eE]+)/);
    if (rms) current.rmsDb = rms[1] === "-inf" ? Number.NEGATIVE_INFINITY : decibel(rms[1]!);
  }
  if (current !== null) channels.push(current);
  return channels;
};

/**
 * Opposite-phase cancellation: the channels carry energy while the explicit
 * mono mix collapses. A mono file (or one silent channel) is never
 * cancellation; an unmeasured mix is unknown, never cancelled.
 */
export const detectPhaseCancellation = (input: {
  readonly meanDb: number | null;
  readonly mixMeanDb: number | null;
  readonly channels: readonly ChannelStats[];
}): boolean | null => {
  if (input.mixMeanDb === null || Number.isNaN(input.mixMeanDb)) return null;
  if (input.channels.length < 2) return false;
  if (input.meanDb === null || !Number.isFinite(input.meanDb)) return null;
  const audible = input.channels.filter(
    (channel) => channel.rmsDb !== null && Number.isFinite(channel.rmsDb),
  );
  if (audible.length < 2) return false;
  return (
    input.meanDb > GAME_AUDIO_INSPECT_BOUNDS.silenceMeanDb + 20 &&
    input.mixMeanDb <= GAME_AUDIO_INSPECT_BOUNDS.silenceMeanDb
  );
};

/** True when the game-relative path names a recorded native clip's audio. */
export const isNativeClipPath = (gameRelativePath: string): boolean =>
  gameRelativePath === "builds/native-capture" ||
  gameRelativePath.startsWith("builds/native-capture/");

const TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/;

/**
 * Resolves a caller-supplied game-relative path inside the game root.
 * Absolute paths, traversal and symlinks resolving outside the game are
 * refused; the error names the reason, never the resolved target.
 */
export const resolveAudioPath = async (root: string, gameRelativePath: string): Promise<string> => {
  if (
    gameRelativePath.length === 0 ||
    NodePath.isAbsolute(gameRelativePath) ||
    TRAVERSAL.test(gameRelativePath) ||
    gameRelativePath.includes("\\")
  )
    throw new Error("refused: the audio path must be game-relative inside the game.");
  const joined = NodePath.join(root, gameRelativePath);
  const [realRoot, realTarget] = await Promise.all([
    NodeFSP.realpath(root),
    NodeFSP.realpath(joined).catch(() => null),
  ]);
  if (realTarget === null) throw new Error("missing: the audio file does not exist.");
  const inside =
    realTarget === realRoot ||
    realTarget.startsWith(
      realRoot.endsWith(NodePath.sep) ? realRoot : `${realRoot}${NodePath.sep}`,
    );
  if (!inside) throw new Error("refused: the audio path resolves outside the game.");
  return realTarget;
};

/** The source identity a recorded native clip ran from, read from its capture.json. */
export const readNativeClipSourceId = async (evidenceDirectory: string): Promise<string | null> => {
  try {
    const text = await NodeFSP.readFile(NodePath.join(evidenceDirectory, "capture.json"), "utf8");
    const parsed = JSON.parse(text) as { readonly sourceId?: unknown };
    return typeof parsed.sourceId === "string" ? parsed.sourceId : null;
  } catch {
    return null;
  }
};

/** Fingerprints bounded encoded bytes before/after measurement, never decoded PCM. */
export const fingerprintAudioFile = async (file: string): Promise<string> => {
  const handle = await NodeFSP.open(file, "r");
  try {
    const hash = NodeCrypto.createHash("sha256");
    const block = Buffer.alloc(65536);
    let count = 0;
    for (;;) {
      const { bytesRead } = await handle.read(block, 0, block.length, null);
      if (bytesRead === 0) break;
      count += bytesRead;
      if (count > GAME_AUDIO_INSPECT_BOUNDS.maxFileBytes)
        throw new Error("Audio grew beyond its byte bound.");
      hash.update(block.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
};
