// @effect-diagnostics nodeBuiltinImport:off -- Runs a real child process against a stub Godot executable and a temp qualification store.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ThreadId,
  type GameManifest,
  type GameQualificationRead,
  type GameWebPlaytestResult,
} from "@t3tools/contracts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameQualification from "./GameQualification.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GameWebPlaytest from "./GameWebPlaytest.ts";
import { designApprovalTestLayer, previewBrowserTestLayer } from "./gameTestLayers.ts";

const threadId = ThreadId.make("qualification-rules-test");
const manifest = (overrides: Partial<GameManifest> = {}): GameManifest => ({
  schemaVersion: 1,
  name: "Qualification probe",
  brief: "",
  artDirection: "",
  testSuite: "res://tests/smoke_test.gd",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
  ...overrides,
});
// A stand-in Godot: imports and scripts succeed, and a release export writes the
// four files the service insists on. Nothing here needs a real engine install.
const fakeGodot = `#!/bin/sh
for last do :; done
case "$*" in
  *--export-release*)
    out="$last"
    printf x > "$out"
    printf x > "\${out%.html}.wasm"
    printf x > "\${out%.html}.js"
    printf x > "\${out%.html}.pck"
    ;;
esac
exit 0
`;
const playtestResult = (input: {
  readonly success: boolean;
  readonly responded: boolean;
}): GameWebPlaytestResult => ({
  success: input.success,
  booted: true,
  bootMs: 25,
  responded: input.responded,
  changedPercent: input.responded ? 12 : 0,
  message: input.success ? "Playtest succeeded: fake run." : "Playtest failed: fake run.",
  consoleMessages: [],
  screenshots: [],
});
const withFixture = <A, E, R>(
  run: (input: { readonly root: string }) => Effect.Effect<A, E, R>,
  options: {
    readonly manifest?: GameManifest;
    readonly playtest?: typeof GameWebPlaytest.playtest;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-rules-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      const executable = NodePath.join(base, "godot");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot/scripts"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(root, "godot/tests"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "godot/project.godot"), "[application]\n");
        await NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "extends Node\n");
        await NodeFSP.writeFile(
          NodePath.join(root, "godot/tests/smoke_test.gd"),
          "extends SceneTree\n",
        );
        await NodeFSP.writeFile(NodePath.join(root, "godot/tests/other.gd"), "extends SceneTree\n");
        await NodeFSP.writeFile(executable, fakeGodot, { mode: 0o755 });
      });
      const current = options.manifest ?? manifest();
      const services = GameService.layerWithPlaytest(
        options.playtest ??
          (() => Effect.succeed(playtestResult({ success: true, responded: true }))),
      ).pipe(
        Layer.provideMerge(GameProcesses.layer),
        Layer.provide(
          Layer.mock(GameProjectService.GameProjectService)({
            resolve: () => Effect.succeed(root),
            read: () => Effect.succeed(current),
            inventory: () =>
              Effect.succeed({
                manifest: current,
                design: null,
                designPath: null,
                briefPath: null,
                assets: [],
                scenes: [],
                builds: [],
                viewport: { width: 1152, height: 648 },
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(GameToolchain.GameToolchain)({
            executable: () =>
              Effect.succeed({ path: executable, version: "4.7.2", templates: null }),
            status: Effect.succeed({
              toolsDirectory: base,
              installing: false,
              tools: [
                {
                  tool: "godot" as const,
                  path: executable,
                  version: "4.7.2",
                  ready: true,
                  verified: true,
                  message: "stub",
                },
              ],
            }),
          }),
        ),
        Layer.provide(
          Layer.mock(GamePreview.GamePreview)({
            open: () => Effect.succeed("http://127.0.0.1:9/game"),
            stop: () => Effect.void,
            url: () => null,
          }),
        ),
        Layer.provide(previewBrowserTestLayer(executable)),
        Layer.provideMerge(GameQualification.layer({ stateDir })),
        Layer.provideMerge(designApprovalTestLayer(stateDir)),
        Layer.provide(NodeServices.layer),
      );
      return yield* run({ root }).pipe(Effect.provide(services));
    }),
  );

const stageOf = (read: GameQualificationRead, stage: string) =>
  read.stages.find((entry) => entry.stage === stage);

it.live("a non-canonical test script runs but does not record the test stage", () =>
  withFixture(({ root }) =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const tested = yield* game.test(threadId, "tests/other.gd");
      expect(tested.success, tested.message).toBe(true);
      expect(tested.message).toContain("Only the canonical suite");
      expect(tested.message).toContain("res://tests/smoke_test.gd");
      const qualification = yield* GameQualification.GameQualification;
      const read = yield* qualification.read(root, "godot");
      expect(stageOf(read, "test")?.status).toBe("missing");
    }),
  ),
);

it.live("the canonical suite records the test stage", () =>
  withFixture(({ root }) =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const tested = yield* game.test(threadId, "tests/smoke_test.gd");
      expect(tested.success, tested.message).toBe(true);
      expect(tested.message).not.toContain("Only the canonical suite");
      const qualification = yield* GameQualification.GameQualification;
      const read = yield* qualification.read(root, "godot");
      expect(stageOf(read, "test")?.status).toBe("passed");
    }),
  ),
);

it.live("the manifest's suite is canonical instead of the default", () =>
  withFixture(
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const smoke = yield* game.test(threadId, "tests/smoke_test.gd");
        expect(smoke.success, smoke.message).toBe(true);
        expect(smoke.message).toContain("Only the canonical suite");
        const qualification = yield* GameQualification.GameQualification;
        const before = yield* qualification.read(root, "godot");
        expect(stageOf(before, "test")?.status).toBe("missing");
        const canonical = yield* game.test(threadId, "tests/other.gd");
        expect(canonical.message).not.toContain("Only the canonical suite");
        const after = yield* qualification.read(root, "godot");
        expect(stageOf(after, "test")?.status).toBe("passed");
      }),
    { manifest: manifest({ testSuite: "res://tests/other.gd" }) },
  ),
);

it.live("a playtest with no steps succeeds as a tool result but fails qualification", () =>
  withFixture(
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const playtest = yield* game.webPlaytest(threadId, { steps: [] });
        // The boot smoke result stays useful to the tool caller.
        expect(playtest.success, playtest.message).toBe(true);
        expect(playtest.message).toContain(
          "a qualifying playtest needs input steps and a visible response",
        );
        const qualification = yield* GameQualification.GameQualification;
        const read = yield* qualification.read(root, "godot");
        expect(stageOf(read, "export")?.status).toBe("passed");
        expect(stageOf(read, "playtest")?.status).toBe("failed");
      }),
    {
      playtest: () => Effect.succeed(playtestResult({ success: true, responded: false })),
    },
  ),
);

it.live("a scripted playtest that responded records a passed playtest", () =>
  withFixture(
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const playtest = yield* game.webPlaytest(threadId, { steps: [{ waitMs: 1 }] });
        expect(playtest.success, playtest.message).toBe(true);
        expect(playtest.message).not.toContain("a qualifying playtest needs input steps");
        const qualification = yield* GameQualification.GameQualification;
        const read = yield* qualification.read(root, "godot");
        expect(stageOf(read, "playtest")?.status).toBe("passed");
        expect(NodeFS.existsSync(NodePath.join(root, "builds/playtests"))).toBe(true);
      }),
    {
      playtest: () => Effect.succeed(playtestResult({ success: true, responded: true })),
    },
  ),
);
