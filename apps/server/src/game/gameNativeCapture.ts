// @effect-diagnostics nodeBuiltinImport:off -- This helper owns the native filesystem boundary for diagnostic captures.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { NATIVE_CAPTURE_BOUNDS } from "@t3tools/contracts";

/** One step-boundary sample. Three different units, kept separate on purpose. */
export interface NativeCaptureTimelineEntry {
  readonly step: number;
  readonly phase: "before" | "after";
  /** Runner physics frames consumed by the route, including boot. */
  readonly scenarioFrame: number;
  /** Engine physics ticks since boot. */
  readonly enginePhysicsFrame: number;
  /** Engine process (render) ticks since boot. */
  readonly renderFrame: number;
}

export interface NativeCaptureRunnerReport {
  readonly frames: number;
  readonly physicsHz: number;
  readonly playerMoved: boolean;
  readonly error: string | null;
  readonly timeline: readonly NativeCaptureTimelineEntry[];
}

/**
 * Planned physics frames for a validated scenario: a press costs two ticks,
 * a hold costs its frames, a wait costs its wait.
 */
export const plannedScenarioFrames = (steps: readonly unknown[]): number => {
  let planned = 0;
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const record = step as Record<string, unknown>;
    if (typeof record.press === "string") planned += 2;
    else if (Array.isArray(record.hold) && typeof record.frames === "number")
      planned += record.frames;
    else if (typeof record.wait === "number") planned += record.wait;
  }
  return planned;
};

export const movieFrameEstimate = (plannedFrames: number, fps: number, physicsHz = 60): number =>
  Math.ceil((plannedFrames * fps) / physicsHz);

/**
 * The project's physics tick rate, read from project.godot before launch.
 * Godot defaults to 60 when the project sets nothing; the capture refuses
 * anything outside NATIVE_CAPTURE_BOUNDS.supportedPhysicsHz instead of
 * silently relabelling physics frames as render frames.
 */
export const parsePhysicsTicksPerSecond = (projectGodot: string): number => {
  const match = projectGodot.match(/physics_ticks_per_second\s*=\s*(\d+)/);
  if (!match) return 60;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 60;
};

/**
 * Render-frame fallback cap for --quit-after, in the CLI's own unit. Movie
 * frames track render frames under --fixed-fps, not physics frames, so the
 * physics plan is converted at the configured tick rate and given a fixed
 * render-frame margin. The caller validates movieEstimate first, so this
 * stays bounded by maxMovieFrames plus the margin.
 */
export const quitAfterRenderFrames = (
  plannedFrames: number,
  fps: number,
  physicsHz: number,
): number => Math.ceil((plannedFrames * fps) / physicsHz) + 120;

/** Worst-case bytes before launch: one raw RGBA frame (4 bytes/px) per movie frame plus fixed overhead. */
export const estimateCaptureBytes = (width: number, height: number, movieFrames: number): number =>
  width * height * movieFrames * NATIVE_CAPTURE_BOUNDS.bytesPerPixelEstimate +
  NATIVE_CAPTURE_BOUNDS.estimateOverheadBytes;

/** Twice the estimate: the preflight reserves raw capture plus transcode/poster headroom. */
export const requiredReserveBytes = (estimateBytes: number): number =>
  estimateBytes * NATIVE_CAPTURE_BOUNDS.diskSafetyFactor;

/**
 * Conservative timeout for the Godot capture from the route length, in
 * milliseconds. Physics frames convert at the configured tick rate (not the
 * movie fps); the 90-frame render margin converts at the movie fps.
 */
export const captureTimeoutMs = (plannedFrames: number, fps: number, physicsHz = 60): number => {
  const movieSeconds = plannedFrames / physicsHz + 90 / fps;
  return Math.min(
    NATIVE_CAPTURE_BOUNDS.captureTimeoutMs,
    Math.max(60_000, Math.ceil(movieSeconds * 1000 * 4) + 60_000),
  );
};

const isExecutable = async (path: string): Promise<boolean> => {
  try {
    await NodeFSP.access(path, NodeFSP.constants.X_OK);
    return (await NodeFSP.stat(path)).isFile();
  } catch {
    return false;
  }
};

/**
 * PATH discovery for standard executables. Env overrides exist for configured
 * test environments only; the product never hard-codes a machine path.
 */
export const findExecutable = async (
  name: string,
  options: { readonly pathEnv?: string | undefined; readonly override?: string | undefined },
): Promise<string | null> => {
  const candidates: string[] = [];
  if (options.override?.trim()) candidates.push(options.override.trim());
  for (const entry of (options.pathEnv ?? "").split(NodePath.delimiter).filter(Boolean))
    candidates.push(NodePath.join(entry, name));
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
};

