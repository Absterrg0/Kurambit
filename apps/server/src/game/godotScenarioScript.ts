/**
 * The route runner Godot executes headlessly for `game_scenarios_run`. It is a
 * string, not an asset, so the packed server archive carries it without a second
 * asset-copy rule. GameService writes it under the game's ignored
 * `builds/logs/` tree and passes a request path after `--`.
 *
 * The runner is intentionally dumb: it starts the real main scene, injects input
 * every physics frame and samples GameState plus the "player" group. It never
 * calls a game function or writes a game property, so a passing route proves the
 * game is playable with the same input a person uses. When the request asks
 * for it, the runner also takes a small bounded set of layout probes near
 * input step boundaries with the shared geometry scanner: findings are
 * diagnostic hints for Web-frame inspection, never quality verdicts.
 */
import { GODOT_LAYOUT_SCANNER } from "./godotLayoutScanner.ts";
import { GODOT_SHARED_PROBE } from "./godotSharedProbe.ts";

export const GODOT_SCENARIO_SCRIPT = `extends SceneTree

${GODOT_LAYOUT_SCANNER}

${GODOT_SHARED_PROBE}

const LIMITS := {"steps": 2000, "frames": 36000}
const MAX_ACTIONS_PER_STEP := 8
# Bounded runtime layout probes: one boot probe plus at most three
# step-boundary probes per scenario, so even the longest routes cannot
# multiply the pairwise geometry comparisons without bound.
const LAYOUT_MAX_STEP_PROBES := 3
# Bounded runtime spatial snapshots: boot plus at most three step boundaries
# at the same schedule. One traversal per probe, capped so the longest routes
# stay bounded. All world-geometry reads are synchronous transforms.
const SPATIAL_MAX_NODES := 600
const SPATIAL_MAX_AREAS := 16
const SPATIAL_MAX_SHAPES := 32
const SPATIAL_MAX_SNAPSHOTS := 4

var _result_path := ""
var _request := {}
var _scenario := {}
var _observations: Array = []
var _sample_every := 6
var _boot_frames := 30
var _record_timeline := false
var _record_runtime_state := false
# Bounded runtime layout inspection, off unless the request asks: probes run
# near input step boundaries and gameplay baselines, never just the menu, with
# no injected input, no route steps and no source mutation. Probes must not
# await extra frames: even idle-frame waits can advance game physics.
var _record_layout := false
var _layout_state := {"warnings": 0, "pairs": 0, "inspected": 0}
var _layout_findings: Array = []
var _layout_probes := 0
var _layout_omitted := 0
var _layout_step := -1
var _layout_probe_steps: Array = []
# Bounded runtime spatial snapshots, off unless the request asks: world-space
# player origin/velocity plus Area collision-shape bounds at the same probe
# schedule. Synchronous transform reads only, no ticks, no input, no writes.
var _record_spatial := false
var _spatial_snapshots: Array = []
var _spatial_visited := 0
var _spatial_areas := 0
var _spatial_shapes := 0
var _spatial_skipped_freed := 0
var _spatial_truncated := false
var _spatial_omitted := 0
var _spatial_probe_steps: Array = []
var _initial_game_state: Variant = null
var _seed_has := false
var _seed_value := 0
var _expected_user_prefix := ""
var _initial_user_data_dir := ""
var _frame := 0
var _timeline: Array = []
var _held := {}
var _stats := {}
var _first_input_frame := -1
var _baseline_frame := -1
var _baseline_values := {}
var _player: Variant = null
var _player_first: Variant = null
var _player_baseline: Variant = null
var _player_last: Variant = null
var _player_moved := false
var _player_seen := false
var _invalid_actions: Array = []
var _error := ""
var _property_names := {}
var _finished := false
var _started_ms := 0

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() < 2:
		printerr("scenario runner needs a request and a result path")
		quit(2)
		return
	_request = _read_json(args[0])
	_result_path = args[1]
	if typeof(_request) != TYPE_DICTIONARY:
		_error = "The request file is not a JSON object."
		_write_result()
		quit(2)
		return
	_observations = _request.get("observations", [])
	_sample_every = maxi(int(_request.get("sampleEvery", 6)), 1)
	_boot_frames = maxi(int(_request.get("bootFrames", 30)), 0)
	# Native capture only: the exam never sets this, so its result shape is unchanged.
	_record_timeline = bool(_request.get("recordTimeline", false))
	_record_runtime_state = bool(_request.get("recordRuntimeState", false))
	# Layout probes measure at the project's logical window size, the way the
	# checker does: a custom headless SceneTree otherwise keeps a 64x64 root.
	# The size is only touched when layout inspection was requested, so native
	# capture and calibration runs keep their existing behavior byte for byte.
	_record_layout = bool(_request.get("recordLayout", false))
	if _record_layout:
		# Apply after Window initialization without ticking autoloads before the run.
		root.set_deferred("size", Vector2i(int(ProjectSettings.get_setting("display/window/size/viewport_width", 1152)), int(ProjectSettings.get_setting("display/window/size/viewport_height", 648))))
	# Spatial snapshots reuse the same schedule but never touch window size or
	# physics: world transforms read the same frames with or without probing.
	_record_spatial = bool(_request.get("recordSpatial", false))
	# Calibration only: a fixed global seed applied before the main scene
	# loads. Autoloads that already randomized, plus RandomNumberGenerator
	# randomize/time/external state, stay outside guarantees (see warnings).
	if _request.has("seed"):
		_seed_has = true
		_seed_value = int(_request.get("seed", 0))
	# Isolation check: the service passes the per-run XDG data home it gave
	# this child. The expected prefix is verified before the game main plays,
	# so a user:// that escapes isolation fails closed instead of looking clean.
	_expected_user_prefix = str(_request.get("expectedUserDataPrefix", ""))
	_initial_user_data_dir = OS.get_user_data_dir()
	if not _expected_user_prefix.is_empty():
		if _initial_user_data_dir.is_empty() or not (_initial_user_data_dir == _expected_user_prefix or _initial_user_data_dir.begins_with(_expected_user_prefix.trim_suffix("/") + "/")):
			_error = "The engine user data dir is outside the isolated per-run directory; refusing instead of claiming a clean state."
			_write_result()
			quit(1)
			return
	if _seed_has:
		seed(_seed_value)
	var scenario_path := str(_request.get("scenarioPath", ""))
	_scenario = _read_json(scenario_path)
	if typeof(_scenario) != TYPE_DICTIONARY:
		_error = "The scenario file is not a JSON object."
		_write_result()
		quit(2)
		return
	var validation := _validate_scenario(_scenario)
	if validation != "":
		_error = validation
		_write_result()
		quit(2)
		return
	await _run()
	_write_result()
	quit(0 if _error.is_empty() else 1)

func _run() -> void:
	_started_ms = Time.get_ticks_msec()
	var main_path := str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if main_path.is_empty():
		_error = "project.godot has no application/run/main_scene."
		return
	var packed := load(main_path) as PackedScene
	if packed == null:
		_error = "The main scene does not load: %s" % main_path
		return
	var scene := packed.instantiate()
	if scene == null:
		_error = "The main scene does not instantiate: %s" % main_path
		return
	root.add_child(scene)
	# The runner starts the real main scene, so it must own it the way a
	# normal launch does. Without current_scene the unmanaged menu is never
	# freed when it calls change_scene_to_file: the old menu stays over the
	# new scene's HUD/gameplay while input still moves the player. Setting
	# current_scene makes the scene change free the menu first.
	current_scene = scene
	for i in _boot_frames:
		await _tick()
	_sample()
	if _record_runtime_state:
		_initial_game_state = _runtime_game_state()
	if _record_layout:
		_probe_layout(-1)
	var steps: Array = _scenario.get("steps", [])
	if _record_layout:
		_layout_probe_steps = _probe_schedule(steps)
	if _record_spatial:
		_spatial_probe_steps = _probe_schedule(steps)
		_probe_spatial(-1)
	for index in steps.size():
		if _finished:
			return
		var step: Dictionary = steps[index]
		if _record_timeline:
			_timeline.append({"step": index, "phase": "before", "scenarioFrame": _frame, "enginePhysicsFrame": Engine.get_physics_frames(), "renderFrame": Engine.get_process_frames()})
		var step_error := await _run_step(step)
		if _record_timeline:
			_timeline.append({"step": index, "phase": "after", "scenarioFrame": _frame, "enginePhysicsFrame": Engine.get_physics_frames(), "renderFrame": Engine.get_process_frames()})
		if not step_error.is_empty():
			_error = "Step %d: %s" % [index + 1, step_error]
			return
		# A probe after a step boundary sees what that input did to the
		# layout; a failed step ends the run instead of probing a broken game.
		if _record_layout and _layout_probe_steps.has(index):
			_probe_layout(index)
		# Spatial shares the same schedule: one synchronous world-space read
		# after the input that established the state.
		if _record_spatial and _spatial_probe_steps.has(index):
			_probe_spatial(index)
	_release_all()
	# One last sample after the final step, so a short route still has an end value.
	_sample()

func _run_step(step: Dictionary) -> String:
	if step.has("press"):
		return await _run_press(str(step["press"]))
	if step.has("hold"):
		return await _run_hold(step["hold"], int(step["frames"]))
	if step.has("wait"):
		_release_all()
		for i in int(step["wait"]):
			if _finished:
				return ""
			await _tick()
		return ""
	return "unknown step kind"

# The bounded probe schedule: the boot probe plus the first, middle and last
# input step boundaries, deduped. Waits only gather evidence, so they never
# earn a probe; gameplay baselines are covered because the probes run after
# the inputs that establish them.
func _probe_schedule(steps: Array) -> Array:
	var inputs: Array = []
	for index in steps.size():
		var step = steps[index]
		if step is Dictionary and (step.has("press") or step.has("hold")):
			inputs.append(index)
	if inputs.is_empty():
		return []
	var picked: Array = [inputs[0], inputs[inputs.size() / 2], inputs[inputs.size() - 1]]
	var schedule: Array = []
	for index in picked:
		if schedule.size() >= LAYOUT_MAX_STEP_PROBES:
			break
		if not schedule.has(index):
			schedule.append(index)
	return schedule

func _probe_layout(step_index: int) -> void:
	if int(_layout_state.get("warnings", 0)) >= GS_LAYOUT_MAX_WARNINGS:
		_layout_omitted += 1
		return
	_layout_step = step_index
	_layout_probes += 1
	var scene := current_scene
	if scene == null or not is_instance_valid(scene):
		return
	gs_layout_scan_entry(scene, root, Callable(self, "_layout_finding"), _layout_state)

func _layout_finding(kind: String, subject: String, detail: String, node_path: String) -> void:
	var vp := root.size
	_layout_findings.append({
		"kind": kind,
		"subject": subject,
		"detail": detail,
		"nodePath": node_path,
		"scenarioFrame": _frame,
		"step": null if _layout_step < 0 else _layout_step,
		"viewport": {"width": vp.x, "height": vp.y},
	})

# Bounded spatial snapshots: player origin/velocity plus Area collision-shape
# world bounds. Synchronous only, no awaits or ticks: the same physical frames
# run with or without probing. Skips freed nodes, caps traversal, and marks
# rotated/non-box boxes conservative. Point-in-box never means a body is fully
# inside or any game trigger fired.
func _probe_spatial(step_index: int) -> void:
	if _spatial_snapshots.size() >= SPATIAL_MAX_SNAPSHOTS:
		_spatial_omitted += 1
		_spatial_truncated = true
		return
	var scene := current_scene
	if scene == null or not is_instance_valid(scene):
		_spatial_skipped_freed += 1
		_spatial_truncated = true
		_spatial_snapshots.append({
			"scenarioFrame": _frame,
			"step": null if step_index < 0 else step_index,
			"player": {"present": false, "position": null, "velocity": null, "bodyKind": null},
			"areas": [],
		})
		return
	var player_info := _spatial_player_info()
	var areas: Array = []
	var stack: Array = [scene]
	while not stack.is_empty():
		if _spatial_visited >= SPATIAL_MAX_NODES or _spatial_areas + areas.size() >= SPATIAL_MAX_AREAS or _spatial_shapes >= SPATIAL_MAX_SHAPES:
			_spatial_truncated = true
			break
		if stack.size() > SPATIAL_MAX_NODES * 2:
			_spatial_truncated = true
			break
		var node: Node = stack.pop_back()
		_spatial_visited += 1
		if node == null or not is_instance_valid(node):
			_spatial_skipped_freed += 1
			continue
		if node is Area2D or node is Area3D:
			if _spatial_areas + areas.size() >= SPATIAL_MAX_AREAS:
				_spatial_truncated = true
				continue
			var entry := _spatial_area_entry(node, player_info)
			if not entry.is_empty():
				areas.append(entry)
		_spatial_push_children(node, stack)
	_spatial_areas += areas.size()
	_spatial_snapshots.append({
		"scenarioFrame": _frame,
		"step": null if step_index < 0 else step_index,
		"player": {
			"present": bool(player_info.get("present", false)),
			"position": _encode_pos(player_info.get("pos")),
			"velocity": _encode_pos(player_info.get("vel")),
			"bodyKind": player_info.get("kind"),
		},
		"areas": areas,
	})

# Preserve scene child order while bounding the pending stack before allocation.
func _spatial_push_children(node: Node, stack: Array) -> void:
	var available := maxi(0, SPATIAL_MAX_NODES - _spatial_visited - stack.size())
	var count := mini(node.get_child_count(), available)
	if count < node.get_child_count():
		_spatial_truncated = true
	for index in range(count - 1, -1, -1):
		stack.append(node.get_child(index))

func _spatial_player_info() -> Dictionary:
	var body: Variant = get_first_node_in_group("player")
	if body == null:
		return {"present": false, "pos": null, "vel": null, "kind": null}
	if body == null or not is_instance_valid(body):
		_spatial_skipped_freed += 1
		return {"present": false, "pos": null, "vel": null, "kind": null}
	var pos: Variant = _player_position(body)
	var vel: Variant = null
	if body is CharacterBody2D:
		vel = (body as CharacterBody2D).velocity
	elif body is CharacterBody3D:
		vel = (body as CharacterBody3D).velocity
	elif body is RigidBody2D:
		vel = (body as RigidBody2D).linear_velocity
	elif body is RigidBody3D:
		vel = (body as RigidBody3D).linear_velocity
	var kind: Variant = null
	if body is Node:
		kind = str((body as Node).get_class())
	return {"present": true, "pos": pos, "vel": vel, "kind": kind}

func _spatial_area_entry(area: Node, player_info: Dictionary) -> Dictionary:
	if area == null or not is_instance_valid(area):
		_spatial_skipped_freed += 1
		return {}
	var area_type := str(area.get_class())
	if area_type != "Area2D" and area_type != "Area3D":
		return {}
	var node_path := str(root.get_path_to(area))
	var monitoring := false
	var monitorable := false
	if area is Area2D:
		monitoring = bool((area as Area2D).monitoring)
		monitorable = bool((area as Area2D).monitorable)
	else:
		monitoring = bool((area as Area3D).monitoring)
		monitorable = bool((area as Area3D).monitorable)
	var visible := bool(area.is_visible_in_tree())
	var shapes: Array = []
	var child_count := area.get_child_count()
	var inspected := 0
	for index in range(child_count):
		if _spatial_visited >= SPATIAL_MAX_NODES or _spatial_shapes >= SPATIAL_MAX_SHAPES:
			_spatial_truncated = true
			break
		var node := area.get_child(index)
		_spatial_visited += 1
		inspected += 1
		if node == null or not is_instance_valid(node):
			_spatial_skipped_freed += 1
			continue
		# CollisionShape nodes configure their immediate CollisionObject parent.
		# Descendant Areas own their own shapes, never their ancestor's shapes.
		if node is CollisionShape2D or node is CollisionShape3D:
			var shape_entry := _spatial_shape_entry(node, player_info)
			if not shape_entry.is_empty():
				shapes.append(shape_entry)
				_spatial_shapes += 1
	if inspected < child_count:
		_spatial_truncated = true
	return {
		"nodePath": node_path,
		"type": area_type,
		"monitoring": monitoring,
		"monitorable": monitorable,
		"visible": visible,
		"shapes": shapes,
	}

func _spatial_shape_entry(shape_node: Node, player_info: Dictionary) -> Dictionary:
	if shape_node == null or not is_instance_valid(shape_node):
		_spatial_skipped_freed += 1
		return {}
	var node_path := str(root.get_path_to(shape_node))
	var disabled := false
	if shape_node is CollisionShape2D:
		disabled = bool((shape_node as CollisionShape2D).disabled)
	elif shape_node is CollisionShape3D:
		disabled = bool((shape_node as CollisionShape3D).disabled)
	var bound := {"kind": "unknown", "min": null, "max": null, "conservative": true, "shapeKind": "unknown"}
	if shape_node is CollisionShape2D:
		bound = _spatial_shape2d_bounds(shape_node as CollisionShape2D)
	elif shape_node is CollisionShape3D:
		bound = _spatial_shape3d_bounds(shape_node as CollisionShape3D)
	var contains: Variant = null
	var player_pos: Variant = player_info.get("pos")
	if player_pos != null and str(bound.get("kind", "unknown")) != "unknown":
		var bmin: Variant = bound.get("min")
		var bmax: Variant = bound.get("max")
		if player_pos is Vector2 and bmin is Vector2 and bmax is Vector2:
			var p := player_pos as Vector2
			contains = p.x >= (bmin as Vector2).x and p.x <= (bmax as Vector2).x and p.y >= (bmin as Vector2).y and p.y <= (bmax as Vector2).y
		elif player_pos is Vector3 and bmin is Vector3 and bmax is Vector3:
			var q := player_pos as Vector3
			contains = q.x >= (bmin as Vector3).x and q.x <= (bmax as Vector3).x and q.y >= (bmin as Vector3).y and q.y <= (bmax as Vector3).y and q.z >= (bmin as Vector3).z and q.z <= (bmax as Vector3).z
	var encoded_min: Variant = null
	var encoded_max: Variant = null
	if bound.get("min") != null:
		encoded_min = _encode_pos(bound.get("min"))
	if bound.get("max") != null:
		encoded_max = _encode_pos(bound.get("max"))
	return {
		"nodePath": node_path,
		"shapeKind": str(bound.get("shapeKind", "unknown")),
		"disabled": disabled,
		"bounds": {"kind": str(bound.get("kind", "unknown")), "min": encoded_min, "max": encoded_max},
		"conservative": bool(bound.get("conservative", true)),
		"containsPlayerOrigin": contains,
	}

func _spatial_shape2d_bounds(shape_node: CollisionShape2D) -> Dictionary:
	var unknown := {"kind": "unknown", "min": null, "max": null, "conservative": true, "shapeKind": "unknown"}
	var shape: Variant = shape_node.shape
	if shape == null or not is_instance_valid(shape):
		return unknown
	var kind := str((shape as Resource).get_class())
	unknown["shapeKind"] = kind
	if not shape.has_method("get_rect"):
		return unknown
	var local_rect: Rect2 = shape.get_rect()
	if not is_finite(local_rect.position.x) or not is_finite(local_rect.position.y) or not is_finite(local_rect.size.x) or not is_finite(local_rect.size.y):
		return unknown
	if local_rect.size.x <= 0.0 or local_rect.size.y <= 0.0:
		return unknown
	var xform: Transform2D = shape_node.global_transform
	if not is_finite(xform.x.x) or not is_finite(xform.x.y) or not is_finite(xform.y.x) or not is_finite(xform.y.y) or not is_finite(xform.origin.x) or not is_finite(xform.origin.y):
		return unknown
	var corners: Array = [
		xform * local_rect.position,
		xform * (local_rect.position + Vector2(local_rect.size.x, 0.0)),
		xform * (local_rect.position + Vector2(0.0, local_rect.size.y)),
		xform * (local_rect.position + local_rect.size),
	]
	var min_pt := corners[0] as Vector2
	var max_pt := corners[0] as Vector2
	for corner in corners:
		var c := corner as Vector2
		if not is_finite(c.x) or not is_finite(c.y):
			return unknown
		min_pt.x = minf(min_pt.x, c.x)
		min_pt.y = minf(min_pt.y, c.y)
		max_pt.x = maxf(max_pt.x, c.x)
		max_pt.y = maxf(max_pt.y, c.y)
	var rot := absf(float(shape_node.global_rotation))
	var conservative := rot > 0.0001 or kind != "RectangleShape2D"
	return {"kind": "rect2", "min": min_pt, "max": max_pt, "conservative": conservative, "shapeKind": kind}

func _spatial_shape3d_bounds(shape_node: CollisionShape3D) -> Dictionary:
	var unknown := {"kind": "unknown", "min": null, "max": null, "conservative": true, "shapeKind": "unknown"}
	var shape: Variant = shape_node.shape
	if shape == null or not is_instance_valid(shape):
		return unknown
	var kind := str((shape as Resource).get_class())
	unknown["shapeKind"] = kind
	if kind != "BoxShape3D" and kind != "SphereShape3D" and kind != "CapsuleShape3D" and kind != "CylinderShape3D":
		return unknown
	var ext := Vector3.ZERO
	if kind == "BoxShape3D":
		var sz: Variant = shape.get("size")
		if not (sz is Vector3):
			return unknown
		var s := sz as Vector3
		if not is_finite(s.x) or not is_finite(s.y) or not is_finite(s.z) or s.x <= 0.0 or s.y <= 0.0 or s.z <= 0.0:
			return unknown
		ext = s * 0.5
	elif kind == "SphereShape3D":
		var r: Variant = shape.get("radius")
		if not (r is float or r is int):
			return unknown
		if not is_finite(float(r)) or float(r) <= 0.0:
			return unknown
		ext = Vector3(float(r), float(r), float(r))
	else:
		var rr: Variant = shape.get("radius")
		var hh: Variant = shape.get("height")
		if not (rr is float or rr is int) or not (hh is float or hh is int):
			return unknown
		if not is_finite(float(rr)) or not is_finite(float(hh)) or float(rr) <= 0.0 or float(hh) <= 0.0:
			return unknown
		ext = Vector3(float(rr), float(hh) * 0.5, float(rr))
	var xform: Transform3D = shape_node.global_transform
	var bx := xform.basis.x
	var by := xform.basis.y
	var bz := xform.basis.z
	var og := xform.origin
	if not is_finite(bx.x) or not is_finite(bx.y) or not is_finite(bx.z) or not is_finite(by.x) or not is_finite(by.y) or not is_finite(by.z) or not is_finite(bz.x) or not is_finite(bz.y) or not is_finite(bz.z) or not is_finite(og.x) or not is_finite(og.y) or not is_finite(og.z):
		return unknown
	var corners: Array = [
		xform * Vector3(-ext.x, -ext.y, -ext.z),
		xform * Vector3(ext.x, -ext.y, -ext.z),
		xform * Vector3(-ext.x, ext.y, -ext.z),
		xform * Vector3(ext.x, ext.y, -ext.z),
		xform * Vector3(-ext.x, -ext.y, ext.z),
		xform * Vector3(ext.x, -ext.y, ext.z),
		xform * Vector3(-ext.x, ext.y, ext.z),
		xform * Vector3(ext.x, ext.y, ext.z),
	]
	var min_pt := corners[0] as Vector3
	var max_pt := corners[0] as Vector3
	for corner in corners:
		var c := corner as Vector3
		if not is_finite(c.x) or not is_finite(c.y) or not is_finite(c.z):
			return unknown
		min_pt.x = minf(min_pt.x, c.x)
		min_pt.y = minf(min_pt.y, c.y)
		min_pt.z = minf(min_pt.z, c.z)
		max_pt.x = maxf(max_pt.x, c.x)
		max_pt.y = maxf(max_pt.y, c.y)
		max_pt.z = maxf(max_pt.z, c.z)
	var rot: Vector3 = (shape_node as Node3D).global_rotation
	var conservative := rot.length() > 0.0001 or kind != "BoxShape3D"
	return {"kind": "aabb3", "min": min_pt, "max": max_pt, "conservative": conservative, "shapeKind": kind}

func _mark_input() -> void:
	# The first non-wait step is where play could start. Everything sampled
	# before it is boot, and a value that was already true there proves nothing.
	if _first_input_frame < 0:
		_first_input_frame = _frame
		# A game already playing when the route starts has no menu transition
		# to absorb this press. Baseline before it, not at the next periodic
		# sample, so the action the press causes is evidence instead of looking
		# like a value that was already true when play started. An existing
		# player is a markerless game's sign that play has started; a typed
		# play marker is the sign for a no-player UI game. The menu guard in
		# _capture_baseline still holds its baseline back.
		_capture_baseline(get_nodes_in_group("player"))

func _run_press(action: String) -> String:
	_release_all()
	_mark_input()
	var has_key := false
	for event in InputMap.action_get_events(action):
		var key := event as InputEventKey
		if key != null and key.physical_keycode != 0:
			has_key = true
			Input.parse_input_event(_make_key_event(key.keycode, key.physical_keycode, true))
			Input.action_press(action)
			await _tick()
			Input.parse_input_event(_make_key_event(key.keycode, key.physical_keycode, false))
			Input.action_release(action)
			await _tick()
			return ""
	if has_key:
		return ""
	var down_action := InputEventAction.new()
	down_action.action = action
	down_action.pressed = true
	Input.parse_input_event(down_action)
	Input.action_press(action)
	await _tick()
	var up_action := InputEventAction.new()
	up_action.action = action
	up_action.pressed = false
	Input.parse_input_event(up_action)
	Input.action_release(action)
	await _tick()
	return ""

func _run_hold(actions: Array, frames: int) -> String:
	_mark_input()
	for action in _held.keys():
		if not actions.has(action):
			Input.action_release(action)
			_held.erase(action)
	for action in actions:
		if not _held.has(action):
			Input.action_press(action)
			_held[action] = true
	for i in frames:
		if _finished:
			return ""
		await _tick()
	# Actions stay held until the next step replaces them or the route ends, so
	# consecutive hold steps form one continuous input instead of releasing for a
	# frame every time a jump is added.
	return ""

func _release_all() -> void:
	for action in _held.keys():
		Input.action_release(action)
	_held.clear()

func _tick() -> void:
	await physics_frame
	_frame += 1
	if _frame % _sample_every == 0:
		_sample()

func _validate_scenario(scenario: Dictionary) -> String:
	var keys := scenario.keys()
	for key in keys:
		if key != "id" and key != "steps":
			return "Unknown scenario key \\"%s\\"." % key
	if not scenario.has("steps") or typeof(scenario["steps"]) != TYPE_ARRAY:
		return "The scenario needs a steps array."
	var steps: Array = scenario["steps"]
	if steps.is_empty() or steps.size() > LIMITS["steps"]:
		return "The scenario must have 1..%d steps." % LIMITS["steps"]
	var planned := 0
	for index in steps.size():
		var step = steps[index]
		if typeof(step) != TYPE_DICTIONARY:
			return "Step %d is not an object." % (index + 1)
		if step.has("press"):
			if typeof(step["press"]) != TYPE_STRING or str(step["press"]).is_empty():
				return "Step %d needs one action to press." % (index + 1)
			if not InputMap.has_action(str(step["press"])) and not _invalid_actions.has(str(step["press"])):
				_invalid_actions.append(str(step["press"]))
			planned += 2
		elif step.has("hold"):
			if typeof(step["hold"]) != TYPE_ARRAY or step["hold"].is_empty() or step["hold"].size() > MAX_ACTIONS_PER_STEP:
				return "Step %d needs a non-empty hold list." % (index + 1)
			for action in step["hold"]:
				if typeof(action) != TYPE_STRING or not InputMap.has_action(action):
					if not _invalid_actions.has(str(action)):
						_invalid_actions.append(str(action))
			if not step.has("frames") or int(step["frames"]) <= 0:
				return "Step %d needs positive frames." % (index + 1)
			planned += int(step["frames"])
		elif step.has("wait"):
			if not step.has("wait") or int(step["wait"]) <= 0:
				return "Step %d needs a positive wait." % (index + 1)
			planned += int(step["wait"])
		else:
			return "Step %d is not a press, hold or wait step." % (index + 1)
	if planned > LIMITS["frames"]:
		return "The scenario plans %d frames; the limit is %d." % [planned, LIMITS["frames"]]
	if not _invalid_actions.is_empty():
		return "Unknown input action(s): %s" % ", ".join(_invalid_actions)
	return ""

func _read_json(path: String) -> Variant:
	var text := FileAccess.get_file_as_string(path)
	if text.is_empty():
		return null
	var parsed = JSON.parse_string(text)
	return parsed

func _state_marker() -> Variant:
	# Null means "no shared play marker here": an absent, null or non-numeric
	# state keeps the player-presence baseline rule instead of blocking play.
	var state := _game_state()
	if state == null or not _property_exists(state, "state"):
		return null
	var value: Variant = state.get("state")
	if typeof(value) == TYPE_BOOL or _is_number(value):
		return value
	return null

func _is_menu(value: Variant) -> bool:
	if typeof(value) == TYPE_BOOL:
		return not value
	return _is_number(value) and is_equal_approx(float(value), 0.0)

func _capture_baseline(players: Array) -> void:
	if _baseline_frame >= 0:
		return
	# 0 is the shared menu state. A menu's hidden player group must not become
	# the gameplay baseline while the route is still in the menu.
	var marker: Variant = _state_marker()
	if marker != null and _is_menu(marker):
		return
	# A markerless game needs a player to show play started. An explicit typed
	# marker identifies play on its own, so a Control UI game with no player
	# node can establish the baseline its approved choices are measured from.
	if players.size() == 0 and marker == null:
		return
	_baseline_frame = _frame
	# The physical baseline rides with the observation baseline: the player
	# position when play started, so displacement measures what the route did.
	if players.size() > 0:
		_player_baseline = _player_position(players[0])
	for observation in _observations:
		var key := str(observation["key"])
		_baseline_values[key] = _value(key)

func _property_exists(node: Node, key: String) -> bool:
	if _property_names.is_empty():
		for property in node.get_property_list():
			_property_names[str(property["name"])] = true
	return _property_names.has(key)

func _value(key: String) -> Variant:
	var state := _game_state()
	if state == null or not _property_exists(state, key):
		return null
	return state.get(key)

func _sample() -> void:
	# A hold or press can rebuild the scene; look the player up again every sample.
	var players := get_nodes_in_group("player")
	if players.size() > 0:
		var body := players[0] as Node
		if body is Node2D:
			_player = (body as Node2D).global_position
		elif body is Node3D:
			_player = (body as Node3D).global_position
		else:
			_player = null
	else:
		_player = null
	if _player != null:
		_player_seen = true
		if _player_first == null:
			_player_first = _player
		elif _player != _player_first:
			_player_moved = true
		_player_last = _player
	# The gameplay baseline is taken before the first input when play had
	# already started, and otherwise at the first sample after real input in
	# which play exists. A menu, a spawn counter or a world total that is
	# already true there is not something the player did.
	# A game already in play was sampled before this input by _mark_input, so
	# its first action is not folded into the baseline.
	if _first_input_frame >= 0:
		_capture_baseline(players)
	var has_baseline := _baseline_frame >= 0
	var state := _game_state()
	if state != null:
		for observation in _observations:
			var key := str(observation["key"])
			var id := str(observation["id"])
			var value: Variant = _value(key)
			if not _stats.has(key):
				_stats[key] = {
					"key": key,
					"min": null,
					"max": null,
					"first": value,
					"last": value,
					"firstChangeFrame": null,
					"matches": {},
				}
			var stats: Dictionary = _stats[key]
			stats["last"] = value
			if _is_number(value):
				if stats["min"] == null or value < stats["min"]:
					stats["min"] = value
				if stats["max"] == null or value > stats["max"]:
					stats["max"] = value
			if stats["firstChangeFrame"] == null and value != stats["first"]:
				stats["firstChangeFrame"] = _frame
			# Only samples strictly after the baseline can prove a transition.
			# The baseline value itself is recorded separately and is checked by
			# the evaluator for "already true when play started".
			if (
				has_baseline
				and _frame > _baseline_frame
				and not stats["matches"].has(id)
				and _matches(
					str(observation.get("expect", "")),
					value,
					_baseline_values.get(key),
				)
			):
				stats["matches"][id] = {"frame": _frame, "value": value}

func _is_number(value: Variant) -> bool:
	return typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT

func _matches(expect: String, value: Variant, baseline: Variant) -> bool:
	if expect == "changes":
		# Change is measured from the gameplay baseline, not from boot.
		return value != baseline
	if expect.length() < 3:
		return false
	var operator := expect.substr(0, 2)
	if operator != "==" and operator != ">=" and operator != "<=":
		return false
	var target := expect.substr(2).to_float()
	var number := 0.0
	if typeof(value) == TYPE_BOOL:
		number = 1.0 if value else 0.0
	elif _is_number(value):
		number = float(value)
	else:
		return false
	if operator == "==":
		return is_equal_approx(number, target)
	if operator == ">=":
		return number >= target
	return number <= target

func _write_result() -> void:
	if _result_path.is_empty():
		return
	var observations: Array = []
	for key in _stats.keys():
		var stats: Dictionary = _stats[key]
		var matches: Array = []
		for id in stats["matches"].keys():
			var match: Dictionary = stats["matches"][id]
			matches.append({
				"id": id,
				"frame": int(match["frame"]),
				"value": match["value"],
			})
		observations.append({
			"key": stats["key"],
			"min": stats["min"],
			"max": stats["max"],
			"first": stats["first"],
			"last": stats["last"],
			"firstChangeFrame": stats["firstChangeFrame"],
			"baseline": _baseline_values.get(key),
			"matches": matches,
		})
	var file := FileAccess.open(_result_path, FileAccess.WRITE)
	if file == null:
		return
	var result := {
		"id": str(_scenario.get("id", "")),
		"frames": _frame,
		"durationMs": Time.get_ticks_msec() - _started_ms,
		"firstInputFrame": null if _first_input_frame < 0 else _first_input_frame,
		"baselineFrame": null if _baseline_frame < 0 else _baseline_frame,
		"playerMoved": _player_seen and _player_moved,
		"error": null if _error.is_empty() else _error,
		"invalidActions": _invalid_actions,
		"observations": observations,
		# Isolation evidence, reported before the game main played: the engine
		# user data dir this run actually used. The service checks it stays
		# inside the per-run XDG trio it gave this child.
		"userDataDir": _initial_user_data_dir,
		# Physical state, as plain arrays: Vector2 as [x, y], Vector3 as
		# [x, y, z], null when the player was never observed. The baseline is
		# the position when play started; displacement is measured from it.
		"playerFirst": _encode_pos(_player_first),
		"playerBaseline": _encode_pos(_player_baseline),
		"playerLast": _encode_pos(_player_last),
		# Actual engine counters at finish, not estimates. Physics and render
		# frames are different units from the runner's scenario frames: never
		# compare them as one.
		"enginePhysicsFrames": Engine.get_physics_frames(),
		"renderFrames": Engine.get_process_frames(),
	}
	if _record_timeline:
		result["timeline"] = _timeline
		result["physicsHz"] = Engine.physics_ticks_per_second
	if _record_runtime_state:
		var final_state := _runtime_game_state()
		result["gameState"] = final_state.get("values", {})
		result["initialGameState"] = _initial_game_state.get("values", {}) if _initial_game_state is Dictionary else {}
		result["gameStateComplete"] = bool(final_state.get("complete", false)) and _initial_game_state is Dictionary and bool(_initial_game_state.get("complete", false))
	if _record_layout:
		# Runtime layout is additive diagnostics, never a quality verdict:
		# the state exam grades observations, and absence of findings never
		# means the route was fully covered. Findings are native headless
		# geometry at the project's logical size, not Web proof.
		var vp := root.size
		result["layout"] = {
			"findings": _layout_findings,
			"coverage": {
				"probes": _layout_probes,
				"omittedProbes": _layout_omitted,
				"inspectedControls": int(_layout_state.get("inspected", 0)),
				"pairs": int(_layout_state.get("pairs", 0)),
				"truncated": bool(_layout_state.get("truncated", false)),
				"viewport": {"width": vp.x, "height": vp.y},
			},
		}
	if _record_spatial:
		# Runtime spatial snapshots are additive measurements, never a verdict:
		# the state exam grades observations, and absence of areas never means
		# full coverage. Native headless world geometry may diverge from Web
		# cadence and runtime. containsPlayerOrigin tests the probed origin
		# point only, never a whole body or any game trigger.
		result["spatial"] = {
			"snapshots": _spatial_snapshots,
			"coverage": {
				"snapshots": _spatial_snapshots.size(),
				"omittedSnapshots": _spatial_omitted,
				"visitedNodes": _spatial_visited,
				"areas": _spatial_areas,
				"shapes": _spatial_shapes,
				"skippedFreed": _spatial_skipped_freed,
				"truncated": _spatial_truncated,
			},
		}
	file.store_string(JSON.stringify(result))
	file.close()
`;
