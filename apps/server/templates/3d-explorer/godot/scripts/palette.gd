## The template's functional colour roles, as a resource (`materials/palette.tres`).
##
## The world materials keep their own `base_color`/`accent_color` pairs so a wall and a
## path can hold different values; this resource is the shared role list for everything
## that needs one colour: the gate state, the HUD and the life pips. Restyle the UI and
## the goal state here, and the world through the shader parameters in `materials/*.tres`.
class_name GamePalette
extends Resource

## The darkest background value: sky, and the value the far walls fall back to.
@export var background_deep := Color(0.063, 0.086, 0.216)
## The far haze / wall value. Cooler and darker than the playfield.
@export var background_far := Color(0.173, 0.165, 0.271)
## The playfield's mid value: grass and the lit ground.
@export var playfield := Color(0.196, 0.259, 0.149)
## The low value under the playfield: dirt, deep stone and shadowed crevices.
@export var playfield_deep := Color(0.141, 0.102, 0.071)
## The hero's suit. The brightest warm shape in the frame.
@export var player := Color(0.93, 0.55, 0.22)
## The hero's visor and antenna accent.
@export var player_accent := Color(0.25, 0.85, 1.0)
## The one reserved warning hue: the lava and any new hazard.
@export var hazard := Color(1.0, 0.36, 0.23)
## Pickups: the relic crystal and its beam.
@export var pickup := Color(0.36, 0.95, 1.0)
## The open gate and its beacon. Locked uses `hazard`.
@export var goal := Color(0.45, 1.0, 0.72)
## UI accent: HUD labels and the control hint.
@export var ui_accent := Color(0.56, 0.71, 1.0)
## Outline and silhouette colour.
@export var ink := Color(0.078, 0.094, 0.125)
## Warm lantern light for the goal beacon and HUD highlights.
@export var glow := Color(1.0, 0.77, 0.42)
