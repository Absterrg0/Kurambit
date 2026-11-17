// @effect-diagnostics nodeBuiltinImport:off -- Reads a bot run's performance record from its evidence folder.
// Performance, measured during the plays the facts already run: the three.js shell
// keeps play's frame times, the GPU's time per frame (timer queries) and its render
// scale, and the play session reads them (`__studio.perf()`) as the page closes.
// What the page says is checked here before it becomes a fact.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { GAME_PERFORMANCE_SERIES_MAX, type GameBuildFacts } from "@kurambit/contracts";
import { busyReading, type MachineLoad, notMeasured } from "./buildFacts.ts";

/** Beside a bot run's trace: how its play ran, as the game's shell measured it. */
export const PLAY_PERF_FILE = "perf.json";

const Finite = Schema.Finite;
/** The shell's play stats (templates/runtime/three/1/shell/look.js); extra fields are ignored. */
export const PlayPerf = Schema.Struct({
  frames: Finite,
  seconds: Schema.NullOr(Finite),
  fps: Schema.NullOr(Finite),
  low1Fps: Schema.NullOr(Finite),
  gpuMs: Schema.NullOr(Finite),
  scale: Schema.NullOr(Finite),
  width: Finite,
  height: Finite,
  software: Schema.Boolean,
  renderer: Schema.String,
  /** The median sampled frame's draw calls and triangles; absent from shells that predate them. */
  drawCalls: Schema.optionalKey(Schema.NullOr(Finite)),
  triangles: Schema.optionalKey(Schema.NullOr(Finite)),
  /** Frames per second through play, a reading each half second; absent from older shells. */
  series: Schema.optionalKey(Schema.Array(Finite)),
});
export type PlayPerf = typeof PlayPerf.Type;
const decodePlayPerf = Schema.decodeUnknownOption(Schema.fromJsonString(PlayPerf));

/** A bot run's performance record; "none" when the run left none, null when it does not read. */
export const readPlayPerf = (root: string, evidence: string) =>
  NodeFSP.readFile(NodePath.join(root, evidence, PLAY_PERF_FILE), "utf8").then(
    (text) => Option.getOrNull(decodePlayPerf(text)),
    () => "none" as const,
  );

/** Frames to read a frame rate from: two seconds at 60 fps. */
const MIN_FRAMES = 120;
/**
 * A 1% low over fewer frames is a handful of start-up frames (shader and asset warm-up), not the
 * play: over the check's ~6 s it read 20 to 48 on the same build, run after run.
 */
const LOW1_FRAMES = 1000;
/** Below this a reading on a busy machine says nothing about the game. */
const SMOOTH_FPS = 55;

/** What a frame draws, as the record counted it: the same on any renderer. */
const countsOf = (record: PlayPerf) => {
  const whole = (value: number | null | undefined) =>
    typeof value === "number" && value >= 0 ? Math.round(value) : null;
  const drawCalls = whole(record.drawCalls);
  const triangles = whole(record.triangles);
  return {
    ...(drawCalls === null ? {} : { drawCalls }),
    ...(triangles === null ? {} : { triangles }),
  };
};

/**
 * PURE. The random-input play's record as the performance fact. Software
 * rendering is the harness's fault on this machine, never the game's: its frame
 * times are not read, and the reason says so with what the GPU probe printed;
 * what a frame draws is the game's own, so a record that counted it keeps it.
 */
export const performanceOf = (
  record: PlayPerf | "none" | null,
  browser: { readonly software: boolean; readonly renderer: string | null; readonly probe: string },
  machine: MachineLoad | null,
): GameBuildFacts["performance"] => {
  if (browser.software || (record !== null && record !== "none" && record.software)) {
    const counts = record !== null && record !== "none" ? countsOf(record) : {};
    if (record !== null && record !== "none" && Object.keys(counts).length > 0)
      return {
        status: "measured",
        value: {
          fps: null,
          low1: null,
          gpuMs: null,
          scale: null,
          width: Math.round(record.width),
          height: Math.round(record.height),
          frames: Math.round(record.frames),
          ...counts,
        },
      };
    // Its 300-character cap would cut the probe's output, so the reason is set after.
    return {
      ...notMeasured("software", false, true, "software"),
      why: `a harness fault on this machine, not the game's: the plays drew in software (${record !== null && record !== "none" ? record.renderer : (browser.renderer ?? "SwiftShader")}), where frame times say nothing about a game, because Kurambit's GPU probe found no hardware renderer (${browser.probe || "no output"})`.slice(
        0,
        700,
      ),
    };
  }
  if (record === "none")
    return notMeasured(
      "the game's shell does not report frame times (its copy of the shell predates performance measurement)",
      false,
      false,
      "old-shell",
    );
  if (record === null) return notMeasured("the play's performance record could not be read", true);
  if (record.frames < MIN_FRAMES || record.fps === null || record.low1Fps === null)
    return notMeasured(
      `the random-input play drew ${record.frames} frames of play, too few to read a frame rate`,
      false,
    );
  const value = {
    fps: record.fps,
    low1: record.low1Fps,
    gpuMs: record.gpuMs,
    scale: record.scale,
    width: Math.round(record.width),
    height: Math.round(record.height),
    frames: Math.round(record.frames),
    ...countsOf(record),
    ...(record.series === undefined || record.series.length < 2
      ? {}
      : {
          series: record.series.slice(-GAME_PERFORMANCE_SERIES_MAX).map((fps) => Math.round(fps)),
        }),
  };
  return (
    (record.fps < SMOOTH_FPS ? busyReading("frames ran slow", machine) : null) ?? {
      status: "measured",
      value,
    }
  );
};