export const missingToolDetail = (tool: string): string =>
  tool === "xvfb-run"
    ? "xvfb-run was not found on PATH. Install the xvfb package (the capture runs on a private virtual display, never the desktop). Web playtests and scenario runs are unaffected."
    : tool === "ffmpeg" || tool === "ffprobe"
      ? `${tool} was not found on PATH. Install FFmpeg to transcode and measure native clips. Web playtests and scenario runs are unaffected.`
      : `${tool} was not found. Fix its path; Web playtests and scenario runs are unaffected.`;

/** Godot MovieWriter arguments. Mirrors the measured prototype invocation. */
export const godotMovieArgs = (input: {
  readonly godotProjectDir: string;
  readonly scriptPath: string;
  readonly requestPath: string;
  readonly resultPath: string;
  readonly aviPath: string;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly quitAfter: number;
}): readonly string[] => [
  "--display-driver",
  "x11",
  "--rendering-method",
  "gl_compatibility",
  "--audio-driver",
  "Dummy",
  "--fixed-fps",
  String(input.fps),
  "--resolution",
  `${input.width}x${input.height}`,
  "--path",
  input.godotProjectDir,
  "--write-movie",
  input.aviPath,
  "--quit-after",
  String(input.quitAfter),
  "--script",
  input.scriptPath,
  "--",
  input.requestPath,
  input.resultPath,
];

/** xvfb-run prefix plus the Godot command: one private display, never the user's desktop. */
export const xvfbArgs = (
  godotExecutable: string,
  godotArgs: readonly string[],
): readonly string[] => [
  "-a",
  "-s",
  `-screen 0 ${NATIVE_CAPTURE_BOUNDS.screen}`,
  godotExecutable,
  ...godotArgs,
];

export const transcodeArgs = (
  aviPath: string,
  mp4Path: string,
  outputFps?: number | undefined,
): readonly string[] => [
  "-y",
  // Decoder bound (input side), then encoder and filter bounds (output side):
  // a 16 GB host transcodes one diagnostic clip with 2 decode threads, 1
  // encode thread and 1 filter thread, streaming file to file throughout.
  "-threads",
  String(NATIVE_CAPTURE_BOUNDS.decodeThreads),
  "-filter_threads",
  String(NATIVE_CAPTURE_BOUNDS.filterThreads),
  "-i",
  aviPath,
  "-c:v",
  "libx264",
  "-threads",
  String(NATIVE_CAPTURE_BOUNDS.encodeThreads),
  // Encode-only rate: the raw capture already ran at the render cadence, so
  // this converts the encoding without rerunning the game. Omitted means the
  // render rate (legacy behaviour, byte-identical args).
  ...(outputFps === undefined ? [] : ["-r", String(outputFps)]),
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  mp4Path,
];

export const probeArgs = (mp4Path: string): readonly string[] => [
  "-v",
  "error",
  "-select_streams",
  "v:0",
  "-show_entries",
  "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,codec_name,duration",
  "-of",
  "json",
  mp4Path,
];

/** Extract the poster from the middle of the clip, so boot/menu black is not the evidence. */
export const posterArgs = (
  mp4Path: string,
  posterPath: string,
  durationSeconds: number,
): readonly string[] => [
  "-y",
  // A single poster frame needs no parallelism: bound decode and filter threads.
  "-threads",
  "1",
  "-filter_threads",
  String(NATIVE_CAPTURE_BOUNDS.filterThreads),
  "-ss",
  String(Math.max(0, durationSeconds / 2)),
  "-i",
  mp4Path,
  "-vframes",
  "1",
  posterPath,
];

export interface NativeCaptureProbe {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frames: number;
  readonly codec: string;
  readonly durationSeconds: number;
}

