## A floating relic. Bobs and spins in place, reports itself to `GameState` when the
## player touches it, and can be re-armed by `reset()` so a restart needs no reload.
class_name Collectible
extends Area3D

@export var label := "Relic"
@export var spin_speed := 1.6
@export var bob_height := 0.18
@export var bob_speed := 2.2
@export var burst_color := Color(0.6, 0.95, 1.0)

@onready var visual: Node3D = $Visual

var collected := false

var _time := 0.0
var _rest_height := 0.0

func _ready() -> void:
	_rest_height = visual.position.y
	body_entered.connect(_on_body_entered)

func _process(delta: float) -> void:
	_time += delta
	visual.rotation.y += spin_speed * delta
	visual.position.y = _rest_height + sin(_time * bob_speed) * bob_height

func reset() -> void:
	collected = false
	visible = true
	set_deferred("monitoring", true)

func _on_body_entered(body: Node3D) -> void:
	if collected or not GameState.is_playing():
		return
	if body as Player == null:
		return
	collected = true
	visible = false
	# Called from a physics signal, so the collider cannot be changed in place.
	set_deferred("monitoring", false)
	GameState.collect(label)
	Audio.play("pickup")
	_spawn_burst()

func _spawn_burst() -> void:
	var burst := CPUParticles3D.new()
	burst.one_shot = true
	burst.emitting = true
	burst.amount = 18
	burst.lifetime = 0.8
	burst.explosiveness = 1.0
	burst.direction = Vector3.UP
	burst.spread = 180.0
	burst.initial_velocity_min = 1.5
	burst.initial_velocity_max = 3.2
	burst.gravity = Vector3(0.0, -3.5, 0.0)
	burst.scale_amount_min = 0.05
	burst.scale_amount_max = 0.13
	burst.color = burst_color
	var spark := SphereMesh.new()
	spark.radius = 0.09
	spark.height = 0.18
	spark.radial_segments = 6
	spark.rings = 3
	spark.material = preload("res://materials/spark.tres")
	burst.mesh = spark
	# Parented outside the collectible: the collectible hides itself, and hidden
	# parents are not drawn.
	var host := get_parent()
	if host == null:
		return
	host.add_child(burst)
	burst.global_position = global_position
	get_tree().create_timer(1.6).timeout.connect(burst.queue_free)
