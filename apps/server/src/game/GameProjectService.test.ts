// @effect-diagnostics nodeBuiltinImport:off -- Test portable projects using actual temporary folders and Git.
import { it, expect } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  DEFAULT_GAME_TEMPLATE,
  ProviderInstanceId,
  ThreadId,
  type GameTemplateId,
} from "@t3tools/contracts";
import { projectTestLayer } from "./gameTestLayers.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
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
            // The stage letterboxes to the game's design resolution, and a game
            // with no web build yet is stale by definition.
            expect(inventory.viewport).toEqual({ width: 1280, height: 720 });
            expect(inventory.webBuildStale).toBe(true);
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
            expect((yield* projects.read(game.root)).template).toBe(DEFAULT_GAME_TEMPLATE);
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
        // Planning is the default, so the first turn asks for DESIGN.md, not a build.
        expect(launch?.initialMessage?.text).toContain("DESIGN.md");
        expect(launch?.initialMessage?.text).toContain("Keep the scaffold's section headings");
        expect(launch?.initialMessage?.text).not.toContain("Build a playable game");
        // The design turn fills the scaffold instead of inventing its own structure;
        // both the prompt and the game's AGENTS.md have to say so.
        const design = yield* readFile(NodePath.join(created.root, "DESIGN.md"));
        expect(design).toContain("## Pitch");
        expect(design).toContain("## Milestones");
        expect(design).toContain("Keep these headings");
        expect(yield* readFile(NodePath.join(created.root, "AGENTS.md"))).toContain(
          "Keep the scaffold's section headings",
        );
        expect(yield* readFile(NodePath.join(created.root, "CLAUDE.md"))).toBe("@AGENTS.md\n");
        expect(yield* readFile(NodePath.join(created.root, "godot/project.godot"))).toContain(
          "gl_compatibility",
        );
        const presets = yield* readFile(NodePath.join(created.root, "godot/export_presets.cfg"));
        expect(presets).toContain('name="Web"');
        expect(presets).toContain('name="Linux"');
        expect(presets).toContain("variant/thread_support=false");
        // The default starter template becomes the game's godot/ tree with the name substituted.
        expect(yield* readFile(NodePath.join(created.root, "godot/project.godot"))).toContain(
          'config/name="Tiny Quest"',
        );
        expect(yield* exists(NodePath.join(created.root, "godot/scenes/main_menu.tscn"))).toBe(
          true,
        );
        expect(yield* exists(NodePath.join(created.root, "godot/tests/smoke_test.gd"))).toBe(true);
        expect(yield* readFile(NodePath.join(created.root, "TEMPLATE.md"))).toContain(
          "# Tiny Quest — 3D Explorer starter template",
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
    expect(reopened.threadId).toBe(created.threadId);
  }).pipe(Effect.scoped),
);

it.effect("opening an existing game resumes its newest session instead of starting another", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-resume-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const launches: ThreadLaunchService.ThreadLaunchInput[] = [];
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* GameProjectService.GameProjectService;
        const game = yield* service.create({
          name: "Resume Me",
          parentDirectory: parent,
          brief: "Keep going.",
          modelSelection: selection,
        });
        const opened = yield* service.open({ path: game.root, modelSelection: selection });
        const reopened = yield* service.open({ path: game.root, modelSelection: selection });
        return { game, opened, reopened };
      }).pipe(
        Effect.provide(
          gameProjectLayer(
            projectTestLayer((input) => {
              launches.push(input);
            }),
          ),
        ),
      ),
    );
    expect(result.opened.threadId).toBe(result.game.threadId);
    expect(result.reopened.threadId).toBe(result.game.threadId);
    expect(result.opened.projectId).toBe(result.game.projectId);
    expect(launches).toHaveLength(1);
  }),
);

it.effect("a project with no session gets one when the game is opened", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-new-session-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    let launches = 0;
    const created = yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* GameProjectService.GameProjectService;
        const game = yield* service.create({
          name: "Sessionless",
          parentDirectory: parent,
          brief: "Go",
          modelSelection: selection,
        });
        // The mock had no session yet; opening the same project must create one.
        const opened = yield* service.open({ path: game.root, modelSelection: selection });
        expect(opened.projectId).toBe(game.projectId);
        expect(opened.threadId).toBe(game.threadId);
        return game;
      }).pipe(
        Effect.provide(
          gameProjectLayer(
            projectTestLayer(
              () => {
                launches += 1;
              },
              undefined,
              { threads: () => [] },
            ),
          ),
        ),
      ),
    );
    expect(created.root).toBe(NodePath.join(parent, "sessionless"));
    expect(launches).toBe(2);
  }),
);

