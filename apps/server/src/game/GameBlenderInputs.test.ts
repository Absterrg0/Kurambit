// @effect-diagnostics nodeBuiltinImport:off -- Focused mocked tests for bounded named Blender inputs; no engines run.
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
  GAME_BLENDER_INPUT_BOUNDS,
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
import { inspectGlb } from "./gameGlb.ts";
import { renderRunScript } from "./blenderScript.ts";
import {
  admissionTestLayer,
  previewBrowserTestLayer,
  roundStoreTestLayer,
} from "./gameTestLayers.ts";

const threadId = ThreadId.make("blender-inputs-test");
const io = new NodeIO();

const manifest = (): GameManifest => ({
  schemaVersion: 1,
  name: "Inputs probe",
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
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-blender-inputs-")),
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
        // Real library-format source: .gltf plus a relative .bin, written
        // through the upstream SDK so the fixture parses, not hand-made.
        const sourceDoc = new Document();
        const sourceBuffer = sourceDoc.createBuffer();
        sourceDoc
          .createAccessor()
          .setType("VEC3")
          .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
          .setBuffer(sourceBuffer);
        const sourcePrimitive = sourceDoc.createPrimitive();
        const sourceMesh = sourceDoc.createMesh("Base").addPrimitive(sourcePrimitive);
        sourceDoc.createScene("Scene").addChild(sourceDoc.createNode("Root").setMesh(sourceMesh));
        const gltfPath = NodePath.join(root, "godot/assets/library/models/crate/crate.gltf");
        await NodeFSP.mkdir(NodePath.dirname(gltfPath), { recursive: true });
        await io.write(gltfPath, sourceDoc);
        // Real image source for texture reuse.
        const texPath = NodePath.join(root, "godot/assets/library/materials/bark/diffuse.png");
        await NodeFSP.mkdir(NodePath.dirname(texPath), { recursive: true });
        await NodeFSP.writeFile(texPath, thumbnailPng());
        // Unsupported-type fixture.
        await NodeFSP.writeFile(NodePath.join(root, "godot/assets/notes.txt"), "notes");
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

const readFinals = (root: string) =>
  Effect.promise(async () => ({
    blend: await NodeFSP.readFile(NodePath.join(root, "art/blender/coin.blend"), "utf8"),
    script: await NodeFSP.readFile(NodePath.join(root, "art/scripts/coin.py"), "utf8"),
    export: await NodeFSP.readFile(NodePath.join(root, "godot/assets/models/coin.glb"), "utf8"),
  }));

const manifestBytes = (root: string) =>
  Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8"));

it("renders ASSET_INPUTS in the run script and packs images", () => {
  const rendered = renderRunScript("/tmp/game/builds/logs/blender-1/config.json");
  expect(rendered).toContain("ASSET_INPUTS");
  expect(rendered).toContain("image.pack()");
  expect(rendered).not.toContain("__STUDIO_BLENDER_CONFIG__");
});

it.live("stages named .gltf and image inputs, exposes them and records bindings", () =>
  withGame(
    ({ root, args }) =>
      Effect.promise(async () => {
        const config = JSON.parse(await NodeFSP.readFile(configOf(args), "utf8")) as {
          source: string;
          exported: string;
          metadata: string;
          thumbnail: string | null;
          inputs: Record<string, string>;
        };
        expect(Object.keys(config.inputs).sort()).toEqual(["bark", "base"]);
        // Staged .gltf became a self-contained GLB the importer reads alone.
        const baseGlb = await NodeFSP.readFile(config.inputs["base"]!);
        const inspection = await inspectGlb(new Uint8Array(baseGlb));
        expect(inspection.meshes).toBeGreaterThanOrEqual(1);
        const barkBytes = await NodeFSP.readFile(config.inputs["bark"]!);
        expect(PNG.sync.read(barkBytes).width).toBe(32);
        await NodeFSP.writeFile(config.source, "staged-blend");
        await NodeFSP.writeFile(config.exported, await triangleGlb());
        if (config.thumbnail !== null) await NodeFSP.writeFile(config.thumbnail, thumbnailPng());
        await NodeFSP.writeFile(config.metadata, metadataJson());
        return processOk(root);
      }),
    ({ root, current }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const crateBefore = yield* Effect.promise(() =>
          NodeFSP.readFile(
            NodePath.join(root, "godot/assets/library/models/crate/crate.gltf"),
            "utf8",
          ),
        );
        const texBefore = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, "godot/assets/library/materials/bark/diffuse.png")),
        );
        const result = yield* game.blender(threadId, {
          id: "coin",
          script: "import bpy",
          thumbnail: false,
          inputs: [
            { name: "base", path: "godot/assets/library/models/crate/crate.gltf" },
            { name: "bark", path: "res://assets/library/materials/bark/diffuse.png" },
          ],
        });
        expect(result.asset.inputs).toEqual([
          { name: "base", path: "godot/assets/library/models/crate/crate.gltf" },
          { name: "bark", path: "res://assets/library/materials/bark/diffuse.png" },
        ]);
        expect(current().assets.find((entry) => entry.id === "coin")?.inputs).toEqual(
          result.asset.inputs,
        );
        // Input sources are reads: staging never rewrites them.
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(
              NodePath.join(root, "godot/assets/library/models/crate/crate.gltf"),
              "utf8",
            ),
          ),
        ).toBe(crateBefore);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(
              NodePath.join(root, "godot/assets/library/materials/bark/diffuse.png"),
            ),
          ),
        ).toEqual(texBefore);
      }),
  ),
);

