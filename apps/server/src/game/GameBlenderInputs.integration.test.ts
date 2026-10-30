// @effect-diagnostics nodeBuiltinImport:off -- Real Blender/Godot verification for named inputs. Root runs this; it is the executable heavy check.
// Root-owned opt-in integration test (DO NOT run in the implementation worker).
// Proves a real Blender run imports a textured/animated library-format source
// (.gltf plus relative .bin/image), produces a related variant sharing source
// geometry/materials, revises after scratch removal, and instantiates in Godot.
import { it, expect } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
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
import { NodeIO, getBounds } from "@gltf-transform/core";
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

const BASE_SCRIPT = `import bpy
bpy.ops.mesh.primitive_cube_add(size=1)
base = bpy.context.object
base.name = "Base"
base.scale = (1.0, 1.0, 1.0)
base.location = (0.0, 0.0, 0.5)
mat = bpy.data.materials["StudioPalette_ff5b3a"]
base.data.materials.append(mat)
base.rotation_euler = (0, 0, 0)
base.keyframe_insert("rotation_euler", frame=1)
base.rotation_euler = (0, 0, 1.57)
base.keyframe_insert("rotation_euler", frame=10)
`;

const VARIANT_SCRIPT = `import bpy
bpy.ops.import_scene.gltf(filepath=ASSET_INPUTS["base"])
imported = [obj for obj in bpy.context.selected_objects]
assert imported, "ASSET_INPUTS[base] imported nothing"
base = None
for obj in bpy.context.scene.objects:
    if obj.type == 'MESH':
        base = obj
        break
assert base is not None
bpy.ops.mesh.primitive_cube_add(size=0.4)
hat = bpy.context.object
hat.name = "Hat"
hat.location = (0.0, 0.0, 1.2)
hat.data.materials.append(bpy.data.materials["StudioPalette_ff5b3a"])
`;

const LINEUP_SCENE = `[gd_scene load_steps=3 format=3]
[ext_resource type="PackedScene" path="res://assets/models/base.glb" id="1_base"]
[ext_resource type="PackedScene" path="res://assets/models/variant.glb" id="1_variant"]
[node name="Lineup" type="Node3D"]
[node name="Base" parent="." instance=ExtResource("1_base")]
[node name="Variant" parent="." instance=ExtResource("1_variant")]
`;

const LINEUP_TEST = `extends SceneTree
func _initialize() -> void:
\tvar packed := load("res://scenes/input_lineup.tscn") as PackedScene
\tif packed == null:
\t\tpush_error("The lineup scene does not load.")
\t\tquit(1)
\t\treturn
\tvar lineup := packed.instantiate()
\troot.add_child(lineup)
\tvar meshes := 0
\tvar stack: Array = [lineup]
\twhile not stack.is_empty():
\t\tvar node: Node = stack.pop_back()
\t\tif node is MeshInstance3D:
\t\t\tmeshes += 1
\t\tfor child in node.get_children():
\t\t\tstack.append(child)
\tprint("LINEUP meshes=%d" % meshes)
\tif meshes < 2:
\t\tpush_error("Expected at least 2 mesh instances, found %d." % meshes)
\t\tquit(1)
\t\treturn
\tprint("LINEUP PASS: base and variant instantiate together")
\tlineup.queue_free()
\tquit(0)
`;

