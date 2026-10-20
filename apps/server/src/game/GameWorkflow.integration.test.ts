// @effect-diagnostics nodeBuiltinImport:off -- Run the real installed creative tools and loopback HTTP server, with isolated temporary game files.
import { it, expect } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as GameService from "./GameService.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GamePreview from "./GamePreview.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  previewBrowserTestLayer,
  projectTestLayer,
  designApprovalTestLayer,
  qualificationTestLayer,
} from "./gameTestLayers.ts";
const managed = GameToolchain.toolsDirectory();
const available =
  NodeFS.existsSync(NodePath.join(managed, "blender-4.5.14/blender")) &&
  NodeFS.existsSync(NodePath.join(managed, "godot-4.7.2/Godot_v4.7.2-stable_linux.x86_64"));
it.live.skipIf(!available)(
  "builds a Blender asset, imports and tests a Godot scene, exports both targets, serves WebAssembly, and stops native play",
  () =>
    Effect.gen(function* () {
      const parent = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-studio-real-")),
      );
      const dependencies = GameService.layer.pipe(
        Layer.provideMerge(GameProjectService.layer),
        Layer.provideMerge(GameOperations.layer),
        Layer.provideMerge(GameToolchain.layer),
        Layer.provideMerge(GamePreview.layer),
        Layer.provideMerge(GameProcesses.layer),
        Layer.provide(projectTestLayer()),
        Layer.provide(previewBrowserTestLayer()),
        Layer.provideMerge(qualificationTestLayer()),
        Layer.provideMerge(designApprovalTestLayer()),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(NodeServices.layer),
      );
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const projects = yield* GameProjectService.GameProjectService;
            const game = yield* GameService.GameService;
            const processes = yield* GameProcesses.GameProcesses;
            const created = yield* projects.create({
              name: "Real Cube Game",
              parentDirectory: parent,
              brief: "A cube rotates as the core game loop advances.",
              // The pipeline test builds without a design phase.
              planFirst: false,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6.1-sol",
              },
            });
            const threadId = ThreadId.make("game-test-thread");
            // The untouched starter template must import before the test rewrites the game.
            const templateImported = yield* game.import(threadId);
            expect(templateImported.success, templateImported.message).toBe(true);
            const asset = yield* game.blender(threadId, {
              id: "cube",
              script:
                "import bpy\nbpy.ops.mesh.primitive_cube_add(size=1)\nmaterial = bpy.data.materials.new('Clay')\nmaterial.diffuse_color = (0.3, 0.6, 0.9, 1)\nbpy.context.object.data.materials.append(material)\n",
            });
            expect(asset.meshes).toBe(1);
            expect(asset.dimensions).toEqual([1, 1, 1]);
            expect(asset.asset.thumbnail).toBe("art/previews/cube.png");
            const revision = yield* game.blender(threadId, {
              id: "cube",
              thumbnail: false,
              script: "import bpy\nbpy.data.objects['Cube'].scale = (2, 1, 1)\n",
            });
            expect(revision.meshes).toBe(1);
            expect(revision.asset.export).toBe(asset.asset.export);
            expect(revision.dimensions).toEqual([2, 1, 1]);
            const rebuilt = yield* game.blender(threadId, {
              id: "cube",
              reset: true,
              thumbnail: false,
              script: "import bpy\nbpy.ops.mesh.primitive_cube_add(size=3)\n",
            });
            expect(rebuilt.meshes).toBe(1);
            expect(rebuilt.dimensions).toEqual([3, 3, 3]);
            expect(rebuilt.asset.source).toBe(asset.asset.source);
            expect(rebuilt.asset.export).toBe(asset.asset.export);
            const bad = yield* Effect.result(
              game.blender(threadId, {
                id: "broken",
                script: "raise RuntimeError('intentional script failure')",
                thumbnail: false,
              }),
            );
            expect(bad._tag).toBe("Failure");
            if (Result.isFailure(bad)) {
              expect(bad.failure.detail).toContain("Traceback");
              expect(bad.failure.message).toContain("RuntimeError: intentional script failure");
            }
            const logs = yield* Effect.promise(() =>
              NodeFSP.readdir(NodePath.join(created.root, "builds/logs")),
            );
            expect(logs.filter((name) => name.startsWith("blender-"))).toEqual([]);
            yield* Effect.promise(async () => {
              await NodeFSP.writeFile(
                NodePath.join(created.root, "godot/scripts/main.gd"),
                `extends Node3D\nvar steps := 0\nfunc simulation_step():\n    steps += 1\n    $Cube.rotation.y += 0.05\nfunc _process(_delta):\n    simulation_step()\n`,
              );
              await NodeFSP.writeFile(
                NodePath.join(created.root, "godot/scenes/main.tscn"),
                `[gd_scene load_steps=3 format=3]\n[ext_resource type="PackedScene" path="res://assets/models/cube.glb" id="1"]\n[ext_resource type="Script" path="res://scripts/main.gd" id="2"]\n[node name="Main" type="Node3D"]\nscript = ExtResource("2")\n[node name="Cube" parent="." instance=ExtResource("1")]\n[node name="Camera" type="Camera3D" parent="."]\nposition = Vector3(0, 0, 5)\ncurrent = true\n[node name="Sun" type="DirectionalLight3D" parent="."]\nrotation_degrees = Vector3(-45, -30, 0)\n`,
              );
              await NodeFSP.writeFile(
                NodePath.join(created.root, "godot/tests/smoke_test.gd"),
                `extends SceneTree\nfunc _initialize():\n    var scene = load("res://scenes/main.tscn").instantiate()\n    root.add_child(scene)\n    for i in range(10):\n        scene.simulation_step()\n    if scene.steps != 10 or scene.get_node("Cube").rotation.y < 0.49:\n        push_error("Gameplay loop did not advance")\n        quit(1)\n        return\n    print("SMOKE PASS: 10 gameplay steps rotated the imported cube")\n    scene.queue_free()\n    quit(0)\n`,
              );
            });
            const imported = yield* game.import(threadId);
            expect(imported.success, imported.message).toBe(true);
            const tested = yield* game.test(threadId, "tests/smoke_test.gd");
            expect(tested.success, tested.message).toBe(true);
            expect(tested.process?.stdout).toContain("SMOKE PASS");
            const web = yield* game.action(threadId, "preview");
            expect(web.success, web.message).toBe(true);
            const htmlPath = NodePath.join(created.root, "builds/logs/preview.html");
            const htmlResponse = yield* processes.run({
              root: created.root,
              executable: "curl",
              args: [
                "--fail",
                "--silent",
                "--show-error",
                "--dump-header",
                "-",
                "--output",
                htmlPath,
                web.url!,
              ],
              operation: "curl-html",
            });
            expect(htmlResponse.exitCode, htmlResponse.stderr).toBe(0);
            expect(htmlResponse.stdout).toContain("200 OK");
            const html = yield* Effect.promise(() => NodeFSP.readFile(htmlPath, "utf8"));
            expect(html).toContain("canvas");
            const wasm = yield* processes.run({
              root: created.root,
              executable: "curl",
              args: ["--fail", "--silent", "--show-error", "--head", `${web.url}index.wasm`],
              operation: "curl-wasm",
            });
            expect(wasm.exitCode, wasm.stderr).toBe(0);
            expect(wasm.stdout).toContain("Content-Type: application/wasm");
            const linux = yield* game.export(threadId, "Linux");
            expect(linux.success, linux.message).toBe(true);
            const status = yield* game.status(threadId);
            expect(status.assets[0]?.usedBy).toContain("godot/scenes/main.tscn");
            let nativePid: number | null = null;
            if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
              const native = yield* game.action(threadId, "native");
              expect(native.success, native.message).toBe(true);
              const running = yield* game.status(threadId);
              nativePid =
                running.processes.find((entry) => entry.operation === "native")?.pid ?? null;
              expect(nativePid).not.toBeNull();
            }
            yield* game.action(threadId, "stop");
            if (nativePid !== null) expect(() => process.kill(nativePid!, 0)).toThrow();
            const stopped = yield* game.status(threadId);
            expect(stopped.processes).toEqual([]);
            expect(stopped.previewUrl).toBeNull();
            const report = {
              root: created.root,
              blender: {
                meshes: asset.meshes,
                dimensions: asset.dimensions,
                revisionDimensions: revision.dimensions,
                log: asset.process.logPath,
              },
              importExit: imported.process?.exitCode,
              importLog: imported.process?.logPath,
              testOutput: tested.process?.stdout,
              web: web.path,
              webLog: web.process?.logPath,
              htmlHeaders: htmlResponse.stdout,
              wasmHeaders: wasm.stdout,
              linux: linux.path,
              linuxLog: linux.process?.logPath,
              nativePid,
              stopped: true,
            };
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(parent, "result.json"),
                JSON.stringify(report, null, 2),
              ),
            );
            yield* Effect.log(report);
          }).pipe(Effect.provide(dependencies)),
        );
      } finally {
        if (process.env.GAME_STUDIO_KEEP_TEST !== "1")
          yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
      }
    }),
  600000,
);