it.live("rejects missing, unsupported, duplicate, escaping and remote inputs before Blender", () =>
  withGame(
    () => Effect.die("Blender must not launch for invalid inputs."),
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const before = yield* readFinals(root);
        const beforeManifest = yield* manifestBytes(root);
        const cases: Array<{ inputs: Array<{ name: string; path: string }>; match: string }> = [
          { inputs: [{ name: "gone", path: "godot/assets/missing.glb" }], match: "missing" },
          { inputs: [{ name: "note", path: "godot/assets/notes.txt" }], match: "not supported" },
          {
            inputs: [
              { name: "dup", path: "godot/assets/library/models/crate/crate.gltf" },
              { name: "dup", path: "godot/assets/library/materials/bark/diffuse.png" },
            ],
            match: "Duplicate",
          },
          { inputs: [{ name: "esc", path: "../outside.glb" }], match: "escapes" },
          { inputs: [{ name: "abs", path: "/tmp/evil.glb" }], match: "escapes" },
          {
            inputs: [{ name: "remote", path: "https://example.com/a.glb" }],
            match: "remote",
          },
        ];
        for (const entry of cases) {
          const error = yield* game
            .blender(threadId, { id: "coin", script: "import bpy", inputs: entry.inputs })
            .pipe(Effect.flip);
          expect(error.reason).toBe("invalid-input");
          expect(error.detail ?? "").toContain(entry.match);
        }
        expect(yield* readFinals(root)).toEqual(before);
        expect(yield* manifestBytes(root)).toBe(beforeManifest);
      }),
  ),
);

it.live("rejects a symlink input and an oversized image", () =>
  withGame(
    () => Effect.die("Blender must not launch for symlink or dimension failures."),
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        yield* Effect.promise(async () => {
          await NodeFSP.symlink(
            NodePath.join(root, "godot/assets/library/materials/bark/diffuse.png"),
            NodePath.join(root, "godot/assets/link.png"),
          );
          // Forged header: 9000x16 without allocating the pixels. The header
          // check rejects it before any full decode.
          const forged = Buffer.concat([
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            Buffer.from([0, 0, 0, 13]),
            Buffer.from("IHDR", "ascii"),
            Buffer.alloc(4),
            Buffer.alloc(4),
            Buffer.from([8, 2, 0, 0, 0]),
            Buffer.alloc(4),
          ]);
          forged.writeUInt32BE(9000, 16);
          forged.writeUInt32BE(16, 20);
          await NodeFSP.writeFile(NodePath.join(root, "godot/assets/huge.png"), forged);
        });
        const symlinkError = yield* game
          .blender(threadId, {
            id: "coin",
            script: "import bpy",
            inputs: [{ name: "link", path: "godot/assets/link.png" }],
          })
          .pipe(Effect.flip);
        expect(symlinkError.reason).toBe("invalid-input");
        expect(symlinkError.detail ?? "").toContain("symlink");
        const hugeError = yield* game
          .blender(threadId, {
            id: "coin",
            script: "import bpy",
            inputs: [{ name: "huge", path: "godot/assets/huge.png" }],
          })
          .pipe(Effect.flip);
        expect(hugeError.reason).toBe("invalid-input");
        expect(hugeError.detail ?? "").toContain(
          `${GAME_BLENDER_INPUT_BOUNDS.maxImageDimension}px`,
        );
        const manyError = yield* game
          .blender(threadId, {
            id: "coin",
            script: "import bpy",
            inputs: [0, 1, 2, 3, 4].map((index) => ({
              name: `in${index}`,
              path: "godot/assets/library/materials/bark/diffuse.png",
            })),
          })
          .pipe(Effect.flip);
        expect(manyError.reason).toBe("invalid-input");
        expect(manyError.detail ?? "").toContain("Too many inputs");
      }),
  ),
);

