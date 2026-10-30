// @effect-diagnostics nodeBuiltinImport:off -- Focused offline tests for library imports through the service; Poly Haven is stubbed, engines are stubbed.
// @effect-diagnostics globalFetch:off -- Tests stub the library HTTP boundary with cached fixtures; production streams through the service.
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
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
import {
  admissionTestLayer,
  previewBrowserTestLayer,
  roundStoreTestLayer,
} from "./gameTestLayers.ts";

const threadId = ThreadId.make("library-import-test");

const manifest = (): GameManifest => ({
  schemaVersion: 1,
  name: "Library probe",
  brief: "",
  artDirection: "",
  design: { status: "approved" },
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
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
  logPath: NodePath.join(root, "builds/logs/library-test.log"),
});

const md5 = (bytes: Uint8Array): string => NodeCrypto.createHash("md5").update(bytes).digest("hex");

// Valid small glTF fixture with one triangle, read through the upstream SDK.
// Positions (3x VEC3 float) plus indices (3x SCALAR u16) pack into 42 bytes.
const triangleBin = (): Buffer => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  const out = Buffer.alloc(42);
  Buffer.from(positions.buffer).copy(out, 0);
  Buffer.from(indices.buffer).copy(out, 36);
  return out;
};
const TRIANGLE_BIN = triangleBin();
const MODEL_GLTB_JSON = {
  asset: { version: "2.0" },
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", max: [1, 1, 0], min: [0, 0, 0] },
    { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: 36 },
    { buffer: 0, byteOffset: 36, byteLength: 6 },
  ],
  buffers: [{ uri: "test_crate_01.bin", byteLength: TRIANGLE_BIN.byteLength }],
  images: [{ uri: "textures/test_crate_01_diff_1k.jpg" }],
};
const MODEL_GLTB = JSON.stringify(MODEL_GLTB_JSON);
const MODEL_TEX = "texture-bytes-abcdef";

const modelFiles = () => {
  const gltf = Buffer.from(MODEL_GLTB);
  const bin = TRIANGLE_BIN;
  const tex = Buffer.from(MODEL_TEX);
  return {
    gltf: {
      url: "https://example.com/test_crate_01_1k.gltf",
      bytes: gltf,
      md5: md5(gltf),
    },
    bin: { url: "https://example.com/test_crate_01.bin", bytes: bin, md5: md5(bin) },
    tex: { url: "https://example.com/test_crate_01_diff_1k.jpg", bytes: tex, md5: md5(tex) },
  };
};

const MODEL_INFO = {
  type: 2,
  name: "Test Crate",
  description: "A small test crate.",
  category: "Props/Boxes",
  tags: ["wood", "crate"],
  authors: { Tester: "All" },
  thumbnail_url: "https://example.com/thumb.png",
  dimensions: [500, 500, 500],
  polycount: 100,
  max_resolution: [1024, 1024],
  download_count: 10,
};

const modelFilesJson = () => {
  const parts = modelFiles();
  return {
    gltf: {
      "1k": {
        gltf: {
          url: parts.gltf.url,
          size: parts.gltf.bytes.byteLength,
          md5: parts.gltf.md5,
          include: {
            "test_crate_01.bin": {
              url: parts.bin.url,
              size: parts.bin.bytes.byteLength,
              md5: parts.bin.md5,
            },
            "textures/test_crate_01_diff_1k.jpg": {
              url: parts.tex.url,
              size: parts.tex.bytes.byteLength,
              md5: parts.tex.md5,
            },
          },
        },
      },
    },
    blend: {
      "1k": { blend: { url: "https://example.com/a.blend", size: 10, md5: "a".repeat(32) } },
    },
  };
};

// Synthetic PBR bytes: JPEG magic so staged validation passes.
const jpg = (seed: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(seed)]);
const MAT_BYTES = { diff: jpg("diff-seed"), normal: jpg("normal-seed"), rough: jpg("rough-seed") };
const MAT_INFO = {
  type: 1,
  name: "Test Planks",
  description: "A small test PBR set.",
  category: "Wood/Planks",
  tags: ["wood"],
  authors: { Tester: "All" },
  thumbnail_url: "https://example.com/thumb.png",
  dimensions: [1000, 1000],
  max_resolution: [1024, 1024],
  download_count: 5,
};
const matFilesJson = () => {
  const entry = (bytes: Buffer, url: string) => ({ url, size: bytes.byteLength, md5: md5(bytes) });
  return {
    Diffuse: { "1k": { jpg: entry(MAT_BYTES.diff, "https://example.com/diff_1k.jpg") } },
    nor_gl: { "1k": { jpg: entry(MAT_BYTES.normal, "https://example.com/nor_1k.jpg") } },
    Rough: { "1k": { jpg: entry(MAT_BYTES.rough, "https://example.com/rough_1k.jpg") } },
  };
};

