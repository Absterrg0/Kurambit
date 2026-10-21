## Read-only snapshot hook for Game Studio's web playtest. The browser calls
## `window.__studioProbe()` and gets JSON: GameState's public primitive members and
## the world position of the first node in the `player` group.
##
## It also carries the stage's visibility bridge. The app that hosts this game in
## its iframe sends `studio-visibility` postMessages, and while the stage tab is
## not open the probe pauses the SceneTree and mutes the master audio bus, so a
## game behind another tab cannot keep walking, scoring or sounding. It answers
## with the state it observed in a `studio-visibility-ack` postMessage to the
## parent document, and parks the same object on `window.__studioVisibilityAck`
## for tests.
##
## It is installed only in web builds, it never writes to the game beyond that
## pause and mute, and no gameplay logic lives here. Extend GameState (not this
## script) when a new run value should be observable.
extends Node

## Hard bounds so a runaway GameState cannot make the probe response expensive.
const MAX_KEYS := 40
const MAX_STRING_CHARS := 80

## Kept as a member so the JavaScript function wrapping the GDScript callback
## stays alive for the whole session.
var _callback: JavaScriptObject = null
var _window: JavaScriptObject = null
var _visibility_callback: JavaScriptObject = null
## The pause and mute to put back when the stage returns; the game counts as
## running and audible until a first hide says otherwise.
var _resume_paused := false
var _resume_muted := false
## A repeated hide (a restated request) must not overwrite the state to restore.
var _hidden := false


func _ready() -> void:
	if not OS.has_feature("web"):
		return
	_window = JavaScriptBridge.get_interface("window")
	if _window == null:
		return
	_callback = JavaScriptBridge.create_callback(_read)
	_window.__studioProbeCallback = _callback
	_window.__studioProbe = _callback
	# A Godot callback's return value does not cross back into JavaScript, so the
	# public probe is a small JS wrapper around it: it calls the callback, which
	# parks the snapshot on the window, and returns that JSON string. The raw
	# callback stays installed if this eval is ever unavailable.
	JavaScriptBridge.eval(
		"window.__studioProbe = function () { window.__studioProbeLast = null; window.__studioProbeCallback(); return window.__studioProbeLast; };",
		true,
	)
	_install_visibility_bridge()

func _read(_args: Array) -> String:
	var text := JSON.stringify(snapshot())
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

## Hands the browser's message the probe's own JS listener, so pause and mute
## still reach the engine from a hidden tab where the app cannot reach deeper.
func _install_visibility_bridge() -> void:
	_visibility_callback = JavaScriptBridge.create_callback(_on_visibility_requested)
	_window.__studioVisibilityCallback = _visibility_callback
	JavaScriptBridge.eval(
		"""
		(function () {
			if (window.__studioVisibilityInstalled) return;
			window.__studioVisibilityInstalled = true;
			window.addEventListener("message", function (event) {
				var data = event.data;
				if (data === null || typeof data !== "object" || data.type !== "studio-visibility") return;
				// Parked as 1/0: a number is the one value the bridge always carries.
				window.__studioVisibilityRequested = data.visible === true ? 1 : 0;
				window.__studioVisibilityCallback(window.__studioVisibilityRequested);
			});
		})();
		""",
		true,
	)

func _on_visibility_requested(args: Array) -> void:
	# The listener mirrors the request as a callback argument and parks it on
	# the window; either the engine forwards arguments or the parked number
	# still carries the request, so one miss does not kill the bridge.
	var raw: Variant = args.back()
	if not (raw is int or raw is float):
		raw = _window.__studioVisibilityRequested
	if not (raw is int or raw is float):
		return
	_apply_visibility(int(raw) == 1)

## The one inversion the stage may ask of a game: while its tab is hidden the
## run stops (SceneTree paused) and goes silent (master bus muted). Whatever
## the game itself had paused or muted when it was hidden is what comes back.
func _apply_visibility(visible: bool) -> void:
	var tree := get_tree()
	if visible:
		if _hidden:
			if tree != null:
				tree.paused = _resume_paused
			AudioServer.set_bus_mute(0, _resume_muted)
			_hidden = false
	else:
		if not _hidden:
			_resume_paused = tree != null and tree.paused
			_resume_muted = AudioServer.is_bus_mute(0)
			_hidden = true
		if tree != null:
			tree.paused = true
		AudioServer.set_bus_mute(0, true)
	_report_visibility(visible)

func _report_visibility(visible: bool) -> void:
	var tree := get_tree()
	var payload := JSON.stringify({
		"type": "studio-visibility-ack",
		"visible": visible,
		"paused": tree != null and tree.paused,
		"muted": AudioServer.is_bus_mute(0),
	})
	# The play surface reads the parent postMessage; tests read the parked
	# JSON as an object, the way the surface filters acks.
	JavaScriptBridge.eval(
		"var ack = JSON.parse('%s'); window.__studioVisibilityAck = ack; parent.postMessage(ack, '*');" % payload,
		true,
	)
