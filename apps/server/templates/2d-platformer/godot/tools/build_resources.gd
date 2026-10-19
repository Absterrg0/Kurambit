## Rebuilds everything that is generated rather than hand-edited:
##
##   assets/tiles/tileset.tres        the TileSet: solid, one-way and hazard tiles
##   assets/sprites/*_frames.tres     SpriteFrames for the player, slime, coin, flag
##   scenes/levels/level_01.tscn      painted from tools/level_01.map
##   scenes/levels/level_02.tscn      painted from tools/level_02.map
##
## Run it after changing the art (`node tools/generate_art.mjs`) or a level map:
##
##   game_godot_test { script: "tools/build_resources.gd" }
##
## It needs an imported project, so run `game_godot_import` first. Levels are painted
## from ASCII maps because a .tscn full of tile_data ints is not editable by hand:
## edit the map, run this, and open the scene in the editor to keep painting.
extends SceneTree

const TILE := 16
const LEVELS := [
	{
		"id": "level_01",
		"title": "Mossy Ridge",
		"sky": [
			Color(0.11, 0.12, 0.28),
			Color(0.25, 0.18, 0.44),
			Color(0.47, 0.26, 0.48),
			Color(0.74, 0.4, 0.44),
			Color(0.98, 0.62, 0.36),
		],
		"tint": Color(1, 1, 1),
	},
	{
		"id": "level_02",
		"title": "Sunken Steps",
		"sky": [
			Color(0.05, 0.06, 0.16),
			Color(0.14, 0.13, 0.3),
			Color(0.26, 0.2, 0.42),
			Color(0.42, 0.26, 0.44),
			Color(0.66, 0.38, 0.4),
		],
		"tint": Color(0.68, 0.7, 0.92),
	},
]

## Atlas coordinates in assets/tiles/tiles.png, mirrored from tools/generate_art.mjs.
const TILES := {
	"grass_a": Vector2i(0, 0),
	"grass_b": Vector2i(1, 0),
	"grass_left": Vector2i(2, 0),
	"grass_right": Vector2i(3, 0),
	"dirt_a": Vector2i(4, 0),
	"dirt_b": Vector2i(5, 0),
	"dirt_left": Vector2i(6, 0),
	"dirt_right": Vector2i(7, 0),
	"stone_top": Vector2i(0, 1),
	"stone_fill": Vector2i(1, 1),
	"plank_left": Vector2i(2, 1),
	"plank_mid": Vector2i(3, 1),
	"plank_right": Vector2i(4, 1),
	"spikes": Vector2i(5, 1),
	"tuft": Vector2i(6, 1),
	"flower": Vector2i(7, 1),
	"pebble": Vector2i(0, 2),
	"bush": Vector2i(1, 2),
	"rock": Vector2i(2, 2),
	"mushroom": Vector2i(3, 2),
}
const SOLID_TILES := [
	"grass_a",
	"grass_b",
	"grass_left",
	"grass_right",
	"dirt_a",
	"dirt_b",
	"dirt_left",
	"dirt_right",
	"stone_top",
	"stone_fill",
]
const ONE_WAY_TILES := ["plank_left", "plank_mid", "plank_right"]
const HAZARD_TILES := ["spikes"]
const DECOR_TILES := ["tuft", "flower", "pebble", "bush", "rock", "mushroom"]
const DECOR_CHARS := {
	"*": "tuft", "x": "flower", "p": "pebble", "b": "bush", "r": "rock", "m": "mushroom"
}

## Scenes are loaded by path, not preloaded: the frames they need are written by this
## same run, so a first run on a fresh project would otherwise instance them empty.
const LEVEL_SCRIPT_PATH := "res://scripts/level.gd"
const SPIKE_FIELD_SCRIPT_PATH := "res://scripts/spike_field.gd"

var _failures := 0
## The level being built; every generated node is owned by it so it can be packed.
var _root: Node2D

