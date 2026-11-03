## Strips from game_blender_render_sprites on an AnimatedSprite2D. Each render
## writes `<output>.sprite.json` beside its frames (frame size, fps, loop and
## the anchor per view); this turns them into one SpriteFrames, each strip at
## its own speed, and offsets the sprite so the node origin is the feet (or the
## centre) in every animation.
##
##   @onready var sprite: AnimatedSprite2D = $Sprite
##   func _ready() -> void:
##       SpriteStrips.apply(sprite, {
##           "idle": "res://assets/sprites/hero_idle.sprite.json",
##           "walk": "res://assets/sprites/hero_walk.sprite.json",
##       }, "right")                        # the view rendered; flip_h faces left
##   # every frame: sprite.play("walk" if moving else "idle")
##
## Run game_import after a render so the frames load.
class_name SpriteStrips
extends RefCounted


static func apply(sprite: AnimatedSprite2D, strips: Dictionary, view := "") -> SpriteFrames:
	var frames := SpriteFrames.new()
	frames.remove_animation("default")
	var offsets := {}
	for animation in strips:
		var path: String = strips[animation]
		var manifest := _manifest(path)
		if manifest.is_empty():
			continue
		var views: Dictionary = manifest.get("views", {})
		var chosen: String = view if views.has(view) else str(views.keys()[0]) if not views.is_empty() else ""
		if chosen == "":
			push_warning("SpriteStrips: %s has no views" % path)
			continue
		if view != "" and chosen != view:
			push_warning("SpriteStrips: %s has no view \"%s\"; using %s (views: %s)" % [path, view, chosen, ", ".join(views.keys())])
		var strip: Dictionary = views[chosen]
		frames.add_animation(animation)
		frames.set_animation_speed(animation, maxf(float(manifest.get("fps", 12.0)), 1.0))
		frames.set_animation_loop(animation, bool(manifest.get("loop", true)))
		for file in strip.get("frames", []):
			var texture := load(path.get_base_dir().path_join(str(file))) as Texture2D
			if texture == null:
				push_warning("SpriteStrips: no frame %s (run game_import after rendering)" % file)
				continue
			frames.add_frame(animation, texture)
		# Centred frames: move the drawing so the anchor lands on the node origin.
		var anchor: Dictionary = strip.get("anchor", {})
		var size := Vector2(float(manifest.get("frameWidth", 0)), float(manifest.get("frameHeight", 0)))
		offsets[animation] = size / 2.0 - Vector2(float(anchor.get("x", size.x / 2.0)), float(anchor.get("y", size.y / 2.0)))
	sprite.sprite_frames = frames
	sprite.centered = true
	var follow := func() -> void: sprite.offset = offsets.get(sprite.animation, sprite.offset)
	sprite.animation_changed.connect(follow)
	if frames.get_animation_names().size() > 0:
		sprite.play(frames.get_animation_names()[0])
	follow.call()
	return frames


static func _manifest(path: String) -> Dictionary:
	var text := FileAccess.get_file_as_string(path)
	var data: Variant = JSON.parse_string(text) if text != "" else null
	if data is Dictionary:
		return data
	push_warning("SpriteStrips: cannot read %s" % path)
	return {}
