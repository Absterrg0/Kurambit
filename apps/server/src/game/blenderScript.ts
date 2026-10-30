import * as Schema from "effect/Schema";

/**
 * The bpy program Blender runs headlessly for one asset. It is static text:
 * the service passes every per-run path through a JSON config file, named on
 * the command line after `--` with the service's own staged path baked into
 * the script as the fallback. Blender only ever writes the staged paths in
 * that config; the service publishes them into the game after the export
 * validates.
 */
const BLENDER_RUN_SCRIPT = `import bpy, os, json, traceback, sys
from mathutils import Vector
try:
    argv = sys.argv
    if '--' in argv and argv.index('--') + 1 < len(argv):
        config_path = argv[argv.index('--') + 1]
    else:
        config_path = os.environ.get('STUDIO_BLENDER_CONFIG', '') or __STUDIO_BLENDER_CONFIG__
    with open(config_path, 'r') as config_file:
        config = json.load(config_file)
    source = config['source']
    reset = config.get('reset', False)
    script_path = config['script']
    exported = config['exported']
    thumbnail = config.get('thumbnail')
    metadata_path = config['metadata']
    palette = config.get('palette', [])
    asset_inputs = dict(config.get('inputs', {}))

    def srgb_to_linear(channel):
        channel = channel / 255.0
        return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4

    if (not reset) and os.path.exists(source):
        bpy.ops.wm.open_mainfile(filepath=source)
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
    # One shared unit convention, so related assets measure the same metre.
    bpy.context.scene.unit_settings.system = 'METRIC'
    bpy.context.scene.unit_settings.scale_length = 1.0
    for entry in palette:
        name = 'StudioPalette_' + entry.lstrip('#').lower()
        material = bpy.data.materials.get(name)
        if material is None:
            material = bpy.data.materials.new(name)
            material.use_nodes = True
            principled = None
            for node in material.node_tree.nodes:
                if node.type == 'BSDF_PRINCIPLED':
                    principled = node
                    break
            if principled is None:
                principled = material.node_tree.nodes.new('ShaderNodeBsdfPrincipled')
            red = int(entry[1:3], 16)
            green = int(entry[3:5], 16)
            blue = int(entry[5:7], 16)
            principled.inputs['Base Color'].default_value = (
                srgb_to_linear(red), srgb_to_linear(green), srgb_to_linear(blue), 1.0)
            material.diffuse_color = (
                srgb_to_linear(red), srgb_to_linear(green), srgb_to_linear(blue), 1.0)

    with open(script_path, 'r') as script_file:
        exec(compile(script_file.read(), script_path, 'exec'), {'__name__': '__main__', 'bpy': bpy, 'ASSET_INPUTS': dict(asset_inputs)})
    # Packed images keep the saved .blend usable after scratch inputs are
    # removed. A script-supplied texture stays with the source; a missing file
    # simply stays unpacked rather than failing the run.
    for image in list(bpy.data.images):
        try:
            if image.filepath and image.packed_file is None:
                image.pack()
        except Exception:
            pass
    bpy.context.view_layer.update()
    objects = list(bpy.context.scene.objects)
    meshes = [obj for obj in objects if obj.type == 'MESH']
    depsgraph = bpy.context.evaluated_depsgraph_get()
    triangles = 0
    for obj in meshes:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            mesh.calc_loop_triangles()
            triangles += len(mesh.loop_triangles)
        finally:
            evaluated.to_mesh_clear()
    points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    low = Vector(tuple(min(p[i] for p in points) for i in range(3))) if points else Vector((0, 0, 0))
    high = Vector(tuple(max(p[i] for p in points) for i in range(3))) if points else Vector((0, 0, 0))
    dimensions = list(high - low)
    origin_offset = [(low[0] + high[0]) / 2, (low[1] + high[1]) / 2, low[2]] if points else [0, 0, 0]
    material_details = []
    for material in bpy.data.materials:
        color = list(material.diffuse_color[:3])
        if material.use_nodes:
            for node in material.node_tree.nodes:
                if node.type == 'BSDF_PRINCIPLED' and 'Base Color' in node.inputs:
                    color = list(node.inputs['Base Color'].default_value[:3])
                    break
        material_details.append({'name': material.name, 'color': [round(c, 3) for c in color]})
    bpy.ops.wm.save_as_mainfile(filepath=source)
    bpy.ops.export_scene.gltf(filepath=exported, export_format='GLB', export_apply=True, export_materials='EXPORT')
    warnings = []
    if not meshes:
        warnings.append('The asset has no mesh objects.')
    if thumbnail:
        center = (low + high) / 2
        size = max(max(dimensions), 0.5)
        camera_data = bpy.data.cameras.new('Studio thumbnail camera')
        camera = bpy.data.objects.new('Studio thumbnail camera', camera_data)
        bpy.context.scene.collection.objects.link(camera)
        camera.location = center + Vector((1.4, -1.8, 1.2)) * size
        camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
        camera_data.type = 'ORTHO'
        camera_data.ortho_scale = size * 1.9
        bpy.context.scene.camera = camera
        light_data = bpy.data.lights.new('Studio thumbnail light', 'AREA')
        light_data.energy = 125 * size * size
        light_data.shape = 'DISK'
        light_data.size = size * 3
        light = bpy.data.objects.new('Studio thumbnail light', light_data)
        bpy.context.scene.collection.objects.link(light)
        light.location = center + Vector((0.8, -1, 2)) * size
        light.rotation_euler = (center - light.location).to_track_quat('-Z', 'Y').to_euler()
        scene = bpy.context.scene
        scene.view_settings.view_transform = 'Standard'
        world = bpy.data.worlds.new('Studio thumbnail world')
        world.use_nodes = True
        world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.15, 0.15, 0.15, 1)
        world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.5
        scene.world = world
        scene.render.engine = 'CYCLES'
        scene.cycles.device = 'CPU'
        scene.cycles.samples = 8
        scene.render.threads_mode = 'FIXED'
        scene.render.threads = 2
        scene.render.resolution_x = 256
        scene.render.resolution_y = 256
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = 'PNG'
        scene.render.film_transparent = True
        scene.render.filepath = thumbnail
        bpy.ops.render.render(write_still=True)
    with open(metadata_path, 'w') as out:
        json.dump({'objects': len(objects), 'meshes': len(meshes), 'materials': len(bpy.data.materials), 'materialDetails': material_details, 'animations': len(bpy.data.actions), 'triangles': triangles, 'dimensions': dimensions, 'originOffset': origin_offset, 'warnings': warnings}, out)
except BaseException:
    traceback.print_exc()
    sys.exit(1)
`;

