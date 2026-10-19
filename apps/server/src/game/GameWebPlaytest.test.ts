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
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GameWebPlaytest from "./GameWebPlaytest.ts";
import * as ServerSettings from "../serverSettings.ts";
import { previewBrowserTestLayer, projectTestLayer } from "./gameTestLayers.ts";

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
      // preserveTimestamps keeps the fixture's godot/ sources older than its
      // builds/web, so the service reuses the export instead of re-exporting.
      const root = NodePath.join(parent, "fixture");
      yield* Effect.promise(() =>
        NodeFSP.cp(sourceProject, root, {
          recursive: true,
          preserveTimestamps: true,
        }),
      );
      const dependencies = GameService.layer.pipe(
        Layer.provideMerge(GameProjectService.layer),
        Layer.provideMerge(GameToolchain.layer),
        Layer.provideMerge(GamePreview.layer),
        Layer.provideMerge(GameProcesses.layer),
        Layer.provide(projectTestLayer()),
        Layer.provide(previewBrowserTestLayer(browserExecutable!)),
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
            const result = yield* game.webPlaytest(registered.threadId, {
              steps: [{ key: "ArrowUp", holdMs: 1000 }],
            });
            yield* Effect.log(result.message);
            expect(result.booted).toBe(true);
            expect(result.bootMs).not.toBeNull();
            expect(result.success).toBe(true);
            expect(result.screenshots.map((shot) => shot.label)).toEqual(["booted", "after-steps"]);
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
