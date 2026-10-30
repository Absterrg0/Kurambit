// @effect-diagnostics nodeBuiltinImport:off -- Proves native capture wiring against a real game tree with mocked native executables.
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
import * as GameQualification from "./GameQualification.ts";
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

const threadId = ThreadId.make("native-capture-test");
const manifest: GameManifest = {
  schemaVersion: 1,
  name: "Native capture",
  brief: "",
  artDirection: "",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
};

const projectGodot = `[application]
config/name="Native capture"

[display]
window/size/viewport_width=960
window/size/viewport_height=540

[input]
move_right={
}
`;

const winRoute = { id: "win-run", steps: [{ press: "move_right" }] };
const longRoute = { id: "long-run", steps: [{ hold: ["move_right"], frames: 2000 }] };

type Plan = "success" | "transcode-fails" | "change-sources" | "hang" | "import-fails";

const probeStdout = JSON.stringify({
  streams: [
    {
      width: 960,
      height: 540,
      r_frame_rate: "30/1",
      avg_frame_rate: "30/1",
      nb_frames: "47",
      codec_name: "h264",
      duration: "1.566667",
    },
  ],
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
  readonly qualification: GameQualification.GameQualification["Service"];
  readonly started: Deferred.Deferred<void>;
}

const withFixture = <A, E>(
  plan: Plan,
  run: (fixture: Fixture) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "native-capture-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot/tests/scenarios"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(root, "builds/logs"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(root, "bin"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "godot/project.godot"), projectGodot);
        await NodeFSP.writeFile(
          NodePath.join(root, "godot/tests/scenarios/win-run.json"),
          JSON.stringify(winRoute),
        );
        await NodeFSP.writeFile(
          NodePath.join(root, "godot/tests/scenarios/long-run.json"),
          JSON.stringify(longRoute),
        );
        // Discovery probes executability, never execution: the mocked
        // processes below stand in for xvfb, Godot and FFmpeg.
        for (const tool of ["xvfb-run", "ffmpeg", "ffprobe"])
          await NodeFSP.writeFile(NodePath.join(root, "bin", tool), "#!/bin/sh\nexit 0\n", {
            mode: 0o755,
          });
      });
      // Every capture test resolves its display server and encoders here; the
      // missing-tool test narrows PATH to prove the actionable error.
      vi.stubEnv("PATH", NodePath.join(root, "bin"));
      const started = yield* Deferred.make<void>();
      const failureFor = (operation: string): GameProcessResult => ({
        ...resultFor(root),
        exitCode: 1,
        stderr: `${operation} failed`,
      });
      const processes = Layer.mock(GameProcesses.GameProcesses)({
        run: (input) =>
          Effect.gen(function* () {
            if (input.operation === "godot-import") {
              if (plan === "import-fails")
                return {
                  ...resultFor(root),
                  exitCode: 1,
                  stderr: "import failed",
                };
              return resultFor(root);
            }
            if (input.operation === "native-capture") {
              yield* Deferred.succeed(started, undefined);
              if (plan === "hang") return yield* Effect.never;
              if (plan === "change-sources")
                yield* Effect.promise(() =>
                  NodeFSP.writeFile(NodePath.join(root, "godot/touched.gd"), "extends Node\n"),
                );
              const resultPath = input.args[input.args.indexOf("--") + 2]!;
              yield* Effect.promise(() =>
                NodeFSP.writeFile(
                  resultPath,
                  JSON.stringify({
                    id: "win-run",
                    frames: 32,
                    physicsHz: 60,
                    playerMoved: true,
                    error: null,
                    timeline: [
                      {
                        step: 0,
                        phase: "before",
                        scenarioFrame: 30,
                        enginePhysicsFrame: 30,
                        renderFrame: 15,
                      },
                      {
                        step: 0,
                        phase: "after",
                        scenarioFrame: 32,
                        enginePhysicsFrame: 32,
                        renderFrame: 16,
                      },
                    ],
                  }),
                ),
              );
              return resultFor(root);
            }
            if (input.operation === "native-capture-transcode") {
              if (plan === "transcode-fails") return failureFor(input.operation);
              yield* Effect.promise(() =>
                NodeFSP.writeFile(input.args[input.args.length - 1]!, "fake-mp4"),
              );
              return resultFor(root);
            }
            if (input.operation === "native-capture-probe")
              return { ...resultFor(root), stdout: probeStdout };
            if (input.operation === "native-capture-poster") {
              yield* Effect.promise(() =>
                NodeFSP.writeFile(input.args[input.args.length - 1]!, "fake-png"),
              );
              return resultFor(root);
            }
            return yield* Effect.die(`Unexpected native capture operation ${input.operation}.`);
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
        const qualification = yield* GameQualification.GameQualification;
        return yield* run({ root, game, qualification, started });
      }).pipe(Effect.provide(services));
    }),
  );

const captureError = (fixture: Fixture, input: { readonly scenarioId: string }) =>
  fixture.game.nativeCapture(threadId, input).pipe(Effect.flip);

it.effect("refuses an unknown scenario without running a capture", () =>
  withFixture("success", (fixture) =>
    Effect.gen(function* () {
      const error = yield* captureError(fixture, { scenarioId: "nope" });
      expect(error.reason).toBe("invalid-input");
      expect(error.message).toContain("win-run");
    }),
  ),
);

