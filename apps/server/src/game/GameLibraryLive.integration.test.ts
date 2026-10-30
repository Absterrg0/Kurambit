// @effect-diagnostics nodeBuiltinImport:off -- Heavy upstream verification. Root runs this once with live network and engines; it never skips on API failure.
// @effect-diagnostics globalFetch:off -- The service streams the pinned downloads; this file only stages the game.
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
import * as GameAssetLibrary from "./GameAssetLibrary.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GamePreview from "./GamePreview.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  admissionTestLayer,
  previewBrowserTestLayer,
  projectTestLayer,
  designApprovalTestLayer,
  roundStoreTestLayer,
  qualificationTestLayer,
} from "./gameTestLayers.ts";

const managed = GameToolchain.toolsDirectory();
const toolsAvailable = NodeFS.existsSync(
  NodePath.join(managed, "godot-4.7.2/Godot_v4.7.2-stable_linux.x86_64"),
);
// Opt-in live run: root sets GAME_STUDIO_LIVE_LIBRARY=1. Inside the run an
// unavailable API is a failure, never a skip.
const liveEnabled = process.env.GAME_STUDIO_LIVE_LIBRARY === "1";

// Pinned small production choices: a 1473-triangle prop at 1k glTF (~0.6 MB)
// and a 1m-cover PBR set at 1k JPEG (~1.3 MB). Both CC0, both under the caps.
const MODEL_SLUG = "barrel_03";
const MATERIAL_SLUG = "brown_planks_03";

const EDIT_MATERIAL_SCRIPT = `extends SceneTree
func _initialize() -> void:
	var material := load("res://assets/library/materials/brown_planks_03/brown_planks_03_1k.tres") as StandardMaterial3D
	var property := OS.get_cmdline_user_args()[0]
	match property:
		"roughness": material.roughness = 0.25
		"metallic": material.metallic = 0.9
		"albedo_color": material.albedo_color = Color(0.5, 0.7, 0.2)
		"transparency": material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	quit(0 if ResourceSaver.save(material, material.resource_path) == OK else 1)
`;

const CONSUMER_SCRIPT = `extends SceneTree
func _initialize() -> void:
	var packed := load("res://assets/library/models/barrel_03/barrel_03_1k.gltf") as PackedScene
	if packed == null:
		push_error("The library model does not load.")
		quit(1)
		return
	var finish := load("res://assets/library/materials/brown_planks_03/brown_planks_03_1k.tres") as StandardMaterial3D
	if finish == null:
		push_error("The library material does not load.")
		quit(1)
		return
	var stage := Node3D.new()
	stage.name = "LibraryStage"
	root.add_child(stage)
	var barrel := packed.instantiate()
	barrel.name = "Barrel"
	stage.add_child(barrel)
	var shared := 0
	for index in range(3):
		var box := MeshInstance3D.new()
		box.name = "PlankBox%d" % index
		var mesh := BoxMesh.new()
		mesh.size = Vector3(1, 1, 0.1)
		box.mesh = mesh
		box.material_override = finish
		box.position = Vector3(float(index) * 1.5, 0.55, 2.0)
		stage.add_child(box)
		if box.material_override == finish:
			shared += 1
	var meshes := 0
	var stack: Array = [stage]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		if node is MeshInstance3D:
			meshes += 1
		for child in node.get_children():
			stack.append(child)
	print("LIBRARY_LIVE boxes=3 shared=%d meshes=%d" % [shared, meshes])
	if shared != 3 or meshes < 4:
		push_error("Expected 3 boxes sharing one material plus the barrel.")
		quit(1)
		return
	print("LIBRARY_LIVE PASS: one material finishes three objects beside the model")
	var camera := Camera3D.new()
	stage.add_child(camera)
	camera.transform = Transform3D(Basis.IDENTITY, Vector3(4.5, 3.5, 7)).looking_at(Vector3(1.4, 0.3, 1))
	camera.current = true
	var light := DirectionalLight3D.new()
	light.rotation_degrees = Vector3(-50, -30, 0)
	stage.add_child(light)
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color(0.11, 0.14, 0.18)
	world.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	world.environment.ambient_light_color = Color.WHITE
	world.environment.ambient_light_energy = 0.6
	stage.add_child(world)
	for child in stage.get_children():
		child.owner = stage
	var scene := PackedScene.new()
	if scene.pack(stage) != OK or ResourceSaver.save(scene, "res://scenes/library-proof.tscn") != OK:
		quit(1)
		return
	stage.free()
	quit(0)
`;

