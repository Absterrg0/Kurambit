// @effect-diagnostics nodeBuiltinImport:off -- Verified against the installed toolchain and the managed browser checkout.
import { it, expect } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type GameQualificationRead } from "@t3tools/contracts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameQualification from "./GameQualification.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GameWebPlaytest from "./GameWebPlaytest.ts";
import { snapshotSource } from "./sourceSnapshot.ts";
import { describeWebArtifacts } from "./webBuild.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  previewBrowserTestLayer,
  projectTestLayer,
  designApprovalTestLayer,
  qualificationTestLayer,
  visualJudgeTestLayer,
} from "./gameTestLayers.ts";

const workspaceRoot = (() => {
  let directory = process.cwd();
  for (
    let hops = 0;
    hops < 5 && !NodeFS.existsSync(NodePath.join(directory, "apps/server/package.json"));
    hops++
  ) {
    directory = NodePath.resolve(directory, "..");
  }
  return directory;
})();
const godotExecutable = NodePath.join(
  GameToolchain.toolsDirectory(),
  `godot-${GameToolchain.GODOT_VERSION}/Godot_v${GameToolchain.GODOT_VERSION}-stable_linux.x86_64`,
);
// Mirror PreviewBrowser's install layout (<baseDir>/tools/chrome-headless-shell/<platform>/<version>/…);
// the test picks whatever release is installed on this machine rather than re-decoding the release catalog.
const browserExecutable = (() => {
  const installRoot = NodePath.join(
    NodePath.join(workspaceRoot, ".t3"),
    "tools",
    "chrome-headless-shell",
  );
  if (!NodeFS.existsSync(installRoot)) return null;
  for (const platform of NodeFS.readdirSync(installRoot)) {
    const platformPath = NodePath.join(installRoot, platform);
    for (const version of NodeFS.readdirSync(platformPath)) {
      for (const name of ["chrome-headless-shell", "chrome-headless-shell.exe"]) {
        const candidate = NodePath.join(platformPath, version, name);
        if (NodeFS.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
})();
const available = NodeFS.existsSync(godotExecutable) && browserExecutable !== null;
// GameService.webPlaytest exports only when the Web build is stale, so this
// test also needs matching web export templates on disk (any version subdir).
const templatesInstalled = (() => {
  const dataRoot = process.env.XDG_DATA_HOME ?? NodePath.join(NodeOS.homedir(), ".local/share");
  const roots = [
    NodePath.join(dataRoot, "godot/export_templates"),
    NodePath.join(
      GameToolchain.toolsDirectory(),
      `godot-${GameToolchain.GODOT_VERSION}`,
      "editor_data/export_templates",
    ),
  ];
  try {
    for (const root of roots) {
      if (!NodeFS.existsSync(root)) continue;
      for (const version of NodeFS.readdirSync(root))
        for (const name of ["web_nothreads_release.zip", "web_nothreads_debug.zip"])
          if (
            NodeFS.existsSync(NodePath.join(root, version, version, name)) ||
            NodeFS.existsSync(NodePath.join(root, version, name))
          )
            return true;
    }
  } catch {
    // Unreadable template roots count as missing.
  }
  return false;
})();
const sourceProject = NodePath.join(workspaceRoot, ".t3", "e2e-games", "island-artifacts");
const sourceBuild = NodePath.join(sourceProject, "builds", "web");
const evidenceDirectory = "/home/abstergo/Programming/Projects/game-studio-orch/round7-evidence";

it.live.skipIf(!available)(
  "playtests the exported island web build in headless Chrome",
  () =>
    Effect.gen(function* () {
      const scratch = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-playtest-")),
      );
      try {
        const web = NodePath.join(scratch, "builds", "web");
        yield* Effect.promise(() => NodeFSP.cp(sourceBuild, web, { recursive: true }));
        const preview = yield* GamePreview.GamePreview;
        const url = yield* Effect.acquireRelease(preview.open(scratch), () =>
          preview.stop(scratch),
        );
        const result = yield* GameWebPlaytest.playtest({
          executable: browserExecutable!,
          url,
          profileDirectory: NodePath.join(scratch, "browser-profile"),
          width: 1280,
          height: 720,
          bootTimeoutMs: 30_000,
          steps: [{ key: "ArrowUp", holdMs: 1500 }],
          // This fixture predates the probe, so nothing here qualifies it.
          probeRequired: false,
          acceptance: null,
        });
        yield* Effect.log(result.message);
        yield* Effect.log(
          `${result.booted}, bootMs ${String(result.bootMs)}, console ${result.consoleMessages.length}`,
        );
        expect(result.booted).toBe(true);
        expect(result.bootMs).not.toBeNull();
        expect(result.screenshots.map((shot) => shot.label)).toEqual(["booted", "after-steps"]);
        expect(result.screenshots.every((shot) => shot.width > 0 && shot.height > 0)).toBe(true);
        yield* Effect.promise(() => NodeFSP.mkdir(evidenceDirectory, { recursive: true }));
        for (const shot of result.screenshots) {
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(evidenceDirectory, `task7b-${shot.label}.png`),
              Buffer.from(shot.data, "base64"),
            ),
          );
        }
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(scratch, { recursive: true, force: true }));
      }
    }).pipe(Effect.provide(GamePreview.layer)),
  180_000,
);

