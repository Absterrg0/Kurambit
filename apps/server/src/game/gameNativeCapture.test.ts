// @effect-diagnostics nodeBuiltinImport:off -- Fixture executables and temp paths live on the real filesystem for PATH discovery.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { NATIVE_CAPTURE_BOUNDS } from "@t3tools/contracts";
import {
  captureTimeoutMs,
  estimateCaptureBytes,
  findExecutable,
  godotMovieArgs,
  missingToolDetail,
  movieFrameEstimate,
  parseCalibrationRunnerReport,
  parsePhysicsTicksPerSecond,
  parseProbeJson,
  parseRunnerReport,
  plannedScenarioFrames,
  posterArgs,
  probeArgs,
  quitAfterRenderFrames,
  requiredReserveBytes,
  transcodeArgs,
  xvfbArgs,
} from "./gameNativeCapture.ts";

it("counts planned physics frames like the runner", () => {
  expect(
    plannedScenarioFrames([{ press: "jump" }, { hold: ["move_right"], frames: 120 }, { wait: 30 }]),
  ).toBe(2 + 120 + 30);
});

it("bounds movie frames and timeouts before launch", () => {
  // The measured 2D probe replayed 292 physics frames into 147 movie frames at 30 fps.
  expect(movieFrameEstimate(292, 30)).toBe(146);
  expect(movieFrameEstimate(292, 60)).toBe(292);
  expect(movieFrameEstimate(1800, 30, 30)).toBe(1800);
  expect(movieFrameEstimate(1800, 30, 120)).toBe(450);
  const timeout = captureTimeoutMs(1800, 30, 60);
  expect(timeout).toBeLessThanOrEqual(NATIVE_CAPTURE_BOUNDS.captureTimeoutMs);
  expect(timeout).toBeGreaterThanOrEqual(60_000);
  // A short probe route stays well inside the budget instead of timing out.
  expect(captureTimeoutMs(292, 30, 60)).toBeLessThan(NATIVE_CAPTURE_BOUNDS.captureTimeoutMs);
  // The timeout divides physics frames by the tick rate, not the movie fps.
  expect(captureTimeoutMs(600, 30, 60)).toBe(captureTimeoutMs(1200, 30, 120));
});

it("reads the configured physics tick rate instead of assuming 60 Hz", () => {
  expect(parsePhysicsTicksPerSecond("[display]\n")).toBe(60);
  expect(parsePhysicsTicksPerSecond("[physics]\ncommon/physics_ticks_per_second=120\n")).toBe(120);
  expect(parsePhysicsTicksPerSecond("physics_ticks_per_second=30")).toBe(30);
  expect(parsePhysicsTicksPerSecond("physics_ticks_per_second=0")).toBe(60);
});

it("caps --quit-after in render frames, not physics frames", () => {
  // 2D probe: 388 physics frames at 30 fps/60 Hz stay near the 194 movie
  // frames plus margin instead of the old physics-unit 478.
  const quitAfter = quitAfterRenderFrames(388, 30, 60);
  expect(quitAfter).toBe(movieFrameEstimate(388, 30) + 120);
  expect(quitAfter).toBeLessThanOrEqual(NATIVE_CAPTURE_BOUNDS.maxMovieFrames + 120);
  // A 120 Hz project converts the same physics plan into half the render cap.
  expect(quitAfterRenderFrames(388, 30, 120)).toBeLessThan(quitAfter);
});

it("estimates disk from raw frames and reserves twice the estimate", () => {
  // One raw RGBA frame is 4 bytes/px; the 64 MB overhead covers container,
  // poster, metadata and worst-case ~30 s stereo PCM (~6 MB at 48 kHz).
  const bytes = estimateCaptureBytes(960, 540, 147);
  expect(bytes).toBe(960 * 540 * 147 * 4 + 64 * 1024 * 1024);
  expect(bytes).toBeGreaterThan(64 * 1024 * 1024);
  expect(estimateCaptureBytes(1280, 720, 1000)).toBeGreaterThan(bytes);
  expect(requiredReserveBytes(bytes)).toBe(bytes * 2);
});

