// @effect-diagnostics nodeBuiltinImport:off -- Test portable projects using actual temporary folders and Git.
import { it, expect } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProviderInstanceId } from "@t3tools/contracts";
import { projectTestLayer } from "./gameTestLayers.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { scaffoldFiles } from "./scaffold.ts";
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
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
              GameProjectService.layer.pipe(
                Layer.provide(
                  projectTestLayer((input) => {
                    launch = input;
                  }),
                ),
                Layer.provideMerge(GameProcesses.layer),
              ),
            ),
          ),
        );
        expect(created.root).toBe(NodePath.join(parent, "tiny-quest"));
        expect(launch?.modelSelection).toEqual(selection);
        expect(launch?.initialMessage?.text).toContain("Collect three coins.");
        expect(launch?.initialMessage?.text).toContain("Clay");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(created.root, "CLAUDE.md"), "utf8"),
          ),
        ).toBe("@AGENTS.md\n");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(created.root, "godot/project.godot"), "utf8"),
          ),
        ).toContain("gl_compatibility");
        const presets = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(created.root, "godot/export_presets.cfg"), "utf8"),
        );
        expect(presets).toContain('name="Web"');
        expect(presets).toContain('name="Linux"');
        expect(presets).toContain("variant/thread_support=false");
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
        }).pipe(
          Effect.provide(
            GameProjectService.layer.pipe(
              Layer.provide(projectTestLayer()),
              Layer.provide(GameProcesses.layer),
            ),
          ),
        ),
      );
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
    }
  }),
);
