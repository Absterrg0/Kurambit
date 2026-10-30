// @effect-diagnostics nodeBuiltinImport:off -- Focused offline tests for the upstream library adapter; network is stubbed with cached Poly Haven fixtures.
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GameOperationError } from "@t3tools/contracts";
import * as GameAssetLibrary from "./GameAssetLibrary.ts";
import { GAME_LIBRARY_BOUNDS, GAME_LIBRARY_CREDIT } from "@t3tools/contracts";

const BARREL_INFO = {
  donated: true,
  type: 2,
  tags: ["industrial", "barrel", "oil", "fuel", "truck", "painted", "blue"],
  name: "Barrel 03",
  categories: ["industrial", "containers"],
  authors: { "Serhii Khromov": "All" },
  date_published: 1632268800,
  max_resolution: [4096, 4096],
  polycount: 1473,
  dimensions: [633.943498134613, 638.5995149612427, 930.4736243899824],
  description:
    "Free 4K model: weathered blue painted steel barrel with subtle rust, dents, scuffs and detailed surface imperfections; industrial oil/fuel container.",
  category: "Containers & Storage/Barrels & Drums/Metal Drums",
  download_count: 22181,
  thumbnail_url: "https://cdn.polyhaven.com/asset_img/thumbs/barrel_03.png?width=256",
};

const BARREL_FILES = {
  gltf: {
    "1k": {
      gltf: {
        include: {
          "textures/barrel_03_diff_1k.jpg": {
            size: 149997,
            url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/barrel_03/barrel_03_diff_1k.jpg",
            md5: "6e77dc1af60c48787fd80dbbcf125040",
          },
          "barrel_03.bin": {
            size: 44872,
            url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/4k/barrel_03/barrel_03.bin",
            md5: "6993587e3ef8e0603334e615ab292288",
          },
          "textures/barrel_03_nor_gl_1k.jpg": {
            size: 126707,
            url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/barrel_03/barrel_03_nor_gl_1k.jpg",
            md5: "fd181365eb7397d55773987d145f0420",
          },
          "textures/barrel_03_arm_1k.jpg": {
            size: 249922,
            url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/barrel_03/barrel_03_arm_1k.jpg",
            md5: "3520338e30b4d257745db34848098688",
          },
        },
        size: 2638,
        url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/barrel_03/barrel_03_1k.gltf",
        md5: "204eec2159a38a1dc4b826ef255f9468",
      },
    },
    "2k": {
      gltf: { include: {}, size: 2638, url: "https://example.com/2k.gltf", md5: "a".repeat(32) },
    },
    "4k": {
      gltf: { include: {}, size: 2638, url: "https://example.com/4k.gltf", md5: "b".repeat(32) },
    },
  },
  blend: {
    "1k": {
      blend: { include: {}, size: 1, url: "https://example.com/a.blend", md5: "c".repeat(32) },
    },
  },
  fbx: {
    "1k": { fbx: { include: {}, size: 1, url: "https://example.com/a.fbx", md5: "d".repeat(32) } },
  },
};

const PLANKS_INFO = {
  type: 1,
  tags: ["planks", "untreated", "boat", "costal", "dry", "old", "withered"],
  name: "Brown Planks 03",
  categories: ["wood"],
  authors: { "Rob Tuytel": "All" },
  dimensions: [1000, 1000],
  max_resolution: [8192, 8192],
  description: "Free 8K texture: weathered brown planks with dry, untreated surface.",
  category: "Wood/Boards & Planks/Weathered Planks",
  download_count: 157685,
  thumbnail_url: "https://cdn.polyhaven.com/asset_img/thumbs/brown_planks_03.png?width=256",
};

