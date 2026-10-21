/**
 * The route runner Godot executes headlessly for `game_scenarios_run`. It is a
 * string, not an asset, so the packed server archive carries it without a second
 * asset-copy rule. GameService writes it under the game's ignored
 * `builds/logs/` tree and passes a request path after `--`.
 *
 * The runner is intentionally dumb: it starts the real main scene, injects input
 * every physics frame and samples GameState plus the "player" group. It never
 * calls a game function or writes a game property, so a passing route proves the
 * game is playable with the same input a person uses.
 */
export const GODOT_SCENARIO_SCRIPT = `extends SceneTree

const LIMITS := {"steps": 2000, "frames": 36000}
const MAX_ACTIONS_PER_STEP := 8

var _result_path := ""
var _request := {}
var _scenario := {}
var _observations: Array = []
var _sample_every := 6
var _boot_frames := 30
var _frame := 0
var _held := {}
var _stats := {}
var _first_input_frame := -1
var _baseline_frame := -1
var _baseline_values := {}
var _player: Variant = null
var _player_first: Variant = null
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
	for i in _boot_frames:
		await _tick()
	_sample()
	var steps: Array = _scenario.get("steps", [])
	for index in steps.size():
		if _finished:
			return
		var step: Dictionary = steps[index]
		var step_error := await _run_step(step)
		if not step_error.is_empty():
			_error = "Step %d: %s" % [index + 1, step_error]
			return
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

func _mark_input() -> void:
	# The first non-wait step is where play could start. Everything sampled
	# before it is boot, and a value that was already true there proves nothing.
	if _first_input_frame < 0:
		_first_input_frame = _frame

func _run_press(action: String) -> String:
	_release_all()
	_mark_input()
	var has_key := false
	for event in InputMap.action_get_events(action):
		var key := event as InputEventKey
		if key != null and key.physical_keycode != 0:
			has_key = true
			var down := InputEventKey.new()
			down.physical_keycode = key.physical_keycode
			down.keycode = key.keycode
			down.pressed = true
			Input.parse_input_event(down)
			Input.action_press(action)
			await _tick()
			var up := InputEventKey.new()
			up.physical_keycode = key.physical_keycode
			up.keycode = key.keycode
			up.pressed = false
			Input.parse_input_event(up)
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

func _game_state() -> Node:
	return root.get_node_or_null("GameState")

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
	# The gameplay baseline is the first sample after real input in which the
	# player exists. Boot samples do not count: a menu, a spawn counter or a
	# world total that is already true there is not something the player did.
	var has_baseline := _baseline_frame >= 0
	if not has_baseline and _first_input_frame >= 0 and players.size() > 0:
		_baseline_frame = _frame
		has_baseline = true
		for observation in _observations:
			var key := str(observation["key"])
			_baseline_values[key] = _value(key)
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
	file.store_string(JSON.stringify({
		"id": str(_scenario.get("id", "")),
		"frames": _frame,
		"durationMs": Time.get_ticks_msec() - _started_ms,
		"firstInputFrame": null if _first_input_frame < 0 else _first_input_frame,
		"baselineFrame": null if _baseline_frame < 0 else _baseline_frame,
		"playerMoved": _player_seen and _player_moved,
		"error": null if _error.is_empty() else _error,
		"invalidActions": _invalid_actions,
		"observations": observations,
	}))
	file.close()
`;