it.live("rejects a .gltf whose dependency is missing and publishes nothing", () =>
  withGame(
    () => Effect.die("Blender must not launch for a broken dependency."),
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        yield* Effect.promise(async () => {
          const gltfPath = NodePath.join(root, "godot/assets/library/models/crate/crate.gltf");
          const binPath = NodePath.join(
            NodePath.dirname(gltfPath),
            JSON.parse(await NodeFSP.readFile(gltfPath, "utf8")).buffers[0].uri,
          );
          await NodeFSP.rm(binPath);
        });
        const before = yield* readFinals(root);
        const beforeManifest = yield* manifestBytes(root);
        const error = yield* game
          .blender(threadId, {
            id: "coin",
            script: "import bpy",
            inputs: [{ name: "base", path: "godot/assets/library/models/crate/crate.gltf" }],
          })
          .pipe(Effect.flip);
        expect(error.reason).toBe("invalid-input");
        expect(error.detail ?? "").toContain("dependency");
        expect(yield* readFinals(root)).toEqual(before);
        expect(yield* manifestBytes(root)).toBe(beforeManifest);
      }),
  ),
);

it.live("a failed export with inputs keeps live files, sources and manifest", () =>
  withGame(
    ({ root }) =>
      Effect.succeed({ ...processOk(root), exitCode: 1, stderr: "Traceback\nRuntimeError: boom" }),
    ({ root, current }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const before = yield* readFinals(root);
        const beforeManifest = yield* manifestBytes(root);
        const error = yield* game
          .blender(threadId, {
            id: "coin",
            script: "raise boom",
            inputs: [{ name: "base", path: "godot/assets/library/models/crate/crate.gltf" }],
          })
          .pipe(Effect.flip);
        expect(error.reason).toBe("command-failed");
        expect(yield* readFinals(root)).toEqual(before);
        expect(yield* manifestBytes(root)).toBe(beforeManifest);
        expect(current().assets.find((entry) => entry.id === "coin")?.inputs).toBeUndefined();
      }),
  ),
);

it.live("an interrupted export with inputs keeps the last good asset", () =>
  withGame(
    () => Effect.interrupt,
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const before = yield* readFinals(root);
        const fiber = yield* game
          .blender(threadId, {
            id: "coin",
            script: "import time; time.sleep(30)",
            inputs: [{ name: "base", path: "godot/assets/library/models/crate/crate.gltf" }],
          })
          .pipe(Effect.forkChild);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(yield* readFinals(root)).toEqual(before);
        expect(yield* manifestBytes(root)).toBe(JSON.stringify(manifest()));
      }),
  ),
);

it.live("a revision without new inputs preserves the previous bindings", () => {
  let calls = 0;
  return withGame(
    ({ root, args }) =>
      Effect.promise(async () => {
        calls += 1;
        const config = JSON.parse(await NodeFSP.readFile(configOf(args), "utf8")) as {
          source: string;
          exported: string;
          metadata: string;
          thumbnail: string | null;
          inputs: Record<string, string>;
        };
        if (calls === 1) expect(Object.keys(config.inputs)).toEqual(["base"]);
        else expect(Object.keys(config.inputs)).toEqual([]);
        await NodeFSP.writeFile(config.source, `staged-blend-${calls}`);
        await NodeFSP.writeFile(config.exported, await triangleGlb());
        await NodeFSP.writeFile(config.metadata, metadataJson());
        return processOk(root);
      }),
    ({ current }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const first = yield* game.blender(threadId, {
          id: "coin",
          script: "import bpy",
          thumbnail: false,
          inputs: [{ name: "base", path: "godot/assets/library/models/crate/crate.gltf" }],
        });
        expect(first.asset.inputs).toHaveLength(1);
        const second = yield* game.blender(threadId, {
          id: "coin",
          script: "import bpy",
          thumbnail: false,
        });
        expect(second.asset.inputs).toEqual(first.asset.inputs);
        expect(current().assets.find((entry) => entry.id === "coin")?.inputs).toEqual(
          first.asset.inputs,
        );
      }),
  );
});

