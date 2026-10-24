// @effect-diagnostics nodeBuiltinImport:off -- Runs the pinned Godot binary against a real temporary game.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as GameArtKits from "./GameArtKits.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameToolchain from "./GameToolchain.ts";
import { gameArtKitCatalog } from "./artKitCatalog.ts";

const godotExecutable = NodePath.join(
  GameToolchain.toolsDirectory(),
  `godot-${GameToolchain.GODOT_VERSION}/Godot_v${GameToolchain.GODOT_VERSION}-stable_linux.x86_64`,
);
const available = NodeFS.existsSync(godotExecutable);

const godotCheck = (imagePath: string, width: number, height: number): string => `extends SceneTree

func _initialize() -> void:
	var texture := load(${JSON.stringify(imagePath)}) as Texture2D
	if texture == null:
		push_error("Imported kit atlas did not load as a Texture2D")
		quit(1)
		return
	if texture.get_width() != ${width} or texture.get_height() != ${height}:
		push_error("Imported kit atlas has the wrong size")
		quit(2)
		return
	var tile := AtlasTexture.new()
	tile.atlas = texture
	tile.region = Rect2(16, 112, 16, 16)
	var region := tile.get_image()
	if region == null or region.get_size() != Vector2i(16, 16):
		push_error("Imported kit atlas did not produce a 16x16 region")
		quit(3)
		return
	print("ART_KIT_OK %d %d %d %d" % [texture.get_width(), texture.get_height(), region.get_size().x, region.get_size().y])
	quit()
`;

it.live.skipIf(!available)(
  "the installed atlas imports and loads as a Texture2D and AtlasTexture in pinned Godot",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const base = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-art-godot-"))),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const root = NodePath.join(base, "game");
        const project = NodePath.join(root, "godot");
        yield* Effect.promise(() => NodeFSP.mkdir(project, { recursive: true }));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(project, "project.godot"),
            'config_version=5\n[application]\nconfig/name="Art kit proof"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
          ),
        );

        const result = yield* GameArtKits.make(gameArtKitCatalog).install({
          root,
          godotProject: "godot",
          id: "kenney-tiny-dungeon",
        });
        expect(result.alreadyPresent).toBe(false);
        expect(result.atlas.imageResPath).toBe(
          "res://assets/art/kits/kenney-tiny-dungeon/tilemap_packed.png",
        );

        const processes = yield* GameProcesses.GameProcesses;
        const imported = yield* processes.run({
          root: base,
          executable: godotExecutable,
          args: ["--headless", "--path", project, "--editor", "--import"],
          operation: "godot-art-kit-import",
          timeoutMs: 120_000,
        });
        // The check script needs a real .godot import cache; a nonzero import
        // would make a later load failure ambiguous.
        expect(imported.exitCode, `${imported.stdout}\n${imported.stderr}`).toBe(0);

        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(project, "art_kit_check.gd"),
            godotCheck(
              result.atlas.imageResPath,
              result.atlas.imageWidth,
              result.atlas.imageHeight,
            ),
          ),
        );
        const checked = yield* processes.run({
          root: base,
          executable: godotExecutable,
          args: ["--headless", "--path", project, "--script", "res://art_kit_check.gd"],
          operation: "godot-art-kit-check",
          timeoutMs: 60_000,
        });
        expect(checked.exitCode, `${checked.stdout}\n${checked.stderr}`).toBe(0);
        expect(checked.stdout).toContain("ART_KIT_OK 192 176 16 16");
      }).pipe(Effect.provide(GameProcesses.layer)),
    ),
  180_000,
);
