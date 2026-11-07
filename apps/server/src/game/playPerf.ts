// @effect-diagnostics nodeBuiltinImport:off -- Reads a bot run's performance record from its evidence folder.
// Performance, measured during the plays the facts already run: the three.js shell
// keeps play's frame times, the GPU's time per frame (timer queries) and its render
// scale, and the play session reads them (`__studio.perf()`) as the page closes.
// What the page says is checked here before it becomes a fact.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { GameBuildFacts } from "@kurambit/contracts";
import { busyReading, type MachineLoad, notMeasured } from "./buildFacts.ts";

/** Beside a bot run's trace: how its play ran, as the game's shell measured it. */
export const PLAY_PERF_FILE = "perf.json";

const Finite = Schema.Finite;
/** The shell's play stats (templates/blank-three/web/shell/look.js); extra fields are ignored. */
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
/** Below this a reading on a busy machine says nothing about the game. */
const SMOOTH_FPS = 55;

/**
 * PURE. The random-input play's record as the performance fact. Software
 * rendering is the harness's fault on this machine, never the game's: the reason
 * says so, with what the GPU probe printed.
 */
export const performanceOf = (
  record: PlayPerf | "none" | null,
  browser: { readonly software: boolean; readonly renderer: string | null; readonly probe: string },
  machine: MachineLoad | null,
): GameBuildFacts["performance"] => {
  if (browser.software || (record !== null && record !== "none" && record.software))
    // Its 300-character cap would cut the probe's output, so the reason is set after.
    return {
      ...notMeasured("software", false, true),
      why: `a harness fault on this machine, not the game's: the plays drew in software (${record !== null && record !== "none" ? record.renderer : (browser.renderer ?? "SwiftShader")}), where frame times say nothing about a game, because Kurambit's GPU probe found no hardware renderer (${browser.probe || "no output"})`.slice(
        0,
        700,
      ),
    };
  if (record === "none")
    return notMeasured(
      "the game's shell does not report frame times (its copy of the shell predates performance measurement)",
      false,
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
  };
  return (
    (record.fps < SMOOTH_FPS ? busyReading("frames ran slow", machine) : null) ?? {
      status: "measured",
      value,
    }
  );
};
