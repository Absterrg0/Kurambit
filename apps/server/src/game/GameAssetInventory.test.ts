// @effect-diagnostics nodeBuiltinImport:off -- Tests use real temporary game folders with stubbed engine processes only.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Document, NodeIO } from "@gltf-transform/core";
import { GameOperationError, ThreadId, type GameManifest } from "@t3tools/contracts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameQualification from "./GameQualification.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import { hashWebBuildDirectory } from "./webBuild.ts";
import {
  normalizeAuthoredPath,
  scanSourceMentions,
  walkGameFiles,
  preflightImportSafety,
} from "./gameAssetInventory.ts";
import { checkFamily, type FamilyMeasureInputs } from "./gameAssetInventory.ts";
import {
  GAME_ASSET_INVENTORY_BOUNDS,
  type GameAssetFamily,
  type GameAssetNativeEvidence,
} from "@t3tools/contracts";
import {
  admissionTestLayer,
  previewBrowserTestLayer,
  projectTestLayer,
  roundStoreTestLayer,
  designApprovalTestLayer,
  qualificationTestLayer,
} from "./gameTestLayers.ts";

const threadId = ThreadId.make("assets-inspect-test");

const manifest = (): GameManifest => ({
  schemaVersion: 1,
  name: "Inventory probe",
  brief: "",
  artDirection: "",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [
    {
      id: "coin",
      kind: "model",
      source: "art/blender/coin.blend",
      script: "art/scripts/coin.py",
      export: "godot/assets/models/coin.glb",
      updatedAt: "2026-10-19T00:00:00Z",
      inputs: [{ name: "base", path: "godot/assets/hero.png" }],
    },
  ],
  families: [
    {
      name: "tileset",
      kind: "environment",
      paths: ["res://assets/hero.png"],
      provenance: "required",
    },
    {
      name: "hero",
      kind: "character",
      paths: ["res://scenes/hero.tscn"],
      targetHeight: 1.8,
      pivot: "ground",
      animations: [{ name: "idle", loop: true }],
      collision: "required",
      provenance: "required",
    },
    {
      name: "ghost",
      kind: "character",
      paths: ["res://scenes/missing.tscn"],
      animations: [{ name: "fly" }],
      collision: "required",
      provenance: "required",
    },
    { name: "ambience", kind: "audio", paths: ["res://assets/theme.ogg"] },
  ],
});

const writeFixture = async (root: string) => {
  const write = (relative: string, contents: string | Uint8Array) =>
    NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, relative)), { recursive: true }).then(() =>
      NodeFSP.writeFile(NodePath.join(root, relative), contents),
    );
  await write("game.json", JSON.stringify(manifest()));
  await write("godot/project.godot", "[application]\n");
  await write(
    "godot/scripts/hero.gd",
    'extends CharacterBody2D\nconst SPRITE = preload("res://assets/hero.png")\n',
  );
  await write(
    "godot/scenes/hero.tscn",
    '[gd_scene format=3]\n[ext_resource type="Script" path="res://scripts/hero.gd" id="1"]\n[node name="Hero" type="CharacterBody2D"]\nscript = ExtResource("1")\n',
  );
  await write("godot/assets/hero.png", Buffer.from(ONE_BY_ONE_PNG_B64, "base64"));
  await write("godot/assets/theme.ogg", Buffer.from("OggS-fake-audio"));
  await write("godot/assets/ui/font.ttf", Buffer.from("fake-font"));
  await write(
    "godot/materials/hero.tres",
    '[gd_resource type="StandardMaterial3D" format=3]\n[resource]\nalbedo_texture = ExtResource("res://assets/hero.png")\n',
  );
  await write("godot/assets/PROVENANCE.md", "# Hero art provenance\n");
  await write("godot/scenes/PROVENANCE.md", "# Scene provenance\n");
  const model = new Document();
  model.createScene();
  await write("godot/assets/models/coin.glb", await new NodeIO().writeBinary(model));

  // Generated trees the walk must never list.
  await write("builds/web/index.html", "<html>generated</html>");
  await write("godot/.godot/imported.txt", "generated");
};

