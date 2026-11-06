// @effect-diagnostics nodeBuiltinImport:off -- ffmpeg writes its readings as files beside the run video; this module reads them back.
// A play video's vital signs, from one ffmpeg pass over the span of play:
// stretches where the picture stood still (freezedetect), how much it moves
// and how detailed it is (siti, ITU-T P.910), and the share one colour holds
// (a 1 fps histogram). The numbers are values to diff between builds, not
// calibrated thresholds.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { GameOperationError } from "@kurambit/contracts";
import type * as GameProcesses from "./GameProcesses.ts";

export interface VideoSignals {
  readonly freezes: ReadonlyArray<{ readonly at: number; readonly seconds: number }>;
  readonly longestFreeze: number;
  readonly motion: number;
  readonly detail: number;
  readonly dominantColour: number;
  readonly seconds: number;
}

/** One frame's metadata lines from ffmpeg's `metadata=mode=print`: its time and its keys. */
export const parseMetadata = (
  text: string,
): ReadonlyArray<{ readonly t: number; readonly values: Readonly<Record<string, string>> }> => {
  const frames: Array<{ t: number; values: Record<string, string> }> = [];
  for (const line of text.split("\n")) {
    const head = /^frame:\d+\s+pts:\S+\s+pts_time:(\S+)/.exec(line);
    if (head !== null) {
      frames.push({ t: Number(head[1]), values: {} });
      continue;
    }
    const eq = line.indexOf("=");
    const frame = frames.at(-1);
    if (eq > 0 && frame !== undefined) frame.values[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return frames;
};

const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value: number, digits = 2) => Number(value.toFixed(digits));

/** The share of pixels the most common colour holds, quantised to 4 bits a channel. */
export const dominantShare = (rgb: Uint8Array): number => {
  const counts = new Uint32Array(4096);
  let top = 0;
  const pixels = Math.floor(rgb.length / 3);
  for (let i = 0; i < pixels * 3; i += 3) {
    const bucket = ((rgb[i]! >> 4) << 8) | ((rgb[i + 1]! >> 4) << 4) | (rgb[i + 2]! >> 4);
    const count = ++counts[bucket]!;
    if (count > top) top = count;
  }
  return pixels === 0 ? 0 : top / pixels;
};

/** PURE. The signals from ffmpeg's two metadata files and the colour samples. */
export const signalsOf = (siti: string, freeze: string, rgb: Uint8Array): VideoSignals => {
  const frames = parseMetadata(siti);
  const first = frames[0]?.t ?? 0;
  const end = (frames.at(-1)?.t ?? first) - first;
  // The first frame has no predecessor, so its motion reads 0 by definition.
  const ti = frames.slice(1).map((frame) => Number(frame.values["lavfi.siti.ti"] ?? 0));
  const si = frames.map((frame) => Number(frame.values["lavfi.siti.si"] ?? 0));
  const freezes: Array<{ at: number; seconds: number }> = [];
  let open: number | null = null;
  for (const frame of parseMetadata(freeze)) {
    const start = frame.values["lavfi.freezedetect.freeze_start"];
    const duration = frame.values["lavfi.freezedetect.freeze_duration"];
    if (start !== undefined) open = Number(start) - first;
    if (duration !== undefined && open !== null) {
      freezes.push({ at: round(open, 1), seconds: round(Number(duration), 1) });
      open = null;
    }
  }
  // A still stretch that lasts to the end of the span is reported with no end of its own.
  if (open !== null && end - open >= 2)
    freezes.push({ at: round(open, 1), seconds: round(end - open, 1) });
  return {
    freezes: freezes.slice(0, 10),
    longestFreeze: round(Math.max(0, ...freezes.map((entry) => entry.seconds)), 1),
    motion: round(mean(ti)),
    detail: round(mean(si)),
    dominantColour: round(dominantShare(rgb)),
    seconds: round(end, 1),
  };
};

/**
 * The video's span of play, in video seconds, from its sidecar: from the
 * first frame at or after `from` (game seconds) to the last before `to`.
 * Null when the sidecar has no frames in it.
 */
export const playSpan = (
  frames: ReadonlyArray<readonly [number, number, number]>,
  from: number,
  to: number | null,
): { readonly start: number; readonly end: number } | null => {
  const inside = frames.filter(([, t]) => t >= from && (to === null || t <= to));
  const head = inside[0];
  const tail = inside.at(-1);
  if (head === undefined || tail === undefined || tail[2] <= head[2]) return null;
  return { start: head[2] / 1000, end: tail[2] / 1000 };
};

/**
 * Runs ffmpeg once over `span` of `video`, writing its readings into
 * `workDir`. A failure is ffmpeg's or the file's, never the game's: it is a
 * `tool-failed` error.
 */
export const measureVideo = (
  processes: GameProcesses.GameProcesses["Service"],
  input: {
    readonly root: string;
    readonly ffmpeg: string;
    readonly video: string;
    readonly span: { readonly start: number; readonly end: number };
    readonly workDir: string;
  },
): Effect.Effect<VideoSignals, GameOperationError> =>
  Effect.gen(function* () {
    const failed = (detail: string, cause?: unknown) =>
      new GameOperationError({
        operation: "Video signals",
        path: input.video,
        reason: "tool-failed",
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdir(input.workDir, { recursive: true }),
      catch: (cause) => failed("its working folder could not be made", cause),
    });
    // Output names are relative to the working folder, so no path is ever
    // part of the filtergraph and none needs escaping.
    const result = yield* processes.run({
      root: input.root,
      executable: input.ffmpeg,
      operation: "video-signals",
      cwd: input.workDir,
      log: false,
      timeoutMs: 120_000,
      args: [
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        input.span.start.toFixed(3),
        "-to",
        input.span.end.toFixed(3),
        "-i",
        input.video,
        "-filter_complex",
        "[0:v]split=3[a][b][c];" +
          "[a]freezedetect=n=0.003:d=2,metadata=mode=print:file=freeze.txt,nullsink;" +
          "[b]scale=480:-2,siti,metadata=mode=print:file=siti.txt,nullsink;" +
          "[c]fps=1,scale=160:-2,format=rgb24[colour]",
        "-map",
        "[colour]",
        "-f",
        "rawvideo",
        "colour.rgb",
      ],
    });
    if (result.exitCode !== 0 || result.timedOut)
      return yield* failed(
        result.timedOut
          ? "ffmpeg did not finish within 120 s"
          : `ffmpeg exited ${result.exitCode}: ${result.stderr.slice(-300)}`,
      );
    const read = (name: string) =>
      Effect.tryPromise({
        try: () => NodeFSP.readFile(NodePath.join(input.workDir, name)),
        catch: (cause) => failed(`ffmpeg wrote no ${name}`, cause),
      });
    const [siti, freeze, colour] = yield* Effect.all([
      read("siti.txt"),
      read("freeze.txt"),
      read("colour.rgb"),
    ]);
    return signalsOf(siti.toString("utf8"), freeze.toString("utf8"), colour);
  });
