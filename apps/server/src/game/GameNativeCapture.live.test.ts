// @effect-diagnostics nodeBuiltinImport:off -- Root-owned live validation: real Godot, Xvfb, FFmpeg and cancellation. NEVER run in a worker session.
// Opt in with GAME_STUDIO_NATIVE_CAPTURE_LIVE=1 on a quiet Linux host, one heavy
// operation at a time. The worker slice proves wiring with mocks; this file
// proves engines, pixels and group kill. See harness native-capture.md.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderInstanceId,
  type GameOperationError,
  type GameTemplateId,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import { readScenarioFiles } from "./gameScenarios.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  admissionTestLayer,
  previewBrowserTestLayer,
  projectTestLayer,
  designApprovalTestLayer,
  roundStoreTestLayer,
  qualificationTestLayer,
} from "./gameTestLayers.ts";

const godotExecutable = NodePath.join(
  GameToolchain.toolsDirectory(),
  `godot-${GameToolchain.GODOT_VERSION}/Godot_v${GameToolchain.GODOT_VERSION}-stable_linux.x86_64`,
);

const onPath = (name: string, overrideVar: string): boolean => {
  const override = process.env[overrideVar]?.trim();
  const candidates = [
    ...(override ? [override] : []),
    ...(process.env.PATH ?? "").split(NodePath.delimiter).map((dir) => NodePath.join(dir, name)),
  ];
  return candidates.some((candidate) => {
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
};

/** Root runs this; workers never do, even to check collection. */
const ready =
  process.env.GAME_STUDIO_NATIVE_CAPTURE_LIVE === "1" &&
  NodeFS.existsSync(godotExecutable) &&
  onPath("xvfb-run", "GAME_STUDIO_XVFB_RUN") &&
  onPath("ffmpeg", "GAME_STUDIO_FFMPEG") &&
  onPath("ffprobe", "GAME_STUDIO_FFPROBE");

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
};

const approve = (approvals: GameDesignApproval.GameDesignApproval["Service"], root: string) =>
  Effect.gen(function* () {
    const design = "# Live capture fixture\n\nA disposable acceptance fixture.\n";
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "DESIGN.md"), design));
    yield* approvals.write(root, {
      schemaVersion: 1,
      game: NodePath.resolve(root),
      approvalId: "live-capture-approval",
      designHash: GameDesignApproval.designDocumentHash(design),
      approvedAt: "2026-10-20T00:00:00.000Z",
      acceptance: [],
    });
  });

const withTemplateGame = <A, E>(
  template: GameTemplateId,
  run: (input: {
    readonly root: string;
    readonly game: GameService.GameService["Service"];
    readonly processes: GameProcesses.GameProcesses["Service"];
    readonly threadId: Parameters<GameService.GameService["Service"]["nativeCapture"]>[0];
  }) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E | GameOperationError | ServerSettingsError, never> =>
  Effect.gen(function* () {
    const parent = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "native-capture-live-")),
    );
    const designStateDir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "native-capture-live-design-")),
    );
    const layer = GameService.layer.pipe(
      Layer.provideMerge(GameProjectService.layer),
      Layer.provideMerge(GameOperations.layer),
      Layer.provideMerge(GameToolchain.layer),
      Layer.provideMerge(GamePreview.layer),
      Layer.provideMerge(GameProcesses.layer),
      Layer.provide(projectTestLayer()),
      Layer.provide(previewBrowserTestLayer()),
      Layer.provideMerge(qualificationTestLayer(NodePath.join(parent, ".test-state"))),
      Layer.provideMerge(designApprovalTestLayer(designStateDir)),
      Layer.provideMerge(roundStoreTestLayer(designStateDir)),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provideMerge(admissionTestLayer),
      Layer.provide(NodeServices.layer),
    );
    const cleanup = Effect.promise(() =>
      process.env.GAME_STUDIO_KEEP_TEST === "1"
        ? Promise.resolve()
        : Promise.all([
            NodeFSP.rm(parent, { recursive: true, force: true }),
            NodeFSP.rm(designStateDir, { recursive: true, force: true }),
          ]).then(() => undefined),
    ).pipe(Effect.orDie);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const approvals = yield* GameDesignApproval.GameDesignApproval;
        const created = yield* projects.create({
          name: `live capture ${template}`,
          parentDirectory: parent,
          template,
          brief: "A disposable live capture fixture.",
          planFirst: false,
          modelSelection,
        });
        yield* approve(approvals, created.root);
        const game = yield* GameService.GameService;
        const processes = yield* GameProcesses.GameProcesses;
        return yield* run({
          root: created.root,
          game,
          processes,
          threadId: created.threadId,
        });
      }),
    ).pipe(Effect.provide(layer), Effect.ensuring(cleanup));
  });

