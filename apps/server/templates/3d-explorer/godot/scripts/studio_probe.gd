## Read-only snapshot hook for Game Studio's web playtest. The browser calls
## `window.__studioProbe()` and gets JSON: GameState's public primitive members and
## the world position of the first node in the `player` group.
##
## It is installed only in web builds, it never writes to the game, and it is
## deliberately tiny: no gameplay logic lives here. Extend GameState (not this
## script) when a new run value should be observable.
extends Node

## Hard bounds so a runaway GameState cannot make the probe response expensive.
const MAX_KEYS := 40
const MAX_STRING_CHARS := 80

## Kept as a member so the JavaScript function wrapping the GDScript callback
## stays alive for the whole session.
var _callback: JavaScriptObject = null

func _ready() -> void:
	if not OS.has_feature("web"):
		return
	var window := JavaScriptBridge.get_interface("window")
	if window == null:
		return
	_callback = JavaScriptBridge.create_callback(_read)
	window.__studioProbe = _callback

func _read(_args: Array) -> String:
	var text := JSON.stringify(snapshot())
	# A callback's return value does not cross back into JavaScript, so the probe
	# also parks the snapshot on the window for the browser to read.
	JavaScriptBridge.eval("window.__studioProbeLast = %s" % JSON.stringify(text), true)
	return text

## The snapshot itself, split out so it can be read and tested without a browser.
func snapshot() -> Dictionary:
	return {
		"gameState": _game_state_values(),
		"player": _player_position(),
	}

func _game_state_values() -> Dictionary:
	var values := {}
	var game_state := get_node_or_null("/root/GameState")
	if game_state == null:
		return values
	for property in game_state.get_property_list():
		if values.size() >= MAX_KEYS:
			break
		if not (int(property.usage) & PROPERTY_USAGE_SCRIPT_VARIABLE):
			continue
		var key := str(property.name)
		if key.begins_with("_"):
			continue
		var value: Variant = game_state.get(key)
		if value is bool or value is int or value is float:
			values[key] = value
		elif value is String or value is StringName:
			values[key] = str(value).left(MAX_STRING_CHARS)
	return values

func _player_position() -> Variant:
	var tree := get_tree()
	if tree == null:
		return null
	for node in tree.get_nodes_in_group("player"):
		if not is_instance_valid(node):
			continue
		if node is Node3D:
			var at: Vector3 = node.global_position
			return {"x": at.x, "y": at.y, "z": at.z}
		if node is Node2D:
			var flat: Vector2 = node.global_position
			return {"x": flat.x, "y": flat.y, "z": 0.0}
	return null
