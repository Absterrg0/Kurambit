## Levels as text maps. Write the level as rows of characters and a legend;
## LevelMap builds it under a parent node with real collision and returns the
## spawns and the bounds, so nothing is placed by coordinates.
##
## 2D, tiles from one sheet (atlas coordinates are column, row in tiles):
##   const ROOMS := [
##       "#########   #########",
##       "#P......#   #.....E.#",
##       "#.......#####...G...#",
##       "#.......=...=.......#",   # two rooms joined by a corridor
##       "#####################",   # every walkable edge closed: void is open space
##   ]
##   var level := LevelMap.build_2d(self, ROOMS, {
##       "#": Vector2i(0, 4),                     # a solid tile
##       "=": {"floor": Vector2i(2, 4)},          # a walkable cell with its own floor tile
##       "P": "spawn", "E": "spawn", "G": "spawn",
##   }, {"sheet": "res://assets/library/<pack>/tilemap_packed.png", "tile_size": 16, "floor": Vector2i(0, 4)})
##   # a sheet with gaps between tiles also takes "separation": 1 (and "margin")
##   $Player.position = level.spawns["P"][0]     # Vector2s at cell centres, by letter
##   cam.bounds = level.bounds                   # FollowCamera2D; a 16 px sheet wants cam.zoom = Vector2(3, 3)
##
## 3D, one piece scene (a .glb or .tscn) per cell:
##   var level := LevelMap.build_3d(self, ROOMS, {
##       "#": "res://assets/library/<pack>/wall.glb",       # a solid piece
##       "c": {"scene": "res://assets/library/<pack>/barrel.glb", "rotate": 90},
##       "=": "floor",
##       "P": "spawn", "E": "spawn", "G": "spawn",
##   }, {"cell": 1.0, "floor": "res://assets/library/<pack>/floor.glb"})
##   $Player.position = level.spawns["P"][0]     # Vector3s on the floor, by letter
##
## " " is void (nothing drawn, no collision: open sky in 2D, a pit in 3D), so
## close every walkable edge with a solid cell or the player walks out; and
## "." is plain floor (the `floor` option's tile or piece; a grey tile in 3D
## without one) unless the legend says otherwise; any other character must
## be in the legend. A legend entry is "spawn", "floor", a solid piece (a
## Vector2i tile in 2D, a scene path in 3D), or a Dictionary: {"tile" |
## "scene", "solid", "floor", "spawn", "rotate" (degrees about y), "y",
## "scale"}; a tile with "solid": false draws over the floor. Solid cells
## collide on layer 1, so CharacterBody2D/3D move_and_slide stops at them and
## FollowCamera3D pulls in at them; every non-void 3D cell has floor
## collision. Column c, row r is at ((c + 0.5) * cell, (r + 0.5) * cell)
## from the parent's origin, rows running down in 2D and toward +z in 3D.
## Rooms are just rows: add arrays to stack them, join strings row by row to
## put them side by side. Repeated 3D pieces share one MultiMesh each, so a
## 60x60 map costs one draw per piece mesh.
class_name LevelMap
extends RefCounted

## The node holding the level, already under the parent; free it to remove the level.
var node: Node
## Spawn cells by letter: Array of Vector2 (2D) or Vector3 (3D).
var spawns := {}
## The level's extent: Rect2 in 2D (FollowCamera2D.bounds), AABB in 3D.
var bounds: Variant
var cell := 1.0
var width := 0
var height := 0
var _chars := PackedStringArray()
## Legend characters already reported, so a bad entry errors once, not once per cell.
var _reported := {}


## The map character at a position in the parent's space; " " outside the map.
func at(position: Variant) -> String:
	var c := floori(position.x / cell)
	var r := floori((position.y if position is Vector2 else position.z) / cell)
	if c < 0 or r < 0 or c >= width or r >= height:
		return " "
	return _chars[r * width + c]