const parseRate = (rate: string): number | null => {
  const match = rate.match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = match[2] === undefined ? 1 : Number(match[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0)
    return null;
  return numerator / denominator;
};

/** Encoded metadata comes from ffprobe, never from the requested window size. */
export const parseProbeJson = (text: string): NativeCaptureProbe | null => {
  try {
    const parsed = JSON.parse(text) as {
      readonly streams?: readonly {
        readonly width?: unknown;
        readonly height?: unknown;
        readonly r_frame_rate?: unknown;
        readonly avg_frame_rate?: unknown;
        readonly nb_frames?: unknown;
        readonly codec_name?: unknown;
        readonly duration?: unknown;
      }[];
    };
    const stream = parsed.streams?.[0];
    if (!stream) return null;
    const width = typeof stream.width === "number" ? stream.width : Number(stream.width);
    const height = typeof stream.height === "number" ? stream.height : Number(stream.height);
    const fps =
      (typeof stream.r_frame_rate === "string" ? parseRate(stream.r_frame_rate) : null) ??
      (typeof stream.avg_frame_rate === "string" ? parseRate(stream.avg_frame_rate) : null);
    const frames =
      typeof stream.nb_frames === "string" && stream.nb_frames !== "N/A"
        ? Number.parseInt(stream.nb_frames, 10)
        : Number.NaN;
    const duration =
      typeof stream.duration === "string"
        ? Number(stream.duration)
        : typeof stream.duration === "number"
          ? stream.duration
          : Number.NaN;
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0)
      return null;
    if (fps === null || !Number.isFinite(fps) || fps <= 0) return null;
    const resolvedFrames =
      Number.isInteger(frames) && frames > 0 ? frames : Math.round(fps * duration);
    if (!Number.isInteger(resolvedFrames) || resolvedFrames <= 0) return null;
    return {
      width,
      height,
      fps,
      frames: resolvedFrames,
      codec: typeof stream.codec_name === "string" ? stream.codec_name : "unknown",
      durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : resolvedFrames / fps,
    };
  } catch {
    return null;
  }
};

const isTimelineEntry = (value: unknown): value is NativeCaptureTimelineEntry => {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.step === "number" &&
    Number.isInteger(entry.step) &&
    entry.step >= 0 &&
    (entry.phase === "before" || entry.phase === "after") &&
    typeof entry.scenarioFrame === "number" &&
    Number.isInteger(entry.scenarioFrame) &&
    entry.scenarioFrame >= 0 &&
    typeof entry.enginePhysicsFrame === "number" &&
    Number.isInteger(entry.enginePhysicsFrame) &&
    entry.enginePhysicsFrame >= 0 &&
    typeof entry.renderFrame === "number" &&
    Number.isInteger(entry.renderFrame) &&
    entry.renderFrame >= 0
  );
};

/** Lenient runner-result reader: the capture owns timeline/physics extras the exam decoder never sees. */
export const parseRunnerReport = (text: string): NativeCaptureRunnerReport | null => {
  try {
    const parsed = JSON.parse(text) as {
      readonly frames?: unknown;
      readonly physicsHz?: unknown;
      readonly playerMoved?: unknown;
      readonly error?: unknown;
      readonly timeline?: unknown;
    };
    if (typeof parsed.frames !== "number" || !Number.isInteger(parsed.frames) || parsed.frames < 0)
      return null;
    const rawTimeline = Array.isArray(parsed.timeline) ? parsed.timeline : [];
    if (rawTimeline.length > NATIVE_CAPTURE_BOUNDS.maxTimelineEntries) return null;
    if (!rawTimeline.every(isTimelineEntry)) return null;
    return {
      frames: parsed.frames,
      physicsHz:
        typeof parsed.physicsHz === "number" && Number.isFinite(parsed.physicsHz)
          ? parsed.physicsHz
          : 60,
      playerMoved: parsed.playerMoved === true,
      error: typeof parsed.error === "string" ? parsed.error : null,
      timeline: rawTimeline as NativeCaptureTimelineEntry[],
    };
  } catch {
    return null;
  }
};

export interface CalibrationRunnerObservation {
  readonly key: string;
  readonly baseline: number | boolean | string | null;
  readonly last: number | boolean | string | null;
}

export interface CalibrationRunnerReport {
  readonly frames: number;
  readonly gameState: Readonly<Record<string, number | boolean | string | null>> | null;
  readonly initialGameState: Readonly<Record<string, number | boolean | string | null>> | null;
  readonly gameStateComplete: boolean | null;
  readonly physicsHz: number;
  readonly playerMoved: boolean;
  readonly error: string | null;
  readonly timeline: readonly NativeCaptureTimelineEntry[];
  readonly userDataDir: string | null;
  readonly playerFirst: readonly number[] | null;
  readonly playerBaseline: readonly number[] | null;
  readonly playerLast: readonly number[] | null;
  readonly enginePhysicsFrames: number | null;
  readonly renderFrames: number | null;
  readonly firstInputFrame: number | null;
  readonly baselineFrame: number | null;
  readonly observations: readonly CalibrationRunnerObservation[];
}

