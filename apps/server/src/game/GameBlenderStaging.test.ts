// @effect-diagnostics nodeBuiltinImport:off -- These tests stage temporary games with stubbed Blender, checking failure preservation through the service.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { PNG } from "pngjs";
import { Document, NodeIO } from "@gltf-transform/core";
import {
  GameOperationError,
  ThreadId,
  type GameDesignRead,
  type GameManifest,
  type GameProcessResult,
} from "@t3tools/contracts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameQualification from "./GameQualification.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import { renderRunScript } from "./blenderScript.ts";
import {
  admissionTestLayer,
  previewBrowserTestLayer,
  roundStoreTestLayer,
} from "./gameTestLayers.ts";

const threadId = ThreadId.make("blender-staging-test");
const io = new NodeIO();

const manifest = (): GameManifest => ({
  schemaVersion: 1,
  name: "Staging probe",
  brief: "",
  artDirection: "",
  design: { status: "approved" },
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [
    {
      id: "coin",
      kind: "model",
      source: "art/blender/coin.blend",
      script: "art/scripts/coin.py",
      export: "godot/assets/models/coin.glb",
      thumbnail: "art/previews/coin.png",
      updatedAt: "2026-10-27T00:00:00.000Z",
    },
  ],
});

const design = (state: GameDesignRead["state"]): GameDesignRead => ({
  state,
  document: null,
  documentTruncated: false,
  approvedHash: "hash",
  currentHash: "hash",
  approvedAt: "2026-10-27T00:00:00.000Z",
  acceptance: [],
  issues: [],
  pendingRevision: null,
  revisionDiff: null,
});

const processOk = (root: string): GameProcessResult => ({
  pid: 7,
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: "",
  stderr: "",
  logPath: NodePath.join(root, "builds/logs/blender-test.log"),
});

const thumbnailPng = (): Buffer => {
  const png = new PNG({ width: 32, height: 32 });
  png.data.fill(200);
  return PNG.sync.write(png);
};

const triangleGlb = async (): Promise<Buffer> => {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", positions)
    .setMaterial(document.createMaterial("Clay"));
  const mesh = document.createMesh("Triangle").addPrimitive(primitive);
  document.createScene("Scene").addChild(document.createNode("Root").setMesh(mesh));
  return Buffer.from(await io.writeBinary(document));
};

const metadataJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    objects: 2,
    meshes: 1,
    materials: 1,
    materialDetails: [{ name: "StudioPalette_ff0000", color: [1, 0, 0] }],
    animations: 1,
    triangles: 1,
    dimensions: [0.4, 0.4, 1.8],
    originOffset: [0, 0, 0],
    warnings: [],
    ...overrides,
  });

/** The config path is the argument after `--`; the stub only writes those staged paths. */
const configOf = (args: ReadonlyArray<string>): string => {
  const separator = args.indexOf("--");
  const path = separator === -1 ? undefined : args[separator + 1];
  if (path === undefined) throw new Error("The Blender run received no config path.");
  return path;
};

type RunFn = (input: {
  readonly root: string;
  readonly args: ReadonlyArray<string>;
}) => Effect.Effect<GameProcessResult, GameOperationError>;

const withGame = <A, E, R>(
  run: RunFn,
  body: (input: {
    readonly root: string;
    readonly current: () => GameManifest;
  }) => Effect.Effect<A, E, R>,
  failManifest = false,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-blender-staging-")),
        ),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      const state = { current: manifest() };
      yield* Effect.promise(async () => {
        for (const [relative, contents] of [
          ["game.json", JSON.stringify(state.current)],
          ["art/blender/coin.blend", "good-blend"],
          ["art/scripts/coin.py", "good-script"],
          ["godot/assets/models/coin.glb", "good-glb"],
          ["art/previews/coin.png", "good-thumb"],
          ["godot/project.godot", "[application]\n"],
        ] as const) {
          await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, relative)), {
            recursive: true,
          });
          await NodeFSP.writeFile(NodePath.join(root, relative), contents);
        }
      });
      const services = GameService.layer.pipe(
        Layer.provide(
          Layer.mock(GameProcesses.GameProcesses)({
            run: (input) => run({ root, args: input.args }),
            list: () => [],
            stop: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.mock(GameProjectService.GameProjectService)({
            resolve: () => Effect.succeed(root),
            read: () => Effect.succeed(state.current),
            upsertAsset: (assetRoot, asset, options) =>
              failManifest
                ? Effect.fail(
                    new GameOperationError({ operation: "save-asset", path: root, reason: "io" }),
                  )
                : Effect.promise(async () => {
                    state.current = {
                      ...state.current,
                      assets: state.current.assets
                        .filter((entry) => entry.id !== asset.id)
                        .concat(asset),
                      ...(options?.artProfile === undefined
                        ? {}
                        : { artProfile: options.artProfile }),
                    };
                    await NodeFSP.writeFile(
                      NodePath.join(assetRoot, "game.json"),
                      JSON.stringify(state.current),
                    );
                  }),
          }),
        ),
        Layer.provide(
          Layer.mock(GameToolchain.GameToolchain)({
            executable: () =>
              Effect.succeed({ path: "/not-used/blender", version: "4.5.14", templates: null }),
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
            status: () => Effect.succeed(design("approved")),
          }),
        ),
        Layer.provideMerge(roundStoreTestLayer(stateDir)),
        Layer.provideMerge(admissionTestLayer),
        Layer.provide(NodeServices.layer),
      );
      return yield* body({
        root,
        current: () => state.current,
      }).pipe(Effect.provide(services));
    }),
  );