const forgedPng = (width: number, height: number): Buffer => {
  // Valid PNG signature plus IHDR dimensions, then truncation: the header
  // guards must reject this before any pixel decode, which would fail with a
  // different "does not decode" message instead of the pixel bound.
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR", "ascii"),
    Buffer.alloc(4),
    Buffer.alloc(4),
    Buffer.from([8, 2, 0, 0, 0]),
    Buffer.alloc(4),
  ]);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

const texturedModel = async (image: Uint8Array, mime: string): Promise<Document> => {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const texture = document.createTexture("paint").setMimeType(mime).setImage(image);
  const material = document.createMaterial("paint").setBaseColorTexture(texture);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", positions)
    .setMaterial(material);
  const mesh = document.createMesh("mesh").addPrimitive(primitive);
  document.createScene("scene").addChild(document.createNode("root").setMesh(mesh));
  return document;
};

it.live("stages percent-encoded URIs and contained parent-relative dependencies", () =>
  withGame(
    ({ root, args }) =>
      Effect.promise(async () => {
        const config = JSON.parse(await NodeFSP.readFile(configOf(args), "utf8")) as {
          source: string;
          exported: string;
          metadata: string;
          thumbnail: string | null;
          inputs: Record<string, string>;
        };
        expect(Object.keys(config.inputs).sort()).toEqual(["enc", "rel"]);
        for (const key of ["enc", "rel"] as const) {
          const inspection = await inspectGlb(
            new Uint8Array(await NodeFSP.readFile(config.inputs[key]!)),
          );
          expect(inspection.meshes).toBeGreaterThanOrEqual(1);
          expect(inspection.textures).toBeGreaterThanOrEqual(1);
        }
        await NodeFSP.writeFile(config.source, "staged-blend");
        await NodeFSP.writeFile(config.exported, await triangleGlb());
        await NodeFSP.writeFile(config.metadata, metadataJson());
        return processOk(root);
      }),
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        yield* Effect.promise(async () => {
          // Percent-encoded sibling dependency: the URI spells
          // "mesh%20data.bin" while the file on disk has a real space, and
          // NodeIO resolves it with decodeURIComponent.
          const encDir = NodePath.join(root, "godot/assets/encoded");
          await NodeFSP.mkdir(encDir, { recursive: true });
          const generated = await io.writeJSON(await texturedModel(thumbnailPng(), "image/png"));
          const bin = generated.resources[generated.json.buffers![0]!.uri!]!;
          const png = generated.resources[generated.json.images![0]!.uri!]!;
          generated.json.buffers![0]!.uri = "mesh%20data.bin";
          generated.json.images![0]!.uri = "base%20color.png";
          await NodeFSP.writeFile(NodePath.join(encDir, "mesh data.bin"), Buffer.from(bin));
          await NodeFSP.writeFile(NodePath.join(encDir, "base color.png"), Buffer.from(png));
          await NodeFSP.writeFile(
            NodePath.join(encDir, "source.gltf"),
            JSON.stringify(generated.json),
          );
          // Contained parent: rig.gltf reaches ../textures/skin.png, which
          // stays inside the game.
          const rigDir = NodePath.join(root, "godot/assets/models/rig");
          const texDir = NodePath.join(root, "godot/assets/models/textures");
          await NodeFSP.mkdir(rigDir, { recursive: true });
          await NodeFSP.mkdir(texDir, { recursive: true });
          const rigged = await io.writeJSON(await texturedModel(thumbnailPng(), "image/png"));
          const rigBin = rigged.resources[rigged.json.buffers![0]!.uri!]!;
          const rigPng = rigged.resources[rigged.json.images![0]!.uri!]!;
          rigged.json.buffers![0]!.uri = "rig.bin";
          rigged.json.images![0]!.uri = "../textures/skin.png";
          await NodeFSP.writeFile(NodePath.join(rigDir, "rig.bin"), Buffer.from(rigBin));
          await NodeFSP.writeFile(NodePath.join(texDir, "skin.png"), Buffer.from(rigPng));
          await NodeFSP.writeFile(NodePath.join(rigDir, "rig.gltf"), JSON.stringify(rigged.json));
        });
        const result = yield* game.blender(threadId, {
          id: "coin",
          script: "import bpy",
          thumbnail: false,
          inputs: [
            { name: "enc", path: "godot/assets/encoded/source.gltf" },
            { name: "rel", path: "godot/assets/models/rig/rig.gltf" },
          ],
        });
        expect(result.asset.inputs).toEqual([
          { name: "enc", path: "godot/assets/encoded/source.gltf" },
          { name: "rel", path: "godot/assets/models/rig/rig.gltf" },
        ]);
      }),
  ),
);

