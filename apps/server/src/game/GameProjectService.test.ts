// @effect-diagnostics nodeBuiltinImport:off -- Test portable projects using actual temporary folders and Git.
import { it, expect } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProviderInstanceId, type GameTemplateId } from "@t3tools/contracts";
import { projectTestLayer } from "./gameTestLayers.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { scaffoldFiles } from "./scaffold.ts";
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const gameProjectLayer = (registration = projectTestLayer()) =>
  GameProjectService.layer.pipe(
    Layer.provide(registration),
    Layer.provideMerge(GameProcesses.layer),
    Layer.provide(NodeServices.layer),
  );
const readFile = (file: string) => Effect.promise(() => NodeFSP.readFile(file, "utf8"));
const exists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.access(path).then(
      () => true,
      () => false,
    ),
  );
it.effect(
  "scaffolds a portable Godot game, commits it, registers it, and launches the selected model with its brief",
  () =>
    Effect.gen(function* () {
      const parent = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-project-")),
      );
      let launch: ThreadLaunchService.ThreadLaunchInput | undefined;
      try {
        const created = yield* Effect.scoped(
          Effect.gen(function* () {
            const projects = yield* GameProjectService.GameProjectService;
            const game = yield* projects.create({
              name: "Tiny Quest",
              parentDirectory: parent,
              brief: "Collect three coins.",
              artDirection: "Clay",
              modelSelection: selection,
            });
            const reopened = yield* projects.open({ path: game.root, modelSelection: selection });
            expect(reopened.projectId).toBe(game.projectId);
            const asset = {
              id: "coin",
              kind: "model" as const,
              source: "art/blender/coin.blend",
              script: "art/scripts/coin.py",
              export: "godot/assets/models/coin.glb",
              updatedAt: "2026-10-19T00:00:00Z",
            };
            yield* projects.upsertAsset(game.root, asset);
            yield* projects.upsertAsset(game.root, { ...asset, updatedAt: "2026-10-19T01:00:00Z" });
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(game.root, "godot/scenes/coin.tscn"),
                '[gd_scene format=3]\n[ext_resource type="PackedScene" path="res://assets/models/coin.glb" id="1"]\n[node name="Coin" instance=ExtResource("1")]\n',
              ),
            );
            const inventory = yield* projects.inventory(game.root);
            expect(inventory.assets).toHaveLength(1);
            expect(inventory.assets[0]?.updatedAt).toBe("2026-10-19T01:00:00Z");
            expect(inventory.assets[0]?.usedBy).toEqual(["godot/scenes/coin.tscn"]);
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(game.root, "godot/scripts/cube.gd"),
                'extends Node3D\nvar model = preload("res://assets/models/coin.glb").instantiate()\n',
              ),
            );
            const scriptedInventory = yield* projects.inventory(game.root);
            expect(scriptedInventory.assets[0]?.usedBy).toEqual([
              "godot/scenes/coin.tscn",
              "godot/scripts/cube.gd",
            ]);
            // The template survives a manifest re-encode (upsertAsset above).
            expect((yield* projects.read(game.root)).template).toBe("blank");
            const processes = yield* GameProcesses.GameProcesses;
            const commit = yield* processes.run({
              root: game.root,
              executable: "git",
              args: ["log", "-1", "--format=%s"],
              operation: "test-git",
            });
            expect(commit.stdout.trim()).toBe("chore: create game project");
            return game;
          }).pipe(
            Effect.provide(
              gameProjectLayer(
                projectTestLayer((input) => {
                  if (input.initialMessage) launch = input;
                }),
              ),
            ),
          ),
        );
        expect(created.root).toBe(NodePath.join(parent, "tiny-quest"));
        expect(launch?.modelSelection).toEqual(selection);
        expect(launch?.runtimeMode).toBe("full-access");
        expect(launch?.initialMessage?.text).toContain("Collect three coins.");
        expect(launch?.initialMessage?.text).toContain("Clay");
        expect(yield* readFile(NodePath.join(created.root, "CLAUDE.md"))).toBe("@AGENTS.md\n");
        expect(yield* readFile(NodePath.join(created.root, "godot/project.godot"))).toContain(
          "gl_compatibility",
        );
        const presets = yield* readFile(NodePath.join(created.root, "godot/export_presets.cfg"));
        expect(presets).toContain('name="Web"');
        expect(presets).toContain('name="Linux"');
        expect(presets).toContain("variant/thread_support=false");
        // The blank starter template becomes the game's godot/ tree with the name substituted.
        expect(yield* readFile(NodePath.join(created.root, "godot/project.godot"))).toContain(
          'config/name="Tiny Quest"',
        );
        expect(yield* exists(NodePath.join(created.root, "godot/scenes/main.tscn"))).toBe(true);
        expect(yield* readFile(NodePath.join(created.root, "TEMPLATE.md"))).toContain(
          "# Tiny Quest — Blank starter template",
        );
        expect(
          Object.keys(
            scaffoldFiles({
              name: "Game",
              parentDirectory: parent,
              brief: "Go",
              modelSelection: selection,
            }),
          ),
        ).toContain("AGENTS.md");
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
      }
    }),
);
it.effect("rejects absent or invalid manifests and paths outside a game", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-invalid-")),
    );
    try {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const projects = yield* GameProjectService.GameProjectService;
          const read = yield* Effect.result(projects.read(root));
          expect(read._tag).toBe("Failure");
          yield* Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(root, "game.json"), '{"schemaVersion":999}'),
          );
          const invalid = yield* Effect.result(projects.read(root));
          expect(invalid._tag).toBe("Failure");
          expect(() => GameProjectService.insideGame(root, "../escape")).toThrow();
        }).pipe(Effect.provide(gameProjectLayer())),
      );
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
    }
  }),
);