const failingRun: RunFn = ({ root }) =>
  Effect.succeed({ ...processOk(root), exitCode: 1, stderr: "Traceback\nRuntimeError: boom" });

const readFinals = (root: string) =>
  Effect.promise(async () => ({
    blend: await NodeFSP.readFile(NodePath.join(root, "art/blender/coin.blend"), "utf8"),
    script: await NodeFSP.readFile(NodePath.join(root, "art/scripts/coin.py"), "utf8"),
    export: await NodeFSP.readFile(NodePath.join(root, "godot/assets/models/coin.glb"), "utf8"),
  }));

const manifestBytes = (root: string) =>
  Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8"));

it("renders the run script with only the run's own config path baked in", () => {
  const rendered = renderRunScript("/tmp/game/builds/logs/blender-1/config.json");
  expect(rendered).toContain(JSON.stringify("/tmp/game/builds/logs/blender-1/config.json"));
  expect(rendered).not.toContain("__STUDIO_BLENDER_CONFIG__");
});

it.live("a failed export keeps the live script, source, export and manifest", () =>
  withGame(failingRun, ({ root, current }) =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const before = yield* readFinals(root);
      const error = yield* game
        .blender(threadId, { id: "coin", script: "raise boom" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("command-failed");
      // The staged failure publishes nothing: every live file still reads as before.
      expect(yield* readFinals(root)).toEqual(before);
      expect(yield* manifestBytes(root)).toBe(JSON.stringify(manifest()));
      expect(current().assets).toHaveLength(1);
    }),
  ),
);

it.live("a malformed staged export fails before anything publishes", () =>
  withGame(
    ({ root, args }) =>
      Effect.promise(async () => {
        const config = JSON.parse(await NodeFSP.readFile(configOf(args), "utf8")) as {
          source: string;
          exported: string;
          metadata: string;
        };
        await NodeFSP.writeFile(config.source, "staged-blend");
        await NodeFSP.writeFile(config.exported, "not a glb");
        await NodeFSP.writeFile(config.metadata, metadataJson());
        return processOk(root);
      }),
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const before = yield* readFinals(root);
        const error = yield* game
          .blender(threadId, { id: "coin", script: "import bpy", thumbnail: false })
          .pipe(Effect.flip);
        expect(error.reason).toBe("command-failed");
        expect(error.detail).toContain("not a readable GLB");
        expect(yield* readFinals(root)).toEqual(before);
      }),
  ),
);

it.live("an interrupted export keeps the last good asset", () =>
  withGame(
    () => Effect.interrupt,
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const before = yield* readFinals(root);
        const fiber = yield* game
          .blender(threadId, { id: "coin", script: "import time; time.sleep(30)" })
          .pipe(Effect.forkChild);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(yield* readFinals(root)).toEqual(before);
        expect(yield* manifestBytes(root)).toBe(JSON.stringify(manifest()));
      }),
  ),
);

it.live("a manifest publication failure restores the previous asset files", () =>
  withGame(
    ({ root, args }) =>
      Effect.promise(async () => {
        const config = JSON.parse(await NodeFSP.readFile(configOf(args), "utf8"));
        await NodeFSP.writeFile(config.source, "replacement-blend");
        await NodeFSP.writeFile(config.exported, await triangleGlb());
        await NodeFSP.writeFile(config.metadata, metadataJson());
        return processOk(root);
      }),
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const before = yield* readFinals(root);
        const beforeManifest = yield* manifestBytes(root);
        const result = yield* Effect.result(
          game.blender(threadId, {
            id: "coin",
            script: "replacement-script",
            thumbnail: false,
          }),
        );
        expect(result._tag).toBe("Failure");
        expect(yield* readFinals(root)).toEqual(before);
        expect(yield* manifestBytes(root)).toBe(beforeManifest);
      }),
    true,
  ),
);

