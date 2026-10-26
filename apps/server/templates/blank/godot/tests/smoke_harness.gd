## Engine-readiness smoke test for the Blank starter, loaded by
## `tests/smoke_test.gd`.
##
## It proves the project boots its main scene, that the GameState autoload is
## live, and that StudioProbe can read the real scene tree. It deliberately
## checks no gameplay. Keep these engine checks as you add gameplay and run
## values, and add checks that drive the game and assert observable outcomes.
extends Node

const MAIN_SCENE := "res://scenes/main.tscn"
const GAME_STATE_SCRIPT := "res://scripts/game_state.gd"

var _failures: Array[String] = []
var _checks := 0
## Read by smoke_test.gd to know the run is over.
var finished := false

var _finished := false

func _ready() -> void:
	# Deferred: root is still busy adding children while this node enters the tree.
	run.call_deferred()

func run() -> void:
	print("blank starter smoke test: engine readiness")
	await _check_main_scene()
	_check_game_state()
	_check_probe()
	_finish()

func _check_main_scene() -> void:
	var packed := load(MAIN_SCENE) as PackedScene
	if packed == null:
		_fail("%s loads" % MAIN_SCENE)
		return
	var main := packed.instantiate()
	if main == null:
		_fail("%s instantiates" % MAIN_SCENE)
		return
	get_tree().root.add_child(main)
	# Let the scene enter and run a frame; a script error in _ready would surface
	# before the bridge checks read the tree.
	await get_tree().process_frame
	await get_tree().physics_frame
	_check(main.is_inside_tree(), "%s enters the scene tree" % MAIN_SCENE)

func _check_game_state() -> void:
	var game_state := get_node_or_null("/root/GameState")
	if game_state == null:
		_fail("the GameState autoload exists")
		return
	var script := game_state.get_script() as Script
	_check(
		script != null and script.resource_path == GAME_STATE_SCRIPT,
		"GameState runs %s" % GAME_STATE_SCRIPT
	)

func _check_probe() -> void:
	var probe := get_node_or_null("/root/StudioProbe")
	if probe == null:
		_fail("the StudioProbe autoload exists")
		return
	_check(probe.has_method("snapshot"), "StudioProbe exposes snapshot()")
	if not probe.has_method("snapshot"):
		return
	var snapshot: Variant = probe.call("snapshot")
	if not (snapshot is Dictionary):
		_fail("StudioProbe.snapshot() returns a Dictionary")
		return
	var values := snapshot as Dictionary
	_check(values.has("gameState"), "the snapshot carries gameState")
	_check(values.has("player"), "the snapshot carries player")
	_check(values.has("hudText"), "the snapshot carries hudText")
	_check(values.get("gameState") is Dictionary, "gameState is a Dictionary")
	_check(values.get("hudText") is String, "hudText is a String")

func _check(condition: bool, label: String) -> void:
	_checks += 1
	if _finished:
		return
	if condition:
		print("  ok    ", label)
		return
	_fail(label)

func _fail(label: String) -> void:
	if _finished:
		return
	_failures.append(label)
	_finish()

func _finish() -> void:
	if _finished:
		return
	_finished = true
	finished = true
	if _failures.is_empty():
		print("SMOKE PASS: %d checks (engine readiness only, no gameplay)" % _checks)
		get_tree().quit(0)
		return
	printerr("SMOKE FAIL: %d of %d checks failed" % [_failures.size(), _checks])
	for failure in _failures:
		printerr("  failed: ", failure)
	get_tree().quit(1)