/** Canned engine facts keyed off the request targets, with real missing checks. */
const stubProbe = (root: string) => async (resultPath: string, args: readonly string[]) => {
  const requestPath = args.at(-2)!;
  const targets = JSON.parse(await NodeFSP.readFile(requestPath, "utf8")).targets as string[];
  const results = [];
  for (const target of targets) {
    const relative = target.startsWith("res://") ? `godot/${target.slice("res://".length)}` : null;
    const exists =
      relative === null
        ? false
        : await NodeFSP.stat(NodePath.join(root, relative)).then(
            (stat) => stat.isFile(),
            () => false,
          );
    if (!exists) {
      results.push({ resPath: target, loaded: false, error: "missing" });
      continue;
    }
    if (target.endsWith(".tscn")) {
      results.push({
        resPath: target,
        loaded: true,
        godotClass: "PackedScene",
        dependencies: ["res://scripts/hero.gd", "res://assets/hero.png"],
        animations: ["idle", "walk"],
        loops: ["idle"],
        transitions: [],
        hasStateMachine: false,
        collisionTotal: 2,
        collisionEnabled: 1,
        rootPosition: [0, 0, 0],
        rootScale: [1, 1, 1],
        pivotHint: "ground",
        heightHint: 1.8,
        detail: "Scene with 3 node(s), 2 animation(s), 1/2 enabled shapes.",
      });
    } else if (target.endsWith(".tres")) {
      results.push({
        resPath: target,
        loaded: true,
        godotClass: "StandardMaterial3D",
        dependencies: ["res://assets/hero.png"],
        animations: [],
        hasStateMachine: false,
        collisionTotal: 0,
        collisionEnabled: 0,
        detail: "StandardMaterial3D with 1 native texture edge(s).",
      });
    } else if (target.endsWith(".png")) {
      results.push({
        resPath: target,
        loaded: true,
        godotClass: "Texture2D",
        dependencies: [],
        animations: [],
        hasStateMachine: false,
        collisionTotal: 0,
        collisionEnabled: 0,
        detail: "Texture 16x16.",
      });
    } else {
      results.push({
        resPath: target,
        loaded: true,
        godotClass: "AudioStreamWAV",
        dependencies: [],
        animations: [],
        hasStateMachine: false,
        collisionTotal: 0,
        collisionEnabled: 0,
        detail: "Audio stream (AudioStreamWAV).",
      });
    }
  }
  await NodeFSP.writeFile(resultPath, JSON.stringify({ results, truncated: false }));
};

interface Harness {
  readonly run: (input: {
    readonly root: string;
    readonly operation: string;
    readonly args: readonly string[];
  }) => Effect.Effect<
    {
      readonly pid: number;
      readonly exitCode: number;
      readonly signal: null;
      readonly timedOut: boolean;
      readonly stdout: string;
      readonly stderr: string;
      readonly logPath: string;
    },
    GameOperationError
  >;
  readonly toolchain?: () => Effect.Effect<
    { path: string; version: string; templates: null },
    GameOperationError
  >;
}

const withInventory = <A, E>(
  harness: Harness,
  run: (input: {
    readonly root: string;
  }) => Effect.Effect<A, E, GameService.GameService | GameRoundStore.GameRoundStore>,
): Effect.Effect<A, E> =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-assets-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      yield* Effect.promise(() => writeFixture(root));
      const services = GameService.layer.pipe(
        Layer.provide(
          Layer.mock(GameProjectService.GameProjectService)({
            resolve: () => Effect.succeed(root),
            read: () => Effect.succeed(manifest()),
          }),
        ),
        Layer.provide(
          Layer.mock(GameToolchain.GameToolchain)({
            executable:
              harness.toolchain ??
              (() =>
                Effect.succeed({ path: "/fake/godot", version: "4.7.2.stable", templates: null })),
            status: Effect.succeed({ toolsDirectory: base, installing: false, tools: [] }),
          }),
        ),
        Layer.provide(
          Layer.mock(GamePreview.GamePreview)({
            directories: () => [],
            url: () => null,
            urlFor: () => null,
            serving: () => false,
          }),
        ),
        Layer.provide(previewBrowserTestLayer()),
        Layer.provideMerge(GameQualification.layer({ stateDir })),
        Layer.provide(
          Layer.mock(GameDesignApproval.GameDesignApproval)({
            status: () =>
              Effect.succeed({
                state: "legacy",
                document: null,
                documentTruncated: false,
                approvedHash: null,
                currentHash: null,
                approvedAt: null,
                acceptance: [],
                issues: [],
                pendingRevision: null,
                revisionDiff: null,
              }),
          }),
        ),
        Layer.provideMerge(roundStoreTestLayer(stateDir)),
        Layer.provideMerge(admissionTestLayer),
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.mock(GameProcesses.GameProcesses)({
            run: (input) =>
              harness.run({ root, operation: input.operation, args: [...input.args] }),
            start: () => Effect.succeed({ pid: 1, logPath: "fake" }),
            stop: () => Effect.void,
            list: () => [],
          }),
        ),
      );
      return yield* run({ root }).pipe(Effect.provide(services));
    }),
  );

it.effect("inventories every resource kind without native loads and mixes family verdicts", () =>
  withInventory(
    {
      run: () => Effect.die("Godot must not run when the native pass is skipped"),
    },
    () =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const result = yield* game.assetsInspect(threadId, { includeNative: false });
        const kinds = new Set(result.resources.map((entry) => entry.kind));
        for (const kind of ["model", "texture", "audio", "scene", "resource"] as const)
          expect(kinds.has(kind), `expected a ${kind} resource`).toBe(true);
        // Generated trees never enter the walk.
        expect(result.resources.some((entry) => entry.path.startsWith("builds/"))).toBe(false);
        expect(result.resources.some((entry) => entry.path.split("/").includes(".godot"))).toBe(
          false,
        );
        expect(result.resources.every((entry) => entry.godotClass === null)).toBe(true);
        // Declared references name existence; source mentions never prove loading.
        const missing = result.declaredReferences.filter((ref) => !ref.exists);
        expect(missing.map((ref) => ref.target)).toContain("res://scenes/missing.tscn");
        expect(result.sourceMentions.length).toBeGreaterThan(0);
        expect(result.native.status).toBe("unknown");
        expect(result.native.edges).toEqual([]);
        // Recorded inputs are counted as mentioned, never as used.
        expect(result.coverage.suppliedInputs).toBe(1);
        expect(result.coverage.mentionedInputs).toBe(1);
        expect(result.exportedUsage).toBe("unknown");
        expect(result.message).toContain("no export artifact was parsed");
        const byFamily = new Map(result.families.map((family) => [family.family, family]));
        expect(byFamily.get("tileset")?.status).toBe("complete");
        expect(byFamily.get("hero")?.status).toBe("unknown");
        expect(byFamily.get("ghost")?.status).toBe("incomplete");
        expect(byFamily.get("ambience")?.status).toBe("unknown");
        expect(byFamily.get("ghost")?.missing.join("\n")).toContain("missing file");
        expect(
          result.families.every((family) => family.missing.every((item) => item.length > 0)),
        ).toBe(true);
      }),
  ),
);