const isPositionVector = (value: unknown): value is readonly number[] => {
  if (!Array.isArray(value)) return false;
  if (value.length < 2 || value.length > 3) return false;
  return value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
};

const asPositionOrNull = (value: unknown): readonly number[] | null =>
  value === null || value === undefined ? null : isPositionVector(value) ? value : null;

const asIntOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

const asObservedOrNull = (value: unknown): number | boolean | string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean" || typeof value === "string") return value;
  return null;
};

/**
 * Lenient calibration-run reader. Extended diagnostics (player positions,
 * engine counters, user data dir, observations) ride beside the base report;
 * a run that cannot be parsed, or that carries malformed extended fields, is
 * not a passing measurement: the caller records it as unknown.
 */
export const parseCalibrationRunnerReport = (text: string): CalibrationRunnerReport | null => {
  let parsed: Record<string, unknown>;
  try {
    const decoded = JSON.parse(text) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
    parsed = decoded as Record<string, unknown>;
  } catch {
    return null;
  }
  const frames = parsed["frames"];
  if (typeof frames !== "number" || !Number.isInteger(frames) || frames < 0) return null;
  const rawTimeline = Array.isArray(parsed["timeline"]) ? parsed["timeline"] : [];
  if (rawTimeline.length > NATIVE_CAPTURE_BOUNDS.maxTimelineEntries) return null;
  if (!rawTimeline.every(isTimelineEntry)) return null;
  const rawObservations = Array.isArray(parsed["observations"]) ? parsed["observations"] : [];
  const observations: CalibrationRunnerObservation[] = [];
  for (const entry of rawObservations) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record["key"] !== "string") return null;
    observations.push({
      key: record["key"],
      baseline: asObservedOrNull(record["baseline"]),
      last: asObservedOrNull(record["last"]),
    });
    if (observations.length > 64) return null;
  }
  const scalarState = (value: unknown): Record<string, number | boolean | string | null> | null => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    if (entries.length > 64) return null;
    if (
      entries.some(
        ([key, v]) =>
          key.length > 64 ||
          (v !== null &&
            typeof v !== "boolean" &&
            !(typeof v === "number" && Number.isFinite(v)) &&
            !(typeof v === "string" && v.length <= 256)),
      )
    )
      return null;
    return Object.fromEntries(entries) as Record<string, number | boolean | string | null>;
  };
  return {
    gameState: scalarState(parsed["gameState"]),
    initialGameState: scalarState(parsed["initialGameState"]),
    gameStateComplete:
      typeof parsed["gameStateComplete"] === "boolean" ? parsed["gameStateComplete"] : null,
    frames,
    physicsHz:
      typeof parsed["physicsHz"] === "number" && Number.isFinite(parsed["physicsHz"])
        ? (parsed["physicsHz"] as number)
        : 60,
    playerMoved: parsed["playerMoved"] === true,
    error: typeof parsed["error"] === "string" ? (parsed["error"] as string) : null,
    timeline: rawTimeline as NativeCaptureTimelineEntry[],
    userDataDir:
      typeof parsed["userDataDir"] === "string" ? (parsed["userDataDir"] as string) : null,
    playerFirst: asPositionOrNull(parsed["playerFirst"]),
    playerBaseline: asPositionOrNull(parsed["playerBaseline"]),
    playerLast: asPositionOrNull(parsed["playerLast"]),
    enginePhysicsFrames:
      typeof parsed["enginePhysicsFrames"] === "number" &&
      Number.isInteger(parsed["enginePhysicsFrames"]) &&
      (parsed["enginePhysicsFrames"] as number) >= 0
        ? (parsed["enginePhysicsFrames"] as number)
        : null,
    renderFrames:
      typeof parsed["renderFrames"] === "number" &&
      Number.isInteger(parsed["renderFrames"]) &&
      (parsed["renderFrames"] as number) >= 0
        ? (parsed["renderFrames"] as number)
        : null,
    firstInputFrame:
      parsed["firstInputFrame"] === null || parsed["firstInputFrame"] === undefined
        ? null
        : asIntOrNull(parsed["firstInputFrame"]),
    baselineFrame:
      parsed["baselineFrame"] === null || parsed["baselineFrame"] === undefined
        ? null
        : asIntOrNull(parsed["baselineFrame"]),
    observations,
  };
};

/** Free bytes on the evidence filesystem, or null when the platform cannot say. */
export const freeBytes = async (directory: string): Promise<number | null> => {
  try {
    const stats = await NodeFSP.statfs(directory);
    // bavail, not bfree: reserved root blocks are not available to the capture.
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
};
