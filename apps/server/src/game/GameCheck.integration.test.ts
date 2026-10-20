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
import * as GamePreview from "./GamePreview.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  previewBrowserTestLayer,
  projectTestLayer,
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
        Layer.provideMerge(GameToolchain.layer),
        Layer.provideMerge(GamePreview.layer),
        Layer.provideMerge(GameProcesses.layer),
        Layer.provide(projectTestLayer()),
        Layer.provide(previewBrowserTestLayer()),
        Layer.provide(qualificationTestLayer()),
        Layer.provide(ServerSettings.layerTest()),
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
            expect(checked.durationMs).toBeGreaterThan(0);

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
  180_000,
);
