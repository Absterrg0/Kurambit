// @effect-diagnostics nodeBuiltinImport:off -- Verified against the installed toolchain and the managed browser checkout.
import { it, expect } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as GameService from "./GameService.ts";
import * as GameWebPlaytest from "./GameWebPlaytest.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  admissionTestLayer,
  previewBrowserTestLayer,
  projectTestLayer,
  designApprovalTestLayer,
  roundStoreTestLayer,
  qualificationTestLayer,
} from "./gameTestLayers.ts";
import { hashWebBuild } from "./webBuild.ts";

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
const available = NodeFS.existsSync(godotExecutable) && browserExecutable !== null;

// A minimal interactive page with the same contract the driver needs: a real
// canvas, a requestAnimationFrame loop, input that repaints, console boot
// evidence, the visibility-ack bridge and a read-only probe.
const fixtureHtml = `<!doctype html><canvas width="640" height="360" tabindex="0"></canvas><script>
const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
let count = 0, x = 0;
function paint() {
  ctx.fillStyle = count > 0 ? '#ffffff' : '#000000';
  ctx.fillRect(0, 0, 640, 360);
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(x, 180, 20, 20);
}
paint();
function tick() { requestAnimationFrame(tick); }
requestAnimationFrame(tick);
addEventListener('keydown', () => { count++; x += 5; paint(); for(let i=0;i<60;i++) console.log('burst '+i); console.warn('late-observation-'+count); });
canvas.addEventListener('mousedown', () => { count++; x += 5; paint(); });
addEventListener('message', event => {
  if (event.data?.type !== 'studio-visibility') return;
  const visible = event.data.visible === true;
  window.__studioVisibilityAck = { visible, paused: !visible, muted: !visible };
});
window.__studioProbe = () => JSON.stringify({ gameState: { count }, player: { x, y: 0, z: 0 } });
console.log('Godot Engine v4 fixture');
</script>`;

const serviceLayers = (stateDir: string) =>
  GameService.layer.pipe(
    Layer.provideMerge(GameProjectService.layer),
    Layer.provideMerge(GameOperations.layer),
    Layer.provideMerge(GameToolchain.layer),
    Layer.provideMerge(GamePreview.layer),
    Layer.provideMerge(GameProcesses.layer),
    Layer.provide(projectTestLayer()),
    Layer.provide(previewBrowserTestLayer(browserExecutable!)),
    Layer.provideMerge(qualificationTestLayer(stateDir)),
    Layer.provideMerge(designApprovalTestLayer(stateDir)),
    Layer.provideMerge(roundStoreTestLayer(stateDir)),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provideMerge(admissionTestLayer),
    Layer.provide(NodeServices.layer),
  );

it.live.skipIf(browserExecutable === null)(
  "explores a minimal interactive fixture and replays it fresh",
  () =>
    Effect.gen(function* () {
      const parent = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-explore-fixture-")),
      );
      const stateDir = NodePath.join(parent, "state");
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const projects = yield* GameProjectService.GameProjectService;
            const rounds = yield* GameRoundStore.GameRoundStore;
            const game = yield* GameService.GameService;
            const created = yield* projects.create({
              name: "Explore Fixture",
              parentDirectory: parent,
              template: "blank",
              brief: "Probe the fixture.",
              planFirst: false,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6.1-sol",
              },
            });
            // A build-addressed fixture export: real bytes on disk plus a real
            // source binding, so the session verifies exactly what it plays.
            const staging = NodePath.join(created.root, "builds/candidates", "0".repeat(64));
            yield* Effect.promise(async () => {
              await NodeFSP.mkdir(staging, { recursive: true });
              await NodeFSP.writeFile(NodePath.join(staging, "index.html"), fixtureHtml);
            });
            const hashed = yield* Effect.promise(() =>
              hashWebBuild(created.root, `builds/candidates/${"0".repeat(64)}`),
            );
            if (hashed === null) throw new Error("Fixture build should hash");
            const frozen = yield* rounds.freeze(created.root);
            yield* rounds.recordExport(created.root, {
              buildId: hashed.buildId,
              directory: NodePath.join("builds/candidates", hashed.buildId),
              sourceId: frozen.sourceId,
              engine: "godot",
              target: "Web",
              entry: "index.html",
            });
            yield* Effect.promise(() =>
              NodeFSP.rename(
                staging,
                NodePath.join(created.root, "builds/candidates", hashed.buildId),
              ),
            );
            const started = yield* game.exploreStart(created.threadId, { buildId: hashed.buildId });
            expect(started.booted).toBe(true);
            const acted = yield* game.exploreAct(created.threadId, {
              sessionId: started.sessionId,
              steps: [{ press: "Space" }, { waitMs: 200 }, { key: "ArrowRight", holdMs: 80 }],
            });
            expect(acted.executedInputSteps).toBe(2);
            expect(acted.nominalMs).toBe(330);
            expect(acted.probe?.gameState.count).toBe(2);
            const continued = yield* game.exploreAct(created.threadId, {
              sessionId: started.sessionId,
              steps: [{ press: "Space" }, { waitMs: 200 }],
            });
            expect(continued.probe?.gameState.count).toBe(3);
            expect(continued.totalNominalMs).toBe(580);
            expect(acted.consoleTruncated).toBeGreaterThan(0);
            expect(
              continued.consoleMessages.some((message) => message.text === "late-observation-3"),
            ).toBe(true);
            expect(continued.consoleTruncated).toBeGreaterThan(0);
            expect(continued.screenshotPath).not.toBe(acted.screenshotPath);
            const closed = yield* game.exploreClose(created.threadId, {
              sessionId: started.sessionId,
            });
            expect(closed.reason).toBe("closed");
            const replayed = yield* game.exploreReplay(created.threadId, {
              traceId: closed.traceId,
            });
            expect(replayed.buildId).toBe(hashed.buildId);
            expect(replayed.booted).toBe(true);
            expect(replayed.responded).toBe(true);
            expect(replayed.frames.length).toBeGreaterThan(0);
            for (const frame of replayed.frames)
              expect(frame.path.startsWith(replayed.evidenceDirectory)).toBe(true);
            // The fixture's probe answers through the fresh run, not the trace.
            expect(replayed.state?.before?.gameState.count).toBe(0);
            expect(replayed.state?.after).toEqual({
              gameState: { count: 3 },
              player: { x: 15, y: 0, z: 0 },
            });
            yield* Effect.promise(() =>
              NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
            );
            yield* Effect.promise(() =>
              NodeFSP.rm(replayed.evidenceDirectory, { recursive: true, force: true }),
            );
          }).pipe(Effect.provide(serviceLayers(stateDir))),
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
      }
    }),
  240_000,
);