/** The JSON config the service writes beside the static run script. */
export const BlenderRunConfig = Schema.Struct({
  /** Staged .blend the run opens and saves; published only on success. */
  source: Schema.String,
  reset: Schema.Boolean,
  /** The agent's bpy script, staged outside the game until it succeeds. */
  script: Schema.String,
  /** Staged GLB export path. */
  exported: Schema.String,
  /** Staged thumbnail path, or null when the asset wants none. */
  thumbnail: Schema.NullOr(Schema.String),
  /** Where the run writes its metrics JSON. */
  metadata: Schema.String,
  /** Hex palette roles to ensure as shared materials. */
  palette: Schema.Array(Schema.String),
  /** Staged absolute paths for named local inputs, read as ASSET_INPUTS. */
  inputs: Schema.Record(Schema.String, Schema.String),
});
export type BlenderRunConfig = typeof BlenderRunConfig.Type;
export const encodeBlenderRunConfig = Schema.encodeSync(Schema.fromJsonString(BlenderRunConfig));

/**
 * Renders the static run script for one run. Only the service's own staged
 * config path is substituted, as a JSON string literal, so agent script
 * content never enters code.
 */
export const renderRunScript = (configPath: string): string =>
  BLENDER_RUN_SCRIPT.replace("__STUDIO_BLENDER_CONFIG__", JSON.stringify(configPath));
