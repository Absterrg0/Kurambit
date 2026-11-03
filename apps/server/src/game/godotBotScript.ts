/**
 * The real-time bot runner Godot executes for `game_bot_run`. It is a
 * string, not an asset, so the packed server archive carries it without a
 * second asset-copy rule. GameBot writes it under the game's ignored
 * `builds/logs/` tree and passes a request path after `--`, the same pattern
 * as the explore runner.
 *
 * Unlike the explore runner, the game tree is NEVER paused: game time runs
 * continuously at normal speed while the service streams input at 10 Hz and
 * reads back one observation per tick. Input lands as real key events through
 * `Input.parse_input_event` (so `_input`/`_unhandled_input` handlers and the
 * runtime-registered InputMap actions both see it) and real mouse clicks at
 * listed controls, never signal emits or state writes — except the explicit
 * `setState` op, which exists so a bot can reach a late moment fast and is
 * always reported by the service.
 *
 * View shape (what's visible with distance and bearing; the body: on ground,
 * touching, velocity; how far the player can move each way via raycasts) and
 * the error-log drain are adapted from ramenvr/autopilot lib/ui.gd,
 * lib/world.gd and lib/detectors.gd (Apache-2.0); the code below is our own.
 */
import { GODOT_SHARED_PROBE } from "./godotSharedProbe.ts";