it.live.skipIf(!available || !templatesInstalled)(
  "explores an actual exported Godot starter and replays it",
  () =>
    Effect.gen(function* () {
      const parent = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-explore-starter-")),
      );
      const stateDir = NodePath.join(parent, "state");
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const projects = yield* GameProjectService.GameProjectService;
            const game = yield* GameService.GameService;
            const created = yield* projects.create({
              name: "Explore Starter",
              parentDirectory: parent,
              template: "blank",
              brief: "Probe the starter.",
              planFirst: false,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6.1-sol",
              },
            });
            const exported = yield* game.export(created.threadId, "Web");
            expect(exported.success, exported.message).toBe(true);
            const started = yield* game.exploreStart(created.threadId, {});
            expect(started.booted, started.message).toBe(true);
            const acted = yield* game.exploreAct(created.threadId, {
              sessionId: started.sessionId,
              steps: [{ click: "left" }, { waitMs: 600 }],
            });
            expect(acted.executedInputSteps).toBe(1);
            // The starter owes its probe: the observation carries real state.
            expect(acted.probe).not.toBeNull();
            const closed = yield* game.exploreClose(created.threadId, {
              sessionId: started.sessionId,
            });
            const replayed = yield* game.exploreReplay(created.threadId, {
              traceId: closed.traceId,
            });
            expect(replayed.buildId).toBe(started.buildId);
            expect(replayed.booted, replayed.message).toBe(true);
            yield* Effect.log(replayed.message);
            yield* Effect.promise(() =>
              NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
            );
            yield* Effect.promise(() =>
              NodeFSP.rm(replayed.evidenceDirectory, { recursive: true, force: true }),
            );
          }).pipe(Effect.provide(serviceLayers(stateDir))),
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
      }
    }),
  600_000,
);

it.live.skipIf(browserExecutable === null)(
  "a real late console error fails after more than forty ordinary messages",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "late-console-live-")),
          ),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(root, "builds/web"), { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(root, "builds/web/index.html"),
            fixtureHtml.replace(
              "console.warn('late-observation-'+count)",
              "console.error('late-engine-failure')",
            ),
          );
        });
        const preview = yield* GamePreview.GamePreview;
        const url = yield* preview.open(root);
        const result = yield* GameWebPlaytest.playtest({
          executable: browserExecutable!,
          url,
          profileDirectory: NodePath.join(root, "profile"),
          width: 640,
          height: 360,
          bootTimeoutMs: 10000,
          steps: [{ press: "Space" }],
          probeRequired: true,
          acceptance: null,
        });
        expect(result.booted).toBe(true);
        expect(result.executedInputSteps).toBe(1);
        expect(result.consoleErrorCount).toBe(1);
        expect(result.consoleTruncated).toBeGreaterThan(0);
        expect(
          result.consoleMessages.some(
            (message) => message.text === "late-engine-failure" && message.level === "error",
          ),
        ).toBe(true);
        expect(result.success).toBe(false);
        expect(result.qualifies).toBe(false);
      }),
    ).pipe(Effect.provide(GamePreview.layer)),
  60000,
);
