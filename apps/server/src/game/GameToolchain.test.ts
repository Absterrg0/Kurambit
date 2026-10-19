import { it, expect } from "@effect/vitest";
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
    expect(result.tools[0]?.message).toContain("server settings");
  }),
);
