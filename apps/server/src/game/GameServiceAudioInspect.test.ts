// @effect-diagnostics nodeBuiltinImport:off -- Proves audio inspection wiring against a real game tree with mocked FFmpeg.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ThreadId, type GameManifest, type GameProcessResult } from "@t3tools/contracts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import {
  admissionTestLayer,
  previewBrowserTestLayer,
  qualificationTestLayer,
  roundStoreTestLayer,
} from "./gameTestLayers.ts";

afterEach(() => vi.unstubAllEnvs());

const threadId = ThreadId.make("audio-inspect-test");
const manifest: GameManifest = {
  schemaVersion: 1,
  name: "Audio inspect",
  brief: "",
  artDirection: "",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
};

/** Minimal PCM16 stereo WAV writer: fixtures stay hand-made, no encoder runs. */
const writeWav = async (path: string, samples: (frame: number) => [number, number]) => {
  const rate = 44100;
  const frames = rate;
  const data = Buffer.alloc(frames * 4);
  for (let frame = 0; frame < frames; frame++) {
    const [left, right] = samples(frame);
    const clamp = (value: number) => Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767);
    data.writeInt16LE(Math.round(clamp(left)), frame * 4);
    data.writeInt16LE(Math.round(clamp(right)), frame * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  await NodeFSP.writeFile(path, Buffer.concat([header, data]));
};

const phase = (frame: number) => Math.sin((2 * Math.PI * 440 * frame) / 44100);

const TONE_MEASURE = `[Parsed_silencedetect_0 @ 0x1] silence_end: 0 | silence_duration: 0
[Parsed_volumedetect_0 @ 0x2] n_samples: 44100
[Parsed_volumedetect_0 @ 0x2] mean_volume: -12.1 dB
[Parsed_volumedetect_0 @ 0x2] max_volume: -9.1 dB
[Parsed_volumedetect_0 @ 0x2] histogram_9db: 25440
[Parsed_astats_0 @ 0x3] Channel: 1
[Parsed_astats_0 @ 0x3] Peak level dB: -9.073654
[Parsed_astats_0 @ 0x3] RMS level dB: -12.084013
[Parsed_astats_0 @ 0x3] Channel: 2
[Parsed_astats_0 @ 0x3] Peak level dB: -9.073654
[Parsed_astats_0 @ 0x3] RMS level dB: -12.084013
[Parsed_volumedetect_2 @ 0x4] n_samples: 22050
[Parsed_volumedetect_2 @ 0x4] mean_volume: -12.1 dB
[Parsed_volumedetect_2 @ 0x4] max_volume: -9.1 dB
`;

const SILENCE_MEASURE = `[Parsed_silencedetect_0 @ 0x1] silence_start: 0
[Parsed_silencedetect_0 @ 0x1] silence_end: 1 | silence_duration: 1
[Parsed_volumedetect_0 @ 0x2] n_samples: 44100
[Parsed_volumedetect_0 @ 0x2] mean_volume: -91.0 dB
[Parsed_volumedetect_0 @ 0x2] max_volume: -91.0 dB
[Parsed_astats_0 @ 0x3] Channel: 1
[Parsed_astats_0 @ 0x3] Peak level dB: -inf
[Parsed_astats_0 @ 0x3] RMS level dB: -inf
[Parsed_astats_0 @ 0x3] Channel: 2
[Parsed_astats_0 @ 0x3] Peak level dB: -inf
[Parsed_astats_0 @ 0x3] RMS level dB: -inf
[Parsed_volumedetect_2 @ 0x4] n_samples: 22050
[Parsed_volumedetect_2 @ 0x4] mean_volume: -91.0 dB
[Parsed_volumedetect_2 @ 0x4] max_volume: -91.0 dB
`;

const CLIP_MEASURE = `[Parsed_volumedetect_0 @ 0x2] n_samples: 44100
[Parsed_volumedetect_0 @ 0x2] mean_volume: -0.7 dB
[Parsed_volumedetect_0 @ 0x2] max_volume: 0.0 dB
[Parsed_volumedetect_0 @ 0x2] histogram_0db: 70000
[Parsed_astats_0 @ 0x3] Channel: 1
[Parsed_astats_0 @ 0x3] Peak level dB: 0.0
[Parsed_astats_0 @ 0x3] RMS level dB: -3.0
[Parsed_astats_0 @ 0x3] Channel: 2
[Parsed_astats_0 @ 0x3] Peak level dB: 0.0
[Parsed_astats_0 @ 0x3] RMS level dB: -3.0
[Parsed_volumedetect_2 @ 0x4] n_samples: 22050
[Parsed_volumedetect_2 @ 0x4] mean_volume: -0.7 dB
[Parsed_volumedetect_2 @ 0x4] max_volume: 0.0 dB
[Parsed_volumedetect_2 @ 0x4] histogram_0db: 35000
`;

const CANCEL_MEASURE = `[Parsed_volumedetect_0 @ 0x2] n_samples: 44100
[Parsed_volumedetect_0 @ 0x2] mean_volume: -21.1 dB
[Parsed_volumedetect_0 @ 0x2] max_volume: -18.1 dB
[Parsed_astats_0 @ 0x3] Channel: 1
[Parsed_astats_0 @ 0x3] Peak level dB: -18.1
[Parsed_astats_0 @ 0x3] RMS level dB: -21.1
[Parsed_astats_0 @ 0x3] Channel: 2
[Parsed_astats_0 @ 0x3] Peak level dB: -18.1
[Parsed_astats_0 @ 0x3] RMS level dB: -21.1
[Parsed_volumedetect_2 @ 0x4] n_samples: 22050
[Parsed_volumedetect_2 @ 0x4] mean_volume: -91.0 dB
[Parsed_volumedetect_2 @ 0x4] max_volume: -91.0 dB
`;

type Plan =
  | "tone"
  | "silence"
  | "clipping"
  | "cancelled"
  | "long"
  | "hang"
  | "measure-fails"
  | "source-change"
  | "audio-change";

const probeStdout = (duration: string) =>
  JSON.stringify({
    streams: [{ codec_name: "pcm_s16le", sample_rate: "44100", channels: 2, duration }],
  });

const resultFor = (directory: string): GameProcessResult => ({
  pid: 4242,
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: "",
  stderr: "",
  logPath: NodePath.join(directory, "builds/logs/fake.log"),
});

interface Fixture {
  readonly root: string;
  readonly game: GameService.GameService["Service"];
  readonly entered: Deferred.Deferred<void>;
  readonly measured: Deferred.Deferred<ReadonlyArray<string>>;
}

const withFixture = <A, E>(
  plan: Plan,
  run: (fixture: Fixture) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "audio-inspect-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot/assets/audio"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(root, "godot/tests/scenarios"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(root, "builds/logs"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(root, "builds/native-capture/take-1"), {
          recursive: true,
        });
        await NodeFSP.mkdir(NodePath.join(root, "bin"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "godot/project.godot"), "[application]\n");
        await writeWav(NodePath.join(root, "godot/assets/audio/tone.wav"), (frame) => {
          const value = phase(frame) * 0.3;
          return [value, value];
        });
        await writeWav(NodePath.join(root, "godot/assets/audio/silence.wav"), () => [0, 0]);
        await writeWav(NodePath.join(root, "godot/assets/audio/clipping.wav"), (frame) => {
          const value = frame % 2 === 0 ? 1 : -1;
          return [value, value];
        });
        await writeWav(NodePath.join(root, "godot/assets/audio/cancelled.wav"), (frame) => {
          const value = phase(frame) * 0.3;
          return [value, -value];
        });
        await writeWav(NodePath.join(root, "builds/native-capture/take-1/clip.mp4"), (frame) => {
          const value = phase(frame) * 0.3;
          return [value, value];
        });
        await NodeFSP.writeFile(
          NodePath.join(root, "builds/native-capture/take-1/capture.json"),
          JSON.stringify({ scenarioId: "win", sourceId: "clip-source-1" }),
        );
        for (const tool of ["ffmpeg", "ffprobe"])
          await NodeFSP.writeFile(NodePath.join(root, "bin", tool), "#!/bin/sh\nexit 0\n", {
            mode: 0o755,
          });
      });
      if (plan !== "hang") vi.stubEnv("PATH", NodePath.join(root, "bin"));
      const entered = yield* Deferred.make<void>();
      const measured = yield* Deferred.make<ReadonlyArray<string>>();
      const measureFor =
        plan === "tone"
          ? TONE_MEASURE
          : plan === "silence"
            ? SILENCE_MEASURE
            : plan === "clipping"
              ? CLIP_MEASURE
              : CANCEL_MEASURE;
      const processes = Layer.mock(GameProcesses.GameProcesses)({
        run: (input) =>
          Effect.gen(function* () {
            if (input.operation === "inspect-audio-probe") {
              if (plan === "long") return { ...resultFor(root), stdout: probeStdout("200.0") };
              return { ...resultFor(root), stdout: probeStdout("1.0") };
            }
            if (input.operation === "inspect-audio-measure") {
              yield* Deferred.succeed(entered, undefined);
              if (plan === "hang") return yield* Effect.never;
              if (plan === "measure-fails")
                return { ...resultFor(root), exitCode: 1, stderr: "ffmpeg failed" };
              if (plan === "source-change")
                yield* Effect.promise(() =>
                  NodeFSP.writeFile(NodePath.join(root, "godot/changed.gd"), "extends Node\n"),
                );
              if (plan === "audio-change")
                yield* Effect.promise(() =>
                  NodeFSP.appendFile(input.args[input.args.indexOf("-i") + 1]!, "changed"),
                );
              yield* Deferred.succeed(measured, [...input.args]);
              return { ...resultFor(root), stdout: "", stderr: measureFor };
            }
            return yield* Effect.die(`Unexpected audio operation ${input.operation}.`);
          }),
        stop: () => Effect.void,
        list: () => [],
      });
      const services = GameService.layer.pipe(
        Layer.provideMerge(processes),
        Layer.provide(
          Layer.mock(GameProjectService.GameProjectService)({
            resolve: () => Effect.succeed(root),
            read: () => Effect.succeed(manifest),
          }),
        ),
        Layer.provide(
          Layer.mock(GameToolchain.GameToolchain)({
            executable: () =>
              Effect.succeed({
                path: NodePath.join(root, "godot-fake"),
                version: "4.7.2",
                templates: null,
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(GamePreview.GamePreview)({
            directories: () => [],
            serving: () => false,
            stop: () => Effect.void,
            url: () => null,
            urlFor: () => null,
          }),
        ),
        Layer.provide(
          Layer.mock(GameDesignApproval.GameDesignApproval)({
            status: () =>
              Effect.succeed({
                state: "approved",
                document: null,
                documentTruncated: false,
                approvedHash: null,
                currentHash: null,
                approvedAt: null,
                acceptance: [],
                issues: [],
                autoRevision: 0,
                pendingRevision: null,
                revisionDiff: null,
              }),
          }),
        ),
        Layer.provide(previewBrowserTestLayer()),
        Layer.provideMerge(qualificationTestLayer(NodePath.join(root, ".test-state"))),
        Layer.provideMerge(roundStoreTestLayer(NodePath.join(root, ".test-state"))),
        Layer.provideMerge(admissionTestLayer),
      );
      return yield* Effect.gen(function* () {
        const game = yield* GameService.GameService;
        return yield* run({ root, game, entered, measured });
      }).pipe(Effect.provide(services));
    }),
  );

it.effect("measures a tone's peak and mean without a verdict", () =>
  withFixture("tone", (fixture) =>
    Effect.gen(function* () {
      const result = yield* fixture.game.audioInspect(threadId, {
        path: "godot/assets/audio/tone.wav",
      });
      expect(result.path).toBe("godot/assets/audio/tone.wav");
      expect(result.source.kind).toBe("asset");
      expect(result.metrics.codec).toBe("pcm_s16le");
      expect(result.metrics.channels).toBe(2);
      expect(result.metrics.peakDb).toBeCloseTo(-9.1, 0);
      expect(result.metrics.meanDb).toBeCloseTo(-12.1, 0);
      expect(result.metrics.nearClippingSamples).toBe(0);
      expect(result.metrics.phaseCancelled).toBe(false);
      expect(result.warnings.join(" ")).toContain("exported Web build is unassessed");
      expect(result.message).not.toMatch(/good|bad|quality verdict/i);
    }),
  ),
);

it.effect("reads silence as silence with its duration", () =>
  withFixture("silence", (fixture) =>
    Effect.gen(function* () {
      const result = yield* fixture.game.audioInspect(threadId, {
        path: "godot/assets/audio/silence.wav",
      });
      expect(result.metrics.meanDb).toBe(-91);
      expect(result.metrics.silenceSeconds).toBe(1);
      expect(result.metrics.phaseCancelled).toBe(false);
    }),
  ),
);

it.effect("counts 0 dBFS samples on a clipped signal", () =>
  withFixture("clipping", (fixture) =>
    Effect.gen(function* () {
      const result = yield* fixture.game.audioInspect(threadId, {
        path: "godot/assets/audio/clipping.wav",
      });
      expect(result.metrics.peakDb).toBe(0);
      expect(result.metrics.nearClippingSamples).toBe(70_000);
      expect(result.warnings.join(" ")).toContain("near clipping");
    }),
  ),
);

it.effect("reads opposite-phase collapse as cancellation, not silence", () =>
  withFixture("cancelled", (fixture) =>
    Effect.gen(function* () {
      const result = yield* fixture.game.audioInspect(threadId, {
        path: "godot/assets/audio/cancelled.wav",
      });
      expect(result.metrics.phaseCancelled).toBe(true);
      expect(result.warnings.join(" ")).toContain("cancellation");
    }),
  ),
);

it.effect("clamps an overlong stream to the duration bound before decode", () =>
  withFixture("long", (fixture) =>
    Effect.gen(function* () {
      const result = yield* fixture.game.audioInspect(threadId, {
        path: "godot/assets/audio/tone.wav",
      });
      expect(result.metrics.durationSeconds).toBe(200);
      expect(result.warnings.join(" ")).toContain("unassessed");
      // The bound travels with the command: FFmpeg decodes at most 120 s.
      const args = yield* Deferred.await(fixture.measured);
      const at = args.indexOf("-t");
      expect(at).toBeGreaterThan(-1);
      expect(args[at + 1]).toBe("120");
    }),
  ),
);

it.effect("refuses oversize files before any decode", () =>
  withFixture("tone", (fixture) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(fixture.root, "godot/assets/audio/big.wav"),
          Buffer.alloc(21 * 1024 * 1024),
        ),
      );
      const error = yield* fixture.game
        .audioInspect(threadId, { path: "godot/assets/audio/big.wav" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("invalid-input");
      expect(error.detail ?? "").toContain("bound");
    }),
  ),
);