static func build_2d(parent: Node, rows: Array, legend: Dictionary, options := {}) -> LevelMap:
	var level := LevelMap.new()
	var grid := level._parse(rows, legend)
	# A scene name (the 3D or three.js form) would draw nothing and collide nowhere.
	for ch in legend:
		var raw: Variant = legend[ch]
		if (raw is String and not raw in ["spawn", "floor", "void"]) or (raw is Dictionary and raw.has("scene")):
			push_error("LevelMap.build_2d: legend \"%s\" names a scene; 2D takes Vector2i(column, row) tiles from the sheet" % ch)
	var tile: int = options.get("tile_size", 16)
	var size := Vector2i(tile, tile)
	level.cell = tile
	var texture := load(str(options.get("sheet", ""))) as Texture2D
	if texture == null:
		push_error("LevelMap.build_2d: options.sheet %s is not a texture" % options.get("sheet", "(missing)"))
		return level
	var atlas := TileSetAtlasSource.new()
	atlas.texture = texture
	atlas.texture_region_size = size
	atlas.separation = int(options.get("separation", 0)) * Vector2i.ONE
	atlas.margins = int(options.get("margin", 0)) * Vector2i.ONE
	var tiles := TileSet.new()
	tiles.tile_size = size
	tiles.add_physics_layer()
	tiles.add_source(atlas, 0)
	var half := Vector2(size) / 2.0
	var square := PackedVector2Array([-half, Vector2(half.x, -half.y), half, Vector2(-half.x, half.y)])
	var root := Node2D.new()
	root.name = "Level"
	# Every tile has a full-square collision shape; only the Walls layer turns it on.
	var layers := {}
	for layer_name in ["Floor", "Decor", "Walls"]:
		var layer := TileMapLayer.new()
		layer.name = layer_name
		layer.tile_set = tiles
		layer.collision_enabled = layer_name == "Walls"
		root.add_child(layer)
		layers[layer_name] = layer
	var put := func(layer: TileMapLayer, at: Vector2i, coords: Variant) -> void:
		if not coords is Vector2i:
			push_error("LevelMap.build_2d: a tile is %s, not Vector2i(column, row)" % [coords])
			return
		if not atlas.has_tile(coords):
			if not atlas.has_room_for_tile(coords, Vector2i.ONE, 1, Vector2i.ZERO, 1):
				push_error("LevelMap.build_2d: tile %s is outside the sheet" % [coords])
				return
			atlas.create_tile(coords)
			var data := atlas.get_tile_data(coords, 0)
			data.add_collision_polygon(0)
			data.set_collision_polygon_points(0, 0, square)
		layer.set_cell(at, 0, coords)
	var used := Rect2i()
	for cell_info in grid:
		var entry: Dictionary = cell_info.entry
		var at: Vector2i = cell_info.at
		used = Rect2i(at, Vector2i.ONE) if used.size == Vector2i.ZERO else used.merge(Rect2i(at, Vector2i.ONE))
		var floor_tile: Variant = entry.get("floor", options.get("floor", null))
		if floor_tile != null and not floor_tile is bool:
			put.call(layers.Floor, at, floor_tile)
		if entry.has("tile"):
			put.call(layers.Walls if entry.solid else layers.Decor, at, entry.tile)
		if entry.get("spawn", false):
			level._spawn(cell_info.char, Vector2(at * size) + half)
	level.bounds = Rect2(Vector2(used.position * size), Vector2(used.size * size))
	parent.add_child(root)
	level.node = root
	return level


static func build_3d(parent: Node, rows: Array, legend: Dictionary, options := {}) -> LevelMap:
	var level := LevelMap.new()
	var grid := level._parse(rows, legend)
	var cell: float = options.get("cell", 1.0)
	level.cell = cell
	var scale: float = options.get("scale", 1.0)
	var root := Node3D.new()
	root.name = "Level"
	var body := StaticBody3D.new()
	body.name = "Collision"
	root.add_child(body)
	# scene path -> Array of Transform3D; each mesh in the scene becomes one MultiMesh
	var placed := {}
	var plain_floor: Array[Transform3D] = []
	var used := Rect2i()
	for cell_info in grid:
		var entry: Dictionary = cell_info.entry
		var at: Vector2i = cell_info.at
		used = Rect2i(at, Vector2i.ONE) if used.size == Vector2i.ZERO else used.merge(Rect2i(at, Vector2i.ONE))
		var centre := Vector3((at.x + 0.5) * cell, 0.0, (at.y + 0.5) * cell)
		var floor_scene: Variant = entry.get("floor", options.get("floor", null))
		if floor_scene == null:
			plain_floor.append(Transform3D(Basis.IDENTITY, centre))
		elif not floor_scene is bool:
			level._place(placed, str(floor_scene), Transform3D(Basis.IDENTITY.scaled(Vector3.ONE * scale), centre))
		if entry.has("scene"):
			var basis := Basis(Vector3.UP, deg_to_rad(float(entry.get("rotate", 0.0)))).scaled(Vector3.ONE * float(entry.get("scale", scale)))
			level._place(placed, str(entry.scene), Transform3D(basis, centre + Vector3.UP * float(entry.get("y", 0.0))))
		if entry.get("spawn", false):
			level._spawn(cell_info.char, centre)
	var heights := {}
	var top := cell
	for path in placed:
		heights[path] = level._multimesh(root, path, placed[path])
		top = maxf(top, heights[path])
	if not plain_floor.is_empty():
		var plane := PlaneMesh.new()
		plane.size = Vector2(cell, cell)
		var material := StandardMaterial3D.new()
		material.albedo_color = Color(0.33, 0.34, 0.37)
		plane.material = material
		level._instances(root, "Floor", plane, Transform3D.IDENTITY, plain_floor)
	# Collision as boxes over runs of one character along a row: a floor slab
	# under every non-void cell, and walls as tall as their piece.
	for r in level.height:
		var c := 0
		while c < level.width:
			var ch := level._chars[r * level.width + c]
			var run := 1
			while c + run < level.width and level._chars[r * level.width + c + run] == ch:
				run += 1
			var entry := level._entry_at(c, r, legend)
			if not entry.get("void", false):
				var mid := Vector3((c + run / 2.0) * cell, 0.0, (r + 0.5) * cell)
				level._box(body, mid + Vector3.DOWN * 0.5, Vector3(run * cell, 1.0, cell))
				if entry.solid:
					# As tall as the piece is drawn: its scale and lift count.
					var piece_scale := float(entry.get("scale", options.get("scale", 1.0)))
					var tall: float = maxf(heights.get(str(entry.get("scene", "")), cell) * piece_scale, 0.1) + float(entry.get("y", 0.0))
					level._box(body, mid + Vector3.UP * tall / 2.0, Vector3(run * cell, tall, cell))
			c += run
	level.bounds = AABB(Vector3(used.position.x * cell, 0.0, used.position.y * cell), Vector3(used.size.x * cell, top, used.size.y * cell))
	parent.add_child(root)
	level.node = root
	return level