it.live(
  "a blocked destination rolls back files already published and preserves creator content",
  () =>
    withGame(
      ({ root, args }) =>
        Effect.promise(async () => {
          const config = JSON.parse(await NodeFSP.readFile(configOf(args), "utf8"));
          await NodeFSP.writeFile(config.source, "replacement-blend");
          await NodeFSP.writeFile(config.exported, await triangleGlb());
          await NodeFSP.writeFile(config.metadata, metadataJson());
          return processOk(root);
        }),
      ({ root }) =>
        Effect.gen(function* () {
          const game = yield* GameService.GameService;
          const before = yield* readFinals(root);
          const script = NodePath.join(root, "art/scripts/coin.py");
          yield* Effect.promise(async () => {
            await NodeFSP.rm(script);
            await NodeFSP.mkdir(script);
            await NodeFSP.writeFile(NodePath.join(script, "keep.txt"), "creator content");
          });
          const result = yield* Effect.result(
            game.blender(threadId, { id: "coin", script: "replacement", thumbnail: false }),
          );
          expect(result._tag).toBe("Failure");
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(root, "art/blender/coin.blend"), "utf8"),
            ),
          ).toBe(before.blend);
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(root, "godot/assets/models/coin.glb"), "utf8"),
            ),
          ).toBe(before.export);
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(script, "keep.txt"), "utf8"),
            ),
          ).toBe("creator content");
          expect(yield* manifestBytes(root)).toBe(JSON.stringify(manifest()));
        }),
    ),
);

it.live("a successful export stages, validates, publishes and records the profile", () => {
  let calls = 0;
  return withGame(
    ({ root, args }) =>
      Effect.promise(async () => {
        calls += 1;
        const config = JSON.parse(await NodeFSP.readFile(configOf(args), "utf8")) as {
          source: string;
          exported: string;
          thumbnail: string | null;
          metadata: string;
        };
        await NodeFSP.writeFile(config.source, `staged-blend-${calls}`);
        await NodeFSP.writeFile(config.exported, await triangleGlb());
        if (config.thumbnail !== null) await NodeFSP.writeFile(config.thumbnail, thumbnailPng());
        // The revision drifts from the profile the first run recorded.
        await NodeFSP.writeFile(
          config.metadata,
          calls === 1
            ? metadataJson()
            : metadataJson({
                materialDetails: [{ name: "Rogue", color: [0, 1, 0] }],
                dimensions: [0.4, 0.4, 0.5],
              }),
        );
        return processOk(root);
      }),
    ({ root, current }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const first = yield* game.blender(threadId, {
          id: "coin",
          script: "import bpy",
          art: { palette: ["#ff0000"], targetHeight: 1.8 },
        });
        expect(first.meshes).toBe(1);
        expect(first.animations).toBe(1);
        expect(first.triangles).toBe(1);
        expect(first.materialDetails.map((entry) => entry.name)).toEqual(["StudioPalette_ff0000"]);
        expect(first.warnings).toEqual([]);
        expect(first.contactSheet).toBe("art/previews/contact_sheet.png");
        // Publishing lands the staged bytes at the stable paths.
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, "art/blender/coin.blend"), "utf8"),
          ),
        ).toBe("staged-blend-1");
        expect(current().artProfile).toEqual({ palette: ["#ff0000"], targetHeight: 1.8 });
        expect(current().assets).toHaveLength(1);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(root, "art/previews/contact_sheet.png")).then(
              (info) => info.size > 0,
              () => false,
            ),
          ),
        ).toBe(true);
        // A revision at the same id revises in place and judges itself against
        // the stored profile.
        const second = yield* game.blender(threadId, { id: "coin", script: "import bpy" });
        expect(second.asset.export).toBe(first.asset.export);
        expect(current().assets).toHaveLength(1);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, "art/blender/coin.blend"), "utf8"),
          ),
        ).toBe("staged-blend-2");
        expect(second.warnings.join("\n")).toContain("profile target");
        expect(second.warnings.join("\n")).toContain("outside the game palette");
      }),
  );
});
