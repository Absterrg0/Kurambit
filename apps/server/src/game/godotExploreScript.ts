/**
 * The native exploration runner Godot executes for `game_explore_*` with
 * `target: "native"`. It is a string, not an asset, so the packed server
 * archive carries it without a second asset-copy rule. GameService writes it
 * under the game's ignored `builds/logs/` tree and passes a request path
 * after `--`, the same pattern as the scenario runner.
 *
 * The runner starts the real main scene from current sources (no export),
 * connects out to 127.0.0.1 over TCP with a per-session token, and exchanges
 * one JSON object per line. The game tree stays paused between acts, so no
 * game time passes while the agent thinks; the runner itself keeps polling
 * TCP while paused (SceneTree signals still fire when paused, verified on
 * Godot 4.7). An act resumes the pause the game itself last set, so a game
 * left on its pause or end screen stays frozen through the next act.
 *
 * Input lands before game nodes read it by frame order: every event is
 * injected synchronously and the next physics frame is awaited before the
 * release, so the game polls the already-queued event. A key tap stays down
 * for at least 10 physics frames (~167 ms at 60 Hz): T16 showed shorter
 * presses land between physics frames and are missed despite input latches.
 * Mouse goes through the real viewport
 * (`push_input` at the control's centre); the runner never emits a signal
 * directly, so an overlay blocking a click stays visible and the reply says
 * the control did not receive it.
 *
 * UI listing and visible-text keys follow the owner-qualified `<Owner>.<Name>`
 * scheme adapted from ramenvr/autopilot lib/ui.gd (Apache-2.0): owner root or
 * nearest scene instance, deduped with #2/#3. Only the id scheme and the
 * real-mouse (no signal emit) approach are borrowed; the code below is our own.
 */
import { GODOT_SHARED_PROBE } from "./godotSharedProbe.ts";

