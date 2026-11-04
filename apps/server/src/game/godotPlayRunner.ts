/**
 * Godot's play-session runner (the protocol in `@kurambit/contracts`
 * gamePlaySession.ts), for both exploration and bots. It is a string, not an
 * asset, so the packed server archive carries it without a second asset-copy
 * rule. The launch writes it under the game's ignored `builds/logs/` tree and
 * passes the request path after `--`.
 *
 * The runner starts the real main scene from current sources (no export),
 * connects out to 127.0.0.1 with the session token and says hello with the
 * game tree held. Held, acts run with the tree unpaused and hold it again
 * after; the runner itself keeps polling TCP while paused (SceneTree signals
 * still fire when paused, verified on Godot 4.7). An act resumes the pause
 * the game itself last set, so a game left on its pause or end screen stays
 * frozen through the next act. `realtime` gives the game its own pause state
 * back for good, and from then on the loop yields on physics frames (so ticks
 * stay at 10 Hz even when software rendering is slower) and the game runs at
 * normal speed while input streams in.
 *
 * Input lands before game nodes read it by frame order: every event is
 * injected synchronously and the next physics frame is awaited before the
 * release, so the game polls the already-queued event. A key tap stays down
 * for at least 10 physics frames (~167 ms at 60 Hz): T16 showed shorter
 * presses land between physics frames and are missed despite input latches.
 * Keys go through `Input.parse_input_event`, so `_input`/`_unhandled_input`
 * handlers and runtime-registered InputMap actions both see them. Mouse goes
 * through the real viewport (`push_input` at the control's centre); the
 * runner never emits a signal directly, so an overlay blocking a click stays
 * visible and the reply says the control did not receive it. The only write
 * is the explicit `setState`, which the harness always reports.
 *
 * UI listing and visible-text keys follow the owner-qualified `<Owner>.<Name>`
 * scheme adapted from ramenvr/autopilot lib/ui.gd (Apache-2.0); the view
 * shape (visible landmarks with distance and bearing, the body, raycast room)
 * and the error-log drain from its lib/world.gd and lib/detectors.gd. Only
 * those ideas are borrowed; the code below is our own.
 */
