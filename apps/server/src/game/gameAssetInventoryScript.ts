/**
 * Native inventory for `game_assets_inspect`. Runs headlessly against the
 * game's own project (so `res://` resolves like play) and reports engine
 * facts without running game code: no scene instantiation, no `_init`, no
 * property getters on live nodes. Scenes are read through
 * `PackedScene.get_state()` (stored node types, paths and properties) and
 * dependencies through `ResourceLoader.get_dependencies()`; measurements
 * accumulate local transforms over `Mesh.get_aabb()` and never call
 * `get_global_transform()` or `get_transformed_aabb()`. It never saves: no
 * ResourceSaver call, no source edit. Output goes to the result path under
 * builds/logs scratch only.
 */
export const GODOT_ASSET_INVENTORY_SCRIPT = `extends SceneTree

const MAX_NODES := 400
const MAX_DEPENDENCIES := 64
const MAX_ANIMATIONS := 64
const MAX_TRANSITIONS := 64
const MAX_RESULTS := 32
const MAX_FILE_BYTES := 20000000
const MAX_TOTAL_BYTES := 50000000
const MAX_IMAGE_PIXELS := 16777216
const MAX_TOTAL_PIXELS := 33554432

var _request_path := ""
var _result_path := ""

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	_request_path = args[0] if args.size() > 0 else ""
	_result_path = args[1] if args.size() > 1 else ""
	var outcome := _inspect()
	_write(outcome)
	quit(0 if not outcome.has("error") else 1)

func _inspect() -> Dictionary:
	if _request_path.is_empty():
		return {"error": "No request file was given."}
	var file := FileAccess.open(_request_path, FileAccess.READ)
	if file == null:
		return {"error": "The request file does not read."}
	var request: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	if not (request is Dictionary):
		return {"error": "The request file is not a JSON object."}
	var targets: Array = request.get("targets", [])
	if targets.is_empty():
		return {"engineVersion": str(Engine.get_version_info().get("string", "unknown")), "results": [], "truncated": false}
	var results: Array = []
	var truncated := false
	for target in targets:
		if results.size() >= MAX_RESULTS:
			truncated = true
			break
		results.append(_inspect_target(str(target)))
	return {
		"engineVersion": str(Engine.get_version_info().get("string", "unknown")),
		"results": results,
		"truncated": truncated,
	}

func _fail(res_path: String, code: String, detail: String) -> Dictionary:
	return {"resPath": res_path, "loaded": false, "godotClass": null, "error": code, "dependencies": [], "animations": [], "loops": [], "transitions": [], "hasStateMachine": false, "collisionTotal": 0, "collisionEnabled": 0, "rootPosition": null, "rootScale": null, "pivotHint": null, "heightHint": null, "detail": detail}

func _inspect_target(res_path: String) -> Dictionary:
	if res_path.is_empty() or not res_path.begins_with("res://"):
		return _fail(res_path, "Not a res:// path.", "Skipped: not a res:// path.")
	if not ResourceLoader.exists(res_path):
		return _fail(res_path, "missing", "The resource does not exist. For .glb/.gltf this needs an editor import first.")
	var size_check := _file_bytes(res_path)
	if size_check > MAX_FILE_BYTES:
		return _fail(res_path, "overlarge", "The file holds %d bytes, past the %d byte native bound; skipped without decoding." % [size_check, MAX_FILE_BYTES])
	if _is_image_path(res_path):
		var pixels := _image_pixels(res_path)
		if pixels > MAX_IMAGE_PIXELS:
			return _fail(res_path, "overlarge", "The image decodes to about %d MP, past the %d MP per-image bound; skipped without decoding." % [pixels / 1000000, MAX_IMAGE_PIXELS / 1000000])
	var closure := _closure(res_path)
	if not (closure is Dictionary):
		return _fail(res_path, "unloadable", "Dependency metadata did not read.")
	if str(closure.get("overlarge", "")) != "":
		return _fail(res_path, "overlarge", str(closure.get("overlarge", "")))
	var resource: Resource = ResourceLoader.load(res_path)
	if resource == null:
		return _fail(res_path, "unloadable", "ResourceLoader returned null. The resource may reference a missing class or an unimported asset; run an editor import first.")
	var godot_class := resource.get_class()
	var dependencies: Array = (closure.get("deps", []) as Array).duplicate()
	var animations: Array = []
	var loops: Array = []
	var transitions: Array = []
	var has_state_machine := false
	var collision_total := 0
	var collision_enabled := 0
	var root_position = null
	var root_scale = null
	var pivot_hint = null
	var height_hint = null
	var detail := "Loaded as %s." % godot_class
	if resource is SpriteFrames:
		_collect_sprite_frames(resource, animations, loops)
		_add_res_path(dependencies, str(resource.resource_path))
		detail = "SpriteFrames with %d animation(s)." % animations.size()
	elif resource is AnimationLibrary:
		_collect_animation_library(resource, animations, loops)
		detail = "AnimationLibrary with %d animation(s)." % animations.size()
	elif resource is AnimationNodeStateMachine:
		_collect_state_machine(resource, str(res_path), animations, transitions)
		has_state_machine = true
		detail = "State machine with %d transition(s)." % transitions.size()
	elif resource is StandardMaterial3D:
		detail = "StandardMaterial3D with %d native texture edge(s)." % dependencies.size()
	elif resource is AudioStream:
		detail = "Audio stream (%s)." % godot_class
	elif resource is Texture2D:
		detail = "Texture with %d native edge(s)." % dependencies.size()
	elif resource is PackedScene:
		var state: SceneState = (resource as PackedScene).get_state()
		if state == null:
			return _fail(res_path, "uninspectable", "The scene loads but its stored state did not read; no scripts ran.")
		var walked := _walk_state(state, res_path, dependencies, animations, loops, transitions)
		collision_total = int(walked.get("total", 0))
		collision_enabled = int(walked.get("enabled", 0))
		has_state_machine = bool(walked.get("stateMachine", false))
		root_position = walked.get("rootPosition", null)
		root_scale = walked.get("rootScale", null)
		height_hint = walked.get("height", null)
		pivot_hint = walked.get("pivot", null)
		detail = "Scene with %d node(s), %d animation(s), %d transition(s), %d/%d enabled shapes." % [int(walked.get("nodes", 0)), animations.size(), transitions.size(), collision_enabled, collision_total]
	else:
		detail = "Loaded as %s with %d native edge(s)." % [godot_class, dependencies.size()]
	return {
		"resPath": res_path,
		"loaded": true,
		"godotClass": godot_class,
		"error": null,
		"dependencies": dependencies.slice(0, MAX_DEPENDENCIES),
		"animations": animations.slice(0, MAX_ANIMATIONS),
		"loops": loops.slice(0, MAX_ANIMATIONS),
		"transitions": transitions.slice(0, MAX_TRANSITIONS),
		"hasStateMachine": has_state_machine,
		"collisionTotal": collision_total,
		"collisionEnabled": collision_enabled,
		"rootPosition": root_position,
		"rootScale": root_scale,
		"pivotHint": pivot_hint,
		"heightHint": height_hint,
		"detail": detail,
	}

func _add_res_path(dependencies: Array, path: String) -> void:
	path = path.get_slice("::", 0)
	if path.is_empty() or not path.begins_with("res://"):
		return
	if dependencies.size() >= MAX_DEPENDENCIES:
		return
	if not dependencies.has(path):
		dependencies.append(path)

func _is_image_path(path: String) -> bool:
	var lower := path.to_lower()
	return lower.ends_with(".png") or lower.ends_with(".jpg") or lower.ends_with(".jpeg")

func _file_bytes(path: String) -> int:
	var handle := FileAccess.open(path, FileAccess.READ)
	if handle == null:
		return -1
	var length := handle.get_length()
	handle.close()
	return int(length)

func _image_pixels(path: String) -> int:
	var lower := path.to_lower()
	if lower.ends_with(".png"):
		return _png_pixels(path)
	if lower.ends_with(".jpg") or lower.ends_with(".jpeg"):
		return _jpeg_pixels(path)
	return -1

func _png_pixels(path: String) -> int:
	var handle := FileAccess.open(path, FileAccess.READ)
	if handle == null:
		return -1
	var head := handle.get_buffer(33)
	handle.close()
	if head.size() < 33:
		return -1
	if head[0] != 137 or head[1] != 80 or head[2] != 78 or head[3] != 71 or head[4] != 13 or head[5] != 10 or head[6] != 26 or head[7] != 10:
		return -1
	var width := (head[16] << 24) | (head[17] << 16) | (head[18] << 8) | head[19]
	var height := (head[20] << 24) | (head[21] << 16) | (head[22] << 8) | head[23]
	if width <= 0 or height <= 0:
		return -1
	return width * height

func _jpeg_pixels(path: String) -> int:
	var handle := FileAccess.open(path, FileAccess.READ)
	if handle == null:
		return -1
	var head := handle.get_buffer(65536)
	handle.close()
	if head.size() < 4:
		return -1
	if head[0] != 0xFF or head[1] != 0xD8:
		return -1
	var pos := 2
	var guard := 0
	while pos + 9 < head.size() and guard < 512:
		guard += 1
		if head[pos] != 0xFF:
			break
		var marker := head[pos + 1]
		if marker == 0xD8 or marker == 0xD9 or marker == 0x01:
			pos += 2
			continue
		if marker >= 0xD0 and marker <= 0xD7:
			pos += 2
			continue
		if pos + 3 >= head.size():
			break
		var length := (head[pos + 2] << 8) | head[pos + 3]
		if length < 2:
			break
		if marker == 0xC0 or marker == 0xC1 or marker == 0xC2 or marker == 0xC3:
			if pos + 9 >= head.size():
				break
			var height := (head[pos + 5] << 8) | head[pos + 6]
			var width := (head[pos + 7] << 8) | head[pos + 8]
			if width <= 0 or height <= 0:
				return -1
			return width * height
		pos += 2 + length
	return -1

func _closure(res_path: String) -> Dictionary:
	var deps: Array = []
	var seen := {}
	seen[res_path] = true
	var queue: Array = [res_path]
	if not ResourceLoader.has_method("get_dependencies"):
		return {"deps": deps, "overlarge": ""}
	var guard := 0
	while not queue.is_empty() and guard < MAX_DEPENDENCIES * 4:
		guard += 1
		var current := str(queue.pop_back())
		var direct: PackedStringArray = ResourceLoader.get_dependencies(current)
		for dep in direct:
			var encoded := str(dep).split("::")
			var dpath := str(encoded[encoded.size() - 1])
			if dpath.is_empty() or not dpath.begins_with("res://"):
				continue
			if seen.has(dpath):
				continue
			seen[dpath] = true
			if deps.size() < MAX_DEPENDENCIES:
				deps.append(dpath)
			queue.append(dpath)
	var total := 0
	var pixels := 0
	for dep in deps:
		var dpath := str(dep)
		var bytes := _file_bytes(dpath)
		if bytes < 0:
			continue
		if bytes > MAX_FILE_BYTES:
			return {"deps": deps, "overlarge": "Dependency %s holds %d bytes, past the %d byte native bound; skipped without decoding." % [dpath, bytes, MAX_FILE_BYTES]}
		total += bytes
		if _is_image_path(dpath):
			var count := _image_pixels(dpath)
			if count > MAX_IMAGE_PIXELS:
				return {"deps": deps, "overlarge": "Dependency %s decodes past the per-image pixel bound; skipped without decoding." % dpath}
			if count > 0:
				pixels += count
				if pixels > MAX_TOTAL_PIXELS:
					return {"deps": deps, "overlarge": "Dependencies decode past the total pixel bound; skipped without decoding."}
	var own := _file_bytes(res_path)
	if own > 0:
		total += own
	if total > MAX_TOTAL_BYTES:
		return {"deps": deps, "overlarge": "The target with its dependencies holds %d bytes, past the %d byte native bound; skipped without decoding." % [total, MAX_TOTAL_BYTES]}
	return {"deps": deps, "overlarge": ""}

func _collect_sprite_frames(frames: SpriteFrames, animations: Array, loops: Array) -> void:
	if not frames.has_method("get_animation_names"):
		return
	for name in frames.get_animation_names():
		var sname := str(name)
		if animations.size() < MAX_ANIMATIONS and not animations.has(sname):
			animations.append(sname)
		if frames.has_method("get_animation_loop"):
			var looping := false
			looping = bool(frames.get_animation_loop(name))
			if looping and not loops.has(sname) and loops.size() < MAX_ANIMATIONS:
				loops.append(sname)

func _collect_animation_library(library: AnimationLibrary, animations: Array, loops: Array) -> void:
	if not library.has_method("get_animation_list"):
		return
	for name in library.get_animation_list():
		var sname := str(name)
		if animations.size() < MAX_ANIMATIONS and not animations.has(sname):
			animations.append(sname)
		if library.has_method("get_animation"):
			var anim: Animation = library.get_animation(name)
			if anim != null and anim.has_method("get_loop_mode"):
				if int(anim.get_loop_mode()) != 0 and not loops.has(sname) and loops.size() < MAX_ANIMATIONS:
					loops.append(sname)

func _collect_state_machine(sm: AnimationNodeStateMachine, res_path: String, animations: Array, transitions: Array) -> void:
	if not sm.has_method("get_transition_count"):
		return
	if not sm.has_method("get_transition_from") or not sm.has_method("get_transition_to"):
		return
	var count := int(sm.get_transition_count())
	for i in range(mini(count, MAX_TRANSITIONS * 2)):
		if transitions.size() >= MAX_TRANSITIONS:
			break
		var from_name := str(sm.get_transition_from(i))
		var to_name := str(sm.get_transition_to(i))
		if from_name.is_empty() or to_name.is_empty():
			continue
		if not animations.has(from_name) and animations.size() < MAX_ANIMATIONS:
			animations.append(from_name)
		if not animations.has(to_name) and animations.size() < MAX_ANIMATIONS:
			animations.append(to_name)
		var condition := ""
		if sm.has_method("get_transition"):
			var edge: AnimationNodeStateMachineTransition = sm.get_transition(i)
			if edge != null:
				var raw = edge.get("advance_condition")
				if raw != null:
					condition = str(raw)
		transitions.append({"resource": res_path, "from": from_name, "to": to_name, "condition": condition})

func _walk_state(state: SceneState, res_path: String, dependencies: Array, animations: Array, loops: Array, transitions: Array) -> Dictionary:
	var total := 0
	var enabled := 0
	var nodes := 0
	var state_machine := false
	var root_position = null
	var root_scale = null
	var center_flags: Array = []
	if not state.has_method("get_node_count"):
		return {"total": 0, "enabled": 0, "nodes": 0, "stateMachine": false, "rootPosition": null, "rootScale": null, "height": null, "pivot": null}
	var count := int(state.get_node_count())
	if count <= 0:
		return {"total": 0, "enabled": 0, "nodes": 0, "stateMachine": false, "rootPosition": null, "rootScale": null, "height": null, "pivot": null}
	var capped := mini(count, MAX_NODES)
	var path_strings: Array = []
	var type_strings: Array = []
	var property_maps: Array = []
	for i in range(capped):
		var ntype := ""
		var npath := ""
		if state.has_method("get_node_type"):
			ntype = str(state.get_node_type(i))
		if state.has_method("get_node_path"):
			npath = str(state.get_node_path(i))
		path_strings.append(npath)
		type_strings.append(ntype)
		var props := {}
		if state.has_method("get_node_property_count") and state.has_method("get_node_property_name") and state.has_method("get_node_property_value"):
			var pcount := int(state.get_node_property_count(i))
			for p in range(mini(pcount, 48)):
				var pname := str(state.get_node_property_name(i, p))
				if pname.is_empty():
					continue
				if pname == "transform" or pname == "position" or pname == "scale" or pname == "centered" or pname == "disabled" or pname == "shape" or pname == "mesh" or pname == "sprite_frames" or pname == "libraries" or pname == "tree_root" or pname == "script":
					props[pname] = state.get_node_property_value(i, p)
		property_maps.append(props)
	nodes = capped
	var globals: Array = []
	for i in range(capped):
		globals.append(Transform3D.IDENTITY)
	for i in range(capped):
		var parent_global := Transform3D.IDENTITY
		var mine := str(path_strings[i])
		var parent := _parent_path(mine)
		if not parent.is_empty():
			for j in range(i):
				if str(path_strings[j]) == parent:
					parent_global = globals[j]
					break
		var local := Transform3D.IDENTITY
		var stored = (property_maps[i] as Dictionary).get("transform", null)
		if stored is Transform3D:
			local = stored
		globals[i] = parent_global * local
		if i == 0:
			if stored is Transform3D:
				var origin: Vector3 = (stored as Transform3D).origin
				var basis_scale: Vector3 = (stored as Transform3D).basis.get_scale()
				root_position = [snappedf(origin.x, 0.001), snappedf(origin.y, 0.001), snappedf(origin.z, 0.001)]
				root_scale = [snappedf(basis_scale.x, 0.001), snappedf(basis_scale.y, 0.001), snappedf(basis_scale.z, 0.001)]
			else:
				var p2 = (property_maps[i] as Dictionary).get("position", null)
				var s2 = (property_maps[i] as Dictionary).get("scale", null)
				if p2 is Vector2:
					root_position = [snappedf((p2 as Vector2).x, 0.001), snappedf((p2 as Vector2).y, 0.001)]
				if s2 is Vector2:
					root_scale = [snappedf((s2 as Vector2).x, 0.001), snappedf((s2 as Vector2).y, 0.001)]
	var minimum := Vector3(INF, INF, INF)
	var maximum := Vector3(-INF, -INF, -INF)
	var found := false
	for i in range(capped):
		var ntype := str(type_strings[i])
		var props := property_maps[i] as Dictionary
		var script_value = props.get("script", null)
		if script_value is Resource:
			_add_res_path(dependencies, str((script_value as Resource).resource_path))
		if ntype == "CollisionShape2D" or ntype == "CollisionShape3D":
			total += 1
			var disabled := false
			if props.has("disabled"):
				disabled = bool(props.get("disabled", false))
			if props.get("shape", null) != null and not disabled:
				enabled += 1
		if ntype == "Sprite2D":
			if props.has("centered"):
				center_flags.append(bool(props.get("centered", true)))
			else:
				center_flags.append(true)
		if ntype == "AnimatedSprite2D" or ntype == "AnimatedSprite3D":
			var frames_value = props.get("sprite_frames", null)
			if frames_value is SpriteFrames:
				_collect_sprite_frames(frames_value, animations, loops)
				_add_res_path(dependencies, str((frames_value as Resource).resource_path))
		if ntype == "AnimationPlayer":
			var libraries_value = props.get("libraries", null)
			if libraries_value is Dictionary:
				for key in (libraries_value as Dictionary).keys():
					var library_value = (libraries_value as Dictionary).get(key, null)
					if library_value is AnimationLibrary:
						_collect_animation_library(library_value, animations, loops)
						_add_res_path(dependencies, str((library_value as Resource).resource_path))
		if ntype == "AnimationTree":
			state_machine = true
			var root_value = props.get("tree_root", null)
			if root_value is AnimationNodeStateMachine:
				_collect_state_machine(root_value, res_path, animations, transitions)
		if ntype == "MeshInstance3D":
			var mesh_value = props.get("mesh", null)
			if mesh_value is Resource and (mesh_value as Resource).has_method("get_aabb"):
				var box: AABB = (mesh_value as Mesh).get_aabb()
				var global: Transform3D = globals[i]
				var grown := _expand(global, box, minimum, maximum)
				minimum = grown[0]
				maximum = grown[1]
				found = true
				_add_res_path(dependencies, str((mesh_value as Resource).resource_path))
	var height = null
	var pivot = null
	if found:
		height = snappedf(maximum.y - minimum.y, 0.001)
		var width_x := maximum.x - minimum.x
		var depth_z := maximum.z - minimum.z
		var centre_x := (minimum.x + maximum.x) / 2.0
		var centre_z := (minimum.z + maximum.z) / 2.0
		if absf(minimum.y) < 0.05 and absf(centre_x) < 0.25 * maxf(width_x, 0.001) + 0.05 and absf(centre_z) < 0.25 * maxf(depth_z, 0.001) + 0.05:
			pivot = "ground"
		else:
			pivot = "center"
	elif not center_flags.is_empty():
		pivot = "center" if bool(center_flags[0]) else "ground"
	return {"total": total, "enabled": enabled, "nodes": nodes, "stateMachine": state_machine, "rootPosition": root_position, "rootScale": root_scale, "height": height, "pivot": pivot}

func _parent_path(path_string: String) -> String:
	if path_string.is_empty() or path_string == ".":
		return ""
	if not path_string.contains("/"):
		return ""
	return path_string.get_base_dir()

func _expand(global: Transform3D, box: AABB, minimum: Vector3, maximum: Vector3) -> Array:
	for cx in range(2):
		for cy in range(2):
			for cz in range(2):
				var corner := box.position + Vector3(box.size.x if cx == 1 else 0.0, box.size.y if cy == 1 else 0.0, box.size.z if cz == 1 else 0.0)
				var world: Vector3 = global * corner
				minimum.x = minf(minimum.x, world.x)
				minimum.y = minf(minimum.y, world.y)
				minimum.z = minf(minimum.z, world.z)
				maximum.x = maxf(maximum.x, world.x)
				maximum.y = maxf(maximum.y, world.y)
				maximum.z = maxf(maximum.z, world.z)
	return [minimum, maximum]

func _write(result: Dictionary) -> void:
	if _result_path.is_empty():
		return
	var file := FileAccess.open(_result_path, FileAccess.WRITE)
	if file == null:
		return
	file.store_string(JSON.stringify(result))
	file.close()
`;

