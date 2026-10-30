/**
 * The GDScript Godot runs headlessly for `game_art_frames`. It is a string,
 * not an asset, so the packed server archive carries it without a second
 * asset-copy rule. It builds one SpriteFrames resource from a kit sheet's
 * authored grid and animations with the engine's own AtlasTexture resources,
 * so agents use the catalog's cells instead of guessing sprite regions.
 */
export const GODOT_ART_FRAMES_SCRIPT = `extends SceneTree

var _request_path := ""
var _result_path := ""

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	_request_path = args[0] if args.size() > 0 else ""
	_result_path = args[1] if args.size() > 1 else ""
	var outcome := _build()
	_write_result(outcome)
	quit(0 if outcome.has("animations") else 1)

func _build() -> Dictionary:
	if _request_path.is_empty():
		return {"error": "No request file was given."}
	var file := FileAccess.open(_request_path, FileAccess.READ)
	if file == null:
		return {"error": "The request file does not read."}
	var request: Variant = JSON.parse_string(file.get_as_text())
	if not (request is Dictionary):
		return {"error": "The request file is not a JSON object."}
	var sheet := load(str(request.get("imageResPath", ""))) as Texture2D
	if sheet == null:
		return {"error": "The sheet image does not load: %s." % str(request.get("imageResPath", ""))}
	var tile_width := int(request.get("tileWidth", 0))
	var tile_height := int(request.get("tileHeight", 0))
	var columns := int(request.get("columns", 0))
	var rows := int(request.get("rows", 0))
	var margin := int(request.get("margin", 0))
	var spacing := int(request.get("spacing", 0))
	var animations: Array = request.get("animations", [])
	if animations.is_empty():
		return {"error": "The request names no animations."}
	var seen := {}
	var frames := SpriteFrames.new()
	frames.remove_animation("default")
	for entry in animations:
		if not (entry is Dictionary):
			return {"error": "An animation entry is not an object."}
		var name := str(entry.get("name", ""))
		if name.is_empty():
			return {"error": "An animation entry has no name."}
		if seen.has(name):
			return {"error": "The animation '%s' is named twice." % name}
		seen[name] = true
		var cells: Array = entry.get("cells", [])
		if cells.is_empty():
			return {"error": "The animation '%s' has no cells." % name}
		frames.add_animation(name)
		frames.set_animation_speed(name, float(entry.get("fps", 6.0)))
		frames.set_animation_loop(name, bool(entry.get("loop", true)))
		for cell in cells:
			var column := int(cell.get("col", -1))
			var row := int(cell.get("row", -1))
			if column < 0 or row < 0 or column >= columns or row >= rows:
				return {"error": "The animation '%s' names cell (%d, %d) outside the %dx%d grid." % [name, column, row, columns, rows]}
			var region := Rect2(
				margin + column * (tile_width + spacing),
				margin + row * (tile_height + spacing),
				tile_width, tile_height)
			if region.end.x > sheet.get_width() or region.end.y > sheet.get_height():
				return {"error": "The animation '%s' reads outside the sheet image." % name}
			var texture := AtlasTexture.new()
			texture.atlas = sheet
			texture.region = region
			frames.add_frame(name, texture)
	var output := str(request.get("outputPath", ""))
	if output.is_empty():
		return {"error": "The request names no output path."}
	var existing_path := str(request.get("existingPath", ""))
	var reused := FileAccess.file_exists(existing_path)
	if reused:
		var previous := load(existing_path) as SpriteFrames
		if previous == null or previous.get_animation_names() != frames.get_animation_names():
			return {"error": "The existing frames resource was modified; move it aside to regenerate. It was not overwritten."}
		for animation in frames.get_animation_names():
			if previous.get_frame_count(animation) != frames.get_frame_count(animation) or previous.get_animation_speed(animation) != frames.get_animation_speed(animation) or previous.get_animation_loop(animation) != frames.get_animation_loop(animation):
				return {"error": "The existing animation '%s' was modified; it was not overwritten." % animation}
			for index in range(frames.get_frame_count(animation)):
				var old_texture := previous.get_frame_texture(animation, index) as AtlasTexture
				var new_texture := frames.get_frame_texture(animation, index) as AtlasTexture
				if old_texture == null or old_texture.atlas == null or old_texture.atlas.resource_path != sheet.resource_path or old_texture.region != new_texture.region or previous.get_frame_duration(animation, index) != 1.0:
					return {"error": "The existing frame in '%s' was modified; it was not overwritten." % animation}
	if not reused and ResourceSaver.save(frames, output) != OK:
		return {"error": "The frames resource did not write: %s." % output}
	var summary: Array = []
	for entry in animations:
		var name := str(entry.get("name", ""))
		summary.append({
			"name": name,
			"frames": frames.get_frame_count(name),
			"fps": frames.get_animation_speed(name),
			"loop": frames.get_animation_loop(name),
		})
	return {"animations": summary, "reused": reused}

func _write_result(outcome: Dictionary) -> void:
	if _result_path.is_empty():
		return
	var file := FileAccess.open(_result_path, FileAccess.WRITE)
	if file == null:
		return
	file.store_string(JSON.stringify(outcome))
	file.close()
`;
