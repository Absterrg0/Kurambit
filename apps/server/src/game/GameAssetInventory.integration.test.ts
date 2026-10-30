// @effect-diagnostics nodeBuiltinImport:off -- Opt-in live check: real Godot loads real template scenes plus one SDK-built GLB. Root runs this; unit collection never launches an engine (skipIf on the binary check below, no engine use at import time).
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Document, NodeIO } from "@gltf-transform/core";
import {
  ProviderInstanceId,
  ThreadId,
  type GameManifest,
  type GameOperationError,
  type GameTemplateId,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as GameService from "./GameService.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  admissionTestLayer,
  previewBrowserTestLayer,
  projectTestLayer,
  qualificationTestLayer,
  designApprovalTestLayer,
  roundStoreTestLayer,
} from "./gameTestLayers.ts";

const available = NodeFS.existsSync(
  NodePath.join(GameToolchain.toolsDirectory(), "godot-4.7.2/Godot_v4.7.2-stable_linux.x86_64"),
);

const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };

const liveLayers = (stateDir: string) =>
  GameService.layer.pipe(
    Layer.provideMerge(GameProjectService.layer),
    Layer.provideMerge(GameOperations.layer),
    Layer.provideMerge(GameToolchain.layer),
    Layer.provideMerge(GamePreview.layer),
    Layer.provideMerge(GameProcesses.layer),
    Layer.provide(projectTestLayer()),
    Layer.provide(previewBrowserTestLayer()),
    Layer.provideMerge(qualificationTestLayer(stateDir)),
    Layer.provideMerge(designApprovalTestLayer(stateDir)),
    Layer.provideMerge(roundStoreTestLayer(stateDir)),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provideMerge(admissionTestLayer),
    Layer.provide(NodeServices.layer),
  );

/** One triangle standing 2m tall, built with the SDK — never hand-written bytes. */
const pebbleGlb = async (): Promise<Uint8Array> => {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0]))
    .setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", positions);
  primitive.setMaterial(document.createMaterial("Pebble").setBaseColorFactor([0.5, 0.5, 0.5, 1]));
  const mesh = document.createMesh("PebbleMesh").addPrimitive(primitive);
  document.createScene("Scene").addChild(document.createNode("Pebble").setMesh(mesh));
  return new Uint8Array(await new NodeIO().writeBinary(document));
};

/** Byte identity of every non-generated file: the probe must not touch sources. */
const snapshotSources = async (root: string): Promise<Map<string, string>> => {
  const entries = new Map<string, string>();
  const walk = async (directory: string) => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const absolute = NodePath.join(directory, entry.name);
      const relative = NodePath.relative(root, absolute).split(NodePath.sep).join("/");
      if (
        relative.split("/").includes(".godot") ||
        relative.endsWith(".import") ||
        relative.endsWith(".uid")
      )
        continue;
      if (entry.isDirectory()) {
        if (relative.split("/").includes("builds")) continue;
        await walk(absolute);
      } else if (entry.isFile()) {
        const bytes = await NodeFSP.readFile(absolute);
        entries.set(relative, NodeCrypto.createHash("sha256").update(bytes).digest("hex"));
      }
    }
  };
  await walk(root);
  return entries;
};

const writeFamilies = async (root: string, families: GameManifest["families"]) => {
  const manifestPath = NodePath.join(root, "game.json");
  const manifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8")) as GameManifest;
  await NodeFSP.writeFile(manifestPath, `${JSON.stringify({ ...manifest, families }, null, 2)}\n`);
};

const runLive = <A, E>(
  template: GameTemplateId,
  body: (input: {
    readonly root: string;
    readonly threadId: ThreadId;
  }) => Effect.Effect<
    A,
    E,
    | GameService.GameService
    | GameProjectService.GameProjectService
    | GameProcesses.GameProcesses
    | GameToolchain.GameToolchain
  >,
): Effect.Effect<A, E | GameOperationError | ServerSettingsError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const parent = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-inventory-live-")),
        ),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const stateDir = NodePath.join(parent, "state");
      return yield* Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const created = yield* projects.create({
          name: `Inventory live ${template}`,
          parentDirectory: parent,
          brief: "Live inventory check.",
          template,
          modelSelection: selection,
        });
        return yield* body({ root: created.root, threadId: created.threadId });
      }).pipe(Effect.provide(liveLayers(stateDir)));
    }),
  );