const PLANKS_FILES = {
  Diffuse: {
    "1k": {
      jpg: {
        size: 570668,
        md5: "6c9fdc21afcdf171d0a39999392a70f4",
        url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/brown_planks_03/brown_planks_03_diff_1k.jpg",
      },
    },
    "2k": { jpg: { size: 1, md5: "e".repeat(32), url: "https://example.com/d2k.jpg" } },
  },
  nor_gl: {
    "1k": {
      jpg: {
        size: 516860,
        md5: "4944cb903b7d7c4029310deb8a51d69e",
        url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/brown_planks_03/brown_planks_03_nor_gl_1k.jpg",
      },
    },
    "2k": { jpg: { size: 1, md5: "f".repeat(32), url: "https://example.com/n2k.jpg" } },
  },
  Rough: {
    "1k": {
      jpg: {
        size: 222197,
        md5: "7c205220c96d8fc72b1fae2ae8d7ccb6",
        url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/brown_planks_03/brown_planks_03_rough_1k.jpg",
      },
    },
    "2k": { jpg: { size: 1, md5: "0".repeat(32), url: "https://example.com/r2k.jpg" } },
  },
};

const stubFetch = (routes: Record<string, { status?: number; body: unknown }>) => {
  const original = globalThis.fetch;
  const stub = async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    for (const [prefix, route] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        const status = route.status ?? 200;
        return new Response(JSON.stringify(route.body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response("not found", { status: 404 });
  };
  globalThis.fetch = stub;
  return () => {
    globalThis.fetch = original;
  };
};

it.effect("plans the barrel 1k glTF set with pinned sizes before any download", () =>
  Effect.gen(function* () {
    const plan = GameAssetLibrary.planModelFiles("barrel_03", BARREL_FILES, "1k");
    expect(plan.format).toBe("gltf");
    expect(plan.files).toHaveLength(5);
    expect(plan.files[0]?.path).toBe("barrel_03_1k.gltf");
    expect(plan.files.map((file) => file.path)).toContain("barrel_03.bin");
    expect(plan.files.map((file) => file.path)).toContain("textures/barrel_03_diff_1k.jpg");
    const total = GameAssetLibrary.totalBytesOf(plan.files);
    expect(total).toBe(2638 + 149997 + 44872 + 126707 + 249922);
    expect(total).toBeLessThan(GAME_LIBRARY_BOUNDS.maxTotalBytes);
    GameAssetLibrary.checkBudgets("barrel_03", plan.files);
  }),
);

it.effect("plans the planks 1k PBR maps as albedo plus non-colour data", () =>
  Effect.gen(function* () {
    const plan = GameAssetLibrary.planMaterialFiles("brown_planks_03", PLANKS_FILES, "1k");
    expect(plan.format).toBe("jpg");
    expect(plan.files).toHaveLength(3);
    expect(plan.files[0]?.url).toContain("brown_planks_03_diff_1k.jpg");
    expect(plan.files[1]?.url).toContain("brown_planks_03_nor_gl_1k.jpg");
    expect(plan.files[2]?.url).toContain("brown_planks_03_rough_1k.jpg");
    const total = GameAssetLibrary.totalBytesOf(plan.files);
    expect(total).toBe(570668 + 516860 + 222197);
    GameAssetLibrary.checkBudgets("brown_planks_03", plan.files);
  }),
);

it.effect("rejects an oversized plan before any byte is fetched", () =>
  Effect.gen(function* () {
    const huge = [
      {
        path: "big.bin",
        url: "https://example.com/big.bin",
        bytes: GAME_LIBRARY_BOUNDS.maxFileBytes + 1,
        md5: "a".repeat(32),
      },
    ];
    let reason: string | undefined;
    try {
      GameAssetLibrary.checkBudgets("huge_asset", huge);
    } catch (cause) {
      reason = (cause as GameOperationError).reason;
    }
    expect(reason).toBe("invalid-input");
  }),
);

it.effect("rejects unsafe dependency paths instead of writing outside the game", () =>
  Effect.gen(function* () {
    const evil = {
      gltf: {
        "1k": {
          gltf: {
            include: {
              "../evil.txt": { size: 10, url: "https://example.com/evil.txt", md5: "b".repeat(32) },
            },
            size: 10,
            url: "https://example.com/a.gltf",
            md5: "c".repeat(32),
          },
        },
      },
    };
    let reason: string | undefined;
    try {
      GameAssetLibrary.planModelFiles("evil", evil, "1k");
    } catch (cause) {
      reason = (cause as GameOperationError).reason;
    }
    expect(reason).toBe("invalid-input");
  }),
);

it.effect("fails a material plan with a missing map instead of a partial set", () =>
  Effect.gen(function* () {
    const partial = { Diffuse: PLANKS_FILES.Diffuse, nor_gl: PLANKS_FILES.nor_gl };
    let error: GameOperationError | undefined;
    try {
      GameAssetLibrary.planMaterialFiles("partial", partial, "1k");
    } catch (cause) {
      error = cause as GameOperationError;
    }
    expect(error?.reason).toBe("invalid-input");
    expect(error?.message).toContain("Rough");
  }),
);

it.effect("search returns bounded enriched hits with credit", () => {
  const restore = stubFetch({
    "https://api.polyhaven.com/search": {
      body: {
        query: "barrel",
        type: "models",
        total: 261,
        results: [{ slug: "barrel_03", score: 0.6728 }],
      },
    },
    "https://api.polyhaven.com/info/barrel_03": { body: BARREL_INFO },
  });
  return Effect.gen(function* () {
    const library = yield* GameAssetLibrary.GameAssetLibrary;
    const result = yield* library.search({ q: "Barrel", type: "models", limit: 5 });
    expect(result.query).toBe("barrel");
    expect(result.total).toBe(261);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.slug).toBe("barrel_03");
    expect(result.hits[0]?.kind).toBe("model");
    expect(result.hits[0]?.category).toContain("Barrels");
    expect(result.credit).toBe(GAME_LIBRARY_CREDIT);
  }).pipe(Effect.provide(GameAssetLibrary.layer), Effect.ensuring(Effect.sync(restore)));
});

it.effect("default search combines supported models and textures without upstream HDRIs", () => {
  const restore = stubFetch({
    "https://api.polyhaven.com/search?q=camp&t=models&limit=5": {
      body: { total: 2, results: [{ slug: "barrel_03", score: 0.9 }] },
    },
    "https://api.polyhaven.com/search?q=camp&t=textures&limit=5": {
      body: { total: 3, results: [{ slug: "brown_planks_03", score: 0.8 }] },
    },
    "https://api.polyhaven.com/info/barrel_03": { body: BARREL_INFO },
    "https://api.polyhaven.com/info/brown_planks_03": { body: PLANKS_INFO },
  });
  return Effect.gen(function* () {
    const library = yield* GameAssetLibrary.GameAssetLibrary;
    const result = yield* library.search({ q: "camp" });
    expect(result.type).toBe("all");
    expect(result.total).toBe(5);
    expect(result.hits.map((hit) => hit.kind)).toEqual(["model", "texture"]);
  }).pipe(Effect.provide(GameAssetLibrary.layer), Effect.ensuring(Effect.sync(restore)));
});

it.effect("get returns the model plan with provenance-ready license and source", () => {
  const restore = stubFetch({
    "https://api.polyhaven.com/info/barrel_03": { body: BARREL_INFO },
    "https://api.polyhaven.com/files/barrel_03": { body: BARREL_FILES },
  });
  return Effect.gen(function* () {
    const library = yield* GameAssetLibrary.GameAssetLibrary;
    const result = yield* library.get({ id: "barrel_03" });
    expect(result.asset.name).toBe("Barrel 03");
    expect(result.asset.type).toBe("model");
    expect(result.asset.polycount).toBe(1473);
    expect(result.files).toHaveLength(5);
    expect(result.asset.license.name).toBe("CC0-1.0");
    expect(result.asset.license.url).toBe("https://polyhaven.com/license");
    expect(result.asset.source.url).toBe("https://polyhaven.com/a/barrel_03");
    expect(result.message).toContain("1473");
    expect(result.credit).toBe(GAME_LIBRARY_CREDIT);
  }).pipe(Effect.provide(GameAssetLibrary.layer), Effect.ensuring(Effect.sync(restore)));
});

it.effect("get returns the material plan with physical scale and no repaint claim", () => {
  const restore = stubFetch({
    "https://api.polyhaven.com/info/brown_planks_03": { body: PLANKS_INFO },
    "https://api.polyhaven.com/files/brown_planks_03": { body: PLANKS_FILES },
  });
  return Effect.gen(function* () {
    const library = yield* GameAssetLibrary.GameAssetLibrary;
    const result = yield* library.get({ id: "brown_planks_03" });
    expect(result.asset.type).toBe("texture");
    expect(result.asset.dimensionsMm).toEqual([1000, 1000]);
    expect(result.files).toHaveLength(3);
    expect(result.message).toContain("non-colour");
    expect(result.message).toContain("never a repaint");
  }).pipe(Effect.provide(GameAssetLibrary.layer), Effect.ensuring(Effect.sync(restore)));
});

it.effect("get maps a missing asset to invalid-input, not a crash", () => {
  const restore = stubFetch({});
  return Effect.gen(function* () {
    const library = yield* GameAssetLibrary.GameAssetLibrary;
    const error = yield* Effect.flip(library.get({ id: "no_such_asset" }));
    expect(error.reason).toBe("invalid-input");
  }).pipe(Effect.provide(GameAssetLibrary.layer), Effect.ensuring(Effect.sync(restore)));
});

it.effect("provenance keeps license, authors, pins and credit without executable content", () =>
  Effect.gen(function* () {
    const plan = GameAssetLibrary.planModelFiles("barrel_03", BARREL_FILES, "1k");
    const text = GameAssetLibrary.provenanceMarkdown({
      slug: "barrel_03",
      name: "Barrel 03",
      kind: "model",
      authors: ["Serhii Khromov"],
      pageUrl: "https://polyhaven.com/a/barrel_03",
      files: plan.files,
      resolution: "1k",
      format: "gltf",
      retrievedAt: "2026-10-28",
    });
    expect(text).toContain("CC0-1.0");
    expect(text).toContain("Serhii Khromov");
    expect(text).toContain("https://polyhaven.com/a/barrel_03");
    expect(text).toContain("md5");
    expect(text).toContain(GAME_LIBRARY_CREDIT);
    expect(text).toContain("never instructions");
    expect(text).not.toContain("exec(");
  }),
);

it.live("streams one pinned file and verifies its md5", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode("library-fixture-bytes");
      const md5 = NodeCrypto.createHash("md5").update(bytes).digest("hex");
      const original = globalThis.fetch;
      globalThis.fetch = (async () => new Response(bytes, { status: 200 })) as typeof fetch;
      try {
        const staging = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-library-dl-"))),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const done = yield* GameAssetLibrary.downloadPlannedFiles(
          staging,
          [{ path: "tile.jpg", url: "https://example.com/tile.jpg", bytes: bytes.byteLength, md5 }],
          "test-download",
        );
        expect(done).toHaveLength(1);
        expect(done[0]?.bytes).toBe(bytes.byteLength);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(staging, "tile.jpg"))),
        ).toEqual(Buffer.from(bytes));
      } finally {
        globalThis.fetch = original;
      }
    }),
  ),
);

