// @effect-diagnostics nodeBuiltinImport:off -- Test portable projects using actual temporary folders and Git.
import { it, expect } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import {
  DEFAULT_GAME_TEMPLATE,
  GameOperationError,
  ProviderInstanceId,
  ThreadId,
  type GameTemplateId,
} from "@t3tools/contracts";
import {
  designApprovalTestLayer,
  previewBrowserTestLayer,
  projectTestLayer,
  qualificationTestLayer,
} from "./gameTestLayers.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import { designIntentFile } from "./GameDesignApproval.ts";
import { scaffoldFiles } from "./scaffold.ts";
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
/** Record stores live inside the fixture directory that the test removes. */
const fixtureState = (fixture: string) => NodePath.join(fixture, ".test-state");
/** Enough of the real services to resolve a game and hit the draft gate without Godot. */
const gameServiceLayers = (options: {
  readonly stateDir: string;
  readonly onSend?: (input: ThreadManagementService.ThreadManagementSendInput) => void;
}) =>
  GameService.layer.pipe(
    Layer.provideMerge(GameProjectService.layer),
    Layer.provideMerge(GameOperations.layer),
    Layer.provideMerge(GameToolchain.layer),
    Layer.provideMerge(GamePreview.layer),
    Layer.provideMerge(GameProcesses.layer),
    Layer.provide(projectTestLayer(undefined, options.onSend)),
    Layer.provide(previewBrowserTestLayer()),
    Layer.provideMerge(qualificationTestLayer(options.stateDir)),
    Layer.provideMerge(designApprovalTestLayer(options.stateDir)),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(NodeServices.layer),
  );
const gameProjectLayer = (stateDir: string, registration = projectTestLayer()) =>
  GameProjectService.layer.pipe(
    Layer.provide(registration),
    Layer.provideMerge(GameProcesses.layer),
    Layer.provideMerge(designApprovalTestLayer(stateDir)),
    Layer.provideMerge(qualificationTestLayer(stateDir)),
    Layer.provideMerge(GameOperations.layer),
    Layer.provide(NodeServices.layer),
  );
