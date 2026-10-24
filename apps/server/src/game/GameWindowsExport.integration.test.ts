// @effect-diagnostics nodeBuiltinImport:off -- Runs the real pinned Godot toolchain and exports a real Windows executable to an isolated game folder.
import { it, expect } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_GAME_TEMPLATE, ProviderInstanceId } from "@t3tools/contracts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import { inspectWindowsBuild } from "./windowsExport.ts";
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
const listDirectories = (root: string) => {
  try {
    return NodeFS.readdirSync(root);
  } catch {
    return [];
  }
};
const templateRoots = (() => {
  const dataRoot = process.env.XDG_DATA_HOME ?? NodePath.join(NodeOS.homedir(), ".local/share");
  const root = NodePath.join(
    GameToolchain.toolsDirectory(),
    `godot-${GameToolchain.GODOT_VERSION}`,
    "editor_data/export_templates",
  );
  const legacy = NodePath.join(dataRoot, "godot/export_templates");
  return [
    ...listDirectories(root).map((version) => NodePath.join(root, version)),
    ...listDirectories(legacy).map((version) => NodePath.join(legacy, version, version)),
  ];
})();
const windowsTemplates = templateRoots.some(
  (directory) =>
    NodeFS.existsSync(NodePath.join(directory, "windows_release_x86_64.exe")) &&
    NodeFS.existsSync(NodePath.join(directory, "windows_debug_x86_64.exe")),
);
const available = NodeFS.existsSync(godotExecutable) && windowsTemplates;
const evidenceDirectory = process.env.GAME_STUDIO_WINDOWS_EVIDENCE_DIR?.trim();

