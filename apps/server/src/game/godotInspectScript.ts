/**
 * The scene dump Godot runs headlessly for `game_scene_inspect`. Kept as a
 * string beside the check script for the same reason: the packed server has no
 * second asset-copy rule for GDScript.
 */
export const GODOT_INSPECT_SCRIPT = `extends SceneTree

const MAX_NODES := 400

var _scene_path := ""
var _result_path := ""
var _nodes: Array = []
var _total := 0

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	_scene_path = args[0] if args.size() > 0 else ""
	_result_path = args[1] if args.size() > 1 else ""
	var packed := load(_scene_path) as PackedScene
	if packed == null:
		_write({"error": "The scene does not load: " + _scene_path})
		quit(1)
		return
	var scene := packed.instantiate()
	if scene == null:
		_write({"error": "The scene does not instantiate: " + _scene_path})
		quit(1)
		return
	_walk(scene, ".")
	_write({
		"scenePath": _scene_path,
		"nodes": _nodes,
		"nodeCount": _total,
		"truncated": _total > _nodes.size(),
	})
	scene.free()
	quit(0)

func _walk(node: Node, path: String) -> void:
	_total += 1
	if _nodes.size() < MAX_NODES:
		var children: Array = []
		for child in node.get_children():
			children.append(str(child.name))
		var entry := {
			"path": path,
			"name": str(node.name),
			"type": node.get_class(),
			"groups": _groups(node),
			"children": children,
		}
		var script := node.get_script()
		if script is Script and not script.resource_path.is_empty():
			entry["script"] = script.resource_path
		var position := _position(node)
		if not position.is_empty():
			entry["position"] = position
		if node is CollisionObject2D or node is CollisionObject3D:
			entry["collisionLayer"] = node.collision_layer
			entry["collisionMask"] = node.collision_mask
		_nodes.append(entry)
	for child in node.get_children():
		_walk(child, str(child.name) if path == "." else path + "/" + str(child.name))

func _groups(node: Node) -> Array:
	var groups: Array = []
	for group in node.get_groups():
		groups.append(str(group))
	return groups

func _position(node: Node) -> Array:
	var value = null
	if node is Node3D:
		value = node.position
	elif node is Node2D or node is Control:
		value = node.position
	if value == null:
		return []
	if value is Vector3:
		return [snappedf(value.x, 0.001), snappedf(value.y, 0.001), snappedf(value.z, 0.001)]
	return [snappedf(value.x, 0.001), snappedf(value.y, 0.001)]

func _write(result: Dictionary) -> void:
	if _result_path.is_empty():
		return
	var file := FileAccess.open(_result_path, FileAccess.WRITE)
	if file == null:
		return
	file.store_string(JSON.stringify(result))
	file.close()
`;