/** A design that clears every scaffold heading and binds acceptance. */
const filledDesign = (name = "Planned Quest") => `# ${name} — design

## Pitch

You are a rooftop courier who lights lanterns to open the chimney gate. The pleasure is a clean
route across moving platforms, a growing string of lights below, and one more run after a fall.

## Core loop

Run and jump across three rooftops, light every lantern on a roof, then climb the chimney to the
next roof. Each roof raises the wind and adds a moving platform, so the same route keeps changing.

## Controls

Move with A and D or the left stick. Jump with Space, W or the south face button. Pause with
Escape or Start, and restart the current roof from the pause menu with R.

## Win & lose

The run is won when the chimney lantern on the third roof lights. Falling below the rooftops or
losing all three lives ends the run at the last checkpoint, and restart returns to roof one.

## Content

Three rooftops, nine lanterns total, two moving platforms, one wind gust per roof and a chimney
gate. The starter template supplies the courier controller, camera, pause menu and checkpoint
respawn; this game adds lanterns, the wind system and the chimney route.

## Acceptance

The build is judged against these criteria.

\`\`\`acceptance
[
  { "id": "move-and-jump", "kind": "control", "text": "A and D move the courier and Space jumps", "observe": { "key": "jumps", "expect": ">=1" } },
  { "id": "light-lanterns", "kind": "mechanic", "text": "Touching a lantern lights it and increments the count", "observe": { "key": "collected", "expect": ">=1" } },
  { "id": "nine-lanterns", "kind": "content", "text": "The courier collects all nine lanterns across the three rooftops", "observe": { "key": "collected", "expect": ">=9" } },
  { "id": "chimney-opens", "kind": "mechanic", "text": "Lighting every lantern on a roof opens its chimney", "observe": { "key": "level_index", "expect": ">=1" } },
  { "id": "reach-third-roof", "kind": "win", "text": "The run ends at the third roof's chimney lantern", "observe": { "key": "state", "expect": "==3" } },
  { "id": "out-of-lives", "kind": "lose", "text": "Losing all three lives ends the run", "observe": { "key": "lives", "expect": "<=0" } }
]
\`\`\`

## Art direction

Moonlit slate rooftops with warm amber lanterns, deep blue shadows and a pale gold chimney. Keep
silhouettes simple and readable at the game's small camera distance.

## Audio

A quiet wind bed, a rising chime per lantern, a low door rumble for each chimney and a short
victory phrase when the third roof lights.

## Scope

- **Must have** — three rooftops, nine lanterns, the jump controller and a finish.
- **Nice to have** — wind gusts and a second moving platform on roof three.
- **Cut** — enemies, inventories and generated audio beds.

## Milestones

1. **Playable core** — one roof, three lanterns and the chimney gate working end to end.
2. **Content** — all three rooftops, nine lanterns and the wind system.
3. **Polish** — audio, pause states and the checkpoint presentation.
`;

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
            // The stage letterboxes to the game's design resolution.
            expect(inventory.viewport).toEqual({ width: 1280, height: 720 });
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
            // The canonical suite is copied from the template metadata.
            expect((yield* projects.read(game.root)).testSuite).toBe("res://tests/smoke_test.gd");
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
                fixtureState(parent),
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
        }).pipe(Effect.provide(gameProjectLayer(fixtureState(root)))),
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
    const freshService = () =>
      gameProjectLayer(fixtureState(parent), registration).pipe(Layer.fresh);
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
            fixtureState(parent),
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
            fixtureState(parent),
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
      }).pipe(Effect.provide(gameProjectLayer(fixtureState(parent)))),
    );
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      name: "Library Game",
      template: DEFAULT_GAME_TEMPLATE,
      designState: "draft",
      operation: null,
      qualification: { state: "unqualified", asOf: null },
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
            fixtureState(parent),
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
        }).pipe(Effect.provide(gameProjectLayer(fixtureState(parent)))),
      );
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
    }
  }),
);
it.effect("a failed creation removes the intent record it wrote", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-failed-intent-")),
      ),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const stateDir = NodePath.join(parent, ".test-state");
    const root = NodePath.join(parent, "failed-create");
    const services = GameProjectService.layer.pipe(
      Layer.provide(projectTestLayer()),
      Layer.provide(
        Layer.mock(GameProcesses.GameProcesses)({
          // Git is the first step after the creation intent is written.
          run: () =>
            Effect.succeed({
              pid: 1,
              exitCode: 1,
              signal: null,
              timedOut: false,
              stdout: "",
              stderr: "injected git failure",
              logPath: NodePath.join(parent, "git.log"),
            }),
          list: () => [],
        }),
      ),
      Layer.provideMerge(designApprovalTestLayer(stateDir)),
      Layer.provideMerge(qualificationTestLayer(stateDir)),
      Layer.provideMerge(GameOperations.layer),
      Layer.provide(NodeServices.layer),
    );
    const failure = yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        return yield* Effect.result(
          projects.create({
            name: "Failed Create",
            parentDirectory: parent,
            brief: "Go",
            modelSelection: selection,
          }),
        );
      }).pipe(Effect.provide(services)),
    );
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") expect(failure.failure.operation).toBe("git-init");
    // The folder and the intent this attempt wrote are both gone; no other
    // record for this root is invented.
    expect(yield* exists(root)).toBe(false);
    expect(yield* exists(designIntentFile(stateDir, root))).toBe(false);
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
      }).pipe(Effect.provide(gameProjectLayer(fixtureState(parent)))),
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
      }).pipe(Effect.provide(gameProjectLayer(fixtureState(parent)))),
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
    const stateDir = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-skip-design-state-")),
      ),
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
            stateDir,
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
    // Skip planning is an explicit server-owned decision, not a missing record.
    expect(
      yield* Effect.promise(() =>
        GameDesignApproval.readDesignIntent(
          GameDesignApproval.designIntentFile(stateDir, created.game.root),
        ),
      ),
    ).toBe("skipped");
    expect(launch?.initialMessage?.text).toContain("Build a playable game");
    expect(launch?.initialMessage?.text).not.toContain("DESIGN.md");
    expect(yield* exists(NodePath.join(created.game.root, "DESIGN.md"))).toBe(false);
  }),
);

