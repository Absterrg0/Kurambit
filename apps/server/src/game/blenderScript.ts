export function blenderWrapper(input: {
  source: string;
  reset?: boolean;
  script: string;
  exported: string;
  thumbnail: string | null;
  metadata: string;
}) {
  return `import bpy, os, json, traceback, sys, math
from mathutils import Vector
try:
    if ${input.reset ? "False" : "True"} and os.path.exists(${JSON.stringify(input.source)}):
        bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(input.source)})
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
    with open(${JSON.stringify(input.script)}, 'r') as script_file:
        exec(compile(script_file.read(), ${JSON.stringify(input.script)}, 'exec'), {'__name__': '__main__', 'bpy': bpy})
    bpy.context.view_layer.update()
    objects = list(bpy.context.scene.objects)
    meshes = [obj for obj in objects if obj.type == 'MESH']
    points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    low = Vector(tuple(min(p[i] for p in points) for i in range(3))) if points else Vector((0, 0, 0))
    high = Vector(tuple(max(p[i] for p in points) for i in range(3))) if points else Vector((0, 0, 0))
    dimensions = list(high - low)
    bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(input.source)})
    bpy.ops.export_scene.gltf(filepath=${JSON.stringify(input.exported)}, export_format='GLB', export_apply=True, export_materials='EXPORT')
    warnings = []
    if not meshes:
        warnings.append('The asset has no mesh objects.')
    thumbnail = ${input.thumbnail === null ? "None" : JSON.stringify(input.thumbnail)}
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
    with open(${JSON.stringify(input.metadata)}, 'w') as out:
        json.dump({'objects': len(objects), 'meshes': len(meshes), 'materials': len(bpy.data.materials), 'dimensions': dimensions, 'warnings': warnings}, out)
except BaseException:
    traceback.print_exc()
    sys.exit(1)
`;
}