/**
 * Pack inclusion for `game_assets_inspect`. Runs headlessly against an empty
 * bootstrap project - never the game project, never with autoloads - and
 * asks the engine whether the exact recorded `.pck` contains each `res://`
 * path. Only `ProjectSettings.load_resource_pack` plus
 * `ResourceLoader.exists` run: no `ResourceLoader.load`, no instantiation,
 * no `_init`, no script execution. Remap-aware: `exists` follows the export
 * remaps, so an engine-renamed glb/png still reads as included.
 */
export const GODOT_ASSET_EXPORT_INCLUSION_SCRIPT = `extends SceneTree

const MAX_CHECKS := 32

var _request_path := ""
var _result_path := ""

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	_request_path = args[0] if args.size() > 0 else ""
	_result_path = args[1] if args.size() > 1 else ""
	var outcome := _check()
	_write(outcome)
	quit(0 if not outcome.has("error") else 1)

func _check() -> Dictionary:
	if _request_path.is_empty():
		return {"error": "No request file was given."}
	var file := FileAccess.open(_request_path, FileAccess.READ)
	if file == null:
		return {"error": "The request file does not read."}
	var request: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	if not (request is Dictionary):
		return {"error": "The request file is not a JSON object."}
	var pack_path := str(request.get("packPath", ""))
	var checks: Array = request.get("checks", [])
	if pack_path.is_empty():
		return {"error": "No pack path was given."}
	if not ProjectSettings.load_resource_pack(pack_path):
		return {"error": "The pack did not load as a Godot resource pack."}
	var included: Array = []
	var missing: Array = []
	var unresolved: Array = []
	for raw in checks.slice(0, MAX_CHECKS):
		var path := str(raw)
		if path.is_empty() or not path.begins_with("res://"):
			if unresolved.size() < MAX_CHECKS and not unresolved.has(path):
				unresolved.append(path)
			continue
		if ResourceLoader.exists(path, ""):
			if included.size() < MAX_CHECKS and not included.has(path):
				included.append(path)
		else:
			if missing.size() < MAX_CHECKS and not missing.has(path):
				missing.append(path)
	return {"included": included, "missing": missing, "unresolved": unresolved}

func _write(result: Dictionary) -> void:
	if _result_path.is_empty():
		return
	var file := FileAccess.open(_result_path, FileAccess.WRITE)
	if file == null:
		return
	file.store_string(JSON.stringify(result))
	file.close()
`;