it.effect("deleting DESIGN.md on a plan-first game reads draft, not legacy", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-missing-design-")),
      ),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const stateDir = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-missing-design-state-")),
      ),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const game = yield* GameService.GameService;
        const created = yield* projects.create({
          name: "Planned Quest",
          parentDirectory: parent,
          brief: "Collect three coins.",
          modelSelection: selection,
        });
        expect(
          yield* Effect.promise(() =>
            GameDesignApproval.readDesignIntent(
              GameDesignApproval.designIntentFile(stateDir, created.root),
            ),
          ),
        ).toBe("required");
        yield* Effect.promise(() => NodeFSP.rm(NodePath.join(created.root, "DESIGN.md")));
        // A raw manifest edit to approved is the old forged-legacy route.
        const manifestFile = NodePath.join(created.root, "game.json");
        const raw = JSON.parse(yield* readFile(manifestFile)) as Record<string, unknown>;
        raw.design = { status: "approved", approvedAt: "2026-10-20T00:00:00.000Z" };
        yield* Effect.promise(() =>
          NodeFSP.writeFile(manifestFile, `${JSON.stringify(raw, null, 2)}\n`),
        );
        const status = yield* game.status(created.threadId);
        expect(status.design.state).toBe("draft");
        expect(status.design.issues.join("\n")).toContain("DESIGN.md is missing");
        expect(status.qualification.stages.find((s) => s.stage === "design")?.status).toBe(
          "failed",
        );
        // The approval path reads the same intent, so it reports the real
        // problem instead of treating this as a legacy game.
        const approval = yield* Effect.result(
          projects.approveDesign(
            created.threadId,
            "0000000000000000000000000000000000000000000000000000000000000000",
          ),
        );
        expect(approval._tag).toBe("Failure");
        if (approval._tag === "Failure") expect(approval.failure.reason).toBe("design-missing");
      }).pipe(Effect.provide(gameServiceLayers({ stateDir }))),
    );
  }),
);

const writeDesign = (root: string, design: string) =>
  Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "DESIGN.md"), design));
const designHashOf = (root: string) =>
  readFile(NodePath.join(root, "DESIGN.md")).pipe(
    Effect.map(GameDesignApproval.designDocumentHash),
  );

it.effect("approves one reviewed DESIGN.md revision and dispatches one build turn", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-approve-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const stateDir = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-approve-state-")),
      ),
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
        yield* writeDesign(created.root, filledDesign());
        const designHash = yield* designHashOf(created.root);
        const approval = yield* projects.approveDesign(created.threadId, designHash);
        const manifest = yield* projects.read(created.root);
        expect(manifest.design).toEqual({ status: "approved", approvedAt: approval.approvedAt });
        expect(approval.designHash).toBe(designHash);
        // The authority is the server record, not game.json.
        const record = yield* Effect.promise(() =>
          GameDesignApproval.readDesignApprovalRecord(
            GameDesignApproval.approvalRecordFile(stateDir, created.root),
          ),
        );
        expect(record?.approvalId).toBe(approval.approvalId);
        expect(record?.designHash).toBe(designHash);
        expect(record?.acceptance).toHaveLength(6);
        // Retrying the same revision is a read, not another build turn.
        const again = yield* projects.approveDesign(created.threadId, designHash);
        expect(again.approvalId).toBe(approval.approvalId);
        // The creator approves what they saw; a changed document is rejected.
        yield* writeDesign(created.root, filledDesign().replace("nine lanterns", "ten lanterns"));
        const stale = yield* Effect.result(projects.approveDesign(created.threadId, designHash));
        expect(stale._tag).toBe("Failure");
        if (stale._tag === "Failure") expect(stale.failure.reason).toBe("design-hash-mismatch");
      }).pipe(
        Effect.provide(
          gameProjectLayer(
            stateDir,
            projectTestLayer(undefined, (input) => sends.push(input)),
          ),
        ),
      ),
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]?.threadId).toBe(ThreadId.make("game-test-thread"));
    expect(sends[0]?.text).toContain("The design is approved");
    expect(sends[0]?.text).toContain("milestone 1");
    expect(sends[0]?.text).toContain("acceptance criterion");
    expect(sends[0]?.text).toContain("re-approval");
    // The build turn runs the product's qualification loop with the recorded
    // tools; the prompt has to name them, because a do-it-yourself agent that
    // drives the godot CLI by hand leaves no verdicts the panel can show.
    expect(sends[0]?.text).toContain("game_status");
    expect(sends[0]?.text).toContain("game_godot_import");
    expect(sends[0]?.text).toContain("game_godot_check");
    expect(sends[0]?.text).toContain("game_godot_test");
    expect(sends[0]?.text).toContain("game_export");
    expect(sends[0]?.text).toContain("game_web_playtest");
    expect(sends[0]?.text).toContain("Do not drive the godot binary");
    expect(sends[0]?.createdBy).toBe("user");
    expect(sends[0]?.attachments).toEqual([]);
    expect(gameRoot).not.toBe("");
  }),
);

