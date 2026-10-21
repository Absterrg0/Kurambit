// @effect-diagnostics nodeBuiltinImport:off -- Runs the real installed Godot against real temporary games.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GameOperationError, ProviderInstanceId } from "@t3tools/contracts";
import type { GameAcceptanceCriterion, GameTemplateId } from "@t3tools/contracts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  previewBrowserTestLayer,
  projectTestLayer,
  designApprovalTestLayer,
  qualificationTestLayer,
} from "./gameTestLayers.ts";

const godotExecutable = NodePath.join(
  GameToolchain.toolsDirectory(),
  `godot-${GameToolchain.GODOT_VERSION}/Godot_v${GameToolchain.GODOT_VERSION}-stable_linux.x86_64`,
);
const available = NodeFS.existsSync(godotExecutable);

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
};

interface Fixture {
  readonly name: string;
  readonly template?: GameTemplateId;
  readonly planFirst?: boolean;
  readonly mainScript?: string;
  readonly stateScript?: string;
  readonly playerScript?: string;
  readonly scenarios?: Readonly<Record<string, unknown>>;
  readonly criteria?: readonly GameAcceptanceCriterion[];
}

/**
 * Creates one real game with its own service layer and temporary directories. A
 * fresh `projectTestLayer` matters: the mocks expose one fixed thread, so two
 * games in one layer resolve to the first game's root.
 */
const withGame = <A>(
  fixture: Fixture,
  run: (input: {
    readonly root: string;
    readonly game: GameService.GameService["Service"];
    readonly threadId: Parameters<GameService.GameService["Service"]["scenariosRun"]>[0];
    readonly approvals: GameDesignApproval.GameDesignApproval["Service"];
  }) => Effect.Effect<A, GameOperationError>,
) =>
  Effect.gen(function* () {
    const parent = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-scenarios-")),
    );
    const designStateDir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-scenarios-design-")),
    );
    const layer = GameService.layer.pipe(
      Layer.provideMerge(GameProjectService.layer),
      Layer.provideMerge(GameOperations.layer),
      Layer.provideMerge(GameToolchain.layer),
      Layer.provideMerge(GamePreview.layer),
      Layer.provideMerge(GameProcesses.layer),
      Layer.provide(projectTestLayer()),
      Layer.provide(previewBrowserTestLayer()),
      Layer.provideMerge(qualificationTestLayer(NodePath.join(parent, ".test-state"))),
      Layer.provideMerge(designApprovalTestLayer(designStateDir)),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(NodeServices.layer),
    );
    const cleanup = Effect.promise(() =>
      Promise.all([
        NodeFSP.rm(parent, { recursive: true, force: true }),
        NodeFSP.rm(designStateDir, { recursive: true, force: true }),
      ]),
    ).pipe(Effect.orDie);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const game = yield* GameService.GameService;
        const approvals = yield* GameDesignApproval.GameDesignApproval;
        const created = yield* projects.create({
          name: fixture.name,
          parentDirectory: parent,
          ...(fixture.template === undefined ? {} : { template: fixture.template }),
          brief: "A disposable scenario fixture.",
          planFirst: fixture.planFirst ?? false,
          modelSelection,
        });
        if (fixture.mainScript !== undefined && fixture.stateScript !== undefined)
          yield* Effect.promise(() => writeProject(created.root, fixture));
        if (fixture.criteria !== undefined)
          yield* approve(approvals, created.root, fixture.criteria);
        return yield* run({
          root: created.root,
          game,
          threadId: created.threadId,
          approvals,
        });
      }),
    ).pipe(Effect.provide(layer), Effect.ensuring(cleanup));
  });

