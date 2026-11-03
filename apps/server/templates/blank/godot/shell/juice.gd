## Game feel, one call each. Autoloaded as `Juice`. Every player action wants
## an answer the player can see and hear; overlapping calls combine instead of
## fighting, and nothing here can leave the game stuck.
##
##   Juice.shake(0.4)                       # camera shake: trauma 0..1 adds up, decays
##   Juice.hit_pause()                      # ~60 ms time dip on a hit; overlaps extend it
##   Juice.pop(node)                        # quick scale-up and settle (pickups, UI, hits)
##   Juice.squash(node)                     # wide-and-short, springs back (jumps, landings)
##   Juice.flash(node)                      # flash white (or a color), fades back; 2D and 3D
##   Juice.tint(node, Color(1, 0.4, 0.4))   # tween a 2D node's modulate to a color
##   Juice.burst(position, Color.ORANGE)    # one-shot particles at a Vector2 or Vector3
##   Juice.sfx("res://assets/sfx/hit.wav")  # pooled one-shot on the SFX bus, slight pitch jitter
##
## A hit, all together: Juice.shake(0.3); Juice.hit_pause(); Juice.flash(enemy);
## Juice.burst(enemy.global_position); Juice.sfx(HIT_SOUND)
##
## The current Camera2D or Camera3D shakes through its offset (h_offset and
## v_offset in 3D), so the game's own camera code keeps working. pop and
## squash animate `scale`: face left with flip_h, not a negative scale, on a
## node you pop. flash and burst reach child sprites and meshes. Bursts spawn
## in the gameplay scene, so they freeze with it on pause.
extends Node

## Camera offset at full trauma, in pixels (2D) and world units (3D).
var shake_pixels := 14.0
var shake_units := 0.18
## Trauma lost per second.
var shake_decay := 1.6
## Where bursts spawn by default; the shell points it at the gameplay scene.
var stage: Node = null

const MAX_HIT_PAUSE_S := 0.3
const SFX_VOICES := 12
const MAX_FLASH_NODES := 32
const FLASH_SHADER := """
shader_type canvas_item;
uniform vec4 flash_color : source_color = vec4(1.0);
uniform float amount = 0.0;
void fragment() {
	vec4 c = texture(TEXTURE, UV) * COLOR;
	COLOR = vec4(mix(c.rgb, flash_color.rgb, amount * flash_color.a), c.a);
}
"""

var _trauma := 0.0
var _shake_time := 0.0
var _noise := FastNoiseLite.new()
var _cam2d: Camera2D = null
var _applied2d := Vector2.ZERO
var _cam3d: Camera3D = null
var _applied3d := Vector2.ZERO
var _last_state := ""
var _hit_until_ms := 0
var _scale_before := 1.0
var _voices: Array[AudioStreamPlayer] = []
var _next_voice := 0
var _streams := {}
var _flash_shader: Shader = null


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_noise.frequency = 0.9
	var bus := "SFX" if AudioServer.get_bus_index("SFX") >= 0 else "Master"
	for i in SFX_VOICES:
		var voice := AudioStreamPlayer.new()
		voice.bus = bus
		add_child(voice)
		_voices.append(voice)
	_last_state = GameState.state
	GameState.state_changed.connect(_on_state)


func shake(amount := 0.4) -> void:
	_trauma = clampf(_trauma + amount, 0.0, 1.0)


func hit_pause(seconds := 0.06, time_scale := 0.05) -> void:
	if GameState.state == "paused" or GameState.state == "ended":
		return
	if _hit_until_ms == 0:
		_scale_before = Engine.time_scale
	var until := Time.get_ticks_msec() + int(clampf(seconds, 0.0, MAX_HIT_PAUSE_S) * 1000.0)
	_hit_until_ms = maxi(_hit_until_ms, until)
	Engine.time_scale = minf(Engine.time_scale, time_scale)


func pop(node: Node, amount := 0.25, seconds := 0.2) -> void:
	var tween := _scale_tween(node)
	if tween == null:
		return
	var base: Variant = node.get_meta("_juice_scale")
	tween.tween_property(node, "scale", base * (1.0 + amount), seconds * 0.35).set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT)
	tween.tween_property(node, "scale", base, seconds * 0.65).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)


func squash(node: Node, amount := 0.3, seconds := 0.25) -> void:
	var tween := _scale_tween(node)
	if tween == null:
		return
	var base: Variant = node.get_meta("_juice_scale")
	var squashed: Variant = base * (Vector3(1.0 + amount, 1.0 - amount, 1.0 + amount) if base is Vector3 else Vector2(1.0 + amount, 1.0 - amount))
	tween.tween_property(node, "scale", squashed, seconds * 0.3).set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT)
	tween.tween_property(node, "scale", base, seconds * 0.7).set_trans(Tween.TRANS_ELASTIC).set_ease(Tween.EASE_OUT)