func _initialize() -> void:
	_failures += _write_tileset()
	_failures += _write_sheet_frames(
		"player",
		{
			"idle": {"frames": [Vector2i(0, 0), Vector2i(1, 0)], "speed": 3.0, "loop": true},
			"run": {
				"frames": [Vector2i(2, 0), Vector2i(3, 0), Vector2i(0, 1), Vector2i(1, 1)],
				"speed": 13.0,
				"loop": true,
			},
			"jump": {"frames": [Vector2i(2, 1)], "speed": 1.0, "loop": false},
			"fall": {"frames": [Vector2i(3, 1)], "speed": 1.0, "loop": false},
		}
	)
	_failures += _write_sheet_frames(
		"slime",
		{"move": {"frames": [Vector2i(0, 0), Vector2i(1, 0)], "speed": 4.0, "loop": true}}
	)
	_failures += _write_sheet_frames(
		"coin",
		{
			"spin": {
				"frames": [
					Vector2i(0, 0),
					Vector2i(1, 0),
					Vector2i(2, 0),
					Vector2i(3, 0),
					Vector2i(4, 0),
					Vector2i(5, 0),
				],
				"speed": 10.0,
				"loop": true,
			}
		}
	)
	_failures += _write_checkpoint_frames()
	for level in LEVELS:
		_failures += _write_level(level)
	if _failures == 0:
		print("BUILD OK")
	else:
		printerr("BUILD FAIL: %d step(s) failed" % _failures)
	quit(_failures)

# ------------------------------------------------------------------ generated art

func _write_tileset() -> int:
	var tile_set := TileSet.new()
	tile_set.tile_size = Vector2i(TILE, TILE)
	tile_set.add_physics_layer()
	tile_set.set_physics_layer_collision_layer(0, 1)
	tile_set.set_physics_layer_collision_mask(0, 1)
	var atlas := TileSetAtlasSource.new()
	atlas.texture = load("res://assets/tiles/tiles.png") as Texture2D
	atlas.texture_region_size = Vector2i(TILE, TILE)
	# The source joins the set before any tile is authored: TileData reads the physics
	# layer count from the TileSet it belongs to.
	tile_set.add_source(atlas, 0)
	var full := PackedVector2Array([
		Vector2(-8, -8), Vector2(8, -8), Vector2(8, 8), Vector2(-8, 8)
	])
	# A one-way platform collides with the top 6px only: the lip of a wooden plank.
	# Wound counter-clockwise (in 2D, y grows downwards), which points the collision
	# normal up: a body moving upwards passes through it, a falling one lands on it.
	var lip := PackedVector2Array([
		Vector2(-8, -8), Vector2(-8, -2), Vector2(8, -2), Vector2(8, -8)
	])
	for name in SOLID_TILES:
		var data := _create_tile(atlas, name)
		data.add_collision_polygon(0)
		data.set_collision_polygon_points(0, 0, full)
	for name in ONE_WAY_TILES:
		var data := _create_tile(atlas, name)
		data.add_collision_polygon(0)
		data.set_collision_polygon_points(0, 0, lip)
		data.set_collision_polygon_one_way(0, 0, true)
	for name in HAZARD_TILES + DECOR_TILES:
		_create_tile(atlas, name)
	return _save(tile_set, "res://assets/tiles/tileset.tres", "tileset")

func _create_tile(atlas: TileSetAtlasSource, name: String) -> TileData:
	var coords: Vector2i = TILES[name]
	atlas.create_tile(coords)
	return atlas.get_tile_data(coords, 0)

## Builds SpriteFrames from one sheet, where every animation names its frames by atlas
## cell. Cells are 16x16 except for the checkpoint, whose frames are 16x32.
func _write_sheet_frames(sheet_name: String, animations: Dictionary) -> int:
	var sheet := load("res://assets/sprites/%s.png" % sheet_name) as Texture2D
	if sheet == null:
		printerr("  missing sheet assets/sprites/%s.png" % sheet_name)
		return 1
	var frames := SpriteFrames.new()
	frames.remove_animation("default")
	for animation in animations:
		var spec: Dictionary = animations[animation]
		frames.add_animation(animation)
		frames.set_animation_speed(animation, spec["speed"])
		frames.set_animation_loop(animation, spec["loop"])
		for cell in spec["frames"]:
			frames.add_frame(animation, _region(sheet, cell, Vector2i(TILE, TILE)))
	return _save(frames, "res://assets/sprites/%s_frames.tres" % sheet_name, "%s frames" % sheet_name)