it.effect("refuses traversal and symlinks escaping the game", () =>
  withFixture("tone", (fixture) =>
    Effect.gen(function* () {
      const traversal = yield* fixture.game
        .audioInspect(threadId, { path: "../escape.wav" })
        .pipe(Effect.flip);
      expect(traversal.reason).toBe("invalid-path");
      const outside = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "audio-evil-")),
      );
      try {
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(outside, "evil.wav"), "RIFF-fake"),
        );
        yield* Effect.promise(() =>
          NodeFSP.symlink(
            NodePath.join(outside, "evil.wav"),
            NodePath.join(fixture.root, "godot/assets/audio/link.wav"),
          ),
        );
        const escaped = yield* fixture.game
          .audioInspect(threadId, { path: "godot/assets/audio/link.wav" })
          .pipe(Effect.flip);
        expect(escaped.reason).toBe("invalid-path");
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(outside, { recursive: true, force: true }));
      }
    }),
  ),
);

it.effect("binds native clips to their capture source, assets to the game tree", () =>
  withFixture("tone", (fixture) =>
    Effect.gen(function* () {
      const clip = yield* fixture.game.audioInspect(threadId, {
        path: "builds/native-capture/take-1/clip.mp4",
      });
      expect(clip.source.kind).toBe("native-clip");
      expect(clip.source.sourceId).toBe("clip-source-1");
      expect(clip.warnings.join(" ")).toContain("engine mixer");
      const asset = yield* fixture.game.audioInspect(threadId, {
        path: "godot/assets/audio/tone.wav",
      });
      expect(asset.source.kind).toBe("asset");
      expect(asset.source.sourceId).not.toBe("clip-source-1");
    }),
  ),
);

