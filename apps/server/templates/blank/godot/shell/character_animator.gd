## Character animation by state for a 3D model (a library GLB instanced as a
## scene). Choose the state from gameplay every frame and call play(state);
## this finds the clip under the model's AnimationPlayer, crossfades, plays
## one-shots through and returns to the loop.
##
##   @onready var anim := CharacterAnimator.on($Model)   # $Model: the instanced GLB
##   func _physics_process(delta: float) -> void:
##       var speed := Vector2(velocity.x, velocity.z).length()
##       anim.play("fall" if not is_on_floor() else "run" if speed > 4.0 else "walk" if speed > 0.1 else "idle",
##           {"speed": maxf(speed / 3.0, 0.6)})   # playback rate: moving speed / the clip's own
##       if Input.is_action_just_pressed("attack"):
##           anim.play("attack")                 # one-shot, then back to the loop
##
## States: idle, walk, run, jump, fall, attack, hit, die, or any word in a clip
## name ("dance", "roll"). Names match by word, case-insensitive: "Idle",
## "Walk_Loop", "CharacterArmature|Run", "attack-melee-right". A missing run
## plays walk, then idle (fall plays jump); each miss warns once with the clips
## the model has. jump, attack and hit play once each time the state is entered
## (asked for again, they hold their last pose), then the loop asked for
## meanwhile takes over; die plays once and holds until revive(). `clips` lists
## the clip names, and the output shows which clip each role got.
class_name CharacterAnimator
extends RefCounted

const ROLES := {
	"idle": ["idle", "fly", "flying", "hover"],
	"walk": ["walk", "walking"],
	"run": ["run", "running", "jog", "sprint"],
	"jump": ["jump"],
	"fall": ["fall", "falling", "air", "airborne"],
	"attack": ["attack", "punch", "slash", "swing", "melee", "kick", "shoot"],
	"hit": ["hit", "hurt", "damage", "recievehit", "receivehit"],
	"die": ["die", "death", "dead", "defeat", "dying"],
}
const FALLBACK := {"run": "walk", "walk": "idle", "fall": "jump", "jump": "idle"}
const ONCE := ["attack", "hit", "die", "jump"]
## Words that say nothing about the motion; any other word makes a clip a
## variant ("Idle_Talking_Loop" loses to "Idle_Loop").
const FILLER := ["loop", "anim", "animation", "fwd", "forward", "inplace", "cycle"]
## Clips with these words are held poses or guards, never a role's pick
## (KayKit's "Block_Attack" is not its attack); play them by their own word.
const NOT_A_ROLE := ["block", "blocking", "pose", "aiming", "reload"]

var player: AnimationPlayer
var clips: PackedStringArray = []
## Seconds each change blends over.
var fade := 0.2
var state := ""

var _resolved := {}
var _warned := {}
var _loop_state := "idle"
var _loop_speed := 1.0
var _current := ""
var _current_once := false
var _done := false
var _held := false
var _asked := ""


## The animator for a model: the first AnimationPlayer under `model`.
static func on(model: Node) -> CharacterAnimator:
	var found := model.find_children("*", "AnimationPlayer", true, false)
	if model is AnimationPlayer:
		found.insert(0, model)
	var animator := CharacterAnimator.new()
	if found.is_empty():
		push_warning("CharacterAnimator: no AnimationPlayer under %s" % model.name)
		return animator
	animator.player = found[0]
	# Every instance of one GLB shares its Animation resources and _start sets
	# loop_mode on them, so each animator plays its own copies: one character's
	# one-shot must never stop another's loop.
	for library_name in animator.player.get_animation_library_list():
		var library := animator.player.get_animation_library(library_name)
		var own := AnimationLibrary.new()
		for clip_name in library.get_animation_list():
			own.add_animation(clip_name, library.get_animation(clip_name).duplicate())
		animator.player.remove_animation_library(library_name)
		animator.player.add_animation_library(library_name, own)
	animator.clips = animator.player.get_animation_list()
	animator.player.animation_finished.connect(animator._on_finished)
	var roles: PackedStringArray = []
	for role in ROLES:
		var clip := find_clip(animator.clips, role)
		roles.append("%s=%s" % [role, clip if clip != "" else "-"])
	print("CharacterAnimator: clips %s; %s" % [", ".join(animator.clips), " ".join(roles)])
	animator.play("idle")
	return animator


