// @effect-diagnostics nodeBuiltinImport:off -- Runs the real installed Godot against a real temporary game.
import { it, expect } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameService from "./GameService.ts";
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

const godotExecutable = NodePath.join(
  GameToolchain.toolsDirectory(),
  `godot-${GameToolchain.GODOT_VERSION}/Godot_v${GameToolchain.GODOT_VERSION}-stable_linux.x86_64`,
);
const available = NodeFS.existsSync(godotExecutable);

it.live.skipIf(!available)(
  "checks and inspects a template game, then reports a deliberately broken script with its file and line",
  () =>
    Effect.gen(function* () {
      const parent = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "godot-check-")),
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
              name: "Check Runner",
              parentDirectory: parent,
              template: "3d-explorer",
              brief: "Collect the relics.",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6.1-sol",
              },
            });

            const checked = yield* game.check(created.threadId);
            expect(checked.ok, JSON.stringify(checked.errors)).toBe(true);
            expect(checked.errors).toEqual([]);
            expect(checked.entries).toEqual(["main", "gameplay"]);
            expect(checked.durationMs).toBeGreaterThan(0);

            // Every starter template reaches the same bar: its own gameplay
            // entry initializes and its player (when it has one) has a usable
            // collider. Blank has no menu, so its gameplay entry is its main scene.
            for (const template of ["2d-platformer", "blank"] as const) {
              const other = yield* projects.create({
                name: `Check Runner ${template}`,
                parentDirectory: parent,
                template,
                brief: "Run the template.",
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-6.1-sol",
                },
              });
              const otherCheck = yield* game.check(other.threadId);
              expect(otherCheck.ok, JSON.stringify(otherCheck.errors)).toBe(true);
              expect(otherCheck.entries).toEqual(["main", "gameplay"]);
            }

            const inspected = yield* game.inspectScene(
              created.threadId,
              "res://scenes/main_menu.tscn",
            );
            expect(inspected.scenePath).toBe("res://scenes/main_menu.tscn");
            expect(inspected.nodeCount).toBeGreaterThan(3);
            expect(inspected.nodes).toHaveLength(inspected.nodeCount);
            expect(inspected.truncated).toBe(false);
            expect(inspected.nodes[0]).toMatchObject({ path: ".", type: "Control" });
            expect(inspected.nodes.some((node) => node.name === "SettingsPanel")).toBe(true);

            const player = yield* game.inspectScene(
              created.threadId,
              "res://scenes/player/player.tscn",
            );
            const body = player.nodes.find((node) => node.name === "Player");
            expect(body).toMatchObject({
              type: "CharacterBody3D",
              script: "res://scripts/player.gd",
              collisionLayer: 2,
              collisionMask: 1,
            });
            expect(body?.position).toHaveLength(3);
            expect(body?.children).toContain("Collision");

            // The dump is capped, and the total still tells the agent how much it did not see.
            const crowded = ["[gd_scene format=3]", '[node name="Crowded" type="Node"]'];
            for (let index = 0; index < 405; index++)
              crowded.push(`[node name="Node${index}" type="Node" parent="."]`);
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(created.root, "godot/scenes/crowded.tscn"),
                crowded.join("\n"),
              ),
            );
            const limited = yield* game.inspectScene(created.threadId, "res://scenes/crowded.tscn");
            expect(limited.truncated).toBe(true);
            expect(limited.nodeCount).toBe(406);
            expect(limited.nodes).toHaveLength(400);

            // A script the engine can load, but with an action the project never defines.
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(created.root, "godot/scripts/missing_input.gd"),
                'extends Node\n\nfunc _ready() -> void:\n\tif Input.is_action_pressed("does_not_exist"):\n\t\tpass\n',
              ),
            );
            const linted = yield* game.check(created.threadId);
            expect(linted.ok, JSON.stringify(linted.errors)).toBe(true);
            expect(linted.warnings).toContainEqual(
              expect.objectContaining({
                file: "res://scripts/missing_input.gd",
                message: expect.stringContaining('"does_not_exist"'),
              }),
            );

            // The review-r1 probe: a failure that only happens once gameplay
            // initializes. The menu never touches this code, so a check that only
            // runs the main scene reports it as clean.
            const playerScript = NodePath.join(created.root, "godot/scripts/player.gd");
            const playerSource = yield* Effect.promise(() =>
              NodeFSP.readFile(playerScript, "utf8"),
            );
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                playerScript,
                playerSource.replace(
                  "func _ready() -> void:\n",
                  'func _ready() -> void:\n\tpush_error("R1 gameplay ready error")\n\tvar missing = null\n\tmissing.explode()\n',
                ),
              ),
            );
            const failedGameplay = yield* game.check(created.threadId);
            expect(failedGameplay.ok).toBe(false);
            expect(failedGameplay.entries).toEqual(["main", "gameplay"]);
            // push_error is the review's probe: Godot reports it without a script
            // location, because the innermost frame is the builtin itself.
            expect(failedGameplay.errors).toContainEqual(
              expect.objectContaining({
                message: expect.stringContaining("R1 gameplay ready error"),
              }),
            );
            // A real script failure in the same entry does carry its source.
            expect(failedGameplay.errors).toContainEqual(
              expect.objectContaining({
                file: "res://scripts/player.gd",
                message: expect.stringContaining("explode"),
              }),
            );
            yield* Effect.promise(() => NodeFSP.writeFile(playerScript, playerSource));

            // A player without a usable collider is not a player. Disabled first,
            // then a shape nested under Visual, which the body does not own.
            const playerScene = NodePath.join(created.root, "godot/scenes/player/player.tscn");
            const sceneSource = yield* Effect.promise(() => NodeFSP.readFile(playerScene, "utf8"));
            const collisionBlock =
              '[node name="Collision" type="CollisionShape3D" parent="."]\nposition = Vector3(0, 0.9, 0)\nshape = SubResource("shape_body")\n';
            expect(sceneSource).toContain(collisionBlock);
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                playerScene,
                sceneSource.replace(
                  collisionBlock,
                  '[node name="Collision" type="CollisionShape3D" parent="."]\nposition = Vector3(0, 0.9, 0)\ndisabled = true\nshape = SubResource("shape_body")\n',
                ),
              ),
            );
            const disabledCollider = yield* game.check(created.threadId);
            expect(disabledCollider.ok).toBe(false);
            expect(disabledCollider.errors).toContainEqual(
              expect.objectContaining({
                file: "res://scenes/game.tscn",
                message: expect.stringContaining("is in the player group"),
              }),
            );

            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                playerScene,
                `${sceneSource.replace(collisionBlock, "")}\n[node name="NestedCollision" type="CollisionShape3D" parent="Visual"]\nshape = SubResource("shape_body")\n`,
              ),
            );
            const nestedCollider = yield* game.check(created.threadId);
            expect(nestedCollider.ok).toBe(false);
            expect(nestedCollider.errors).toContainEqual(
              expect.objectContaining({
                file: "res://scenes/game.tscn",
                message: expect.stringContaining("is in the player group"),
              }),
            );
            yield* Effect.promise(() => NodeFSP.writeFile(playerScene, sceneSource));

            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(created.root, "godot/scripts/broken.gd"),
                "extends Node\n\nfunc _ready() -> void:\n\tthis is not gdscript\n",
              ),
            );
            const broken = yield* game.check(created.threadId);
            expect(broken.ok).toBe(false);
            const reported = broken.errors.find((issue) => issue.file.endsWith("broken.gd"));
            expect(reported).toMatchObject({ file: "res://scripts/broken.gd", line: 4 });
            expect(reported?.message).toContain("Parse Error");
          }).pipe(Effect.provide(dependencies)),
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
      }
    }),
  300_000,
);
