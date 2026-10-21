## The exit gate. Its barrier glows red and its beacon burns warm while relics are
## missing; both turn green, and the gate opens, once `GameState` reports every relic
## collected. Walking in wins the run.
class_name Goal
extends Area3D

const Palette := preload("res://materials/palette.tres")
const LANTERN_LOCKED := preload("res://materials/lamp_glow.tres")
const LANTERN_OPEN := preload("res://materials/gate_open.tres")
const BEACON_LOCKED := preload("res://materials/beacon_locked.tres")
const BEACON_OPEN := preload("res://materials/beacon_open.tres")

@onready var locked_visual: Node3D = $Locked
@onready var open_visual: Node3D = $Open
@onready var light: OmniLight3D = $Light
@onready var lantern: MeshInstance3D = $Lantern
@onready var beacon_light: OmniLight3D = $BeaconLight
@onready var beacon: MeshInstance3D = $Beacon

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
	light.light_color = Palette.goal if unlocked else Palette.hazard
	# The beacon is the landmark the player aims at from across the world; its lantern
	# keeps the gate's state colour so the same read works at any distance.
	beacon_light.light_color = Palette.goal if unlocked else Palette.hazard
	lantern.material_override = LANTERN_OPEN if unlocked else LANTERN_LOCKED
	beacon.material_override = BEACON_OPEN if unlocked else BEACON_LOCKED

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
