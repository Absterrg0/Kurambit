// @effect-diagnostics nodeBuiltinImport:off -- Runs the real Godot toolchain, the loopback preview server and a headless browser against a game created from the real starter template.
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
// Mirrors PreviewBrowser's install layout; the test uses whatever release is already
// installed on this machine instead of re-reading the release catalog.
const browserExecutable = (() => {
  const installRoot = NodePath.join(workspaceRoot, ".t3", "tools", "chrome-headless-shell");
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
        for (const name of ["web_nothreads_release.zip", "linux_release.x86_64"])
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
const available =
  NodeFS.existsSync(godotExecutable) && browserExecutable !== null && templatesInstalled;
// Evidence the playtest frames are read from: the orchestrator inspects these files.
const evidenceDirectory = "/home/abstergo/Programming/Projects/game-studio-orch/t16-shots";

const readLog = (logPath: string | undefined) =>
  Effect.promise(() =>
    logPath === undefined ? Promise.resolve("") : NodeFSP.readFile(logPath, "utf8").catch(() => ""),
  );

it.live.skipIf(!available)(
  "takes a game created from the 3d-explorer template from a clean import to a playtested web build",
  () =>
    Effect.gen(function* () {
      const parent = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-studio-template-")),
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
            const created = yield* projects.create({
              name: "Relic Run",
              parentDirectory: parent,
              template: "3d-explorer",
              brief: "Explode into a courtyard of floating ruins and collect every relic.",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6.1-sol",
              },
            });
            expect((yield* projects.read(created.root)).template).toBe("3d-explorer");
            const threadId = created.threadId;

            // 1. Import: the template's own scenes and scripts must compile untouched.
            const imported = yield* game.import(threadId);
            expect(imported.success, imported.message).toBe(true);
            const importLog = yield* readLog(imported.process?.logPath);
            expect(importLog).not.toMatch(/SCRIPT ERROR|ERROR:|WARNING:|Parse Error/);

            // 2. The template's smoke test drives the real loop.
            const tested = yield* game.test(threadId, "tests/smoke_test.gd", 300_000);
            expect(tested.success, tested.message).toBe(true);
            expect(tested.process?.stdout).toContain("SMOKE PASS");
            const smokeLog = `${tested.process?.stdout ?? ""}\n${tested.process?.stderr ?? ""}`;
            expect(smokeLog).not.toMatch(/SCRIPT ERROR|ERROR:|Parse Error/);

            // 3. Both export targets, with real export templates.
            const web = yield* game.export(threadId, "Web");
            expect(web.success, web.message).toBe(true);
            const linux = yield* game.export(threadId, "Linux");
            expect(linux.success, linux.message).toBe(true);

            // 4. Play the real Web build: click the canvas, start the run from the menu,
            // walk forward, jump.
            const playtest = yield* game.webPlaytest(threadId, {
              width: 1280,
              height: 720,
              steps: [
                { click: "left" },
                { waitMs: 500 },
                { key: "Enter", holdMs: 80 },
                { waitMs: 3000 },
                { click: "left" },
                { waitMs: 300 },
                { key: "w", holdMs: 1200 },
                { waitMs: 200 },
                { key: "Space", holdMs: 100 },
                { waitMs: 900 },
              ],
            });
            expect(playtest.booted, playtest.message).toBe(true);
            expect(playtest.success, playtest.message).toBe(true);
            expect(playtest.screenshots.map((shot) => shot.label)).toEqual([
              "booted",
              "after-steps",
            ]);

            yield* Effect.promise(() => NodeFSP.mkdir(evidenceDirectory, { recursive: true }));
            for (const shot of playtest.screenshots) {
              yield* Effect.promise(() =>
                NodeFSP.writeFile(
                  NodePath.join(evidenceDirectory, `3d-explorer-${shot.label}.png`),
                  Buffer.from(shot.data, "base64"),
                ),
              );
            }
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(evidenceDirectory, "3d-explorer-playtest.json"),
                JSON.stringify(
                  {
                    game: created.root,
                    message: playtest.message,
                    bootMs: playtest.bootMs,
                    console: playtest.consoleMessages,
                  },
                  null,
                  2,
                ),
              ),
            );
            yield* Effect.log(playtest.message);
            yield* Effect.log(
              `import exit ${String(imported.process?.exitCode)}, ` +
                `smoke exit ${String(tested.process?.exitCode)}, ` +
                `web ${String(web.path)}, linux ${String(linux.path)}, ` +
                `console messages ${String(playtest.consoleMessages.length)}`,
            );
          }).pipe(Effect.provide(dependencies)),
        );
      } finally {
        if (process.env.GAME_STUDIO_KEEP_TEST !== "1")
          yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
      }
    }),
  900_000,
);
