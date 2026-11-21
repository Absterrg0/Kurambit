"""bake_down: a dense model's detail baked onto a light one, wired so Blender's glTF exporter ships it.
The bake settings follow bake_maps.py from EL4CTEO/blender-skills (MIT, Copyright (c) 2026 EL4CTEO)."""
import math

import bpy

from .helpers import use_nodes

# map: (Cycles bake type, pass filter, colour data)
MAPS = {"normal": ("NORMAL", set(), False), "ao": ("AO", set(), False), "color": ("DIFFUSE", {"COLOR"}, True)}
GLTF_GROUP = "glTF Material Output"  # the node group Blender's glTF exporter reads occlusion from


def _gltf_output():
    ng = bpy.data.node_groups.get(GLTF_GROUP)
    if ng is None:
        ng = bpy.data.node_groups.new(GLTF_GROUP, "ShaderNodeTree")
        ng.interface.new_socket("Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
        ng.interface.new_socket("Thickness", in_out="INPUT", socket_type="NodeSocketFloat")
    return ng


def _select(objs, active):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = active


def _unwrap(low):
    _select([low], low)
    with bpy.context.temp_override(object=low, active_object=low, selected_objects=[low], selected_editable_objects=[low]):
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.01)
        bpy.ops.object.mode_set(mode="OBJECT")


def bake_down(high, low=None, maps=("normal", "ao"), size=1024, decimate=0.1, *, name=None, samples=32, unwrap=None):
    """Bakes a dense model (subdivided, bevelled, sculpted, one_skin) onto a light one, so the game
    draws a tenth of the triangles and still shows the bevels, creases and contact shadows.

    high      the dense object (or name), modifiers included. It is hidden afterwards, kept for a re-bake.
    low       the light object to bake onto: the blockout before its bevels is the best low for a hard
              surface prop. None makes one: a copy of high decimated to `decimate` of its triangles.
    maps      any of "normal" (tangent-space normal map), "ao" (ambient occlusion: shipped as the
              glTF occlusion texture, three.js aoMap), "color" (high's base colour; with it the low
              gets one material, without it each of low's materials keeps its colour and gains the maps).
    size      texture side in pixels (512-2048).
    decimate  the ratio for a made low (0.1 = a tenth of the triangles).
    unwrap    Smart UV Project the low first. Default: when the low was made here or has no UVs.
              A low's own UVs must not overlap, or the bake paints two places onto one.
    The images are packed into the .blend (named <name>_normal, <name>_ao, ...). Bakes with Cycles on
    the CPU: about 10-60 s at 1024 px.
    Returns the low object, named name (default high's name + "_low"), ready to export.
    Example, a crate with bevels baked onto its 12-triangle blockout:
        game_crate = kurambit.bake_down(crate_hi, low=crate_box, maps=("normal", "ao"), size=1024)
    """
    high = bpy.data.objects[high] if isinstance(high, str) else high
    name = name or f"{high.name}_low"
    made = low is None
    if made:
        me = bpy.data.meshes.new_from_object(high.evaluated_get(bpy.context.evaluated_depsgraph_get()))
        low = bpy.data.objects.new(name, me)
        low.matrix_world = high.matrix_world.copy()
        bpy.context.collection.objects.link(low)
        mod = low.modifiers.new("decimate", "DECIMATE")
        mod.ratio, mod.use_collapse_triangulate = decimate, True
        me2 = bpy.data.meshes.new_from_object(low.evaluated_get(bpy.context.evaluated_depsgraph_get()))
        low.modifiers.clear()
        low.data = me2
        bpy.data.meshes.remove(me)
    else:
        low = bpy.data.objects[low] if isinstance(low, str) else low
    if unwrap or (unwrap is None and (made or not low.data.uv_layers)):
        _unwrap(low)
    if "color" in maps or not low.data.materials:
        base = bpy.data.materials.new(f"{name}_baked")
        use_nodes(base)
        low.data.materials.clear()
        low.data.materials.append(base)
    else:
        copies = {}  # high keeps its own materials; slots sharing one share its copy
        for slot in low.material_slots:
            m = slot.material
            if m not in copies:
                copies[m] = m.copy() if m else bpy.data.materials.new(f"{name}_baked")
                use_nodes(copies[m])
            slot.material = copies[m]

    sc = bpy.context.scene
    engine = sc.render.engine
    sc.render.engine = "CYCLES"
    sc.cycles.device, sc.cycles.samples, sc.cycles.use_denoising = "CPU", samples, False
    diag = max(high.dimensions.length, 1e-3)
    bk = sc.render.bake
    bk.use_selected_to_active, bk.use_cage = True, False
    bk.cage_extrusion, bk.max_ray_distance = diag * 0.015, diag * 0.06
    bk.margin, bk.margin_type, bk.target, bk.use_clear = 8, "EXTEND", "IMAGE_TEXTURES", True
    bk.normal_space = "TANGENT"
    images = {}
    try:
        for key in maps:
            kind, passes, colour = MAPS[key]
            img = bpy.data.images.new(f"{name}_{key}", size, size, alpha=False)
            img.colorspace_settings.name = "sRGB" if colour else "Non-Color"
            nodes = []
            for mat in {s.material for s in low.material_slots}:
                nt = mat.node_tree
                n = nt.nodes.new("ShaderNodeTexImage")
                n.image = img
                nt.nodes.active = n
                nodes.append((nt, n))
            _select([high, low], low)
            bpy.ops.object.bake(type=kind, pass_filter=passes, use_selected_to_active=True)
            for nt, n in nodes:
                nt.nodes.remove(n)
            img.pack()
            images[key] = img
    finally:
        sc.render.engine = engine

    for mat in {s.material for s in low.material_slots}:
        nt = mat.node_tree
        bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")

        def tex(key):
            n = nt.nodes.new("ShaderNodeTexImage")
            n.image = images[key]
            return n
        if "color" in images:
            nt.links.new(tex("color").outputs["Color"], bsdf.inputs["Base Color"])
        if "normal" in images:
            nm = nt.nodes.new("ShaderNodeNormalMap")
            nt.links.new(tex("normal").outputs["Color"], nm.inputs["Color"])
            nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
        if "ao" in images:
            sep = nt.nodes.new("ShaderNodeSeparateColor")
            nt.links.new(tex("ao").outputs["Color"], sep.inputs["Color"])
            out = nt.nodes.new("ShaderNodeGroup")
            out.node_tree = _gltf_output()
            nt.links.new(sep.outputs["Red"], out.inputs["Occlusion"])
    low.data.shade_smooth()
    high.hide_set(True)
    high.hide_render = True
    low["kurambit_baked_from"] = high.name
    return low