it.effect("uses stubbed native evidence for engine facts and completes the hero family", () =>
  withInventory(
    {
      run: ({ root, operation, args }) =>
        operation === "godot-import" || args.includes("--import")
          ? Effect.succeed({
              pid: 1,
              exitCode: 0,
              signal: null,
              timedOut: false,
              stdout: "",
              stderr: "",
              logPath: NodePath.join(root, "builds/logs/fake-import.log"),
            })
          : Effect.promise(() =>
              stubProbe(root)(args.at(-1)!, args).then(() => ({
                pid: 1,
                exitCode: 0,
                signal: null,
                timedOut: false,
                stdout: "",
                stderr: "",
                logPath: NodePath.join(root, "builds/logs/fake.log"),
              })),
            ),
    },
    () =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const result = yield* game.assetsInspect(threadId, {});
        expect(result.native.status).toBe("partial");
        expect(result.native.checkedPaths).toContain("res://scenes/hero.tscn");
        expect(result.native.missingPaths).toContain("res://scenes/missing.tscn");
        expect(
          result.native.edges.some(
            (edge) => edge.from === "res://scenes/hero.tscn" && edge.to === "res://scripts/hero.gd",
          ),
        ).toBe(true);
        const hero = result.families.find((family) => family.family === "hero")!;
        expect(hero.status).toBe("complete");
        expect(hero.animations.status).toBe("yes");
        expect(hero.collision.status).toBe("yes");
        expect(hero.scale.status).toBe("yes");
        expect(hero.pivot.status).toBe("yes");
        const ghost = result.families.find((family) => family.family === "ghost")!;
        expect(ghost.status).toBe("incomplete");
        expect(ghost.animations.status).toBe("no");
        const tileset = result.families.find((family) => family.family === "tileset")!;
        expect(tileset.status).toBe("complete");
        // The probe wrote only under builds/logs scratch: no source changed.
        expect(
          result.resources.find((entry) => entry.path === "godot/scenes/hero.tscn")?.godotClass,
        ).toBe("PackedScene");
      }),
  ),
);

it.effect("reports unknown native evidence when the probe fails, keeping filesystem facts", () =>
  withInventory(
    {
      run: () =>
        Effect.succeed({
          pid: 1,
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "boom",
          logPath: "fake.log",
        }),
    },
    () =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const result = yield* game.assetsInspect(threadId, {});
        expect(result.native.status).toBe("unknown");
        expect(result.resources.length).toBeGreaterThan(0);
        expect(result.families.find((family) => family.family === "tileset")?.status).toBe(
          "complete",
        );
        expect(result.families.find((family) => family.family === "ghost")?.status).toBe(
          "incomplete",
        );
      }),
  ),
);

it.effect("reports unknown native evidence when Godot is missing, without failing", () =>
  withInventory(
    {
      run: () => Effect.die("Godot must not run without an executable"),
      toolchain: () =>
        Effect.fail(
          new GameOperationError({
            operation: "inspect-assets",
            path: "godot",
            reason: "tool-missing",
          }),
        ),
    },
    () =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const result = yield* game.assetsInspect(threadId, {});
        expect(result.native.status).toBe("unknown");
        expect(result.resources.length).toBeGreaterThan(0);
      }),
  ),
);

it.effect("rejects invalid native paths before running Godot", () =>
  withInventory(
    {
      run: () => Effect.die("Godot must not run for invalid input"),
    },
    () =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        for (const paths of [["../escape"], ["res://../escape"], ["not-a-res-path"]]) {
          const failure = yield* game.assetsInspect(threadId, { paths }).pipe(Effect.flip);
          expect(failure.reason).toBe("invalid-input");
        }
      }),
  ),
);

it.effect("never equates source mentions with loads and never verifies exports", () =>
  withInventory(
    {
      run: () => Effect.die("Godot must not run when the native pass is skipped"),
    },
    () =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const result = yield* game.assetsInspect(threadId, { includeNative: false });
        // Every mention target is a string sighting; the edge list stays empty.
        expect(result.sourceMentions.length).toBeGreaterThan(0);
        expect(result.native.edges).toEqual([]);
        expect(result.exportedUsage).toBe("unknown");
        const mention = result.sourceMentions.find(
          (entry) => entry.target === "res://assets/hero.png",
        );
        expect(mention?.count).toBeGreaterThanOrEqual(1);
      }),
  ),
);