export const GODOT_BOT_SCRIPT = `extends SceneTree

${GODOT_SHARED_PROBE}

const TICK_MS := 100
const BOOT_FRAMES := 30
const MAX_TEXT_ENTRIES := 64
const MAX_TEXT_CHARS := 200
const MAX_UI_CONTROLS := 32
const MAX_ERRORS_PER_TICK := 10
const MAX_LANDMARKS := 16
const ROOM_DIST := 6.0
const DROP_DIST := 4.0
const TAP_FRAMES := 10

# Error capture adapted from ramenvr/autopilot lib/detectors.gd (Apache-2.0):
# a Logger registered with OS.add_logger, drained once per tick. Only the
# ErrorLog shape is borrowed; the surrounding runner is our own.
class BotErrorLog extends Logger:
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
var _errors := BotErrorLog.new()
var _running := false
var _physics_hz := 60
var _boot_physics := 0
var _tick := 0
var _held: Dictionary = {}
var _tap_releases: Array = []
var _pointer := Vector2.ZERO
var _pointer_init := false
var _dead_pump := 0
var _sweep_tick := 0

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() < 1:
		printerr("bot runner needs a request path")
		quit(2)
		return
	var request = _read_json(str(args[0]))
	if typeof(request) != TYPE_DICTIONARY:
		printerr("bot runner request is not a JSON object")
		quit(2)
		return
	_port = int(request.get("port", 0))
	_token = str(request.get("token", ""))
	_expected_user_prefix = str(request.get("expectedUserDataPrefix", ""))
	if _port <= 0 or _token.is_empty():
		printerr("bot runner request needs a port and a token")
		quit(2)
		return
	_physics_hz = maxi(1, int(ProjectSettings.get_setting("physics/common/physics_ticks_per_second", 60)))
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
	_peer.connect_to_host("127.0.0.1", _port)
	for i in 3600:
		_peer.poll()
		if _peer.get_status() == 2:
			break
		if _peer.get_status() == 3:
			_send({"error": "Could not connect to the bot server."})
			return
		await process_frame
	if _peer.get_status() != 2:
		return
	# The game stays unpaused for the whole run: this is real play at
	# normal speed, not the explore runner's paused acts. The loop yields on
	# physics frames (not process frames) so ticks stay at 10 Hz even when
	# software rendering is slower than that; game speed is unaffected.
	paused = false
	_boot_physics = Engine.get_physics_frames()
	_send(_boot_observation())
	_running = true
	var tick_every := maxi(1, roundi(float(_physics_hz) / 10.0))
	var since_tick := 0
	while _running:
		await physics_frame
		if _peer.get_status() != 2:
			_dead_pump += 1
			if _dead_pump > 300:
				return
			continue
		_dead_pump = 0
		_pump_commands()
		_tick_taps()
		since_tick += 1
		if since_tick >= tick_every:
			since_tick = 0
			_send(_tick_observation())

func _game_time() -> float:
	return float(Engine.get_physics_frames() - _boot_physics) / float(_physics_hz)

func _boot_observation() -> Dictionary:
	return {
		"token": _token,
		"boot": true,
		"physicsHz": _physics_hz,
		"probe": _read_probe(),
		"body": _read_body(),
		"errors": _drain_errors(),
		"perf": _read_perf(),
	}

# Counts, not timings: frame and script times under the private software
# display measure this machine's load, while node counts are the game's own.
# Orphans (nodes out of the tree, never freed) are tracked in the debug build
# the bot runs.
func _read_perf() -> Dictionary:
	return {
		"nodes": int(Performance.get_monitor(Performance.OBJECT_NODE_COUNT)),
		"orphans": int(Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT)),
	}

func _tick_observation() -> Dictionary:
	_tick += 1
	_sweep_tick += 1
	var sweep: Variant = null
	if _sweep_tick >= 5:
		_sweep_tick = 0
		sweep = _do_sweep_values()
	return {
		"token": _token,
		"tick": _tick,
		"t": _game_time(),
		"physicsFrames": Engine.get_physics_frames() - _boot_physics,
		"probe": _read_probe(),
		"body": _read_body(),
		"visible": _read_visible(),
		"room": _read_room(),
		"errors": _drain_errors(),
		"sweep": sweep,
		"perf": null if sweep == null else _read_perf(),
	}

# --- commands (never block; the game keeps running) ---

func _pump_commands() -> void:
	_peer.poll()
	var n := _peer.get_available_bytes()
	if n > 0:
		var res := _peer.get_data(n)
		if res[0] == OK:
			_read_buf.append_array(res[1])
	while true:
		var s := _read_buf.get_string_from_utf8()
		var idx := s.find("\\n")
		if idx < 0:
			break
		var line := s.substr(0, idx)
		_read_buf = s.substr(idx + 1).to_utf8_buffer()
		await _handle_command(line)

func _handle_command(line: String) -> void:
	if line.strip_edges().is_empty():
		return
	var msg = JSON.parse_string(line)
	if typeof(msg) != TYPE_DICTIONARY:
		return
	var op := str(msg.get("op", ""))
	if op == "quit":
		_send({"id": msg.get("id", 0), "ok": true})
		_running = false
		return
	if op == "input":
		_apply_input(msg)
		return
	if op == "setState":
		_send(_apply_set_state(msg))
		return

func _apply_input(msg: Dictionary) -> void:
	var want: Dictionary = {}
	var held: Array = msg.get("held", [])
	for name in held:
		var code := _keycode_for(str(name))
		if code != KEY_NONE:
			want[code] = true
	for code in _held.keys():
		if not want.has(code):
			Input.parse_input_event(_make_key_event(code, code, false))
			_held.erase(code)
	for code in want.keys():
		if not _held.has(code):
			Input.parse_input_event(_make_key_event(code, code, true))
			_held[code] = true
	var taps: Array = msg.get("taps", [])
	for name in taps:
		var code := _keycode_for(str(name))
		if code == KEY_NONE:
			continue
		if not _held.has(code):
			Input.parse_input_event(_make_key_event(code, code, true))
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
				Input.parse_input_event(_make_key_event(code, code, false))
			_tap_releases.remove_at(i)

func _apply_set_state(msg: Dictionary) -> Dictionary:
	var id_val = msg.get("id", 0)
	var target := str(msg.get("target", ""))
	var values = msg.get("values", {})
	if typeof(values) != TYPE_DICTIONARY:
		return {"id": id_val, "ok": false, "error": "setState values must be an object."}
	var applied: Array = []
	if target == "game_state":
		var state := root.get_node_or_null("GameState")
		if state == null:
			return {"id": id_val, "ok": false, "error": "No /root/GameState."}
		for key in (values as Dictionary).keys():
			var name := str(key)
			if name.is_empty() or name.length() > 64:
				continue
			var v = (values as Dictionary)[key]
			if v == null or v is bool or v is int or (v is float and is_finite(float(v))) or v is String:
				(state as Node).set(name, v)
				applied.append(name)
		return {"id": id_val, "ok": true, "applied": applied}
	if target == "player":
		var p := _find_player()
		if p == null:
			return {"id": id_val, "ok": false, "error": "No player body."}
		if (values as Dictionary).has("position"):
			var arr = (values as Dictionary)["position"]
			if arr is Array and (arr as Array).size() == 3:
				var pos := Vector3(float((arr as Array)[0]), float((arr as Array)[1]), float((arr as Array)[2]))
				if is_finite(pos.x) and is_finite(pos.y) and is_finite(pos.z):
					(p as Node3D).global_position = pos
					if p is CharacterBody3D:
						(p as CharacterBody3D).velocity = Vector3.ZERO
					applied.append("position")
		return {"id": id_val, "ok": true, "applied": applied}
	return {"id": id_val, "ok": false, "error": "Unknown setState target %s." % target}

# --- probe, body, visible, room ---

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
		if arr.size() == 2 and is_finite(float(arr[0])) and is_finite(float(arr[1])):
			player = {"x": arr[0], "y": arr[1], "z": 0.0}
		elif arr.size() == 3 and is_finite(float(arr[0])) and is_finite(float(arr[1])) and is_finite(float(arr[2])):
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

# Player search adapted from ramenvr/autopilot lib/world.gd (Apache-2.0):
# camera-hung body, then the player group, then the first character body.
# Only the search order is borrowed; the query below is our own.
func _find_player() -> Node:
	var cam3d: Camera3D = null
	var vp = root.get_viewport() if root is Window else null
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
		var at: Vector3 = (p as Node3D).global_position
		return {"present": true, "dim": "3d", "onGround": null, "touching": 0,
			"vx": 0.0, "vy": 0.0, "vz": 0.0, "x": at.x, "y": at.y, "z": at.z}
	return {"present": true, "dim": "2d", "onGround": null, "touching": 0, "vx": 0.0, "vy": 0.0}

func _active_camera() -> Camera3D:
	var vp = root.get_viewport() if root is Window else null
	if vp == null:
		return null
	return vp.get_camera_3d()

func _read_visible() -> Array:
	var out: Array = []
	for c in _visible_controls():
		if out.size() >= MAX_UI_CONTROLS:
			break
		out.append({"kind": _kind_of(c as Control), "label": _text_of(c as Control).left(80)})
	var p := _find_player()
	if p is Node3D and current_scene != null:
		var at: Vector3 = (p as Node3D).global_position
		var cam := _active_camera()
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
				var dist := d.length()
				var bearing := rad_to_deg(Vector2(fwd.x, fwd.z).angle_to(d))
				var frustum := true
				if cam != null and cam.has_method("is_position_in_frustum"):
					frustum = (cam as Camera3D).is_position_in_frustum(pos)
				cands.append({"label": str((child as Node).name).left(40),
					"dist": snappedf(dist, 0.1), "bearing": snappedf(bearing, 1.0),
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
# and report solid contacts. Same approach as the explore runner's sweep
# check, sampled every fifth tick so the 10 Hz loop stays cheap.
func _do_sweep_values() -> Dictionary:
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

# --- ui and inspect (adapted from ramenvr/autopilot lib/ui.gd, Apache-2.0:
# owner-qualified ids, real mouse input, never a signal emit) ---

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

func _drain_errors() -> Array:
	var out: Array = []
	for e in _errors.drain():
		if out.size() >= MAX_ERRORS_PER_TICK:
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
`;