type FetchStub = { restore: () => void };
const stubLibraryFetch = (): FetchStub => {
  const original = globalThis.fetch;
  const parts = modelFiles();
  const byUrl: Record<string, Buffer> = {
    [parts.gltf.url]: parts.gltf.bytes,
    [parts.bin.url]: parts.bin.bytes,
    [parts.tex.url]: parts.tex.bytes,
    "https://example.com/diff_1k.jpg": MAT_BYTES.diff,
    "https://example.com/nor_1k.jpg": MAT_BYTES.normal,
    "https://example.com/rough_1k.jpg": MAT_BYTES.rough,
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.startsWith("https://api.polyhaven.com/info/test_crate_01"))
      return new Response(JSON.stringify(MODEL_INFO), { status: 200 });
    if (url.startsWith("https://api.polyhaven.com/files/test_crate_01"))
      return new Response(JSON.stringify(modelFilesJson()), { status: 200 });
    if (url.startsWith("https://api.polyhaven.com/info/test_planks_01"))
      return new Response(JSON.stringify(MAT_INFO), { status: 200 });
    if (url.startsWith("https://api.polyhaven.com/files/test_planks_01"))
      return new Response(JSON.stringify(matFilesJson()), { status: 200 });
    if (url in byUrl) {
      const bytes: Uint8Array = byUrl[url]!;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      return { ok: true, status: 200, body: stream } as unknown as Response;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { restore: () => void (globalThis.fetch = original) };
};

type RunFn = (input: {
  readonly root: string;
  readonly args: ReadonlyArray<string>;
}) => Effect.Effect<GameProcessResult, GameOperationError>;

const withGame = <A, E, R>(
  run: RunFn,
  body: (input: { readonly root: string }) => Effect.Effect<A, E, R>,
  fetchOverride?: () => { restore: () => void },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const stub = fetchOverride === undefined ? stubLibraryFetch() : fetchOverride();
      try {
        const base = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-library-import-")),
          ),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const root = NodePath.join(base, "game");
        const stateDir = NodePath.join(base, "state");
        const state = { current: manifest() };
        yield* Effect.promise(async () => {
          for (const [relative, contents] of [
            ["game.json", JSON.stringify(state.current)],
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
              upsertAsset: (assetRoot, asset, _options) =>
                Effect.promise(async () => {
                  state.current = {
                    ...state.current,
                    assets: state.current.assets
                      .filter((entry) => entry.id !== asset.id)
                      .concat(asset),
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
                Effect.succeed({ path: "/not-used/godot", version: "4.7.2", templates: null }),
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
        return yield* body({ root }).pipe(Effect.provide(services));
      } finally {
        stub.restore();
      }
    }),
  );

const FRESH_TRES = '[gd_resource type="StandardMaterial3D" format=3]\n';
const godotRun: RunFn = ({ root, args }) =>
  Effect.promise(async () => {
    if (args.includes("--editor")) return processOk(root);
    const separator = args.indexOf("--");
    const requestPath = separator === -1 ? undefined : args[separator + 1];
    const resultPath = separator === -1 ? undefined : args[separator + 2];
    if (requestPath !== undefined && resultPath !== undefined) {
      const request = JSON.parse(await NodeFSP.readFile(requestPath, "utf8")) as {
        outputPath: string;
        existingPath: string;
      };
      // Emulate the engine script: reuse byte-identical resources, refuse
      // edited ones instead of overwriting them.
      const existingRelative = request.existingPath.replace(/^res:\/\//, "");
      const existingAbsolute = NodePath.join(root, "godot", existingRelative);
      const current = await NodeFSP.readFile(existingAbsolute, "utf8").catch(() => null);
      if (current !== null) {
        if (current === FRESH_TRES) {
          await NodeFSP.writeFile(
            resultPath,
            JSON.stringify({ material: { name: "test", maps: 3 }, reused: true }),
          );
        } else {
          await NodeFSP.writeFile(
            resultPath,
            JSON.stringify({
              error: "The existing material was modified; it was not overwritten.",
            }),
          );
          return { ...processOk(root), exitCode: 1 };
        }
      } else {
        await NodeFSP.writeFile(request.outputPath, FRESH_TRES);
        await NodeFSP.writeFile(
          resultPath,
          JSON.stringify({ material: { name: "test", maps: 3 }, reused: false }),
        );
      }
    }
    return processOk(root);
  });

it.live("imports a model, reuses it byte-exact, and refuses edited files", () =>
  withGame(
    () => Effect.succeed(processOk("/unused")),
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const manifestBefore = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8"),
        );
        const first = yield* game.importLibraryModel(threadId, { id: "test_crate_01" });
        expect(first.alreadyPresent).toBe(false);
        expect(first.gltfResPath).toContain("res://assets/library/models/test_crate_01/");
        expect(first.gltfResPath.endsWith(".gltf")).toBe(true);
        expect(first.message).toContain("game_godot_import");
        expect(first.credit).toContain("Poly Haven");
        // Provenance stays with the download and the manifest is untouched.
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(
              NodePath.join(root, "art/library/models/test_crate_01/PROVENANCE.md"),
              "utf8",
            ),
          ),
        ).toContain("CC0-1.0");
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8")),
        ).toBe(manifestBefore);
        const second = yield* game.importLibraryModel(threadId, { id: "test_crate_01" });
        expect(second.alreadyPresent).toBe(true);
        expect(second.gltfResPath).toBe(first.gltfResPath);
        // A creator edit refuses instead of being overwritten.
        const gltfPath = NodePath.join(root, first.destination, "test_crate_01_1k.gltf");
        yield* Effect.promise(() => NodeFSP.writeFile(gltfPath, "creator edit"));
        const edited = yield* Effect.flip(
          game.importLibraryModel(threadId, { id: "test_crate_01" }),
        );
        expect(edited.reason).toBe("art-kit-conflict");
        expect(yield* Effect.promise(() => NodeFSP.readFile(gltfPath, "utf8"))).toBe(
          "creator edit",
        );
      }),
  ),
);

