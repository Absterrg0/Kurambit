## The template's functional colour roles, as a resource (`assets/palette.tres`).
##
## Restyle through these roles first: they are what the runtime effects and the HUD read,
## and `tools/generate_art.mjs` writes this file from the same palette that draws the
## tiles and sprites, so the two cannot drift. A full restyle edits the palette object in
## that generator and reruns it plus `tools/build_resources.gd`.
class_name GamePalette
extends Resource

## The darkest background value; also the colour the screen fades into at the bottom.
@export var background_deep := Color(0.071, 0.075, 0.169)
## The mass of the far parallax band. Kept darker and less saturated than the playfield.
@export var background_far := Color(0.173, 0.145, 0.286)
## The playfield's mid value: the grass band and the first soil row read at this level.
@export var playfield := Color(0.373, 0.604, 0.290)
## Below the first soil row, so the foreground never competes with the player.
@export var playfield_deep := Color(0.180, 0.114, 0.075)
## The hero's brightest material; the player must sit above every other value.
@export var player := Color(0.561, 0.969, 0.918)
## The hero's warm accent (scarf), used for the lantern glow around the player.
@export var player_accent := Color(0.949, 0.463, 0.235)
## The one reserved warning hue. Only hazards use it.
@export var hazard := Color(1.0, 0.357, 0.227)
## Pickups: bright, warm and saturated, but below the hazard's urgency.
@export var pickup := Color(1.0, 0.824, 0.290)
## The goal's glow. Cool and distinct from every pickup, so the exit reads as a place.
@export var goal := Color(0.388, 0.847, 0.941)
## Accent for HUD labels and focus rings.
@export var ui_accent := Color(0.714, 0.745, 0.878)
## The outline colour used across the art.
@export var ink := Color(0.098, 0.071, 0.157)
## Warm light colour for glows and the landmark lanterns.
@export var glow := Color(0.965, 0.875, 0.682)