it.live.skipIf(!available)(
  "imports a textured/animated .gltf source, variants it, revises after scratch removal, and instantiates in Godot",
  () =>
    Effect.gen(function* () {
      const parent = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-studio-inputs-")),
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
            const created = yield* projects.create({
              name: "Inputs Integration Game",
              parentDirectory: parent,
              brief: "A base asset and a variant reusing its geometry.",
              planFirst: false,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6.1-sol",
              },
            });
            const threadId = ThreadId.make("game-test-thread");
            const imported = yield* game.import(threadId);
            expect(imported.success, imported.message).toBe(true);

            // Base asset with shared palette material plus rotation animation.
            const base = yield* game.blender(threadId, {
              id: "base",
              script: BASE_SCRIPT,
              art: { palette: ["#ff5b3a"], targetHeight: 1.0 },
            });
            expect(base.meshes).toBe(1);
            expect(base.animations).toBeGreaterThanOrEqual(1);

            // Library-format source: the base export repacked as .gltf plus
            // relative .bin/image through the upstream SDK.
            const sourceGltf = "godot/assets/library/models/base/base.gltf";
            yield* Effect.promise(async () => {
              const baseGlb = await NodeFSP.readFile(
                NodePath.join(created.root, base.asset.export),
              );
              const sourceDir = NodePath.join(created.root, "godot/assets/library/models/base");
              await NodeFSP.mkdir(sourceDir, { recursive: true });
              const parsed = await new NodeIO().readBinary(new Uint8Array(baseGlb));
              const textureImage = new PNG({ width: 16, height: 16 });
              textureImage.data.fill(128);
              const textureBytes = PNG.sync.write(textureImage);
              const texture = parsed
                .createTexture("SourceTexture")
                .setImage(new Uint8Array(textureBytes))
                .setMimeType("image/png");
              parsed.getRoot().listMaterials()[0]!.setBaseColorTexture(texture);
              await new NodeIO().write(NodePath.join(sourceDir, "base.gltf"), parsed);
            });

            // Variant reuses the source geometry/materials by name.
            const variant = yield* game.blender(threadId, {
              id: "variant",
              script: VARIANT_SCRIPT,
              inputs: [{ name: "base", path: sourceGltf }],
            });
            expect(variant.meshes).toBeGreaterThanOrEqual(2);
            expect(variant.asset.inputs).toEqual([{ name: "base", path: sourceGltf }]);
            const variantInspection = yield* Effect.promise(async () =>
              inspectGlb(await NodeFSP.readFile(NodePath.join(created.root, variant.asset.export))),
            );
            expect(variantInspection.meshes).toBeGreaterThanOrEqual(2);
            expect(variantInspection.textures).toBeGreaterThanOrEqual(1);
            expect(variantInspection.animations).toBeGreaterThanOrEqual(1);

            // Scratch inputs are gone, yet the saved .blend still revises:
            // images were packed, geometry was imported, not linked.
            const revision = yield* game.blender(threadId, {
              id: "variant",
              script: 'import bpy\nbpy.data.objects["Hat"].scale = (1.1, 1.1, 1.1)\n',
            });
            expect(revision.asset.export).toBe(variant.asset.export);
            expect(revision.asset.inputs).toEqual(variant.asset.inputs);
            const revisedInspection = yield* Effect.promise(async () =>
              inspectGlb(
                await NodeFSP.readFile(NodePath.join(created.root, revision.asset.export)),
              ),
            );
            expect(revisedInspection.textures).toBeGreaterThanOrEqual(1);
            expect(revisedInspection.animations).toBeGreaterThanOrEqual(1);

            yield* Effect.promise(async () => {
              await NodeFSP.writeFile(
                NodePath.join(created.root, "godot/scenes/input_lineup.tscn"),
                LINEUP_SCENE,
              );
              await NodeFSP.writeFile(
                NodePath.join(created.root, "godot/tests/input_lineup_test.gd"),
                LINEUP_TEST,
              );
            });
            const reimported = yield* game.import(threadId);
            expect(reimported.success, reimported.message).toBe(true);
            const lineup = yield* game.test(threadId, "tests/input_lineup_test.gd");
            expect(lineup.success, lineup.message).toBe(true);
            expect(lineup.process?.stdout).toContain("LINEUP PASS");
          }).pipe(Effect.provide(dependencies)),
        );
      } finally {
        if (process.env.GAME_STUDIO_KEEP_TEST !== "1")
          yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
      }
    }),
  600000,
);
const FOX_VARIANT_SCRIPT = `import bpy
names = {o.name for o in bpy.data.objects}
bpy.ops.import_scene.gltf(filepath=ASSET_INPUTS["fox"])
imported = [o for o in bpy.data.objects if o.name not in names]
assert imported, "ASSET_INPUTS[fox] imported nothing"
for obj in imported:
    if obj.parent is None:
        obj.scale = (0.01, 0.01, 0.01)
`;