it.effect("refuses a missing, skeleton, unreadable or acceptance-less design", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-invalid-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const sends: ThreadManagementService.ThreadManagementSendInput[] = [];
    yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const created = yield* projects.create({
          name: "Planned Quest",
          parentDirectory: parent,
          brief: "Collect three coins.",
          modelSelection: selection,
        });
        const designFile = NodePath.join(created.root, "DESIGN.md");
        const refuse = (reason: string) =>
          Effect.gen(function* () {
            const hash = yield* Effect.promise(async () => {
              try {
                return GameDesignApproval.designDocumentHash(
                  await NodeFSP.readFile(designFile, "utf8"),
                );
              } catch {
                return "missing";
              }
            });
            const outcome = yield* Effect.result(projects.approveDesign(created.threadId, hash));
            expect(outcome._tag).toBe("Failure");
            if (outcome._tag === "Failure") {
              expect(outcome.failure.reason).toBe(reason);
              return outcome.failure.detail ?? "";
            }
            return "";
          });
        // The untouched scaffold.
        const skeletonDetail = yield* refuse("design-invalid");
        expect(skeletonDetail).toContain("skeleton hint");
        // A filled page with no acceptance block.
        const withoutAcceptance = filledDesign().replace(
          /\n## Acceptance[\s\S]*?(?=\n## Art direction)/,
          "",
        );
        yield* writeDesign(created.root, withoutAcceptance);
        expect(yield* refuse("design-invalid")).toContain("Acceptance");
        // Missing, then unreadable (a directory is never a document).
        yield* Effect.promise(() => NodeFSP.rm(designFile));
        yield* refuse("design-missing");
        yield* Effect.promise(() => NodeFSP.mkdir(designFile));
        yield* refuse("design-missing");
        yield* Effect.promise(() => NodeFSP.rmdir(designFile));
        expect(sends).toHaveLength(0);
      }).pipe(
        Effect.provide(
          gameProjectLayer(
            fixtureState(parent),
            projectTestLayer(undefined, (input) => sends.push(input)),
          ),
        ),
      ),
    );
  }),
);

it.effect("only an explicit service call changes the verification policy", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-policy-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const stateDir = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-policy-state-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const approvals = yield* GameDesignApproval.GameDesignApproval;
        const created = yield* projects.create({
          name: "Planned Quest",
          parentDirectory: parent,
          brief: "Collect three coins.",
          modelSelection: selection,
        });
        const createdPolicy = yield* approvals.readPolicy(
          created.root,
          yield* projects.read(created.root),
        );
        expect(createdPolicy.policy).toEqual({
          testSuite: "res://tests/smoke_test.gd",
          gameplayScene: "res://scenes/game.tscn",
          probe: true,
        });
        const updated = yield* projects.updateVerificationPolicy(created.threadId, {
          testSuite: "res://tests/other.gd",
          gameplayScene: null,
          probe: false,
        });
        expect(updated.policy.testSuite).toBe("res://tests/other.gd");
        expect(updated.revision).not.toBe(createdPolicy.revision);
        // game.json mirrors the change for display, but the record is authority.
        const mirror = yield* projects.read(created.root);
        expect(mirror.testSuite).toBe("res://tests/other.gd");
        expect(mirror.gameplayScene).toBeUndefined();
        expect(mirror.probe).toBe(false);
        // A manifest edit is not another way to change the exam.
        yield* Effect.promise(async () => {
          const file = NodePath.join(created.root, "game.json");
          const raw = JSON.parse(await NodeFSP.readFile(file, "utf8")) as Record<string, unknown>;
          raw.testSuite = "res://tests/trivial.gd";
          raw.gameplayScene = "res://scenes/menu.tscn";
          await NodeFSP.writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
        });
        expect(
          (yield* approvals.readPolicy(created.root, yield* projects.read(created.root))).policy,
        ).toEqual(updated.policy);
        for (const policy of [
          { testSuite: "tests/other.gd", gameplayScene: null, probe: false },
          { testSuite: "res://../other.gd", gameplayScene: null, probe: false },
          { testSuite: "res://tests/other.txt", gameplayScene: null, probe: false },
          {
            testSuite: "res://tests/other.gd",
            gameplayScene: "res://scenes/menu.gd",
            probe: false,
          },
        ]) {
          const rejected = yield* Effect.result(
            projects.updateVerificationPolicy(created.threadId, policy),
          );
          expect(rejected._tag).toBe("Failure");
          if (rejected._tag === "Failure") expect(rejected.failure.reason).toBe("invalid-path");
        }
      }).pipe(Effect.provide(gameProjectLayer(stateDir))),
    );
  }),
);

