"""scan: a photo-scanned surface (a Poly Haven texture) under a material's own colour and roughness.

game_blender op asset_import with source "polyhaven", a texture's id and applyTo calls this with the
texture's files, fetched and checked by the server. Each material named, or each material of each
object named, keeps its base colour, roughness and metal; the scan adds its grain, weave, pores and
scratches at its real size: the colour map's light and dark over the material's colour, its
roughness map's variation around the material's roughness, its normal and occlusion maps as they
are. The textures are laid on a UV map ("scan") projected from six sides in metres, so a fused mesh
without UVs takes them too, and the glTF export ships them as ordinary textures.

    scan(["Satchel", "HoodWool"], color=, normal=, arm=, metres=0.4, scale=1.0, source={...})

scale multiplies the texture's size (2 doubles the grain: a small or stylised model often wants it
larger than life). Running it again on a material replaces the scan it had. scan(names, off=True)
puts the materials back as they were: change a colour or roughness then, and scan again.
"""
import json
import os

import bpy
import numpy as np

from .bake import _gltf_output
from .helpers import use_nodes
from .protocol import Refused

UV = "scan"
KEY = "kurambit_scan"  # on a material: the scan it wears and the colour and roughness it had


def _pixels(img):
    a = np.empty(len(img.pixels), np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(-1, 4)


def _principled(m):
    use_nodes(m)
    return next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)


def _derived(name, w, h, px, colour):
    img = bpy.data.images.get(name)
    if img is not None and tuple(img.size) != (w, h):
        bpy.data.images.remove(img)
        img = None
    img = img or bpy.data.images.new(name, w, h, alpha=False)
    img.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    img.pixels.foreach_set(px.ravel())
    img.pack()
    return img


def _srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def _targets(names):
    mats, objs = [], []
    for n in names:
        if n in bpy.data.materials:
            m = bpy.data.materials[n]
            mats.append(m)
            objs += [o for o in bpy.data.objects if o.type == "MESH" and any(s.material == m for s in o.material_slots)]
        elif n in bpy.data.objects and bpy.data.objects[n].type == "MESH":
            o = bpy.data.objects[n]
            objs.append(o)
            mats += [s.material for s in o.material_slots if s.material is not None]
        else:
            raise Refused("invalid-input", f"applyTo names {n!r}, which is neither a mesh nor a material in the scene")
    if not mats:
        raise Refused("invalid-input", f"{', '.join(names)}: no material to put the scan under; give the meshes a material first")
    return list(dict.fromkeys(mats)), list(dict.fromkeys(objs))


def _project(o):
    """A UV map of o's faces in metres, projected from the six sides of the object's own box."""
    me = o.data
    uv = me.uv_layers.get(UV) or me.uv_layers.new(name=UV)
    s = o.matrix_world.to_scale()
    n = len(me.loops)
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3) * np.array([abs(s.x), abs(s.y), abs(s.z)], np.float32)
    nor = np.empty(len(me.polygons) * 3, np.float32)
    me.polygons.foreach_get("normal", nor)
    nor = np.abs(nor.reshape(-1, 3))
    loop_vert = np.empty(n, np.int64)
    me.loops.foreach_get("vertex_index", loop_vert)
    loop_poly = np.empty(n, np.int64)
    for p in me.polygons:
        loop_poly[p.loop_start:p.loop_start + p.loop_total] = p.index
    axis = nor[loop_poly].argmax(1)
    c = co[loop_vert]
    u = np.where(axis == 0, c[:, 1], c[:, 0])
    v = np.where(axis == 2, c[:, 1], c[:, 2])
    uv.data.foreach_set("uv", np.stack([u, v], 1).ravel())


MEAN = 0.75  # the shared maps' mean: the material's own value is their factor, so a light one can still reach it


def _shared(name, path, size, colour, make):
    """One image per scan and map, made once from the scan's file at size px a side."""
    img = bpy.data.images.get(name)
    if img is not None and tuple(img.size) == (size, size):
        return img
    src = bpy.data.images.load(path, check_existing=False)
    src.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    src.scale(size, size)
    px = make(_pixels(src))
    bpy.data.images.remove(src)
    return _derived(name, size, size, px, colour)


def _off(m):
    p = _principled(m)
    was = json.loads(m.get(KEY, "null"))
    if p is None or was is None:
        return
    nt = m.node_tree
    for n in [n for n in nt.nodes if n.get(KEY)]:
        nt.nodes.remove(n)
    p.inputs["Base Color"].default_value = was["color"]
    p.inputs["Roughness"].default_value = was["roughness"]
    p.inputs["Metallic"].default_value = was["metallic"]
    del m[KEY]