const FOX_POSE_TEST = `extends SceneTree
func _find(node: Node, cls: String) -> Node:
\tif node.get_class() == cls:
\t\treturn node
\tfor child in node.get_children():
\t\tvar found := _find(child, cls)
\t\tif found != null:
\t\t\treturn found
\treturn null
func _initialize() -> void:
\tvar packed := load("res://assets/models/fox_variant.glb") as PackedScene
\tif packed == null:
\t\tpush_error("FOX FAIL: the fox variant export does not load.")
\t\tquit(1)
\t\treturn
\tvar inst := packed.instantiate()
\troot.add_child(inst)
\tvar meshes := 0
\tvar stack: Array = [inst]
\twhile not stack.is_empty():
\t\tvar node: Node = stack.pop_back()
\t\tif node is MeshInstance3D:
\t\t\tmeshes += 1
\t\tfor child in node.get_children():
\t\t\tstack.append(child)
\tprint("FOX meshes=%d" % meshes)
\tif meshes < 1:
\t\tpush_error("FOX FAIL: no mesh instances in the variant.")
\t\tquit(1)
\t\treturn
\tvar skel := _find(inst, "Skeleton3D") as Skeleton3D
\tif skel == null:
\t\tpush_error("FOX FAIL: no Skeleton3D in the variant; the skin did not survive.")
\t\tquit(1)
\t\treturn
\tvar player := _find(inst, "AnimationPlayer") as AnimationPlayer
\tif player == null:
\t\tpush_error("FOX FAIL: no AnimationPlayer in the variant.")
\t\tquit(1)
\t\treturn
\tvar clips := player.get_animation_list()
\tprint("FOX clips=%s" % ",".join(clips))
\tfor want in ["Survey", "Walk", "Run"]:
\t\tif not (want in clips):
\t\t\tpush_error("FOX FAIL: clip %s missing from %s." % [want, ",".join(clips)])
\t\t\tquit(1)
\t\t\treturn
\tvar bones := skel.get_bone_count()
\tif bones < 1:
\t\tpush_error("FOX FAIL: the skeleton holds no bones.")
\t\tquit(1)
\t\treturn
\tvar length := (player.get_animation("Walk") as Animation).length
\tplayer.play("Walk")
\tplayer.seek(0.0, true)
\tvar before: Array = []
\tfor i in range(bones):
\t\tbefore.append(skel.get_bone_pose(i))
\tplayer.seek(length * 0.5, true)
\tvar moved := false
\tfor i in range(bones):
\t\tif not (before[i] as Transform3D).is_equal_approx(skel.get_bone_pose(i)):
\t\t\tmoved = true
\t\t\tbreak
\tprint("FOX bones=%d moved=%s" % [bones, str(moved)])
\tif not moved:
\t\tpush_error("FOX FAIL: the Walk clip leaves every bone pose unchanged.")
\t\tquit(1)
\t\treturn
\tprint("FOX PASS: variant instantiates with skin, clips and a moving skeleton")
\tinst.queue_free()
\tquit(0)
`;

// Pinned Khronos Fox fixture, supplied by the parent through GAME_STUDIO_FOX_GLB
// (absolute path to Fox.glb; LICENSE.md and PROVENANCE.json sit beside it).
// Geometry CC0 by PixelMannen; rig/animation CC-BY-4.0 by tomkranis; glTF
// conversion CC-BY-4.0 by @AsoboStudio/@scurest. Never downloaded or committed
// here; the binary stays the parent's private fixture. Parent-owned and
// engine-backed: the implementation worker must NOT run this case.
const foxFixture = (process.env.GAME_STUDIO_FOX_GLB ?? "").trim();

