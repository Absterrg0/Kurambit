import * as Schema from "effect/Schema";

/**
 * Bounded real audio measurement. One local asset file or one recorded
 * native clip is decoded with the installed FFmpeg and measured; nothing is
 * downloaded, nothing crosses the network, and no unbounded PCM buffer is
 * ever held. The result is concrete metrics plus honest unknowns, never a
 * quality verdict: it does not prove exported Web audio, composition, taste,
 * spatial mix or "good audio".
 */
export const GAME_AUDIO_INSPECT_BOUNDS = {
  /** Largest audio file the tool will open, in bytes. */
  maxFileBytes: 20 * 1024 * 1024,
  /** Longest audio stream the tool will measure, in seconds. */
  maxDurationSeconds: 120,
  maxChannels: 2,
  maxSampleRate: 192000,
  /** Largest ffprobe/ffmpeg stderr the tool will read, in bytes. */
  maxOutputBytes: 1 * 1024 * 1024,
  /** Per-tool wall-clock budget, in milliseconds. */
  probeTimeoutMs: 30_000,
  measureTimeoutMs: 60_000,
  /** dBFS peak at or above this counts a sample as near clipping. */
  nearClippingDb: -1,
  /** Below this mean volume the signal reads as silence. */
  silenceMeanDb: -60,
} as const;

export const GameAudioInspectInput = Schema.Struct({
  /**
   * Game-relative path to one local audio asset (e.g.
   * `godot/assets/theme.ogg`) or one recorded native clip (e.g. a
   * `builds/native-capture/<id>/clip.mp4` audio stream). Never a URL, never
   * an absolute path; symlinks resolving outside the game are refused.
   */
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  /**
   * Seconds of audio to measure from the start of the stream. Defaults to the
   * whole stream within the duration bound. Bounded above by
   * maxDurationSeconds.
   */
  segmentSeconds: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThan(0)).check(
      Schema.isLessThanOrEqualTo(GAME_AUDIO_INSPECT_BOUNDS.maxDurationSeconds),
    ),
  ),
});
export type GameAudioInspectInput = typeof GameAudioInspectInput.Type;

export const GameAudioInspectMetrics = Schema.Struct({
  /** Measured stream duration, in seconds. */
  durationSeconds: Schema.Number,
  /** Container/codec FFmpeg decoded, e.g. "vorbis", "aac", "pcm_s16le". */
  codec: Schema.String,
  /** Sample rate in Hz, as decoded. */
  sampleRate: Schema.Number,
  /** Channel count, preserved as decoded (never downmixed for the measure). */
  channels: Schema.Number,
  /** Peak volume in dBFS, or null when FFmpeg reported none. */
  peakDb: Schema.NullOr(Schema.Number),
  /** Measured segment length in seconds. */
  measuredSeconds: Schema.Number,
  /** Mean volume in dBFS, or null when FFmpeg reported none. */
  meanDb: Schema.NullOr(Schema.Number),
  /** Seconds detected as silence, or null when not measured. */
  silenceSeconds: Schema.NullOr(Schema.Number),
  /** Samples at or above the clipping threshold, or null when unreported. */
  nearClippingSamples: Schema.NullOr(Schema.Number),
  /** True when every measured sample cancels across channels (opposite-phase mono). */
  phaseCancelled: Schema.optionalKey(Schema.Boolean),
});
export type GameAudioInspectMetrics = typeof GameAudioInspectMetrics.Type;

export const GameAudioInspectResult = Schema.Struct({
  /** The game-relative path that was measured, first in every report. */
  path: Schema.String,
  evidenceDirectory: Schema.optionalKey(Schema.String),
  reportPath: Schema.optionalKey(Schema.String),
  logs: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * What was measured: a local asset file, or a recorded native clip's
   * audio stream. Native-clip audio is engine-mixer audio from the native
   * sources, never the exported Web build.
   */
  source: Schema.Struct({
    kind: Schema.Literals(["asset", "native-clip"]),
    /** The game's source identity when the measurement ran, when known. */
    sourceId: Schema.NullOr(Schema.String),
    fileSha256: Schema.optionalKey(Schema.String),
  }),
  metrics: GameAudioInspectMetrics,
  /**
   * Honest limits: missing tool, truncated segment, unmeasured fields, and
   * the explicit native-vs-Web scope. Never a quality verdict.
   */
  warnings: Schema.Array(Schema.String.check(Schema.isMaxLength(500))),
  unknowns: Schema.Array(Schema.String.check(Schema.isMaxLength(500))),
  message: Schema.String.check(Schema.isMaxLength(2000)),
});
export type GameAudioInspectResult = typeof GameAudioInspectResult.Type;