def scan(apply_to, color=None, normal=None, arm=None, metres=1.0, scale=1.0, size=512, off=False):
    names = [apply_to] if isinstance(apply_to, str) else list(apply_to)
    mats, objs = _targets(names)
    if off:
        for m in mats:
            _off(m)
        return {"materials": [m.name for m in mats], "objects": [o.name for o in objs], "metres": 0, "size": 0, "dimmed": []}
    for path in (color, normal, arm):
        if path is None or not os.path.isfile(path):
            raise Refused("tool-failed", f"the scan's file {path} is missing")
    tile = max(float(metres) * float(scale), 1e-3)
    stem = os.path.basename(os.path.dirname(color)) or os.path.splitext(os.path.basename(color))[0]

    def grain(px):
        # The scan's own colour is dropped: its light and dark about their mean carry the grain.
        lum = px[:, :3] @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        g = _srgb(MEAN * (0.2 + 0.8 * lum / max(float(lum.mean()), 1e-4)))  # linear about MEAN, stored as colour is
        return np.stack([g, g, g, np.ones_like(g)], 1)

    def orm(px):
        r = px[:, 1] / max(float(px[:, 1].mean()), 1e-4)
        return np.stack([px[:, 0], np.clip(MEAN * (1 + 0.9 * (r - 1)), 0, 1), np.ones(len(px), np.float32), np.ones(len(px), np.float32)], 1)

    img_g = _shared(f"scan_{stem}_grain", color, size, True, grain)
    img_o = _shared(f"scan_{stem}_orm", arm, size, False, orm)
    img_n = _shared(f"scan_{stem}_normal", normal, size, False, lambda px: px)
    for o in objs:
        _project(o)
    done, dimmed = [], []
    for m in mats:
        p = _principled(m)
        if p is None:
            continue
        nt = m.node_tree
        was = json.loads(m.get(KEY, "null")) or {
            "color": list(p.inputs["Base Color"].default_value), "roughness": p.inputs["Roughness"].default_value,
            "metallic": p.inputs["Metallic"].default_value}
        for n in [n for n in nt.nodes if n.get(KEY)]:
            nt.nodes.remove(n)
        factor = [min(1.0, c / MEAN) for c in was["color"][:3]]
        if max(was["color"][:3]) > MEAN:
            dimmed.append(m.name)

        def node(kind):
            n = nt.nodes.new(kind)
            n[KEY] = 1
            return n
        uvn = node("ShaderNodeUVMap")
        uvn.uv_map = UV
        mp = node("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (1 / tile, 1 / tile, 1)
        nt.links.new(uvn.outputs["UV"], mp.inputs["Vector"])
        tex = {}
        for key, img in (("grain", img_g), ("orm", img_o), ("normal", img_n)):
            t = node("ShaderNodeTexImage")
            t.image = img
            nt.links.new(mp.outputs["Vector"], t.inputs["Vector"])
            tex[key] = t
        # Factor times texture, in the shapes Blender's glTF exporter writes as factors.
        mix = node("ShaderNodeMix")
        mix.data_type, mix.blend_type = "RGBA", "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        a, b = [i for i in mix.inputs if i.type == "RGBA"][:2]
        a.default_value = (*factor, 1.0)
        nt.links.new(tex["grain"].outputs["Color"], b)
        nt.links.new(next(o for o in mix.outputs if o.type == "RGBA"), p.inputs["Base Color"])
        sep = node("ShaderNodeSeparateColor")
        nt.links.new(tex["orm"].outputs["Color"], sep.inputs["Color"])
        for channel, key in (("Green", "roughness"), ("Blue", "metallic")):
            mul = node("ShaderNodeMath")
            mul.operation = "MULTIPLY"
            nt.links.new(sep.outputs[channel], mul.inputs[0])
            mul.inputs[1].default_value = min(1.0, was[key] / MEAN) if key == "roughness" else was[key]
            nt.links.new(mul.outputs[0], p.inputs["Roughness" if key == "roughness" else "Metallic"])
        nm = node("ShaderNodeNormalMap")
        nm.uv_map = UV
        nt.links.new(tex["normal"].outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], p.inputs["Normal"])
        out = node("ShaderNodeGroup")
        out.node_tree = _gltf_output()
        nt.links.new(sep.outputs["Red"], out.inputs["Occlusion"])
        m[KEY] = json.dumps(was)
        done.append(m.name)
    return {"materials": done, "objects": [o.name for o in objs], "metres": round(tile, 3), "size": size,
            "dimmed": dimmed}