it.effect("reopens a registered workspace after reconstructing the game service", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-reopen-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const registration = projectTestLayer();
    const freshService = () => gameProjectLayer(registration).pipe(Layer.fresh);
    const created = yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* GameProjectService.GameProjectService;
        return yield* service.create({
          name: "Reopen",
          parentDirectory: parent,
          brief: "Go",
          modelSelection: selection,
        });
      }).pipe(Effect.provide(freshService())),
    );
    const reopened = yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* GameProjectService.GameProjectService;
        return yield* service.open({ path: created.root, modelSelection: selection });
      }).pipe(Effect.provide(freshService())),
    );
    expect(reopened.projectId).toBe(created.projectId);
  }).pipe(Effect.scoped),
);

it.effect("passes the chosen runtime mode to the game thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const parent = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-mode-"))),
        (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
      let launch: ThreadLaunchService.ThreadLaunchInput | undefined;
      yield* Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        yield* projects.create({
          name: "Supervised",
          parentDirectory: parent,
          brief: "Go",
          modelSelection: selection,
          runtimeMode: "approval-required",
        });
      }).pipe(
        Effect.provide(
          gameProjectLayer(
            projectTestLayer((input) => {
              launch = input;
            }),
          ),
        ),
      );
      expect(launch?.runtimeMode).toBe("approval-required");
    }),
  ),
);

it.effect("rejects an unknown starter template and removes the folder it created", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-template-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const failure = yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        return yield* Effect.result(
          projects.create({
            name: "Future Game",
            parentDirectory: parent,
            brief: "Go",
            // A template id this build does not ship.
            template: "3d-explorer" as GameTemplateId,
            modelSelection: selection,
          }),
        );
      }).pipe(Effect.provide(gameProjectLayer())),
    );
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect(failure.failure.operation).toBe("copy-template");
      expect(failure.failure.reason).toBe("unknown-template");
    }
    expect(yield* exists(NodePath.join(parent, "future-game"))).toBe(false);
  }),
);

it.effect("keeps a pre-existing folder when creation cannot adopt it", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-occupied-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const root = NodePath.join(parent, "occupied");
    yield* Effect.promise(() => NodeFSP.mkdir(root));
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "keep.txt"), "keep"));
    const failure = yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        return yield* Effect.result(
          projects.create({
            name: "Occupied",
            parentDirectory: parent,
            brief: "Go",
            modelSelection: selection,
          }),
        );
      }).pipe(Effect.provide(gameProjectLayer())),
    );
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") expect(failure.failure.reason).toBe("io");
    expect(yield* readFile(NodePath.join(root, "keep.txt"))).toBe("keep");
  }),
);
