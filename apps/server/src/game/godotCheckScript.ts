/**
 * The check script Godot runs headlessly for `game_godot_check`. It is a
 * string, not an asset, so the packed server archive carries it without a
 * second asset-copy rule. GameService writes it under the game's ignored
 * `builds/logs/` tree and passes the result path after `--`.
 */
export const GODOT_CHECK_SCRIPT = `extends SceneTree

const PHYSICS_FRAMES := 120
const MAX_ISSUES := 100

var _errors: Array = []
var _warnings: Array = []
var _result_path := ""
var _main_scene := ""
var _seen_warnings := {}

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	_result_path = args[0] if args.size() > 0 else ""
	_main_scene = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	var scripts: Array = []
	var resources: Array = []
	_collect_files("res://", scripts, resources)
	for file in scripts:
		var script := load(file)
		if script == null:
			_add_error(file, "Failed to load script.")
		elif script is GDScript and not script.can_instantiate():
			_add_error(file, "Script does not compile.")
	for file in resources:
		if load(file) == null:
			_add_error(file, "Failed to load resource.")
	_lint_inputs(scripts)
	await _run_main()
	_write_result()
	quit(0 if _errors.is_empty() else 1)

func _collect_files(path: String, scripts: Array, resources: Array) -> void:
	var directory := DirAccess.open(path)
	if directory == null:
		return
	directory.list_dir_begin()
	while true:
		var name := directory.get_next()
		if name.is_empty():
			break
		if name.begins_with("."):
			continue
		var full := path.path_join(name)
		if directory.current_is_dir():
			_collect_files(full, scripts, resources)
		elif name.ends_with(".gd"):
			scripts.append(full)
		elif name.ends_with(".tscn") or name.ends_with(".tres"):
			resources.append(full)
	directory.list_dir_end()

func _lint_inputs(files: Array) -> void:
	var pattern := RegEx.new()
	pattern.compile("Input\\\\.(?:is_action(?:_pressed|_just_pressed|_just_released)?|get_action_strength|get_action_raw_strength|action_press|action_release|get_vector)\\\\(\\\\s*\\"([^\\"]+)\\"")
	var seen := {}
	for file in files:
		var text := FileAccess.get_file_as_string(file)
		for found in pattern.search_all(text):
			var action := found.get_string(1)
			if seen.has(action):
				continue
			seen[action] = true
			if not InputMap.has_action(action):
				_add_warning(file, "Input action \\"%s\\" is used but not defined in the InputMap." % action)

func _run_main() -> void:
	if _main_scene.is_empty():
		_add_error("project.godot", "No main scene is configured (application/run/main_scene).")
		return
	var packed := load(_main_scene) as PackedScene
	if packed == null:
		_add_error(_main_scene, "The main scene does not load.")
		return
	var instance := packed.instantiate()
	if instance == null:
		_add_error(_main_scene, "The main scene does not instantiate.")
		return
	root.add_child(instance)
	for i in PHYSICS_FRAMES:
		await physics_frame
	if is_instance_valid(instance):
		_lint_tree(instance)
		instance.queue_free()

func _lint_tree(instance: Node) -> void:
	if not _tree_has_camera(instance):
		_add_warning(_main_scene, "No Camera2D or Camera3D in the main scene tree.")
	_lint_nodes(instance)

func _tree_has_camera(node: Node) -> bool:
	if node is Camera2D or node is Camera3D:
		return true
	for child in node.get_children():
		if _tree_has_camera(child):
			return true
	return false

func _lint_nodes(node: Node) -> void:
	if node is CharacterBody2D or node is CharacterBody3D:
		if _find_collision(node) == null:
			_add_warning(_node_path(node), "%s has no CollisionShape child; it cannot collide." % node.get_class())
	for child in node.get_children():
		_lint_nodes(child)

func _find_collision(node: Node) -> Node:
	for child in node.get_children():
		if child is CollisionShape2D or child is CollisionShape3D:
			return child
		var nested := _find_collision(child)
		if nested != null:
			return nested
	return null

func _node_path(node: Node) -> String:
	if node == root:
		return "."
	return str(root.get_path_to(node))

func _add_error(file: String, message: String) -> void:
	if _errors.size() < MAX_ISSUES:
		_errors.append({"file": file, "message": message})

func _add_warning(file: String, message: String) -> void:
	var key := file + ":" + message
	if _warnings.size() < MAX_ISSUES and not _seen_warnings.has(key):
		_seen_warnings[key] = true
		_warnings.append({"file": file, "message": message})

func _write_result() -> void:
	if _result_path.is_empty():
		return
	var file := FileAccess.open(_result_path, FileAccess.WRITE)
	if file == null:
		return
	file.store_string(JSON.stringify({
		"mainScene": _main_scene,
		"errors": _errors,
		"warnings": _warnings,
	}))
	file.close()
`;