func _write_checkpoint_frames() -> int:
	var sheet := load("res://assets/sprites/checkpoint.png") as Texture2D
	if sheet == null:
		printerr("  missing sheet assets/sprites/checkpoint.png")
		return 1
	var frames := SpriteFrames.new()
	frames.remove_animation("default")
	for entry in [{"name": "idle", "cell": Vector2i(0, 0)}, {"name": "lit", "cell": Vector2i(1, 0)}]:
		var animation: String = entry["name"]
		var cell: Vector2i = entry["cell"]
		frames.add_animation(animation)
		frames.set_animation_speed(animation, 1.0)
		frames.set_animation_loop(animation, false)
		frames.add_frame(animation, _region(sheet, cell, Vector2i(TILE, 32)))
	return _save(frames, "res://assets/sprites/checkpoint_frames.tres", "checkpoint frames")

func _region(sheet: Texture2D, cell: Vector2i, size: Vector2i) -> AtlasTexture:
	var texture := AtlasTexture.new()
	texture.atlas = sheet
	texture.region = Rect2(cell.x * size.x, cell.y * size.y, size.x, size.y)
	return texture

# ----------------------------------------------------------------------- levels

func _write_level(definition: Dictionary) -> int:
	var id: String = definition["id"]
	var map := _read_map("res://tools/%s.map" % id)
	if map.is_empty():
		printerr("  could not read tools/%s.map" % id)
		return 1
	var tile_set := load("res://assets/tiles/tileset.tres") as TileSet
	if tile_set == null:
		printerr("  assets/tiles/tileset.tres is missing; run this script twice")
		return 1

	var terrain: Dictionary = map["terrain"]
	var decor: Dictionary = map["decor"]
	var objects: Dictionary = map["objects"]
	var width: int = map["width"]
	var height: int = map["height"]

	_root = Node2D.new()
	_root.set_script(load(LEVEL_SCRIPT_PATH) as Script)
	_root.name = "Level"
	_root.set("title", definition["title"])
	_root.set("camera_bounds", Rect2(0, 0, width * TILE, height * TILE))
	_root.set("kill_plane", height * TILE + 64)

	# Background bands sit against the bottom of the level, so they take pixels, not rows.
	_add_background(definition, height * TILE)
	if definition["tint"] != Color(1, 1, 1):
		var tint := CanvasModulate.new()
		tint.name = "Tint"
		tint.color = definition["tint"]
		_add(tint)

	var terrain_layer := _layer("Terrain", tile_set)
	var decor_layer := _layer("Decor", tile_set)
	var hazards_layer := _layer("Hazards", tile_set)
	_paint_terrain(terrain, terrain_layer, hazards_layer, width, height)
	_paint_decor(decor, decor_layer)

	var spawn := Marker2D.new()
	spawn.name = "Spawn"
	_add(spawn)

	_add_spike_field(hazards_layer)
	var containers := {}
	var coin_scene := load("res://scenes/pickups/coin.tscn") as PackedScene
	var slime_scene := load("res://scenes/enemies/slime.tscn") as PackedScene
	var checkpoint_scene := load("res://scenes/checkpoint.tscn") as PackedScene
	for name in ["Pickups", "Enemies", "Checkpoints"]:
		var node := Node2D.new()
		node.name = name
		_add(node)
		containers[name] = node

	var goal := (load("res://scenes/goal.tscn") as PackedScene).instantiate()
	goal.name = "Goal"
	_add(goal)

	var spawn_placed := false
	for cell in objects:
		var letter: String = objects[cell]
		match letter:
			"P":
				spawn.position = Vector2(_centre_x(cell.x), float(cell.y) * TILE)
				spawn_placed = true
			"o":
				_place(coin_scene, containers["Pickups"], _centre(cell))
			"s":
				_place(slime_scene, containers["Enemies"], Vector2(_centre_x(cell.x), float(cell.y) * TILE))
			"f":
				_place(checkpoint_scene, containers["Checkpoints"], Vector2(_centre_x(cell.x), float(cell.y) * TILE))
			"D":
				goal.position = Vector2(_centre_x(cell.x), float(cell.y) * TILE)
	if not spawn_placed:
		printerr("  %s has no spawn point (P)" % id)
		return 1

	var packed := PackedScene.new()
	if packed.pack(_root) != OK:
		printerr("  could not pack %s" % id)
		return 1
	# The scene holds copies, so the scratch tree goes away now: leaving it alive is
	# what makes Godot print "RIDs leaked at exit" and looks like a failed build.
	_root.free()
	_root = null
	return _save(packed, "res://scenes/levels/%s.tscn" % id, id)