it.effect("two concurrent approvals write one record and dispatch one turn", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-concurrent-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const sends: ThreadManagementService.ThreadManagementSendInput[] = [];
    yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const created = yield* projects.create({
          name: "Planned Quest",
          parentDirectory: parent,
          brief: "Collect three coins.",
          modelSelection: selection,
        });
        yield* writeDesign(created.root, filledDesign());
        const hash = yield* designHashOf(created.root);
        const results = yield* Effect.all(
          [
            projects.approveDesign(created.threadId, hash),
            projects.approveDesign(created.threadId, hash),
          ],
          { concurrency: 2 },
        );
        expect(results[0].approvalId).toBe(results[1].approvalId);
      }).pipe(
        Effect.provide(
          gameProjectLayer(
            fixtureState(parent),
            projectTestLayer(undefined, (input) => sends.push(input)),
          ),
        ),
      ),
    );
    expect(sends).toHaveLength(1);
  }),
);

it.effect("a failed dispatch keeps the approval and a retry reuses its command", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-retry-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const sends: ThreadManagementService.ThreadManagementSendInput[] = [];
    yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const approvals = yield* GameDesignApproval.GameDesignApproval;
        const created = yield* projects.create({
          name: "Planned Quest",
          parentDirectory: parent,
          brief: "Collect three coins.",
          modelSelection: selection,
        });
        yield* writeDesign(created.root, filledDesign());
        const hash = yield* designHashOf(created.root);
        const failed = yield* Effect.result(projects.approveDesign(created.threadId, hash));
        expect(failed._tag).toBe("Failure");
        if (failed._tag === "Failure") expect(failed.failure.reason).toBe("thread-dispatch");
        // The creator's decision survives a dispatch failure; only the build
        // attempt is still pending.
        expect((yield* projects.read(created.root)).design?.status).toBe("approved");
        const pending = yield* approvals.read(created.root);
        expect(pending?.buildDispatch?.state).toBe("pending");
        const approval = yield* projects.approveDesign(created.threadId, hash);
        expect(approval.approvalId).toBe(pending?.approvalId);
        const sent = yield* approvals.read(created.root);
        expect(sent?.buildDispatch?.state).toBe("dispatched");
        // A successful approval is never duplicated or undone by a retry.
        const retry = yield* projects.approveDesign(created.threadId, hash);
        expect(retry.approvalId).toBe(approval.approvalId);
      }).pipe(
        Effect.provide(
          gameProjectLayer(
            fixtureState(parent),
            projectTestLayer(undefined, (input) => sends.push(input), { sendFailures: 1 }),
          ),
        ),
      ),
    );
    expect(sends).toHaveLength(2);
    expect(sends[0]?.commandId).toBe(sends[1]?.commandId);
    expect(sends[0]?.messageId).toBe(sends[1]?.messageId);
  }),
);