## The clip for a role: one whose words hold a role keyword, fewest extra words, earliest keyword.
static func find_clip(names: PackedStringArray, wanted: String) -> String:
	var keys: Array = ROLES.get(wanted, [wanted.to_lower()])
	var best := ""
	var best_score := 1 << 30
	for clip in names:
		var w := _words(clip)
		if ROLES.has(wanted) and NOT_A_ROLE.any(func(x): return x in w):
			continue
		var k := -1
		for i in keys.size():
			if keys[i] in w:
				k = i
				break
		if k < 0:
			continue
		var extra := 0
		for x in w:
			# A lone letter is a variant tag ("Hit_A"), not another motion.
			if not (x in keys) and not (x in FILLER) and x.length() > 1:
				extra += 1
		if extra * 10 + k < best_score:
			best_score = extra * 10 + k
			best = clip
	return best


static func _words(clip: String) -> PackedStringArray:
	var name := clip.get_slice("|", clip.get_slice_count("|") - 1)
	var split := RegEx.create_from_string("([a-z])([A-Z])").sub(name, "$1 $2", true).to_lower()
	var out: PackedStringArray = []
	for part in RegEx.create_from_string("[a-z]+").search_all(split):
		out.append(part.get_string())
	return out


func play(wanted: String, options := {}) -> void:
	var entered := wanted != _asked
	_asked = wanted
	if player == null or _held:
		return
	var once: bool = options.get("once", wanted in ONCE)
	var clip := _clip_for(wanted)
	if clip == "":
		return
	var speed: float = options.get("speed", 1.0)
	if once:
		if not entered and _current == clip:
			return
		if wanted == "die":
			_held = true
		_start(wanted, clip, true, speed, options.get("fade", fade))
		return
	_loop_state = wanted
	_loop_speed = speed
	# A one-shot plays through; the loop asked for meanwhile follows it.
	if _current_once and not _done:
		return
	if _current == clip and not _current_once:
		state = wanted
		player.speed_scale = speed
		if not player.is_playing():
			player.play(clip)
		return
	_start(wanted, clip, false, speed, options.get("fade", fade))


## Back to playing after die (a respawn).
func revive() -> void:
	_held = false
	_asked = ""
	_current = ""
	play("idle")


func _start(wanted: String, clip: String, once: bool, speed: float, blend: float) -> void:
	var animation := player.get_animation(clip)
	animation.loop_mode = Animation.LOOP_NONE if once else Animation.LOOP_LINEAR
	# Loop to loop keeps the step phase (walk to run lands on the same foot).
	var phase := -1.0
	if not once and not _current_once and _current != "" and _current != clip and player.current_animation_length > 0.0:
		phase = player.current_animation_position / player.current_animation_length
	player.play(clip, blend)
	if phase >= 0.0:
		player.seek(phase * animation.length, true)
	player.speed_scale = speed
	_current = clip
	_current_once = once
	_done = false
	state = wanted


func _clip_for(wanted: String) -> String:
	if _resolved.has(wanted):
		return _resolved[wanted]
	var clip := ""
	var s := wanted
	while s != "":
		clip = find_clip(clips, s)
		if clip != "":
			break
		s = FALLBACK.get(s, "")
	if clip == "" and (wanted == "idle" or not ROLES.has(wanted) or FALLBACK.has(wanted)):
		clip = find_clip(clips, "idle")
		if clip == "" and not clips.is_empty():
			clip = clips[0]
	if clip != find_clip(clips, wanted) and not _warned.has(wanted):
		_warned[wanted] = true
		push_warning("CharacterAnimator: no \"%s\" clip%s; clips: %s" % [wanted, "" if clip == "" else ", playing " + clip, ", ".join(clips)])
	_resolved[wanted] = clip
	return clip


func _on_finished(clip: StringName) -> void:
	if String(clip) != _current or not _current_once:
		return
	_done = true
	# Still asked for (airborne in a jump): hold the last pose until the game moves on.
	if _held or _asked == state:
		return
	var next := _clip_for(_loop_state)
	if next != "":
		_start(_loop_state, next, false, _loop_speed, fade)