const writeProject = async (root: string, fixture: Fixture) => {
  const godot = NodePath.join(root, "godot");
  await NodeFSP.rm(godot, { recursive: true, force: true });
  await NodeFSP.mkdir(NodePath.join(godot, "tests/scenarios"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(godot, "project.godot"),
    `config_version=5

[application]
run/main_scene="res://main.tscn"

[autoload]
GameState="*res://game_state.gd"

[input]
move_right={
"deadzone": 0.2,
"events": [Object(InputEventKey,"physical_keycode":68)]
}
jump={
"deadzone": 0.2,
"events": [Object(InputEventKey,"physical_keycode":32)]
}
pause={
"deadzone": 0.2,
"events": [Object(InputEventKey,"physical_keycode":4194305)]
}
`,
  );
  await NodeFSP.writeFile(
    NodePath.join(godot, "main.tscn"),
    `[gd_scene load_steps=5 format=3]

[ext_resource type="Script" path="res://main.gd" id="1_main"]
[ext_resource type="Script" path="res://player.gd" id="2_player"]

[sub_resource type="RectangleShape2D" id="shape_player"]
size = Vector2(10, 14)

[sub_resource type="RectangleShape2D" id="shape_wall"]
size = Vector2(2, 40)

[node name="Main" type="Node2D"]
script = ExtResource("1_main")

[node name="Player" type="CharacterBody2D" parent="." groups=["player"]]
script = ExtResource("2_player")

[node name="Collision" type="CollisionShape2D" parent="Player"]
position = Vector2(0, -7)
shape = SubResource("shape_player")

[node name="Wall" type="StaticBody2D" parent="."]
position = Vector2(40, 0)

[node name="Collision" type="CollisionShape2D" parent="Wall"]
shape = SubResource("shape_wall")
`,
  );
  await NodeFSP.writeFile(NodePath.join(godot, "main.gd"), fixture.mainScript!);
  await NodeFSP.writeFile(NodePath.join(godot, "game_state.gd"), fixture.stateScript!);
  await NodeFSP.writeFile(
    NodePath.join(godot, "player.gd"),
    fixture.playerScript ??
      `extends CharacterBody2D

func _physics_process(_delta: float) -> void:
\tvelocity.x = 120.0 if Input.is_action_pressed("move_right") else 0.0
\tmove_and_slide()
`,
  );
  for (const [name, scenario] of Object.entries(fixture.scenarios ?? {}))
    await NodeFSP.writeFile(
      NodePath.join(godot, "tests/scenarios", `${name}.json`),
      JSON.stringify(scenario),
    );
};

const approve = (
  approvals: GameDesignApproval.GameDesignApproval["Service"],
  root: string,
  criteria: readonly GameAcceptanceCriterion[],
) =>
  Effect.gen(function* () {
    const design = "# Fixture design\n\nA disposable acceptance fixture.\n";
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "DESIGN.md"), design));
    yield* approvals.write(root, {
      schemaVersion: 1,
      game: NodePath.resolve(root),
      approvalId: "fixture-approval",
      designHash: GameDesignApproval.designDocumentHash(design),
      approvedAt: "2026-10-20T00:00:00.000Z",
      acceptance: criteria,
    });
  });

const stateWith = (extra: string) => `extends Node
var state := 1
var collected := 0
var jumped := 0
${extra}`;

it.live.skipIf(!available)(
  "runs both template routes (win and lose) to PASS",
  () =>
    Effect.gen(function* () {
      for (const template of ["2d-platformer", "3d-explorer"] as const) {
        yield* withGame(
          { name: `${template} route`, template, planFirst: false },
          ({ game, threadId }) =>
            Effect.gen(function* () {
              const run = yield* game.scenariosRun(threadId);
              expect(run.errors, `${template}: ${JSON.stringify(run.errors)}`).toEqual([]);
              expect(run.ok, `${template}: ${JSON.stringify(run.summary)}`).toBe(true);
              expect(run.summary).toMatchObject({ mode: "legacy", passed: true });
              expect(run.scenarios.map((scenario) => scenario.id).sort()).toEqual([
                "full-run",
                "lose-run",
              ]);
              const full = run.scenarios.find((scenario) => scenario.id === "full-run");
              const lose = run.scenarios.find((scenario) => scenario.id === "lose-run");
              expect(full).toMatchObject({ playerMoved: true, error: null });
              expect(full?.frames).toBeGreaterThan(500);
              expect(lose).toMatchObject({ playerMoved: true, error: null });
              expect(lose?.baselineFrame).not.toBeNull();
              const state = lose?.observations.find((entry) => entry.key === "state");
              expect(state?.last).toBe(4);
              return run;
            }),
        );
      }
    }),
  { timeout: 240_000 },
);