it.live("an interrupted import publishes nothing and retries cleanly", () =>
  withGame(
    () => Effect.succeed(processOk("/unused")),
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const manifestBefore = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8"),
        );
        // The download signals when its first bytes arrive; the test waits
        // for that milestone before interrupting, so the interrupt lands
        // mid-download instead of possibly before it starts.
        const started = Deferred.makeUnsafe<void>();
        let abortSeen = false;
        const inner = globalThis.fetch;
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          );
          if (url.startsWith("https://example.com/")) {
            Deferred.doneUnsafe(started, Effect.succeed(undefined));
            init?.signal?.addEventListener("abort", () => void (abortSeen = true), { once: true });
            await new Promise<never>((_, reject) => {
              if (init?.signal?.aborted === true) {
                abortSeen = true;
                reject(new DOMException("Aborted", "AbortError"));
                return;
              }
              init?.signal?.addEventListener(
                "abort",
                () => {
                  abortSeen = true;
                  reject(new DOMException("Aborted", "AbortError"));
                },
                { once: true },
              );
            });
          }
          return inner(input);
        }) as typeof fetch;
        try {
          const fiber = yield* game
            .importLibraryModel(threadId, { id: "test_crate_01" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(fiber);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          expect(abortSeen).toBe(true);
        } finally {
          globalThis.fetch = inner;
        }
        expect(
          yield* Effect.promise(() =>
            NodeFSP.lstat(NodePath.join(root, "godot/assets/library/models/test_crate_01")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8")),
        ).toBe(manifestBefore);
        // Retry with real stubbed bytes succeeds at the same stable paths.
        const retry = yield* game.importLibraryModel(threadId, { id: "test_crate_01" });
        expect(retry.alreadyPresent).toBe(false);
        expect(retry.gltfResPath).toContain("res://assets/library/models/test_crate_01/");
        expect((retry as Record<string, unknown>).assetId).toBe(undefined);
        expect(retry.destination).toBe("godot/assets/library/models/test_crate_01");
      }),
  ),
);

it.live("a missing model dependency publishes nothing", () =>
  withGame(
    () => Effect.succeed(processOk("/unused")),
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const error = yield* Effect.flip(
          game.importLibraryModel(threadId, { id: "test_crate_01", resolution: "2k" }),
        );
        expect(error.reason).toBe("invalid-input");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.lstat(NodePath.join(root, "godot/assets/library/models/test_crate_01")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }),
  ),
);