it.live.skipIf(!available)(
  "exports a real x86_64 Windows build without changing the selected Web build",
  () =>
    Effect.gen(function* () {
      const parent = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-studio-windows-")),
        ),
        (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
      const dependencies = GameService.layer.pipe(
        Layer.provideMerge(GameProjectService.layer),
        Layer.provideMerge(GameOperations.layer),
        Layer.provideMerge(GameToolchain.layer),
        Layer.provideMerge(GamePreview.layer),
        Layer.provideMerge(GameProcesses.layer),
        Layer.provide(projectTestLayer()),
        Layer.provide(previewBrowserTestLayer()),
        Layer.provideMerge(qualificationTestLayer(NodePath.join(parent, ".test-state"))),
        Layer.provideMerge(designApprovalTestLayer(NodePath.join(parent, ".test-state"))),
        Layer.provideMerge(roundStoreTestLayer(NodePath.join(parent, ".test-state"))),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provideMerge(admissionTestLayer),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const projects = yield* GameProjectService.GameProjectService;
          const game = yield* GameService.GameService;
          const created = yield* projects.create({
            name: "Windows Export",
            parentDirectory: parent,
            template: DEFAULT_GAME_TEMPLATE,
            brief: "Collect the relics.",
            planFirst: false,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-6.1-sol",
            },
          });
          const threadId = created.threadId;
          const imported = yield* game.import(threadId);
          expect(imported.success, imported.message).toBe(true);
          const checked = yield* game.check(threadId);
          expect(checked.ok, JSON.stringify(checked.errors)).toBe(true);

          // Simulate a game created before Windows existed: keep the creator's
          // Web and Linux presets byte for byte, without the Windows block.
          const presetsPath = NodePath.join(created.root, "godot/export_presets.cfg");
          const originalPresets = yield* Effect.promise(() =>
            NodeFSP.readFile(presetsPath, "utf8"),
          );
          const windowsStart = originalPresets.indexOf("[preset.2]");
          expect(windowsStart).toBeGreaterThan(-1);
          const withoutWindows = `${originalPresets.slice(0, windowsStart).trimEnd()}\n`;
          expect(withoutWindows).not.toContain('platform="Windows Desktop"');
          expect(withoutWindows).toContain('name="Web"');
          expect(withoutWindows).toContain('name="Linux"');
          yield* Effect.promise(() => NodeFSP.writeFile(presetsPath, withoutWindows));

          const web = yield* game.export(threadId, "Web");
          expect(web.success, web.message).toBe(true);
          const selectedBefore = (yield* game.status(threadId)).selectedBuildId;
          expect(selectedBefore).not.toBeNull();

          const windows = yield* game.export(threadId, "Windows");
          const presetsDuringExport = yield* Effect.promise(() =>
            NodeFSP.readFile(presetsPath, "utf8"),
          );
          expect(
            windows.success,
            `${windows.message}\n--- presets ---\n${presetsDuringExport}`,
          ).toBe(true);
          const executablePath = NodePath.join(created.root, "builds/windows/game.exe");
          expect(windows.path).toBe(executablePath);
          expect(NodeFS.statSync(executablePath).size).toBeGreaterThan(0);
          expect(NodeFS.existsSync(NodePath.join(created.root, "builds/windows/game.pck"))).toBe(
            false,
          );
          const inspection = inspectWindowsBuild({
            executable: NodeFS.readFileSync(executablePath),
            pck: null,
          });
          expect(inspection.issues).toEqual([]);
          expect(inspection.embeddedPck).toBe(true);
          expect(inspection.pckFileCount).toBeGreaterThan(0);

          const status = yield* game.status(threadId);
          expect(status.selectedBuildId).toBe(selectedBefore);
          expect(status.selectedArtifactUsable).toBe(true);
          expect(status.builds.find((build) => build.target === "Windows")?.path).toBe(
            "builds/windows/game.exe",
          );
          const inventory = yield* projects.inventory(created.root);
          expect(inventory.builds.find((build) => build.target === "Windows")?.path).toBe(
            "builds/windows/game.exe",
          );
          const presetsAfter = yield* Effect.promise(() => NodeFSP.readFile(presetsPath, "utf8"));
          expect(presetsAfter.startsWith(withoutWindows)).toBe(true);
          expect(presetsAfter).toContain('name="Windows"');
          expect(presetsAfter).toContain('platform="Windows Desktop"');

          // A creator-named preset is reused exactly as written and Godot is
          // asked for that name, not the literal "Windows".
          const renamedPresets = presetsAfter.replace('name="Windows"', 'name="Store build"');
          expect(renamedPresets).toContain('name="Store build"');
          yield* Effect.promise(() => NodeFSP.writeFile(presetsPath, renamedPresets));
          const reused = yield* game.export(threadId, "Windows");
          expect(reused.success, reused.message).toBe(true);
          expect(reused.message).not.toContain("standard Windows export preset was added");
          const finalStatus = yield* game.status(threadId);
          expect(finalStatus.selectedBuildId).toBe(selectedBefore);
          const finalPresets = yield* Effect.promise(() => NodeFSP.readFile(presetsPath, "utf8"));
          expect(finalPresets).toContain('name="Store build"');
          expect(finalPresets.match(/platform="Windows Desktop"/g)).toHaveLength(1);
          const finalInspection = inspectWindowsBuild({
            executable: NodeFS.readFileSync(executablePath),
            pck: null,
          });
          expect(finalInspection.issues).toEqual([]);

          if (evidenceDirectory !== undefined) {
            yield* Effect.promise(async () => {
              const target = NodePath.join(evidenceDirectory, "window-export");
              await NodeFSP.mkdir(target, { recursive: true });
              await NodeFSP.copyFile(executablePath, NodePath.join(target, "game.exe"));
              await NodeFSP.copyFile(presetsPath, NodePath.join(target, "export_presets.cfg"));
              if (reused.process !== null)
                await NodeFSP.copyFile(reused.process.logPath, NodePath.join(target, "export.log"));
              await NodeFSP.writeFile(
                NodePath.join(target, "inspection.json"),
                `${JSON.stringify(
                  {
                    addedPresetMessage: windows.message,
                    reusedPresetMessage: reused.message,
                    presetName: "Store build",
                    executableBytes: finalInspection.executableBytes,
                    embeddedPck: finalInspection.embeddedPck,
                    pckFileCount: finalInspection.pckFileCount,
                    selectedBuildBefore: selectedBefore,
                    selectedBuildAfter: finalStatus.selectedBuildId,
                  },
                  null,
                  2,
                )}\n`,
              );
            });
          }
        }).pipe(Effect.provide(dependencies)),
      );
    }),
  900_000,
);
