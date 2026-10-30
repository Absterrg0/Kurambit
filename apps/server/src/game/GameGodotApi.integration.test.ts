// @effect-diagnostics nodeBuiltinImport:off -- The real installed engine is queried in an isolated fixture.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as GameService from "./GameService.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as ServerSettings from "../serverSettings.ts";
import { snapshotBuildSource } from "./sourceSnapshot.ts";
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

it.live.skipIf(!available)(
  "queries real engine signatures, inherited members and typo suggestions without loading the game",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-api-live-"))),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const state = NodePath.join(parent, "state");
        const dependencies = GameService.layer.pipe(
          Layer.provideMerge(GameProjectService.layer),
          Layer.provideMerge(GameOperations.layer),
          Layer.provideMerge(GameToolchain.layer),
          Layer.provideMerge(GamePreview.layer),
          Layer.provideMerge(GameProcesses.layer),
          Layer.provide(projectTestLayer()),
          Layer.provide(previewBrowserTestLayer()),
          Layer.provideMerge(qualificationTestLayer(state)),
          Layer.provideMerge(designApprovalTestLayer(state)),
          Layer.provideMerge(roundStoreTestLayer(state)),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provideMerge(admissionTestLayer),
          Layer.provide(NodeServices.layer),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const projects = yield* GameProjectService.GameProjectService;
            const game = yield* GameService.GameService;
            const created = yield* projects.create({
              name: "API fixture",
              parentDirectory: parent,
              brief: "Engine API lookup",
              planFirst: false,
              modelSelection: { instanceId: ProviderInstanceId.make("test"), model: "test" },
            });
            const before = yield* Effect.promise(() => snapshotBuildSource(created.root, "godot"));
            expect(before.kind).toBe("known");
            const light = yield* game.godotApi(created.threadId, {
              className: "PointLight2D",
              memberFilter: "energy",
            });
            expect(light.found).toBe(true);
            expect(light.engineVersion).toContain("4.7.2");
            expect(light.parent).toBe("Light2D");
            expect(light.properties).toContainEqual({ name: "energy", type: "float" });
            expect(light.methods).toContainEqual({
              name: "get_energy",
              signature: "get_energy() -> float",
            });
            const sprite = yield* game.godotApi(created.threadId, {
              className: "SpriteFrames",
              memberFilter: "animation_loop",
            });
            expect(
              sprite.methods.some(
                (method) =>
                  method.name === "get_animation_loop" &&
                  method.signature.includes("StringName") &&
                  method.signature.endsWith("-> bool"),
              ),
            ).toBe(true);
            const body = yield* game.godotApi(created.threadId, {
              className: "CharacterBody2D",
              memberFilter: "move",
            });
            expect(
              body.methods.some(
                (method) =>
                  method.name === "move_and_collide" &&
                  method.signature.includes("Vector2") &&
                  method.signature.includes(" = "),
              ),
            ).toBe(true);
            const typo = yield* game.godotApi(created.threadId, { className: "PointLigh2D" });
            expect(typo.found).toBe(false);
            expect(typo.suggestions[0]).toBe("PointLight2D");
            const node = yield* game.godotApi(created.threadId, { className: "Node" });
            expect(node.truncated).toBe(true);
            expect(node.totalMethods).toBeGreaterThan(node.methods.length);
            expect(node.methods.length).toBeLessThanOrEqual(80);
            expect(yield* Effect.promise(() => snapshotBuildSource(created.root, "godot"))).toEqual(
              before,
            );
            expect(NodeFS.existsSync(NodePath.join(created.root, "godot/.godot"))).toBe(false);
            const processes = yield* GameProcesses.GameProcesses;
            expect(processes.list(created.root)).toEqual([]);
          }),
        ).pipe(Effect.provide(dependencies));
      }),
    ),
  { timeout: 120_000 },
);