it.live.skipIf(!available)(
  "both templates prove control, mechanic, content, win and lose across their two routes",
  () =>
    Effect.gen(function* () {
      for (const template of ["2d-platformer", "3d-explorer"] as const) {
        yield* withGame(
          {
            name: `${template} accepted routes`,
            template,
            planFirst: true,
            criteria: [
              {
                id: "jump",
                kind: "control",
                text: "Space jumps",
                observe: { key: "jumps", expect: ">=1" },
              },
              {
                id: "pickup",
                kind: "mechanic",
                text: "Touching a pickup scores",
                observe: { key: "score", expect: ">=100" },
              },
              {
                id: "collect",
                kind: "content",
                text: "The player collects at least two pickups",
                observe: { key: "collected", expect: ">=2" },
              },
              {
                id: "win",
                kind: "win",
                text: "Finish the run",
                observe: { key: "state", expect: "==3" },
              },
              {
                id: "lose",
                kind: "lose",
                text: "Losing every life ends the run",
                observe: { key: "lives", expect: "<=0" },
              },
            ],
          },
          ({ game, threadId }) =>
            Effect.gen(function* () {
              const result = yield* game.scenariosRun(threadId);
              expect(result.errors, `${template}: ${JSON.stringify(result.errors)}`).toEqual([]);
              expect(result.ok, `${template}: ${JSON.stringify(result.summary)}`).toBe(true);
              expect(result.summary).toMatchObject({ mode: "criteria", passed: true });
              expect(
                result.summary.criteria.map((criterion) => [criterion.id, criterion.status]),
              ).toEqual([
                ["jump", "passed"],
                ["pickup", "passed"],
                ["collect", "passed"],
                ["win", "passed"],
                ["lose", "passed"],
              ]);
              expect(result.summary.coverage).toEqual([
                { kind: "control", proven: 1, failed: 0, missing: 0 },
                { kind: "mechanic", proven: 1, failed: 0, missing: 0 },
                { kind: "content", proven: 1, failed: 0, missing: 0 },
                { kind: "win", proven: 1, failed: 0, missing: 0 },
                { kind: "lose", proven: 1, failed: 0, missing: 0 },
              ]);
              // Each moot claim names the route and frame that proved it.
              const win = result.summary.criteria.find((criterion) => criterion.id === "win");
              expect(win?.provenBy?.scenario).toBe("full-run");
              expect(win?.provenBy?.frame).toBeGreaterThan(0);
              const lose = result.summary.criteria.find((criterion) => criterion.id === "lose");
              expect(lose?.provenBy?.scenario).toBe("lose-run");
              // The readable state stage keeps the same coverage and proof.
              const status = yield* game.status(threadId);
              const state = status.qualification.stages.find((stage) => stage.stage === "state");
              expect(state?.status).toBe("passed");
              expect(state?.coverage).toEqual(result.summary.coverage);
              expect(
                state?.criteria?.find((criterion) => criterion.id === "win")?.provenBy,
              ).toEqual({ scenario: "full-run", frame: win?.provenBy?.frame });
              return result;
            }),
        );
      }
    }),
  { timeout: 240_000 },
);

it.live.skipIf(!available)(
  "a still route never qualifies, even though the game is playing",
  () =>
    withGame(
      {
        name: "still fixture",
        mainScript: "extends Node2D\n",
        stateScript: stateWith(""),
        scenarios: { "still-run": { id: "still-run", steps: [{ wait: 90 }] } },
      },
      ({ game, threadId }) =>
        Effect.gen(function* () {
          const result = yield* game.scenariosRun(threadId);
          expect(result.ok).toBe(false);
          expect(result.summary.reason).toBe("no-player-movement");
          return result;
        }),
    ),
  { timeout: 60_000 },
);