it.effect("an interrupted dispatch keeps its record and a retry does not send twice", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-interrupt-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const sends: ThreadManagementService.ThreadManagementSendInput[] = [];
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const approvals = yield* GameDesignApproval.GameDesignApproval;
        const created = yield* projects.create({
          name: "Planned Quest",
          parentDirectory: parent,
          brief: "Collect three coins.",
          modelSelection: selection,
        });
        yield* writeDesign(created.root, filledDesign());
        const hash = yield* designHashOf(created.root);
        const fiber = yield* Effect.forkScoped(projects.approveDesign(created.threadId, hash));
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        // The dispatch committed before the interrupted reply read; the retry
        // reconciles that receipt instead of sending a second message.
        expect((yield* approvals.read(created.root))?.buildDispatch?.state).toBe("pending");
        expect((yield* projects.read(created.root)).design?.status).toBe("approved");
        const retry = yield* projects.approveDesign(created.threadId, hash);
        expect(yield* approvals.read(created.root)).toMatchObject({
          approvalId: retry.approvalId,
          buildDispatch: { state: "dispatched" },
        });
      }).pipe(
        Effect.provide(
          gameProjectLayer(
            fixtureState(parent),
            projectTestLayer(undefined, (input) => sends.push(input), {
              sendGate: { started, release },
            }),
          ),
        ),
      ),
    );
    expect(sends).toHaveLength(1);
  }),
);

it.effect("a crash after writing a pending approval sends once with its ids", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-crash-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const sends: ThreadManagementService.ThreadManagementSendInput[] = [];
    yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const approvals = yield* GameDesignApproval.GameDesignApproval;
        const created = yield* projects.create({
          name: "Planned Quest",
          parentDirectory: parent,
          brief: "Collect three coins.",
          modelSelection: selection,
        });
        yield* writeDesign(created.root, filledDesign());
        const hash = yield* designHashOf(created.root);
        // What a process that died between the record write and its first send
        // leaves behind.
        yield* approvals.write(created.root, {
          schemaVersion: 1,
          game: created.root,
          approvalId: "crashed-approval",
          designHash: hash,
          approvedAt: "2026-10-20T00:00:00.000Z",
          acceptance: [],
          buildDispatch: {
            commandId: "stable-command",
            messageId: "stable-message",
            threadId: created.threadId,
            state: "pending",
          },
        });
        const retry = yield* projects.approveDesign(created.threadId, hash);
        expect(retry.approvalId).toBe("crashed-approval");
        expect((yield* approvals.read(created.root))?.buildDispatch?.state).toBe("dispatched");
      }).pipe(
        Effect.provide(
          gameProjectLayer(
            fixtureState(parent),
            projectTestLayer(undefined, (input) => sends.push(input)),
          ),
        ),
      ),
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]?.commandId).toBe("stable-command");
    expect(sends[0]?.messageId).toBe("stable-message");
  }),
);

it.effect("a committed dispatch with a failed reply read is never sent twice", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-post-commit-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const sends: ThreadManagementService.ThreadManagementSendInput[] = [];
    yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const approvals = yield* GameDesignApproval.GameDesignApproval;
        const created = yield* projects.create({
          name: "Planned Quest",
          parentDirectory: parent,
          brief: "Collect three coins.",
          modelSelection: selection,
        });
        yield* writeDesign(created.root, filledDesign());
        const hash = yield* designHashOf(created.root);
        const approval = yield* projects.approveDesign(created.threadId, hash);
        // The command committed; only the reply projection read failed.
        expect((yield* approvals.read(created.root))?.buildDispatch?.state).toBe("dispatched");
        const retry = yield* projects.approveDesign(created.threadId, hash);
        expect(retry.approvalId).toBe(approval.approvalId);
      }).pipe(
        Effect.provide(
          gameProjectLayer(
            fixtureState(parent),
            projectTestLayer(undefined, (input) => sends.push(input), {
              sendProjectionFailures: 1,
            }),
          ),
        ),
      ),
    );
    expect(sends).toHaveLength(1);
  }),
);