it("rejects escaping authored paths instead of resolving them", () => {
  expect(normalizeAuthoredPath("../escape", "godot").invalid).toBe("../escape");
  expect(normalizeAuthoredPath("res://../escape", "godot").invalid).toBe("res://../escape");
  expect(normalizeAuthoredPath("res://scenes/hero.tscn", "godot").gameRelative).toBe(
    "godot/scenes/hero.tscn",
  );
});

it.effect("stops the walk at the file bound and says so", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const parent = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-assets-bound-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      yield* Effect.promise(async () => {
        for (let index = 0; index < 8; index += 1)
          await NodeFSP.writeFile(NodePath.join(parent, `file-${index}.gd`), "extends Node\n");
      });
      const scan = yield* Effect.promise(() =>
        walkGameFiles(parent, { ...GAME_ASSET_INVENTORY_BOUNDS, maxFiles: 5 }),
      );
      expect(scan.truncated).toBe(true);
      expect(scan.incomplete.join("\n")).toContain("5 files");
    }),
  ),
);

it.effect("bounds the source mention scan", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const parent = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-assets-mention-")),
        ),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      yield* Effect.promise(async () => {
        for (let index = 0; index < 3; index += 1)
          await NodeFSP.writeFile(
            NodePath.join(parent, `script-${index}.gd`),
            `extends Node\nconst A = preload("res://a${index}.tscn")\nconst B = preload("res://b${index}.tscn")\n`,
          );
      });
      const files = [
        { path: "script-0.gd", bytes: 100 },
        { path: "script-1.gd", bytes: 100 },
        { path: "script-2.gd", bytes: 100 },
      ];
      const scan = yield* Effect.promise(() =>
        scanSourceMentions(parent, files, { ...GAME_ASSET_INVENTORY_BOUNDS, maxMentions: 2 }),
      );
      expect(scan.truncated).toBe(true);
      expect(scan.mentions).toHaveLength(2);
    }),
  ),
);

const familyReadLayer = (stateDir: string) =>
  GameProjectService.layer.pipe(
    Layer.provide(projectTestLayer()),
    Layer.provideMerge(GameProcesses.layer),
    Layer.provideMerge(designApprovalTestLayer(stateDir)),
    Layer.provideMerge(qualificationTestLayer(stateDir)),
    Layer.provideMerge(GameOperations.layer),
    Layer.provideMerge(admissionTestLayer),
    Layer.provide(NodeServices.layer),
  );

it.effect("rejects a family path that escapes the game", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-assets-escape-")),
        ),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(tmp, "game");
      const stateDir = NodePath.join(tmp, "state");
      yield* Effect.promise(() => NodeFSP.mkdir(root, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(root, "game.json"),
          JSON.stringify({
            schemaVersion: 1,
            name: "Escape",
            brief: "",
            artDirection: "",
            engine: { name: "godot", version: "4.7.2" },
            godotProject: "godot",
            assets: [],
            families: [{ name: "sneak", kind: "prop", paths: ["../outside.tscn"] }],
          }),
        ),
      );
      const check = Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        return yield* Effect.result(projects.read(root));
      });
      const failure = yield* check.pipe(Effect.provide(familyReadLayer(stateDir)));
      expect(failure._tag).toBe("Failure");
    }),
  ),
);

it.effect("reads a manifest whose families stay inside the game", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-assets-inside-")),
        ),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(tmp, "game");
      const stateDir = NodePath.join(tmp, "state");
      yield* Effect.promise(() => NodeFSP.mkdir(root, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(root, "game.json"),
          JSON.stringify({
            schemaVersion: 1,
            name: "Inside",
            brief: "",
            artDirection: "",
            engine: { name: "godot", version: "4.7.2" },
            godotProject: "godot",
            assets: [],
            families: [{ name: "hud", kind: "ui", paths: ["res://ui/hud.tscn"] }],
          }),
        ),
      );
      const check = Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        return yield* projects.read(root);
      });
      const manifest = yield* check.pipe(Effect.provide(familyReadLayer(stateDir)));
      expect(manifest.families).toHaveLength(1);
    }),
  ),
);

const baseNative = (overrides?: Partial<GameAssetNativeEvidence>): GameAssetNativeEvidence => ({
  status: "partial",
  checkedPaths: [],
  missingPaths: [],
  overlargePaths: [],
  edges: [],
  animations: [],
  collisions: [],
  scales: [],
  transitions: [],
  errors: [],
  message: "stub native evidence",
  ...overrides,
});

const declaredMapOf = (
  family: string,
  entries: ReadonlyArray<{ target: string; resolvedPath: string | null }>,
): FamilyMeasureInputs["declared"] => {
  const map = new Map();
  for (const entry of entries)
    map.set(`family:${family}\0${entry.target}`, {
      from: `family:${family}`,
      target: entry.target,
      exists: entry.resolvedPath !== null,
      resolvedPath: entry.resolvedPath,
    });
  return map;
};

const inputsOf = (
  family: GameAssetFamily,
  native: GameAssetNativeEvidence,
  paths: ReadonlyArray<{ target: string; resolvedPath: string | null }>,
  options?: { declaredTruncated?: boolean; glbHeights?: ReadonlyMap<string, number> },
): FamilyMeasureInputs => ({
  declared: declaredMapOf(family.name, paths),
  native,
  provenanceFiles: new Set<string>(),
  glbHeights: options?.glbHeights ?? new Map(),
  declaredTruncated: options?.declaredTruncated ?? false,
});