it.live("rejects oversized images on every input path before Blender", () =>
  withGame(
    () => Effect.die("Blender must not launch for oversized images."),
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        yield* Effect.promise(async () => {
          // One forged 8192x8192 header reused directly, as a .gltf
          // dependency, as a data URI and embedded in a GLB. Each rejects on
          // the pixel bound; without the header guard the decode would fail
          // with "does not decode" instead.
          const big = forgedPng(8192, 8192);
          await NodeFSP.writeFile(NodePath.join(root, "godot/assets/big.png"), big);
          const depDir = NodePath.join(root, "godot/assets/depmodel");
          await NodeFSP.mkdir(depDir, { recursive: true });
          const deped = await io.writeJSON(await texturedModel(thumbnailPng(), "image/png"));
          const depBin = deped.resources[deped.json.buffers![0]!.uri!]!;
          deped.json.buffers![0]!.uri = "dep.bin";
          deped.json.images![0]!.uri = "big.png";
          await NodeFSP.writeFile(NodePath.join(depDir, "dep.bin"), Buffer.from(depBin));
          await NodeFSP.writeFile(NodePath.join(depDir, "big.png"), big);
          await NodeFSP.writeFile(NodePath.join(depDir, "dep.gltf"), JSON.stringify(deped.json));
          const inline = await io.writeJSON(await texturedModel(thumbnailPng(), "image/png"));
          const inlineBin = inline.resources[inline.json.buffers![0]!.uri!]!;
          inline.json.buffers![0]!.uri = "inline.bin";
          inline.json.images![0]!.uri = `data:image/png;base64,${big.toString("base64")}`;
          await NodeFSP.writeFile(NodePath.join(depDir, "inline.bin"), Buffer.from(inlineBin));
          await NodeFSP.writeFile(
            NodePath.join(depDir, "inline.gltf"),
            JSON.stringify(inline.json),
          );
          const embedded = await io.writeBinary(await texturedModel(big, "image/png"));
          await NodeFSP.writeFile(
            NodePath.join(root, "godot/assets/embedded.glb"),
            Buffer.from(embedded),
          );
        });
        const before = yield* readFinals(root);
        const beforeManifest = yield* manifestBytes(root);
        const cases: Array<{ inputs: Array<{ name: string; path: string }>; match: string }> = [
          { inputs: [{ name: "big", path: "godot/assets/big.png" }], match: "per-image bound" },
          {
            inputs: [{ name: "dep", path: "godot/assets/depmodel/dep.gltf" }],
            match: "per-image bound",
          },
          {
            inputs: [{ name: "inline", path: "godot/assets/depmodel/inline.gltf" }],
            match: "per-image bound",
          },
          {
            inputs: [{ name: "large", path: "godot/assets/embedded.glb" }],
            match: "per-image bound",
          },
        ];
        for (const entry of cases) {
          const error = yield* game
            .blender(threadId, { id: "coin", script: "import bpy", inputs: entry.inputs })
            .pipe(Effect.flip);
          expect(error.reason).toBe("invalid-input");
          expect(error.detail ?? "").toContain(entry.match);
        }
        expect(yield* readFinals(root)).toEqual(before);
        expect(yield* manifestBytes(root)).toBe(beforeManifest);
      }),
  ),
);

