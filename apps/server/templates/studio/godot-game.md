# Godot game

Adapted from OhMyGame's godot-game skill (Apache-2.0), plus local rules.

1. Godot 4.7, GL Compatibility renderer.
2. You have no local Godot binary: never look for one or run it. Check
   with `game_check`, re-import after asset changes with `game_import`,
   play with `game_explore_*`, build with `game_export`.
3. Keep the boot clean: no script errors, no parse errors. Engine shutdown
   noise after quit is not failure; anything while the game runs is.
4. Main scene set in project.godot. Controls are the named actions in
   project.godot `[input]` (TEMPLATE.md): read them with `Input.get_vector`
   and `Input.is_action_*`, never key codes, so the gamepad and the
   player's rebinding work.
5. Export checklist before calling it done: `game_export` succeeds for Web
   and Linux, and `game_check` reports every entry clean.
6. Work in ./godot plus VISION.md, PLAN.md and NOTES.md. Never commit,
   never reset git, never use subagents.

## The shell and the feel kit

The starter already has a title, pause, settings, end and credits screens
(TEMPLATE.md). Never build your own menus: put gameplay in
`scenes/game.tscn`, end a run with `GameState.win(text, stats)` or
`GameState.lose(text, stats)`, and restyle the shell instead of replacing it.
Answer every player action through `Juice` (shell/juice.gd): `shake`,
`hit_pause`, `pop`, `squash`, `flash`, `tint`, `burst`, `sfx`.
Spawn bullets and effects under your game scene (or `Juice.stage`), never
`get_tree().current_scene`, and never call `change_scene_to_file` or
`reload_current_scene`: the shell owns restarts. Retry resets every value in
game_state.gd; list the ones that must survive (best score, unlocks) in
`const KEEP_ACROSS_RUNS := [...]`; the shell saves those to user:// between
launches and Settings can reset them.
The title shows `assets/ui/title_bg.png` behind the menu once that file
exists: put the game's key art there (16:9), and the title stops looking like
a template.

## Godot 4 patterns (each verified on 4.7)

Godot 3 code fails the check. Use the Godot 4 form:
`export var` → `@export var`; `onready` → `@onready`; `KinematicBody2D` →
`CharacterBody2D`; `move_and_slide(v)` → set `velocity`, call
`move_and_slide()`; `yield(x, "s")` → `await x.s`; `connect("s", self, "f")`
→ `s.connect(f)`; `instance()` → `instantiate()`; `rand_range` →
`randf_range`; `OS.get_ticks_msec()` → `Time.get_ticks_msec()`; `Tween.new()`
→ `create_tween()`; `change_scene(p)` → `change_scene_to_file(p)`.

Free what you spawn: `queue_free()` removes a node for good; `remove_child`
alone, or a `Node.new()` never added, leaves an orphan. Bot results report
scene node and orphan counts: orphans that grow, or nodes that keep rising
while play stays in one place, are a leak to fix.

The starter declares `move_left`, `move_right`, `move_up`, `move_down`,
`jump`, `action`, `alt` and `pause` with keyboard and gamepad defaults.
Add the game's own action as one line under `[input]` (L key and gamepad
RB; the comment above the actions lists the codes), and delete the ones the
game never reads:

```
dash={"deadzone": 0.25, "events": [Object(InputEventKey,"device":-1,"physical_keycode":76), Object(InputEventJoypadButton,"device":-1,"button_index":10)]}
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