it.effect("lists games with their template, design state, activity and rendered cover", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-list-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const games = yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* GameProjectService.GameProjectService;
        const game = yield* service.create({
          name: "Library Game",
          parentDirectory: parent,
          brief: "Go",
          modelSelection: selection,
        });
        yield* service.upsertAsset(game.root, {
          id: "coin",
          kind: "model",
          source: "art/blender/coin.blend",
          script: "art/scripts/coin.py",
          export: "godot/assets/models/coin.glb",
          thumbnail: "art/previews/coin.png",
          updatedAt: "2026-10-19T00:00:00.000Z",
        });
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(game.root, "art/previews/coin.png"), "png"),
        );
        return yield* service.list();
      }).pipe(Effect.provide(gameProjectLayer())),
    );
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      name: "Library Game",
      template: DEFAULT_GAME_TEMPLATE,
      designStatus: "draft",
      coverImagePath: "art/previews/coin.png",
    });
    // The mock's session is newer than the project row, so activity follows it.
    expect(games[0]?.updatedAt).toBe("2026-10-20T00:00:00.000Z");
  }),
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

it.effect("creates a game from an explicitly requested starter template", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-blank-")),
    );
    try {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const projects = yield* GameProjectService.GameProjectService;
          const created = yield* projects.create({
            name: "Plain Quest",
            parentDirectory: parent,
            brief: "Go",
            template: "blank",
            modelSelection: selection,
          });
          expect((yield* projects.read(created.root)).template).toBe("blank");
          expect(yield* exists(NodePath.join(created.root, "godot/scenes/main.tscn"))).toBe(true);
          expect(yield* readFile(NodePath.join(created.root, "TEMPLATE.md"))).toContain(
            "Blank starter template",
          );
        }).pipe(Effect.provide(gameProjectLayer())),
      );
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
    }
  }),
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
            template: "not-a-template" as GameTemplateId,
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

it.effect("starts a skip-planning game approved, without a design turn", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-skip-design-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    let launch: ThreadLaunchService.ThreadLaunchInput | undefined;
    const created = yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const game = yield* projects.create({
          name: "Straight To Build",
          parentDirectory: parent,
          brief: "Jump over the crates.",
          planFirst: false,
          modelSelection: selection,
        });
        return { game, inventory: yield* projects.inventory(game.root) };
      }).pipe(
        Effect.provide(
          gameProjectLayer(
            projectTestLayer((input) => {
              launch = input;
            }),
          ),
        ),
      ),
    );
    expect(created.inventory.manifest.design).toEqual({ status: "approved" });
    expect(created.inventory.designPath).toBeNull();
    expect(created.inventory.briefPath).toBe("BRIEF.md");
    expect(launch?.initialMessage?.text).toContain("Build a playable game");
    expect(launch?.initialMessage?.text).not.toContain("DESIGN.md");
    expect(yield* exists(NodePath.join(created.game.root, "DESIGN.md"))).toBe(false);
  }),
);

it.effect("approves a draft design once and starts exactly one build turn", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-approve-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const sends: ThreadManagementService.ThreadManagementSendInput[] = [];
    let gameRoot = "";
    yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const created = yield* projects.create({
          name: "Planned Quest",
          parentDirectory: parent,
          brief: "Collect three coins.",
          modelSelection: selection,
        });
        gameRoot = created.root;
        yield* projects.upsertAsset(created.root, {
          id: "coin",
          kind: "model",
          source: "art/blender/coin.blend",
          script: "art/scripts/coin.py",
          export: "godot/assets/models/coin.glb",
          updatedAt: "2026-10-20T09:00:00Z",
        });
        const approval = yield* projects.approveDesign(created.threadId);
        const manifest = yield* projects.read(created.root);
        expect(manifest.design).toEqual({ status: "approved", approvedAt: approval.approvedAt });
        expect(manifest.assets).toHaveLength(1);
        const again = yield* Effect.result(projects.approveDesign(created.threadId));
        expect(again._tag).toBe("Failure");
        if (again._tag === "Failure") expect(again.failure.reason).toBe("design-already-approved");
      }).pipe(
        Effect.provide(gameProjectLayer(projectTestLayer(undefined, (input) => sends.push(input)))),
      ),
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]?.threadId).toBe(ThreadId.make("game-test-thread"));
    expect(sends[0]?.text).toContain("The design is approved");
    expect(sends[0]?.text).toContain("milestone 1");
    expect(sends[0]?.createdBy).toBe("user");
    expect(sends[0]?.attachments).toEqual([]);
    expect(gameRoot).not.toBe("");
  }),
);
