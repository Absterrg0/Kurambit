// @effect-diagnostics nodeBuiltinImport:off -- Runs the real Godot toolchain, the loopback preview server and a headless browser against a game created from the real starter templates.
import { it, expect } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type GamePlaytestStep, type GameTemplateId } from "@t3tools/contracts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  previewBrowserTestLayer,
  projectTestLayer,
  designApprovalTestLayer,
  qualificationTestLayer,
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
// Evidence is per-test scratch space unless the caller asks to retain it at a
// stable destination for review.
const evidenceDirectoryFor = (parent: string, template: GameTemplateId) => {
  const retained = process.env.GAME_STUDIO_EVIDENCE_DIR?.trim();
  return retained ? NodePath.join(retained, template) : NodePath.join(parent, "evidence");
};

interface TemplateJourney {
  readonly template: GameTemplateId;
  readonly name: string;
  readonly brief: string;
  readonly steps: readonly GamePlaytestStep[];
  readonly expectedScreenshots: readonly string[];
  /** Optional second pass that ends on a menu, saved as `<template>-pause.png`. */
  readonly pauseSteps?: readonly GamePlaytestStep[];
}

const readLog = (logPath: string | undefined) =>
  Effect.promise(() =>
    logPath === undefined ? Promise.resolve("") : NodeFSP.readFile(logPath, "utf8").catch(() => ""),
  );

/**
 * Takes a game from a clean import through its smoke test, both export targets and a
 * real Web playtest, then writes the frames the orchestrator reviews as evidence.
 * One path for every starter template, so a new template inherits the same bar.
 */
const templateJourney = (journey: TemplateJourney) =>
  Effect.gen(function* () {
    const parent = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-studio-template-")),
    );
    const evidenceDirectory = evidenceDirectoryFor(parent, journey.template);
    // Created before the first write: a fresh evidence destination must work.
    yield* Effect.promise(() => NodeFSP.mkdir(evidenceDirectory, { recursive: true }));
    const dependencies = GameService.layer.pipe(
      Layer.provideMerge(GameProjectService.layer),
      Layer.provideMerge(GameOperations.layer),
      Layer.provideMerge(GameToolchain.layer),
      Layer.provideMerge(GamePreview.layer),
      Layer.provideMerge(GameProcesses.layer),
      Layer.provide(projectTestLayer()),
      Layer.provide(previewBrowserTestLayer(browserExecutable!)),
      Layer.provideMerge(qualificationTestLayer(NodePath.join(parent, ".test-state"))),
      Layer.provideMerge(designApprovalTestLayer(NodePath.join(parent, ".test-state"))),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(NodeServices.layer),
    );
    try {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const projects = yield* GameProjectService.GameProjectService;
          const game = yield* GameService.GameService;
          const created = yield* projects.create({
            name: journey.name,
            parentDirectory: parent,
            template: journey.template,
            brief: journey.brief,
            // The template journey is the build bar, not the design phase.
            planFirst: false,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-6.1-sol",
            },
          });
          expect((yield* projects.read(created.root)).template).toBe(journey.template);
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
          // then walk and jump for a while.
          const playtest = yield* game.webPlaytest(threadId, {
            width: 1280,
            height: 720,
            steps: journey.steps,
          });
          expect(playtest.booted, playtest.message).toBe(true);
          expect(playtest.success, playtest.message).toBe(true);
          expect(playtest.screenshots.map((shot) => shot.label)).toEqual(
            journey.expectedScreenshots,
          );

          // A second pass that stops on the pause overlay, so the evidence shows the
          // menu the player actually sees mid-run.
          if (journey.pauseSteps !== undefined) {
            const paused = yield* game.webPlaytest(threadId, {
              width: 1280,
              height: 720,
              steps: journey.pauseSteps,
            });
            expect(paused.success, paused.message).toBe(true);
            const last = paused.screenshots.at(-1);
            if (last !== undefined)
              yield* Effect.promise(() =>
                NodeFSP.writeFile(
                  NodePath.join(evidenceDirectory, `${journey.template}-pause.png`),
                  Buffer.from(last.data, "base64"),
                ),
              );
          }
          for (const shot of playtest.screenshots) {
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(evidenceDirectory, `${journey.template}-${shot.label}.png`),
                Buffer.from(shot.data, "base64"),
              ),
            );
          }
          for (const [suffix, contents] of [
            ["import.log", importLog],
            ["smoke.log", smokeLog],
          ] as const)
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(evidenceDirectory, `${journey.template}-${suffix}`),
                contents,
              ),
            );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(evidenceDirectory, `${journey.template}-playtest.json`),
              JSON.stringify(
                {
                  game: created.root,
                  message: playtest.message,
                  bootMs: playtest.bootMs,
                  responded: playtest.responded,
                  changedPercent: playtest.changedPercent,
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
        }),
      ).pipe(Effect.provide(dependencies));
    } finally {
      if (process.env.GAME_STUDIO_KEEP_TEST !== "1")
        yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
    }
  });

it.live.skipIf(!available)(
  "takes a game created from the 3d-explorer template from a clean import to a playtested web build",
  () =>
    templateJourney({
      template: "3d-explorer",
      // A name with quotes and a backslash: the template's own files must survive it.
      name: 'Relic Run "Best" \\ 2',
      brief: "Explode into a courtyard of floating ruins and collect every relic.",
      steps: [
        { click: "left" },
        { waitMs: 500 },
        { key: "Enter", holdMs: 80 },
        { waitMs: 3000 },
        { click: "left" },
        { waitMs: 300 },
        { keys: ["Shift", "w"], holdMs: 1200 },
        { waitMs: 200 },
        { key: "Space", holdMs: 100 },
        { waitMs: 900 },
        { screenshot: "mid-run" },
      ],
      expectedScreenshots: ["booted", "mid-run", "after-steps"],
    }),
  900_000,
);

it.live.skipIf(!available)(
  "takes a game created from the 2d-platformer template from a clean import to a playtested web build",
  () =>
    templateJourney({
      template: "2d-platformer",
      name: "Skyward Sprint",
      brief: "Run the ridge, stomp the slimes and bank every coin before the door.",
      // Click the canvas, start from the menu, run right until the ledge stops the
      // player, jump, carry on running over it, then let the frame settle so the last
      // screenshot shows the hero rather than a mid-fall. Steps run one key at a time,
      // so the jump has to happen from the ledge and the run continues mid-air.
      steps: [
        { click: "left" },
        { waitMs: 600 },
        { key: "Enter", holdMs: 80 },
        { waitMs: 1200 },
        { key: "ArrowRight", holdMs: 1000 },
        { key: "Space", holdMs: 200 },
        { key: "ArrowRight", holdMs: 1300 },
        { waitMs: 1500 },
      ],
      expectedScreenshots: ["booted", "after-steps"],
      pauseSteps: [
        { click: "left" },
        { waitMs: 800 },
        { key: "Enter", holdMs: 80 },
        { waitMs: 2000 },
        { key: "Escape", holdMs: 80 },
        { waitMs: 400 },
      ],
    }),
  900_000,
);