it.live("fails a corrupted download without publishing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode("corrupted-bytes");
      const original = globalThis.fetch;
      globalThis.fetch = (async () => new Response(bytes, { status: 200 })) as typeof fetch;
      try {
        const staging = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-library-dl-"))),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const error = yield* Effect.flip(
          GameAssetLibrary.downloadPlannedFiles(
            staging,
            [
              {
                path: "tile.jpg",
                url: "https://example.com/tile.jpg",
                bytes: bytes.byteLength,
                md5: "0".repeat(32),
              },
            ],
            "test-download",
          ),
        );
        expect(error.reason).toBe("download");
      } finally {
        globalThis.fetch = original;
      }
    }),
  ),
);

it.live("cancels a nonterminating oversized response before disk exceeds pinned bytes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pinned = 16;
      let cancelCalled = false;
      const chunk = new Uint8Array(8).fill(0x61);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunk);
        },
        cancel() {
          cancelCalled = true;
        },
      });
      const original = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(stream, { status: 200 })) as unknown as typeof fetch;
      try {
        const staging = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-library-dl-"))),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const error = yield* Effect.flip(
          GameAssetLibrary.downloadPlannedFiles(
            staging,
            [
              {
                path: "tile.jpg",
                url: "https://example.com/tile.jpg",
                bytes: pinned,
                md5: "a".repeat(32),
              },
            ],
            "test-download",
          ),
        );
        expect(error.reason).toBe("download");
        expect(cancelCalled).toBe(true);
        const stat = yield* Effect.promise(() =>
          NodeFSP.stat(NodePath.join(staging, "tile.jpg")).catch(() => null),
        );
        expect(stat === null || stat.size <= pinned).toBe(true);
      } finally {
        globalThis.fetch = original;
      }
    }),
  ),
);