it.effect(
  "changing the approved design marks it changed, unqualifies the game, and re-approval does not dispatch",
  () =>
    Effect.gen(function* () {
      const parent = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-changed-"))),
        (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
      const stateDir = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-changed-state-")),
        ),
        (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
      const sends: ThreadManagementService.ThreadManagementSendInput[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const projects = yield* GameProjectService.GameProjectService;
          const game = yield* GameService.GameService;
          const created = yield* projects.create({
            name: "Planned Quest",
            parentDirectory: parent,
            brief: "Collect three coins.",
            modelSelection: selection,
          });
          yield* writeDesign(created.root, filledDesign());
          const firstHash = yield* designHashOf(created.root);
          yield* projects.approveDesign(created.threadId, firstHash);
          const approved = yield* game.status(created.threadId);
          expect(approved.design.state).toBe("approved");
          expect(approved.design.acceptance).toHaveLength(6);
          // One snapshot: the text the Design tab renders hashes to the hash it
          // submits, and a changed document cannot keep an old snapshot.
          expect(approved.design.documentTruncated).toBe(false);
          expect(approved.design.document).toContain("## Pitch");
          expect(approved.design.currentHash).toBe(
            GameDesignApproval.designDocumentHash(approved.design.document ?? ""),
          );
          expect(approved.qualification.stages.find((s) => s.stage === "design")?.status).toBe(
            "passed",
          );
          // Changing DESIGN.md is a scope change, not a silent approval.
          yield* writeDesign(
            created.root,
            filledDesign().replaceAll("nine lanterns", "ten lanterns"),
          );
          const changed = yield* game.status(created.threadId);
          expect(changed.design.state).toBe("changed");
          expect(changed.design.currentHash).not.toBe(changed.design.approvedHash);
          expect(changed.qualification.stages.find((s) => s.stage === "design")?.status).toBe(
            "failed",
          );
          expect(changed.qualification.state).toBe("unqualified");
          const gated = yield* Effect.result(game.action(created.threadId, "preview"));
          expect(gated._tag).toBe("Failure");
          if (gated._tag === "Failure") expect(gated.failure.reason).toBe("design-changed");
          // Re-approval binds the new revision but must not start another build.
          const secondHash = yield* designHashOf(created.root);
          const second = yield* projects.approveDesign(created.threadId, secondHash);
          expect(second.designHash).toBe(secondHash);
          const reapproved = yield* game.status(created.threadId);
          expect(reapproved.design.state).toBe("approved");
          expect(reapproved.design.acceptance.some((c) => c.text.includes("ten lanterns"))).toBe(
            true,
          );
        }).pipe(
          Effect.provide(gameServiceLayers({ stateDir, onSend: (input) => sends.push(input) })),
        ),
      );
      expect(sends).toHaveLength(1);
    }),
);