func _layer(name: String, tile_set: TileSet) -> TileMapLayer:
	var layer := TileMapLayer.new()
	layer.name = name
	layer.tile_set = tile_set
	_add(layer)
	return layer

func _add_background(definition: Dictionary, height: int) -> void:
	var backdrop := CanvasLayer.new()
	backdrop.name = "Background"
	backdrop.layer = -10
	_add(backdrop)
	var gradient := Gradient.new()
	gradient.offsets = PackedFloat32Array([0.0, 0.45, 0.72, 0.9, 1.0])
	gradient.colors = PackedColorArray(definition["sky"])
	var texture := GradientTexture2D.new()
	texture.gradient = gradient
	texture.width = 64
	texture.height = 256
	texture.fill_from = Vector2(0.5, 0.0)
	texture.fill_to = Vector2(0.5, 1.0)
	var sky := TextureRect.new()
	sky.name = "Sky"
	sky.texture = texture
	sky.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	sky.stretch_mode = TextureRect.STRETCH_SCALE
	sky.set_anchors_preset(Control.PRESET_FULL_RECT)
	sky.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_add(sky)
	# Three parallax bands. `scroll_scale` 0 is pinned to the screen and 1 moves with
	# the camera, so the far ridge barely moves and the near vegetation runs almost level.
	for band in [
		{"name": "Far", "texture": "ridge_far", "scroll": 0.18, "top": height - 224},
		{"name": "Mid", "texture": "ridge_mid", "scroll": 0.34, "top": height - 216},
		{"name": "Near", "texture": "veg_near", "scroll": 0.62, "top": height - 132},
	]:
		var parallax := Parallax2D.new()
		parallax.name = band["name"]
		parallax.scroll_scale = Vector2(band["scroll"], 1.0)
		parallax.repeat_size = Vector2(640.0, 0.0)
		parallax.repeat_times = 4
		_add(parallax)
		var sprite := Sprite2D.new()
		sprite.name = "Art"
		sprite.centered = false
		sprite.texture = load("res://assets/backgrounds/%s.png" % band["texture"]) as Texture2D
		sprite.position = Vector2(0.0, float(band["top"]))
		_add(sprite, parallax)

## Paints the terrain layer, choosing grass/dirt/stone variants from the neighbours so
## a map only has to say "ground here".
func _paint_terrain(
	terrain: Dictionary, layer: TileMapLayer, hazards: TileMapLayer, width: int, height: int
) -> void:
	for y in height:
		for x in width:
			var cell := Vector2i(x, y)
			if not terrain.has(cell):
				continue
			var letter: String = terrain[cell]
			if letter == "^":
				hazards.set_cell(cell, 0, TILES["spikes"])
				continue
			if letter == "-":
				layer.set_cell(cell, 0, _plank_tile(terrain, x, y))
				continue
			if letter == "S":
				var buried := terrain.has(Vector2i(x, y - 1))
				layer.set_cell(cell, 0, TILES["stone_fill"] if buried else TILES["stone_top"])
				continue
			layer.set_cell(cell, 0, _ground_tile(terrain, x, y))

func _plank_tile(terrain: Dictionary, x: int, y: int) -> Vector2i:
	if not terrain.has(Vector2i(x - 1, y)):
		return TILES["plank_left"]
	if not terrain.has(Vector2i(x + 1, y)):
		return TILES["plank_right"]
	return TILES["plank_mid"]