it.live.skipIf(!available || foxFixture === "")(
  "imports the pinned Fox reference, variants it, revises after scratch cleanup, and proves animation in Godot",
  () =>
    Effect.gen(function* () {
      if (!NodeFS.existsSync(foxFixture))
        throw new Error(`GAME_STUDIO_FOX_GLB points at a missing file: ${foxFixture}`);
      const parent = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-studio-fox-")),
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
            const created = yield* projects.create({
              name: "Fox Integration Game",
              parentDirectory: parent,
              brief: "A fox variant reusing the pinned reference model.",
              planFirst: false,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6.1-sol",
              },
            });
            const threadId = ThreadId.make("game-test-thread");
            const imported = yield* game.import(threadId);
            expect(imported.success, imported.message).toBe(true);

            // Pin the private fixture beside the game with its source credits.
            const foxDir = "godot/assets/library/models/fox";
            yield* Effect.promise(async () => {
              const target = NodePath.join(created.root, foxDir);
              await NodeFSP.mkdir(target, { recursive: true });
              await NodeFSP.copyFile(foxFixture, NodePath.join(target, "Fox.glb"));
              for (const credit of ["LICENSE.md", "PROVENANCE.json"]) {
                try {
                  await NodeFSP.copyFile(
                    NodePath.join(NodePath.dirname(foxFixture), credit),
                    NodePath.join(target, credit),
                  );
                } catch {
                  throw new Error(`The Fox fixture is missing its ${credit} credit.`);
                }
              }
            });

            // SDK facts on the pinned source: 1 mesh/skin/material/texture,
            // Survey/Walk/Run, pre-scale height ~79.
            const sourceFacts = yield* Effect.promise(async () => {
              const document = await new NodeIO().readBinary(
                new Uint8Array(
                  await NodeFSP.readFile(NodePath.join(created.root, foxDir, "Fox.glb")),
                ),
              );
              const foxRoot = document.getRoot();
              const box = getBounds(foxRoot.listScenes()[0]!);
              return {
                meshes: foxRoot.listMeshes().length,
                skins: foxRoot.listSkins().length,
                materials: foxRoot.listMaterials().length,
                textures: foxRoot.listTextures().length,
                clips: foxRoot
                  .listAnimations()
                  .map((entry) => entry.getName())
                  .sort(),
                height: box.max[1]! - box.min[1]!,
              };
            });
            expect(sourceFacts.meshes).toBe(1);
            expect(sourceFacts.skins).toBe(1);
            expect(sourceFacts.materials).toBe(1);
            expect(sourceFacts.textures).toBe(1);
            expect(sourceFacts.clips).toEqual(["Run", "Survey", "Walk"]);
            expect(sourceFacts.height).toBeGreaterThan(70);
            expect(sourceFacts.height).toBeLessThan(90);

            // Variant reuses the reference with a .01 root scale (~0.79 m).
            const variant = yield* game.blender(threadId, {
              id: "fox_variant",
              script: FOX_VARIANT_SCRIPT,
              inputs: [{ name: "fox", path: `${foxDir}/Fox.glb` }],
            });
            expect(variant.meshes).toBeGreaterThanOrEqual(1);
            expect(variant.asset.inputs).toEqual([{ name: "fox", path: `${foxDir}/Fox.glb` }]);
            const variantFacts = yield* Effect.promise(async () => {
              const bytes = await NodeFSP.readFile(
                NodePath.join(created.root, variant.asset.export),
              );
              const inspection = await inspectGlb(new Uint8Array(bytes));
              const document = await new NodeIO().readBinary(new Uint8Array(bytes));
              return {
                inspection,
                clips: document
                  .getRoot()
                  .listAnimations()
                  .map((entry) => entry.getName())
                  .sort(),
              };
            });
            expect(variantFacts.inspection.textures).toBeGreaterThanOrEqual(1);
            expect(variantFacts.inspection.skins).toBeGreaterThanOrEqual(1);
            expect(variantFacts.clips).toEqual(["Run", "Survey", "Walk"]);
            expect(variantFacts.inspection.bounds).toBeNull();
            const scaledHeight = variant.dimensions[2] ?? 0;
            expect(scaledHeight).toBeGreaterThan(0.5);
            expect(scaledHeight).toBeLessThan(1.2);

            // Scratch inputs are gone, yet the saved .blend still revises and
            // keeps texture, skin and clip names.
            yield* Effect.promise(() =>
              NodeFSP.rm(NodePath.join(created.root, "builds"), {
                recursive: true,
                force: true,
              }),
            );
            const revision = yield* game.blender(threadId, {
              id: "fox_variant",
              script: "import bpy\nprint([o.name for o in bpy.data.objects])\n",
            });
            expect(revision.asset.export).toBe(variant.asset.export);
            expect(revision.asset.inputs).toEqual(variant.asset.inputs);
            const revisedFacts = yield* Effect.promise(async () => {
              const bytes = await NodeFSP.readFile(
                NodePath.join(created.root, revision.asset.export),
              );
              const inspection = await inspectGlb(new Uint8Array(bytes));
              const document = await new NodeIO().readBinary(new Uint8Array(bytes));
              return {
                inspection,
                clips: document
                  .getRoot()
                  .listAnimations()
                  .map((entry) => entry.getName())
                  .sort(),
              };
            });
            expect(revisedFacts.inspection.textures).toBeGreaterThanOrEqual(1);
            expect(revisedFacts.inspection.skins).toBeGreaterThanOrEqual(1);
            expect(revisedFacts.clips).toEqual(["Run", "Survey", "Walk"]);

            yield* Effect.promise(async () => {
              await NodeFSP.writeFile(
                NodePath.join(created.root, "godot/tests/fox_pose_test.gd"),
                FOX_POSE_TEST,
              );
            });
            const reimported = yield* game.import(threadId);
            expect(reimported.success, reimported.message).toBe(true);
            const posed = yield* game.test(threadId, "tests/fox_pose_test.gd");
            expect(posed.success, posed.message).toBe(true);
            expect(posed.process?.stdout).toContain("FOX PASS");
          }).pipe(Effect.provide(dependencies)),
        );
      } finally {
        if (process.env.GAME_STUDIO_KEEP_TEST !== "1")
          yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
      }
    }),
  600000,
);