it("reports a missing file incomplete even when the family promises nothing else", () => {
  const family: GameAssetFamily = {
    name: "jingle",
    kind: "audio",
    paths: ["res://assets/jingle.ogg"],
  };
  const check = checkFamily(
    family,
    "godot",
    inputsOf(family, baseNative({ status: "complete", checkedPaths: [] }), [
      { target: "res://assets/jingle.ogg", resolvedPath: null },
    ]),
  );
  expect(check.status).toBe("incomplete");
  expect(check.missing.join("\n")).toContain("missing file");
});

it("scopes animations to exact family paths and never matches basenames", () => {
  const hero: GameAssetFamily = {
    name: "hero",
    kind: "character",
    paths: ["res://scenes/a/hero.tscn"],
    animations: [{ name: "idle" }],
  };
  const other: GameAssetFamily = {
    name: "other",
    kind: "character",
    paths: ["res://scenes/b/hero.tscn"],
    animations: [{ name: "idle" }],
  };
  const native = baseNative({
    status: "complete",
    checkedPaths: ["res://scenes/b/hero.tscn"],
    edges: [],
    animations: [{ resource: "res://scenes/b/hero.tscn", animations: ["idle"] }],
  });
  const heroCheck = checkFamily(
    hero,
    "godot",
    inputsOf(hero, native, [
      { target: "res://scenes/a/hero.tscn", resolvedPath: "godot/scenes/a/hero.tscn" },
    ]),
  );
  expect(heroCheck.animations.status).toBe("unknown");
  expect(heroCheck.status).toBe("unknown");
  const otherCheck = checkFamily(
    other,
    "godot",
    inputsOf(other, native, [
      { target: "res://scenes/b/hero.tscn", resolvedPath: "godot/scenes/b/hero.tscn" },
    ]),
  );
  expect(otherCheck.animations.status).toBe("yes");
});

it("reports collision unknown on families the native pass never inspected", () => {
  const required: GameAssetFamily = {
    name: "ghost",
    kind: "character",
    paths: ["res://scenes/ghost.tscn"],
    collision: "required",
  };
  const none: GameAssetFamily = {
    name: "sign",
    kind: "prop",
    paths: ["res://scenes/sign.tscn"],
    collision: "none",
  };
  const native = baseNative({
    status: "partial",
    checkedPaths: ["res://scenes/other.tscn"],
    collisions: [{ scene: "res://scenes/other.tscn", total: 1, enabledWithShape: 1 }],
  });
  const requiredCheck = checkFamily(
    required,
    "godot",
    inputsOf(required, native, [
      { target: "res://scenes/ghost.tscn", resolvedPath: "godot/scenes/ghost.tscn" },
    ]),
  );
  expect(requiredCheck.collision.status).toBe("unknown");
  const noneCheck = checkFamily(
    none,
    "godot",
    inputsOf(none, native, [
      { target: "res://scenes/sign.tscn", resolvedPath: "godot/scenes/sign.tscn" },
    ]),
  );
  expect(noneCheck.collision.status).toBe("unknown");
});

it("measures loop flags natively instead of passing on a manual review", () => {
  const family: GameAssetFamily = {
    name: "hero",
    kind: "character",
    paths: ["res://scenes/hero.tscn"],
    animations: [{ name: "idle", loop: true }],
  };
  const paths = [{ target: "res://scenes/hero.tscn", resolvedPath: "godot/scenes/hero.tscn" }];
  const withoutLoops = baseNative({
    status: "complete",
    checkedPaths: ["res://scenes/hero.tscn"],
    animations: [{ resource: "res://scenes/hero.tscn", animations: ["idle"] }],
  });
  expect(
    checkFamily(family, "godot", inputsOf(family, withoutLoops, paths)).animations.status,
  ).toBe("unknown");
  const matching = baseNative({
    status: "complete",
    checkedPaths: ["res://scenes/hero.tscn"],
    animations: [{ resource: "res://scenes/hero.tscn", animations: ["idle"], loops: ["idle"] }],
  });
  expect(checkFamily(family, "godot", inputsOf(family, matching, paths)).animations.status).toBe(
    "yes",
  );
  const mismatch = baseNative({
    status: "complete",
    checkedPaths: ["res://scenes/hero.tscn"],
    animations: [{ resource: "res://scenes/hero.tscn", animations: ["idle"], loops: [] }],
  });
  expect(checkFamily(family, "godot", inputsOf(family, mismatch, paths)).animations.status).toBe(
    "no",
  );
});