func _ground_tile(terrain: Dictionary, x: int, y: int) -> Vector2i:
	var left_empty := not terrain.has(Vector2i(x - 1, y))
	var right_empty := not terrain.has(Vector2i(x + 1, y))
	# Deterministic variant pick, so rebuilding a map always writes the same scene.
	var variant := (x * 7 + y * 13) % 2
	if not terrain.has(Vector2i(x, y - 1)):
		if left_empty:
			return TILES["grass_left"]
		if right_empty:
			return TILES["grass_right"]
		return TILES["grass_a"] if variant == 0 else TILES["grass_b"]
	if left_empty:
		return TILES["dirt_left"]
	if right_empty:
		return TILES["dirt_right"]
	return TILES["dirt_a"] if variant == 0 else TILES["dirt_b"]

func _paint_decor(decor: Dictionary, layer: TileMapLayer) -> void:
	for cell in decor:
		var name: String = DECOR_CHARS.get(decor[cell], "")
		if not name.is_empty():
			layer.set_cell(cell, 0, TILES[name])

## One hurt box per run of spike tiles, so the player is pushed out of a spike pit
## instead of standing in it. Baking the boxes into the scene keeps them visible in
## the editor, where levels are actually painted.
func _add_spike_field(hazards: TileMapLayer) -> void:
	var field := Area2D.new()
	field.set_script(load(SPIKE_FIELD_SCRIPT_PATH) as Script)
	field.name = "SpikeField"
	field.collision_layer = 16
	field.collision_mask = 2
	_add(field)
	for cell in hazards.get_used_cells():
		if hazards.get_cell_source_id(Vector2i(cell.x - 1, cell.y)) != -1:
			continue
		var length := 1
		while hazards.get_cell_source_id(Vector2i(cell.x + length, cell.y)) != -1:
			length += 1
		var shape := RectangleShape2D.new()
		shape.size = Vector2(float(length * TILE), float(TILE - 2))
		var box := CollisionShape2D.new()
		box.name = "Spikes_%d_%d" % [cell.x, cell.y]
		box.shape = shape
		box.position = Vector2(
			float(cell.x + length / 2.0) * TILE, float(cell.y) * TILE + float(TILE) / 2.0
		)
		_add(box, field)

# ------------------------------------------------------------------------ maps

## Reads one `tools/<id>.map`: `[terrain]`, `[decor]` and `[objects]` sections. Rows
## may be shorter than the widest one; the rest of that row is empty. Comment lines
## start with `;`, because `#` is the ground tile.
func _read_map(path: String) -> Dictionary:
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return {}
	var terrain := {}
	var decor := {}
	var objects := {}
	var section := ""
	var row := 0
	var width := 0
	var heights := {"[terrain]": 0, "[decor]": 0, "[objects]": 0}
	while not file.eof_reached():
		var line := file.get_line()
		if line.begins_with("["):
			section = line.strip_edges()
			row = 0
			continue
		if not heights.has(section) or line.begins_with(";"):
			continue
		width = maxi(width, line.length())
		heights[section] = row + 1
		for x in line.length():
			var letter := line[x]
			if letter == "." or letter == " ":
				continue
			var cell := Vector2i(x, row)
			match section:
				"[terrain]":
					terrain[cell] = letter
				"[decor]":
					decor[cell] = letter
				"[objects]":
					objects[cell] = letter
		row += 1
	var height: int = maxi(heights["[terrain]"], 1)
	return {
		"terrain": terrain,
		"decor": decor,
		"objects": objects,
		"width": maxi(width, 1),
		"height": height,
	}

# ---------------------------------------------------------------------- helpers

func _centre_x(x: int) -> float:
	return (float(x) + 0.5) * float(TILE)

func _centre(cell: Vector2i) -> Vector2:
	return Vector2(_centre_x(cell.x), (float(cell.y) + 0.5) * float(TILE))

func _place(scene: PackedScene, container: Node, where: Vector2) -> void:
	var node := scene.instantiate()
	node.position = where
	container.add_child(node)
	node.owner = _root

## Adds a generated node to the level being built; the level owns everything.
func _add(child: Node, parent: Node = null) -> void:
	var target := parent if parent != null else _root
	target.add_child(child)
	child.owner = _root

func _save(resource: Resource, path: String, label: String) -> int:
	var error := ResourceSaver.save(resource, path)
	if error != OK:
		printerr("  could not write the %s (%d)" % [label, error])
		return 1
	print("  wrote the %s" % label)
	return 0