export const GODOT_PLAY_RUNNER = `extends SceneTree

const BOOT_FRAMES := 30
const ACT_TEXT_ENTRIES := 128
const TICK_TEXT_ENTRIES := 64
const MAX_TEXT_CHARS := 200
const ACT_UI_CONTROLS := 64
const TICK_UI_CONTROLS := 32
const ACT_ERRORS := 20
const TICK_ERRORS := 10
const MAX_INSPECT_VALUES := 64
const MAX_LANDMARKS := 16
const ROOM_DIST := 6.0
const DROP_DIST := 4.0
const TAP_FRAMES := 10

class RunnerErrorLog extends Logger:
	var mutex := Mutex.new()
	var lines: Array = []
	func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, script_backtraces: Array) -> void:
		var where := "%s:%d" % [file, line]
		for bt in script_backtraces:
			if bt != null and not bt.is_empty() and bt.get_frame_count() > 0:
				where = "%s:%d" % [bt.get_frame_file(0), bt.get_frame_line(0)]
				break
		mutex.lock()
		if lines.size() < 1000:
			lines.append({"message": rationale if rationale != "" else code, "where": where})
		mutex.unlock()
	func _log_message(_message: String, _error: bool) -> void:
		pass
	func drain() -> Array:
		mutex.lock()
		var out := lines
		lines = []
		mutex.unlock()
		return out

var _port := 0
var _token := ""
var _expected_user_prefix := ""
var _peer := StreamPeerTCP.new()
var _read_buf := PackedByteArray()
var _errors := RunnerErrorLog.new()
var _pointer := Vector2.ZERO
var _pointer_init := false
var _physics_hz := 60
var _game_paused := false
var _realtime := false
var _running := true
var _start_physics := 0
var _tick := 0
var _sweep_tick := 0
var _held: Dictionary = {}
var _tap_releases: Array = []

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() < 1:
		printerr("play runner needs a request path")
		quit(2)
		return
	var request = _read_json(str(args[0]))
	if typeof(request) != TYPE_DICTIONARY:
		printerr("play runner request is not a JSON object")
		quit(2)
		return
	_port = int(request.get("port", 0))
	_token = str(request.get("token", ""))
	_expected_user_prefix = str(request.get("expectedUserDataPrefix", ""))
	if _port <= 0 or _token.is_empty():
		printerr("play runner request needs a port and a token")
		quit(2)
		return
	_physics_hz = maxi(1, int(ProjectSettings.get_setting("physics/common/physics_ticks_per_second", 60)))
	# Headless keeps a tiny root window; the project size is the only honest
	# frame for layout, ui rects and the picture. Deferred so it applies after
	# Window initialization without ticking autoloads first.
	root.set_deferred("size", Vector2i(int(ProjectSettings.get_setting("display/window/size/viewport_width", 1152)), int(ProjectSettings.get_setting("display/window/size/viewport_height", 648))))
	OS.add_logger(_errors)
	await _serve()
	OS.remove_logger(_errors)
	quit(0)

func _serve() -> void:
	if not _expected_user_prefix.is_empty():
		var dir := OS.get_user_data_dir()
		if dir.is_empty() or not (dir == _expected_user_prefix or dir.begins_with(_expected_user_prefix.trim_suffix("/") + "/")):
			await _fail_boot("The engine user data dir is outside the isolated per-run directory.")
			return
	var main_path := str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if main_path.is_empty():
		await _fail_boot("project.godot has no application/run/main_scene.")
		return
	var packed := load(main_path) as PackedScene
	if packed == null:
		await _fail_boot("The main scene does not load: %s" % main_path)
		return
	var scene := packed.instantiate()
	if scene == null:
		await _fail_boot("The main scene does not instantiate: %s" % main_path)
		return
	root.add_child(scene)
	current_scene = scene
	for i in BOOT_FRAMES:
		await physics_frame
	await process_frame
	await process_frame
	if not await _connect():
		return
	_hold()
	_send(_hello())
	while _running and not _realtime:
		var line := await _read_line()
		if line.is_empty():
			return
		await _handle(line)
	if not _realtime:
		return
	paused = _game_paused
	_start_physics = Engine.get_physics_frames()
	var tick_every := maxi(1, roundi(float(_physics_hz) / 10.0))
	var since_tick := 0
	var dead_pump := 0
	while _running:
		await physics_frame
		if _peer.get_status() != 2:
			dead_pump += 1
			if dead_pump > 300:
				return
			continue
		dead_pump = 0
		await _pump()
		_tick_taps()
		since_tick += 1
		if since_tick >= tick_every:
			since_tick = 0
			_send(_tick_observation())

# Connect out to the server that launched us; the token authenticates us.
func _connect() -> bool:
	_peer.connect_to_host("127.0.0.1", _port)
	for i in 3600:
		_peer.poll()
		if _peer.get_status() == 2:
			return true
		if _peer.get_status() == 3:
			return false
		await process_frame
	return false

# A boot failure reaches the harness only when the connection opens.
func _fail_boot(message: String) -> void:
	if await _connect():
		_send({"op": "error", "error": message})

func _handle(line: String) -> void:
	if line.strip_edges().is_empty():
		return
	var msg = JSON.parse_string(line)
	if typeof(msg) != TYPE_DICTIONARY:
		return
	var op := str(msg.get("op", ""))
	if op == "quit":
		_send({"op": "reply", "id": msg.get("id", 0), "ok": true})
		_running = false
	elif op == "act" and not _realtime:
		_send(await _run_act(msg))
	elif op == "realtime":
		_realtime = true
	elif op == "input" and _realtime:
		await _apply_input(msg)
	elif op == "setState":
		_send(_apply_set_state(msg))

func _hello() -> Dictionary:
	return {
		"op": "hello",
		"protocol": 1,
		"token": _token,
		"engine": "godot",
		"capabilities": ["realtime", "ui", "inspect", "setState"],
		"physicsHz": _physics_hz,
		"probe": _read_probe(ACT_TEXT_ENTRIES),
		"screenText": _read_screen_text(ACT_TEXT_ENTRIES),
		"ui": _list_ui(),
		"body": _read_body(),
		"errors": _drain_errors(ACT_ERRORS),
		"perf": _read_perf(),
	}

# --- acts (the game is held between them) ---

func _run_act(msg: Dictionary) -> Dictionary:
	var id_val = msg.get("id", 0)
	var steps: Array = msg.get("steps", [])
	var shot_path: Variant = msg.get("screenshotPath", null)
	if shot_path != null and not (shot_path is String):
		shot_path = null
	paused = _game_paused
	var executed := 0
	var ui_results: Array = []
	var inspections: Array = []
	for step in steps:
		if typeof(step) != TYPE_DICTIONARY:
			_hold()
			return {"op": "reply", "id": id_val, "ok": false, "error": "A step is not an object."}
		var err := await _run_step(step, ui_results, inspections)
		if not err.is_empty():
			_hold()
			return {"op": "reply", "id": id_val, "ok": false, "error": err}
		if not (step.has("waitMs") or step.has("screenshot") or step.has("inspect")):
			executed += 1
	_release_map_actions()
	await process_frame
	await process_frame
	var shot := _take_screenshot(shot_path)
	var obs := {
		"op": "reply",
		"id": id_val,
		"ok": true,
		"probe": _read_probe(ACT_TEXT_ENTRIES),
		"screenText": _read_screen_text(ACT_TEXT_ENTRIES),
		"ui": _list_ui(),
		"errors": _drain_errors(ACT_ERRORS),
		"inspections": inspections,
		"uiResults": ui_results,
		"executedInputSteps": executed,
		"screenshot": shot,
	}
	_hold()
	return obs

# Freezes game time between acts, remembering whether the game had paused
# itself so the next act resumes that state rather than unpausing it.
func _hold() -> void:
	_game_paused = paused
	paused = true

func _frames_for_ms(ms: int) -> int:
	return maxi(1, roundi(float(maxi(0, ms)) * float(_physics_hz) / 1000.0))

func _run_step(step: Dictionary, ui_results: Array, inspections: Array) -> String:
	if step.has("press"):
		return await _do_key_tap(_keycode_for(str(step["press"])))
	if step.has("hold") or step.has("key") or step.has("keys"):
		var names: Array = []
		if step.has("keys"):
			names = step["keys"]
		elif step.has("key"):
			names = [str(step["key"])]
		else:
			names = [str(step["hold"])]
		return await _do_key_hold(names, int(step.get("holdMs", 50)))
	if step.has("waitMs"):
		_release_map_actions()
		for i in _frames_for_ms(int(step["waitMs"])):
			await physics_frame
		return ""
	if step.has("screenshot"):
		return ""
	if step.has("click"):
		var pos := _click_pos(step)
		_push_click(pos, int(MOUSE_BUTTON_LEFT))
		return ""
	if step.has("drag"):
		var drag: Dictionary = step["drag"]
		var from := Vector2(float(drag.get("from", {}).get("x", 0.0)), float(drag.get("from", {}).get("y", 0.0)))
		var to := Vector2(float(drag.get("to", {}).get("x", 0.0)), float(drag.get("to", {}).get("y", 0.0)))
		await _push_drag(from, to, _frames_for_ms(int(step.get("holdMs", 300))))
		return ""
	if step.has("mouseMove"):
		var mv: Dictionary = step["mouseMove"]
		_ensure_pointer()
		_pointer.x = clampf(_pointer.x + float(mv.get("dx", 0.0)), 0.0, float(root.size.x))
		_pointer.y = clampf(_pointer.y + float(mv.get("dy", 0.0)), 0.0, float(root.size.y))
		root.warp_mouse(_pointer)
		var motion := InputEventMouseMotion.new()
		motion.position = _pointer
		motion.global_position = _pointer
		root.push_input(motion, true)
		return ""
	if step.has("ui"):
		return await _do_ui(step["ui"], ui_results)
	if step.has("inspect"):
		inspections.append(_do_inspect(step["inspect"]))
		return ""
	return "Unknown step kind."

func _click_pos(step: Dictionary) -> Vector2:
	_ensure_pointer()
	if step.get("x", null) == null or step.get("y", null) == null:
		return root.size * 0.5
	var pos := Vector2(float(step["x"]), float(step["y"]))
	pos.x = clampf(pos.x, 0.0, float(root.size.x))
	pos.y = clampf(pos.y, 0.0, float(root.size.y))
	_pointer = pos
	_pointer_init = true
	return pos

func _ensure_pointer() -> void:
	if not _pointer_init:
		_pointer = root.size * 0.5
		_pointer_init = true

func _do_key_tap(code: int) -> String:
	if code == KEY_NONE:
		return "Unknown key."
	Input.parse_input_event(_make_key_event(code, true))
	for i in TAP_FRAMES:
		await physics_frame
	Input.parse_input_event(_make_key_event(code, false))
	await physics_frame
	await physics_frame
	return ""

func _do_key_hold(names: Array, hold_ms: int) -> String:
	var codes: Array = []
	for name in names:
		var code := _keycode_for(str(name))
		if code == KEY_NONE:
			_release_map_actions()
			return "Unknown key %s." % str(name)
		codes.append(code)
	for code in codes:
		Input.parse_input_event(_make_key_event(code, true))
	for i in _frames_for_ms(hold_ms):
		await physics_frame
	for code in codes:
		Input.parse_input_event(_make_key_event(code, false))
	await physics_frame
	return ""

func _release_map_actions() -> void:
	# Physical keys and mouse buttons are always released inside their own
	# step, so nothing is held across steps. These only clear a stuck map
	# action if a game pressed one itself mid-act.
	for action in ["ui_accept", "ui_select", "ui_cancel", "ui_left", "ui_right", "ui_up", "ui_down"]:
		Input.action_release(action)

func _push_drag(from: Vector2, to: Vector2, frames: int) -> void:
	_push_click(from, int(MOUSE_BUTTON_LEFT))
	for i in maxi(1, frames):
		var f := float(i + 1) / float(maxi(1, frames))
		var pos := from.lerp(to, f)
		root.warp_mouse(pos)
		var motion := InputEventMouseMotion.new()
		motion.position = pos
		motion.global_position = pos
		root.push_input(motion, true)
		await physics_frame
	_pointer = to
	_pointer_init = true
	root.warp_mouse(to)
	_push_release(to, int(MOUSE_BUTTON_LEFT))
	await physics_frame

func _do_ui(spec: Variant, ui_results: Array) -> String:
	if typeof(spec) != TYPE_DICTIONARY:
		return "A ui step needs an object."
	var id := str(spec.get("id", ""))
	var action := str(spec.get("action", "click"))
	if id.is_empty():
		return "A ui step needs an id."
	var c := _find_control(id)
	if c == null:
		ui_results.append({"id": id, "action": action, "received": false, "detail": "no element %s on screen" % id})
		return ""
	if c is BaseButton and (c as BaseButton).disabled:
		ui_results.append({"id": id, "action": action, "received": false, "detail": "%s is disabled" % id})
		return ""
	if action == "click":
		var received := await _click_control(c)
		ui_results.append({"id": id, "action": action, "received": received, "detail": "real mouse at the control centre; never a signal emit"})
		return ""
	if action == "drag":
		var target := str(spec.get("to", ""))
		if target.is_empty():
			return "A ui drag needs a to id."
		var other := _find_control(target)
		if other == null:
			ui_results.append({"id": id, "action": action, "received": false, "detail": "no element %s on screen to drop on" % target})
			return ""
		await _push_drag(_control_centre(c), _control_centre(other), _frames_for_ms(300))
		ui_results.append({"id": id, "action": action, "received": true, "detail": "real mouse drag delivered; game acceptance unknown"})
		return ""
	return "Unknown ui action %s." % action

func _do_inspect(spec: Variant) -> Dictionary:
	if typeof(spec) != TYPE_DICTIONARY:
		return {"path": "", "values": {}, "error": "An inspect step needs an object."}
	var path := str(spec.get("path", ""))
	if path.is_empty():
		return {"path": path, "values": {}, "error": "An inspect step needs a path."}
	var node := root.get_node_or_null(NodePath(path))
	if node == null and not path.begins_with("/"):
		node = root.get_node_or_null(NodePath("/root/" + path))
	if node == null:
		return {"path": path, "values": {}, "error": "No node %s." % path}
	var wanted: Variant = spec.get("properties", null)
	var values := {}
	if wanted == null:
		for prop in (node as Node).get_property_list():
			if values.size() >= MAX_INSPECT_VALUES:
				break
			if (int(prop.get("usage", 0)) & PROPERTY_USAGE_SCRIPT_VARIABLE) == 0:
				continue
			var key := str(prop.get("name", ""))
			if key.is_empty() or key.length() > 64:
				continue
			values[key] = _encode_inspect_value((node as Node).get(key))
	else:
		if not (wanted is Array):
			return {"path": path, "values": {}, "error": "inspect properties must be a list."}
		for key in wanted:
			if values.size() >= MAX_INSPECT_VALUES:
				break
			var name := str(key)
			values[name] = _encode_inspect_value((node as Node).get(name))
	return {"path": path, "values": values}

func _encode_inspect_value(value: Variant) -> Variant:
	if value == null or value is bool or value is int:
		return value
	if value is float:
		return value if is_finite(float(value)) else null
	if value is String or value is StringName:
		return str(value).left(256)
	if value is Vector2:
		return [(value as Vector2).x, (value as Vector2).y]
	if value is Vector2i:
		return [float((value as Vector2i).x), float((value as Vector2i).y)]
	if value is Vector3:
		return [(value as Vector3).x, (value as Vector3).y, (value as Vector3).z]
	if value is Vector3i:
		return [float((value as Vector3i).x), float((value as Vector3i).y), float((value as Vector3i).z)]
	return null

func _take_screenshot(path: Variant) -> bool:
	if path == null or not (path is String) or (path as String).is_empty():
		return false
	if DisplayServer.get_name() == "headless":
		return false
	var tex = root.get_texture()
	if tex == null:
		return false
	var img := tex.get_image()
	if img == null or img.is_empty():
		return false
	return img.save_png(path as String) == OK

# --- real-time play (never blocks; the game keeps running) ---

func _pump() -> void:
	_peer.poll()
	var n := _peer.get_available_bytes()
	if n > 0:
		var res := _peer.get_data(n)
		if res[0] == OK:
			_read_buf.append_array(res[1])
	while _running:
		var s := _read_buf.get_string_from_utf8()
		var idx := s.find("\\n")
		if idx < 0:
			break
		var line := s.substr(0, idx)
		_read_buf = s.substr(idx + 1).to_utf8_buffer()
		await _handle(line)

func _tick_observation() -> Dictionary:
	_tick += 1
	_sweep_tick += 1
	var sweep: Variant = null
	if _sweep_tick >= 5:
		_sweep_tick = 0
		sweep = _do_sweep()
	var frames := Engine.get_physics_frames() - _start_physics
	return {
		"op": "tick",
		"tick": _tick,
		"t": float(frames) / float(_physics_hz),
		"physicsFrames": frames,
		"probe": _read_probe(TICK_TEXT_ENTRIES),
		"body": _read_body(),
		"visible": _read_visible(),
		"room": _read_room(),
		"errors": _drain_errors(TICK_ERRORS),
		"sweep": sweep,
		"perf": null if sweep == null else _read_perf(),
	}

func _apply_input(msg: Dictionary) -> void:
	var want: Dictionary = {}
	var held: Array = msg.get("held", [])
	for name in held:
		var code := _keycode_for(str(name))
		if code != KEY_NONE:
			want[code] = true
	for code in _held.keys():
		if not want.has(code):
			Input.parse_input_event(_make_key_event(code, false))
			_held.erase(code)
	for code in want.keys():
		if not _held.has(code):
			Input.parse_input_event(_make_key_event(code, true))
			_held[code] = true
	var taps: Array = msg.get("taps", [])
	for name in taps:
		var code := _keycode_for(str(name))
		if code == KEY_NONE:
			continue
		if not _held.has(code):
			Input.parse_input_event(_make_key_event(code, true))
		_tap_releases.append({"code": code, "frames": TAP_FRAMES})
	var clicks: Array = msg.get("clicks", [])
	for spec in clicks:
		if typeof(spec) != TYPE_DICTIONARY:
			continue
		if str(spec.get("id", "")) != "":
			var c := _find_control(str(spec.get("id", "")))
			if c != null:
				await _click_control(c)
		elif spec.get("x", null) != null:
			var pos := Vector2(float(spec.get("x", 0.0)), float(spec.get("y", 0.0)))
			_push_click(pos, int(MOUSE_BUTTON_LEFT))
			await physics_frame
			await physics_frame
			_push_release(pos, int(MOUSE_BUTTON_LEFT))

func _tick_taps() -> void:
	for i in range(_tap_releases.size() - 1, -1, -1):
		var entry: Dictionary = _tap_releases[i]
		entry["frames"] = int(entry["frames"]) - 1
		if int(entry["frames"]) <= 0:
			var code := int(entry["code"])
			if not _held.has(code):
				Input.parse_input_event(_make_key_event(code, false))
			_tap_releases.remove_at(i)

func _apply_set_state(msg: Dictionary) -> Dictionary:
	var id_val = msg.get("id", 0)
	var target := str(msg.get("target", ""))
	var values = msg.get("values", {})
	if typeof(values) != TYPE_DICTIONARY:
		return {"op": "reply", "id": id_val, "ok": false, "error": "setState values must be an object."}
	var applied: Array = []
	if target == "game_state":
		var state := _game_state()
		if state == null:
			return {"op": "reply", "id": id_val, "ok": false, "error": "No /root/GameState."}
		for key in (values as Dictionary).keys():
			var name := str(key)
			if name.is_empty() or name.length() > 64:
				continue
			var v = (values as Dictionary)[key]
			if v == null or v is bool or v is int or (v is float and is_finite(float(v))) or v is String:
				(state as Node).set(name, v)
				applied.append(name)
		return {"op": "reply", "id": id_val, "ok": true, "applied": applied}
	if target == "player":
		var p := _find_player()
		if p == null:
			return {"op": "reply", "id": id_val, "ok": false, "error": "No player body."}
		if (values as Dictionary).has("position"):
			var arr = (values as Dictionary)["position"]
			if arr is Array and (arr as Array).size() == 3:
				var pos := Vector3(float((arr as Array)[0]), float((arr as Array)[1]), float((arr as Array)[2]))
				if is_finite(pos.x) and is_finite(pos.y) and is_finite(pos.z):
					(p as Node3D).global_position = pos
					if p is CharacterBody3D:
						(p as CharacterBody3D).velocity = Vector3.ZERO
					applied.append("position")
		return {"op": "reply", "id": id_val, "ok": true, "applied": applied}
	return {"op": "reply", "id": id_val, "ok": false, "error": "Unknown setState target %s." % target}

# --- probe, body, visible, room, sweep (pure reads) ---

func _game_state() -> Node:
	return root.get_node_or_null("GameState")

func _runtime_game_state() -> Dictionary:
	var state := _game_state()
	var values := {}
	if state == null:
		return values
	for prop in state.get_property_list():
		if (int(prop.get("usage", 0)) & PROPERTY_USAGE_SCRIPT_VARIABLE) == 0:
			continue
		var key := str(prop.get("name", ""))
		if key.is_empty() or key.length() > 64 or values.size() >= 64:
			continue
		var value: Variant = state.get(key)
		if value == null or typeof(value) == TYPE_BOOL or typeof(value) == TYPE_INT:
			values[key] = value
		elif typeof(value) == TYPE_FLOAT and is_finite(float(value)):
			values[key] = value
		elif typeof(value) == TYPE_STRING and str(value).length() <= 256:
			values[key] = value
	return values

func _read_probe(text_entries: int) -> Dictionary:
	var player: Variant = null
	var players := get_nodes_in_group("player")
	if players.size() > 0:
		var body = players[0]
		if body is Node2D:
			var p2: Vector2 = (body as Node2D).global_position
			if is_finite(p2.x) and is_finite(p2.y):
				player = {"x": p2.x, "y": p2.y, "z": 0.0}
		elif body is Node3D:
			var p3: Vector3 = (body as Node3D).global_position
			if is_finite(p3.x) and is_finite(p3.y) and is_finite(p3.z):
				player = {"x": p3.x, "y": p3.y, "z": p3.z}
	var hud := ""
	var lines := _read_screen_text(text_entries)
	var count := 0
	for key in lines:
		hud += str(lines[key]) + "\\n"
		count += 1
		if hud.length() > 2000 or count >= text_entries:
			break
	return {"gameState": _runtime_game_state(), "player": player, "hudText": hud.strip_edges()}

# Player search adapted from ramenvr/autopilot lib/world.gd (Apache-2.0):
# camera-hung body, then the player group, then the first character body.
func _find_player() -> Node:
	var vp = root.get_viewport() if root is Window else null
	var cam3d: Camera3D = null
	if vp != null:
		cam3d = vp.get_camera_3d()
	if cam3d != null:
		var n: Node = cam3d
		while n != null:
			if n is PhysicsBody3D:
				return n
			n = n.get_parent()
	var cam2d: Camera2D = null
	if vp != null:
		cam2d = vp.get_camera_2d()
	if cam2d != null:
		var n2: Node = cam2d
		while n2 != null:
			if n2 is PhysicsBody2D:
				return n2
			n2 = n2.get_parent()
	for g in ["player", "Player", "players"]:
		for cand in get_nodes_in_group(g):
			if cand is Node2D or cand is Node3D:
				return cand
	var s := current_scene
	if s != null:
		var found3 := s.find_children("*", "CharacterBody3D", true, false)
		if found3.size() > 0:
			return found3[0]
		var found2 := s.find_children("*", "CharacterBody2D", true, false)
		if found2.size() > 0:
			return found2[0]
	return null

func _read_body() -> Dictionary:
	var p := _find_player()
	if p == null:
		return {"present": false}
	if p is CharacterBody3D:
		var b := p as CharacterBody3D
		return {"present": true, "dim": "3d",
			"onGround": b.is_on_floor(), "touching": b.get_slide_collision_count(),
			"vx": b.velocity.x, "vy": b.velocity.y, "vz": b.velocity.z}
	if p is CharacterBody2D:
		var b2 := p as CharacterBody2D
		return {"present": true, "dim": "2d",
			"onGround": b2.is_on_floor(), "touching": b2.get_slide_collision_count(),
			"vx": b2.velocity.x, "vy": b2.velocity.y}
	if p is Node3D:
		return {"present": true, "dim": "3d", "onGround": null, "touching": 0, "vx": 0.0, "vy": 0.0, "vz": 0.0}
	return {"present": true, "dim": "2d", "onGround": null, "touching": 0, "vx": 0.0, "vy": 0.0}

# Counts, not timings: frame and script times under the private software
# display measure this machine's load, while node counts are the game's own.
# Orphans (nodes out of the tree, never freed) are tracked in the debug build
# the runner plays.
func _read_perf() -> Dictionary:
	return {
		"nodes": int(Performance.get_monitor(Performance.OBJECT_NODE_COUNT)),
		"orphans": int(Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT)),
	}

func _read_visible() -> Array:
	var out: Array = []
	for c in _visible_controls():
		if out.size() >= TICK_UI_CONTROLS:
			break
		out.append({"kind": _kind_of(c as Control), "label": _text_of(c as Control).left(80)})
	var p := _find_player()
	if p is Node3D and current_scene != null:
		var at: Vector3 = (p as Node3D).global_position
		var vp = root.get_viewport() if root is Window else null
		var cam: Camera3D = null if vp == null else vp.get_camera_3d()
		var fwd := Vector3(0, 0, -1)
		if cam != null:
			fwd = -(cam as Node3D).global_basis.z
			fwd.y = 0.0
			if fwd.length() < 0.01:
				fwd = Vector3(0, 0, -1)
			fwd = fwd.normalized()
		var cands: Array = []
		var visited := 0
		var stack: Array = [(current_scene as Node).get_children()]
		while not stack.is_empty() and visited < 300:
			var kids: Array = stack.pop_back()
			for child in kids:
				visited += 1
				if visited > 300:
					break
				if not (child is Node3D):
					if child is Node:
						stack.append((child as Node).get_children())
					continue
				if child == p or (p as Node).is_ancestor_of(child):
					stack.append((child as Node).get_children())
					continue
				var pos: Vector3 = (child as Node3D).global_position
				if not (is_finite(pos.x) and is_finite(pos.y) and is_finite(pos.z)):
					continue
				var d := Vector2(pos.x - at.x, pos.z - at.z)
				var bearing := rad_to_deg(Vector2(fwd.x, fwd.z).angle_to(d))
				var frustum := true
				if cam != null:
					frustum = cam.is_position_in_frustum(pos)
				cands.append({"label": str((child as Node).name).left(40),
					"dist": snappedf(d.length(), 0.1), "bearing": snappedf(bearing, 1.0),
					"dy": snappedf(pos.y - at.y, 0.1), "inView": frustum})
				stack.append((child as Node).get_children())
		cands.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return float(a["dist"]) < float(b["dist"]))
		for entry in cands.slice(0, MAX_LANDMARKS):
			out.append(entry)
	return out

func _read_room() -> Variant:
	var p := _find_player()
	if not (p is CollisionObject3D):
		return null
	var at: Vector3 = (p as Node3D).global_position + Vector3(0, 0.5, 0)
	var space := root.world_3d.direct_space_state
	var out := {}
	for dir in [["forward", Vector3(0, 0, -1)], ["back", Vector3(0, 0, 1)], ["left", Vector3(-1, 0, 0)], ["right", Vector3(1, 0, 0)]]:
		var q := PhysicsRayQueryParameters3D.create(at, at + (dir[1] as Vector3) * ROOM_DIST)
		q.exclude = [(p as CollisionObject3D).get_rid()]
		q.collide_with_areas = false
		q.collide_with_bodies = true
		var hit := space.intersect_ray(q)
		if (hit as Dictionary).is_empty():
			out[dir[0]] = ROOM_DIST
		else:
			var hp: Vector3 = (hit as Dictionary)["position"]
			out[dir[0]] = snappedf(at.distance_to(hp), 0.1)
		# Drop sense: floor distance 1.2m ahead in this direction. No floor
		# within DROP_DIST means a drop (or a jump-scale gap) ahead.
		var ahead: Vector3 = at + (dir[1] as Vector3) * 1.2
		var dq := PhysicsRayQueryParameters3D.create(ahead, ahead + Vector3(0, -1, 0) * DROP_DIST)
		dq.exclude = [(p as CollisionObject3D).get_rid()]
		dq.collide_with_areas = false
		dq.collide_with_bodies = true
		var dhit := space.intersect_ray(dq)
		if (dhit as Dictionary).is_empty():
			out["drop_" + str(dir[0])] = DROP_DIST
		else:
			var dp: Vector3 = (dhit as Dictionary)["position"]
			out["drop_" + str(dir[0])] = snappedf(ahead.distance_to(dp), 0.1)
	return out

# No-clip probe: overlap the player's own shape against the physics space
# and report solid contacts, sampled every fifth tick so the loop stays cheap.
func _do_sweep() -> Dictionary:
	var p := _find_player()
	if p == null:
		return {"error": "no player body."}
	if p is CollisionObject3D:
		var body3 := p as CollisionObject3D
		for c in body3.get_children():
			if c is CollisionShape3D and (c as CollisionShape3D).shape != null and not (c as CollisionShape3D).disabled:
				var q3 := PhysicsShapeQueryParameters3D.new()
				q3.shape = (c as CollisionShape3D).shape
				q3.transform = (c as CollisionShape3D).global_transform
				q3.exclude = [body3.get_rid()]
				q3.collide_with_areas = false
				q3.collide_with_bodies = true
				var hits3: Array = root.world_3d.direct_space_state.intersect_shape(q3, 8)
				var names3: Array = []
				for h in hits3:
					var collider3: Variant = (h as Dictionary).get("collider", null)
					if collider3 is Node:
						names3.append(str((collider3 as Node).name))
				return {"dim": "3d", "overlaps": hits3.size(), "overlapNames": ",".join(names3.slice(0, 8))}
		return {"error": "no enabled shape under the 3D player."}
	if p is CollisionObject2D:
		var body2 := p as CollisionObject2D
		for c in body2.get_children():
			if c is CollisionShape2D and (c as CollisionShape2D).shape != null and not (c as CollisionShape2D).disabled:
				var q := PhysicsShapeQueryParameters2D.new()
				q.shape = (c as CollisionShape2D).shape
				q.transform = (c as CollisionShape2D).global_transform
				q.exclude = [body2.get_rid()]
				q.collide_with_areas = false
				q.collide_with_bodies = true
				var hits: Array = root.world_2d.direct_space_state.intersect_shape(q, 8)
				return {"dim": "2d", "overlaps": hits.size()}
		return {"error": "no enabled shape under the 2D player."}
	return {"error": "player is not a physics body."}

# --- ui ---

func _owner_name(n: Node) -> String:
	var x := n.get_parent()
	while x != null and x != root:
		if x is CanvasLayer or (x as Node).scene_file_path != "" or x == n.owner:
			return str((x as Node).name)
		x = x.get_parent()
	return "Screen"

func _on_screen(c: Control) -> bool:
	if not c.is_visible_in_tree():
		return false
	var a := 1.0
	var x: Node = c
	while x != null:
		if x is CanvasItem:
			a *= (x as CanvasItem).modulate.a
			if x == c:
				a *= (c as Control).self_modulate.a
		x = x.get_parent()
	if a <= 0.01:
		return false
	var vp := c.get_viewport()
	if vp == null:
		return false
	var t := c.get_global_transform_with_canvas()
	var rect := Rect2(t.origin, c.size * t.get_scale())
	return vp.get_visible_rect().intersects(rect, true) or c.size == Vector2.ZERO

func _visible_controls() -> Array:
	var out: Array = []
	var stack: Array = [root]
	while not stack.is_empty():
		var n: Node = stack.pop_back()
		if n == null or not is_instance_valid(n):
			continue
		if n is CanvasItem and not (n as CanvasItem).visible:
			continue
		if n is CanvasLayer and not (n as CanvasLayer).visible:
			continue
		var kids := n.get_children()
		kids.reverse()
		stack.append_array(kids)
		if n is Control and _on_screen(n as Control):
			out.append(n)
	return out

static func _text_of(c: Control) -> String:
	if c is Label:
		return (c as Label).text
	if c is RichTextLabel:
		return (c as RichTextLabel).get_parsed_text()
	if c is Button:
		return (c as Button).text
	if c is LineEdit:
		return (c as LineEdit).text
	if c is TextEdit:
		return (c as TextEdit).text
	return ""

static func _kind_of(c: Control) -> String:
	if c is OptionButton:
		return "combo"
	if c is CheckBox or c is CheckButton:
		return "checkbox"
	if c is BaseButton:
		return "checkbox" if (c as BaseButton).toggle_mode and not (c is MenuButton) else "button"
	if c is Slider or c is SpinBox:
		return "slider"
	if c is LineEdit or c is TextEdit:
		return "text_input"
	return ""

func _keyed(nodes: Array) -> Array:
	var counts := {}
	var out: Array = []
	for n in nodes:
		var base := _owner_name(n as Node) + "." + str((n as Node).name)
		counts[base] = int(counts.get(base, 0)) + 1
		var key := base if int(counts[base]) == 1 else "%s#%d" % [base, int(counts[base])]
		out.append([key, n])
	return out

func _control_centre(c: Control) -> Vector2:
	return c.get_global_transform_with_canvas() * (c.size * 0.5)

func _control_rect(c: Control) -> Dictionary:
	var t := c.get_global_transform_with_canvas()
	var origin := t.origin
	var sc := t.get_scale()
	return {"x": snappedf(origin.x, 1.0), "y": snappedf(origin.y, 1.0), "width": snappedf(c.size.x * sc.x, 1.0), "height": snappedf(c.size.y * sc.y, 1.0)}

func _read_screen_text(max_entries: int) -> Dictionary:
	var texts := {}
	var with_text: Array = []
	for c in _visible_controls():
		if _text_of(c as Control).strip_edges() != "":
			with_text.append(c)
	for kn in _keyed(with_text):
		var label := _text_of(kn[1] as Control).strip_edges()
		if label.length() > MAX_TEXT_CHARS:
			label = label.left(MAX_TEXT_CHARS)
		texts[kn[0]] = label
		if texts.size() >= max_entries:
			break
	return texts

func _list_ui() -> Array:
	var interactive: Array = []
	for c in _visible_controls():
		if _kind_of(c as Control) != "":
			interactive.append(c)
	var out: Array = []
	for kn in _keyed(interactive):
		if out.size() >= ACT_UI_CONTROLS:
			break
		var c: Control = kn[1]
		var label := _text_of(c)
		if label == "" and c is BaseButton:
			label = (c as BaseButton).tooltip_text
		var enabled := true
		if c is BaseButton:
			enabled = not (c as BaseButton).disabled
		elif c is LineEdit:
			enabled = (c as LineEdit).editable
		elif c is TextEdit:
			enabled = (c as TextEdit).editable
		out.append({"id": kn[0], "kind": _kind_of(c), "label": label.left(200), "enabled": enabled, "rect": _control_rect(c), "path": str(root.get_path_to(c))})
	return out

func _find_control(id: String) -> Control:
	if id.begins_with("/"):
		var n := root.get_node_or_null(NodePath(id))
		return n if n is Control else null
	for c in _visible_controls():
		for kn in _keyed([c]):
			if kn[0] == id:
				return c
	return null

func _push_click(pos: Vector2, button: int) -> void:
	_pointer = pos
	_pointer_init = true
	# Pushed motion feeds gui hit-testing, but the viewport's own mouse
	# position (what get_global_mouse_position reads) only follows a warp.
	root.warp_mouse(pos)
	var motion := InputEventMouseMotion.new()
	motion.position = pos
	motion.global_position = pos
	root.push_input(motion, true)
	var down := InputEventMouseButton.new()
	down.button_index = button
	down.pressed = true
	down.position = pos
	down.global_position = pos
	root.push_input(down, true)

func _push_release(pos: Vector2, button: int) -> void:
	var up := InputEventMouseButton.new()
	up.button_index = button
	up.pressed = false
	up.position = pos
	up.global_position = pos
	root.push_input(up, true)

func _click_control(c: Control) -> bool:
	var pos := _control_centre(c)
	if c is BaseButton:
		var state := {"pressed": false, "toggled": false}
		var on_pressed := func(): state.pressed = true
		var on_toggled := func(_on): state.toggled = true
		(c as BaseButton).pressed.connect(on_pressed)
		(c as BaseButton).toggled.connect(on_toggled)
		_push_click(pos, int(MOUSE_BUTTON_LEFT))
		await physics_frame
		await physics_frame
		_push_release(pos, int(MOUSE_BUTTON_LEFT))
		await physics_frame
		# A click that rebuilds its screen frees the control mid-click. That
		# means the click landed, so report received without touching the
		# freed control: touching it logs "Trying to cast a freed object",
		# which is runner noise, not a game finding.
		if not is_instance_valid(c):
			return true
		if (c as BaseButton).pressed.is_connected(on_pressed):
			(c as BaseButton).pressed.disconnect(on_pressed)
		if (c as BaseButton).toggled.is_connected(on_toggled):
			(c as BaseButton).toggled.disconnect(on_toggled)
		return bool(state.pressed) or bool(state.toggled)
	_push_click(pos, int(MOUSE_BUTTON_LEFT))
	await physics_frame
	await physics_frame
	_push_release(pos, int(MOUSE_BUTTON_LEFT))
	await physics_frame
	return true

# --- keys, errors, transport ---

# One key event with both fields set: a physical-only event never reaches
# Input.is_key_pressed, and a keycode-only event never reaches the physical
# poll, so a tap needs both to land.
func _make_key_event(code: int, pressed: bool) -> InputEventKey:
	var ev := InputEventKey.new()
	ev.physical_keycode = code
	ev.keycode = code
	ev.pressed = pressed
	ev.echo = false
	return ev

func _keycode_for(name: String) -> int:
	match name:
		"Space":
			return KEY_SPACE
		"Enter":
			return KEY_ENTER
		"Tab":
			return KEY_TAB
		"Backspace":
			return KEY_BACKSPACE
		"Escape":
			return KEY_ESCAPE
		"Shift":
			return KEY_SHIFT
		"Control":
			return KEY_CTRL
		"Alt":
			return KEY_ALT
		"ArrowUp":
			return KEY_UP
		"ArrowDown":
			return KEY_DOWN
		"ArrowLeft":
			return KEY_LEFT
		"ArrowRight":
			return KEY_RIGHT
		"Home":
			return KEY_HOME
		"End":
			return KEY_END
		"PageUp":
			return KEY_PAGEUP
		"PageDown":
			return KEY_PAGEDOWN
		"Insert":
			return KEY_INSERT
		"Delete":
			return KEY_DELETE
	if name.length() == 1:
		var code := OS.find_keycode_from_string(name.to_upper())
		if code != KEY_NONE:
			return code
	if name.length() > 1 and name[0] == "F" and name.substr(1).is_valid_int():
		var n := int(name.substr(1))
		if n >= 1 and n <= 12:
			return KEY_F1 + n - 1
	return OS.find_keycode_from_string(name)

func _drain_errors(max_errors: int) -> Array:
	var out: Array = []
	for e in _errors.drain():
		if out.size() >= max_errors:
			break
		out.append({"message": str(e.get("message", "")).left(500), "where": str(e.get("where", ""))})
	return out

func _read_json(path: String) -> Variant:
	var text := FileAccess.get_file_as_string(path)
	if text.is_empty():
		return null
	return JSON.parse_string(text)

func _send(msg: Dictionary) -> void:
	if _peer.get_status() != 2:
		return
	_peer.poll()
	_peer.put_data((JSON.stringify(msg) + "\\n").to_utf8_buffer())

# Between acts the tree is held; a game that unpauses itself meanwhile (a
# countdown timer that runs while paused) gets that state back at the next
# act, and game time stays frozen until then.
func _read_line() -> String:
	for i in 20000:
		if _peer.get_status() != 2:
			return ""
		_peer.poll()
		var n := _peer.get_available_bytes()
		if n > 0:
			var chunk := _peer.get_data(n)
			if chunk[0] != OK:
				return ""
			_read_buf.append_array(chunk[1])
		var s := _read_buf.get_string_from_utf8()
		var idx := s.find("\\n")
		if idx >= 0:
			var line := s.substr(0, idx)
			_read_buf = s.substr(idx + 1).to_utf8_buffer()
			return line
		if not paused:
			_game_paused = false
			paused = true
		await process_frame
	return ""
`;