it("counts only observed state-machine edges, scoped to the owning family", () => {
  const family: GameAssetFamily = {
    name: "hero",
    kind: "character",
    paths: ["res://scenes/hero.tscn"],
    animations: [{ name: "idle" }, { name: "run" }],
    transitions: [{ from: "idle", to: "run", condition: "speed" }],
  };
  const paths = [{ target: "res://scenes/hero.tscn", resolvedPath: "godot/scenes/hero.tscn" }];
  const wired = baseNative({
    status: "complete",
    checkedPaths: ["res://scenes/hero.tscn"],
    animations: [{ resource: "res://scenes/hero.tscn", animations: ["idle", "run"] }],
    transitions: [
      { resource: "res://scenes/hero.tscn", from: "idle", to: "run", condition: "speed" },
    ],
  });
  expect(checkFamily(family, "godot", inputsOf(family, wired, paths)).transitions.status).toBe(
    "yes",
  );
  const endpointsOnly = baseNative({
    status: "complete",
    checkedPaths: ["res://scenes/hero.tscn"],
    animations: [{ resource: "res://scenes/hero.tscn", animations: ["idle", "run"] }],
    transitions: [],
  });
  expect(
    checkFamily(family, "godot", inputsOf(family, endpointsOnly, paths)).transitions.status,
  ).toBe("unknown");
  const missingEndpoints = baseNative({
    status: "complete",
    checkedPaths: ["res://scenes/hero.tscn"],
    animations: [{ resource: "res://scenes/hero.tscn", animations: ["idle"] }],
    transitions: [],
  });
  expect(
    checkFamily(family, "godot", inputsOf(family, missingEndpoints, paths)).transitions.status,
  ).toBe("no");
  const wrongFamily = baseNative({
    status: "complete",
    checkedPaths: ["res://scenes/hero.tscn", "res://scenes/villain.tscn"],
    edges: [],
    animations: [
      { resource: "res://scenes/hero.tscn", animations: ["idle", "run"] },
      { resource: "res://scenes/villain.tscn", animations: ["idle", "run"] },
    ],
    transitions: [
      { resource: "res://scenes/villain.tscn", from: "idle", to: "run", condition: "speed" },
    ],
  });
  expect(
    checkFamily(family, "godot", inputsOf(family, wrongFamily, paths)).transitions.status,
  ).toBe("unknown");
});

it("counts a direct state-machine resource as its own transition owner", () => {
  const family: GameAssetFamily = {
    name: "brain",
    kind: "character",
    paths: ["res://brains/hero.tres"],
    transitions: [{ from: "idle", to: "run" }],
  };
  const paths = [{ target: "res://brains/hero.tres", resolvedPath: "godot/brains/hero.tres" }];
  const native = baseNative({
    status: "complete",
    checkedPaths: ["res://brains/hero.tres"],
    animations: [{ resource: "res://brains/hero.tres", animations: ["idle", "run"] }],
    transitions: [{ resource: "res://brains/hero.tres", from: "idle", to: "run", condition: "" }],
  });
  expect(checkFamily(family, "godot", inputsOf(family, native, paths)).transitions.status).toBe(
    "yes",
  );
});

it("never passes a measured subset when a member is missing or uninspected", () => {
  const family: GameAssetFamily = {
    name: "party",
    kind: "character",
    paths: ["res://scenes/a.tscn", "res://scenes/missing.tscn"],
    targetHeight: 1.8,
    provenance: "required",
  };
  const native = baseNative({
    status: "partial",
    checkedPaths: ["res://scenes/a.tscn"],
    missingPaths: ["res://scenes/missing.tscn"],
    scales: [{ resource: "res://scenes/a.tscn", heightM: 1.8, pivot: null, detail: "ok" }],
  });
  const check = checkFamily(family, "godot", {
    ...inputsOf(family, native, [
      { target: "res://scenes/a.tscn", resolvedPath: "godot/scenes/a.tscn" },
      { target: "res://scenes/missing.tscn", resolvedPath: null },
    ]),
    provenanceFiles: new Set(["godot/scenes/PROVENANCE.md"]),
  });
  expect(check.status).toBe("incomplete");
  expect(check.scale.status).not.toBe("yes");
  expect(check.provenance.status).not.toBe("yes");
});

it("requires provenance beside every directory, not just one of them", () => {
  const family: GameAssetFamily = {
    name: "props",
    kind: "prop",
    paths: ["res://a/prop.tscn", "res://b/prop.tscn"],
    provenance: "required",
  };
  const native = baseNative({ status: "complete", checkedPaths: [] });
  const check = checkFamily(family, "godot", {
    ...inputsOf(family, native, [
      { target: "res://a/prop.tscn", resolvedPath: "godot/a/prop.tscn" },
      { target: "res://b/prop.tscn", resolvedPath: "godot/b/prop.tscn" },
    ]),
    provenanceFiles: new Set(["godot/a/PROVENANCE.md"]),
  });
  expect(check.provenance.status).toBe("no");
  expect(check.status).toBe("incomplete");
});

it("reports truncated references as unverified, never as missing", () => {
  const family: GameAssetFamily = {
    name: "hero",
    kind: "character",
    paths: ["res://scenes/hero.tscn"],
    animations: [{ name: "idle" }],
  };
  const native = baseNative({ status: "partial", checkedPaths: [] });
  const check = checkFamily(
    family,
    "godot",
    inputsOf(family, native, [], { declaredTruncated: true }),
  );
  expect(check.animations.status).toBe("unknown");
  expect(check.status).toBe("unknown");
  expect(check.missing.join("\n")).not.toContain("missing file");
});