const writeCapturePrefix = (root: string) =>
  Effect.promise(async () => {
    const files = await readScenarioFiles(NodePath.join(root, "godot"));
    const source = files.scenarios.find((file) => file.scenario.id === "full-run");
    if (source === undefined) throw new Error("The template ships no full-run scenario.");
    // A separate, explicitly short route tests capture, never game completion.
    const prefix = { id: "capture-prefix", steps: source.scenario.steps.slice(0, 12) };
    await NodeFSP.writeFile(
      NodePath.join(root, "godot/tests/scenarios/capture-prefix.json"),
      JSON.stringify(prefix),
    );
    return prefix;
  });

const procStat = (pid: number) => {
  try {
    const text = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text
      .slice(text.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    return { state: fields[0], group: Number(fields[2]) };
  } catch {
    return null;
  }
};

it.live.skipIf(!ready)(
  "captures a bounded 2D diagnostic clip with actual measured metadata",
  () =>
    Effect.gen(function* () {
      yield* withTemplateGame("2d-platformer", ({ root, game, threadId }) =>
        Effect.gen(function* () {
          const scenario = yield* writeCapturePrefix(root);
          const capture = yield* game.nativeCapture(threadId, { scenarioId: scenario.id });
          expect(capture.scenarioFrames).toBeGreaterThan(0);
          expect(capture.movieFrames).toBeGreaterThan(0);
          expect(capture.actualWidth).toBeLessThanOrEqual(1280);
          expect(capture.actualHeight).toBeLessThanOrEqual(720);
          expect(capture.timelineEntries).toBe(scenario.steps.length * 2);
          for (const name of ["clip.mp4", "poster.png", "result.json", "timeline.json"])
            expect(
              NodeFS.existsSync(NodePath.join(root, capture.evidenceDirectory, name)),
              name,
            ).toBe(true);
          // The clip keeps its recorded audio: quality is unassessed, never muted.
          expect(capture.warnings.join("\n")).toContain("unassessed");
        }),
      );
    }),
  300_000,
);

it.live.skipIf(!ready)(
  "captures a bounded 3D diagnostic clip without claiming gameplay success",
  () =>
    Effect.gen(function* () {
      yield* withTemplateGame("3d-explorer", ({ root, game, threadId }) =>
        Effect.gen(function* () {
          const scenario = yield* writeCapturePrefix(root);
          const capture = yield* game.nativeCapture(threadId, { scenarioId: scenario.id });
          expect(capture.movieFrames).toBeGreaterThan(0);
          expect(capture.actualWidth).toBeLessThanOrEqual(1280);
          expect(capture.actualHeight).toBeLessThanOrEqual(720);
          expect(capture.message).toContain("does not prove gameplay");
          // Movement and counters are measurements a reviewer still has to judge.
          expect(typeof capture.playerMoved).toBe("boolean");
        }),
      );
    }),
  300_000,
);

it.live.skipIf(!ready)(
  "captures a bounded 60 fps clip with measured timing",
  () =>
    withTemplateGame("2d-platformer", ({ root, game, threadId }) =>
      Effect.gen(function* () {
        const scenario = yield* writeCapturePrefix(root);
        const capture = yield* game.nativeCapture(threadId, { scenarioId: scenario.id, fps: 60 });
        expect(capture.actualFps).toBe(60);
        expect(capture.physicsHz).toBe(60);
        expect(capture.movieFrames).toBeGreaterThan(0);
        expect(capture.movieFrames).toBeLessThanOrEqual(1000);
        expect(capture.timelineEntries).toBe(scenario.steps.length * 2);
      }),
    ),
  300_000,
);

it.live.skipIf(!ready)(
  "cancelling a capture kills the display server group and removes evidence",
  () =>
    Effect.gen(function* () {
      yield* withTemplateGame("2d-platformer", ({ root, game, processes, threadId }) =>
        Effect.gen(function* () {
          const signalPath = NodePath.join(root, "builds/capture-ready");
          yield* Effect.promise(async () => {
            const gameScript = NodePath.join(root, "godot/scripts/game.gd");
            const script = await NodeFSP.readFile(gameScript, "utf8");
            const ready = "func _ready() -> void:\n";
            if (!script.includes(ready)) throw new Error("The fixture has no game ready hook.");
            await NodeFSP.writeFile(
              gameScript,
              script.replace(
                ready,
                `${ready}\tFileAccess.open(${JSON.stringify(signalPath)}, FileAccess.WRITE).store_string("ready")\n`,
              ),
            );
            await NodeFSP.writeFile(
              NodePath.join(root, "godot/tests/scenarios/long-run.json"),
              JSON.stringify({
                id: "long-run",
                steps: [{ press: "ui_accept" }, { hold: ["move_right"], frames: 1500 }],
              }),
            );
          });
          // The disposable scene writes this signal only after Godot starts
          // gameplay. Evidence-directory creation alone would cancel before
          // any engine or display process existed.
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const nativeDir = NodePath.join(root, "builds/native-capture");
              yield* Effect.promise(() =>
                NodeFSP.mkdir(NodePath.join(root, "builds"), { recursive: true }),
              );
              const watcher = yield* Effect.acquireRelease(
                Effect.sync(() => NodeFS.watch(NodePath.join(root, "builds"))),
                (watch) => Effect.sync(() => watch.close()),
              );
              let ownedGroup = -1;
              const started = new Promise<void>((resolve, reject) => {
                // fs.watch reports file creation as a "change" event whose
                // eventType is "rename": listen for "change", not "rename".
                watcher.on("change", (_event, filename) => {
                  if (filename?.toString() !== "capture-ready") return;
                  const listed = processes
                    .list(root)
                    .find((entry) => entry.operation === "native-capture");
                  if (listed !== undefined) {
                    ownedGroup = listed.pid;
                    resolve();
                  }
                });
                watcher.on("error", reject);
              });
              const fiber = yield* game
                .nativeCapture(threadId, { scenarioId: "long-run" })
                .pipe(Effect.forkChild);
              yield* Effect.promise(() => started).pipe(Effect.timeout("60 seconds"));
              const members = NodeFS.readdirSync("/proc")
                .filter((name) => /^\d+$/.test(name))
                .map(Number)
                .filter((pid) => procStat(pid)?.group === ownedGroup);
              expect(members.length).toBeGreaterThanOrEqual(2);
              yield* Fiber.interrupt(fiber);
              expect(processes.list(root)).toEqual([]);
              for (const pid of members) {
                const remaining = procStat(pid);
                expect(
                  remaining === null || remaining.group !== ownedGroup || remaining.state === "Z",
                  `owned group member ${pid} is still running`,
                ).toBe(true);
              }
              // The evidence directory itself is removed; the parent
              // builds/native-capture may remain, so only its entries must be gone.
              const remaining = yield* Effect.promise(() =>
                NodeFSP.readdir(nativeDir).catch(() => [] as string[]),
              );
              expect(remaining).toEqual([]);
            }),
          );
        }),
      );
    }),
  300_000,
);
