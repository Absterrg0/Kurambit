## Draws the remaining lives as pips. Drawn in code so the HUD needs no textures.
class_name LifePips
extends Control

const PIP_RADIUS := 7.0
const PIP_SPACING := 20.0

var _lives := 0
var _pip_count := 0

func refresh(lives: int, pip_count: int) -> void:
	_lives = lives
	_pip_count = pip_count
	queue_redraw()

func _draw() -> void:
	var middle := size.y * 0.5
	for index in _pip_count:
		var centre := Vector2(PIP_RADIUS + float(index) * PIP_SPACING, middle)
		if index < _lives:
			draw_circle(centre, PIP_RADIUS, Color(1.0, 0.42, 0.34))
			draw_circle(centre, PIP_RADIUS * 0.42, Color(1.0, 0.93, 0.86))
		else:
			draw_circle(centre, PIP_RADIUS, Color(1.0, 1.0, 1.0, 0.07), false, 2.0)
