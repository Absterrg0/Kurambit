// @effect-diagnostics nodeBuiltinImport:off -- Fixture files live in an actual temporary tool directory.
import { it, expect } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GameProcesses from "./GameProcesses.ts";
it("resolves explicit paths before environment, managed installs, and PATH", () => {
  expect(
    GameToolchain.toolCandidates("blender", "/explicit/blender", "/env/blender", "/tools", "/bin"),
  ).toEqual(["/explicit/blender"]);
  expect(GameToolchain.toolCandidates("blender", "", "/env/blender", "/tools", "/bin")).toEqual([
    "/env/blender",
  ]);
  expect(GameToolchain.toolCandidates("godot", "", undefined, "/tools", "/bin:/usr/bin")).toEqual([
    "/tools/godot-4.7.2/Godot_v4.7.2-stable_linux.x86_64",
    "/bin/godot",
    "/bin/godot4",
    "/usr/bin/godot",
    "/usr/bin/godot4",
  ]);
});
it("accepts only Godot 4.7 and Blender 4.2 or later", () => {
  for (const version of ["4.7.2.stable.official.ed1daf0", "4.7.0.stable.official"])
    expect(GameToolchain.validToolVersion("godot", version)).toBe(true);
  for (const version of ["4.6.2.stable.official", "4.8.0.stable", "5.7.2", "unknown"])
    expect(GameToolchain.validToolVersion("godot", version)).toBe(false);
  for (const version of ["Blender 4.2.0", "Blender 4.5.14", "Blender 5.0.0"])
    expect(GameToolchain.validToolVersion("blender", version)).toBe(true);
  expect(GameToolchain.validToolVersion("blender", "Blender 4.1.1")).toBe(false);
});
it.effect("returns an actionable error for a bogus explicit path without falling back", () =>
  Effect.gen(function* () {
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const tools = yield* GameToolchain.GameToolchain;
        return yield* tools.status;
      }).pipe(
        Effect.provide(
          GameToolchain.layer.pipe(
            Layer.provide(GameProcesses.layer),
            Layer.provide(
              ServerSettings.layerTest({
                gameBlenderPath: "/no-such-studio/blender",
                gameGodotPath: "/no-such-studio/godot",
              }),
            ),
          ),
        ),
      ),
    );
    expect(result.tools.every((tool) => !tool.ready)).toBe(true);
    expect(result.tools[0]?.message).toContain("/no-such-studio/blender");
    expect(result.tools[0]?.message).toContain("Settings > General > Game tools");
  }),
);

it.effect("Web and Linux stay ready when only the Windows templates are missing", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-toolchain-windows-")),
      ),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const binary = NodePath.join(directory, "Godot_v4.7.2-stable_linux.x86_64");
    const templates = NodePath.join(directory, "editor_data/export_templates/4.7.2.stable");
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(templates, { recursive: true });
      await NodeFSP.writeFile(
        binary,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "4.7.2.stable.official.ed1daf0"; fi\nexit 0\n',
      );
      await NodeFSP.chmod(binary, 0o755);
      await NodeFSP.writeFile(NodePath.join(directory, "._sc_"), "");
      for (const file of [
        "web_nothreads_release.zip",
        "web_nothreads_debug.zip",
        "linux_release.x86_64",
        "linux_debug.x86_64",
        "version.txt",
      ])
        await NodeFSP.writeFile(NodePath.join(templates, file), "fixture");
    });
    const status = yield* Effect.scoped(
      Effect.gen(function* () {
        const tools = yield* GameToolchain.GameToolchain;
        return yield* tools.status;
      }).pipe(
        Effect.provide(
          GameToolchain.layer.pipe(
            Layer.provide(GameProcesses.layer),
            Layer.provide(ServerSettings.layerTest({ gameGodotPath: binary })),
          ),
        ),
      ),
    );
    const godot = status.tools.find((tool) => tool.tool === "godot");
    expect(godot?.ready).toBe(true);
    expect(godot?.message).toContain("Windows export templates are missing");
    expect(yield* Effect.promise(() => GameToolchain.hasBaseExportTemplates(templates))).toBe(true);
    expect(yield* Effect.promise(() => GameToolchain.hasWindowsExportTemplates(templates))).toBe(
      false,
    );

    yield* Effect.promise(async () => {
      for (const file of ["windows_release_x86_64.exe", "windows_debug_x86_64.exe"])
        await NodeFSP.writeFile(NodePath.join(templates, file), "fixture");
    });
    const updated = yield* Effect.scoped(
      Effect.gen(function* () {
        const tools = yield* GameToolchain.GameToolchain;
        return yield* tools.status;
      }).pipe(
        Effect.provide(
          GameToolchain.layer.pipe(
            Layer.provide(GameProcesses.layer),
            Layer.provide(ServerSettings.layerTest({ gameGodotPath: binary })),
          ),
        ),
      ),
    );
    expect(updated.tools.find((tool) => tool.tool === "godot")?.message).not.toContain(
      "Windows export templates are missing",
    );
  }),
);