it.effect("cancels oversized JSON while reading, before parsing or buffering the rest", () =>
  Effect.gen(function* () {
    let canceled = false;
    let pulled = 0;
    const chunk = new Uint8Array(64_000);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    try {
      const error = yield* GameAssetLibrary.fetchLibraryJson(
        "https://api.polyhaven.com/info/big_asset",
      ).pipe(Effect.match({ onFailure: (cause) => cause, onSuccess: () => null }));
      expect(error?.reason).toBe("download");
      expect(error?.message).toContain("2 MB reader limit");
      expect(canceled).toBe(true);
      expect(pulled).toBeLessThanOrEqual(
        GameAssetLibrary.LIBRARY_JSON_MAX_BYTES + 2 * chunk.byteLength,
      );
    } finally {
      globalThis.fetch = original;
    }
  }),
);

it.effect("rejects duplicate destinations instead of overwriting on publish", () =>
  Effect.gen(function* () {
    const files = [
      { path: "a.bin", url: "https://example.com/a.bin", bytes: 10, md5: "a".repeat(32) },
      { path: "a.bin", url: "https://example.com/a2.bin", bytes: 10, md5: "b".repeat(32) },
    ];
    let reason: string | undefined;
    try {
      GameAssetLibrary.checkBudgets("dup_asset", files);
    } catch (cause) {
      reason = (cause as GameOperationError).reason;
    }
    expect(reason).toBe("invalid-input");
  }),
);