it.live("rejects decoded-pixel totals across named inputs", () =>
  withGame(
    () => Effect.die("Blender must not launch past the total pixel bound."),
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        yield* Effect.promise(async () => {
          // Three inline 4000x3000 images (12 MP each): the third pushes the
          // run past the 32 MP total. Forged headers keep the fixture tiny;
          // the area guard rejects before any decode is attempted.
          const one = `data:image/png;base64,${forgedPng(4000, 3000).toString("base64")}`;
          const document = {
            asset: { version: "2.0" },
            images: [{ uri: one }, { uri: one }, { uri: one }],
          };
          const dir = NodePath.join(root, "godot/assets/total");
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(dir, "total.gltf"), JSON.stringify(document));
        });
        const error = yield* game
          .blender(threadId, {
            id: "coin",
            script: "import bpy",
            inputs: [{ name: "many", path: "godot/assets/total/total.gltf" }],
          })
          .pipe(Effect.flip);
        expect(error.reason).toBe("invalid-input");
        expect(error.detail ?? "").toContain("total bound");
      }),
  ),
);

it.live("rejects escaping, remote and symlink glTF dependencies", () =>
  withGame(
    () => Effect.die("Blender must not launch for unsafe dependencies."),
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        yield* Effect.promise(async () => {
          const dir = NodePath.join(root, "godot/assets/depunsafe");
          await NodeFSP.mkdir(dir, { recursive: true });
          const document = (imageUri: string) => ({
            asset: { version: "2.0" },
            buffers: [{ byteLength: 4, uri: "dep.bin" }],
            images: [{ uri: imageUri }],
          });
          await NodeFSP.writeFile(NodePath.join(dir, "dep.bin"), Buffer.alloc(4));
          await NodeFSP.writeFile(
            NodePath.join(dir, "escape.gltf"),
            JSON.stringify(document("../../../../evil.bin")),
          );
          await NodeFSP.writeFile(
            NodePath.join(dir, "remote.gltf"),
            JSON.stringify(document("https://example.com/a.png")),
          );
          await NodeFSP.writeFile(NodePath.join(dir, "real.png"), thumbnailPng());
          await NodeFSP.symlink(NodePath.join(dir, "real.png"), NodePath.join(dir, "linked.png"));
          await NodeFSP.writeFile(
            NodePath.join(dir, "linked.gltf"),
            JSON.stringify(document("linked.png")),
          );
        });
        const cases: Array<{ file: string; match: string }> = [
          { file: "escape.gltf", match: "outside the game" },
          { file: "remote.gltf", match: "network assets are not fetched" },
          { file: "linked.gltf", match: "symlink" },
        ];
        for (const entry of cases) {
          const error = yield* game
            .blender(threadId, {
              id: "coin",
              script: "import bpy",
              inputs: [{ name: "dep", path: `godot/assets/depunsafe/${entry.file}` }],
            })
            .pipe(Effect.flip);
          expect(error.reason).toBe("invalid-input");
          expect(error.detail ?? "").toContain(entry.match);
        }
      }),
  ),
);

it.live("reset without new inputs clears stale bindings", () => {
  let calls = 0;
  return withGame(
    ({ root, args }) =>
      Effect.promise(async () => {
        calls += 1;
        const config = JSON.parse(await NodeFSP.readFile(configOf(args), "utf8")) as {
          source: string;
          exported: string;
          metadata: string;
          thumbnail: string | null;
          inputs: Record<string, string>;
        };
        if (calls === 1) expect(Object.keys(config.inputs)).toEqual(["base"]);
        else expect(Object.keys(config.inputs)).toEqual([]);
        await NodeFSP.writeFile(config.source, `staged-blend-${calls}`);
        await NodeFSP.writeFile(config.exported, await triangleGlb());
        await NodeFSP.writeFile(config.metadata, metadataJson());
        return processOk(root);
      }),
    ({ current }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const first = yield* game.blender(threadId, {
          id: "coin",
          script: "import bpy",
          thumbnail: false,
          inputs: [{ name: "base", path: "godot/assets/library/models/crate/crate.gltf" }],
        });
        expect(first.asset.inputs).toHaveLength(1);
        // Reset starts a fresh source: stale bindings must not carry over.
        const reset = yield* game.blender(threadId, {
          id: "coin",
          script: "import bpy",
          thumbnail: false,
          reset: true,
        });
        expect(reset.asset.inputs).toBeUndefined();
        expect(current().assets.find((entry) => entry.id === "coin")?.inputs).toBeUndefined();
        // A later revision without inputs stays clear: nothing resurrects.
        const revised = yield* game.blender(threadId, {
          id: "coin",
          script: "import bpy",
          thumbnail: false,
        });
        expect(revised.asset.inputs).toBeUndefined();
      }),
  );
});