it.live.skipIf(!available)(
  "the review's wait-only boot fixture fails instead of passing on constants",
  () =>
    withGame(
      {
        name: "wait only fixture",
        planFirst: true,
        mainScript: "extends Node2D\n",
        stateScript: "extends Node\nvar state := 0\nvar total := 5\n",
        playerScript: `extends CharacterBody2D

func _physics_process(delta: float) -> void:
\tvelocity.y += 300.0 * delta
\tmove_and_slide()
`,
        scenarios: { "wait-only": { id: "wait-only", steps: [{ wait: 60 }] } },
        criteria: [
          { id: "jump", kind: "control", text: "The player jumps with Space" },
          { id: "hazard", kind: "mechanic", text: "The hazard damages the player" },
          {
            id: "content",
            kind: "content",
            text: "Five pickups are reachable",
            observe: { key: "total", expect: "==5" },
          },
          {
            id: "win",
            kind: "win",
            text: "The player wins",
            observe: { key: "state", expect: "==0" },
          },
          { id: "lose", kind: "lose", text: "The player can lose" },
        ],
      },
      ({ game, threadId }) =>
        Effect.gen(function* () {
          const result = yield* game.scenariosRun(threadId);
          expect(result.ok).toBe(false);
          expect(result.summary.mode).toBe("criteria");
          const content = result.summary.criteria.find((entry) => entry.id === "content");
          const win = result.summary.criteria.find((entry) => entry.id === "win");
          expect(content?.status).toBe("failed");
          expect(win?.status).toBe("failed");
          expect(content?.observed).toContain("pressed no controls");
          return result;
        }),
    ),
  { timeout: 60_000 },
);

it.live.skipIf(!available)(
  "a world total is already true when play starts and cannot prove content",
  () =>
    withGame(
      {
        name: "world total fixture",
        planFirst: true,
        mainScript: "extends Node2D\n",
        stateScript: "extends Node\nvar state := 1\nvar total := 5\n",
        scenarios: {
          "total-run": {
            id: "total-run",
            steps: [{ press: "ui_accept" }, { hold: ["move_right"], frames: 60 }],
          },
        },
        criteria: [
          {
            id: "five-pearls",
            kind: "content",
            text: "Five pearls exist",
            observe: { key: "total", expect: "==5" },
          },
          {
            id: "win",
            kind: "win",
            text: "Reach the end",
            observe: { key: "state", expect: "==3" },
          },
        ],
      },
      ({ game, threadId }) =>
        Effect.gen(function* () {
          const result = yield* game.scenariosRun(threadId);
          expect(result.ok).toBe(false);
          const content = result.summary.criteria.find((entry) => entry.id === "five-pearls");
          expect(content?.status).toBe("failed");
          expect(content?.observed).toContain("Already true when play started");
          return result;
        }),
    ),
  { timeout: 60_000 },
);

it.live.skipIf(!available)(
  "starting and pausing the game is a state change, not a win",
  () =>
    withGame(
      {
        name: "pause is not a win fixture",
        planFirst: true,
        mainScript: `extends Node2D

func _physics_process(_delta: float) -> void:
\tif Input.is_action_just_pressed("ui_accept"):
\t\tGameState.state = 1
\tif Input.is_action_just_pressed("pause"):
\t\tGameState.state = 2
`,
        stateScript: "extends Node\nvar state := 0\nvar lives := 3\n",
        scenarios: {
          "pause-run": {
            id: "pause-run",
            steps: [{ press: "ui_accept" }, { wait: 30 }, { press: "pause" }, { wait: 60 }],
          },
        },
        criteria: [
          {
            id: "win",
            kind: "win",
            text: "The run reaches the win state",
            observe: { key: "state", expect: "changes" },
          },
        ],
      },
      ({ game, threadId }) =>
        Effect.gen(function* () {
          const result = yield* game.scenariosRun(threadId);
          expect(result.ok).toBe(false);
          const win = result.summary.criteria.find((entry) => entry.id === "win");
          expect(win?.status).toBe("failed");
          expect(win?.observed).toContain("value the run ends at");
          return result;
        }),
    ),
  { timeout: 60_000 },
);

it.live.skipIf(!available)(
  "a jump the game ignores fails the approved observation",
  () =>
    withGame(
      {
        name: "fake jump fixture",
        planFirst: true,
        mainScript: "extends Node2D\n",
        stateScript: stateWith(""),
        scenarios: {
          "jump-run": {
            id: "jump-run",
            steps: [
              { press: "ui_accept" },
              { hold: ["move_right"], frames: 10 },
              { hold: ["jump"], frames: 20 },
              { wait: 30 },
            ],
          },
        },
        criteria: [
          {
            id: "jump-works",
            kind: "mechanic",
            text: "Jump changes jumped",
            observe: { key: "jumped", expect: ">=1" },
          },
          {
            id: "win",
            kind: "win",
            text: "Reach the end",
            observe: { key: "state", expect: "==3" },
          },
        ],
      },
      ({ game, threadId }) =>
        Effect.gen(function* () {
          const result = yield* game.scenariosRun(threadId);
          expect(result.ok).toBe(false);
          expect(result.summary.mode).toBe("criteria");
          expect(
            result.summary.criteria.find((criterion) => criterion.id === "jump-works")?.status,
          ).toBe("failed");
          return result;
        }),
    ),
  { timeout: 60_000 },
);

