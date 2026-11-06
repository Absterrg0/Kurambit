// @effect-diagnostics nodeBuiltinImport:off -- Fixture models are written with plain fs.
// The art director judges sizes with these facts: a skinned model is measured as glTF places it.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { describeModel } from "./modelFacts.ts";

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => NodeFSP.rm(dir, { recursive: true, force: true }))));

const ibm = (scale: number) => {
  const m = new Float32Array([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1]);
  return `data:application/octet-stream;base64,${Buffer.from(m.buffer).toString("base64")}`;
};

const model = async (skin: object | null) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "model-facts-"));
  dirs.push(dir);
  const path = NodePath.join(dir, "fox.gltf");
  // The mesh sits under a node scaled 0.0001, which glTF ignores for a skinned
  // mesh; its one joint sits under the armature root, scaled 0.01.
  const doc = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0, 3] }],
    nodes: [
      { children: [1], scale: [0.0001, 0.0001, 0.0001] },
      { mesh: 0, ...(skin === null ? {} : { skin: 0 }) },
      {},
      { children: [2], scale: [0.01, 0.01, 0.01] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      { count: 3, min: [0, 0, 0], max: [25, 79, 155] },
      ...(skin === null ? [] : [{ bufferView: 0, componentType: 5126, count: 1, type: "MAT4" }]),
    ],
    ...(skin === null ? {} : skin),
  };
  await NodeFSP.writeFile(path, JSON.stringify(doc));
  return path;
};

describe("model facts", () => {
  it("places a skinned mesh by its joints, not by its own node", async () => {
    const path = await model({
      skins: [{ joints: [2], inverseBindMatrices: 1 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 64 }],
      buffers: [{ uri: ibm(1), byteLength: 64 }],
    });
    expect(await describeModel(path, "fox")).toContain("0.79 tall, 0.25 wide, 1.55 deep");
  });

  it("says a skinned size it cannot read is not measured, never a number", async () => {
    const path = await model({
      skins: [{ joints: [2], inverseBindMatrices: 1 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 64 }],
      buffers: [{ uri: "missing.bin", byteLength: 64 }],
    });
    const line = await describeModel(path, "fox");
    expect(line).toContain("skinned: size not measured");
    expect(line).not.toMatch(/tall/);
  });
});

describe("model facts on broken skins", () => {
  it("says a skin with fewer inverse bind matrices than joints is not measured", async () => {
    const path = await model({
      skins: [{ joints: [2, 3], inverseBindMatrices: 1 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 64 }],
      buffers: [{ uri: ibm(1), byteLength: 64 }],
    });
    expect(await describeModel(path, "fox")).toContain("skinned: size not measured");
  });

  it("refuses an impossible stride before reading anything", async () => {
    const path = await model({
      skins: [{ joints: [2], inverseBindMatrices: 1 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 64, byteStride: 1_000_000_000 }],
      buffers: [{ uri: "huge.bin", byteLength: 64 }],
    });
    expect(await describeModel(path, "fox")).toContain("impossible stride");
  });
});