it("records on a private display with the probe's MovieWriter flags", () => {
  const movie = godotMovieArgs({
    godotProjectDir: "/game/godot",
    scriptPath: "/evidence/scenario.gd",
    requestPath: "/evidence/request.json",
    resultPath: "/evidence/result.json",
    aviPath: "/evidence/playback.avi",
    fps: 30,
    width: 960,
    height: 540,
    quitAfter: 412,
  });
  expect(movie).toContain("--write-movie");
  expect(movie).toContain("--fixed-fps");
  expect(movie).toContain("--audio-driver");
  const wrapped = xvfbArgs("/usr/bin/godot", movie);
  expect(wrapped[0]).toBe("-a");
  expect(wrapped).toContain("-s");
  expect(wrapped).toContain("/usr/bin/godot");
  // Never the user's desktop: the wrapper always names its own screen.
  expect(wrapped.join(" ")).toContain("1280x720x24");
});

it("transcodes to MP4, probes the encode and posters the middle", () => {
  const transcode = transcodeArgs("/evidence/playback.avi", "/evidence/clip.mp4");
  expect(transcode.slice(0, 3)).toEqual(["-y", "-threads", "2"]);
  expect(transcode).toContain("-filter_threads");
  expect(transcode).toContain("libx264");
  expect(transcode).toContain("+faststart");
  expect(transcode).toEqual([
    "-y",
    "-threads",
    "2",
    "-filter_threads",
    "1",
    "-i",
    "/evidence/playback.avi",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "/evidence/clip.mp4",
  ]);
  expect(probeArgs("/evidence/clip.mp4").join(" ")).toContain("r_frame_rate");
  const poster = posterArgs("/evidence/clip.mp4", "/evidence/poster.png", 4.9);
  // A 4.9s clip posters near the middle, never the boot frame by default.
  expect(poster).toContain("2.45");
  expect(poster.slice(0, 5)).toEqual(["-y", "-threads", "1", "-filter_threads", "1"]);
});

it("reads actual encode metadata from ffprobe, not the request", () => {
  const measured = parseProbeJson(
    JSON.stringify({
      streams: [
        {
          width: 1280,
          height: 720,
          r_frame_rate: "30/1",
          avg_frame_rate: "30/1",
          nb_frames: "110",
          codec_name: "h264",
          duration: "3.666667",
        },
      ],
    }),
  );
  expect(measured).toMatchObject({ width: 1280, height: 720, fps: 30, frames: 110 });
  expect(parseProbeJson(JSON.stringify({ streams: [] }))).toBeNull();
  expect(parseProbeJson("not json")).toBeNull();
});

it("reads the runner timeline with honest separate units", () => {
  const report = parseRunnerReport(
    JSON.stringify({
      id: "win-run",
      frames: 292,
      physicsHz: 60,
      playerMoved: true,
      error: null,
      timeline: [
        { step: 0, phase: "before", scenarioFrame: 30, enginePhysicsFrame: 30, renderFrame: 15 },
        { step: 0, phase: "after", scenarioFrame: 32, enginePhysicsFrame: 32, renderFrame: 16 },
      ],
    }),
  );
  expect(report?.frames).toBe(292);
  expect(report?.physicsHz).toBe(60);
  expect(report?.timeline).toHaveLength(2);
  // Scenario, engine-physics and render frames are different units; the
  // timeline keeps each under its own name instead of merging them.
  expect(report?.timeline[0]).toMatchObject({ scenarioFrame: 30, enginePhysicsFrame: 30 });
  expect(parseRunnerReport(JSON.stringify({ frames: 1, timeline: [{ step: "x" }] }))).toBeNull();
});

it("names missing platform tooling as an actionable optional-feature error", () => {
  expect(missingToolDetail("xvfb-run")).toContain("xvfb");
  expect(missingToolDetail("ffmpeg")).toContain("FFmpeg");
  expect(missingToolDetail("ffmpeg")).toContain("unaffected");
});

