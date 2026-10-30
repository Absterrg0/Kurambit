/**
 * Shared probe helpers for the Godot scenario runner and the native
 * exploration runner. It is a GDScript string, not an asset, concatenated
 * after `extends SceneTree` by both scripts. The functions are verbatim
 * extracts of the scenario runner's own probe readers, so the exam's
 * behaviour does not change when it includes this file instead of defining
 * them itself.
 *
 * All functions are pure reads: they never write game state or call a game
 * method. `_runtime_game_state` relies on the including script's `_game_state`
 * being the `/root/GameState` autoload lookup; both runners define it the
 * same way through this file.
 */
export const GODOT_SHARED_PROBE = `func _game_state() -> Node:
	return root.get_node_or_null("GameState")

func _player_position(body: Variant) -> Variant:
	if body is Node2D:
		return (body as Node2D).global_position
	if body is Node3D:
		return (body as Node3D).global_position
	return null

func _encode_pos(pos: Variant) -> Variant:
	# Runner positions cross as plain arrays: a Vector2 becomes [x, y] and a
	# Vector3 becomes [x, y, z]. Anything else stays null (unobserved).
	if pos is Vector2:
		return [(pos as Vector2).x, (pos as Vector2).y]
	if pos is Vector3:
		return [(pos as Vector3).x, (pos as Vector3).y, (pos as Vector3).z]
	return null

func _runtime_game_state() -> Dictionary:
	var state := _game_state()
	var values := {}
	var truncated := false
	if state == null:
		return {"values": values, "complete": false}
	for prop in state.get_property_list():
		if (int(prop.get("usage", 0)) & PROPERTY_USAGE_SCRIPT_VARIABLE) == 0:
			continue
		var key := str(prop.get("name", ""))
		if key.is_empty() or key.length() > 64 or values.size() >= 64:
			truncated = true
			continue
		var value: Variant = state.get(key)
		if value == null or typeof(value) == TYPE_BOOL or typeof(value) == TYPE_INT:
			values[key] = value
		elif typeof(value) == TYPE_FLOAT and is_finite(float(value)):
			values[key] = value
		elif typeof(value) == TYPE_STRING and str(value).length() <= 256:
			values[key] = value
		else:
			truncated = true
	return {"values": values, "complete": not truncated}

# One key event with the map's own keycode pair. Both fields are set: a
# physical-only event never reaches Input.is_key_pressed, and a keycode-only
# event never reaches the physical poll, so a tap needs both to land. Callers
# pass the InputMap event's own pair, or the same code twice for a physical
# key with no map entry.
func _make_key_event(keycode: int, physical: int, pressed: bool) -> InputEventKey:
	var ev := InputEventKey.new()
	ev.physical_keycode = physical
	ev.keycode = keycode
	ev.pressed = pressed
	ev.echo = false
	return ev
`;