/** A frame's GPU time with room for the browser's own work at 60 fps (shell/look.js's budget). */
const CHECK_GPU_BUDGET_MS = 12.5;
/** Past these a laptop's integrated GPU, slower than the one that measured, misses frames. */
const CHECK_DRAW_CALLS = 400;
const CHECK_TRIANGLES = 1_500_000;
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const count = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
      ? `${Math.round(n / 1000)}k`
      : `${n}`;

/**
 * PURE. game_check's play, read as one line and, when it misses 60 fps or spends more than a laptop
 * has, a warning that names what costs. Software drawing says nothing about a game, so it is said
 * as not measured. A slow frame rate with the GPU in budget is the CPU's: the game's code, or a
 * busy machine, and the warning says which it can tell.
 */
export const checkPerformance = (
  raw: unknown,
  browser: { readonly software: boolean },
): { readonly line: string; readonly warning: string | null } => {
  const record = Option.getOrNull(decodePlayPerf(JSON.stringify(raw ?? null)));
  const draws = finite(record?.drawCalls);
  const triangles = finite(record?.triangles);
  const counted = [
    draws === null ? null : `${count(draws)} draw calls`,
    triangles === null ? null : `${count(triangles)} triangles`,
  ].filter((part) => part !== null);
  const overCounts = [
    draws !== null && draws > CHECK_DRAW_CALLS
      ? `${count(draws)} draw calls (budget ${CHECK_DRAW_CALLS}): draw repeated models as one InstancedMesh (buildLevel does) and merge static pieces`
      : null,
    triangles !== null && triangles > CHECK_TRIANGLES
      ? `${count(triangles)} triangles (budget ${count(CHECK_TRIANGLES)}): fewer or lighter copies of the densest model, nothing far away drawn at full detail`
      : null,
  ].filter((cost) => cost !== null);
  // Software says nothing of the frame rate, but a frame draws the same on any renderer.
  if (browser.software || record?.software === true)
    return {
      line: [
        "fps not measured: this machine's check drew in software, where frame rates say nothing",
        ...counted,
      ].join(" · "),
      warning:
        overCounts.length === 0
          ? null
          : `Heavier than a laptop GPU holds at 60 fps: ${overCounts.join("; ")}.`,
    };
  if (record === null || record.fps === null || record.frames < MIN_FRAMES / 2)
    return { line: "not measured: the play drew too few frames to read", warning: null };
  const gpu = record.gpuMs;
  const low1 = record.frames >= LOW1_FRAMES ? record.low1Fps : null;
  const line = [
    `${Math.round(record.fps)} fps`,
    low1 === null ? null : `1% low ${Math.round(low1)}`,
    gpu === null
      ? null
      : `GPU ${gpu.toFixed(1)} ms at ${record.scale ?? 1}× of ${Math.round(record.width)}×${Math.round(record.height)}`,
    ...counted,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const costs = [
    gpu !== null && gpu > CHECK_GPU_BUDGET_MS
      ? `the GPU takes ${gpu.toFixed(1)} ms a frame (budget ${CHECK_GPU_BUDGET_MS})`
      : null,
    record.scale !== null && record.scale < 1
      ? `the look dropped to ${record.scale}× resolution to keep up`
      : null,
    ...overCounts,
  ].filter((cost) => cost !== null);
  const slow = record.fps < SMOOTH_FPS || (low1 !== null && low1 < 40);
  if (costs.length === 0 && !slow) return { line, warning: null };
  const why =
    costs.length > 0
      ? `${costs.join("; ")}. Also cheap to cut: the look's ao and bloom passes, shadow casting on small props.`
      : "the GPU has room, so the time goes to the game's own code each frame (allocations, scans over every object, physics) or this machine was busy; profile update(dt) before cutting art.";
  return {
    line,
    warning: `${slow ? "Under 60 fps" : "Heavier than a laptop GPU holds at 60 fps"}: ${why}`,
  };
};
