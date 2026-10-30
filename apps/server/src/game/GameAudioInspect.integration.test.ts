// @effect-diagnostics nodeBuiltinImport:off -- Root-only media validation uses real FFmpeg and private files.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type GameAudioInspectResult } from "@t3tools/contracts";
import * as GameService from "./GameService.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameToolchain from "./GameToolchain.ts";
import { findExecutable } from "./gameNativeCapture.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  admissionTestLayer,
  previewBrowserTestLayer,
  projectTestLayer,
  designApprovalTestLayer,
  qualificationTestLayer,
  roundStoreTestLayer,
} from "./gameTestLayers.ts";

const onPath = (name: string) =>
  (process.env.PATH ?? "")
    .split(NodePath.delimiter)
    .some((dir) => NodeFS.existsSync(NodePath.join(dir, name)));
const enabled = process.env.GAME_STUDIO_AUDIO_LIVE === "1" && onPath("ffmpeg") && onPath("ffprobe");

it.live.skipIf(!enabled)(
  "measures actual tone, silence, clipping, mono, and opposite-phase signals through the service",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const base = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "audio-live-"))),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const state = NodePath.join(base, "state");
        const dependencies = GameService.layer.pipe(
          Layer.provideMerge(GameProjectService.layer),
          Layer.provideMerge(GameOperations.layer),
          Layer.provideMerge(GameToolchain.layer),
          Layer.provideMerge(GamePreview.layer),
          Layer.provideMerge(GameProcesses.layer),
          Layer.provide(projectTestLayer()),
          Layer.provide(previewBrowserTestLayer()),
          Layer.provideMerge(qualificationTestLayer(state)),
          Layer.provideMerge(designApprovalTestLayer(state)),
          Layer.provideMerge(roundStoreTestLayer(state)),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provideMerge(admissionTestLayer),
          Layer.provide(NodeServices.layer),
        );
        yield* Effect.gen(function* () {
          const projects = yield* GameProjectService.GameProjectService;
          const game = yield* GameService.GameService;
          const processes = yield* GameProcesses.GameProcesses;
          const created = yield* projects.create({
            name: "Audio measurements",
            parentDirectory: base,
            template: "blank",
            planFirst: false,
            brief: "Disposable audio measurements",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
          });
          const root = created.root;
          const ffmpeg = yield* Effect.promise(() =>
            findExecutable("ffmpeg", { pathEnv: process.env.PATH }),
          );
          if (ffmpeg === null) throw new Error("Expected FFmpeg");
          const directory = NodePath.join(root, "godot/assets/audio");
          yield* Effect.promise(() => NodeFSP.mkdir(directory, { recursive: true }));
          const specifications = [
            { name: "tone", signal: "sine=frequency=440:duration=2", channels: 2, filters: [] },
            { name: "silence", signal: "anullsrc=r=44100:cl=stereo:d=2", channels: 2, filters: [] },
            {
              name: "clipping",
              signal: "sine=frequency=440:duration=2,volume=40dB",
              channels: 2,
              filters: [],
            },
            {
              name: "cancelled",
              signal: "sine=frequency=440:duration=2",
              channels: 2,
              filters: ["-af", "pan=stereo|c0=c0|c1=-1*c0"],
            },
            { name: "mono", signal: "sine=frequency=440:duration=2", channels: 1, filters: [] },
          ];
          const results: Record<string, GameAudioInspectResult> = {};
          for (const spec of specifications) {
            const relative = "godot/assets/audio/" + spec.name + ".wav";
            const generated = yield* processes.run({
              root,
              executable: ffmpeg,
              args: [
                "-nostdin",
                "-y",
                "-threads",
                "1",
                "-filter_threads",
                "1",
                "-f",
                "lavfi",
                "-i",
                spec.signal,
                ...spec.filters,
                "-ac",
                String(spec.channels),
                "-ar",
                "44100",
                NodePath.join(root, relative),
              ],
              operation: "audio-fixture",
              timeoutMs: 30000,
            });
            expect(generated.exitCode, generated.stderr).toBe(0);
            const measured = yield* game.audioInspect(created.threadId, { path: relative });
            results[spec.name] = measured;
            expect(measured.source.fileSha256).toMatch(/^[a-f0-9]{64}$/);
            expect(measured.metrics.channels).toBe(spec.channels);
            expect(measured.metrics.measuredSeconds).toBe(2);
            expect(measured.reportPath).toBeDefined();
            const report = JSON.parse(
              yield* Effect.promise(() =>
                NodeFSP.readFile(NodePath.join(root, measured.reportPath!), "utf8"),
              ),
            );
            expect(report.metrics).toEqual(measured.metrics);
          }
          expect(results.tone!.metrics.peakDb).toBeGreaterThan(-30);
          expect(results.tone!.metrics.peakDb).toBeLessThan(-10);
          expect(results.tone!.metrics.nearClippingSamples).toBe(0);
          expect(results.tone!.metrics.silenceSeconds).toBe(0);
          expect(results.silence!.metrics.meanDb).toBeLessThan(-60);
          expect(results.silence!.metrics.silenceSeconds).toBeCloseTo(2, 2);
          expect(results.clipping!.metrics.peakDb).toBeCloseTo(0, 1);
          expect(results.clipping!.metrics.nearClippingSamples).toBeGreaterThan(0);
          expect(results.cancelled!.metrics.meanDb).toBeGreaterThan(-30);
          expect(results.cancelled!.metrics.phaseCancelled).toBe(true);
          expect(results.cancelled!.metrics.silenceSeconds).toBe(0);
          expect(results.mono!.metrics.phaseCancelled).toBe(false);
          const shortened = yield* game.audioInspect(created.threadId, {
            path: "godot/assets/audio/tone.wav",
            segmentSeconds: 0.5,
          });
          expect(shortened.metrics.durationSeconds).toBe(2);
          expect(shortened.metrics.measuredSeconds).toBe(0.5);
          const output = process.env.GAME_STUDIO_AUDIO_RESULTS;
          if (output !== undefined)
            yield* Effect.promise(() =>
              NodeFSP.writeFile(output, JSON.stringify({ results, shortened }, null, 2)),
            );
        }).pipe(Effect.provide(dependencies));
      }),
    ),
  120000,
);
