## The exit gate. It glows red while relics are missing, turns green and opens once
## `GameState` reports every relic collected, and wins the run when the player walks in.
class_name Goal
extends Area3D

const LOCKED_COLOR := Color(0.95, 0.35, 0.3)
const OPEN_COLOR := Color(0.45, 1.0, 0.72)

@onready var locked_visual: Node3D = $Locked
@onready var open_visual: Node3D = $Open
@onready var light: OmniLight3D = $Light

var unlocked := false

func _ready() -> void:
	body_entered.connect(_on_body_entered)
	GameState.all_collected.connect(_on_all_collected)
	_refresh()

func reset() -> void:
	_refresh()

func _refresh() -> void:
	unlocked = GameState.total > 0 and GameState.collected >= GameState.total
	locked_visual.visible = not unlocked
	open_visual.visible = unlocked
	light.light_color = OPEN_COLOR if unlocked else LOCKED_COLOR

func _on_all_collected() -> void:
	if unlocked:
		return
	_refresh()
	GameState.notify("The gate is open")
	Audio.play("unlock")

func _on_body_entered(body: Node3D) -> void:
	if not unlocked or not GameState.is_playing():
		return
	if body as Player == null:
		return
	GameState.reach_goal()
