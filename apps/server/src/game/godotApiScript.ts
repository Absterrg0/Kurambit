/**
 * Engine reflection for `game_godot_api`. Runs headlessly in an isolated
 * scratch project (no user scene, no autoloads): queries the installed
 * Godot's built-in ClassDB for one engine class and writes JSON. ClassDB
 * covers engine classes only, not script-defined classes or Variant builtin
 * types.
 */
export const GODOT_API_SCRIPT = `extends SceneTree

const MAX_METHODS := 80
const MAX_PROPERTIES := 80
const MAX_SIGNALS := 40
const MAX_CONSTANTS := 80
const MAX_SUGGESTIONS := 5

var _class_name := ""
var _filter := ""
var _result_path := ""

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	_class_name = args[0] if args.size() > 0 else ""
	_filter = args[1] if args.size() > 1 else ""
	_result_path = args[2] if args.size() > 2 else ""
	var payload := _query(_class_name, _filter.to_lower())
	_write(payload)
	quit(0 if payload.get("found", false) else 1)

func _matches(name: String, needle: String) -> bool:
	return needle.is_empty() or name.to_lower().contains(needle)

func _type_name(info: Dictionary, is_return: bool = false) -> String:
	var kind := int(info.get("type", TYPE_NIL))
	var named := str(info.get("class_name", ""))
	if kind == TYPE_OBJECT and not named.is_empty():
		return named
	if kind == TYPE_NIL:
		return "Variant" if not is_return or (int(info.get("usage", 0)) & PROPERTY_USAGE_NIL_IS_VARIANT) != 0 else "void"
	return type_string(kind)

func _method_signature(entry: Dictionary) -> String:
	var name := str(entry.get("name", "?"))
	var parts: Array = []
	var args: Array = entry.get("args", [])
	var defaults: Array = entry.get("default_args", [])
	for index in range(args.size()):
		var arg: Dictionary = args[index]
		var part := "%s: %s" % [str(arg.get("name", "?")), _type_name(arg)]
		var default_index := index - (args.size() - defaults.size())
		if default_index >= 0:
			part += " = " + var_to_str(defaults[default_index]).left(80)
		parts.append(part)
	if (int(entry.get("flags", 0)) & METHOD_FLAG_VARARG) != 0:
		parts.append("...")
	return "%s(%s) -> %s" % [name, ", ".join(parts), _type_name(entry.get("return", {}), true)]

func _query(requested_class: String, needle: String) -> Dictionary:
	var exists: bool = ClassDB.class_exists(requested_class)
	var parent: Variant = ClassDB.get_parent_class(requested_class) if exists else null
	var chain: Array = []
	if exists:
		var cursor: String = str(parent)
		while not cursor.is_empty():
			chain.append(cursor)
			cursor = str(ClassDB.get_parent_class(cursor))
	var methods: Array = []
	var total_methods := 0
	var properties: Array = []
	var total_properties := 0
	var signals: Array = []
	var total_signals := 0
	var constants: Array = []
	var total_constants := 0
	if exists:
		for entry in ClassDB.class_get_method_list(requested_class):
			if not (entry is Dictionary):
				continue
			var mname := str(entry.get("name", ""))
			if mname.begins_with("@"):
				continue
			if not _matches(mname, needle):
				continue
			total_methods += 1
			if methods.size() < MAX_METHODS:
				methods.append({"name": mname, "signature": _method_signature(entry)})
		for entry in ClassDB.class_get_property_list(requested_class):
			if not (entry is Dictionary):
				continue
			if (int(entry.get("usage", 0)) & (PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP)) != 0:
				continue
			var pname := str(entry.get("name", ""))
			if not _matches(pname, needle):
				continue
			total_properties += 1
			if properties.size() < MAX_PROPERTIES:
				properties.append({"name": pname, "type": _type_name(entry)})
		for entry in ClassDB.class_get_signal_list(requested_class):
			if not (entry is Dictionary):
				continue
			var sname := str(entry.get("name", ""))
			if not _matches(sname, needle):
				continue
			total_signals += 1
			if signals.size() < MAX_SIGNALS:
				signals.append({"name": sname, "signature": _method_signature(entry)})
		for cname in ClassDB.class_get_integer_constant_list(requested_class):
			var text := str(cname)
			if not _matches(text, needle):
				continue
			total_constants += 1
			if constants.size() < MAX_CONSTANTS:
				constants.append({"name": text, "value": int(ClassDB.class_get_integer_constant(requested_class, text))})
	var suggestions: Array = []
	if not exists:
		var matches: Array = []
		for candidate in ClassDB.get_class_list():
			var text := str(candidate)
			var score := text.to_lower().similarity(requested_class.to_lower())
			if score >= 0.35:
				matches.append({"name": text, "score": score})
		matches.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return a.score > b.score if a.score != b.score else a.name < b.name)
		for index in range(mini(MAX_SUGGESTIONS, matches.size())):
			suggestions.append(matches[index].name)
	var truncated: bool = methods.size() < total_methods or properties.size() < total_properties or signals.size() < total_signals or constants.size() < total_constants
	var message := ""
	if exists:
		message = "%s: %d method(s), %d properties, %d signal(s), %d constant(s)%s." % [requested_class, total_methods, total_properties, total_signals, total_constants, " (truncated)" if truncated else ""]
	else:
		message = "%s is not an engine class in ClassDB. ClassDB covers engine classes only, not script-defined classes or Variant builtin types." % requested_class
	return {
		"className": requested_class,
		"engineVersion": str(Engine.get_version_info().get("string", "unknown")),
		"found": exists,
		"parent": (str(parent) if parent != null and str(parent) != "" else null),
		"inheritance": chain,
		"methods": methods,
		"totalMethods": total_methods,
		"properties": properties,
		"totalProperties": total_properties,
		"signals": signals,
		"totalSignals": total_signals,
		"constants": constants,
		"totalConstants": total_constants,
		"truncated": truncated,
		"suggestions": suggestions,
		"message": message,
	}

func _write(result: Dictionary) -> void:
	if _result_path.is_empty():
		return
	var file := FileAccess.open(_result_path, FileAccess.WRITE)
	if file == null:
		return
	file.store_string(JSON.stringify(result))
	file.close()
`;
