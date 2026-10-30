// @effect-diagnostics nodeBuiltinImport:off -- Run the real Blender and Godot tools against an isolated temporary game. Root runs this; it is the executable heavy verification for the asset pipeline.
import { it, expect } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
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
import { inspectGlb } from "./gameGlb.ts";
import { NodeIO } from "@gltf-transform/core";
import { PNG } from "pngjs";
import {
  admissionTestLayer,
  previewBrowserTestLayer,
  projectTestLayer,
  designApprovalTestLayer,
  roundStoreTestLayer,
  qualificationTestLayer,
} from "./gameTestLayers.ts";

const managed = GameToolchain.toolsDirectory();
const available =
  NodeFS.existsSync(NodePath.join(managed, "blender-4.5.14/blender")) &&
  NodeFS.existsSync(NodePath.join(managed, "godot-4.7.2/Godot_v4.7.2-stable_linux.x86_64"));

const PROFILE = { palette: ["#ff5b3a", "#3fa7ff", "#ffd23f"], targetHeight: 1.8 };

const HERO_SCRIPT = `import bpy
bpy.ops.mesh.primitive_cube_add(size=1)
hero = bpy.context.object
hero.name = "Hero"
hero.scale = (1.0, 1.0, 1.8)
hero.location = (0.0, 0.0, 0.9)
hero.data.materials.append(bpy.data.materials["StudioPalette_ff5b3a"])
hero.rotation_euler = (0, 0, 0)
hero.keyframe_insert("rotation_euler", frame=1)
hero.rotation_euler = (0, 0, 1.57)
hero.keyframe_insert("rotation_euler", frame=10)
`;

const CRATE_SCRIPT = `import bpy
bpy.ops.mesh.primitive_cube_add(size=1)
crate = bpy.context.object
crate.name = "Crate"
crate.data.materials.append(bpy.data.materials["StudioPalette_3fa7ff"])
`;

const SWORD_SCRIPT = `import bpy
bpy.ops.mesh.primitive_cube_add(size=1)
sword = bpy.context.object
sword.name = "Sword"
sword.scale = (0.15, 0.18, 1.2)
sword.location = (0.0, 0.0, 0.6)
sword.data.materials.append(bpy.data.materials["StudioPalette_ffd23f"])
`;

const LINEUP_SCENE = `[gd_scene load_steps=4 format=3]
[ext_resource type="PackedScene" path="res://assets/models/hero.glb" id="1_hero"]
[ext_resource type="PackedScene" path="res://assets/models/crate.glb" id="1_crate"]
[ext_resource type="PackedScene" path="res://assets/models/sword.glb" id="1_sword"]
[node name="Lineup" type="Node3D"]
[node name="Hero" parent="." instance=ExtResource("1_hero")]
[node name="Crate" parent="." instance=ExtResource("1_crate")]
[node name="Sword" parent="." instance=ExtResource("1_sword")]
`;

const LINEUP_TEST = `extends SceneTree
func _initialize() -> void:
	var packed := load("res://scenes/lineup.tscn") as PackedScene
	if packed == null:
		push_error("The lineup scene does not load.")
		quit(1)
		return
	var lineup := packed.instantiate()
	root.add_child(lineup)
	var meshes := 0
	var names := PackedStringArray()
	var stack: Array = [lineup]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		names.append(str(node.name))
		if node is MeshInstance3D:
			meshes += 1
		for child in node.get_children():
			stack.append(child)
	print("LINEUP meshes=%d nodes=%s" % [meshes, ",".join(names)])
	if meshes < 3:
		push_error("Expected at least 3 mesh instances, found %d." % meshes)
		quit(1)
		return
	print("LINEUP PASS: the three exports instantiate together")
	lineup.queue_free()
	quit(0)
`;

