/**
 * The check script Godot runs headlessly for `game_check`. It is a
 * string, not an asset, so the packed server archive carries it without a
 * second asset-copy rule. GameService writes it under the game's ignored
 * `builds/logs/` tree and passes the result path and the game's declared
 * gameplay scene after `--`. Layout visibility diagnostics ride the same
 * warnings channel: clipped or overlapped interactive controls warn, never fail.
 * The geometry probe itself lives in godotLayoutScanner.ts; this script keeps
 * its warning channel, its viewport init and its font diagnostics.
 */
import { GODOT_LAYOUT_SCANNER } from "./godotLayoutScanner.ts";

export const GODOT_CHECK_SCRIPT = `extends SceneTree

${GODOT_LAYOUT_SCANNER}

const PHYSICS_FRAMES := 120
const MAX_ISSUES := 100
# Bounded font-coverage diagnostic: a missing glyph draws as a hex box but never
# fails the check. Live controls are inspected with the real Font API; source
# string mentions are reported only as potential risk, never as proof.
const FONT_MAX_WARNINGS := 10
const FONT_MAX_NODES := 300
const FONT_MAX_TEXT_CHARS := 500
const FONT_MAX_SOURCE_FILES := 30
const FONT_MAX_SOURCE_BYTES := 200000
const FONT_MAX_SOURCE_CHARS := 20000
# Bounded layout-visibility diagnostic: interactive controls that are clipped
# by an ancestor, hang off the viewport, or sit under a later sibling warn but
# never fail the check. Fully scrolled-out ScrollContainer children are normal
# and stay silent; hidden, disabled, rotated/mirrored, and zero-size controls
# are skipped as unknown rather than claimed covered or broken (see
# godotLayoutScanner.ts).

var _errors: Array = []
var _warnings: Array = []
var _result_path := ""
var _main_scene := ""
var _gameplay_scene := ""
var _entries: Array = []
var _seen_warnings := {}
var _font_warnings := 0
var _font_nodes_seen := 0
var _font_reported := {}
var _fallback_font: Font = null
var _layout_state := {"warnings": 0, "pairs": 0, "inspected": 0}
var _layout_scene := ""

func _initialize() -> void:
	# Custom headless SceneTrees otherwise keep a 64x64 root, irrespective of
	# the project's logical window size; layout diagnostics must use that size.
	await process_frame
	root.size = Vector2i(int(ProjectSettings.get_setting("display/window/size/viewport_width", 1152)), int(ProjectSettings.get_setting("display/window/size/viewport_height", 648)))
	var args := OS.get_cmdline_user_args()
	_result_path = args[0] if args.size() > 0 else ""
	_gameplay_scene = args[1] if args.size() > 1 else ""
	_main_scene = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	var scripts: Array = []
	var resources: Array = []
	_collect_files("res://", scripts, resources, _excluded_everywhere())
	for file in scripts:
		var script := load(file)
		if script == null:
			_add_error(file, "Failed to load script.")
		elif script is GDScript and not script.can_instantiate():
			_add_error(file, "Script does not compile.")
	for file in resources:
		if load(file) == null:
			_add_error(file, "Failed to load resource.")
	_lint_inputs(scripts)
	# The menu alone proves nothing about gameplay: a failure in Player._ready()
	# only shows once the scene the menu starts is instantiated and stepped.
	await _run_entry(_main_scene, "main", "main scene")
	if not _gameplay_scene.is_empty():
		await _run_entry(_gameplay_scene, "gameplay", "gameplay scene")
	_lint_font_sources(scripts)
	_write_result()
	quit(0 if _errors.is_empty() else 1)

# Godot's own reading of what is part of the project: a folder holding
# .gdignore is invisible to the editor, and a file every export preset
# excludes never ships, so neither can fail the check.
func _excluded_everywhere() -> Array:
	var presets := ConfigFile.new()
	if presets.load("res://export_presets.cfg") != OK:
		return []
	var lists: Array = []
	for section in presets.get_sections():
		if not (section.begins_with("preset.") and section.count(".") == 1):
			continue
		var patterns: Array = []
		for each in str(presets.get_value(section, "exclude_filter", "")).split(",", false):
			var pattern := each.strip_edges()
			if not pattern.is_empty():
				patterns.append(pattern)
		lists.append(patterns)
	return lists

func _excluded(full: String, name: String, lists: Array) -> bool:
	if lists.is_empty():
		return false
	var relative := full.trim_prefix("res://")
	for patterns in lists:
		var hit := false
		for pattern in patterns:
			if relative.matchn(pattern) or name.matchn(pattern):
				hit = true
				break
		if not hit:
			return false
	return true

func _collect_files(path: String, scripts: Array, resources: Array, excluded: Array) -> void:
	if FileAccess.file_exists(path.path_join(".gdignore")):
		return
	var directory := DirAccess.open(path)
	if directory == null:
		return
	directory.list_dir_begin()
	while true:
		var name := directory.get_next()
		if name.is_empty():
			break
		if name.begins_with("."):
			continue
		var full := path.path_join(name)
		if directory.current_is_dir():
			_collect_files(full, scripts, resources, excluded)
		elif _excluded(full, name, excluded):
			continue
		elif name.ends_with(".gd"):
			scripts.append(full)
		elif name.ends_with(".tscn") or name.ends_with(".tres"):
			resources.append(full)
	directory.list_dir_end()

func _lint_inputs(files: Array) -> void:
	var pattern := RegEx.new()
	pattern.compile("Input\\\\.(?:is_action(?:_pressed|_just_pressed|_just_released)?|get_action_strength|get_action_raw_strength|action_press|action_release|get_vector)\\\\(\\\\s*\\"([^\\"]+)\\"")
	var seen := {}
	for file in files:
		var text := FileAccess.get_file_as_string(file)
		for found in pattern.search_all(text):
			var action := found.get_string(1)
			if seen.has(action):
				continue
			seen[action] = true
			if not InputMap.has_action(action):
				_add_warning(file, "Input action \\"%s\\" is used but not defined in the InputMap." % action)

func _run_entry(scene_path: String, label: String, noun: String) -> void:
	if scene_path.is_empty():
		_add_error("project.godot", "No %s is configured." % noun)
		return
	var packed := load(scene_path) as PackedScene
	if packed == null:
		_add_error(scene_path, "The %s does not load." % noun)
		return
	var instance := packed.instantiate()
	if instance == null:
		_add_error(scene_path, "The %s does not instantiate." % noun)
		return
	_entries.append(label)
	root.add_child(instance)
	for i in PHYSICS_FRAMES:
		await physics_frame
	if not is_instance_valid(instance):
		_add_error(scene_path, "The %s freed itself during its first %d physics frames." % [noun, PHYSICS_FRAMES])
		return
	await _lint_tree(instance, scene_path, label)
	if instance.get_parent() != null:
		instance.queue_free()
		# Let the freed tree leave the scene before the next entry adds its own.
		await process_frame

func _lint_tree(instance: Node, scene_path: String, label: String) -> void:
	# A main scene that is only a menu around a separately declared gameplay
	# scene has no camera of its own; the gameplay entry is where one belongs.
	var menu_only := label == "main" and not _gameplay_scene.is_empty() and _gameplay_scene != _main_scene
	if not menu_only and not _tree_has_camera(instance):
		_add_warning(scene_path, "No Camera2D or Camera3D in this scene tree.")
	_lint_nodes(instance, scene_path)
	_lint_control_fonts(instance, scene_path)
	# Containers sort and scroll containers settle on idle frames, not physics
	# frames, so let a few pass before measuring on-screen geometry.
	for i in 3:
		await process_frame
	_lint_control_layout(instance, scene_path)

func _tree_has_camera(node: Node) -> bool:
	if node is Camera2D or node is Camera3D:
		return true
	for child in node.get_children():
		if _tree_has_camera(child):
			return true
	return false

func _lint_nodes(node: Node, scene_path: String) -> void:
	if node is CharacterBody2D or node is CharacterBody3D:
		# The player is the one body a game cannot ship broken. Only a direct,
		# enabled collision shape with a real shape moves it; a decorative shape
		# nested elsewhere does not count.
		if node.is_in_group("player"):
			if not _has_usable_collider(node):
				_add_error(scene_path, "%s is in the player group but has no direct, enabled CollisionShape with a shape; it cannot collide." % _node_path(node))
		elif _find_collision(node) == null:
			_add_warning(_node_path(node), "%s has no CollisionShape child; it cannot collide." % node.get_class())
	for child in node.get_children():
		_lint_nodes(child, scene_path)

func _has_usable_collider(node: Node) -> bool:
	for child in node.get_children():
		if child is CollisionShape2D:
			if not child.disabled and child.shape != null:
				return true
		elif child is CollisionShape3D:
			if not child.disabled and child.shape != null:
				return true
	return false

func _find_collision(node: Node) -> Node:
	for child in node.get_children():
		if child is CollisionShape2D or child is CollisionShape3D:
			return child
		var nested := _find_collision(child)
		if nested != null:
			return nested
	return null

func _node_path(node: Node) -> String:
	if node == root:
		return "."
	return str(root.get_path_to(node))

# Font coverage is diagnostic-only: warnings, never errors. Live text on Label,
# Button and RichTextLabel is checked with the real Font.has_char against the
# resolved font, but only when the control is safely known to use the default
# fallback (no LabelSettings font, no theme font override, and the effective
# theme font is the fallback itself). Anything custom is skipped as unknown
# rather than claimed covered or missing.
func _lint_control_fonts(node: Node, scene_path: String) -> void:
	if _fallback_font == null:
		_fallback_font = ThemeDB.fallback_font
	if _fallback_font == null:
		return
	_scan_control_fonts(node, scene_path)

func _scan_control_fonts(node: Node, scene_path: String) -> void:
	if _font_warnings >= FONT_MAX_WARNINGS or _font_nodes_seen >= FONT_MAX_NODES:
		return
	_font_nodes_seen += 1
	if node is Label:
		_lint_label_text(node, scene_path)
	elif node is Button:
		_lint_button_text(node, scene_path)
	elif node is RichTextLabel:
		_lint_rich_text(node, scene_path)
	for child in node.get_children():
		if _font_warnings >= FONT_MAX_WARNINGS or _font_nodes_seen >= FONT_MAX_NODES:
			return
		_scan_control_fonts(child, scene_path)

func _lint_label_text(node: Label, scene_path: String) -> void:
	var settings = node.label_settings
	if settings != null and settings.font != null:
		return
	if node.has_theme_font_override('font'):
		return
	var effective = node.get_theme_font('font', 'Label')
	if effective != null and effective != _fallback_font:
		return
	_lint_live_text(str(node.text), scene_path, 'Label "' + node.name + '" (' + _node_path(node) + ')')

func _lint_button_text(node: Button, scene_path: String) -> void:
	if node.has_theme_font_override('font'):
		return
	var effective = node.get_theme_font('font', 'Button')
	if effective != null and effective != _fallback_font:
		return
	_lint_live_text(str(node.text), scene_path, 'Button "' + node.name + '" (' + _node_path(node) + ')')

func _lint_rich_text(node: RichTextLabel, scene_path: String) -> void:
	for font_name in ['normal_font', 'bold_font', 'italics_font', 'bold_italics_font', 'mono_font']:
		if node.has_theme_font_override(font_name):
			return
	var effective = node.get_theme_font('normal_font', 'RichTextLabel')
	if effective != null and effective != _fallback_font:
		return
	_lint_live_text(str(node.text), scene_path, 'RichTextLabel "' + node.name + '" (' + _node_path(node) + ')')

func _lint_live_text(text: String, scene_path: String, subject: String) -> void:
	if text.is_empty():
		return
	var shown := text.left(FONT_MAX_TEXT_CHARS)
	var i := 0
	while i < shown.length():
		if _font_warnings >= FONT_MAX_WARNINGS:
			return
		var code := shown.unicode_at(i)
		i += 1
		if code < 128:
			continue
		var key := scene_path + ':' + str(code)
		if _font_reported.has(key):
			continue
		_font_reported[key] = true
		if _fallback_font.has_char(code):
			continue
		var tag: String = 'U+%04X' % code
		_add_warning(scene_path, subject + ' shows ' + tag + ' "' + String.chr(code) + '" which the default fallback font lacks; it is likely to render as a missing-glyph box.')
		_font_warnings += 1

# Dynamic draw_string text may never appear on boot, so .gd sources are scanned
# for double-quoted string mentions of glyphs the default fallback lacks. These
# are explicitly potential risk, not proof the characters render or that a
# custom font lacks them. Full-line comments are skipped; the scan reads at most
# a bounded prefix of a bounded number of bounded-size files and never writes.
func _lint_font_sources(scripts: Array) -> void:
	if _fallback_font == null:
		_fallback_font = ThemeDB.fallback_font
	if _fallback_font == null:
		return
	var files := 0
	for file in scripts:
		if _font_warnings >= FONT_MAX_WARNINGS:
			return
		if files >= FONT_MAX_SOURCE_FILES:
			return
		if not (file is String):
			continue
		var path: String = file
		if not path.begins_with('res://'):
			continue
		if path.contains('..'):
			continue
		files += 1
		var handle := FileAccess.open(path, FileAccess.READ)
		if handle == null:
			continue
		if handle.get_length() > FONT_MAX_SOURCE_BYTES:
			handle.close()
			continue
		var raw := handle.get_as_text()
		handle.close()
		if raw.is_empty():
			continue
		_lint_font_source_text(path, raw.left(FONT_MAX_SOURCE_CHARS))

func _lint_font_source_text(path: String, text: String) -> void:
	for line in text.split("\\n"):
		if _font_warnings >= FONT_MAX_WARNINGS:
			return
		if line.strip_edges().begins_with('#'):
			continue
		var parts := line.split('"')
		var index := 1
		while index < parts.size():
			if _font_warnings >= FONT_MAX_WARNINGS:
				return
			_lint_font_source_part(path, str(parts[index]))
			index += 2

func _lint_font_source_part(path: String, literal: String) -> void:
	var shown := literal.left(FONT_MAX_TEXT_CHARS)
	var i := 0
	while i < shown.length():
		if _font_warnings >= FONT_MAX_WARNINGS:
			return
		var code := shown.unicode_at(i)
		i += 1
		if code < 128:
			continue
		var key := path + ':' + str(code)
		if _font_reported.has(key):
			continue
		_font_reported[key] = true
		if _fallback_font.has_char(code):
			continue
		var tag: String = 'U+%04X' % code
		_add_warning(path, 'Source mentions ' + tag + ' "' + String.chr(code) + '" which the default fallback font lacks; potential missing-glyph risk if drawn with the default font (not proof it appears on screen or that a custom font covers it).')
		_font_warnings += 1

# Layout visibility is diagnostic-only: warnings, never errors. The shared
# probe measures real Control geometry through the viewport and canvas chain;
# this script only routes its reports into the checker's warnings channel.
func _lint_control_layout(node: Node, scene_path: String) -> void:
	_layout_scene = scene_path
	gs_layout_scan_entry(node, root, Callable(self, '_layout_check_report'), _layout_state)

func _layout_check_report(_kind: String, subject: String, detail: String, _node_path: String) -> void:
	# Kind and node path ride to the scenario runner's findings; the checker
	# only needs the warning text on its existing channel.
	_add_warning(_layout_scene, subject + detail)

func _add_error(file: String, message: String) -> void:
	if _errors.size() < MAX_ISSUES:
		_errors.append({"file": file, "message": message})

func _add_warning(file: String, message: String) -> void:
	var key := file + ":" + message
	if _warnings.size() < MAX_ISSUES and not _seen_warnings.has(key):
		_seen_warnings[key] = true
		_warnings.append({"file": file, "message": message})

func _write_result() -> void:
	if _result_path.is_empty():
		return
	var file := FileAccess.open(_result_path, FileAccess.WRITE)
	if file == null:
		return
	file.store_string(JSON.stringify({
		"mainScene": _main_scene,
		"gameplayScene": _gameplay_scene,
		"entries": _entries,
		"errors": _errors,
		"warnings": _warnings,
	}))
	file.close()
`;
