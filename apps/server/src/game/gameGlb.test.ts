// The GLB inspector reads exported bytes with the upstream glTF SDK, so the
// tests build their fixtures with that same SDK instead of hand-writing bytes.
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Document, NodeIO } from "@gltf-transform/core";
import { inspectGlb } from "./gameGlb.ts";

const io = new NodeIO();

const triangleDocument = (options?: { readonly material?: boolean }) => {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 2, 0, 0, 0, 4, 0]))
    .setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", positions);
  if (options?.material === true)
    primitive.setMaterial(document.createMaterial("Clay").setBaseColorFactor([1, 0, 0, 1]));
  const mesh = document.createMesh("Triangle").addPrimitive(primitive);
  const node = document.createNode("Root").setMesh(mesh);
  document.createScene("Scene").addChild(node);
  return document;
};

it.effect("reads meshes, triangles, materials and bounds from a real GLB", () =>
  Effect.promise(async () => {
    const inspection = await inspectGlb(
      new Uint8Array(await io.writeBinary(triangleDocument({ material: true }))),
    );
    expect(inspection.meshes).toBe(1);
    expect(inspection.primitives).toBe(1);
    expect(inspection.triangles).toBe(1);
    expect(inspection.materials).toBe(1);
    expect(inspection.untexturedMaterials).toBe(1);
    expect(inspection.textures).toBe(0);
    expect(inspection.animations).toBe(0);
    expect(inspection.bounds?.size.map((value) => Math.round(value))).toEqual([2, 4, 0]);
    expect(inspection.warnings).toEqual([]);
  }),
);

it.effect("warns on an empty export instead of failing it", () =>
  Effect.promise(async () => {
    const inspection = await inspectGlb(new Uint8Array(await io.writeBinary(new Document())));
    expect(inspection.meshes).toBe(0);
    expect(inspection.warnings.join("\n")).toContain("no meshes");
  }),
);

it.effect("counts animation channels on an animated export", () =>
  Effect.promise(async () => {
    const document = triangleDocument();
    const buffer = document.getRoot().listBuffers()[0]!;
    const input = document
      .createAccessor()
      .setType("SCALAR")
      .setArray(new Float32Array([0, 1]))
      .setBuffer(buffer);
    const output = document
      .createAccessor()
      .setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, 0, 0, 1]))
      .setBuffer(buffer);
    const sampler = document.createAnimationSampler().setInput(input).setOutput(output);
    const node = document.getRoot().listNodes()[0]!;
    document
      .createAnimation("Bob")
      .addChannel(document.createAnimationChannel().setTargetNode(node).setSampler(sampler));
    const inspection = await inspectGlb(new Uint8Array(await io.writeBinary(document)));
    expect(inspection.animations).toBe(1);
  }),
);

it.effect("rejects bytes that are not a GLB", () =>
  Effect.promise(async () => {
    const error = await inspectGlb(new Uint8Array([0x67, 0x6c, 0x54, 0x46])).then(
      () => null,
      (cause) => cause,
    );
    expect(error).not.toBeNull();
  }),
);

it.effect("does not report static vertex bounds as the size of a skinned model", () =>
  Effect.promise(async () => {
    const document = triangleDocument();
    const meshNode = document.getRoot().listNodes()[0]!;
    const joint = document.createNode("Joint").setScale([100, 100, 100]);
    document.getRoot().listScenes()[0]!.addChild(joint);
    meshNode.setSkin(document.createSkin("Rig").addJoint(joint));
    const inspection = await inspectGlb(await io.writeBinary(document));
    expect(inspection.meshes).toBe(1);
    expect(inspection.skins).toBe(1);
    expect(inspection.bounds).toBeNull();
    expect(inspection.warnings.join("\n")).toContain("require engine evaluation");
  }),
);
