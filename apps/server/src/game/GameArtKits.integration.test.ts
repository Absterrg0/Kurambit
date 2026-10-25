// @effect-diagnostics nodeBuiltinImport:off -- Runs the pinned Godot binary against a real temporary game.
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
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

/**
 * A real X server is needed for pixels: Godot's headless display driver is a
 * dummy renderer. `xvfb-run` keeps that server virtual, so no window reaches
 * the user's desktop. CI images normally install it; this workstation has it
 * in a snapped core image, hence the bounded search.
 */
const xvfbRun = (() => {
  const candidates = [process.env.XVFB_RUN, "/usr/bin/xvfb-run", "/usr/local/bin/xvfb-run"].filter(
    (candidate): candidate is string => candidate !== undefined,
  );
  for (const candidate of candidates) if (NodeFS.existsSync(candidate)) return candidate;
  try {
    const found = NodeChildProcess.execFileSync("/bin/sh", ["-c", "command -v xvfb-run"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (found !== "") return found;
  } catch {
    // Fall through to the snap layout.
  }
  const snapRoot = "/var/lib/snapd/snap";
  if (NodeFS.existsSync(snapRoot)) {
    for (const entry of NodeFS.readdirSync(snapRoot)) {
      const revisions = NodePath.join(snapRoot, entry);
      let children: ReadonlyArray<string> = [];
      try {
        children = NodeFS.readdirSync(revisions);
      } catch {
        continue;
      }
      for (const revision of children) {
        const candidate = NodePath.join(revisions, revision, "usr/bin/xvfb-run");
        if (NodeFS.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
})();

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

const renderScript = (tilesPath: string, charactersPath: string): string => `extends SceneTree

const SCALE := 3
const TILE := 18
const CHARACTER := 24

var _tiles: Texture2D
var _characters: Texture2D
var _player: Sprite2D
var _out := ""

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() < 1:
		push_error("Missing render output directory")
		quit(2)
		return
	_out = args[0]
	_tiles = load(${JSON.stringify(tilesPath)}) as Texture2D
	_characters = load(${JSON.stringify(charactersPath)}) as Texture2D
	if _tiles == null or _characters == null:
		push_error("Imported art kit sheet did not load as a Texture2D")
		quit(3)
		return
	if _tiles.get_size() != Vector2(360, 162) or _characters.get_size() != Vector2(216, 72):
		push_error("Imported art kit sheet has the wrong size")
		quit(4)
		return
	var world := Node2D.new()
	root.add_child(world)
	# Column 0 is a standalone block; columns 1-3 are the wide surface's
	# left/middle/right, so a long run repeats column 2.
	for x in range(12):
		var surface_col := 2
		if x == 0:
			surface_col = 1
		elif x == 11:
			surface_col = 3
		_sprite(world, _tiles, surface_col, 0, TILE, Vector2(x * TILE * SCALE, 216))
		_sprite(world, _tiles, 4 + (x % 2), 0, TILE, Vector2(x * TILE * SCALE, 270))
		_sprite(world, _tiles, 4 + (x % 2), 0, TILE, Vector2(x * TILE * SCALE, 324))
	for i in range(4):
		var platform_col := 2
		if i == 0:
			platform_col = 1
		elif i == 3:
			platform_col = 3
		_sprite(world, _tiles, platform_col, 2, TILE, Vector2(216 + i * TILE * SCALE, 108))
	_sprite(world, _tiles, 4, 4, TILE, Vector2(54, 162))
	_sprite(world, _tiles, 11, 7, TILE, Vector2(270, 54))
	_sprite(world, _tiles, 6, 6, TILE, Vector2(486, 162))
	_sprite(world, _tiles, 13, 7, TILE, Vector2(540, 18))
	_player = _sprite(world, _characters, 0, 0, CHARACTER, Vector2(162, 144))
	_sprite(world, _characters, 2, 1, CHARACTER, Vector2(432, 144))
	await process_frame
	await process_frame
	await process_frame
	var frame0 := _capture("frame-0.png")
	if frame0 == null:
		quit(5)
		return
	_player.texture = _region(_characters, 1, 0, CHARACTER)
	await process_frame
	await process_frame
	var frame1 := _capture("frame-1.png")
	if frame1 == null:
		quit(6)
		return
	var report := {
		"frame0": _stats(frame0),
		"frame1": _stats(frame1),
		"diff": _diff(frame0, frame1),
	}
	print("ART_KIT_RENDER " + JSON.stringify(report))
	quit()

func _region(atlas: Texture2D, col: int, row: int, cell: int) -> AtlasTexture:
	var texture := AtlasTexture.new()
	texture.atlas = atlas
	texture.region = Rect2(col * cell, row * cell, cell, cell)
	return texture

func _sprite(parent: Node, atlas: Texture2D, col: int, row: int, cell: int, position: Vector2) -> Sprite2D:
	var sprite := Sprite2D.new()
	sprite.texture = _region(atlas, col, row, cell)
	sprite.centered = false
	sprite.position = position
	sprite.scale = Vector2(SCALE, SCALE)
	sprite.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	parent.add_child(sprite)
	return sprite

func _capture(name: String) -> Image:
	var image := root.get_texture().get_image()
	if image == null or image.get_size() != Vector2i(640, 360):
		push_error("Viewport did not render a 640x360 frame")
		return null
	var path := _out + "/" + name
	if image.save_png(path) != OK:
		push_error("Could not save rendered frame " + path)
		return null
	return image

func _stats(image: Image) -> Dictionary:
	var background := image.get_pixel(0, 0).to_rgba32()
	var unique := {}
	var non_sky := 0
	for y in range(image.get_height()):
		for x in range(image.get_width()):
			var color := image.get_pixel(x, y).to_rgba32()
			unique[color] = true
			if color != background:
				non_sky += 1
	return {
		"width": image.get_width(),
		"height": image.get_height(),
		"unique": unique.size(),
		"nonSky": non_sky,
		"playerGreen": _count(image, Rect2i(162, 144, 72, 72), "green"),
		"groundGreen": _count(image, Rect2i(0, 216, 640, 54), "green"),
		"dirtBrown": _count(image, Rect2i(0, 270, 640, 54), "brown"),
		"coinGold": _count(image, Rect2i(270, 54, 54, 54), "gold"),
	}

func _count(image: Image, area: Rect2i, mode: String) -> int:
	var matches := 0
	for y in range(area.position.y, area.position.y + area.size.y):
		for x in range(area.position.x, area.position.x + area.size.x):
			if x < 0 or y < 0 or x >= image.get_width() or y >= image.get_height():
				continue
			var color := image.get_pixel(x, y)
			if mode == "green":
				if color.g > color.r + 0.08 and color.g > color.b + 0.02:
					matches += 1
			elif mode == "brown":
				if color.r > color.g + 0.04 and color.g > color.b + 0.04:
					matches += 1
			elif mode == "gold":
				if color.r > 0.55 and color.g > 0.30 and color.b < 0.35:
					matches += 1
	return matches

func _diff(left: Image, right: Image) -> int:
	var changed := 0
	for y in range(144, 216):
		for x in range(162, 234):
			if left.get_pixel(x, y).to_rgba32() != right.get_pixel(x, y).to_rgba32():
				changed += 1
	return changed
`;

interface RenderStats {
  readonly width: number;
  readonly height: number;
  readonly unique: number;
  readonly nonSky: number;
  readonly playerGreen: number;
  readonly groundGreen: number;
  readonly dirtBrown: number;
  readonly coinGold: number;
}
interface RenderReport {
  readonly frame0: RenderStats;
  readonly frame1: RenderStats;
  readonly diff: number;
}

it.live.skipIf(!available || xvfbRun === null)(
  "the imported platformer kit renders a real player, ground, platform and coin frame",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const base = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-art-render-"))),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const root = NodePath.join(base, "game");
        const project = NodePath.join(root, "godot");
        const out = NodePath.join(base, "render");
        yield* Effect.promise(() => NodeFSP.mkdir(project, { recursive: true }));
        yield* Effect.promise(() => NodeFSP.mkdir(out, { recursive: true }));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(project, "project.godot"),
            [
              "config_version=5",
              "[application]",
              'config/name="Art kit platformer render"',
              "[display]",
              "window/size/viewport_width=640",
              "window/size/viewport_height=360",
              "window/size/window_width_override=640",
              "window/size/window_height_override=360",
              'window/stretch/mode="viewport"',
              "[rendering]",
              'renderer/rendering_method="gl_compatibility"',
              "textures/canvas_textures/default_texture_filter=0",
              "2d/snap/snap_2d_transforms_to_pixel=true",
              "environment/defaults/default_clear_color=Color(0.42, 0.72, 0.9, 1)",
              "",
            ].join("\n"),
          ),
        );

        const result = yield* GameArtKits.make(gameArtKitCatalog).install({
          root,
          godotProject: "godot",
          id: "kenney-pixel-platformer",
        });
        expect(result.files).toHaveLength(4);
        expect(result.additionalSheets[0]?.imageResPath).toBe(
          "res://assets/art/kits/kenney-pixel-platformer/tilemap-characters_packed.png",
        );

        const processes = yield* GameProcesses.GameProcesses;
        const imported = yield* processes.run({
          root: base,
          executable: godotExecutable,
          args: ["--headless", "--path", project, "--editor", "--import"],
          operation: "godot-art-kit-platformer-import",
          timeoutMs: 120_000,
        });
        expect(imported.exitCode, `${imported.stdout}\n${imported.stderr}`).toBe(0);

        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(project, "render_art_kit.gd"),
            renderScript(result.atlas.imageResPath, result.additionalSheets[0]!.imageResPath),
          ),
        );
        const rendered = yield* processes.run({
          root: base,
          executable: "/usr/bin/env",
          args: [
            "LIBGL_ALWAYS_SOFTWARE=1",
            `PATH=${NodePath.dirname(xvfbRun!)}:${process.env.PATH ?? ""}`,
            xvfbRun!,
            "-a",
            "-s",
            "-screen 0 800x600x24",
            godotExecutable,
            "--path",
            project,
            "--script",
            "res://render_art_kit.gd",
            "--",
            out,
          ],
          operation: "godot-art-kit-platformer-render",
          timeoutMs: 180_000,
        });
        expect(rendered.exitCode, `${rendered.stdout}\n${rendered.stderr}`).toBe(0);
        const line = rendered.stdout
          .split("\n")
          .find((entry) => entry.startsWith("ART_KIT_RENDER "));
        expect(line, rendered.stdout).toBeDefined();
        const report = JSON.parse(line!.slice("ART_KIT_RENDER ".length)) as RenderReport;
        expect(report.frame0.width).toBe(640);
        expect(report.frame0.height).toBe(360);
        expect(report.frame0.unique).toBeGreaterThan(10);
        expect(report.frame0.nonSky).toBeGreaterThan(50_000);
        expect(report.frame0.playerGreen).toBeGreaterThan(100);
        expect(report.frame0.groundGreen).toBeGreaterThan(5_000);
        expect(report.frame0.dirtBrown).toBeGreaterThan(5_000);
        expect(report.frame0.coinGold).toBeGreaterThan(50);
        expect(report.diff).toBeGreaterThan(100);
        expect(report.frame1.unique).toBe(report.frame0.unique);
        expect(report.frame1.playerGreen).toBeGreaterThan(100);

        const evidence = process.env.GAME_ART_KIT_RENDER_DIR;
        if (evidence !== undefined) {
          yield* Effect.promise(() => NodeFSP.mkdir(evidence, { recursive: true }));
          for (const name of ["frame-0.png", "frame-1.png"]) {
            yield* Effect.promise(() =>
              NodeFSP.copyFile(NodePath.join(out, name), NodePath.join(evidence, name)),
            );
          }
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(evidence, "render-report.json"),
              `${JSON.stringify(report, null, 2)}\n`,
            ),
          );
        }
      }).pipe(Effect.provide(GameProcesses.layer)),
    ),
  300_000,
);