it.live.skipIf(!available)(
  "inspects a real 2D game: SpriteFrames animations, UI scenes, missing audio and transitions",
  () =>
    runLive("2d-platformer", ({ root, threadId }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        yield* Effect.promise(() =>
          writeFamilies(root, [
            {
              name: "player",
              kind: "character",
              paths: ["res://scenes/player/player.tscn"],
              animations: [{ name: "idle", loop: true }, { name: "run" }],
              collision: "required",
            },
            {
              name: "slime",
              kind: "character",
              paths: ["res://scenes/enemies/slime.tscn"],
              animations: [{ name: "fly" }],
              transitions: [{ from: "crawl", to: "fly" }],
              collision: "required",
              provenance: "required",
            },
            { name: "hud", kind: "ui", paths: ["res://scenes/ui/hud.tscn"] },
            { name: "jingle", kind: "audio", paths: ["res://assets/audio/jingle.ogg"] },
          ]),
        );
        const before = yield* Effect.promise(() => snapshotSources(root));
        const result = yield* game.assetsInspect(threadId, {
          paths: [
            "res://scenes/player/player.tscn",
            "res://scenes/enemies/slime.tscn",
            "res://scenes/ui/hud.tscn",
            "res://assets/sprites/player_frames.tres",
          ],
        });
        const after = yield* Effect.promise(() => snapshotSources(root));
        expect(after).toEqual(before);
        expect(["complete", "partial"], JSON.stringify(result.native)).toContain(
          result.native.status,
        );
        expect(result.native.checkedPaths).toContain("res://scenes/player/player.tscn");
        const player = result.families.find((family) => family.family === "player")!;
        expect(player.status).toBe("complete");
        expect(player.animations.status).toBe("yes");
        expect(player.collision.status).toBe("yes");
        const slime = result.families.find((family) => family.family === "slime")!;
        expect(slime.status).toBe("incomplete");
        expect(slime.missing.join("\n")).toContain("fly");
        const hud = result.families.find((family) => family.family === "hud")!;
        expect(hud.status).toBe("unknown");
        const jingle = result.families.find((family) => family.family === "jingle")!;
        expect(jingle.status).toBe("incomplete");
        expect(jingle.missing.join("\n")).toContain("missing file");
        expect(result.exportedUsage).toBe("unknown");
        expect(result.sourceMentions.length).toBeGreaterThan(0);
        expect(result.coverage.audioFiles).toBe(0);
      }),
    ),
);

it.live.skipIf(!available)(
  "inspects a real 3D game: GLB scale, materials, collision and pivot with a missing provenance",
  () =>
    runLive("3d-explorer", ({ root, threadId }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const glb = yield* Effect.promise(() => pebbleGlb());
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(root, "godot/assets/models/pebble"), {
            recursive: true,
          });
          await NodeFSP.writeFile(
            NodePath.join(root, "godot/assets/models/pebble/pebble.glb"),
            glb,
          );
        });
        yield* Effect.promise(() =>
          writeFamilies(root, [
            {
              name: "player",
              kind: "character",
              paths: ["res://scenes/player/player.tscn"],
              collision: "required",
            },
            {
              name: "pebble",
              kind: "prop",
              paths: ["res://assets/models/pebble/pebble.glb"],
              targetHeight: 2,
              provenance: "required",
            },
          ]),
        );
        const before = yield* Effect.promise(() => snapshotSources(root));
        const result = yield* game.assetsInspect(threadId, {
          paths: [
            "res://scenes/player/player.tscn",
            "res://assets/models/pebble/pebble.glb",
            "res://materials/player_suit.tres",
          ],
        });
        const after = yield* Effect.promise(() => snapshotSources(root));
        expect(after).toEqual(before);
        expect(["complete", "partial"], JSON.stringify(result.native)).toContain(
          result.native.status,
        );
        const player = result.families.find((family) => family.family === "player")!;
        expect(player.status).toBe("complete");
        expect(player.collision.status).toBe("yes");
        const pebble = result.families.find((family) => family.family === "pebble")!;
        expect(pebble.scale.status).toBe("yes");
        expect(pebble.status).toBe("incomplete");
        expect(pebble.missing.join("\n")).toContain("provenance");
        const suit = result.resources.find(
          (entry) => entry.resPath === "res://materials/player_suit.tres",
        );
        expect(suit?.godotClass).toBe("StandardMaterial3D");
        expect(result.exportedUsage).toBe("unknown");
      }),
    ),
);