it.live.skipIf(!available || !templatesInstalled)(
  "GameService.webPlaytest boots the fixture game and reuses a fresh build",
  () =>
    Effect.gen(function* () {
      const parent = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-webplaytest-")),
      );
      // The fixture ships a prebuilt web export. Record the export identity the
      // way GameService does after a real export, so the playtest reuses it
      // instead of paying for an export the test does not need.
      const stateDir = NodePath.join(parent, "state");
      const root = NodePath.join(parent, "fixture");
      yield* Effect.promise(() =>
        NodeFSP.cp(sourceProject, root, {
          recursive: true,
          preserveTimestamps: true,
        }),
      );
      const dependencies = GameService.layer.pipe(
        Layer.provideMerge(GameProjectService.layer),
        Layer.provideMerge(GameOperations.layer),
        Layer.provideMerge(GameToolchain.layer),
        Layer.provideMerge(GamePreview.layer),
        Layer.provideMerge(GameProcesses.layer),
        Layer.provide(projectTestLayer()),
        Layer.provide(previewBrowserTestLayer(browserExecutable!)),
        Layer.provideMerge(qualificationTestLayer(stateDir)),
        Layer.provideMerge(visualJudgeTestLayer(stateDir)),
        Layer.provideMerge(designApprovalTestLayer(stateDir)),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(NodeServices.layer),
      );
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const projects = yield* GameProjectService.GameProjectService;
            const game = yield* GameService.GameService;
            const registered = yield* projects.open({
              path: root,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6.1-sol",
              },
            });
            const index = NodePath.join(root, "builds/web/index.html");
            const builtBefore = (yield* Effect.promise(() => NodeFSP.stat(index))).mtimeMs;
            const qualification = yield* GameQualification.GameQualification;
            const snapshot = yield* Effect.promise(() => snapshotSource(root, "godot"));
            if (snapshot.kind !== "known") throw new Error("Fixture sources should be known");
            yield* qualification.record(root, {
              stage: "export",
              outcome: "passed",
              sourceId: snapshot.sourceId,
              buildId: `${snapshot.sourceId}:fixture`,
              evidenceDirectory: null,
              // The fixture build is the artifact the playtest must reuse; the
              // record has to name its files or the read correctly calls it stale.
              artifacts: (yield* Effect.promise(() => describeWebArtifacts(root)))!,
            });
            const result = yield* game.webPlaytest(registered.threadId, {
              steps: [{ key: "ArrowUp", holdMs: 1000 }],
            });
            yield* Effect.log(result.message);
            expect(result.booted).toBe(true);
            expect(result.bootMs).not.toBeNull();
            expect(result.success).toBe(true);
            // The fixture predates StudioProbe: keep the pixel rule and say so.
            expect(result.state).toBeNull();
            expect(result.message).toContain("no state probe");
            expect(result.screenshots.map((shot) => shot.label)).toEqual(["booted", "after-steps"]);
            // Evidence is persisted and the status exposes the newest run.
            const status = yield* game.status(registered.threadId);
            expect(status.lastPlaytest).toMatchObject({
              success: true,
              responded: true,
              consoleErrorCount: 0,
              stale: false,
            });
            expect(status.lastPlaytest?.frames).toHaveLength(2);
            const evidence = NodePath.join(root, status.lastPlaytest!.directory);
            const stored = JSON.parse(
              yield* Effect.promise(() =>
                NodeFSP.readFile(NodePath.join(evidence, "result.json"), "utf8"),
              ),
            );
            expect(stored.steps).toEqual([{ key: "ArrowUp", holdMs: 1000 }]);
            expect(stored.responded).toBe(true);
            for (const frame of status.lastPlaytest?.frames ?? [])
              expect(
                yield* Effect.promise(() => NodeFSP.stat(NodePath.join(root, frame.path))),
              ).toBeDefined();
            // The stale branch must not have re-exported behind the test's back.
            expect((yield* Effect.promise(() => NodeFSP.stat(index))).mtimeMs).toBe(builtBefore);
            // The browser profile is scratch and cleaned up with the run.
            const logs = yield* Effect.promise(() =>
              NodeFSP.readdir(NodePath.join(root, "builds/logs")),
            );
            expect(logs.some((entry) => entry.startsWith("playtest-"))).toBe(false);
          }).pipe(Effect.provide(dependencies)),
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
      }
    }),
  240_000,
);

