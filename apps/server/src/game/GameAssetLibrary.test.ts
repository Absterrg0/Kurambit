// @effect-diagnostics nodeBuiltinImport:off -- The test stages real files on disk, as the code under test reads them.
import { afterAll, beforeAll, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { GameOperationError } from "@kurambit/contracts";
import * as GameAssetLibrary from "./GameAssetLibrary.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameTemplates from "./GameTemplates.ts";
import * as ServerSettings from "../serverSettings.ts";

let data = "";
const previous = process.env.XDG_DATA_HOME;
beforeAll(async () => {
  // The library cache lives under XDG_DATA_HOME: a private one, so nothing real is touched.
  data = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "library-"));
  process.env.XDG_DATA_HOME = data;
});
afterAll(async () => {
  if (previous === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previous;
  await NodeFSP.rm(data, { recursive: true, force: true });
});

// packFile never reaches processes or games; a refusal must come before any fetch.
const layer = GameAssetLibrary.layer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(GameProcesses.GameProcesses, {} as GameProcesses.GameProcesses["Service"]),
  ),
  Layer.provide(
    Layer.succeed(
      GameProjectService.GameProjectService,
      {} as GameProjectService.GameProjectService["Service"],
    ),
  ),
  Layer.provide(
    Layer.succeed(GameTemplates.GameTemplates, {
      directory: Effect.fail(
        new GameOperationError({ operation: "test", path: "", reason: "templates-missing" }),
      ),
    }),
  ),
);

it.effect("refuses a pack file path that leaves the pack, before fetching anything", () =>
  Effect.gen(function* () {
    const library = yield* GameAssetLibrary.GameAssetLibrary;
    for (const path of [
      "../../../../etc/passwd",
      "Unreal-Godot/../../x.glb",
      "/etc/passwd",
      "a//b.glb",
      "a\\..\\b.glb",
      "./Unreal-Godot/UAL1_Standard.glb",
    ]) {
      const error = yield* library
        .packFile("quaternius-universal-animation-library", path)
        .pipe(Effect.flip);
      expect(error.reason).toBe("invalid-path");
    }
    // Nothing was downloaded or unpacked for the refusals.
    const packs = yield* Effect.promise(() =>
      NodeFSP.readdir(NodePath.join(data, "kurambit/asset-library/packs")).catch(() => []),
    );
    expect(packs).toEqual([]);
  }).pipe(Effect.provide(layer)),
);