it.effect("refuses an unknown scenario before the engine import runs", () =>
  withFixture("import-fails", (fixture) =>
    Effect.gen(function* () {
      // The import would fail, but the cheap route refusal still wins: the
      // unknown id never reaches an engine subprocess.
      const error = yield* captureError(fixture, { scenarioId: "nope" });
      expect(error.reason).toBe("invalid-input");
      expect(error.message).toContain("win-run");
    }),
  ),
);

it.effect("refuses an unsupported physics tick rate instead of relabelling units", () =>
  withFixture("success", (fixture) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(fixture.root, "godot/project.godot"),
          projectGodot.replace(
            "[input]",
            "[physics]\ncommon/physics_ticks_per_second=240\n\n[input]",
          ),
        ),
      );
      const error = yield* captureError(fixture, { scenarioId: "win-run" });
      expect(error.reason).toBe("invalid-input");
      expect(error.message).toContain("240 Hz");
      expect(
        yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(fixture.root, "builds"))),
      ).not.toContain("native-capture");
    }),
  ),
);

it.effect("refuses an overlong route instead of truncating it", () =>
  withFixture("success", (fixture) =>
    Effect.gen(function* () {
      const error = yield* captureError(fixture, { scenarioId: "long-run" });
      expect(error.reason).toBe("invalid-input");
      expect(error.message).toContain("at most 1800");
      expect(
        yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(fixture.root, "builds"))),
      ).not.toContain("native-capture");
    }),
  ),
);

it.effect("reports a missing display server as an actionable optional-feature error", () =>
  withFixture("success", (fixture) =>
    Effect.gen(function* () {
      vi.stubEnv("PATH", fixture.root);
      const error = yield* captureError(fixture, { scenarioId: "win-run" });
      expect(error.reason).toBe("tool-missing");
      expect(error.message).toContain("xvfb-run");
      expect(error.message).toContain("unaffected");
    }),
  ),
);

it.effect("records a bounded clip from actual measured metadata", () =>
  withFixture("success", (fixture) =>
    Effect.gen(function* () {
      const before = yield* fixture.qualification.read(fixture.root, "godot");
      const result = yield* fixture.game.nativeCapture(threadId, { scenarioId: "win-run" });
      expect(result.scenarioId).toBe("win-run");
      expect(result.sourceId).toMatch(/^[0-9a-f]{64}$/);
      expect(result.requestedFps).toBe(30);
      // Actual encode metadata comes from ffprobe, not the request.
      expect(result.actualWidth).toBe(960);
      expect(result.actualHeight).toBe(540);
      expect(result.actualFps).toBe(30);
      expect(result.movieFrames).toBe(47);
      expect(result.scenarioFrames).toBe(32);
      expect(result.timelineEntries).toBe(2);
      expect(result.playerMoved).toBe(true);
      const clip = NodePath.join(fixture.root, result.clipPath);
      const poster = NodePath.join(fixture.root, result.posterPath);
      const timeline = NodePath.join(fixture.root, result.timelinePath);
      expect(yield* Effect.promise(() => NodeFSP.stat(clip))).toBeDefined();
      expect(yield* Effect.promise(() => NodeFSP.stat(poster))).toBeDefined();
      expect(
        JSON.parse(yield* Effect.promise(() => NodeFSP.readFile(timeline, "utf8"))),
      ).toHaveLength(2);
      // The intermediate AVI is not evidence; the MP4 is.
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(fixture.root, result.evidenceDirectory)),
        ),
      ).not.toContain("playback.avi");
      // The clip keeps its recorded audio: quality is unassessed, never muted.
      expect(result.warnings.join("\n")).toContain("unassessed");
      expect(result.warnings.join("\n")).toContain("audio");
      expect(result.message).toContain("does not prove gameplay");
      // A diagnostic never writes a qualification record.
      expect(yield* fixture.qualification.read(fixture.root, "godot")).toEqual(before);
    }),
  ),
);

it.effect("removes evidence when the transcode fails", () =>
  withFixture("transcode-fails", (fixture) =>
    Effect.gen(function* () {
      const error = yield* captureError(fixture, { scenarioId: "win-run" });
      expect(error.reason).toBe("command-failed");
      expect(error.message).toContain("transcode");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(fixture.root, "builds/native-capture")).catch(() => []),
        ),
      ).toEqual([]);
    }),
  ),
);

it.effect("refuses changed sources instead of certifying them", () =>
  withFixture("change-sources", (fixture) =>
    Effect.gen(function* () {
      const error = yield* captureError(fixture, { scenarioId: "win-run" });
      expect(error.reason).toBe("command-failed");
      expect(error.message).toContain("changed");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(fixture.root, "builds/native-capture")).catch(() => []),
        ),
      ).toEqual([]);
    }),
  ),
);

it.effect("cleans up a cancelled capture", () =>
  withFixture("hang", (fixture) =>
    Effect.gen(function* () {
      const fiber = yield* fixture.game
        .nativeCapture(threadId, { scenarioId: "win-run" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(fixture.started);
      yield* Fiber.interrupt(fiber);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(fixture.root, "builds/native-capture")).catch(() => []),
        ),
      ).toEqual([]);
    }),
  ),
);
