// @effect-diagnostics nodeBuiltinImport:off -- The test stages real files on disk, as the code under test reads them.
import { afterEach, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type { GameModelSidecar } from "@kurambit/contracts";
import { measureAssets } from "./assetFacts.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});

/** A GLB holding only its JSON chunk: a one-triangle mesh. */
const glb = (json: unknown) => {
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.write("glTF", 0, "latin1");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.write("JSON", 16, "latin1");
  return Buffer.concat([header, padded]);
};
const TRIANGLE = {
  asset: { version: "2.0" },
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [{ count: 3 }],
};

const sidecar = (model: string, bytes: Buffer): GameModelSidecar => ({
  version: 1,
  model,
  sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
  kind: "prop",
  skeleton: null,
  restDeviation: null,
  height: 1,
  footprint: { width: 1, depth: 1 },
  triangles: 1,
  materials: 1,
  textures: [],
  clips: [],
  springs: [],
  measured: { kit: "abc", key: "k", reviewedAt: "2026-11-07T00:00:00.000Z" },
  source: {
    route: "blender",
    parts: [
      { what: "parts", from: "made", licence: "made in this game", ai: false, credits: null },
    ],
    standIn: null,
    concept: null,
  },
});

const game = Effect.promise(async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "asset-facts-"));
  roots.push(root);
  const dir = NodePath.join(root, "web/assets/blender");
  await NodeFSP.mkdir(dir, { recursive: true });
  return { root, dir };
});
const write = (path: string, contents: string | Buffer) =>
  Effect.promise(() => NodeFSP.writeFile(path, contents));
const pipelineOf = (root: string, path: string) =>
  measureAssets(root, "three", "web").pipe(
    Effect.map((facts) => facts.models.find((model) => model.path === path)?.pipeline),
  );

it.effect("measures an export only while its GLB is the one its sidecar names", () =>
  Effect.gen(function* () {
    const { root, dir } = yield* game;
    const bytes = glb(TRIANGLE);
    yield* write(NodePath.join(dir, "crate.glb"), bytes);
    yield* write(
      NodePath.join(dir, "crate.asset.json"),
      JSON.stringify(sidecar("crate.glb", bytes)),
    );
    expect(yield* pipelineOf(root, "web/assets/blender/crate.glb")).toMatchObject({
      status: "measured",
      sidecar: "web/assets/blender/crate.asset.json",
    });
    // A hand edit of the GLB after its export.
    yield* write(NodePath.join(dir, "crate.glb"), glb({ ...TRIANGLE, extras: {} }));
    expect(yield* pipelineOf(root, "web/assets/blender/crate.glb")).toEqual({
      status: "not-measured",
      why: "the GLB changed after its export: export it again",
      retry: false,
    });
  }),
);

it.effect("never measures through a sidecar whose model is not this GLB's bare name", () =>
  Effect.gen(function* () {
    const { root, dir } = yield* game;
    // Bytes outside the assets folder that a path in the sidecar would name, hash and all.
    const outside = glb(TRIANGLE);
    yield* write(NodePath.join(root, "outside.glb"), outside);
    yield* write(NodePath.join(dir, "crate.glb"), glb({ ...TRIANGLE, extras: {} }));
    yield* write(
      NodePath.join(dir, "crate.asset.json"),
      JSON.stringify(sidecar("../../../outside.glb", outside)),
    );
    const pipeline = yield* pipelineOf(root, "web/assets/blender/crate.glb");
    expect(pipeline?.status).toBe("not-measured");
    expect(pipeline).toMatchObject({ why: expect.stringMatching(/^the sidecar is not valid/) });
    // A bare name of another model beside it is still not this model's measurement.
    yield* write(NodePath.join(dir, "other.glb"), outside);
    yield* write(
      NodePath.join(dir, "crate.asset.json"),
      JSON.stringify(sidecar("other.glb", outside)),
    );
    expect(yield* pipelineOf(root, "web/assets/blender/crate.glb")).toMatchObject({
      status: "not-measured",
      why: expect.stringMatching(/names other\.glb/),
    });
    // A GLB with no sidecar was never exported through the pipeline.
    expect(yield* pipelineOf(root, "web/assets/blender/other.glb")).toMatchObject({
      why: "no sidecar: not exported through the pipeline",
    });
  }),
);