it("keeps a partially inspected multi-resource family unknown", () => {
  const family: GameAssetFamily = {
    name: "hero-pair",
    kind: "character",
    paths: ["res://a.tres", "res://b.tres"],
    animations: [{ name: "idle", loop: true }],
  };
  const check = checkFamily(
    family,
    "godot",
    inputsOf(
      family,
      baseNative({
        status: "partial",
        checkedPaths: ["res://a.tres"],
        animations: [{ resource: "res://a.tres", animations: ["idle"], loops: ["idle"] }],
      }),
      [
        { target: "res://a.tres", resolvedPath: "godot/a.tres" },
        { target: "res://b.tres", resolvedPath: "godot/b.tres" },
      ],
    ),
  );
  expect(check.animations.status).toBe("unknown");
  expect(check.status).toBe("unknown");
});

it("does not confirm an authored transition trigger with a different native condition", () => {
  const family: GameAssetFamily = {
    name: "hero",
    kind: "character",
    paths: ["res://hero.tres"],
    transitions: [{ from: "idle", to: "run", condition: "moving" }],
  };
  const check = checkFamily(
    family,
    "godot",
    inputsOf(
      family,
      baseNative({
        status: "complete",
        checkedPaths: ["res://hero.tres"],
        animations: [{ resource: "res://hero.tres", animations: ["idle", "run"] }],
        transitions: [{ resource: "res://hero.tres", from: "idle", to: "run", condition: "hurt" }],
      }),
      [{ target: "res://hero.tres", resolvedPath: "godot/hero.tres" }],
    ),
  );
  expect(check.transitions.status).toBe("unknown");
});

const ONE_BY_ONE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const bombPng = (width: number, height: number): Buffer => {
  const bytes = Buffer.alloc(33, 0);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

it.effect(
  "refuses the native pass before any engine import when a tiny header claims huge pixels",
  () =>
    withInventory(
      {
        run: () => Effect.die("Godot must not run when preflight refuses a header bomb"),
      },
      ({ root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(root, "godot/assets/bomb.png"),
              bombPng(100_000, 100_000),
            ),
          );
          const game = yield* GameService.GameService;
          const result = yield* game.assetsInspect(threadId, {});
          expect(result.native.status).toBe("unknown");
          expect(result.native.checkedPaths).toEqual([]);
          expect(result.resources.length).toBeGreaterThan(0);
          expect(result.resources.some((entry) => entry.path === "godot/assets/bomb.png")).toBe(
            true,
          );
          expect(result.exportedUsage).toBe("unknown");
          expect(result.exportedInclusion.status).toBe("unknown");
        }),
    ),
);

it.effect("accepts a small valid texture and still runs the engine import", () =>
  withInventory(
    {
      run: ({ root, operation, args }) => {
        if (operation === "godot-import" || args.includes("--import"))
          return Effect.succeed({
            pid: 1,
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "",
            logPath: NodePath.join(root, "builds/logs/fake-import.log"),
          });
        return Effect.promise(() =>
          stubProbe(root)(args.at(-1)!, args).then(() => ({
            pid: 1,
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "",
            logPath: NodePath.join(root, "builds/logs/fake.log"),
          })),
        );
      },
    },
    ({ root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(root, "godot/assets/ok.png"),
            Buffer.from(ONE_BY_ONE_PNG_B64, "base64"),
          ),
        );
        const game = yield* GameService.GameService;
        const result = yield* game.assetsInspect(threadId, {});
        expect(result.native.status).not.toBe("unknown");
        expect(result.native.checkedPaths).toContain("res://scenes/hero.tscn");
        expect(result.resources.some((entry) => entry.path === "godot/assets/ok.png")).toBe(true);
      }),
  ),
);

it.effect(
  "refuses pack inclusion when no Web build is recorded and never runs the pack probe",
  () =>
    withInventory(
      {
        run: () => Effect.die("Godot must not run when no Web build is recorded"),
      },
      () =>
        Effect.gen(function* () {
          const game = yield* GameService.GameService;
          const result = yield* game.assetsInspect(threadId, { includeNative: false });
          expect(result.exportedUsage).toBe("unknown");
          expect(result.exportedInclusion.status).toBe("unknown");
          expect(result.exportedInclusion.buildId).toBeNull();
          expect(result.resources.length).toBeGreaterThan(0);
        }),
    ),
);

it.effect("refuses pack inclusion when the recorded build changed and never opens the pack", () =>
  withInventory(
    {
      run: () => Effect.die("Godot must not run when the recorded build is stale"),
    },
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        // Create a candidate build, select it, then tamper with its bytes.
        const staging = NodePath.join(root, "builds/candidates/tmp-pack");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(staging, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(staging, "index.html"), "<html>build</html>");
          await NodeFSP.writeFile(NodePath.join(staging, "game.pck"), Buffer.from("PCKFAKE"));
        });
        const hashed = yield* Effect.promise(() => hashWebBuildDirectory(staging));
        expect(hashed).not.toBeNull();
        const buildId = hashed!.buildId;
        const directory = `builds/candidates/${buildId}`;
        yield* Effect.promise(() => NodeFSP.rename(staging, NodePath.join(root, directory)));
        const store = yield* GameRoundStore.GameRoundStore;
        yield* store.select(root, {
          buildId,
          directory,
          sourceId: null,
          engine: "godot",
          target: "Web",
          entry: "index.html",
        });
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, directory, "game.pck"), Buffer.from("TAMPERED")),
        );
        const result = yield* game.assetsInspect(threadId, { includeNative: false });
        expect(result.exportedInclusion.status).toBe("unknown");
        expect(result.exportedInclusion.buildId).toBe(buildId);
        expect(result.exportedUsage).toBe("unknown");
      }),
  ),
);