func _parse(rows: Array, legend: Dictionary) -> Array:
	height = rows.size()
	for row in rows:
		width = maxi(width, str(row).length())
	var unknown := {}
	var grid := []
	for r in height:
		var row := str(rows[r])
		for c in width:
			var ch := row[c] if c < row.length() else " "
			_chars.append(ch)
			if not legend.has(ch) and ch != " " and ch != ".":
				unknown[ch] = true
				continue
			var entry := _entry_at(c, r, legend)
			if not entry.get("void", false):
				grid.append({"at": Vector2i(c, r), "char": ch, "entry": entry})
	if not unknown.is_empty():
		push_error("LevelMap: no legend entry for %s; the legend has %s" % [", ".join(unknown.keys().map(func(k): return "\"%s\"" % k)), ", ".join(legend.keys().map(func(k): return "\"%s\"" % k))])
	return grid


func _entry_at(c: int, r: int, legend: Dictionary) -> Dictionary:
	var ch := _chars[r * width + c]
	if not legend.has(ch):
		return {"void": true, "solid": false} if ch != "." else {"solid": false}
	var raw: Variant = legend[ch]
	if raw is String and raw == "spawn":
		return {"spawn": true, "solid": false}
	if raw is String and raw == "floor":
		return {"solid": false}
	if raw is String and raw == "void":
		return {"void": true, "solid": false}
	if raw is String:
		return {"scene": raw, "solid": true}
	if raw is Vector2i:
		return {"tile": raw, "solid": true}
	if raw is Dictionary:
		var entry: Dictionary = raw.duplicate()
		entry["solid"] = entry.get("solid", entry.has("scene") or entry.has("tile"))
		return entry
	if _reported.has(ch):
		return {"solid": false}
	_reported[ch] = true
	push_error("LevelMap: legend \"%s\" is %s; use \"spawn\", \"floor\", a Vector2i(column, row) tile (2D), a scene path (3D) or a Dictionary" % [ch, raw])
	return {"solid": false}


func _spawn(ch: String, at: Variant) -> void:
	if not spawns.has(ch):
		spawns[ch] = []
	spawns[ch].append(at)


func _place(placed: Dictionary, path: String, transform: Transform3D) -> void:
	if not placed.has(path):
		placed[path] = [] as Array[Transform3D]
	placed[path].append(transform)


## One MultiMeshInstance3D per mesh in the piece scene; returns the piece's height.
func _multimesh(root: Node3D, path: String, transforms: Array) -> float:
	var packed := load(path) as PackedScene
	if packed == null:
		push_error("LevelMap.build_3d: %s is not a scene (a .glb or .tscn); run game_import after copying it" % path)
		return 0.0
	var piece := packed.instantiate()
	var top := 0.0
	var stack: Array[Node] = [piece]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		stack.append_array(node.get_children())
		if not node is MeshInstance3D or (node as MeshInstance3D).mesh == null:
			continue
		var local := Transform3D.IDENTITY
		var walk: Node = node
		while walk != piece:
			local = (walk as Node3D).transform * local
			walk = walk.get_parent()
		var mesh_node := node as MeshInstance3D
		var instances := _instances(root, path.get_file().get_basename(), mesh_node.mesh, local, transforms)
		instances.material_override = mesh_node.material_override
		top = maxf(top, (local * mesh_node.mesh.get_aabb()).end.y)
	piece.free()
	return top


func _instances(root: Node3D, name: String, mesh: Mesh, local: Transform3D, transforms: Array) -> MultiMeshInstance3D:
	var multimesh := MultiMesh.new()
	multimesh.transform_format = MultiMesh.TRANSFORM_3D
	multimesh.mesh = mesh
	multimesh.instance_count = transforms.size()
	for i in transforms.size():
		multimesh.set_instance_transform(i, transforms[i] * local)
	var instance := MultiMeshInstance3D.new()
	instance.name = name
	instance.multimesh = multimesh
	root.add_child(instance)
	return instance


func _box(body: StaticBody3D, centre: Vector3, size: Vector3) -> void:
	var box := BoxShape3D.new()
	box.size = size
	var shape := CollisionShape3D.new()
	shape.shape = box
	shape.position = centre
	body.add_child(shape)
