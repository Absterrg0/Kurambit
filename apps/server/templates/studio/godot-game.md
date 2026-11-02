# Godot game

Adapted from OhMyGame's godot-game skill (Apache-2.0), plus local rules.

1. Godot 4.7, GL Compatibility renderer.
2. You have no local Godot binary: never look for one or run it. Check
   with `game_check`, re-import after asset changes with `game_import`,
   play with `game_explore_*`, build with `game_export`.
3. Keep the boot clean: no script errors, no parse errors. Engine shutdown
   noise after quit is not failure; anything while the game runs is.
4. Main scene set in project.godot. Input actions in the project settings,
   not hardcoded keys in gameplay code.
5. Export checklist before calling it done: `game_export` succeeds for Web
   and Linux, and `game_check` reports every entry clean.
6. Work in ./godot plus VISION.md, PLAN.md and NOTES.md. Never commit,
   never reset git, never use subagents.

## Godot 4 patterns (each verified on 4.7)

Godot 3 code fails the check. Use the Godot 4 form:
`export var` → `@export var`; `onready` → `@onready`; `KinematicBody2D` →
`CharacterBody2D`; `move_and_slide(v)` → set `velocity`, call
`move_and_slide()`; `yield(x, "s")` → `await x.s`; `connect("s", self, "f")`
→ `s.connect(f)`; `instance()` → `instantiate()`; `rand_range` →
`randf_range`; `OS.get_ticks_msec()` → `Time.get_ticks_msec()`; `Tween.new()`
→ `create_tween()`; `change_scene(p)` → `change_scene_to_file(p)`.

An input action in project.godot (A key; 4194319 is the Left arrow):

```
[input]
move_left={
"deadzone": 0.2,
"events": [Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":0,"physical_keycode":65,"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)
]
}
```

A numbered PNG sequence as an animation, and a sound:

```gdscript
@onready var sprite: AnimatedSprite2D = $Sprite
func _ready() -> void:
	var frames := SpriteFrames.new()
	frames.add_animation("walk")
	frames.set_animation_speed("walk", 8.0)
	for i in 4:
		frames.add_frame("walk", load("res://assets/walk/walk_%d.png" % i))
	sprite.sprite_frames = frames
	sprite.play("walk")
	var sfx := AudioStreamPlayer.new()
	sfx.stream = preload("res://assets/sfx/hit.wav")
	add_child(sfx)
	sfx.play()
```

State with a change signal (GameState autoload):
`var score := 0:` then an indented `set(v):` that assigns and emits.