it.effect(
  "checks pack inclusion against the exact recorded Web build without running game code",
  () =>
    withInventory(
      {
        run: ({ root, args }) =>
          Effect.promise(async () => {
            const requestPath = args.at(-2)!;
            const resultPath = args.at(-1)!;
            const request = JSON.parse(await NodeFSP.readFile(requestPath, "utf8")) as {
              packPath: string;
              checks: string[];
            };
            expect(request.packPath.endsWith(".pck")).toBe(true);
            expect(request.checks.length).toBeGreaterThan(0);
            // The probe answers from the engine: first check is in the pack, the rest are not.
            const included = request.checks.slice(0, 1);
            const partial = await NodeFSP.access(NodePath.join(root, ".partial-probe")).then(
              () => true,
              () => false,
            );
            const missing = partial ? [] : request.checks.slice(1);
            await NodeFSP.writeFile(
              resultPath,
              JSON.stringify({ included, missing, unresolved: [] }),
            );
            return {
              pid: 1,
              exitCode: 0,
              signal: null,
              timedOut: false,
              stdout: "",
              stderr: "",
              logPath: NodePath.join(root, "builds/logs/fake-pack.log"),
            };
          }),
      },
      ({ root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(
              NodePath.join(root, "godot/tripwire.gd"),
              'extends Node\nfunc _init():\n\tFileAccess.open("res://unexpected-write.txt", FileAccess.WRITE).store_string("ran")\n',
            );
          });
          const staging = NodePath.join(root, "builds/candidates/tmp-pack-included");
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(staging, { recursive: true });
            await NodeFSP.writeFile(NodePath.join(staging, "index.html"), "<html>build</html>");
            await NodeFSP.writeFile(NodePath.join(staging, "game.pck"), Buffer.from("PCKBYTES"));
          });
          const hashed = yield* Effect.promise(() => hashWebBuildDirectory(staging));
          expect(hashed).not.toBeNull();
          const buildId = hashed!.buildId;
          const directory = `builds/candidates/${buildId}`;
          yield* Effect.promise(() => NodeFSP.rename(staging, NodePath.join(root, directory)));
          const store = yield* GameRoundStore.GameRoundStore;
          yield* store.select(root, {
            buildId,
            directory,
            sourceId: null,
            engine: "godot",
            target: "Web",
            entry: "index.html",
          });
          const game = yield* GameService.GameService;
          const result = yield* game.assetsInspect(threadId, { includeNative: false });
          expect(result.exportedUsage).toBe("unknown");
          expect(result.exportedInclusion.status).toBe("checked");
          expect(result.exportedInclusion.buildId).toBe(buildId);
          expect(result.exportedInclusion.checkedPaths.length).toBeGreaterThan(0);
          expect(result.exportedInclusion.includedPaths).toHaveLength(1);
          expect(result.exportedInclusion.includedPaths[0]).toBe(
            result.exportedInclusion.checkedPaths[0],
          );
          expect(result.exportedInclusion.missingPaths.length).toBe(
            result.exportedInclusion.checkedPaths.length - 1,
          );
          const unexpected = yield* Effect.promise(() =>
            NodeFSP.access(NodePath.join(root, "godot/unexpected-write.txt")).then(
              () => true,
              () => false,
            ),
          );
          expect(unexpected).toBe(false);
          yield* Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(root, ".partial-probe"), "partial"),
          );
          const partial = yield* game.assetsInspect(threadId, { includeNative: false });
          expect(partial.exportedInclusion.status).toBe("unknown");
        }),
    ),
);

it.effect("unknown image headers and unresolved model resources refuse native import", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "inventory-preflight-")),
    );
    try {
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "godot")));
      for (const [name, bytes] of [
        ["unknown.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
        [
          "model.gltf",
          Buffer.from(
            JSON.stringify({
              asset: { version: "2.0" },
              buffers: [{ uri: "https://example.invalid/huge.bin", byteLength: 1 }],
            }),
          ),
        ],
      ] as const) {
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "godot", name), bytes));
        const scan = yield* Effect.promise(() => walkGameFiles(root));
        const result = yield* Effect.promise(() =>
          preflightImportSafety({ root, godotProject: "godot", scan }),
        );
        expect(result.ok, name).toBe(false);
        yield* Effect.promise(() => NodeFSP.unlink(NodePath.join(root, "godot", name)));
      }
      const model = new Document();
      model.createBuffer();
      model.createTexture().setImage(bombPng(100_000, 100_000)).setMimeType("image/png");
      model.createScene();
      const embedded = yield* Effect.promise(() => new NodeIO().writeBinary(model));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "godot/model.glb"), embedded),
      );
      const scan = yield* Effect.promise(() => walkGameFiles(root));
      const result = yield* Effect.promise(() =>
        preflightImportSafety({ root, godotProject: "godot", scan }),
      );
      expect(result.ok).toBe(false);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
    }
  }),
);
