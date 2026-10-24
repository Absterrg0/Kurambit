## Headless smoke-test entry point.
##
##     game_godot_test { script: "tests/smoke_test.gd" }
##
## Godot compiles the `--script` entry point before it registers the project's
## autoloads and before the scene tree is live, so the checks themselves live in
## `tests/smoke_harness.gd`: it is loaded here and starts from its own `_ready`.
## Exit code 0 means every check passed; anything else prints the failures.
extends SceneTree

const HARNESS := "res://tests/smoke_harness.gd"
## A runtime error inside the harness would leave this loop running forever.
const WATCHDOG_MS := 60_000

func _initialize() -> void:
	var script := load(HARNESS) as GDScript
	if script == null:
		printerr("SMOKE FAIL: %s did not load" % HARNESS)
		quit(1)
		return
	var harness := script.new() as Node
	if harness == null:
		printerr("SMOKE FAIL: %s is not a Node" % HARNESS)
		quit(1)
		return
	root.add_child(harness)
	_watch(harness)

func _watch(harness: Node) -> void:
	var deadline := Time.get_ticks_msec() + WATCHDOG_MS
	while Time.get_ticks_msec() < deadline:
		await physics_frame
		if bool(harness.get("finished")):
			return
	printerr("SMOKE FAIL: no result after %d ms" % WATCHDOG_MS)
	quit(1)