it.effect("rejects unsafe and nonintegral planned files", () =>
  Effect.gen(function* () {
    for (const bad of [
      { path: "../evil.bin", url: "https://example.com/evil.bin", bytes: 10, md5: "a".repeat(32) },
      { path: "/abs.bin", url: "https://example.com/abs.bin", bytes: 10, md5: "a".repeat(32) },
      { path: "a\\b.bin", url: "https://example.com/b.bin", bytes: 10, md5: "a".repeat(32) },
      { path: "ok.bin", url: "https://example.com/ok.bin", bytes: 10.5, md5: "a".repeat(32) },
      { path: "ok2.bin", url: "https://example.com/ok2.bin", bytes: 0, md5: "a".repeat(32) },
    ]) {
      let reason: string | undefined;
      try {
        GameAssetLibrary.checkBudgets("bad_asset", [bad as never]);
      } catch (cause) {
        reason = (cause as GameOperationError).reason;
      }
      expect(reason).toBe("invalid-input");
    }
  }),
);

it.effect("rejects fractional upstream sizes instead of planning them", () =>
  Effect.gen(function* () {
    const fractional = {
      gltf: {
        "1k": {
          gltf: {
            url: "https://example.com/a.gltf",
            size: 10.5,
            md5: "c".repeat(32),
            include: {},
          },
        },
      },
    };
    let reason: string | undefined;
    try {
      GameAssetLibrary.planModelFiles("fractional", fractional, "1k");
    } catch (cause) {
      reason = (cause as GameOperationError).reason;
    }
    expect(reason).toBe("invalid-input");
  }),
);

it.effect("asks JPG exclusively instead of silently taking PNG or EXR", () =>
  Effect.gen(function* () {
    const pngOnly = {
      Diffuse: {
        "1k": { png: { url: "https://example.com/d.png", size: 10, md5: "a".repeat(32) } },
      },
      nor_gl: {
        "1k": { jpg: { url: "https://example.com/n.jpg", size: 10, md5: "b".repeat(32) } },
      },
      Rough: { "1k": { jpg: { url: "https://example.com/r.jpg", size: 10, md5: "c".repeat(32) } } },
    };
    let error: GameOperationError | undefined;
    try {
      GameAssetLibrary.planMaterialFiles("png_asset", pngOnly, "1k");
    } catch (cause) {
      error = cause as GameOperationError;
    }
    expect(error?.reason).toBe("invalid-input");
    expect(error?.message).toContain("JPEG");
  }),
);
