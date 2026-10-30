import * as Schema from "effect/Schema";

const scenarioIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const pathText = (cap: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(cap));

/**
 * Bounded native temporal diagnostic: replays one validated scenario through
 * the real game under Godot MovieWriter on a private virtual display, then
 * transcodes with the installed FFmpeg. A diagnostic clip only: it measures
 * input/frame timing, it never proves gameplay and never touches
 * qualification, and its source identity is the native game sources, not an
 * exported Web build.
 */
export const NATIVE_CAPTURE_BOUNDS = {
  /** Movie frames per second. 30 is the default; 60 only when the route stays bounded. */
  fpsDefault: 30,
  fpsOptions: [30, 60] as const,
  /** Planned physics frames (press 2, hold frames, wait) plus boot that one capture may run. */
  maxPlannedFrames: 1800,
  /** Encoded movie frames one capture may produce. */
  maxMovieFrames: 1000,
  /** Actual captured pixels must fit inside this box. */
  maxWidth: 1280,
  maxHeight: 720,
  /** Step-boundary timeline entries one capture may record. */
  maxTimelineEntries: 4096,
  /** Physics boot frames before the route starts, matching the scenario exam. */
  bootFrames: 30,
  /** Observation sampling stride, matching the scenario exam. */
  sampleEvery: 6,
  /** Requested capture window. The project viewport may override it, so the actual size is validated. */
  requestWidth: 960,
  requestHeight: 540,
  /** Private virtual display geometry for xvfb-run. */
  screen: "1280x720x24",
  /**
   * Conservative encoded bytes per pixel per frame for the disk preflight. A
   * raw RGBA frame needs 4 bytes/px; the fixed overhead below covers the
   * container, poster and metadata plus worst-case ~30 s stereo PCM at
   * 48 kHz (about 6 MB), so short diagnostic clips stay inside the reserve.
   */
  bytesPerPixelEstimate: 4,
  /** Fixed overhead (container, poster, metadata, worst-case audio) for the disk preflight. */
  estimateOverheadBytes: 64 * 1024 * 1024,
  /**
   * The disk preflight reserves twice the estimate: one share for the raw
   * capture plus audio, one for the transcode and poster. The refusal names
   * that doubled reserve honestly instead of reporting a single estimate.
   */
  diskSafetyFactor: 2,
  /**
   * Physics tick rates the capture can bound honestly. The project's
   * physics/common/physics_ticks_per_second is read before launch; anything
   * outside this set is refused instead of relabelled, because the movie
   * estimate, the render-frame quit cap and the timeout all divide by it.
   */
  supportedPhysicsHz: [30, 60, 120] as const,
  /** FFmpeg thread bounds for a 16 GB host: 2 decode threads, 1 encode thread, 1 filter thread. */
  decodeThreads: 2,
  encodeThreads: 1,
  filterThreads: 1,
  captureTimeoutMs: 300_000,
  transcodeTimeoutMs: 120_000,
  probeTimeoutMs: 30_000,
  posterTimeoutMs: 60_000,
} as const;

export const GameNativeCaptureInput = Schema.Struct({
  /** Authored id of one file in godot/tests/scenarios/<id>.json. Never a path or script. */
  scenarioId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.isPattern(scenarioIdPattern),
  ),
  /**
   * Godot render/movie rate in frames per second. This sets the engine render
   * cadence: different rates can change input timing and route outcomes, so
   * keep it fixed when comparing runs. Default 30.
   */
  fps: Schema.optionalKey(Schema.Literals([30, 60])),
  /**
   * Encode-only output rate in frames per second. It changes the FFmpeg
   * transcode target without rerunning the game: the engine still runs at
   * `fps`, the raw capture is still reserved at that render cadence, and only
   * the encoded clip is converted. Omitted means the render rate. A different
   * output rate never proves the game behaves the same at another cadence.
   */
  outputFps: Schema.optionalKey(Schema.Literals([30, 60])),
});
export type GameNativeCaptureInput = typeof GameNativeCaptureInput.Type;

export const GameNativeCaptureResult = Schema.Struct({
  scenarioId: pathText(64),
  /** The native build-source identity the capture ran against, not a Web build. */
  sourceId: pathText(64),
  /** Game-relative evidence directory holding clip.mp4, poster.png, result.json, timeline.json and capture.json. */
  evidenceDirectory: pathText(512),
  /** Game-relative paths. No media bytes cross the wire; read chosen files with file tools. */
  clipPath: pathText(512),
  posterPath: pathText(512),
  resultPath: pathText(512),
  timelinePath: pathText(512),
  requestedFps: Schema.Int,
  /**
   * Encode-only output rate the transcode targeted. Equals the render rate
   * when the caller did not name one; changing it never reruns the game.
   */
  requestedOutputFps: Schema.Int,
  /** Render cadence the engine ran at. The raw capture reserves at this rate. */
  renderFps: Schema.Int,
  /** Actual encoded frame rate from ffprobe, not the requested one. */
  actualFps: Schema.Number,
  requestedWidth: Schema.Int,
  requestedHeight: Schema.Int,
  /** Actual encoded pixels from ffprobe, not the requested window. */
  actualWidth: Schema.Int,
  actualHeight: Schema.Int,
  /** Physics frames the route ran, including boot. */
  scenarioFrames: Schema.Int,
  /** Encoded movie frames. A different unit from physics frames: never compare them as one. */
  movieFrames: Schema.Int,
  physicsHz: Schema.Int,
  playerMoved: Schema.Boolean,
  timelineEntries: Schema.Int,
  /** Honest limits, e.g. actual size differing from requested, unassessed recorded audio, measurement-only counters. */
  warnings: Schema.Array(Schema.String.check(Schema.isMaxLength(500))),
  message: Schema.String.check(Schema.isMaxLength(2000)),
});
export type GameNativeCaptureResult = typeof GameNativeCaptureResult.Type;