it.live.skipIf(!liveEnabled)(
  "imports a real model and a real reusable PBR material, consumes them in Godot, and keeps the last good on failure",
  () =>
    Effect.gen(function* () {
      expect(
        toolsAvailable,
        "The live library test needs managed Godot 4.7.2 and its export templates.",
      ).toBe(true);
      const parent = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-studio-library-")),
      );
      const dependencies = GameService.layer.pipe(
        Layer.provideMerge(GameProjectService.layer),
        Layer.provideMerge(GameOperations.layer),
        Layer.provideMerge(GameToolchain.layer),
        Layer.provideMerge(GamePreview.layer),
        Layer.provideMerge(GameProcesses.layer),
        Layer.provideMerge(GameAssetLibrary.layer),
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
            const library = yield* GameAssetLibrary.GameAssetLibrary;
            const processes = yield* GameProcesses.GameProcesses;
            const tools = yield* GameToolchain.GameToolchain;
            const created = yield* projects.create({
              name: "Library Live Game",
              parentDirectory: parent,
              brief: "A game using upstream library props and finishes.",
              planFirst: false,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6.1-sol",
              },
            });
            const threadId = ThreadId.make("game-test-thread");
            const root = created.root;
            yield* Effect.log(`LIBRARY_LIVE_ROOT=${root}`);
            const templateImported = yield* game.import(threadId);
            expect(templateImported.success, templateImported.message).toBe(true);

            const search = yield* library.search({ q: "barrel", type: "models", limit: 5 });
            expect(search.hits.length).toBeGreaterThan(0);
            expect(search.hits.map((hit) => hit.slug)).toContain(MODEL_SLUG);
            const mixed = yield* library.search({ q: "wood", limit: 2 });
            expect(mixed.type).toBe("all");
            expect(mixed.hits.length).toBeGreaterThan(0);
            expect(mixed.hits.every((hit) => hit.kind === "model" || hit.kind === "texture")).toBe(
              true,
            );

            const modelGet = yield* library.get({ id: MODEL_SLUG });
            expect(modelGet.asset.type).toBe("model");
            expect(modelGet.files.length).toBeGreaterThan(0);

            const model = yield* game.importLibraryModel(threadId, { id: MODEL_SLUG });
            expect(model.alreadyPresent).toBe(false);
            expect(model.gltfResPath).toContain(`res://assets/library/models/${MODEL_SLUG}/`);
            const modelAgain = yield* game.importLibraryModel(threadId, { id: MODEL_SLUG });
            expect(modelAgain.alreadyPresent).toBe(true);
            expect(modelAgain.gltfResPath).toBe(model.gltfResPath);

            const material = yield* game.importLibraryMaterial(threadId, { id: MATERIAL_SLUG });
            expect(material.alreadyPresent).toBe(false);
            expect(material.maps).toEqual(["Diffuse", "nor_gl", "Rough"]);
            expect(material.physicalSizeM).toEqual([1, 1]);
            const materialAgain = yield* game.importLibraryMaterial(threadId, {
              id: MATERIAL_SLUG,
            });
            expect(materialAgain.alreadyPresent).toBe(true);

            const godot = yield* tools.executable("godot");
            const manifest = yield* projects.read(root);
            const cwd = NodePath.join(root, manifest.godotProject);
            const materialPath = NodePath.join(
              root,
              material.destination,
              `${MATERIAL_SLUG}_1k.tres`,
            );
            const originalMaterial = yield* Effect.promise(() => NodeFSP.readFile(materialPath));
            const editScript = NodePath.join(root, "builds/logs/edit-material.gd");
            yield* Effect.promise(() => NodeFSP.writeFile(editScript, EDIT_MATERIAL_SCRIPT));
            for (const property of ["roughness", "metallic", "albedo_color", "transparency"]) {
              try {
                const edited = yield* processes.run({
                  root,
                  executable: godot.path,
                  args: ["--headless", "--path", cwd, "--script", editScript, "--", property],
                  operation: "library-edit-probe",
                  timeoutMs: 120_000,
                });
                expect(edited.exitCode, edited.stderr).toBe(0);
                const editedBytes = yield* Effect.promise(() => NodeFSP.readFile(materialPath));
                const refused = yield* Effect.flip(
                  game.importLibraryMaterial(threadId, { id: MATERIAL_SLUG }),
                );
                expect(refused.detail).toContain(`property ${property} was modified`);
                expect(yield* Effect.promise(() => NodeFSP.readFile(materialPath))).toEqual(
                  editedBytes,
                );
              } finally {
                yield* Effect.promise(() => NodeFSP.writeFile(materialPath, originalMaterial));
              }
            }

            // The engine itself consumes both: one material finishes three
            // boxes beside the instanced model, in memory, with no
            // handwritten scene format.
            const scriptPath = NodePath.join(root, "builds/logs/library-consumer.gd");
            yield* Effect.promise(() => NodeFSP.writeFile(scriptPath, CONSUMER_SCRIPT));
            const consumer = yield* processes.run({
              root,
              executable: godot.path,
              args: ["--headless", "--path", cwd, "--script", scriptPath],
              operation: "library-consumer",
              timeoutMs: 120_000,
            });
            expect(consumer.exitCode, `${consumer.stdout}\n${consumer.stderr}`).toBe(0);
            expect(consumer.stdout).toContain("LIBRARY_LIVE PASS");

            const projectFile = NodePath.join(cwd, "project.godot");
            yield* Effect.promise(async () => {
              const project = await NodeFSP.readFile(projectFile, "utf8");
              await NodeFSP.writeFile(
                projectFile,
                project.replace(
                  /^run\/main_scene=.*$/m,
                  'run/main_scene="res://scenes/library-proof.tscn"',
                ),
              );
            });

            const exported = yield* game.export(threadId, "Web");
            expect(exported.success, exported.message).toBe(true);

            // Failure keeps the last good: an unknown slug and an edited
            // texture both refuse, and the published bytes never move.
            const gltfGamePath = NodePath.join(root, model.destination, `${MODEL_SLUG}_1k.gltf`);
            const goodGltf = yield* Effect.promise(() => NodeFSP.readFile(gltfGamePath));
            const goodManifest = yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8"),
            );
            const unknown = yield* Effect.flip(
              game.importLibraryModel(threadId, { id: "no_such_asset_xyz" }),
            );
            expect(unknown.reason).toBe("invalid-input");
            expect(yield* Effect.promise(() => NodeFSP.readFile(gltfGamePath))).toEqual(goodGltf);
            const texGamePath = NodePath.join(
              root,
              material.destination,
              `${MATERIAL_SLUG}_diff_1k.jpg`,
            );
            const goodTex = yield* Effect.promise(() => NodeFSP.readFile(texGamePath));
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                texGamePath,
                Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from("edited")]),
              ),
            );

            const refused = yield* Effect.flip(
              game.importLibraryMaterial(threadId, { id: MATERIAL_SLUG }),
            );
            expect(refused.reason).toBe("art-kit-conflict");
            expect(yield* Effect.promise(() => NodeFSP.readFile(texGamePath, "utf8"))).toContain(
              "edited",
            );
            yield* Effect.promise(() => NodeFSP.writeFile(texGamePath, goodTex));
            const healed = yield* game.importLibraryMaterial(threadId, { id: MATERIAL_SLUG });
            expect(healed.alreadyPresent).toBe(true);
            expect(
              yield* Effect.promise(() =>
                NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8"),
              ),
            ).toBe(goodManifest);
          }),
        ).pipe(Effect.provide(dependencies));
      } finally {
        if (process.env.GAME_STUDIO_KEEP_TEST !== "1") {
          yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
        }
      }
    }),
  { timeout: 600_000 },
);
