// @effect-diagnostics nodeBuiltinImport:off -- Opt-in live check: real Godot export plus pack inclusion. Root runs this; unit collection never launches an engine.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PNG } from "pngjs";
import { Document, NodeIO } from "@gltf-transform/core";
import {
  ProviderInstanceId,
  ThreadId,
  type GameManifest,
  type GameOperationError,
  type GameTemplateId,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as GameService from "./GameService.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  admissionTestLayer,
  previewBrowserTestLayer,
  projectTestLayer,
  qualificationTestLayer,
  designApprovalTestLayer,
  roundStoreTestLayer,
} from "./gameTestLayers.ts";

const available = NodeFS.existsSync(
  NodePath.join(GameToolchain.toolsDirectory(), "godot-4.7.2/Godot_v4.7.2-stable_linux.x86_64"),
);

const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };

const liveLayers = (stateDir: string) =>
  GameService.layer.pipe(
    Layer.provideMerge(GameProjectService.layer),
    Layer.provideMerge(GameOperations.layer),
    Layer.provideMerge(GameToolchain.layer),
    Layer.provideMerge(GamePreview.layer),
    Layer.provideMerge(GameProcesses.layer),
    Layer.provide(projectTestLayer()),
    Layer.provide(previewBrowserTestLayer()),
    Layer.provideMerge(qualificationTestLayer(stateDir)),
    Layer.provideMerge(designApprovalTestLayer(stateDir)),
    Layer.provideMerge(roundStoreTestLayer(stateDir)),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provideMerge(admissionTestLayer),
    Layer.provide(NodeServices.layer),
  );

const runLive = <A, E>(
  template: GameTemplateId,
  body: (input: {
    readonly root: string;
    readonly threadId: ThreadId;
  }) => Effect.Effect<
    A,
    E,
    | GameService.GameService
    | GameProjectService.GameProjectService
    | GameProcesses.GameProcesses
    | GameToolchain.GameToolchain
  >,
): Effect.Effect<A, E | GameOperationError | ServerSettingsError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const parent = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-export-live-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const stateDir = NodePath.join(parent, "state");
      return yield* Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const created = yield* projects.create({
          name: `Export inclusion live ${template}`,
          parentDirectory: parent,
          brief: "Live export inclusion check.",
          template,
          modelSelection: selection,
        });
        return yield* body({ root: created.root, threadId: created.threadId });
      }).pipe(Effect.provide(liveLayers(stateDir)));
    }),
  );

const writeFamilies = async (root: string, families: GameManifest["families"]) => {
  const manifestPath = NodePath.join(root, "game.json");
  const manifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8")) as GameManifest;
  await NodeFSP.writeFile(manifestPath, `${JSON.stringify({ ...manifest, families }, null, 2)}\n`);
};

it.live.skipIf(!available)(
  "pack inclusion distinguishes an exported scene from an export-excluded path without running game code",
  () =>
    runLive("blank", ({ root, threadId }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(
            NodePath.join(root, "godot/tripwire.gd"),
            'extends Node\nfunc _init():\n\tFileAccess.open("res://unexpected-write.txt", FileAccess.WRITE).store_string("ran")\n',
          );
          await NodeFSP.writeFile(
            NodePath.join(root, "godot/tripwire.tscn"),
            '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://tripwire.gd" id="1"]\n[node name="Tripwire" type="Node"]\nscript = ExtResource("1")\n',
          );
          await NodeFSP.writeFile(
            NodePath.join(root, "godot/tests/excluded.tscn"),
            '[gd_scene format=3]\n[node name="Excluded" type="Node"]\n',
          );
          const png = new PNG({ width: 2, height: 2 });
          png.data.fill(255);
          await NodeFSP.writeFile(NodePath.join(root, "godot/packed.png"), PNG.sync.write(png));
          const doc = new Document();
          const buffer = doc.createBuffer();
          const positions = doc
            .createAccessor()
            .setType("VEC3")
            .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
            .setBuffer(buffer);
          const mesh = doc
            .createMesh()
            .addPrimitive(doc.createPrimitive().setAttribute("POSITION", positions));
          doc.createScene().addChild(doc.createNode().setMesh(mesh));
          await NodeFSP.writeFile(
            NodePath.join(root, "godot/packed.glb"),
            await new NodeIO().writeBinary(doc),
          );
        });
        yield* Effect.promise(() =>
          writeFamilies(root, [
            { name: "hero", kind: "prop", paths: ["res://tripwire.tscn"] },
            { name: "ghost", kind: "prop", paths: ["res://scenes/missing.tscn"] },
          ]),
        );
        const exported = yield* game.export(threadId, "Web");
        expect(exported.success).toBe(true);
        const included = yield* game.assetsInspect(threadId, {
          paths: [
            "res://tripwire.tscn",
            "res://tests/excluded.tscn",
            "res://packed.png",
            "res://packed.glb",
          ],
        });
        expect(included.exportedUsage).toBe("unknown");
        expect(included.exportedInclusion.status, JSON.stringify(included.exportedInclusion)).toBe(
          "checked",
        );
        expect(included.exportedInclusion.includedPaths).toContain("res://tripwire.tscn");
        expect(included.exportedInclusion.missingPaths).toContain("res://tests/excluded.tscn");
        expect(included.exportedInclusion.includedPaths).toEqual(
          expect.arrayContaining(["res://packed.png", "res://packed.glb"]),
        );
        expect(
          yield* Effect.promise(() =>
            NodeFSP.access(NodePath.join(root, "godot/unexpected-write.txt")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
        // Tamper with the recorded pack: inclusion must refuse as stale, never claim use.
        const packFile = included.exportedInclusion.packFile;
        expect(packFile).not.toBeNull();
        yield* Effect.promise(() =>
          NodeFSP.appendFile(NodePath.join(root, packFile!), Buffer.from("TAMPER")),
        );
        const stale = yield* game.assetsInspect(threadId, {
          includeNative: false,
          paths: ["res://tripwire.tscn"],
        });
        expect(stale.exportedInclusion.status).toBe("unknown");
        expect(stale.exportedUsage).toBe("unknown");
      }),
    ),
);

it.live.skipIf(!available)(
  "a tiny header bomb refuses before the engine import on a real project",
  () =>
    runLive("blank", ({ root, threadId }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        yield* Effect.promise(async () => {
          const bytes = Buffer.alloc(33, 0);
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
          bytes.writeUInt32BE(13, 8);
          bytes.write("IHDR", 12, "ascii");
          bytes.writeUInt32BE(100_000, 16);
          bytes.writeUInt32BE(100_000, 20);
          await NodeFSP.writeFile(NodePath.join(root, "godot/bomb.png"), bytes);
        });
        const result = yield* game.assetsInspect(threadId, {});
        expect(result.native.status).toBe("unknown");
        expect(result.resources.some((entry) => entry.path === "godot/bomb.png")).toBe(true);
        expect(result.exportedUsage).toBe("unknown");
      }),
    ),
);