it.live.skipIf(!available)(
  "builds a coherent profiled asset set that survives failure and cancellation, then instantiates it in Godot",
  () =>
    Effect.gen(function* () {
      const parent = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-studio-assets-")),
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
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const projects = yield* GameProjectService.GameProjectService;
            const game = yield* GameService.GameService;
            const processes = yield* GameProcesses.GameProcesses;
            const created = yield* projects.create({
              name: "Asset Pipeline Game",
              parentDirectory: parent,
              brief: "A lineup of profiled assets standing on the ground.",
              planFirst: false,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6.1-sol",
              },
            });
            const threadId = ThreadId.make("game-test-thread");
            const templateImported = yield* game.import(threadId);
            expect(templateImported.success, templateImported.message).toBe(true);

            // Three coherent assets against one shared profile.
            const hero = yield* game.blender(threadId, {
              id: "hero",
              script: HERO_SCRIPT,
              art: PROFILE,
            });
            expect(hero.meshes).toBe(1);
            expect(hero.animations).toBeGreaterThanOrEqual(1);
            expect(hero.triangles).toBeGreaterThan(0);
            expect(hero.materialDetails.map((entry) => entry.name)).toContain(
              "StudioPalette_ff5b3a",
            );
            expect(hero.originOffset.every((value) => Math.abs(value) < 1e-6)).toBe(true);
            expect(hero.dimensions[2]).toBeCloseTo(1.8, 5);
            expect(hero.warnings).toEqual([]);
            expect(hero.contactSheet).toBe("art/previews/contact_sheet.png");

            const crate = yield* game.blender(threadId, {
              id: "crate",
              script:
                CRATE_SCRIPT +
                `
from pathlib import Path
texture_path = Path(${JSON.stringify(NodePath.join(created.root, "art/textures/crate.png"))})
texture_path.parent.mkdir(parents=True, exist_ok=True)
image = bpy.data.images.new("CrateTexture", width=16, height=16)
image.pixels[:] = [0.2, 0.6, 1.0, 1.0] * 256
image.filepath_raw = str(texture_path)
image.file_format = 'PNG'
image.save()
material = bpy.data.materials["StudioPalette_3fa7ff"]
texture = material.node_tree.nodes.new('ShaderNodeTexImage')
texture.image = bpy.data.images.load(str(texture_path), check_existing=False)
material.node_tree.links.new(texture.outputs['Color'], material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
`,
            });
            expect(crate.asset.export).toBe("godot/assets/models/crate.glb");
            // A metre cube against a 1.8m profile, floating at the origin: the
            // run succeeds and says exactly how it drifts.
            expect(crate.warnings.join("\n")).toContain("profile target");
            expect(crate.warnings.join("\n")).toContain("origin");

            const sword = yield* game.blender(threadId, { id: "sword", script: SWORD_SCRIPT });
            expect(sword.meshes).toBe(1);

            // A legacy source may keep unpacked images relative to its .blend.
            const legacy = yield* processes.run({
              root: created.root,
              executable: NodePath.join(managed, "blender-4.5.14/blender"),
              args: [
                "--background",
                NodePath.join(created.root, crate.asset.source),
                "--threads",
                "2",
                "--python-exit-code",
                "1",
                "--python-expr",
                "import bpy; bpy.ops.file.unpack_all(method='WRITE_LOCAL'); bpy.ops.file.make_paths_relative(); bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)",
              ],
              operation: "legacy-texture-fixture",
              timeoutMs: 60000,
            });
            expect(legacy.exitCode, legacy.stderr).toBe(0);

            // A revision at the same id revises in place and stays one entry.
            const revised = yield* game.blender(threadId, {
              id: "crate",
              script: 'import bpy\nbpy.data.objects["Crate"].scale = (1.2, 1.0, 1.0)\n',
            });
            expect(revised.asset.export).toBe(crate.asset.export);
            const revisedGlb = yield* Effect.promise(async () =>
              inspectGlb(await NodeFSP.readFile(NodePath.join(created.root, revised.asset.export))),
            );
            expect(revisedGlb.textures).toBe(1);
            const exportedPixels = yield* Effect.promise(async () => {
              const doc = await new NodeIO().readBinary(
                await NodeFSP.readFile(NodePath.join(created.root, revised.asset.export)),
              );
              const image = doc.getRoot().listTextures()[0]?.getImage();
              return image === null || image === undefined
                ? null
                : PNG.sync.read(Buffer.from(image)).data.subarray(0, 3);
            });
            const sourcePixels = yield* Effect.promise(async () =>
              PNG.sync
                .read(await NodeFSP.readFile(NodePath.join(created.root, "art/textures/crate.png")))
                .data.subarray(0, 3),
            );
            expect(exportedPixels).toEqual(sourcePixels);
            const status = yield* game.status(threadId);
            expect(status.assets.filter((asset) => asset.id === "crate")).toHaveLength(1);

            // A generation failure keeps every live byte and the manifest.
            const finals = yield* Effect.promise(() =>
              Promise.all(
                [
                  "art/blender/sword.blend",
                  "art/scripts/sword.py",
                  "godot/assets/models/sword.glb",
                  "game.json",
                ].map((relative) => NodeFSP.readFile(NodePath.join(created.root, relative))),
              ),
            );
            const failed = yield* Effect.result(
              game.blender(threadId, {
                id: "sword",
                script: "raise RuntimeError('intentional asset failure')",
              }),
            );
            expect(failed._tag).toBe("Failure");
            const afterFailure = yield* Effect.promise(() =>
              Promise.all(
                [
                  "art/blender/sword.blend",
                  "art/scripts/sword.py",
                  "godot/assets/models/sword.glb",
                  "game.json",
                ].map((relative) => NodeFSP.readFile(NodePath.join(created.root, relative))),
              ),
            );
            expect([...afterFailure].map((bytes) => bytes.toString())).toEqual(
              [...finals].map((bytes) => bytes.toString()),
            );

            // A cancellation keeps the last good asset too.
            const readyName = "asset-cancellation-ready";
            const readyPath = NodePath.join(created.root, readyName);
            const watcher = yield* Effect.acquireRelease(
              Effect.sync(() => NodeFS.watch(created.root)),
              (watch) => Effect.sync(() => watch.close()),
            );
            const ready = new Promise<void>((resolve) =>
              watcher.on("change", (_event, filename) => {
                if (filename === readyName) resolve();
              }),
            );
            const cancelled = yield* game
              .blender(threadId, {
                id: "sword",
                script: `import bpy, time\nfrom pathlib import Path\nbpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)\nPath(${JSON.stringify(readyPath)}).write_text("ready")\ntime.sleep(120)\n`,
              })
              .pipe(Effect.forkChild);
            yield* Effect.promise(() => ready);
            expect(processes.list(created.root).length).toBeGreaterThan(0);
            const cancelledPids = processes.list(created.root).map((entry) => entry.pid);
            yield* game.cancelThread(threadId);
            const cancelExit = yield* Fiber.await(cancelled);
            expect(Exit.isFailure(cancelExit)).toBe(true);
            for (const pid of cancelledPids) expect(() => process.kill(pid, 0)).toThrow();
            const afterCancel = yield* Effect.promise(() =>
              Promise.all(
                [
                  "art/blender/sword.blend",
                  "art/scripts/sword.py",
                  "godot/assets/models/sword.glb",
                  "game.json",
                ].map((relative) => NodeFSP.readFile(NodePath.join(created.root, relative))),
              ),
            );
            expect([...afterCancel].map((bytes) => bytes.toString())).toEqual(
              [...finals].map((bytes) => bytes.toString()),
            );

            // The exports instantiate together in the pinned engine.
            yield* Effect.promise(async () => {
              await NodeFSP.writeFile(
                NodePath.join(created.root, "godot/scenes/lineup.tscn"),
                LINEUP_SCENE,
              );
              await NodeFSP.writeFile(
                NodePath.join(created.root, "godot/tests/asset_lineup_test.gd"),
                LINEUP_TEST,
              );
            });
            const imported = yield* game.import(threadId);
            expect(imported.success, imported.message).toBe(true);
            const lineup = yield* game.test(threadId, "tests/asset_lineup_test.gd");
            expect(lineup.success, lineup.message).toBe(true);
            expect(lineup.process?.stdout).toContain("LINEUP PASS");
            const checked = yield* game.check(threadId);
            expect(checked.ok, JSON.stringify(checked.errors)).toBe(true);
            const played = yield* game.status(threadId);
            expect(played.assets.map((asset) => asset.id).sort()).toEqual([
              "crate",
              "hero",
              "sword",
            ]);
            for (const asset of played.assets)
              expect(asset.usedBy.join(",")).toContain("lineup.tscn");

            // The shipped 2D kit builds engine-native sprite frames.
            const kit = yield* game.importArtKit(threadId, { id: "kenney-pixel-platformer" });
            expect(kit.alreadyPresent).toBe(false);
            const frames = yield* game.buildArtFrames(threadId, {
              id: "kenney-pixel-platformer",
              sheet: "characters",
            });
            expect(frames.animations).toHaveLength(10);
            expect(frames.animations.find((entry) => entry.name === "bat-flap")?.frames).toBe(3);
            const framesPath = NodePath.join(created.root, frames.framesPath);
            const frameBytes = yield* Effect.promise(() => NodeFSP.readFile(framesPath));
            const repeated = yield* game.buildArtFrames(threadId, {
              id: "kenney-pixel-platformer",
              sheet: "characters",
            });
            expect(repeated.framesPath).toBe(frames.framesPath);
            expect(yield* Effect.promise(() => NodeFSP.readFile(framesPath))).toEqual(frameBytes);
            const subset = yield* game.buildArtFrames(threadId, {
              id: "kenney-pixel-platformer",
              sheet: "characters",
              animations: ["bat-flap"],
            });
            expect(subset.framesPath).not.toBe(frames.framesPath);
            expect(yield* Effect.promise(() => NodeFSP.readFile(framesPath))).toEqual(frameBytes);
            const reimported = yield* game.import(threadId);
            expect(reimported.success, reimported.message).toBe(true);
            const rechecked = yield* game.check(threadId);
            expect(rechecked.ok, JSON.stringify(rechecked.errors)).toBe(true);

            const report = {
              profile: PROFILE,
              hero: {
                meshes: hero.meshes,
                animations: hero.animations,
                triangles: hero.triangles,
                dimensions: hero.dimensions,
                materialDetails: hero.materialDetails,
                warnings: hero.warnings,
              },
              crateWarnings: crate.warnings,
              swordExport: sword.asset.export,
              contactSheet: hero.contactSheet,
              frames: frames.animations,
              lineup: lineup.process?.stdout,
            };
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(parent, "result.json"),
                JSON.stringify(report, null, 2),
              ),
            );
          }).pipe(Effect.provide(dependencies)),
        );
      } finally {
        if (process.env.GAME_STUDIO_KEEP_TEST !== "1")
          yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
      }
    }),
  600000,
);