it.live("imports a material through Godot, reuses it, and refuses an edited resource", () =>
  withGame(godotRun, ({ root }) =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const first = yield* game.importLibraryMaterial(threadId, { id: "test_planks_01" });
      expect(first.alreadyPresent).toBe(false);
      expect(first.materialResPath).toContain("res://assets/library/materials/test_planks_01/");
      expect(first.maps).toEqual(["Diffuse", "nor_gl", "Rough"]);
      expect(first.physicalSizeM).toEqual([1, 1]);
      expect(first.usage).toContain("material_override");
      expect(first.message).toContain("non-colour");
      const second = yield* game.importLibraryMaterial(threadId, { id: "test_planks_01" });
      expect(second.alreadyPresent).toBe(true);
      expect(second.materialResPath).toBe(first.materialResPath);
      // An edited material refuses on rebuild instead of being overwritten.
      const tresPath = NodePath.join(root, first.destination, "test_planks_01_1k.tres");
      yield* Effect.promise(() => NodeFSP.writeFile(tresPath, "creator edit"));
      const refused = yield* Effect.flip(
        game.importLibraryMaterial(threadId, { id: "test_planks_01" }),
      );
      expect(refused.reason).toBe("command-failed");
      expect(refused.detail ?? "").toContain("modified");
      expect(yield* Effect.promise(() => NodeFSP.readFile(tresPath, "utf8"))).toBe("creator edit");
    }),
  ),
);

it.live("a texture slug is not a model", () =>
  withGame(
    () => Effect.succeed(processOk("/unused")),
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const error = yield* Effect.flip(
          game.importLibraryModel(threadId, { id: "test_planks_01" }),
        );
        expect(error.reason).toBe("invalid-input");
        expect(error.message).toContain("not a model");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.lstat(NodePath.join(root, "godot/assets/library/models/test_planks_01")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }),
  ),
);

it.live("a malformed staged glTF publishes nothing", () =>
  withGame(
    () => Effect.succeed(processOk("/unused")),
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const error = yield* Effect.flip(
          game.importLibraryModel(threadId, { id: "test_crate_01" }),
        );
        expect(error.reason).toBe("command-failed");
        expect(error.message).toContain("glTF");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.lstat(NodePath.join(root, "godot/assets/library/models/test_crate_01")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }),
    () => {
      // Malformed accessor: count 0 can never describe a triangle, so the
      // upstream SDK read plus the count check must refuse it. The files API
      // pins the malformed bytes, so the download succeeds and validation fails.
      const original = globalThis.fetch;
      const parts = modelFiles();
      const malformed = JSON.stringify({
        ...MODEL_GLTB_JSON,
        accessors: [{ bufferView: 0, componentType: 5126, count: 0, type: "VEC3" }],
      });
      const malformedBytes = Buffer.from(malformed);
      const malformedMd5 = md5(malformedBytes);
      const malformedFiles = {
        gltf: {
          "1k": {
            gltf: {
              url: parts.gltf.url,
              size: malformedBytes.byteLength,
              md5: malformedMd5,
              include: {
                "test_crate_01.bin": {
                  url: parts.bin.url,
                  size: parts.bin.bytes.byteLength,
                  md5: parts.bin.md5,
                },
                "textures/test_crate_01_diff_1k.jpg": {
                  url: parts.tex.url,
                  size: parts.tex.bytes.byteLength,
                  md5: parts.tex.md5,
                },
              },
            },
          },
        },
        blend: {
          "1k": { blend: { url: "https://example.com/a.blend", size: 10, md5: "a".repeat(32) } },
        },
      };
      const byUrl: Record<string, Buffer> = {
        [parts.gltf.url]: malformedBytes,
        [parts.bin.url]: parts.bin.bytes,
        [parts.tex.url]: parts.tex.bytes,
        "https://example.com/diff_1k.jpg": MAT_BYTES.diff,
        "https://example.com/nor_1k.jpg": MAT_BYTES.normal,
        "https://example.com/rough_1k.jpg": MAT_BYTES.rough,
      };
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.startsWith("https://api.polyhaven.com/info/test_crate_01"))
          return new Response(JSON.stringify(MODEL_INFO), { status: 200 });
        if (url.startsWith("https://api.polyhaven.com/files/test_crate_01"))
          return new Response(JSON.stringify(malformedFiles), { status: 200 });
        if (url.startsWith("https://api.polyhaven.com/info/test_planks_01"))
          return new Response(JSON.stringify(MAT_INFO), { status: 200 });
        if (url.startsWith("https://api.polyhaven.com/files/test_planks_01"))
          return new Response(JSON.stringify(matFilesJson()), { status: 200 });
        if (url in byUrl) {
          const bytes: Uint8Array = byUrl[url]!;
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(bytes);
              c.close();
            },
          });
          return { ok: true, status: 200, body: stream } as unknown as Response;
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;
      return { restore: () => void (globalThis.fetch = original) };
    },
  ),
);