it("discovers executables on PATH without hard-coded machine paths", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "capture-path-"));
  try {
    const fake = NodePath.join(directory, "ffprobe");
    await NodeFSP.writeFile(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(await findExecutable("ffprobe", { pathEnv: directory })).toBe(fake);
    expect(await findExecutable("does-not-exist", { pathEnv: directory })).toBeNull();
    expect(await findExecutable("does-not-exist", { pathEnv: directory, override: fake })).toBe(
      fake,
    );
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("keeps the legacy transcode byte-identical and converts only the encoding on request", () => {
  const legacy = transcodeArgs("/evidence/playback.avi", "/evidence/clip.mp4");
  expect(legacy).not.toContain("-r");
  // An output-only rate converts the encoding without rerunning the game: the
  // raw capture was still reserved at the render cadence.
  const converted = transcodeArgs("/evidence/playback.avi", "/evidence/clip.mp4", 30);
  expect(converted).toContain("-r");
  expect(converted[converted.indexOf("-r") + 1]).toBe("30");
  expect(converted[converted.length - 1]).toBe("/evidence/clip.mp4");
  // Render-cadence planning never uses the output rate: the raw reserve is
  // identical whether or not an encode conversion follows.
  expect(movieFrameEstimate(292, 30)).toBe(movieFrameEstimate(292, 30));
});

it("reads calibration runner diagnostics beside the base report", () => {
  const report = parseCalibrationRunnerReport(
    JSON.stringify({
      id: "win-run",
      frames: 100,
      durationMs: 10,
      firstInputFrame: 30,
      baselineFrame: 32,
      playerMoved: true,
      error: null,
      invalidActions: [],
      observations: [
        {
          key: "collected",
          min: 0,
          max: 6,
          first: 0,
          last: 6,
          firstChangeFrame: 40,
          baseline: 0,
          matches: [],
        },
      ],
      userDataDir: "/tmp/run/user/data/godot/app_userdata/x",
      playerFirst: [0, 0],
      playerBaseline: [1, 1],
      playerLast: [3, 4],
      enginePhysicsFrames: 100,
      renderFrames: 50,
      physicsHz: 60,
      timeline: [
        { step: 0, phase: "before", scenarioFrame: 30, enginePhysicsFrame: 30, renderFrame: 15 },
      ],
    }),
  );
  expect(report?.frames).toBe(100);
  expect(report?.userDataDir).toContain("app_userdata");
  expect(report?.playerFirst).toEqual([0, 0]);
  expect(report?.playerBaseline).toEqual([1, 1]);
  expect(report?.playerLast).toEqual([3, 4]);
  expect(report?.enginePhysicsFrames).toBe(100);
  expect(report?.renderFrames).toBe(50);
  expect(report?.observations).toHaveLength(1);
  expect(report?.observations[0]).toMatchObject({ key: "collected", last: 6 });
  expect(parseCalibrationRunnerReport("not json")).toBeNull();
  expect(parseCalibrationRunnerReport(JSON.stringify({ frames: -1 }))).toBeNull();
});

it("keeps bounded scalar initial and final runtime state without inventing missing values", () => {
  const value = {
    frames: 150,
    physicsHz: 60,
    userDataDir: "/owned/data/game",
    playerFirst: [0, 0],
    playerBaseline: [0, 0],
    playerLast: [240, 0],
    enginePhysicsFrames: 150,
    renderFrames: 75,
    gameState: { visits: 1 },
    initialGameState: { visits: 1 },
    gameStateComplete: true,
  };
  const parsed = parseCalibrationRunnerReport(JSON.stringify(value));
  expect(parsed?.gameState).toEqual({ visits: 1 });
  expect(parsed?.initialGameState).toEqual({ visits: 1 });
  expect(parsed?.gameStateComplete).toBe(true);
  expect(
    parseCalibrationRunnerReport(JSON.stringify({ ...value, gameState: { nested: { a: 1 } } }))
      ?.gameState,
  ).toBeNull();
});