func flash(node: Node, color := Color.WHITE, seconds := 0.12) -> void:
	if not is_instance_valid(node):
		return
	var old: Variant = node.get_meta("_juice_flash") if node.has_meta("_juice_flash") else null
	if old is Tween and (old as Tween).is_valid():
		(old as Tween).kill()
	var targets := _flash_targets(node)
	if targets.is_empty():
		if node is CanvasItem:
			# Every sprite here has its own material: brighten through modulate.
			var item := node as CanvasItem
			var back := item.modulate
			var brighten := node.create_tween()
			node.set_meta("_juice_flash", brighten)
			item.modulate = Color(back.r * 2.5, back.g * 2.5, back.b * 2.5, back.a)
			brighten.tween_property(item, "modulate", back, seconds)
		return
	var material: Material
	if targets[0] is CanvasItem:
		if _flash_shader == null:
			_flash_shader = Shader.new()
			_flash_shader.code = FLASH_SHADER
		var shader_material := ShaderMaterial.new()
		shader_material.shader = _flash_shader
		shader_material.set_shader_parameter("flash_color", color)
		material = shader_material
	else:
		var overlay := StandardMaterial3D.new()
		overlay.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		overlay.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		overlay.albedo_color = color
		material = overlay
	material.set_meta("_juice", true)
	for target in targets:
		if target is CanvasItem:
			(target as CanvasItem).material = material
		else:
			(target as GeometryInstance3D).material_overlay = material
	var tween := node.create_tween()
	node.set_meta("_juice_flash", tween)
	tween.tween_method(_set_flash.bind(material, color), 1.0, 0.0, seconds)
	tween.tween_callback(_end_flash.bind(targets, material))


func tint(node: CanvasItem, color: Color, seconds := 0.3) -> void:
	if is_instance_valid(node):
		node.create_tween().tween_property(node, "modulate", color, seconds)


func burst(at: Variant, color := Color.WHITE, amount := 16, parent: Node = null) -> void:
	if parent == null:
		parent = stage if is_instance_valid(stage) else get_tree().current_scene
	if parent == null:
		return
	var ramp := Gradient.new()
	ramp.set_color(0, color)
	ramp.set_color(1, Color(color, 0.0))
	var particles: Node
	if at is Vector3:
		var p3 := CPUParticles3D.new()
		var mesh := SphereMesh.new()
		mesh.radius = 0.05
		mesh.height = 0.1
		mesh.radial_segments = 6
		mesh.rings = 3
		var look := StandardMaterial3D.new()
		look.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		look.vertex_color_use_as_albedo = true
		look.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		mesh.material = look
		p3.mesh = mesh
		p3.position = at
		p3.direction = Vector3.UP
		p3.spread = 180.0
		p3.gravity = Vector3(0, -9.0, 0)
		p3.initial_velocity_min = 2.0
		p3.initial_velocity_max = 5.0
		p3.scale_amount_min = 0.6
		p3.scale_amount_max = 1.4
		p3.color_ramp = ramp
		p3.amount = amount
		p3.lifetime = 0.6
		p3.one_shot = true
		p3.explosiveness = 1.0
		p3.emitting = true
		p3.top_level = true
		p3.finished.connect(p3.queue_free)
		particles = p3
	elif at is Vector2:
		var p2 := CPUParticles2D.new()
		p2.position = at
		p2.direction = Vector2.UP
		p2.spread = 180.0
		p2.gravity = Vector2(0, 500)
		p2.initial_velocity_min = 120.0
		p2.initial_velocity_max = 280.0
		p2.damping_min = 80.0
		p2.damping_max = 160.0
		p2.scale_amount_min = 3.0
		p2.scale_amount_max = 6.0
		p2.color_ramp = ramp
		p2.amount = amount
		p2.lifetime = 0.5
		p2.one_shot = true
		p2.explosiveness = 1.0
		p2.emitting = true
		p2.top_level = true
		p2.z_index = 10
		p2.finished.connect(p2.queue_free)
		particles = p2
	else:
		push_warning("Juice.burst needs a Vector2 or Vector3 position.")
		return
	# Deferred: bursts are usually spawned from physics callbacks.
	parent.add_child.call_deferred(particles)


## Plays a sound (an AudioStream or a res:// path) on a free pooled voice.
func sfx(sound: Variant, volume_db := 0.0, pitch_jitter := 0.08) -> AudioStreamPlayer:
	var stream: AudioStream = sound if sound is AudioStream else _stream(str(sound))
	if stream == null:
		return null
	var voice: AudioStreamPlayer = null
	for each in _voices:
		if not each.playing:
			voice = each
			break
	if voice == null:
		voice = _voices[_next_voice]
		_next_voice = (_next_voice + 1) % _voices.size()
	voice.stream = stream
	voice.volume_db = volume_db
	voice.pitch_scale = 1.0 + randf_range(-pitch_jitter, pitch_jitter)
	voice.play()
	return voice