it.live.skipIf(!available)(
  "measures native loops, state-machine wiring and transformed meshes without running scene scripts",
  () =>
    runLive("blank", ({ root, threadId }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const processes = yield* GameProcesses.GameProcesses;
        const toolchain = yield* GameToolchain.GameToolchain;
        const godot = yield* toolchain.executable("godot");
        const script = NodePath.join(root, "builds/logs/inventory-fixtures.gd");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(script), { recursive: true });
          await NodeFSP.writeFile(
            script,
            `extends SceneTree
func _initialize():
	var frames = SpriteFrames.new()
	frames.add_animation("idle")
	frames.set_animation_loop("idle", true)
	frames.add_animation("run")
	frames.set_animation_loop("run", false)
	ResourceSaver.save(frames, "res://frames.tres")
	var machine = AnimationNodeStateMachine.new()
	var idle = AnimationNodeAnimation.new()
	idle.animation = "idle"
	var run = AnimationNodeAnimation.new()
	run.animation = "run"
	machine.add_node("idle", idle)
	machine.add_node("run", run)
	var edge = AnimationNodeStateMachineTransition.new()
	edge.advance_condition = "moving"
	machine.add_transition("idle", "run", edge)
	ResourceSaver.save(machine, "res://machine.tres")
	var body = CharacterBody3D.new()
	body.name = "Hero"
	var mesh = MeshInstance3D.new()
	mesh.name = "Mesh"
	mesh.mesh = BoxMesh.new()
	mesh.mesh.size = Vector3(1, 1, 1)
	mesh.scale = Vector3(1, 2, 1)
	mesh.position = Vector3(0, 1, 0)
	body.add_child(mesh)
	mesh.owner = body
	var shape = CollisionShape3D.new()
	shape.shape = BoxShape3D.new()
	body.add_child(shape)
	shape.owner = body
	var tree = AnimationTree.new()
	tree.tree_root = machine
	body.add_child(tree)
	tree.owner = body
	var scene = PackedScene.new()
	scene.pack(body)
	ResourceSaver.save(scene, "res://hero.tscn")
	body.free()
	var audio = AudioStreamWAV.new()
	audio.mix_rate = 8000
	audio.data = PackedByteArray([0, 0, 1, 1, 0, 0, 255, 255])
	ResourceSaver.save(audio, "res://tone.tres")
	quit()
`,
          );
          await NodeFSP.writeFile(
            NodePath.join(root, "godot/tripwire.gd"),
            'extends Node\nfunc _init():\n\tFileAccess.open("res://unexpected-write.txt", FileAccess.WRITE).store_string("ran")\n',
          );
          await NodeFSP.writeFile(
            NodePath.join(root, "godot/tripwire.tscn"),
            '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://tripwire.gd" id="1"]\n[node name="Tripwire" type="Node"]\nscript = ExtResource("1")\n',
          );
        });
        const generated = yield* processes.run({
          root,
          executable: godot.path,
          args: ["--headless", "--path", NodePath.join(root, "godot"), "--script", script],
          operation: "inventory-fixtures",
          timeoutMs: 60000,
        });
        expect(generated.exitCode, generated.stderr).toBe(0);
        yield* Effect.promise(() =>
          writeFamilies(root, [
            {
              name: "frames",
              kind: "character",
              paths: ["res://frames.tres"],
              animations: [
                { name: "idle", loop: true },
                { name: "run", loop: false },
              ],
            },
            {
              name: "machine",
              kind: "character",
              paths: ["res://machine.tres"],
              transitions: [{ from: "idle", to: "run", condition: "moving" }],
            },
            {
              name: "wrong-trigger",
              kind: "character",
              paths: ["res://machine.tres"],
              transitions: [{ from: "idle", to: "run", condition: "hurt" }],
            },
            {
              name: "hero",
              kind: "character",
              paths: ["res://hero.tscn"],
              targetHeight: 2,
              pivot: "ground",
              collision: "required",
              transitions: [{ from: "idle", to: "run", condition: "moving" }],
            },
            {
              name: "uninspected",
              kind: "character",
              paths: ["res://hero.tscn", "res://frames.tres"],
              animations: [{ name: "idle" }],
            },
          ]),
        );
        const before = yield* Effect.promise(() => snapshotSources(root));
        const result = yield* game.assetsInspect(threadId, {
          paths: [
            "res://frames.tres",
            "res://machine.tres",
            "res://hero.tscn",
            "res://tone.tres",
            "res://tripwire.tscn",
          ],
        });
        expect(result.native.status, JSON.stringify(result.native)).toBe("complete");
        const family = (name: string) => result.families.find((entry) => entry.family === name)!;
        expect(family("frames").animations.status, JSON.stringify(result.native)).toBe("yes");
        expect(family("machine").transitions.status).toBe("yes");
        expect(family("wrong-trigger").transitions.status).toBe("unknown");
        expect(family("hero").scale.status, JSON.stringify(result.native.scales)).toBe("yes");
        expect(family("hero").pivot.status).toBe("yes");
        expect(family("hero").collision.status).toBe("yes");
        expect(family("hero").transitions.status).toBe("yes");
        expect(
          result.resources.find((entry) => entry.resPath === "res://tone.tres")?.godotClass,
        ).toBe("AudioStreamWAV");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.access(NodePath.join(root, "godot/unexpected-write.txt")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
        expect(yield* Effect.promise(() => snapshotSources(root))).toEqual(before);
        const narrowed = yield* game.assetsInspect(threadId, { paths: ["res://frames.tres"] });
        expect(
          narrowed.families.find((entry) => entry.family === "uninspected")?.animations.status,
        ).toBe("unknown");
      }),
    ),
);