it.live.skipIf(!available || !templatesInstalled)(
  "reads the template's state probe and qualifies only a run that really played",
  () =>
    Effect.gen(function* () {
      const parent = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-probe-playtest-")),
      );
      const stateDir = NodePath.join(parent, "state");
      const dependencies = GameService.layer.pipe(
        Layer.provideMerge(GameProjectService.layer),
        Layer.provideMerge(GameOperations.layer),
        Layer.provideMerge(GameToolchain.layer),
        Layer.provideMerge(GamePreview.layer),
        Layer.provideMerge(GameProcesses.layer),
        Layer.provide(projectTestLayer()),
        Layer.provide(previewBrowserTestLayer(browserExecutable!)),
        Layer.provideMerge(qualificationTestLayer(stateDir)),
        Layer.provideMerge(visualJudgeTestLayer(stateDir)),
        Layer.provideMerge(designApprovalTestLayer(stateDir)),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(NodeServices.layer),
      );
      const playtestStage = (status: { qualification: GameQualificationRead }) =>
        status.qualification.stages.find((stage) => stage.stage === "playtest")?.status;
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const projects = yield* GameProjectService.GameProjectService;
            const game = yield* GameService.GameService;
            const created = yield* projects.create({
              name: "Probe Runner",
              parentDirectory: parent,
              template: "3d-explorer",
              brief: "Collect the relics.",
              // The probe belongs to the build bar, not the design phase.
              planFirst: false,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6.1-sol",
              },
            });
            const exported = yield* game.export(created.threadId, "Web");
            expect(exported.success, exported.message).toBe(true);

            // Open the game from its menu and stand still. The click and Enter
            // seat a body, so the gameplay baseline has a player; what fails is
            // everything else: no movement, and the only baseline-relative
            // change is the run clock — the ride a stopped clock would show.
            const still = yield* game.webPlaytest(created.threadId, {
              steps: [
                { click: "left" },
                { waitMs: 600 },
                { key: "Enter", holdMs: 80 },
                { waitMs: 2500 },
              ],
            });
            yield* Effect.log(still.message);
            expect(still.booted, still.message).toBe(true);
            expect(still.state, still.message).not.toBeNull();
            // The gameplay baseline: a probe taken after input with a body present.
            expect(still.state?.before?.player, still.message).not.toBeNull();
            expect(still.state?.after?.gameState.state).toBe(1);
            expect(still.state?.playerMoved ?? 0).toBeLessThan(1);
            expect(still.state?.changes.every((change) => change.key === "run_seconds")).toBe(true);
            expect(still.qualifies).toBe(false);
            expect(still.blockers).toContain("the player did not move from the gameplay baseline");
            expect(still.blockers).toContain(
              "no GameState value changed on a ride a stopped clock would not show",
            );
            const stillStatus = yield* game.status(created.threadId);
            expect(playtestStage(stillStatus)).toBe("failed");
            // The run is fresh for the current build; it simply did not qualify,
            // so it must not also be labelled stale on the Builds tab.
            expect(stillStatus.lastPlaytest?.qualifies).toBe(false);
            expect(stillStatus.lastPlaytest?.stale).toBe(false);

            // Walking forward moves the body and jumping turns the named jumps
            // counter the way a clock never turns: the same export now qualifies.
            // The walk lasts 1.8s and a slow swiftshader frame run measured
            // ~1.84 units over 1.2s, so the hold keeps the moved distance far
            // above the 2-unit line the assertions below read.
            const played = yield* game.webPlaytest(created.threadId, {
              steps: [
                { click: "left" },
                { waitMs: 600 },
                { key: "Enter", holdMs: 80 },
                { waitMs: 2500 },
                { key: "w", holdMs: 1800 },
                { key: " ", holdMs: 80 },
                { waitMs: 300 },
              ],
            });
            yield* Effect.log(played.message);
            expect(played.success, played.message).toBe(true);
            expect(played.qualifies, played.message).toBe(true);
            expect(played.blockers).toEqual([]);
            expect(played.state?.playerMoved ?? 0).toBeGreaterThan(2);
            expect(played.message).toContain("jumps 0→1");
            expect(played.message).toContain("player moved");
            expect(played.message).not.toContain("Qualification:");
            // The template's probe answers the stage's pause bridge.
            expect(still.pauseConfirmed, still.message).toBe(true);
            expect(played.pauseConfirmed, played.message).toBe(true);
            const status = yield* game.status(created.threadId);
            expect(playtestStage(status)).toBe("passed");
            expect(status.lastPlaytest?.responded).toBe(true);
            expect(status.lastPlaytest?.qualifies).toBe(true);
            expect(status.lastPlaytest?.blockers).toEqual([]);
            // The evidence keeps the probe snapshot the verdict was made from.
            const evidence = JSON.parse(
              yield* Effect.promise(() =>
                NodeFSP.readFile(
                  NodePath.join(created.root, status.lastPlaytest!.directory, "result.json"),
                  "utf8",
                ),
              ),
            );
            expect(evidence.state.before.player).not.toBeNull();
            expect(evidence.state.after.gameState.state).toBe(1);
            expect(evidence.state.playerMoved).toBeGreaterThan(2);
            expect(
              evidence.state.changes.some((change: { key: string }) => change.key === "jumps"),
            ).toBe(true);
            // Each screenshot also carries the probe read nearest it, the
            // per-frame state the cover picker reads back from this same file.
            expect(
              evidence.frames.some(
                (frame: { probe?: { gameState?: { jumps?: number } } | null }) =>
                  typeof frame.probe?.gameState?.jumps === "number",
              ),
            ).toBe(true);
          }).pipe(Effect.provide(dependencies)),
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
      }
    }),
  600_000,
);