it.effect("a missing tool is an actionable error, not a silent unknown", () =>
  withFixture("tone", (fixture) =>
    Effect.gen(function* () {
      vi.stubEnv("PATH", NodePath.join(fixture.root, "empty-bin"));
      const error = yield* fixture.game
        .audioInspect(threadId, { path: "godot/assets/audio/tone.wav" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("tool-missing");
      expect(error.detail ?? "").toContain("Audio quality stays unknown");
    }),
  ),
);

it.effect("a failed measurement reports the log, not numbers", () =>
  withFixture("measure-fails", (fixture) =>
    Effect.gen(function* () {
      const error = yield* fixture.game
        .audioInspect(threadId, { path: "godot/assets/audio/tone.wav" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("command-failed");
    }),
  ),
);

it.effect("cancelling the caller stops the measurement", () =>
  withFixture("hang", (fixture) =>
    Effect.gen(function* () {
      const fiber = yield* fixture.game
        .audioInspect(threadId, { path: "godot/assets/audio/tone.wav" })
        .pipe(Effect.forkDetach);
      yield* Deferred.await(fixture.entered);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(exit._tag).not.toBe("Success");
    }),
  ),
);

it.effect("audio bytes and game sources changing during decode invalidate their binding", () =>
  Effect.gen(function* () {
    for (const plan of ["source-change", "audio-change"] as const)
      yield* withFixture(plan, ({ game }) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(
            game.audioInspect(threadId, { path: "godot/assets/audio/tone.wav" }),
          );
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure.reason).toBe("command-failed");
        }),
      );
  }),
);