it.live.skipIf(!available)(
  "a pickup behind a wall stays uncollected while the body moves",
  () =>
    withGame(
      {
        name: "walled pickup fixture",
        planFirst: true,
        mainScript: "extends Node2D\n",
        stateScript: stateWith(""),
        playerScript: `extends CharacterBody2D

func _physics_process(_delta: float) -> void:
\tvelocity.x = 120.0 if Input.is_action_pressed("move_right") else 0.0
\tmove_and_slide()
`,
        scenarios: {
          "wall-run": {
            id: "wall-run",
            steps: [{ press: "ui_accept" }, { hold: ["move_right"], frames: 90 }],
          },
        },
        criteria: [
          {
            id: "pickup",
            kind: "content",
            text: "Collect the pickup",
            observe: { key: "collected", expect: ">=1" },
          },
          {
            id: "win",
            kind: "win",
            text: "Reach the end",
            observe: { key: "state", expect: "==3" },
          },
        ],
      },
      ({ game, threadId }) =>
        Effect.gen(function* () {
          const result = yield* game.scenariosRun(threadId);
          expect(result.ok).toBe(false);
          expect(result.scenarios[0]?.playerMoved).toBe(true);
          expect(
            result.summary.criteria.find((criterion) => criterion.id === "pickup")?.status,
          ).toBe("failed");
          return result;
        }),
    ),
  { timeout: 60_000 },
);

it.live.skipIf(!available)(
  "an unreachable finish fails the end criterion",
  () =>
    withGame(
      {
        name: "unfinished fixture",
        planFirst: true,
        mainScript: "extends Node2D\n",
        stateScript: stateWith(""),
        scenarios: {
          "finish-run": {
            id: "finish-run",
            steps: [{ press: "ui_accept" }, { hold: ["move_right"], frames: 60 }, { wait: 30 }],
          },
        },
        criteria: [
          {
            id: "win",
            kind: "win",
            text: "Reach the end",
            observe: { key: "state", expect: "==3" },
          },
        ],
      },
      ({ game, threadId }) =>
        Effect.gen(function* () {
          const result = yield* game.scenariosRun(threadId);
          expect(result.ok).toBe(false);
          expect(result.summary.criteria[0]?.status).toBe("failed");
          return result;
        }),
    ),
  { timeout: 60_000 },
);

it.live.skipIf(!available)(
  "a gameplay-only runtime error fails the scenario",
  () =>
    withGame(
      {
        name: "crashing fixture",
        mainScript:
          "extends Node2D\n\nfunc _ready() -> void:\n\tvar broken = null\n\tbroken.explode()\n",
        stateScript: stateWith(""),
        scenarios: { "crash-run": { id: "crash-run", steps: [{ wait: 60 }] } },
      },
      ({ game, threadId }) =>
        Effect.gen(function* () {
          const result = yield* game.scenariosRun(threadId);
          expect(result.ok).toBe(false);
          expect(result.scenarios[0]?.error).toContain("Godot reported");
          return result;
        }),
    ),
  { timeout: 60_000 },
);

it.live.skipIf(!available)(
  "unknown actions and extra scenario keys are rejected without running a route",
  () =>
    withGame(
      {
        name: "invalid route fixture",
        mainScript: "extends Node2D\n",
        stateScript: stateWith(""),
        scenarios: {
          "unknown-action": { id: "unknown-action", steps: [{ hold: ["fly"], frames: 10 }] },
          "extra-key": { id: "extra-key", steps: [{ wait: 10 }], title: "not allowed" },
        },
      },
      ({ game, threadId }) =>
        Effect.gen(function* () {
          const result = yield* game.scenariosRun(threadId);
          expect(result.ok).toBe(false);
          expect(result.scenarios).toEqual([]);
          expect(result.errors.join(" ")).toContain("not an input action");
          expect(result.errors.join(" ")).toContain("Unknown scenario key");
          return result;
        }),
    ),
  { timeout: 60_000 },
);