it.effect("a raw game.json edit to approved grants nothing", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-raw-edit-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const game = yield* GameService.GameService;
        const created = yield* projects.create({
          name: "Planned Quest",
          parentDirectory: parent,
          brief: "Collect three coins.",
          modelSelection: selection,
        });
        const manifestFile = NodePath.join(created.root, "game.json");
        const manifest = JSON.parse(yield* readFile(manifestFile)) as Record<string, unknown>;
        manifest.design = { status: "approved", approvedAt: "2026-10-20T00:00:00.000Z" };
        yield* Effect.promise(() =>
          NodeFSP.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`),
        );
        const status = yield* game.status(created.threadId);
        // The untouched skeleton is still a draft, whatever game.json claims.
        expect(status.design.state).toBe("draft");
        expect(status.qualification.stages.find((s) => s.stage === "design")?.status).toBe(
          "failed",
        );
        const hash = yield* designHashOf(created.root);
        const outcome = yield* Effect.result(projects.approveDesign(created.threadId, hash));
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag === "Failure") expect(outcome.failure.reason).toBe("design-invalid");
      }).pipe(Effect.provide(gameServiceLayers({ stateDir: fixtureState(parent) }))),
    );
  }),
);

it.effect("a skip-planning game is legacy with no acceptance", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-legacy-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const game = yield* GameService.GameService;
        const created = yield* projects.create({
          name: "Straight To Build",
          parentDirectory: parent,
          brief: "Jump over the crates.",
          planFirst: false,
          modelSelection: selection,
        });
        const status = yield* game.status(created.threadId);
        expect(status.design.state).toBe("legacy");
        expect(status.design.acceptance).toEqual([]);
        expect(status.qualification.stages.find((s) => s.stage === "design")?.status).toBe(
          "passed",
        );
        const outcome = yield* Effect.result(projects.approveDesign(created.threadId, "any"));
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag === "Failure") expect(outcome.failure.reason).toBe("design-legacy");
      }).pipe(Effect.provide(gameServiceLayers({ stateDir: fixtureState(parent) }))),
    );
  }),
);

it.effect("a draft design locks staging until it is approved", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-draft-gate-")),
    );
    try {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const projects = yield* GameProjectService.GameProjectService;
          const game = yield* GameService.GameService;
          const created = yield* projects.create({
            name: "Planned First",
            parentDirectory: parent,
            brief: "Collect three coins.",
            artDirection: "Clay",
            modelSelection: selection,
          });
          const gated: ReadonlyArray<Effect.Effect<unknown, GameOperationError>> = [
            game.action(created.threadId, "preview"),
            game.action(created.threadId, "export-linux"),
            game.action(created.threadId, "rebuild"),
            game.action(created.threadId, "native"),
            game.export(created.threadId, "Web"),
            game.webPlaytest(created.threadId, {}),
            game.blender(created.threadId, { id: "coin", script: "import bpy" }),
          ];
          for (const attempt of gated) {
            const outcome = yield* Effect.result(attempt);
            expect(outcome._tag).toBe("Failure");
            if (outcome._tag === "Failure")
              expect((outcome.failure as { reason?: string }).reason).toBe("design-draft");
          }
          // Read-only tools stay open; the agent can still see game state while drafting.
          const status = yield* game.status(created.threadId);
          expect(status.design.state).toBe("draft");
          // Approval is the only legal way out of the gate.
          yield* writeDesign(created.root, filledDesign("Planned First"));
          yield* projects.approveDesign(created.threadId, yield* designHashOf(created.root));
          expect((yield* projects.read(created.root)).design?.status).toBe("approved");
          expect((yield* game.status(created.threadId)).design.state).toBe("approved");
        }).pipe(Effect.provide(gameServiceLayers({ stateDir: fixtureState(parent) }))),
      );
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
    }
  }),
);

it.effect("reuses the inventory until the source snapshot or manifest changes", () =>
  Effect.gen(function* () {
    const parent = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-inventory-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* GameProjectService.GameProjectService;
        const game = yield* service.create({
          name: "Cached Inventory",
          parentDirectory: parent,
          brief: "Go",
          modelSelection: selection,
        });
        const coin = {
          id: "coin",
          kind: "model" as const,
          source: "art/blender/coin.blend",
          script: "art/scripts/coin.py",
          export: "godot/assets/models/coin.glb",
          updatedAt: "2026-10-19T00:00:00.000Z",
        };
        yield* service.upsertAsset(game.root, coin);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(game.root, "godot/scenes/coin.tscn"),
            '[gd_scene format=3]\n[ext_resource type="PackedScene" path="res://assets/models/coin.glb" id="1"]\n[node name="Coin" instance=ExtResource("1")]\n',
          ),
        );
        const first = yield* service.inventory(game.root, "source-a");
        // The template's own scenes are there too; this test tracks the delta.
        expect(first.scenes).toContain("godot/scenes/coin.tscn");
        expect(first.assets[0]?.usedBy).toContain("godot/scenes/coin.tscn");
        const templateScenes = first.scenes.filter((scene) => !scene.includes("coin"));

        // A source change with the same snapshot id is a caller bug the cache
        // must not paper over silently; a new snapshot id is what re-scans.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(game.root, "godot/scenes/coin-2.tscn"),
            '[gd_scene format=3]\n[ext_resource type="PackedScene" path="res://assets/models/coin.glb" id="1"]\n[node name="Coin2" instance=ExtResource("1")]\n',
          ),
        );
        const cached = yield* service.inventory(game.root, "source-a");
        expect(cached.scenes).not.toContain("godot/scenes/coin-2.tscn");
        expect(cached.scenes).toHaveLength(templateScenes.length + 1);
        const rescanned = yield* service.inventory(game.root, "source-b");
        expect(rescanned.scenes).toContain("godot/scenes/coin-2.tscn");
        expect(rescanned.scenes).toHaveLength(templateScenes.length + 2);
        expect([...(rescanned.assets[0]?.usedBy ?? [])].sort()).toEqual([
          "godot/scenes/coin-2.tscn",
          "godot/scenes/coin.tscn",
        ]);

        // game.json is outside the source snapshot, so the manifest signature
        // has to invalidate the cached asset list on its own.
        yield* service.upsertAsset(game.root, {
          ...coin,
          id: "gem",
          source: "art/blender/gem.blend",
          script: "art/scripts/gem.py",
          export: "godot/assets/models/gem.glb",
        });
        const withGem = yield* service.inventory(game.root, "source-b");
        expect(withGem.assets.map((asset) => asset.id)).toEqual(["coin", "gem"]);
      }).pipe(Effect.provide(gameProjectLayer(fixtureState(parent)))),
    );
  }),
);
