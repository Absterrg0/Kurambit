"""ref_planes: reference pictures standing behind the model, with an orthographic camera for each,
so a model is built over its reference and rendered against it (the eagle's method)."""
import bpy

from .helpers import use_nodes

# view: (where its camera stands, from the model; the rotation that turns a plane and a camera to face it)
VIEWS = {
    "front": ((0, -1, 0), (90, 0, 0)),
    "side": ((1, 0, 0), (90, 0, 90)),
    "top": ((0, 0, 1), (0, 0, 0)),
}


def _image_material(img, opacity, name):
    m = bpy.data.materials.new(name)
    nt = use_nodes(m)
    nt.nodes.clear()
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    emit = nt.nodes.new("ShaderNodeEmission")
    clear = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(tex.outputs["Color"], emit.inputs["Color"])
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    mul.inputs[1].default_value = opacity
    nt.links.new(tex.outputs["Alpha"], mul.inputs[0])
    nt.links.new(mul.outputs[0], mix.inputs["Fac"])
    nt.links.new(clear.outputs[0], mix.inputs[1])
    nt.links.new(emit.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    m.surface_render_method = "BLENDED"
    return m


def ref_planes(front=None, side=None, top=None, height=2.0, *, name="ref", distance=None, opacity=0.6,
               centre=(0.0, 0.0)):
    """Reference pictures as planes behind the model, and an orthographic camera looking through the
    model at each, so a render shows the model over its reference.

    front, side, top  image paths (PNG or JPG; transparency shows through). front is seen from -Y
                      (the model faces -Y), side from +X (the model's left side, facing the left
                      of the picture), top from +Z with -Y down the picture.
    height            metres the picture's full height covers: draw or crop the reference so the
                      subject fills it from its feet to its top (for top: the depth along Y).
                      The picture's bottom edge sits on the ground (z = 0); top is centred.
    centre            (x, y) of the subject's ground point, if it is not at the origin.
    distance          how far behind the model each plane stands (default 2 x height).
    opacity           0..1 how strongly the picture shows.
    The planes are marked kurambit_ref, cast no shadow and do not export unless you pass them;
    they live in a collection named `name`.
    Returns {view: {"plane": object, "camera": camera object}}. To render one view:
        refs = kurambit.ref_planes(front="//ref_front.png", side="//ref_side.png", height=1.8)
        bpy.context.scene.camera = refs["front"]["camera"]; bpy.ops.render.render(write_still=True)
    """
    coll = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if coll.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(coll)
    out = {}
    for view, path in (("front", front), ("side", side), ("top", top)):
        if path is None:
            continue
        img = bpy.data.images.load(bpy.path.abspath(path), check_existing=True)
        aspect = img.size[0] / max(img.size[1], 1)
        w, h = height * aspect, height
        look, rot = VIEWS[view]
        d = distance or 2 * height
        cx, cy = centre
        mid = (cx, cy, h / 2) if view != "top" else (cx, cy, 0.0)
        me = bpy.data.meshes.new(f"{name}_{view}")
        me.from_pydata([(-w / 2, -h / 2, 0), (w / 2, -h / 2, 0), (w / 2, h / 2, 0), (-w / 2, h / 2, 0)], [], [(0, 1, 2, 3)])
        me.uv_layers.new().data.foreach_set("uv", [0, 0, 1, 0, 1, 1, 0, 1])
        me.materials.append(_image_material(img, opacity, f"{name}_{view}"))
        plane = bpy.data.objects.new(f"{name}_{view}", me)
        plane.rotation_euler = [r * 3.14159265 / 180 for r in rot]
        plane.location = [m - k * d for m, k in zip(mid, look)]
        plane.visible_shadow = False
        plane.hide_select = True
        plane["kurambit_ref"] = True
        coll.objects.link(plane)
        cam_data = bpy.data.cameras.new(f"{name}_{view}_cam")
        cam_data.type = "ORTHO"
        cam_data.ortho_scale = max(w, h) * 1.02
        cam_data.clip_end = 4 * d + 10
        cam = bpy.data.objects.new(f"{name}_{view}_cam", cam_data)
        cam.rotation_euler = plane.rotation_euler.copy()
        cam.location = [m + k * d for m, k in zip(mid, look)]
        coll.objects.link(cam)
        out[view] = {"plane": plane, "camera": cam}
    return out
