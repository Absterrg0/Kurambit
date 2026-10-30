import * as Schema from "effect/Schema";

/**
 * The GDScript Godot runs headlessly for library PBR materials. It is static
 * text, not an asset, so the packed server carries it without a second
 * asset-copy rule. It builds one StandardMaterial3D from the imported maps
 * with the engine's own resources: albedo as colour data, the OpenGL normal
 * and roughness as non-colour data, so callers never handwrite .tres text.
 */
export const GODOT_ASSET_MATERIAL_SCRIPT = `extends SceneTree

var _request_path := ""
var _result_path := ""

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	_request_path = args[0] if args.size() > 0 else ""
	_result_path = args[1] if args.size() > 1 else ""
	var outcome := _build()
	_write_result(outcome)
	quit(0 if outcome.has("material") else 1)

func _build() -> Dictionary:
	if _request_path.is_empty():
		return {"error": "No request file was given."}
	var file := FileAccess.open(_request_path, FileAccess.READ)
	if file == null:
		return {"error": "The request file does not read."}
	var request: Variant = JSON.parse_string(file.get_as_text())
	if not (request is Dictionary):
		return {"error": "The request file is not a JSON object."}
	var albedo := load(str(request.get("albedoResPath", ""))) as Texture2D
	if albedo == null:
		return {"error": "The albedo map does not load: %s." % str(request.get("albedoResPath", ""))}
	var normal_map := load(str(request.get("normalResPath", ""))) as Texture2D
	if normal_map == null:
		return {"error": "The normal map does not load: %s." % str(request.get("normalResPath", ""))}
	var roughness_map := load(str(request.get("roughnessResPath", ""))) as Texture2D
	if roughness_map == null:
		return {"error": "The roughness map does not load: %s." % str(request.get("roughnessResPath", ""))}
	var material := StandardMaterial3D.new()
	material.resource_name = str(request.get("materialName", "library_material"))
	material.albedo_texture = albedo
	material.normal_enabled = true
	material.normal_texture = normal_map
	material.normal_scale = 1.0
	material.roughness_texture = roughness_map
	material.roughness = 1.0
	material.metallic = float(request.get("metallic", 0.0))
	var uv_scale: Array = request.get("uvScale", [1.0, 1.0])
	var sx := float(uv_scale[0]) if uv_scale.size() > 0 else 1.0
	var sy := float(uv_scale[1]) if uv_scale.size() > 1 else 1.0
	material.uv1_scale = Vector3(sx, sy, 1.0)
	var output := str(request.get("outputPath", ""))
	if output.is_empty():
		return {"error": "The request names no output path."}
	var existing_path := str(request.get("existingPath", ""))
	var reused := FileAccess.file_exists(existing_path)
	if reused:
		var previous := load(existing_path) as StandardMaterial3D
		if previous == null:
			return {"error": "The existing material was modified; move it aside to regenerate. It was not overwritten."}
		var ignore := {
			"resource_path": true,
			"resource_scene_unique_id": true,
		}
		for prop in material.get_property_list():
			var usage := int(prop.get("usage", 0))
			if (usage & PROPERTY_USAGE_STORAGE) == 0:
				continue
			var pname := str(prop.get("name", ""))
			if pname.is_empty() or ignore.has(pname):
				continue
			var expected = material.get(pname)
			var actual = previous.get(pname)
			if expected is Texture2D or actual is Texture2D:
				var exp_path := ""
				var act_path := ""
				if expected is Texture2D and expected != null:
					exp_path = (expected as Texture2D).resource_path
				if actual is Texture2D and actual != null:
					act_path = (actual as Texture2D).resource_path
				if exp_path != act_path:
					return {"error": "The existing material property %s was modified; it was not overwritten." % pname}
			elif expected != actual:
				return {"error": "The existing material property %s was modified; it was not overwritten." % pname}
	if not reused and ResourceSaver.save(material, output) != OK:
		return {"error": "The material resource did not write: %s." % output}
	return {"material": {"name": material.resource_name, "maps": 3}, "reused": reused}

func _write_result(outcome: Dictionary) -> void:
	if _result_path.is_empty():
		return
	var out := FileAccess.open(_result_path, FileAccess.WRITE)
	if out == null:
		return
	out.store_string(JSON.stringify(outcome))
	out.close()
`;

const MaterialRequest = Schema.fromJsonString(
  Schema.Struct({
    albedoResPath: Schema.String,
    normalResPath: Schema.String,
    roughnessResPath: Schema.String,
    existingPath: Schema.String,
    materialName: Schema.String,
    metallic: Schema.Number,
    uvScale: Schema.Tuple([Schema.Number, Schema.Number]),
    outputPath: Schema.String,
  }),
);
export const encodeMaterialRequest = Schema.encodeSync(MaterialRequest);

const MaterialResult = Schema.fromJsonString(
  Schema.Struct({
    material: Schema.optionalKey(Schema.Struct({ name: Schema.String, maps: Schema.Number })),
    error: Schema.optionalKey(Schema.String),
    reused: Schema.optionalKey(Schema.Boolean),
  }),
);
export const decodeMaterialResult = Schema.decodeUnknownSync(MaterialResult);