func _process(delta: float) -> void:
	if _hit_until_ms != 0 and Time.get_ticks_msec() >= _hit_until_ms:
		_end_hit_pause()
	if get_tree().paused:
		return
	if _trauma <= 0.0 and _applied2d == Vector2.ZERO and _applied3d == Vector2.ZERO:
		return
	_trauma = maxf(_trauma - shake_decay * delta, 0.0)
	_shake_time += delta * 60.0
	var strength := _trauma * _trauma
	var wobble := Vector2(_noise.get_noise_2d(11.0, _shake_time), _noise.get_noise_2d(73.0, _shake_time)) * strength
	_shake_2d(wobble * shake_pixels)
	_shake_3d(wobble * shake_units)


func _shake_2d(offset: Vector2) -> void:
	var camera := get_viewport().get_camera_2d()
	if camera != _cam2d:
		if is_instance_valid(_cam2d):
			_cam2d.offset -= _applied2d
		_applied2d = Vector2.ZERO
		_cam2d = camera
	if camera == null:
		return
	camera.offset += offset - _applied2d
	_applied2d = offset


func _shake_3d(offset: Vector2) -> void:
	var camera := get_viewport().get_camera_3d()
	if camera != _cam3d:
		if is_instance_valid(_cam3d):
			_cam3d.h_offset -= _applied3d.x
			_cam3d.v_offset -= _applied3d.y
		_applied3d = Vector2.ZERO
		_cam3d = camera
	if camera == null:
		return
	camera.h_offset += offset.x - _applied3d.x
	camera.v_offset += offset.y - _applied3d.y
	_applied3d = offset


func _end_hit_pause() -> void:
	Engine.time_scale = _scale_before
	_hit_until_ms = 0


func _on_state(state: String) -> void:
	var was := _last_state
	_last_state = state
	if state != "playing" and _hit_until_ms != 0:
		_end_hit_pause()
	# The last hit's shake plays through the end beat; a new run starts still.
	if state == "title" or (state == "playing" and was == "ended"):
		_trauma = 0.0
		_shake_2d(Vector2.ZERO)
		_shake_3d(Vector2.ZERO)


func _scale_tween(node: Node) -> Tween:
	if not (node is Node2D or node is Node3D or node is Control):
		return null
	var old: Variant = node.get_meta("_juice_tween") if node.has_meta("_juice_tween") else null
	if old is Tween and (old as Tween).is_valid():
		(old as Tween).kill()
		node.set("scale", node.get_meta("_juice_scale"))
	node.set_meta("_juice_scale", node.get("scale"))
	if node is Control and (node as Control).pivot_offset == Vector2.ZERO:
		(node as Control).pivot_offset = (node as Control).size * 0.5
	var tween := node.create_tween()
	node.set_meta("_juice_tween", tween)
	return tween


## The node and its descendants that draw and carry no material of their own
## (2D) or no overlay of their own (3D), bounded.
func _flash_targets(node: Node) -> Array:
	var found: Array = []
	var pending: Array[Node] = [node]
	while not pending.is_empty() and found.size() < MAX_FLASH_NODES:
		var each: Node = pending.pop_front()
		if each is CanvasItem:
			var item := each as CanvasItem
			if item.material == null or item.material.has_meta("_juice"):
				found.append(item)
		elif each is GeometryInstance3D:
			var geometry := each as GeometryInstance3D
			if geometry.material_overlay == null or geometry.material_overlay.has_meta("_juice"):
				found.append(geometry)
		pending.append_array(each.get_children())
	# One kind per flash: a 2D node's 3D children (or the reverse) stay as they are.
	if not found.is_empty():
		var flat: bool = found[0] is CanvasItem
		found = found.filter(func(each: Node) -> bool: return (each is CanvasItem) == flat)
	return found


func _set_flash(amount: float, material: Material, color: Color) -> void:
	if material is ShaderMaterial:
		(material as ShaderMaterial).set_shader_parameter("amount", amount)
	else:
		(material as StandardMaterial3D).albedo_color = Color(color, color.a * amount)


func _end_flash(targets: Array, material: Material) -> void:
	for target in targets:
		if not is_instance_valid(target):
			continue
		if target is CanvasItem and (target as CanvasItem).material == material:
			(target as CanvasItem).material = null
		elif target is GeometryInstance3D and (target as GeometryInstance3D).material_overlay == material:
			(target as GeometryInstance3D).material_overlay = null


func _stream(path: String) -> AudioStream:
	if _streams.has(path):
		return _streams[path]
	var stream: AudioStream = null
	if ResourceLoader.exists(path):
		stream = load(path) as AudioStream
	if stream == null:
		push_warning("Juice.sfx: no sound at %s." % path)
	_streams[path] = stream
	return stream