export const GODOT_EXPLORE_SCRIPT = `extends SceneTree

${GODOT_SHARED_PROBE}

const BOOT_FRAMES := 30
const MAX_TEXT_ENTRIES := 128
const MAX_TEXT_CHARS := 200
const MAX_UI_CONTROLS := 64
const MAX_ERRORS_PER_ACT := 20
const MAX_INSPECT_VALUES := 64

# Error capture adapted from ramenvr/autopilot lib/detectors.gd (Apache-2.0):
# a Logger registered with OS.add_logger, drained once per act. Only the
# ErrorLog shape (mutex-guarded lines with file:line from the first backtrace
# frame) is borrowed; the surrounding runner is our own.
class ExploreErrorLog extends Logger:
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

var _request := {}
var _port := 0
var _token := ""
var _boot_screenshot_path: Variant = null
var _expected_user_prefix := ""
var _peer := StreamPeerTCP.new()
var _read_buf := PackedByteArray()
var _errors := ExploreErrorLog.new()
var _pointer := Vector2.ZERO
var _pointer_init := false
var _physics_hz := 60
var _game_paused := false

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() < 1:
		printerr("explore runner needs a request path")
		quit(2)
		return
	_request = _read_json(str(args[0]))
	if typeof(_request) != TYPE_DICTIONARY:
		printerr("explore runner request is not a JSON object")
		quit(2)
		return
	_port = int(_request.get("port", 0))
	_token = str(_request.get("token", ""))
	_boot_screenshot_path = _request.get("bootScreenshotPath", null)
	if _boot_screenshot_path != null and not (_boot_screenshot_path is String):
		_boot_screenshot_path = null
	_expected_user_prefix = str(_request.get("expectedUserDataPrefix", ""))
	if _port <= 0 or _token.is_empty():
		printerr("explore runner request needs a port and a token")
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
			_send({"error": "The engine user data dir is outside the isolated per-run directory."})
			return
	var main_path := str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if main_path.is_empty():
		_send({"error": "project.godot has no application/run/main_scene."})
		return
	var packed := load(main_path) as PackedScene
	if packed == null:
		_send({"error": "The main scene does not load: %s" % main_path})
		return
	var scene := packed.instantiate()
	if scene == null:
		_send({"error": "The main scene does not instantiate: %s" % main_path})
		return
	root.add_child(scene)
	current_scene = scene
	for i in BOOT_FRAMES:
		await physics_frame
	await process_frame
	await process_frame
	# Connect out to the server that launched us; the token authenticates us.
	_peer.connect_to_host("127.0.0.1", _port)
	for i in 3600:
		_peer.poll()
		if _peer.get_status() == 2:
			break
		if _peer.get_status() == 3:
			_send({"error": "Could not connect to the explore server."})
			return
		await process_frame
	if _peer.get_status() != 2:
		return
	_hold()
	_send(_boot_observation())
	while true:
		var line := await _read_line()
		if line.is_empty():
			return
		var msg = JSON.parse_string(line)
		if typeof(msg) != TYPE_DICTIONARY:
			continue
		if str(msg.get("op", "")) == "quit":
			_send({"id": msg.get("id", 0), "ok": true})
			return
		if str(msg.get("op", "")) == "act":
			_send(await _run_act(msg))
			continue

func _boot_observation() -> Dictionary:
	var shot := _take_screenshot(_boot_screenshot_path)
	return {
		"token": _token,
		"boot": true,
		"probe": _read_probe(),
		"screenText": _read_screen_text(),
		"ui": _list_ui(),
		"errors": _drain_errors(),
		"screenshot": shot.get("saved", false),
		"screenshotWidth": shot.get("width", 0),
		"screenshotHeight": shot.get("height", 0),
		"bootMs": null,
		"pauseConfirmed": true,
	}

func _run_act(msg: Dictionary) -> Dictionary:
	var id_val = msg.get("id", 0)
	var steps: Array = msg.get("steps", [])
	var shot_path: Variant = msg.get("screenshotPath", null)
	if shot_path != null and not (shot_path is String):
		shot_path = null
	paused = _game_paused
	var executed := 0
	var nominal := 0
	var ui_results: Array = []
	var inspections: Array = []
	for step in steps:
		if typeof(step) != TYPE_DICTIONARY:
			_hold()
			return {"id": id_val, "ok": false, "error": "A step is not an object."}
		var err := await _run_step(step, ui_results, inspections)
		if not err.is_empty():
			_hold()
			return {"id": id_val, "ok": false, "error": err}
		if _is_input_step(step):
			executed += 1
		nominal += _step_nominal_ms(step)
	_release_all_inputs()
	await process_frame
	await process_frame
	var shot := _take_screenshot(shot_path)
	var obs := {
		"id": id_val,
		"ok": true,
		"probe": _read_probe(),
		"screenText": _read_screen_text(),
		"ui": _list_ui(),
		"errors": _drain_errors(),
		"inspections": inspections,
		"uiResults": ui_results,
		"executedInputSteps": executed,
		"nominalMs": nominal,
		"screenshot": shot.get("saved", false),
		"screenshotWidth": shot.get("width", 0),
		"screenshotHeight": shot.get("height", 0),
	}
	_hold()
	return obs

# Freezes game time between acts, remembering whether the game had paused
# itself so the next act resumes that state rather than unpausing it.
func _hold() -> void:
	_game_paused = paused
	paused = true

func _is_input_step(step: Dictionary) -> bool:
	if step.has("waitMs") or step.has("screenshot") or step.has("inspect"):
		return false
	return true

func _step_nominal_ms(step: Dictionary) -> int:
	if step.has("press"):
		return 170
	if step.has("actionHold") and step["actionHold"] is Dictionary:
		return maxi(50, int((step["actionHold"] as Dictionary).get("holdMs", 300)))
	if step.has("waitMs"):
		return maxi(0, int(step["waitMs"]))
	if step.has("holdMs"):
		return maxi(0, int(step["holdMs"]))
	if step.has("ui"):
		return 100
	return 0

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
		_release_all_inputs()
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
	if step.has("sweepCheck"):
		inspections.append(_do_sweep_check())
		return ""
	if step.has("actionHold"):
		return await _do_action_hold(step["actionHold"])
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
	# T16: a 2-frame tap lands between physics frames and is dropped by most
	# games. Hold ~167 ms so the press spans several polls before release.
	var down := _make_key_event(code, code, true)
	Input.parse_input_event(down)
	for i in 10:
		await physics_frame
	var up := _make_key_event(code, code, false)
	Input.parse_input_event(up)
	await physics_frame
	await physics_frame
	return ""

func _do_key_hold(names: Array, hold_ms: int) -> String:
	var codes: Array = []
	for name in names:
		var code := _keycode_for(str(name))
		if code == KEY_NONE:
			_release_all_inputs()
			return "Unknown key %s." % str(name)
		codes.append(code)
	for code in codes:
		Input.parse_input_event(_make_key_event(code, code, true))
	for i in _frames_for_ms(hold_ms):
		await physics_frame
	for code in codes:
		Input.parse_input_event(_make_key_event(code, code, false))
	await physics_frame
	return ""

func _release_all_inputs() -> void:
	# Physical keys and mouse buttons are always released inside their own
	# step, so nothing is held across steps. The ui_* releases below only
	# clear a stuck map action if a game pressed one itself mid-act.
	Input.action_release("ui_accept")
	Input.action_release("ui_select")
	Input.action_release("ui_cancel")
	Input.action_release("ui_left")
	Input.action_release("ui_right")
	Input.action_release("ui_up")
	Input.action_release("ui_down")

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
	var code2 := OS.find_keycode_from_string(name)
	if code2 != KEY_NONE:
		return code2
	return KEY_NONE

# --- ui and inspect ---

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

func _read_screen_text() -> Dictionary:
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
		if texts.size() >= MAX_TEXT_ENTRIES:
			break
	return texts

func _list_ui() -> Array:
	var interactive: Array = []
	for c in _visible_controls():
		if _kind_of(c as Control) != "":
			interactive.append(c)
	var out: Array = []
	for kn in _keyed(interactive):
		if out.size() >= MAX_UI_CONTROLS:
			break
		var c: Control = kn[1]
		var kind := _kind_of(c)
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
		out.append({"id": kn[0], "kind": kind, "label": label.left(200), "enabled": enabled, "rect": _control_rect(c), "path": str(root.get_path_to(c))})
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
	if not is_instance_valid(c):
		return true
	if c is LineEdit or c is TextEdit:
		var vp := c.get_viewport()
		if vp != null and vp.gui_get_focus_owner() == c:
			return true
		return true
	return true

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

# Player search adapted from ramenvr/autopilot lib/world.gd (Apache-2.0):
# camera-hung body, then the player group, then the first character body.
# Only the search order is borrowed; the query below is our own.
func _find_sweep_player() -> Node:
	var cam3d: Camera3D = null
	var vp := root.get_viewport() if root is Window else null
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

# No-clip probe for the code-only bug sweep: overlap the player's own shape
# against the physics space and report solid contacts. Runs in the runner, so
# the game's project is untouched.
func _do_sweep_check() -> Dictionary:
	var p := _find_sweep_player()
	if p == null:
		return {"path": "", "values": {}, "error": "sweepCheck: no player body."}
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
				var names: Array = []
				for h in hits:
					var collider: Variant = (h as Dictionary).get("collider", null)
					if collider is Node:
						names.append(str((collider as Node).name))
				var pos2: Vector2 = (p as Node2D).global_position
				return {"path": str(body2.get_path()), "values": {
					"dim": "2d", "x": pos2.x, "y": pos2.y,
					"overlaps": hits.size(), "overlapNames": ",".join(names.slice(0, 8)),
					"onFloor": (body2 as CharacterBody2D).is_on_floor() if body2 is CharacterBody2D else null,
					"vx": (body2 as CharacterBody2D).velocity.x if body2 is CharacterBody2D else null,
					"vy": (body2 as CharacterBody2D).velocity.y if body2 is CharacterBody2D else null}}
		return {"path": str(body2.get_path()), "values": {}, "error": "sweepCheck: no enabled shape under the 2D player."}
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
				var pos3: Vector3 = (p as Node3D).global_position
				return {"path": str(body3.get_path()), "values": {
					"dim": "3d", "x": pos3.x, "y": pos3.y, "z": pos3.z,
					"overlaps": hits3.size(), "overlapNames": ",".join(names3.slice(0, 8)),
					"onFloor": (body3 as CharacterBody3D).is_on_floor() if body3 is CharacterBody3D else null,
					"vx": (body3 as CharacterBody3D).velocity.x if body3 is CharacterBody3D else null,
					"vy": (body3 as CharacterBody3D).velocity.y if body3 is CharacterBody3D else null,
					"vz": (body3 as CharacterBody3D).velocity.z if body3 is CharacterBody3D else null}}
		return {"path": str(body3.get_path()), "values": {}, "error": "sweepCheck: no enabled shape under the 3D player."}
	return {"path": str((p as Node).get_path()), "values": {}, "error": "sweepCheck: player is not a physics body."}

# Sweep-only driver: press an InputMap action directly so the code-only sweep
# can hold and tap every action even when its key binding is unknown.
func _do_action_hold(spec: Variant) -> String:
	if typeof(spec) != TYPE_DICTIONARY:
		return "An actionHold step needs an object."
	var action_name := str(spec.get("action", ""))
	if action_name.is_empty() or not InputMap.has_action(action_name):
		return "Unknown action %s." % action_name
	Input.action_press(action_name)
	for i in _frames_for_ms(maxi(50, int(spec.get("holdMs", 300)))):
		await physics_frame
	Input.action_release(action_name)
	await physics_frame
	return ""

# --- probe, errors, screenshot, transport ---

func _read_probe() -> Dictionary:
	var runtime := _runtime_game_state()
	var values: Dictionary = runtime.get("values", {})
	var player_pos: Variant = null
	var players := get_nodes_in_group("player")
	if players.size() > 0:
		player_pos = _encode_pos(_player_position(players[0]))
	var player: Variant = null
	if player_pos is Array:
		var arr: Array = player_pos
		if arr.size() == 2:
			player = {"x": arr[0], "y": arr[1], "z": 0.0}
		elif arr.size() == 3:
			player = {"x": arr[0], "y": arr[1], "z": arr[2]}
	var hud := ""
	var lines := _read_screen_text()
	var count := 0
	for key in lines:
		hud += str(lines[key]) + "\\n"
		count += 1
		if hud.length() > 2000 or count >= MAX_TEXT_ENTRIES:
			break
	return {"gameState": values, "player": player, "hudText": hud.strip_edges()}

func _drain_errors() -> Array:
	var out: Array = []
	for e in _errors.drain():
		if out.size() >= MAX_ERRORS_PER_ACT:
			break
		out.append({"message": str(e.get("message", "")).left(500), "where": str(e.get("where", ""))})
	return out

func _take_screenshot(path: Variant) -> Dictionary:
	if path == null or not (path is String) or (path as String).is_empty():
		return {"saved": false, "width": 0, "height": 0}
	if DisplayServer.get_name() == "headless":
		return {"saved": false, "width": 0, "height": 0}
	var tex = root.get_texture()
	if tex == null:
		return {"saved": false, "width": 0, "height": 0}
	var img := tex.get_image()
	if img == null or img.is_empty():
		return {"saved": false, "width": 0, "height": 0}
	var err := img.save_png(path as String)
	if err != OK:
		return {"saved": false, "width": 0, "height": 0}
	return {"saved": true, "width": img.get_width(), "height": img.get_height()}

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
		# Between acts the tree is held; a game that unpauses itself meanwhile
		# (a countdown timer that runs while paused) gets that state back at the
		# next act, and game time stays frozen until then.
		if not paused:
			_game_paused = false
			paused = true
		await process_frame
	return ""
`;
